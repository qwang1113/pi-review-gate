/**
 * PRESSING a key in a child session — the second atomic capability the layer
 * was missing (F6), and the one that made the "proxy-approve a child's goal"
 * power unreachable (F11).
 *
 * The measured failure: `orchestrator_send` could only type TEXT and submit
 * it. When the child raised a choice dialog, the orchestrator sent "A", the
 * TUI ignored the text and the Enter landed on whatever row happened to be
 * highlighted — which was the right one, once, by luck. The verification
 * notes call it exactly that: "看似成功实为侥幸". A selection mechanism whose
 * success depends on the default row is not a selection mechanism.
 *
 * WHAT THIS MODULE DECIDES (user decision: high-level first, low-level as a
 * backstop):
 *
 *   high level   "select item N" / "select the item matching X" — the gate
 *                reads the highlight itself, computes the arrow presses and
 *                CHECKS afterwards that the highlight actually moved.
 *   low level    up / down / enter / escape / tab … for everything the
 *                high-level path cannot express (dismissing with Escape,
 *                answering a free-text prompt).
 *
 * THE PROTOCOL IS TWO-PHASE ON PURPOSE. Move, re-read, confirm the highlight
 * is on the target, and only THEN press Enter. Pressing Enter blind is what
 * F11 did; a wrong Enter in a goal-approval dialog is an irreversible answer
 * given on the user's behalf. If any step cannot be confirmed the tool fails
 * loudly — the whole point of this round is that a receipt never lies.
 *
 * Pure module: it plans key sequences and judges observations. It never
 * touches tmux (lib/orchestrator-tmux.ts builds the argv).
 */

import type { PaneDialog, PaneSnapshot } from "./orchestrator-pane-read.ts";

/** The keys an orchestrator may press. Deliberately a short, closed list. */
export type LowLevelKey =
  | "up" | "down" | "left" | "right"
  | "enter" | "escape" | "tab" | "space" | "backspace";

/**
 * Agent-facing name → the name tmux's `send-keys` understands.
 *
 * A closed map, not a passthrough: `send-keys` treats any unknown word as
 * literal text, so a typo would silently type "escpae" into the child's
 * composer instead of dismissing its dialog.
 */
export const TMUX_KEY_NAMES: Readonly<Record<LowLevelKey, string>> = Object.freeze({
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "BSpace",
});

const KEY_ALIASES: Readonly<Record<string, LowLevelKey>> = Object.freeze({
  up: "up", k: "up", arrowup: "up",
  down: "down", j: "down", arrowdown: "down",
  left: "left", arrowleft: "left",
  right: "right", arrowright: "right",
  enter: "enter", return: "enter", cr: "enter",
  escape: "escape", esc: "escape",
  tab: "tab",
  space: "space",
  backspace: "backspace", bspace: "backspace",
});

/** Normalize one agent-supplied key name, or `undefined` when unknown. */
export function normalizeKey(raw: unknown): LowLevelKey | undefined {
  const key = String(raw ?? "").trim().toLowerCase();
  return KEY_ALIASES[key];
}

/** Turn agent-supplied key names into tmux names, refusing the first unknown. */
export function normalizeKeySequence(
  raw: unknown,
): { ok: true; keys: LowLevelKey[] } | { ok: false; reason: string } {
  const list = Array.isArray(raw) ? raw : [raw];
  const keys: LowLevelKey[] = [];
  for (const entry of list) {
    const key = normalizeKey(entry);
    if (!key) {
      return {
        ok: false,
        reason:
          `不认识的按键 "${String(entry)}" —— 只支持：${Object.keys(TMUX_KEY_NAMES).join(", ")}。` +
          "（按键名是白名单，不是透传：tmux 会把不认识的词当字面文本敲进子会话的输入框。）",
      };
    }
    keys.push(key);
  }
  if (keys.length === 0) return { ok: false, reason: "没有要按的键。" };
  return { ok: true, keys };
}

// ---------------------------------------------------------------------------
// High-level selection
// ---------------------------------------------------------------------------

/** How the caller named the row it wants. Exactly one is used. */
export interface SelectionRequest {
  /** 1-based index, as `orchestrator_read` printed it. */
  index?: number;
  /** Case-insensitive substring of the row's label. */
  match?: string;
}

export type SelectionTarget =
  | { ok: true; index: number; label: string }
  | { ok: false; reason: string };

/**
 * Rows that mean "yes, approve this" in a gate dialog (F11).
 *
 * Used ONLY to find a candidate; the caller still has to establish that
 * exactly ONE row matches and then go through the ordinary verified
 * selection. A pattern that matched two rows would be resolved by refusing,
 * never by picking the first — the whole failure being fixed here is a
 * confident press on an unidentified row.
 */
export const APPROVE_LABEL_PATTERN = /认可|批准|同意|确认|接受|\bapprove\b|\bconfirm\b|\baccept\b|^\s*yes\b/i;

/**
 * Which row does the caller mean?
 *
 * A `match` must hit EXACTLY ONE row. An ambiguous match is refused rather
 * than resolved by "first wins": two options whose labels share a substring
 * are precisely where a silent pick answers the wrong question.
 */
