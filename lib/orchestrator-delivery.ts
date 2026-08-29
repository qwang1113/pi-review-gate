/**
 * DELIVERY — getting a task into a child session, and refusing to say it
 * arrived unless it demonstrably did (F7, F8, F11).
 *
 * THE MEASURED FAILURE, in order. `orchestrator_spawn` typed the task text
 * into the new pane with `send-keys`: the text was TRUNCATED mid-sentence
 * (F7), no Enter ever submitted what survived (F8), and the tool nevertheless
 * reported "任务说明已发过去" and told the orchestrator to go wait (F8 again).
 * The orchestrator then waited on a child that was sitting in an empty
 * composer with 0.0% context. One human keystroke is what unblocked the whole
 * night. This module removes both halves of that failure:
 *
 *  1. THE TASK NO LONGER TRAVELS THROUGH THE KEYBOARD. It is written to a
 *     file and handed to the child as pi's own `@file` argv message — the
 *     exact mechanism lib/judge-process.ts has used since 2026-08-28. A file
 *     cannot be truncated by a TUI, cannot be split by a newline, and needs
 *     no Enter: it IS the session's first prompt.
 *  2. THE RECEIPT IS EARNED, NOT ASSUMED. {@link deliveryVerdict} takes the
 *     evidence actually observed after the fact and decides whether delivery
 *     may be claimed. No evidence ⇒ the tool FAILS. "Sent" is not a thing the
 *     gate can know by having tried.
 *
 * WHERE THE TASK FILE LIVES: outside the repository, next to the gate's
 * orchestration worktrees. A task file inside the worktree would be swept
 * into the first child's `git add -A` checkpoint — the same reason
 * lib/orchestrator-wiring.ts puts worktrees under the temp dir.
 *
 * Pure module: it builds strings and judges evidence. The IO (writing the
 * file, capturing the pane) belongs to the wiring.
 */

import type { StartupEvidence } from "./orchestrator-pane-read.ts";

/** Subdirectory of the orchestration scratch root that holds task files. */
export const TASK_FILE_DIRNAME = "tasks";

/**
 * A message longer than this — or one containing a newline — is delivered as
 * a FILE plus a one-line pointer instead of being typed.
 *
 * The bound is small on purpose. F7 proved the failure mode is silent
 * truncation somewhere between the tool and the TUI, and nobody can say where
 * exactly; the only safe reading is that typing is for short, single-line
 * text and nothing else.
 */
export const SEND_INLINE_MAX_CHARS = 200;

/**
 * A per-delivery token that appears in the task file AND on the child's
 * screen once it renders the message. It is what turns "we ran a command"
 * into "the child has this text".
 */
export function buildDeliveryMarker(taskId: string, now: number): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 24);
  return `rg-task-${safe}-${Math.floor(now).toString(36)}`;
}

/** File name for one delivery (already marker-unique, no collisions). */
export function taskFileName(marker: string): string {
  return `${marker.replace(/[^A-Za-z0-9._-]/g, "-")}.md`;
}

/**
 * The document the child opens as its first message.
 *
 * The marker is on its own line at the top: it has to survive whatever
 * wrapping the child's renderer applies, because it is the evidence the pane
 * check looks for.
 */
export function buildTaskDocument(opts: {
  marker: string;
  taskId: string;
  title: string;
  brief: string;
}): string {
  return [
    `<!-- ${opts.marker} -->`,
    `# 任务 ${opts.taskId}：${opts.title}`,
    "",
    `投递标记：\`${opts.marker}\`（项目经理据此确认这份任务真的到了你手上，别删）`,
    "",
    opts.brief.trim(),
    "",
  ].join("\n");
}

/** The argv a child pane runs: pi with the task file as its first message. */
export function buildChildCommand(taskPath: string, piBin = "pi"): string[] {
  return [piBin, `@${taskPath}`];
}

/** How a message should reach an ALREADY RUNNING child. */
export type SendMode =
  | { kind: "inline"; text: string }
  | { kind: "file"; body: string; pointer: (path: string) => string };

export const ECHO_MARKER_CHARS = 16;

/**
 * The slice of a typed message that is looked for on the child's screen.
 *
 * SHORT on purpose. A terminal wraps at its own width, so the longer the
 * needle the more likely it straddles a line break and is never found —
 * which would turn a perfectly good delivery into a false failure. Sixteen
 * characters is long enough to be distinctive and short enough to survive
 * any sane pane width.
 */
export function echoMarker(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, ECHO_MARKER_CHARS);
}

/**
 * Decide how to deliver a message to a running child.
 *
 * Short single-line text is typed (a running session has no other way in);
 * anything else becomes a file plus a one-line pointer, so `send-keys` only
 * ever carries a path.
 */
export function planSend(message: string): SendMode {
  const text = message.trim();
  if (text.length <= SEND_INLINE_MAX_CHARS && !text.includes("\n")) {
    return { kind: "inline", text };
  }
  return {
    kind: "file",
    body: text,
    pointer: (path: string) =>
      `项目经理给你发了一份说明，请先完整读一遍再继续：${path}`,
  };
}

// ---------------------------------------------------------------------------
// The receipt (F8) — what counts as proof
// ---------------------------------------------------------------------------

/** Which delivery path is being judged; they have different proofs. */
export type DeliveryKind =
  /** The task rode in on the argv — pi running at all means it has it. */
  | "spawn"
  /** The text was typed into a running session — the echo is the proof. */
  | "send";

export type DeliveryVerdict =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

/**
 * May this delivery be reported as successful?
 *
 * SPAWN. The task is in the process's argv, so the question reduces to "did
 * the process start". A pi-looking screen, the marker on screen, or the
 * child's own sidecar on disk each answer it.
 *
 * SEND. The text went through the keyboard, so a running process proves
 * NOTHING about whether the text landed — that is precisely the F8 mistake.
 * Only the echo (the marker/pointer visible on screen) counts.
 *
 * When nothing was observed the verdict is a FAILURE with the evidence
 * spelled out, and the caller is told what state the world is in. The
 * user's rule for this round (2026-08-29): keep the pane, do not kill a
 * session that may well be alive; put the task back to `pending` so it can be
 * picked up again.
 */
export function deliveryVerdict(
  kind: DeliveryKind,
  evidence: StartupEvidence,
): DeliveryVerdict {
  if (kind === "spawn") {
    if (evidence.markerVisible) return { ok: true, summary: "任务标记已出现在子会话屏幕上" };
    if (evidence.sidecarPresent) return { ok: true, summary: "子会话已写出自己的门禁 sidecar，扩展已加载" };
    if (evidence.looksLikePi) return { ok: true, summary: "子会话 pane 里已经是一个运行中的 pi 会话（任务随 argv 一起进去的）" };
    return {
      ok: false,
      reason:
        "开出了 pane，但看不到任何「子会话真的起跑了」的证据 —— 不回执「已发送」。" +
        "（上一轮正是这里谎报，导致项目经理空等一整夜。）",
    };
  }
  if (evidence.markerVisible) return { ok: true, summary: "消息已出现在子会话屏幕上" };
  return {
    ok: false,
    reason:
      "消息敲进去了，但屏幕上看不到它 —— 无法确认子会话真的收到（可能没提交、可能被截断）。" +
      "不回执「已发送」：请 `orchestrator_read` 看现状后重试。",
  };
}
