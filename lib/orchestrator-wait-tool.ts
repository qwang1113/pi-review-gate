/**
 * `orchestrator_wait` — the tool body behind the orchestrator's ONE
 * information channel, and the receipt blocks only it assembles (the exit
 * blockers, the inheritance brief).
 *
 * Split from lib/orchestrator-session-tools.ts, which keeps the registration
 * of every orchestration session tool; the pure receipt rules this drives
 * live in lib/orchestrator-wait.ts and the per-poll supervision in
 * lib/orchestrator-supervisor.ts.
 */

import { pollUntil, type PollWaitResult } from "./poll-wait.ts";
import { ORCHESTRATOR_WAIT_DISCIPLINE } from "./agent-directives.ts";
import type { OrchestratorDeps, ToolReply } from "./orchestrator-deps.ts";
import { findChild, repointChildPanes } from "./orchestrator-registry.ts";
import { formatInheritanceBrief, readInheritance } from "./session-inheritance.ts";
import { orchestratorDoneProblems } from "./orchestrator-gate.ts";
import {
  buildWaitReceipt,
  clampChildWaitTimeout,
  dueRequests,
  evaluateChildWait,
  type ChildWaitDecision,
  type ChildWaitObservation,
} from "./orchestrator-wait.ts";
import {
  decideSupervisionEvents,
  reportedDoneIds,
  superviseChildren,
  type SupervisionMemory,
  type SupervisionSnapshot,
} from "./orchestrator-supervisor.ts";
import { alivePanes, childAssets, currentPlan, refreshPaneLabels } from "./orchestrator-tool-kit.ts";
import { toolFail as fail, toolReply as reply } from "./tool-host.ts";

/**
 * The `timeoutMs: 0` snapshot, expressed as the waiting skeleton's own result:
 * a wait that did not wait. Nothing is invented — `done` is the SAME criterion
 * the blocking path polls on, so the two branches cannot drift apart.
 */
function snapshotResult(observation: ChildWaitObservation): PollWaitResult<ChildWaitObservation> {
  return {
    observation,
    done: evaluateChildWait(observation).done,
    aborted: false,
    stalledInProbe: false,
    waitedMs: 0,
  };
}


/**
 * WAIT — the orchestrator's ONE information channel, and the only call it
 * makes every round.
 *
 * ── WHAT IT USED TO BE, AND WHY THAT FAILED (R-16, R-4, R3-5) ──
 *
 * It consumed events from a global queue, re-checked their addressing in
 * code, then decided from an UNPARSED SCREEN whether the question behind an
 * event was still open. Measured: two children sat in front of dialogs
 * nobody was coming to answer while the orchestrator's token count did not
 * move for 17 minutes, and an external Escape was the only way out. The
 * receipt could not even say WHICH child was calling.
 *
 * ── WHAT IT IS NOW ──
 *
 * Three things, and none of them touches a rendered line:
 *
 *  1. THE GATE LOOKS FOR ITSELF. Every poll re-reads every child's channel
 *     (lib/orchestrator-supervisor.ts), so `waiting-input`, `done`, `idle`,
 *     `stalled` and `dead` produce events even when no child ever rang — and
 *     an unanswered question rings AGAIN on the 10s→30s→60s backoff.
 *     AN OPEN QUESTION DOES NOT WAIT FOR THAT BACKOFF: it ends the wait on
 *     the channel's own evidence (`pending-request`), because the backoff's
 *     memory is shared with the 10s supervision timer and every due moment
 *     landed on a timer tick — the timer consumed each one and a manager sat
 *     for 910 seconds beside a dialog opened 2 seconds before it called.
 *  2. NOTHING IS SWALLOWED, because nothing has to be filtered: each child's
 *     traffic is its own file. There is no foreign event to drop and no
 *     ownership to re-derive.
 *  3. THE BUDGET IS INDEPENDENT (lib/poll-wait.ts): the loop races every
 *     await against its own timer, so a probe that never returns cannot hold
 *     the call.
 *
 * ── `timeoutMs: 0` IS THE OLD `orchestrator_status` ──
 *
 * Snapshot and blocking wait were two tools answering the same question, and
 * an agent had to choose between them (philosophy two: that is a design
 * failure). They are one tool now; blocking is a parameter. The reply is
 * IDENTICAL either way — the four-block receipt — so nothing an orchestrator
 * needs is reachable only from one of them.
 */
