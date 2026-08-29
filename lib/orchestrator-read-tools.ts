/**
 * The two READ/PRESS tools — `orchestrator_read` and `orchestrator_key`.
 *
 * They are the atomic capabilities the first real orchestration did not have,
 * and their absence is the whole reason it deadlocked on the first hop: the
 * orchestrator could be TOLD that a child needed it (an attention event) and
 * had no way to see WHAT it was being asked (F3), nor any way to answer a
 * choice dialog reliably (F6) — which in turn made the "proxy-approve the
 * child's goal" power granted by the task book physically unreachable (F11).
 *
 * They live in their own module rather than in
 * lib/orchestrator-session-tools.ts for the reason this repository now has a
 * rule about: that file was already 483 lines, and "just add the two new
 * tools here" is exactly the move that produced an 8933-line extension. The
 * decisions themselves are one level further out again, in the two pure
 * modules lib/orchestrator-pane-read.ts (what is on screen) and
 * lib/orchestrator-keys.ts (which keys, and did they land) — so every rule
 * here is unit-testable without a terminal.
 *
 * THE ONE PRINCIPLE BOTH TOOLS OBEY: never claim more than was observed. A
 * read says which channel each fact came from; a key press re-reads the
 * screen and FAILS if it cannot confirm the highlight moved, rather than
 * reporting the success it hoped for. F8/F11 were both "the gate checked its
 * own half and called it done".
 */

import { Type } from "typebox";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";
import { buildSendKeysArgv } from "./orchestrator-tmux.ts";
import { findChild } from "./orchestrator-registry.ts";
import { formatChildHealth } from "./orchestrator-child-state.ts";

import type { ChildSession } from "./orchestrator-registry.ts";
import {
  formatPaneSnapshot,
  PANE_CAPTURE_LINES,
  type PaneSnapshot,
} from "./orchestrator-pane-read.ts";
import {
  describeScreenChange,
  normalizeKeySequence,
  planSelection,
  SUBMIT_KEY_ORDER,
  verifyDismissed,
  verifyHighlight,
  type LowLevelKey,
} from "./orchestrator-keys.ts";

import {
  capturePane,
  childGateFacts,
  toolFail as fail,
  toolReply as reply,
  requireOrchestratorMode,
} from "./orchestrator-tool-kit.ts";

/** How long a TUI is given to repaint before the screen is read back. */
export const KEY_SETTLE_MS = 400;
/** How many times a read-back is retried while the screen is still stale. */
export const KEY_SETTLE_ATTEMPTS = 3;

/** Resolve `childId` to an addressable, still-open child. */
function openChild(
  deps: OrchestratorDeps,
  params: Record<string, unknown>,
): { ok: true; child: ChildSession } | { ok: false; problem: ToolReply } {
  const childId = String(params.childId ?? "").trim();
  const child = findChild(deps.runtime(), childId);
  if (!child) {
    return {
      ok: false,
      problem: fail(
        `review-gate: 没有登记过子会话 "${childId}" —— 只能读/按由 orchestrator_spawn 开出来的 pane。` +
        "用 `orchestrator_status` 看现有子会话。",
      ),
    };
  }
  if (child.closedAt) {
    return { ok: false, problem: fail(`review-gate: 子会话 "${child.id}" 已经关闭了（${child.closedAt}）。`) };
  }
  return { ok: true, child };
}

/** The sidecar half of a read, rendered with its provenance stated. */
function renderGateFacts(deps: OrchestratorDeps, child: ChildSession): string[] {
  const facts = childGateFacts(deps, child);
  if (!facts.present) {
    return [
      "### 子会话门禁状态（来源：它自己的 sidecar）",
      "（还没有 sidecar —— 它要么刚起来、要么根本没加载 review-gate 扩展）",
    ];
  }
  const out = [
    "### 子会话门禁状态（来源：它自己的 sidecar，结构化真值）",
    ...(facts.lines.length ? facts.lines.map((l) => `- ${l}`) : ["（sidecar 里没有可读的字段）"]),
  ];
  if (facts.goalDraft) {
    out.push(
      "",
      "#### 它正在申请批准的 goal 草稿全文（来源：sidecar `goalPrereview.draft`）",
      facts.goalDraft,
    );
  }
  return out;
}