export function resolveSelectionTarget(
  dialog: PaneDialog | undefined,
  request: SelectionRequest,
): SelectionTarget {
  if (!dialog || dialog.options.length === 0) {
    return {
      ok: false,
      reason:
        "当前 pane 里没有解析出选项列表 —— 先用 `orchestrator_read` 看看它到底在问什么；" +
        "如果确实是选项框但没被识别出来，用低层按键（keys: [\"down\",\"enter\"]）自己走。",
    };
  }
  const { index, match } = request;
  if (index !== undefined) {
    const found = dialog.options.find((o) => o.index === index);
    if (!found) {
      return {
        ok: false,
        reason: `第 ${index} 项不存在 —— 这个对话框只有 ${dialog.options.length} 项。`,
      };
    }
    return { ok: true, index: found.index, label: found.label };
  }
  const needle = String(match ?? "").trim().toLowerCase();
  if (!needle) {
    return { ok: false, reason: "要选哪一项没说清楚：给 `index`（第几项）或 `match`（选项文本）。" };
  }
  const hits = dialog.options.filter((o) => o.label.toLowerCase().includes(needle));
  if (hits.length === 0) {
    return {
      ok: false,
      reason:
        `没有选项包含 "${match}" —— 现有选项：` +
        dialog.options.map((o) => `${o.index}. ${o.label}`).join(" / "),
    };
  }
  if (hits.length > 1) {
    return {
      ok: false,
      reason:
        `"${match}" 同时匹配了 ${hits.length} 项（${hits.map((h) => h.index).join(", ")}）—— ` +
        "歧义不猜：改用 `index` 指名第几项。",
    };
  }
  return { ok: true, index: hits[0]!.index, label: hits[0]!.label };
}

/**
 * The arrow presses that move the highlight from `from` to `to`.
 *
 * No Enter here, by design: submitting is a SEPARATE step that only runs
 * after the move has been re-read and confirmed (see the header).
 */
export function planMoveKeys(from: number, to: number): LowLevelKey[] {
  const distance = to - from;
  const key: LowLevelKey = distance > 0 ? "down" : "up";
  return Array.from({ length: Math.abs(distance) }, () => key);
}

export type SelectionPlan =
  | { ok: true; target: number; label: string; moves: LowLevelKey[] }
  | { ok: false; reason: string };

/**
 * Plan a selection against the CURRENT screen.
 *
 * Refuses when the highlight could not be located: without a known starting
 * row there is no way to count arrow presses, and guessing "it is probably on
 * the first one" is the F6 failure in a new costume.
 */
export function planSelection(
  dialog: PaneDialog | undefined,
  request: SelectionRequest,
): SelectionPlan {
  const target = resolveSelectionTarget(dialog, request);
  if (!target.ok) return target;
  const from = dialog?.selectedIndex;
  if (from === undefined) {
    return {
      ok: false,
      reason:
        "读不到当前高亮的是第几项，因而算不出要按几次方向键 —— 拒绝盲按（盲按 Enter 正是 F11 的错法）。" +
        "先 `orchestrator_read` 确认这个框长什么样，必要时用低层按键手动走。",
    };
  }
  return { ok: true, target: target.index, label: target.label, moves: planMoveKeys(from, target.index) };
}

// ---------------------------------------------------------------------------
// Verification — the half that makes the receipt honest
// ---------------------------------------------------------------------------

export type KeyVerification = { ok: true; note: string } | { ok: false; reason: string };

/** After the moves: is the highlight really on the row we aimed at? */
export function verifyHighlight(
  after: PaneSnapshot | undefined,
  target: number,
  label: string,
): KeyVerification {
  const dialog = after?.dialog;
  if (!dialog) {
    return {
      ok: false,
      reason:
        "按完方向键后 pane 里已经读不到选项列表了 —— 对话框可能被别人（用户本人？）答掉了，" +
        "也可能是解析失效。先 `orchestrator_read` 看清楚现状，不要继续按 Enter。",
    };
  }
  if (dialog.selectedIndex === undefined) {
    return { ok: false, reason: "按完方向键后读不到高亮项，无法确认是否命中 —— 拒绝提交。" };
  }
  if (dialog.selectedIndex !== target) {
    const now = dialog.options.find((o) => o.index === dialog.selectedIndex)?.label ?? "?";
    return {
      ok: false,
      reason:
        `方向键没走到位：想选第 ${target} 项（${label}），现在高亮的是第 ${dialog.selectedIndex} 项（${now}）——` +
        "没有提交任何东西。",
    };
  }
  return { ok: true, note: `高亮已落在第 ${target} 项（${label}）` };
}

/** After Enter: the dialog must be GONE, otherwise nothing was answered. */
export function verifyDismissed(after: PaneSnapshot | undefined, label: string): KeyVerification {
  if (after?.dialog && after.dialog.options.length >= 2) {
    return {
      ok: false,
      reason:
        `按下 Enter 之后对话框还在 —— 无法确认「${label}」真的被提交了。` +
        "不谎报成功：请 `orchestrator_read` 看现状，必要时用低层按键处理。",
    };
  }
  return { ok: true, note: `对话框已关闭，「${label}」已提交` };
}
