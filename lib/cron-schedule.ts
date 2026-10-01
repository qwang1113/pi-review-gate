/**
 * 5-FIELD CRON — the pure half of the scheduler kernel.
 *
 * ── WHAT IT ANSWERS ──
 *
 *   1. `parseCron(expr)` — is this a legal `分 时 日 月 周` expression, and
 *      which values does each segment allow? An illegal one comes back with
 *      the SEGMENT NUMBER and the reason, because "invalid cron" alone sends
 *      the reader back to the panel to guess which of five fields is wrong.
 *   2. `nextRunAfter(cron, after)` — the first local wall-clock time STRICTLY
 *      after `after` (the same strictness `lastFiredAt` needs: a run that
 *      fired at 09:00 must not be scheduled for 09:00 again).
 *   3. `describeCron(cron)` — the one-line human reading the panel shows
 *      ("每天 09:00"), falling back to the expression itself when no short
 *      phrase is honest.
 *
 * ── WHY IT IS A MODULE AND NOT A DEPENDENCY ──
 *
 * A cron library would pull a parser, a timezone database and a formatter for
 * a five-field grammar that fits in one screen. This is a personal, local
 * scheduler: 5 fields, numeric only, LOCAL time, no seconds, no `@reboot`, no
 * names — and everything the daemon and the panel need is here, testable
 * without a clock (the caller passes `after`). It has no IO, no state and no
 * timer: what to DO when a task is due belongs to the daemon
 * (`lib/daemon/`), not to this file.
 *
 * ── TWO SEMANTICS WORTH STATING ──
 *
 *   - DAY-OF-MONTH vs DAY-OF-WEEK: when BOTH are restricted the classic cron
 *     rule applies — the day matches if EITHER does (`0 9 1 * 1` is the 1st
 *     AND every Monday). When either is unrestricted, the other one decides
 *     alone. `nextRunAfter` and `describeCron` read the same rule.
 *   - `0` and `7` both mean Sunday; a literal 7 folds onto 0 on the way in,
 *     so nothing downstream has to know about the second spelling.
 */

/** The five segments, in evaluation order. The 1-based position is what an error names. */
export const CRON_FIELD_NAMES = Object.freeze(["分", "时", "日", "月", "周"] as const);

/** A segment's display name (`分` / `时` / `日` / `月` / `周`). */
export type CronFieldName = (typeof CRON_FIELD_NAMES)[number];

/** Lower/upper bounds per segment. `周` accepts 0–7 (7 folds onto 0). */
const FIELD_SPECS = Object.freeze([
  { min: 0, max: 59 }, // 分
  { min: 0, max: 23 }, // 时
  { min: 1, max: 31 }, // 日
  { min: 1, max: 12 }, // 月
  { min: 0, max: 7 }, // 周
] as const);

/** A parsed expression: raw segments plus the allowed values of each. */
export interface ParsedCron {
  /** The trimmed expression, as given. */
  expr: string;
  /** Raw segment text, in order (分 时 日 月 周). */
  fields: readonly string[];
  /** Sorted, de-duplicated. */
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: readonly number[];
  months: readonly number[];
  /** 0–6, Sunday = 0 (a literal 7 has been folded onto 0). */
  daysOfWeek: readonly number[];
}

/** `parseCron`'s two outcomes. The refusal names the segment and the reason. */
export type CronParse = { ok: true; cron: ParsedCron } | { ok: false; problem: string };

/** How many days `nextRunAfter` will walk before declaring a combination unsatisfiable. */
export const MAX_SEARCH_DAYS = 2_930; // 8 years: covers a Feb-29 slot across a non-leap century year (2096 → 2104).

/** `第 N 段（名）: <why>` — the only shape a refusal takes. */
function fieldProblem(index: number, why: string): string {
  return `第 ${index} 段（${CRON_FIELD_NAMES[index - 1]}）: ${why}`;
}

