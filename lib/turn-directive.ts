/**
 * THE PER-TURN SURFACES — `before_agent_start` (the system prompt the gate
 * injects every turn), `turn_end` (the heartbeat plus the one-way stale-state
 * reconciliation) and the thinking-loop guard's message hooks. Moved out of
 * `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split).
 */

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SCOPE_ESCALATION_PROTOCOL } from "./agent-directives.ts";
import { startupAgentsCheck } from "./agents-startup.ts";
import { formatAgentsStartupRefusal } from "./agents-startup-copy.ts";
import { LANGUAGE_DIRECTIVE } from "./constants.ts";
import { EDIT_DISCIPLINE_DIRECTIVE } from "./edit-discipline.ts";
import { computeFingerprint, type Fingerprint } from "./fingerprint.ts";
import { couldReconcile, reconcileArming } from "./gate-arming.ts";
import { MODE_REGISTRY, resolveGateMode } from "./gate-modes.ts";
import type { GateState } from "./gate-state.ts";
import { unmetRequirements } from "./gate-state-requirements.ts";
import { readJudgeSideEnv } from "./judge-side.ts";
import {
  buildGoalForceNegotiateDirective,
  buildGoalStageOffDirective,
  goalNegotiationOverdue,
} from "./loop-goal-directives.ts";
import { buildStagesDirective, type LoopStage, type LoopStagesRecord } from "./loop-stages.ts";
import { resolvePackageAgentsDir } from "./model-config.ts";
import { loadRegistry } from "./model-spec.ts";
import { orchestrationIdFromEnv } from "./orchestration-id.ts";
import {
  buildOrchestratorExitBlock,
  CHILD_OF_ORCHESTRATOR_DIRECTIVE,
  ORCHESTRATOR_DIRECTIVE,
} from "./orchestrator-directives.ts";
import { globalConfigPath, projectConfigPath } from "./project-config.ts";
import { commitsAheadOfBase } from "./repo-facts.ts";
import { formatReviewScopeDirective, type SettledConclusion } from "./review-carryover.ts";
import type { ReviewScopeDecision } from "./review-scope.ts";
import type { SessionCells } from "./session-cells.ts";
import { formatInheritanceBrief, readInheritance } from "./session-inheritance.ts";
import { GATE_MODE_DECISION_DIRECTIVE, isEnforcedMode } from "./task-mode.ts";
import { createThinkingLoopController } from "./thinking-loop-controller.ts";
import { readWorkerSideEnv } from "./worker-side.ts";
import { advisoryChangeToken, changedFiles } from "./worktree-changes.ts";

export interface TurnDirectiveDeps {
  handoffReminderBlock(): string;
  orchestrationDoneProblems(): string[];
  loopStagesRecord(): LoopStagesRecord | undefined;
  stageIsOn(stage: LoopStage): boolean;
  goalStageSatisfied(): boolean;
  loopGoalDirectiveText(): string;
  isOrchestrationChild(): boolean;
  reviewScopeFor(root: string, st: GateState): ReviewScopeDecision;
  previousRoundFindings(st: GateState): string[];
  settledConclusion(st: GateState): SettledConclusion | undefined;
  log(text: string): void;
}

