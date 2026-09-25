/**
 * The goal APPROVAL dialog's copy — what the user reads before approving a
 * loop goal (the transcript echo, the dialog title and the dialog body).
 *
 * Split out of lib/loop-goal.ts: this is presentation, the contract and its
 * hash stay there. Rendered by `propose_loop_goal` (lib/goal-tools.ts).
 */

import { parseNoAcceptanceDeclaration } from "./acceptance-round.ts";
import { LOOP_GOAL_RELPATH, normalizeGoalText } from "./loop-goal.ts";

export const GOAL_CONFIRM_TITLE = "review-gate: AI 提交了本次任务的目标（退出条约）——是否认可？";

/**
 * Full-text message shown in the TRANSCRIPT before the approval dialog opens.
 *
 * WHY NOT IN THE DIALOG. A dialog renders its text as one unclipped block
 * pinned to the bottom of the screen; a goal-sized block makes the dialog
 * taller than the terminal, which pushes the animating spinner row out of the
 * viewport and turns every spinner frame into a full-screen clear (see
 * lib/renderer-mode.ts — that is where the measurement lives now, and where
 * the session that is NOT on the fullscreen renderer is told about it). The
 * transcript, unlike the dialog, scrolls — so the reviewable text goes there
 * and the dialog keeps only the decision.
 *
 * AND IT IS THE WHOLE GOAL (user decision, 2026-09-14). This used to echo only
 * the first 2000 characters with an `…（已截断）` tail — cutting exactly the
 * text the user is being asked to approve, on a surface that is not
 * constrained at all: measured on the real renderer, appending 400 rows to the
 * transcript triggers 0 full clears, so length here costs nothing but scroll.
 * The dialog's height is no longer budgeted at all (2026-09-16), and the
 * dialog never carries the goal text anyway.
 *
 * A goal can still be too long, but that is refused, not silently shortened:
 * `LOOP_GOAL_MAX_WRITE_CHARS` bounds what the extension will write at all.
 */
export function buildGoalTranscriptMessage(goalText: string): string {
  return (
    "───── AI 提交的目标（不可信数据） ─────\n" +
    normalizeGoalText(goalText) +
    "\n───────────────────────\n" +
    "认可后，以上内容将由扩展写入 `" + LOOP_GOAL_RELPATH + "`，作为本会话的退出条约：" +
    "reviewer 会逐条验收它，loop 模式下未经认可的目标会拦住 commit/push/PR。"
  );
}

/** Max characters of the goal's title line echoed into the dialog. */
export const GOAL_DIALOG_TITLE_MAX_CHARS = 60;

/**
 * Dialog body — the decision only. The goal text itself was just printed to
 * the transcript by {@link buildGoalTranscriptMessage}; repeating it here would
 * bury the decision, so this stays a handful of lines. What the BOUNDS are is
 * now only input-side: the agent's own title is hard-capped (see below).
 *
 * ORDER: see the comment on the return below — that is the ONE statement of
 * the ordering policy, because it depends on every part of the body and a
 * second copy here is a copy that goes stale (this one did: it still claimed
 * the consequence copy comes first, which is exactly the order that made a
 * narrow terminal truncate INTO the consent-critical lines — round-1 review
 * P1, 2026-09-16). What the BOUNDS are: the agent's own title is hard-capped,
 * and the body is passed through whole (no fit — the row budget is gone).
 */
export function buildGoalConfirmMessage(goalText: string, extraUntrusted?: string): string {
  const normalized = normalizeGoalText(goalText);
  const rawTitle = normalized.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "（空）";
  const title = rawTitle.length > GOAL_DIALOG_TITLE_MAX_CHARS
    ? rawTitle.slice(0, GOAL_DIALOG_TITLE_MAX_CHARS) + "…"
    : rawTitle;
  // Read through the SAME parser the completion-time decision uses, so the
  // line below and the skip it authorizes can never disagree about whether the
  // clause is present and whether it carries a reason.
  const noAcceptance = parseNoAcceptanceDeclaration(normalized);
  return (
    // ORDER IS THE READING ORDER (2026-09-16). `fitDialogMessage` is gone, so
    // nothing is truncated — but the box is still read top-down, and the lines
    //   1. the untrusted facts the user is CONFIRMING (repo, station,
    //      `goal-auditor 预审: PASS`) — losing one of these means consenting to
    //      something the dialog never showed;
    //   2. what approval / rejection will actually do;
    //   3. the goal's own title, whose full text is on screen right above.
    // The order used to put (2) before (1) and the title last but ONE, so on a
    // narrow terminal the truncation cut INTO (1) long before it touched the
    // title (measured: at 60 columns with a 120-character path, both the
    // station line and the pre-review line were dropped). Extra untrusted
    // facts go before everything for the same reason they always did.
    (extraUntrusted ? extraUntrusted + "\n" : "") +
    // THE ONE EXEMPTION ONLY THE USER MAY GRANT (2026-09-22). A goal that
    // declares this round has nothing to accept for real is consenting to skip
    // the acceptance judge, so the box that asks for consent says so — in its
    // own line, before the ordinary approval copy, because a narrow terminal
    // truncates from the bottom. An acceptance judge may never exempt itself;
    // this line is where the decision actually happens.
    (noAcceptance === undefined
      ? ""
      : `⚠️ 本轮无真实验收：${noAcceptance.reason} —— 认可即同意这一轮跳过真实验收（该豁免只有你能拍板，验收 agent 无权自行豁免）。\n`) +
    "认可后：扩展把它写入 `" + LOOP_GOAL_RELPATH + "`，reviewer 逐条验收。\n" +
    "不认可就拒绝，然后告诉 AI 哪里不对；它会重新跟你确认后再提交。\n" +
    "目标全文（不可信数据）已显示在上方消息中，请先读完再决定。\n" +
    "标题（不可信数据）: " + title
  );
}
