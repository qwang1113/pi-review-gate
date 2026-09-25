/**
 * THE RULES BEHIND `orchestrator_answer` — pure decisions, no tool surface.
 *
 * Two families live here: how a project manager's answer text is read against
 * the rows a child offered ({@link resolveAnswer}), and what a proxy approval
 * must carry before the gate writes it (the crosscheck and the station
 * widening refusal). The tool that applies them — pending lookup, the grant
 * dialogs, the channel write — is lib/orchestrator-answer-tools.ts.
 */

import type { DeliveryStation } from "./delivery-station.ts";
import { looksLikeDeclineRow, rowIndexOf } from "./choice-dialog.ts";
// THE CANONICAL WIRE SEPARATOR, imported rather than spelled again (quality
// round P2, 2026-09-22): this module WRITES the answer the child side parses,
// so a second literal here is a second dialect waiting to drift.
import { MULTI_ANSWER_SEPARATOR } from "./multi-choice-dialog.ts";
import type { PendingRequest } from "./orchestrator-supervisor.ts";

/**
 * The separators a project manager may use to quote several rows at once
 * (2026-09-22): `A, C` / `A、C` / `A C` / `A+C` / `A/C`. The child side parses
 * ONE canonical spelling (`lib/multi-choice-dialog.ts`'s `" / "`), and this
 * is where a human's own loose punctuation is turned into it.
 */
const MULTI_ANSWER_SPLIT = /[,，、+/\s]+/;

/**
 * WHICH ROW a single token quotes — the reading BOTH shapes share.
 *
 * The order is the one the answer numbering implies: an EXACT row first (an
 * option whose own text is `A` must win over the position), then a POSITION
 * (`A` / `1`), then an unambiguous SUBSTRING. A position past the last row is
 * refused rather than read as free text — deliberately different from the
 * pane's own parser, which lets a stray letter fall through to free text.
 */
function readRow(token: string, options: string[]): { row: string } | { reason: string } {
  const exact = options.find((option) => option === token);
  if (exact !== undefined) return { row: exact };
  const rowIndex = rowIndexOf(token);
  if (rowIndex !== undefined) {
    const picked = options[rowIndex];
    if (picked !== undefined) return { row: picked };
    return { reason: `"${token}" 超出选项范围（只有 ${options.length} 个选项）` };
  }
  const hits = options.filter((option) => option.includes(token));
  if (hits.length === 1) return { row: hits[0]! };
  if (hits.length > 1) return { reason: `"${token}" 同时匹配 ${hits.length} 个选项，不敢替它选` };
  return { reason: `"${token}" 不是这个框里的任何一项。可选：` + options.join(MULTI_ANSWER_SEPARATOR) };
}

/**
 * SEVERAL ROWS AT ONCE — the multiple-choice half of a proxy answer.
 *
 * The whole string is read as ONE row first (a single `A` is the common case),
 * and only then split. That order matters: splitting first would turn a single
 * option whose own text contains a comma into two "rows" nobody offered.
 * A segment that reads as nothing refuses the WHOLE answer — guessing which
 * half a manager meant is how a wrong tick gets minted.
 */
function resolveMultiAnswer(
  options: string[],
  text: string,
): { ok: true; answer: string } | { ok: false; reason: string } {
  const whole = readRow(text, options);
  if ("row" in whole) return { ok: true, answer: whole.row };
  const tokens = text.split(MULTI_ANSWER_SPLIT).map((token) => token.trim()).filter(Boolean);
  if (tokens.length < 2) return { ok: false, reason: whole.reason };
  const rows: string[] = [];
  for (const token of tokens) {
    const read = readRow(token, options);
    if ("reason" in read) return { ok: false, reason: `多选答案里有一段读不出来：${read.reason}` };
    if (!rows.includes(read.row)) rows.push(read.row);
  }
  return { ok: true, answer: rows.join(MULTI_ANSWER_SEPARATOR) };
}

