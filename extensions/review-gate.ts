/**
 * pi-review-gate — quality gates for Pi.
 *
 * Enforcement layers:
 *   L1 Ship gate (HARD)  — tool_call blocks git commit/push & gh pr create/edit
 *                          until review READY + precommit PASS, both bound to
 *                          the current worktree fingerprint.
 *   L2 Auto-continuation — agent_settled re-triggers the loop when gates are
 *                          unmet (recursion-guarded, max_rounds, plateau stop).
 *   L3 Git hooks         — scripts/install-git-hooks.sh installs pre-commit /
 *                          pre-push verification that works even outside Pi.
 *   L4 Output-language   — before_agent_start unconditionally injects the
 *                          strict Simplified-Chinese LANGUAGE_DIRECTIVE every
 *                          turn (thinking in Chinese too); protocol English
 *                          tokens (verdict enum, commit msgs, code) exempt.
 *   L5 Commit/PR English — HARD: tool_call blocks a git commit message or
 *                          PR title/body that is predominantly non-English
 *                          (majority-body policy; escape hatch named in the
 *                          reason); the per-turn LANGUAGE_DIRECTIVE instructs
 *                          the agent to write ship text in English and the
 *                          reviewer checks it during review too.
 *   L6 Test-label English — pre-commit (scripts/scan-test-labels.cjs) blocks a
 *                          staged it/test/describe label written in a non-Latin
 *                          script, unless a `// review-gate: allow-non-english`
 *                          (line) or `-file` marker exempts it.
 *
 * Design principles (from real-world harness engineering):
 *   1 glob trap        → precommit runner warns on `node --test **` scripts
 *   2 fail-open parse  → no verdict text to parse; a judge's structured
 *                        conclusion rides its channel report, and a READY
 *                        carrying an open P0/P1 is recorded as BLOCKED
 *   3 NO_CHECKS_RUN    → distinct precommit verdict; never treated as pass
 *   4 NotebookEdit     → coalesceToolPath reads every path param spelling
 *   5 extension drift  → ONE CODE_EXTENSIONS list; structural test enforces it
 *   6 formatter safety → no formatter is run at all
 *   7 compaction       → state persisted via appendEntry + sidecar; re-injected
 *                        into context after session_compact and on resume
 *   8 word boundaries  → commit-msg patterns \b-bound only bare AI
 *
 * sd0x-dev-flow ports beyond PR #7 (see README "-dev-flow features ported"):
 *   R6  per-project maxRounds via .pi/review-gate.json (clamped 3..50)
 *   R9  [GIT_CONTEXT] git memory after compaction (filtered, capped; default on)
 *   R10 one-shot [STRATEGIC_RESET] think-harder checklist near the round cap
 *   —   auto-loop prohibited behaviors in the per-turn reminder
 *   —   .git/ internals in SENSITIVE_FILE_PATTERNS (pre-edit-guard port)
 *   —   /gate-lesson self-improvement log (.pi/review-gate-lessons.md)
 */

import {
  existsSync, statSync, readFileSync, writeFileSync,
  mkdirSync, readdirSync, writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join as pathJoin, dirname as pathDirname, resolve as pathResolve, basename as pathBasename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  coalesceToolPath,
  DEFAULT_MAX_ROUNDS,
  isCodeFile,
  isDocFile,
  isSensitiveFile,
  COMMIT_MSG_FORBIDDEN,
  LANGUAGE_DIRECTIVE,
  STRATEGIC_RESET_OFFSET,
  STRATEGIC_RESET_CHECKLIST,
  TASK_TEXT_MARKER,
} from "../lib/constants.ts";
import {
  ROUND_NOTE_HINT,
  SCOPE_ESCALATION_PROTOCOL,
  SETTLED_TOOL_REMINDER,
  WAIT_DISCIPLINE_HINT,
} from "../lib/agent-directives.ts";

import { MODE_REGISTRY, resolveGateMode } from "../lib/gate-modes.ts";
import { armingFromFacts, couldReconcile, reconcileArming } from "../lib/gate-arming.ts";
import { planCheckpointSweep } from "../lib/checkpoint-sweep.ts";
import { defaultProjectConfig, globalConfigPath, loadProjectConfig, type ProjectConfig } from "../lib/project-config.ts";
import { buildGitMemory } from "../lib/git-memory.ts";
import { detectShipCommands, observedShipKinds } from "../lib/ship-detect.ts";


import {
  gitRootOfDir,
  resolveCommandRepos,
  resolveToolRepoTarget,
} from "../lib/repo-resolve.ts";
import { classifyEditRepoScope } from "../lib/edit-repo-scope.ts";
import { isSensitiveOutsideRepoPath } from "../lib/out-of-repo-paths.ts";
import {
  nonEnglishCommitMessage,
  l5BlockReason,
} from "../lib/lang-detect.ts";
import {
  APPEAL_HINT,
  appealDigest,
  appealPassAuthorizes,
  consumeAppealPass,
  emptyAppealRecord,
  type AppealKind,
  type AppealableBlock,
} from "../lib/text-appeal.ts";
import {
  emptyInspection,
  observeInspection,
  parseReviewRange,
  parseReviewScopeKind,
  type InspectionEvidence,
} from "../lib/judge-inspection.ts";
import {
  type InspectionBlock,
  type InspectionPass,
} from "../lib/inspection-appeal.ts";
import {
  judgeSessionIdFor,
  shortRepoHash,
} from "../lib/judge-process.ts";
import {
  judgeWorkDirFor,
} from "../lib/judge-lifecycle.ts";
import {
  createProgressReporter,
  type ToolUpdate,
} from "../lib/progress-stream.ts";
// The interview's pure functions are no longer reached from here: `ask_user`
// lives in lib/user-interaction-tools.ts and imports them itself.
import { registerUserInteractionTools } from "../lib/user-interaction-tools.ts";
// The COMMAND layer moved out the same way: every slash command lives in
// lib/gate-command-tools.ts (+ lib/gate-diagnosis-commands.ts) and is wired
// from here with one call.
import { registerGateCommands } from "../lib/gate-command-tools.ts";

import { isProtectedBranch } from "../lib/workspace-branch.ts";
// ---- the SUPERVISION CHANNEL (both sides). A child reports on it and reads
// its instructions from it; an orchestrator reads it and writes answers. It
// replaced the global attention queue, the screen scraping and send-keys.
import {
  instructText,
  nodeChannelIO,
  type ChannelIO,
} from "../lib/channel-io.ts";
import {
  isStalled,
  type ReportConclusion,
} from "../lib/channel-projection.ts";
import { describeToolActivity, reportState } from "../lib/orchestrator-child-channel.ts";
import { judgeChildRecordOf, judgeLive, removeJudge, tmuxServerFrom, windowClosable, type HierarchyTable } from "../lib/hierarchy.ts";
import {
  judgeRemembersPreviousRound,
} from "../lib/judge-rotation.ts";
import {
  JUDGE_ID_ENV,
  JUDGE_OPENER_ENV,
  JUDGE_ROLE_ENV,
  judgePaneAlive,
} from "../lib/judge-pane.ts";
import {
  buildJudgeRecoverCommand,
  closeSessionPane,
  closeSessionWindow,
  openSessionWindow,
} from "../lib/session-factory.ts";
// MY OWN TMUX SESSION (2026-09-25): the name, the lazy creation, the ownership
// record and the one session `declare_done` closes.
import {
  addressableSessions,
  closeOwnSession,
  createOwnershipProbe,
  sanitizeScopeRecord,
  type TmuxScope,
} from "../lib/session-tmux-scope.ts";
import {
  readJudgeSideEnv,
  JUDGE_TASK_ENV,
  JUDGE_STREAM_ENV,
} from "../lib/judge-side.ts";
import { claimsMainSidecar, gateStateWriteSkip } from "../lib/session-exclusivity.ts";
import { registerJudgeConcludeTool } from "../lib/judge-conclude.ts";
import { runTmux as rawTmux } from "../lib/orchestrator-wiring.ts";
import { sideEffectsEnabled } from "../lib/side-effects.ts";
import {
  describeNotifyOutcome,
  mayNotifyUser,
  type UserNotifyKind,
  type UserNotifyOutcome,
} from "../lib/user-notify.ts";
import { createUserNotifyRuntime } from "../lib/user-notify-runtime.ts";
// WORKER PANES (2026-09-21): the tmux-pane replacement for the pi-subagents
// `Agent` tool. Four tools on the agent surface, one on the worker surface,
// and the pane factory they both go through.
import { registerWorkerTools } from "../lib/worker-tools.ts";
import { readWorkerSideEnv, registerWorkerReportTool } from "../lib/worker-side.ts";
import {
  parseWorkerRegistry,
  serializeWorkerRegistry,
  workerSessionDirName,
  WORKER_REGISTRY_RELPATH,
  WORKER_SESSION_ROOT,
} from "../lib/worker-pane.ts";
import type { ToolHost } from "../lib/tool-host.ts";
// ---- orchestration layer (project-manager role). Everything but these few
// wires lives in lib/orchestrator-*.ts, deliberately: this file is the
// repository's own worst example of the architecture rule this round adds.
import { orchestrationIdFromEnv, ORCHESTRATION_ID_ENV, startupOrchestrationId, storedRuntimeIsMine } from "../lib/orchestration-id.ts";
import { orchestratorDoneProblems } from "../lib/orchestrator-gate.ts";
import {
  ORCHESTRATOR_DIRECTIVE,
  CHILD_OF_ORCHESTRATOR_DIRECTIVE,
  ORCHESTRATOR_NEEDS_TMUX,
  buildOrchestratorExitBlock,
} from "../lib/orchestrator-directives.ts";
import { createOrchestratorDeps, readPlanFile } from "../lib/orchestrator-wiring.ts";
import { formatPlanSummary } from "../lib/orchestrator-plan.ts";
import {
  contextPercentOf,
  handoffAccepted,
  handoffDocFilled,
  handoffDue,
  handoffReminder,
  HANDOFF_PERCENT,
  type HandoffSessionKind,
} from "../lib/session-handoff.ts";
import {
  ensureHandoffDoc,
  handoffDocPath,
  handoffExtraEnvFor,
  registerContextStatusTool,
  registerSessionHandoffTool,
  successorOpeningMessage,
  type SessionHandoffDeps,
} from "../lib/session-handoff-tools.ts";
// THE NAME A SESSION CAN BE FOUND BY (2026-09-25, t2): the tool, its registry,
// the heartbeat that renews it, the sweep that reclaims what dead sessions left
// behind, and the release `declare_done` / process exit owe. Everything but the
// wiring lives in these two modules.
import { createSessionNaming, liveSessionNames } from "../lib/session-name-tools.ts";
// WHAT A NAME IS FOR (2026-09-25, t3): the message one session sends another by
// name. The sender's judgement and the recipient's inbox consumption live in
// `lib/session-message-tools.ts`; here is only the two lines of wiring — the
// tool, and the poll that rides the name's own heartbeat below.
import { createSessionMessaging, nodeInboxIO } from "../lib/session-message-tools.ts";
import { nodeRegistryIO, pidAlive, sessionRegistryRoot } from "../lib/session-registry.ts";
import {
  buildPlanAuditTask,
  formatPlanAuditCarryover,
  planAuditHash,
} from "../lib/orchestrator-plan-audit.ts";
import { composeWithUntrustedData } from "../lib/untrusted-data.ts";
import { settleAuditRound } from "../lib/audit-round-settle.ts";


import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";
import {
  registerOrchestratorSessionTools,
  type OrchestratorSessionDeps,
} from "../lib/orchestrator-session-tools.ts";


// The waiting skeleton's second interrupt source: a real user message ends a
// long block (orchestrator_wait / judge_wait) instead of being queued behind it.
import { notifyUserInput } from "../lib/poll-wait.ts";

import { formatInheritanceBrief, handoffGeneration, isHandoffSuccessorOf, readInheritance, stateOwnership, successorEnv, successorSessionId } from "../lib/session-inheritance.ts";
import {
  childWorktreeBranch,
  childWorktreePath,
  createWorktreeArgv,
  looksLikeAlreadyGone,
  looksLikeMergeConflict,
  planSettlement,
  repoRootOfWorktree,
} from "../lib/orchestrator-worktree.ts";
import { addGrant, emptyRuntime, findChild, hasGrant, noteWorktreeBranch, removeGrant, successorRuntime, type OrchestratorRuntime } from "../lib/orchestrator-registry.ts";
import { fileSizeVerdict, formatFileSizeVerdict, isSizeJudgedFile } from "../lib/file-size-gate.ts";
import { firstBaseContaining, isNewInWorktree, readChangeBaseRefs } from "../lib/change-baseline.ts";
import { STATION_CAP_ENV } from "../lib/repo-pr-policy.ts";
import { seedWorktree } from "../lib/worktree-seed.ts";
import { dependencyJustificationVerdict, formatDependencyJustificationVerdict, newDependencyNames } from "../lib/dependency-justification.ts";
import { buildRejection } from "../lib/rejection-copy.ts";
import { classifyChildren, buildChildWaitNotice, type ChildSnapshot } from "../lib/child-watch.ts";
// (A round's conclusion is the channel report. The transcript READ died with
// judge_read, and the module behind it was deleted 2026-09-06.)

// The judge tools that observe/end a session (judge_close / judge_wait) are
// registered from lib/, like the orchestration tools: this file keeps only
// what it alone owns and hands the rest over as deps.

import {
  registerJudgeSessionTools,
  registerJudgeWaitTool,
  type JudgeSessionToolDeps,
} from "../lib/judge-session-tools.ts";
import { doWait } from "../lib/judge-wait-tool.ts";

import { registerJudgeSpawnTools } from "../lib/judge-spawn-tools.ts";
import { AUDIT_SELF_WAIT_BUDGET_MS, awaitRoundReport } from "../lib/judge-lifecycle.ts";

// The judge tools that RELAY to a session (review_spawn / review_watch /
// review_send) are the other half of the same family, and are registered the
// same way — the dispatch owner and the child registry reach them as deps.
//
// THE TEN ADVANCED ENTRIES ARE GONE (2026-08-30, philosophy three). There are
// no longer tools named `review_spawn` / `review_watch` / `review_send`,
// `prepare_review` / `prepare_adviser` / `prepare_goal_audit`,
// `run_precommit` / `review_checkpoint`, `record_review` /
// `record_goal_prereview`. Every one of them was a SECOND path to something
// `judge_submit` (or `propose_loop_goal`) already does end to end, and the
// cost of a second path is not redundancy — it is an agent stopping to decide
// which one applies, every single round.
//
// FIVE of them are still IMPLEMENTATIONS, registered into `internalHost`
// instead of into `pi`: the chain calls them so the mechanical checks live in
// exactly one place, and no model can see the names. Three
// (`review_spawn` / `review_watch` / `review_send`) were deleted outright,
// module included. The last two — the RECORDERS — are plain functions on no
// host at all (2026-09-04): `recordReviewVerdict` here and
// `recordGoalPrereview` in lib/goal-prereview-tools.ts. Their tool shape
// existed only to carry text that had to be parsed back into a verdict, and a
// conclusion arrives structured now.
import { registerReviewPrepareTools } from "../lib/review-prepare-tools.ts";
import { squashPointBaseline, branchBaseBaseline } from "../lib/review-baseline.ts";
import { registerAdvisoryPrepareTools } from "../lib/advisory-prepare-tools.ts";

// The L7 Copilot tools moved the same way: this file wires them, the module
// owns their bodies (and lib/copilot-gh.ts the `gh` calls they make).
import { registerCopilotReviewTools } from "../lib/copilot-review-tools.ts";
// The L8 goal family (the agent-facing `propose_loop_goal` and the audit
// recorder behind it) moved the same way: this file wires them, the
// module owns their bodies (and lib/goal-prereview-tools.ts the audit record).
import { registerGoalTools } from "../lib/goal-tools.ts";
import { registerRestatementTools } from "../lib/restatement.ts";
// THE FIVE STAGE SWITCHES (2026-09-22): the rule, the record, the dialog and
// the tool live in ONE module; this file only reads `stageOpen` at the five
// checkpoints and wires the deps the module needs.
import {
  buildStagesDirective,
  ensureLoopStages,
  registerLoopStageTools,
  stageOpen,
  stagesOffered,
  type LoopStage,
  type LoopStagesDeps,
  type LoopStagesRecord,
} from "../lib/loop-stages.ts";
import { recordGoalPrereview, type GoalPrereviewDeps } from "../lib/goal-prereview-tools.ts";
// The L1 tool_call hook moved the same way — it was the single biggest thing
// left in this file. lib/ship-gate-hook.ts owns the dispatch (and the
// judge-role subagent refusal), lib/ship-gate-edit-guard.ts the edit arm and
// lib/ship-gate-bash.ts the ship gate itself; this file keeps the deps.
import {
  evaluateToolCall,
  type BlockedShipRecord,
  type ShipGateHookDeps,
} from "../lib/ship-gate-hook.ts";
import { QUALITY_ROLE } from "../lib/quality-round.ts";
import {
  ACCEPTANCE_GATE_ENV,
  acceptanceRoundInFlight,
  acceptanceStatusLine,
} from "../lib/acceptance-round.ts";
import {
  modelChainFor,
  JUDGE_ROLES,
  SUBMITTABLE_JUDGE_ROLES,
} from "../lib/judge-prompt.ts";
import { runTrustedPrecommit } from "../lib/precommit-runner.ts";
import type { Ref, SessionHost } from "../lib/session-host.ts";
import { createStatusStrip } from "../lib/status-strip.ts";
import { createEditTimeChecks } from "../lib/edit-time-checks.ts";
import { appendAuditLog, createArbitrationHost } from "../lib/arbitration-host.ts";
import { createChildSide } from "../lib/child-side-host.ts";
import { createOrchestratorRuntime } from "../lib/orchestrator-runtime-host.ts";
import { createJudgeRegistry, HIERARCHY_FILENAME } from "../lib/judge-registry-host.ts";
import { createReviewTargets } from "../lib/review-target-host.ts";
import { createJudgeLaunch } from "../lib/judge-launch-host.ts";
import { createPrecommitLane } from "../lib/precommit-lane.ts";
import { createReviewChain } from "../lib/review-chain.ts";
import { createJudgeLanes } from "../lib/judge-lane-host.ts";
import { createJudgeRoundDispatch, hasTranscript } from "../lib/judge-round-dispatch.ts";
import { createJudgeRoundSettle } from "../lib/judge-round-settle.ts";
import { createAuditRoundHost } from "../lib/audit-round-host.ts";
import { createReviewVerdictRecorder } from "../lib/verdict-host.ts";
import { createSiblingVerdictRecorders } from "../lib/sibling-verdict-host.ts";
import { createRoundCancel } from "../lib/round-cancel-host.ts";
import { createAcceptanceHost } from "../lib/acceptance-host.ts";
import { createWorktreePresence } from "../lib/worktree-presence-host.ts";
import { asChoiceHost, createGateDialogs, showToUser } from "../lib/gate-dialogs.ts";
import { createDialogProxy } from "../lib/dialog-proxy.ts";
import {
  commitsAheadOfBase,
  currentBranch,
  digestForMerge,
  hasStagedChanges,
  headCommitTree,
  listedWorktreeBranch,
  samePlace,
  unreviewedTreesSince,
  worktreeTree,
} from "../lib/repo-facts.ts";
import { appendTiming } from "../lib/gate-timings.ts";
// The background lane's failure notice: wording + the "is this still the
// content under the agent's hands" rule, both pure and unit-tested there.
import {
  decideReviewScope,
  type ReviewScopeDecision,
} from "../lib/review-scope.ts";
// The incremental contract's WORDING lives in exactly one module.
import {
  formatReviewScopeDirective,
  type SettledConclusion,
} from "../lib/review-carryover.ts";
import { computeFingerprint, isGateOwnedPath } from "../lib/fingerprint.ts";
import { advisoryChangeToken, changedFiles, incrementSinceTree } from "../lib/worktree-changes.ts";
import type { Fingerprint } from "../lib/fingerprint.ts";
import { gitBaseEnv, gitOrNull, gitRaw, gitText } from "../lib/git-exec.ts";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import { readJsonIfExists } from "../lib/json-file.ts";
import {
  emptyState,
  type GateState,
} from "../lib/gate-state.ts";
import {
  shouldStrategicReset,
  unmetRequirements,
} from "../lib/gate-state-requirements.ts";
import {
  saveSidecarPreservingConcurrent,
  sidecarPath,
  stateVariantFrom,
  STATE_VARIANT_ENV,
} from "../lib/gate-state-io.ts";
import {
  loadSidecar,
  migrateFingerprintVersion,
  FINGERPRINT_MIGRATION_NOTICE,
} from "../lib/gate-state-load.ts";
import {
  invalidateBindings,
  inheritGoalContract,
} from "../lib/gate-state-transitions.ts";
import {
  type ScopeStampRecord,
} from "../lib/gate-state-records.ts";
import { parsePrecommitOutput } from "../lib/precommit-parse.ts";
import { sessionDirForCwd, sessionDirFromContext } from "../lib/session-dir.ts";
import {
  evaluateModeChange,
  buildModeConfirmMessage,
  normalizeTaskMode,
  isEnforcedMode,
  requestedModeFromEnv,
  GATE_MODE_DECISION_DIRECTIVE,
  MODE_CONFIRM_TITLE,
  type TaskMode,
  type TaskModeSource,
} from "../lib/task-mode.ts";
import {
  createLlmClassifier,
  type LlmClassifier,
} from "../lib/llm-classify.ts";
import {
  BASH_WRITE_NUDGE,
  EDIT_DISCIPLINE_DIRECTIVE,
  EDIT_FAILURE_NUDGE,
  looksLikeBashFileWrite,
} from "../lib/edit-discipline.ts";
import { FULL_LANE_NUDGE, looksLikeFullLaneRun } from "../lib/test-run-discipline.ts";
import { createThinkingLoopController } from "../lib/thinking-loop-controller.ts";
import {
  evaluateReadonlyStall,
  readonlyStallNudgeFor,
  type ReadonlyStallState,
} from "../lib/readonly-stall.ts";
import {
  LOOP_GOAL_RELPATH,
  loopGoalRelPath,

  isLoopGoalConfirmed,
  readLoopGoal,
  // buildGoalAuditTask moved with prepare_goal_audit (lib/advisory-prepare-tools.ts);
  // the goal family's own text builders (transcript/confirm/refusal messages,
  // the length cap, the carryover) moved with it into lib/goal-tools.ts +
  // lib/goal-prereview-tools.ts.
  LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK,
  loopGoalUnconfirmedEditBlock,
  loopGoalEditGate,
} from "../lib/loop-goal.ts";
import {
  buildLoopGoalDirective,
  buildGoalStageOffDirective,
  goalReminderDue,
  GOAL_FORCE_NEGOTIATE_TURN_THRESHOLD,
  buildGoalForceNegotiateDirective,
  goalNegotiationOverdue,
} from "../lib/loop-goal-directives.ts";
import type { LoopGoal } from "../lib/loop-goal.ts";
// The delivery station (where THIS round stops) is a pure contract module;
// the extension only supplies the facts (which goal / plan the user approved,
// which repos are dirty) and lets it decide.
import {
  DEFAULT_DELIVERY_STATION,
  STATION_SHIP_NEXT_STEPS,
  parseDeliveryStation,
  prEvidencePresent,
  stationArrivalProblems,

  type DeliveryStation,
} from "../lib/delivery-station.ts";
// …and the FACTS that arrival is judged on when no local evidence can answer
// (2026-09-16): the gate asks GitHub itself instead of waiting for a
// `gh pr create` exit 0 that an already-open PR makes impossible.
import { existingPrNotice, hasUnpushedCommits, probeOpenPr, type OpenPrArrival } from "../lib/station-pr-evidence.ts";


import {
  choiceRows,
  parseChoice,
  type ChoiceSpec,
  type ChoiceUi,
} from "../lib/choice-dialog.ts";
// The model-chain diagnosis and the /gate-doctor checks are reached only
// through lib/gate-diagnosis-commands.ts now — this file wires that module,
// it no longer runs either diagnosis itself.
import {
  buildStallNotice,
  classifyStallCause,
  evaluateStall,
  negotiationFingerprint,
  progressSignature,
  stallInMotion,
  STALL_MOTION_MAX_AGE_SEC,
  STALL_REPEAT_LIMIT,
  type StallState,
} from "../lib/loop-stall.ts";
import {
  applyAgentConfigLayer,
  KNOWN_AGENTS,
  resolvePackageAgentsDir,
  ensureAgentFilesPresent,
} from "../lib/model-config.ts";
import {
  loadRegistry,
  validateSpec,
  KNOWN_THINKING_LEVELS,
  parseModelSpec,
} from "../lib/model-spec.ts";
import { startupAgentsCheck } from "../lib/agents-startup.ts";
import { effectiveAgentsConfig } from "../lib/agents-config.ts";
import {
  projectAgentIdentity,
  frontmatterBlock,
} from "../lib/agent-frontmatter.ts";
import type { ModelRegistry, RegistryModelInfo } from "../lib/model-spec.ts";
import { createModelRotation } from "../lib/judge-model-rotation.ts";
// The model allowlist is consulted by the diagnosis module, not here.
// The baseline resolution moved with prepare_review (lib/review-prepare-tools.ts).
// The Copilot TOOLS and the `gh` access they run on moved out of this file
// (lib/copilot-review-tools.ts + lib/copilot-gh.ts); what is left here is the
// arming site and the completion-only problem list.
import { armCopilotReview, copilotProblems } from "../lib/copilot-review-state.ts";
import { parsePrView } from "../lib/copilot-probe-parse.ts";
import {
  fetchCopilotPayload,
  fetchCopilotProbe,
  fetchCopilotTimeline,
  requestCopilotReviewer,
  resolveCopilotSupport,
  resolveOpenPr,
  resolveRepoSlug,
} from "../lib/copilot-gh.ts";
// The TTL and the grant WRITE moved out with request_sensitive_edit; what is
// left here is the READ side — the edit guard and the grant it consumes.
import {
  consumeGrant,
  normalizeSensitivePath,
  type SensitiveGrant,
} from "../lib/sensitive-grant.ts";
import {
  blockedMarkerPath,
  recordBlockedMarker,
  reconcileBlockedMarker,
} from "../lib/blocked-marker.ts";
// The workflow-command catalog is read by lib/gate-command-tools.ts, which
// registers every command in it.
import {
  formatPrecommitBaseline,
  REVIEW_VERDICT_SCHEMA,
} from "../lib/parallel-review.ts";
import {
  parseArbitrableAction,
  buildArbiterPrompt,
  runArbiter,
  BYPASS_TOKEN_TTL_MS,
  type BypassToken,
} from "../lib/arbitration.ts";
// THE PROXY HALF OF EVERY DIALOG (2026-09-19): the race lives in
// lib/user-proxy.ts, its I/O in lib/dialog-proxy.ts, and the one place all
// twelve dialogs are rendered is lib/gate-dialogs.ts.
import {
  formatProxyDecisionReport,
  sessionProxyDecisions,
} from "../lib/user-proxy.ts";

// TASK_TEXT_MARKER now lives in lib/constants.ts: the two prepare modules
// WRITE it and `extractTaskText` below READS it, so one definition serves all
// three instead of a literal per file.

/**
 * This process's sidecar variant (F4), resolved ONCE from the environment.
 *
 * A session an orchestrator spawned carries `RG_STATE_VARIANT`, so it reads
 * and writes its OWN `.pi/review-gate-state.<variant>.json` instead of
 * sharing one file with the supervising orchestrator (whose `taskMode`,
 * `askUser` record and unmet-gate list would otherwise overwrite each
 * other's). See lib/gate-state.ts for why the CHILD moves rather than the
 * orchestrator.
 */
const SESSION_STATE_VARIANT = stateVariantFrom(process.env);

/** The sidecar this process owns, for any repo it touches. */
function sessionSidecarPath(root: string): string {
  return sidecarPath(root, ".pi", SESSION_STATE_VARIANT);
}

/**
 * The LOOP GOAL this process owns, for any repo it touches (R-10).
 *
 * Same variant as the sidecar, for the same measured reason: an orchestration
 * child shares the supervisor's worktree, so without this two serial children
 * write their approved goals into ONE file and the second overwrites the
 * first — while the reviewer verifies against that file.
 */
function loopGoalPathIn(root: string): string {
  return pathJoin(root, loopGoalRelPath(SESSION_STATE_VARIANT));
}

/** Read THIS session's goal (never another session's copy). */
function readSessionLoopGoal(root: string): LoopGoal {
  return readLoopGoal(root, Date.now(), SESSION_STATE_VARIANT);
}



const ENTRY_TYPE = "review-gate-state";
/**
 * Session-entry type for the audit record a judge leaves when it declines to
 * write the repo's gate state. Distinct from ENTRY_TYPE on purpose: it is not
 * gate state, it is the note saying none was written.
 */
const GATE_STATE_SKIP_ENTRY = "review-gate-persist-skipped";

// 2026-08-31 (P0, onchain deadlock investigation): `replace` / `insert` are
// pi's hashline edit tools and were MISSING here — a session could edit files
// through them while every edit gate (L8 goal gate, sensitive-file floor,
// orchestrator write restriction, edit tracking) was silently skipped.
// Orchestration children use replace/insert, which is exactly how a child
// bypassed the loop-goal requirement and edited straight away.
const EDIT_TOOL_NAMES = new Set(["edit", "write", "Edit", "Write", "NotebookEdit", "notebook_edit", "replace", "insert"]);

// D (2026-09-01): read-only tools whose results carry the goal-negotiation
// reminder while this session is loop-mode and its goal is unapproved.
// `bash` is deliberately excluded: a read-only bash command (ls, git log)
// must not be nagged — the reminder targets the agent's passive reading,
// not shell diagnostics. Includes pi's file-reading tools and the MCP-style
// read/grep family.
const READ_ONLY_TOOL_NAMES = new Set([
  "read", "read_file", "Read", "read_more",
  "grep", "anchor_grep", "rg",
  "ls", "cat", "head", "tail",
]);

/** D — one-line advisory appended to read-only results while the session is
 * loop-mode and its loop goal is not yet confirmed. Not a block: the L8 edit
 * gate is the enforcement, this text just keeps the negotiation in front of
 * an agent that is busy reading. */
const GOAL_REMINDER_TEXT =
  "\n[review-gate] 你还没协商并获批本会话的 loop goal —— 顺序是先用 `propose_restatement` " +
  "把需求反述给用户确认（没有它 `propose_loop_goal` 会直接被拒、不弹框），再 `propose_loop_goal` " +
  "走完协商，然后才改代码（未批准前 L8 会拦下 edit/write）。";



/**
 * Read the PROJECT-layer agent file that actually shadows `name` at runtime:
 * pi-subagents loads every `.md` under <repo>/.pi/agents and registers it
 * under its frontmatter `name`, so a custom-named file (e.g. custom.md with
 * `name: reviewer`) DOES override the global reviewer — the widget and
 * /gate-status must find it by IDENTITY, not by basename (round-11 P2).
 *
 * LAST match wins, like everyone else who resolves this: pi-subagents builds
 * `projectMap.set(agent.name, agent)` (agents.ts:1885) and gate-doctor fills
 * `projectByIdentity` with the same overwriting Map. Returning the FIRST match
 * meant that with two project files claiming one `name`, the widget could show
 * a file the runtime does not actually deploy.
 */
function findProjectAgentText(projectAgentsDir: string, name: string): string | undefined {
  let found: string | undefined;
  try {
    for (const f of readdirSync(projectAgentsDir)) {
      if (!f.endsWith(".md")) continue;
      let text: string | undefined;
      try {
        text = readFileSync(pathJoin(projectAgentsDir, f), "utf8");
      } catch { continue; }
      if (projectAgentIdentity(text) === name) found = text;
    }
  } catch { /* dir missing/unreadable — no project layer */ }
  return found;
}

/**
 * THE ONE PROCESS-EXIT HANDLER FOR THIS SESSION'S NAME (t2; quality round 2 P2).
 *
 * Registered at MODULE scope and pointed at the CURRENT session's runtime. pi
 * rebuilds the extension runner on every `/new`, `/resume`, `/fork` and
 * `/reload` — each of which re-runs the factory below — so a `process.on("exit")`
 * registered inside it would accumulate one listener per session (Node warns at
 * eleven) and every stale instance would run its own release at exit. One
 * listener per PROCESS, re-pointed by the factory, is the whole fix.
 */
let sessionNamingAtExit: { release(): unknown } | undefined;
process.on("exit", () => {
  try { sessionNamingAtExit?.release(); } catch { /* the process is already going */ }
});

export default function reviewGate(pi: ExtensionAPI) {
  /**
   * Every tool's own `execute`, captured as it is registered.
   *
   * `judge_submit` runs the submission chain (precommit → checkpoint →
   * prepare → dispatch) by CALLING those tools, not by re-implementing them:
   * one implementation, one set of mechanical checks, no second copy to drift.
   * The tools stay registered as advanced entries.
   */
  type ToolExecute = (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content?: { type: string; text: string }[]; details?: Record<string, unknown>; isError?: boolean }>;
  const toolExecutes = new Map<string, ToolExecute>();
  // Intercepted ONCE, here, rather than at 24 registration sites: every tool
  // this extension registers is captured on its way through, so the chain can
  // never call a stale copy of one.
  const registerToolUpstream = pi.registerTool.bind(pi) as (spec: unknown) => unknown;
  (pi as { registerTool: (spec: unknown) => unknown }).registerTool = (spec: unknown) => {
    const s = spec as { name?: string; execute?: unknown };
    if (typeof s?.name === "string" && typeof s?.execute === "function") {
      toolExecutes.set(s.name, s.execute as ToolExecute);
    }
    return registerToolUpstream(spec);
  };
  /**
   * The INTERNAL host — an implementation the gate runs but does not expose.
   *
   * Philosophy three says the ten advanced entries are DELETED, and philosophy
   * two says the gate still has to perform every step they used to name. Both
   * hold at once because a tool has two halves: an implementation and a
   * registration. This host keeps the first and drops the second — the body is
   * captured into `toolExecutes` (so `judge_submit` and `propose_loop_goal`
   * still call the ONE implementation, with all its mechanical checks) and
   * `pi` never learns the name exists, so no agent can be tempted to sequence
   * the steps by hand.
   *
   * Nothing here is a back door: the names are unreachable from a model, and
   * `test/extension-structure.test.ts` asserts that they are not registered.
   */
  function captureInternalTool(spec: unknown): void {
    const s = spec as { name?: string; execute?: unknown };
    if (typeof s?.name === "string" && typeof s?.execute === "function") {
      toolExecutes.set(s.name, s.execute as ToolExecute);
    }
  }
  /** The `lib/` tool modules register through this. */
  const internalHost: ToolHost = { registerTool: captureInternalTool };
  /**
   * A TEST SEAM, and deliberately not a tool surface.
   *
   * The internal implementations have to stay reachable by a test — they hold
   * mechanical checks (the precommit receipt, the L5 message rule, the
   * checkpoint commit, the audit adjudication) whose behavior is the point of
   * several suites, and driving them only through the minutes-long chains
   * that call them would test almost nothing.
   *
   * It is not a back door: an agent's world is the TOOL REGISTRY, and nothing
   * here is in it. `pi` never learns these names, no schema is published for
   * them, and `test/extension-structure.test.ts` asserts exactly that.
   */
  (pi as unknown as { __reviewGateInternalTools?: Map<string, ToolExecute> })
    .__reviewGateInternalTools = toolExecutes;

  /**
   * The same seam, for the two RECORDERS that are plain functions rather than
   * internal tools (2026-09-04, user decision D4: their tool shape existed only
   * to carry text that had to be parsed back into a verdict).
   *
   * Same reasoning as above and the same non-back-door property: they take a
   * STRUCTURED conclusion, `pi` never learns a name for either, and the only
   * production callers are the gate's own settle path. A test would otherwise
   * have to drive a minutes-long judge dispatch to reach the L8b record or the
   * commit-target binding.
   */
  (pi as unknown as { __reviewGateRecorders?: Record<string, unknown> }).__reviewGateRecorders = {
    recordGoalPrereview: (input: Parameters<typeof recordGoalPrereview>[1], ctx: unknown) =>
      recordGoalPrereview(goalPrereviewDeps, input, ctx),
    recordReviewVerdict: (concluded: ReportConclusion, repo: string, ctx: unknown) =>
      recordReviewVerdict(concluded, repo, ctx),
    // THE QUALITY RECORDER, for the same reason the review one is here: since
    // 2026-09-16 a functional READY can only be recorded when a quality
    // standing covers the SAME head, so an end-to-end test of the recorder has
    // to be able to produce the round that precedes it. It is a plain function
    // (no tool, no registration); the seam only forwards it.
    recordQualityVerdict: (concluded: ReportConclusion, repo: string, ctx: unknown) =>
      recordQualityVerdict(concluded, repo, ctx),
  };

  /**
   * The lane, exposed for the ONE test that needs a lane to actually be running.
   *
   * WHY THIS IS NOT A BACK DOOR. `startPrecommitBeside` is the gate's own
   * background verification — the thing a checkpoint is allowed to precede
   * (B1). A parked READY can only be revived by that lane's own landing, so the
   * rule "never park a conclusion when no lane is running" (round-1 P1,
   * 2026-09-15) can only be tested end to end by starting one; production
   * reaches this function from `judge_submit` alone, and a test calling it
   * directly grants no authority — it runs the repository's own precommit.
   *
   * SIDE EFFECT, since a caller has to know it (round-2 Nit): starting a lane
   * RESETS the recorded `precommit` entry to `NOT_RUN` — that is what makes a
   * lane "in flight" observable at all — so a test that starts one leaves the
   * sidecar saying its verification has not run yet. Nothing reads that entry as
   * authority; the ship gate wants a PASS on the tree it is shipping.
   */
  (pi as unknown as { __reviewGateTestSeams?: Record<string, unknown> }).__reviewGateTestSeams = {
    startFullLane: (root: string, ctx: unknown) => startPrecommitBeside(root, ctx),
  };

  /**
   * The in-file bodies register through this, which keeps pi's own parameter
   * typing (the typebox schema flows into `execute`'s params) while the
   * definition goes nowhere near the model.
   */
  const internalTool: typeof pi.registerTool = ((spec: unknown) => {
    captureInternalTool(spec);
  }) as typeof pi.registerTool;


  /** Call another gate tool internally; a missing tool is a programming error. */
  async function callTool(
    name: string,
    params: Record<string, unknown>,
    ctx: unknown,
    /** Live-output sink forwarded to the called tool (the chain streams). */
    onUpdate?: ToolUpdate,
    /** The caller's abort signal, forwarded so ESC can stop internal waits. */
    signal?: AbortSignal | undefined,
  ) {
    const run = toolExecutes.get(name);
    if (!run) throw new Error(`review-gate: internal tool ${name} is not registered`);
    return run(`internal-${name}`, params, signal, onUpdate, ctx);
  }
  /** Bridge an internal wait's motion frames into the chain's own progress tail. */
  function forwardWaitUpdates(progress: { tail?(text: string): void; step?(t: string): void } | undefined): ToolUpdate | undefined {
    if (!progress) return undefined;
    return (partial) => {
      const text = (partial.content ?? []).map((c) => c.text).join("\n").slice(-500).trim();
      if (!text) return;
      if (progress.tail) progress.tail(text);
      else progress.step?.(text.slice(0, 120));
    };
  }
  /**
   * THE GATE'S OWN WAIT (2026-09-08) — the round-end rule is `awaitRoundReport`'s:
   * one synchronous audit chain, nobody there to act on a finding, so "anything
   * but a report" is unfinished. The single `wait` step addresses the auditor by
   * JUDGE ID through `doWait` directly instead of `callTool("judge_wait",
   * { repo })`: the tool path re-runs `addressJudge`'s "has this session edited
   * that repo" check, which refuses a legitimate self-audit of an unedited repo
   * (measured: five consecutive "等待未命中本轮 report" on a cross-repo goal
   * audit). The opener check still runs inside `doWait`; only the repo-addressing
   * is bypassed, and the judgeId comes from this session's own registry
   * (`judgeChildByRole`), never from an agent-supplied parameter.
   */
  async function selfAuditWait(
    root: string,
    ctx: unknown,
    onUpdate: ToolUpdate | undefined,
    signal: AbortSignal | undefined,
  ) {
    return awaitRoundReport({
      wait: (timeoutMs) => {
        const judgeId = judgeChildByRole(root, "goal-auditor")?.judgeId;
        if (judgeId === undefined) {
          return Promise.resolve({
            content: [{ type: "text", text: "review-gate: no judge on record — submit a round first (judge_submit)." }],
            details: { done: false, reason: undefined, role: undefined, hasVerdict: false },
            isError: true,
          });
        }
        // Pass the LIVE signal through, never a frozen snapshot: `pollUntil`
        // reads `aborted` on every tick, and a `{ aborted: signal.aborted }`
        // copy taken at dispatch time would never observe a user ESC.
        return doWait(
          selfSessionDeps(),
          { sessionId: judgeId, timeoutMs },
          signal,
          onUpdate,
          true, // gateSelf: the gate's own chain, never an agent param
        );
      },
      now: () => Date.now(),
      aborted: () => signal?.aborted === true,
      // THE GATE OWNS ITS OWN BUDGET (2026-09-19). Borrowing `judge_wait`'s
      // ten-minute cap made an eleven-minute goal audit look like a gate
      // defect: the budget expired, `awaitRoundEnd` reported 「等待未命中本轮
      // report」, nothing was recorded, and the agent re-ran the whole audit to
      // collect a verdict that had already landed. An audit is not an agent
      // wait — see `AUDIT_SELF_WAIT_BUDGET_MS`.
      budgetMs: AUDIT_SELF_WAIT_BUDGET_MS,
    }) as ReturnType<typeof callTool>;

  }

  /** The text a tool result carries (its content joined). */
  function toolText(result: { content?: { type: string; text: string }[] }): string {
    return (result.content ?? []).map((c) => c.text).join("\n");
  }

  /**
   * The payload a `prepare_*` tool built, split off its human-facing header.
   *
   * All three prepare tools end their header with this marker, so the chain
   * extracts one way for every role. A result WITHOUT the marker is handed
   * over whole rather than silently truncated — a judge that receives a
   * header instead of its task is a wasted round either way, but a
   * mis-sliced one is harder to notice.
   */
  function extractTaskText(prepared: string): string {
    const at = prepared.indexOf(TASK_TEXT_MARKER);
    if (at < 0) return prepared;
    return prepared.slice(at + TASK_TEXT_MARKER.length).trim() || prepared;
  }


  let state: GateState = emptyState(null, DEFAULT_MAX_ROUNDS);
  let cwd = process.cwd();
  let continuationsInjected = 0; // total auto-continuation injections (persisted)
  // L2 stall breaker (in-memory by design: a restart is itself a change of
  // circumstances, and a stale stall must never outlive the session).
  let loopStall: StallState | undefined;
  let stallNoticeShown = false;
  /**
   * WHEN THE GATE LAST GOT AN ANSWER OUT OF THE USER, in ISO — written by
   * `askChoice`, which every one of the gate's dialogs goes through (ask_user's
   * interview, the restatement / goal / plan approvals, the consent boxes).
   *
   * It exists for ONE reader: the stall breaker (`stallInMotion`), which must
   * not call a live negotiation "no progress". In memory on purpose: `loopStall`
   * is in memory too, so a restart starts the breaker from zero either way, and
   * a persisted stamp could only excuse a turn it knows nothing about.
   */
  const lastUserInteractionAt: Ref<string | undefined> = { current: undefined };
  /** ISO of the previous stall observation — what `stallInMotion` compares against. */
  let lastStallObservedAt: string | undefined;
  /**
   * L7/L8 continuations spent on COMPLETION-only work (waiting for Copilot,
   * negotiating the goal). Separate budget on purpose: a Copilot review that
   * takes four polls must not eat the rounds the fix→review loop needs, and a
   * stuck completion requirement still has to stop eventually.
   */
  let completionContinuations = 0;
  const COMPLETION_CONTINUATION_CAP = 12;
  // Round-18: hosted judge-child wait notices are throttled (one per minute
  // per state), NOT counted against the continuation budget — they repeat
  // only while the agent keeps ending turns instead of hosting the wait, and
  // the stall breaker must stay the sole arbiter of the review budget.
  let lastChildNoticeAt = 0;
  // D (2026-09-01): goal-negotiation reminder for read-only tools, throttled.
  // In-memory by design: a restart is itself a fresh session with a fresh
  // reminder budget, and the L8 edit gate stays the hard backstop — this is
  // advisory only.
  let lastGoalReminderAt = 0;
  const GOAL_REMINDER_MIN_MS = 5 * 60_000; // every 5 minutes at most
  let goalReminderCount = 0;
  const GOAL_REMINDER_CAP = 2; // per session at most

  const CHILD_NOTICE_MIN_MS = 60_000;
  /**
   * Gate-owned hosted-wait watchdog. It is intentionally NOT `unref()`'d:
   * while a child is in flight, the main session must remain alive even if the
   * child never signals. A single timer replaces the old fall-through RESUME
   * noise; session_shutdown cancels it.
   */
  let childWaitTimer: ReturnType<typeof setTimeout> | undefined;
  function cancelChildWaitTimer(): void {
    if (childWaitTimer) clearTimeout(childWaitTimer);
    childWaitTimer = undefined;
  }
  function scheduleChildWaitRecheck(delayMs: number): void {
    if (childWaitTimer) return;
    childWaitTimer = setTimeout(() => {
      childWaitTimer = undefined;
      // Re-check every legal stop condition at callback time. The timer is
      // deliberately referenced, but it must never revive a user-paused or
      // user-aborted session, or a task whose child has already been closed.
      if (state.taskMode === "explore" || state.taskMode === "normal" ||
          state.pausedQuestion || lastRunAborted || !loopArmed || state.bypass.active) return;
      if (ownJudges().length === 0) return;
      try {
        pi.sendUserMessage(
          "[REVIEW_GATE_CHILD_WATCHDOG] 门禁托管等待到期，重新检查子会话的通道 report、有无 pane 死亡与静默上限；" +
          `新消息会以标准报告送达并继续。\n${WAIT_DISCIPLINE_HINT}`,

          { deliverAs: "followUp" },
        );
      } catch { /* session was replaced or shut down */ }
    }, Math.max(1_000, delayMs));
    // Deliberately keep this timer referenced: it is the main-session liveness
    // anchor while the child may have stopped without signalling.
  }
  let loopArmed = true; // /gate-bypass or NEEDS_HUMAN disarms auto-continuation
  // Re-arm the loop AND clear the arbitration pause together: working again
  // means the human stop no longer applies (2026-08-30, P1).
  function armLoop(): void {
    loopArmed = true;
    arbitrationPaused = false;
  }
  // Arbitration pause (2026-08-30, P1): the revival timer must respect the
  // third way an arbiter ruling can end — the human picked "Pause gate and
  // wait" in the dialog. Set in the arbitration tool, cleared by armLoop.
  let arbitrationPaused = false;
  // session_start; a missing/corrupt config file falls back to safe defaults.
  let projectConfig: ProjectConfig = defaultProjectConfig();
  // A declined downgrade confirmation locks agent-initiated downgrades for the
  // rest of the session (anti-grinding: a prompt-injected agent must not be
  // able to re-pop the dialog until the user gives in). /gate-mode and
  // /gate-reset clear it. In-memory only — never persisted.
  let agentDowngradesLocked = false;
  // USER REQUIREMENT ("no changes" = THIS session, not pre-existing ones):
  // tracks whether THIS session has edited anything yet. session_start resets
  // it; a passed edit tool_call sets it. Distinct from state.hasCodeChange/
  // hasDocChange, which intentionally include pre-existing worktree/branch
  // changes detected at session_start (they arm the ship gate). The first
  // classification stays consent-free as long as the session itself has not
  // edited — leftover changes from before this session do not force a dialog.
  // In-memory only: a fresh session starts fresh anyway.
  let sessionEdited = false;
  // Edit-discipline nudge window (prompt-only, never blocking): set when an
  // edit/write tool call FAILS; cleared ONLY on a successful edit or after one
  // nudge has been issued (2026-09-08 — it used to close at turn start / on
  // new user input, which let a persistently broken edit tool cross turns and
  // fall into bash file edits with no reminder). While set, a bash result
  // that looks like a direct file write gets BASH_WRITE_NUDGE appended
  // (lib/edit-discipline.ts). This targets the recurring "edit failed → shell
  // edits the file" workaround without policing ordinary bash usage.
  let editFailurePending = false;
  // Read-only drill stall guard (lib/readonly-stall.ts): counts consecutive
  // successful read-only tool calls (read family + bash) with no edit landing
  // in between; at READONLY_STALL_LIMIT it appends READONLY_STALL_NUDGE to
  // the next result (nudge only, never a block — see the module doc). The
  // state lives for the session: a drill that spans several turns still trips.
  let readonlyStallState: ReadonlyStallState | undefined;
  // USER REQUIREMENT (ESC = pause): when the user aborts a run (ESC — the
  // TUI's "Operation aborted"), the L2 auto-continuation must NOT steamroll
  // that explicit human stop with a [REVIEW_GATE_RESUME] follow-up. agent_end
  // records whether the run's LAST assistant message ended with stopReason
  // "aborted"; agent_settled then skips the continuation and the next REAL
  // user input (any non-"extension" source) clears the flag. Deliberately
  // OVERWRITTEN on every agent_end, so an overflow-recovery abort that Pi
  // auto-retries (the retried run ends normally) never leaves a stale pause.
  // In-memory only: no run can settle again until the user speaks, and a
  // process restart starts idle anyway. Tighten-only — the ship gate never
  // reads it.
  let lastRunAborted = false;
  // Anti-grinding lock for request_scope_limit (mirrors agentDowngradesLocked):
  // once the user DECLINES a scope-limit dialog, the agent cannot re-pop it
  // for the rest of the session. /gate-reset clears it. In-memory only.
  let scopeLimitDeclined = false;
  // The same lock for request_tmux_access (user decision, 2026-09-17). The
  // GRANT is not in-memory — it lives in the sidecar (`state.tmuxAccess`)
  // because the user asked for it to cover a handoff successor too; the
  // REFUSAL is, because "do not ask again" is about this session's nagging.
  let tmuxAccessDeclined = false;
  // Repo-relative paths of the files THIS session actually edited (successful
  // edit-tool results only). Feeds the request_scope_limit grant (what stays
  // in scope) and the scope directive in the per-turn prompt. In-memory; a
  // same-session resume re-seeds it from state.scopeLimit.sessionFiles.
  const sessionEditedPaths = new Set<string>();
  // ---- Sensitive-file edit authorization (lib/sensitive-grant.ts) ----
  // Live one-shot grants issued by request_sensitive_edit, and the set of
  // paths whose dialog the user already DECLINED. Both in-memory ONLY: a
  // permission to write `.env` must never outlive the process that asked for
  // it, so a crash/resume/second session starts fully fail-closed.
  //
  // The decline lock is per PATH, not per session (unlike scopeLimitDeclined):
  // a "no" to `/a/.env` says nothing about `/b/credentials.json`, but it does
  // permanently answer `/a/.env` — re-popping the same dialog is exactly the
  // grinding an injected instruction would try.
  let sensitiveGrants: SensitiveGrant[] = [];
  const sensitiveDeclinedPaths = new Set<string>();

  // ---- Multi-repo tracking (see lib/repo-resolve.ts) ----
  // The gate's sidecar + fingerprint bind to the SESSION repo (cwd's git
  // root). When the agent edits or ships from ANOTHER git repository (sibling
  // checkout, submodule, …), that repo gets its OWN sidecar + fingerprint.
  // `activeRepoRoot` is the repo the agent most recently edited — the target
  // of verdict recording / run_precommit. `sessionRepos` collects every repo this
  // session has edited; declare_done requires ALL of them to pass.
  // True when the session cwd sits inside a git repository (gitRootOfDir
  // succeeded). When false, the session is a NON-GIT directory (e.g. /tmp):
  // the gate short-circuits entirely — no git calls, no branch, no loop
  // goal, no checkpoint/review/precommit/ship machinery, no fatal noise on
  // stderr (2026-09-02, user decision: "非 git 目录就不显示分支或者说不调用
  // git 的信息 所有的逻辑都应该这样").
  let sessionInGit = gitRootOfDir(cwd) !== null;
  let primaryRepoRoot = gitRootOfDir(cwd) ?? cwd;
  const activeRepoRoot = { current: primaryRepoRoot };
  const sessionRepos = new Set<string>([primaryRepoRoot]);
  // Non-primary repo states (primary is `state` itself). Loaded lazily;
  // each is persisted to its own repo's .pi/review-gate-state.json sidecar so
  // the L3 git hooks (which read the repo-local sidecar) see the same state.
  const repoStateCache = new Map<string, GateState>();

  /** State for a repo. The primary repo IS `state`; every other repo gets a
   *  lazily loaded/cached independent state. A sidecar left over from a
   *  DIFFERENT session is not trusted: we start fresh but preserve the fact
   *  that the worktree holds changes (fail-closed — pre-existing uncommitted
   *  work must still arm the gate). */
  function stateForRepo(root: string): GateState {
    if (root === primaryRepoRoot) return state;
    let s = repoStateCache.get(root);
    if (!s) {
      const existing = loadSidecar(sessionSidecarPath(root));
      const owner = stateOwnership(process.env, state.sessionId, existing?.sessionId);
      if (owner === "mine" && existing) {
        s = existing;
      } else {
        s = emptyState(state.sessionId ?? null, projectConfig.maxRounds);
        const files = changedFiles(root);
        // SAME RULE as every other arming site (`lib/gate-arming.ts`, 2026-09-20),
        // and BOTH facts — the branch-ahead half included (review round 1 P1):
        // a secondary repo whose only work is already committed would otherwise
        // read as "nothing to review" to that repo's ship gate, which is the
        // fail-open F1 closed for the primary repo. The sync helper exists for
        // this call site (it is a synchronous state factory).
        const armed = armingFromFacts({ files: files ?? [], commitsAhead: commitsAheadOfBase(root) });
        if (armed.hasCodeChange || armed.hasDocChange) {
          s.hasCodeChange = armed.hasCodeChange;
          s.hasDocChange = armed.hasDocChange;
          s.review.verdict = "PENDING";
          s.precommit.verdict = "NOT_RUN";
        }
        // A relay successor continues the same work in EVERY repo it touched,
        // so a SECONDARY repo's sidecar is inherited on the same terms as the
        // primary one — one rule, one function (`lib/session-inheritance.ts`'s
        // `stateOwnership`), no second copy of it here. Without it, the moment
        // the successor touched its second repo the gate would ask it to
        // negotiate a goal it already has (reviewer P2, round 1).
        if (owner === "inherited" && existing) s = inheritGoalContract(s, existing);
      }
      // THE STAGE SWITCHES ARE A SESSION FACT, carried into every repo this
      // session writes (2026-09-22, lib/loop-stages.ts): the box is answered
      // once for the session, so a second repo must not read "no record" as
      // "all five on" — the L3 hooks read the repo-local sidecar, and they
      // would otherwise keep blocking on a stage the user switched off. A
      // repo that carries its own record keeps it.
      if (s.stages === undefined && state.stages !== undefined) s.stages = state.stages;
      repoStateCache.set(root, s);
    }
    return s;
  }

  /** Persist a repo's state: the primary repo goes through persist() (session
   *  entry + widget + .blocked handling); other repos write their own sidecar
   *  (the same fail-closed .blocked marker on write failure). Each repo's
   *  marker is reclaimed strictly against its OWN path — one repo's successful
   *  write says nothing about another repo's failed one. */
  function persistRepo(ctx: ExtensionContext, root: string) {
    // The primary repo goes through persist() — which arms the L7 watcher for
    // it (as it does for every other persist).
    if (root === primaryRepoRoot) { persist(ctx); return; }
    // The SECOND repo's sidecar is gate state too — a judge is barred from it
    // for exactly the same reason, and this path does not go through persist().
    if (noteGateStatePersistSkip(ctx)) return;
    const s = stateForRepo(root);
    try {
      saveSidecarPreservingConcurrent(sessionSidecarPath(root), s, () => digestForMerge(root));
      reconcileBlockedMarker(blockedMarkerPath(sessionSidecarPath(root)), { sessionId: s.sessionId });
    } catch {
      recordBlockedMarker(blockedMarkerPath(sessionSidecarPath(root)), { sessionId: s.sessionId });
    }
  }

  /**
   * THE SESSION HOST — what every module carved out of this closure reads the
   * session through (lib/session-host.ts). Accessors, never values: `state`,
   * the repo roots and `latestCtx` are all reassigned while the session lives.
   */
  const host: SessionHost = {
    state: () => state,
    stateFor: (root) => stateForRepo(root),
    persist: (ctx) => persist(ctx),
    persistRepo: (ctx, root) => persistRepo(ctx, root),
    repos: () => ({
      primary: primaryRepoRoot,
      active: activeRepoRoot.current,
      all: sessionRepos,
      cwd,
      inGit: sessionInGit,
    }),
    ctx: () => latestCtx,
    log: (text) => appendAuditLog(primaryRepoRoot, state.sessionId, text),
  };
  const { log } = host;

  // ---- TUI widgets (display-only; never throw, never block the gate) ----
  /** The last UI context a widget render reached — the refresh timer's target. */
  const lastUiCtx: Ref<ExtensionContext | undefined> = { current: undefined };
  const { contractReadout, updateWidget, armUiRefreshTimer, disarmUiRefreshTimer } = createStatusStrip(host, {
    goalStageSatisfied: () => goalStageSatisfied(),
    goalStageOn: () => stageIsOn("goal"),
    isJudgePane: () => isJudgePane(),
    judgeTaskRound: () => judgeTaskRound,
    sessionEdited: () => sessionEdited || sessionEditedPaths.size > 0,
    loopGoalPresent: (root) => readSessionLoopGoal(root).present,
    loopGoalPath: (root) => loopGoalPathIn(root),
    lastUiCtx,
  });

  /** Human label for a repo in messages. The primary repo has no distinctive
   *  name of its own in a single-repo session, but in a MULTI-repo session an
   *  unlabelled problem line is exactly what made a real session unfixable:
   *  the agent read "code review gate is PENDING" as being about the repo it
   *  had just reviewed (a different one) and looped forever. So label by
   *  directory name whenever more than one repo is in play — falling back to
   *  the full path when two checkouts share a basename (two `api` clones
   *  labelled `[api]` would recreate the very ambiguity this removes). */
  function repoLabel(root: string): string {
    const multi = sessionRepos.size > 1;
    if (root === primaryRepoRoot && !multi) return "session repo";
    const name = root.split("/").pop() || root;
    const collides = knownRepoRoots().some((r) => r !== root && (r.split("/").pop() || r) === name);
    return collides ? root : name;
  }

  /** Every repo this session is accountable for, primary first. */
  function knownRepoRoots(): string[] {
    const roots = [...sessionRepos];
    if (!roots.includes(primaryRepoRoot)) roots.unshift(primaryRepoRoot);
    return roots;
  }

  /**
   * Say WHERE the last READY actually landed when a ship is blocked.
   *
   * In the session that motivated this, every round's READY was recorded
   * against the last-edited repo while the commit ran in another one; the
   * block message named neither, so the agent concluded the sidecar was being
   * reset by a stray process and retried the same futile loop seven times.
   * Naming both ends turns that dead end into an actionable next step.
   *
   * Deliberately worded as a diagnosis, never as permission: the verdict
   * quoted here belongs to a different repo and authorizes nothing.
   */
  function crossRepoVerdictHint(blockedRoots: string[]): string {
    if (blockedRoots.length === 0) return "";
    const elsewhere = knownRepoRoots().filter(
      (r) => !blockedRoots.includes(r) && enforcementStateFor(r)?.review.verdict === "READY",
    );
    if (elsewhere.length === 0) return "";
    return (
      `\nnote: a READY review is recorded on ${elsewhere.join(", ")} — not on ${blockedRoots.join(", ")}. ` +
      "A verdict counts only for the repo it was recorded against, so it does not unblock this one: " +
      'run the loop for the blocked repo: `judge_submit({role:"reviewer", repo:"<that repo path>", task:<what you changed there>})` ' +
      "— the gate runs that repo's own precommit, checkpoint and review, and records the verdict against it."
    );
  }

  /**
   * Gate summary for every repo BESIDES the session repo, for /gate-status.
   *
   * /gate-status used to report the session repo only, so a session working
   * across several repos saw "ship gate: OPEN" while the repo it was about to
   * commit was still PENDING — the status readout actively confirmed the
   * wrong mental model. Each repo is now listed with its own verdicts and its
   * own unmet requirements.
   *
   * This hashes each repo's worktree (~0.5s on a large repo), which is why it
   * lives in the user-invoked command and not on any hot path.
   */
  function otherRepoStatus(): { lines: string[]; blocked: boolean } {
    const others = knownRepoRoots().filter((r) => r !== primaryRepoRoot);
    if (others.length === 0) return { lines: [], blocked: false };
    const lines = ["", `other repos edited this session (${others.length}):`];
    let blocked = false;
    for (const root of others) {
      const st = enforcementStateFor(root);
      if (!st) {
        // Sidecar missing or owned by a different session: nothing verifiable.
        // Reported explicitly rather than skipped — a skipped repo reads as a
        // green one. Mirror the ship gate's own rule for this case (see the
        // `else` branch of the ship check): only DIRTY or unverifiable repos
        // actually block, so a clean one is not escalated to a warning.
        const files = changedFiles(root);
        const dirty = files === undefined || files.length > 0;
        if (dirty) blocked = true;
        lines.push(
          `  ${root}: no usable gate state — ` +
          (files === undefined
            ? "worktree unverifiable, ships from it are refused"
            : files.length > 0
              ? `${files.length} uncommitted change(s), so ships from it are blocked`
              : "clean, so it blocks nothing"),
        );
        continue;
      }
      const rfp = computeFingerprint(root);
      const unmet = unmetRequirements(st, headCommitTree(root), false, {
        requireDocSync: projectConfig.docSync,
        unreviewedCommits: unreviewedTreesSince(root, st.review),
      });
      if (unmet.length) blocked = true;
      lines.push(
        `  ${root}: review=${st.review.verdict} precommit=${st.precommit.verdict} ` +
        `changes=${st.hasCodeChange ? "code" : st.hasDocChange ? "docs" : "none"} — ` +
        (unmet.length ? `BLOCKED: ${unmet.join("; ")}` : "OPEN"),
      );
      // THE ACCEPTANCE RECORD RIDES ALONG (quality round P2, 2026-09-22): the
      // round is decided PER REPO since this same day, so a secondary repo's
      // READY / SKIPPED (with its reason) / BLOCKED would otherwise exist only
      // in a sidecar nobody reads — the same "recorded is not enough" rule the
      // primary's own line above obeys. Rendered only when there is one.
      const acceptanceLine = acceptanceStatusLine(st.acceptance);
      if (acceptanceLine !== undefined) lines.push(`    ${acceptanceLine}`);
    }
    return { lines, blocked };
  }

  /**
   * Resolve the repo the verdict recorder / `run_precommit` targets.
   *
   * Before this existed both steps wrote to `activeRepoRoot`, which only an
   * edit-tool call could move: a session whose last edit was in repo B could
   * never record a verdict for repo A again, so A's commit stayed blocked no
   * matter how many review rounds ran. Resolution (and the multi-repo
   * "be explicit" rule) lives in resolveToolRepoTarget; see its docstring for
   * why auto-retargeting was rejected as fail-open.
   */
  function resolveToolRepo(requested?: string) {
    return resolveToolRepoTarget({
      requested,
      sessionRepos: knownRepoRoots(),
      activeRepo: activeRepoRoot.current,
      primaryRepo: primaryRepoRoot,
      resolveAbsolute: (p) => pathResolve(cwd, p),
      // Same normalization sessionRepos/repoStateCache keys use: a symlinked
      // or subdirectory path must never mint a SECOND state for one repo
      // (two states for one root is the one way this could fail open).
      resolveRoot: (dir) => gitRootOfDir(dir) ?? null,
    });
  }

  /** State used for ENFORCEMENT checks (ship gate, declare_done): the
   *  primary's live state, or a sidecar THIS session may rely on — its own, or
   *  the predecessor's this handoff continued. A sidecar from anybody else is
   *  NOT trusted here (same rule as stateForRepo, from the same function): it
   *  falls through to undefined so the caller's fail-closed "no gate state"
   *  handling applies (a never-edited repo with uncommitted work blocks
   *  shipping from it). */
  function enforcementStateFor(root: string): GateState | undefined {
    if (root === primaryRepoRoot) return state;
    // THE CACHE IS NOT A SOURCE OF OWNERSHIP (quality round P1, 2026-09-16).
    // This used to be `repoStateCache.get(root) ?? …`, and `stateForRepo`
    // fills that cache for any repo this session merely READ — `settleFinishedRounds`
    // alone walks `sessionRepos` on every settle. So whether a repo counted as
    // this session's own came down to who looked first: a cold cache failed a
    // never-recorded repo closed, a warm one waved it through
    // `unmetRequirements` with nothing unmet. Same repo, two answers, on the
    // path that decides whether work may ship.
    //
    // ONE LOADER, ONE ANSWER (same round, after the reviewer measured the
    // first fix): ownership is read from the DISK through the rule
    // `stateForRepo` also uses, and — that answered — the state itself comes
    // from that SAME loader, so both readers return one object. A repo of ours
    // is adopted as it stands; the predecessor's is carried exactly the way the
    // primary repo is (a fresh state with the user's contracts on it, never the
    // predecessor's verdicts — which is why the raw sidecar must never be
    // handed out here).
    const onDisk = loadSidecar(sessionSidecarPath(root));
    if (stateOwnership(process.env, state.sessionId, onDisk?.sessionId) === "foreign") return undefined;
    return stateForRepo(root);
  }

  /**
   * The path as the REPOSITORY sees it — the form `git status`, `git ls-files`
   * and a reviewer's findings all use (changedFiles() emits the same form; edit
   * tools may pass absolute).
   *
   * ROOT-RELATIVE, NOT `cwd`-RELATIVE (review round 1 P1, drill F3). A session
   * launched inside a subdirectory used to record `x.ts` for `<root>/sub/x.ts`:
   * that matched nothing downstream. The checkpoint's "did this session write
   * it" test compares against git's root-relative paths, so the session's own
   * new file was left out of its own commit; and a file inside the repo but
   * outside that `cwd` was recorded as an ABSOLUTE path, which
   * `lib/out-of-repo-paths.ts` reads as "this child wrote outside the repo".
   * A path genuinely outside the repository still comes back absolute — that is
   * the signal that module needs.
   *
   * (The two sentences that used to stand here — "assumes the session cwd IS the
   * repo root" — described the behaviour this replaces, and scope-set membership
   * no longer relies on that assumption.)
   */
  function repoRelative(p: string): string {
    const abs = p.startsWith("/") ? p : pathJoin(cwd, p);
    return abs.startsWith(primaryRepoRoot + "/") ? abs.slice(primaryRepoRoot.length + 1) : abs;
  }

  // LLM semantic guard layer (DeepSeek V4 Flash — lib/llm-classify.ts).
  // Lazily (re)created so it always reflects the loaded projectConfig model.
  // Every use is tighten-only + fail-back: an unreachable model degrades each
  // guard to its exact pre-LLM deterministic behavior.
  let llmClassifier: LlmClassifier | null = null;
  let llmClassifierModel = "";

  // ---- Arbitration state (in-memory ONLY; never persisted to the sidecar) ----
  // A single-use bypass token issued by an AGENT_WINS arbiter decision, bound to
  // the exact action + worktree + review round (lib/arbitration.ts). Any edit,
  // new review round, fingerprint change, or /gate-reset clears it.
  let bypassToken: BypassToken | null = null;
  /** Set when restore() dropped bindings written by an older fingerprint
   *  algorithm, so session_start can explain why they disappeared. */
  let fingerprintMigrated = false;
  // The most recent ship command the gate BLOCKED, so request_arbitration can
  // only contest a real block (not an agent-invented one).
  let lastBlockedShip: BlockedShipRecord | null = null;
  // The most recent A-class TEXT block (lib/text-appeal.ts), for the same
  // reason: an appeal contests a block that actually happened, never a
  // hypothetical one.
  let lastBlockedText: (AppealableBlock & { at: number }) | null = null;
  // JUDGE SIDE ONLY — the third arbitrable class. `judge_conclude` refuses a
  // zero-inspection READY (lib/judge-inspection.ts) and records the refusal
  // here so the appeal can contest a block that actually happened; a granted
  // appeal parks its single-use pass in `inspectionPass`. Both live in memory
  // only: they belong to this pane's round, and a judge writes no gate state.
  let lastBlockedInspection: InspectionBlock | null = null;
  let inspectionPass: InspectionPass | undefined;
  /** What THIS round has been observed inspecting (judge panes only). */
  let judgeInspection: InspectionEvidence = emptyInspection();
  /** The round's `baseline..HEAD`, recovered from its task text when present. */
  let judgeReviewRange: string | undefined;
  /** The round's full/incremental decision, recovered from the same text. */
  let judgeScopeKind: "full" | "incremental" | undefined;
  /**
   * The round number the TASK carried (an instruct record's `roundSeq`), or
   * undefined for a pane whose task never named one.
   *
   * Authoritative over the opener's table for `judge_conclude` (2026-09-16):
   * the table is bumped at dispatch, so it can already hold a LATER round than
   * the one this pane is still concluding.
   */
  let judgeTaskRound: number | undefined;
  /** Is THIS session a judge pane? (the observer's only scope). */
  function isJudgePane(): boolean {
    return readJudgeSideEnv(process.env) !== undefined;
  }
  /**
   * Learn the round's review range and scope kind from its task text. Both are
   * opener knowledge that reaches a pane only as prose — round 1 through the
   * task file in the environment, later rounds through the channel — so they
   * are read back out of that prose. Best effort by design: no range simply
   * means the evidence carries no range flag (a goal audit has none at all),
   * and no decision marker means the report carries no scope kind.
   */
  function noteJudgeTaskText(text: string | undefined, roundSeq?: number): void {
    const range = parseReviewRange(text);
    if (range) judgeReviewRange = range;
    const kind = parseReviewScopeKind(text);
    if (kind) judgeScopeKind = kind;
    // WHICH ROUND THIS TASK IS (2026-09-16). The number travels WITH the task
    // because the opener's table holds the NEXT dispatch's number by the time a
    // busy pane reads this one — reading it from there is exactly how an old
    // verdict got booked against a new round. Only a real number is recorded:
    // an absent field must not renumber an existing round to 0.
    if (typeof roundSeq === "number" && Number.isFinite(roundSeq)) {
      judgeTaskRound = Math.floor(roundSeq);
    }
  }
  /**
   * THIS round's scope, as this pane read it — the judge half of the audit
   * pair stamped on the channel report. Undefined when the task text carried
   * neither fact, which is the honest answer for a round that has no range
   * (a goal audit): an empty stamp would claim a scope nobody recorded.
   */
  function judgeReviewScope(): ScopeStampRecord | undefined {
    if (judgeReviewRange === undefined && judgeScopeKind === undefined) return undefined;
    return {
      ...(judgeReviewRange === undefined ? {} : { range: judgeReviewRange }),
      ...(judgeScopeKind === undefined ? {} : { kind: judgeScopeKind }),
    };
  }
  /** Round 1's task, as the pane was opened with it (a path in the env). */
  function judgeTaskText(): string | undefined {
    const path = (process.env[JUDGE_TASK_ENV] ?? "").trim();
    if (!path) return undefined;
    try {
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    } catch { return undefined; }
  }
  /**
   * The paths THIS round was handed: its task file and its findings stream.
   *
   * They are the round's own paperwork, and reading them is not reviewing the
   * repository — the probe ("conclude READY, do nothing else") would otherwise
   * clear the inspection gate on the task read every judge performs anyway.
   * The generic markers live in lib/judge-inspection.ts; these two are the
   * exact paths only this process knows.
   */
  function judgeOwnPaths(): string[] {
    const paths: string[] = [];
    for (const key of [JUDGE_TASK_ENV, JUDGE_STREAM_ENV]) {
      const value = (process.env[key] ?? "").trim();
      if (value) paths.push(value);
    }
    return paths;
  }
  // Re-roll prevention: decisions cached by (commandDigest#round). A GATE_WINS /
  // HUMAN outcome cannot be re-requested for the same action+round.
  const arbitrationDecisions = new Map<string, "GATE_WINS" | "AGENT_WINS" | "HUMAN">();

  /** Appeals + arbitrations spent this session (persisted, so a restart does
   *  not hand the agent a fresh quota). */
  function appealsUsed(): number {
    return state.appeals?.used ?? 0;
  }
  /** Spend one slot of the SHARED quota (the `gh pr edit` arbitration path;
   *  a text appeal spends its slot through recordAppealDecision). */
  function spendArbitration(ctx: unknown): void {
    state.appeals = { ...(state.appeals ?? emptyAppealRecord()), used: appealsUsed() + 1 };
    persist(ctx as unknown as ExtensionContext);
  }

  /**
   * Refuse one A-class text — unless an appeal already passed this EXACT
   * content, in which case the pass is consumed and the text goes through.
   *
   * Every A-class refusal goes through here, so three things cannot drift
   * apart: the appeal hint in the reason, the record of what was blocked
   * (an appeal may only contest a real block) and the pass lookup.
   */
  function refuseText(
    kind: AppealKind,
    text: string,
    reason: string,
    ctx: unknown,
  ): string | undefined {
    const digest = appealDigest(kind, text);
    if (appealPassAuthorizes(state.appeals, digest)) {
      // Single-use: spend it here, at the one place that can prove the
      // content is the content the arbiter judged.
      state.appeals = consumeAppealPass(state.appeals);
      persist(ctx as unknown as ExtensionContext);
      appendLesson(`appeal pass consumed (${kind})`);
      return undefined;
    }
    const full = `review-gate: ${reason} ${APPEAL_HINT}`;
    lastBlockedText = { kind, text, reason: full, at: Date.now() };
    return full;
  }

  /** Clear any standing bypass token (called whenever the worktree or review
   *  round changes, so a token can never outlive the exact state it was for). */
  function clearBypassToken() { bypassToken = null; }

  // ---- Advisory (PROMPT-ONLY) fingerprint memo ----
  // computeFingerprint() deliberately defeats git's stat cache, which costs
  // ~575ms on a 9k-file repo (~466ms of it the `--renormalize` re-hash). The
  // per-turn system prompt paid that on EVERY turn, including long stretches
  // where the agent only reads files or waits on a review.
  //
  // SAFETY: this memo is keyed on advisoryChangeToken() (a filesystem probe,
  // NOT an extension-event heuristic) and is read by exactly one caller: the
  // before_agent_start prompt renderer. A stale hit can only produce a stale
  // PROMPT for one turn; every enforcement path (ship block, declare_done,
  // verdict recording, arbitration, precommit binding, git hooks) calls
  // computeFingerprint() directly and is unaffected. A null token (git
  // unreadable) always falls through to a real compute — never to a reuse.
  let advisoryFpMemo: { token: string; fp: Fingerprint } | null = null;

  function advisoryFingerprint(): Fingerprint {
    const token = advisoryChangeToken(cwd);
    if (token === null) return computeFingerprint(cwd);
    if (advisoryFpMemo && advisoryFpMemo.token === token) return advisoryFpMemo.fp;
    const fp = computeFingerprint(cwd);
    // Never memoize an UNAVAILABLE result: it is a transient failure signal,
    // and caching it would keep reporting a fail-closed prompt after git
    // recovers.
    advisoryFpMemo = fp.unavailable ? null : { token, fp };
    return fp;
  }

  // Wall clock of the last gate event (session start, precommit, review).
  // Used ONLY to approximate how long a review round took: the reviewer runs
  // as a subagent the extension cannot observe, so the honest measure is
  // "time since the gate last heard anything", recorded as an upper bound.
  // A `Ref`, because the verdict recorders that stamp it live in lib/ (t7).
  const lastGateEventAt: Ref<number> = { current: Date.now() };

  /**
   * How much of this round the reviewer must deep-read.
   *
   * Collects the git facts (increment since the last approved tree, what that
   * review covered) PLUS the one fact that is not about the code — whether the
   * judge taking the round still holds the previous round's reasoning — and
   * hands them all to the pure decision function. Every missing fact resolves
   * to a FULL review; see lib/review-scope.ts.
   *
   * The reader-side fact is gathered HERE rather than at each call site so all
   * three consumers (the reviewer's task text, the turn-end directive, the
   * timing record) describe the same round the same way.
   */
  function reviewScopeFor(root: string, st: GateState): ReviewScopeDecision {
    // WHAT THIS SESSION HAS READ — any concluded round, BLOCKED included.
    // `settledConclusion` below asks the narrower question (what was
    // CONFIRMED) and still demands a READY.
    const base = st.lastReviewedTree;
    // No settled tree ⇒ full anyway. Returning before the lane probe keeps a
    // session that has never had a READY free of a registry scan and a
    // directory read on every turn.
    if (!base) return decideReviewScope({});
    const increment = incrementSinceTree(root, base.treeOid);
    return decideReviewScope({
      baseTree: base.treeOid,
      changedFiles: increment?.files,
      changedLines: increment?.lines,
      previouslyReviewedFiles: base.files,
      judgeRemembersPreviousRound: reviewerRemembersPreviousRound(root),
    });
  }

  /**
   * WILL THIS REPO'S NEXT REVIEWER STILL REMEMBER THE ROUND THAT SETTLED?
   *
   * The lane judgement is `resolveJudgeLane`'s, not a second copy of it: the
   * dispatch that actually opens the reviewer asks the same function, so the
   * scope this decides and the transcript that round lands in cannot disagree.
   * Reading it here is free of consequence — the returned `retirePrevious` is
   * a closure, and nothing but a caller that invokes it retires anything.
   *
   * FAIL-SAFE AT EVERY UNKNOWN: no caller identity, no transcript, or a lane
   * the policy did not call `reuse` all come back `false`, and `false` only
   * ever buys a deeper review.
   */
  function reviewerRemembersPreviousRound(root: string): boolean {
    const opener = callerIdentity();
    if (!opener) return false;
    const { decision } = resolveJudgeLane(root, "reviewer", opener);
    const workDir = pathJoin(root, judgeWorkDirFor("reviewer", shortRepoHash(root), opener, decision.lane));
    return judgeRemembersPreviousRound({
      decision,
      transcriptExists: hasTranscript(pathJoin(workDir, "sessions")),
    });
  }


  /** Findings the previous round left on the table, for the next reviewer. */
  function previousRoundFindings(st: GateState): string[] {
    const last = st.rounds[st.rounds.length - 1];
    if (!last || last.verdict === "READY") return [];
    // Only the fingerprints are persisted (the issue prose is not), which is
    // enough to make the reviewer look each one up and re-check it.
    return last.fingerprints.slice(0, 20);
  }

  /**
   * The conclusion the previous round already reached, so the next reviewer
   * builds on it instead of re-deriving it. Only the READY verdict the
   * increment is measured against qualifies: an unapproved tree has settled
   * nothing. Undefined when there is no such review (⇒ a full round anyway).
   */
  function settledConclusion(st: GateState): SettledConclusion | undefined {
    const base = st.lastReviewedTree;
    // ONLY A READY SETTLES ANYTHING (2026-09-19). A BLOCKED tree is one the
    // previous round READ — which is why `reviewScopeFor` uses it — but nothing
    // about it was approved, and handing it to the next reviewer as settled
    // would tell it to skip exactly the content the previous round refused.
    if (!base || base.verdict !== "READY") return undefined;
    // `rounds` is the recorded-round COUNT at directive time, not the round
    // that produced the verdict (rounds recorded after it are included) — the
    // directive words it that way too.
    return { verdict: "READY", at: base.at, rounds: st.rounds.length };
  }


  /**
   * Background judge-completion watchers (review_watch): one handle per
   * session id. When the child's process exits, the watcher wakes THIS
   * session via pi.sendMessage(triggerTurn) — the "the child finished"
   * notification that makes main-session polling unnecessary. Cancelled on
   * session_shutdown so a reload/resume never leaks a stale listener.
   */

  // ---------- the CHILD side of the supervision channel ----------
  //
  // The heartbeat, the channel watcher, the instruction drain and the dialog
  // race live in lib/child-side-host.ts; this is only the wiring.

  const channelIO: ChannelIO = nodeChannelIO();

  const {
    childBinding,
    reportChildState,
    noteChildProgress,
    noteToolActivity,
    foldBackgroundWait,
    observeBackgroundToolResult,
    startChildHeartbeat,
    stopChildHeartbeat,
    drainChildInstructions,
    askEitherSide,
  } = createChildSide(host, {
    pi,
    channelIO,
    activeJudgeWait: () => activeJudgeWait(),
    isJudgePane: () => isJudgePane(),
    noteJudgeTaskText: (text, roundSeq) => noteJudgeTaskText(text, roundSeq),
  });



  /** Open question ids already announced (in-memory; a restart re-announces — desired). */
  let announcedRequestIds = new Set<string>();
  /**
   * Judges whose DEATH has already been announced (in-memory, same as above).
   *
   * The merged registry survives the process, so a judge that died with a
   * previous one is offered back on every settle — and `terminated` is the one
   * classification the notice throttle deliberately does not cover. Announced
   * once; the entry itself is kept, because `judge_recover` addresses it.
   */
  const announcedTerminated = new Set<string>();
  /** Hints (never refusals) the gate has already delivered — said once each. */
  const deliveredHints = new Set<string>();
  /**
   * Hints earned by the tool call now in flight — appended to ITS result.
   *
   * The next `tool_result` consumes whatever is here; a hint whose call never
   * produces one (a refusal elsewhere in the chain) is dropped with it. No
   * call id is kept: a hint is advice about the command shape, not a fact
   * about that one call, so a parallel batch mis-attributing one costs
   * nothing.
   */
  const pendingHints: string[] = [];


  // NOTE: there is deliberately NO settle-time verdict scraping here anymore. A round
  // ends exactly one way — the judge calls judge_conclude (judge-side-only tool), which
  // appends the channel report itself. See lib/judge-conclude.ts.

  // ---------- ONE gate session per worktree (lib/session-exclusivity.ts) ----------
  // The presence heartbeat and the refusal watch: lib/worktree-presence-host.ts.
  const { holdWorktree, releaseWorktree, applySessionExclusivity, stopExclusivityRecheck } =
    createWorktreePresence(host, { lastUiCtx });


  // ---------- orchestration layer (the project-manager role) ----------
  //
  // Only the WIRING is here. The plan, the constraints, the tmux commands,
  // the tools and their prompts all live in lib/orchestrator-*.ts — this file
  // is the repository's own worst example of the architecture rule this round
  // introduces, so the orchestration layer deliberately does not grow it.
  //
  // The orchestration id is an ADDRESS, not an identity: a relay successor
  // inherits the predecessor's id from its environment, which is what keeps
  // every child reaching whoever currently holds the role. A session started
  // without one mints its own the first time it needs it.
  let orchestrationIdValue: string | undefined = orchestrationIdFromEnv();
  /**
   * The session that HOLDS this orchestration, as it is written to the
   * sidecar (see `OrchestratorRuntime.ownerSessionId`).
   *
   * It answers ONE question — "is the runtime on disk mine to resume?" —
   * and it is deliberately not `state.sessionId`: a fresh session that
   * inherited a foreign runtime keeps it on disk under its OWN session id
   * (the B1 rule), so the sidecar's session id cannot tell an owner from a
   * bystander one reload later. Only the three legitimate holders set this:
   * the session that resolved the address below, and the one that adopted it
   * through `orchestrator_attach`.
   */
  let orchestrationOwner: string | undefined;
  function currentOrchestrationId(): string {
    if (!orchestrationIdValue) {
      const stored = state.orchestrator;
      orchestrationIdValue = startupOrchestrationId({
        env: process.env,
        storedId: stored?.orchestrationId,
        // The durable answer, never "did the sidecar carry my session id" —
        // the reset path re-stamps that on every persist.
        storedBelongsToThisSession: storedRuntimeIsMine({
          ownerSessionId: stored?.ownerSessionId,
          sessionId: state.sessionId,
        }),
        repoRoot: primaryRepoRoot,
      });
    }
    // WHICHEVER WAY IT RESOLVED, THIS SESSION HOLDS IT: an id inherited from
    // the environment (a relay successor), this session's own resumed runtime,
    // or a fresh mint. The claim is what the sidecar needs to let THIS session
    // resume the record after a reload, and it is written with the runtime
    // (`persistOrchestration`). Note the bystander case cannot reach it: a
    // stored runtime owned by another session is never adopted here, so the
    // address this line claims is this session's own new one.
    orchestrationOwner = state.sessionId ?? undefined;
    return orchestrationIdValue;
  }
  /**
   * Take over an existing orchestration's ADDRESS (B1, `orchestrator_attach`).
   *
   * This is the one writer of that closure variable other than the mint
   * above, and it is deliberately dumb: every check that decides whether a
   * takeover is legitimate lives in lib/orchestrator-takeover.ts, where it
   * can be tested without a session. All that happens here is the assignment
   * — from this point on every channel path, every spawned child's
   * environment and every wake-up uses the adopted id.
   */
  function adoptOrchestrationId(id: string): void {
    orchestrationIdValue = id;
    // TAKEOVER IS A CLAIM: from here this session owns the address, and the
    // sidecar must say so, or its own reload would refuse to resume it.
    orchestrationOwner = state.sessionId ?? undefined;
  }
  /** Started BY an orchestrator as a worker (not as its relay successor). */
  function isOrchestrationChild(): boolean {
    return orchestrationIdFromEnv() !== undefined && readInheritance().predecessorPane === undefined;
  }
  // The most recent ExtensionContext, so the orchestration tools can persist
  // and raise dialogs. tool_call fires immediately before every tool body, so
  // it is always fresh by the time one of them runs.
  let latestCtx: ExtensionContext | undefined;
  function persistOrchestration(runtime: OrchestratorRuntime): void {
    // THE OWNER RIDES WITH THE RECORD. A runtime written by a session that
    // holds the address carries that session as its owner; one inherited but
    // never claimed (the B1 reset path) keeps the owner it already had, which
    // is what stops a reload from turning a bystander into the owner.
    state.orchestrator = orchestrationOwner === undefined
      ? runtime
      : { ...runtime, ownerSessionId: orchestrationOwner };
    // No `if (latestCtx)`: an in-memory-only runtime would silently lose the
    // user's plan approval and the child registry on a restart. persist()
    // takes the context only to refresh the status widget, so a missing one
    // costs a redraw, never the record.
    persist(latestCtx);
  }
  /**
   * MY OWN TMUX SESSION, as `lib/session-tmux-scope.ts` needs it: the identity
   * a name is derived from, and the sidecar that records what was created.
   *
   * It is built ONCE and injected everywhere a child can be opened (judge /
   * worker / orchestration child), so "which session do my children go in" has
   * one answer in the process. Nothing here takes a name from a parameter: the
   * record is written only when this session really creates the session, and
   * read back from there afterwards.
   */
  const tmuxScope: TmuxScope = {
    sessionId: () => state.sessionId?.trim() || undefined,
    repoRoot: () => primaryRepoRoot,
    read: () => sanitizeScopeRecord(state.tmuxScope),
    write: (record) => {
      state.tmuxScope = record;
      persist(latestCtx ?? lastUiCtx.current);
    },
    now: () => new Date().toISOString(),
  };

  const orchestratorDeps = createOrchestratorDeps({
    repoRoot: primaryRepoRoot,
    scope: tmuxScope,
    taskMode: () => state.taskMode,
    // THE one banner channel, handed to the tool kit as well: `add-decision`
    // announces a decision the moment it registers one (constraint 11), and
    // the deps only forward the asking — every rule lives in the policy module.
    notifyUser: (opts) => raiseBanner({ kind: opts.kind, detail: opts.detail }),
    // The requirement restatement `submit` demands (2026-09-06). Read live
    // off the state object rather than captured: `propose_restatement` writes
    // it during the same session, and a captured value would make the tool
    // that just recorded a confirmation invisible to the tool that needs it.
    restatement: () => state.restatement,
    loadRuntime: () => state.orchestrator,
    storeRuntime: persistOrchestration,
    // B2 — the plan's records land in the SAME audit log as the restatement
    // confirmation and the loop-goal approval. One log, one grep.
    log: (message) => { log(message); },
    orchestrationId: currentOrchestrationId,
    adoptOrchestrationId,
    askChoice: (spec, opts) => askChoice(asChoiceHost(latestCtx ?? {}), spec, opts),
    // O-1 — the plan's full text goes into the TRANSCRIPT before the dialog
    // asks about it, exactly like the loop goal. A plan approval binds to
    // content, so a truncated dialog body was asking the user to sign
    // something they could not read.
    showToUser: (title, text) => { showToUser(latestCtx ?? {}, title, text); },

    // ROUND-4 P1 — THIS BINDING WAS SIMPLY MISSING. `orchestrator_wait`'s
    // fourth block (context usage + when to hand over) is computed from it,
    // and because nothing was passed, all 15+ receipts of the fourth run said
    // "宿主未提供读数": the orchestrator could not tell whether it had room
    // for another task round, on the one axis — running long — that defines
    // unattended work. The reading itself was always available; nobody wired
    // it. `latestCtx` is refreshed on every tool_call, so it is current by
    // the time any orchestration tool runs.
    contextPercent: () => contextPercentOf(latestCtx as unknown as { getContextUsage?: () => unknown }),
    auditPlan: (plan, onUpdate, signal) => runPlanAudit(plan, onUpdate as { step?: (t: string) => void; done?: (t: string) => void } | undefined, signal),

    sessionTranscriptPath: () => {
      try {
        const dir = sessionDirForCwd(cwd);
        return state.sessionId ? `${dir}/${state.sessionId}.jsonl` : undefined;
      } catch { return undefined; }
    },
    // Handed to a successor as its takeover proof (lib/orchestrator-relay.ts).
    ownSessionId: () => state.sessionId ?? undefined,
    // WHERE THE CHILD WORKS (2026-09-18, A): the ONE git read the task book's
    // branch line needs. It reuses the session's own rebase-aware
    // `currentBranch` — a second `git symbolic-ref` here would be a second
    // answer to the same question the checkpoint's own refusal already reads.
    currentBranch: (root) => currentBranch(root),
    // ONE CHECKOUT PER WRITER (2026-09-10): the second child in a repo gets
    // its own worktree, which is what lets same-repo tasks run side by side
    // (lib/orchestrator-worktree.ts owns every derivation).
    createWorktree: (repoRoot, childId) => {
      const path = childWorktreePath(repoRoot, childId);
      const branch = childWorktreeBranch(childId);
      try {
        gitText(repoRoot, createWorktreeArgv(repoRoot, childId), { timeout: 0 });
      } catch (error) {
        const detail = (error as { stderr?: Buffer | string }).stderr;
        return {
          ok: false as const,
          reason: String(detail ?? (error as Error).message).trim().split("\n").slice(-3).join(" "),
        };
      }
      // SEED IT BEFORE THE CHILD SEES IT (2026-09-15, onchain). `git worktree
      // add` reproduces the COMMIT, and a repository's local environment is by
      // definition not in it: the project's gate config, its `.env` and its
      // `node_modules` are all gitignored. Measured cost of skipping this: a
      // child whose precommit silently ran `yarn test` (the whole midway
      // suite) instead of the repository's configured scoped jest — 143 files
      // failing for reasons that had nothing to do with its change — while the
      // project manager had to talk it through copying a config file by hand.
      // lib/worktree-seed.ts owns what may be taken, and why.
      const seeded = seedWorktree(repoRoot, path);
      return {
        ok: true as const,
        path,
        branch,
        ...(seeded.length > 0 ? { note: seeded.join("\n") } : {}),
      };
    },
    // SETTLE IT (2026-09-10): the manager names the fate of a finished child's
    // checkout; the git sequence is lib/orchestrator-worktree.ts's, so the
    // conflict path is decided there rather than discovered here.
    settleWorktree: ({ childId, taskId, repoRoot, settlement }) => {
      const worktreePath = childWorktreePath(repoRoot, childId);
      // THE BRANCH THE CHECKOUT IS ACTUALLY ON (2026-09-18, reviewer P2). The
      // task book lets a child whose station reaches `pr` rename the gate's
      // `rg-child-…` handle before it pushes (lib/orchestrator-delivery.ts
      // `buildBranchLine`); settling the DERIVED name after that fails with
      // "branch not found", which reports the manager's checkout as broken
      // right after they did what the gate asked.
      //
      // THREE SOURCES, IN THIS ORDER, because each one covers what the previous
      // cannot. The repository's own listing is the ONLY acceptable first
      // source — reading the directory asks git, which walks UP to an enclosing
      // repository when that path is not one, and the name it answers with ends
      // up in a destructive `branch -D` (quality round P1, 2026-09-18). A merge
      // RECLAIMS the directory (2026-09-15, user decision), so the `discard`
      // its receipt asks for next has nothing left to list — it needs the name
      // this session recorded when it DID read one (below), and the derived
      // name is the last resort for a child with no worktree record at all.
      const registered = state.orchestrator ? findChild(state.orchestrator, childId)?.worktree?.branch : undefined;
      const branch = listedWorktreeBranch(repoRoot, worktreePath) ?? registered ?? childWorktreeBranch(childId);
      const plan = planSettlement(settlement, repoRoot, childId, taskId, branch);
      if (plan.steps.length === 0) {
        return { ok: true, text: `worktree 保留在 ${worktreePath}（分支 ${branch}）—— 没有动它` };
      }
      // IDEMPOTENT ON AN ALREADY-RECLAIMED CHECKOUT (2026-09-15). A `merge`
      // reclaims the directory, so a SECOND settlement — or the `discard` a
      // manager issues afterwards to take the branch away too — contains steps
      // aimed at a directory that is already gone. `git -C <missing> add -A`
      // answers "not a git repository", which is a fact about the path and not
      // about the work, so those steps are DROPPED rather than reported as a
      // failure: the branch steps and the merge itself still run.
      const steps = existsSync(worktreePath)
        ? plan.steps
        : plan.steps.filter((step) => step[1] !== worktreePath);
      const run = (argv: readonly string[]): { ok: boolean; output: string } => {
        try {
          // No timeout: a merge or commit step may run the user's hooks.
          return { ok: true, output: gitText(repoRoot, argv, { timeout: 0 }) };
        } catch (error) {
          // BOTH STREAMS (round-5 P1): git writes the merge-conflict text and
          // "nothing to commit" to STDOUT and exits non-zero. Reading only
          // stderr meant neither of those two matches could ever fire — the
          // planned abort never ran, and a child who left nothing uncommitted
          // was reported as a failure.
          const e = error as { stdout?: Buffer | string; stderr?: Buffer | string };
          const out = [e.stdout, e.stderr].map((v) => (v === undefined ? "" : String(v))).join("");
          return { ok: false, output: out.trim() || (error as Error).message };
        }
      };
      // Reclamation after a SUCCESSFUL merge is reported, never fatal: the
      // work is already in the manager's checkout, and failing the whole
      // settlement over an unclean worktree directory would be lying about
      // where the work is.
      const reclamation: string[] = [];
      for (const step of steps) {
        const result = run(step);
        if (result.ok) continue;
        const sub = step[2];
        if (sub === "commit" && /nothing to commit|no changes added/i.test(result.output)) continue;
        if (settlement === "merge" && sub === "merge" && looksLikeMergeConflict(result.output)) {
          for (const undo of plan.onConflict ?? []) run(undo);
          return {
            ok: false,
            text:
              `合并 ${childId} 的 worktree 时**冲突** —— 已中止，你的工作区回到合并前的样子。\n` +
              `它的分支 \`${branch}\` 仍在 ${childWorktreePath(repoRoot, childId)}，一行都没丢。` +
              `需要人工解决：在那边 \`git rebase ${repoRoot}\`（或你习惯的方式）后再 \`orchestrator_close\` 一次。\n\n` +
              result.output.trim().split("\n").slice(0, 12).join("\n"),
          };
        }
        if (sub === "worktree" || sub === "branch") {
          // IDEMPOTENT, so a retry can CONVERGE (round-10 P2). The decision is
          // `looksLikeAlreadyGone` in lib/orchestrator-worktree.ts — pure, and
          // unit-tested there, because "is this failure actually success" is
          // exactly the kind of rule that must not be inlined into a closure.
          if (looksLikeAlreadyGone(result.output)) continue;
          reclamation.push(result.output.trim().slice(0, 200));
          continue;
        }
        return { ok: false, text: `worktree 结算失败（git ${sub ?? "?"}）：${result.output.trim().slice(0, 600)}` };
      }
      // REMEMBER WHAT THE CHECKOUT TURNED OUT TO BE ON (reviewer P2,
      // 2026-09-18). Both settlements that get here REMOVE the directory, and
      // the branch name is then the only thing left to settle with — without
      // this, the very `discard` the receipt below asks for deletes the derived
      // name, misses a renamed branch, and reports it reclaimed anyway.
      const runtime = state.orchestrator;
      const noted = runtime === undefined ? undefined : noteWorktreeBranch(runtime, childId, branch);
      if (runtime !== undefined && noted !== undefined && noted !== runtime) persistOrchestration(noted);
      // BOTH SETTLEMENTS THAT REMOVE SOMETHING RUN RECLAMATION — `discard`
      // (checkout + branch) and `merge` (checkout only, 2026-09-15) — so both
      // can report a failed one. `keep` plans no steps at all and returns
      // above. A merge that CONFLICTED never got here: the sequence stopped at
      // the merge step, and its abort leaves the child's checkout exactly
      // where the human now needs it.
      return {
        ok: true,
        // The RECLAMATION outcome rides back with the settlement, because the
        // caller has to know whether the checkout is actually GONE: forgetting
        // a record whose directory still exists strands it — and a retry is
        // exactly what a failed removal should leave open (round-9 P2).
        reclaimed: reclamation.length === 0,
        text: settlement === "merge"
          ? `已把 ${childId} 的改动合并到当前分支（**已暂存、未提交** —— 看过再 commit）。\n` +
            (reclamation.length === 0
              ? `它的隔离 checkout（${worktreePath}）**已回收** —— 目录不再占地方。\n`
              : `⚠️ 合并成功，但这个隔离 checkout 没能回收：${reclamation.join(" / ")}\n路径 ${worktreePath}。\n`) +
            `分支 \`${branch}\` **保留**：这次合并还只是 staged，` +
            `万一你要 \`git merge --abort\` / reset，它就是那份工作的锚（删了它就只剩 reflog）。提交后用 ` +
            `\`orchestrator_close({childId:"${childId}", worktree:"discard"})\` 连分支一起收回 —— ` +
            `那个调用对已关闭的子会话**同样有效**（它只结算 checkout，不再开门）。`
          : reclamation.length > 0
            ? `⚠️ ${childId} 的 worktree **没能回收**（工作区或分支还留着）：${reclamation.join(" / ")}\n` +
              `路径 ${childWorktreePath(repoRoot, childId)}，分支 \`${branch}\`。\n` +
              `再调一次 \`orchestrator_close({childId:"${childId}", worktree:"discard"})\` 会重试——` +
              `已经删掉的那一半会被当作已完成，不会重复报错。`
            : `已回收 ${childId} 的 worktree 与分支（丢弃）。`,
      };
    },
    knownRepoRoots: () => knownRepoRoots(),
    // Symmetric re-arm (goal 5): the project manager's work is its
    // orchestration tools — the loop session's work is its edits. The
    // whole reason `loopArmed` has three re-arm sites on the edit path
    // and none for the manager is that the manager never edits; here it
    // re-arms itself by managing.
    onToolCall: () => { armLoop(); },
    // RETIRE (goal 7, reworked 2026-09-10 after the rebate handoff failure and
    // its review round 1).
    //
    // A handoff is a VOLUNTARY exit, so every wake-up path has to go quiet —
    // but going quiet is not enough on its own. The successor arms its gate in
    // THIS worktree, and the exclusivity guard refuses a second claimant while
    // our heartbeat is still fresh. MEASURED: the successor was refused with
    // "这个 worktree 已被另一个会话占用", naming the session that had just
    // handed the orchestration over, and its pi then exited.
    //
    // TWO PHASES, and the split is what makes each half safe:
    //   1. release the worktree claim — BEFORE the successor's pane opens, or
    //      its boot races a heartbeat we have not stopped yet;
    //   2. go silent (the retirement flag plus the wake-up timers) — AFTER
    //      the successor's pane is up. `persist()` refuses to write for a
    //      retired session, so marking earlier would make the successor's own
    //      registry row memory-only; and a rollback of a silence it never
    //      entered has nothing to undo.
    //
    // Shared with every other kind of session (`session_handoff`,
    // lib/session-handoff-tools.ts) — see `handoffRetirement` below.
    onHandoff: () => handoffRetirement(),
  });
  registerOrchestratorStateTools(pi, orchestratorDeps);
  // The session tools take the orchestration deps as they are, through an
  // alias — no extra capability, and no copy: a spread would freeze every
  // field at registration time, and these deps are one live object the rest of
  // the session keeps using. (They were once handed a judge-pane count for the
  // window's shared label bar; that judgement is deleted — the bar is turned
  // on and never turned off, see lib/session-factory.ts `closeSessionPane`.)
  const sessionDeps: OrchestratorSessionDeps = orchestratorDeps;
  registerOrchestratorSessionTools(pi, sessionDeps);

  // ---------- THE ONE HANDOVER (lib/session-handoff-tools.ts) ----------
  //
  // WHY THIS IS NOT INSIDE registerOrchestratorSessionTools (2026-09-14,
  // philosophy three): handing over is EVERY kind of session's move. A plain
  // loop session, an orchestration child and a judge pane all run out of room
  // exactly like a project manager, so the tool is registered ONCE here and
  // the mechanical half lives in lib/session-handoff-tools.ts. The retired
  // `orchestrator_handoff` was the half that did not work: it opened a bare
  // `pi` with NO first message, so the successor never learned there was a
  // document to read — and the predecessor waited forever for a close nobody
  // owed it.
  //
  // WHAT THE AGENT STILL OWNS (user decision, same day): the INTENT. Reaching
  // the threshold produces a reminder plus the document skeleton; nothing is
  // opened until `session_handoff()` is called, because only the session
  // itself knows the work is at a stopping point.

  /**
   * WHAT KIND OF SESSION THIS IS — the ONE reading of that fact (2026-09-25).
   *
   * THREE callers branch on it: the registry entry (t2, `mode`), the message
   * sender's self-description (t3), and the handover below. They used to read it
   * in two places with two shapes, which is how two answers to one question
   * drift apart — a worker pane was the fact they had already started to
   * disagree about.
   */
  function ownSessionKind(): string {
    if (readJudgeSideEnv(process.env)) return "judge";
    if (readWorkerSideEnv(process.env)) return "worker";
    if (state.taskMode === "orchestrator") return "orchestrator";
    if ((process.env[STATE_VARIANT_ENV] ?? "").trim()) return "child";
    return state.taskMode ?? "loop";
  }

  /**
   * Which of the FOUR kinds of session is running here, for the handover.
   *
   * A worker pane is not one of them — it is handed work by its opener and never
   * hands over — so it reads as the ordinary loop, exactly as the separate
   * reading it replaced did. Nothing else is invented: `normal` / `explore` are
   * loop sessions too, and the handover document says so.
   */
  function handoffKind(): HandoffSessionKind {
    const kind = ownSessionKind();
    return kind === "orchestrator" || kind === "child" || kind === "judge" ? kind : "loop";
  }

  /** This session's transcript — the raw record a successor may dig through. */
  function ownTranscriptPath(): string | undefined {
    try {
      const dir = sessionDirForCwd(cwd);
      return state.sessionId ? `${dir}/${state.sessionId}.jsonl` : undefined;
    } catch { return undefined; }
  }

  /**
   * The retirement EVERY handover owes — phase one out here, phase two in
   * `committed` (lib/orchestrator-deps.ts's HandoffRetirement spells out why
   * the two cannot be one flag). Shared by the orchestrator deps and the
   * handoff tool, so the two cannot drift.
   */
  function handoffRetirement(): { committed(): void; rolledBack(): void } {
    releaseWorktree();
    return {
      committed: () => {
        markHandedOff();
        stopSupervisionTimer();
        stopRevivalTimer();
        stopChildHeartbeat();
      },
      rolledBack: () => {
        if (claimsMainSidecar(process.env)) holdWorktree();
      },
    };
  }

  /**
   * The MECHANICAL half of the handoff document.
   *
   * Every line is a fact the gate observed — the contract in force, the work
   * still open — so a successor can trust the frame even when the agent's own
   * paragraph is thin. The agent's half is the only testimony in the file and
   * lib/session-handoff.ts marks it as such.
   */
  function handoffDocFacts(): { contract?: string; outstanding?: string[] } {
    const kind = handoffKind();
    const outstanding: string[] = [];
    let contract: string | undefined;
    if (kind === "orchestrator") {
      const { plan } = readPlanFile(cwd);
      if (plan) {
        contract =
          `编排 plan：${plan.title}\n` +
          plan.tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n");
      }
      for (const child of state.orchestrator?.children ?? []) {
        outstanding.push(
          `子会话 ${child.id}（任务 ${child.taskId}，pane ${child.paneId}）：` +
          (child.closedAt ? "已关闭" : "运行中"),
        );
      }
    } else if (kind === "judge") {
      const task = judgeTaskText();
      if (task) contract = `本轮审查任务：\n${task}`;
    } else {
      const goal = readSessionLoopGoal(primaryRepoRoot);
      if (goal.present) contract = `loop goal：\n${goal.text}`;
    }
    try {
      const files = changedFiles(cwd) ?? [];
      if (files.length > 0) {
        outstanding.push(
          `未提交改动 ${files.length} 个文件：${files.slice(0, 12).join("、")}${files.length > 12 ? " …" : ""}`,
        );
      }
    } catch { /* a repo the gate cannot read says nothing rather than lying */ }
    return { ...(contract ? { contract } : {}), outstanding };
  }

  /** Everything the successor needs on top of lib/session-inheritance.ts's record. */
  function handoffExtraEnv(kind: HandoffSessionKind): Record<string, string> {
    return handoffExtraEnvFor({
      kind,
      ...(state.taskMode === undefined ? {} : { taskMode: state.taskMode }),
      // THE ID THIS SESSION ACTUALLY HOLDS, through the ONE rule that decides
      // it: `deps.runtime()` returns an empty runtime when the stored record
      // belongs to a different orchestration (lib/orchestrator-wiring.ts, B1),
      // so its id is "mine" by construction. A child holds none — it addresses
      // one, and that address arrived in ITS environment, blank or not.
      ...(kind === "orchestrator"
        ? { orchestrationId: orchestratorDeps.runtime().orchestrationId }
        : { orchestrationId: process.env[ORCHESTRATION_ID_ENV] }),
      // Blank handling is the FUNCTION's job (`handoffExtraEnvFor` trims and
      // omits), pinned by its test — re-doing it here was the second copy the
      // reviewer flagged as a Nit.
      stateVariant: process.env[STATE_VARIANT_ENV],
      // THE STATION CEILING RIDES THE RELAY TOO (2026-09-15). A successor is a
      // new process, so a ceiling that lived only in the predecessor's
      // environment would evaporate: a child whose plan narrowed its repo to
      // `commit` would come back able to negotiate `pr`. Organic for a
      // standalone session (the variable is absent ⇒ the field is omitted).
      stationCap: process.env[STATION_CAP_ENV],
      // And the ACCEPTANCE GATE rides it (2026-09-22), for exactly the same
      // reason: a relay is a new process, and the variable's ABSENCE means ON.
      acceptanceGate: process.env[ACCEPTANCE_GATE_ENV],
    });
  }

  const handoffDeps: SessionHandoffDeps = {
    kind: handoffKind,
    sessionId: () => state.sessionId ?? undefined,
    ownPane: () => (process.env.TMUX_PANE ?? "").trim() || undefined,
    repoRoot: () => cwd,
    transcriptPath: ownTranscriptPath,
    docPath: (sessionId) => handoffDocPath(cwd, sessionId),
    docFacts: handoffDocFacts,
    writeText: (path, text) => {
      mkdirSync(pathJoin(path, ".."), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
    readText: (path) => {
      try { return existsSync(path) ? readFileSync(path, "utf8") : undefined; } catch { return undefined; }
    },
    openSuccessor: async (spec) => {
      const ownPane = (process.env.TMUX_PANE ?? "").trim();
      if (!ownPane) return { ok: false, error: "本会话不在 tmux pane 里" };
      // THE ONE LAYOUT THAT STILL SPLITS (user decision, 2026-09-25): a relay is
      // the human's own seat changing hands, so the successor lands in their
      // window rather than in a tmux session of its own.
      const opened = await openSessionWindow(runTmux, {
        scope: tmuxScope,
        ownPane,
        cwd,
        layout: "beside-opener",
        command: [...spec.command],
        role: { kind: "successor", env: spec.env },
      });
      return opened.ok ? { ok: true, paneId: opened.paneId } : { ok: false, error: opened.error };
    },
    retire: handoffRetirement,
    // An orchestration records who took over, on the runtime it persists: the
    // successor's own row goes through `persist()`, which refuses to write for
    // a retired session — so this runs BEFORE `committed`.
    recordHandoff: (paneId, docPath) => {
      if (handoffKind() !== "orchestrator") return;
      try {
        orchestratorDeps.saveRuntime({
          ...orchestratorDeps.runtime(),
          relay: { handoffPath: docPath, successorPane: paneId, at: new Date().toISOString() },
        });
      } catch { /* the handover must not fail because a diagnostic row could not be written */ }
    },
    ...(readJudgeSideEnv(process.env) ? { requestSuccession: judgeSuccessionRequest } : {}),
    extraEnv: () => handoffExtraEnv(handoffKind()),
    now: () => Date.now(),
  };
  /**
   * THE JUDGE'S HANDOVER — a judge that ran out of room opens the next
   * generation itself, because the round is ITS to finish.
   *
   * WHY THE JUDGE AND NOT THE OPENER. A reviewer's rotation between rounds is
   * the opener's decision (lib/judge-rotation.ts) and stays that way. But a
   * judge that hits the threshold IN THE MIDDLE of a round cannot wait for the
   * next dispatch: the round it is holding is the one that would blow up. It
   * opens the successor beside itself, points it at the handoff document it
   * just wrote, and the new session's first tool call proves the takeover —
   * at which point the gate closes THIS pane, exactly as it does for every
   * other kind of session.
   *
   * The new id is derived from this one, so the chain is readable, and the
   * table is updated ON DISK so the opener's next sweep finds the new channel.
   */
  async function judgeSuccessionRequest(
    docPath: string,
  ): Promise<{ ok: true; detail: string } | { ok: false; reason: string }> {
    const side = readJudgeSideEnv(process.env);
    if (!side) return { ok: false, reason: "本会话不是 judge" };
    const ownPane = (process.env.TMUX_PANE ?? "").trim();
    if (!ownPane) return { ok: false, reason: "judge pane 不在 tmux 里，无法开新一代会话" };
    // THE TABLE HAS TO BE LOADED FIRST (2026-09-14, measured in the lab): a
    // judge process does not touch the registry on the way up, so without this
    // `judgeHierarchy` is empty, `entry` is undefined, and the handover leaves
    // the opener pointing at a session that no longer exists. The load is
    // idempotent, so the ordinary (already-loaded) path costs a Set lookup.
    ensureHierarchyLoaded(cwd);
    const entry = judgeHierarchy()[side.judgeId];
    const successorId = successorSessionId(side.judgeId, handoffGeneration(side.judgeId) + 1);
    const opened = await openSessionWindow(runTmux, {
      scope: tmuxScope,
      ownPane,
      cwd,
      layout: "beside-opener",
      command: ["pi", "--session-id", successorId, successorOpeningMessage(docPath, "judge")],
      role: {
        kind: "successor",
        env: successorEnv({
          kind: "judge",
          predecessorPane: ownPane,
          handoffDoc: docPath,
          ...(state.sessionId ? { predecessorSessionId: state.sessionId } : {}),
          extra: {
            [JUDGE_OPENER_ENV]: side.openerId,
            [JUDGE_ID_ENV]: successorId,
            [JUDGE_ROLE_ENV]: side.role,
            ...(entry?.streamPath ? { [JUDGE_STREAM_ENV]: entry.streamPath } : {}),
          },
        }),
      },
    });
    if (!opened.ok) return { ok: false, reason: opened.error };
    if (entry) {
      const next: HierarchyTable = { ...judgeHierarchy() };
      delete next[side.judgeId];
      next[successorId] = { ...entry, judgeId: successorId, paneId: opened.paneId };
      setHierarchy(next);
      try { persistJudgeHierarchy(); } catch { /* the opener still sees the new channel after a reload */ }
    }
    return {
      ok: true,
      detail:
        `新一代 judge 会话已在 pane ${opened.paneId} 启动（${successorId}），` +
        "它会接着这一轮审查；门禁会在它读到交接文档后关掉本 pane。",
    };
  }

  registerSessionHandoffTool(pi, handoffDeps);

  // `context_status()` — the same measurement, handed to the session that owns
  // it (user requirement, 2026-09-14). It is registered beside the handoff tool
  // because they answer halves of one question: how full am I, and what to do
  // about it. Judges get it too: a judge out of context is what handovers are
  // for, and it is the one session nobody can re-ask later.
  registerContextStatusTool(pi, {
    usage: () => {
      try { return latestCtx?.getContextUsage?.(); } catch { return undefined; }
    },
    docPath: () => (state.sessionId ? handoffDocPath(cwd, state.sessionId) : undefined),
  });

  /**
   * THE REMINDER — the whole of what the gate does by itself.
   *
   * It is computed from the session's OWN reading, taken through the same
   * `contextPercentOf` wrapper every other usage read uses, and it renders the
   * document skeleton on the way (the agent has to have somewhere to write its
   * paragraph BEFORE it decides to call the tool). Nothing is opened, nothing
   * is closed and nothing is blocked here: reaching the threshold produces a
   * sentence and a file, and the agent decides when the work is at a stopping
   * point (user decision, 2026-09-14).
   *
   * A missing reading produces NOTHING. A reminder that fires whenever the host
   * cannot report usage is one its reader learns to ignore.
   */
  function handoffReminderBlock(): string {
    if (handedOff() || !state.sessionId) return "";
    let due: { due: boolean; percent?: number };
    try {
      due = handoffDue(latestCtx?.getContextUsage?.());
    } catch { return ""; }
    if (!due.due || due.percent === undefined) return "";
    const docPath = handoffDocPath(cwd, state.sessionId);
    let pendingFill = true;
    try {
      pendingFill = ensureHandoffDoc(handoffDeps, state.sessionId, docPath).pendingFill;
    } catch { return ""; }
    return "\n\n" + handoffReminder({
      kind: handoffKind(),
      percent: due.percent,
      docPath,
      pendingFill,
    });
  }

  /**
   * THE SUCCESSOR SIDE — the gate closes the predecessor.
   *
   * The asymmetry the protocol is built on used to be "only the successor may
   * close the predecessor" (constraint 12), and the successor was TOLD to do
   * it by hand. MEASURED: a successor that never learned it owed a close left
   * two live sessions behind, so the act moved to the gate — and the proof
   * moved with it (lib/session-handoff.ts's `handoffAccepted`), and the proof
   * is the user's own two-part test: the successor READ the handoff document
   * AND a tool call succeeded. Running the `read` IS that tool call in the
   * ordinary path.
   *
   * Done exactly once per session: a second tool_result must not race a second
   * kill against the first.
   */
  let successionClosed = false;
  pi.on("tool_result", (event) => {
    if (successionClosed || !state.sessionId) return;
    const inherited = readInheritance();
    if (!inherited.predecessorPane) return;
    const readPath = event.toolName === "read"
      ? String((event.input as { path?: unknown } | undefined)?.path ?? "").trim()
      : "";
    // RESOLVE IT BEFORE COMPARING (reviewer P2, 2026-09-14): pi's read tool
    // accepts a relative path, and `handoffDocPath` always renders an absolute
    // one — so a successor that read the document as `.pi/handoff/x.md` would
    // never prove its takeover and the predecessor pane would sit there
    // forever. A path that cannot be resolved is simply not a match.
    const resolvedRead = readPath.length === 0 ? "" : pathResolve(cwd, readPath);
    const accepted = handoffAccepted({
      readHandoffDoc: event.isError !== true && inherited.handoffDoc !== undefined &&
        resolvedRead === inherited.handoffDoc,
      firstToolSucceeded: event.isError !== true,
    });
    if (!accepted) return;
    successionClosed = true;
    const closed = closeSessionPane(runTmux, inherited.predecessorPane);
    try {
      latestCtx?.ui?.notify(
        closed.ok
          ? `review-gate: 接手成功，前任 pane ${inherited.predecessorPane} 已关闭。`
          : `review-gate: 接手成功，但关闭前任 pane ${inherited.predecessorPane} 失败 —— ${closed.error}`,
        closed.ok ? "info" : "warning",
      );
    } catch { /* headless */ }
  });

  // The orchestration's exit contract, the revival / supervision clocks and the
  // orchestrator's settle continuation live in lib/orchestrator-runtime-host.ts
  // (wired below, beside the session name whose heartbeat it also owns).

  /**
   * How many DECORATED child panes this session still owns — the number the
   * label-bar release used to consult, and now consulted by nobody.
   *
   * KEPT AS A KNOWLEDGE NOTE, NOT AS CODE (2026-09-17, user decision): the
   * release is gone, and with it every reader of this count. `declare_done`
   * reports live CHILDREN from the registry directly (`orchestrator-gate.ts`),
   * so nothing here is load-bearing any more.
   */

  /**
   * `labelBarOwnedByOthers()` stood here — the "is this session only a GUEST
   * in someone else's orchestration window" predicate, which existed solely to
   * decide whether a close could take the window's shared border options down.
   * GONE with that decision (2026-09-17, user decision): the bar is turned on
   * by whoever opens a decorated pane and is never turned off, because the
   * toggle resizes every pane in the window (measured: SIGWINCH, rows 84 ↔ 83)
   * and its guest test was wrong in both directions across sessions.
   */



  // (Process-era completion watcher deleted with the pane migration: a pane
  // has no exit event to listen on. Completion arrives as a channel report
  // consumed by judge_wait — the wait is the completion path.)
  /**
   * THE registry of pane judges, its persistence, identity and model health
   * (lib/judge-registry-host.ts), the round's review target
   * (lib/review-target-host.ts) and what a round launches on
   * (lib/judge-launch-host.ts). `judgeHierarchy()` is an ACCESSOR: the table
   * is reassigned on every write, so it is read fresh at every use.
   */
  const {
    judgeHierarchy,
    pendingAudits,
    setHierarchy,
    dropAudits,
    persistJudgeHierarchy,
    ensureHierarchyLoaded,
    reloadJudgeHierarchy,
    callerIdentity,
    callerIdentities,
    paneOwnerIdentity,
    ownJudges,
    ownLiveJudges,
    listServerPanesForThisSession,
    activeJudgeWait,
    judgeRoundReported,
    channelLastActivity,
    judgeModelHealth,
    absorbJudgeModelEvents,
    judgeCurrentRound,
    dropDeadForeignJudges,
    nextJudgeRound,
  } = createJudgeRegistry(host, {
    runTmux: (argv) => runTmux(argv),
    channelIO,
    roundBindingOf: (judge) => roundBindingOf(judge),
    copilotWaitSince: () => copilotWaitSince,
  });
  const { reviewTargets, noteQualityRoundDispatched, qualityRoundInFlight } =
    createReviewTargets(host, { ownLiveJudges });
  const { resolveJudgeLaunch, sweepStaleJudgeSessionDirs } = createJudgeLaunch(host, {
    freshProjectConfig: (root) => freshProjectConfig(root),
    ensureModelLayersRendered: (ctx, cfg, root) => ensureModelLayersRendered(ctx, cfg, root),
    judgeModelHealth,
    judgeHierarchy,
  });

  /**
   * The tmux sessions the WORKER registry names, read on demand.
   *
   * WHY IT IS READ RATHER THAN REMEMBERED: the declaration has to include them,
   * and a relay successor or a takeover closes the PREVIOUS seat's worker windows
   * without ever having dispatched one — nothing in memory names them, and a list
   * built only from memory would refuse exactly those closes (quality round P2).
   * It is one small local file read next to a tmux subprocess; the cost is not the
   * read.
   */
  const workerRegistrySessions = (): Array<string | undefined> => {
    try {
      const registry = parseWorkerRegistry(readJsonIfExists(pathJoin(activeRepoRoot.current, WORKER_REGISTRY_RELPATH)));
      // ONLY THE ROWS OF THIS SESSION'S LINE (2026-09-25, t4 whole-branch
      // review P1). This file is per REPO, not per session, so a second gate
      // session working here keeps ITS workers in it too — and every one of
      // those names would widen OUR executor declaration: another session's
      // session is still somebody else's, and its marker is a real one, so the
      // ownership probe below has nothing to refuse. `ownJudges()` does this
      // job for the judge table; this is the worker half of the same rule.
      //
      // BOTH ID FLAVOURS ARE THE LINE: a judge row records `callerIdentity()`
      // (the ORCHESTRATION id in project-manager mode), a worker row records
      // the plain `sessionId` (worker-tools.ts `openerId`). A filter that knew
      // only one of them would drop the project manager's own workers.
      const line = new Set<string>(callerIdentities());
      const own = state.sessionId?.trim();
      if (own) line.add(own);
      return Object.values(registry)
        .filter((entry) => line.has(entry.openerId))
        .map((entry) => entry.tmuxSession);
    } catch {
      // No registry yet, or an unreadable one: both mean "nothing recorded",
      // which only ever narrows the list.
      return [];
    }
  };

  /**
   * THE OWNERSHIP PROBE — the marker read that turns a name some registry
   * mentions into a session this process may actually DECLARE (2026-09-25, t4
   * whole-branch review P1). It rides the raw runner rather than the wrapper
   * below, so the probe cannot recurse into the declaration it is building.
   */
  const sessionOwnership = createOwnershipProbe(tmuxScope, (argv) => rawTmux(argv));

  /**
   * THE RUNNER, and the only one this file uses (2026-09-25).
   *
   * It carries THIS session's declaration on every call, which is what makes
   * "the gate may only touch sessions of its own" true at the executor too: the
   * four session commands (`new-session` / `new-window` / `kill-window` /
   * `kill-session`) are refused unless their target is one of the sessions this
   * process holds coordinates for.
   *
   * THE LIST IS WIDER THAN ONE NAME, and deliberately: a relay successor owns
   * the previous seat's windows (`callerIdentities()` counts them as its own),
   * and those live in the PREDECESSOR's session — a successor that could only
   * declare its own name could never close the windows it exists to reclaim
   * (quality round P1, 2026-09-25). It is also NARROWER than "every row in the
   * file": the judge table is shared with other sessions in this repo, so only
   * `ownJudges()` — my own rows and the lineage's — may widen it (quality round
   * P2).
   *
   * IT IS DECLARED HERE, AFTER `judgeHierarchy`, and not beside `tmuxScope`: the
   * wrapper closes over both registries, and a `let` read before its own
   * declaration has executed is a TDZ error — a call during startup would throw
   * instead of merely being refused.
   *
   * WHY A WRAPPER INSTEAD OF PASSING THE DECLARATION AT EACH CALL SITE: there
   * are a dozen of them (every tool's deps, the judge close helpers, the
   * declare_done cascade), and a rule one caller can forget is a rule that is
   * already broken. The raw runner is imported under a different name so that
   * forgetting is not expressible: there is no unguarded `runTmux` in scope.
   */
  const runTmux = (argv: readonly string[], env?: NodeJS.ProcessEnv, extraSessions?: readonly string[]) =>
    rawTmux(argv, env ?? process.env, {
      ownSessions: addressableSessions(
        tmuxScope,
        [
          ...ownJudges().map((entry) => entry.tmuxSession),
          ...(state.orchestrator?.children ?? []).map((child) => child.tmuxSession),
          ...workerRegistrySessions(),
        ],
        sessionOwnership,
        // SESSIONS THIS CALL PROVED ARE GATE SESSIONS ANYWAY (2026-09-25, t2).
        // The orphan sweep kills the dedicated session of a session that is
        // GONE — nobody alive can declare that name, so it arrives here already
        // marker-verified (lib/session-registry.ts reads `@rg_scope_owner` and
        // compares it with the dead entry's session id before building the
        // kill). It passes as PROVEN rather than as a candidate: a sweep's
        // target belongs to a dead session, so no marker of OURS vouches for it
        // and the probe would refuse it (t4 review P1).
        extraSessions,
      ),
    });

  /**
   * THE SESSION'S OWN NAME (2026-09-25, t2) — the tool, the registry, the
   * heartbeat and the sweep, built once and wired at the moments below.
   *
   * A REGISTRY RATHER THAN GATE STATE, and deliberately: the name is global
   * (it has to be reachable from a session in another repository), it is
   * renewed by a timer, and it is read by processes that never share this
   * session's state — `~/.pi/agent/rg-sessions/<name>.json` is the unit, one
   * file per name (lib/session-registry.ts says why that layout, and why a live
   * holder is never evicted).
   */
  const sessionNaming = createSessionNaming({
    runTmux,
    sessionId: () => state.sessionId?.trim() || undefined,
    ownPane: () => process.env.TMUX_PANE?.trim() || undefined,
    // THE SERVER HALF OF THE COORDINATES (t4 review P1): recorded so a later
    // reader never compares a pane id against a different tmux server's ids.
    tmuxServer: () => tmuxServerFrom(process.env),
    repoRoot: () => primaryRepoRoot,
    cwd: () => cwd,
    mode: () => ownSessionKind(),
    // A COARSE READING IS ENOUGH FOR THE REGISTRY: the question it answers is
    // "is anybody there", and the heartbeat is what proves that.
    state: () => (latestCtx?.isIdle?.() ? "idle" : "working"),
    scopeSession: () => tmuxScope.read()?.name,
    log: (message) => log(`review-gate[session-name] ${message}`),
    onLost: (reason) => {
      // NOT A SILENT LOSS: the session is told the moment its renewal finds the
      // name gone, because everything that addressed it by name now reaches
      // somebody else (or nobody).
      log(`review-gate[session-name] ${reason}`);
      try { latestCtx?.ui?.notify?.(`review-gate: ${reason}`, "warning"); } catch { /* headless */ }
    },
  });

  /**
   * ONE SESSION MESSAGING ANOTHER (2026-09-25, t3) — the sender's judgement and
   * the recipient's inbox, built once right beside the name that addresses it.
   *
   * The two share the registry root on purpose: a name IS the address, so the
   * module that answers “who holds this name” and the module that writes TO it
   * must look at the same directory, and the path rule stays t2's
   * (`sessionInboxPath`). The inbox IO is its own seam because consuming needs
   * two primitives the channel never did (rename, remove) — see
   * lib/session-message-tools.ts.
   */
  const sessionRegistryRootDir = sessionRegistryRoot();
  const sessionRegistryFiles = nodeRegistryIO(sessionRegistryRootDir);
  const sessionMessaging = createSessionMessaging({
    root: sessionRegistryRootDir,
    io: nodeInboxIO(),
    // WHO IS STILL A SESSION is the registry's own answer (t2): the sender PICKS a
    // name, it never re-decides liveness here.
    liveSessions: () => liveSessionNames({
      root: sessionRegistryRootDir,
      io: sessionRegistryFiles,
      runTmux: (argv) => runTmux(argv, undefined),
      alive: pidAlive,
      // WHICH SERVER THIS PROCESS IS ON (t4 review P1): without it the liveness
      // rule cannot tell a recorded pane id from a stranger's after a restart,
      // and the sender would write mail to a holder that is gone.
      tmuxServer: () => tmuxServerFrom(process.env),
    }),
    self: () => ({
      name: sessionNaming.currentName(),
      sessionId: state.sessionId ?? "",
      repo: primaryRepoRoot,
      mode: ownSessionKind(),
    }),
    // THE INJECTION IS A STEER: the recipient finishes the tool call it is in
    // the middle of and then reads this — it never aborts somebody's turn.
    inject: (text) => { pi.sendUserMessage(text, { deliverAs: "steer" }); },
    log: (message) => log(`review-gate[session-message] ${message}`),
  });

  /**
   * THE SESSION'S RUNTIME CLOCKS (lib/orchestrator-runtime-host.ts): the
   * unified exit criterion, the revival and supervision timers, the
   * orchestrator's settle continuation, the retirement flag they all honour,
   * and the name's heartbeat (which also drains the inbox).
   */
  const {
    orchestrationDoneProblems,
    sessionExitProblems,
    orchestratorSettled,
    startRevivalTimer,
    stopRevivalTimer,
    stopSupervisionTimer,
    startSessionNamingHeartbeat,
    stopSessionNamingHeartbeat,
    handedOff,
    markHandedOff,
    resetOrchestratorContinuations,
  } = createOrchestratorRuntime(host, {
    pi,
    orchestratorDeps,
    channelIO,
    currentOrchestrationId: () => currentOrchestrationId(),
    lastRunAborted: () => lastRunAborted,
    arbitrationPaused: () => arbitrationPaused,
    updateWidget: (ctx) => updateWidget(ctx),
    goalStageSatisfied: () => goalStageSatisfied(),
    copilotProblemsFor: (st) => copilotProblemsFor(st),
    repoLabel: (root) => repoLabel(root),
    projectConfig: () => projectConfig,
    sessionNaming,
    sessionMessaging,
  });
  // THE NAME GOES BACK WHEN THE PROCESS DIES, however it dies (t2): the ONE
  // handler for that lives at module scope (it must survive session
  // replacement), and this line points it at THIS session's runtime.
  sessionNamingAtExit = sessionNaming;

  // `name_session()` — THE SESSION'S OWN NAME (2026-09-25, t2). Registered for
  // EVERY kind of session (user decision): a window title and a status line are
  // worth the same to a judge pane as to a loop session, and a name is how
  // another session addresses this one (`@名字`, t3). Naming yourself is not one
  // of the things a reporting shell may not do (`JUDGE_DENIED_TOOLS` is that
  // list, and this tool is not on it).
  sessionNaming.register(pi);

  // `send_message()` — ONE SESSION ADDRESSING ANOTHER BY NAME (2026-09-25, t3).
  // Registered for EVERY kind of session (user decision), exactly like the name
  // above: a judge pane or a worker is reachable the same way a loop session is,
  // and its inbox poll rides the same heartbeat. Receiving is unconditional;
  // SENDING requires a name of one's own, which the tool itself enforces.
  sessionMessaging.register(pi);

  function classifier(): LlmClassifier {
    if (!llmClassifier || llmClassifierModel !== projectConfig.llmGuards.model) {
      llmClassifier = createLlmClassifier(projectConfig.llmGuards.model);
      llmClassifierModel = projectConfig.llmGuards.model;
    }
    return llmClassifier;
  }

  /**
   * sd0x-dev-flow R10 "Think Harder": one-shot strategic-reset checklist when
   * the loop is BLOCKED close to the round cap. The firing predicate is the
   * pure, unit-tested shouldStrategicReset() (review verdict must be BLOCKED —
   * a READY loop merely awaiting precommit must NOT consume the one-shot).
   * Returns the checklist text to append (and marks it fired), or "".
   * The state parameter defaults to the primary `state` so a missed
   * argument can never dereference undefined (the P-multi signature change
   * to `st: GateState` left the L2 auto-continuation call bare, which
   * threw inside shouldStrategicReset).
   */
  function maybeStrategicReset(st: GateState = state): string {
    if (!shouldStrategicReset(st, projectConfig.thinkHarder, STRATEGIC_RESET_OFFSET)) return "";
    st.strategicResetFired = true;
    return "\n\n" + STRATEGIC_RESET_CHECKLIST;
  }

  // ---------- persistence ----------

  /** Said once per session — the skip is a standing fact, not an event. */
  let gateStateSkipAnnounced = false;

  /**
   * Is this session barred from writing gate state, and if so, RECORD it.
   *
   * The record deliberately lands nowhere near the repo: `pi.appendEntry`
   * writes into pi's own session store (`~/.pi/agent/sessions/…`) and the
   * notice goes to this pane. A log file under `.pi/judge-sessions/…` would
   * still be the judge writing into the repository it is reviewing, which is
   * the very thing being fixed.
   */
  function noteGateStatePersistSkip(ctx?: ExtensionContext): boolean {
    const skip = gateStateWriteSkip(process.env);
    if (!skip) return false;
    if (!gateStateSkipAnnounced) {
      gateStateSkipAnnounced = true;
      try { pi.appendEntry(GATE_STATE_SKIP_ENTRY, { ...skip, at: new Date().toISOString() }); }
      catch { /* older Pi without appendEntry — the notice below still tells someone */ }
      try { ctx?.ui.notify(skip.reason, "info"); } catch { /* headless */ }
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────
  // THE BANNER CHANNEL (user decision, 2026-09-17) — DEPS ASSEMBLY ONLY.
  //
  // The gate used to write an OSC escape to stdout and hope tmux forwarded it;
  // it does not reliably (lib/user-notify.ts carries the measurement), and the
  // manager could fire one whenever it liked. Both are gone.
  //
  // WHERE EACH HALF LIVES, and why: the POLICY (three kinds, who may send,
  // argv, the click command) is lib/user-notify.ts; the RUNTIME (the resolved
  // notifier, this session's tmux address, the spawn, the exit handler) is
  // lib/user-notify-runtime.ts; and this file supplies the session's own
  // plumbing and calls four methods. Two quality rounds asked for that split
  // (an extension that is already ~9000 lines must not grow a fourth job) and
  // both modules are testable without a session because of it.
  // ─────────────────────────────────────────────────────────────────────
  const notifyRuntime = createUserNotifyRuntime({
    state: () => state,
    persist: () => persist(latestCtx),
    repoName: () => pathBasename(primaryRepoRoot),
    taskMode: () => state.taskMode,
    env: () => process.env,
    interactive: () => sideEffectsEnabled(process.env, process.stdout.isTTY === true),
    // The gate's own tmux runner: argv, no shell, and it refuses global option
    // writes on the way (lib/orchestrator-tmux.ts).
    runTmux: (argv) => runTmux(argv),
  });
  // KIND TWO of three is registered once, for the whole process: the handler
  // is inside the runtime, and `markCleanShutdown` (called by the
  // `session_shutdown` handler below) is what tells it a `/quit` from a crash.
  notifyRuntime.armExitHandler();
  /** Raise the banner for one event. Never throws; never claims delivery. */
  const raiseBanner = (opts: { kind: UserNotifyKind; detail: string; blocking?: boolean }) =>
    notifyRuntime.notify(opts);

  // `ctx` is optional because it is used for ONE thing — refreshing the status
  // widget. A caller that has no context (the orchestration tools persist from
  // a callback) must still be able to write the record: dropping the write
  // instead would lose the user's plan approval on a restart.
  function persist(ctx?: ExtensionContext) {
    // A judge and a worker write NO gate state (lib/session-exclusivity.ts
    // explains why — it is the same question as the exclusivity guard). Checked
    // here, at the single funnel every gate-state write goes through, rather
    // than at each call site — a new caller must not be able to reintroduce it.
    if (noteGateStatePersistSkip(ctx)) return;
    // Nor does a session another one holds this worktree against: that sidecar
    // is the HOLDER's — its mode, its verdicts, its unmet list — and the whole
    // point of refusing is that these two must not overwrite each other. (The
    // refusal itself is memory-only; saveSidecar strips it as well.)
    if (state.exclusivityRefusal) return;
    // Nor does a RETIRED orchestrator: it handed the orchestration to a
    // successor, and the successor now owns this sidecar. The successor is
    // admitted into this SAME worktree on purpose (one orchestration id, no
    // child restarted), which is exactly the "two sessions, one sidecar"
    // situation the exclusivity guard exists to prevent — so the predecessor
    // is the one that has to stop writing. Without this, a wake-up that
    // slipped past the retirement guards would rewrite the plan and child
    // registry the successor is working from.
    if (handedOff()) return;
    // P-multi: persist the session's repo set so a same-session resume (or
    // restart) re-arms declare_done against every repo this session edited.
    state.sessionReposPaths = [...sessionRepos].filter((r) => r !== primaryRepoRoot);
    try {
      saveSidecarPreservingConcurrent(sessionSidecarPath(cwd), state, () => digestForMerge(cwd));
      // Our own earlier write failure (if any) is resolved: reclaim OUR owner
      // entry — and any owner whose session has been silent past the
      // concurrent-session window — but never a live foreign one.
      reconcileBlockedMarker(blockedMarkerPath(sessionSidecarPath(cwd)), { sessionId: state.sessionId });
    } catch {
      recordBlockedMarker(blockedMarkerPath(sessionSidecarPath(cwd)), { sessionId: state.sessionId });
    }
    try {
      // Store continuation count alongside state so it survives restarts.
      pi.appendEntry(ENTRY_TYPE, { state, continuationsInjected });
    } catch { /* older Pi without appendEntry */ }
    if (ctx) updateWidget(ctx);
  }

  function restore(ctx: ExtensionContext, sessionId: string | null) {
    let restored: GateState | undefined;
    let restoredInjections = 0;
    try {
      const entries = ctx.sessionManager.getEntries() as Array<{
        customType?: string; data?: { state?: GateState; continuationsInjected?: number };
      }>;
      // Newest entry wins; scan backward and stop at the first match so a
      // long session (persist appends one entry per state change) doesn't
      // deserialize every historical snapshot.
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if ((e.customType) === ENTRY_TYPE && e.data?.state?.schema === 1) {
          restored = e.data.state;
          if (typeof e.data.continuationsInjected === "number") restoredInjections = e.data.continuationsInjected;
          break;
        }
      }
    } catch { /* session manager unavailable */ }

    // Fall back to sidecar for cross-process state (L3 hooks read it).
    // loadSidecar() applies the fingerprint migration itself (so it can never
    // be forgotten), which means the result must be collected HERE — asking
    // migrateFingerprintVersion() again below would report "no migration",
    // and the user would watch READY become PENDING with no explanation.
    const sidecarMigration = { migrated: false };
    if (!restored) {
      restored = loadSidecar(sessionSidecarPath(cwd), sidecarMigration);
    }

    // Sidecar corruption detection: file exists but couldn't parse → fail-closed.
    const sidecarFile = sessionSidecarPath(cwd);
    let sidecarCorrupt = false;
    try {
      if (existsSync(sidecarFile) && statSync(sidecarFile).isFile() && !restored) {
        sidecarCorrupt = true;
      }
    } catch { /* best effort */ }

    if (restored?.taskMode !== undefined && normalizeTaskMode(restored.taskMode) === undefined) {
      delete restored.taskMode;
    }

    if (restored && restored.sessionId === sessionId) {
      state = restored;
      continuationsInjected = restoredInjections;
      // The orchestration runtime that came with it keeps its OWN
      // `ownerSessionId` — that field, not this branch, is what answers "may
      // this session resume it" (see `currentOrchestrationId`).
    } else if (restored && restored.sessionId !== sessionId) {
      state = emptyState(sessionId, restored.maxRounds ?? DEFAULT_MAX_ROUNDS);
      // THE ORCHESTRATION RUNTIME SURVIVES THE RESET (2026-09-06, B1).
      //
      // Everything else here describes THIS session's round — its verdict,
      // its precommit, its edits — and a new session owns none of it. The
      // orchestration runtime is the one field that describes something
      // OUTSIDE the session: which orchestration this repo runs, and which
      // child sessions are registered under it. Those children are panes that
      // are still alive; they did not stop existing because their supervisor's
      // process did. Dropping it cost the same bug twice — a RELAY successor
      // (a plain `pi`, hence a fresh session id) lost the predecessor's whole
      // registry, and a TAKEOVER had nothing left to take over.
      //
      // The APPROVAL does not survive — UNLESS this process is the
      // predecessor's own handoff successor, and THAT asymmetry is the point.
      // The registry is a fact about the world; the approval is permission the
      // user gave to a session that is gone, so an ordinary new session (and a
      // takeover through `orchestrator_attach`, which carries no handoff
      // marker either) re-obtains it — one dialog, and no session nobody
      // approved can spawn children. A RELAY SUCCESSOR is the one case where
      // the same permission was given to the same WORK, minutes ago, in this
      // same worktree: re-obtaining it there costs the restatement dialog, the
      // plan re-audit and the plan approval dialog for a requirement not one
      // word of which changed (measured — that is what a project-manager
      // handover actually cost the user). The 2026-09-06 decision is narrowed
      // to the sessions it was about, and WHICH sessions those are is one
      // answer: `isHandoffSuccessorOf` checks the handoff marker against the
      // session id the sidecar itself records, so the approval cannot ride
      // into a session a THIRD session's state happens to be sitting there
      // for. WHICH fields carry that permission is
      // lib/orchestrator-registry.ts's to know, not this call site's: spelled
      // out here, the list silently went stale the moment the approval grew a
      // field (`approvedPlanHistory` would have ridden into the new session
      // and let it write the plan back to a content it was never granted).
      const relaySuccessor = isHandoffSuccessorOf(process.env, restored.sessionId);
      if (restored.orchestrator) {
        state.orchestrator = successorRuntime(restored.orchestrator, relaySuccessor);
      }
      // …and the successor's own contracts travel the same way: what the user
      // confirmed the requirement is, the goal they approved, and the round
      // budget a handover must not reset. The rule (and what deliberately does
      // NOT carry) is lib/gate-state.ts's.
      if (relaySuccessor) state = inheritGoalContract(state, restored);
    } else if (sidecarCorrupt) {
      state = emptyState(sessionId, DEFAULT_MAX_ROUNDS);
      state.hasCodeChange = true;
      state.hasDocChange = true;
    } else {
      state = emptyState(sessionId, DEFAULT_MAX_ROUNDS);
    }

    // A binding produced by a DIFFERENT fingerprint algorithm cannot be
    // verified by this one, so it is invalidated here rather than trusted.
    // Recorded for session_start to surface — without an explanation the user
    // just sees a READY silently become PENDING after an upgrade.
    // Either source can carry a stale binding: the session entry is migrated
    // by this call, the sidecar was already migrated inside loadSidecar().
    fingerprintMigrated = migrateFingerprintVersion(state) || sidecarMigration.migrated;

    // (A "another session wrote this sidecar recently" WARNING used to be
    // built here. It is gone: `applySessionExclusivity` decides the same
    // question from a heartbeat and either refuses or takes the claim, and two
    // definitions of "another session is alive" is one too many — 哲学三.)
  }

  let lastLayerNotifyText = "";
  /**
   * The agents-layer key of the config the model layers were last rendered
   * from (null = nothing rendered yet this session). `ensureModelLayersRendered`
   * is called at session start AND before every judge dispatch, and the
   * renderer writes unconditionally — this is what keeps the dispatch-time
   * call a no-op until the config actually changes on disk.
   */
  let lastRenderedAgentsKey: string | null = null;
  /** Disk registry merged with the SESSION's runtime registry. The runtime
   *  view is authoritative (built-in anthropic catalogs never reach
   *  models-store.json): validating a
   * a stale render deployed (round-2 P1). */
  function modelConfigRegistry(ctx: ExtensionContext): ModelRegistry {
    const merged = loadRegistry();
    try {
      const reg = (ctx as { modelRegistry?: unknown }).modelRegistry as { getAll?: () => unknown[] } | undefined;
      const all = typeof reg?.getAll === "function" ? reg.getAll() : [];
      for (const m of all) {
        const obj = m as { provider?: unknown; id?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown };
        if (typeof obj.provider !== "string" || typeof obj.id !== "string") continue;
        const list = (merged[obj.provider] ??= [] as RegistryModelInfo[]);
        // The runtime entry REPLACES any same-id disk entry — the runtime view
        // is authoritative, and keeping the disk metadata could preserve a
        // stale thinkingLevelMap that refuses levels the live registry
        // supports (round-3 P1).
        const tlm = obj.thinkingLevelMap;
        const info: RegistryModelInfo = {
          id: obj.id,
          ...(typeof obj.reasoning === "boolean" ? { reasoning: obj.reasoning } : {}),
          // Filter the map the same way loadRegistry / factsFromRegistry do:
          // a bare cast let a malformed value (a number, an object) through as
          // if it were a valid mapping, and validateSpec then ACCEPTED a level
          // the filtered semantics refuse (deployed ≠ validated).
          thinkingLevelMap: typeof tlm === "object" && tlm !== null && !Array.isArray(tlm)
            ? Object.fromEntries(
                Object.entries(tlm).filter(([, mapped]) => mapped === null || typeof mapped === "string"),
              ) as Record<string, string | null>
            : undefined,
        };
        const idx = list.findIndex((e) => e.id === obj.id);
        if (idx >= 0) list[idx] = info;
        else list.push(info);
      }
    } catch { /* runtime registry unusable — the disk view stands */ }
    return merged;
  }

  /**
   * The agents-layer key of one config snapshot, for the change guard below.
   *
   * Whatever the JSON is, the RENDERED files depend on exactly these values:
   * the two agents sections and the two corrupt flags (a corrupt layer keeps
   * the last render instead of sweeping it).
   */
  function agentsLayerKey(cfg: ProjectConfig): string {
    return JSON.stringify([cfg.agentsGlobal ?? null, cfg.agentsProject ?? null, cfg.agentsGlobalCorrupt ?? false, cfg.agentsProjectCorrupt ?? false]);
  }

  /**
   * The agents layer AS IT IS ON DISK RIGHT NOW (the dispatch-time read).
   *
   * WHY THIS EXISTS (2026-09-10, measured in rebate): `projectConfig` is
   * loaded ONCE per session start, and the judge dispatch read its model chain
   * from that in-memory snapshot. A user who edited `~/.pi/review-gate.json`
   * mid-session kept getting the OLD chain launched — while the judge pane's
   * own session start re-rendered `.pi/agents/*.md` from the NEW one, so the
   * file on disk and the model actually running contradicted each other.
   *
   * A corrupt layer keeps the snapshot's value (corrupt ≠ absent: treating it
   * as "unconfigured" would sweep a valid chain back to the built-in default).
   */
  function freshProjectConfig(root: string): ProjectConfig {
    const fresh = loadProjectConfig(root);
    return {
      ...fresh,
      agentsGlobal: fresh.agentsGlobalCorrupt ? projectConfig.agentsGlobal : fresh.agentsGlobal,
      agentsProject: fresh.agentsProjectCorrupt ? projectConfig.agentsProject : fresh.agentsProject,
      agentsGlobalCorrupt: fresh.agentsGlobalCorrupt ?? projectConfig.agentsGlobalCorrupt,
      agentsProjectCorrupt: fresh.agentsProjectCorrupt ?? projectConfig.agentsProjectCorrupt,
    };
  }

  /**
   * Re-apply BOTH model-config layers once per session start: global
   * (~/.pi/agent/agents) AND the current repo's project layer
   * (<primaryRepoRoot>/.pi/agents, which outranks global).
   *
   * `scripts/install-package.mjs` imports lib/model-config.ts through a
   * stripped data URL (which works under node_modules), so the postinstall DOES
   * render the global layer on a published install — but only the extension
   * ever renders the PROJECT layer, and only the extension re-renders after the
   * config changes between installs.
   *
   * It also sweeps stale generated overrides when the `agents` section is gone:
   * every agent then defaults to auto:true, whose renderer deletes generated
   * products in that layer. Hand-written / upstream copies are never touched
   * (no marker). Idempotent (the same slots re-render the same overlay) and
   * fail-soft (a render failure never blocks a session); a corrupt layer keeps
   * the last good render instead of sweeping it.
   */
  function ensureModelLayersRendered(ctx: ExtensionContext, cfg: ProjectConfig = projectConfig, root: string = primaryRepoRoot): void {
    // CHANGE GUARD (2026-09-10): the renderer writes unconditionally, so the
    // dispatch-time call below must not re-write four agent files per judge
    // round. The same config renders the same files — one key is enough.
    // `null` means "nothing rendered yet this session", so the first call
    // (session start) always renders.
    const cfgKey = agentsLayerKey(cfg);
    if (lastRenderedAgentsKey === cfgKey) return;
    lastRenderedAgentsKey = cfgKey;
    const problems: string[] = [];
    try {
      const packageRoot = pathDirname(fileURLToPath(import.meta.url));
      // The package's own agents/ directory, found by PROBING the install
      // layouts (resolvePackageAgentsDir) rather than trusting one relative
      // path: `<packageRoot>/../agents` is only correct in some layouts, and a
      // source that silently fails to resolve turns both the render and the
      // self-heal below into no-ops. Resolved ONCE and shared, so the renderer
      // and the heal can never disagree about where the defaults live — the
      // legacy relative path stays as a last-resort fallback for both.
      const probedAgentsDir = resolvePackageAgentsDir();
      const packageAgentsDir = probedAgentsDir ?? pathJoin(packageRoot, "..", "agents");
      const globalAgentsDir = pathJoin(homedir(), ".pi", "agent", "agents");
      // BOOTSTRAP SELF-HEAL (before any rendering): a role the gate REQUIRES —
      // goal-auditor gates every goal approval — must be dispatchable, or the
      // session deadlocks with no exit but switching the gate off. Filling only
      // the GAPS is idempotent and never clobbers a configured chain.
      const healed = ensureAgentFilesPresent({
        sourceDir: existsSync(packageAgentsDir) ? packageAgentsDir : null,
        targetDir: globalAgentsDir,
        agents: KNOWN_AGENTS,
      });
      if (healed.copied.length > 0) log(`self-healed missing agent files: ${healed.copied.join(", ")}`);
      problems.push(...healed.problems);
      // Global layer. A CORRUPT config file keeps the last good render:
      // treating it as "no agents section" would sweep every generated chain
      // back to the upstream default and clobber the last valid render
      // (corrupt ≠ absent for the renderer).
      if (cfg.agentsGlobalCorrupt) {
        problems.push("global: ~/.pi/review-gate.json is corrupt or its agents section is invalid — keeping the last rendered model chains (fail-safe)");
      } else {
        const { map, diagnostics } = effectiveAgentsConfig(cfg.agentsGlobal ?? undefined, undefined);
        problems.push(...diagnostics);
        problems.push(...cfg.agentsDiagnostics.filter((d) => d.startsWith("global:")));
        const res = applyAgentConfigLayer({
          agents: map,
          targetDir: globalAgentsDir,
          // Infrastructure layer: restore the upstream default on cleanup.
          restoreDefault: true,
          sourceDir: packageAgentsDir,
          registry: modelConfigRegistry(ctx),
        });
        problems.push(...res.errors, ...res.warnings);
      }
      // Project layer of the CURRENT repo (project outranks global) — same
      // fail-safe: a corrupt project file keeps the last project render.
      if (cfg.agentsProjectCorrupt) {
        problems.push("project: .pi/review-gate.json is corrupt or its agents section is invalid — keeping the last rendered model chains (fail-safe)");
      } else {
        const { map, diagnostics } = effectiveAgentsConfig(undefined, cfg.agentsProject ?? undefined);
        problems.push(...diagnostics);
        problems.push(...cfg.agentsDiagnostics.filter((d) => d.startsWith("project:")));
        // (The cross-layer reviewer-readonly guard retired 2026-08-27 with
        // the follow rule: the readonly dispatch path no longer exists.)
        const res = applyAgentConfigLayer({
          agents: map,
          targetDir: pathJoin(root, ".pi", "agents"),
          // Project-layer base is the BUILT-IN default (package agents dir),
          // NEVER the already-rendered global layer — a global auto:false slot
          // render must not leak into a project auto:true shadow (round-7 P1).
          sourceDir: packageAgentsDir,
          registry: modelConfigRegistry(ctx),
        });
        problems.push(...res.errors, ...res.warnings);
      }
    } catch (e) {
      problems.push(`model config layer render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A rejected slot chain must never be silent: the renderer reads the
    // same config, so the user has to see that the DEPLOYED chain and the
    // and the PLANNED chain diverged (round-1 P2). The same problem set is
    // NOT re-notified on every session start (round-2 Nit).
    if (problems.length > 0) {
      const text = `review-gate: model config layer problems (${problems.length}):\n${problems.slice(0, 5).join("\n")}`;
      if (text !== lastLayerNotifyText) {
        lastLayerNotifyText = text;
        try {
          ctx.ui.notify(text, "warning");
        } catch { /* headless — no UI to notify */ }
      }
    }
  }


  /**
   * Is a judge child process (reviewer / quality-auditor / adviser /
   * goal-auditor) still in
   * flight? The stall breaker must not cut the loop off while a judge is
   * working — its verdict is exactly what the unchanged signature is waiting
   * for (round-16 P2: only the subagent scan was consulted, so a waiting
   * reviewer was mid-round).
   *
   * Freshness bound: a child that has been alive
   * since before STALL_MOTION_MAX_AGE_SEC is the HUNG case the breaker
   * exists for, not motion (goal-auditor P2: alive-forever must not
   * disable the breaker).
   */
  function judgeChildInMotion(): boolean {
    const cutoff = Date.now() - STALL_MOTION_MAX_AGE_SEC * 1000;
    // `ownLiveJudges()` for the same reason activeJudgeWait uses it: a
    // persisted entry from a previous process is this opener's judge, but its
    // pane is gone, and "motion" it is not. The age bound below still stands
    // on its own — a live pane that never finishes is the HUNG case.
    return ownLiveJudges()
      .filter((c) => {
        const at = Date.parse(c.spawnedAt);
        return Number.isFinite(at) && at >= cutoff;
      })
      .some((c) => !judgeRoundReported(c));
  }

  // ---------- user-visible output channels ----------
  //
  // The transcript notice (`showToUser`) and the ONE dialog renderer live in
  // lib/gate-dialogs.ts; the thirty-minute stand-in's I/O in
  // lib/dialog-proxy.ts. Created here, before any tool module below captures
  // `askChoice` by value.
  const dialogProxy = createDialogProxy(host, {
    resolveArbiterModel: () => resolveArbiterModel(),
    ownTranscriptPath: () => ownTranscriptPath(),
  });
  const { askChoice, askMultiChoice } = createGateDialogs(host, {
    proxy: dialogProxy,
    raiseBanner: (opts) => raiseBanner(opts),
    lastUserInteractionAt,
  });

  // SECURITY: source is persisted so the git pre-commit hook can distinguish a
  // user-chosen explore/normal (advisory hook) from an agent selection
  // (hook stays fully enforced). The in-session mode decision is made via the
  // set_gate_mode tool (or the user via /gate-mode): the agent classifies the
  // FIRST decision itself, bounded by lib/task-mode.ts — it can pick loop or
  // (while clean) explore without a dialog, but never normal; later changes go
  // through the same consent rules.
  function setTaskMode(mode: TaskMode, source: TaskModeSource, ctx: ExtensionContext) {
    state.taskMode = mode;
    state.taskModeSource = source;
    // A fresh mode decision supersedes a standing question pause: an ENFORCED
    // mode re-arms (explore/normal turn auto-continuation off by definition).
    delete state.pausedQuestion;
    // isEnforcedMode, not `=== "loop"`: an orchestrator session is the one
    // that needs the survival invariant MOST — it supervises children through
    // the night — and it is also the one that can never re-arm the old way,
    // because constraint 2 forbids it from editing code and its plan writes
    // go through a tool, not the edit path. Disarming it here made
    // agent_settled and the child watchdog return early, so the session could
    // end its turn with children still running and gates unmet.
    loopArmed = isEnforcedMode(mode);
    continuationsInjected = 0;
    resetOrchestratorContinuations(); // goal 6 — reset with the loop budget
    completionContinuations = 0;
    loopStall = undefined; // a mode decision is a change of circumstances
    stallNoticeShown = false;
    persist(ctx);
    // MODE-CHANGE NOTIFICATION (user requirement 2026-08-30): every mode
    // transition — via set_gate_mode tool OR /gate-mode command — is
    // reported to the supervising orchestrator as a forced state update, so
    // a child that downgraded to explore/normal (or became an orchestrator)
    // is never silently invisible to the project manager waiting on it.
    // Without this, an orchestrator could wait forever on a child that
    // stopped heartbeating after a mode switch (deadlock).
    reportChildState(ctx, `gate mode → ${mode}`, { force: true, state: "mode-changed" });
  }

  // ---------- L6 (extension side): test-label language, checked at edit time ----------

  // The check itself lives in lib/edit-time-checks.ts; the arbitration I/O it
  // shares a quota with lives in lib/arbitration-host.ts. Both are created
  // HERE, before `shipGateHookDeps` below captures their functions by value.
  const { editedTestContent, checkTestLabels, llmNotice } = createEditTimeChecks(host, {
    projectConfig: () => projectConfig,
    classifier: () => classifier(),
    refuseText: (kind, text, reason, ctx) => refuseText(kind, text, reason, ctx),
  });
  const {
    computeTokenBindings,
    resolveArbiterModel,
    arbitrateText,
    arbitrateInspection,
    bodyFileDigest,
    appendLesson,
    gatherPrText,
    gatherProposedText,
    gatherGitLog,
  } = createArbitrationHost(host, {
    projectConfig: () => projectConfig,
    appealsUsed: () => appealsUsed(),
    spendArbitration: (ctx) => spendArbitration(ctx),
    arbitrationDecisions,
    grantInspectionPass: (pass) => { inspectionPass = pass; },
  });

  // ---------- L1: tool_call — sensitive files + ship gate ----------
  //
  // The hook's BODY lives in lib/ship-gate-hook.ts (+ its two arms,
  // lib/ship-gate-edit-guard.ts and lib/ship-gate-bash.ts). This file keeps
  // only the wiring and the deps: everything the decision cannot own — the
  // session cwd, the per-repo gate state, the git measurements, the LLM
  // classifier, the appeal recorder and the arbiter token — arrives through
  // one injected object, so every branch of L1 is testable without a session.
  const shipGateHookDeps: ShipGateHookDeps = {
    noteContext: (c) => { latestCtx = c as ExtensionContext; },
    // A HINT, not a refusal — and it rides THE CALL'S OWN RESULT (user decision,
    // 2026-09-14). The hook can only block or stay silent, so this is how the
    // gate says "there is a tool for that" without taking the command away; the
    // sentence is collected here and appended to the bash result by
    // `hintRideAlong` below. A separate follow-up message was measured wrong:
    // it arrives after the fact and reads as an interruption from nowhere.
    // Deduplicated per session — the same advice on every iteration of a loop
    // would be noise, and noise is ignored.
    hint: (message) => {
      if (deliveredHints.has(message)) return;
      deliveredHints.add(message);
      pendingHints.push(message);
    },

    isEditTool: (toolName) => EDIT_TOOL_NAMES.has(toolName),
    isJudgeSession: () => readJudgeSideEnv(process.env) !== undefined,
    // THE STAGE FALLBACK (2026-09-22): the box the USER answers once per
    // session, raised by the gate itself when the first edit (or the
    // restatement that precedes it) arrives without a choice on record.
    ensureLoopStages: (ctx) => ensureLoopStagesFor(ctx),
    cwd: () => cwd,
    primaryRepoRoot: () => primaryRepoRoot,
    taskMode: () => state.taskMode,
    relayHandoffPath: () => state.orchestrator?.relay?.handoffPath,
    sensitiveGrants: () => sensitiveGrants,
    sensitiveDeclined: (absPath) => sensitiveDeclinedPaths.has(absPath),
    nearestExistingDir,
    loopGoalEditBlockFor,
    checkTestLabels: (path, input, ctx) => checkTestLabels(
      path,
      editedTestContent(input, path),
      ctx,
      llmNotice(ctx),
    ),
    markSessionEdited: () => { sessionEdited = true; },
    bypassActive: () => state.bypass.active,
    projectConfig: () => projectConfig,
    sessionRepos: () => sessionRepos,
    knownRepoRoots,
    enforcementStateFor,
    stateForRepo,
    repoLabel,
    currentBranch,
    worktreeTree,
    headCommitTree,
    hasStagedChanges,
    unreviewedTreesSince,
    loopGoalConfirmed: () => goalStageSatisfied(),
    deliveryStation: (root) => deliveryStationFor(root),

    crossRepoVerdictHint,
    classifier,
    notice: (ctx) => llmNotice(ctx),
    refuseText,
    appendLesson,
    bypassToken: () => bypassToken,
    setBypassToken: (token) => { bypassToken = token; },
    // The tmux permission is read LIVE off the state: the grant is minted by a
    // dialog mid-session, and a captured value would leave the first command
    // after the grant still refused.
    tmuxAccess: () => state.tmuxAccess,
    consumeTmuxAccess: () => {
      // One use, and only a ONE-SHOT is consumed: a session grant stays until
      // the session (or its successor) ends.
      if (state.tmuxAccess?.scope !== "once") return;
      delete state.tmuxAccess;
      persist(latestCtx);
    },
    clearBypassToken,
    computeTokenBindings,
    setLastBlockedShip: (record) => { lastBlockedShip = record; },
  };

  // ONE `tool_call` handler, TWO jobs, and the order is deliberate: the
  // activity line is refreshed BEFORE the gate decides, so a tool call that
  // gets blocked is still the last thing this session tried to do (the
  // receipt's answer to "spinning or working" — 2026-09-17). Captured for
  // every session and only ever READ by a supervisor looking at a child; a
  // manager writing a plan pays one string assignment per call. Registering
  // a SECOND handler here would be a second path, and the vendored hosts
  // (test fixtures) keep exactly one handler per event.
  pi.on("tool_call", (event, ctx) => {
    noteToolActivity(describeToolActivity(
      String((event as { toolName?: unknown }).toolName ?? ""),
      (event as { input?: unknown }).input,
    ));
    return evaluateToolCall(shipGateHookDeps, event, ctx);
  });

  /**
   * THE HINTS RIDE THE RESULT (user decision, 2026-09-14).
   *
   * `tool_result` handlers chain like middleware, so this patch is what the
   * REST of the pipeline (and the model) sees as that tool's output: the
   * advice appears under the very command it is about, in one message. The
   * handler touches nothing else — every other field keeps its current value.
   */
  pi.on("tool_result", (event) => {
    if (pendingHints.length === 0) return;
    const text = pendingHints.splice(0).join("\n\n");
    try {
      return { content: [...event.content, { type: "text" as const, text: "\n\n" + text }] };
    } catch { /* an unreadable result shape: drop the hint, never the result */ }
  });

  // ---------- L7: post-PR Copilot code-review loop ----------
  //
  // The tool that drives it (`copilot_review`) lives in
  // lib/copilot-review-tools.ts, and the `gh` access it runs on in
  // lib/copilot-gh.ts — their wiring is further down. What stays here is what
  // the REST of the extension consults: whether the loop is active for a repo,
  // the completion-only problems it reports, the directory `gh` must run in
  // (all closures over this extension's own project config, primary root and
  // cwd), and the background WATCHER that owns the wait.

  /** Is the L7 loop active for this repo's state? (mode + project config) */
  function copilotEnabled(st: GateState): boolean {
    return projectConfig.copilotReview.enabled && st.taskMode !== "normal";
  }

  /**
   * Copilot problems for one repo — a COMPLETION-only requirement.
   * Never consulted by the ship gate (see lib/copilot-review.ts header).
   *
   * The AWAITING line stays in the revival nudge too: the wait itself is
   * `copilot_review`'s blocking call, so a session whose turn ended mid-wait is
   * told to call it again — never to sit idle until something wakes it
   * (AGENTS.md 总则: no turn ends before declare_done).
   */
  function copilotProblemsFor(st: GateState | undefined): string[] {
    if (!st || !copilotEnabled(st)) return [];
    return copilotProblems(st.copilot);
  }

  /** The directory `gh` should run in for a given repo root. */
  function repoDirFor(root: string): string {
    return root === primaryRepoRoot ? cwd : root;
  }

  // ---------- L7: the wait is copilot_review's own blocking call ----------
  //
  // The background watcher that used to live here (a timer that polled the PR
  // and sent the session a wake message) was deleted 2026-09-23: it was the
  // reason `copilot_review` told the agent to END ITS TURN and wait to be
  // called, and an orchestration child that did so read as idle — its manager
  // was woken every minute for the whole ~16-minute wait. The wait now blocks
  // inside the tool (lib/copilot-watch.ts `awaitCopilotNews`); all this file
  // keeps is the fact that the call is blocking, so the child heartbeat can
  // report it as a gate-owned wait (see activeJudgeWait).

  /** When the current `copilot_review` call started blocking, if it is. */
  let copilotWaitSince: number | undefined;

  // ---------- L8: the loop goal must be one the USER approved ----------

  /**
   * Does the goal file's CURRENT text carry the user's approval?
   *
   * The comparison is over content, not time: the sidecar holds the hash of
   * exactly the text shown in the confirm dialog, so an agent edit after the
   * approval silently drops it — which is the intended behaviour, since the
   * contract the user agreed to no longer exists. The raw file is re-read here
   * because the prompt copy is length-capped, and a truncated text cannot be
   * hashed back to the approved one.
   *
   * Multi-repo: `root` defaults to the primary repo, but the L8 edit gate
   * passes the TARGET repo of the write — each repo's goal is checked against
   * that repo's own sidecar confirmation, so a session editing several repos
   * cannot satisfy one repo's goal and then write into another.
   */
  function loopGoalConfirmed(root: string = primaryRepoRoot, st: GateState = state): boolean {
    const goal = readSessionLoopGoal(root);
    if (!goal.present || !st.loopGoal) return false;
    let raw: string;
    try {
      raw = readFileSync(loopGoalPathIn(root), "utf8");

    } catch {
      return false; // unreadable ⇒ unapproved (fail-closed)
    }
    return isLoopGoalConfirmed(goal, st.loopGoal, raw);
  }

  // ---------- the five stage switches (2026-09-22, lib/loop-stages.ts) ----------

  /**
   * THE SESSION'S STAGE RECORD, read for one repo.
   *
   * The user's choice is a SESSION fact (the box is shown once, by this
   * session), while the sidecar that carries it is per repo — so a repo this
   * session has not written to yet falls back to the primary repo's copy
   * instead of reading "no record" as "all five on" behind the user's back.
   */
  function loopStagesRecord(root: string = primaryRepoRoot): LoopStagesRecord | undefined {
    const st = root === primaryRepoRoot ? state : stateForRepo(root);
    return st.stages ?? state.stages;
  }

  /** IS THIS STAGE ON? — the ONE query, at all five checkpoints. */
  function stageIsOn(stage: LoopStage, root?: string): boolean {
    return stageOpen(loopStagesRecord(root), stage);
  }

  /**
   * DOES THIS ROUND OWE NO FULL-LANE VERIFICATION? (quality round P1, 2026-09-22)
   *
   * TWO ways a round owes no lane, and to the adjudicator they are ONE fact
   * (`lib/review-adjudicate.ts`'s `laneVerifiesTree` reads it as "no lane is
   * OWED at all, so nothing is missing"): the user's `/gate-bypass`, and the
   * user's own precommit stage switch. With that stage OFF the chain starts no
   * lane at all (`submitForReview` skips it), so `lastFullPassTree` can never
   * catch up with the content and the old reading withheld EVERY READY as
   * `unverified-idle` — REFUSED, not held — which made the legal combination
   * unconvergeable, and contradicted the switch's own copy (“precommit 关 ⇒
   * 不跑 lane，checkpoint 与 ship 都不再要求 precommit PASS”).
   *
   * ONE function for BOTH readers — the recorder and the parked-READY re-ask:
   * a second composition at the other call site is how the two readings drift
   * (`laneVerifiesTree`'s docblock is the other half of this rule).
   */
  function laneVerificationWaived(root: string, st: GateState = stateForRepo(root)): boolean {
    return st.bypass.active || !stageIsOn("precommit", root);
  }

  /**
   * IS THE GOAL CONTRACT SATISFIED — because the user approved it, or because
   * the user switched the goal stage off?
   *
   * This is the ENFORCEMENT question, and it is deliberately not folded into
   * `loopGoalConfirmed`: that one is a FACT ("this exact text carries the
   * user's approval") read by the approval machinery itself, while this one
   * asks what the gate should do about it. A stage that is off answers the
   * second question positively without inventing an approval the user never
   * gave.
   */
  function goalStageSatisfied(root: string = primaryRepoRoot, st: GateState = state): boolean {
    return !stageIsOn("goal", root) || loopGoalConfirmed(root, st);
  }

  /**
   * THE LOOP'S STANDING GOAL DIRECTIVE, stage-aware (2026-09-22).
   *
   * With the goal stage ON this is `buildLoopGoalDirective` over this repo's
   * file and approval (unchanged). With it OFF there is no contract to
   * negotiate, and the missing-goal text would send the agent to negotiate one
   * anyway — so the agent is told the truth instead (lib/loop-goal.ts owns
   * that wording, like every other goal paragraph).
   */
  function loopGoalDirectiveText(): string {
    if (!stageIsOn("goal")) return buildGoalStageOffDirective();
    return buildLoopGoalDirective(readSessionLoopGoal(primaryRepoRoot), goalStageSatisfied());
  }

  /**
   * Write the user's choice where every checkpoint reads it: on the primary
   * state, and MIRRORED into every repo this session knows about — each repo
   * has its own sidecar, and the L3 hooks read the repo-local one, so a
   * secondary repo without the mirror would keep enforcing a stage the user
   * switched off.
   */
  function applyStages(record: LoopStagesRecord, ctx: unknown): void {
    state.stages = record;
    for (const root of knownRepoRoots()) {
      const st = stateForRepo(root);
      if (st === state) continue;
      st.stages = record;
      persistRepo(ctx as unknown as ExtensionContext, root);
    }
    persist(ctx as unknown as ExtensionContext);
  }

  /** The five deps the stage module needs; the dialog is the gate's own box. */
  const loopStageDeps: LoopStagesDeps = {
    state: () => state,
    refusal: () => stagesOffered({
      mode: state.taskMode,
      judge: isJudgePane(),
      orchestrated: orchestrationIdFromEnv(process.env) !== undefined,
    }),
    askMulti: (uiCtx, spec, opts) => askMultiChoice(uiCtx as { ui?: ChoiceUi }, spec, {
      ...opts,
      // A MACHINE MUST NOT TURN THE GATES OFF (quality round P1, 2026-09-22):
      // see `askDialog`'s `proxy` option.
      proxy: false,
    }),
    persist: (record, ctx) => applyStages(record, ctx),
    log: (message) => log(`[stages] ${message}`),
  };

  /**
   * THE FALLBACK, asked before a tool whose gate the switches decide
   * (`propose_restatement`, or the first edit/write).
   *
   * ONCE PER SESSION, and only while there is no record: a box the user closed
   * is an answer too ("run it as it is"), and re-opening it on every edit would
   * be grinding. A host that cannot draw it says so once and then keeps the
   * defaults — the same landing a dismissed box has.
   */
  let stagesAsked = false;
  async function ensureLoopStagesFor(ctx: unknown): Promise<void> {
    if (stagesAsked || state.stages !== undefined) return;
    // THE ELIGIBILITY CHECK COMES FIRST (reviewer Nit, 2026-09-22): setting the
    // once-per-session flag before it would spend the only chance on a session
    // that could not be asked — an explore/edit session promoted to loop later
    // would never see the fallback box, and only an explicit
    // `choose_loop_stages` call would exist.
    if (stagesOffered({
      mode: state.taskMode,
      judge: isJudgePane(),
      orchestrated: orchestrationIdFromEnv(process.env) !== undefined,
    }) !== undefined) return;
    stagesAsked = true;
    await ensureLoopStages(loopStageDeps, ctx);
  }

  /**
   * WHERE THIS ROUND STOPS for one repo, or `undefined` when this session has
   * no delivery contract at all (lib/delivery-station.ts).
   *
   * Two contracts, one per role, and nothing else is consulted:
   *
   *  - loop  — the station the USER approved together with THAT REPO's loop
   *    goal. An unconfirmed goal yields `undefined` rather than the strictest
   *    station: L8 already refuses that ship on its own terms, and answering
   *    "your round stops at precommit" to a session that has no contract yet
   *    would send it to fix the wrong thing.
   *  - orchestrator — the station of the plan the user approved. Missing (an
   *    older runtime, or no approval yet) reads as the strictest station,
   *    which is the reading lib/delivery-station.ts documents for a contract
   *    that forgot to say where it stops.
   *
   * explore and normal have no contract, so they get `undefined` and keep the
   * exact ship behaviour they had before stations existed (user decision,
   * 2026-09-06).
   */
  function deliveryStationFor(root: string): DeliveryStation | undefined {
    if (state.taskMode === "orchestrator") {
      return state.orchestrator?.approvedPlan?.deliveryStation ?? DEFAULT_DELIVERY_STATION;
    }
    if (!isEnforcedMode(state.taskMode)) return undefined;
    // A stage that is off has no contract to read a station from — the same
    // `undefined` ("no ceiling beyond the ordinary gates") a session that
    // never negotiated a goal has always got.
    if (!stageIsOn("goal", root)) return undefined;
    const st = root === primaryRepoRoot ? state : stateForRepo(root);
    if (!loopGoalConfirmed(root, st)) return undefined;
    return st.loopGoal?.station ?? DEFAULT_DELIVERY_STATION;
  }


  /**
   * L8 edit-gate decision for ONE edit/write call, or undefined to let it
   * pass. Kept OUT of the tool_call body on purpose: the structural security
   * tests forbid EXPLORE branches and negated mode branches inside that
   * handler (the pre-existing `taskMode === "normal"` early return stays),
   * and this helper is also where the explore short-circuit lives — explore
   * never gates on the goal, so it must not pay for the goal lookup either
   * (gitRootOfDir is a git subprocess; loopGoalConfirmed reads the file
   * twice).
   */
  function loopGoalEditBlockFor(absPath: string | undefined): { block: true; reason: string } | undefined {
    // THE WORKTREE COMES FIRST, before any mode branch below.
    //
    // When another live session holds this checkout, nothing this session
    // writes here is safe — the two share one sidecar and one set of
    // uncommitted changes, so an edit made now is an edit made to somebody
    // else's work in progress. It refuses even in explore (an explore session
    // still writes files) and even with an approved goal on disk (a resumed
    // session carries one), which is exactly why it is ABOVE both.
    //
    // (The hook's name is the L8 goal gate's, fixed by the deps interface in
    // lib/ship-gate-edit-guard.ts; what it really is, is this extension's
    // per-edit block decision. The ship side reads the same refusal through
    // `unmetRequirements`.)
    if (state.exclusivityRefusal) {
      return { block: true, reason: state.exclusivityRefusal };
    }
    // explore never gates on the goal (loopGoalEditGate would return true
    // anyway) — skip the lookup before paying for it.
    if (state.taskMode === "explore") return undefined;
    const goalRoot = absPath
      ? // Every write pays the real per-edit git resolution: a fast path that
        // attributed anything under primaryRepoRoot to the primary repo would
        // let an approved primary goal unlock a NESTED independent git repo's
        // write surface (round P2) — the per-repo binding must be exact.
        // (~3.6 ms/edit measured; correctness beats the micro-cost.)
        gitRootOfDir(nearestExistingDir(pathDirname(absPath))) ?? primaryRepoRoot
      : primaryRepoRoot;
    const goalSt = goalRoot === primaryRepoRoot ? state : stateForRepo(goalRoot);
    if (!loopGoalEditGate({ taskMode: state.taskMode, goalConfirmed: goalStageSatisfied(goalRoot, goalSt) })) {
      // Name the repo that lacks an approved goal: in a multi-repo session an
      // anonymous block makes the agent re-approve the PRIMARY goal and stay
      // blocked forever — the propose_loop_goal `repo` parameter is what
      // binds a goal to a specific repo. The hint goes in through the builder,
      // which puts it on the 现象 line where it is read.
      return { block: true, reason: loopGoalUnconfirmedEditBlock(goalRoot === primaryRepoRoot ? undefined : goalRoot) };
    }
    return undefined;
  }

  /**
   * Walk up to the nearest EXISTING ancestor directory. `gitRootOfDir` runs
   * `git rev-parse`, which fails on a path that does not exist — and a
   * `write` creating a NEW nested file targets exactly such a path. An
   * unattributable path falling back to the primary repo is what let repo
   * A's approved goal open repo B's write surface, so attribution must
   * first climb to a directory git can actually resolve.
   */
  function nearestExistingDir(p: string): string {
    let d = p;
    for (;;) {
      try {
        if (statSync(d).isDirectory()) return d;
      } catch { /* does not exist — keep climbing */ }
      const parent = pathDirname(d);
      if (parent === d) return d;
      d = parent;
    }
  }

  /**
   * Goal text handed to spawned reviewers. The prompt copy is capped
   * (LOOP_GOAL_MAX_CHARS), and a truncated goal's "read the file for the
   * rest" pointer would be useless without an absolute location — a judge
   * child may be reading from a throwaway worktree of its own — so a
   * truncated goal appends the REAL file path instead.
   */
  function goalTextForReviewers(root: string): { text: string; truncated: boolean } | undefined {
    const goal = readSessionLoopGoal(root);
    if (!goal.present) return undefined;
    // Use readLoopGoal's OWN truncated boolean — never sniff the display
    // marker string (round-17 Nit: the marker is display, the fact is the
    // flag).
    if (!goal.truncated) return { text: goal.text, truncated: false };
    return { text: goal.text + "\n(全文: " + loopGoalPathIn(root) + ")", truncated: true };

  }
  // ---------- track edits & precommit results ----------

  pi.on("tool_result", async (event, ctx) => {
    // E — a completed tool call is forward progress for the child health reading.
    noteChildProgress("tool");
    // Background-agent wait tracking: a launch starts a wait, a terminal
    // report ends one (lib/background-wait.ts). Runs before every return
    // below, like the progress note above it.
    observeBackgroundToolResult(event);
    // 0. JUDGE SIDE: the round's mechanical inspection evidence. Folded FIRST,
    // before any of the branches below can return, because every one of them
    // returns early and a miss here would read as "this judge inspected
    // nothing". Successful calls only — a failed read inspected nothing — and
    // the classification itself lives in lib/judge-inspection.ts.
    if (isJudgePane() && event.isError !== true) {
      judgeInspection = observeInspection(
        judgeInspection,
        { toolName: event.toolName, input: event.input },
        {
          range: judgeReviewRange,
          // Stamped with the round the registry says we are in, so an
          // abandoned round's reads cannot be credited to the next round.
          round: judgeCurrentRound(),
          // The round's OWN paperwork never counts as having reviewed the
          // repository — reading the task a probe wrote is what the probe
          // asked for, and crediting it would make this gate decorative.
          ownPaths: judgeOwnPaths(),
          // WHOSE round this is (2026-09-22, reviewer P2): the acceptance
          // judge's job IS to run the thing, so for that role a successful
          // execution is an inspection action — otherwise a round that never
          // needed to read a file could only conclude READY by pretending to.
          role: readJudgeSideEnv(process.env)?.role,
        },
      );
    }
    // 1. Edits: only arm gate on success.
    if (EDIT_TOOL_NAMES.has(event.toolName)) {
      if (event.isError) {
        // Edit-discipline nudge (prompt-only, non-blocking): a failed edit is
        // the classic trigger for the "shell edits the file instead"
        // workaround. Append guidance to THIS result and arm the bash window;
        // it closes only on a successful edit or after one nudge (2026-09-08,
        // cross-turn persistence — a persistently broken edit tool must not
        // slip into silent bash edits next turn). Failure semantics stay
        // untouched (isError true).
        // Skipped in normal mode: the step-aside must not add
        // extension text to results.
        if (state.taskMode === "normal") return;
        editFailurePending = true;
        return {
          content: [...(event.content ?? []), { type: "text", text: EDIT_FAILURE_NUDGE }],
          isError: true,
        };
      }
      editFailurePending = false;
      // A landed edit IS production: the drill counter starts over (the
      // guard exists to catch sessions that read but never write).
      readonlyStallState = evaluateReadonlyStall({
        previous: readonlyStallState,
        produced: true,
        read: false,
      }).state;
      const path = coalesceToolPath(event.input as Record<string, unknown>);
      if (!path) return;

      // The edit LANDED, so burn any one-shot sensitive-file authorization for
      // this path. Consuming here rather than at tool_call is what makes a
      // failed edit (stale anchor, missing file) retryable without a second
      // dialog, while a successful one costs the user a fresh "yes" next time.
      // Normalized on both sides, exactly like the tool_call guard: a grant is
      // keyed by the resolved path, so matching the raw spelling here could
      // leave a burned-but-unconsumed grant alive.
      const sensitiveAbs = normalizeSensitivePath(path, cwd);
      if (isSensitiveFile(sensitiveAbs)) {
        const { consumed, remaining } = consumeGrant(
          sensitiveGrants,
          sensitiveAbs,
          Date.now(),
        );
        sensitiveGrants = remaining;
        if (consumed) log(`sensitive-grant consumed for ${consumed.path}`);
      }

      // Normal mode: the extension steps aside completely, and that has to
      // include ARMING. An armed sidecar would still be read by the L3 git
      // hooks (which only go advisory for a USER-chosen mode), so tracking
      // edits here would block the very commits normal mode promises to let
      // through — the deadlock a headless, forced-normal session would hit on
      // its first edit. The sensitive-file guard above stays: it is a security
      // floor, not workflow enforcement.
      if (state.taskMode === "normal") return;

      // P-multi: an edit OUTSIDE the session repo arms THAT repo's own gate.
      // A code/doc file's repo joins the declare_done set and becomes the
      // active repo (the target for the next verdict record / run_precommit).
      // ANY file's repo joins the set (review round 2 P1, drill F3): since the
      // checkpoint commits this session's OWN new files — `.json`, `.yaml`,
      // scratch — a repo holding one of them is a repo the session worked in,
      // and leaving it out of the set would drop it from declare_done's coverage
      // while its file sat in the gate's own-list. This SUPERSEDES the earlier
      // "a non-code edit must not grow the set" nit: that was about wasting a
      // round on a change-less repo, and the fail-closed direction wins over the
      // round (a branch ahead is unreviewed work in every repo alike).
      const absEditPath = path.startsWith("/") ? path : pathJoin(cwd, path);
      // Attribution climbs to the nearest EXISTING ancestor first: `git
      // rev-parse` fails on a directory that does not exist, and a `write`
      // creating a new nested file targets exactly such a path — asking about
      // the raw directory left a new file in ANOTHER repo unattributed, and
      // therefore unarmed once unattributed stopped meaning "the primary"
      // (round-2 reviewer P1). It is also the resolution the L8 goal gate
      // already uses for the same question, so the two now agree.
      const editRepoDir = nearestExistingDir(pathDirname(absEditPath));
      const editRepo = gitRootOfDir(editRepoDir);

      // Gate-owned paths (.pi/, .pi-subagents/) are excluded from the
      // fingerprint AND from changedFiles(), so a reviewer can never see them.
      // Tracking such an edit would arm the doc gate and demote READY→PENDING
      // over a file with nothing to review — exactly the self-deadlock the
      // exclusion exists to prevent. It covers the gate's own sidecar/lesson
      // writes and the agent-authored .pi/loop-goal.md alike.
      if (isGateOwnedPath(absEditPath, editRepo ?? primaryRepoRoot)) return;
      // WHICH repo this edit belongs to — or none at all. The `null` answer
      // from gitRootOfDir used to fall straight through to the PRIMARY branch
      // below, so a file outside every repository (the `/tmp/report.md` a
      // child session writes its completion report to) armed the doc gate and
      // demoted a READY it could not possibly invalidate: it is in neither
      // changedFiles() nor the fingerprint, so no reviewer ever sees it. That
      // cost seven rounds of the same report before anyone traced it here.
      // lib/edit-repo-scope.ts owns the judgement, including its fail-closed
      // side: only a path resolved CONFIDENTLY outside the root skips
      // tracking.
      const editScope = classifyEditRepoScope({
        absPath: absEditPath,
        primaryRepoRoot,
        editRepo,
        // Where a RESOLVED path really lives, for the one case git could not
        // attribute: a symlink whose own directory is in no repository but
        // whose target is inside one.
        resolveRepoRoot: (file) => gitRootOfDir(nearestExistingDir(pathDirname(file))),
      });
      if (editScope.scope === "outside") {
        // ONE exception, and it is not about the gate: a SENSITIVE path
        // outside the repo stays VISIBLE. `sessionEditedFiles` is the only
        // input lib/out-of-repo-paths.ts has for the supervision-time
        // question "did this child write somewhere it had no business
        // writing?" — its out-of-repo exemption for process artefacts
        // deliberately keeps sensitive paths as violations, and dropping the
        // record entirely would leave that exception with nothing to read
        // (round-1 reviewer P1). Recording is NOT arming: no verdict is
        // invalidated, no completion undone — nothing reviewable changed.
        if (isSensitiveOutsideRepoPath(absEditPath)) {
          if (!state.sessionEditedFiles) state.sessionEditedFiles = [];
          if (!state.sessionEditedFiles.includes(absEditPath)) {
            state.sessionEditedFiles.push(absEditPath);
            sessionEditedPaths.add(absEditPath);
            persist(ctx);
          }
        }
        return;
      }
      if (editScope.scope === "other-repo") {
        const otherRepo = editScope.root;
        const isProjectFile = isCodeFile(path) || isDocFile(path);
        const isNewRepo = !sessionRepos.has(otherRepo);
        // THE REPO SET FOLLOWS THE RECORDING (review round 2 P1). A session that
        // wrote only a `.json` in another repo HAS worked there: leaving that
        // repo out of `sessionRepos` would drop it from `declare_done`'s
        // coverage and from the sidecar's repo list while its file sits in the
        // checkpoint's own-list. The ACTIVE repo still follows PROJECT files
        // alone — a scratch path must not retarget verdict recording.
        sessionRepos.add(otherRepo);
        if (isProjectFile) {
          activeRepoRoot.current = otherRepo;
        }
        const s = stateForRepo(otherRepo);
        let dirty = false;
        if (isCodeFile(path) && !s.hasCodeChange) { s.hasCodeChange = true; dirty = true; }
        if (isDocFile(path) && !s.hasDocChange) { s.hasDocChange = true; dirty = true; }
        // EVERY path this session wrote is recorded, code/doc or not — the same
        // rule as the primary branch below (review round 1 P1, drill F3):
        // `review_checkpoint` commits THIS repo's own new files and nothing else,
        // and a new `.json`/`.yaml` file of a secondary repo was left looking
        // like a stranger's. The path is root-relative because that is the form
        // git answers in (this branch already did that; the primary branch did
        // not, and compared against `cwd` — fixed in `repoRelative`).
        const rel = absEditPath.startsWith(otherRepo + "/")
          ? absEditPath.slice(otherRepo.length + 1)
          : absEditPath;
        if (!s.sessionEditedFiles) s.sessionEditedFiles = [];
        if (!s.sessionEditedFiles.includes(rel)) { s.sessionEditedFiles.push(rel); dirty = true; }
        // A NEW EDIT UN-FINISHES THE TASK — for EVERY file, not only code/doc
        // (2026-09-22). The completion record is what a supervising
        // orchestrator reads to decide a child is `done`, AND what the revival
        // guard reads to decide a session may be left stopped. Leaving it in
        // place for a `.json`/`.yaml` edit stranded exactly that session: the
        // invariant stayed silent (nothing had "un-finished" it) while the
        // ship gate kept blocking, because the worktree fingerprint HAD moved.
        // The ARMING below stays code/doc-only — that is the different
        // question ("is there anything to review?") and its answer did not
        // change.
        //
        // AND THE SESSION'S RECORD LIVES ON THE PRIMARY STATE (quality round
        // P1, 2026-09-22): `declare_done` writes `state.completion` there and
        // nowhere else, so a per-repo record is one this session never carries
        // — clearing that instead left the SESSION looking finished while THIS
        // repo's bindings had just been invalidated: the same stranding the
        // primary branch fixes below, reached through the other door.
        let sessionUnfinished = false;
        if (state.completion) { delete state.completion; sessionUnfinished = true; }
        if (isProjectFile) {
          invalidateBindings(s);
          armLoop();
          if (s.pausedQuestion) delete s.pausedQuestion;
          dirty = true;
          clearBypassToken(); // any edit invalidates a standing arbiter bypass
        }
        if (dirty) {
          persistRepo(ctx as unknown as ExtensionContext, otherRepo);
          // P-multi (round-2 P2): the FIRST cross-repo edit grows the repo
          // set — record it in the PRIMARY sidecar's sessionReposPaths NOW so
          // a crash/restart before the next primary persist cannot drop this
          // repo from the resumed declare_done set.
          if (isNewRepo) persist(ctx as unknown as ExtensionContext);
        }
        // The session's own completion lived on the PRIMARY state (see above),
        // so its deletion has to reach that sidecar even when this repo's own
        // state was already clean.
        if (sessionUnfinished) persist(ctx as unknown as ExtensionContext);
        return;
      }

      let dirty = false;
      // P-multi: an edit in the PRIMARY repo makes it the active repo again —
      // otherwise a single cross-repo edit would leave verdict recording /
      // run_precommit pointed at the other repo forever (multi-repo deadlock).
      // Reaching this line ALREADY means the edit belongs to the primary repo
      // — an outside path and another repo both returned above — so the
      // retarget is unconditional now. The old `editRepo === primaryRepoRoot`
      // guard missed the one case git cannot attribute yet (a new file in a
      // repo directory that does not exist), leaving a multi-repo session
      // recording its verdicts against the other repo (round-1 reviewer P2).
      activeRepoRoot.current = primaryRepoRoot;
      if (isCodeFile(path) && !state.hasCodeChange) { state.hasCodeChange = true; dirty = true; }
      if (isDocFile(path) && !state.hasDocChange) { state.hasDocChange = true; dirty = true; }
      // EVERY PATH THIS SESSION WROTE IS RECORDED, code/doc or not (drill F3,
      // 2026-09-20). The checkpoint commits this session's OWN new files and
      // nothing else, and this list is how it knows which are its own: a
      // `.json` fixture or a `.yaml` config is exactly as much this round's
      // work as a `.ts` file, while extension-based classification would leave
      // it looking like a stranger's file and keep it out of the reviewed
      // commit. The ARMING below stays code/doc-only — that is a different
      // question ("is there anything to review?") and its answer did not
      // change.
      const rel = repoRelative(path);
      sessionEditedPaths.add(rel);
      if (!state.sessionEditedFiles) state.sessionEditedFiles = [];
      if (!state.sessionEditedFiles.includes(rel)) { state.sessionEditedFiles.push(rel); dirty = true; }
      // Same as the cross-repo branch above: ANY file of this repo's own
      // project un-finishes the task (2026-09-22), while the ARMING below
      // stays code/doc-only.
      if (state.completion) { delete state.completion; dirty = true; }
      if (isCodeFile(path) || isDocFile(path)) {
        // Scope tracking: this file is part of THIS session's own work — it is
        // always IN scope, even under a user-granted scope limit (which the
        // persisted lists must reflect across restarts).
        if (state.scopeLimit) {
          if (!state.scopeLimit.sessionFiles.includes(rel)) {
            state.scopeLimit.sessionFiles.push(rel);
          }
          // P1 fix: a session edit RECLAIMS an exempt file — it is now this
          // session's own work, so it must arm the gate again at EVERY
          // exempt-filter site (session_start P0-2, bash re-arm, turn_end).
          // Without this, a session that edits ONLY pre-existing dirty files
          // would see turn_end filter them all out, disarm the gate, and ship
          // its own edits unreviewed.
          const idx = state.scopeLimit.preexistingFiles.indexOf(rel);
          if (idx >= 0) state.scopeLimit.preexistingFiles.splice(idx, 1);
        }
        invalidateBindings(state);
        armLoop();
        // The agent resumed working on its own — a standing question pause
        // (ask_user) is moot; clear it so the loop enforces again.
        if (state.pausedQuestion) delete state.pausedQuestion;
        dirty = true;
        clearBypassToken(); // any edit invalidates a standing arbiter bypass
      }
      if (dirty) persist(ctx);
      return;
    }

    // 1.5 D — goal-negotiation reminder on read-only tools (advisory, throttled).
    //
    // MEASURED (2026-09-01, onchain): an orchestration child read code for
    // four minutes and then its process died — it never negotiated its own
    // loop goal because the task brief claimed one was already approved. The
    // L8 edit gate blocks every edit/write until the goal is approved, but it
    // cannot remind an agent that keeps READING. This branch appends a
    // one-line reminder to read-only results while the session is loop-mode
    // and the goal is unconfirmed. Never blocks; throttled to GOAL_REMINDER_MIN_MS
    // apart and GOAL_REMINDER_CAP total per session (user decision, 2026-09-01).
    // Explore/normal never remind (their gate modes do not require a goal).
    if (READ_ONLY_TOOL_NAMES.has(event.toolName)) {
      const nowMs = Date.now();
      const canRemind =
        state.taskMode !== "explore" &&
        state.taskMode !== "normal" &&
        state.taskMode !== "orchestrator" &&
        !goalStageSatisfied() &&
        goalReminderDue({
          now: nowMs,
          lastAt: lastGoalReminderAt,
          count: goalReminderCount,
          minMs: GOAL_REMINDER_MIN_MS,
          cap: GOAL_REMINDER_CAP,
        });
      if (canRemind) {
        lastGoalReminderAt = nowMs;
        goalReminderCount += 1;
        return {
          content: [...(event.content ?? []), { type: "text", text: GOAL_REMINDER_TEXT }],
          isError: event.isError === true,
        };
      }

      // Read-only drill stall guard (lib/readonly-stall.ts) — PRODUCTIVITY,
      // not liveness: the L2 stall breaker only evaluates at turn boundaries
      // and the child-health progress reading counts ANY tool call as
      // forward progress, so a session that keeps grepping through library
      // source (node_modules/) trips neither. Count consecutive successful
      // read-family calls with no edit landing in between; at
      // READONLY_STALL_LIMIT append the nudge (never a block). WHO HEARS IT is
      // the module's decision (readonlyStallNudgeFor): normal steps aside like
      // the edit-discipline nudges, and orchestrator is exempt because a
      // project manager may not write code at all. State is in-memory only —
      // no persistence.
      const readonlyNudgeText = readonlyStallNudgeFor(state.taskMode);
      if (readonlyNudgeText !== undefined && event.isError !== true) {
        const stall = evaluateReadonlyStall({
          previous: readonlyStallState,
          produced: false,
          read: true,
        });
        readonlyStallState = stall.state;
        if (stall.nudge) {
          return {
            content: [...(event.content ?? []), { type: "text", text: readonlyNudgeText }],
            // The enclosing condition already excludes isError:true, so the
            // result is not an error; keep the original semantics (false).
            isError: false,
          };
        }
      }
      return;
    }

    // 2. Bash: precommit re-arming + stash/checkout re-arming.
    if (event.toolName === "bash") {
      const text = contentText(event.content);
      const cmd = (event.input as Record<string, unknown>)?.command as string | undefined;

      // ROOT-CAUSE FIX (adviser): plain bash stdout can NEVER grant a PASS. The
      // ONLY way to record PASS is the run_precommit tool, which spawns the
      // trusted runner itself and verifies a private nonce receipt. Parsing
      // `## Overall:` out of arbitrary stdout was forgeable in unbounded ways
      // (printf a sentinel, `|| node runner`, here-docs, quoted operators, …).
      // Here bash output may only INVALIDATE a prior PASS as a safety net: if a
      // command emits a FAIL/NO_CHECKS_RUN sentinel, drop any standing PASS.
      if (text) {
        const verdict = parsePrecommitOutput(text);
        if (verdict && verdict !== "PASS") {
          // P-multi: a FAIL sentinel invalidates a standing PASS in EVERY
          // repo this session tracks, not just the primary (the safety net
          // must cover all of them).
          for (const root of sessionRepos) {
            const st = root === primaryRepoRoot ? state : stateForRepo(root);
            if (st.precommit.verdict === "PASS") {
              st.precommit = { verdict, fingerprint: null, at: new Date().toISOString() };
              persistRepo(ctx as unknown as ExtensionContext, root);
            }
          }
        }
      }
      // P0-7: re-arm gate if a git operation restored dirty state
      // without going through an edit tool (bypass prevention). P-multi: the
      // command's own repos (cd chain / git -C) are re-armed, not just cwd —
      // `cd other && git checkout -b x` must arm OTHER's gate.
      if (cmd && /(^|[\s;&|])(git\s+(stash\s+(pop|apply)|checkout|switch|restore|reset\s+--hard|merge|pull|rebase|cherry-pick|am)|gh\s+pr\s+checkout)\b/.test(cmd)) {
        const cmdRepos = resolveCommandRepos(cmd, cwd);
        const rearmRoots = new Set(cmdRepos.repos);
        if (cmdRepos.ambiguous) {
          for (const r of sessionRepos) rearmRoots.add(r);
        }
        for (const root of rearmRoots) {
          const files = changedFiles(root);
          if (!files || files.length === 0) continue;
          const st = root === primaryRepoRoot ? state : stateForRepo(root);
          // User-granted scope limit: files still in the exempt snapshot
          // never re-arm the gate (session-edited ones were reclaimed out of
          // it); anything newer still does (fail-closed). Scope limits are
          // primary-repo-only; other repos always arm.
          const exempt = root === primaryRepoRoot ? new Set(state.scopeLimit?.preexistingFiles ?? []) : new Set<string>();
          const arming = exempt.size > 0 ? files.filter((f) => !exempt.has(f)) : files;
          // The file-kind half of the rule is `lib/gate-arming.ts`'s, here as
          // everywhere (2026-09-20): this command brought dirty state BACK, and
          // "what does it arm" is one question with one answer. `commitsAhead:
          // 0` — this site re-arms on what the git command just restored, not on
          // the branch's history (which `session_start` owns).
          const armed = armingFromFacts({ files: arming, commitsAhead: 0 });
          if (armed.hasCodeChange && !st.hasCodeChange) { st.hasCodeChange = true; }
          if (armed.hasDocChange && !st.hasDocChange) { st.hasDocChange = true; }
          if (st.hasCodeChange || st.hasDocChange) {
            invalidateBindings(st);
            clearBypassToken();
            persistRepo(ctx as unknown as ExtensionContext, root);
          }
        }
      }
      // DELIVERY-STATION EVIDENCE: which ship kinds the gate WATCHED succeed
      // in each repo. `event.isError !== true` is the whole point — this is an
      // observation of an exit code, not a claim, which is what makes it
      // usable as arrival evidence for `declare_done`.
      //
      // Recorded independently of the Copilot block below (and of
      // `copilotReview.enabled`): a repo that cannot do Copilot review still
      // opens real PRs, and tying the evidence to that switch is exactly the
      // bug this replaced (round-1 reviewer P1 — a `pr` round in such a repo
      // could never finish).
      //
      // The KINDS come from `observedShipKinds`, not from `detectShipCommands`
      // (round-2/3 reviewer P2): the shared detector over-matches on purpose,
      // which is right when the answer is "block" and wrong when the answer is
      // "you arrived" — a heredoc body, a `node -e '…'` string and a
      // `python3 -c "…"` argument were all detected as `pr-create`. The
      // evidence entry point applies the two fail-closed narrowings; the
      // detector itself stays exactly as strict as it was.
      if (cmd && event.isError !== true && state.taskMode !== "normal") {
        const shipped = observedShipKinds(cmd);

        if (shipped.length > 0) {
          const cmdRepos = resolveCommandRepos(cmd, cwd);
          const roots = cmdRepos.ambiguous ? new Set(sessionRepos) : new Set(cmdRepos.repos);
          for (const root of roots) {
            const st = root === primaryRepoRoot ? state : stateForRepo(root);
            const before = st.shippedKinds ?? [];
            const merged = [...new Set([...before, ...shipped])];
            if (merged.length !== before.length) {
              st.shippedKinds = merged;
              persistRepo(ctx as unknown as ExtensionContext, root);
            }
          }
        }
      }

      // L7: a SUCCESSFUL PR-affecting ship opens a Copilot review round for
      // the repo the command ran in. `git push` counts even when no PR exists
      // yet — the check tool resolves that to UNSUPPORTED — because the usual
      // order is "push the branch, then open the PR", and a requirement that
      // only armed on `gh pr create` would be bypassed by the previous ship's
      // terminal state sticking around. A FAILED command arms nothing.
      if (cmd && event.isError !== true && state.taskMode !== "normal" && projectConfig.copilotReview.enabled) {
        const kinds = new Set(detectShipCommands(cmd).map((d) => d.kind));
        if (kinds.has("pr-create") || kinds.has("pr-edit") || kinds.has("push")) {
          const cmdRepos = resolveCommandRepos(cmd, cwd);
          const armRoots = cmdRepos.ambiguous ? new Set(sessionRepos) : new Set(cmdRepos.repos);
          const nowIso = new Date().toISOString();
          for (const root of armRoots) {
            const st = root === primaryRepoRoot ? state : stateForRepo(root);
            st.copilot = armCopilotReview(st.copilot, nowIso);
            persistRepo(ctx as unknown as ExtensionContext, root);
            armLoop();
          }
        }
      }

      // Edit-discipline nudge (prompt-only, non-blocking): right after a
      // FAILED edit call, a bash command that looks like a direct file write
      // is the exact workaround pattern — append guidance once and close the
      // window. Deliberately AFTER the state-maintenance above, so this path
      // never skips the sentinel-invalidation / re-arm safety nets. Skipped in
      // normal mode. Never blocks; benign bash (read-only, diagnostics) is
      // untouched because the window only opens on an edit failure.
      if (state.taskMode !== "normal" && editFailurePending && cmd && looksLikeBashFileWrite(cmd)) {
        editFailurePending = false;
        return {
          content: [...(event.content ?? []), { type: "text", text: BASH_WRITE_NUDGE }],
          isError: event.isError === true,
        };
      }

      // Test-run discipline nudge (prompt-only, non-blocking): a manual full
      // `npm test` / `tsc --noEmit` in the MAIN session is pure waste — the
      // submission chain runs the full lane itself, input-cached. Judge panes
      // are exempt: a reviewer verifies the reviewed commit in its throwaway
      // worktree and that full run IS the job. Skipped in normal mode.
      if (state.taskMode !== "normal"
        && readJudgeSideEnv(process.env) === undefined
        && cmd && looksLikeFullLaneRun(cmd)) {
        return {
          content: [...(event.content ?? []), { type: "text", text: FULL_LANE_NUDGE }],
          isError: event.isError === true,
        };
      }

      // A FAILED `gh pr create`: the branch already has a PR.
      //
      // `gh` reports that case as an ERROR, which is why the success-only
      // evidence above can never see it — and why the agent is left reading
      // gh's stderr and guessing between "append to it" and "open another
      // one". On 2026-09-16 that guess cost a user an open PR (closed, then
      // reopened under a new number when the arrival check would not accept
      // the old one). So the gate asks GitHub itself and says the answer out
      // loud; user-requested. Normal mode steps aside like every other nudge.
      // Placement is deliberate: BEFORE the read-only stall guard, whose
      // "count it like the read family" docblock reads as describing whatever
      // immediately follows it — and this is not that.
      if (
        cmd && event.isError === true && state.taskMode !== "normal"
        && observedShipKinds(cmd).includes("pr-create")
      ) {
        const cmdRepos = resolveCommandRepos(cmd, cwd);
        for (const root of cmdRepos.ambiguous ? sessionRepos : cmdRepos.repos) {
          const notice = existingPrNotice(await probeOpenPr(root));
          if (notice) {
            return {
              content: [...(event.content ?? []), { type: "text", text: notice }],
              isError: true,
            };
          }
        }
      }

      // Read-only drill stall guard (lib/readonly-stall.ts): bash is the
      // drill workhorse (grep/sed through node_modules/), so count it like
      // the read family. Deliberately at the END of the bash branch — after
      // every state-maintenance safety net (sentinel invalidation, re-arm,
      // copilot, edit-discipline nudge) — so this nudge can never skip them.
      // Who hears it is readonlyStallNudgeFor's call (normal + orchestrator
      // are silent). State is in-memory only — no persistence.
      const bashReadonlyNudgeText = readonlyStallNudgeFor(state.taskMode);
      if (bashReadonlyNudgeText !== undefined && event.isError !== true) {
        const stall = evaluateReadonlyStall({
          previous: readonlyStallState,
          produced: false,
          read: true,
        });
        readonlyStallState = stall.state;
        if (stall.nudge) {
          return {
            content: [...(event.content ?? []), { type: "text", text: bashReadonlyNudgeText }],
            // Enclosing condition excludes isError:true; result is not an error.
            isError: false,
          };
        }
      }
      return;
    }
  });

  // ---------- review_checkpoint tool (the pre-review commit channel) ----------

  // INTERNAL, not registered (philosophy three): the checkpoint is a step of
  // `judge_submit`, not a thing to sequence by hand.
  internalTool({
    name: "review_checkpoint",
    label: "Review Checkpoint",
    description:
      "ADVANCED / internal: `judge_submit({role:\"reviewer\"})` runs this itself as step 2 of the " +
      "submission chain — call it directly only " +
      "to freeze work without submitting it. " +
      "Commits the current worktree as a checkpoint commit — the ONLY way to commit before a READY " +
      "review. Requires a precommit PASS (it bypasses READY only, never precommit), validates the " +
      "message is English (L5), commits everything (git add -A), records the commit sha and the " +
      "branch it landed on, and refuses any branch that is not this session's work branch. " +
      "Every review round judges baseline..HEAD, so checkpoints are the review unit.",
    parameters: Type.Object({
      message: Type.String({ description: "English commit message (Conventional Commits style)" }),
      note: Type.Optional(Type.String({
        description: "The agent's round note in its own words (the same text judge_submit receives as task) — the dependency-justification gate reads the justification from it, because the English-only commit message may have dropped the original wording.",
      })),
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = resolveToolRepo(params.repo);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const root = target.root;
      // NON-GIT SHORT-CIRCUIT: a checkpoint IS a commit — outside a
      // repository there is no commit to make. Refuse before any git call
      // (currentBranch below would otherwise leak fatal to the terminal).
      if (!sessionInGit) {
        return {
          content: [{ type: "text", text: "review-gate: 非 git 目录 —— checkpoint 不可用（无仓库可提交）。" }],
          details: { committed: false },
          isError: true,
        };
      }
      // A checkpoint IS a commit, so it lands on the CURRENT branch — no
      // work-branch rule anymore (2026-09-07, user decision: sessions work
      // directly on the branch they are on, including main). The ONE hard
      // line left (2026-09-16, user decision): a checkpoint on a PROTECTED
      // branch (main/master/dev/develop) is REFUSED outright — no dialog,
      // no channel ask. It used to pop a confirmation the user (or the
      // orchestrator's project manager) could answer, but the user decided
      // "无论如何都不能在保护分支上面做 commit，checkpoint 也不行" — so the
      // gate's own commit now fails closed exactly like the agent's own
      // `git commit` does. To checkpoint, work on a feature branch.
      const here = currentBranch(root);
      // ANOTHER live session holds this worktree ⇒ no commit, of any kind.
      //
      // This is the gate's OWN commit path, and it does `git add -A` with the
      // hooks silenced — so a refused session would sweep the HOLDER's
      // uncommitted work into a commit and move HEAD under it. The agent's own
      // `git commit` is already refused (unmetRequirements), which is exactly
      // why this one has to be too: a rule the gate enforces on the agent and
      // then breaks on its own behalf is not a rule (reviewer P1, 2026-09-05).
      if (state.exclusivityRefusal) {
        return {
          content: [{ type: "text", text: state.exclusivityRefusal }],
          details: { committed: false },
          isError: true,
        };
      }

      if (here && isProtectedBranch(here)) {
        return {
          content: [{ type: "text", text:
            `review-gate: checkpoint 拒绝 — 不能在受保护分支 ${here} 上提交（checkpoint 也是 commit）。\n` +
            "请先切到功能分支：`git checkout -b <type>/<slug>`，名字用英文 kebab-case 概括这次改动" +
            "（如 `feat/aum-blacklist-purge`、`fix/auth-token-expiry`），**不要**用会话 id 或 `rg-child-…` 这类内部 handle" +
            " —— 这个分支名会跟着 PR 走，是要给人看的。然后重新 checkpoint。" }],
          details: { committed: false },
          isError: true,
        };
      }
      const message = String(params.message ?? "").trim();
      if (message.length === 0) {
        return {
          content: [{ type: "text", text: "review-gate: review_checkpoint rejected — the commit message is empty." }],
          details: { committed: false },
          isError: true,
        };
      }
      // P2 (round-4): REVIEW_GATE_BYPASS=1 also silences hooks/commit-msg —
      // the AI-attribution guard — so this tool must replicate it.
      const attribution = COMMIT_MSG_FORBIDDEN.some((re) => re.test(message));
      if (attribution) {
        const reason = refuseText("ai-attribution", message,
          "review_checkpoint rejected — commit message contains AI attribution. Rewrite without it.", ctx);
        if (reason) {
          return { content: [{ type: "text", text: reason }], details: { committed: false }, isError: true };
        }
      }
      // L5 (HARD): the same single rule as the bash commit path, through the
      // same function — no non-Latin letter in subject or body.
      const nonEn = nonEnglishCommitMessage(message);
      if (nonEn) {
        const kind: AppealKind = nonEn.part === "subject" ? "commit-subject" : "commit-body";
        const reason = refuseText(kind, nonEn.text,
          `review_checkpoint rejected — ${l5BlockReason({ kind, text: nonEn.text })} 用英文重写。`, ctx);
        if (reason) {
          return { content: [{ type: "text", text: reason }], details: { committed: false }, isError: true };
        }
      }
      const st = stateForRepo(root);
      // R-22 — WHAT `/gate-bypass` COVERS, decided by the user on 2026-08-30.
      //
      // The measured deadlock: a child's precommit failed for a reason that
      // had nothing to do with its change (an environment variable the
      // orchestration injected poisoned the test subprocess, R-15). The user
      // authorized `/gate-bypass`, the bypass took effect — and `judge_submit`
      // still refused, because the bypass only ever covered the SHIP gate. So
      // the lane had no way to finish: it could not pass precommit, could not
      // reach a review, and could not close out. Unattended, that is a dead
      // stop until a human wakes up.
      //
      // A bypass is the USER's authorization, and it now covers this
      // prerequisite too — but it never hides: the round is recorded as
      // bypassed, the reviewer is told, and declare_done says so.
      //
      // SCOPE, stated because it is easy to miss (round-1 Nit): the bypass is
      // a SESSION-level switch, not a one-shot token. Once the user grants it,
      // every later checkpoint in that session skips this prerequisite too —
      // which is why each of them stamps `precommitBypassed` and why the
      // receipt below says so out loud rather than only the first time.
      const precommitBypassed = st.bypass.active;
      // A STAGE THAT IS OFF IS NOT A PREREQUISITE (2026-09-22, user decision):
      // with `precommit` switched off the lane never runs, and a checkpoint
      // that demanded its PASS would be unsatisfiable — the same deadlock the
      // bypass above exists for, so it is released the same way (and said out
      // loud on the receipt below, where the bypass is named too).
      const precommitStageOn = stageIsOn("precommit", root);
      // B1 (2026-09-10): a checkpoint MAY land while its verification is IN
      // FLIGHT — that is the whole point of running the long lane beside the
      // chain instead of in front of it. The receipt is the live promise, not
      // a file: a restarted session has none, and a checkpoint with no live
      // verification is refused exactly as before (fail-closed). A FAIL that
      // arrives afterwards withdraws the round's READY (see
      // `recordReviewVerdict`) and wakes the agent with the reason.
      const verifyingNow =
        precommitStageOn &&
        !precommitBypassed &&
        precommitLaneRunning(root) &&
        st.precommit.verdict === "NOT_RUN";

      if (precommitStageOn && !precommitBypassed && !verifyingNow && st.precommit.verdict !== "PASS") {
        return {
          content: [{
            type: "text",
            text: `review-gate: checkpoint rejected — precommit is ${st.precommit.verdict} (a checkpoint bypasses READY only, never precommit). ` +
              "`judge_submit({role:\"reviewer\"})` runs the full lane before this step, so fix what it reported and submit the round again. " +
              "如果 precommit 是因为与本次改动无关的环境问题失败的，那是用户的决定：让用户 `/gate-bypass <理由>`，" +
              "bypass 会连这条前置一起覆盖，并把「本轮 precommit 被 bypass」写进记录。",
          }],
          details: { committed: false },
          isError: true,
        };
      }
      // Round-4 P2: dev-flow requires the FULL suite (lint + typecheck +
      // build + test) before a checkpoint and 送审 — a fast-lane PASS would
      // otherwise let a round go to review with the suite never run.
      if (precommitStageOn && !precommitBypassed && !verifyingNow && st.precommit.testScope !== "full") {
        return {
          content: [{
            type: "text",
            text: `review-gate: checkpoint rejected — the precommit PASS covers ${st.precommit.testScope ?? "unknown"}, not the full suite (dev-flow: 全量通过才允许送审). \`judge_submit({role:"reviewer"})\` always runs the FULL lane, so re-submit the round rather than reusing this narrowed PASS.`,
          }],
          details: { committed: false },
          isError: true,
        };
      }

      try {
        // The L3 pre-commit hook would reject this commit (no READY yet). The
        // tool IS the gate here: it verified precommit PASS (full) + English
        // + AI-attribution above — the checks the hooks perform — so
        // REVIEW_GATE_BYPASS=1 for the hook layer is the mechanism, not a
        // loophole.
        const status = gitRaw(root, ["status", "--porcelain"]);
        if (status.trim() === "") {
          return {
            content: [{ type: "text", text: "review-gate: review_checkpoint — nothing to commit (worktree is clean)." }],
            details: { committed: false },
          };
        }
        // Round-4 P2: refuse sensitive paths and report what is swept in.
        // Round-5 P2: porcelain has rename (`R  old -> new`) and quoted
        // non-ASCII (`A  "\344\270…"`) forms — take the DESTINATION side of
        // a rename and strip surrounding quotes before matching.
        // Round-6 P2 (measured): NEVER trim the whole status before slicing —
        // porcelain v1 lines carry a leading space in the X (index) column,
        // and `" M path".trim()` → `"M path"` shifts the path left, so
        // slice(3) eats the first character of the path.
        const changedLines = status.split("\n").filter((l) => l.trim().length > 0);
        const pathOf = (l: string): string => {
          let p = l.slice(3).trim();
          const arrow = p.indexOf(" -> ");
          if (arrow !== -1) p = p.slice(arrow + 4);
          if (p.startsWith("\"") && p.endsWith("\"")) p = p.slice(1, -1);
          return p;
        };
        const paths = changedLines.map(pathOf);
        const sensitive = paths.filter((p) => isSensitiveFile(pathResolve(root, p)));
        if (sensitive.length > 0) {
          return {
            content: [{
              type: "text",
              text: `review-gate: review_checkpoint rejected — sensitive path(s) in the worktree: ${sensitive.join(", ")}. Handle them by hand before checkpointing.`,
            }],
            details: { committed: false },
            isError: true,
          };
        }
        // FILE-SIZE gate (task book §9). Runs HERE, at the checkpoint, not at
        // edit time: blocking mid-write would fire while a file is half
        // written and force a blind restructure, whereas at the checkpoint
        // the whole shape exists and splitting it is mechanical. Only a NEW
        // oversized file blocks — an existing one gets a reminder, because it
        // grew a hundred lines at a time and forcing a rushed split at the
        // end of a task produces worse modules than the sprawl.
        // MERGE-AWARE BASE (2026-09-15, dashboard). "Absent from HEAD" and
        // "created by this session" are the same statement ONLY when HEAD is
        // the sole parent. Mid-merge, HEAD is still the branch tip, so every
        // file the OTHER side brought in looked newly created — measured: 104
        // staged additions, all 104 present in `origin/main`, three of them
        // over the size limit — and the checkpoint was refused with no legal
        // way through, because the review loop needs exactly that commit. The
        // session escaped by switching the gate off. lib/change-baseline.ts
        // carries the full account.
        const changeBases = readChangeBaseRefs(root);
        const sizeFacts = paths
          .filter(isSizeJudgedFile)
          .map((p) => {
            let content: string;
            try {
              content = readFileSync(pathResolve(root, p), "utf8");
            } catch {
              return undefined; // deleted (or unreadable): nothing to judge
            }
            const lines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;
            return { path: p, lines, isNew: isNewInWorktree(root, p, changeBases) };
          })
          .filter((f): f is { path: string; lines: number; isNew: boolean } => f !== undefined);
        const sizeCheck = fileSizeVerdict(sizeFacts);
        if (sizeCheck.blocking.length > 0) {
          return {
            content: [{
              type: "text",
              text: "review-gate: review_checkpoint rejected — " + formatFileSizeVerdict(sizeCheck),
            }],
            details: { committed: false, oversizedNewFiles: sizeCheck.blocking.length },
            isError: true,
          };
        }

        // DEPENDENCY-JUSTIFICATION gate (minimalism §5, 2026-09-08). Runs HERE,
        // at the checkpoint, next to the file-size gate — not at edit time:
        // blocking mid-write would fire on a half-written round, whereas at
        // the checkpoint the whole shape (manifest diff + round note) exists.
        // Only a NEW dependency without a written justification blocks — worth
        // stays with the judges (reviewer P1, goal/plan audit P0/P1).
        const depGate = (() => {
          // Root manifest only: a nested package.json (sub-package / fixture)
          // must be compared against ITS OWN base, not the root's — comparing
          // across paths judges every sub-package key as new (reviewer P2,
          // 2026-09-08). Nested manifests stay the reviewer's judgement call.
          if (!paths.some((p) => p === "package.json")) return { blocking: [] as string[] };
          let worktreeText: string | undefined;
          try {
            worktreeText = readFileSync(pathResolve(root, "package.json"), "utf8");
          } catch {
            return { blocking: [] as string[] }; // unreadable ⇒ no facts, never a block
          }
          // THE SAME MERGE-AWARE BASE as the size gate above (2026-09-15).
          // Mid-merge `HEAD:package.json` is the BRANCH side, so every
          // dependency `main` added would arrive as "new" and demand a written
          // justification for work this session never did. The first base that
          // carries the manifest is the one to compare against — HEAD whenever
          // HEAD has it, which is the pre-existing behaviour.
          const manifestBase = firstBaseContaining(root, "package.json", changeBases);
          let baseText: string | undefined;
          if (manifestBase) {
            try {
              const out = gitRaw(root, ["show", `${manifestBase}:package.json`]);
              baseText = out;
            } catch {
              baseText = undefined; // unreadable ⇒ no facts, never a block
            }
          } else {
            baseText = undefined; // no base (new repo / new manifest) ⇒ every key is new
          }
          const added = newDependencyNames(worktreeText, baseText);
          if (added.length === 0) return { blocking: [] as string[] };
          // The justification rides the agent's own words: the round note that
          // built this message, or the message itself. submitForReview derives
          // the message from the note via buildCheckpointMessage(note) — so pass
          // both, exactly as the goal's acceptance criterion 6 requires.
          return dependencyJustificationVerdict(
            added.map((name) => ({ name })),
            { note: typeof params.note === "string" ? params.note : "", message },
          );
        })();
        if (depGate.blocking.length > 0) {
          return {
            content: [{
              type: "text",
              text: "review-gate: review_checkpoint rejected — " + formatDependencyJustificationVerdict(depGate),
            }],
            details: { committed: false, unjustifiedDeps: depGate.blocking.length },
            isError: true,
          };
        }

        // WHAT THIS COMMIT TAKES — AND WHAT IT LEAVES (drill F3, 2026-09-20).
        //
        // `git add -A` took EVERYTHING, including files this session never
        // wrote and no `.gitignore` covers: measured in the drill, the seeded
        // `node_modules` symlink went into the history as `+1/−0 node_modules`
        // and the reviewer read it out of its own change index. The gate's own
        // commit is the one place nobody sees what is being added until
        // afterwards, and a commit is not undoable in someone else's
        // repository.
        //
        // So the sweep keeps:
        //   - every TRACKED change (`M`/`D`/`R`/…) — that is the round's work;
        //   - untracked paths THIS SESSION wrote through edit/write
        //     (`st.sessionEditedFiles`), which is what makes a NEW file
        //     reviewable at all;
        // and leaves every other untracked-and-unignored path where it is:
        // a file the session never touched is not this round's work, and
        // committing it silently is how a secret, an artefact carrying an
        // absolute path, or build output ends up in the history of the one
        // tool whose job is to be careful.
        //
        // The leftover list comes from `ls-files -z`, NOT from the porcelain
        // lines above: git QUOTES and escapes unusual names in `status`, and
        // handing that form back as a pathspec matches nothing.
        const untracked = gitRaw(root, ["ls-files", "--others", "--exclude-standard", "-z"])
          .split("\0").filter((p) => p.length > 0);
        const leftOut = planCheckpointSweep({ untracked, own: st.sessionEditedFiles ?? [] }).leftOut;
        gitText(root, ["add", "-A"], { timeout: 0 });
        if (leftOut.length > 0) {
          // Unstage, do not skip: `add -A` is still the right primitive for
          // the tracked half (deletes and renames included), and `reset`
          // leaves the leftover files exactly where they were — untracked, in
          // the worktree, and named in the receipt.
          gitText(root, ["reset", "-q", "--", ...leftOut]);
        }
        // No timeout: the commit runs the repo's own hooks.
        gitText(root, ["commit", "-m", message], {
          timeout: 0,
          env: { ...gitBaseEnv(), REVIEW_GATE_BYPASS: "1" },
        });
        const sha = gitText(root, ["rev-parse", "HEAD"]);
        // THE COMMITTED FILES, READ FROM THE COMMIT (drill F4). The receipt
        // used to describe the WORKTREE — which is how the symlink above could
        // be committed without ever appearing in it — so it now reports what
        // the commit actually carries.
        const sweptIn = gitRaw(root, ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", "--root", sha])
          .split("\0").filter((p) => p.length > 0);
        // Round-4 P2: the sha is persisted so prepare_review can compute
        // baseline..HEAD against it. Round-8 P1: record HEAD^ as prevSha —
        // the baseline start for the NEXT prepare — so the documented
        // checkpoint → prepare flow does not self-lock (baseline..HEAD would
        // be empty if the baseline were the checkpoint itself).
        // Root commit: no parent — prepare falls back to <sha>^.
        const prevSha = gitOrNull(root, ["rev-parse", "HEAD^"]) ?? "";
        st.checkpoint = {
          sha,
          prevSha,
          at: new Date().toISOString(),
          // R-22 — the bypass travels WITH the checkpoint. A round that
          // skipped precommit on the user's authorization must be legible
          // later: the reviewer is told, and declare_done says it out loud.
          ...(precommitBypassed ? { precommitBypassed: true } : {}),
        };

        persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{
            type: "text",
            text: `review-gate: checkpoint committed ${sha.slice(0, 12)} — \"${message}\". This commit is the review unit for the next round (baseline..HEAD).` +
              `\n\nCHECKPOINT_SHA=${sha}\nFiles: ${sweptIn.length} — ${sweptIn.slice(0, 20).join(", ")}${sweptIn.length > 20 ? " …" : ""}` +
              // WHAT DID NOT GO IN, SAID OUT LOUD (drill F3/F4). A path left
              // behind is invisible otherwise: the round reviews `baseline..HEAD`,
              // so a change parked in an uncommitted file is a change nobody
              // judged.
              (leftOut.length > 0
                ? `\n\n**未提交（${leftOut.length}）**：${leftOut.slice(0, 20).join(", ")}${leftOut.length > 20 ? " …" : ""}` +
                  "\n这些路径没有被 gitignore，也不是本会话通过 edit/write 写过的文件 —— 门禁没有把它们带进这次提交（它们仍在 worktree 里）。" +
                  "若其中有本轮的改动，请用 edit/write 工具重写一遍再送审：否则它不会进入审查范围 `baseline..HEAD`。"
                : "") +
              (precommitBypassed
                // R-22: never let a bypassed round read like a clean one.
                ? "\n\n**本轮 precommit 被 `/gate-bypass` 覆盖**（用户授权）：全量测试并没有在这份内容上跑过。" +
                  "这条事实已经记进 checkpoint，reviewer 与 declare_done 都会看到 —— 请在送审说明里写清 bypass 的理由。" +
                  "注意 bypass 是**会话级**的：在本会话里它对之后每一次 checkpoint 同样生效，" +
                  "根因修好之后请让用户 `/gate-reset`（或重开会话），别让它一直挂着。"

                : precommitStageOn
                ? "\n\nThe required full precommit already ran typecheck + build + the COMPLETE test suite on this exact content " +
                  "(cache: an unchanged input set is reused in seconds — do NOT manually re-run the full suite or `tsc`; " +
                  "run only targeted tests for files you keep editing, and let the round's own full lane be the single gate)."
                // THE SWITCH SAYS IT, NOT A SILENCE (2026-09-22): a reader must
                // never conclude the suite ran when it was released by choice.
                : "\n\n**precommit 环节已关闭**（用户设定的环节开关）：本轮不跑全量测试，ship 也不要求 precommit PASS。") +
              (sizeCheck.advisory.length ? "\n\n" + formatFileSizeVerdict(sizeCheck) : ""),
          }],
          details: { committed: true, sha, precommitBypassed, files: sweptIn, leftOut },

        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `review-gate: review_checkpoint failed — ${reason}` }],
          details: { committed: false },
          isError: true,
        };
      }
    },
  });

  // ---------- judge_submit + the judge tool families' wiring ----------

  /**
   * What the goal-audit recorder needs from this session. Declared once and
   * spread into `registerGoalTools` below, so the recorder the gate calls
   * directly and the approval tool registered for the agent can never drift
   * apart on which repo they read and write.
   */
  const goalPrereviewDeps: GoalPrereviewDeps = {
    // Getters: session_start re-resolves both, and a goal bound to the
    // pre-session cwd would be recorded where nothing ever reads it.
    primaryRepoRoot: () => primaryRepoRoot,
    cwd: () => cwd,
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    log: (message) => log(message),
  };

  /**
   * THE REVIEW LOOP'S HOST MODULES (t7, wave 3 of the split): the precommit
   * lane (lib/precommit-lane.ts), the submission chain (lib/review-chain.ts),
   * a judge round's lane / dispatch / settle (lib/judge-lane-host.ts,
   * lib/judge-round-dispatch.ts, lib/judge-round-settle.ts), the audit
   * engine's session deps (lib/audit-round-host.ts), the three recorders
   * (lib/verdict-host.ts, lib/sibling-verdict-host.ts), the cancel matrix's
   * effects (lib/round-cancel-host.ts) and the acceptance round
   * (lib/acceptance-host.ts). They reference each other in a cycle, so every
   * cross-module dep is a lambda read at CALL time, never a value captured
   * here.
   */
  const judgeLanes = createJudgeLanes(host, {
    registry: { judgeHierarchy, setHierarchy, dropAudits },
    runTmux: (argv) => runTmux(argv),
    loopGoalConfirmed: (root, st) => loopGoalConfirmed(root, st),
    reviewScopeFor: (root, st) => reviewScopeFor(root, st),
    settledConclusion: (st) => settledConclusion(st),
    previousRoundFindings: (st) => previousRoundFindings(st),
  });
  const { resolveJudgeLane, reapReviewScratch } = judgeLanes;
  const { dispatchJudgeRound } = createJudgeRoundDispatch(host, {
    registry: {
      judgeHierarchy, setHierarchy, dropAudits, callerIdentity, paneOwnerIdentity,
      absorbJudgeModelEvents, nextJudgeRound, dropDeadForeignJudges,
    },
    lanes: judgeLanes,
    reviewTargets,
    stageIsOn: (stage, root) => stageIsOn(stage, root),
    runTmux: (argv) => runTmux(argv),
    channelIO,
    tmuxScope,
    resolveJudgeLaunch,
    sweepStaleJudgeSessionDirs,
  });
  const { judgeChildByRole, findJudgeChild, checkpointAtFor, roundBindingOf, settleFinishedRounds } =
    createJudgeRoundSettle(host, {
      pi,
      registry: {
        judgeHierarchy, pendingAudits, ownJudges, absorbJudgeModelEvents,
        reloadJudgeHierarchy, callerIdentities, paneOwnerIdentity,
      },
      channelIO,
      runTmux: (argv) => runTmux(argv),
      announcedRequestIds: () => announcedRequestIds,
      auditRoundDeps: (ctx) => auditRoundDeps(ctx),
      applyRoundCancel: (kind, root, ctx) => applyRoundCancel(kind, root, ctx),
      resumeParkedReady: (root, ctx) => resumeParkedReady(root, ctx),
    });
  const { precommitLaneRunning, abortPrecommitLane, waitForQuietLane, startPrecommitBeside } =
    createPrecommitLane(host, {
      pi,
      callTool,
      toolText,
      applyCancelPlan: (plan, root) => applyCancelPlan(plan, root),
      resumeParkedReady: (root, ctx, landing) => resumeParkedReady(root, ctx, landing),
    });
  const { recordReviewVerdict } = createReviewVerdictRecorder(host, {
    reviewTargets,
    resolveToolRepo: (requested) => resolveToolRepo(requested),
    reviewScopeFor: (root, st) => reviewScopeFor(root, st),
    stageIsOn: (stage, root) => stageIsOn(stage, root),
    laneVerificationWaived: (root, st) => laneVerificationWaived(root, st),
    precommitLaneRunning,
    qualityRoundInFlight,
    clearBypassToken: () => clearBypassToken(),
    setLoopArmed: (armed) => { loopArmed = armed; },
    maybeStrategicReset: (st) => maybeStrategicReset(st),
    lastGateEventAt,
  });
  const { recordQualityVerdict, recordAcceptanceVerdict } = createSiblingVerdictRecorders(host, {
    reviewTargets,
    resolveToolRepo: (requested) => resolveToolRepo(requested),
    stageIsOn: (stage, root) => stageIsOn(stage, root),
    lastGateEventAt,
  });
  const { cancelJudgeRound, resumeParkedReady, applyCancelPlan, applyRoundCancel } = createRoundCancel(host, {
    pi,
    registry: { judgeHierarchy, setHierarchy, absorbJudgeModelEvents },
    runTmux: (argv) => runTmux(argv),
    reviewTargets,
    stageIsOn: (stage, root) => stageIsOn(stage, root),
    laneVerificationWaived: (root, st) => laneVerificationWaived(root, st),
    judgeChildByRole,
    closeJudgePaneOf: judgeLanes.closeJudgePaneOf,
    reapReviewScratch,
    precommitLaneRunning,
    abortPrecommitLane,
    qualityRoundInFlight,
    recordReviewVerdict,
  });
  const { auditRoundDeps, auditRunDeps, buildGoalAuditRound } = createAuditRoundHost(host, {
    registry: { judgeHierarchy, setHierarchy, dropAudits, pendingAudits, persistJudgeHierarchy },
    channelIO,
    lastUiCtx,
    callTool,
    toolText,
    extractTaskText,
    goalPrereviewDeps,
    judgeChildByRole,
    checkpointAtFor,
    dispatchJudgeRound,
    recordReviewVerdict,
    recordQualityVerdict,
    recordAcceptanceVerdict,
    selfAuditWait,
    forwardWaitUpdates,
    selfSessionDeps: () => selfSessionDeps(),
  });
  const { submitForReview, runGoalAudit, runPlanAudit } = createReviewChain(host, {
    callTool,
    toolText,
    extractTaskText,
    stageIsOn: (stage, root) => stageIsOn(stage, root),
    reviewTargets,
    waitForQuietLane,
    startPrecommitBeside,
    buildGoalAuditRound,
    auditRunDeps,
  });
  const { armAcceptanceRound } = createAcceptanceHost(host, {
    reviewTargets,
    runTmux: (argv) => runTmux(argv),
    stageIsOn: (stage, root) => stageIsOn(stage, root),
    repoLabel: (root) => repoLabel(root),
    loopGoalConfirmed: (root, st) => loopGoalConfirmed(root, st),
    readSessionLoopGoal,
    loopGoalPathIn,
    judgeChildByRole,
    dispatchJudgeRound,
  });

  pi.registerTool({
    name: "judge_submit",
    label: "Submit To Judge",
    description:
      "Submit one round of work to a judge role — the ONE entry point for reviewer / adviser / " +
      "goal-auditor. A reviewer submission runs the chain itself, and for a round that carries " +
      // ONE ENTRY POINT FOR BOTH JUDGES OF A ROUND (2026-09-16): a round that
      // carries code starts `quality-auditor`, `reviewer` and the full precommit
      // lane together, and the cancel matrix (lib/quality-round.ts) decides who
      // stops whom. A reviewer READY that lands before the quality verdict is
      // HELD until that verdict arrives (never recorded early, never re-run).
      "code that chain starts the QUALITY round (`quality-auditor`), the functional reviewer and " +
      "the full precommit lane TOGETHER — the three judge the same commit range, so a non-READY " +
      "quality verdict kills the reviewer's pane and the lane, a non-READY reviewer kills the " +
      "quality pane and the lane, and a FAILED lane kills only the reviewer. You never call this " +
      "twice for one round, and the quality judge is not a role you can name. " +
      "The gate owns everything procedural: the session id and its directory " +
      "(derived from role+repo, so the judge's context carries across rounds), pane open vs. channel-queued vs. " +
      "fresh kill, and the channel verdict. You pass WHO and WHAT; you never pass a session id, a " +
      "title or a directory. It returns as soon as the round is SUBMITTED, not when the judge is " +
      "done — the round ends when its channel report lands, and the gate wakes you with " +
      "the standard report (verdict, evidence pointer, record note, open questions). A living pane takes the round " +
      "through its channel (nothing is silently dropped): wait for it, or pass " +
      "fresh:true to kill the pane and start over.",
    parameters: Type.Object({
      // The SUBMITTABLE subset of the judge roles — `quality-auditor` is
      // routed to by the chain, never named by the agent (lib/judge-prompt.ts).
      role: Type.Enum(SUBMITTABLE_JUDGE_ROLES),
      task: Type.String({
        description:
          "reviewer: what you changed this round, in your words (the gate wraps it in the review " +
          "task it builds). " + ROUND_NOTE_HINT + " " +
          "adviser / goal-auditor: the question or the draft to judge.",
      }),
      message: Type.Optional(Type.String({
        description:
          "reviewer only: the checkpoint commit message (English, Conventional Commits — the gate " +
          "makes it a legal one if it is not). Omit it and the gate derives the message from your " +
          "task text — but only the parts of it that are ENGLISH: L5 accepts no non-Latin letter " +
          "in a commit message, so a Chinese round note yields the default subject and no body. " +
          "Write this field whenever you want the history to say something — that is the normal " +
          "case in this project.",
      })),
      reason: Type.Optional(Type.String({
        description:
          "reviewer only: why THIS round is worth a review when the polish gate is armed (two " +
          "consecutive READYs, or the same file polished for three rounds). The gate refuses the " +
          "round without it and tells you so.",
      })),
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
      fresh: Type.Optional(Type.Boolean({
        description: "Kill the role's RUNNING process and dispatch this round anyway. Its transcript (and therefore its context) survives — this abandons the round in flight, not the conversation.",
      })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const target = resolveToolRepo(params.repo);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const root = target.root;
      // NOTHING OF ITS OWN TO REVIEW, NOTHING TO DISPATCH (2026-09-19). Under a
      // user-granted scope limit with no edits of its own this session has
      // ALREADY been told the ship gate is disarmed — but `judge_submit` still
      // ran the whole chain: a full precommit, a checkpoint, a dispatch, and a
      // reviewer that could only ever conclude BLOCKED, because its range is the
      // branch's pre-existing content, which this session is not allowed to
      // touch. Measured in prime's t3-report-update: that shape burned minutes
      // per round and then deadlocked on `declare_done` (its own goal forbade
      // fixing what the reviewer found). The refusal states what the caller's
      // gate state already says: there is nothing of its own to review.
      if (params.role === "reviewer") {
        const scoped = stateForRepo(root);
        if (scoped.scopeLimit !== undefined && !scoped.hasCodeChange && !scoped.hasDocChange) {
          return {
            content: [{
              type: "text",
              text: buildRejection({
                what: "judge_submit 被拒 —— 本会话没有任何自己的改动，且用户已批准缩小审查范围",
                why:
                  "门禁只覆盖本会话的改动（`request_scope_limit` 已生效），而本会话在这个仓库里零 edit：" +
                  "没有东西需要审。派出去的 reviewer 只能拿到分支上**别人**的 diff，然后判出这一轮修不了的 " +
                  "finding —— 这正是 prime 的 t3-report-update 卡死的那条路。",
                by: "agent",
                next:
                  "直接收尾（`declare_done`）—— ship 拦截已经解除。若确实要审本会话以外的内容，" +
                  "先让用户 `/gate-reset` 撤掉范围限制。",
              }),
            }],
            details: { refused: "no-session-edits-under-scope-limit" },
            isError: true,
          };
        }
      }
      // NON-GIT SHORT-CIRCUIT: the review chain (precommit → checkpoint →
      // baseline..HEAD) is meaningless outside a repository, and its git
      // steps would leak fatal to the terminal. Refuse up front.
      if (!sessionInGit) {
        return {
          content: [{
            type: "text",
            text: buildRejection({
              what: "judge_submit 被拒 —— 当前不在 git 仓库里",
              why: "送审链条（precommit → checkpoint → baseline..HEAD）在仓库外没有意义，git 步骤会直接报致命错误。",
              by: "agent",
              next: "换到仓库目录里再送审；如果这一轮本来就不属于任何仓库（纯调研 / 临时脚本），用 `set_gate_mode(\"explore\")` 或 `normal` 收尾。",
            }),
          }],
          details: { submitted: false },
          isError: true,
        };
      }
      const role = String(params.role ?? "");
      // The SAME constant the parameter enum is built from: a second list here
      // is how the schema and this check drifted apart (reviewer P2,
      // 2026-09-15 — `JUDGE_ROLES` had grown to include `quality-auditor`, so
      // a hand-named quality round passed this check while the schema refused
      // it, and the two disagreed about what "unknown role" means).
      if (!Object.hasOwn(SUBMITTABLE_JUDGE_ROLES, role)) {
        return {
          content: [{
            type: "text",
            text: buildRejection({
              what: `judge_submit 被拒 —— 未知的 role "${role}"`,
              why: `agent 能指定的 judge 角色只有 ${Object.keys(SUBMITTABLE_JUDGE_ROLES).join(" / ")} 这几个；` +
                "`quality-auditor` 由门禁自己按轮次路由，不是你能点名的角色。",
              by: "agent",
              next: "把 role 换成上面列出的一个再调用一次。",
            }),
          }],
          details: { submitted: false },
          isError: true,
        };
      }
      const task = String(params.task ?? "").trim();
      if (!task) {
        return {
          content: [{
            type: "text",
            text: buildRejection({
              what: "judge_submit 被拒 —— task 是空的",
              why: "task 就是这一轮的送审说明，是 reviewer 看到的全部改动上下文；没有它，审查只能靠猜。",
              by: "agent",
              next: "用一两句话说清这轮改了什么、为什么（改了哪些文件 / 哪个行为变了 / 为什么这么做），写进 task 再调用一次。",
            }),
          }],
          details: { submitted: false },
          isError: true,
        };
      }
      // THE GOAL STAGE RELEASES THE GOAL AUDIT TOO (2026-09-22, lib/loop-stages.ts):
      // `propose_loop_goal` short-circuits when it is off, and this is the other
      // entrance to the same judge — running a minutes-long audit for a contract
      // the user switched off would be work nobody asked for, and a step the
      // agent could mistake for one it still owes.
      if (role === "goal-auditor" && !stageIsOn("goal")) {
        return {
          content: [{
            type: "text",
            text: "review-gate: goal 环节已关闭（用户设定的环节开关）—— 本轮不跑 goal 审计，也不需要协商 goal。\n" +
              "直接按用户的要求干活即可；要恢复 goal 环节，让用户重开开关（再调一次 `choose_loop_stages`）。",
          }],
          details: { submitted: false, goalStageOff: true },
          isError: true,
        };
      }
      // SUBMITTING FOR REVIEW IS A CHAIN, and the gate runs all of it: the
      // agent describes its change, the gate proves it builds (precommit),
      // freezes it (checkpoint), computes the reviewed range (prepare) and
      // only then dispatches. Any step failing sends the round back with the
      // reason — nothing half-submitted, no manual four-step dance.
      let reviewTask = task;
      /**
       * WHICH judge this submission actually dispatches — see `submitForReview`.
       * `null` = the user switched review AND quality off, so the chain froze
       * the round and dispatched nobody (the receipt below says so).
       */
      let dispatchRole: string | null = role;
      /** Printed when the quality round was skipped (docs/data-only round). */
      let skipNote: string | undefined;
      /** Printed when the quality stage is ON and the head is already judged. */
      let qualityStandingNote: string | undefined;
      /**
       * Where THIS round's findings stream lives — the channel the agent
       * reads while the judge is still working. Every role that has one
       * reports it in the reply; criterion 1 requires it in the return.
       */
      let streamPath: string | undefined;
      /**
       * THE FUNCTIONAL BRIEF OF A PARALLEL ROUND (2026-09-16): present when the
       * chain routed this submission to the quality judge, in which case the
       * reviewer starts in the same breath (see the loop below).
       */
      let parallelReviewer: { taskText: string; streamPath?: string } | undefined;
      /**
       * WHAT THE CHAIN FROZE, for the receipt (drill F4). Set by the reviewer
       * chain only — the adviser and goal-audit branches make no commit.
       */
      let checkpointFacts: { sha: string; files: string[]; leftOut: string[] } | undefined;
      // Live progress for the whole submission: precommit → checkpoint →
      // prepare → dispatch. Each step publishes as it starts and as it ends,
      // so a round that stalls shows WHERE it stalled.
      const progress = createProgressReporter({
        title: `review-gate: judge_submit(${role})`,
        onUpdate: onUpdate as ToolUpdate | undefined,
      });
      if (role === "reviewer") {
        const chain = await submitForReview({
          root,
          note: task,
          message: params.message ? String(params.message) : undefined,
          reason: params.reason ? String(params.reason) : undefined,
          ctx,
          progress,
        });
        if (!chain.ok) {
          return {
            content: [{ type: "text", text: chain.text }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        reviewTask = chain.taskText;
        streamPath = chain.streamPath;
        // THE CHAIN DECIDES WHICH ROUND RUNS (2026-09-15). The agent asked for
        // "a review"; whether that means the quality judge, the functional
        // judge, or both in sequence is the gate's routing rule — and it is
        // deliberately NOT a role the agent can name.
        dispatchRole = chain.role;
        skipNote = chain.skipNote;
        qualityStandingNote = chain.qualityStandingNote;
        parallelReviewer = chain.parallelReviewer;
        checkpointFacts = chain.checkpoint;
      }

      // The other two roles are the same shape: the gate builds the task the
      // judge receives (carryover, criteria, transcript pointer, findings
      // stream) from what the agent SAID, so the agent never assembles a
      // judge's brief by hand.
      if (role === "goal-auditor") {
        // A goal audit streams its findings too (criterion 2): the agent can
        // fix the draft while the auditor is still working, exactly as it
        // does with a code review. The task and its stream come from the ONE
        // assembler — this branch used to derive both itself.
        const built = await buildGoalAuditRound(task, root, ctx);
        if (!built.ok) {
          return {
            content: [{ type: "text", text: "review-gate: 本轮未受理 — goal 审计任务无法生成。\n" + built.error }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        streamPath = built.streamPath;
        reviewTask = built.task;
        // (The draft is remembered only AFTER the dispatch is accepted —
        // see below. Recording it here would let a REFUSED submission
        // overwrite the draft a still-running audit is judging.)
      }
      if (role === "adviser") {
        const prepared = await callTool("prepare_adviser", { repo: root }, ctx);
        if (prepared.isError) {
          return {
            content: [{ type: "text", text: "review-gate: 本轮未受理 — adviser brief 无法生成。\n" + toolText(prepared) }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        // Same ordering rule as the reviewer note: the gate's brief first, the
        // main session's question after it as untrusted data. The adviser was
        // the role actually steered into an 8-second READY by a question that
        // opened the task (round 5, 2026-09-05).
        reviewTask = composeWithUntrustedData(extractTaskText(toolText(prepared)), [
          { tag: "main_session_question", label: "你要回答的问题（来自主会话）：", text: task },
        ]);
      }
      // ---- THE TWO JUDGES OF ONE ROUND, STARTED TOGETHER (2026-09-16) ----
      //
      // The quality judge and the functional judge are dispatched back to back
      // (two spawns, a second apart) and judge CONCURRENTLY: they read the same
      // immutable `baseline..HEAD`, so neither has anything to wait for. The
      // three-way race with the precommit lane is already running behind them.
      //
      // WHO STOPS WHOM is NOT decided here — `roundCancelPlan`
      // (lib/quality-round.ts) owns that table, and the settle path applies it.
      // The only thing this loop owns is that a round never starts HALF: if the
      // quality dispatch fails, the reviewer is not dispatched at all (a
      // functional round whose quality half never started could only ever be
      // refused at recording time — see `decideQualityHold`).
      const judges = [
        ...(dispatchRole === null ? [] : [{ role: dispatchRole, task: reviewTask, streamPath }]),
        ...(parallelReviewer === undefined
          ? []
          : [{ role: "reviewer" as const, task: parallelReviewer.taskText, streamPath: parallelReviewer.streamPath }]),
      ];
      if (judges.length === 0) {
        // A RELEASED STAGE DISPATCHES NOBODY (2026-09-22). No judge stage is due,
        // so there is no pane to open — and the receipt still names what the
        // chain DID do (precommit, the checkpoint), because "nothing was
        // submitted" and "nothing needed submitting" are different facts.
        //
        // `dispatchRole === null` ⟺ the review stage is OFF (quality round P2,
        // 2026-09-22): the chain is built for a role, and the ONE thing that
        // hands back `role: null` is `submitForReview` on a released review
        // stage — a session with review off but quality on gets QUALITY_ROLE and
        // never reaches this branch. So the reviewer line below is stated
        // unconditionally: the `reviewStageOn ? …` guard it used to have was an
        // unreachable branch claiming a case that cannot happen, and the
        // comment beside it described that case out loud.
        const qualityStageOn = stageIsOn("quality", root);
        return {
          content: [{
            type: "text",
            text: [
              "review-gate: 本轮没有派任何 judge。",
              "- 功能审查 reviewer：环节已关闭 —— ship 时该卡点视为满足。",
              ...(qualityStageOn ? [] : ["- 代码质量审查 quality-auditor：环节已关闭 —— 不派质量轮。"]),
              ...(qualityStandingNote === undefined ? [] : [`- ${qualityStandingNote}`]),
              ...(skipNote === undefined ? [] : [`- 质量轮跳过：${skipNote}`]),
              ...(checkpointFacts === undefined
                ? []
                : [`- checkpoint ${checkpointFacts.sha.slice(0, 12)} 已冻结 ${checkpointFacts.files.length} 个文件。`]),
              // ONLY WHEN THE QUALITY STAGE IS OFF: the review switch is always
              // off here, so the only remaining reason to say “re-open the
              // switches” is a quality stage the user turned off.
              ...(qualityStageOn
                ? []
                : ["要恢复哪个环节，就再调一次 `choose_loop_stages`（用户重新勾选，门禁自己弹框）。"]),
            ].join("\n"),
          }],
          details: {
            submitted: true,
            judges: [],
            // A CONSTANT, BECAUSE THIS BRANCH HAS ONE CAUSE THAT ALWAYS HOLDS
            // (quality round P2, 2026-09-22): `judges.length === 0` is only
            // ever reached with `role: null`, and the chain produces that on
            // `!reviewOn` alone — so the functional stage IS off here, every
            // time. The previous round's `!reviewStageOn || !qualityStageOn`
            // was a tautology dressed up as a condition. The field says “a
            // stage is off”, never “every stage is off”: the quality stage's
            // own state is what the prose above states.
            stageOff: true,
          },
        };
      }
      /**
       * Every judge this submission started, as it was ACCEPTED — each with its
       * OWN findings stream (B1, 2026-09-18). A parallel round starts two
       * judges that write two streams, so a single routed path on the receipt
       * left the functional round's channel written but unread.
       */
      const accepted: Array<{
        role: string;
        judgeId: string;
        paneId: string;
        sessionDir: string;
        reused: boolean;
        streamPath?: string;
      }> = [];
      for (const judge of judges) {
        // The title is a DISPLAY label the gate derives itself (B5: it must not
        // reach the session's directory, or every round starts a new session).
        const title = `${judge.role}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
        progress.step(`spawn ${judge.role}`);
        const d = await dispatchJudgeRound({
          root,
          role: judge.role,
          title,
          task: judge.task,
          fresh: params.fresh === true,
          ...(judge.streamPath === undefined ? {} : { streamPath: judge.streamPath }),
          // THE ONE PERMISSION TO DISPATCH A REVIEWER WITHOUT A STANDING: this
          // submission dispatched this round's quality judge a line above, and
          // the standing is now checked at RECORD time instead. Never inferred
          // from the registry — a flag the caller must pass.
          ...(judge.role === "reviewer" && judges.length > 1 ? { qualityRoundDispatched: true } : {}),
        });
        if (!d.ok) {
          // A KEPT PANE IS A DISPATCHED ROUND (2026-09-05). A boot-check timeout
          // is the failure that names a pane AND delivered the task (it rode in
          // on the argv), so the audited draft goes on record
          // here too: without it a late report has no pending kind to bind to and
          // the whole round is lost. `judge_spawn` makes the same call, and the
          // two must not disagree about what a kept pane means.
          //
          // …AND A PANE IS NOT ENOUGH TO SAY THAT (quality round P2, 2026-09-16):
          // the channel-write failure on a REUSED pane also carries one, with the
          // task never delivered. `delivered` is what tells the two apart, which
          // is why the abandonment below reads it and not `paneId`.
          if (d.delivered === true && role === "goal-auditor") {
            pendingAudits.set(root, { kind: "goal", draft: task, startedAt: new Date().toISOString() });
            persistJudgeHierarchy();
          }
          progress.fail("spawn 失败");
          // A ROUND NEVER STARTS HALF, IN EITHER DIRECTION (functional round P2,
          // 2026-09-16). The loop above only guarded quality→reviewer; when the
          // REVIEWER could not start, the quality judge was already running and
          // registered, and the reply said the submission FAILED — so the agent
          // re-submitted, started a second quality round beside a head nobody
          // was waiting on any more, and the first one's verdict was orphaned.
          //
          // …EXCEPT WHEN THE TASK ACTUALLY REACHED THE JUDGE (functional
          // round P1 / quality P2, 2026-09-16). Two failures keep a pane and
          // they mean opposite things: a boot-check timeout means the task rode
          // in on the pane's argv and the round may still complete (cancelling
          // the judges already accepted would kill a healthy quality round,
          // leave this very pane running, and make the round's READY
          // unrecordable while the receipt points the agent at it), while a
          // failed channel write into a REUSED pane delivered nothing at all.
          // `delivered` is that distinction — never `paneId`, which both sites
          // carry.
          if (d.delivered !== true) {
            for (const already of accepted) {
              cancelJudgeRound(root, already.role, "本轮另一个 judge 的这一个轮次没投递出去 —— 这一轮整体作废");
            }
          }
          const lead = "review-gate: judge_submit 失败 — ";
          return {
            content: [{ type: "text", text: `${lead}${d.error ?? "review pane 未能开出来"}` }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        // THE ROUND REMEMBERS ITS OWN QUALITY JUDGE, on the target it prepared.
        // This is what `qualityRoundInFlight` reads: a live pane elsewhere in
        // the registry proves nothing (the pane is reused across rounds), so
        // "this round dispatched one and has not recorded its verdict" has to
        // be recorded per round.
        if (judge.role === QUALITY_ROLE && d.judgeId) noteQualityRoundDispatched(root, d.judgeId);
        // ONE ROUND SENT OUT (2026-09-17, user decision): the strip's `轮 N`.
        // Counted HERE — a reviewer dispatch that reached the judge — and not
        // where the verdict is recorded, because "how many rounds have I sent"
        // is the question that reading answers, and a round a judge is still
        // reading was sent. A REFUSED dispatch returns above, so a round that
        // never left is never counted; the adviser / goal-auditor branches
        // cannot reach this line at all.
        if (judge.role === "reviewer") {
          const sent = stateForRepo(root);
          sent.sentReviewRounds = (sent.sentReviewRounds ?? 0) + 1;
          // Persisted HERE and not with the round's other bookkeeping: the
          // count is what the strip renders, and the strip has to move the
          // moment the round is submitted (persist refreshes the widget).
          persistRepo(ctx as unknown as ExtensionContext, root);
        }
        accepted.push({
          role: judge.role,
          judgeId: d.judgeId ?? "(pending)",
          paneId: d.paneId ?? "(pending)",
          sessionDir: d.sessionDir ?? "(pending)",
          reused: d.reused,
          ...(judge.streamPath === undefined ? {} : { streamPath: judge.streamPath }),
        });
        progress.done(d.reused ? "已受理（续接同一会话）" : "已受理（新会话）");
      }
      // The round is ACCEPTED — only now is the audited draft on record. A
      // refused submission (a busy role, a failed spawn) must never replace
      // the draft a running audit is judging: its verdict would be recorded
      // against text no auditor ever read, and propose_loop_goal would then
      // show the user an unaudited goal.
      if (role === "goal-auditor") {
        pendingAudits.set(root, { kind: "goal", draft: task, startedAt: new Date().toISOString() });
        persistJudgeHierarchy();
      }
      // THE REPLY NAMES EVERY JUDGE THIS SUBMISSION STARTED (2026-09-16). The
      // parallel path starts two, and naming only the routed one while printing
      // the OTHER's id/pane is how a receipt ends up describing a judge that is
      // not the one it points at — the agent then waits on the wrong pane.
      // `routed` keeps the detail fields honest for the same reason: they are
      // matched by ROLE, never by position.
      const routed = accepted.find((a) => a.role === dispatchRole) ?? accepted[accepted.length - 1];
      const lines = [
        `review-gate: 已受理本轮任务 — ${accepted.map((a) => `${a.role}（judge ${a.judgeId}）`).join(" + ")}。`,
        ...accepted.map((a) => `- ${a.role}: pane ${a.paneId} · transcript ${a.sessionDir}`),
        // EVERY JUDGE'S STREAM, MATCHED BY ROLE (B1, 2026-09-18). The text used
        // to name only the ROUTED judge's stream, so the functional reviewer's
        // path — the one the agent fixes findings from while both judges are
        // still working — was nowhere on the receipt nor in `details`.
        ...accepted.flatMap((a) =>
          a.streamPath === undefined ? [] : [`- ${a.role} 的 findings 流（边审边修）: ${a.streamPath}`]),
        // The routing is the gate's, so the gate says which way it went —
        // otherwise "the reviewer is running" and "the quality judge is
        // running beside it" look the same to the agent, and only one of them
        // means "your code is being judged for quality as well as for whether
        // it works".
        ...(dispatchRole === QUALITY_ROLE
          ? [
              ...(parallelReviewer === undefined
                // QUALITY ALONE (2026-09-22): the user switched the functional
                // stage off, so the receipt must not promise a reviewer that
                // was never started.
                ? [
                    "- 本轮**只**跑质量轮（功能审查环节已关闭，用户设定的环节开关）：质量轮审代码本身" +
                      "（哲学/架构/正确性/性能，再看简洁可读可维护，判定表 `docs/code-quality-rules.md`），" +
                      "外加按开关运行的 precommit。你不需要为这一轮再调 judge_submit；要恢复功能审查，" +
                      "让用户重开开关（`choose_loop_stages`）。",
                  ]
                : [
                    "- 本轮**同时**跑两个 judge：质量轮（审代码本身：哲学/架构/正确性/性能，再看简洁可读可维护，" +
                      "判定表 `docs/code-quality-rules.md`）与功能轮 reviewer（审需求符合度/测试覆盖/文档同步），" +
                      "外加与它们并行的全量 precommit。你不需要为这一轮再调 judge_submit。",
                    "- 谁先判不过由门禁收口：质量轮非 READY ⇒ 终止 reviewer 与 precommit；reviewer 非 READY ⇒ 终止质量轮与 precommit；" +
                      "precommit FAIL ⇒ 只终止 reviewer，质量轮继续。reviewer 先交卷 READY 而质量轮未交卷时，那份 READY 会被**扣下**，等质量轮结论落地再补记。",
                  ]),
            ]
          : []),
        ...(skipNote ? [`- 质量轮跳过：${skipNote}`] : []),
        // THE COMMIT THIS ROUND JUDGES, AND WHAT WENT INTO IT (drill F4). The
        // receipt named panes, transcripts and streams but not the reviewed
        // unit itself — so "the gate committed a file I never wrote" (F3) was
        // unreadable here, which is the only place the agent looks.
        ...(checkpointFacts === undefined
          ? []
          : [
              `- checkpoint ${checkpointFacts.sha.slice(0, 12)} 已冻结 ${checkpointFacts.files.length} 个文件：` +
                `${checkpointFacts.files.slice(0, 12).join(", ")}${checkpointFacts.files.length > 12 ? " …" : ""}`,
              ...(checkpointFacts.leftOut.length === 0
                ? []
                : [
                    `- **未提交（${checkpointFacts.leftOut.length}）**：${checkpointFacts.leftOut.slice(0, 12).join(", ")}` +
                      `${checkpointFacts.leftOut.length > 12 ? " …" : ""}` +
                      " —— 未被 gitignore、也不是本会话用 edit/write 写过的文件；若其中有本轮改动，用它重写一遍再送下一轮。",
                  ]),
            ]),
        "- 本轮结束（通道 report 落盘）即完成；门禁会用标准报告唤醒你（结论、证据位置、记录情况、待答问题）。现在别等，先做别的确定性工作。",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          submitted: true,
          role: dispatchRole,
          /** Did THIS submission route to the quality judge? (diagnostic) */
          qualityRound: dispatchRole === QUALITY_ROLE,
          /**
           * EVERY judge this submission started, in dispatch order — each with
           * its own `streamPath` when it has one, so `details` carries BOTH
           * streams of a parallel round, not just the routed one.
           */
          judges: accepted,
          ...(checkpointFacts === undefined ? {} : { checkpoint: checkpointFacts }),
          // THE ROUTED JUDGE'S OWN FIELDS, MATCHED BY ROLE (quality round P2,
          // 2026-09-16): the parallel round starts two judges, and a `role`
          // naming one of them beside the other's id/pane is the same lie the
          // reply text had. Position would drift the moment the order changes;
          // the role cannot.
          reused: routed.reused,
          paneId: routed.paneId,
          judgeId: routed.judgeId,
          sessionDir: routed.sessionDir,
          streamPath,
        },
      };
    },
  });
  // `review_spawn` / `review_watch` / `review_send` are GONE, module and all
  // (lib/judge-relay-tools.ts is deleted). Unlike the prepare family they were
  // not even used internally: `judge_submit` dispatches rounds itself and
  // registers its own completion watcher, so those three were purely a second
  // way to ask for the same thing.


  /**
   * The two tools that OBSERVE or END a judge session — judge_close and
   * judge_wait — live in lib/judge-session-tools.ts; only their wiring is
   * here. What they need from THIS file (the repo resolution, the child
   * registry, the announced-question cursor, the pending audit, the
   * hosted-wait watchdog) arrives as this deps object, and nothing else of
   * them does: every rule they apply is unit-testable without a spawned judge.
   */
  // WHERE EACH ONE LIVES. `judge_close` stays on the INTERNAL host: its only
  // callers are the gate's own audit chains closing the auditor they opened.
  // `judge_wait` is registered on BOTH — the same implementation, once for
  // those chains and once for the AGENT, which needs a way to wait for its
  // judge's next message that is not a hand-written sleep loop (2026-09-05,
  // user decision D1).
  /**
   * THE GATE'S OWN DEPS HANDLE (2026-09-08) — `judgeSessionDeps` is the object
   * the agent-facing `judge_wait` / `judge_close` registrations close over;
   * the gate's self-audit chains (`selfAuditWait`, `auditRunDeps.closeJudge`)
   * call the SAME `doWait` / `doClose` implementations through this accessor
   * instead of `callTool`, so the repo-addressing check inside `addressJudge`
   * is bypassed for the gate's own auditor only. One object, not a copy: any
   * drift between "what the agent's wait checks" and "what the gate's wait
   * checks" would be a second implementation (哲学三). Agent-facing tools keep
   * the full check — they still go through `addressJudge` with `repo`.
   */
  function selfSessionDeps(): JudgeSessionToolDeps {
    return judgeSessionDeps;
  }

  const judgeSessionDeps: JudgeSessionToolDeps = {

    resolveRepo: (requested) => {
      const resolved = resolveToolRepo(requested);
      if (resolved.ok) ensureHierarchyLoaded(resolved.root);
      return resolved;
    },
    callerId: () => callerIdentity(),
    paneOwner: () => paneOwnerIdentity(),
    // …and the identity a successor REPLACED, so a handover does not orphan the
    // reviewers its predecessor had already dispatched (2026-09-14).
    callerIds: () => callerIdentities(),
    hierarchy: () => { dropDeadForeignJudges(); return judgeHierarchy(); },
    saveHierarchy: (next) => setHierarchy(next),
    findChildById: (judgeId) => {
      const c = ownJudges().find((e) => e.judgeId === judgeId);
      // ONE projection, in the registry module (lib/hierarchy.ts
      // `judgeChildRecordOf`): the two hand-written copies this used to be
      // dropped the window coordinates the moment they were added to the
      // entry, and a judge window that cannot be addressed as
      // `<session>:<@window>` is a judge window nothing can close.
      return c ? judgeChildRecordOf(c) : undefined;
    },
    findChild: (root, role, judgeId) => {
      const c = findJudgeChild(root, role, judgeId);
      return c ? judgeChildRecordOf(c, root) : undefined;
    },
    channelIO: () => channelIO,
    channelHome: () => undefined,
    // THE ONE READING A HEARTBEAT CANNOT GIVE (goal 6(d), 2026-09-21): the
    // judge's transcript mtime. A live pane whose gate is reporting proves a
    // PROCESS; only writes to the transcript prove a TURN is running — which
    // is exactly the difference the 552-second freeze fell into.
    transcriptActivityAt: (child) => {
      if (!child.sessionDir) return undefined;
      try {
        let newest: number | undefined;
        for (const name of readdirSync(child.sessionDir)) {
          if (!name.endsWith(".jsonl")) continue;
          try {
            const at = statSync(pathJoin(child.sessionDir, name)).mtimeMs;
            if (newest === undefined || at > newest) newest = at;
          } catch { /* one unreadable file is not a verdict on the rest */ }
        }
        return newest;
      } catch {
        return undefined;
      }
    },
    // THE FLOOR UNDER THAT READING — from the REGISTRY, not from the channel
    // (quality round P1, 2026-09-21). The first version rebuilt it as "the
    // newest `instruct` on the judge's channel", which is only written on the
    // LIVE-PANE-REUSE path: a fresh open carries its task as a task file, and
    // goal/plan audits never write an instruct at all. So the reading was the
    // PREVIOUS round's timestamp or nothing — precisely the case this floor
    // exists for. `JudgeEntry.spawnedAt` is stamped on EVERY dispatch and is
    // already the registry's own answer to "when did this round start".
    roundDispatchedAt: (child) => {
      const at = judgeHierarchy()[child.judgeId]?.spawnedAt;
      if (at === undefined) return undefined;
      const ms = Date.parse(at);
      return Number.isFinite(ms) ? ms : undefined;
    },
    // …AND NOTHING NARROWS IT FURTHER. An earlier version also asked the
    // channel "is this judge parked on an unanswered question", to keep a
    // waiting round out of the reading. Three review rounds found three ways
    // for that predicate to go stale (a question settled in the pane, an
    // abandoned one, and the cross-round channel having no floor), each one
    // silently disabling the reading for the rest of that lane's life. It was
    // never needed: the receipt REPORTS a reading, and already names "parked on
    // a dialog nobody answered" as one of its three explanations. A reading
    // does not have to know which one it is.
    tmux: (argv) => runTmux(argv),
    tmuxServer: () => tmuxServerFrom(process.env),
    // Decorated panes were counted around here once — a guest test plus a
    // manager's child count — to decide whether a close could take the window's
    // shared label bar down. Both are GONE with that decision (2026-09-17, user
    // decision): taking the bar down writes `pane-border-status`, which resizes
    // EVERY pane in the window (measured: SIGWINCH, rows 84 ↔ 83), so the bar is
    // turned on by whoever opens a decorated pane and never turned off.
    now: () => Date.now(),
    readText: (path) => {
      try {
        if (!existsSync(path)) return undefined;
        return readFileSync(path, "utf8");
      } catch { return undefined; }
    },
    announcedQuestions: () => announcedRequestIds,
    markQuestionsAnnounced: (ids) => { for (const id of ids) announcedRequestIds.add(id); },
    // The wait reads the round through the SAME binding the recorder applies.
    roundBinding: (child) => roundBindingOf(child),

    // The wait closes its round through the SAME engine the settle path uses,
    // so a report cannot be recorded twice (one cursor, written in one place).
    settleRound: async (judgeId, root) => {
      // Before the verdict is read: whatever the pane reported about its own
      // model is a fact about this round (lib/judge-model-rotation.ts). The
      // wait path reaches it through `absorbModelEvents` before moving its
      // cursor; this covers the settle SWEEP, which no wait drives.
      absorbJudgeModelEvents(root, judgeId);
      const settled = await settleAuditRound(auditRoundDeps(undefined), { judgeId, root });
      switch (settled.status) {
        case "recorded": {
          // THE SAME HAND-OFF THE SWEEP DOES (reviewer P1, 2026-09-15). This
          // path can win the cursor (a `judge_wait` that sees the report
          // first), and the sweep then only ever sees `already-consumed` — so
          // a hand-off wired into the sweep alone would never run, leaving the
          // held functional round stranded forever while the reply told the
          // agent not to re-submit.
          const handOffNote = await applyRoundCancel(settled.kind, root, undefined);
          return {
            text: settled.text,
            // Its own field, so `judge_wait`'s wake-up prints it too (the
            // recorded note is first-line-only).
            ...(handOffNote === undefined ? {} : { handOffNote }),
            verdict: settled.verdict,
            hasVerdict: settled.hasVerdict,
            ...(settled.bindingNote === undefined ? {} : { bindingNote: settled.bindingNote }),
            // The round's own scope stamp, so a `judge_wait` wake-up says the
            // same thing the settle sweep would have said about this round.
            ...(settled.scope === undefined ? {} : { scope: settled.scope }),
          };
        }
        case "advice":
          return { advice: settled.text, hasVerdict: false };
        case "unrecorded":
          return { verdict: settled.verdict, hasVerdict: settled.hasVerdict };
        default:
          return { hasVerdict: false };
      }
    },
    dropPendingAudit: (root) => dropAudits(root),
    cancelWaitTimer: () => cancelChildWaitTimer(),
    // The wait's side of the model events: the opener acts on them BEFORE its
    // cursor moves past them, so nothing the pane reported is ever dropped.
    absorbModelEvents: (root, judgeId) => absorbJudgeModelEvents(root, judgeId),
  };
  registerJudgeSessionTools(internalHost, judgeSessionDeps);
  // The SAME implementation on the agent surface — one waiting tool, two
  // hosts. A second registration is not a second implementation: both
  // executes close over `judgeSessionDeps`.
  registerJudgeWaitTool(pi, judgeSessionDeps);

  // -----------------------------------------------------------------------
  // WORKER TOOLS (2026-09-21) — the tmux-pane replacement for the
  // pi-subagents `Agent` tool, and the answer to the user's requirement that
  // opening a subagent and opening a review pane be the same act.
  //
  // SURFACE MATTERS, and it is the only guard these need: the four dispatch
  // tools go on the AGENT surface and never inside a judge or worker pane (a
  // judge is read-only by contract; a worker that could dispatch workers is a
  // recursion nobody asked for), while `worker_report` goes on the WORKER
  // surface alone, so a main session can never fabricate a worker's answer.
  // -----------------------------------------------------------------------
  if (!readJudgeSideEnv(process.env) && !readWorkerSideEnv(process.env)) {
    const workerRegistryPath = () => pathJoin(activeRepoRoot.current, WORKER_REGISTRY_RELPATH);
    registerWorkerTools(pi, {
      ownPane: () => process.env.TMUX_PANE?.trim() || undefined,
      paneAlive: (paneId) => {
        try {
          return judgePaneAlive(runTmux, paneId) === true;
        } catch {
          // Unreadable tmux is missing INFORMATION: a worker whose liveness
          // cannot be read is treated as gone, and `worker_submit` opens the
          // window again under the SAME session id — which is the safe
          // direction (a resumed transcript beats a message nobody reads).
          return false;
        }
      },
      openPane: async (spec) => {
        const opened = await openSessionWindow(runTmux, {
          scope: tmuxScope,
          cwd: spec.cwd,
          layout: "own-session-window",
          role: spec.role,
          decor: spec.decor,
          command: spec.command,
          register: spec.register,
        });
        return opened.ok ? { ok: true, paneId: opened.paneId } : { ok: false, error: opened.error };
      },
      closeWindow: (coords) => {
        try {
          // The factory's own close: `kill-window -t <session>:<@id>`, so a
          // stale id can only reach a window of this session's own tmux
          // session. The ERROR travels with the failure (2026-09-25, quality
          // round P2): `worker_close` has to tell “it is already gone” from
          // “tmux refused”, and a boolean cannot carry that.
          const closed = closeSessionWindow(runTmux, coords);
          return closed.ok ? { ok: true } : { ok: false, error: closed.error };
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
      // STABLE OPENER IDENTITY, not the pane (reviewer P1, 2026-09-21):
      // `TMUX_PANE` changes on every restart, re-attach and handover, and it is
      // half of every worker channel path — so a worker dispatched before one
      // of those would report into a file nobody reads and the caller would
      // wait on an empty one. The session id survives all three (pi resumes
      // the same transcript by it), which is what keeps a worker reachable.
      openerId: () => state.sessionId?.trim() || "gate",
      paneOwner: () => paneOwnerIdentity(),
      repoRoot: () => activeRepoRoot.current,
      channelIO,
      channelHome: () => undefined,
      workDirFor: (workerId) => pathJoin(activeRepoRoot.current, ".pi", WORKER_SESSION_ROOT, workerId),
      // THE OTHER HALF OF THE RESUME KEY: the session id alone finds nothing
      // if the transcript directory is not the one it was written to.
      // NOT under `.pi/judge-sessions/` (reviewer P2, 2026-09-21): that root is
      // swept by the judge lifecycle, whose staleness rule matches a directory
      // name ending in `-<8 hex>` and is NOT in the judge registry — and a
      // worker id like `abc12345` produces exactly that shape, so its
      // transcript directory would be removed the next time the sweep ran.
      sessionDirFor: (workerId) =>
        pathJoin(activeRepoRoot.current, ".pi", WORKER_SESSION_ROOT, workerSessionDirName(workerId), "sessions"),
      writeFile: (path, content) => {
        try {
          mkdirSync(pathDirname(path), { recursive: true });
          writeFileSync(path, content, "utf8");
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      // No file yet, or an unreadable one: both mean "no workers", and a
      // registry that cannot be read must never be repaired into a guess
      // (lib/worker-pane.ts drops malformed ENTRIES for the same reason).
      readRegistry: () => parseWorkerRegistry(readJsonIfExists(workerRegistryPath())),
      saveRegistry: (registry) => {
        try {
          writeFileAtomic(workerRegistryPath(), serializeWorkerRegistry(registry));
        } catch (error) {
          log(`worker registry write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      agents: () => {
        const cfg = freshProjectConfig(activeRepoRoot.current);
        return effectiveAgentsConfig(cfg.agentsGlobal, cfg.agentsProject).map;
      },
      // The registry check the renderer used to do for every role — worker
      // presets never reach `applyAgentConfigLayer` (it filters them), so this
      // is where their specs get validated instead of at pane-open time.
      validateModel: (spec) => {
        const verdict = validateSpec(loadRegistry(), spec);
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
      tmuxServer: () => tmuxServerFrom(process.env),
      now: () => Date.now(),
      log,
    });
  }
  if (readWorkerSideEnv(process.env)) {
    registerWorkerReportTool(pi, {
      env: () => process.env,
      channelIO: () => channelIO,
      now: () => Date.now(),
      cwd: () => cwd,
    });
  }

  /**
   * THE PANE'S OWN MODEL SELF-HEAL (2026-09-10).
   *
   * The judge side is the ONLY party that sees this session's provider errors:
   * the opener is parked in a wait, and the channel carries verdicts, not
   * stack traces. So the pane watches its own runs and, when one ends with
   * `stopReason: "error"` AND pi has nothing left to retry (`agent_settled`),
   * it walks the role's chain (lib/judge-model-rotation.ts): switch model,
   * nudge itself to carry on, and REPORT the event so the opener can cool the
   * failed slot down.
   *
   * Why `agent_settled` and not the first failed request: a burst of 503s that
   * recovers 30 seconds later is the normal shape of a busy provider
   * (measured), and rotating on it would move every round to the backup for no
   * reason. The terminal condition is "pi gave up", which is exactly what
   * `agent_settled` with a failed last message means.
   */
  function installJudgeModelRotation(role: string): void {
    /** The last run's terminal error, cleared by any run that ended cleanly. */
    let lastRunError: string | undefined;
    const rotation = createModelRotation({
      chain: () => {
        const cfg = freshProjectConfig(cwd);
        const { map } = effectiveAgentsConfig(cfg.agentsGlobal, cfg.agentsProject);
        return modelChainFor(map, role, cwd);
      },
      currentSpec: () => {
        const model = latestCtx?.model as { provider?: string; id?: string } | undefined;
        return model?.provider && model.id ? `${model.provider}/${model.id}` : undefined;
      },
      switchTo: async (spec) => {
        const parsed = parseModelSpec(spec);
        if (!parsed.provider || !parsed.id) return `spec 里解析不出 provider/id：${spec}`;
        if (!latestCtx) return "会话还没有可用的 ctx（读不到模型注册表）";
        try {
          const model = latestCtx.modelRegistry.find(parsed.provider, parsed.id);
          if (!model) return `注册表里没有这个模型：${parsed.provider}/${parsed.id}`;
          if (!(await pi.setModel(model))) return `pi.setModel 拒绝了 ${parsed.provider}/${parsed.id}`;
          // The slot's own level, applied AFTER the switch (setModel resets it
          // to the new model's default). A level the model cannot take is not
          // a reason to abandon a working model — pi clamps it, and an unknown
          // suffix is dropped here rather than passed on as a lie.
          if (parsed.thinking && KNOWN_THINKING_LEVELS.has(parsed.thinking)) {
            pi.setThinkingLevel(parsed.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
          }
          return true;
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          return `切换 ${spec} 时抛错：${text.slice(0, 160)}`;
        }
      },
      nudge: (text) => {
        try {
          // The same idiom the thinking-loop notice uses: idle ⇒ a plain user
          // message (this IS the next turn); anything still streaming ⇒ steer,
          // so the notice rides that run instead of being rejected.
          if (latestCtx?.isIdle()) pi.sendUserMessage(text);
          else pi.sendUserMessage(text, { deliverAs: "steer" });
        } catch { /* the report still went out */ }
      },
      report: (event) => {
        const binding = childBinding();
        // The state tells the truth about what happens NEXT: a rotation means
        // the round goes on (working), an exhausted chain means it stopped.
        if (binding) reportState(binding, event.exhausted ? "idle" : "working", { modelEvent: event });
      },
      notify: (text, level) => {
        try { latestCtx?.ui.notify(text, level); } catch { /* headless */ }
      },
    });
    pi.on("agent_end", (event) => {
      const messages = (event as { messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }> }).messages ?? [];
      let error: string | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]!;
        if (message.role !== "assistant") continue;
        error = message.stopReason === "error" ? (message.errorMessage ?? "model error") : undefined;
        break;
      }
      lastRunError = error;
    });
    pi.on("agent_settled", async () => {
      const error = lastRunError;
      lastRunError = undefined;
      if (error === undefined) return;
      const event = await rotation.onModelFailure(error);
      // A rotation that FAILED to switch (no auth, unknown id) is still a fact
      // the opener must not be blind to — the attempt list is in the event.
      if (event) log(`model fallback: ${event.spec} failed (${event.error ?? "error"}) → ${event.to ?? "chain exhausted"}`);
    });
  }

  // judge_conclude is the ONLY tool that exists on one side only: a judge
  // concludes its own round through it, and the main session must never see
  // it (a main session that could self-certify a verdict breaks the gate).
  // The guard is the registration itself — anti-forgery by surface, not secret.
  if (readJudgeSideEnv(process.env)) {
    // Round 1's task arrives as a FILE in the environment (later rounds come
    // through the channel drain), and it is the only place this pane can learn
    // the range its inspection evidence is measured against.
    noteJudgeTaskText(judgeTaskText());
    registerJudgeConcludeTool(pi, {
      env: () => process.env,
      repoRoot: () => cwd,
      hierarchyPath: (root) => pathJoin(root, ".pi", HIERARCHY_FILENAME),
      readText: (path) => {
        try {
          if (!existsSync(path)) return undefined;
          return readFileSync(path, "utf8");
        } catch { return undefined; }
      },
      channelIO: () => channelIO,
      channelHome: () => undefined,
      now: () => Date.now(),
      inspection: () => judgeInspection,
      // The audit stamp for THIS round, read out of the task text this pane
      // was opened (or instructed) with. Unlike the evidence above it is NOT
      // reset between rounds: a later round arriving through the channel
      // carries its own scope block and overwrites it, and a round whose text
      // says nothing new is still running against the same range.
      reviewScope: () => judgeReviewScope(),
      // The round the TASK said it is, when a task said so — the one reading
      // that cannot be overtaken by the next dispatch's numbering.
      taskRound: () => judgeTaskRound,
      // THIS pane's own context usage, taken at the conclusion — the reading
      // the opener cannot take, and the one its rotation policy runs on
      // (lib/judge-rotation.ts). Same wrapper the orchestration layer uses;
      // `undefined` when the host offers no usage, which never rotates.
      contextPercent: () => contextPercentOf(latestCtx as unknown as { getContextUsage?: () => unknown }),
      inspectionPass: () => inspectionPass,
      noteInspectionRefusal: (block) => { lastBlockedInspection = block; },
      noteConcluded: (usedPass) => {
        // A round's evidence belongs to that round: the next one starts blind.
        judgeInspection = emptyInspection();
        if (usedPass) inspectionPass = undefined;
      },
    });
    // The pane watches its OWN model: the opener cannot (it is parked in a
    // wait) and no other surface sees this process's provider errors.
    installJudgeModelRotation(readJudgeSideEnv(process.env)!.role);
  }
  registerJudgeSpawnTools(pi, {
    callerId: () => callerIdentity(),
    paneOwner: () => paneOwnerIdentity(),
    hierarchy: () => { dropDeadForeignJudges(); return judgeHierarchy(); },
    saveHierarchy: (next) => setHierarchy(next),
    channelIO: () => channelIO,
    channelHome: () => undefined,
    tmux: (argv) => runTmux(argv),
    ownPane: () => process.env.TMUX_PANE?.trim() || undefined,
    // Every judge this session opens is a window of THIS session's own tmux
    // session — never a pane taken from the user's window.
    scope: tmuxScope,
    tmuxServer: () => tmuxServerFrom(process.env),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    resolveRepo: (requested) => {
      const resolved = resolveToolRepo(requested);
      if (resolved.ok) ensureHierarchyLoaded(resolved.root);
      return resolved;
    },
    // THE lane resolver, shared with `dispatchJudgeRound` — one policy, one
    // retire path, whichever tool starts the judge.
    lane: (root, role, opener) => {
      const resolved = resolveJudgeLane(root, role, opener);
      return {
        lane: resolved.decision.lane,
        roundsInObject: resolved.decision.roundsInObject,
        retirePrevious: () => { resolved.retirePrevious(); },
      };
    },
    launchConfig: (root, role, opener, lane) => {
      const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener, lane));
      // ONE launch resolver for both dispatch surfaces (judge_spawn here,
      // judge_submit's chain in dispatchJudgeRound): re-read the config, pick
      // the first slot that is not cooling down.
      const judgeId = judgeSessionIdFor(role, shortRepoHash(root), opener, lane);
      // Same reason as `dispatchJudgeRound`: the events this pane reported last
      // round must be acted on (and their cursor advanced) before
      // `registerJudge` replaces the entry that carries the cursor.
      absorbJudgeModelEvents(root, judgeId);
      const launch = resolveJudgeLaunch(root, role, workDir, role, judgeId);
      if (!launch.ok) {
        return { ok: false, error: launch.error };
      }
      const sessionDir = pathJoin(workDir, "sessions");
      try { mkdirSync(sessionDir, { recursive: true }); } catch { /* best effort */ }
      return { ok: true, model: launch.spec, sysPromptPath: launch.sysPromptPath, sessionDir };
    },
    buildGoalAuditTask: async (draft, root, ctx) => {
      // The third caller of the ONE assembler (the other two are the audit
      // chain and judge_submit's goal-auditor branch).
      const built = await buildGoalAuditRound(draft, root, ctx);
      if (!built.ok) return { ok: false, error: "goal 审计任务无法生成" };
      return { ok: true, task: built.task, streamPath: built.streamPath };
    },
    buildPlanAuditTask: async (root) => {
      const read = readPlanFile(root);
      if (!read.plan) {
        return { ok: false, error: `读不到可审计的 plan：${read.problems.join("；") || "plan 文件不存在"}` };
      }
      const plan = read.plan;
      const hash = planAuditHash(plan);
      const previous = state.planAudit;
      const carryover = previous && previous.hash !== hash ? formatPlanAuditCarryover(previous) : undefined;
      return {
        ok: true,
        task: buildPlanAuditTask(plan, {
          ...(carryover === undefined ? {} : { carryover }),
          ...(carryover !== undefined && previous?.planText ? { prevPlanText: previous.planText } : {}),
          repoRoot: root,
          ...(state.sessionId ? { sessionId: state.sessionId, sessionDir: sessionDirForCwd(cwd) } : {}),
        }),
      };
    },
    writeJudgeTaskFile: (root, role, opener, task, lane) => {
      try {
        const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener, lane));
        const sessionDir = pathJoin(workDir, "sessions");
        mkdirSync(sessionDir, { recursive: true });
        const taskPath = pathJoin(sessionDir, `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.md`);
        writeFileSync(taskPath, task, "utf8");
        return { ok: true, path: taskPath };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    pendingAuditKind: (root) => {
      const pending = pendingAudits.get(root);
      return pending?.kind === "goal" || pending?.kind === "plan" ? pending.kind : undefined;
    },
    rememberGoalAudit: (root, draft) => {
      pendingAudits.set(root, { kind: "goal", draft, startedAt: new Date().toISOString() });
      persistJudgeHierarchy();
    },
    rememberPlanAudit: (root) => {
      const read = readPlanFile(root);
      if (!read.plan) return { ok: false, error: `读不到 plan：${read.problems.join("；") || "plan 文件不存在"}` };
      const plan = read.plan;
      pendingAudits.set(root, {
        kind: "plan",
        hash: planAuditHash(plan),
        planText: formatPlanSummary(plan),
        startedAt: new Date().toISOString(),
      });
      persistJudgeHierarchy();
      return { ok: true };
    },
    forgetAudit: (root) => {
      pendingAudits.delete(root);
      persistJudgeHierarchy();
    },
  });

  /**
   * `prepare_review` — the preparation of ONE code-review round (the
   * immutable baseline..HEAD range, the polish gate, the findings stream and
   * the review target a verdict later binds to) — lives in
   * lib/review-prepare-tools.ts; only its wiring is here. What it needs from
   * THIS file (the repo resolution, gate state and its persistence, the
   * loop-goal readers, the scope decision, the review-target registry and
   * three git reads) arrives as this deps object, and nothing else of it
   * does: every branch it applies is unit-testable without a repository.
   */
  registerReviewPrepareTools(internalHost, {
    resolveRepo: (requested) => resolveToolRepo(requested),
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    sessionDir: (ctx) => sessionDirFromContext(ctx, cwd),
    goalConfirmed: (root, st) => loopGoalConfirmed(root, st),
    goalTextForReviewers: (root) => goalTextForReviewers(root),
    loopGoalPath: (root) => loopGoalPathIn(root),
    reviewScope: (root, st) => reviewScopeFor(root, st),
    previousRoundFindings: (st) => previousRoundFindings(st),
    settledConclusion: (st) => settledConclusion(st),
    registerReviewTarget: (root, target, ctx) => {
      reviewTargets.set(root, target);
      // A PARKED READY DOES NOT SURVIVE ITS ROUND (2026-09-15). A new target
      // means a new round was dispatched, so the parked one is history: if the
      // lane that follows ever PASSed on that old tree, replaying it would
      // record a READY the session has already moved past — and `review`
      // belongs to the round in flight. The tree comparison in the lane's own
      // landing checks this too; clearing it here is what keeps the sidecar
      // from carrying a parked conclusion nobody is waiting on any more.
      const st = stateForRepo(root);
      if (st.pendingReady) {
        delete st.pendingReady;
        persistRepo(ctx as ExtensionContext, root);
      }
    },
    git: {
      // Deliberately NOT the `isAncestor` helper above: that one runs with
      // `encoding: "utf8"` and no `stdio`, which lets git's "fatal: Not a
      // valid object name" reach the USER's stderr. prepare_review has always
      // silenced this probe (a rewritten chain is an expected outcome here,
      // not an error), so the `stdio: "ignore"` is carried over verbatim.
      isAncestor: (root, maybeAncestor, branch) =>
        gitOrNull(root, ["merge-base", "--is-ancestor", maybeAncestor, branch]) !== null,
      revParse: (root, rev) => gitText(root, ["rev-parse", rev]),
      // The FALLBACK read, and it carries the same two flags as the numstat
      // probe so the two can never disagree about which files moved: without
      // `--no-renames` name-only reports a rename as the NEW path alone (the
      // numstat path reports both halves of it), and without
      // `core.quotePath=false` a non-ASCII path comes back as an escaped C
      // string no shell would resolve.
      changedFilesInRange: (root, baseline, head) =>
        gitText(root, ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", `${baseline}..${head}`])
          .split("\n").filter(Boolean),
      // The reviewer's read plan is built from this (lib/parallel-review.ts's
      // formatChangeIndex): one call gives both the file list and the sizes.
      //
      // TWO FLAGS THAT ARE SECURITY, NOT TASTE (round-2 P1):
      //
      //  - `--no-renames`. Rename detection is ON by default, and numstat then
      //    prints a renamed file as the pseudo-path `old => new` — which the
      //    reviewer is told to paste into a shell, where `>` is a REDIRECT.
      //    With detection off the rename reads as a delete plus an add: two
      //    real paths, and the information is not lost.
      //  - `core.quotePath=false`, so a non-ASCII path is emitted as the bytes
      //    git will accept back rather than as an escaped C string (`"\303\251"`)
      //    that no shell would resolve. Paths are still quoted at the point
      //    the command is rendered (formatChangeIndex's shellQuotePath),
      //    because spaces and metacharacters remain possible.
      //
      // Binary files report `-` for both counts — git's way of saying "no line
      // counts", which reads as 0 here so a binary file still appears in the
      // index (a missing row would drop it from the plan entirely).
      numstatInRange: (root, baseline, head) =>
        gitText(root, ["-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", `${baseline}..${head}`])
          .split("\n").filter(Boolean)
          .map((line) => {
            const [added, deleted, ...rest] = line.split("\t");
            return {
              file: rest.join("\t"),
              added: added === "-" ? 0 : Number(added) || 0,
              deleted: deleted === "-" ? 0 : Number(deleted) || 0,
            };
          })
          .filter((row) => row.file !== ""),
      // The two history probes the baseline resolution consults: where a
      // rewritten chain still holds the reviewed content, and where the branch
      // itself starts. Both are decisions OF the prepare module, so both go
      // through this seam (lib/review-prepare-tools.ts's `ReviewPrepareGit`)
      // instead of being called behind its back.
      branchBaseBaseline: (root) => branchBaseBaseline(root),
      squashPointBaseline: (root, reviewedTree, startSha) =>
        squashPointBaseline(root, reviewedTree, startSha),
      worktreeClean: (root) =>
        gitText(root, ["status", "--porcelain"]) === "",
    },
    readText: (path) => {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
  });

  /**
   * The two ADVISORY preparations — `prepare_adviser` (the incremental brief
   * for a consultation on the current goal) and `prepare_goal_audit` (the
   * auditor's task for a DRAFT goal) — live in lib/advisory-prepare-tools.ts;
   * only their wiring is here. Neither computes a commit range nor registers
   * a review target, which is exactly why they are a separate module from the
   * reviewer's round preparation.
   */
  registerAdvisoryPrepareTools(internalHost, {
    resolveRepo: (requested) => resolveToolRepo(requested),
    cwd,
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    sessionDir: (ctx) => sessionDirFromContext(ctx, cwd),
    goalConfirmed: (root, st) => loopGoalConfirmed(root, st),
    goalTextForReviewers: (root) => goalTextForReviewers(root),
    loopGoalPath: (root) => loopGoalPathIn(root),
    readText: (path) => {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
    ensureDir: (path) => {
      try { mkdirSync(path, { recursive: true }); } catch { /* best-effort */ }
    },
    incrementSinceTree: (root, tree) => incrementSinceTree(root, tree),
    headCommitTree: (root) => headCommitTree(root),
  });
  // ---------- recording a reviewer verdict (a plain function) ----------
  // The three recorders, the cancel matrix and the parked re-ask are wired
  // above, where the review loop's host modules are created (t7).

  // ---------- review tooling: change collection ----------

  /** Collect changed files: tracked edits vs HEAD plus untracked, repo-relative. */
  async function listChangedFiles(
    cwd: string,
  ): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
    const { execFile } = await import("node:child_process");
    const run = (args: string[]): Promise<{ ok: true; lines: string[] } | { ok: false; error: string }> =>
      new Promise((resolve) => {
        execFile("git", args, { cwd, env: gitBaseEnv() }, (err, stdout) => {
          if (err) {
            resolve({ ok: false, error: String(err.message ?? err).split("\n")[0] });
          } else {
            resolve({ ok: true, lines: stdout.split("\n").filter((l) => l.trim().length > 0) });
          }
        });
      });
    const tracked = await run(["diff", "--name-only", "HEAD"]);
    if (!tracked.ok) return { ok: false, error: `git diff failed: ${tracked.error}` };
    const untracked = await run(["ls-files", "--others", "--exclude-standard"]);
    if (!untracked.ok) return { ok: false, error: `git ls-files failed: ${untracked.error}` };
    return { ok: true, files: [...new Set([...tracked.lines, ...untracked.lines])] };
  }


  // ---------- run_precommit tool (the ONLY path to a PASS) ----------

  // INTERNAL, not registered: precommit is the first step of `judge_submit`,
  // which always runs the FULL lane before it freezes anything.
  internalTool({
    name: "run_precommit",
    label: "Run Precommit",
    description:
      "ADVANCED / internal: `judge_submit({role:\"reviewer\"})` runs this itself as step 1 of the " +
      "submission chain — call it directly only to check the lane on its own. " +
      "Runs the trusted precommit checks and records the verdict. This is the ONLY way to " +
      "record a precommit PASS — the gate never trusts a PASS parsed from bash output. " +
      "The extension spawns the bundled runner itself and verifies a private nonce receipt.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ description: "'fast' (default) or 'full'" })),
      repo: Type.Optional(Type.String({
        description:
          "Absolute path of the repository to run the checks in. REQUIRED once the session has edited " +
          "more than one repository — the PASS binds to that repo's own worktree fingerprint and " +
          "unblocks only that repo.",
      })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      // Available in every mode: explore allows edits/bash, so the agent may
      // legitimately want to verify its investigation with the trusted runner.
      const mode = params.mode === "full" ? "full" : "fast";
      // P-multi: precommit runs in — and binds its PASS to — the repo named by
      // `repo` (mandatory once several repos are in play), falling back to the
      // last-edited repo in a single-repo session; never just the session cwd.
      // The target DIR for the primary repo stays the session cwd (its
      // precommit may be repo-subdir-aware); other repos run at their root.
      // stateForRepo(primary) IS `state`, so no global swap is needed: the
      // local `st` writes land on the right object and persistRepo persists
      // to the right sidecar. (A global `state = stateForRepo(...)` swap
      // across the long `await runTrustedPrecommit` was rejected: a parallel
      // edit tool_result in that window would arm the WRONG repo's state and
      // persist it to the primary sidecar — losing hasCodeChange, a fail-open.)
      // `repo` overrides the last-edited default; with several repos in play
      // it is mandatory, because a PASS recorded against the wrong repo
      // leaves the intended one permanently unshippable.
      const target = resolveToolRepo(params.repo);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const targetRoot = target.root;
      // NON-GIT SHORT-CIRCUIT: the runner's change detection and fingerprint
      // binding are git-backed; outside a repository the run would fail its
      // own checks and leak fatal noise. Nothing to verify there — refuse.
      if (!sessionInGit) {
        return {
          content: [{ type: "text", text: "review-gate: 非 git 目录 —— run_precommit 不可用（无仓库可检查）。" }],
          details: { ok: false },
          isError: true,
        };
      }
      const targetDir = targetRoot === primaryRepoRoot ? cwd : targetRoot;
      const st = stateForRepo(targetRoot);
      // Same liveness rule as the verdict recorder: running precommit proves the
      // agent is not waiting on the user — clear any stale question pause.
      delete st.pausedQuestion;
      // P1 fix: pass the target dir explicitly. runTrustedPrecommit previously
      // derived its own process.cwd(), which can differ from ctx.cwd
      // (e.g. pi --cwd), running checks — and binding the PASS fingerprint
      // — in the wrong dir.
      // targetDir is where the checks RUN; targetRoot is the repo the run log
      // belongs to (`.pi/` is only gate-owned at the root — see keepRunLog).
      // Live progress: the runner's own log (plan preamble first, then each
      // check's output) is shown UNDER a step line that carries the lane and
      // the elapsed time — a precommit used to be a silent multi-minute call
      // with no way to see what it was doing. The frames go to `onUpdate`
      // only; the verdict text below is what the agent gets.
      const progress = createProgressReporter({
        title: `review-gate: precommit (${mode})`,
        onUpdate: onUpdate as ToolUpdate | undefined,
      });
      progress.step(mode === "full" ? "lint + typecheck + build + 全量测试" : "lint + typecheck + build + 相关测试");
      const outcome = await runTrustedPrecommit(targetDir, targetRoot, mode, signal, (partial) => {
        progress.tail(partial.content.map((c) => c.text).join("\n"));
      });
      progress.done(outcome.verdict);

      if (outcome.verdict === "PASS") {
        // Bind PASS to the fingerprint recomputed AFTER the runner finished
        // (a lint:fix step may have modified files). `testScope` travels with
        // the binding because it decides what this PASS may authorize: a fast
        // lane narrowed to the changed files can clear a commit, never a push.
        st.precommit = {
          verdict: "PASS",
          fingerprint: outcome.fingerprint,
          at: new Date().toISOString(),
          mode,
          testScope: outcome.testScope,
          // CARRIED, never decided here: the pass-coverage record is written
          // (and revoked) by `nextFullPassTree` at the lane's own completion,
          // which is the only place that knows the tree the lane STARTED on.
          ...(st.precommit.lastFullPassTree ? { lastFullPassTree: st.precommit.lastFullPassTree } : {}),
        };
      } else {
        // P0 fix: "ERROR" is a runner-protocol outcome, NOT a GateState
        // PrecommitVerdict enum member. Persisting it would make loadSidecar
        // and the git pre-commit hook reject the whole sidecar as forged
        // (fail-closed — which then bricks even the USER's manual commits).
        // Map ERROR → NOT_RUN (accurate: no trusted verdict was recorded);
        // FAIL / NO_CHECKS_RUN persist as themselves. The error detail still
        // reaches the model via the tool result text below.
        const persisted = outcome.verdict === "ERROR" ? "NOT_RUN" : outcome.verdict;
        st.precommit = {
          verdict: persisted,
          fingerprint: null,
          at: new Date().toISOString(),
          mode,
          testScope: outcome.testScope,
          // Same carry-forward as the PASS branch above; the lane's completion
          // is what decides whether it survives (a FAIL of the same tree
          // revokes it, anything else leaves it alone).
          ...(st.precommit.lastFullPassTree ? { lastFullPassTree: st.precommit.lastFullPassTree } : {}),
        };
      }
      persistRepo(ctx as unknown as ExtensionContext, targetRoot);

      // Observability (diagnostics only, never read by an enforcement path):
      // one line per run so "why did this take 5 minutes?" stays answerable
      // after the fact. See lib/gate-timings.ts.
      appendTiming(targetRoot, {
        kind: "precommit",
        at: new Date().toISOString(),
        repo: targetRoot,
        mode,
        testScope: outcome.testScope ?? "unknown",
        verdict: outcome.verdict,
        totalMs: outcome.totalMs ?? 0,
        steps: outcome.timings ?? [],
        fingerprint: outcome.fingerprint.slice(0, 12),
      });
      // A precommit run is a gate event: the NEXT review round's approximate
      // duration measures from here, not from before this run, so a 100s full
      // lane does not get attributed to the reviewer.
      lastGateEventAt.current = Date.now();

      // Naming the lane in the reply is what stops the agent from discovering
      // at push time that its PASS does not qualify.
      const lane = `[lane ${mode}, tests: ${outcome.testScope ?? "unknown"}${outcome.configSource ? `, config: ${outcome.configSource}` : ""}]`;
      const pushNote = outcome.verdict === "PASS" && outcome.testScope !== "full"
        ? ' This clears a `git commit`; `git push` / `gh pr create` need a run with mode "full".'
        : "";
      // testScope skipped = the test step was DROPPED (no related-test
      // strategy), so the commit-time PASS never executed the suite. This
      // must be loud: a user seeing only "PASS" would reasonably assume
      // tests ran.
      const skippedNote = outcome.verdict === "PASS" && outcome.testScope === "skipped"
        ? " ⚠️ WARNING: NO tests ran in this lane — the test script could not be narrowed to related tests and was skipped entirely; this PASS did NOT execute the test suite. A `git push` / `gh pr create` requires a full run that does."
        : "";
      const detail =
        outcome.verdict === "PASS" ? `PASS ${lane} (${outcome.checksRun} checks ran, 0 failed).${pushNote}${skippedNote}`
        : outcome.verdict === "FAIL" ? `FAIL ${lane} (${outcome.checksFailed}/${outcome.checksRun} checks failed).`
        : outcome.verdict === "NO_CHECKS_RUN" ? `NO CHECKS RUN ${lane} — zero runnable checks; this is NOT a pass. Configure real checks or /gate-bypass.`
        : `ERROR (${outcome.error ?? "runner could not be trusted"}) — fail-closed.`;

      // Diagnostics pointer. The full runner output is ALWAYS captured to a
      // file; what changes with the verdict is whether the agent is told to go
      // read it. Output is never inlined here — a failing test suite can emit
      // megabytes, and only the agent knows how much of it it needs. Failed
      // check NAMES are included so it can jump to the right section instead
      // of paging through the whole log.
      const failed = outcome.failedSteps.length ? ` Failed: ${outcome.failedSteps.join(", ")}.` : "";
      const logNote = !outcome.logPath
        ? " (run log unavailable — the runner produced no readable output)"
        : outcome.verdict === "PASS"
          ? ` Full output: ${outcome.logPath}`
          : `${failed} Full output: ${outcome.logPath} — read it (or grep it) to see what failed; it is the complete runner output, not a summary.`;

      return {
        // Name the REPO in the text (not just details) — see recordReviewVerdict.
        // The PASS binds to the repo root, so that is what is echoed; the
        // working directory is only shown when it is genuinely a different
        // place. Compared through realpath, because a Pi launched via a
        // symlinked path has a logical cwd that never string-matches git's
        // physical root — which would print "(ran in …)" on every single run.
        content: [{
          type: "text",
          text: `review-gate: precommit for ${targetRoot}` +
            (samePlace(targetDir, targetRoot) ? "" : ` (ran in ${targetDir})`) + `: ${detail}` + logNote,
        }],
        details: {
          verdict: outcome.verdict, checksRun: outcome.checksRun, checksFailed: outcome.checksFailed,
          repo: repoLabel(targetRoot), logPath: outcome.logPath, failedSteps: outcome.failedSteps,
        },
        isError: outcome.verdict !== "PASS",
      };
    },
  });

  /* ─────────────────── L9: the acceptance round, armed at completion ─────────────────── */
  // `armAcceptanceRound` lives in lib/acceptance-host.ts (t7); `declare_done` below calls it.

  // ---------- declare_done tool ----------

  pi.registerTool({
    name: "declare_done",
    label: "Declare Done",
    description:
      "Declare the current task complete. Re-validates every gate server-side. " +
      "The work stays on the branch it was done on — no gate merge (2026-09-07, user decision); " +
      "merging/rebasing/pushing is the user's own git workflow.",
    parameters: Type.Object({
      summary: Type.String({ description: "One-paragraph completion summary" }),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      // Completion re-runs every gate and then MERGES — minutes of work in
      // the worst case, and a merge conflict is exactly when the human wants
      // to see what happened. One step per phase.
      const progress = createProgressReporter({
        title: "review-gate: declare_done",
        onUpdate: onUpdate as ToolUpdate | undefined,
      });
      progress.step("门禁复检");
      // NON-GIT SHORT-CIRCUIT (2026-09-02, user decision): outside a git
      // repository there is nothing the gate could have reviewed or
      // precommitted — declare_done has no gate to re-run. The old path
      // fell into fail-closed "code review gate is PENDING" forever
      // because computeFingerprint returns UNAVAILABLE outside a repo.
      if (!sessionInGit) {
        progress.step("完成");
        return {
          content: [{ type: "text", text: "review-gate: 非 git 目录 —— 门禁不介入，declare_done 直接完成（无仓库可审查/提交）。" }],
          details: { ok: true, nonGit: true },
        };
      }
      // R-30 — THE ORCHESTRATOR'S EXIT CONTRACT IS THE PLAN, and it is the
      // ONE the status tool already reports. Measured on 2026-08-30: with
      // every task done, no live children and no open decisions,
      // `orchestrator_status` said "没有了，可以 declare_done" while
      // declare_done rejected with "code review gate is PENDING / precommit
      // has not run" — criteria a project manager can never satisfy, because
      // constraint 2 forbids it from writing the code a review would judge.
      // Two answers to one question is a bug wherever it appears; here it was
      // a functional deadlock, so both callers now run the same function.
      const orchestratorMode = state.taskMode === "orchestrator";
      // P-multi: completion requires EVERY repo this session has edited to
      // pass its own review + precommit — a multi-repo task is not done while
      // any of its repos still holds unreviewed work.
      const problems: string[] = [];
      if (orchestratorMode) {
        // WHAT THIS DELIBERATELY DOES NOT CHECK (round-1 Nit, recorded rather
        // than silently accepted): unreviewed changes a serial child left in
        // the shared worktree are invisible to THIS exit check now. That is a
        // tidiness risk, not a hole — a supervisor writes no code (constraint
        // 2) and every ship still goes through the SESSION that made the
        // change, with its own review and precommit. If an orchestrator is
        // ever allowed to commit, this layer has to be reconsidered.
        problems.push(...orchestrationDoneProblems());

      } else {

      for (const root of sessionRepos) {
        const st = enforcementStateFor(root);
        const fp = computeFingerprint(root);
        if (st) {
          // `requireFullTests`: declaring the task done means the work is
          // about to be published, and the fast lane never proved the suite
          // passes — only the tests related to the last edit. Requiring the
          // full run HERE (rather than only at push time) is what keeps the
          // loop honest: the agent cannot finish on a narrowed check.
          for (const p of unmetRequirements(st, headCommitTree(root), false, {
            requireDocSync: projectConfig.docSync,
            requireFullTests: true,
            unreviewedCommits: unreviewedTreesSince(root, st.review),
          })) {
            problems.push(root === primaryRepoRoot ? p : `[${repoLabel(root)}] ${p}`);
          }
        } else {
          // An edited repo always has a state (edit hook initializes it);
          // this is defense against future drift. Fail-closed.
          problems.push(`[${repoLabel(root)}] gate state missing (fail-closed)`);
        }
      }
      }


      // Owned judge panes cascade-close HERE (hierarchy design): finished ones
      // are reclaimed, running ones are abandoned — an unrecorded round never
      // enters the review chain. This SUPERSEDES the old “refuse while a judge
      // is open” rule: finishing takes the panes with it, so done can never
      // strand one. In loop/orchestrator mode this runs for real; explore/normal
      // only report it as advisory (their done is advisory too).
      //
      // `ownJudges()` and NOT `ownLiveJudges()`: cascade-close is the one
      // reader that wants this opener's entries even when their pane is gone
      // — a dead pane still leaves a registry entry, a scratch worktree and
      // (for an auditor) a pending audit to reclaim. The opener filter is
      // what keeps it off a PEER's review.
      //
      // AN IN-FLIGHT ACCEPTANCE ROUND IS NOT ABANDONED HERE (reviewer P1,
      // 2026-09-22). This tool is the one that dispatched it, and the reply it
      // gave told the agent to WAIT for it — so a second `declare_done` must
      // reach `acceptanceDecision`'s AWAITING branch. Closing the pane first
      // made `acceptanceRoundAlive()` answer “gone”, and the decision's own
      // `roundAlive === false` rule then dispatched a SECOND round on top of a
      // working judge: the first was killed and paid for twice.
      //
      // ONLY that role, and ONLY while its own record says AWAITING (a
      // concluded round — READY / BLOCKED / SKIPPED / DISABLED — is reclaimed
      // like every other finished judge). A pane that really died is still
      // re-dispatched, because `acceptanceRoundAlive` reads the PANE: leaving
      // the registry entry here changes nothing about that decision. Killing
      // the pane by hand (tmux) remains the way to abandon a round that is
      // alive but will never conclude.
      const ownedJudges = ownJudges().filter((child) =>
        !(child.role === "acceptance" && acceptanceRoundInFlight(stateForRepo(child.repoRoot).acceptance)),
      );
      if (ownedJudges.length > 0 && isEnforcedMode(state.taskMode)) {
        const run = (argv: readonly string[]) => runTmux(argv);
        const closed: string[] = [];
        const tmuxServer = tmuxServerFrom(process.env);
        for (const child of ownedJudges) {
          // `windowClosable`, not just "has a window id": a persisted id from a
          // tmux server that has since restarted names whatever now holds that
          // number, and this is a kill (2026-09-05, adviser P1). Unverifiable ⇒
          // the entry and its scratch are still reclaimed below, we simply do
          // not send kill-window into a window that may not be ours.
          if (windowClosable(child, tmuxServer)) {
            try {
              // The target is `<session>:<@window>` from the entry itself, so a
              // leftover id can only reach a window of THIS session's own tmux
              // session — never one the user owns.
              if (closeSessionWindow(run, { ownSession: child.tmuxSession, windowId: child.windowId }).ok) {
                closed.push(child.windowId);
              }
            } catch { /* best effort */ }
          }
          try { reapReviewScratch(child.judgeId); } catch { /* best effort */ }
          setHierarchy(removeJudge(judgeHierarchy(), child.judgeId));
          if (child.role === "goal-auditor") dropAudits(child.repoRoot);
        }
        progress.step(`联关 ${ownedJudges.length} 个 review window${closed.length ? `（已关 ${closed.join("、")}）` : ""}`);
      } else if (ownedJudges.length > 0) {
        for (const child of ownedJudges) {
          problems.push(`[${repoLabel(child.repoRoot)}] judge window ${child.windowId ?? "(无 window)"} (${child.role}) 仍开着——explore/normal 下仅提醒，不代关。`);
        }
      }
      // L7/L8 — completion-only requirements. Neither is in
      // unmetRequirements(): the Copilot loop needs commits to make progress
      // (gating ships on it would deadlock it), and the goal approval is a
      // dialog fact the git hooks cannot see. Both still decide whether the
      // TASK is finished, which is exactly what this tool answers.
      const completionProblems: string[] = [];
      if (!orchestratorMode) {
        for (const root of sessionRepos) {
          const st = root === primaryRepoRoot ? state : stateForRepo(root);
          for (const p of copilotProblemsFor(st)) {
            completionProblems.push(root === primaryRepoRoot ? p : `[${repoLabel(root)}] ${p}`);
          }
        }
        if (isEnforcedMode(state.taskMode) && !goalStageSatisfied()) {
          completionProblems.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
        }
        // DID THIS ROUND ARRIVE AT ITS STATION (2026-09-06)?
        //
        // The gates above answer "is the work good enough"; this answers the
        // other half of the contract — a round that promised a PR and stops at
        // a clean worktree did not finish what the user agreed to. LOOP MODE
        // ONLY, and deliberately: the reason an orchestrator is not judged
        // here (it could never satisfy it, and the receipt would tell it to do
        // something impossible) is written where someone would go to "fix the
        // gap" — the docblock of `orchestrationDoneProblems`.

        //
        // Every fact is the gate's OWN: uncommitted work, a `gh pr create` it
        // watched exit 0 (`shippedKinds`), the PR number the Copilot cycle
        // resolved, and — when neither of those can answer — a question it
        // asks GitHub itself (`lib/station-pr-evidence.ts`). That last one is
        // a network round trip, so it runs ONLY when the free local facts
        // cannot prove arrival: a completion must never fail because the
        // network was slow, and must never be IMPOSSIBLE because the PR was
        // opened before this session existed.
        //
        // PER REPO, not once for the session (round-1 reviewer P2): each repo
        // carries its OWN approved goal and therefore its own station, and the
        // facts are per repo too. Folding them into one station would let a
        // second repo's `pr` contract go unchecked behind the primary repo's
        // `precommit` one — the strictest station demands the LEAST here,
        // which is the opposite of the ship gate's fold.
        if (isEnforcedMode(state.taskMode) && goalStageSatisfied()) {
          for (const root of sessionRepos) {
            const station = deliveryStationFor(root);
            if (station === undefined) continue; // no contract for that repo
            const st = root === primaryRepoRoot ? state : stateForRepo(root);
            // UNVERIFIABLE counts as dirty: "I could not read the worktree"
            // is not evidence that the work was committed.
            const files = changedFiles(root);
            const observedPrCreate = st.shippedKinds?.includes("pr-create") === true;
            const recordedPr = typeof st.copilot?.pr === "number" ? st.copilot.pr : null;
            let probe: OpenPrArrival | null = null;
            let unpushed = false;
            if (station === "pr") {
              // ASK GITHUB ONLY WHEN THE FREE EVIDENCE IS SILENT — `gh` reports
              // "already exists" as an ERROR, so a round that APPENDS to an
              // open PR leaves `shippedKinds` empty, and a repo with
              // `copilotReview` off never resolves a number either. Whether a
              // round has to ask is the module's rule, not a second expression
              // written here (round-1 quality P1).
              if (!prEvidencePresent({ observedPrCreate, recordedPr })) {
                // Named in the progress line: this one can take seconds, and a
                // silent wait at the last step of a round reads as a hang.
                progress.step(`查询 PR 状态（${repoLabel(root)}）`);
                probe = await probeOpenPr(repoDirFor(root));
              }
              // …but HAVING a PR is not arriving: work still sitting locally —
              // a checkpoint commit the gate landed after the PR was opened
              // included — has not been delivered, and no evidence above can
              // see that. Pure local git, no network.
              unpushed = hasUnpushedCommits(repoDirFor(root));
            }
            const problems = stationArrivalProblems(station, {
              dirty: files === undefined || files.length > 0,
              observedPrCreate,
              recordedPr,
              openPr: probe?.number ?? null,
              unpushed,
            });
            for (const p of problems) {
              completionProblems.push(root === primaryRepoRoot ? p : `[${repoLabel(root)}] ${p}`);
            }
          }

        }

        // Orchestration exit contract (constraints 3, 4, 10, 11): the question
        // is whether the WHOLE job is finished, not whether this session kept
        // its own promises — an orchestrator that writes no code would
        // otherwise sail through every gate above with its plan half-run.
        // (In orchestrator mode it was already the ONLY criterion, above.)
        completionProblems.push(...orchestrationDoneProblems());
      }
      problems.push(...completionProblems);

      if (state.taskMode === "explore" || state.taskMode === "normal") {
        // Explore's defining behavior: the agent may end the task on its own
        // judgment. Gate status is reported as advisory only. (Ship commands
        // remain fully gated by L1 in explore; normal has no ship gate at all.)
        loopArmed = false;
        persist(ctx as unknown as ExtensionContext);
        return {
          content: [{
            type: "text",
            text: (state.taskMode === "normal"
              ? `review-gate: normal mode — completion accepted without gates. ${params.summary}`
              : `review-gate: explore task completed by AI judgment. ${params.summary}` +
                (problems.length ? "\nAdvisory gate status:\n" + problems.map((p) => `  - ${p}`).join("\n") : "")),
          }],
          details: { accepted: true, advisoryProblems: problems },
        };
      }
      if (problems.length > 0) {
        progress.fail(`${problems.length} 项未满足`);
        const staleReady = problems.some((p) => p.includes("modified after the last READY"));
        return {
          content: [{
            type: "text",
            text: buildRejection({
              what: `declare_done 被拒 —— ${problems.length} 项门禁未满足`,
              why: "下面是门禁**重新核对**出的未满足项（服务端复检，不看你的 summary）：\n" +
                problems.map((p) => `  - ${p}`).join("\n"),
              by: "agent",
              next: (orchestratorMode
                // R-30: an orchestrator has no review of its own to run, so
                // pointing it at the loop would be pointing it at nothing.
                // These are the SAME items block 5 of the `orchestrator_wait`
                // receipt lists — one decision function, two surfaces.
                ? "把上面这些做完再退出（这就是 `orchestrator_wait` 回执第 5 块「还差什么」，两处用的是同一个判据函数）。"
                : "跑完审查循环再试：按 findings 修 → `judge_submit({role:\"reviewer\"})` → READY → 再调 `declare_done`。") +
                (staleReady
                  ? "\n注意：READY 之后的任何代码或文档编辑都会让它失效（handoff / 设计 / plan 文档也算）。" +
                    "把所有编辑（含文档）全部做完，再把最后一轮 review + precommit 当作 declare_done 之前的最后两步。"
                  : ""),
            }),
          }],
          details: { accepted: false, problems },
          isError: true,
        };
      }
      // ── L9 — THE REAL-ACCEPTANCE ROUND (2026-09-22, user decision) ──
      //
      // The gate's OWN dispatch, at completion: the agent has no tool that
      // starts this round and deliberately never will — a round an agent can
      // ask for is a round an agent can skip past. It runs AFTER every other
      // gate is satisfied (the branch above already rejected when anything
      // else was unmet), so the judge runs on content that is otherwise
      // finished, and its verdict binds to that content's fingerprint.
      //
      // LOOP SEMANTICS ONLY, never an orchestrator — and UNDECIDED COUNTS AS
      // THE LOOP (real-session P1, 2026-09-22). The first version of this line
      // asked whether the mode WAS loop, in so many words, and that question has
      // no true branch for a session whose agent never called `set_gate_mode`:
      // no dispatch, no SKIPPED note, `declare_done` returned "done accepted".
      // `isEnforcedMode` is the ONE answer to “does this session run the loop's
      // semantics?” — lib/task-mode.ts says so, and the SAME question was asked
      // wrong a few lines above for the goal and station checks. Never re-derive
      // it here.
      // WHAT THE ACCEPTANCE ROUND DID WHEN IT DID NOT RUN (quality round P2,
      // 2026-09-22): a note for the outcome the human reads, not only for the
      // sidecar — see the skip branch in `armAcceptanceRound`.
      const acceptanceNotes: string[] = [];
      if (isEnforcedMode(state.taskMode) && !orchestratorMode) {
        progress.step("真实验收");
        const acceptance = await armAcceptanceRound(ctx, progress, acceptanceNotes);
        if (acceptance) return acceptance;
      }
      progress.done("全部满足");
      // No landing step anymore (2026-09-07, user decision): the work stays
      // on the branch it was done on. `declare_done` closes the gates;
      // merging/rebasing/pushing is the user's own git workflow.
      loopArmed = false;
      // R3-5 — RECORD THE COMPLETION, in this session's own sidecar.
      //
      // Everything the gate knew about "this task is finished" used to live in
      // this function's local variables and then evaporate. A supervising
      // orchestrator was left reading the child's TERMINAL to guess, and it
      // guessed "working" for 725 seconds on a child that had merged its
      // branch. This one write is what the `done` state is judged from
      // (lib/orchestrator-child-state.ts), so it happens BEFORE the loop
      // bookkeeping below and is never cleared by it.
      state.completion = {
        at: new Date().toISOString(),
        merge: "none", // no landing step anymore (2026-09-07)
        ...(String(params.summary ?? "").trim()
          ? { summary: String(params.summary).trim().slice(0, 500) }
          : {}),
      };
      // A completed unit of work closes its review loop. Session-log analysis
      // showed multi-task sessions accumulating a single ever-growing round
      // counter (e.g. "round 24/10"), which misleads the agent into believing
      // it is stuck in one runaway loop when it is really starting the next
      // task. Reset the per-task loop bookkeeping now that the gate is fully
      // satisfied — for EVERY repo this session edited (P-multi), not just
      // the primary. This only clears already-satisfied history — the next
      // code edit re-arms hasCodeChange and a fresh review is still required,
      // so it cannot loosen the gate.
      for (const root of sessionRepos) {
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        st.rounds = [];
        st.lastPolishReason = undefined;
        st.strategicResetFired = false;
        // The delivery-station EVIDENCE is per TASK too (round-2 reviewer P2):
        // the `gh pr create` that finished task A says nothing about task B,
        // and leaving it behind would let the next round claim it arrived at
        // the `pr` station without opening anything.
        st.shippedKinds = undefined;
        if (root !== primaryRepoRoot) persistRepo(ctx as unknown as ExtensionContext, root);
      }
      state.rounds = [];
      state.lastPolishReason = undefined;
      state.strategicResetFired = false;
      state.shippedKinds = undefined;

      // P1 fix: the L2 auto-continuation budget must reset with the task too.
      // continuationsInjected is capped against maxRounds in agent_settled; if
      // task A consumed it, task B in the same session would get ZERO
      // auto-continuations. Like rounds above, this only clears satisfied
      // history — it cannot loosen the ship gate.
      continuationsInjected = 0;
      resetOrchestratorContinuations(); // goal 6 — reset with the loop budget
      completionContinuations = 0;
      loopStall = undefined; // a completed task is real progress
      stallNoticeShown = false;
      persist(ctx as unknown as ExtensionContext);
      // KIND ONE of three (lib/user-notify.ts): the round's exit contract was
      // met. Raised HERE, on the accepted path only — a refused `declare_done`
      // is the session being told to keep working, not news for the human.
      const notified = raiseBanner({ kind: "finished", detail: String(params.summary ?? "") });
      // ── CLOSE MY OWN TMUX SESSION (2026-09-25) ──
      //
      // The one session this process created for its children, killed with
      // every window still in it. The name comes from THIS session's sidecar
      // and the kill is gated on the ownership marker written at creation, so
      // a name that is not provably ours is left alone; having created no
      // session at all is the normal empty case, not an error
      // (lib/session-tmux-scope.ts).
      //
      // A FAILURE HERE IS REPORTED, NEVER BLOCKING: the work is finished, and
      // an unreachable tmux must not strand a completed task — the leftover
      // session is a fact the human is told about, and t2's orphan sweep is
      // the backstop for it.
      //
      // ENFORCED MODES ONLY, like the judge cascade above it: an explore/normal
      // session returns earlier and leaves its children running on purpose, so
      // killing the session they live in would be the one thing that section
      // promises not to do.
      const sessionClose = closeOwnSession((argv) => runTmux(argv), tmuxScope);
      // ── AND THE NAME GOES BACK WITH IT (t2, 2026-09-25) ──
      //
      // The name is a lease on a human-visible surface: the window title and the
      // status line go back to what they said before, and the registration is
      // deleted so the next session can take the name. A failure is reported
      // and never blocks — the work is finished — and the sweep in
      // lib/session-registry.ts is the backstop for a name that outlives its
      // session.
      const namingRelease = sessionNaming.release();
      return {
        content: [{
          type: "text",
          text: `review-gate: done accepted. ${params.summary}` +
            // WHAT THE USER'S OWN SWITCHES SKIPPED (quality round P2, 2026-09-22).
            // The gate's one line here, from the record — never from the
            // summary: a released gate is a fact the agent's prose cannot be
            // trusted to carry.
            (acceptanceNotes.length ? `\n真实验收：${acceptanceNotes.join("；")}` : "") +
            // R-22 — a round that shipped without a precommit says so, here,
            // where the human reads the outcome.
            (state.checkpoint?.precommitBypassed
              ? "\n注意：本次交付的 checkpoint 是在 `/gate-bypass` 覆盖 precommit 前置的情况下完成的" +
                "（用户授权，理由已记在 bypass 里）—— 全量测试没有在这份内容上跑过。"
              : "") +
            // Honest about the banner in the same breath: `missing` means the
            // user was NOT told, which is their cue to install the notifier.
            (notified.status === "sent" ? "" : `\n（通知：${describeNotifyOutcome(notified)}）`) +
            // The gate's OWN session cleanup, reported only when it did not
            // happen — including refusing to kill a session the marker says is
            // not ours.
            (sessionClose.ok ? "" : `\n（专属 tmux session 未清干净：${sessionClose.error}）`) +
            // The session's NAME, reported only when it was NOT given back:
            // the name is what other sessions address this one by, so a
            // stranded one is a fact the human has to know (and the next
            // session's sweep is the backstop).
            (namingRelease.released ? "" : `\n（会话名字未腾出：${namingRelease.error ?? "未知原因"}）`) +
            // WHO DECIDED WHAT (2026-09-19). Printed by the GATE, from the
            // state record, and never by the summary — a decision the proxy
            // took on the user's behalf is the one fact this report cannot let
            // an agent's prose forget. Empty in the ordinary case.
            // Only THIS session's (and its handoff predecessor's): the sidecar
            // list is a union across sessions and would otherwise replay
            // earlier tasks' decisions in every later report.
            formatProxyDecisionReport(
              sessionProxyDecisions(dialogProxy.all(), [state.sessionId ?? undefined, readInheritance().predecessorSession]),
            ),
        }],
        details: { accepted: true, precommitBypassed: state.checkpoint?.precommitBypassed === true },

      };
    },
  });

  /**
   * HOW FAR THIS SESSION MAY SHIP (2026-09-15) — the ONE reader of
   * `RG_STATION_CAP`, shared by the goal dialog and the restatement dialog.
   *
   * The variable is written by the DISPATCHER (lib/orchestrator-dispatch.ts)
   * and by nothing else, which is the whole point: it lives in an environment
   * the session's own prompt cannot reach, so a child cannot talk itself out
   * of the ceiling its task was dispatched with.
   *
   * An ABSENT variable is `undefined` — NO ceiling — and never
   * `precommit`: a standalone loop session has no plan above it, and reading
   * absence as the strictest station would silently freeze every ordinary
   * session at "the gate's checks pass, the user commits". The two statements
   * are not the same one, so `parseDeliveryStation` (whose default IS the
   * strictest station) is only reached when the variable is really there.
   */
  const stationCapFromEnv = (): DeliveryStation | undefined => {
    const raw = process.env[STATION_CAP_ENV];
    return raw === undefined || raw.trim() === "" ? undefined : parseDeliveryStation(raw);
  };

  /**
   * The GOAL family — `propose_loop_goal` (L8: the user approves this
   * session's exit contract) and the audit recorder behind it (L8b: the
   * goal-auditor's verdict becomes a record) — lives in
   * lib/goal-tools.ts + lib/goal-prereview-tools.ts; only its wiring is here.
   *
   * ONE HOST: the family registers exactly one tool, on `pi`. Its recorder is
   * a plain function this file calls itself when the audit round's report
   * lands (`recordGoalPrereview`, wired through `goalPrereviewDeps` above), so
   * there is no name for an agent to sequence by hand. The audit stays TRUSTED
   * — the auditor's structured conclusion is adjudicated and the draft hashed
   * in THIS process (lib/review-adjudicate.ts + lib/loop-goal.ts), never by
   * the agent.
   *
   * What they need from THIS file arrives as this deps object: the repo roots
   * and their gate state, the persistence, the audit chain (`runGoalAudit` —
   * dispatch the judge, wait for it, record the verdict), the three
   * user-facing surfaces (transcript notice, bounded dialog, and the
   * either-side funnel an orchestrator may answer through), this session's
   * own loop-goal path, the project-layer agent lookup and the one file write
   * an approval performs.
   */
  registerGoalTools(pi, {
    ...goalPrereviewDeps,
    runGoalAudit: (input) => runGoalAudit(input),
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as ExtensionContext, lead, body),
    askChoice: (uiCtx, spec, opts) => askChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
    loopGoalPath: (root) => loopGoalPathIn(root),
    loopGoalRelPath: loopGoalRelPath(SESSION_STATE_VARIANT),
    findProjectAgent: (dir, name) => findProjectAgentText(dir, name),
    // HOW FAR THIS SESSION MAY SHIP (2026-09-15). Read from the environment
    // the DISPATCHER wrote (lib/repo-pr-policy.ts), never from anything this
    // session's own prompt could say: a standalone loop session has no var and
    // therefore no ceiling, an orchestration child gets the station its task
    // was dispatched with — the plan's value, narrowed per repo. An ABSENT var
    // is `undefined` (no ceiling), never `precommit`: those are different
    // statements and collapsing them would silently freeze every standalone
    // session at the strictest station.
    stationCap: stationCapFromEnv,
    // The directory is created with the file: the goal is the first thing a
    // session writes into .pi/, so its parent may not exist yet.
    writeGoalFile: (path, text) => {
      // Same rule as every other gate-state write: a session another one holds
      // this worktree against must not overwrite `.pi/loop-goal.md` — the
      // holder's approved goal is bound by hash, so replacing the file would
      // invalidate the approval it already earned (reviewer P1, 2026-09-05).
      if (state.exclusivityRefusal) throw new Error(state.exclusivityRefusal);
      mkdirSync(pathDirname(path), { recursive: true });
      writeFileSync(path, text, "utf8");
    },
  });

  /**
   * `propose_restatement` (L8a — the step BEFORE a contract is negotiated):
   * the session says the requirement back, the user (or the project manager
   * on their behalf) confirms it, and the gate records it. Registered here,
   * implemented in lib/restatement.ts — the module also owns the refusal both
   * contract tools hand back when nothing was restated.
   *
   * It shares the goal family's bindings deliberately: same repo resolution,
   * same gate state, same three user-facing surfaces. The restatement and the
   * goal are two steps of one negotiation, and a second set of bindings would
   * be a second way for them to disagree about which repo they are talking
   * about.
   */
  registerRestatementTools(pi, {
    primaryRepoRoot: () => primaryRepoRoot,
    cwd: () => cwd,
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    log: (message) => log(message),
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as ExtensionContext, lead, body),
    askChoice: (uiCtx, spec, opts) => askChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
    // THE SAME CEILING the goal dialog reads (2026-09-15): a restatement is
    // where the station is FIRST named, so clamping only at the goal step
    // would mean asking the user about one contract and recording another.
    stationCap: stationCapFromEnv,
  });

  /**
   * `choose_loop_stages` (2026-09-22) — the USER's five stage switches, ONE
   * no-parameter tool. The module owns the rule, the record, the box's copy and
   * the tool itself (lib/loop-stages.ts); this file passes the deps it needs,
   * exactly as the goal and restatement families above do.
   *
   * THE SAME DEPS BACK THE FALLBACK: `ensureLoopStagesFor` (wired into the L1
   * tool_call hook) shows the identical box when the first edit or
   * `propose_restatement` arrives without a choice on record, so there is one
   * implementation and one set of rules for both entrances.
   */
  registerLoopStageTools(pi, loopStageDeps);



  /**
   * The ONE L7 Copilot tool — `copilot_review`, which asks for the review when
   * the current head has none, reports what an outstanding request is doing,
   * and reads what the review left open — lives in
   * lib/copilot-review-tools.ts; only its wiring is here. It stays TRUSTED
   * across the move: the `gh` calls run in this process (lib/copilot-gh.ts),
   * never through the agent, so the agent can still not report its own review
   * outcome.
   *
   * What it needs from THIS file arrives as this deps object: the repo
   * resolution, gate state and its persistence, the directory `gh` runs in,
   * whether the loop is on for a repo (project config + mode), the
   * auto-continuation arming and the log channel. The GitHub surface is
   * injected too — one `gh` member per call the tool makes — so every branch
   * it takes is unit-testable without a pull request.
   */
  registerCopilotReviewTools(pi, {
    resolveRepo: (requested) => resolveToolRepo(requested),
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    repoDir: (root) => repoDirFor(root),
    copilotEnabled: (st) => copilotEnabled(st),
    sessionMode: () => state.taskMode,
    onWaiting: (active) => {
      copilotWaitSince = active ? Date.now() : undefined;
      if (latestCtx) reportChildState(latestCtx, undefined, { force: true });
    },
    armLoop: () => { armLoop(); },
    log: (message) => log(message),
    gh: {
      resolveOpenPr: (dir, signal) => resolveOpenPr(dir, signal),
      resolveRepoSlug: (dir, pr, signal) => resolveRepoSlug(dir, pr, signal),
      fetchCopilotPayload: (dir, slug, prNumber, signal) => fetchCopilotPayload(dir, slug, prNumber, signal),
      fetchCopilotProbe: (dir, slug, prNumber, signal) => fetchCopilotProbe(dir, slug, prNumber, signal),
      fetchCopilotTimeline: (dir, slug, prNumber, signal) => fetchCopilotTimeline(dir, slug, prNumber, signal),
      requestCopilotReviewer: (dir, pr, slug, signal) => requestCopilotReviewer(dir, pr, slug, signal),
      // The allow-list is THIS extension's project config; lib/copilot-gh.ts
      // carries no configuration of its own.
      resolveCopilotSupport: (dir, slug, supportConfirmed, opts) =>
        resolveCopilotSupport(dir, slug, supportConfirmed, projectConfig.copilotReview.owners, opts),
    },
    // The ONE dialog the triage needs, rendered through THIS file's helpers so
    // a Copilot finding's question is the same shape as every other gate
    // question — and, in an orchestration, the same race (the human and the
    // project manager can both answer; whoever gets there first wins).
    askFinding: async (uiCtx, spec, opts) => {
      const ui = uiCtx as { hasUI?: boolean; ui?: ChoiceUi };
      const outcome = await askEitherSide(
        {
          dialogKind: "select",
          topic: "other",
          title: opts.body ? `${spec.title}\n${opts.body}` : spec.title,
          options: choiceRows(spec),
          payload: `推荐答案：${spec.recommended}`,
        },
        ui.hasUI === true,
        (signal) => askChoice(ui, spec, {
          ...(opts.body === undefined ? {} : { body: opts.body }),
          signal,
        }),
      );
      return outcome.answer;
    },
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as ExtensionContext, lead, body),
    delay: (ms) => new Promise((r) => setTimeout(r, ms)),
  });



  // ---------- user-interaction tools (ask_user + the two consent tools) ----------
  //
  // `ask_user`, `request_scope_limit` and `request_sensitive_edit` moved to
  // lib/user-interaction-tools.ts (+ lib/consent-request-tools.ts) for the
  // architecture rule this file is the repository's own worst example of
  // (AGENTS.md §"架构规范"). ONE registration call wires all three: a family
  // the extension could wire half of is a family it eventually does.
  //
  // What they need from THIS file arrives as this deps object. `state` is a
  // GETTER on purpose — the extension rebinds its state object at
  // session_start and clears `pausedQuestion` from several other handlers, so
  // a captured reference would leave the tools writing into a dead copy of
  // the very state the gate reads. The dialogs stay here too (showToUser /
  // askChoice / askEitherSide are this file's helpers, and the last is
  // what lets an orchestrator answer the same box the human can).
  registerUserInteractionTools(pi, {
    state: () => state,
    // THE GIT ROOT, NOT `cwd` (review round 5 P1): the sidecars are keyed by repo
    // root, and `cwd` may be a subdirectory of it.
    repoRoot: () => primaryRepoRoot,
    persist: (ctx) => persist(ctx as unknown as ExtensionContext),
    setLoopArmed: (armed) => { loopArmed = armed; },
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as Parameters<typeof showToUser>[0], lead, body),
    askChoice: (uiCtx, spec, opts) => askChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    askMultiChoice: (uiCtx, spec, opts) => askMultiChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
    canChannelDialogs: () => childBinding() !== undefined,
    grantProxyScope: (scope, via) => {
      if (!state.orchestrator) return; // not an orchestration — nothing to grant
      persistOrchestration(addGrant(state.orchestrator, { scope, grantedAt: new Date().toISOString(), via }));
    },
    // The same doorway, closing: the user can walk BACK to an authorization
    // question (2026-09-19) and answer something else, which takes the scope
    // away again (lib/user-interaction-tools.ts `applyGrant`).
    revokeProxyScope: (scope) => {
      if (!state.orchestrator) return; // not an orchestration — nothing to revoke
      persistOrchestration(removeGrant(state.orchestrator, scope));
    },
    cwd,
    sessionEditedPaths: () => [...sessionEditedPaths],
    commitsAheadOfBase: async () => commitsAheadOfBase(cwd),
    scopeLimitDeclined: () => scopeLimitDeclined,
    declineScopeLimit: () => { scopeLimitDeclined = true; },
    tmuxAccessDeclined: () => tmuxAccessDeclined,
    declineTmuxAccess: () => { tmuxAccessDeclined = true; },
    sensitiveGrants: () => sensitiveGrants,
    storeSensitiveGrants: (next) => { sensitiveGrants = next; },
    sensitiveDeclinedPaths,
    log: (message) => log(message),
  });

  // ---------- set_gate_mode tool (in-session mode decision + self-service switching) ----------

  pi.on("input", (event, ctx) => {
    // 2026-09-08: the edit-failure nudge window NO LONGER closes on a fresh
    // user message — a session whose edit tool is broken (schema/gate
    // conflict) would otherwise cross turns and silently fall into bash file
    // edits with no reminder. It closes on a successful edit or after one
    // nudge has been issued; see edit-discipline.ts.
    // A real user message resumes an ESC-abort pause: the user is speaking
    // again, so auto-continuation may re-arm from this turn on ("extension"
    // is how the gate injects its own follow-ups — those never count).
    if (event.source !== "extension") lastRunAborted = false;
    // …and it ENDS a long block. `orchestrator_wait` / `judge_wait` are minutes
    // of blocking inside ONE turn, and a message typed during them used to sit
    // in the host's steer queue until the budget ran out — measured at 14
    // minutes of an unreachable project manager (B5). This event fires while a
    // tool is still executing (measured 2026-09-06), so it is the whole
    // trigger: no new tool, no new channel, nobody but the human at this
    // session's keyboard. `source === "extension"` stays excluded — the gate's
    // own [REVIEW_GATE_RESUME] follow-ups and an orchestrator's steer /
    // followUp deliveries must never cut a review round short.
    if (event.source !== "extension") notifyUserInput();

    // A real user message (interactive TUI or an RPC driver — never
    // "extension", which is how the gate injects its own [REVIEW_GATE_RESUME]
    // follow-ups) answers a standing ask_user pause: clear it and
    // re-arm auto-continuation so the loop enforces again from this turn on.
    if (state.pausedQuestion && event.source !== "extension") {
      delete state.pausedQuestion;
      if (state.taskMode !== "explore" && state.taskMode !== "normal") armLoop();
      persist(ctx);
    }
  });

  pi.registerTool({
    name: "set_gate_mode",
    label: "Set Gate Mode",
    description:
      "Decide or change this session's gate mode: \"loop\" (full enforced review loop), " +
      "\"explore\" (investigation — advisory gates, ship commands still blocked), or \"normal\" " +
      "(gate fully off). Call this FIRST in a new session to classify the task — YOUR pick is the " +
      "classification; no external model second-guesses it. You can only classify yourself INTO the " +
      "gate: a first \"loop\" always applies, a first \"explore\" applies while this session is still " +
      "clean, but \"normal\" (gate fully off) always needs the user's confirmation dialog. " +
      "In a Temp dir (/tmp) nothing is forced: the gate only nudges — trivial work should go " +
      "\"normal\", delivery work runs the same modes as anywhere else. " +
      "Upgrades (toward loop) apply immediately (a non-git directory still refuses enforced " +
      "modes via the agent; only the user can force one via /gate-mode). Downgrades after the first classification pop a " +
      "confirmation dialog for the user — you cannot approve it yourself, and a declined " +
      "dialog locks further agent-initiated downgrades for this session. " +
      "\"orchestrator\" is the PROJECT-MANAGER role — loop plus the orchestration constraints " +
      "(you write no code, a plan the user approved authorizes every child session, and " +
      "declare_done additionally requires an empty task queue and no live children). Pick it " +
      "only when the user asked you to supervise rather than to build; it requires tmux.",
    parameters: Type.Object({
      mode: Type.String({ description: '"loop" | "explore" | "normal" | "orchestrator"' }),
      reason: Type.String({ description: "One-line justification (shown to the user as untrusted data)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const requested = normalizeTaskMode(params.mode.trim());
      if (requested === undefined) {
        return {
          content: [{ type: "text", text: 'review-gate: unknown mode — use "loop", "explore", "normal", or "orchestrator". "plan" / "goal" / "review" are internal-only: the gate places them onto spawned sessions itself, an agent can never pick them.' }],
          details: {},
          isError: true,
        };
      }
      // ORCHESTRATOR PRECONDITIONS. Both are facts about the environment, not
      // judgements, so they are checked before the rule engine ever runs:
      //  - no tmux ⇒ the role is impossible (its children ARE panes of the
      //    user's window, and a relay is a split), so entering it would only
      //    fail later, one confusing tool call at a time;
      //  - a session STARTED as somebody's orchestration child must never
      //    become an orchestrator itself. It would inherit the channel of the
      //    orchestration supervising it and start answering its own bell.
      //    A relay successor is exempt: it also carries an orchestration id,
      //    but it carries a predecessor pane too, which is what makes it the
      //    intended holder of the role.
      if (requested === "orchestrator") {
        if (!process.env.TMUX) {
          return {
            content: [{ type: "text", text: ORCHESTRATOR_NEEDS_TMUX }],
            details: { mode: state.taskMode ?? null },
            isError: true,
          };
        }
        if (isOrchestrationChild()) {
          return {
            content: [{
              type: "text",
              text:
                "review-gate: 本会话是某个编排的**子会话**（环境里带着 RG_ORCHESTRATION_ID），" +
                "不能自己变成项目经理 —— 那会让它接管管着自己的那个 orchestration 的通知渠道。" +
                "你就是普通 loop 会话：干活、送审、declare_done；有事项目经理会找你。",
            }],
            details: { mode: state.taskMode ?? null },
            isError: true,
          };
        }
        // THE IDENTITY TAKE-OVER GUARD USED TO BE HERE, AND THAT WAS THE BUG
        // (2026-09-06, B1). It refused the MODE whenever this session had not
        // inherited an orchestration id and the repo already held somebody
        // else's plan — and its advice was to remove that plan by hand.
        //
        // The rule it enforced is right and is still enforced; the PLACE was
        // wrong. Entering the role grants nothing on its own: what needs an
        // identity is writing/submitting a plan and spawning a child, and all
        // three refuse on `runtimeConflict` (lib/orchestrator-plan-action.ts,
        // lib/orchestrator-dispatch.ts). Refusing the mode itself put the two
        // tools that RESOLVE the situation — `orchestrator_attach` and
        // `orchestrator_plan({action:"archive"})` — behind the very door it
        // was holding shut, so the only executable advice left was to delete
        // the gate's own plan file by hand. Three sessions did exactly that.
        //
        // Nothing replaces it here: this is the honest empty space where a
        // check that belonged one layer down used to be.
      }
      // FIRST CLASSIFICATION: while the mode is undecided and THIS session
      // has not edited anything, the AGENT's own pick IS the classification —
      // no external classifier is consulted for the mode (see the NOTE in
      // lib/llm-classify.ts). The pure rule engine below is what bounds it:
      // the agent can only tighten (loop always, explore while clean), a
      // first "normal" still needs the user's dialog, a dirty or headless
      // session is refused, and source stays "auto" so the git hooks remain
      // fully enforced.
      let effective = requested;
      // SCRATCH-SESSION RULE (USER REQUIREMENT): sessions STARTED IN /tmp
      // (lib/pi-self.ts) never enter loop via the agent. On the first
      // classification the agent's pick is clamped: only an explicit explore
      // (investigation) survives, everything else — including loop and a
      // missing pick — becomes normal (local pi-config work / chores). Later
      // agent upgrades to loop are rejected (piSelfTask stays true for the
      // whole session). Only the user can force loop (/gate-mode). NOTHING
      // else is path-exempt — a session started in ~/.pi or in this repo runs
      // the full loop. Path detection is deterministic: the session cwd is
      // chosen by the USER.
      // NON-GIT SHORT-CIRCUIT (2026-09-02, user decision): outside a git
      // repository there is nothing to review/checkpoint/ship, so the
      // enforced modes are impossible. Clamp loop/orchestrator to normal —
      // same shape as the /tmp scratch clamp below (piSelf). This must be
      // checked BEFORE evaluateModeChange so a loop upgrade request can
      // never reach the rule engine as a real loop.
      const nonGitTask = !sessionInGit;
      if (nonGitTask && state.taskMode === undefined && (effective === "loop" || effective === "orchestrator")) {
        effective = "normal";
      }
      // The pure rule engine decides; this tool only supplies FACTS. Consent
      // is obtained below by the EXTENSION (there is deliberately no
      // "confirmed" parameter the model could set). hasChanges = THIS
      // session's own edits only (pre-existing changes arm the gate via
      // state.hasCodeChange but must not force a confirmation dialog on the
      // first classification). piSelfTask now means non-git directories only:
      // Temp dirs are NOT clamped anymore (criterion 6 — nudge instead), so the
      // engine's path exemption covers the no-git case alone — and it is not a
      // first-classification-only flag: later agent loop upgrades must also
      // be rejected.
      const decision = evaluateModeChange({
        current: state.taskMode,
        requested: effective,
        hasChanges: sessionEdited,
        hasUI: ctx.hasUI,
        downgradesLocked: agentDowngradesLocked,
        // piSelfTask = the environment forbids enforced modes: non-git directories
        // (nothing to review/checkpoint/ship — user decision 2026-09-02). Temp dirs
        // are no longer clamped (criterion 6).
        piSelfTask: !sessionInGit,
        // NON-GIT (2026-09-02): the clamp comes from the non-git rule, so the
        // reject reason must say so — the /tmp default would be a lie in a non-git
        // dir (reviewer P2).
        clampReason: !sessionInGit
          ? `this session is not inside a git repository — non-git directories cannot enter "${effective}" via the agent. Ask the user to run /gate-mode ${effective} if they really want the enforced workflow here.`
          : undefined,
      });

      if (decision.action === "noop") {
        // Criterion 3: EVERY return path reports to the supervisor — a noop
        // is still a mode-related event the orchestrator should see.
        reportChildState(ctx, `gate mode already ${effective}（noop）`, { force: true, state: "mode-changed" });
        return {
          content: [{ type: "text", text: `review-gate: gate mode is already "${effective}".` }],
          details: { mode: effective },
        };
      }

      if (decision.action === "apply") {
        // NON-GIT (2026-09-02): a non-git directory still clamps loop/orchestrator
        // to normal without confirmation; Temp dirs only get a nudge (criterion 6).
        const nonGitFirst = !sessionInGit && state.taskMode === undefined;
        setTaskMode(effective, decision.source, ctx as unknown as ExtensionContext);
        try {
          const sourceNote = nonGitFirst
            ? "（非 git 目录，规则禁止 loop，无需确认）"
            : "";
          ctx.ui.notify(
            effective === "loop"
              ? `review-gate: 会话类型已判定为循环任务${sourceNote}。可用 /gate-mode 切换。`
              : effective === "orchestrator"
                ? `review-gate: 本会话已进入项目经理（orchestrator）模式${sourceNote} — 你负责统筹调度，不写代码；plan 需用户批准后才能开子会话。可用 /gate-mode 切换。`
                : effective === "explore"
                  ? `review-gate: 会话类型已判定为探查任务${sourceNote} — gate 仅供参考，AI 可自主结束（commit/push 等 ship 命令仍被完整拦截）。可用 /gate-mode 切换。`
                  : `review-gate: 会话类型已判定为普通任务${sourceNote} — 本会话门禁关闭。可用 /gate-mode 切换。`,
            isEnforcedMode(effective) ? "info" : "warning",
          );
        } catch { /* headless */ }
        // Loop mode decided ⇒ deliver the Step 0 loop-goal directive right
        // here. before_agent_start only injects it on the NEXT turn, and the
        // mode is normally decided as the session's first action — without
        // this the agent could edit for a whole turn before ever seeing the
        // exit contract it is supposed to establish first.
        const goalNote = effective === "loop" ? "\n\n" + loopGoalDirectiveText() : "";
        return {
          content: [{
            type: "text",
            text:
              `review-gate: gate mode set to "${effective}" (source: ${decision.source})` +
              (effective !== requested
                ? `。你请求的是 "${requested}"，目录规则已将其调整为 "${effective}"（非 git 目录禁 enforced 模式）。`
                : ".") +
              goalNote,
          }],
          details: { mode: effective, source: decision.source },
        };
      }

      if (decision.action === "confirm") {
        // USER CONSENT — rendered by the extension with fixed consequence copy;
        // the agent's reason is displayed as clearly-labeled untrusted data.
        // The dialog must describe what the choice actually grants: the
        // decision was computed on `effective`, so the copy is built from it —
        // never from `requested`.
        const confirmLabel = `确认降级到 ${effective}`;
        const keepLabel = `保持当前模式（${state.taskMode ?? "undecided"}）`;
        const spec: ChoiceSpec = {
          title: MODE_CONFIRM_TITLE,
          options: [confirmLabel, keepLabel],
          // The SAFE option is the recommendation: a downgrade turns the
          // enforced workflow off, so the gate never nudges the user into it.
          recommended: keepLabel,
        };
        let ok = false;
        /** The user's own typed reason for keeping the mode, when they gave one. */
        let declineReason: string | undefined;
        try {
          const pick = parseChoice(
            await askChoice(
              asChoiceHost(ctx),
              spec,
              { body: buildModeConfirmMessage(effective, params.reason) },
            ),
            spec,
          );
          ok = pick.kind === "chose" && pick.option === confirmLabel;
          declineReason = pick.kind === "declined" && pick.reason ? pick.reason : undefined;
        } catch { ok = false; }
        if (ok) {
          setTaskMode(effective, "user", ctx as unknown as ExtensionContext);
          return {
            content: [{ type: "text", text: `review-gate: the user CONFIRMED the downgrade — gate mode is now "${effective}".` }],
            details: { mode: effective, source: "user" },
          };
        }
        // Declined: lock agent-initiated downgrades for this session so the
        // dialog cannot be re-popped until the user acts (/gate-mode).
        // Declined: lock agent-initiated downgrades for this session so the
        // dialog cannot be re-popped until the user acts (/gate-mode).
        agentDowngradesLocked = true;
        // Criterion 3: a DECLINED downgrade is still a mode-related event the
        // supervisor must not miss — the child stays in loop, which changes
        // what the orchestrator may expect of it.
        reportChildState(ctx, `gate mode 降级被用户拒绝（保持 ${state.taskMode ?? "undecided"}）`, { force: true, state: "mode-changed" });
        return {
          content: [{
            type: "text",
            text:
              "review-gate: the user DECLINED the downgrade." +
              (declineReason ? ` 用户的意见：${declineReason}` : "") +
              " Agent-initiated downgrades are now " +
              "locked for this session — continue under the current mode and do not ask again; " +
              "only the user can change the mode (/gate-mode).",
          }],
          details: { mode: state.taskMode ?? null, declined: true },
          isError: true,
        };
      }

      // Criterion 3: the REJECTED path also reports — a refused mode change
      // is information the supervisor should have (the child tried to leave
      // loop and could not).
      reportChildState(ctx, `gate mode 变更被拒（${decision.reason}）`, { force: true, state: "mode-changed" });
      return {
        content: [{ type: "text", text: `review-gate: mode change rejected — ${decision.reason}` }],
        details: { mode: state.taskMode ?? null },
        isError: true,
      };
    },
  });

  // ---------- request_arbitration tool (narrow, fail-closed gate exception) ----------

  pi.registerTool({
    name: "request_arbitration",
    label: "Request Arbitration",
    description:
      "Contest a review-gate block you believe is a MISJUDGEMENT. Three things are contestable, " +
      "each only AFTER the gate actually blocked: (a) a TEXT the language/attribution heuristics " +
      "refused (commit subject/body, PR title/body, romanized non-English, AI attribution, test " +
      "label) — a granted appeal passes THAT EXACT CONTENT once; (b) a ship block on a lone " +
      "`gh pr edit` limited to --title/--body/--body-file that is genuinely CIRCULAR; (c) IN A " +
      "REVIEW SESSION, a refusal to conclude READY because the gate observed no inspection this " +
      "round — a granted appeal lets THIS round conclude once. Never " +
      "git commit/push or gh pr create, and never a FACT the gate observed (no workspace, no " +
      "approved goal, unmet review gate, sensitive file) — those have a correct next step. " +
      "An INDEPENDENT arbiter (you cannot write its verdict) rules GATE_WINS / AGENT_WINS / " +
      "HUMAN. Quota: 3 per session, shared; a refused content cannot be appealed twice.",
    parameters: Type.Object({
      argument: Type.String({ description: "Your case for why this specific block is a misjudgement / circular — cite evidence (e.g. the non-Latin text is a quoted filename)." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });

      if (!projectConfig.arbiter.enabled) {
        return deny("review-gate: arbitration is disabled for this project (arbiter.enabled=false). GATE_WINS — comply with the gate.");
      }
      // Criterion 1: no built-in arbiter default — an unconfigured arbiter
      // (no agents.arbiter.slots[0]) fails closed here, before any spawn.
      if (!resolveArbiterModel()) {
        return deny("review-gate: 仲裁者未配置模型链（agents.arbiter.slots 缺失或为空）——按 fail-closed 处理，GATE_WINS。请修复 ~/.pi/review-gate.json 后重试。");
      }
      // Must contest a REAL, recent block — and the MOST RECENT one, when
      // several kinds happened: that is the block the caller is actually stuck
      // on. Three kinds exist: an A-class TEXT refusal, a ship block on a lone
      // `gh pr edit`, and (judge side only) a zero-inspection READY refusal.
      const blockedAt = (at: number | undefined) => at ?? -1;
      const newest = Math.max(
        blockedAt(lastBlockedInspection?.at),
        blockedAt(lastBlockedText?.at),
        blockedAt(lastBlockedShip?.at),
      );
      if (newest < 0) {
        return deny("review-gate: 没有可申诉的拦截。先把命令/编辑真跑一次——申诉只受理已经发生的拦截。");
      }
      if (lastBlockedInspection && lastBlockedInspection.at === newest) {
        return arbitrateInspection(lastBlockedInspection, String(params.argument ?? ""), ctx);
      }
      if (lastBlockedText && lastBlockedText.at === newest) {
        return arbitrateText(lastBlockedText, String(params.argument ?? ""), ctx);
      }
      if (!lastBlockedShip) {
        return deny("review-gate: no ship block to arbitrate. Run the command first; arbitration only contests an actual block.");
      }
      // A DELIVERY-STATION block is not arbitrable, and saying so BEFORE the
      // quota check is the point: the arbiter rules on whether a quality block
      // is circular, and the ship gate does not consult a token while a
      // station refusal stands — so accepting this appeal would spend one of
      // three, possibly rule AGENT_WINS, and leave the command blocked with no
      // explanation (round-1 reviewer P2, 2026-09-06). `deny` costs nothing.
      if (lastBlockedShip.stationBlocked) {
        return deny(
          "review-gate: 这条拦截里有**交付站点**的成分，仲裁受理不了 —— 仲裁判的是「质量拦截是不是死结」，" +
          "它从来没被问过「这一轮该走多远」，而且站点还立着的时候门禁根本不会去看仲裁令牌。\n" +
          STATION_SHIP_NEXT_STEPS,
        );
      }

      const parsed = parseArbitrableAction(lastBlockedShip.command);
      if (!parsed.ok) {
        return deny(`review-gate: this block is NOT arbitrable — ${parsed.reason}. Only a lone \`gh pr edit\` (title/body) qualifies; git commit/push and gh pr create must go through the full gate.`);
      }
      // Per-session cap (SHARED with text appeals, and persisted) and re-roll
      // prevention.
      if (appealsUsed() >= projectConfig.arbiter.maxPerSession) {
        return deny(`review-gate: arbitration limit reached (${projectConfig.arbiter.maxPerSession}/session). Escalate to the user or /gate-bypass.`);
      }
      const fp = computeFingerprint(cwd);
      if (fp.unavailable) return deny("review-gate: worktree fingerprint unavailable — cannot bind an arbitration token. GATE_WINS (fail-closed).");
      // Re-roll prevention: an action identity (exact command + review round +
      // body-file content) may be arbitrated AT MOST ONCE. This covers
      // AGENT_WINS too — a granted-then-consumed token must NOT be re-mintable by
      // calling again. To legitimately try again the agent must change the
      // command or fix the code (new round / fingerprint), which yields a
      // different identity.
      const bodyDigest = bodyFileDigest(parsed.action.bodyFilePaths);
      const decisionKey = `${parsed.action.commandDigest}#${state.rounds.length}#${bodyDigest}`;
      const cached = arbitrationDecisions.get(decisionKey);
      if (cached) {
        return deny(`review-gate: this exact action was already arbitrated this round → ${cached}. Re-rolling is not allowed; change the action or comply with the gate.`);
      }

      spendArbitration(ctx);

      // Gather TRUSTED ground-truth evidence ourselves (the arbiter is tool-less).
      const currentPr = gatherPrText(parsed.action);
      const proposedText = gatherProposedText(parsed.action);
      const gitContext = gatherGitLog(cwd);
      const prompt = buildArbiterPrompt({
        blockReason: lastBlockedShip.blockReason,
        gateProblems: lastBlockedShip.problems,
        command: lastBlockedShip.command,
        currentPr,
        proposedText,
        gitContext,
        agentArgument: params.argument,
      });

      const verdict = await runArbiter(resolveArbiterModel() ?? "", prompt);
      // Fail-closed: any spawn/parse failure → GATE_WINS.
      const decision = verdict?.decision ?? "GATE_WINS";
      arbitrationDecisions.set(decisionKey, decision);
      appendLesson(`arbitration #${appealsUsed()} decision=${decision} reason=${JSON.stringify(verdict?.reason ?? "(no verdict → GATE_WINS)")} cmd=${lastBlockedShip.command.slice(0, 200)} arg=${params.argument.slice(0, 200)}`);

      if (decision === "AGENT_WINS") {
        const bindings = await computeTokenBindings(parsed.action, fp.digest);
        bypassToken = {
          blockId: randomBytes(8).toString("hex"),
          sessionId: bindings.sessionId,
          kind: bindings.kind,
          fingerprint: bindings.fingerprint,
          round: bindings.round,
          commandDigest: bindings.commandDigest,
          bodyFileDigest: bindings.bodyFileDigest,
          issuedAt: Date.now(),
          ttlMs: BYPASS_TOKEN_TTL_MS,
          consumed: false,
        };
        return {
          content: [{ type: "text", text: `review-gate: arbiter ruled AGENT_WINS — ${verdict?.reason ?? ""}\nA SINGLE-USE bypass is issued for this exact \`gh pr edit\` (valid ${Math.round(BYPASS_TOKEN_TTL_MS / 60000)} min, this worktree/round only). Run the SAME command now; it will be allowed ONCE, then you must re-review.` }],
          details: { decision },
        };
      }

      if (decision === "HUMAN") {
        // Pause the gate: hand the choice to the human via a 3-way dialog. No
        // UI → fail-closed to GATE_WINS.
        if (!ctx.hasUI) {
          return deny("review-gate: arbiter deferred to a HUMAN but no interactive UI is available → GATE_WINS (fail-closed). Escalate to the user out-of-band.");
        }
        let choice: string | undefined;
        /** The human's own words when they picked the template's decline row. */
        let humanNote: string | undefined;
        try {
          // The arbiter's question goes through the SAME template as every
          // other dialog (2026-09-08): the recommended row is the gate's own
          // answer, and the decline row lets the human explain why neither
          // extreme fits — which is exactly the third choice the arbiter
          // asked for.
          const spec: ChoiceSpec = {
            title: `review-gate: arbiter is unsure — you decide.\nBlock: ${lastBlockedShip.blockReason.split("\n")[0]}\nArbiter: ${verdict?.reason ?? ""}`,
            options: [
              "Gate wins — require correction",
              "Allow this exact `gh pr edit` once",
              "Pause gate and wait",
            ],
            recommended: "Gate wins — require correction",
          };
          const pick = parseChoice(
            await askChoice(ctx as unknown as { ui?: ChoiceUi }, spec),
            spec,
          );
          choice = pick.kind === "chose" ? pick.option : undefined;
          // The decline row is "none of these, and here is why": the human is
          // NOT choosing an action, so the gate keeps its fail-closed default
          // — but their objection is the half the agent can act on, so it is
          // carried back to the caller instead of only into the audit log.
          humanNote = pick.kind === "declined" ? pick.reason : undefined;
        } catch { choice = undefined; }
        if (choice === "Allow this exact `gh pr edit` once") {
          const bindings = await computeTokenBindings(parsed.action, fp.digest);
          bypassToken = {
            blockId: randomBytes(8).toString("hex"),
            sessionId: bindings.sessionId, kind: bindings.kind, fingerprint: bindings.fingerprint,
            round: bindings.round, commandDigest: bindings.commandDigest, bodyFileDigest: bindings.bodyFileDigest,
            issuedAt: Date.now(), ttlMs: BYPASS_TOKEN_TTL_MS, consumed: false,
          };
          appendLesson(`arbitration #${appealsUsed()} HUMAN→allow-once`);
          return { content: [{ type: "text", text: "review-gate: human allowed this exact `gh pr edit` ONCE. Run the same command now." }], details: { decision: "HUMAN", human: "allow-once" } };
        }
        if (choice === "Pause gate and wait") {
          loopArmed = false;
          arbitrationPaused = true; // P1: the revival timer must respect this
          appendLesson(`arbitration #${appealsUsed()} HUMAN→pause`);
          return { content: [{ type: "text", text: "review-gate: gate PAUSED by the human — auto-continuation disarmed. No bypass issued. Wait for further instructions." }], details: { decision: "HUMAN", human: "pause" } };
        }
        // The decline row is not one of the three rulings, and saying "the
        // human ruled GATE_WINS" would put words in their mouth (reviewer P1).
        if (humanNote !== undefined) {
          appendLesson(`arbitration #${appealsUsed()} human note: ${humanNote}`);
          return deny(
            "review-gate: the human did not pick an arbitration option — they picked 「✎ 不选，我说明原因」." +
            (humanNote ? ` 用户的意见：${humanNote}` : "") +
            " The gate's default therefore stands (no bypass issued): comply with the gate, or bring this objection into a new appeal.",
          );
        }
        appendLesson(`arbitration #${appealsUsed()} HUMAN→gate-wins`);
        return deny("review-gate: human ruled GATE_WINS — comply with the gate.");
      }

      // GATE_WINS
      return deny(`review-gate: arbiter ruled GATE_WINS — ${verdict?.reason ?? "the block stands (no valid verdict → fail-closed)"}. Comply: fix the underlying problem, then re-review.`);
    },
  });

  // ---------- ESC abort detection (feeds the L2 pause below) ----------

  pi.on("agent_end", (event) => {
    // stopReason "aborted" on the run's LAST assistant message = the user
    // aborted (ESC — the TUI's "Operation aborted"). Overwritten each
    // agent_end: an overflow-recovery abort that Pi retries ends with a later,
    // non-aborted agent_end, which clears the flag again before settle.
    let last: { role?: string; stopReason?: string } | undefined;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i] as { role?: string; stopReason?: string };
      if (m?.role === "assistant") { last = m; break; }
    }
    lastRunAborted = last?.stopReason === "aborted";
  });

  // ---------- L2: auto-continuation ----------

  pi.on("agent_settled", async (_event, ctx) => {
    // A SETTLE IS NOT A STOP UNTIL THE GATE IS DONE WITH IT (round-3 P1).
    //
    // MEASURED failure: the "I stopped" proof used to be published right here,
    // at the top — and this handler may inject the NEXT TURN ITSELF, a few
    // lines below. A loop child that was about to be resumed therefore
    // published a structurally-proven `idle` first, and (since the proof is
    // believed instantly, that being the whole point of it) a supervisor could
    // act on a stop that never happened.
    //
    // So the proof is published by the EXITS THAT MEAN IT: the early returns
    // that decide NOT to continue, and the end of the handler. Every exit that
    // hands the session more work either says nothing (it never set the stamp)
    // or withdraws the stamp it already had.
    // The CLEAR direction comes first: nothing below may inherit a previous
    // settle's stamp, and this report therefore carries none.
    noteChildProgress("tool");
    reportChildState(ctx);
    const confirmStop = (): void => {
      noteChildProgress("settled");
      reportChildState(ctx, undefined, { force: true });
    };
    await drainChildInstructions(ctx);
    // Judge panes conclude through judge_conclude (their own round-ending tool) —
    // there is no settle-time verdict scraping, so nothing to do here.
    // Finished rounds wake in every mode except normal (gate fully off): explore
    // is advisory on enforcement, not deaf — its reports still land and record.
    if (state.taskMode !== "normal" && !handedOff() && (await settleFinishedRounds(ctx))) {
      // …and this exit may have handed the session a round's report, so it is
      // NOT a stop: nothing is published here (see `confirmStop`).
      return;
    }
    // Explore and normal never auto-continue — that is their defining
    // difference from loop. This check MUST stay before the loopArmed check:
    // explore/normal-mode edits set loopArmed = true in tool_result, and only
    // this early return keeps the continuation loop off.
    if (state.taskMode === "explore" || state.taskMode === "normal") { confirmStop(); return; }
    // Paused for a user question (ask_user): defense-in-depth —
    // loopArmed is in-memory and resets on restart, but the persisted pause
    // must keep auto-continuation off until the user actually replies.
    if (state.pausedQuestion) { confirmStop(); return; }
    if (!loopArmed) { confirmStop(); return; }
    if (state.bypass.active) { confirmStop(); return; }
    // NOT a stop: the agent is still working, so no proof is published here.
    if (!ctx.isIdle()) return;

    // R-3 — AN ORCHESTRATOR IS NOT IN THE LOOP, and the loop's nudge is not
    // merely off-topic for it: its criteria can never be met. The RESUME text
    // reads the SUPERVISOR's own sidecar ("code review gate is PENDING",
    // "precommit has not run", "the loop goal is unconfirmed"), and a project
    // manager writes no code, runs no precommit and negotiates no loop goal —
    // constraint 2 forbids the first and the plan replaces the third. The
    // second run measured it firing twice, each time telling the supervisor
    // to review work its CHILDREN had done. Its continuation is the plan.
    if (state.taskMode === "orchestrator") {
      orchestratorSettled(ctx);
      return;
    }

    // A JUDGE PANE IS NOT IN THE LOOP EITHER (round-7 P1, measured in the
    // certification e2e). A reporting shell has no gates of its own: the RESUME
    // text it received ("code review gate is PENDING", "the loop goal is
    // unconfirmed") is the OPENER's sidecar, and acting on it made the reviewer
    // call judge_conclude twice 8 seconds apart — two channel reports for ONE round,
    // so the gate recorded a DRAFT verdict (now refused: one round concludes once).
    // Its completion is the single conclude call it already made; nothing else is owed.
    if (readJudgeSideEnv(process.env)) return;

    // The revival clock for the LOOP session: armed here so a turn that
    // ends under any of the six guards above still gets its minute-level
    // second chance. (The orchestrator arms it in orchestratorSettled.)
    startRevivalTimer(ctx);
    // 2026-09-17 (user decision): count un-goaled turns so the force-negotiate
    // directive fires at GOAL_FORCE_NEGOTIATE_TURN_THRESHOLD. This is a REAL
    // settled loop turn (explore/normal/orchestrator/aborted all returned
    // above), and the count persists so a restart cannot reset the clock.
    // Cleared in doProposeLoopGoal on approval.
    if (!goalStageSatisfied()) {
      state.turnsWithoutGoal = (state.turnsWithoutGoal ?? 0) + 1;
    } else {
      state.turnsWithoutGoal = undefined;
    }
    const forceNegotiate = goalNegotiationOverdue(state.turnsWithoutGoal);
    const fp = computeFingerprint(cwd);
    // Ship-gate requirements only exist once this session touched something.
    const problems = (state.hasCodeChange || state.hasDocChange)
      ? unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync })
      : [];


    // L7/L8 — completion-only requirements (never part of the ship authority):
    // an open Copilot review cycle and an unapproved loop goal. They keep the
    // loop running after the code itself is clean, which is the whole point of
    // "the PR is not done when it is opened".
    const completion: string[] = [];
    for (const root of sessionRepos) {
      const st = root === primaryRepoRoot ? state : stateForRepo(root);
      for (const p of copilotProblemsFor(st)) {
        completion.push(root === primaryRepoRoot ? p : `[${repoLabel(root)}] ${p}`);
      }
    }
    if (!goalStageSatisfied()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
    // Goal-only continuation: the ONLY remaining item is the unapproved loop
    // goal. If the agent already grilled the user and is waiting for the
    // answer, ask_user already paused the loop — the resume text below
    // points at it instead of re-asking.
    const goalOnly =
      problems.length === 0 &&
      completion.length === 1 &&
      completion[0] === LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK;

    // THE ORDINARY STOP, and round-4 P1 caught it missing: every gate is
    // satisfied, so this handler will nudge nobody again. An orchestration
    // child in loop mode reaches THIS exit on nearly every normal stop — the
    // four exits that used to publish the proof are the rare ones (explore,
    // a pause, a disarmed loop, a bypass).
    if (problems.length === 0 && completion.length === 0) { confirmStop(); return; }
    // Budgets are checked per source: gate problems against maxRounds,
    // completion-only continuations against their own cap.

    // USER REQUIREMENT: the user aborted this run (ESC — "Operation aborted").
    // Injecting a continuation would override an explicit human stop, so the
    // loop pauses instead; the user's next message resumes it (input handler
    // clears the flag). Tighten-only — ship commands stay blocked while gates
    // are unmet, exactly like an ask_user pause.
    if (lastRunAborted) {
      try {
        ctx.ui.notify(
          "review-gate: 检测到手动中止（ESC）— 自动循环已暂停（质量门禁仍未满足）。你的下一条消息会恢复循环；ship 命令仍被拦截。",
          "warning",
        );
      } catch { /* headless */ }
      updateWidget(ctx);
      confirmStop();
      return;
    }

    // Round-18 (user ask): the main session must HOST the wait itself — a
    // judge child's completion signal is an ACCELERATOR, never a
    // precondition. The old early return let the session fall back to idle
    // while a child was in flight, which (measured twice this session)
    // deadlocked the loop when the child finished WITHOUT signalling.
    // Classify the children: dead/silent ones end their wait NOW (read what
    // they produced and carry on), live fresh ones are HOSTED (the agent
    // keeps doing deterministic work or blocks in bash on the three
    // criteria) — never idle.
    const paneList = listServerPanesForThisSession();
    const tmuxServer = tmuxServerFrom(process.env);
    const childSnapshots: ChildSnapshot[] = [];
    const sessionIdsBySession = new Map<string, string>();
    for (const c of ownJudges()) {
      // A judge whose death was ALREADY announced is not news a second time.
      // The registry is persisted now, so an entry can outlive the process
      // that opened it: its pane died with that process, the classifier calls
      // it `terminated`, and terminated bypasses the notice throttle — so
      // without this the session would re-announce the same dead judge on
      // every settle, forever, with nothing left to reclaim it (reviewer P2,
      // 2026-09-05). Announced once is the contract; `judge_recover` still
      // finds the entry, because the entry itself is deliberately kept.
      if (announcedTerminated.has(c.judgeId)) {
        // A judge that is ALIVE again (re-dispatched over its pane, or
        // recovered into a new one) has a future, so its next death is news
        // again. Self-healing on the liveness we already computed, rather than
        // a clear() at each of the several places that revive a judge — the
        // set would otherwise only grow, and this session would go silent
        // about that judge forever (reviewer P2, 2026-09-05).
        if (judgeLive(c, paneList, tmuxServer)) announcedTerminated.delete(c.judgeId);
        else continue;
      }
      childSnapshots.push({
        title: c.title,
        sessionId: c.judgeId,
        role: c.role,
        spawnedAt: c.spawnedAt,
        // Liveness through the SAME predicate the wait uses (lib/hierarchy.ts):
        // an UNREADABLE pane list stays alive — missing information must never
        // end a wait — and a pane id from another tmux server is not this
        // judge's pane at all.
        alive: judgeLive(c, paneList, tmuxServer),
        // The channel is the activity record now (heartbeat, questions,
        // reports); absent ⇒ the classifier falls back to spawnedAt.
        lastActivityAt: channelLastActivity(c),
      });
      sessionIdsBySession.set(c.judgeId, c.title);
    }
    // (Reports already settled above; the watchdog below keeps pane-dead rounds.)
    if (childSnapshots.length > 0) {
      const childVerdict = classifyChildren(childSnapshots, Date.now());
      const childNotice = buildChildWaitNotice(childVerdict, sessionIdsBySession);
      const notifyNow = childVerdict.terminated.length > 0 || Date.now() - lastChildNoticeAt >= CHILD_NOTICE_MIN_MS;
      if (childNotice) {
        if (!notifyNow) {
          // Do not fall through to the generic RESUME injection: that would
          // burn review budget while the child is still legitimately in flight.
          // The referenced timer is the main session's liveness anchor and
          // re-checks independently when this throttle window expires.
          scheduleChildWaitRecheck(CHILD_NOTICE_MIN_MS - (Date.now() - lastChildNoticeAt));
          return;
        }
        cancelChildWaitTimer();
        // A terminal child is never throttled: recovery must happen even when
        // the review continuation budget is exhausted or another notice fired
        // moments ago. Only a genuinely in-flight child is rate-limited.
        if (childVerdict.terminated.length === 0) lastChildNoticeAt = Date.now();
        // …but each dead judge is announced ONCE. Recorded here, where the
        // announcement actually goes out, so a notice that was throttled or
        // never built cannot mark a death as already reported.
        for (const t of childVerdict.terminated) announcedTerminated.add(t.child.sessionId);
        pi.sendUserMessage(
          `[REVIEW_GATE_CHILD_${childVerdict.terminated.length > 0 ? "ENDED" : "HOST_WAIT"}] ${childNotice}\n\n` +
          (childVerdict.terminated.length > 0
            ? "Continue: read the child's output and drive the loop forward. Do not summarize; execute."
            : "Waiting discipline: do all deterministic work first; only when nothing is left, block in ONE bash call watching the three criteria. Never end the turn and leave the wake-up to the child."),
          { deliverAs: "followUp" },
        );
        return;
      }
    }
    // Review-round budget is checked AFTER the child watchdog above. A child
    // may already be dead or silent even when the continuation cap is reached;
    // the main session must still inspect its output and recover instead of
    // returning to idle before the independent termination判据 run.
    if (problems.length > 0 && continuationsInjected >= state.maxRounds) { confirmStop(); return; }
    if (problems.length === 0 && completionContinuations >= COMPLETION_CONTINUATION_CAP) { confirmStop(); return; }

    // L2 circuit breaker: an unmet gate justifies another turn only while
    // something is still MOVING. When the fingerprint, both verdicts, the round
    // count, the unmet list and the NEGOTIATED CONTRACT are all unchanged for
    // STALL_REPEAT_LIMIT evaluations in a row, another injection would only
    // burn the budget telling the agent to retry what is not moving — the
    // observed 7-injection quota burn. Stop injecting and name the cause the
    // gate can actually see (`classifyStallCause` reads the sidecar; blaming
    // the provider first is what sent a user to inspect a healthy model chain
    // during an 80-minute negotiation, 2026-09-16).
    // Tighten-only: no verdict is granted, ship commands stay blocked.
    //
    // WHAT COUNTS AS MOTION is `stallInMotion`'s call, not this file's — a
    // running judge, the overdue-negotiation directive, a dialog waiting for
    // the user, and a user answer that arrived after the PREVIOUS observation
    // (an event, never a grace period).
    //
    // 2026-09-17 P1 (reviewer): the force-negotiate directive must NOT be
    // swallowed by the stall breaker. The exact scenario it exists for — a
    // read-only probe loop (no edits → fingerprint unchanged, no review →
    // verdicts PENDING, no rounds) — trips the L2 stall breaker at ~4
    // unchanged settles, which returns before the RESUME injection. So a
    // stalled read-only loop would never see the directive at turn 60.
    // A force-negotiate directive IS motion: it is the gate telling the agent
    // to do the one thing that ends the loop. Treat an overdue negotiation as
    // in-motion (same exemption a running reviewer gets), so the directive
    // reaches the agent exactly when it is needed.
    const motion = {
      // A running reviewer is why the signature is unchanged: the verdict it
      // will produce does not exist yet. Cutting the loop off there would
      // orphan the very review the gate is waiting for — until it is too old
      // to be believable (see `judgeChildInMotion`).
      judgeInFlight: judgeChildInMotion(),
      forceNegotiate,
      pausedForUser: state.pausedQuestion !== undefined,
      lastUserInteractionAt: lastUserInteractionAt.current,
      previousObservationAt: lastStallObservedAt,
    };
    const stall = evaluateStall(
      loopStall,
      progressSignature({
        fingerprint: fp.unavailable ? "" : fp.digest,
        reviewVerdict: state.review.verdict,
        precommitVerdict: state.precommit.verdict,
        rounds: state.rounds.length,
        problems: [...problems, ...completion],
        // The contract hashes are recorded by the gate itself (the confirmed
        // restatement, the draft the goal auditor judged, the approval), so
        // "the requirement moved" is a fact rather than a guess.
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
    // later belongs to the NEXT one, which is what makes the fact an event
    // rather than a window.
    lastStallObservedAt = new Date().toISOString();
    loopStall = stall;
    if (stall.stalled) {
      // Once per stall, not once per turn: the state persists in `loopStall`,
      // and any real progress resets both the count and this flag.
      if (!stallNoticeShown) {
        stallNoticeShown = true;
        const cause = classifyStallCause({
          pausedForUser: motion.pausedForUser,
          goalConfirmed: goalStageSatisfied(),
          hasUnreviewedChanges:
            (state.hasCodeChange || state.hasDocChange) && state.review.verdict !== "READY",
          lastUserInteractionAt: lastUserInteractionAt.current,
          nowMs: Date.now(),
        });
        try { ctx.ui.notify(buildStallNotice(stall.repeats, cause), "warning"); } catch { /* headless */ }
      }
      updateWidget(ctx);
      confirmStop();
      return;
    }
    stallNoticeShown = false;

    if (problems.length > 0) continuationsInjected += 1;
    else completionContinuations += 1;
    // R10: fire the strategic-reset checklist BEFORE persist so the fired flag
    // survives restarts (one-shot per gate-state lifetime). Pass `state`
    // explicitly — the P-multi signature change (st: GateState) left this
    // call bare and it threw "Cannot read properties of undefined (reading
    // 'strategicResetFired')".
    const reset = maybeStrategicReset(state);
    persist(ctx);
    pi.sendUserMessage(
      "[REVIEW_GATE_RESUME] " +
        (problems.length > 0 ? "Quality gates are still unmet:\n" : "The task is not finished yet:\n") +
        [...problems, ...completion].map((p) => `- ${p}`).join("\n") +
        (forceNegotiate
          ? "\n\n" + buildGoalForceNegotiateDirective(state.turnsWithoutGoal)
          : "") +
        (problems.length > 0
          ? `\n(continuation ${continuationsInjected}/${state.maxRounds}) ` +
            "Continue: fix → judge_submit({role:\"reviewer\"}) → declare_done. " +
            SETTLED_TOOL_REMINDER + " Do not summarize; execute."
          : `\n(completion continuation ${completionContinuations}/${COMPLETION_CONTINUATION_CAP}) ` +
            (goalOnly
              ? "The only open item is the unapproved loop goal. Interview the user with ask_user " +
                "(the gate runs the interview and pauses for their answers), draft the goal in " +
                "Simplified Chinese, get it through the `goal-auditor` audit, then call " +
                "propose_loop_goal for approval. Do not summarize; execute."
              : "Continue: work these off — Copilot threads get a fix + resolve or a reply explaining " +
                "why not (copilot_review verifies), an unapproved goal gets negotiated with " +
                "ask_user, drafted in Simplified Chinese, audited by `goal-auditor` and only then " +
                "submitted via propose_loop_goal. Do not summarize; execute.")) +
        (!sessionEdited && !state.scopeLimit
          ? "\nIf these unmet gates target PRE-EXISTING changes this session never made, you may call request_scope_limit — the USER decides whether session-only coverage suffices."
          : "") +
        reset,
      { deliverAs: "followUp" },
    );
  });

  // ---------- lifecycle ----------

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    // (Snapshot sessions were retired 2026-08-27. Judge panes DO load this
    // extension — in judge mode (reporting shell): see readJudgeSideEnv. No
    // inert-session special-case is needed all the same.)
    // P-multi: re-derive the primary repo and reset per-repo tracking for the
    // new session (a switched session may target a different checkout).
    // One probe, two facts: the session cwd's git-ness AND its root.
    // `gitRootOfDir` already silences git's stderr (stdio ignore), so this
    // single call never leaks the "fatal: not a git repository" noise.
    sessionInGit = gitRootOfDir(cwd) !== null;
    primaryRepoRoot = gitRootOfDir(cwd) ?? cwd;
    activeRepoRoot.current = primaryRepoRoot;
    sessionRepos.clear();
    sessionRepos.add(primaryRepoRoot);
    repoStateCache.clear();
    // (Snapshot bookkeeping retired 2026-08-27 — judge children are tmux
    // panes, and review targets are registered per round in memory.)
    // USER REQUIREMENT: "no changes" for the first classification means THIS
    // session — a new session starts with a clean edit slate even if the
    // worktree carries pre-existing changes from before (they still arm the
    // ship gate via the P0-2 detection below).
    sessionEdited = false;
    // In-memory pause/lock hygiene for a fresh (or switched) session.
    lastRunAborted = false;
    scopeLimitDeclined = false;
    sessionEditedPaths.clear();
    // A new/switched session inherits NO sensitive-file authorization.
    sensitiveGrants = [];
    sensitiveDeclinedPaths.clear();
    let sessionId: string | null = null;
    try { sessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.() ?? null; } catch { /* */ }
    restore(ctx, sessionId);
    state.sessionId = sessionId;
    // P-multi: re-arm the repo set from the persisted list — a same-session
    // resume keeps the repos it edited, and a RELAY SUCCESSOR inherits the
    // predecessor's (lib/gate-state.ts's `inheritGoalContract` is what puts
    // them on the state). Only repos whose sidecar still exists are re-added —
    // a deleted checkout must not block declare_done forever.
    //
    // IT HAS TO LAND ABOVE THE FIRST persist() (quality round P1, 2026-09-16):
    // `persist` writes `state.sessionReposPaths` FROM this in-memory set, and a
    // relay successor ALWAYS persists early (the spawner hands it its mode, and
    // `setTaskMode` persists) — so an inherited list re-armed any later was
    // erased before anything could read it, and the inheritance was dead code.
    for (const r of state.sessionReposPaths ?? []) {
      if (r !== primaryRepoRoot && existsSync(sessionSidecarPath(r))) sessionRepos.add(r);
    }
    // Take over previous sessions' pane judges: merge their registry + pendings
    // so live panes stay addressable and no second pi is forked onto one
    // session id. Judge panes themselves skip this (they operate nothing).
    if (!readJudgeSideEnv(process.env)) {
      for (const root of new Set([primaryRepoRoot, ...sessionRepos])) ensureHierarchyLoaded(root);
      dropDeadForeignJudges();
    }
    // A new session negotiates its OWN goal: whatever audit rounds a previous
    // session spent on its draft do not carry into this one's count.
    delete state.goalAuditRound;

    // Per-project overrides (sd0x-dev-flow R6): maxRounds is clamped to [3,50]
    // by the loader, so a forged config cannot make the cap unreachable.
    // Anchored at the repo ROOT (matches the runner's own .pi lookup).
    projectConfig = loadProjectConfig(primaryRepoRoot);
    state.maxRounds = projectConfig.maxRounds;
    // Publish-path fallback for the model-config layers (see
    // ensureModelLayersRendered): idempotent, fail-soft.
    ensureModelLayersRendered(ctx);
    // The session runtime was just (re)bound — re-arm the widget-refresh
    // timer with the fresh ctx. session_shutdown disarmed the old one, whose
    // captured ctx is dead after a replacement and must never be ticked
    // again (a stale tick throws on ctx.hasUI and crashes pi).
    armUiRefreshTimer();
    // THE SUPERVISION HEARTBEAT (round-4 P0). Armed here, for every session
    // that has an orchestration address, because the whole point is that it
    // does not depend on the agent doing anything: a child blocked in
    // `judge_wait` for ten minutes must keep saying it is alive, and the
    // first report must not wait for the first `turn_end` either.
    startChildHeartbeat(ctx);
    reportChildState(ctx, undefined, { force: true });

    // Reflect the precommit config source in the status bar right away.
    updateWidget(ctx);



    // NON-GIT DIRECTORY SHORT-CIRCUIT (2026-09-02, user decision): in a
    // directory that is not inside a git repository (e.g. /tmp), the whole
    // gate steps aside — no git calls, no branch, no loop goal, no
    // checkpoint/review/precommit/ship machinery. The previous behavior
    // CALLED git anyway and swallowed the stderr, which still leaked
    // "fatal: not a git repository" to the terminal on every startup and
    // widget tick. Nothing here can ship (there is no repo to commit to),
    // so normal mode is the honest classification; the language directive
    // (L4) stays — it is orthogonal to the gate.
    if (!sessionInGit) {
      setTaskMode("normal", "auto", ctx);
      if (ctx.hasUI) {
        try {
          ctx.ui.notify("review-gate: 非 git 目录 —— 门禁不介入（无仓库可审查/提交）。", "info");
        } catch { /* headless */ }
      }
      return; // skip P0-2 arming, protected-branch notice, heartbeat-state report
    }
    // PROTECTED-BRANCH NOTICE (2026-09-07, user decision): the workspace
    // settlement layer is gone, so a session may sit on main/master/dev/
    // develop with nobody having asked anything. Say so up front — the
    // checkpoint (and ship) refusal is the hard half, this notice is the
    // soft half.
    //
    // SAY WHAT THE REFUSAL IS (2026-09-12). This notice used to promise a
    // confirmation dialog before committing on a protected branch. There is no
    // such dialog any more — a protected-branch checkpoint is refused outright
    // (and a shell `git commit` cannot ask, so it fails closed too). The
    // notice is the only thing the user reads before hitting that wall, so it
    // must not describe a door that is not there.
    const startBranch = currentBranch(primaryRepoRoot);
    if (startBranch && isProtectedBranch(startBranch) && ctx.hasUI) {
      showToUser(
        ctx as unknown as ExtensionContext,
        "───────── 当前在受保护分支 ─────────",
        `本会话在 ${startBranch} 上开始。checkpoint 会直接提交到当前分支；` +
        "在受保护分支上 checkpoint 与 `git commit` 都会被**直接拒绝**（不弹确认框）。" +
        "若这不是你的意图，先切换分支。",
      );
    }
    // USER REQUIREMENT — a session that cannot show a dialog runs in normal
    // mode, period. Every enforced mode now depends on dialogs (loop-goal
    // approval, sensitive-edit authorization, downgrade confirmation), so a
    // headless session would otherwise enter the loop with no way to satisfy
    // it. Forcing the decision HERE (rather than waiting for set_gate_mode,
    // which lib/task-mode.ts would reject) means the undecided state — whose
    // enforcement behaves as loop — never applies to a headless run.
    if (!ctx.hasUI) setTaskMode("normal", "auto", ctx);

    // SAY IT ONCE WHEN THE BANNER CHANNEL IS DEAD (user decision, 2026-09-17).
    // A notification is how this gate reaches somebody who is not watching —
    // silently having none of that is the failure mode the whole round is
    // about. Only for a session that WOULD be allowed to raise one (a manager
    // or a standalone loop session): a judge pane has no business asking for a
    // notifier it will never use.
    if (
      ctx.hasUI &&
      mayNotifyUser({ taskMode: state.taskMode, stateVariant: process.env[STATE_VARIANT_ENV] }) &&
      notifyRuntime.startHint()
    ) {
      try { ctx.ui.notify(notifyRuntime.startHint(), "info"); } catch { /* headless */ }
    }

    // A SPAWNER may hand a session its starting mode (RG_GATE_MODE): a child
    // opened by `orchestrator_spawn` is an ordinary loop session, and a relay
    // successor is an orchestrator. Neither should have to classify itself
    // into a role somebody else already decided, and a child that guessed
    // "orchestrator" would take over the very orchestration supervising it.
    //
    // It is not a way around the consent rules: it applies only to a session
    // that is still UNDECIDED and interactive, and only for the two enforced
    // modes — a spawner can hand out a tighter starting point, never a looser
    // one. Anything else in the variable is ignored (normalizeTaskMode).
    //
    // THE ONE NON-ENFORCED REQUEST THAT IS HONOURED: a WORKER pane asking for
    // `explore` (2026-09-21). That is not a relaxation of the consent rule it
    // sits beside — a worker runs without `edit`/`write` and its `bash` is
    // bound to read-only use (prompt + the ship block `explore` keeps), so
    // `explore` is not a looser starting point for it, it is the only honest
    // description of a session that reads and reports. Left undecided it behaved as loop (fail-closed), and the
    // measured cost was a worker being told to negotiate a loop goal it has no
    // way to negotiate: after `worker_report` the gate injected
    // `[REVIEW_GATE_RESUME]` and continued it 1/15, 2/15, … — a full LLM turn
    // each. The worker identity is required, so nothing an ordinary session
    // can put in its own environment reaches this branch.
    if (ctx.hasUI && state.taskMode === undefined) {
      const requestedBySpawner = requestedModeFromEnv();
      if (isEnforcedMode(requestedBySpawner) && requestedBySpawner !== undefined) {
        if (requestedBySpawner !== "orchestrator" || process.env.TMUX) {
          setTaskMode(requestedBySpawner, "auto", ctx);
        }
      } else if (requestedBySpawner === "explore" && readWorkerSideEnv(process.env)) {
        setTaskMode("explore", "auto", ctx);
      }
    }

    // A restored pause survives the restart: keep auto-continuation disarmed
    // until the user's next message clears it (input handler).
    if (state.pausedQuestion) loopArmed = false;

    // A same-session resume keeps this session's edit attribution: re-seed
    // the in-memory set from the persisted lists so a process restart cannot
    // re-label the session's own edits as "pre-existing" (and offer them for
    // a scope-limit exemption), nor lose a granted scope's in-scope list.
    for (const f of state.sessionEditedFiles ?? []) sessionEditedPaths.add(f);
    for (const f of state.scopeLimit?.sessionFiles ?? []) sessionEditedPaths.add(f);
    if (sessionEditedPaths.size > 0) sessionEdited = true;

    // (The repo set was re-armed right after `restore()` — it has to land
    // BEFORE the first persist, which derives the persisted list from the
    // in-memory set.)

    // P0-2: detect pre-existing changes — worktree AND branch commits. A
    // user-granted scope limit exempts exactly the files still in its
    // snapshot (a file the session later edits is RECLAIMED out of it by the
    // edit handler); new dirty files still arm the gate (fail-closed).
    // Branch-commit arming is suspended while the grant stands: a new commit
    // under a standing grant is either the exempted pre-existing work being
    // shipped (exactly what the user consented to) or a user/bypass action;
    // the session's own NEW edits re-arm the gate before any further agent
    // commit.
    // ONLY the headless force above may skip arming: a no-UI normal session
    // keeps the git hooks fully enforced (source "auto"), so arming a dirty
    // worktree here would block exactly the commit that mode promises to
    // allow. An INTERACTIVE normal session still arms. Nothing is enforced
    // while it stays normal — and its hooks are already harmless (a
    // user-confirmed normal records source "user", which makes them advisory;
    // the only agent-reachable normal is a /tmp scratch session, where no
    // hook-installed repo lives) — but if the user later switches it to loop
    // via /gate-mode, the pre-existing changes must already be inside the
    // fence. Skipping here would leave them permanently unreviewable.
    const headlessNormal = state.taskMode === "normal" && !ctx.hasUI;
    if (!headlessNormal && !state.hasCodeChange && !state.hasDocChange && !state.bypass.active) {
      const exempt = new Set(state.scopeLimit?.preexistingFiles ?? []);
      const allFiles = changedFiles(cwd);
      const files = state.scopeLimit && allFiles ? allFiles.filter((f) => !exempt.has(f)) : allFiles;
      // ONE RULE, ONE IMPLEMENTATION (drill F1): `turn_end` asks the same
      // question of the same facts, and the two copies of it had drifted.
      const armed = armingFromFacts({
        files: files ?? [],
        commitsAhead: state.scopeLimit ? 0 : commitsAheadOfBase(cwd),
      });

      if (armed.hasCodeChange || armed.hasDocChange) {
        if (armed.hasCodeChange) {
          state.hasCodeChange = true;
        }
        if (armed.hasDocChange) {
          state.hasDocChange = true;
        }
        state.review.verdict = "PENDING";
        state.precommit.verdict = "NOT_RUN";
      }
    }

    // Reclaim orphan .blocked owners (ours, plus any session silent past the
    // concurrent-session window). Deliberately NOT an unconditional unlink:
    // that deleted the fail-closed signal of a CONCURRENT session whose state
    // never reached disk, leaving the hooks to verify a stale-but-well-formed
    // sidecar — fail-closed degraded to fail-open. Done here as well as in
    // persist() because an early return (explore/normal, or a throw) can mean
    // persist() never runs this turn.
    //
    // …but NOT as a judge, and not while refused. This call is the one write
    // to the repo's gate state that does not go through persist(), so it needs
    // the same two guards spelled out: a judge reclaiming (or rewriting) the
    // marker would be the reporting shell editing the fail-closed signal of
    // the session it is reviewing, and a refused session would be doing it to
    // the session that holds this worktree (reviewer P1, 2026-09-05).
    if (!gateStateWriteSkip(process.env) && !state.exclusivityRefusal) {
      reconcileBlockedMarker(blockedMarkerPath(sessionSidecarPath(cwd)), { sessionId: state.sessionId });
    }

    // Explain an invalidated binding instead of letting READY silently become
    // PENDING after an upgrade (see migrateFingerprintVersion).
    if (fingerprintMigrated) {
      try { ctx.ui.notify(FINGERPRINT_MIGRATION_NOTICE, "warning"); } catch { /* headless */ }
      fingerprintMigrated = false;
    }

    // ONE gate session per worktree. This REPLACED a warning that guessed:
    // "another session wrote this sidecar within four hours, it may still be
    // open". It could not tell a live session from one that finished an hour
    // ago, so it had to hedge — and a warning that asserts more than it knows
    // is how people learn to ignore this gate. There is a real liveness signal
    // now (a heartbeat), so the answer is a decision instead of a hedge:
    // refuse, or take the claim. Two definitions of "another session is alive"
    // would be one too many (哲学三), so the old one is gone.
    applySessionExclusivity(ctx);

    persist(ctx);

    // ── THE NAME, AT STARTUP (t2, 2026-09-25) ──
    //
    // Two things happen here, and both belong to the FIRST moment a session is
    // alive: it re-adopts the registration its own session id already holds (a
    // restart or a reload keeps its name), and it SWEEPS what dead sessions
    // left behind — their tmux sessions, registrations and inboxes. The sweep
    // is judged in lib/session-registry.ts and fires only on provable death;
    // it runs once per session and its report goes to the log.
    const namingStart = sessionNaming.onSessionStart();
    if (namingStart.adopted !== undefined) {
      log(`review-gate[session-name] 本会话沿用已登记的名字 ${namingStart.adopted}`);
    }
    for (const reaped of namingStart.sweep.reaped) {
      log(
        `review-gate[session-name] 回收孤儿：${reaped.name}（${reaped.sessionId}）` +
        `${reaped.sessionKilled ? "，已 kill 它的专属 tmux session" : ""}`,
        // NO “已清 inbox” HERE (2026-09-25, reviewer P1 twice): the sweep does
        // not delete a dead holder's mail — the name it leaves behind may be
        // claimed by a new session before any cleanup could run. The reason is
        // written in full at the removal site in lib/session-orphan-sweep.ts.
      );
    }
    startSessionNamingHeartbeat();
  });

  pi.on("session_shutdown", (event) => {
    // A CLEAN SHUTDOWN IS NOT A FAILURE (user decision, 2026-09-17): every
    // reason pi reports here — quit, reload, new, resume, fork — is the user
    // ending or restarting the session themselves, and they already know.
    // The flag is what the runtime's process-exit handler consults; without it
    // a crash and a `/quit` would look identical from there.
    notifyRuntime.markCleanShutdown();
    // (`event.reason` is read at the BOTTOM of this handler — it decides whether
    // the session's name goes back — so there is no `void event;` here.)
    // Round-18: stop the referenced child-wait watchdog with the session.
    cancelChildWaitTimer();
    // The old session runtime is being torn down (reason: quit | reload |
    // new | resume | fork). Every ctx this instance captured is now stale
    // and THROWS on access, so the widget-refresh timer must stop ticking
    // it: without this, the 5s tick fired against the dead ctx right after
    // a resume and the uncaught exception took pi down — which is exactly
    // why the resumed session could not come back. session_start re-arms
    // the timer with the fresh ctx (updateWidget also re-arms, idempotently,
    // so a later subagent-session shutdown cannot leave the widget frozen).
    lastUiCtx.current = undefined;
    disarmUiRefreshTimer();
    // The supervision probe is a timer this session owns; a leaked one would
    // keep waking a session that is gone.
    stopSupervisionTimer();
    // The revival timer is this session's own clock; a leaked one would
    // keep reviving a session that is gone.
    stopRevivalTimer();
    // Same for the child heartbeat: a leaked timer would keep reporting on
    // behalf of a session that is gone, and its supervisor would read those
    // reports as a healthy child.
    stopChildHeartbeat();
    // Let go of the worktree so the next session does not have to wait out the
    // freshness window. Only OUR OWN claim is dropped — a session that was
    // refused never wrote one, and deleting the holder's record on the way out
    // would hand a live worktree to somebody else.
    releaseWorktree();
    // …and stop watching somebody else's heartbeat (a refused session's timer).
    stopExclusivityRecheck();
    // Judge children are independent pi processes — they survive the session
    // by design (their session files persist, so a fresh session can resume
    // or close them). Nothing to clear here anymore: the registry IS the
    // persisted table, and dropping it on shutdown is precisely what used to
    // strand a live pane nobody could address after a restart.

    // ── THE NAME AT SHUTDOWN (t2; quality round 2 P1) ──
    //
    // The renewal clock always stops. Whether the NAME goes back depends on
    // where this session is going, and the reason is the whole difference:
    //
    //   - `reload` keeps the SAME session id, so the instance that comes back
    //     adopts the same registration in its own `session_start` — releasing
    //     here would rename a session that never went away;
    //   - `new` / `resume` / `fork` REPLACE the session: pi builds a new session
    //     (new id) and a new extension instance, while the tmux pane and the pid
    //     are unchanged. `held` dies with this instance, so without this release
    //     the old registration keeps looking LIVE to every other reader (its pid
    //     is this very process, its pane is on screen) and the name could never
    //     be taken again in that window;
    //   - `quit` is the ordinary exit, and the process-exit handler is the
    //     backstop for every path that never gets here.
    //
    // `release()` is idempotent and all-or-nothing (lib/session-name-tools.ts),
    // so a reload that raced into a replacement still gives the name back.
    stopSessionNamingHeartbeat();
    if (event.reason !== "reload") sessionNaming.release();
  });

  pi.on("session_compact", async (_event, ctx) => {
    // Explore/normal have no enforced loop to resume — a "Resume the loop"
    // nudge would contradict the mode, so skip the gate-resume injection.
    if (state.taskMode === "explore" || state.taskMode === "normal") return;
    // Paused for a user question: "Resume the loop" would contradict the
    // wait. Instead, re-inject the waiting state so the compacted model does
    // not lose the fact that it is waiting for the user's answer.
    if (state.pausedQuestion) {
      pi.sendMessage({
        customType: "review-gate-resume",
        content:
          "[REVIEW_GATE_PAUSED] Context compacted. The review loop is PAUSED (ask_user), " +
          `awaiting the user's answer to: "${state.pausedQuestion.question.slice(0, 500)}"\n` +
          "Do not resume the loop on your own — wait for the user's reply (it clears the pause automatically). " +
          "Ship commands remain blocked while gates are unmet.",
        display: true,
      }, { deliverAs: "followUp", triggerTurn: false });
      return;
    }
    const fp = computeFingerprint(cwd);
    const problems = unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync });
    if (problems.length === 0 || state.bypass.active) return;
    // R9 (git memory, default on): filtered git snapshot so the model recovers its
    // working context after compaction without re-exploring the repo.
    const gitContext = projectConfig.gitMemory ? buildGitMemory(cwd) : "";
    pi.sendMessage({
      customType: "review-gate-resume",
      content:
        "[REVIEW_GATE_RESUME] Context compacted. Gate state survived:\n" +
        `- review: ${state.review.verdict}\n- precommit: ${state.precommit.verdict}\n` +
        `- round: ${state.rounds.length}/${state.maxRounds}\n` +
        "Unmet:\n" + problems.map((p) => `- ${p}`).join("\n") + "\nResume the loop." +
        (gitContext ? "\n\n" + gitContext : ""),
      display: true,
    }, { deliverAs: "followUp", triggerTurn: false });
  });

  // One-way stale-state reconciliation: git-clean can clear flags, only edits set them.
  // P0-7: re-arm when stash pop / checkout restores dirty state without an edit event.
  pi.on("turn_end", async (_event, ctx) => {
    // The heartbeat. `turn_end` fires whether or not this session has edits,
    // so it is the one event that proves the extension is alive — which is
    // exactly what `stalled` is the absence of. Placed before the early
    // return below for that reason.
    noteChildProgress(); // E — a turn boundary is forward progress (the timer heartbeat is not).
    reportChildState(ctx);

    // …AND EVERY OTHER REPO THIS SESSION WORKED IN (quality round 2 P2). The
    // rule is one rule, and a secondary repo had NO reconciliation path at all:
    // once armed it stayed armed — while `declare_done` counts every repo in
    // `sessionRepos`, so a flag nothing justifies any more kept the task
    // unclosable. Same functions as the primary block below, clear-only, and the
    // branch-ahead fact still holds an unreviewed branch open (the F1 rule), so
    // this can only un-arm what the facts no longer support.
    //
    // Only repos with a state ALREADY created this session are visited
    // (`repoStateCache`): a repo that was merely mentioned must not get a sidecar
    // written for it here.
    for (const root of sessionRepos) {
      if (root === primaryRepoRoot) continue;
      const st = repoStateCache.get(root);
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
      persistRepo(ctx as unknown as ExtensionContext, root);
    }

    if (!state.hasCodeChange && !state.hasDocChange) return;
    const allFiles = changedFiles(cwd);
    if (allFiles === undefined) return;
    // User-granted scope limit: files still in the exempt snapshot never
    // count toward the armed/clean reconciliation (session-edited files were
    // reclaimed out of it by the edit handler, so they DO count), and
    // branch-commit arming stays suspended while the grant stands (a new
    // commit is either the consented exempted work being shipped or a
    // user/bypass action — session edits re-arm the gate first).
    const exempt = new Set(state.scopeLimit?.preexistingFiles ?? []);
    const files = state.scopeLimit ? allFiles.filter((f) => !exempt.has(f)) : allFiles;
    // ASK THE SAME QUESTION ARMING ASKS (drill F1, 2026-09-19) — and it is the
    // SAME code (`lib/gate-arming.ts`). This block used to read only the
    // working tree's file KINDS, so one untracked non-code file (measured: the
    // seeded `node_modules` symlink) cleared an arming that commits ahead of
    // the base were holding up, and the ship gate let unreviewed commits pass.
    // The git call is paid only when a flag could actually be cleared.
    const current = { hasCodeChange: state.hasCodeChange, hasDocChange: state.hasDocChange };
    if (!couldReconcile(current, files)) return;
    const next = reconcileArming(current, {
      files,
      commitsAhead: state.scopeLimit ? 0 : commitsAheadOfBase(cwd),
    });
    if (!next.changed) return;
    state.hasCodeChange = next.hasCodeChange;
    state.hasDocChange = next.hasDocChange;
    persist(ctx);
  });

  // ---------- thinking-loop guard ----------
  //
  // A reasoning model can spin: a turn emits ONLY thinking deltas, never text
  // and never a tool call, so Pi never ends it and the terminal fills with tens
  // of thousands of chunks while the user watches (deepseek-ai/deepseek-harness#5976).
  // The decision lives in lib/thinking-loop-guard.ts and the state machine in
  // lib/thinking-loop-controller.ts — this is only the wiring, and it is wired
  // for EVERY session that loads this extension (main, judge pane, orchestrator
  // child) on EVERY reasoning model: the guard is model-agnostic, and filtering
  // by provider name would have missed the custom `dsv4` provider entirely.
  //
  // `ctx` is stashed rather than captured: the effects fire from a stream
  // callback, and the extension's context is per-event, so the latest one is
  // the live one.
  //
  // The model-facing notice is DEFERRED to the settle handler below, not
  // queued as a steering message: Pi drains its steering queue from inside a
  // RUNNING agent loop, and `abort()` is exactly what stops that loop — so a
  // steer queued here would sit in the queue until something else started a
  // turn. Sending it once the session is idle again is the only ordering that
  // guarantees the model actually reads it.
  let thinkingLoopInjection: string | undefined;
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
    // `abort()` leaves the run's last assistant message with stopReason
    // "aborted", which the gate's ESC detection (agent_end) reads as "the USER
    // stopped me" and pauses L2 auto-continuation. This abort was OURS and we
    // are about to hand the session a new turn, so that reading is wrong here.
    lastRunAborted = false;
    try {
      // Idle is the normal case (the abort just ended the run); a gate that
      // already auto-continued this settle leaves us streaming, and then the
      // notice rides that run as steering.
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

  // Background-agent wait tracking, message side: a `subagent-notification`
  // custom message is pi-subagents' terminal signal for one or more agents
  // (details.id, plus details.others for a group) — see lib/background-wait.ts.
  pi.on("message_end", (event) => {
    const custom = event.message as { customType?: string; details?: unknown };
    if (custom.customType !== "subagent-notification") return;
    foldBackgroundWait({
      kind: "message",
      message: { customType: custom.customType, details: custom.details },
    });
  });

  // …and the EVENT BUS, which is the terminal signal EVERY finished run emits
  // (2026-09-17, the round that fixed a child stuck reporting `working` after
  // its own `declare_done`). The notification above is not enough on its own:
  // pi-subagents skips it when the result was already consumed and holds
  // others back for batch finalization, so a child that spawned three agents
  // saw one notification and kept two waits forever. `pi.events.on` registers
  // the subscription with the extension runtime, so a reload cannot leave the
  // old handler attached to the new bus.
  //
  // IT IS OPTIONAL, like every host capability this extension reaches for: a
  // host that loads this file outside pi (the install fixtures in test/, a
  // tool that imports it to inspect it) has no bus, and the gate then keeps
  // the two signals it always had rather than refusing to load.
  for (const channel of ["subagents:completed", "subagents:failed"] as const) {
    pi.events?.on?.(channel, (payload) => {
      const changed = foldBackgroundWait({
        kind: "finished",
        id: (payload as { id?: unknown } | null | undefined)?.id,
      });
      // Nothing was waiting on that agent ⇒ nothing to say. Reporting anyway
      // would write a channel record per finished agent of every session.
      if (!changed) return;
      // The state may be changing from `working` to `idle`/`done` RIGHT NOW,
      // and a manager may be sitting in a wait: publish it on this event
      // instead of making it wait out the heartbeat.
      if (latestCtx) {
        try {
          reportChildState(latestCtx, undefined, { force: true });
        } catch { /* reporting is never allowed to break the session that runs it */ }
      }
    });
  }

  pi.registerMarkdownTransformer((markdown, context) =>
    thinkingLoop.truncateDisplay(markdown, context.messageType),
  );

  // ---------- commands ----------
  //
  // The WHOLE command layer — the workflow catalog plus /gate-status,
  // /gate-bypass, /gate-mode, /gate-reset, /gate-lesson and /gate-doctor —
  // moved to lib/gate-command-tools.ts (+ lib/gate-diagnosis-commands.ts) for
  // the architecture rule this file is the repository's own worst example of
  // (AGENTS.md §"架构规范"). ONE registration call wires all of them: a layer
  // the extension could wire half of is a layer it eventually does.
  //
  // What they need from THIS file arrives as this deps object. `state`,
  // `projectConfig` and `primaryRepoRoot` are GETTERS on purpose — the
  // extension rebinds all three (session_start reloads the state and the
  // config, /gate-reset replaces the state object outright), so a captured
  // reference would leave the status readout describing a dead copy of the
  // very state the gate reads.

  /**
   * Everything /gate-reset clears.
   *
   * It stays HERE, as one function, because every binding it touches lives in
   * THIS closure: the state object the extension rebinds, its loop counters
   * and locks, the never-persisted sensitive-file grants, the bypass token
   * and the appeal ledger. The command module owns the ordering around it
   * (reset → persist → notify) and nothing else.
   */
  function resetSessionState(): void {
    // THE USER'S STAGE SWITCHES SURVIVE THE RESET (2026-09-22, lib/loop-stages.ts):
    // they are the user's own configuration of the gates, not a verdict or a
    // lock — clearing them would silently turn gates back ON behind the choice
    // the box recorded. `/gate-status` names them, and `choose_loop_stages`
    // re-opens the box when the user wants them changed.
    const stages = state.stages;
    state = emptyState(state.sessionId, state.maxRounds);
    if (stages) state.stages = stages;
    armLoop();
    continuationsInjected = 0;
    resetOrchestratorContinuations(); // goal 6 — reset with the loop budget
    completionContinuations = 0;
    loopStall = undefined;
    stallNoticeShown = false;
    agentDowngradesLocked = false;
    lastRunAborted = false;
    scopeLimitDeclined = false;
    sessionEditedPaths.clear();
    // The user's call: revoke outstanding one-shot sensitive-file
    // authorizations AND lift the per-path decline locks.
    sensitiveGrants = [];
    sensitiveDeclinedPaths.clear();
    clearBypassToken();
    lastBlockedShip = null;
    lastBlockedText = null;
    // The judge-side class clears with the other two, pass included: a live
    // pass would otherwise authorize a zero-inspection READY after the reset.
    lastBlockedInspection = null;
    inspectionPass = undefined;
    // A user-initiated reset clears the appeal ledger too: quota, decided
    // contents and any live pass. It is the user's own call, and leaving a
    // pass behind would let it authorize content after the reset.
    delete state.appeals;
    arbitrationDecisions.clear();
  }

  registerGateCommands(pi, {
    state: () => state,
    projectConfig: () => projectConfig,
    primaryRepoRoot: () => primaryRepoRoot,
    cwd,
    // The doctor reads the assets THIS package ships; the path is computed
    // here rather than inside lib/ so it cannot silently change meaning when
    // a module moves between directories.
    packageRoot: pathJoin(pathDirname(fileURLToPath(import.meta.url)), ".."),
    persist: (ctx) => persist(ctx as unknown as ExtensionContext),
    callTool: (name, params, ctx) => callTool(name, params, ctx),
    toolText: (result) => toolText(result),
    otherRepoStatus: () => otherRepoStatus(),
    loopGoalConfirmed: () => loopGoalConfirmed(),
    loopGoalPresent: () => readSessionLoopGoal(primaryRepoRoot).present,
    contract: () => contractReadout(),
    hasProxyGrant: (scope) => hasGrant(state.orchestrator ?? emptyRuntime("none"), scope),
    grantProxyScope: (scope, via) => {
      if (!state.orchestrator) return;
      persistOrchestration(addGrant(state.orchestrator, { scope, grantedAt: new Date().toISOString(), via }));
    },
    askChoice: (uiCtx, spec, opts) => askChoice(uiCtx as { ui?: ChoiceUi }, spec, opts),
    setLoopArmed: (armed) => { loopArmed = armed; },
    setTaskMode: (mode, source, ctx) => setTaskMode(mode, source, ctx as ExtensionContext),
    // Only a USER action may lift the lock — /gate-mode and /gate-reset are
    // the only two callers, and both are user-invoked commands.
    unlockAgentDowngrades: () => { agentDowngradesLocked = false; },
    resetSession: resetSessionState,
    findProjectAgentText: (dir, name) => findProjectAgentText(dir, name),
  });

  // ---------- per-turn protocol reminder ----------

  pi.on("before_agent_start", (event) => {
    // Output-language gate: UNCONDITIONAL. Unlike the review gate, it does not
    // depend on there being pending changes — strict Simplified Chinese is
    // required on every turn, so it is injected before any early return.
    let systemPrompt = event.systemPrompt + "\n\n" + LANGUAGE_DIRECTIVE;

    // A SUCCESSOR'S BRIEF — for EVERY kind of session, not just the project
    // manager (2026-09-14, measured). It used to be injected inside the
    // orchestrator branch below, so a loop session's successor — the ordinary
    // case — got its first message but never the brief that says what to read
    // and who closes the predecessor.
    // THE ID IS READ HERE, NEVER MINTED (reviewer P2, 2026-09-14): this used to
    // call `currentOrchestrationId()`, which MINTS an id on first read — so
    // every session that owns no orchestration was stamped with one on every
    // turn, and the brief then promised a successor that "children will reach
    // you here". A session that HAS an orchestration carries its id in the
    // environment (that is how its children address it); one that does not has
    // nothing to inherit, and saying nothing is the honest answer.
    const inheritedBrief = formatInheritanceBrief(readInheritance(), orchestrationIdFromEnv());
    if (inheritedBrief) systemPrompt += "\n\n" + inheritedBrief;

    // THE HANDOFF REMINDER — injected at the very top, before every early return
    // below (a configured-correctly session that is out of context must hear it
    // in EVERY mode, judge panes included). It renders nothing at all until the
    // session's own reading passes 70% of its window; see
    // `handoffReminderBlock` for how the skeleton file rides along.
    systemPrompt += handoffReminderBlock();


    // STARTUP HARD CHECK (user requirement 2026-08-30): every role must have
    // a resolvable model chain in the agents config layer — no silent
    // built-in fallback. A missing/corrupt/unresolvable chain STOPS the
    // session with the reason (normal mode is exempt: the user turned the
    // gate off explicitly).
    if (state.taskMode !== "normal") {
      try {
        // ONE call: validate every role, self-heal the roles NO layer declares
        // (merged into ~/.pi/review-gate.json, gaps only), validate again.
        // Adding a role to KNOWN_AGENTS used to brick every session whose config
        // predates it — the session could not even start to be told to run the
        // installer. The ordering lives in lib/model-config.ts, where it is
        // testable; this site only says where the config and registry live.
        const { checks, healed, healProblems, agentsSection } = startupAgentsCheck({
          agentsGlobal: projectConfig.agentsGlobal,
          agentsProject: projectConfig.agentsProject,
          registry: loadRegistry(),
          configPath: globalConfigPath(),
          agentsDir: resolvePackageAgentsDir(),
        });
        if (agentsSection !== undefined) {
          // The SESSION's snapshot follows the file it just healed. A session
          // reads its config ONCE, so without this every downstream reader
          // (`resolveArbiterModel`, the layer renderer, dispatch) keeps seeing
          // the pre-heal state: the startup check passes while this session
          // still configures nothing (quality-auditor P2, 2026-09-22).
          projectConfig = { ...projectConfig, agentsGlobal: agentsSection };
        }
        if (healed.length > 0) {
          log(`self-healed missing agent slots into ${globalConfigPath()}: ${healed.join(", ")}`);
        }
        const bad = Object.entries(checks).filter(([, c]) => c && !c.ok);
        if (bad.length > 0) {
          const details = bad.map(([name, c]) => `- ${name}: ${c?.reason ?? "未知原因"}`).join("\n");
          const healNote = healProblems.length > 0
            ? `\n启动自愈也没能补上（原因如下）：\n${healProblems.map((p) => `- ${p}`).join("\n")}`
            : "";
          return {
            systemPrompt:
              systemPrompt +
              `\n\n## REVIEW-GATE: 配置错误，会话无法启动\n` +
              `角色模型配置不完整 —— 以下角色无法获得可派发的模型链：\n${details}${healNote}\n` +
              `\n请修复 ~/.pi/review-gate.json 后重开会话：` +
              `\n- 不在 agents 段里的角色（或值为空对象的）：启动时会自动补上包内默认链；` +
              `\n- 已有条目但不可用的角色（auto:true / slots 为空 / spec 不可解析）：改成明确的 auto:false + slots，` +
              `或删掉这个键让门禁补默认。` +
              `\n在配置修复前，本会话拒绝执行任何工作（ship 命令仍被拦截）。`
          };
        }
      } catch (e) {
        return {
          systemPrompt:
              systemPrompt +
              `\n\n## REVIEW-GATE: 配置检查异常，会话无法启动\n` +
              `启动配置检查本身失败（${e instanceof Error ? e.message : String(e)}）。` +
              `\n请修复 ~/.pi/review-gate.json 后重开会话。`
        };
      }
    }



    // Normal mode (user-confirmed later, or a consent-free first
    // classification / /tmp scratch clamp): the extension steps aside — no
    // workflow prompt is injected at all. The language directive above stays:
    // it is the user's standing output-language policy, orthogonal to the
    // gate, and costs nothing (adviser recommendation; trivially reversible).
    if (state.taskMode === "normal") {
      return { systemPrompt };
    }

    // Edit-discipline nudge (prompt-only): steer agents back to the edit/write
    // tools instead of shell-editing files after a failed tool call. Pure
    // guidance — no enforcement.
    systemPrompt += "\n\n" + EDIT_DISCIPLINE_DIRECTIVE;

    // Mode dispatch (single key): a spawned judge pane resolves to its
    // reporting-shell entry and gets the shell discipline — never the
    // classification directive (whose set_gate_mode is denied to it).
    // Anything else undecided keeps the fail-closed directive.
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
    // session tracks no code AND no doc change (see lib/gate-state.ts), so the
    // fingerprint it would be handed cannot affect the outcome. Computing it
    // first cost every turn of every clean session a full re-hash (~575ms on a
    // 9k-file repo) to produce a value that was then discarded. Enforcement is
    // unchanged: this block only renders prompt text — ship blocks,
    // declare_done and the git hooks each compute their own fingerprint.
    const gateArmed = state.hasCodeChange || state.hasDocChange;
    const fp = gateArmed ? advisoryFingerprint() : null;
    const problems = gateArmed
      ? unmetRequirements(state, fp!.digest, fp!.unavailable, { requireDocSync: projectConfig.docSync })
      : [];
    // A WORKER IS NOT AN EXPLORE SESSION (2026-09-21). The worker pane carries
    // `RG_GATE_MODE=explore` so it does not classify itself into the loop, but
    // the explore prompt is written for an agent that owns a task — it says
    // 「任务满意完成即可自行 declare_done」 and 「若任务变成交付性工作，先
    // set_gate_mode("loop")」, while a worker's own system prompt says 「用
    // worker_report 交一次，然后停下」. Two contradicting closing instructions in
    // one prompt is how a worker ends a turn without reporting (reviewer P2).
    if (state.taskMode === "explore" && !readWorkerSideEnv(process.env)) {
      return {
        systemPrompt:
          systemPrompt +
          "\n\n" + MODE_REGISTRY.explore.prompt +
          (problems.length ? `\nAdvisory 门禁状态：\n${problems.map((p) => `- ${p}`).join("\n")}` : ""),
      };
    }
    // Loop goal (Step 0): loop mode works to an explicit exit contract
    // (`.pi/loop-goal.md` — see lib/loop-goal.ts for the full rationale).
    // Injected AFTER the explore early-return. The unarmed early-return is
    // gone (2026-08-30): the goal and the decision table must reach the first
    // turn, before any edit arms the gate. An UNCONFIRMED goal has its body
    // withheld (L8) and blocks ships at L1; the hooks stay out of it.
    // THE USER'S SWITCH RECORD, READABLE BY THE AGENT (2026-09-22, user ask).
    //
    // Every other surface that knows about a switched-off stage is either the
    // dispatch (silent), a tool reply (too late), or the user's own dialog
    // (not addressed to the agent) — so a released stage used to be a fact
    // the agent could only learn by doing work nobody owes. Measured the same
    // day: acceptance off, and the session still wrote a real-acceptance plan
    // and started building its scene. The rendering itself ("no record ⇒
    // nothing", the per-stage wording) lives in lib/loop-stages.ts, next to
    // the table the user's checklist renders.
    //
    // AN UNDECIDED SESSION GETS IT TOO (2026-09-22): `isEnforcedMode(undefined)`
    // is true, the edit gate and the completion path already treat an undecided
    // session as the loop, and `stagesOffered` lets it answer the checklist —
    // so a session that answered the box BEFORE calling `set_gate_mode` must not
    // lose the fact for however long it stays undecided. Orchestrator is
    // excluded (never offered the switches, so it has no record to render),
    // and explore/normal keep the gate out of their prompt entirely.
    if (state.taskMode === "loop" || state.taskMode === undefined) {
      const stagesBlock = buildStagesDirective(loopStagesRecord());
      if (stagesBlock) systemPrompt += "\n\n" + stagesBlock;
      // THE POINTER MUST NOT DANGLE (quality round P2, 2026-09-22): with the
      // goal stage OFF the block says “see the goal paragraph above”, and in an
      // UNDECIDED session that paragraph is not injected by the loop branch
      // below — the agent would still not know whether it owes a goal, which is
      // the very question this block exists to answer. Inject it for exactly
      // that case (one line, and never twice: the loop branch owns its own).
      if (state.taskMode === undefined && !stageIsOn("goal")) {
        systemPrompt += "\n\n" + buildGoalStageOffDirective();
      }
    }

    if (state.taskMode === "loop") {
      const goalConfirmed = goalStageSatisfied();
      systemPrompt += "\n\n" + loopGoalDirectiveText();
      // 2026-09-17: once the un-goaled turn count hits the threshold, the
      // standing goal directive is escalated to the force-negotiate form on
      // EVERY turn (not only in the RESUME injection) — the agent cannot miss
      // that the ONLY acceptable next action is goal negotiation. With the
      // goal stage OFF there is nothing to negotiate, so it never escalates.
      if (stageIsOn("goal") && !goalConfirmed && goalNegotiationOverdue(state.turnsWithoutGoal)) {
        systemPrompt += "\n\n" + buildGoalForceNegotiateDirective(state.turnsWithoutGoal);
      }

    }

    // The orchestration layer's two prompts, and they are deliberately
    // asymmetric (task book §5). The ORCHESTRATOR gets the whole contract;
    // a CHILD gets one sentence — telling it about the plan would make it
    // optimize for the plan instead of for its own task.
    if (state.taskMode === "orchestrator") {
      systemPrompt += "\n\n" + ORCHESTRATOR_DIRECTIVE;
      // F13 — an orchestrator RETURNS HERE, and that is the whole fix.
      //
      // Falling through used to append the loop block, which tells the
      // session to "negotiate a loop goal → judge_submit reviewer →
      // declare_done". For a project manager every clause of that is wrong:
      // its exit contract is the PLAN, not a goal, and constraint 2 forbids
      // it from writing the code a review would judge. Worse, the unmet-gate
      // list it was shown ("code review gate PENDING", "precommit has not
      // run") was read from the sidecar its CHILD had dirtied — two sessions,
      // one file (F4). Its own contract is the orchestration's, and
      // orchestratorDoneProblems is where that lives.
      systemPrompt += "\n\n" + buildOrchestratorExitBlock(orchestrationDoneProblems());
      return { systemPrompt };
    }
    if (isOrchestrationChild()) {
      systemPrompt += "\n\n" + CHILD_OF_ORCHESTRATOR_DIRECTIVE;
    }


    // LOOP-MODE EVERY-TURN INJECTION (2026-08-30): the situation→tool
    // decision table and the loop's standing flow must be visible from the
    // FIRST turn (before any edit arms the gate) and also when the gates are
    // all green — the two windows where the old gateArmed-only injection
    // never rendered them. `gateArmed` gates the unmet-problems list below,
    // not the directives block.
    const loopDirectives =
      state.taskMode === "loop"
        ? "\n\n" + MODE_REGISTRY.loop.prompt +
          // TOP-LEVEL ONLY (2026-09-21): the shared loop block reaches
          // orchestration children as well, and a child's
          // `set_gate_mode("orchestrator")` is refused mechanically — telling
          // it to ask the user to switch would send it to a dead end. The
          // rule is appended here, where the session that can act on it gets
          // it (lib/gate-modes.ts explains why the block itself omits it).
          (isOrchestrationChild() ? "" : "\n\n" + SCOPE_ESCALATION_PROTOCOL)
        : "";
    systemPrompt += loopDirectives;

    // MODE-UNDECIDED early return (2026-08-30): the Review Gate block below
    // is loop-specific — "READY 了就 declare_done", the judge_submit guidance
    // and the all-green 收尾 line all presume a chosen loop mode. A session
    // that has not called set_gate_mode yet and has NOTHING to report sees
    // only the mode-decision directive (already injected above), exactly as
    // before the unarmed early-return was deleted. An undecided session that
    // HAS edited still falls through: its `Current unmet:` list is real and
    // must stay visible even before a mode is chosen (reviewer P2, round 3).
    // Loop mode always falls through and renders the full block every turn.
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
        (sessionRepos.size > 1
          ? "Multi-repo session: this session has edited " + sessionRepos.size + " repositories (" +
            [...sessionRepos].join(", ") +
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
          : gateArmed && !sessionEdited
            ? "NOTE: the tracked changes PRE-DATE this session (this session has not edited anything yet). " +
              "If the unmet gates below are demanding coverage of work you never did, call request_scope_limit — " +
              "the USER decides whether session-only coverage suffices.\n"
            : "") +
        // Scope for the NEXT review round: what a reviewer already approved,
        // what is new since, and which of last round's findings must be
        // re-checked. Only rendered while a review is actually outstanding —
        // once the gate is satisfied there is nothing to scope.
        (problems.length && state.review.verdict !== "READY"
          ? `\n${formatReviewScopeDirective(reviewScopeFor(primaryRepoRoot, state), previousRoundFindings(state), settledConclusion(state))}\n`
          : "") +
        // The fast lane clears a commit but not a push/PR, and finding that
        // out at push time wastes a round. Say it while the lane still shows.
        (problems.length === 0 && state.precommit.verdict === "PASS" && state.precommit.testScope !== "full"
          ? `\nNOTE: the recorded precommit is the FAST lane (tests: ${state.precommit.testScope ?? "unknown"}). ` +
            "That satisfies `git commit`; `git push`, `gh pr create/edit` and declare_done additionally " +
            'require one run with mode "full".\n'
          : "") +
        (problems.length
          ? `Current unmet:\n${problems.map((p) => `- ${p}`).join("\n")}`
          : isEnforcedMode(state.taskMode)
            ? "All gates satisfied — 收尾：跑一次 `declare_done`（门禁合并分支）；若已建 PR，还有 `copilot_review` 周期待收。"
            : "All gates satisfied — you may ship.")
    };
  });

  // The 5s widget refresh (lib/status-strip.ts) — armed once the whole
  // factory has run; session_shutdown disarms it, session_start re-arms it.
  armUiRefreshTimer();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c !== "object" || c === null) return "";
      const o = c as Record<string, unknown>;
      return String(o.text ?? o.content ?? "");
    }).join("\n");
  }
  return "";
}