export function createTurnDirective(cells: SessionCells, deps: TurnDirectiveDeps) {
  // ---- Advisory (PROMPT-ONLY) fingerprint memo ----
  // computeFingerprint() deliberately defeats git's stat cache (~575ms on a
  // 9k-file repo). The per-turn system prompt paid that on EVERY turn.
  //
  // SAFETY: keyed on advisoryChangeToken() (a filesystem probe) and read by
  // exactly one caller — this prompt renderer. A stale hit can only produce a
  // stale PROMPT for one turn; every enforcement path calls
  // computeFingerprint() directly. A null token always falls through to a
  // real compute — never to a reuse.
  let advisoryFpMemo: { token: string; fp: Fingerprint } | null = null;
  function advisoryFingerprint(): Fingerprint {
    const token = advisoryChangeToken(cells.cwd);
    if (token === null) return computeFingerprint(cells.cwd);
    if (advisoryFpMemo && advisoryFpMemo.token === token) return advisoryFpMemo.fp;
    const fp = computeFingerprint(cells.cwd);
    // Never memoize an UNAVAILABLE result: it is a transient failure signal.
    advisoryFpMemo = fp.unavailable ? null : { token, fp };
    return fp;
  }

  /**
   * STARTUP HARD CHECK (user requirement 2026-08-30): every role must have a
   * resolvable model chain — no silent built-in fallback. Returns the refusal
   * block when the session must not start, undefined otherwise.
   */
  function agentsStartupRefusal(): string | undefined {
    try {
      // ONE call: validate every role, self-heal the roles NO layer declares
      // (merged into ~/.pi/review-gate.json, gaps only), validate again. The
      // ordering lives in lib/agents-startup.ts, where it is testable.
      const result = startupAgentsCheck({
        agentsGlobal: cells.projectConfig.agentsGlobal,
        agentsProject: cells.projectConfig.agentsProject,
        registry: loadRegistry(),
        configPath: globalConfigPath(),
        // The root the project layer was LOADED from (session-lifecycle), not
        // cwd: a session started in a subdirectory reads the root's file.
        projectConfigPath: projectConfigPath(cells.primaryRepoRoot),
        agentsDir: resolvePackageAgentsDir(),
      });
      const { healed, agentsSection } = result;
      if (agentsSection !== undefined) {
        // The SESSION's snapshot follows the file it just healed: a session
        // reads its config ONCE (quality-auditor P2, 2026-09-22).
        cells.projectConfig = { ...cells.projectConfig, agentsGlobal: agentsSection };
      }
      if (healed.length > 0) {
        deps.log(`self-healed missing agent slots into ${globalConfigPath()}: ${healed.join(", ")}`);
      }
      return formatAgentsStartupRefusal(result);
    } catch (e) {
      return `\n\n## REVIEW-GATE: 配置检查异常，会话无法启动\n` +
        `启动配置检查本身失败（${e instanceof Error ? e.message : String(e)}）。` +
        `\n请修复 ~/.pi/review-gate.json 后重开会话。`;
    }
  }

  function onBeforeAgentStart(event: BeforeAgentStartEvent): { systemPrompt: string } {
    const state = cells.state;
    // Output-language gate: UNCONDITIONAL — injected before any early return.
    let systemPrompt = event.systemPrompt + "\n\n" + LANGUAGE_DIRECTIVE;

    // A SUCCESSOR'S BRIEF — for EVERY kind of session (2026-09-14, measured).
    // THE ID IS READ HERE, NEVER MINTED (reviewer P2, 2026-09-14): a session
    // that owns no orchestration has nothing to inherit.
    const inheritedBrief = formatInheritanceBrief(readInheritance(), orchestrationIdFromEnv());
    if (inheritedBrief) systemPrompt += "\n\n" + inheritedBrief;

    // THE HANDOFF REMINDER — before every early return below (a session out of
    // context must hear it in EVERY mode, judge panes included). It renders
    // nothing until the session's own reading passes 70% of its window.
    systemPrompt += deps.handoffReminderBlock();

    // STARTUP HARD CHECK — normal mode is exempt (the user turned the gate off).
    if (state.taskMode !== "normal") {
      const refusal = agentsStartupRefusal();
      if (refusal !== undefined) return { systemPrompt: systemPrompt + refusal };
    }

    // Normal mode: the extension steps aside — no workflow prompt at all. The
    // language directive above stays (the user's standing output policy).
    if (state.taskMode === "normal") {
      return { systemPrompt };
    }

    // Edit-discipline nudge (prompt-only): steer agents back to the edit/write
    // tools instead of shell-editing files after a failed tool call.
    systemPrompt += "\n\n" + EDIT_DISCIPLINE_DIRECTIVE;

    // Mode dispatch (single key): a spawned judge pane resolves to its
    // reporting-shell entry — never the classification directive (whose
    // set_gate_mode is denied to it). Anything else undecided keeps the
    // fail-closed directive.
    const gateMode = resolveGateMode({
      taskMode: state.taskMode,
      judgeRole: readJudgeSideEnv(process.env)?.role,
    });
    if (gateMode === "review" || gateMode === "plan" || gateMode === "goal") {
      systemPrompt += "\n\n" + MODE_REGISTRY[gateMode].prompt;
    } else if (state.taskMode === undefined) {
      systemPrompt += "\n\n" + GATE_MODE_DECISION_DIRECTIVE;
    }
    // Order matters for latency: unmetRequirements() returns [] whenever the
    // session tracks no code AND no doc change, so the fingerprint cannot
    // affect the outcome — computing it first cost every clean turn a full
    // re-hash. This block only renders prompt text.
    const gateArmed = state.hasCodeChange || state.hasDocChange;
    const fp = gateArmed ? advisoryFingerprint() : null;
    const problems = gateArmed
      ? unmetRequirements(state, fp!.digest, fp!.unavailable, { requireDocSync: cells.projectConfig.docSync })
      : [];
    // A WORKER IS NOT AN EXPLORE SESSION (2026-09-21): the explore prompt is
    // written for an agent that owns a task, and two contradicting closing
    // instructions in one prompt is how a worker ends a turn without
    // reporting (reviewer P2).
    if (state.taskMode === "explore" && !readWorkerSideEnv(process.env)) {
      return {
        systemPrompt:
          systemPrompt +
          "\n\n" + MODE_REGISTRY.explore.prompt +
          (problems.length ? `\nAdvisory 门禁状态：\n${problems.map((p) => `- ${p}`).join("\n")}` : ""),
      };
    }
    // THE USER'S SWITCH RECORD, READABLE BY THE AGENT (2026-09-22, user ask):
    // a released stage used to be a fact the agent could only learn by doing
    // work nobody owes. AN UNDECIDED SESSION GETS IT TOO (it runs the loop's
    // semantics); orchestrator is excluded, explore/normal keep the gate out.
    if (state.taskMode === "loop" || state.taskMode === undefined) {
      const stagesBlock = buildStagesDirective(deps.loopStagesRecord());
      if (stagesBlock) systemPrompt += "\n\n" + stagesBlock;
      // THE POINTER MUST NOT DANGLE (quality round P2, 2026-09-22): with the
      // goal stage OFF the block points at "the goal paragraph above", which an
      // UNDECIDED session does not get from the loop branch below.
      if (state.taskMode === undefined && !deps.stageIsOn("goal")) {
        systemPrompt += "\n\n" + buildGoalStageOffDirective();
      }
    }

    if (state.taskMode === "loop") {
      const goalConfirmed = deps.goalStageSatisfied();
      systemPrompt += "\n\n" + deps.loopGoalDirectiveText();
      // 2026-09-17: once the un-goaled turn count hits the threshold, the
      // standing goal directive escalates to the force-negotiate form on EVERY
      // turn. With the goal stage OFF there is nothing to negotiate.
      if (deps.stageIsOn("goal") && !goalConfirmed && goalNegotiationOverdue(state.turnsWithoutGoal)) {
        systemPrompt += "\n\n" + buildGoalForceNegotiateDirective(state.turnsWithoutGoal);
      }
    }

    // The orchestration layer's two prompts, deliberately asymmetric: the
    // ORCHESTRATOR gets the whole contract; a CHILD gets one sentence.
    if (state.taskMode === "orchestrator") {
      systemPrompt += "\n\n" + ORCHESTRATOR_DIRECTIVE;
      // F13 — an orchestrator RETURNS HERE: the loop block below is wrong for
      // a project manager on every clause, and its own contract is the
      // orchestration's.
      systemPrompt += "\n\n" + buildOrchestratorExitBlock(deps.orchestrationDoneProblems());
      return { systemPrompt };
    }
    if (deps.isOrchestrationChild()) {
      systemPrompt += "\n\n" + CHILD_OF_ORCHESTRATOR_DIRECTIVE;
    }

    // LOOP-MODE EVERY-TURN INJECTION (2026-08-30): the situation→tool
    // decision table must be visible from the FIRST turn and also when the
    // gates are all green. TOP-LEVEL ONLY for the scope escalation rule
    // (2026-09-21): a child's `set_gate_mode("orchestrator")` is refused.
    const loopDirectives =
      state.taskMode === "loop"
        ? "\n\n" + MODE_REGISTRY.loop.prompt +
          (deps.isOrchestrationChild() ? "" : "\n\n" + SCOPE_ESCALATION_PROTOCOL)
        : "";
    systemPrompt += loopDirectives;

    // MODE-UNDECIDED early return (2026-08-30): the Review Gate block below is
    // loop-specific. An undecided session that HAS edited still falls through:
    // its `Current unmet:` list is real (reviewer P2, round 3).
    if (state.taskMode === undefined && !gateArmed && problems.length === 0) {
      return { systemPrompt };
    }

    return {
      systemPrompt:
        systemPrompt +
        "\n\n## Review Gate (enforced)\n" +
        "改完就送审：`judge_submit({role:\"reviewer\", task:<本轮改动说明>})` —— 门禁自己跑 " +
        "precommit、提交 checkpoint、算审查范围、派 reviewer，并在它退出时机械记录 verdict。" +
        "被打回就按 findings 修，然后再 judge_submit；READY 了就 `declare_done`（工作留在当前分支，合并/推送由你自己安排）。" +
        "攒一批改动再送审：循环按轮计费，不按行。" +
        "git commit/push 与 gh pr create/edit 在门禁通过前是硬拦截。\n" +
        (cells.sessionRepos.size > 1
          ? "Multi-repo session: this session has edited " + cells.sessionRepos.size + " repositories (" +
            [...cells.sessionRepos].join(", ") +
            "). `judge_submit` REQUIRES an explicit `repo` (absolute path) here — " +
            "a verdict binds to that repo's own worktree and unblocks only that repo, so run the " +
            "loop once per repo; " +
            "declare_done and git commit/push/gh pr require EVERY edited repo to pass its own review + precommit " +
            "before shipping.\n"
          : "") +
        "You are ENCOURAGED to proactively consult the `adviser` judge child (a stronger, " +
        "independent second opinion, pinned to a top-tier model at max thinking) BEFORE " +
        "and DURING non-trivial, ambiguous, or risky work \u2014 consulting early is cheaper " +
        "than a failed review later. The `reviewer` (also a top-tier model at max) is the " +
        "independent gatekeeper that emits the recorded verdict.\n" +
        "Prohibited while gates are unmet (sd0x-dev-flow auto-loop rules): claiming a fix " +
        "is done without re-reviewing; asking for permission to continue the loop; citing " +
        "context length or token budget as a reason to skip review; outputting a polished " +
        "completion-style summary. Brief status lines are fine; execute the next step.\n" +
        "Anything that needs the user — an ambiguous requirement, a product decision, scope, " +
        "missing access — goes through `ask_user`: it asks them (options + your recommendation) " +
        "and pauses the loop until they answer. Never write the question into your reply and end " +
        "the turn; that costs an iteration and may not read as a question at all. Ship commands " +
        "stay blocked either way, and asking permission to continue routine loop work is not a " +
        "use for it.\n" +
        (state.pausedQuestion
          ? `Loop currently PAUSED awaiting the user's answer to: "${state.pausedQuestion.question.slice(0, 200)}". ` +
            "If the user has replied, continue the loop; otherwise end the turn after asking " +
            "(the one exception to 'no turn ends before declare_done': you are waiting for a HUMAN).\n"
          : "") +
        (state.scopeLimit
          ? "SCOPE LIMIT (user-approved): the gate covers ONLY this session's own edits" +
            (state.scopeLimit.sessionFiles.length
              ? ` (${state.scopeLimit.sessionFiles.slice(0, 30).join(", ")})`
              : "") +
            ". Pre-existing changes are exempt — instruct the reviewer to verdict only on in-scope findings; out-of-scope issues are advisory.\n"
          : gateArmed && !cells.sessionEdited
            ? "NOTE: the tracked changes PRE-DATE this session (this session has not edited anything yet). " +
              "If the unmet gates below are demanding coverage of work you never did, call request_scope_limit — " +
              "the USER decides whether session-only coverage suffices.\n"
            : "") +
        // Scope for the NEXT review round — only while a review is outstanding.
        (problems.length && state.review.verdict !== "READY"
          ? `\n${formatReviewScopeDirective(deps.reviewScopeFor(cells.primaryRepoRoot, state), deps.previousRoundFindings(state), deps.settledConclusion(state))}\n`
          : "") +
        // The fast lane clears a commit but not a push/PR — say it while the
        // lane still shows.
        (problems.length === 0 && state.precommit.verdict === "PASS" && state.precommit.testScope !== "full"
          ? `\nNOTE: the recorded precommit is the FAST lane (tests: ${state.precommit.testScope ?? "unknown"}). ` +
            "That satisfies `git commit`; `git push`, `gh pr create/edit` and declare_done additionally " +
            'require one run with mode "full".\n'
          : "") +
        (problems.length
          ? `Current unmet:\n${problems.map((p) => `- ${p}`).join("\n")}`
          : isEnforcedMode(state.taskMode)
            ? "All gates satisfied — 收尾：跑一次 `declare_done`（门禁合并分支）；若已建 PR，还有 `copilot_review` 周期待收。"
            : "All gates satisfied — you may ship."),
    };
  }

  return { onBeforeAgentStart };
}