/** One numeric range segment, expanded. */
function parseField(
  raw: string,
  index: number,
): { ok: true; values: number[] } | { ok: false; problem: string } {
  const spec = FIELD_SPECS[index - 1];
  const bounds = `${spec.min}-${spec.max}`;
  const values = new Set<number>();
  const addRange = (low: number, high: number, step: number): string | undefined => {
    if (!Number.isInteger(low) || low < spec.min || low > spec.max) {
      return fieldProblem(index, `值 ${low} 超出 ${bounds}`);
    }
    if (!Number.isInteger(high) || high < spec.min || high > spec.max) {
      return fieldProblem(index, `值 ${high} 超出 ${bounds}`);
    }
    if (low > high) return fieldProblem(index, `区间 ${low}-${high} 的起点大于终点`);
    for (let v = low; v <= high; v += step) values.add(v);
    return undefined;
  };
  for (const item of raw.split(",")) {
    const text = item.trim();
    if (text === "") return { ok: false, problem: fieldProblem(index, `列表 "${raw}" 里有空项`) };
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(text);
    if (!m) {
      return {
        ok: false,
        problem: fieldProblem(index, `"${text}" 不是合法写法（只支持 *、a、a-b、*/n、a-b/n）`),
      };
    }
    const [, fromText = "", toText, stepText] = m;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return { ok: false, problem: fieldProblem(index, `步长必须是正整数（"${text}"）`) };
    let low: number;
    let high: number;
    if (fromText === "*") {
      if (toText !== undefined) {
        return { ok: false, problem: fieldProblem(index, `"${text}" 不合法：* 不能作为区间起点`) };
      }
      low = spec.min;
      high = spec.max;
    } else {
      low = Number(fromText);
      // `a/n` without a range is NOT `a-max/n`: reading it as the single value
      // `a` would silently drop the step the user wrote.
      if (toText === undefined && stepText !== undefined) {
        return {
          ok: false,
          problem: fieldProblem(index, `"${text}" 不是合法写法（带步长要写 */n 或 a-b/n）`),
        };
      }
      high = toText === undefined ? low : Number(toText);
    }
    const problem = addRange(low, high, step);
    if (problem) return { ok: false, problem };
  }
  // Sunday has two spellings; fold the second one away here so nothing
  // downstream has to know about it.
  if (index === 5 && values.delete(7)) values.add(0);
  return { ok: true, values: [...values].sort((a, b) => a - b) };
}

/**
 * Parse a 5-field cron expression. Never throws: anything that is not a legal
 * expression comes back as `{ ok: false, problem }`.
 */
export function parseCron(expr: string): CronParse {
  const raw = String(expr ?? "").trim();
  if (raw === "") {
    return { ok: false, problem: "cron 表达式是空的，需要 5 段（分 时 日 月 周）" };
  }
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) {
    return {
      ok: false,
      problem: `cron 表达式必须是 5 段（分 时 日 月 周），这里收到 ${fields.length} 段：${JSON.stringify(raw)}`,
    };
  }
  const parsed: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const field = parseField(fields[i]!, i + 1);
    if (!field.ok) return field;
    parsed.push(field.values);
  }
  return {
    ok: true,
    cron: {
      expr: raw,
      fields,
      minutes: parsed[0]!,
      hours: parsed[1]!,
      daysOfMonth: parsed[2]!,
      months: parsed[3]!,
      daysOfWeek: parsed[4]!,
    },
  };
}

/** The wall-clock times a day allows, sorted ascending by minute-of-day. */
function timesOfDay(cron: ParsedCron): Array<{ hour: number; minute: number; dayMinute: number }> {
  const times: Array<{ hour: number; minute: number; dayMinute: number }> = [];
  for (const hour of cron.hours) {
    for (const minute of cron.minutes) times.push({ hour, minute, dayMinute: hour * 60 + minute });
  }
  times.sort((a, b) => a.dayMinute - b.dayMinute);
  return times;
}

/**
 * Does this calendar day match the `日` / `月` / `周` segments?
 *
 * Both day fields restricted ⇒ EITHER decides (classic cron); otherwise AND.
 * An unrestricted field is one that allows every value — a bare `*`, but also
 * a step of one over the whole range — so `0-7` in `周` or `1-31` in `日`
 * never silently narrows a day.
 */
function dayMatches(cron: ParsedCron, day: Date): boolean {
  if (!cron.months.includes(day.getMonth() + 1)) return false;
  const domOk = cron.daysOfMonth.includes(day.getDate());
  const dowOk = cron.daysOfWeek.includes(day.getDay());
  const domOpen = cron.daysOfMonth.length === 31;
  const dowOpen = cron.daysOfWeek.length === 7;
  if (domOpen && dowOpen) return true;
  if (domOpen) return dowOk;
  if (dowOpen) return domOk;
  return domOk || dowOk;
}