export async function doWait(
  deps: OrchestratorDeps,
  params: Record<string, unknown>,
  signal: { readonly aborted: boolean } | undefined,
): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const budgetMs = clampChildWaitTimeout(params.timeoutMs);

  // Waiting on NOTHING is a mistake, not an end state: without this the
  // "no live pane" observation below would report `pane-gone` and the
  // orchestrator would be told a child died when it never opened one. A
  // SNAPSHOT of an empty orchestration is legitimate, though — that is how a
  // successor looks around before it spawns anything.
  const openChildren = deps.runtime().children.filter((c) => !c.closedAt);
  if (openChildren.length === 0 && budgetMs > 0) {
    return fail(
      "review-gate: 没有可等的子会话 —— 先用 `orchestrator_spawn` 开一个，" +
      "或者用 `orchestrator_wait({ timeoutMs: 0 })` 看一眼现状。",
      { done: false, reason: "no-children" },
    );
  }
  if (childId && !findChild(deps.runtime(), childId)) {
    return fail(`review-gate: 没有登记过子会话 "${childId}"。`, { done: false, reason: "no-such-child" });
  }

  let snapshot: SupervisionSnapshot | undefined;
  // The pane reading THIS receipt is built from. Block 5 used to take its own,
  // a second `list-panes` at a different instant than the probe's, so the two
  // halves of one receipt could describe two different moments (B4).
  let panesRead: { panes: string[]; ok: boolean } | undefined;

  const probe = (): ChildWaitObservation => {
    const runtime = deps.runtime();
    const panes = alivePanes(deps);
    panesRead = panes;
    const open = runtime.children.filter((c) => !c.closedAt);
    snapshot = superviseChildren({
      orchestrationId: runtime.orchestrationId,
      children: open,
      livePanes: panes.ok ? new Set(panes.panes) : undefined,
      io: deps.channelIO(),
      ...(deps.channelHome() === undefined ? {} : { home: deps.channelHome()! }),
      at: deps.now(),
      assetsFor: (child) => childAssets(deps, child),
    });
    // A child that handed over lives in a new pane: remember it, so close /
    // recover / the exit check stop aiming at the predecessor's corpse.
    if (snapshot.relayed.length > 0) deps.saveRuntime(repointChildPanes(deps.runtime(), snapshot.relayed));
    // The border labels are repainted from the health that was just measured
    // — the probe is already here, so the screen never lags the receipt.
    refreshPaneLabels(deps, snapshot);

    // The event rules carry a memory across polls, and it lives in the
    // sidecar rather than in this closure: a wait that rebuilt it would see
    // every state as "changed" and re-ring the same question forever.
    //
    // IT IS CONSUMED ON EVERY PROBE, INCLUDING THE ONES THAT RETURN BELOW.
    // The background timer injects 「子会话需要你」 from this same memory, so a
    // probe that returned without draining it would leave the timer to ring a
    // second time about the dialog this call is already handing over — one
    // question, two announcers (quality round P2).
    const before = deps.supervisionMemory();
    const decided = decideSupervisionEvents(snapshot, before, deps.now());
    // A wait scoped to ONE child reports only that child's events; its
    // siblings' stay in the memory as un-reported and ring on the next call
    // — which is true only because their entries are put BACK (quality round
    // 3, P2: saving the whole memory spent news this reply then filtered out,
    // the same leak as the P1 above reached from the scope filter).
    deps.saveSupervisionMemory(childId ? keepOutOfScope(before, decided.memory, childId) : decided.memory);
    const scoped = childId ? decided.events.filter((e) => e.childId === childId) : decided.events;
    // A `waiting-input` event is NOT a second announcement of the same
    // question. The block below owns that news, on better terms (per request,
    // from the first probe, immune to the other two consumers of this memory),
    // and letting both speak would ring twice for one dialog.
    const events = scoped.filter((e) => e.state !== "waiting-input");

    // THE FACT, ahead of the manufactured events: a question that is
    // unanswered RIGHT NOW ends this wait whatever any memory thinks is due,
    // and it is remembered BY REQUEST — so neither another consumer's timing
    // nor the absence of a state CHANGE can hide it.
    //
    // A DEAD child's question is not one anybody can answer, and a stalled
    // child's gate is not listening either: there the headline is the corpse,
    // which the event path names. Their requests are left out so the death is
    // what ends this wait — and they are announced again if it comes back.
    const troubled = new Set(snapshot.troubled.map((t) => t.child.id));
    const requests = dueRequests({
      open: snapshot.requests.filter((r) => !troubled.has(r.childId)),
      announced: deps.announcedRequests(),
      at: deps.now(),
      ...(childId ? { childId } : {}),
    });
    deps.saveAnnouncedRequests(requests.memory);
    // BOTH KINDS OF NEWS TRAVEL IN ONE OBSERVATION (quality round 2, P1).
    // Returning the questions alone dropped the events this same probe had
    // just marked as reported in the shared memory: a sibling's `done` or
    // `dead` would have been announced by nobody — not by this reply, and not
    // by the timer either — until its next backoff step came due.
    if (requests.due.length > 0 || events.length > 0) {
      return {
        ...(events.length > 0 ? { events } : {}),
        ...(requests.due.length > 0 ? { pendingRequests: requests.due } : {}),
        paneAlive: true,
      };
    }

    // F14 — an unreadable pane list is UNKNOWN liveness, never a death.
    if (!panes.ok) return { paneAlive: false, livenessUnknown: true };

    // Re-read AFTER the repoint above: judging liveness on the registry this
    // probe started with would call a relayed child dead in the headline while
    // the health block of the same receipt shows its successor working.
    const current = deps.runtime();
    if (!childId) {
      const live = current.children.filter((c) => !c.closedAt && panes.panes.includes(c.paneId));
      return {
        paneAlive: live.length > 0,
        note: `${live.length} 个子会话在跑`,
      };
    }
    const child = findChild(current, childId)!;
    return {
      paneAlive: !child.closedAt && panes.panes.includes(child.paneId),
      note: `子会话 ${child.id} 仍在 pane ${child.paneId}`,
    };
  };

  // Typed as the skeleton's own result on BOTH branches: the snapshot path is
  // "a wait that did not wait", not a different shape — so every field the
  // reply reads (`abortReason` included) exists on it too.
  const waited: PollWaitResult<ChildWaitObservation> = budgetMs === 0
    ? snapshotResult(probe())
    : await pollUntil({
        probe,
        isDone: (observation) => evaluateChildWait(observation).done,
        budgetMs,
        signal,
      });
  const observation = waited.observation;
  const decision: ChildWaitDecision = observation
    ? evaluateChildWait(observation)
    : { done: false, reason: "pending", summary: "本次预算内一次探针都没跑完" };
  const receipt = buildWaitReceipt({
    snapshot: snapshot ?? emptySnapshot(),
    decision,
    ...(deps.contextPercent() === undefined ? {} : { contextPercent: deps.contextPercent()! }),
    exitBlockers: exitBlockers(deps, snapshot, panesRead),
    ...(inheritanceBrief(deps) === undefined ? {} : { inheritance: inheritanceBrief(deps)! }),
    waitedMs: waited.waitedMs,
  });
  const details = {
    reason: decision.reason,
    waitedMs: waited.waitedMs,
    done: decision.done,
    handoffDue: receipt.advice.due,
    openRequests: (snapshot?.requests ?? []).length,
    health: snapshot?.health ?? [],
    ...(decision.childId ? { childId: decision.childId } : {}),
  };

  // F14 — every path below RETURNS, and every one of them carries the SAME
  // four-block receipt. An abort is reported as an abort and a spent budget
  // as a spent budget; neither is an error, and neither leaves the caller
  // without a next step.
  if (waited.aborted) {
    const waitedSeconds = Math.round(waited.waitedMs / 1000);
    // TWO interrupts, and the difference matters to whoever reads this. ESC is
    // the host cancelling the call. A user message is somebody TALKING TO YOU
    // — but WHEN it lands depends on how it was sent, and the receipt must not
    // paper over that: a `steer` (plain Enter, the default) cuts into this very
    // turn, so simply carrying on with the work reads it; a `followUp`
    // (Alt+Enter) is delivered only once the turn ENDS, and a manager that
    // dives straight back into a 900s wait shuts that one out a second time —
    // the original defect wearing a different hat (round-2 P2).
    //
    // AND IT MUST NOT CONTRADICT THE STANDING DISCIPLINE (round-3 P2). The
    // wait discipline forbids ENDING THE TURN AS A WAY OF WAITING — handing
    // the watch back to the user and hoping to be woken. Letting a message
    // that is ALREADY QUEUED through is the opposite of that: nobody is being
    // asked to watch anything, the turn boundary is a doorway rather than a
    // parking spot, and the manager resumes immediately. The receipt says so
    // in as many words, because the two would otherwise read as opposites at
    // the very same decision point.
    if (waited.abortReason === "user-input") {
      return reply(
        `review-gate: 等待被外部消息打断（已等 ${waitedSeconds}s）—— ` +
        "有人正在跟本会话说话，消息已经在宿主队列里。回车发的 steer 会切进你当前这一轮：" +
        "照常继续干活就会读到它。Alt+Enter 发的 followUp 要等这一轮 turn 结束才送达 —— " +
        "只有这一种情况别再一头扎回长阻塞，先把手上这一轮收掉让它进来" +
        "（「declare_done 前不结束 turn」的例外：在等人）。" +
        "（这不违反等待纪律②：那条禁的是「用结束 turn 代替等待、把盯梢责任丢回用户」；" +
        "这里消息已经在队列里，turn 边界只是它进来的门，你随即继续盯。）" +
        "子会话还在跑，没有任何东西被取消。\n\n" + receipt.text,
        { ...details, done: false, reason: "aborted", abortedBy: "user-input" },
      );
    }
    return reply(
      `review-gate: 等待被中断（已等 ${waitedSeconds}s）—— ` +
      "子会话还在跑，没有任何东西被取消。\n\n" + receipt.text,
      { ...details, done: false, reason: "aborted", abortedBy: "signal" },
    );
  }
  if (!decision.done && budgetMs > 0) {
    const stalled = waited.stalledInProbe
      ? "（注意：预算用完时探针一次都没返回 —— tmux 很可能卡住了，先自己看一眼 pane）"
      : "";
    return reply(
      `review-gate: 本次预算用完。${stalled}\n${ORCHESTRATOR_WAIT_DISCIPLINE}\n\n` + receipt.text,

      details,
    );
  }
  return reply(`review-gate: ${receipt.text}`, details);
}

