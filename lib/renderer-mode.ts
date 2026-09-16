/**
 * WHICH RENDERER THIS SESSION IS ON — and what a session on the wrong one is
 * told, once (2026-09-16, user decision).
 *
 * ── WHY THE GATE STOPPED BUDGETING DIALOG HEIGHT ──
 *
 * Dialog content used to be truncated to a rendered-row budget
 * (`lib/dialog-budget.ts`, now deleted) because of a measured failure in pi's
 * DEFAULT renderer: a dialog tall enough to push the working spinner out of
 * the viewport made `tui-main-screen.ts` take its `firstChanged <
 * prevViewportTop` branch, and `fullRender(true)` clears the screen AND the
 * scrollback — about ten times a second, while the user was reading that very
 * dialog. (Measured on a 40-row terminal: dialog + rows below = 39 ⇒ 0 full
 * clears in 30 frames; = 40 ⇒ 29/30.)
 *
 * That budget had a cost of its own, and it landed on the one thing a dialog
 * must never lose: the lines the user is CONFIRMING. Cutting a long repo path
 * and then the tail of the body could take the station line and the
 * `goal-auditor 预审: PASS` line with it, while the dialog went on asking for
 * approval.
 *
 * A renderer that OWNS the screen never hits that branch at all — pi ships it
 * as `TuiAltScreen`, selected by `--tui-mode fullscreen` / the `tuiMode`
 * setting — and the user runs every session that way. So the budget is gone and
 * the tall-dialog problem is now handled by TELLING the session when it is not
 * on that renderer.
 *
 * ── WHY THE MODE COMES FROM THE HOST AND NOT FROM CONFIG ──
 *
 * Reading it back out of `--tui-mode` and the two settings files would be a
 * COPY of pi's own precedence, and copies of precedence rules get the corners
 * wrong (a project's `.pi/settings.json` is ignored ENTIRELY until the folder
 * is trusted; `/settings` can flip the mode mid-session). The host hands an
 * extension the real thing — `TUI.mode` — through the `setWidget` / `setFooter`
 * / `setHeader` factory forms, so that is where it is read.
 */

/** `TUI.mode`'s own vocabulary, re-declared so this module stays dependency-free. */
export type RendererMode = "regular" | "fullscreen";

/**
 * Should this session be told which renderer it is on?
 *
 * PURE, and deliberately taking both facts rather than looking either one up:
 * "the host said nothing" (`undefined` — a non-interactive host, which has no
 * renderer to worry about) is NOT "regular", and a session is told at most
 * once by the caller's own memory.
 */
export function rendererModeNoticeDue(
  mode: RendererMode | undefined,
  alreadyShown: boolean,
): boolean {
  return mode === "regular" && !alreadyShown;
}

/**
 * What such a session is told. It names BOTH ways to fix it — the flag and the
 * setting — because the user's launch habit is not knowable from here, and a
 * notice that only offers the one they do not use is a notice they ignore.
 *
 * The last line matters as much as the first two: this is advice about the
 * terminal, not a gate, and saying so is what keeps it from reading as one.
 */
export const RENDERER_MODE_NOTICE =
  "review-gate: 这个会话跑在 pi 的默认（regular）渲染器上 —— 对话框不再按终端高度裁剪，" +
  "一旦它长到把工作指示器挤出视口，pi-tui 会每帧清屏并反复擦掉滚回缓冲。\n" +
  "  避开它：用 `--tui-mode fullscreen` 启动，或把 `\"tuiMode\": \"fullscreen\"` 写进 " +
  "`~/.pi/agent/settings.json`（项目级 `.pi/settings.json` 同样生效）。\n" +
  "  这只是提醒，不拦任何操作。";
