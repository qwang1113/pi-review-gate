/**
 * The SESSION LIFECYCLE tools — what a child is doing, and when it ends:
 * wait, close, relay. Plus the registration of all seven session tools.
 *
 * The DISPATCH half — spawn and send, i.e. getting work INTO a child — lives
 * in lib/orchestrator-dispatch.ts. The two were one file until this round's
 * delivery-verification work pushed it past the 600-line standard the
 * repository holds itself to, and the split follows a real seam: dispatch
 * answers "did the other side actually receive this" (F1/F7/F8/F11), while
 * this half answers "what is it doing now, and is it still alive"
 * (F12/F14).
 *
 * The invariant both halves share: the orchestrator expresses INTENT and the
 * gate performs the ACT. It names a task, not a split direction; a child, not
 * a pane id; "wait", not a polling loop. Every tmux argv is built by
 * lib/orchestrator-tmux.ts, every pane it may touch is one the registry
 * created, and the blast radius is one window.
 *
 * Read this alongside lib/orchestrator-tools.ts (plan / status / notify),
 * which is the half that never leaves the sidecar.

 */

import { Type } from "typebox";
import { pollUntil } from "./poll-wait.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";
import type { AttentionEvent } from "./attention.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";
import {
  buildKillPaneArgv,
  buildRelayPaneArgv,
  parseSpawnedPaneId,

} from "./orchestrator-tmux.ts";
import { spawnAuthorization } from "./orchestrator-gate.ts";
import {
  closableChild,
  findChild,
  markChildClosed,
} from "./orchestrator-registry.ts";
import {
  predecessorCloseAuthorization,
  readInheritance,
  relayPreconditions,
  successorEnv,
} from "./orchestrator-relay.ts";
import {
  acceptAttention,
  clampChildWaitTimeout,
  evaluateChildWait,
  type ChildWaitObservation,
} from "./orchestrator-wait.ts";
import { dialogIsOpen } from "./orchestrator-pane-read.ts";
import { dispatchSend, dispatchSpawn } from "./orchestrator-dispatch.ts";
// Short local aliases; see the note in lib/orchestrator-tools.ts.
import {
  alivePanes,
  capturePane,
  currentPlan,
  toolFail as fail,
  toolReply as reply,
  requireOrchestratorMode,
} from "./orchestrator-tool-kit.ts";

/**
 * How many attention events one probe may take off the queue.
 *
 * Bounded because the queue is a shared global file: an orchestrator that
 * drained it unbounded would spend a probe walking hundreds of other
 * sessions' events, and an orchestrator that took only one per probe (the old
 * behavior) returned instantly on every foreign event it happened to meet —
 * which is the F12 spin, measured at eight useless wake-ups in a row.
 */
const ATTENTION_DRAIN_PER_PROBE = 8;