async function doRead(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const resolved = openChild(deps, params);
  if (!resolved.ok) return resolved.problem;
  const child = resolved.child;

  const requested = Number(params.lines);
  const snapshot = capturePane(
    deps,
    child.paneId,
    Number.isFinite(requested) ? requested : PANE_CAPTURE_LINES,
  );
  const sections: string[] = [
    `## 子会话 ${child.id}（task=${child.taskId}，pane ${child.paneId}）`,
    ...(child.taskFile ? [`任务书：${child.taskFile}`] : []),
    "",
  ];
  if (!snapshot) {
    sections.push(
      "### pane 可见文本",
      "（读不到 —— tmux capture-pane 失败：pane 可能已经不在了，先 `orchestrator_status` 看看）",
    );
  } else {
    sections.push(formatPaneSnapshot(snapshot));
  }
  sections.push("", ...renderGateFacts(deps, child));
  // R-11 — the state the PROBE measured, printed next to the screen it was
  // measured from. A human reading a pane mis-judged a healthy child as
  // "terminated" during the second run; the structured verdict is what the
  // waiter acts on, so the read shows the same thing rather than a second
  // opinion the agent has to reconcile.
  const health = deps.probe().observe().health.find((h) => h.childId === child.id);
  if (health) {
    sections.push("", "### 门禁探针判定的状态（结构化真值，优先于上面的屏幕启发式）", formatChildHealth([health]));
  }
  return reply(sections.join("\n"), {
    childId: child.id,
    paneRead: Boolean(snapshot),
    dialogOptions: snapshot?.dialog?.options.length ?? 0,
    selectedIndex: snapshot?.dialog?.selectedIndex,
    ...(health ? { state: health.state } : {}),
  });

}

/** Press keys, then let the TUI repaint before reading the screen back. */
async function pressAndReRead(
  deps: OrchestratorDeps,
  paneId: string,
  keys: readonly LowLevelKey[],
): Promise<{ ok: true; after: PaneSnapshot | undefined } | { ok: false; reason: string }> {
  try {
    const result = deps.tmux(buildSendKeysArgv(paneId, keys));
    if (!result.ok) return { ok: false, reason: result.stderr || "tmux send-keys 出错" };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  let after: PaneSnapshot | undefined;
  for (let attempt = 0; attempt < KEY_SETTLE_ATTEMPTS; attempt++) {
    await deps.sleep(KEY_SETTLE_MS);
    after = capturePane(deps, paneId);
    if (after) break;
  }
  return { ok: true, after };
}

/**
 * Capture the pane, retrying while the parse comes back WITHOUT a dialog.
 *
 * R-18: the same goal-approval dialog (`→ Yes / No`, plainly on screen) was
 * read three times in a row with three different results — "no options
 * parsed", then a refusal that recommended the very path that had just
 * failed, then a clean success. A TUI repaints; a single capture taken mid
 * repaint is not evidence that there is no dialog. So the read is retried a
 * few times before anybody concludes anything, and BOTH callers (the key
 * press and the proxy-approval) go through this one function — which is what
 * stops the two of them from disagreeing and bouncing the caller between them.
 */
export async function captureDialog(
  deps: OrchestratorDeps,
  paneId: string,
  attempts = KEY_SETTLE_ATTEMPTS,
): Promise<PaneSnapshot | undefined> {
  let snapshot: PaneSnapshot | undefined;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    if (attempt > 0) await deps.sleep(KEY_SETTLE_MS);
    const current = capturePane(deps, paneId);
    if (current) snapshot = current;
    if (current?.dialog) return current;
  }
  return snapshot;
}

/**
 * The HIGH-LEVEL path: select a row by index or by label.
 *
 * Two phases, and the split is the whole point (see lib/orchestrator-keys.ts):
 * move first, confirm the highlight actually landed on the target, and only
 * then submit. Pressing Enter before confirming is what answered a
 * goal-approval dialog by luck in the hand-run.
 *
 * SUBMITTING IS THE GATE'S PROBLEM, not the caller's (R-8). A pi confirmation
 * dialog was measured ignoring `Enter` and `C-m` entirely and moving only on
 * `KPEnter`, so the submit step tries the alternatives in order and re-reads
 * after each: the caller says "select this row", never "press this byte".
 */
