/**
 * The notice the gate sends when a BACKGROUND full precommit comes back
 * unfavourable — and whether that notice still describes the round it claims.
 *
 * WHY THIS IS A MODULE AND NOT A STRING IN THE EXTENSION (2026-09-12). The
 * first version reported the failure through `deliverAs: "followUp"`, which pi
 * drains only when the agent STOPS. The gate's own standing rule forbids the
 * agent to stop while a gate is unmet, so the notice was queued for hours:
 * measured on a real session (OneKeyHQ notification, 2026-09-12), three
 * failures at 03:01/03:15/03:23 were delivered at 05:14/05:21/05:24 — up to
 * 2h13m late — and by then the gate's own state said PASS + READY and
 * `declare_done` had been accepted. The message read as a flat contradiction,
 * the agent spent ten minutes building a case that the gate "misreports", and
 * two extra review rounds were spent on nothing.
 *
 * Two rules come out of that, both decided here so they are testable without a
 * session (the wiring is one `pi.sendMessage` call in the extension):
 *
 *  1. The notice says WHICH round and WHICH content it is about. A late message
 *     that cannot be matched against a round is worse than no message at all:
 *     it looks like a verdict on the round the agent is in right now.
 *
 *  2. When the content the lane verified is no longer the content on disk, the
 *     notice is DOWNGRADED — never suppressed. The run's own output is still
 *     evidence worth reading, so it stays; what goes away is the framing that
 *     makes a superseded round sound like the current one. Suppression was
 *     rejected by the user (2026-09-12): a failure can be real and merely
 *     early, and silence hides it.
 *
 * WHY "THE CONTENT MOVED" MEANS SUPERSEDED, GIVEN THAT EDITING DURING A LANE IS
 * THE NORMAL CASE. A round's checkpoint freezes the worktree the moment the
 * lane starts, and that frozen content is what the lane verifies and what the
 * reviewer judges; edits made while the suite runs (which the gate explicitly
 * encourages) belong to the NEXT round. So "verified X, now Y" is precisely
 * "that round's verification failed, and Y is somebody else's problem" — the
 * next round runs its own lane on its own content. Both readings are kept
 * honest by one rule: an UNKNOWN fingerprint is never treated as "equal". A
 * lane whose own content identity could not be read stays loud, which is the
 * fail-closed direction (a false alarm costs a re-run; a missed one costs a
 * verdict).
 */

/** How much of the runner's own output travels with the notice. */
export const ASYNC_PRECOMMIT_DETAIL_MAX = 4000;

/** Tree ids are echoed as a short prefix — the full 40/64 hex is noise here. */
const TREE_PREFIX = 12;

export interface AsyncPrecommitReport {
  /**
   * 1-based index of the round this lane belongs to (`state.rounds.length + 1`
   * at submission time). 0 when the caller cannot tell — the notice then says
   * "本轮" instead of inventing a number. Treat it as a HINT: the counter is
   * reset by `declare_done` (a finished task must not make the next one look
   * like "round 24/10"), so the FINGERPRINT below is the identity a reader
   * matches on, and the number is there to make it easy to find.
   */
  round: number;
  /**
   * Fingerprint (worktree tree OID) the lane was launched against, captured
   * BEFORE the runner starts. "" means it could not be read.
   */
  verified: string;
  /**
   * Fingerprint of the worktree at the moment the verdict is being reported.
   * "" means it could not be read.
   */
  current: string;
  /** Whatever the lane produced — anything but PASS reaches this reporter. */
  verdict: string;
  /** The `run_precommit` reply text, appended verbatim. Never a summary. */
  detail: string;
}

/**
 * Is this verdict about content nobody is holding any more?
 *
 * Requires BOTH sides to be known: an unreadable fingerprint on either side
 * leaves the notice in its loud form (see the module docstring).
 */
export function asyncPrecommitReportIsStale(
  input: Pick<AsyncPrecommitReport, "verified" | "current">,
): boolean {
  return Boolean(input.verified) && Boolean(input.current) && input.verified !== input.current;
}

function shortTree(tree: string): string {
  return tree ? tree.slice(0, TREE_PREFIX) : "未知";
}

/**
 * Build the notice. Chinese, like every other gate-to-agent line; the round
 * label and the tree ids are the parts that survive a late delivery.
 */
export function buildAsyncPrecommitReport(input: AsyncPrecommitReport): string {
  const label = input.round > 0 ? `第 ${input.round} 轮` : "本轮";
  const verified = shortTree(input.verified);
  const stale = asyncPrecommitReportIsStale(input);

  // The DOWNGRADED form. It keeps every fact the loud one carried — the round,
  // the content, the run's own output — and drops the two claims that made a
  // superseded notice dangerous: that this is the current round's verdict, and
  // that the way forward is to re-run this verification.
  const staleLead = [
    `review-gate: ${label}的后台 full precommit **没过**（${input.verdict}）—— 但它验证的是**那一轮**的内容（${verified}），`,
    `投递这一刻工作区已经是 ${shortTree(input.current)}，所以这条不描述现在这棵树，也不是当前这一轮的结论：`,
    "你正在改的那份内容，照常由它自己那一轮的 full precommit 判 —— 为这条去重跑测试或取证是白做工。",
    "（下面是那次运行的原始输出；.pi/precommit-last.log 每次运行都覆盖，现在指向的很可能是别的运行。）",
  ].join("\n");

  // The last line of the loud form states WHY it is loud. When a fingerprint
  // could not be read, it says that instead of claiming a match nobody measured
  // — the notice is loud either way, but it must not invent the reason.
  const loudWhy = input.verified && input.current
    ? `（工作区仍是这次验证的那份内容（${verified}），所以这条就是当前这一轮的结论。）`
    : `（内容指纹读不出来（这次验证 ${verified}、投递这一刻 ${shortTree(input.current)}），` +
      "所以无法判断它是不是已被后续改动取代 —— 按当前这一轮处理。）";

  // The LOUD form, i.e. still about the content on disk: identity added, the
  // instruction to re-submit kept (it is true here).
  const loudLead = [
    `review-gate: ${label}的后台 full precommit **没过**（${input.verdict}）—— 这份内容（${verified}）没通过验证，`,
    "本轮不会产生可 ship 的 READY。",
    '修好后重新 `judge_submit({role:"reviewer"})`；无需手动再跑 precommit。',
    "如果它是因为**与本次改动无关的环境问题**失败的，那是用户的决定：让用户 `/gate-bypass <理由>`。",
    loudWhy,
  ].join("\n");

  const lead = stale ? staleLead : loudLead;

  const detail = input.detail.slice(0, ASYNC_PRECOMMIT_DETAIL_MAX);
  return detail ? `${lead}\n\n${detail}` : lead;
}