async function doWait(
  deps: OrchestratorDeps,
  params: Record<string, unknown>,
  signal: { readonly aborted: boolean } | undefined,
): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const budgetMs = clampChildWaitTimeout(params.timeoutMs);

  // Waiting on NOTHING is a mistake, not an end state: without this the
  // "no live pane" probe below would report `pane-gone` and the orchestrator
  // would be told a child died when it never opened one.
  const openChildren = deps.runtime().children.filter((c) => !c.closedAt);
  if (openChildren.length === 0) {
    return fail(
      "review-gate: 没有可等的子会话 —— 先用 `orchestrator_spawn` 开一个，" +
      "或者用 `orchestrator_status` 看看现在的状态。",
      { done: false, reason: "no-children" },
    );
  }
  if (childId && !findChild(deps.runtime(), childId)) {
    return fail(`review-gate: 没有登记过子会话 "${childId}"。`, { done: false, reason: "no-such-child" });
  }

  // Events that were addressed to us but did not belong to any child of this
  // orchestration. Reported at the end rather than swallowed: F12 was
  // invisible precisely because the waiter dropped nothing and said nothing.
  const ignored: string[] = [];

  const probe = (): ChildWaitObservation => {
    const runtime = deps.runtime();
    const panes = alivePanes(deps);
    const open = runtime.children.filter((c) => !c.closedAt);
    const childPanes = open.map((c) => c.paneId);

    // F12 — take at most a bounded number of events per probe, and keep only
    // the ones this orchestration is actually responsible for.
    let accepted: AttentionEvent | undefined;
    for (let i = 0; i < ATTENTION_DRAIN_PER_PROBE; i++) {
      const event = deps.consumeAttention();
      if (!event) break;
      const acceptance = acceptAttention(event, {
        orchestrationId: runtime.orchestrationId,
        childPanes,
      });
      if (!acceptance.accept) {
        if (acceptance.reason) ignored.push(acceptance.reason);
        continue;
      }
      accepted = event;
      break;
    }

    if (accepted) {
      // F12, second half — "the event was dequeued" is not "the matter was
      // handled". Re-read the originating child's screen: a dialog that is
      // gone means somebody (very likely the user, in the pane) already
      // answered, and waking the orchestrator for it would be a ghost.
      const origin = accepted.fromPane
        ? open.find((c) => c.paneId === accepted.fromPane)
        : childId
          ? findChild(runtime, childId)
          : open[0];
      let stillOpen: boolean | undefined;
      if (origin) {
        const snapshot = capturePane(deps, origin.paneId);
        if (snapshot) stillOpen = dialogIsOpen(snapshot);
      }
      return {
        attention: accepted,
        ...(stillOpen === undefined ? {} : { attentionStillOpen: stillOpen }),
        done: false,
        paneAlive: true,
      };
    }

    // F14 — an unreadable pane list is UNKNOWN liveness, never a death.
    if (!panes.ok) return { done: false, paneAlive: false, livenessUnknown: true };

    if (!childId) {
      const live = open.filter((c) => panes.panes.includes(c.paneId));
      return {
        done: live.some((c) => c.doneAt),
        paneAlive: live.length > 0,
        note: `${live.length} 个子会话在跑`,
      };
    }
    const child = findChild(runtime, childId)!;
    return {
      done: Boolean(child.doneAt),
      paneAlive: !child.closedAt && panes.panes.includes(child.paneId),
      note: `子会话 ${child.id} 仍在 pane ${child.paneId}`,
    };
  };

  const waited = await pollUntil({
    probe,
    isDone: (observation) => evaluateChildWait(observation).done,
    budgetMs,
    signal,
  });
  const decision = evaluateChildWait(waited.observation);
  const seconds = Math.round(waited.waitedMs / 1000);
  const ignoredNote = ignored.length
    ? `\n顺带：本次丢弃了 ${ignored.length} 条不属于本编排的 attention 事件 —— ` +
      ignored.slice(0, 3).join("；") + "（它们不会再把你叫醒）"
    : "";

  // F14 — every path below RETURNS. An abort is reported as an abort, and a
  // spent budget is reported as a spent budget; neither is an error, and
  // neither leaves the caller without a next step.
  if (waited.aborted) {
    return reply(
      `review-gate: 等待被中断（已等 ${seconds}s）—— 子会话还在跑，没有任何东西被取消。${ignoredNote}`,
      { done: false, reason: "aborted", waitedMs: waited.waitedMs },
    );
  }
  if (!decision.done) {
    return reply(
      `review-gate: 等了 ${seconds}s，本次预算用完（${decision.summary}）。` +
      "有确定性的活就先做掉，没有就再调一次 `orchestrator_wait` —— " +
      "但不要结束 turn 把盯梢责任丢给用户。" + ignoredNote,
      { done: false, reason: decision.reason, waitedMs: waited.waitedMs, ignored: ignored.length },
    );
  }
  const next = decision.reason === "attention"
    ? `\n它到底在问什么，事件里没有 —— 用 \`orchestrator_read\` 读它的屏幕，再用 \`orchestrator_key\` 答。`
    : "";
  return reply(
    `review-gate: ${decision.summary}（等待 ${seconds}s，判据：${decision.reason}）。${next}${ignoredNote}`,
    { done: true, reason: decision.reason, waitedMs: waited.waitedMs, ignored: ignored.length },
  );
}