/**
 * One-way stale-state reconciliation at every turn boundary: git-clean can
 * clear flags, only edits set them. Also the heartbeat — `turn_end` fires
 * whether or not this session has edits, so it proves the extension is alive.
 */
export function createTurnEndHook(
  cells: SessionCells,
  deps: {
    noteChildProgress(): void;
    reportChildState(ctx: ExtensionContext): void;
    persist(ctx?: ExtensionContext): void;
    persistRepo(ctx: ExtensionContext, root: string): void;
  },
) {
  return function onTurnEnd(ctx: ExtensionContext): void {
    deps.noteChildProgress(); // E — a turn boundary is forward progress (the timer heartbeat is not).
    deps.reportChildState(ctx);

    // …AND EVERY OTHER REPO THIS SESSION WORKED IN (quality round 2 P2): a
    // secondary repo had NO reconciliation path at all. Same functions,
    // clear-only, and only repos with a state ALREADY created this session.
    for (const root of cells.sessionRepos) {
      if (root === cells.primaryRepoRoot) continue;
      const st = cells.repoStateCache.get(root);
      if (st === undefined || (!st.hasCodeChange && !st.hasDocChange)) continue;
      const repoFiles = changedFiles(root);
      if (repoFiles === undefined) continue;
      const repoCurrent = { hasCodeChange: st.hasCodeChange, hasDocChange: st.hasDocChange };
      if (!couldReconcile(repoCurrent, repoFiles)) continue;
      const repoNext = reconcileArming(repoCurrent, {
        files: repoFiles,
        commitsAhead: commitsAheadOfBase(root),
      });
      if (!repoNext.changed) continue;
      st.hasCodeChange = repoNext.hasCodeChange;
      st.hasDocChange = repoNext.hasDocChange;
      deps.persistRepo(ctx, root);
    }

    const state = cells.state;
    if (!state.hasCodeChange && !state.hasDocChange) return;
    const allFiles = changedFiles(cells.cwd);
    if (allFiles === undefined) return;
    // User-granted scope limit: files still in the exempt snapshot never count
    // toward the armed/clean reconciliation, and branch-commit arming stays
    // suspended while the grant stands.
    const exempt = new Set(state.scopeLimit?.preexistingFiles ?? []);
    const files = state.scopeLimit ? allFiles.filter((f) => !exempt.has(f)) : allFiles;
    // ASK THE SAME QUESTION ARMING ASKS (drill F1, 2026-09-19) — and it is the
    // SAME code (`lib/gate-arming.ts`). The git call is paid only when a flag
    // could actually be cleared.
    const current = { hasCodeChange: state.hasCodeChange, hasDocChange: state.hasDocChange };
    if (!couldReconcile(current, files)) return;
    const next = reconcileArming(current, {
      files,
      commitsAhead: state.scopeLimit ? 0 : commitsAheadOfBase(cells.cwd),
    });
    if (!next.changed) return;
    state.hasCodeChange = next.hasCodeChange;
    state.hasDocChange = next.hasDocChange;
    deps.persist(ctx);
  };
}

