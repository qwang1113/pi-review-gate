/**
 * DELIVERY — getting work into a child session, and refusing to say it
 * arrived unless it demonstrably did (F7, F8, F11).
 *
 * THE MEASURED FAILURE, in order. `orchestrator_spawn` typed the task text
 * into the new pane with `send-keys`: the text was TRUNCATED mid-sentence
 * (F7), no Enter ever submitted what survived (F8), and the tool nevertheless
 * reported "任务说明已发过去" and told the orchestrator to go wait. The
 * orchestrator then waited on a child sitting in an empty composer with 0.0%
 * context. One human keystroke unblocked the whole night.
 *
 * TWO RULES CAME OUT OF THAT, and both are still here:
 *
 *  1. NOTHING TRAVELS THROUGH THE KEYBOARD. The opening task is written to a
 *     file and handed to the child as pi's own `@file` argv message — the
 *     mechanism lib/judge-process.ts has used since 2026-08-28. A file cannot
 *     be truncated by a TUI, cannot be split by a newline, and needs no Enter:
 *     it IS the session's first prompt.
 *  2. THE RECEIPT IS EARNED, NOT ASSUMED. {@link deliveryVerdict} takes the
 *     evidence actually observed and decides whether delivery may be claimed.
 *     No evidence ⇒ the tool FAILS. "Sent" is not a thing the gate can know by
 *     having tried.
 *
 * ── WHAT CHANGED (2026-08-30): THE EVIDENCE IS NO LONGER A SCREEN ──
 *
 * Proof used to be a marker string spotted in `capture-pane` output, plus a
 * second lane ("submitted" vs "queued") inferred from whether a `Steering:`
 * line happened to be rendered. Every part of that was a guess about pixels,
 * and the `send-keys` path it verified no longer exists — a later message
 * goes into the child's CHANNEL and is injected by the child's own gate with
 * `pi.sendUserMessage`.
 *
 * So the evidence is now structured and unambiguous:
 *
 *  - a SPAWN is proven when the child appends anything at all to its channel
 *    (its gate booted and is reporting) or when its sidecar lands on disk;
 *  - an INSTRUCTION is proven by the child's own acknowledgement record,
 *    which also says whether it was actually applied. There is no lane to
 *    infer: `deliverAs` decided that before the message was ever written.
 *
 * WHERE THE TASK FILE LIVES: outside the repository, next to the gate's
 * orchestration worktrees. A task file inside the worktree would be swept
 * into the first child's `git add -A` checkpoint — the same reason
 * lib/orchestrator-wiring.ts puts worktrees under the temp dir.
 *
 * Pure module: it builds strings and judges evidence. The IO (writing the
 * file, reading the channel) belongs to the wiring.
 */

/** Subdirectory of the orchestration scratch root that holds task files. */
export const TASK_FILE_DIRNAME = "tasks";

/**
 * A per-delivery token that appears in the task file, so a human reading the
 * child's transcript can tell which assignment it is looking at.
 */
export function buildDeliveryMarker(taskId: string, now: number): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 24);
  return `rg-task-${safe}-${Math.floor(now).toString(36)}`;
}

/** File name for one delivery (already marker-unique, no collisions). */
export function taskFileName(marker: string): string {
  return `${marker.replace(/[^A-Za-z0-9._-]/g, "-")}.md`;
}

/** The document the child opens as its first message. */
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
    opts.brief.trim(),
    "",
  ].join("\n");
}

/**
 * A child's pi session id — DETERMINISTIC, derived from its registry handle.
 *
 * This is what makes death survivable. `pi --session-id <id>` re-opens the
 * SAME transcript, so a child whose pane was killed (crash, a stray
 * `kill-pane`, a machine that slept) is restarted with its whole history
 * intact rather than started over from the task document. It is the same
 * trick lib/judge-process.ts uses to carry a judge's context across rounds.
 */
export function childSessionId(childId: string): string {
  // A DOT is excluded along with everything else non-alphanumeric: pi turns a
  // session id into a file name, and `..` in a file name is the one sequence
  // that stops being a name and starts being a path.
  return `rg-child-${childId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48)}`;
}

/** The argv a child pane runs: pi with the task file as its first message. */
export function buildChildCommand(taskPath: string, childId: string, piBin = "pi"): string[] {
  return [piBin, "--session-id", childSessionId(childId), `@${taskPath}`];
}

/**
 * The argv that RESUMES a child after its pane died.
 *
 * No task file: the transcript already holds the assignment and everything
 * the child did about it. What it gets instead is a short note saying it was
 * recovered, because the one thing the transcript cannot contain is the fact
 * that the process it belonged to has been restarted.
 */
export function buildRecoverCommand(childId: string, notePath: string, piBin = "pi"): string[] {
  return [piBin, "--session-id", childSessionId(childId), `@${notePath}`];
}