/**
 * The first time this expression fires STRICTLY after `after`, in LOCAL time —
 * or `null` when it never does (an illegal expression, an invalid `after`, or a
 * combination that no calendar day satisfies, e.g. `0 0 30 2 *`).
 *
 * The search walks days (bounded by {@link MAX_SEARCH_DAYS}) and, inside a
 * matching day, the allowed times; a candidate that does not read back as the
 * requested wall clock (a DST spring-forward gap) is skipped instead of being
 * returned as the shifted instant.
 */
export function nextRunAfter(cron: string, after: Date): Date | null {
  const parsed = parseCron(cron);
  if (!parsed.ok) return null;
  const spec = parsed.cron;
  if (!(after instanceof Date) || Number.isNaN(after.getTime())) return null;
  const times = timesOfDay(spec);
  const startDay = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  const startMinute = after.getHours() * 60 + after.getMinutes();
  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset++) {
    const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + offset);
    if (!dayMatches(spec, day)) continue;
    const floor = offset === 0 ? startMinute : -1;
    for (const time of times) {
      if (time.dayMinute <= floor) continue;
      const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute, 0, 0);
      if (candidate.getHours() !== time.hour || candidate.getMinutes() !== time.minute) continue;
      if (candidate.getTime() > after.getTime()) return candidate;
    }
  }
  return null;
}

const WEEKDAY_NAMES = Object.freeze(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);
const TWO_DIGITS = (n: number): string => String(n).padStart(2, "0");

/** A segment that is exactly one number. */
function singleNumber(segment: string): number | undefined {
  return /^\d+$/.test(segment) ? Number(segment) : undefined;
}

/** A segment that is a lone star followed by a step (`/` then a number). */
function everyN(segment: string): number | undefined {
  const m = /^\*\/(\d+)$/.exec(segment);
  return m ? Number(m[1]) : undefined;
}

/**
 * A one-line human reading of the expression, or the expression itself when no
 * short phrase is honest ("每年 2 月 29 日 00:00" is honest; "some Mondays and
 * the 1st of some months" is not).
 */
export function describeCron(cron: string): string {
  const raw = String(cron ?? "").trim();
  const parsed = parseCron(raw);
  if (!parsed.ok) return raw;
  const spec = parsed.cron;
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = spec.fields as [string, string, string, string, string];
  const time = (hour: number, minute: number): string => `${TWO_DIGITS(hour)}:${TWO_DIGITS(minute)}`;

  // 每分钟 / 每 n 分钟
  if (minuteRaw === "*" && hourRaw === "*" && domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
    return "每分钟";
  }
  const minuteStep = everyN(minuteRaw);
  if (minuteStep !== undefined && hourRaw === "*" && domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
    return minuteStep <= 1 ? "每分钟" : `每 ${minuteStep} 分钟`;
  }
  // 每 n 小时（分钟必须是 0，否则老实回退）
  const hourStep = everyN(hourRaw);
  if (
    hourStep !== undefined && minuteRaw === "0" && domRaw === "*" && monthRaw === "*" && dowRaw === "*"
  ) {
    return hourStep <= 1 ? "每小时" : `每 ${hourStep} 小时`;
  }
  // 每小时 / 每小时的第 M 分钟
  const minute = singleNumber(minuteRaw);
  if (hourRaw === "*" && minute !== undefined && domRaw === "*" && monthRaw === "*" && dowRaw === "*") {
    return minute === 0 ? "每小时" : `每小时的第 ${minute} 分钟`;
  }
  // 每天 / 每周X / 每月 N 日 / 每年 M 月 N 日 HH:MM
  const hour = singleNumber(hourRaw);
  if (minute === undefined || hour === undefined) return raw;
  if (domRaw === "*" && monthRaw === "*" && dowRaw === "*") return `每天 ${time(hour, minute)}`;
  if (domRaw === "*" && monthRaw === "*" && dowRaw !== "*") {
    const days = spec.daysOfWeek;
    if (days.length === 7) return `每天 ${time(hour, minute)}`; // e.g. 0-7: every day
    return `每周${days.map((d) => WEEKDAY_NAMES[d]!.slice(1)).join("、")} ${time(hour, minute)}`;
  }
  const dom = singleNumber(domRaw);
  if (dowRaw === "*" && monthRaw === "*" && dom !== undefined) {
    return `每月 ${dom} 日 ${time(hour, minute)}`;
  }
  const month = singleNumber(monthRaw);
  if (dowRaw === "*" && dom !== undefined && month !== undefined) {
    return `每年 ${month} 月 ${dom} 日 ${time(hour, minute)}`;
  }
  return raw;
}
