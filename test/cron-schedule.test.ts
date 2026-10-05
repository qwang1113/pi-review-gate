/**
 * The cron kernel: parsing (with the segment named in every refusal), the next
 * local run (across months, years, leap days, and unsatisfiable dates) and the
 * one-line human reading.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { describeCron, nextRunAfter, parseCron } from "../lib/cron-schedule.ts";

/** A local-time date; every assertion is written in local wall clock too. */
const at = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min, 0, 0);
const fmt = (date: Date | null): string =>
  date === null
    ? "null"
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ` +
      `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

test("parseCron expands every supported form, and folds a literal 7 onto Sunday", () => {
  const parsed = parseCron("*/15 8-18 1,15 * 0,7");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual([...parsed.cron.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...parsed.cron.hours], [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual([...parsed.cron.daysOfMonth], [1, 15]);
  assert.deepEqual([...parsed.cron.months], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual([...parsed.cron.daysOfWeek], [0], "7 and 0 are the same day");
  assert.equal(parsed.cron.expr, "*/15 8-18 1,15 * 0,7");

  const stepped = parseCron("0 9-17/4 * * 1-5");
  assert.equal(stepped.ok, true);
  if (!stepped.ok) return;
  assert.deepEqual([...stepped.cron.hours], [9, 13, 17]);
  assert.deepEqual([...stepped.cron.daysOfWeek], [1, 2, 3, 4, 5]);
});

test("parseCron names the segment and the reason — never a bare 「invalid cron」", () => {
  const cases: Array<[string, string[]]> = [
    ["60 0 * * *", ["第 1 段", "分", "60"]],
    ["0 24 * * *", ["第 2 段", "时"]],
    ["0 0 0 * *", ["第 3 段", "日"]],
    ["0 0 * 13 *", ["第 4 段", "月"]],
    ["0 0 * * 8", ["第 5 段", "周"]],
    ["*/0 * * * *", ["第 1 段", "步长"]],
    ["10-5 * * * *", ["第 1 段", "起点大于终点"]],
    ["a * * * *", ["第 1 段", "不是合法写法"]],
    ["1,,2 * * * *", ["第 1 段", "空项"]],
    ["*/x * * * *", ["第 1 段", "不是合法写法"]],
    ["5/10 * * * *", ["第 1 段", "不是合法写法"]],
    ["*-5 * * * *", ["第 1 段", "不能作为区间起点"]],
  ];
  for (const [expr, needles] of cases) {
    const parsed = parseCron(expr);
    assert.equal(parsed.ok, false, `${expr} must be refused`);
    if (parsed.ok) continue;
    for (const needle of needles) {
      assert.ok(parsed.problem.includes(needle), `${expr} → ${parsed.problem} 缺 ${needle}`);
    }
  }

  const wrongCount = parseCron("0 9 * *");
  assert.equal(wrongCount.ok, false);
  if (wrongCount.ok) return;
  assert.match(wrongCount.problem, /5 段/);

  const empty = parseCron("   ");
  assert.equal(empty.ok, false);
});

test("nextRunAfter is strictly after, and crosses days, months and years", () => {
  assert.equal(fmt(nextRunAfter("0 9 * * *", at(2026, 10, 1, 8, 0))), "2026-10-01 09:00");
  // 09:00 is not after 09:00 — the next one is tomorrow.
  assert.equal(fmt(nextRunAfter("0 9 * * *", at(2026, 10, 1, 9, 0))), "2026-10-02 09:00");
  assert.equal(fmt(nextRunAfter("0 9 * * *", at(2026, 10, 1, 9, 1))), "2026-10-02 09:00");
  // Cross-month and cross-year.
  assert.equal(fmt(nextRunAfter("0 0 1 * *", at(2026, 10, 15, 12, 0))), "2026-11-01 00:00");
  assert.equal(fmt(nextRunAfter("30 23 31 12 *", at(2026, 10, 1, 0, 0))), "2026-12-31 23:30");
  assert.equal(fmt(nextRunAfter("30 23 31 12 *", at(2026, 12, 31, 23, 30))), "2027-12-31 23:30");
});

test("nextRunAfter handles */n and the weekday spelling of Sunday", () => {
  assert.equal(fmt(nextRunAfter("*/15 * * * *", at(2026, 10, 1, 10, 7))), "2026-10-01 10:15");
  assert.equal(fmt(nextRunAfter("*/15 * * * *", at(2026, 10, 1, 10, 15))), "2026-10-01 10:30");
  // 2026-10-01 is a Thursday; the next Sunday is the 4th. 0 and 7 agree.
  assert.equal(fmt(nextRunAfter("0 12 * * 0", at(2026, 10, 1, 0, 0))), "2026-10-04 12:00");
  assert.equal(fmt(nextRunAfter("0 12 * * 7", at(2026, 10, 1, 0, 0))), "2026-10-04 12:00");
  // A weekday with only 日 restricted: the day-of-week decides alone.
  assert.equal(fmt(nextRunAfter("0 9 * * 1", at(2026, 10, 1, 0, 0))), "2026-10-05 09:00");
});

test("nextRunAfter finds Feb 29 across a leap cycle, and gives up on impossible dates", () => {
  assert.equal(fmt(nextRunAfter("0 0 29 2 *", at(2026, 1, 1, 0, 0))), "2028-02-29 00:00");
  assert.equal(fmt(nextRunAfter("0 0 29 2 *", at(2028, 2, 29, 0, 0))), "2032-02-29 00:00");
  // No such day, ever.
  assert.equal(nextRunAfter("0 0 30 2 *", at(2026, 1, 1, 0, 0)), null);
  assert.equal(nextRunAfter("0 0 31 4 *", at(2026, 1, 1, 0, 0)), null);
  assert.equal(nextRunAfter("0 0 31 2 *", at(2026, 1, 1, 0, 0)), null);
  // An illegal expression has no next run either.
  assert.equal(nextRunAfter("0 9 * *", at(2026, 1, 1, 0, 0)), null);
});

test("both day fields restricted means OR — classic cron, not AND", () => {
  // 2026-01-01 is a Thursday, so neither the 1st at 09:00 nor Monday has passed
  // when the search starts at 09:00 on the 1st: the next hit is Monday the 5th.
  assert.equal(fmt(nextRunAfter("0 9 1 * 1", at(2026, 1, 1, 9, 0))), "2026-01-05 09:00");
  // Still Monday the 12th, not the 1st of February: the OR rule keeps firing
  // on every Monday until the 日 leg would come first.
  assert.equal(fmt(nextRunAfter("0 9 1 * 1", at(2026, 1, 5, 9, 0))), "2026-01-12 09:00");
  // After the last Monday of January the 日 leg wins.
  assert.equal(fmt(nextRunAfter("0 9 1 * 1", at(2026, 1, 26, 9, 0))), "2026-02-01 09:00");
  // With 日 unrestricted the 周 field decides alone.
  assert.equal(fmt(nextRunAfter("0 9 * * 1", at(2026, 1, 6, 0, 0))), "2026-01-12 09:00");
});

test("describeCron says it in one line, and falls back to the expression", () => {
  assert.equal(describeCron("0 9 * * *"), "每天 09:00");
  assert.equal(describeCron("0 8 * * 1"), "每周一 08:00");
  assert.equal(describeCron("0 9 * * 1,3,5"), "每周一、三、五 09:00");
  assert.equal(describeCron("0 * * * *"), "每小时");
  assert.equal(describeCron("15 * * * *"), "每小时的第 15 分钟");
  assert.equal(describeCron("* * * * *"), "每分钟");
  assert.equal(describeCron("*/15 * * * *"), "每 15 分钟");
  assert.equal(describeCron("0 */6 * * *"), "每 6 小时");
  assert.equal(describeCron("0 0 1 * *"), "每月 1 日 00:00");
  assert.equal(describeCron("0 0 29 2 *"), "每年 2 月 29 日 00:00");
  // Shapes with no honest short phrase keep the expression verbatim.
  assert.equal(describeCron("1,2 3 4 5 6"), "1,2 3 4 5 6");
  assert.equal(describeCron("0 9 1 * 1"), "0 9 1 * 1");
  assert.equal(describeCron("not a cron"), "not a cron");
  // A step that does not divide the field's span is NOT that rhythm: `*/70`
  // fires once an hour and `0 */7` leaves a 3-hour hole before midnight.
  assert.equal(describeCron("*/70 * * * *"), "*/70 * * * *");
  assert.equal(describeCron("0 */7 * * *"), "0 */7 * * *");
});