/** The note a recovered child opens with. */
export function buildRecoveryNote(opts: { childId: string; taskId: string; reason: string }): string {
  return [
    `# 会话已恢复（${opts.childId}）`,
    "",
    `你这个会话的 pane 之前消失了（${opts.reason}），项目经理用同一个 session id 把它重开了 —— ` +
    "上面的对话历史就是你自己的，任务没有换。",
    "",
    `任务 ${opts.taskId} 仍在进行中。先用 \`/gate-status\` 看一眼门禁现在的状态` +
    "（review 裁决、precommit 都还在，没有随进程消失），再接着做。",
    "",
  ].join("\n");
}



// ---------------------------------------------------------------------------
// The receipt (F8) — what counts as proof
// ---------------------------------------------------------------------------

/** Which delivery path is being judged; they have different proofs. */
export type DeliveryKind =
  /** The task rode in on the argv — a reporting gate means it has it. */
  | "spawn"
  /** A message written to the channel for the child's gate to inject. */
  | "instruct";

/** Everything observed about one delivery. No field is inferred from a screen. */
export interface DeliveryEvidence {
  /** The child has appended at least one record to its channel. */
  channelReported: boolean;
  /** Its own gate sidecar exists on disk. */
  sidecarPresent: boolean;
  /** The child's acknowledgement of an instruction, when it made one. */
  ack?: { delivered: boolean; stage?: "received" | "injected"; detail?: string };
}

/** Nothing observed yet. */
export function emptyDeliveryEvidence(): DeliveryEvidence {
  return { channelReported: false, sidecarPresent: false };
}

export type DeliveryVerdict =
  | { ok: true; summary: string }
  | { ok: false; reason: string };

/** How the instruction asked to be delivered — it decides what proof means. */
export type InstructDeliveryMode = "steer" | "followUp" | "interrupt";

/**
 * May this delivery be reported as successful?
 *
 * SPAWN. The task is in the process's argv, so the question reduces to "did
 * the process start and is its gate alive". A channel record answers both at
 * once — only a running gate can write one. A sidecar on disk answers the
 * second half and is accepted as the weaker fallback.
 *
 * INSTRUCT. The message is in the channel, which proves only that it was
 * WRITTEN. What the child says about it is the proof — and WHICH ack is
 * enough depends on what was promised:
 *
 *   - `followUp` promises "when you are done, read this". A busy child cannot
 *     inject it yet BY DEFINITION, so demanding an injection made the tool
 *     fail on exactly the children it was designed for, and the message it
 *     had already written was left orphaned (round-4 P1: one authorization
 *     lost that way). `received` — the child's gate saying it has the message
 *     and has queued it — is the honest bar, and it is a real one: only a
 *     live gate writes it.
 *   - `steer` and `interrupt` promise to act on the CURRENT turn. Nothing but
 *     an injection satisfies that, so `received` alone keeps the check
 *     waiting rather than claiming success.
 *
 * An ack that says `delivered: false` is a FAILURE reported with the child's
 * own explanation — never a success with a caveat.
 */
export function deliveryVerdict(
  kind: DeliveryKind,
  evidence: DeliveryEvidence,
  opts: { instructMode?: InstructDeliveryMode } = {},
): DeliveryVerdict {
  if (kind === "spawn") {
    if (evidence.channelReported) {
      return { ok: true, summary: "子会话已在自己的通道上报了状态 —— 进程起来了，门禁扩展也活着" };
    }
    if (evidence.sidecarPresent) {
      return { ok: true, summary: "子会话已写出自己的门禁 sidecar，扩展已加载（尚未上报状态）" };
    }
    return {
      ok: false,
      reason:
        "开出了 pane，但通道里一条记录都没有、sidecar 也不存在 —— 不回执「已发送」。" +
        "（上一轮正是这里谎报，导致项目经理空等一整夜。）",
    };
  }
  const ack = evidence.ack;
  const mode = opts.instructMode ?? "followUp";
  if (!ack) {
    return {
      ok: false,
      reason:
        "指令已写进通道，但子会话的门禁一直没有回执（连「已收到」都没有）—— " +
        "它的扩展可能没在跑，也可能进程已经不在了。\n" +
        "先看 `orchestrator_wait` 的健康快照：显示 `waiting-judge` 就是它在等自己的 reviewer，" +
        "**这条指令仍在通道里排队，什么都不用做**；只有确认它 `stalled`（心跳真的停了）才谈恢复。",
    };
  }
  const stage = ack.stage ?? "injected";
  if (!ack.delivered && stage === "injected") {
    return {
      ok: false,
      reason: `子会话收到了指令但没能注入：${ack.detail ?? "（它没有说明原因）"}`,
    };
  }
  if (stage === "received") {
    if (mode === "followUp") {
      return {
        ok: true,
        summary:
          "子会话的门禁已确认收到并入队" +
          `${ack.detail ? `：${ack.detail}` : ""} —— 它跑完手上这一轮就会读到`,
      };
    }
    return {
      ok: false,
      reason:
        `子会话已确认收到，但 mode=${mode} 要求它在**当前这一轮**里就读到，而它还没注入。` +
        "再等一会儿；如果它正在 `waiting-judge`，改用 `followUp` 才是对的形状。",
    };
  }
  return { ok: true, summary: `子会话已确认注入${ack.detail ? `：${ack.detail}` : ""}` };
}

