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
  type ChildWaitDecision,
  type ChildWaitObservation,
} from "./orchestrator-wait.ts";
import { formatChildHealth } from "./orchestrator-child-state.ts";
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


/**
 * WAIT — the tool the second orchestration run could not use (R-16).
 *
 * What it did: it took the two attention events that were correctly addressed
 * to this orchestration, marked them handled, decided from an unparsed screen
 * that they were "settled elsewhere", and kept waiting. The orchestrator's
 * token count did not move for 17 minutes, the 900s budget did not fire, and
 * an external Escape was the only way out — while two children sat in front of
 * dialogs nobody was coming to answer.
 *
 * The rewrite rests on three things, each tested against a fake pane state
 * machine rather than a stubbed `tmux() → ok`:
 *
 *  1. THE GATE LOOKS FOR ITSELF. Every poll runs the probe
 *     (lib/orchestrator-probe.ts), so `waiting-input`, `idle` and `dead`
 *     produce events even when no child ever rang — and an unanswered dialog
 *     rings AGAIN on the 10s→30s→60s backoff.
 *  2. AN EVENT IS NEVER SWALLOWED. A consumed event ends the wait unless the
 *     child has provably moved on (screen readable, no dialog, and the probe
 *     says it is working again); everything dropped is named in the reply.
 *  3. THE BUDGET IS INDEPENDENT (lib/poll-wait.ts): the loop races every
 *     await against its own timer, so a probe that never returns cannot hold
 *     the call.
 *
 * Every reply carries the HEALTH SNAPSHOT of all children, so "which one of
 * them is calling me" (R-4) never costs another tool call.
 */
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
  // Events that were consumed and did NOT end the wait — the R-16 class.
  // Never silent: whatever was taken off the queue is named in the reply.
  const settledEvents: string[] = [];
  const childProbe = deps.probe();

  const probe = (): ChildWaitObservation => {
    const runtime = deps.runtime();
    const panes = alivePanes(deps);
    const open = runtime.children.filter((c) => !c.closedAt);
    const childPanes = open.map((c) => c.paneId);
    const observed = childProbe.observe(deps.now());
    // The snapshot is ALWAYS the whole family, even when the wait is scoped
    // to one child: "which of them wants me" is the question the old receipt
    // could not answer (R-4), and a scoped wait is exactly when a supervisor
    // is most likely to be blind to the other one.
    const health = observed.health;



    // The gate's OWN events first: they name the child and the state, and
    // they are the only signal that exists for a child that stopped quietly.
    // A wait scoped to ONE child takes only that child's events and leaves
    // its siblings' queued — dropping them here would be the same silent
    // loss R-16 is about, just with a different queue.
    const manufactured = childProbe.drain({
      now: deps.now(),
      ...(childId ? { childId } : {}),
    });

    if (manufactured.length > 0) {
      return { probeEvents: manufactured, done: false, paneAlive: true, health };
    }

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
      // handled". R-16 is the OTHER half: writing an event off requires
      // POSITIVE evidence that the child moved on (no dialog AND the probe
      // says it is working), never merely a parse that came back empty.
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
      const originState = observed.health.find((h) => h.childId === origin?.id)?.state;
      const observation: ChildWaitObservation = {
        attention: accepted,
        ...(stillOpen === undefined ? {} : { attentionStillOpen: stillOpen }),
        ...(originState ? { originState } : {}),
        done: false,
        paneAlive: true,
        health,
      };
      if (evaluateChildWait(observation).done) return observation;
      settledEvents.push(
        `${accepted.reason}（事件 ${accepted.id}${origin ? `，来自 ${origin.id}` : ""}）—— ` +
        "屏幕上已无待答的框、而且它又在跑了，按已办成处理",
      );
      // Fall through to the ordinary liveness observation: the wait keeps
      // going instead of ending on a ghost, and the probe will ring again if
      // this judgement was wrong.
    }

    // F14 — an unreadable pane list is UNKNOWN liveness, never a death.
    if (!panes.ok) return { done: false, paneAlive: false, livenessUnknown: true, health };

    if (!childId) {
      const live = open.filter((c) => panes.panes.includes(c.paneId));
      return {
        done: live.some((c) => c.doneAt),
        paneAlive: live.length > 0,
        note: `${live.length} 个子会话在跑`,
        health,
      };
    }
    const child = findChild(runtime, childId)!;
    return {
      done: Boolean(child.doneAt),
      paneAlive: !child.closedAt && panes.panes.includes(child.paneId),
      note: `子会话 ${child.id} 仍在 pane ${child.paneId}`,
      health,
    };
  };

  const waited = await pollUntil({
    probe,
    isDone: (observation) => evaluateChildWait(observation).done,
    budgetMs,
    signal,
  });
  const observation = waited.observation;
  const decision: ChildWaitDecision = observation
    ? evaluateChildWait(observation)
    : { done: false, reason: "pending", summary: "本次预算内一次探针都没跑完" };
  const seconds = Math.round(waited.waitedMs / 1000);
  const health = observation?.health ?? childProbe.lastHealth();
  const snapshot =
    "\n\n### 全部子会话的健康快照（来源：门禁探针，结构化真值优先于屏幕启发式）\n" +
    formatChildHealth(health);
  const ignoredNote = ignored.length
    ? `\n顺带：本次丢弃了 ${ignored.length} 条不属于本编排的 attention 事件 —— ` +
      ignored.slice(0, 3).join("；") + "（它们不会再把你叫醒）"
    : "";
  const settledNote = settledEvents.length
    ? `\n本次消费掉、但判定为「已经办成」的事件 ${settledEvents.length} 条：` +
      settledEvents.slice(0, 3).join("；") +
      "（万一其实没办成，探针会按 10s→30s→60s 重新叫你，不会再被吞掉）"
    : "";
  const details = {
    reason: decision.reason,
    waitedMs: waited.waitedMs,
    ignored: ignored.length,
    settled: settledEvents.length,
    health,
    ...(decision.childId ? { childId: decision.childId } : {}),
  };

  // F14 — every path below RETURNS. An abort is reported as an abort, and a
  // spent budget is reported as a spent budget; neither is an error, and
  // neither leaves the caller without a next step.
  if (waited.aborted) {
    return reply(
      `review-gate: 等待被中断（已等 ${seconds}s）—— 子会话还在跑，没有任何东西被取消。` +
      ignoredNote + settledNote + snapshot,
      { ...details, done: false, reason: "aborted" },
    );
  }
  if (!decision.done) {
    const stalled = waited.stalledInProbe
      ? "（注意：预算用完时探针一次都没返回 —— tmux 很可能卡住了，先自己看一眼 pane）"
      : "";
    return reply(
      `review-gate: 等了 ${seconds}s，本次预算用完（${decision.summary}）。${stalled}` +
      "有确定性的活就先做掉，没有就再调一次 `orchestrator_wait` —— " +
      "但不要结束 turn 把盯梢责任丢给用户。" + ignoredNote + settledNote + snapshot,
      { ...details, done: false },
    );
  }
  const who = decision.childId ? `（当事子会话：${decision.childId}）` : "";
  const next = decision.reason === "attention" || decision.reason === "probe"
    ? "\n它到底在问什么，事件里没有 —— 用 `orchestrator_read({ childId })` 读它的屏幕，再用 `orchestrator_key` 答。"
    : "";
  const eventNote = observation?.attention
    ? `\n（事件 ${observation.attention.id}，销账时间 ${observation.attention.handledAt ?? "本次"}）`
    : "";
  return reply(
    `review-gate: ${decision.summary}${who}（等待 ${seconds}s，判据：${decision.reason}）。` +
    eventNote + next + ignoredNote + settledNote + snapshot,
    { ...details, done: true },
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
  // R-28 — THE INCIDENT THIS BRANCH EXISTS FOR. `.git/hooks` lives in the
  // COMMON git dir, so it is shared by every linked worktree: a child that
  // installed the gate's hooks from inside its own orchestration worktree
  // repointed the WHOLE repository's hooks at a directory this call is about
  // to delete. Measured on 2026-08-30: after one `orchestrator_close`, every
  // session in the repo failed to commit ("cannot execute: No such file or
  // directory"), including an innocent third child mid-merge — and it could
  // not repair itself, because `.git/hooks` is gate-blocked and reinstalling
  // from its own temp worktree only moves the crater.
  //
  // So the resource is checked BEFORE it is removed, and repaired first:
  // there is never a window in which the repository cannot commit.
  let hookNote = "";
  if (child.worktree) {
    const referencing = deps.gitHooksReferencing(child.worktree);
    if (referencing.length > 0) {
      const repaired = deps.repairGitHooks();
      if (!repaired.ok) {
        return fail(
          `review-gate: 拒绝清理 worktree —— 仓库的 git 钩子（${referencing.join(", ")}）现在指向 ` +
          `${child.worktree}，删掉它会让**整个仓库**都提交不了（R-28 事故的复现路径）；` +
          `而门禁尝试把钩子复位到主工作区也失败了：${repaired.error}。\n` +
          "pane 与登记都保留着。请在主工作区手动跑 `bash scripts/install-git-hooks.sh` 复位钩子后重试。",
          { childId: child.id, hooksReferencing: referencing, closed: false },
        );
      }
      hookNote =
        `\n注意：仓库的 git 钩子（${referencing.join(", ")}）当时指向这个 worktree —— ` +
        "门禁已先把它们复位到主工作区，再删的 worktree（R-28：先复位、后删除，中间不留破损窗口）。";
    }
  }
  if (child.worktree) deps.removeWorktree(child.worktree);
  deps.saveRuntime(markChildClosed(deps.runtime(), child.id, new Date(deps.now()).toISOString()));
  return reply(
    `review-gate: 子会话 ${child.id}（pane ${child.paneId}）已关闭` +
    (child.worktree ? `，worktree ${child.worktree} 已清理` : "") +
    "。别忘了把它的任务状态置为 done 或 pending（`orchestrator_plan`）。" + hookNote,
    { childId: child.id, hooksRepaired: hookNote.length > 0 },
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
      "Send a message to a registered child session, or approve its loop goal on the user's " +
      "behalf. `approveGoal: true` expresses INTENT only — the gate reads the child's REAL draft " +
      "from its own sidecar and boundary-checks THAT, so a hand-copied text can neither widen nor " +
      "narrow what gets approved; a goal reaching outside the task's declared files is refused " +
      "(that is a scope change, and scope belongs to the human — notify them instead). Plain text " +
      "is REFUSED while the child has a dialog open (typing at an open dialog once answered a " +
      "question on the child's behalf). Use `kind: \"command\"` for a slash command: the gate " +
      "waits for an idle composer, because a command sent to a busy child is filed in its " +
      "steering queue as an ordinary message and never runs — and the receipt always names which " +
      "of the two lanes the text landed in.",
    parameters: Type.Object({
      childId: Type.String(),
      message: Type.Optional(Type.String()),
      kind: Type.Optional(Type.String({
        description: "\"message\" (default) or \"command\" (a slash command that must actually execute)",
      })),
      approveGoal: Type.Optional(Type.Union([Type.Boolean(), Type.String()], {
        description:
          "true = approve the goal this child is currently asking about. The gate compares its " +
          "sidecar draft, never text you pass here (a string is accepted for compatibility and " +
          "only reported when it differs).",
      })),
    }),

    execute: guarded((params) => dispatchSend(deps, params)),
  });

  host.registerTool({
    name: "orchestrator_wait",
    label: "Wait For A Child Session",
    description:
      "Block until something actually happens to a child of THIS orchestration — and the gate " +
      "looks for itself rather than only listening: every poll runs a state probe, so a child " +
      "that raised a dialog (waiting-input), one that quietly STOPPED without declare_done " +
      "(idle), and one whose pane vanished (dead) each produce an event even when the child never " +
      "rang. An unanswered request rings again on a 10s→30s→60s backoff. It ALWAYS returns — the " +
      "budget runs on its own timer — and an interrupt takes effect at once. Events belonging to " +
      "other sessions are dropped and reported; an event is only written off as settled when the " +
      "child provably moved on, and even then it is named in the reply. EVERY reply carries the " +
      "health snapshot of all children (state, how long the screen has been still, the dialog " +
      "title) and says WHICH child is calling you. Unlike a judge child, an orchestration child " +
      "does NOT exit when it finishes, so waiting for a process to end would hang forever. Call " +
      "this instead of ending your turn — then `orchestrator_read` to see the actual question.",

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
