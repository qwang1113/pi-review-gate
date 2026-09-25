/**
 * L2 — AUTO-CONTINUATION: `agent_settled` re-triggers the loop while gates are
 * unmet (recursion-guarded, budgeted, stall-broken), `agent_end` detects the
 * user's ESC, and the hosted-wait watchdog keeps a session with a judge in
 * flight alive. Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4).
 */

import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SETTLED_TOOL_REMINDER, WAIT_DISCIPLINE_HINT } from "./agent-directives.ts";
import { buildChildWaitNotice, classifyChildren, type ChildSnapshot } from "./child-watch.ts";
import type { createChildSide } from "./child-side-host.ts";
import { STRATEGIC_RESET_CHECKLIST, STRATEGIC_RESET_OFFSET } from "./constants.ts";
import { computeFingerprint } from "./fingerprint.ts";
import type { GateState } from "./gate-state.ts";
import { shouldStrategicReset, unmetRequirements } from "./gate-state-requirements.ts";
import { judgeLive, tmuxServerFrom } from "./hierarchy.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import type { createJudgeRoundSettle } from "./judge-round-settle.ts";
import { readJudgeSideEnv } from "./judge-side.ts";
import { LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK } from "./loop-goal.ts";
import { buildGoalForceNegotiateDirective, goalNegotiationOverdue } from "./loop-goal-directives.ts";
import {
  buildStallNotice,
  classifyStallCause,
  evaluateStall,
  negotiationFingerprint,
  progressSignature,
  stallInMotion,
  STALL_MOTION_MAX_AGE_SEC,
  STALL_REPEAT_LIMIT,
} from "./loop-stall.ts";
import type { SessionCells } from "./session-cells.ts";

/** L7/L8 completion-only continuations have their own, smaller budget. */
const COMPLETION_CONTINUATION_CAP = 12;
/** Hosted judge-child wait notices: one per minute per state at most. */
const CHILD_NOTICE_MIN_MS = 60_000;

export interface L2ContinuationDeps {
  pi: Pick<ExtensionAPI, "sendUserMessage">;
  childSide: Pick<ReturnType<typeof createChildSide>, "reportChildState" | "noteChildProgress" | "drainChildInstructions">;
  registry: Pick<
    JudgeRegistry,
    "ownJudges" | "ownLiveJudges" | "judgeRoundReported" | "listServerPanesForThisSession" | "channelLastActivity"
  >;
  settleFinishedRounds: ReturnType<typeof createJudgeRoundSettle>["settleFinishedRounds"];
  /** The runtime clocks (lib/orchestrator-runtime-host.ts), read at call time. */
  runtime(): {
    handedOff(): boolean;
    orchestratorSettled(ctx: ExtensionContext): void;
    startRevivalTimer(ctx: ExtensionContext): void;
  };
  goalStageSatisfied(): boolean;
  copilotProblemsAcrossRepos(): string[];
  updateWidget(ctx: ExtensionContext): void;
  persist(ctx?: ExtensionContext): void;
}