export async function selectOptionInChild(
  deps: OrchestratorDeps,
  child: ChildSession,
  request: { index?: number; match?: string },
): Promise<ToolReply> {
  const before = await captureDialog(deps, child.paneId);
  if (!before) {
    return fail(`review-gate: 读不到子会话 ${child.id} 的屏幕（capture-pane 失败），拒绝盲按。`);
  }
  const plan = planSelection(before.dialog, request);
  if (!plan.ok) return fail("review-gate: " + plan.reason, { paneText: before.text.slice(-2000) });

  let after: PaneSnapshot | undefined = before;
  if (plan.moves.length > 0) {
    const moved = await pressAndReRead(deps, child.paneId, plan.moves);
    if (!moved.ok) return fail(`review-gate: 方向键发送失败 —— ${moved.reason}`);
    after = moved.after;
  }
  const highlight = verifyHighlight(after, plan.target, plan.label);
  if (!highlight.ok) {
    return fail("review-gate: " + highlight.reason, {
      childId: child.id,
      submitted: false,
      paneText: after?.text.slice(-2000),
    });
  }

  const beforeSubmit = after;
  const tried: LowLevelKey[] = [];
  let dismissed = verifyDismissed(beforeSubmit, beforeSubmit, plan.label);
  let screen: PaneSnapshot | undefined = beforeSubmit;
  for (const key of SUBMIT_KEY_ORDER) {
    const submitted = await pressAndReRead(deps, child.paneId, [key]);
    if (!submitted.ok) {
      return fail(
        `review-gate: 高亮已经落在第 ${plan.target} 项（${plan.label}），但提交键 ${key} 没发出去 —— ` +
        `${submitted.reason}。**没有提交任何东西**，可以重试。`,
        { childId: child.id, submitted: false },
      );
    }
    tried.push(key);
    screen = submitted.after;
    dismissed = verifyDismissed(beforeSubmit, submitted.after, plan.label);
    if (dismissed.ok) break;
  }
  if (!dismissed.ok) {
    return fail(
      `review-gate: ${dismissed.reason}\n已经试过的提交键：${tried.join(" → ")}（都没让这个框有任何变化）。`,
      {
        childId: child.id,
        submitted: false,
        submitKeysTried: tried,
        paneText: screen?.text.slice(-2000),
      },
    );
  }
  return reply(
    `review-gate: 已在子会话 ${child.id} 选中第 ${plan.target} 项「${plan.label}」并提交` +
    `（提交键：${tried.join(" → ")}）。\n` +
    `校验：${highlight.note}；${dismissed.note}（两步都是按完复读屏幕确认的，不是「发出去就算数」）。\n\n` +
    (screen ? formatPaneSnapshot(screen, 40) : "（按完之后读不到屏幕）"),
    { childId: child.id, submitted: true, target: plan.target, label: plan.label, submitKeysTried: tried },
  );
}


/**
 * The LOW-LEVEL path: press exactly these keys, and report what happened.
 *
 * It performs no hit check by design — the gate does not know what the caller
 * wanted. It does know whether the screen MOVED, though, and R-8 is what
 * happens when that fact is withheld: `keys:["enter"]` was sent at a dialog
 * that ignores `Enter`, the receipt reported the press as delivered, and the
 * orchestrator waited 600s on an answer it had never given. So the receipt
 * now states the before/after comparison, and says plainly when nothing
 * changed.
 */
async function pressKeys(
  deps: OrchestratorDeps,
  child: ChildSession,
  raw: unknown,
): Promise<ToolReply> {
  const normalized = normalizeKeySequence(raw);
  if (!normalized.ok) return fail("review-gate: " + normalized.reason);
  const before = capturePane(deps, child.paneId);
  const pressed = await pressAndReRead(deps, child.paneId, normalized.keys);
  if (!pressed.ok) return fail(`review-gate: 按键发送失败 —— ${pressed.reason}`);
  const change = describeScreenChange(before, pressed.after);
  return reply(
    `review-gate: 已在子会话 ${child.id} 按下 ${normalized.keys.join(" → ")}。\n` +
    "低层按键没有「命中校验」可做（门禁不知道你想达成什么），能给的只有两件事实：\n" +
    `- ${change.note}\n` +
    "- 按完之后的屏幕如下，由你自己判断是不是想要的结果：\n\n" +
    (pressed.after ? formatPaneSnapshot(pressed.after, 40) : "（按完之后读不到屏幕）"),
    { childId: child.id, keys: normalized.keys, screenChanged: change.changed },
  );
}