/** Resolve `answer` against the offered rows: exact text, a letter, or a 1-based index. */
export function resolveAnswer(
  request: PendingRequest,
  raw: string,
): { ok: true; answer: string } | { ok: false; reason: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "answer 是空的" };
  if (request.options.length === 0) return { ok: true, answer: text };
  // THE TEMPLATE'S DECLINE ROW (2026-09-08): the user (or the PM) picks
  // `✎ 不选，我说明原因` and the reason follows the row after a colon. That
  // whole line is a legitimate answer — the reason is the point — so it is
  // accepted verbatim rather than rejected as an unknown option. It is read
  // BEFORE the rows for BOTH shapes, and it is the same row either way.
  const decline = request.options.find(looksLikeDeclineRow);
  if (decline !== undefined && text.startsWith(decline)) return { ok: true, answer: text };
  // SEVERAL ANSWERS ARE LEGAL ON A CHECKBOX QUESTION ONLY (2026-09-22); a
  // radio question keeps the single-row reading it always had.
  if (request.multiple) return resolveMultiAnswer(request.options, text);
  const read = readRow(text, request.options);
  return "reason" in read ? { ok: false, reason: read.reason } : { ok: true, answer: read.row };
}

// ---------------------------------------------------------------------------
// the proxy CROSSCHECK — what a project manager must say before it approves
// ---------------------------------------------------------------------------

/**
 * THE RUBBER STAMP THIS EXISTS TO STOP (user requirement, 2026-09-06).
 *
 * Answering a child's goal approval used to cost one word. The user's rule is
 * that a project manager must UNDERSTAND the requirement first and then hold
 * the child's draft against the plan, item by item — "goal 跑偏就打回去重谈，
 * 而不是见框就批". A tool that accepts `answer: "认可"` cannot tell those two
 * apart, so the gate asks for the comparison itself and refuses to write an
 * approval without one.
 *
 * WHAT IT CAN AND CANNOT PROVE. It is a STRUCTURE check, deliberately: no
 * pattern can decide whether a judgement is a good one. What it can do is make
 * the three judgements the user named impossible to skip silently — which is
 * exactly the difference between a manager who read the draft and one who
 * pressed yes. Same limit, same reasoning as the docSync attestation.
 *
 * ONE VALIDATOR FOR BOTH TOPICS. A goal approval and a restatement
 * confirmation are the same act (the PM speaking for the user about a child's
 * own text), so they share this check rather than growing two that drift.
 */
export type CrosscheckDimension = "goal" | "station";

/** One accepted spelling of one dimension. */
export interface CrosscheckToken {
  dimension: CrosscheckDimension;
  /** The literal the crosscheck text is searched for (case-insensitive). */
  token: string;
}

/**
 * EVERY spelling the gate accepts, in one exported table.
 *
 * Same shape and same reason as `RESTATEMENT_CONTRAST_TOKENS`
 * (lib/restatement.ts): a keyword rule whose literals are sprinkled through a
 * function is a rule nobody can audit, and a narrow one refuses an honest
 * comparison over its word choice. Widening the accepted surface means adding
 * a ROW here — never editing the condition below, which reads nothing else.
 */
export const PROXY_CROSSCHECK_TOKENS: readonly CrosscheckToken[] = Object.freeze([
  // "is this the task the plan asked for?"
  { dimension: "goal", token: "任务目标" },
  { dimension: "goal", token: "目标" },
  { dimension: "goal", token: "意图" },
  { dimension: "goal", token: "goal" },
  // "does it stop where the plan says the round stops?"
  { dimension: "station", token: "交付站点" },
  { dimension: "station", token: "站点" },
  { dimension: "station", token: "deliveryStation" },
  { dimension: "station", token: "station" },
]);

/** How each dimension is NAMED when the gate reports it missing. */
const CROSSCHECK_DIMENSION_LABELS: Readonly<Record<CrosscheckDimension, string>> = Object.freeze({
  goal: "任务目标",
  station: "交付站点",
});

/**
 * Shortest text that can carry two judgements plus a task id. Low on
 * purpose: the dimension check is what catches an empty gesture, and a length
 * rule that argues with a terse but real comparison would be a rule about
 * style.
 */