export function createL2Continuation(cells: SessionCells, deps: L2ContinuationDeps) {
  function cancelChildWaitTimer(): void {
    if (cells.childWaitTimer) clearTimeout(cells.childWaitTimer);
    cells.childWaitTimer = undefined;
  }

  /**
   * Gate-owned hosted-wait watchdog. It is intentionally NOT `unref()`'d:
   * while a child is in flight, the main session must remain alive even if the
   * child never signals. A single timer replaces the old fall-through RESUME
   * noise; session_shutdown cancels it.
   */
  function scheduleChildWaitRecheck(delayMs: number): void {
    if (cells.childWaitTimer) return;
    cells.childWaitTimer = setTimeout(() => {
      cells.childWaitTimer = undefined;
      // Re-check every legal stop condition at callback time. The timer is
      // deliberately referenced, but it must never revive a user-paused or
      // user-aborted session, or a task whose child has already been closed.
      const state = cells.state;
      if (state.taskMode === "explore" || state.taskMode === "normal" ||
          state.pausedQuestion || cells.lastRunAborted || !cells.loopArmed || state.bypass.active) return;
      if (deps.registry.ownJudges().length === 0) return;
      try {
        deps.pi.sendUserMessage(
          "[REVIEW_GATE_CHILD_WATCHDOG] 门禁托管等待到期，重新检查子会话的通道 report、有无 pane 死亡与静默上限；" +
          `新消息会以标准报告送达并继续。\n${WAIT_DISCIPLINE_HINT}`,

          { deliverAs: "followUp" },
        );
      } catch { /* session was replaced or shut down */ }
    }, Math.max(1_000, delayMs));
    // Deliberately keep this timer referenced: it is the main-session liveness
    // anchor while the child may have stopped without signalling.
  }

  /**
   * Is a judge child (reviewer / quality-auditor / adviser / goal-auditor)
   * still in flight? The stall breaker must not cut the loop off while a judge
   * is working — its verdict is exactly what the unchanged signature is
   * waiting for (round-16 P2).
   *
   * Freshness bound: a child alive since before STALL_MOTION_MAX_AGE_SEC is
   * the HUNG case the breaker exists for, not motion (goal-auditor P2).
   */
  function judgeChildInMotion(): boolean {
    const cutoff = Date.now() - STALL_MOTION_MAX_AGE_SEC * 1000;
    // `ownLiveJudges()` for the same reason activeJudgeWait uses it: a
    // persisted entry from a previous process is this opener's judge, but its
    // pane is gone, and "motion" it is not.
    return deps.registry.ownLiveJudges()
      .filter((c) => {
        const at = Date.parse(c.spawnedAt);
        return Number.isFinite(at) && at >= cutoff;
      })
      .some((c) => !deps.registry.judgeRoundReported(c));
  }

  /**
   * sd0x-dev-flow R10 "Think Harder": one-shot strategic-reset checklist when
   * the loop is BLOCKED close to the round cap. The firing predicate is the
   * pure, unit-tested shouldStrategicReset() (review verdict must be BLOCKED —
   * a READY loop merely awaiting precommit must NOT consume the one-shot).
   * Returns the checklist text to append (and marks it fired), or "". The
   * state parameter defaults to the primary state so a missed argument can
   * never dereference undefined.
   */
  function maybeStrategicReset(st: GateState = cells.state): string {
    if (!shouldStrategicReset(st, cells.projectConfig.thinkHarder, STRATEGIC_RESET_OFFSET)) return "";
    st.strategicResetFired = true;
    return "\n\n" + STRATEGIC_RESET_CHECKLIST;
  }

  /**
   * ESC abort detection (feeds the L2 pause): stopReason "aborted" on the
   * run's LAST assistant message = the user aborted. Overwritten each
   * agent_end: an overflow-recovery abort that Pi retries ends with a later,
   * non-aborted agent_end, which clears the flag again before settle.
   */
  function onAgentEnd(event: AgentEndEvent): void {
    let last: { role?: string; stopReason?: string } | undefined;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i] as { role?: string; stopReason?: string };
      if (m?.role === "assistant") { last = m; break; }
    }
    cells.lastRunAborted = last?.stopReason === "aborted";
  }

  async function onAgentSettled(ctx: ExtensionContext): Promise<void> {
    const { childSide } = deps;
    const runtime = deps.runtime();
    // A SETTLE IS NOT A STOP UNTIL THE GATE IS DONE WITH IT (round-3 P1).
    //
    // The "I stopped" proof used to be published at the top — and this handler
    // may inject the NEXT TURN ITSELF, a few lines below, so a supervisor could
    // act on a stop that never happened. The proof is published by the EXITS
    // THAT MEAN IT: the early returns that decide NOT to continue, and the end
    // of the handler. Every exit that hands the session more work either says
    // nothing or withdraws the stamp it already had.
    // The CLEAR direction comes first: nothing below may inherit a previous
    // settle's stamp, and this report therefore carries none.
    childSide.noteChildProgress("tool");
    childSide.reportChildState(ctx);
    const confirmStop = (): void => {
      childSide.noteChildProgress("settled");
      childSide.reportChildState(ctx, undefined, { force: true });
    };
    await childSide.drainChildInstructions(ctx);
    const state = cells.state;
    // Judge panes conclude through judge_conclude — there is no settle-time
    // verdict scraping. Finished rounds wake in every mode except normal:
    // explore is advisory on enforcement, not deaf.
    if (state.taskMode !== "normal" && !runtime.handedOff() && (await deps.settleFinishedRounds(ctx))) {
      // …and this exit may have handed the session a round's report, so it is
      // NOT a stop: nothing is published here (see `confirmStop`).
      return;
    }
    // Explore and normal never auto-continue — that is their defining
    // difference from loop. This check MUST stay before the loopArmed check:
    // explore/normal-mode edits set loopArmed = true in tool_result, and only
    // this early return keeps the continuation loop off.
    if (state.taskMode === "explore" || state.taskMode === "normal") { confirmStop(); return; }
    // Paused for a user question (ask_user): defense-in-depth — loopArmed is
    // in-memory, the persisted pause keeps auto-continuation off until the
    // user actually replies.
    if (state.pausedQuestion) { confirmStop(); return; }
    if (!cells.loopArmed) { confirmStop(); return; }
    if (state.bypass.active) { confirmStop(); return; }
    // NOT a stop: the agent is still working, so no proof is published here.
    if (!ctx.isIdle()) return;

    // R-3 — AN ORCHESTRATOR IS NOT IN THE LOOP, and the loop's nudge is not
    // merely off-topic for it: its criteria can never be met (a project
    // manager writes no code, runs no precommit and negotiates no loop goal).
    // Its continuation is the plan.
    if (state.taskMode === "orchestrator") {
      runtime.orchestratorSettled(ctx);
      return;
    }

    // A JUDGE PANE IS NOT IN THE LOOP EITHER (round-7 P1): the RESUME text it
    // received is the OPENER's sidecar, and acting on it made the reviewer
    // conclude twice. Its completion is the single conclude call it already made.
    if (readJudgeSideEnv(process.env)) return;

    // The revival clock for the LOOP session: armed here so a turn that ends
    // under any of the guards above still gets its minute-level second chance.
    runtime.startRevivalTimer(ctx);
    // 2026-09-17 (user decision): count un-goaled turns so the force-negotiate
    // directive fires at GOAL_FORCE_NEGOTIATE_TURN_THRESHOLD. The count
    // persists so a restart cannot reset the clock.
    if (!deps.goalStageSatisfied()) {
      state.turnsWithoutGoal = (state.turnsWithoutGoal ?? 0) + 1;
    } else {
      state.turnsWithoutGoal = undefined;
    }
    const forceNegotiate = goalNegotiationOverdue(state.turnsWithoutGoal);
    const fp = computeFingerprint(cells.cwd);
    // Ship-gate requirements only exist once this session touched something.
    const problems = (state.hasCodeChange || state.hasDocChange)
      ? unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: cells.projectConfig.docSync })
      : [];

    // L7/L8 — completion-only requirements (never part of the ship authority):
    // an open Copilot review cycle and an unapproved loop goal.
    const completion: string[] = [...deps.copilotProblemsAcrossRepos()];
    if (!deps.goalStageSatisfied()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
    // Goal-only continuation: the ONLY remaining item is the unapproved loop
    // goal — the resume text below points at the interview instead of
    // re-asking.
    const goalOnly =
      problems.length === 0 &&
      completion.length === 1 &&
      completion[0] === LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK;

    // THE ORDINARY STOP (round-4 P1): every gate is satisfied, so this handler
    // will nudge nobody again.
    if (problems.length === 0 && completion.length === 0) { confirmStop(); return; }

    // USER REQUIREMENT: the user aborted this run (ESC). Injecting a
    // continuation would override an explicit human stop, so the loop pauses
    // instead; the user's next message resumes it.
    if (cells.lastRunAborted) {
      try {
        ctx.ui.notify(
          "review-gate: 检测到手动中止（ESC）— 自动循环已暂停（质量门禁仍未满足）。你的下一条消息会恢复循环；ship 命令仍被拦截。",
          "warning",
        );
      } catch { /* headless */ }
      deps.updateWidget(ctx);
      confirmStop();
      return;
    }

    // Round-18 (user ask): the main session must HOST the wait itself — a
    // judge child's completion signal is an ACCELERATOR, never a precondition.
    // Dead/silent children end their wait NOW, live fresh ones are HOSTED.
    const { registry } = deps;
    const paneList = registry.listServerPanesForThisSession();
    const tmuxServer = tmuxServerFrom(process.env);
    const childSnapshots: ChildSnapshot[] = [];
    const sessionIdsBySession = new Map<string, string>();
    for (const c of registry.ownJudges()) {
      // A judge whose death was ALREADY announced is not news a second time
      // (reviewer P2, 2026-09-05) — unless it is ALIVE again, in which case
      // its next death is news again.
      if (cells.announcedTerminated.has(c.judgeId)) {
        if (judgeLive(c, paneList, tmuxServer)) cells.announcedTerminated.delete(c.judgeId);
        else continue;
      }
      childSnapshots.push({
        title: c.title,
        sessionId: c.judgeId,
        role: c.role,
        spawnedAt: c.spawnedAt,
        // Liveness through the SAME predicate the wait uses (lib/hierarchy.ts):
        // an UNREADABLE pane list stays alive — missing information must never
        // end a wait.
        alive: judgeLive(c, paneList, tmuxServer),
        // The channel is the activity record now; absent ⇒ spawnedAt.
        lastActivityAt: registry.channelLastActivity(c),
      });
      sessionIdsBySession.set(c.judgeId, c.title);
    }
    if (childSnapshots.length > 0) {
      const childVerdict = classifyChildren(childSnapshots, Date.now());
      const childNotice = buildChildWaitNotice(childVerdict, sessionIdsBySession);
      const notifyNow = childVerdict.terminated.length > 0 || Date.now() - cells.lastChildNoticeAt >= CHILD_NOTICE_MIN_MS;
      if (childNotice) {
        if (!notifyNow) {
          // Do not fall through to the generic RESUME injection: that would
          // burn review budget while the child is still legitimately in flight.
          scheduleChildWaitRecheck(CHILD_NOTICE_MIN_MS - (Date.now() - cells.lastChildNoticeAt));
          return;
        }
        cancelChildWaitTimer();
        // A terminal child is never throttled; only a genuinely in-flight
        // child is rate-limited.
        if (childVerdict.terminated.length === 0) cells.lastChildNoticeAt = Date.now();
        // …but each dead judge is announced ONCE, recorded where the
        // announcement actually goes out.
        for (const t of childVerdict.terminated) cells.announcedTerminated.add(t.child.sessionId);
        deps.pi.sendUserMessage(
          `[REVIEW_GATE_CHILD_${childVerdict.terminated.length > 0 ? "ENDED" : "HOST_WAIT"}] ${childNotice}\n\n` +
          (childVerdict.terminated.length > 0
            ? "Continue: read the child's output and drive the loop forward. Do not summarize; execute."
            : "Waiting discipline: do all deterministic work first; only when nothing is left, block in ONE bash call watching the three criteria. Never end the turn and leave the wake-up to the child."),
          { deliverAs: "followUp" },
        );
        return;
      }
    }
    // Review-round budget is checked AFTER the child watchdog above: a dead
    // child must still be inspected even when the cap is reached.
    if (problems.length > 0 && cells.continuationsInjected >= state.maxRounds) { confirmStop(); return; }
    if (problems.length === 0 && cells.completionContinuations >= COMPLETION_CONTINUATION_CAP) { confirmStop(); return; }

    // L2 circuit breaker: an unmet gate justifies another turn only while
    // something is still MOVING. WHAT COUNTS AS MOTION is `stallInMotion`'s
    // call — a running judge, the overdue-negotiation directive (2026-09-17
    // P1: it must not be swallowed by the breaker), a dialog waiting for the
    // user, and a user answer that arrived after the PREVIOUS observation.
    // Tighten-only: no verdict is granted, ship commands stay blocked.
    const motion = {
      judgeInFlight: judgeChildInMotion(),
      forceNegotiate,
      pausedForUser: state.pausedQuestion !== undefined,
      lastUserInteractionAt: cells.lastUserInteractionAt.current,
      previousObservationAt: cells.lastStallObservedAt,
    };
    const stall = evaluateStall(
      cells.loopStall,
      progressSignature({
        fingerprint: fp.unavailable ? "" : fp.digest,
        reviewVerdict: state.review.verdict,
        precommitVerdict: state.precommit.verdict,
        rounds: state.rounds.length,
        problems: [...problems, ...completion],
        // The contract hashes are recorded by the gate itself, so "the
        // requirement moved" is a fact rather than a guess.
        contract: negotiationFingerprint({
          restatementHash: state.restatement?.hash,
          goalDraftHash: state.goalPrereview?.hash,
          goalApprovalHash: state.loopGoal?.hash,
        }),
      }),
      STALL_REPEAT_LIMIT,
      { inMotion: stallInMotion(motion) },
    );
    // The observation is stamped AFTER the decision: an interaction that lands
    // later belongs to the NEXT one.
    cells.lastStallObservedAt = new Date().toISOString();
    cells.loopStall = stall;
    if (stall.stalled) {
      // Once per stall, not once per turn.
      if (!cells.stallNoticeShown) {
        cells.stallNoticeShown = true;
        const cause = classifyStallCause({
          pausedForUser: motion.pausedForUser,
          goalConfirmed: deps.goalStageSatisfied(),
          hasUnreviewedChanges:
            (state.hasCodeChange || state.hasDocChange) && state.review.verdict !== "READY",
          lastUserInteractionAt: cells.lastUserInteractionAt.current,
          nowMs: Date.now(),
        });
        try { ctx.ui.notify(buildStallNotice(stall.repeats, cause), "warning"); } catch { /* headless */ }
      }
      deps.updateWidget(ctx);
      confirmStop();
      return;
    }
    cells.stallNoticeShown = false;

    if (problems.length > 0) cells.continuationsInjected += 1;
    else cells.completionContinuations += 1;
    // R10: fire the strategic-reset checklist BEFORE persist so the fired flag
    // survives restarts (one-shot per gate-state lifetime).
    const reset = maybeStrategicReset(state);
    deps.persist(ctx);
    deps.pi.sendUserMessage(
      "[REVIEW_GATE_RESUME] " +
        (problems.length > 0 ? "Quality gates are still unmet:\n" : "The task is not finished yet:\n") +
        [...problems, ...completion].map((p) => `- ${p}`).join("\n") +
        (forceNegotiate
          ? "\n\n" + buildGoalForceNegotiateDirective(state.turnsWithoutGoal)
          : "") +
        (problems.length > 0
          ? `\n(continuation ${cells.continuationsInjected}/${state.maxRounds}) ` +
            "Continue: fix → judge_submit({role:\"reviewer\"}) → declare_done. " +
            SETTLED_TOOL_REMINDER + " Do not summarize; execute."
          : `\n(completion continuation ${cells.completionContinuations}/${COMPLETION_CONTINUATION_CAP}) ` +
            (goalOnly
              ? "The only open item is the unapproved loop goal. Interview the user with ask_user " +
                "(the gate runs the interview and pauses for their answers), draft the goal in " +
                "Simplified Chinese, get it through the `goal-auditor` audit, then call " +
                "propose_loop_goal for approval. Do not summarize; execute."
              : "Continue: work these off — Copilot threads get a fix + resolve or a reply explaining " +
                "why not (copilot_review verifies), an unapproved goal gets negotiated with " +
                "ask_user, drafted in Simplified Chinese, audited by `goal-auditor` and only then " +
                "submitted via propose_loop_goal. Do not summarize; execute.")) +
        (!cells.sessionEdited && !state.scopeLimit
          ? "\nIf these unmet gates target PRE-EXISTING changes this session never made, you may call request_scope_limit — the USER decides whether session-only coverage suffices."
          : "") +
        reset,
      { deliverAs: "followUp" },
    );
  }

  return {
    cancelChildWaitTimer,
    judgeChildInMotion,
    maybeStrategicReset,
    onAgentEnd,
    onAgentSettled,
  };
}