async function doKey(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const resolved = openChild(deps, params);
  if (!resolved.ok) return resolved.problem;
  const child = resolved.child;

  const rawIndex = params.index;
  const index = typeof rawIndex === "number" && Number.isFinite(rawIndex) ? Math.floor(rawIndex) : undefined;
  const match = String(params.match ?? "").trim() || undefined;
  const keys = params.keys;

  if (index !== undefined || match !== undefined) {
    if (keys !== undefined) {
      return fail(
        "review-gate: `keys`（低层按键）和 `index`/`match`（高层选项）不能同时给 —— " +
        "两者的语义不同：高层带命中校验，低层不带。选一个。",
      );
    }
    return selectOptionInChild(deps, child, { index, match });
  }
  if (keys !== undefined) return pressKeys(deps, child, keys);
  return fail(
    "review-gate: 没说要做什么 —— 用 `index`/`match` 选一项（带命中校验，推荐），" +
    "或者用 `keys` 直接按键（例如 [\"escape\"] 关掉一个框）。",
  );
}

/** Register `orchestrator_read` and `orchestrator_key`. */
export function registerOrchestratorReadTools(host: ToolHost, deps: OrchestratorDeps): void {
  const guarded = (
    run: (params: Record<string, unknown>) => Promise<ToolReply>,
  ) => async (_id: string, params: Record<string, unknown>): Promise<ToolReply> => {
    const refusal = requireOrchestratorMode(deps);
    if (refusal) return refusal;
    return run(params);
  };

  host.registerTool({
    name: "orchestrator_read",
    label: "Read A Child Session",
    description:
      "See what a child session is actually saying — its visible screen (including any choice " +
      "dialog, its options and which one is highlighted) AND its own gate state (mode, branch, " +
      "verdicts, the goal draft it is asking you to approve). Every fact is labelled with the " +
      "channel it came from: the screen is a heuristic parse of tmux capture-pane, the gate " +
      "state is exact. Call this the moment `orchestrator_wait` reports an attention event — " +
      "the event carries only a one-line reason, never the question itself.",
    parameters: Type.Object({
      childId: Type.String({ description: "Registry handle of the child session" }),
      lines: Type.Optional(Type.Integer({
        description: `How many lines of scrollback to capture (default ${PANE_CAPTURE_LINES})`,
      })),
    }),
    execute: guarded((params) => doRead(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_key",
    label: "Answer A Child's Dialog",
    description:
      "Answer a child session's choice dialog. PREFERRED: `index` (the row number " +
      "`orchestrator_read` printed) or `match` (a substring of the row's label) — the gate reads " +
      "the current highlight itself, computes the arrow presses, re-reads the screen to confirm " +
      "the highlight landed on the row you named, and only THEN submits — trying `Enter` and, if " +
      "that dialog ignores it, `KPEnter`, because which byte a TUI accepts is the gate's problem " +
      "and not yours; anything it cannot confirm is reported as a FAILURE, never as a success. " +
      "FALLBACK: `keys` presses exact keys (up/down/left/right/enter/kpenter/submit/escape/tab/" +
      "space/backspace) with no hit check — use it for things a selection cannot express, such as " +
      "dismissing a dialog with Escape. The low-level receipt states whether the screen changed " +
      "at all, so a key that does nothing in this TUI is never reported as if it worked.",

    parameters: Type.Object({
      childId: Type.String(),
      index: Type.Optional(Type.Integer({ description: "1-based row number to select" })),
      match: Type.Optional(Type.String({ description: "Unique substring of the row's label" })),
      keys: Type.Optional(Type.Array(Type.String(), {
        description: "Low-level keys, in order (e.g. [\"escape\"]). Cannot be combined with index/match.",
      })),
    }),
    execute: guarded((params) => doKey(deps, params)),
  });
}