export const PROXY_CROSSCHECK_MIN_CHARS = 60;

/** The skeleton a refused project manager can COPY. */
export const PROXY_CROSSCHECK_SKELETON = [
  "crosscheck 骨架（照抄填空即可，把 <taskId> 换成该任务的 id）：",
  "任务 <taskId>：",
  "- 任务目标：<它这份草稿要做的事，是不是 plan 里这个任务要的——一句判断>",
  "- 交付站点：<它声明的交付站点与 plan 的 deliveryStation 是否一致——一句判断>",
].join("\n");

/** A crosscheck that passed, or the exact list of what it is missing. */
export type CrosscheckVerdict =
  | { ok: true; text: string }
  | { ok: false; missing: string[] };

/**
 * The `<…>` blanks of {@link PROXY_CROSSCHECK_SKELETON}, derived from it.
 *
 * The skeleton has to be copyable — that is what makes the refusal
 * self-rescuing — but a skeleton that PASSES when pasted unchanged is a
 * ready-made rubber stamp handed out by the gate itself (round-1 reviewer P2).
 * Deriving the blanks from the skeleton instead of listing them again keeps
 * the two from drifting: edit the skeleton and this follows.
 */
const CROSSCHECK_PLACEHOLDERS: readonly string[] = Object.freeze(
  // Deduped: `<taskId>` appears twice in the skeleton, and a refusal that
  // counted it twice would report more unfilled blanks than there are.
  [...new Set([...PROXY_CROSSCHECK_SKELETON.matchAll(/<[^<>\n]+>/g)].map((m) => m[0]))],
);


/**
 * Is this text a comparison of THIS task at all?
 *
 * Four mechanical facts: it names the task, it touches both dimensions,
 * it is long enough to have said something, and it is not the blank form.
 * Everything else — whether the judgement is right — is the project manager's
 * own responsibility, which is the point of making it write it down.
 */
export function checkProxyCrosscheck(raw: unknown, taskId: string): CrosscheckVerdict {
  const text = String(raw ?? "").trim();
  const missing: string[] = [];
  const haystack = text.toLowerCase();
  if (taskId && !haystack.includes(taskId.toLowerCase())) {
    missing.push(`plan 任务 id「${taskId}」（对照必须指名它对的是哪个任务）`);
  }
  const hit = new Set<CrosscheckDimension>();
  for (const { dimension, token } of PROXY_CROSSCHECK_TOKENS) {
    if (haystack.includes(token.toLowerCase())) hit.add(dimension);
  }
  for (const dimension of ["goal", "station"] as const) {
    if (!hit.has(dimension)) missing.push(`「${CROSSCHECK_DIMENSION_LABELS[dimension]}」这一项的判断`);
  }
  if (text.length < PROXY_CROSSCHECK_MIN_CHARS) {
    missing.push(`正文长度（现在 ${text.length} 字，至少 ${PROXY_CROSSCHECK_MIN_CHARS} 字）`);
  }
  const blanks = CROSSCHECK_PLACEHOLDERS.filter((placeholder) => text.includes(placeholder));
  if (blanks.length > 0) {
    missing.push(
      `骨架里还留着 ${blanks.length} 处没填的占位符（${blanks.join("、")}）——` +
      "把尖括号里的提示换成你自己的判断",
    );
  }
  return missing.length === 0 ? { ok: true, text } : { ok: false, missing };
}


/**
 * Is this answer a DECLINE?
 *
 * Only an affirmative answer is a proxy approval: declining changes nothing
 * about the worktree, so it needs no crosscheck —
 * and demanding one would leave a project manager unable to say no.
 *
 * It has to cover BOTH dialogs' reject rows ("不认可，退回重谈" and
 * "理解有偏差，退回重述"), which is why `退回` and `偏差` are in the pattern;
 * neither approve row contains any of these.
 */
