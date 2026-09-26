/**
 * THE SESSION'S RUNTIME CLOCKS — the unified exit criterion, the revival
 * timer, the background supervisor, the orchestrator's own settle
 * continuation and the session-name heartbeat, moved out of
 * `extensions/review-gate.ts` (t6, wave 2 of the split).
 *
 * The RULES stay in the pure modules: when a session may be revived
 * (lib/session-revival.ts), what the supervisor reports
 * (lib/orchestrator-supervisor.ts), what the orchestration still owes
 * (lib/orchestrator-gate.ts). What is here is the session-bound half — the
 * timers, the retirement flag they all honour, and the continuation budget.
 */

import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

import type { ChannelIO } from "./channel-io.ts";
import { emptyRuntime, type OrchestratorRuntime } from "./orchestrator-registry.ts";
import {
  freshNoticeEvents,
  noticeText,
  NOTICE_KIND,
  type NoticeEvent,
  type NoticeFacts,
} from "./orchestration-notice.ts";
import {
  decideSupervisionEvents,
  reportedDoneIds,
  superviseChildren,
  type SupervisionMemory,
  type SupervisionSnapshot,
} from "./orchestrator-supervisor.ts";
import { formatChildHealth } from "./orchestrator-child-state.ts";
import { orchestratorDoneProblems } from "./orchestrator-gate.ts";
import { buildOrchestratorResume } from "./orchestrator-directives.ts";
import { readPlanFile } from "./orchestrator-wiring.ts";
import { alivePanes } from "./orchestrator-tool-kit.ts";
import type { OrchestratorDeps } from "./orchestrator-deps.ts";
import { decideRevival, buildRevivalMessage, REVIVAL_INTERVAL_MS } from "./session-revival.ts";
import { computeFingerprint } from "./fingerprint.ts";
import { unmetRequirements } from "./gate-state-requirements.ts";
import { LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK } from "./loop-goal.ts";
import type { GateState } from "./gate-state.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { SessionNaming } from "./session-name-tools.ts";
import type { SessionMessaging } from "./session-message-tools.ts";
import type { SessionHost } from "./session-host.ts";

/** What the runtime clocks need from the session beyond the shared host. */
export interface OrchestratorRuntimeDeps {
  pi: Pick<ExtensionAPI, "sendUserMessage" | "sendMessage" | "on">;
  orchestratorDeps: OrchestratorDeps;
  channelIO: ChannelIO;
  currentOrchestrationId(): string;
  /** The user aborted the last run (ESC) — an explicit human stop. */
  lastRunAborted(): boolean;
  /** An arbitration is waiting on a human. */
  arbitrationPaused(): boolean;
  updateWidget(ctx: ExtensionContext): void;
  goalStageSatisfied(): boolean;
  copilotProblemsFor(st: GateState | undefined): string[];
  repoLabel(root: string): string;
  projectConfig(): ProjectConfig;
  sessionNaming: SessionNaming;
  sessionMessaging: SessionMessaging;
}