async function doClose(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const runtime = deps.runtime();
  const childId = String(params.childId ?? "").trim();
  const predecessorPane = String(params.predecessorPane ?? "").trim();

  // CONSTRAINT 12 — the relay's closing move. Only a SUCCESSOR may close the
  // orchestrator it replaced, and its own environment is what says so.
  if (predecessorPane) {
    const auth = predecessorCloseAuthorization(predecessorPane, deps.env());
    if (!auth.ok) return fail("review-gate: " + auth.reason);
    try {
      const result = deps.tmux(buildKillPaneArgv(predecessorPane));
      if (!result.ok) return fail(`review-gate: 关闭前任 pane 失败 —— ${result.stderr}`);
    } catch (error) {
      return fail(`review-gate: 关闭前任 pane 失败 —— ${(error as Error).message}`);
    }
    return reply(
      `review-gate: 前任项目经理 pane ${predecessorPane} 已关闭，接力完成 —— 你现在是这个 orchestration 的持有者。`,
      { closed: predecessorPane },
    );
  }

  const closable = closableChild(runtime, childId);
  if (!closable.ok) return fail("review-gate: " + closable.reason);
  const child = closable.child;
  try {
    const result = deps.tmux(buildKillPaneArgv(child.paneId));
    if (!result.ok && !/can't find pane|no such pane/i.test(result.stderr)) {
      return fail(`review-gate: 关闭 pane 失败 —— ${result.stderr}`);
    }
  } catch (error) {
    return fail(`review-gate: 关闭 pane 失败 —— ${(error as Error).message}`);
  }
  if (child.worktree) deps.removeWorktree(child.worktree);
  deps.saveRuntime(markChildClosed(deps.runtime(), child.id, new Date(deps.now()).toISOString()));
  return reply(
    `review-gate: 子会话 ${child.id}（pane ${child.paneId}）已关闭` +
    (child.worktree ? `，worktree ${child.worktree} 已清理` : "") +
    "。别忘了把它的任务状态置为 done 或 pending（`orchestrator_plan`）。",
    { childId: child.id },
  );
}

async function doRelay(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const runtime = deps.runtime();
  const { plan } = currentPlan(deps);
  const handoffPath = String(params.handoffPath ?? "").trim();
  const self = deps.ownPane();
  const panes = alivePanes(deps);

  const problems = relayPreconditions({
    planApproved: Boolean(plan && runtime.approvedPlanHash && spawnAuthorization(runtime, plan).ok),
    handoffPath: handoffPath || undefined,
    handoffChars: handoffPath ? deps.fileChars(handoffPath) : undefined,
    ownPane: self,
    liveChildCount: panes.panes.length,
  });
  if (problems.length) {
    return fail(
      "review-gate: 还不能接力：\n" + problems.map((p) => `  - ${p}`).join("\n"),
      { problems },
    );
  }

  let paneId: string | undefined;
  try {
    const result = deps.tmux(buildRelayPaneArgv({
      orchestratorPane: self!,
      cwd: deps.repoRoot,
      env: {
        ...successorEnv({
          orchestrationId: runtime.orchestrationId,
          predecessorPane: self!,
          handoffPath,
          predecessorTranscript: deps.sessionTranscriptPath(),
        }),
        [GATE_MODE_ENV]: "orchestrator",
      },
    }));
    if (!result.ok) throw new Error(result.stderr || "tmux split-window 失败");
    paneId = parseSpawnedPaneId(result.stdout);
  } catch (error) {
    return fail(`review-gate: 开接任会话失败 —— ${(error as Error).message}`);
  }
  if (!paneId) return fail("review-gate: tmux 没有回报接任会话的 pane id —— 接力中止，你仍然是持有者。");

  deps.saveRuntime({
    ...deps.runtime(),
    relay: { handoffPath, successorPane: paneId, at: new Date(deps.now()).toISOString() },
  });
  return reply(
    `review-gate: 接任的项目经理已在 pane ${paneId} 启动，继承同一个 orchestration id ` +
    `(${runtime.orchestrationId})，子会话的通知会自动流向它，无需重启任何子会话。\n` +
    "**接下来你进入 idle：不要再动手**。等它读完交接文档确认接手后，由**它**来关掉你这个 pane" +
    "（只有新会话能关老会话 —— 这天然证明接手成功，中间不断档）。",
    { successorPane: paneId, handoffPath },
  );
}