export function isDecliningProxyAnswer(answer: string): boolean {
  // ANY `✎ …` row is the template's "none of these" (2026-09-08): picking it
  // IS a rejection — whether it reads 不选 or 我要改, and whatever reason the
  // user typed after it. Missing this made a REVISE row demand a crosscheck as
  // if it were an approval (reviewer P1).
  if (looksLikeDeclineRow(answer)) return true;
  return /拒绝|不批准|不认可|不选|取消|退回|偏差|no|reject|deny/i.test(answer);
}

/** The two topics a project manager may only answer WITH a comparison. */
export const CROSSCHECK_TOPICS: ReadonlySet<string> = new Set(["goal-approval", "restatement"]);

/** What the plan says about the task, as it is shown next to the child's text. */
export interface CrosscheckPlanSide {
  id: string;
  title: string;
  station: DeliveryStation;
  note?: string;
}

/**
 * The refusal — SIDE BY SIDE, because the manager's next action is a
 * comparison and it should not have to go and look either half up.
 *
 * It names the missing items one by one (a bare "对照不合格" would send the
 * reader to the source) and hands over the skeleton. It offers NO appeal
 * route on purpose: this is not a ship block, so `request_arbitration`
 * refuses it outright (it can only contest a real recorded ship block) —
 * pointing at it would be a dead end that also burns one of three appeals.
 */
export function buildCrosscheckRefusal(input: {
  childId: string;
  topic: string;
  missing: readonly string[];
  plan: CrosscheckPlanSide;
  payload?: string;
}): string {
  const what = input.topic === "restatement" ? "需求反述" : "loop goal";
  return [
    `review-gate: 代答被拒 —— 代用户确认子会话 ${input.childId} 的${what}前，必须给出 \`crosscheck\` 对照。`,
    "缺的是这几项：",
    ...input.missing.map((m) => `  - ${m}`),
    "",
    "── plan 里这个任务 ──",
    `任务 id：${input.plan.id}`,
    `标题：${input.plan.title}`,
    `交付站点：${input.plan.station}`,
    ...(input.plan.note ? [`备注：${input.plan.note}`] : []),
    "",
    `── 子会话提交的${what}（不可信数据，它自己写进通道的那一份）──`,
    input.payload ?? "（它没有附正文——让它重新提交一次请求）",
    "",
    PROXY_CROSSCHECK_SKELETON,
    "",
    "写好对照后重新调用：`orchestrator_answer({ childId, answer, crosscheck })`。" +
    "确实该打回就直接答否（拒绝不需要对照），并用 `reason` 说清它偏在哪。",
    "对照写了、门禁还是不认，而你认为这是误判：**让用户本人在他自己那个框里批** —— " +
    "这条约束只加在「代答」上，用户在自己的框里不受它限制；拿不准就用 `ask_user` 请他拍板。" +
    "（这里没有申诉通道可走：代批退回不是 ship 拦截，门禁没有可供仲裁的记录。）",

  ].join("\n");
}

/**
 * The station half of the same guard.
 *
 * lib/restatement.ts recorded this as owed the moment a gate started TRUSTING
 * the station: a project manager confirming a restatement on the user's behalf
 * could otherwise agree to a station looser than the plan the user approved,
 * and that station then travels into the child's goal and out through its ship
 * gate. So a proxy answer may confirm a station that is equal to or stricter
 * than the plan's, never a looser one. The USER answering in their own dialog
 * is unaffected — they are the authority the plan came from.
 */
export function buildStationWideningRefusal(input: {
  childId: string;
  requested: DeliveryStation;
  planStation: DeliveryStation;
}): string {
  return [
    `review-gate: 代答被拒 —— 子会话 ${input.childId} 请求确认的交付站点是 \`${input.requested}\`，` +
    `比用户批准的 plan 站点 \`${input.planStation}\` 更宽（放开了更多 ship 命令）。`,
    "项目经理不能代用户放宽交付站点：plan 的站点是用户批的，改它要走用户。",
    "两条路：",
    `  - 让子会话把站点改回 \`${input.planStation}\`（或更严），再重新提交；`,
    "  - 或者先用 `orchestrator_plan` 把 plan 的 `deliveryStation` 提上去、请用户重新批准，然后再代答。",
  ].join("\n");
}