/**
 * The memory a SCOPED wait may write: the one child it is watching advances,
 * everybody else keeps the entry it had.
 *
 * A sibling with no previous entry is left out entirely rather than carried
 * from `advanced` — "never announced" is exactly what the next unscoped call
 * has to see to announce it.
 */
function keepOutOfScope(
  before: SupervisionMemory,
  advanced: SupervisionMemory,
  childId: string,
): SupervisionMemory {
  const next: SupervisionMemory = { ...before };
  if (advanced[childId] !== undefined) next[childId] = advanced[childId]!;
  else delete next[childId];
  return next;
}

/** The receipt still renders when supervision never ran (an empty snapshot). */
function emptySnapshot(): SupervisionSnapshot {
  return { children: [], health: [], requests: [], troubled: [], malformed: 0, relayed: [] };
}

/**
 * What still stands between this orchestration and `declare_done`.
 *
 * This is block 5 of the receipt, and it is the whole of what
 * `orchestrator_status` used to be for. A separate tool for it was a
 * philosophy-two failure twice over: the orchestrator had to choose between
 * two overlapping readouts, and — worse — "am I allowed to finish yet" is a
 * question it only thinks to ask once it already believes it is finished.
 * Pushing it into the call that happens every round means it is answered
 * before that belief forms.
 *
 * IT READS THE SAME SNAPSHOT BLOCK 1 DOES (B4). Completion is a channel fact,
 * and this block used to answer it from a registry field nothing wrote — so
 * one receipt could report a child as finished at the top and as "still
 * alive, go wait for it" at the bottom, and the manager had to arbitrate
 * between its own gate's two answers. The snapshot (and the pane reading it
 * was built from) is passed in for the same reason: two readings taken at two
 * instants are two different moments in one receipt.
 */
function exitBlockers(
  deps: OrchestratorDeps,
  snapshot: SupervisionSnapshot | undefined,
  panesRead: { panes: string[]; ok: boolean } | undefined,
): string[] {
  const { plan } = currentPlan(deps);
  const panes = panesRead ?? alivePanes(deps);
  const reportedDone = snapshot ? reportedDoneIds(snapshot) : [];
  return orchestratorDoneProblems({
    ...(plan ? { plan } : {}),
    runtime: deps.runtime(),
    alivePaneIds: panes.panes,
    ...(reportedDone.length > 0 ? { reportedDone } : {}),
    ...(panes.ok ? {} : { livenessUnknown: true }),
  });
}

/** What a handoff gave this session, when it is a successor. */
function inheritanceBrief(deps: OrchestratorDeps): string | undefined {
  const brief = formatInheritanceBrief(readInheritance(deps.env()), deps.runtime().orchestrationId);
  return brief && brief.length > 0 ? brief : undefined;
}