/** Register the five session tools. */
export function registerOrchestratorSessionTools(host: ToolHost, deps: OrchestratorDeps): void {
  const guarded = (
    run: (params: Record<string, unknown>, signal: { readonly aborted: boolean } | undefined) => Promise<ToolReply>,
  ) => async (
    _id: string,
    params: Record<string, unknown>,
    signal: { readonly aborted: boolean } | undefined,
  ): Promise<ToolReply> => {
    const refusal = requireOrchestratorMode(deps);
    if (refusal) return refusal;
    return run(params, signal);
  };

  host.registerTool({
    name: "orchestrator_spawn",
    label: "Spawn Child Session",
    description:
      "Open an interactive CHILD SESSION for one plan task, in a pane of THIS window. The gate " +
      "picks the split direction (right column, stacked downward), injects the orchestration id " +
      "so the child's wake-ups survive a relay, starts it in loop mode, creates an isolated " +
      "worktree when the task will run in parallel, and registers the pane — a pane nobody " +
      "registered cannot be addressed later. Requires a plan the USER approved.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Plan task id this child will work on" }),
      task: Type.Optional(Type.String({ description: "Opening message sent to the child right away" })),
    }),
    execute: guarded((params) => dispatchSpawn(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_send",
    label: "Message A Child Session",
    description:
      "Send a message to a registered child session. Use `approveGoal` to approve a loop goal on " +
      "the user's behalf: the gate first checks that the goal stays inside the task's declared " +
      "file boundaries and REFUSES otherwise (that is a scope change, and scope belongs to the " +
      "human — notify them instead).",
    parameters: Type.Object({
      childId: Type.String(),
      message: Type.Optional(Type.String()),
      approveGoal: Type.Optional(Type.String({
        description: "The child's proposed goal text — boundary-checked before it is sent",
      })),
    }),
    execute: guarded((params) => dispatchSend(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_wait",
    label: "Wait For A Child Session",
    description:
      "Block until something actually happens to a child of THIS orchestration: an ATTENTION " +
      "event whose dialog is still open, a child reporting its task done, its pane vanishing, or " +
      "the budget running out. It ALWAYS returns, and an interrupt takes effect at once. Events " +
      "belonging to other sessions are dropped and reported, never treated as news; an event " +
      "whose dialog somebody already answered counts as settled and the wait continues. Unlike a " +
      "judge child, an orchestration child does NOT exit when it finishes, so waiting for a " +
      "process to end would hang forever. Call this instead of ending your turn — and when it " +
      "reports an attention event, use `orchestrator_read` to see what the question actually is.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String({ description: "Omit to wait on any child" })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Blocking window (default 300000, max 900000)" })),

    }),
    execute: guarded((params, signal) => doWait(deps, params, signal)),
  });

  host.registerTool({
    name: "orchestrator_close",
    label: "Close A Child Session",
    description:
      "Close a pane this orchestration owns: a registered child (`childId`), or — only when you " +
      "are the SUCCESSOR of a relay — the predecessor orchestrator (`predecessorPane`). Nothing " +
      "else is addressable: the user's own panes and other orchestrations' panes are refused. " +
      "A child's gate-created worktree is cleaned up with it.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String()),
      predecessorPane: Type.Optional(Type.String({
        description: "Relay only: the pane of the orchestrator you replaced",
      })),
    }),
    execute: guarded((params) => doClose(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_relay",
    label: "Hand Over To A Successor",
    description:
      "Hand this orchestration to a fresh orchestrator session when your context is running out. " +
      "Requires an approved plan on disk and a handoff document you already wrote. The successor " +
      "inherits the SAME orchestration id (children keep reaching it with no restart), the " +
      "handoff path, and a pointer to your transcript — the raw record, because a handoff " +
      "document is a self-report. After this you go idle; the SUCCESSOR closes your pane.",
    parameters: Type.Object({
      handoffPath: Type.String({ description: "Repo-relative path, e.g. docs/orchestrator-handoff.md" }),
    }),
    execute: guarded((params) => doRelay(deps, params)),
  });
}

/** Re-exported for the extension's own child-session directive injection. */
export { readInheritance };