/**
 * THE THINKING-LOOP GUARD's wiring — a reasoning model can spin (a turn emits
 * ONLY thinking deltas, deepseek-ai/deepseek-harness#5976). The decision lives
 * in lib/thinking-loop-guard.ts and the state machine in
 * lib/thinking-loop-controller.ts; this wires it for EVERY session on EVERY
 * reasoning model.
 *
 * The model-facing notice is DEFERRED to the settle handler: Pi drains its
 * steering queue from inside a RUNNING agent loop, and `abort()` is exactly
 * what stops that loop — sending once the session is idle again is the only
 * ordering that guarantees the model reads it.
 */
export function registerThinkingLoopGuard(
  pi: Pick<ExtensionAPI, "on" | "sendUserMessage" | "registerMarkdownTransformer">,
  cells: SessionCells,
): () => void {
  let thinkingLoopInjection: string | undefined;
  // `ctx` is stashed rather than captured: the effects fire from a stream
  // callback, and the latest per-event context is the live one.
  let thinkingLoopCtx: ExtensionContext | undefined;
  const thinkingLoop = createThinkingLoopController({
    abort: () => { try { thinkingLoopCtx?.abort(); } catch { /* session gone */ } },
    notify: (message) => { try { thinkingLoopCtx?.ui.notify(message, "warning"); } catch { /* no UI (print mode) */ } },
    inject: (text) => { thinkingLoopInjection = text; },
  });

  pi.on("agent_settled", (_event, ctx) => {
    const text = thinkingLoopInjection;
    if (!text) return;
    thinkingLoopInjection = undefined;
    thinkingLoopCtx = ctx;
    // `abort()` leaves the run's last message "aborted", which the ESC
    // detection reads as "the USER stopped me". This abort was OURS and we
    // are about to hand the session a new turn, so that reading is wrong here.
    cells.lastRunAborted = false;
    try {
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: "steer" });
    } catch { /* the session cannot accept messages right now */ }
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    thinkingLoopCtx = ctx;
    thinkingLoop.startTurn();
  });

  pi.on("message_update", (event, ctx) => {
    thinkingLoopCtx = ctx;
    const chunk = event.assistantMessageEvent;
    if (chunk.type === "thinking_delta") thinkingLoop.observe("thinking", chunk.delta);
    else if (chunk.type === "text_delta") thinkingLoop.observe("text", chunk.delta);
    else if (chunk.type === "toolcall_delta") thinkingLoop.observe("toolcall", chunk.delta);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    thinkingLoopCtx = ctx;
    thinkingLoop.endTurn();
  });

  // The display half, registered by the caller where it always was (after the
  // background-wait message hook).
  return () => {
    pi.registerMarkdownTransformer((markdown, context) =>
      thinkingLoop.truncateDisplay(markdown, context.messageType),
    );
  };
}