export function createOrchestratorRuntime(host: SessionHost, deps: OrchestratorRuntimeDeps) {
  const { pi, orchestratorDeps, channelIO, currentOrchestrationId, updateWidget, sessionNaming, sessionMessaging } = deps;

  /**
   * Constraints 3, 4 and 11 — the orchestration's own exit contract.
   *
   * WHY THERE IS NO DELIVERY-STATION CHECK HERE, and why adding one would be a
   * regression rather than the missing piece it looks like (user decision,
   * 2026-09-06). The plan carries a `deliveryStation`, so "the orchestrator's
   * done should verify the plan reached it" reads like an obvious gap. It is
   * not, for a reason this repo has already paid for once:
   *
   *  - a project manager DOES have a repo (`sessionRepos` always holds the
   *    primary one) — but it is the ORCHESTRATION repo, where constraint 2
   *    lets it write nothing except the plan and its handoff docs. Whether
   *    THAT worktree is clean says nothing about whether the orchestration
   *    reached its station; a couple of uncommitted plan notes would read as
   *    "did not arrive", which is a fact about the wrong repo;
   *  - the arrival evidence — a `gh pr create` the gate watched succeed
   *    (`shippedKinds`), or a Copilot-resolved PR number — is written in the
   *    sidecar of the repo the ship ran in, i.e. a CHILD's repo. This function
   *    walks the MANAGER's own repos, so it can never see it.

   *
   * So an orchestration with `deliveryStation: "pr"` would be held at
   * `declare_done` by a condition it can NEVER satisfy, while the receipt
   * earnestly told the manager to "go open a PR". That is the worst defect
   * class this gate can produce — following the gate's own instruction makes
   * things worse — and it is exactly what round 4 cost when the heartbeat hung
   * off agent events: healthy children were reported lost, and the advised
   * `interrupt` cut a live review in half.
   *
   * THE DIVISION OF LABOUR, stated so nobody has to re-derive it: the plan's
   * station is honoured by each CHILD's ship gate, at the moment a ship
   * command runs in the repo that owns the work. At the orchestration layer a
   * station is an AUTHORIZATION SURFACE (it bounds what a child may be given,
   * and `orchestrator_answer` refuses a proxy confirmation looser than it); at
   * the execution layer it is a BLOCK. The manager's exit contract stays the
   * plan itself — every task done, no live children, no un-notified decision.
   */

  function orchestrationDoneProblems(): string[] {
    const state = host.state();
    if (state.taskMode !== "orchestrator") return [];
    const runtime = state.orchestrator ?? emptyRuntime(currentOrchestrationId());
    // F14 — `undefined` is UNKNOWN liveness, and it is NOT an empty pane list.
    // This used to swallow every tmux failure into `[]`, which means "every
    // registered pane is gone": one unreadable `list-panes` told the manager
    // that all of its children had died. The reading itself is the SAME one
    // the background supervisor uses — one implementation, one answer.
    const panes = alivePaneIdsForSupervision();
    // Completion is a CHANNEL fact, read from the same supervision snapshot the
    // health block is rendered from (B4). Asking a registry field instead is
    // what let one receipt call a child finished and alive in the same breath.
    const snapshot = superviseNow(runtime, panes);
    const reportedDone = snapshot ? reportedDoneIds(snapshot) : [];
    return orchestratorDoneProblems({
      plan: readPlanFile(host.repos().primary).plan,
      runtime,
      alivePaneIds: panes === undefined ? [] : [...panes],
      ...(reportedDone.length > 0 ? { reportedDone } : {}),
      ...(panes === undefined ? { livenessUnknown: true } : {}),
    });
  }

  // ---- the state probe: the gate's own eyes on the children (R-16/R-23) ----
  //
  // The second orchestration run worked only because a HUMAN ran a
  // `capture-pane` loop all night: three of the four situations that matter
  // (a dialog nobody answered, a child that quietly stopped, a vanished pane)
  // produce no event at all, so an orchestrator that waits for events waits
  // forever. The probe manufactures those events, and this timer is what
  // makes it fire even when the supervisor is NOT sitting inside
  // `orchestrator_wait`.
  // ---- THE REVIVAL TIMER (2026-08-30, survival invariant) ----
  //
  // The one clock the invariant rides on. `agent_settled` fires once per
  // turn and the NEXT turn comes from THIS turn's injection, so a turn that
  // ends under any of the six guards never gets a second chance — the
  // event chain is broken and nothing will ever re-trigger it. The loop
  // session heals because edits re-arm `loopArmed`; an orchestrator writes
  // no code (constraint 2) and cannot. So the gate keeps its own minute-
  // level clock, independent of everything the agent did.
  let revivalTimer: ReturnType<typeof setInterval> | undefined;
  /** When this session last injected a revival (ms epoch). */
  let lastRevivalAt: number | undefined;
  /**
   * A session that HANDED OFF must not be revived, supervised or reported on
   * again — its successor owns all of that now.
   *
   * Named for the act, not for the role: since 2026-09-14 every kind of
   * session can hand over (lib/session-handoff-tools.ts), and the old
   * `handedOffOrchestration` name was the reason three of the four guards
   * below were written as if a loop session could never retire.
   */
  let handedOffSession = false;
  let supervisionTimer: ReturnType<typeof setInterval> | undefined;
  let orchestratorContinuations = 0;
  /** The supervisor's own last health read, for the continuation message. */
  let lastSupervisionHealth: ReturnType<typeof formatChildHealth> = "";

  /** How often the background supervisor re-reads every child's channel. */
  const SUPERVISION_INTERVAL_MS = 10_000;

  /**
   * What the children need from the supervisor RIGHT NOW, as text lines.
   *
   * The whole read is the channels — no pane is captured, no text is matched.
   * The event memory lives in the deps (one per orchestration), so the
   * background timer and `orchestrator_wait` share it and neither re-rings
   * what the other has already reported.
   */
  function drainSupervisionNews(): NoticeEvent[] {
    if (host.state().taskMode !== "orchestrator") return [];
    try {
      const runtime = orchestratorDeps.runtime();
      const snapshot = superviseNow(runtime, alivePaneIdsForSupervision());
      if (!snapshot) return [];
      lastSupervisionHealth = formatChildHealth(snapshot.health);
      const decided: { events: NoticeEvent[]; memory: SupervisionMemory } =
        decideSupervisionEvents(snapshot, orchestratorDeps.supervisionMemory(), orchestratorDeps.now());
      orchestratorDeps.saveSupervisionMemory(decided.memory);
      return freshNoticeEvents(decided.events, noticeFacts(snapshot));
    } catch {
      return []; // supervision is a convenience for the timer, never a gate
    }
  }

  /** What a notice is checked against: the open children, their questions, the done tasks. */
  function noticeFacts(snapshot: SupervisionSnapshot | undefined): NoticeFacts {
    const tasks = orchestratorDeps.readPlan().plan?.tasks ?? [];
    return {
      children: (snapshot?.children ?? []).map((c) => ({ childId: c.child.id, taskId: c.child.taskId, state: c.state })),
      openRequestIds: new Set((snapshot?.requests ?? []).map((r) => r.requestId)),
      doneTaskIds: new Set(tasks.filter((t) => t.status === "done").map((t) => t.id)),
    };
  }

  /**
   * A notice was steered in and has not reached the context yet. While it is
   * in flight no second one is queued — the backlog that fed a stale line per
   * turn (lib/orchestration-notice.ts). Cleared when it is delivered, and at
   * `agent_end`, so a notice lost to an abort cannot silence supervision.
   */
  let noticeInFlight = false;

  /** One supervision tick: announce the news, unless someone else has it covered. */
  function superviseTick(): void {
    if (orchestratorDeps.waitActive() || noticeInFlight) return;
    const events = drainSupervisionNews();
    if (events.length === 0) return;
    noticeInFlight = true;
    try {
      pi.sendMessage({
        customType: "review-gate",
        content: noticeText(events),
        display: true,
        details: { kind: NOTICE_KIND, events },
      }, { triggerTurn: true, deliverAs: "steer" });
    } catch {
      noticeInFlight = false;
    }
  }

  /**
   * THE DELIVERY CHECK: the notice is entering the context now — re-read the
   * channels and rewrite it to what is still true. Returns the replacement,
   * or `undefined` when the message is not a notice or nothing went stale.
   */
  function reviseDeliveredNotice(message: MessageEndEvent["message"]): { message: MessageEndEvent["message"] } | undefined {
    if (message.role !== "custom") return undefined;
    const details = message.details as { kind?: string; events?: NoticeEvent[] } | undefined;
    if (details?.kind !== NOTICE_KIND) return undefined;
    noticeInFlight = false;
    const carried = details.events ?? [];
    let fresh: NoticeEvent[];
    try {
      fresh = freshNoticeEvents(carried, noticeFacts(superviseNow(orchestratorDeps.runtime(), alivePaneIdsForSupervision())));
    } catch {
      return undefined; // unreadable ⇒ deliver as written; never block delivery
    }
    if (fresh.length === carried.length) return undefined;
    return { message: { ...message, content: noticeText(fresh), details: { kind: NOTICE_KIND, events: fresh } } };
  }
  pi.on("message_end", (event: MessageEndEvent) => reviseDeliveredNotice(event.message));
  pi.on("agent_end", () => { noticeInFlight = false; });

  /**
   * ONE supervision read — the snapshot BOTH the background timer and the
   * injected wrap-up block are built from (B4).
   *
   * It is a function rather than two similar blocks because two readings of
   * the same channels, taken in two places, is precisely the shape that let
   * one receipt call a child finished and still-to-be-waited-for. Returns
   * `undefined` when there is nothing to supervise (no open child).
   */
  function superviseNow(
    runtime: OrchestratorRuntime,
    livePanes: Set<string> | undefined,
  ): SupervisionSnapshot | undefined {
    const open = runtime.children.filter((c) => !c.closedAt);
    if (open.length === 0) return undefined;
    return superviseChildren({
      orchestrationId: runtime.orchestrationId,
      children: open,
      livePanes,
      io: channelIO,
      // THE SAME CHANNEL ROOT `orchestrator_wait` READS (2026-09-22). The two
      // agree today only because this host happens to provide no channel home,
      // so both fall back to the agent home — a coincidence, not a guarantee:
      // the wait passes `deps.channelHome()` and this read did not, so the
      // moment a host binds one, the timer's 「子会话需要你」 injection and the
      // receipt the manager checks it against would read different directories.
      ...(orchestratorDeps.channelHome() === undefined ? {} : { home: orchestratorDeps.channelHome()! }),
      // The wait's clock too — one supervision, one notion of "now".
      at: orchestratorDeps.now(),
    });
  }


  /**
   * Pane ids that exist right now; `undefined` when tmux cannot be read.
   *
   * THE ONE pane reading this session takes for supervision — the wrap-up
   * block used to take its own, which is how it ended up passing `[]` (every
   * pane vanished) where this one says `undefined` (nothing was measured).
   * It goes through the orchestration deps, so it carries the tmux server the
   * rest of the gate addresses and a test can drive it.
   */
  function alivePaneIdsForSupervision(): Set<string> | undefined {
    // `alivePanes` is the reading `orchestrator_wait` itself takes (argv built
    // by lib/orchestrator-tmux.ts, output filtered by `parsePaneIds`). This
    // used to hand-assemble the same `list-panes` call and keep every non-
    // empty line as a pane id — a second implementation of one measurement.
    const read = alivePanes(orchestratorDeps);
    return read.ok ? new Set(read.panes) : undefined;
  }

  function stopSupervisionTimer(): void {
    if (supervisionTimer) clearInterval(supervisionTimer);
    supervisionTimer = undefined;
  }

  /**
   * Arm the REVIVAL timer — the survival invariant for BOTH modes,
   * every 60s. It exists to catch a session that stopped with its exit
   * contract unmet (provider error, agent that decided it was done early).
   *
   * Deliberately independent of the event chain: it does not consume the
   * continuation budget (`maxRounds`) and ignores the `loop-stall` circuit
   * breaker — both are right for the INJECTION path they guard, and both
   * are wrong here, where a stopped session costs nothing per minute and a
   * silently abandoned task costs the whole run. Human stops (ESC, ask_user,
   * bypass, arbitration pause) DO stop it — the invariant never overrides a
   * person.
   */
  function startRevivalTimer(ctx: ExtensionContext): void {
    if (revivalTimer) return;
    revivalTimer = setInterval(() => {
      // Same freshness rule as the child heartbeat: `latestCtx` is
      // refreshed on every tool_call, so a stale captured ctx must never
      // silently kill the check (a throwing isIdle would be swallowed by
      // the catch below and the session would never be revived).
      const live = host.ctx() ?? ctx;
      try {
        const state = host.state();
        if (state.taskMode === "explore" || state.taskMode === "normal") {
          stopRevivalTimer();
          return;
        }
        const mode = state.taskMode as "loop" | "orchestrator";
        // P2: the problems assembly costs a fingerprint (~180ms) — pass it
        // LAZY so the cheap guards (mode, consent, idle, throttle) run
        // first, and only a session that might actually be revived pays.
        let problemsCache: string[] | undefined;
        const decision = decideRevival({
          mode,
          exitProblems: () => (problemsCache ??= sessionExitProblems()),
          idle: !!live.isIdle?.(),
          humanStop: {
            aborted: deps.lastRunAborted(),
            awaitingAnswer: !!state.pausedQuestion,
            bypassed: state.bypass.active,
            arbitrationPaused: deps.arbitrationPaused(),
          },
          handedOff: handedOffSession,
          // DONE by its own account: `declare_done` recorded the completion
          // and no edit has deleted it since (an edit deletes it). Checked
          // BEFORE the problem thunk on purpose — a finished session must not
          // pay a worktree fingerprint every tick to be told it is finished,
          // and the human's own merge / pull / checkout in this worktree must
          // not re-open a contract this session already met.
          completed: !!state.completion,
          lastRevivalAt,
          now: Date.now(),
          intervalMs: REVIVAL_INTERVAL_MS,
        });
        if (!decision.revive) return;
        lastRevivalAt = Date.now();
        pi.sendUserMessage(buildRevivalMessage(mode, problemsCache ?? []), { deliverAs: "followUp" });
      } catch { /* a revival must never break the session it revives */ }
    }, REVIVAL_INTERVAL_MS);
    (revivalTimer as unknown as { unref?: () => void }).unref?.();
  }
  function stopRevivalTimer(): void {
    if (revivalTimer) clearInterval(revivalTimer);
    revivalTimer = undefined;
  }


  /**
   * Arm the background supervisor (default-on in orchestrator mode, 10s).
   *
   * It only WAKES the session when there is something a supervisor has to act
   * on. It used to demand an IDLE project manager as well — "a wake-up
   * delivered mid-turn would just be noise" — and that assumption was the bug
   * the user reported (2026-09-14): a manager that is busy (writing a plan,
   * running an audit, reading a child's delivery) simply never heard about a
   * child that had asked a question, so the child waited until the manager
   * happened to call `orchestrator_wait`. A child blocked on a question is
   * time the whole orchestration loses, and the manager's own pending work is
   * not more urgent than that — so EVERY child event goes through now, busy or
   * idle alike.
   *
   * THE DELIVERY IS A `steer`, deliberately: pi delivers it after the current
   * batch of tool calls finishes and before the next LLM call, so the manager
   * reads it on its very next turn WITHOUT the gate aborting work in flight
   * (user decision: an aborted minute-long plan audit is a worse trade than a
   * turn of latency). Dedup: the event memory is shared with
   * `orchestrator_wait` (which, while it blocks, has the news to itself), the
   * 10s→30s→60s backoff bounds the repeats, and at most ONE notice is in
   * flight, rewritten on delivery to what is still true (`superviseTick`).
   */
  function startSupervisionTimer(): void {
    if (supervisionTimer || host.state().taskMode !== "orchestrator") return;
    supervisionTimer = setInterval(() => {
      try {
        if (host.state().taskMode !== "orchestrator") { stopSupervisionTimer(); return; }
        // RETIRED: this session handed the orchestration to a successor.
        // Supervision exists to push the plan forward, and pushing it is now
        // somebody else's job — a wake-up here would put two project managers
        // on one orchestration (the exact defect the revival path already
        // guards against at lib/session-revival.ts).
        if (handedOffSession) { stopSupervisionTimer(); return; }
        // NO idle requirement (2026-09-14): busy is exactly when a child's
        // question has to reach the manager. `steer` does not abort the tool
        // calls already running, so the interruption costs a turn at most.
        superviseTick();
      } catch { /* supervision is a convenience, never a gate */ }
    }, SUPERVISION_INTERVAL_MS);
    // Never hold the process open for a supervision timer.
    (supervisionTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * THE UNIFIED EXIT CRITERION (2026-08-30).
   *
   * Every place that asks "is this session done?" reads this one function:
   * `agent_settled` continuation, the revival timer, and `declare_done`.
   * It used to be two separately-assembled answers — the loop's gate
   * problems plus completion items, and the orchestration's plan/children/
   * decisions — which is how one mode could end up with a revival clock
   * and the other without one. One function, one answer.
   */
  function sessionExitProblems(): string[] {
    const state = host.state();
    if (state.taskMode === "orchestrator") {
      return orchestrationDoneProblems();
    }
    const { cwd, primary: primaryRepoRoot, all: sessionRepos } = host.repos();
    const fp = computeFingerprint(cwd);
    const problems = (state.hasCodeChange || state.hasDocChange)
      ? unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: deps.projectConfig().docSync })
      : [];
    const completion: string[] = [];
    for (const root of sessionRepos) {
      const st = root === primaryRepoRoot ? state : host.stateFor(root);
      for (const p of deps.copilotProblemsFor(st)) {
        completion.push(root === primaryRepoRoot ? p : `[${deps.repoLabel(root)}] ${p}`);
      }
    }
    if (!deps.goalStageSatisfied()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
    return [...problems, ...completion];
  }

  /**
   * The orchestrator's own `agent_settled` continuation (R-3).
   *
   * Same shape as the loop's, entirely different criteria: the plan, the
   * children, and the decisions — never a review or a precommit this session
   * will never have.
   */
  function orchestratorSettled(ctx: ExtensionContext): void {
    // RETIRED: this session handed its orchestration to a successor.
    //
    // MEASURED (2026-09-10, rebate): without this guard the predecessor was
    // revived TWO SECONDS after a successful `orchestrator_handoff` —
    // `agent_settled` fired as its turn ended, `sessionExitProblems()` still
    // reported the plan's unfinished tasks, and `[ORCHESTRATION_RESUME]` put
    // it back into `orchestrator_wait` beside the successor it had just
    // started. Both timers are left unarmed for the same reason: the plan is
    // no longer this session's to push.
    //
    // This is the same judgement `decideRevival` already makes on its own
    // path (`handedOff: handedOffSession`); this path simply lacked it.
    if (handedOffSession) return;
    startSupervisionTimer();
    startRevivalTimer(ctx);
    // USER REQUIREMENT (shared with the loop path): the user aborted this
    // run with ESC — do not override an explicit human stop. The user's
    // next message clears the flag and the loop resumes.
    if (deps.lastRunAborted()) {
      try { ctx.ui.notify("review-gate: 检测到手动中止（ESC）— 编排自动续跑已暂停；你的下一条消息会恢复。", "warning"); } catch { /* headless */ }
      updateWidget(ctx);
      return;
    }
    const problems = sessionExitProblems();
    const news = drainSupervisionNews().map((event) => event.summary);
    if (problems.length === 0 && news.length === 0) return;
    const maxRounds = host.state().maxRounds;
    if (orchestratorContinuations >= maxRounds) return;
    orchestratorContinuations += 1;
    pi.sendUserMessage(
      buildOrchestratorResume({
        problems,
        news,
        health: lastSupervisionHealth,
      }) + `\n(编排续跑 ${orchestratorContinuations}/${maxRounds})`,
      { deliverAs: "followUp" },
    );
  }

  /**
   * THE NAME'S CLOCK — a timer of the extension, not of the agent.
   * Same reason the child heartbeat is a timer (round-4 P0): a session blocked
   * in a `judge_wait`, a full precommit or any long tool call is INSIDE one
   * turn, so nothing agent-driven fires — and a registration that stops being
   * renewed starts looking like a dead holder, which is the one thing that must
   * never happen to a session that is alive. It runs for the whole session and
   * does nothing while no name is held (lib/session-name-tools.ts `tick`).
   */
  let sessionNamingTimer: ReturnType<typeof setInterval> | undefined;
  function startSessionNamingHeartbeat(): void {
    if (sessionNamingTimer) return;
    sessionNamingTimer = setInterval(() => {
      try { sessionNaming.tick(); } catch { /* a heartbeat must never break its session */ }
      // THE INBOX RIDES THE SAME CLOCK (t3, user decision): one timer keeps two
      // things true — the name's liveness and the messages addressed to it.
      // A second heartbeat would be a second thing to get wrong, and the poll
      // has nowhere faster to be: a message is INJECTED, never interrupting
      // whatever the session is in the middle of.
      try { sessionMessaging.drain(); } catch { /* a poll must never break its session */ }
    }, sessionNaming.heartbeatMs);
    // Never the reason the process stays alive.
    (sessionNamingTimer as unknown as { unref?: () => void }).unref?.();
  }
  function stopSessionNamingHeartbeat(): void {
    if (sessionNamingTimer) clearInterval(sessionNamingTimer);
    sessionNamingTimer = undefined;
  }

  return {
    orchestrationDoneProblems,
    sessionExitProblems,
    orchestratorSettled,
    startRevivalTimer,
    stopRevivalTimer,
    stopSupervisionTimer,
    /** One background-supervision tick, exposed so a test drives it without the 10s clock. */
    superviseTick,
    startSessionNamingHeartbeat,
    stopSessionNamingHeartbeat,
    /** Has this session handed its work to a successor? */
    handedOff: (): boolean => handedOffSession,
    /** Phase two of a handover: from here nothing revives, supervises or reports. */
    markHandedOff: (): void => { handedOffSession = true; },
    /** A new budget: the orchestrator continuation count starts over. */
    resetOrchestratorContinuations: (): void => { orchestratorContinuations = 0; },
  };
}
