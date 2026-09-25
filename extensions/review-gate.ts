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
  existsSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync, appendFileSync,
  mkdirSync, realpathSync, openSync, closeSync, readSync, copyFileSync, readdirSync, writeSync,
  watch as fsWatch, type FSWatcher,
} from "node:fs";
import { tmpdir, homedir, hostname } from "node:os";
import { join as pathJoin, dirname as pathDirname, resolve as pathResolve, basename as pathBasename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  coalesceToolPath,
  DEFAULT_MAX_ROUNDS,
  isCodeFile,
  isDocFile,
  isSensitiveFile,
  COMMIT_MSG_FORBIDDEN,
  LANGUAGE_DIRECTIVE,
  PLATEAU_ROUNDS,
  OSCILLATION_LIMIT,
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
import { hostEditorFallback, hostReasonEditor, editorTextOf, REASON_EDITOR_BACK, type CustomDialogHost } from "../lib/reason-editor.ts";
import { detectShipCommands, observedShipKinds } from "../lib/ship-detect.ts";


import { buildContractReadout, buildGateWidget, planContractRows, showsRoundReading, type ContractFacts, type GateWidgetFacts } from "../lib/ui-widget.ts";
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
  admitAppeal,
  recordAppealDecision,
  buildTextAppealPrompt,
  TEXT_APPEAL_SYSTEM_PROMPT,
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
  admitInspectionAppeal,
  buildInspectionAppealPrompt,
  inspectionDecisionKey,
  inspectionDeniedText,
  inspectionGrantedText,
  issueInspectionPass,
  INSPECTION_APPEAL_SYSTEM_PROMPT,
  type InspectionBlock,
  type InspectionPass,
} from "../lib/inspection-appeal.ts";
import {
  judgeSessionIdFor,
  shortRepoHash,
  judgeScratchDir,
  reviewScratchWorktrees,
} from "../lib/judge-process.ts";
import {
  judgeWorkDirFor,
  judgeWorkDirBasename,
  legacyJudgeWorkDirBasename,
  selectStaleJudgeSessionDirs,
  isBlockingSeverity,
  JUDGE_SESSIONS_RELDIR,
} from "../lib/judge-lifecycle.ts";
import {
  createProgressReporter,
  type ProgressReporter,
  withSlowNotice,
  statusNotice,
  type SlowNoticeSink,
  type ToolUpdate,
} from "../lib/progress-stream.ts";
import { rebaseBranchName } from "../lib/git-rewrite.ts";
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
  appendRecord,
  channelPathFor,
  instructText,
  isStalled,
  HEARTBEAT_STALE_MS,
  judgeChannelTarget,
  newChannelId,
  nodeChannelIO,
  projectChannel,
  readChannel,
  reportConclusion,
  reportText,
  sanitizeContextPercent,
  type ChannelIO,
  type ChannelRecord,
  type ChannelReportRecord,
  type ReportConclusion,
  type ChildReportedState,
} from "../lib/orchestrator-channel.ts";
import {
  acknowledgeInstruct,
  askThroughChannel,
  bindingPath,
  decideReportedChildState,
  describeToolActivity,
  pendingInstructions,
  reportState,
  type ChannelDialogOutcome,
  type ChannelDialogRequest,
  type ChildChannelBinding,
} from "../lib/orchestrator-child-channel.ts";
import { supervisionTarget } from "../lib/orchestration-id.ts";
import { emptyHierarchy, findJudgeLane, judgeChildRecordOf, judgeLive, listByOpener, paneCoordsOf, paneIdUsable, parseHierarchySnapshot, registerJudge, removeJudge, tmuxServerFrom, windowClosable, type HierarchyTable, type JudgeEntry } from "../lib/hierarchy.ts";
import {
  decideJudgeRotation,
  judgeObjectId,
  judgeRemembersPreviousRound,
  laneOfEntry,
  rotationHandoffTask,
  type JudgeRotationDecision,
} from "../lib/judge-rotation.ts";
import {
  JUDGE_ID_ENV,
  JUDGE_OPENER_ENV,
  JUDGE_ROLE_ENV,
  judgePaneAlive,
  listJudgePanes,
  type JudgePaneRunner,
} from "../lib/judge-pane.ts";
import {
  buildJudgePaneCommand,
  buildJudgeRecoverCommand,
  closeSessionPane,
  closeSessionWindow,
  judgePaneDecor,
  openSessionWindow,
} from "../lib/session-factory.ts";
// MY OWN TMUX SESSION (2026-09-25): the name, the lazy creation, the ownership
// record and the one session `declare_done` closes.
import {
  closeOwnSession,
  ownSessionName,
  sanitizeScopeRecord,
  type TmuxScope,
} from "../lib/session-tmux-scope.ts";
// The ONE pane-identity renderer (2026-09-18): what a pane border calls THIS
// session when it opens a judge.
import { selfPaneOwner } from "../lib/orchestrator-pane-decor.ts";
import {
  readJudgeSideEnv,
  JUDGE_TASK_ENV,
  JUDGE_STREAM_ENV,
} from "../lib/judge-side.ts";
import {
  PRESENCE_FILENAME,
  PRESENCE_HEARTBEAT_MS,
  checkSessionExclusivity,
  claimsMainSidecar,
  gateStateWriteSkip,
  parsePresence,
  presenceFor,
  presenceIsOurs,
  type PresenceRecord,
} from "../lib/session-exclusivity.ts";
import { buildStandardReport, STANDARD_REPORT_EXCERPT_CHARS } from "../lib/judge-report.ts";
import { nextRoundSeq, registerJudgeConcludeTool } from "../lib/judge-conclude.ts";
import { runTmux as rawTmux } from "../lib/orchestrator-wiring.ts";
import { sideEffectsEnabled } from "../lib/side-effects.ts";
import {
  describeNotifyOutcome,
  mayNotifyUser,
  type UserNotifyKind,
  type UserNotifyOutcome,
} from "../lib/user-notify.ts";
import { createUserNotifyRuntime } from "../lib/user-notify-runtime.ts";
import { isOwnedChildPane } from "../lib/orchestrator-delivery.ts";
import {
  foldBackgroundWaits,
  hasBackgroundWaits,
  NO_BACKGROUND_WAITS,
  type BackgroundWaits,
} from "../lib/background-wait.ts";
// The delivery probe a judge spawn shares with an orchestration spawn: same
// polling, same evidence, same verdict — only the channel path differs.
import { alivePanes, channelRecordCount, verifyJudgeBoot } from "../lib/orchestrator-tool-kit.ts";
// STOP-FIRST, THEN SPEAK (2026-09-21): the two-step an `interrupt` has to be,
// and the reason it is a module rather than four lines here — the ordering is
// the whole fix (lib/interrupt-delivery.ts carries the measured deadlock).
import { deliverInterrupt } from "../lib/interrupt-delivery.ts";
// WORKER PANES (2026-09-21): the tmux-pane replacement for the pi-subagents
// `Agent` tool. Four tools on the agent surface, one on the worker surface,
// and the pane factory they both go through.
import { registerWorkerTools } from "../lib/worker-tools.ts";
import {
  JUDGE_PANE_RECLAIM,
  reclaimAuditLine,
  type JudgePaneReclaimOutcome,
} from "../lib/judge-pane-policy.ts";
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
  buildOrchestratorResume,
} from "../lib/orchestrator-directives.ts";
import { createOrchestratorDeps, readPlanFile } from "../lib/orchestrator-wiring.ts";
import { formatPlanSummary, type OrchestratorPlan } from "../lib/orchestrator-plan.ts";
import {
  contextPercentFromUsage,
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

import {
  buildPlanAuditTask,
  formatPlanAuditCarryover,
  formatPlanAuditRefusal,
  planAuditHash,
} from "../lib/orchestrator-plan-audit.ts";
import { composeWithUntrustedData } from "../lib/untrusted-data.ts";
import {
  roundBindingFor,
  roundHasReported,
  runAuditRound,
  settleAuditRound,
  type RoundBinding,
  type RunAuditRoundDeps,
  type SettleAuditRoundDeps,
} from "../lib/audit-round.ts";
import {
  GOAL_AUDIT_SPEC,
  PLAN_AUDIT_SPEC,
  type PendingAudit,
} from "../lib/audit-round-specs.ts";

import {
  decideSupervisionEvents,
  reportedDoneIds,
  superviseChildren,
  type SupervisionMemory,
  type SupervisionSnapshot,
} from "../lib/orchestrator-supervisor.ts";
import { formatChildHealth } from "../lib/orchestrator-child-state.ts";

import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";
import {
  registerOrchestratorSessionTools,
  type OrchestratorSessionDeps,
} from "../lib/orchestrator-session-tools.ts";


// The waiting skeleton's second interrupt source: a real user message ends a
// long block (orchestrator_wait / judge_wait) instead of being queued behind it.
import { notifyUserInput } from "../lib/poll-wait.ts";

import { formatInheritanceBrief, handoffGeneration, isHandoffSuccessorOf, PREDECESSOR_SESSION_ENV, readInheritance, stateOwnership, successorEnv, successorSessionId } from "../lib/session-inheritance.ts";
import {
  branchOfListedWorktree,
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
import { buildCheckpointMessage } from "../lib/checkpoint-message.ts";
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
  probeJudgeRound,
  doWait,
  doClose,
  type JudgeSessionToolDeps,
} from "../lib/judge-session-tools.ts";

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
  stagesOff,
  stagesOffered,
  stagesSummary,
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
import { recordedFindingsFrom } from "../lib/polish-gate.ts";
import {
  decideQualityHold,
  isSkippedQualityRecord,
  QUALITY_ROLE,
  qualityPrecondition,
  qualityRoundSkip,
  qualityStandingFor,
  roundCancelParty,
  roundCancelPlan,
  skippedQualityRecord,
  type RoundCancelPlan,
  type RoundLanding,
} from "../lib/quality-round.ts";
import {
  ACCEPTANCE_GATE_ENV,
  acceptanceDecision,
  acceptanceGateOpen,
  acceptanceProblems,
  acceptanceRoundInFlight,
  acceptanceStatusLine,
  buildAcceptanceTask,
  extractAcceptancePlan,
  parseNoAcceptanceDeclaration,
  type AcceptanceDecision,
  type AcceptanceStatus,
} from "../lib/acceptance-round.ts";
import {
  modelChainFor,
  writeJudgeSpawnFiles,
  JUDGE_ROLES,
  SUBMITTABLE_JUDGE_ROLES,
} from "../lib/judge-prompt.ts";
import {
  failedStepNames,
  receiptTotalMs,
  stepTimings,
  validatePrecommitReceipt,
  type StepTiming,
  type TestScope,
} from "../lib/precommit-receipt.ts";
import { appendTiming } from "../lib/gate-timings.ts";
import { tailLogFile } from "../lib/precommit-tail.ts";
// The background lane's failure notice: wording + the "is this still the
// content under the agent's hands" rule, both pure and unit-tested there.
import { buildAsyncPrecommitReport, buildAsyncPrecommitPass, buildParkedReadyReplayNotice, type AsyncPrecommitPass, type AsyncPrecommitReport } from "../lib/async-precommit-report.ts";
import {
  decideReviewScope,
  type ReviewScopeDecision,
} from "../lib/review-scope.ts";
// The incremental contract's WORDING lives in exactly one module.
import {
  formatReviewScopeDirective,
  type SettledConclusion,
} from "../lib/review-carryover.ts";
import {
  advisoryChangeToken,
  changedFiles,
  computeFingerprint,
  incrementSinceTree,
  isGateOwnedPath,
  reviewCoverageFiles,
  worktreeTreeOid,
} from "../lib/fingerprint.ts";
import type { Fingerprint } from "../lib/fingerprint.ts";
import {
  emptyState,
  isPlateaued,
  isOscillating,
  countOscillations,
  loadSidecar,
  migrateFingerprintVersion,
  FINGERPRINT_MIGRATION_NOTICE,
  saveSidecarPreservingConcurrent,
  shouldStrategicReset,
  sidecarPath as sidecarPathIn,
  stateVariantFrom,
  STATE_VARIANT_ENV,

  unmetRequirements,
  sanitizeRoundScope,
  type GateState,
  type RoundScopeRecord,
  type ScopeStampRecord,
  invalidateBindings,
  inheritGoalContract,
  mergeProxyDecisions,
  nextFullPassTree,
} from "../lib/gate-state.ts";
import { parsePrecommitOutput } from "../lib/precommit-parse.ts";
import {
  adjudicateReviewConclusion,
  classifyReadyWithholding,
  fileFindingsFrom,
  normalizeConcludedVerdict,
  parkedLaneHalf,
  parkedReadyFate,
  readyLacksVerification,
  type ReviewFinding,
  type ScopeExemption,
} from "../lib/review-adjudicate.ts";
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
  classifyNonEnglish,
  createVerdictMemo,
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
import { projectEditedContent } from "../lib/edit-projection.ts";
import {
  evaluateReadonlyStall,
  readonlyStallNudgeFor,
  type ReadonlyStallState,
} from "../lib/readonly-stall.ts";
import {
  LOOP_GOAL_RELPATH,
  loopGoalRelPath,

  buildLoopGoalDirective,
  buildGoalStageOffDirective,
  goalTextHash,
  isLoopGoalConfirmed,
  readLoopGoal,
  // buildGoalAuditTask moved with prepare_goal_audit (lib/advisory-prepare-tools.ts);
  // the goal family's own text builders (transcript/confirm/refusal messages,
  // the length cap, the carryover) moved with it into lib/goal-tools.ts +
  // lib/goal-prereview-tools.ts.
  LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK,
  loopGoalUnconfirmedEditBlock,
  loopGoalEditGate,
  goalPrereviewPassed,
  goalReminderDue,
  GOAL_FORCE_NEGOTIATE_TURN_THRESHOLD,
  buildGoalForceNegotiateDirective,
  goalNegotiationOverdue,
  parseGoalCriteria,
} from "../lib/loop-goal.ts";
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


import { rendererModeNoticeDue, RENDERER_MODE_NOTICE, type RendererMode } from "../lib/renderer-mode.ts";
import {
  choiceRows,
  createDialogQueue,
  dialogNotifyDetail,
  dialogSignal,
  parseChoice,
  renderChoice,
  type ChoiceSpec,
  type ChoiceUi,
} from "../lib/choice-dialog.ts";
import {
  MULTI_UNAVAILABLE,
  buildMultiChoiceBox,
  defaultMultiChoiceKey,
  renderMultiChoice,
  type MultiChoiceHost,
  type MultiChoiceKeyReader,
  type MultiChoiceTheme,
  type MultiSelectOutcome,
} from "../lib/multi-choice-dialog.ts";
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
  decideRevival,
  buildRevivalMessage,
  REVIVAL_INTERVAL_MS,
} from "../lib/session-revival.ts";
import {
  effectiveAgentsConfig,
  applyAgentConfigLayer,
  loadRegistry,
  validateSpec,
  KNOWN_AGENTS,
  KNOWN_THINKING_LEVELS,
  projectAgentIdentity,
  frontmatterBlock,
  parseModelSpec,
  resolvePackageAgentsDir,
  ensureAgentFilesPresent,
  startupAgentsCheck,
} from "../lib/model-config.ts";
import type { ModelRegistry, RegistryModelInfo } from "../lib/model-config.ts";
import {
  clearModelFailure,
  describeCoolingSlot,
  modelKeyOf,
  pruneModelHealth,
  recordModelFailure,
  selectHealthySlot,
  type ModelEvent,
  type ModelHealth,
  type SlotChoice,
} from "../lib/model-health.ts";
import { createModelRotation } from "../lib/judge-model-rotation.ts";
import { buildStreamConsumerDirective, buildStreamDirective } from "../lib/review-stream.ts";
// The model allowlist is consulted by the diagnosis module, not here.
// The baseline resolution moved with prepare_review (lib/review-prepare-tools.ts).
// The Copilot TOOLS and the `gh` access they run on moved out of this file
// (lib/copilot-review-tools.ts + lib/copilot-gh.ts); what is left here is the
// arming site and the completion-only problem list.
import {
  armCopilotReview,
  copilotProblems,
  parsePrView,
} from "../lib/copilot-review.ts";
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
  runArbiterProcess,
  PROXY_ISOLATION_FLAGS,
  sha256,
  BYPASS_TOKEN_TTL_MS,
  type ArbitrableAction,
  type BypassToken,
  type TokenBindings,
} from "../lib/arbitration.ts";
// THE PROXY HALF OF EVERY DIALOG (2026-09-19): the timing, the race and the
// prompt live in lib/user-proxy.ts, because `askChoice` below is the ONE place
// all twelve dialogs are rendered and it must stay wiring only.
import {
  PROXY_ARBITER_TIMEOUT_MS,
  PROXY_SYSTEM_PROMPT,
  buildProxyPrompt,
  formatProxyDecisionReport,
  parseProxyDecision,
  raceWithUserProxy,
  sessionProxyDecisions,
  type ProxyChoice,
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
function sidecarPath(root: string): string {
  return sidecarPathIn(root, ".pi", SESSION_STATE_VARIANT);
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

/** Detect commits ahead of the upstream tracking branch or main/master. P0: also
    checks @{upstream} so local commits ahead of remote on any branch are caught.

    SYNC ON PURPOSE (review round 1 P1, drill F1 follow-up): the secondary-repo
    arming site (`stateForRepo`) is a synchronous state factory, and a branch
    ahead of its base arms the gate THERE as well — a repo whose only work is
    already committed must not read as "nothing to review" to the ship gate,
    which is exactly the fail-open F1 closed for the primary repo. */
function commitsAheadOfBaseSync(cwd: string): number {
  try {
    // Priority 1: upstream tracking branch (catches local ahead of remote on any branch)
    try {
      const out = execFileSync("git", ["rev-list", "--count", "@{upstream}..HEAD"], {
        cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const n = parseInt(out, 10);
      if (!isNaN(n) && n > 0) return n;
    } catch { /* no upstream configured */ }
    // Priority 2: main/master (catches when upstream tracking isn't set)
    for (const base of ["main", "master"]) {
      try {
        const out = execFileSync("git", ["rev-list", "--count", `${base}..HEAD`], {
          cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const n = parseInt(out, 10);
        // When on main, main..HEAD is 0 even if ahead of origin/main.
        // Check origin/main too.
        if (!isNaN(n) && n > 0) return n;
      } catch { /* base branch doesn't exist locally */ }
    }
    // Priority 3: origin/main, origin/master
    for (const base of ["origin/main", "origin/master"]) {
      try {
        const out = execFileSync("git", ["rev-list", "--count", `${base}..HEAD`], {
          cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const n = parseInt(out, 10);
        if (!isNaN(n) && n > 0) return n;
      } catch { /* remote not fetched */ }
    }
  } catch { /* git unavailable */ }
  return 0;
}

/** The async spelling the injectable dep seam declares. ONE implementation. */
async function commitsAheadOfBase(cwd: string): Promise<number> {
  return commitsAheadOfBaseSync(cwd);
}

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
  let lastUserInteractionAt: string | undefined;
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
      const existing = loadSidecar(sidecarPath(root));
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
        const armed = armingFromFacts({ files: files ?? [], commitsAhead: commitsAheadOfBaseSync(root) });
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

  /**
   * Worktree digest for the concurrent-sidecar merge, or null when it cannot
   * be computed (fail-closed: an unverifiable foreign binding is dropped).
   *
   * Only reached when another session's sidecar holds a verdict this session
   * lacks, so the hashing cost stays off the normal persist path.
   */
  function digestForMerge(dir: string): string | null {
    const fp = computeFingerprint(dir);
    return fp.unavailable || !fp.digest ? null : fp.digest;
  }

  /** Do two paths name the same directory? Compared through realpath: a Pi
   *  launched via a symlinked path has a logical cwd that never string-matches
   *  git's physical repo root. Unresolvable paths fall back to string
   *  equality (this only ever decides whether a message says "ran in …"). */
  function samePlace(a: string, b: string): boolean {
    if (a === b) return true;
    try { return realpathSync(a) === realpathSync(b); } catch { return false; }
  }
  /** Resolve a path through symlinks, or return it unchanged when it cannot be
   *  resolved (a path that does not exist is not an error here — the caller is
   *  comparing strings, not opening files).
   *
   *  Load-bearing for the snapshot pin on macOS: `snapshotBaseDir` falls back to
   *  the system temp dir, where `prepare_review` prints `/var/folders/…` while a
   *  reviewer's own `pwd` prints `/private/var/folders/…`. Comparing the raw
   *  strings would silently lose the reviewer's self-reported evidence and
   *  could withhold an honest READY. */
  function canonicalPath(p: string): string {
    try { return realpathSync(p); } catch { return p; }
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
      saveSidecarPreservingConcurrent(sidecarPath(root), s, () => digestForMerge(root));
      reconcileBlockedMarker(blockedMarkerPath(sidecarPath(root)), { sessionId: s.sessionId });
    } catch {
      recordBlockedMarker(blockedMarkerPath(sidecarPath(root)), { sessionId: s.sessionId });
    }
  }

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
    const onDisk = loadSidecar(sidecarPath(root));
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
  let lastGateEventAt = Date.now();

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
  // A session spawned by an orchestrator reports on ONE file that belongs to
  // it alone, and reads its instructions from the same file. The agent in
  // this session knows nothing about any of it: everything below is done by
  // the gate, on pi's own events, which is the whole reason it can be
  // trusted. (The ORCHESTRATOR side is lib/orchestrator-supervisor.ts.)
  //
  // A session with no orchestration address has no binding at all and every
  // function here is a silent no-op — a standalone session reports nowhere.

  const channelIO: ChannelIO = nodeChannelIO();

  /** This session's channel, or undefined when it is not somebody's child. */
  function childBinding(): ChildChannelBinding | undefined {
    const orchestrationId = supervisionTarget();
    const childId = process.env[STATE_VARIANT_ENV]?.trim();
    if (orchestrationId && childId) {
      // Only the pane the gate itself opened may call itself this child. A
      // background subagent inherits the env vars but runs under a random pi
      // session id, not the deterministic rg-child-<childId> — the check is
      // in lib/orchestrator-delivery.ts (isOwnedChildPane) and it is what
      // keeps the subagent's gate from binding its parent's channel and
      // overwriting the parent's reports with idle heartbeats (2026-09-09).
      if (!isOwnedChildPane(childId, state.sessionId)) {
        return undefined;
      }
      return {
        io: channelIO,
        target: { orchestrationId, childId },
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      };
    }
    // Judge panes talk through the SAME file shape under their opener id:
    // a judge pane is a child process with a gate, not a second channel.
    // (Heartbeat, dialog race and round-task drain all funnel through this
    // binding, so they work for judges with no further wiring.)
    //
    // A WORKER PANE JOINS THE SAME LIST (2026-09-21), and this one branch is
    // the whole of its channel story: `ask_user` inside the worker reaches the
    // opener through the dialog race, and `worker_submit`'s message to a live
    // worker is injected by the child-side drain — both without a line of
    // worker-specific transport.
    const workerSide = readWorkerSideEnv(process.env);
    if (workerSide) {
      return {
        io: channelIO,
        target: { orchestrationId: workerSide.openerId, childId: `worker-${workerSide.workerId}` },
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      };
    }
    const judgeSide = readJudgeSideEnv(process.env);
    if (!judgeSide) return undefined;
    return {
      io: channelIO,
      target: judgeChannelTarget(judgeSide.openerId, judgeSide.judgeId),
      ...(state.sessionId ? { sessionId: state.sessionId } : {}),
    };
  }

  /**
   * Percent of this session's context window in use, when the host says.
   *
   * The ARITHMETIC lives in lib/orchestrator-handoff-advice.ts, and it moved
   * there because the version written here was wrong in a way nothing could
   * catch: it read `usage.used / usage.max`, while pi returns
   * `{ tokens, contextWindow, percent }`. The fallback for "percent is null
   * right after a compaction" therefore could never fire, and its absence is
   * indistinguishable from its presence — both render the same honest "no
   * reading" line. A pure function has a test per shape instead.
   */
  function contextPercentOf(ctx: { getContextUsage?: () => unknown } | undefined): number | undefined {
    try {
      return contextPercentFromUsage(ctx?.getContextUsage?.());
    } catch {
      return undefined;
    }
  }


  /**
   * Is a JUDGE this session dispatched still running, and since when?
   *
   * This is the fact that turns silence into a statement. The gate is the one
   * that opened the judge, so it does not have to infer anything: the pane
   * is in its own registry, and a listed pane id is liveness (probed from
   * its window when it matters).
   *
   * `ownLiveJudges()` and not `ownJudges()`: the registry is now the PERSISTED
   * table, so it also offers back this opener's judges from a previous
   * process, whose panes died with it. Reporting one of those as "a judge is
   * running" would leave the session waiting forever on a pane nobody can
   * answer from — the Map this replaced could not say that because a restart
   * emptied it.
   */
  function activeJudgeWait(): { role: string; since: number } | undefined {
    for (const judge of ownLiveJudges()) {
      // A pane id on record is intent, not liveness: a dead pane stays
      // listed until it is recovered or closed. The channel decides — a
      // report newer than the spawn means this round is over.
      if (judgeRoundReported(judge)) continue;
      const since = Date.parse(judge.spawnedAt);
      return { role: judge.role, since: Number.isFinite(since) ? since : Date.now() };
    }
    // A `copilot_review` call blocking on GitHub is the same kind of fact: a
    // wait the gate itself owns, not a stop.
    if (copilotWaitSince !== undefined) return { role: "copilot", since: copilotWaitSince };
    return undefined;
  }


  /**
   * Has this judge answered the round it is CURRENTLY on?
   *
   * It used to be "a report newer than the pane's spawn", which is the second
   * timestamp comparison the round binding exists to delete — and it was wrong
   * in the ordinary case: the pane outlives the round, so round 1's leftover
   * report is newer than the spawn and made a judge that had just been handed
   * round 2 read as finished (reviewer P2, 2026-09-05). The question is the
   * engine's, so the answer is too.
   */
  function judgeRoundReported(judge: JudgeEntry): boolean {
    try {
      const target = judgeChannelTarget(judge.openerId, judge.judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      return roundHasReported(
        read.records,
        roundBindingOf({ judgeId: judge.judgeId, role: judge.role, repoRoot: judge.repoRoot }),
        judge.lastReportId,
      );
    } catch {
      return false;
    }
  }

  /** Newest channel activity for one judge, or undefined when unreadable. */
  function channelLastActivity(judge: JudgeEntry): string | undefined {
    try {
      const target = judgeChannelTarget(judge.openerId, judge.judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      return projectChannel(read.records).lastActivityAt;
    } catch {
      return undefined;
    }
  }


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

  /**
   * Tell the orchestration what this session is doing.
   *
   * Called from `agent_settled`, `turn_end` AND the independent heartbeat
   * timer — pi's own truth, never a heuristic about a terminal.
   * `ctx.isIdle()` separates "still streaming" from "stopped", and the gate's
   * own completion record separates "stopped" from "finished": a child that
   * ran `declare_done` is `done`, and one that merely went quiet is `idle`.
   * That distinction is the entire fix for R3-5, where a finished child was
   * classified `working` and produced no event for 725 seconds.
   *
   * ── WAITING-JUDGE (round-4 P0) ──
   *
   * A judge round of its own outranks both `working` and `idle`, and it has
   * to, because BOTH readings were wrong while one was running: streaming
   * inside `judge_wait` reported `working` while the heartbeat died with it
   * (⇒ `stalled` ⇒ an `interrupt` suggestion aimed at a live review round),
   * and a child that dispatched a judge and settled reported `idle` — "it
   * stopped" — about a session doing exactly what it should. The gate knows
   * which judge and since when, so it says so.
   *
   * THROTTLED, because the heartbeat calls it every tick: a record is written
   * when the state CHANGES or when the last one is old enough to be worth
   * refreshing. Without that the channel would grow a line every few seconds
   * for no new information — and `lastStateSince` (how long a state has held)
   * is computed from an unbroken run of identical states, so re-reporting is
   * cheap but not free.
   */
  function reportChildState(
    ctx: ExtensionContext,
    note?: string,
    opts: { force?: boolean; state?: ChildReportedState } = {},
  ): void {
    const binding = childBinding();
    if (!binding) return;
    const streaming = ctx.isIdle?.() === false || ctx.hasPendingMessages?.() === true;
    const percent = contextPercentOf(ctx as unknown as { getContextUsage?: () => unknown });
    const judging = activeJudgeWait();
    // Waiting on a background agent the child itself spawned is work, not a
    // stop (lib/background-wait.ts): without it, a child whose turn ended
    // while its subagent ran reported `idle` and the orchestrator read
    // "停下了（没有 declare_done）" for a wait it started itself.
    const waitingOnBackground = hasBackgroundWaits(backgroundWaits);
    const reported = decideReportedChildState({
      forced: opts.state,
      judging: judging !== undefined,
      streaming,
      waitingOnBackground,
      completedAt: state.completion?.at,
    });
    const now = Date.now();
    const changed = reported !== lastReportedChildState || lastToolActivity !== lastReportedActivity;
    if (!opts.force && !changed && now - lastChildReportAt < CHILD_STATE_REFRESH_MS) return;
    lastReportedChildState = reported;
    lastReportedActivity = lastToolActivity;
    lastChildReportAt = now;
    const settledSince = lastSettledAt !== undefined && toolCallsSinceSettle === 0 ? lastSettledAt : undefined;
    reportState(
      binding,
      reported,
      {
        ...(percent === undefined ? {} : { contextPercent: Math.round(percent) }),
        ...(judging ? { waitingFor: judging.role } : {}),
        ...(note === undefined ? {} : { note }),
        // E — the progress stamp rides on EVERY report (heartbeat included), so
        // a `working` child re-reported on a timer keeps its last real-progress
        // time. It only advances on a genuine agent event (see noteChildProgress).
        ...(lastChildProgressAt === undefined ? {} : { lastProgressAt: new Date(lastChildProgressAt).toISOString() }),
        // …and the STRUCTURAL half: present only while the child's last turn
        // has ENDED and nothing has run since (user decision, 2026-09-10).
        // A supervisor may act on `idle` the moment it sees this, without
        // waiting out the confirmation window.
        ...(settledSince === undefined ? {} : { settledSince }),
        // WHAT it is doing, for a manager that has only the state word to go on
        // (2026-09-17, user decision): `working · 自上次推进 3200s` cannot tell
        // "reading a large tree" from "spinning on the same search".
        ...(lastToolActivity === undefined ? {} : { activity: lastToolActivity }),
      },
    );
  }

  /** How often the heartbeat ticks (drain + a state refresh when it is due). */
  const CHILD_HEARTBEAT_MS = 10_000;
  /** How stale an unchanged state report may get before it is rewritten. */
  const CHILD_STATE_REFRESH_MS = 60_000;
  let childHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * The fast path for incoming instructions: a watch on this child's OWN
   * channel file (see {@link watchOwnChannel}).
   */
  let childChannelWatcher: FSWatcher | undefined;
  /** True while a drain is mid-flight — the re-entrancy guard. */
  let drainingInstructions = false;
  /**
   * The child-side interrupt source: an instruct (interrupt/steer) fires it
   * to dismiss an OPEN dialog as INTERRUPTED before the message is injected.
   * Wired into askThroughChannel's `interruptSignal`, so the box comes down
   * and the waiting request settles by:"interrupted" — never read as a user
   * rejection, never as consent.
   */
  let gateInterruptController: AbortController = new AbortController();
  /**
   * The signal a dialog currently open listens to for an instruct interrupt.
   * Every dialog gets the CURRENT controller's signal; drain aborts that
   * controller and installs a fresh one, so one interrupt dismisses the dialog
   * open AT THAT MOMENT and never a later one.
   */
  function currentInterruptSignal(): AbortSignal {
    return gateInterruptController.signal;
  }
  let lastChildReportAt = 0;
  let lastReportedChildState: ChildReportedState | undefined;
  /**
   * The activity line last written to the channel.
   *
   * Tracked so a NEW tool call republishes the state at once instead of
   * waiting out `CHILD_STATE_REFRESH_MS` — a receipt that says "working · 最近
   * read(x)" while the child has been running `make test` for a minute is
   * exactly the staleness this field exists to remove.
   */
  let lastReportedActivity: string | undefined;
  /**
   * Epoch ms of the child's last FORWARD PROGRESS (E). Advanced ONLY by a real
   * agent event — a tool result or a turn boundary — never by the heartbeat, so
   * a `working` child that keeps turning the crank shows a small "no progress"
   * reading while one wedged in place shows a growing one. Undefined until the
   * first event, so a booting session is not reported as stuck.
   */
  let lastChildProgressAt: number | undefined;
  /** Stamp forward progress. Called from the agent-event handlers, not the heartbeat. */
  function noteChildProgress(kind: "tool" | "settled" = "tool"): void {
    if (!childBinding()) return;
    lastChildProgressAt = Date.now();
    if (kind === "settled") {
      lastSettledAt = new Date(lastChildProgressAt).toISOString();
      toolCallsSinceSettle = 0;
      return;
    }
    // A tool result (or a turn boundary that may still be followed by more
    // work) means the child is AT WORK: whatever settle we were holding is no
    // longer its current state, and the stamp is dropped.
    toolCallsSinceSettle += 1;
    lastSettledAt = undefined;
  }

  /**
   * THE CHILD'S OWN "I STOPPED" EVIDENCE (2026-09-10, user decision).
   *
   * `agent_settled` is the one event that says a turn is OVER rather than
   * paused — pi will not continue on its own — and anything that runs after it
   * (a tool result, the next turn's boundary) is work RESUMED, which clears
   * the stamp. The pair is what the supervisor reads as `settledSince`, and it
   * is why `idle` no longer has to be confirmed by a 120s silence window:
   * "settled with nothing run since" cannot be true in the middle of a
   * bash → read → bash investigation, which is exactly the measurement that
   * window was introduced for (2026-09-04).
   */
  let lastSettledAt: string | undefined;
  let toolCallsSinceSettle = 0;
  /**
   * Background agents this session spawned that have not reported a terminal
   * state yet (lib/background-wait.ts owns the start/end contract). While
   * non-empty the child reports `working` even when its own turn has ended —
   * waiting on its own subagent is work, not a stop.
   */
  let backgroundWaits: BackgroundWaits = NO_BACKGROUND_WAITS;
  /**
   * The most recent tool call this session made, rendered for the receipt.
   *
   * WHY IT RIDES ON `tool_call` AND NOT `tool_result`: the question the
   * manager is asking is "what is it doing RIGHT NOW", and the call is placed
   * before the work starts — the result can be minutes later, and a child
   * whose tool has been running for ten minutes should read as "running
   * `bash(make test)`", not as the last thing that already finished.
   * (lib/orchestrator-child-channel.ts `describeToolActivity` renders it.)
   */
  let lastToolActivity: string | undefined;
  /** Feed one tool result into the background-wait fold (see the module). */
  function observeBackgroundToolResult(event: {
    toolName: string;
    isError: boolean;
    content: readonly { type?: string; text?: string }[];
    input?: Record<string, unknown>;
  }): void {
    const text = event.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    // pi-subagents' `run_in_background` defaults to true; only an explicit
    // false is a foreground call, whose result can never start a wait.
    const raw = event.input?.run_in_background;
    const runInBackground = raw === true ? true : raw === false ? false : undefined;
    backgroundWaits = foldBackgroundWaits(backgroundWaits, {
      kind: "tool_result",
      tool: { toolName: event.toolName, isError: event.isError === true, text, runInBackground },
    });
  }
  /**
   * Instructions this session has already acknowledged as RECEIVED.
   *
   * In memory rather than derived from the channel because the receipt is
   * written once per instruction: the projection deliberately keeps an
   * instruction pending until it is INJECTED, so re-reading it would make the
   * heartbeat append a duplicate `received` on every tick.
   */
  const acknowledgedReceipts = new Set<string>();


  /**
   * THE HEARTBEAT — an independent timer, and the whole point is what it does
   * NOT depend on.
   *
   * Reporting used to ride on `agent_settled` and `turn_end`, which are AGENT
   * events: they do not fire during a `judge_wait`, a full precommit, or any
   * long tool call, because all of those happen inside one turn. So the
   * channel went silent for minutes at a time while the process was perfectly
   * healthy, the supervisor's 180-second budget expired, and a working child
   * was reported as lost — twice in one run, ~14 minutes, with `interrupt`
   * offered as the remedy (round-4 P0, the one defect where following the
   * gate's own advice made things worse).
   *
   * A timer owned by the extension cannot have that failure mode: it ticks
   * while the agent is blocked, so `stalled` goes back to meaning what it
   * says — the extension itself is gone.
   *
   * It also drains instructions, which is what makes `followUp` deliverable
   * to a BUSY child: the orchestrator's message is acknowledged within one
   * tick instead of waiting for the agent to settle (round-4 P1 — a message
   * that was written, never acknowledged, and silently lost).
   */
  function startChildHeartbeat(ctx: ExtensionContext): void {
    if (childHeartbeatTimer || !childBinding()) return;
    childHeartbeatTimer = setInterval(() => {
      const live = latestCtx ?? ctx;
      try {
        reportChildState(live);
      } catch { /* a heartbeat must never break the session it reports on */ }
      void drainChildInstructions(live).catch(() => { /* best effort */ });
      // Self-heal: the channel file may not have existed when this session
      // started, and a watcher that could not be installed then can be now.
      watchOwnChannel(live);
    }, CHILD_HEARTBEAT_MS);
    watchOwnChannel(ctx);
  }

  /**
   * DRAIN ON WRITE, NOT ON THE NEXT TICK (2026-09-10).
   *
   * MEASURED (this repo's own channels): an `orchestrator_instruct` reached
   * its child in p50 4.79s / p90 9.11s, because the ONLY thing that read a
   * child's channel was the 10s heartbeat — a message written just after a
   * tick waited almost a whole interval. That latency sits on the one path
   * the orchestrator uses to talk to its children, and it is pure waiting:
   * the orchestrator has already written the file by the time this fires.
   *
   * THE TICK STAYS, and not out of tradition: a watcher may fail to install
   * (no channel file yet), may miss (a file REPLACED rather than appended to
   * leaves the watch on a dead inode), and is not available everywhere. The
   * 10s tick is what makes every one of those harmless, and the re-entrancy
   * guard in `drainChildInstructions` what makes a watcher firing beside it
   * safe. The watcher is the fast path, never the only path.
   */
  function watchOwnChannel(ctx: ExtensionContext): void {
    if (childChannelWatcher) return;
    const binding = childBinding();
    if (!binding) return;
    let path: string;
    try { path = bindingPath(binding); } catch { return; }
    try {
      const watcher = fsWatch(path, () => {
        void drainChildInstructions(latestCtx ?? ctx).catch(() => { /* best effort */ });
      });
      // A watcher must never be the reason the process stays alive, and a
      // watcher that errors is dropped so the next tick reinstalls it.
      watcher.unref?.();
      watcher.on("error", () => { stopChildChannelWatcher(); });
      childChannelWatcher = watcher;
    } catch { /* no file yet, or no watch support ⇒ the tick still covers it */ }
  }

  function stopChildChannelWatcher(): void {
    if (childChannelWatcher) {
      try { childChannelWatcher.close(); } catch { /* already gone */ }
    }
    childChannelWatcher = undefined;
  }

  function stopChildHeartbeat(): void {
    if (childHeartbeatTimer) clearInterval(childHeartbeatTimer);
    childHeartbeatTimer = undefined;
    stopChildChannelWatcher();
  }

  // ---------- ONE gate session per worktree (lib/session-exclusivity.ts) ----------

  /** This worktree's presence file — beside the sidecar it protects. */
  function presencePath(root: string): string {
    return pathJoin(root, ".pi", PRESENCE_FILENAME);
  }

  /** The record on disk, or undefined when absent/unreadable/corrupt. */
  function readPresence(root: string): PresenceRecord | undefined {
    try { return parsePresence(readFileSync(presencePath(root), "utf8")); }
    catch { return undefined; }
  }

  let presenceTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Hold this worktree: write the heartbeat now, then keep it fresh.
   *
   * Only a session that PASSED the check calls this. A refused one must never
   * write the file — that would take the claim away from the session that
   * actually holds it.
   */
  function holdWorktree(): void {
    const write = () => {
      const sessionId = state.sessionId;
      if (!sessionId) return;
      try {
        mkdirSync(pathJoin(cwd, ".pi"), { recursive: true });
        writeFileSync(
          presencePath(cwd),
          JSON.stringify(presenceFor(sessionId, process.pid, hostname(), Date.now())),
          "utf8",
        );
      } catch { /* best effort: a missed heartbeat lapses, it never blocks work */ }
    };
    write();
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = setInterval(write, PRESENCE_HEARTBEAT_MS);
    // The heartbeat must not hold the process open on its own.
    presenceTimer.unref?.();
  }

  /** Stop holding, and drop the claim if it is OURS (never somebody else's). */
  function releaseWorktree(): void {
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = undefined;
    if (!presenceIsOurs(readPresence(cwd), state.sessionId)) return;
    try { rmSync(presencePath(cwd), { force: true }); } catch { /* the window lapses anyway */ }
  }

  /**
   * Decide whether this session may work in this worktree, and act on it.
   *
   * Refused ⇒ the refusal is put on the state, where `unmetRequirements`
   * (the authority every ship path shares) turns it into a block, and where
   * the edit gate reads it. Allowed ⇒ this session takes the claim.
   */
  function applySessionExclusivity(ctx?: ExtensionContext): void {
    // The HEIR of the current holder takes over (2026-09-10): a successor
    // started by `orchestrator_handoff` runs in this same worktree ON PURPOSE
    // — that is how one orchestration keeps reaching its children — so
    // refusing it would kill the very handoff it exists to complete. It says
    // so by naming the session it replaces, which it carries in its own
    // environment.
    const successorOf = (process.env[PREDECESSOR_SESSION_ENV] ?? "").trim() || undefined;
    const verdict = checkSessionExclusivity({
      env: process.env,
      sessionId: state.sessionId,
      existing: readPresence(cwd),
      ...(successorOf ? { successorOf } : {}),
      repoRoot: cwd,
      now: Date.now(),
    });
    if (!verdict.ok) {
      // `normal` is the mode whose DEFINING behavior is that the gate is off:
      // both the edit guard and the bash ship gate return before any of this
      // could bite (lib/ship-gate-edit-guard.ts, lib/ship-gate-bash.ts). So no
      // refusal is raised here — it would be a message naming a rule the
      // session is not subject to.
      //
      // But it does NOT take the claim either: the record belongs to the
      // session that holds this worktree, and overwriting it with our own id
      // would both steal the holder's protection and make our own exit delete
      // it (`presenceIsOurs` would say yes) — reviewer P2, 2026-09-05.
      if (state.taskMode === "normal") {
        delete state.exclusivityRefusal;
        stopExclusivityRecheck();
        return;
      }
      // Announce it once PER HOLDER, then keep watching: the refusal PROMISES
      // that closing the other session is enough, so it has to be able to come
      // back on its own. Deduped on WHO holds it, not on the text: the text
      // carries the holder's heartbeat, which is rewritten every few seconds,
      // so comparing the message would re-notify on every re-check tick
      // (reviewer P2, 2026-09-05).
      if (refusedHolderId !== verdict.holder.sessionId) {
        refusedHolderId = verdict.holder.sessionId;
        try { ctx?.ui.notify(verdict.reason, "error"); } catch { /* headless */ }
      }
      state.exclusivityRefusal = verdict.reason;
      startExclusivityRecheck();
      return;
    }
    const wasRefused = state.exclusivityRefusal !== undefined;
    delete state.exclusivityRefusal;
    refusedHolderId = undefined;
    stopExclusivityRecheck();
    if (wasRefused) {
      try { ctx?.ui.notify("review-gate: 占用这个 worktree 的会话已消失，门禁正常启动，本会话接管这个 worktree。", "info"); }
      catch { /* headless */ }
    }
    // A judge / orchestration child does not claim the worktree, so it must
    // not write a heartbeat either — its own presence would refuse the very
    // session that opened it.
    if (claimsMainSidecar(process.env)) holdWorktree();
  }

  /** The refused session's own watch — the only way its refusal can lift. */
  let exclusivityRecheckTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * WHICH holder this session has already complained about.
   *
   * The dedupe key is the holder's session id, not the refusal text: the text
   * quotes the holder's heartbeat, which is rewritten every few seconds, so a
   * text comparison would fire a fresh error box on every re-check tick.
   */
  let refusedHolderId: string | undefined;

  function startExclusivityRecheck(): void {
    if (exclusivityRecheckTimer) return;
    exclusivityRecheckTimer = setInterval(
      () => { try { applySessionExclusivity(lastUiCtx); } catch { /* next tick retries */ } },
      PRESENCE_HEARTBEAT_MS,
    );
    // Never hold the process open just to watch somebody else's heartbeat.
    exclusivityRecheckTimer.unref?.();
  }

  function stopExclusivityRecheck(): void {
    if (exclusivityRecheckTimer) clearInterval(exclusivityRecheckTimer);
    exclusivityRecheckTimer = undefined;
  }


  /**
   * Apply whatever the orchestrator has sent, through pi's OWN delivery API.
   *
   * `steer` / `followUp` are `sendUserMessage`'s own modes and `interrupt` is
   * `ctx.abort()`; nothing is typed at a terminal, so nothing can be
   * truncated, split by a newline, or read by an open dialog as a menu
   * selection. Every one of those was measured on the `send-keys` path this
   * replaces (F7, F8, R-20, R-13).
   *
   * The acknowledgement is what the orchestrator's receipt is built on, so it
   * is written from what ACTUALLY happened — a failure is acknowledged as a
   * failure, never omitted.
   */
  async function drainChildInstructions(ctx: ExtensionContext): Promise<void> {
    const binding = childBinding();
    if (!binding) return;
    // RE-ENTRANCY GUARD: the heartbeat and agent_settled both drain; an
    // `await pi.sendUserMessage()` inside one drain would let the OTHER fire
    // while the first is still mid-flight, and the instruction would be
    // injected twice (round-4: a message that was written, never acknowledged,
    // and silently lost — the inverse: acknowledged twice, then acted on twice).
    if (drainingInstructions) return;
    drainingInstructions = true;
    try {
      await drainInstructionsInner(binding, ctx);
    } finally {
      drainingInstructions = false;
    }
  }

  async function drainInstructionsInner(binding: ChildChannelBinding, ctx: ExtensionContext): Promise<void> {
    for (const instruction of pendingInstructions(binding)) {
      // STAGE ONE — "I have it". Written BEFORE anything is attempted, and
      // exactly once per instruction, because it answers a different question
      // than the injection does: it proves this child's gate is alive and has
      // the message. That is the only honest bar for a `followUp`, whose whole
      // definition is "read this when you are done" — demanding an injection
      // from a busy child made the orchestrator's tool fail on a message that
      // had in fact arrived, and the message was then dropped (round-4 P1).
      if (!acknowledgedReceipts.has(instruction.instructId)) {
        acknowledgedReceipts.add(instruction.instructId);
        acknowledgeInstruct(
          binding,
          instruction.instructId,
          true,
          `已入队（mode=${instruction.mode}）`,
          "received",
        );
      }
      try {
        if (instruction.mode === "interrupt") {
          // Highest priority (2026-08-31): abort the current turn AND carry
          // the new message, so the child stops what it was doing and reads
          // this immediately. A bare interrupt (no text) stays a plain abort.
          const interruptText = instructText(channelIO, instruction);
          // Same as the steer/followUp path below: a round delivered as an
          // interrupt still carries the range the observer records against.
          if (isJudgePane()) noteJudgeTaskText(interruptText, instruction.roundSeq);
          // STOP-FIRST (user decision 2026-09-01): any OPEN dialog is
          // dismissed as INTERRUPTED before the message is injected — a
          // goal box, a question, a consent. The controller is swapped so
          // the NEXT dialog starts clean; the abort below additionally
          // stops the current turn if one is running.
          gateInterruptController.abort();
          gateInterruptController = new AbortController();
          if (interruptText) {
            // STOP FIRST, THEN SPEAK — AND WAIT FOR THE STOP TO LAND
            // (2026-09-21). `ctx.abort()` is SYNCHRONOUS on this side and does
            // not wait for the turn to end, so handing the text to pi while the
            // agent was still streaming queued it as `steer` — and the abort's
            // own end-of-run skipped the drain those queued messages wait for.
            // Measured: two judges of one round froze for 552s with the
            // dispatch sitting unread, and the same drain serves orchestration
            // children. lib/interrupt-delivery.ts owns the contract; this is
            // only the pi surface.
            const delivered = await deliverInterrupt(interruptText, {
              abort: () => ctx.abort?.(),
              isIdle: () => ctx.isIdle?.() === true,
              // NO `deliverAs`: by pi's own contract that is the form which
              // "sends immediately and triggers a new turn".
              sendNow: (text) => pi.sendUserMessage(text),
            });
            // A DEFERRED DELIVERY IS NOT AN INJECTION (2026-09-21): the text is
            // still in the channel, and the next drain retries it. Acknowledging
            // it as `injected` is how the opener was told "delivered" about a
            // message nobody had read — the ack says which stage was ACTUALLY
            // reached, which is the whole point of the two-stage handshake.
            acknowledgeInstruct(
              binding,
              instruction.instructId,
              true,
              delivered.delivered === "turn"
                ? `已中止当前 turn，等 pane 空闲（${delivered.waitedMs}ms）后作为新一轮投递`
                : `pane 仍在忙（已等 ${delivered.waitedMs}ms）—— 正文留在通道里，下一次 drain 再投`,
              delivered.delivered === "turn" ? "injected" : "received",
            );
          } else {
            ctx.abort?.();
            acknowledgeInstruct(binding, instruction.instructId, true, "已调用 ctx.abort()", "injected");
          }
          continue;
        }
        const text = instructText(channelIO, instruction);
        // A judge pane's instructions ARE its rounds: the next round's task
        // text is where its `baseline..HEAD` is written, so the inspection
        // observer learns the range from the same message the judge reads.
        if (isJudgePane()) noteJudgeTaskText(text, instruction.roundSeq);
        if (!text) {
          acknowledgeInstruct(
            binding,
            instruction.instructId,
            false,
            "指令没有正文（也没有可读的溢出文件）",
            "injected",
          );
          continue;
        }
        // STOP-FIRST for steer too: it cuts INTO the current turn, so an
        // open dialog (goal box / question / consent) must come down first —
        // otherwise the message is injected while the child stays wedged on
        // the box (the measured deadlock). followUp is the one mode that
        // does NOT stop: its whole meaning is "read this when you are done".
        if (instruction.mode === "steer") {
          gateInterruptController.abort();
          gateInterruptController = new AbortController();
        }
        pi.sendUserMessage(text, { deliverAs: instruction.mode });
        acknowledgeInstruct(
          binding,
          instruction.instructId,
          true,
          instruction.mode === "steer"
            ? `已解除等待并投递 (deliverAs:${instruction.mode})`
            : `pi.sendUserMessage(deliverAs:${instruction.mode})`,
          "injected",
        );
      } catch (error) {
        acknowledgeInstruct(binding, instruction.instructId, false, (error as Error).message, "injected");

      }
    }
  }

  /**
   * Raise a gate dialog that EITHER the human or the orchestrator may answer.
   *
   * This is the single funnel every gate question goes through, and it is why
   * the orchestrator never needs to read a screen: the request — title, every
   * option in order, and the full payload (a goal draft, a plan) — is written
   * into the channel as data. Whoever answers first wins; the other side is
   * cancelled, so a box the orchestrator answered DISAPPEARS from the user's
   * screen instead of asking a question that is already settled.
   *
   * A session with no orchestration simply renders the dialog, exactly as it
   * always did.
   */
  async function askEitherSide(
    request: Omit<ChannelDialogRequest, "hasUI">,
    hasUI: boolean,
    render: (signal: AbortSignal) => Promise<string | undefined>,
  ): Promise<ChannelDialogOutcome> {
    const binding = childBinding();
    if (!binding) {
      const answer = hasUI ? await render(new AbortController().signal) : undefined;
      return { answer, by: "human", requestId: "" };
    }
    // The dialog listens to the gate's interrupt source as well as its own
    // abort: an instruct fired while it is open dismisses it as INTERRUPTED
    // so the child can process the message instead of staying wedged on the box.
    return askThroughChannel(binding, { ...request, hasUI }, render, currentInterruptSignal());
  }


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
      persist(latestCtx ?? lastUiCtx);
    },
    now: () => new Date().toISOString(),
  };

  /**
   * THE RUNNER, and the only one this file uses (2026-09-25).
   *
   * It carries THIS session's declaration on every call, which is what makes
   * "the gate may only touch its own tmux session" true at the executor too: the
   * four session commands (`new-session` / `new-window` / `kill-window` /
   * `kill-session`) are refused unless their target is the session
   * `lib/session-tmux-scope.ts` derived for this process.
   *
   * WHY A WRAPPER INSTEAD OF PASSING THE DECLARATION AT EACH CALL SITE: there
   * are a dozen of them (every tool's deps, the judge close helpers, the
   * declare_done cascade), and a rule one caller can forget is a rule that is
   * already broken. The raw runner is imported under a different name so that
   * forgetting is not expressible: there is no unguarded `runTmux` in scope.
   */
  const runTmux = (argv: readonly string[], env?: NodeJS.ProcessEnv) =>
    rawTmux(argv, env ?? process.env, { ownSession: ownSessionName(tmuxScope) });

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
        execFileSync("git", [...createWorktreeArgv(repoRoot, childId)], { cwd: repoRoot, encoding: "utf8" });
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
          return { ok: true, output: execFileSync("git", [...argv], { cwd: repoRoot, encoding: "utf8" }).trim() };
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

  /** Which of the four kinds of session is running here. */
  function handoffKind(): HandoffSessionKind {
    if (readJudgeSideEnv(process.env)) return "judge";
    if (state.taskMode === "orchestrator") return "orchestrator";
    if ((process.env[STATE_VARIANT_ENV] ?? "").trim()) return "child";
    return "loop";
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
        handedOffSession = true;
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
   * Re-read the persisted judge table, MERGING IN IDS THIS SESSION HAS NEVER
   * SEEN — the one thing a judge's handover changes under its opener's feet.
   *
   * A judge that runs out of room opens the next generation ITSELF (it owns no
   * registry, but the table is a file in the repo it is already reviewing), and
   * the new session's channel is keyed by the NEW id: without this merge the
   * opener would keep reading the retired session's channel and never see the
   * round's conclusion. Known ids are never overwritten — this session's own
   * rows are newer for every judge IT opened.
   */
  function reloadJudgeHierarchy(root: string): void {
    try {
      const snap = parseHierarchySnapshot(readFileSync(pathJoin(root, ".pi", HIERARCHY_FILENAME), "utf8"));
      if (!snap) return;
      for (const [id, e] of Object.entries(snap.judges)) {
        if (!judgeHierarchy[id]) judgeHierarchy[id] = e;
      }
      hierarchyFileRoots.add(root);
    } catch { /* unreadable ⇒ keep what we have */ }
  }

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
    const entry = judgeHierarchy[side.judgeId];
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
      const next: HierarchyTable = { ...judgeHierarchy };
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
    if (handedOffSession || !state.sessionId) return "";
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
      plan: readPlanFile(primaryRepoRoot).plan,
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

  /**
   * What the children need from the supervisor RIGHT NOW, as text lines.
   *
   * The whole read is the channels — no pane is captured, no text is matched.
   * The event memory lives in the deps (one per orchestration), so the
   * background timer and `orchestrator_wait` share it and neither re-rings
   * what the other has already reported.
   */
  function drainSupervisionNews(): string[] {
    if (state.taskMode !== "orchestrator") return [];
    try {
      const runtime = orchestratorDeps.runtime();
      const snapshot = superviseNow(runtime, alivePaneIdsForSupervision());
      if (!snapshot) return [];
      lastSupervisionHealth = formatChildHealth(snapshot.health);
      const decided: { events: { summary: string }[]; memory: SupervisionMemory } =
        decideSupervisionEvents(snapshot, orchestratorDeps.supervisionMemory(), Date.now());
      orchestratorDeps.saveSupervisionMemory(decided.memory);
      return decided.events.map((event) => event.summary);
    } catch {
      return []; // supervision is a convenience for the timer, never a gate
    }
  }

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
      at: Date.now(),
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
      const live = latestCtx ?? ctx;
      try {
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
            aborted: lastRunAborted,
            awaitingAnswer: !!state.pausedQuestion,
            bypassed: state.bypass.active,
            arbitrationPaused,
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
   * turn of latency). Dedup is unchanged — the event memory is shared with
   * `orchestrator_wait`, so neither re-rings what the other already reported,
   * and the 10s→30s→60s backoff still bounds the repeats.
   */
  function startSupervisionTimer(): void {
    if (supervisionTimer || state.taskMode !== "orchestrator") return;
    supervisionTimer = setInterval(() => {
      try {
        if (state.taskMode !== "orchestrator") { stopSupervisionTimer(); return; }
        // RETIRED: this session handed the orchestration to a successor.
        // Supervision exists to push the plan forward, and pushing it is now
        // somebody else's job — a wake-up here would put two project managers
        // on one orchestration (the exact defect the revival path already
        // guards against at lib/session-revival.ts).
        if (handedOffSession) { stopSupervisionTimer(); return; }
        // NO idle requirement (2026-09-14): busy is exactly when a child's
        // question has to reach the manager. `steer` does not abort the tool
        // calls already running, so the interruption costs a turn at most.
        const news = drainSupervisionNews();
        if (news.length === 0) return;
        pi.sendMessage({
          customType: "review-gate",
          content:
            "[ORCHESTRATION] 子会话需要你：\n" +
            news.map((n) => `- ${n}`).join("\n") +
            "\n调 `orchestrator_wait({ timeoutMs: 0 })` 拿完整回执（问题正文与选项都在里面），" +
            "再用 `orchestrator_answer` 回；别让它就这么等着。" +
            "\n（这条会打断你手上的事：子会话在等回答，优先级高于你正在做的其他事。）",
          display: true,
        }, { triggerTurn: true, deliverAs: "steer" });
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
    if (state.taskMode === "orchestrator") {
      return orchestrationDoneProblems();
    }
    const fp = computeFingerprint(cwd);
    const problems = (state.hasCodeChange || state.hasDocChange)
      ? unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync })
      : [];
    const completion: string[] = [];
    for (const root of sessionRepos) {
      const st = root === primaryRepoRoot ? state : stateForRepo(root);
      for (const p of copilotProblemsFor(st)) {
        completion.push(root === primaryRepoRoot ? p : `[${repoLabel(root)}] ${p}`);
      }
    }
    if (!goalStageSatisfied()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
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
    if (lastRunAborted) {
      try { ctx.ui.notify("review-gate: 检测到手动中止（ESC）— 编排自动续跑已暂停；你的下一条消息会恢复。", "warning"); } catch { /* headless */ }
      updateWidget(ctx);
      return;
    }
    const problems = sessionExitProblems();
    const news = drainSupervisionNews();
    if (problems.length === 0 && news.length === 0) return;
    if (orchestratorContinuations >= state.maxRounds) return;
    orchestratorContinuations += 1;
    pi.sendUserMessage(
      buildOrchestratorResume({
        problems,
        news,
        health: lastSupervisionHealth,
      }) + `\n(编排续跑 ${orchestratorContinuations}/${state.maxRounds})`,
      { deliverAs: "followUp" },
    );
  }


  // (Process-era completion watcher deleted with the pane migration: a pane
  // has no exit event to listen on. Completion arrives as a channel report
  // consumed by judge_wait — the wait is the completion path.)
  /**
   * THE registry of pane judges — one table, `judgeHierarchy` (lib/hierarchy.ts).
   *
   * There used to be two. An in-memory `childSessions` Map held the same facts
   * (id, role, pane, opener, stream) for THIS session's own judges, and every
   * dispatch hand-wrote both; `judgeChildByRole` read the Map while
   * `settleFinishedRounds` read the table, and the audit chain carried a
   * "the registry does not know the judge I just spawned" branch that was
   * nothing but the drift confessing itself. The Map is deleted (哲学三: the
   * new path replaces the old one, no toggle, no compatibility layer).
   *
   * WHAT THE MERGE CHANGED FOR READERS. The Map only ever held judges THIS
   * process opened; the table also holds entries restored from disk and
   * entries belonging to OTHER openers. So every reader that meant "my own
   * judges" now says so explicitly through `ownJudges()` — the filter is not
   * decoration, it is the Map's old scope made mechanical.
   */
  let judgeHierarchy: HierarchyTable = emptyHierarchy();
  /**
   * WHICH MODEL SLOTS ARE BAD, per repo (lib/model-health.ts).
   *
   * Read at every dispatch (the chain head is skipped while it cools down),
   * written when a judge pane reports that its model failed. Persisted in the
   * repo's hierarchy snapshot — the same file that already records which
   * judges exist, and the one file EVERY opener in the repo shares.
   */
  const modelHealthByRoot = new Map<string, ModelHealth>();
  /**
   * Who THIS session is for opener checks: the orchestration id when this
   * session manages one, else its own session id. Unknown ⇒ fail-closed.
   */
  function callerIdentity(): string | undefined {
    const orch = process.env[ORCHESTRATION_ID_ENV]?.trim();
    if (state.taskMode === "orchestrator" && orch) return orch;
    return state.sessionId ?? undefined;
  }

  /**
   * WHO THIS SESSION IS on a pane border — the `@<owner>` half of every judge
   * pane this session opens (2026-09-18).
   *
   * Read from the session's own facts and never from a tool parameter: the
   * child id it was spawned with (`RG_STATE_VARIANT`), the mode it runs in, and
   * nothing else. It is NOT `callerIdentity()` — that one answers "may I touch
   * this judge" and is an opaque session/orchestration id; this one answers
   * "what should a human read", and an opaque id is exactly what the border
   * must not print.
   */
  function paneOwnerIdentity(): string {
    return selfPaneOwner({
      stateVariant: SESSION_STATE_VARIANT,
      orchestrator: state.taskMode === "orchestrator",
    });
  }
  /**
   * The judges THIS session owns — the deleted `childSessions` Map's scope.
   *
   * The merged table is wider than the Map was in two directions, and the two
   * are NOT the same problem:
   *
   *  - OTHER openers' entries (loaded from the shared file). Reading one as
   *    "mine" would let this session cascade-close a live peer's review, so
   *    the opener filter is mandatory, never an optimization.
   *  - MY OWN entries restored from a previous process. Those really are this
   *    opener's judges — but their panes usually died with that process, so
   *    the callers that ask "is a judge RUNNING" filter further through
   *    `ownLiveJudges()`; the ones that ask "what do I own" (cascade-close)
   *    want them, which is how a restart stops stranding panes.
   *
   * Unknown identity yields NOTHING (fail-closed): an unidentifiable session
   * owns no judge, and must not act on one.
   */
  /**
   * EVERY identity whose judges this session is responsible for.
   *
   * Normally one — the orchestration id, or its own session id. A SUCCESSOR
   * adds the identity it replaces (2026-09-14, measured on the loop path): a
   * judge's channel is keyed by `<openerId>/<judgeId>`, so a handover that
   * changes the opener's session id would otherwise strand every judge the
   * predecessor had already dispatched — the round's verdict would land in a
   * channel nobody reads, and the successor would wait forever on a review
   * that had already concluded.
   *
   * Uncertain identity still yields NOTHING (fail-closed): an unidentifiable
   * session owns no judge, and must not act on one.
   */
  function callerIdentities(): string[] {
    const ids: string[] = [];
    const own = callerIdentity();
    if (own) ids.push(own);
    const inherited = readInheritance().predecessorSession;
    if (inherited && !ids.includes(inherited)) ids.push(inherited);
    return ids;
  }

  function ownJudges(): JudgeEntry[] {
    const mine: JudgeEntry[] = [];
    for (const id of callerIdentities()) mine.push(...listByOpener(judgeHierarchy, id));
    return mine;
  }

  /**
   * The panes this session's tmux SERVER has, or undefined when unreadable.
   *
   * SERVER-WIDE since 2026-09-25: a judge is no longer a pane of this window,
   * and asking about the window would answer "none" for every live one.
   */
  function listOwnWindowPanes(): string[] | undefined {
    try { return listJudgePanes((argv) => runTmux(argv)); }
    catch { return undefined; }
  }

  /**
   * How many JUDGE panes of this session are decorated and still on screen.
   *
   * DELETED WITH ITS ONLY CALLER (2026-09-17, user decision): it existed for
   * the label-bar release, which is gone — see lib/session-factory.ts
   * `closeSessionPane` for the measurement that decided it.
   */


  /**
   * Own judges whose pane is not KNOWN to be gone — "is one still running?".
   *
   * The predicate itself is lib/hierarchy.ts's `judgeLive`, shared with the
   * health snapshot so there is ONE answer to that question (哲学二): missing
   * information keeps an entry alive, and a pane id minted by a DIFFERENT tmux
   * server is not comparable at all.
   */
  function ownLiveJudges(): JudgeEntry[] {
    const panes = listOwnWindowPanes();
    const server = tmuxServerFrom(process.env);
    return ownJudges().filter((e) => judgeLive(e, panes, server));
  }

  /**
   * THE audit this repo dispatched and has not recorded yet — one per repo.
   *
   * A verdict binds to the CONTENT it judged (a goal to its draft's sha256, a
   * plan to its canonical hash), so the gate has to remember what it sent; the
   * auditor's output alone cannot say what it audited. Goal and plan share one
   * `goal-auditor` judge per repo, so at most one of them can be in flight —
   * which is why this is ONE map and not two (2026-09-05, user decision). The
   * two-map shape could represent a state the system cannot be in, and paid
   * for it with a self-heal branch that guessed which pending to drop.
   */
  const pendingAudits = new Map<string, PendingAudit>();
  /** File holding one repo's judges + pendings (under `.pi/`, git-ignored like all gate state). */
  const HIERARCHY_FILENAME = "judge-hierarchy.json";
  /** Repos whose hierarchy slice is already merged this session. */
  const hierarchyLoadedRoots = new Set<string>();
  /** Repos with a hierarchy file on disk (for pruning emptied slices). */
  const hierarchyFileRoots = new Set<string>();

  /** Assign the opener table and persist it — the single funnel for table writes. */
  function setHierarchy(next: HierarchyTable): void {
    judgeHierarchy = next;
    persistJudgeHierarchy();
  }

  /** Forget this repo's pending audit and persist. */
  function dropAudits(root: string): void {
    pendingAudits.delete(root);
    persistJudgeHierarchy();
  }

  /**
   * Persist judges + pendings, sliced per repo. Restarting must not strand
   * live panes (unaddressable judges) nor fork a second pi onto one session
   * id — the process era's pid-file takeover, reborn as a file per repo.
   */
  function persistJudgeHierarchy(): void {
    try {
      const slices = new Map<string, { judges: Record<string, JudgeEntry>; audit?: PendingAudit; modelHealth?: ModelHealth }>();
      const slice = (root: string) => {
        let s = slices.get(root);
        if (!s) { s = { judges: {} }; slices.set(root, s); }
        return s;
      };
      for (const [id, e] of Object.entries(judgeHierarchy)) slice(e.repoRoot).judges[id] = e;
      for (const [root, v] of pendingAudits) slice(root).audit = v;
      // Pruned on the way out, so a dead model id can never be immortal in a file.
      const now = Date.now();
      for (const [root, health] of modelHealthByRoot) {
        const live = pruneModelHealth(health, now);
        if (Object.keys(live).length === 0) modelHealthByRoot.delete(root);
        else slice(root).modelHealth = live;
      }
      for (const root of hierarchyFileRoots) slice(root);
      for (const [root, s] of slices) {
        hierarchyFileRoots.add(root);
        const file = pathJoin(root, ".pi", HIERARCHY_FILENAME);
        const empty = Object.keys(s.judges).length === 0 && !s.audit && !s.modelHealth;
        if (empty) { try { rmSync(file, { force: true }); } catch { /* best effort */ } continue; }
        try { mkdirSync(pathJoin(root, ".pi"), { recursive: true }); } catch { /* best effort */ }
        writeFileSync(file, JSON.stringify({ version: 1, ...s }), "utf8");
      }
    } catch { /* persistence never breaks the gate */ }
  }

  /**
   * Merge one repo's durable slice into this session. Memory (this session)
   * wins on conflict; a corrupt file is ignored. Idempotent per root.
   */
  function ensureHierarchyLoaded(root: string): void {
    if (hierarchyLoadedRoots.has(root)) return;
    hierarchyLoadedRoots.add(root);
    let raw: string;
    try { raw = readFileSync(pathJoin(root, ".pi", HIERARCHY_FILENAME), "utf8"); } catch { return; }
    const snap = parseHierarchySnapshot(raw);
    if (!snap) return;
    hierarchyFileRoots.add(root);
    for (const [id, e] of Object.entries(snap.judges)) {
      if (!judgeHierarchy[id]) judgeHierarchy[id] = e;
    }
    if (!pendingAudits.has(root) && snap.audit) pendingAudits.set(root, snap.audit);
    // Model health is the one thing that must SURVIVE this session: the next
    // dispatch (by this opener or the next session) skips a slot that just
    // failed, which is what makes an in-round rotation stick.
    if (!modelHealthByRoot.has(root) && snap.modelHealth) modelHealthByRoot.set(root, snap.modelHealth);
  }

  /** The live (pruned) model health of one repo. */
  function judgeModelHealth(root: string): ModelHealth {
    return pruneModelHealth(modelHealthByRoot.get(root) ?? {}, Date.now());
  }

  /**
   * Remember that one model slot failed in this repo, and persist it.
   *
   * Called when a judge pane reports its own model failure and when the
   * opener's wait ends a round with an exhausted chain — the two facts that
   * decide which slot the NEXT round starts on.
   */
  function recordJudgeModelFailure(root: string, spec: string, error?: string): void {
    modelHealthByRoot.set(root, recordModelFailure(modelHealthByRoot.get(root) ?? {}, spec, Date.now(), error));
    persistJudgeHierarchy();
  }

  /** One model proved itself again (a rotation moved onto it and it ran). */
  function clearJudgeModelFailure(root: string, spec: string): void {
    const next = clearModelFailure(modelHealthByRoot.get(root) ?? {}, spec, Date.now());
    if (Object.keys(next).length === 0) modelHealthByRoot.delete(root);
    else modelHealthByRoot.set(root, next);
    persistJudgeHierarchy();
  }

  /**
   * Read what a pane said about its own models and act on it.
   *
   * The pane cannot write repo state (judge panes report, they do not
   * enforce), so the opener is the one that turns its channel records into a
   * cooldown, a warning and a cursor advance. Called at settle (a round ended)
   * and at dispatch (a round ended badly and nobody settled it — an exhausted
   * chain never produces a report).
   */
  function absorbJudgeModelEvents(root: string, judgeId: string): void {
    const entry = judgeHierarchy[judgeId];
    // NO ENTRY, NO ABSORB (reviewer round 1, 2026-09-10). Without a registry
    // row there is no cursor, and "read the whole channel" would re-record a
    // HISTORICAL failure with a fresh timestamp every time this runs — a
    // cooldown that can never expire. The channel outlives its entries (a close
    // removes the row, the records stay), so the cursor is the only thing that
    // says what has already been acted on; the dispatch seeds it at the
    // channel watermark when it registers a fresh entry.
    if (!entry) return;
    let events: readonly ModelEvent[];
    try {
      const target = judgeChannelTarget(entry.openerId, judgeId);
      events = projectChannel(readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home)).records).modelEvents;
    } catch { return; }
    const fresh = events.slice(entry.lastModelEventCount ?? 0);
    if (fresh.length === 0) return;
    for (const event of fresh) {
      recordJudgeModelFailure(root, event.spec, event.error);
      // A successful switch is proof the destination works; keeping an older
      // failure on record would bench a healthy model for the rest of the TTL.
      if (event.to) clearJudgeModelFailure(root, event.to);
    }
    setHierarchy({ ...judgeHierarchy, [judgeId]: { ...entry, lastModelEventCount: events.length } });
    const lines = fresh.map((event) => {
      const why = event.error ? `（${event.error}）` : "";
      if (!event.exhausted) {
        return `${modelKeyOf(event.spec)} 失败${why} → 切到 ${event.to ? modelKeyOf(event.to) : "?"}`;
      }
      // The per-slot reasons are what make this line actionable — a banner that
      // says only "链上已无可用槽" cannot tell a rate limit from a bad model id.
      const tried = event.tried ?? [];
      const detail = tried.length === 0
        ? ""
        : "：" + tried.map((t) => `${modelKeyOf(t.spec)}（${t.reason}）`).join("、");
      return `${modelKeyOf(event.spec)} 失败${why}，链上已无可用槽${detail}`;
    });
    try { latestCtx?.ui.notify(`review-gate: judge 模型 fallback —— ${lines.join("；")}`, "warning"); } catch { /* headless */ }
  }

  /** What one judge round launches on: the chain, the pick, and why. */
  type JudgeLaunch =
    | { ok: true; sysPromptPath: string; spec: string; chain: string[]; choice: SlotChoice }
    | { ok: false; error: string };

  /**
   * Resolve what THIS round launches on — read fresh, picked by health.
   *
   * THREE THINGS HAPPEN HERE, and they are one function because a dispatch
   * that did only two of them is exactly the defect this fixes (2026-09-10):
   *   1. the agents config is re-READ from disk (a session that started before
   *      the user's edit used to keep launching the old chain for hours);
   *   2. the model layers are re-rendered when the config changed, so the
   *      `.pi/agents/*.md` chain on disk matches the model actually launched;
   *   3. the slot is picked from the WHOLE chain, skipping the ones cooling
   *      down (lib/model-health.ts), instead of always taking `slots[0]`.
   */
  function resolveJudgeLaunch(root: string, role: string, workDir: string, title: string, judgeId: string): JudgeLaunch {
    const cfg = freshProjectConfig(root);
    // Rendering writes files; it is idempotent and guarded by the config key,
    // so the dispatch-time call is a no-op until the config actually changes.
    if (latestCtx) ensureModelLayersRendered(latestCtx, cfg, root);
    const { map: agents } = effectiveAgentsConfig(cfg.agentsGlobal, cfg.agentsProject);
    const files = writeJudgeSpawnFiles({ repoRoot: root, role, agents, workDir, title });
    if (files.chain.length === 0) {
      // NO BUILT-IN DEFAULT (user requirement 2026-08-30): a role with no
      // resolvable chain cannot be dispatched. Fail closed with the reason.
      return { ok: false, error: `角色 ${role} 没有可派发的模型链（agents 配置缺失或不可解析）——请修复 ~/.pi/review-gate.json 后重试` };
    }
    const choice = selectHealthySlot(files.chain, judgeModelHealth(root), Date.now());
    if (!choice) return { ok: false, error: `角色 ${role} 的模型链为空（不可达）` };
    announceSlotSkip(role, choice);
    return { ok: true, sysPromptPath: files.sysPromptPath, spec: choice.spec, chain: files.chain, choice };
  }

  /**
   * Say which slots the pick stepped over — a silent skip is the same
   * blindness as never skipping at all.
   */
  function announceSlotSkip(role: string, choice: SlotChoice): void {
    if (choice.skipped.length === 0) return;
    const now = Date.now();
    const skipped = choice.skipped.map((s) => describeCoolingSlot(s, now)).join("、");
    const head = choice.allCooling
      ? `review-gate: ${role} 的全部模型槽都在冷却期（${skipped}）——本轮仍按链头 ${modelKeyOf(choice.spec)} 派发，失败会立刻上报。`
      : `review-gate: ${role} 跳过冷却中的模型槽 ${skipped} → 本轮用 ${modelKeyOf(choice.spec)}。`;
    try { latestCtx?.ui.notify(head, "warning"); } catch { /* headless */ }
  }

  /**
   * THIS pane's current round number, read from the registry FILE.
   *
   * Deliberately not `judgeHierarchy`: this session's in-memory copy is loaded
   * once and "memory wins on conflict", so it would keep reporting the round
   * the pane opened with while the opener bumps the real one on every
   * dispatch. The inspection observer stamps each action with this, and
   * `judge_conclude` compares it against the round it is concluding — that is
   * what keeps an ABANDONED round's reads from being credited to the next one.
   * Undefined when the file is missing or unreadable (the evidence then
   * carries no round and the comparison cannot refuse anything).
   */
  function judgeCurrentRound(): number | undefined {
    const judgeId = readJudgeSideEnv(process.env)?.judgeId;
    if (!judgeId) return undefined;
    try {
      const raw = readFileSync(pathJoin(cwd, ".pi", HIERARCHY_FILENAME), "utf8");
      const snap = JSON.parse(raw) as { judges?: Record<string, { roundSeq?: unknown }> };
      const seq = snap?.judges?.[judgeId]?.roundSeq;
      return typeof seq === "number" && Number.isFinite(seq) ? Math.floor(seq) : undefined;
    } catch {
      return undefined;
    }
  }

  /** A pane-less foreign entry older than this is not a concurrent spawn. */
  const FOREIGN_SPAWN_GRACE_MS = 10 * 60 * 1000;
  /**
   * Drop foreign entries nobody can still be driving: pane dead (or never
   * recorded) AND channel silent past the heartbeat budget. A live pane or a
   * fresh heartbeat keeps the strict refusal — that is a possibly-live peer,
   * which is what the cross-level rule protects. Own entries are never
   * touched; an unreadable pane list touches nothing (missing info never
   * kills). A pane-less entry younger than the spawn grace is kept: it may be
   * a concurrent spawn that has not recorded its pane yet.
   *
   * WHY DROP, NOT ADOPT: judge ids are opener-scoped, so a new opener never
   * shares an id with a dead entry — adopting it would only resurrect a review
   * whose transcript the new session must never read. Dropped entries lose
   * registry protection and their dirs fall to the TTL/legacy reclaim.
   */
  function dropDeadForeignJudges(): void {
    const caller = callerIdentity();
    if (!caller) return;
    const panes = listOwnWindowPanes();
    let changed = false;
    for (const [id, e] of Object.entries(judgeHierarchy)) {
      if (e.openerId === caller) continue;
      if (e.paneId !== undefined) {
        if (panes === undefined) continue;
        if (panes.includes(e.paneId)) continue;
        if (channelFresh(e)) continue;
      } else if (!foreignSpawnSettled(e)) continue;
      delete judgeHierarchy[id];
      changed = true;
    }
    if (changed) persistJudgeHierarchy();
  }

  /** A pane-less foreign entry counts as settled once older than the grace. */
  function foreignSpawnSettled(e: JudgeEntry): boolean {
    const at = Date.parse(e.spawnedAt ?? "");
    return Number.isFinite(at) && Date.now() - at > FOREIGN_SPAWN_GRACE_MS;
  }

  /**
   * Best-effort reclaim of judge session dirs nobody owns. Registry-referenced
   * dirs (either format — a live peer's, whatever code it runs) are protected;
   * unreferenced legacy dirs go immediately, anything else past the TTL
   * (lib/judge-lifecycle.ts decides, this only lists and deletes).
   * Never throws: the sweep must not break a dispatch.
   */
  function sweepStaleJudgeSessionDirs(root: string): void {
    try {
      const base = pathJoin(root, JUDGE_SESSIONS_RELDIR);
      const known = new Set<string>();
      for (const e of Object.values(judgeHierarchy)) {
        if (e.repoRoot !== root) continue;
        // A LIVE lane is protected by its identity, not by its mtime: an entry
        // that records a lane names a dir with the lane suffix, and that is the
        // dir this judge is writing into right now. Both shapes are added — an
        // entry written by an older build has no lane at all, and its dir is
        // the un-suffixed one.
        known.add(judgeWorkDirBasename(e.role, shortRepoHash(e.repoRoot), e.openerId, laneOfEntry(e)));
        known.add(judgeWorkDirBasename(e.role, shortRepoHash(e.repoRoot), e.openerId));
        known.add(legacyJudgeWorkDirBasename(e.role, shortRepoHash(e.repoRoot)));
      }
      const names = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const entries = names.map((name) => {
        let mtimeMs = Number.NaN;
        try { mtimeMs = statSync(pathJoin(base, name)).mtimeMs; } catch { /* age unknown */ }
        return { name, mtimeMs };
      });
      for (const stale of selectStaleJudgeSessionDirs(entries, known, Date.now())) {
        try { rmSync(pathJoin(base, stale), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    } catch { /* sweep never breaks the caller */ }
  }

  /**
   * Number this judge's next round: above both the persisted entry and every
   * report already in the channel (a close→spawn keeps the old reports, so the
   * entry alone would restart at 1 and collide with them). Best-effort: an
   * unreadable channel still numbers above the entry.
   */
  function nextJudgeRound(openerId: string, judgeId: string): number {
    let records: ChannelRecord[] = [];
    try {
      const target = judgeChannelTarget(openerId, judgeId);
      records = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home)).records;
    } catch { /* the entry alone still numbers above */ }
    return nextRoundSeq(judgeHierarchy[judgeId]?.roundSeq, records);
  }

  /** Fresh heartbeat within budget ⇒ someone may still drive this judge. */
  function channelFresh(e: JudgeEntry): boolean {
    try {
      const target = judgeChannelTarget(e.openerId, e.judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      const last = projectChannel(read.records).lastActivityAt;
      if (!last) return false;
      const at = Date.parse(last);
      return Number.isFinite(at) && Date.now() - at <= HEARTBEAT_STALE_MS;
    } catch {
      return false;
    }
  }
  /**
   * Review targets registered by prepare_review (commit mode): repo root →
   * the reviewed baseline..HEAD plus HEAD's tree. The verdict recorder consumes it:
   * a READY binds to the reviewed tree, and a HEAD that moved past the
   * registered head (a new checkpoint after prepare) is STALE ⇒ BLOCKED.
   */
  interface ReviewTarget {
    baseline: string;
    head: string;
    tree: string;
    /** What this round was DISPATCHED to review (the audit pair's gate half). */
    scope?: ScopeStampRecord;
    /**
     * The files this round changed — carried so the QUALITY PRECONDITION can
     * be evaluated from the target alone (`lib/quality-round.ts`'s
     * `qualityStandingFor`), without a second `git diff` at dispatch time.
     * Absent for targets registered before this field existed: absent ⇒ the
     * guard treats the round as code-bearing (fail-closed).
     */
    files?: readonly string[];
    /**
     * THE QUALITY ROUND THIS TARGET DISPATCHED (2026-09-16).
     *
     * It is written the moment the quality judge of THIS round is dispatched,
     * and it is what makes "is the quality round still owed?" a per-ROUND fact
     * instead of a registry lookup. The quality pane is REUSED across rounds
     * and outlives its own verdict (it is only closed on `fresh`, on rotation
     * or when it dies), so "a quality judge exists and is alive" is true for
     * the rest of the session — a hold predicate built on it would park a
     * conclusion nothing would ever release.
     *
     * `head` is the round it belongs to: a target re-registered by the next
     * `prepare_review` replaces the whole object, so a stale record cannot
     * survive into a round it did not dispatch.
     */
    qualityRound?: { judgeId: string; head: string };
  }
  const reviewTargets = new Map<string, ReviewTarget>();

  /**
   * THE QUALITY JUDGE THIS ROUND DISPATCHED — recorded on the round's target.
   *
   * Called only after the dispatch was ACCEPTED (a refused spawn must not make
   * the round believe a quality verdict is coming).
   */
  function noteQualityRoundDispatched(root: string, judgeId: string): void {
    const target = reviewTargets.get(root);
    if (!target) return; // no target ⇒ nothing to bind the round to (fail-closed elsewhere)
    target.qualityRound = { judgeId, head: target.head };
  }

  /**
   * IS THIS ROUND'S QUALITY JUDGE STILL ABLE TO CONCLUDE? — the fact
   * `decideQualityHold` (lib/quality-round.ts) needs before it may HOLD a
   * functional verdict instead of refusing it.
   *
   * Three conditions, and each one is here for a measured reason:
   *  - the ROUND must have dispatched one (a live quality pane somewhere in
   *    the registry is not the same thing — the pane is reused across rounds
   *    and outlives its own verdict);
   *  - its pane must still be alive (`ownLiveJudges`: a persisted entry from a
   *    previous process has no pane, and a judge that died can never land a
   *    verdict — holding there parks the round forever);
   *  - NO verdict may already stand for this head: once one is recorded, the
   *    standing answers the question and this must not keep a hold alive. A
   *    SKIP record is NOT such a verdict (2026-09-22) — it is a permission the
   *    quality judge was never owed, so with the stage back ON the judge
   *    dispatched for this head is still the one that can conclude it.
   */
  function qualityRoundInFlight(root: string): boolean {
    const target = reviewTargets.get(root);
    const round = target?.qualityRound;
    if (!target || !round || round.head !== target.head) return false;
    // THE RECORD MUST BE A JUDGE'S ANSWER, NOT A SKIP (functional P1,
    // 2026-09-22): with the stage back ON a skip bound to this head does not
    // stand for it (`lib/quality-round.ts`'s `qualityStandingFor`), so reading
    // `commitSha` alone said "nobody is coming back" on a round whose quality
    // judge was running — the functional READY was refused and recorded
    // BLOCKED, and that BLOCKED ran the cancel matrix and killed the live
    // quality pane. `isSkippedQualityRecord` is the ONE reading of the brand
    // (a second `skipped` test here is how the two rules drift).
    const quality = stateForRepo(root).quality;
    if (quality?.commitSha === target.head && !isSkippedQualityRecord(quality)) return false;
    return ownLiveJudges().some((e) => e.judgeId === round.judgeId);
  }

  /**
   * The branch this repo is working on.
   *
   * A rebase in progress is NOT a detached head in any meaningful sense: git
   * remembers the branch it will land back on, and every commit the rebase
   * makes belongs to that branch. Reading it is what keeps the branch rule
   * from blocking `git rebase -i` reword — the very operation an agent needs
   * to fix a non-English commit message (observed deadlock, 2026-08-29).
   * A genuine detached HEAD still reports undefined, and the rule still
   * refuses.
   */
  function currentBranch(root: string): string | undefined {
    try {
      const name = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      if (name) return name;
    } catch { /* detached — maybe a rebase; ask git where it came from */ }
    return rebaseBranch(root);
  }

  /**
   * WHICH BRANCH THIS REPOSITORY LISTS FOR ONE OF ITS OWN CHECKOUTS.
   *
   * ASKED OF THE REPOSITORY, NEVER OF THE CHECKOUT DIRECTORY (quality round
   * P1, 2026-09-18). `currentBranch(worktreePath)` is the obvious read and it is
   * a trap in the one place settlement uses a branch name: when that directory
   * is not a repository — a `git worktree add` that failed halfway, an emptied
   * shell left by a failed removal — git walks UP to the enclosing repository
   * and answers with ITS branch, and that answer then goes to
   * `git -C <repoRoot> branch -D`, which is destructive. `worktree list` is the
   * repository's own registry of the checkouts it owns: a path it does not list
   * yields nothing, so the caller falls through to the name this session
   * recorded or to the one it derived.
   */
  function listedWorktreeBranch(repoRoot: string, worktreePath: string): string | undefined {
    try {
      const out = String(execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 10_000,
      }) ?? "");
      // TWO SPELLINGS, ONE CHECKOUT. git records a worktree under the path it
      // was CREATED with, symlinks resolved — measured on this repository's own
      // list, where `/tmp/...` reads back as `/private/tmp/...`. The gate
      // derives the path from the repo root it was handed, so the two differ
      // whenever a repository lives behind a symlink; a miss would fall through
      // to the derived name, which is exactly the name a renamed child no
      // longer has. Both spellings are tried and neither is invented: a path
      // that cannot be resolved is simply not a match.
      const resolved = realpathOrUndefined(worktreePath);
      return branchOfListedWorktree(out, worktreePath)
        ?? (resolved === undefined ? undefined : branchOfListedWorktree(out, resolved));
    } catch { return undefined; }
  }

  /** `realpathSync`, or undefined when the path cannot be resolved (it may be gone). */
  function realpathOrUndefined(target: string): string | undefined {
    try { return realpathSync(target); } catch { return undefined; }
  }

  /** The branch a rebase in progress will return to, read from the git dir. */
  function rebaseBranch(root: string): string | undefined {
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      try {
        const gitPath = execFileSync("git", ["rev-parse", "--git-path", `${dir}/head-name`], {
          cwd: root, encoding: "utf8",
        }).trim();
        if (!gitPath || !existsSync(pathResolve(root, gitPath))) continue;
        const name = rebaseBranchName(readFileSync(pathResolve(root, gitPath), "utf8"));
        if (name) return name;
      } catch { /* no rebase in progress, or an unreadable git dir */ }
    }
    return undefined;
  }



  /** HEAD commit tree OID — the content-boundary every ship binding compares against (round-8 P1). */
  function headCommitTree(root: string): string {
    try {
      return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  }

  /**
   * The tree the NEXT commit would publish — the worktree tree, computed the
   * same way the ship bindings are (lib/fingerprint.ts). Empty when it cannot
   * be read, which every caller must treat as "unknown" rather than "equal".
   */
  function worktreeTree(root: string): string | undefined {
    try {
      return worktreeTreeOid(root) || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Does the INDEX differ from HEAD? `git diff --cached --quiet HEAD` exits 1
   * when it does, so a throw means "staged content" — and so does any error,
   * which is the fail-closed reading: `undefined` (unknown) never authorizes
   * the message-only exemption.
   */
  function hasStagedChanges(root: string): boolean | undefined {
    try {
      execFileSync("git", ["diff", "--cached", "--quiet", "HEAD"], {
        cwd: root, encoding: "utf8", stdio: "ignore",
      });
      return false;
    } catch (err) {
      // Exit 1 is the documented "there are differences" answer; anything else
      // (no HEAD, not a repo, git missing) is unknown, not "clean".
      return (err as { status?: number }).status === 1 ? true : undefined;
    }
  }

  /**
   * Round-9 P1: trees of the commits between the last READY's reviewed
   * commit and HEAD that DIFFER from the reviewed tree. Non-empty ⇒ content
   * no reviewer saw entered the branch since the READY (a checkpoint never
   * re-reviewed, a change-and-revert, or a rebase that moved the reviewed
   * point) — HEAD's tree matching is not enough. Returns undefined when there
   * is nothing to compare against (older sidecar). When the range cannot be
   * computed (the reviewed commit was squashed/rebase away), the HEAD-tree
   * match is the content proof and the check is skipped — a squash that
   * preserves the tree must keep the READY alive (goal criterion 4), and a
   * rebase that CHANGED content already fails the fingerprint match before
   * this check runs.
   */
  function unreviewedTreesSince(root: string, review: GateState["review"]): string[] | undefined {
    if (!review?.commitSha || !review.fingerprint) return undefined;
    try {
      const out = execFileSync("git", ["rev-list", "--format=%T", `${review.commitSha}..HEAD`], { cwd: root, encoding: "utf8" });
      return out
        .split("\n")
        .filter((l) => l && !l.startsWith("commit ") && l.trim() !== review.fingerprint)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return []; // reviewed commit gone (squash) — tree match is the proof
    }
  }

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
    if (handedOffSession) return;
    // P-multi: persist the session's repo set so a same-session resume (or
    // restart) re-arms declare_done against every repo this session edited.
    state.sessionReposPaths = [...sessionRepos].filter((r) => r !== primaryRepoRoot);
    try {
      saveSidecarPreservingConcurrent(sidecarPath(cwd), state, () => digestForMerge(cwd));
      // Our own earlier write failure (if any) is resolved: reclaim OUR owner
      // entry — and any owner whose session has been silent past the
      // concurrent-session window — but never a live foreign one.
      reconcileBlockedMarker(blockedMarkerPath(sidecarPath(cwd)), { sessionId: state.sessionId });
    } catch {
      recordBlockedMarker(blockedMarkerPath(sidecarPath(cwd)), { sessionId: state.sessionId });
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
      restored = loadSidecar(sidecarPath(cwd), sidecarMigration);
    }

    // Sidecar corruption detection: file exists but couldn't parse → fail-closed.
    const sidecarFile = sidecarPath(cwd);
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

  // ---- TUI widgets (display-only; never throw, never block the gate) ----
  // Content is built by pure functions in lib/ui-widget.ts and only pushed to
  // the TUI when it actually changed (pi re-renders on every setWidget call).
  let lastUiCtx: ExtensionContext | undefined;
  let lastAgentsWidget = "";

  /**
   * Has this session been told about its renderer? At most once per session.
   * In-memory on purpose: a restart is a new session with a new terminal, and
   * the answer can differ.
   */
  let rendererModeNoticeShown = false;

  /**
   * Say something when this session is on the renderer that CANNOT scroll a
   * tall dialog, and stay silent otherwise.
   *
   * The value comes from `TUI.mode` (see `lib/renderer-mode.ts` for why a
   * re-derivation from `--tui-mode` + settings files would be a copy that gets
   * the corners wrong).
   *
   * THE FLAG IS SET ONLY AFTER THE NOTICE IS OUT (round-1 quality P1,
   * 2026-09-16): the first version marked the session as told and then called
   * `latestCtx?.ui.notify`, which at probe time is not set yet — so the notice
   * could never reach anybody. A host that cannot notify must not consume the
   * session's one chance to say it.
   */
  function noteRendererMode(mode: RendererMode | undefined, ctx: ExtensionContext): void {
    if (!rendererModeNoticeDue(mode, rendererModeNoticeShown)) return;
    try {
      ctx.ui.notify(RENDERER_MODE_NOTICE, "warning");
      rendererModeNoticeShown = true;
    } catch { /* headless — a later probe may still succeed */ }
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
   * The gate facts the belowEditor widget renders: mode, branch, edited flag,
   * and whether the loop goal is confirmed.
   *
   * 2026-09-16 — DELIBERATELY CHEAP (input-lag fix): this used to call
   * `computeFingerprint()` on every 5s tick — a full shadow-index materialize
   * + two `git add` passes that took ~3.2s in a 13k-file repo and ran on
   * pi's main event loop, freezing the editor while typing. The widget now
   * shows ONLY state that needs no git work: the in-memory gate state, the
   * branch (one `symbolic-ref`), and the loop-goal confirmation. The unmet-
   * requirements count is gone from the strip; it lives in `/gate-status`.
   * Display-only: this never feeds an enforcement path.
   */
  function gateWidgetFacts(): GateWidgetFacts {
    const completion: string[] = [];
    // NON-GIT SHORT-CIRCUIT: the loop goal is a per-REPO contract — outside
    // a repository there is no repo to bind it to, so it must not surface
    // as an unmet requirement either (2026-09-02, user decision).
    if (sessionInGit && !goalStageSatisfied()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
    // ROUND READING (2026-09-17, user decision): how many rounds THIS session
    // SENT OUT — a loop session's own submissions, a judge pane's own round
    // number. Both are already in memory (no git, no fingerprint, so the
    // cheap-by-contract rule above holds). Sessions that never send anything
    // (orchestrator / explore / normal) do not show the segment at all —
    // `showsRoundReading` is the one place that rule lives, and a judge pane
    // whose task never named a round shows nothing rather than a 0 it cannot
    // back up.
    const judgePane = isJudgePane();
    const roundReading = judgePane ? judgeTaskRound : (state.sentReviewRounds ?? 0);
    return {
      mode: state.taskMode,
      nonGit: !sessionInGit,
      // NON-GIT SHORT-CIRCUIT: `currentBranch` would run git and, outside a
      // repository, leak "fatal: not a git repository" to the terminal.
      // The user decision (2026-09-02): in a non-git directory, do not call
      // git at all — no branch is shown.
      branch: sessionInGit ? currentBranch(primaryRepoRoot) ?? "(detached)" : undefined,
      edited: sessionEdited || state.hasCodeChange || state.hasDocChange || sessionEditedPaths.size > 0,
      ...(sessionInGit && roundReading !== undefined &&
          showsRoundReading({ mode: state.taskMode, judge: judgePane })
        ? { rounds: roundReading }
        : {}),
      // THE STAGE SWITCHES, visible on the strip whenever anything is OFF
      // (2026-09-22, user decision: a released checkpoint must be readable at a
      // glance). All-on renders nothing, which keeps today's strip unchanged;
      // this is in-memory state, so the cheap-by-contract rule above holds.
      ...(stagesOff(state.stages).length > 0 ? { stages: stagesSummary(state.stages) } : {}),
      unmet: completion,
    };
  }

  /**
   * The CONTRACT the `/gate-contract` command shows (2026-09-18): a project
   * manager shows its plan, a loop session (standalone or an orchestrated
   * child) shows the exit criteria of ITS OWN approved goal.
   *
   * On demand, so this runs when the user asks, not on a tick. It is still
   * CHEAP BY CONTRACT in the same sense as the status strip: one plan file read
   * or one goal file read, no git, no fingerprint, and nothing here is an
   * enforcement input.
   *
   * ONE PLACE DECIDES BOTH HALVES (quality round P2, 2026-09-19). The empty
   * cases and their explanations used to be written TWICE — a chain of bare
   * `return { rows: [] }` here and a mirrored chain of `absent(...)` in
   * `contractReadout` — so a new empty case could be added to one half and
   * silently not the other, and the command would then print a reason that
   * sounds right and is wrong (the mirroring was mechanical: 4 returns against
   * 6 branches, and the test only fed a fake readout). `absent` now travels
   * WITH the facts; the readout's job is to print what it is handed.
   */
  function contractFacts(): { facts: ContractFacts; absent?: string } {
    const none = (absent: string): { facts: ContractFacts; absent: string } => ({
      facts: { rows: [] },
      absent,
    });
    if (!sessionInGit) return none("这里不是 git 仓库 —— 契约（goal / plan）都是按仓库谈的");
    if (isJudgePane()) return none("judge 会话审的是别人的契约，自己不持有一份");
    if (state.taskMode === "orchestrator") {
      // Absent file, unreadable JSON and an archived plan all answer the same
      // way here: no plan ⇒ no rows.
      const rows = planContractRows(readPlanFile(primaryRepoRoot).plan?.tasks);
      return rows.length > 0
        ? { facts: { kind: "plan", rows } }
        : none("没有可显示的 plan：.pi/orchestrator-plan.json 不在、不是合法 JSON，或已被归档");
    }
    if (!isEnforcedMode(state.taskMode)) {
      return none(`本会话模式是 ${state.taskMode ?? "未初始化"}，它不持有 plan/goal 契约`);
    }
    if (!goalStageSatisfied()) {
      return none(
        stageIsOn("goal")
          ? (readSessionLoopGoal(primaryRepoRoot).present
            ? "goal 还是一份草稿：用户没批准过这段文本（批准了才有退出标准可看）"
            : "还没有 goal 文件 —— 先反述需求、让用户批准一份退出契约")
          : "goal 环节已关闭（用户设定的环节开关）—— 本会话不持有 goal 契约",
      );
    }
    const rows = goalCriteriaRows();
    return rows.length > 0
      ? { facts: { kind: "goal", rows } }
      : none("已批准的 goal 里解析不出「退出标准」小节的条目");
  }

  /**
   * The approved goal's criteria as contract rows, read from the RAW FILE.
   *
   * NOT `LoopGoal.text`: that copy is capped at LOOP_GOAL_MAX_CHARS for the
   * prompt, and 15 of this repo's 48 goal files have criteria running past the
   * cut (measured while writing this). A file that cannot be read is no rows —
   * the same answer as a goal whose criteria section is empty, which is the
   * case `contractFacts` explains.
   */
  function goalCriteriaRows(): ContractFacts["rows"] {
    try {
      return parseGoalCriteria(readFileSync(loopGoalPathIn(primaryRepoRoot), "utf8"))
        .map((text) => ({ text, state: "pending" }));
    } catch {
      return [];
    }
  }

  /**
   * What `/gate-contract` prints: the contract lines, and — when there are none
   * — WHY, in the gate's own words.
   *
   * Which situation this is, and what it is called, is `contractFacts`' own
   * answer; the pairing of an empty list with its reason is
   * `buildContractReadout`'s (lib/ui-widget.ts) — an empty list can never
   * reach the command unexplained.
   */
  function contractReadout(): { lines: string[]; absent?: string } {
    const { facts, absent } = contractFacts();
    return buildContractReadout(facts, absent);
  }

  function updateWidget(ctx: ExtensionContext) {
    // Idempotent re-arm (round-2 P2: the session_shutdown comment promised
    // this and it did not exist): every widget-refresh path — the 5s timer
    // tick, session_start, an explicit updateWidget call — guarantees the
    // timer is running, so a later session_shutdown cannot leave the widget
    // frozen. The tick calls updateWidget, which calls armUiRefreshTimer,
    // which no-ops when the timer already exists — no recursion hazard.
    armUiRefreshTimer();
    lastUiCtx = ctx;
    let hasUI: boolean;
    try {
      hasUI = ctx.hasUI;
    } catch {
      // Stale ctx: the session was replaced or reloaded (resume / switch /
      // fork) and this captured ctx now THROWS on any access (pi hard-
      // asserts). Drop it — the next session_start installs a fresh one.
      // This must never escape as an uncaught exception: the 5s refresh
      // timer ticked a stale ctx right after resume, threw inside the timer,
      // and killed the whole pi process — the resumed session died before
      // it could come back.
      lastUiCtx = undefined;
      return;
    }
    if (!hasUI) return;
    // belowEditor — the gate status strip. Content-compared so pi only
    // re-renders when something actually changed.
    try {
      const lines = buildGateWidget(gateWidgetFacts());
      const key = lines.join("\n");
      // THE RENDERER PROBE — invisible, and removed the moment it has
      // answered. The `setWidget` FACTORY form is the only place the host hands
      // an extension the real TUI, and `tui.mode` is the only honest answer to
      // "is this session on the renderer that can scroll a tall dialog?" (a
      // config re-derivation would be a copy that gets the corners wrong —
      // lib/renderer-mode.ts).
      //
      // A PROBE, and not the widget itself (round-1 quality P0/P2,
      // 2026-09-16): a factory component must wrap its own lines (`render(width)`),
      // while the string[] form is what wraps each line through pi-tui's
      // `Text` — and pi's RPC host ignores component factories entirely, so
      // making the status strip a factory would delete it there.
      //
      // RE-PROBED when the status strip changes (round-2/3 P2, same day): the
      // mode can change mid-session — `/settings` applies immediately — and the
      // probe is the only place that reads it. It used to run on EVERY widget
      // update, which is every 5s from the refresh timer plus every persist
      // (round-3 P1); moving it inside the content-changed branch keeps the
      // reading while making its cost follow real changes. The residual corner
      // is named: a mode flipped while the strip's content stays identical
      // mid-session is not noticed until that content moves. The NOTICE stays
      // once-per-session (`rendererModeNoticeShown`).
      if (key !== lastAgentsWidget) {
        lastAgentsWidget = key;
        ctx.ui.setWidget("review-gate-renderer-probe", (tui) => {
          noteRendererMode(tui.mode, ctx);
          return { render: () => [], invalidate: () => {} };
        }, { placement: "belowEditor" });
        ctx.ui.setWidget("review-gate-renderer-probe", undefined);
        ctx.ui.setWidget("review-gate-agents", lines, { placement: "belowEditor" });
      }
    } catch { /* display-only */ }
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
  // Two rules, both learned the hard way (the measurements live in
  // lib/renderer-mode.ts now):
  //
  //  1. LONG TEXT GOES TO THE TRANSCRIPT. A tall dialog used to make pi's
  //     DEFAULT renderer clear the screen and the scrollback every frame
  //     (measured: 29 of 30 frames) — that is why the session on that renderer
  //     is told to switch, and why anything long belongs in the transcript
  //     anyway: it scrolls, and the box does not.
  //  2. A DIALOG ONLY CARRIES THE DECISION. Every dialog in this file goes
  //     through askChoice, which renders the gate's one question template
  //     (lib/choice-dialog.ts) — whole, no fitting (2026-09-16).

  // (There is deliberately NO cap on a transcript notice any more — see
  // showToUser below. The sensitive-path DIALOG cap moved to
  // lib/consent-request-tools.ts with the tool that echoes the path —
  // SENSITIVE_PATH_DIALOG_MAX_CHARS.)

  /**
   * Put text in front of the USER, in the transcript, RIGHT NOW.
   *
   * WHY notify AND NOT pi.sendMessage: inside a tool the session is streaming,
   * so `sendMessage` is queued rather than rendered — `deliverAs: "followUp"`
   * lands in the follow-up queue, which agent-loop.ts drains when the agent
   * would otherwise STOP, i.e. it silently buys another LLM turn (fatal for a
   * tool whose whole job is to pause the loop) and still shows nothing until
   * the turn ends. `ui.notify` is synchronous: interactive mode appends a Text
   * to the chat container and requests a render, so the user sees it before
   * the confirm dialog that follows.
   *
   * NO CHARACTER CAP (user decision, 2026-09-14). This used to cut every notice
   * at 4000 characters with a `…（已截断）` tail — including the restatement,
   * goal and plan the user is being asked to APPROVE, i.e. exactly the text
   * they have to read. The cap was there for a geometry fear that does not
   * apply to the transcript: the chat container scrolls, and appending 400
   * rows in one shot triggers 0 full clears on the real renderer (measured,
   * see lib/renderer-mode.ts). The dialog is the constrained
   * surface, and it already keeps only the decision — the full text belongs
   * here, whole.
   *
   * Returns false when there is no UI to render into (headless): callers must
   * report that honestly instead of claiming the user saw something.
   */
  function showToUser(
    uiCtx: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
    lead: string,
    body: string,
  ): boolean {
    try {
      const notify = uiCtx.ui?.notify;
      if (!notify) return false;
      notify(`${lead}\n${body}`, "warning");
      return true;
    } catch {
      return false; // headless / no UI
    }
  }

  /**
   * A host context as the template's narrow `ui` seam.
   *
   * THE CAST IS LOAD-BEARING (2026-09-17): pi's `ExtensionContext.ui` no longer
   * SATISFIES `ChoiceUi` structurally, because the reason box's `editor` takes
   * a `signal` where pi's takes a prefill (see `reasonBoxUi` below for why).
   * Everything else on the seam is pi's own, unchanged. One named cast beats a
   * bare `as` at every call site, which is where it would drift.
   */
  function asChoiceHost(ctx: unknown): { ui?: ChoiceUi; signal?: AbortSignal } {
    return ctx as { ui?: ChoiceUi; signal?: AbortSignal };
  }

/** pi's editor component CLASS, as a type — see `loadEditorComponent`. */
type EditorComponentCtor = (typeof import("@earendil-works/pi-coding-agent"))["ExtensionEditorComponent"];

  /**
   * pi's own multi-line editor component, resolved ON DEMAND.
   *
   * IT USED TO BE A MODULE-SCOPE VALUE IMPORT, and that broke the one case the
   * loader alias cannot cover: a host that loads this file OUTSIDE pi (the
   * install fixtures in test/, any tool that imports the extension to inspect
   * it) has no `@earendil-works/pi-coding-agent` to resolve, so a static import
   * fails at LOAD time — the whole extension refuses to load, to draw one
   * dialog. Resolved lazily it degrades instead: no component ⇒ the reason box
   * stays whatever the host's own `ui.editor` is (multi-line, no signal), and
   * nothing else changes.
   *
   * Inside pi the resolve always succeeds: the extension loader aliases this
   * specifier to pi's own entry (dist/core/extensions/loader.js `_aliases`,
   * `piCodingAgentEntry = packageIndex`), so no second copy is involved.
   */
  let editorComponent: Promise<EditorComponentCtor | undefined> | undefined;
  function loadEditorComponent(): Promise<EditorComponentCtor | undefined> {
    editorComponent ??= import("@earendil-works/pi-coding-agent")
      .then((pi) => pi.ExtensionEditorComponent)
      .catch(() => undefined);
    return editorComponent;
  }

  /**
   * The template's `ui` seam, with the reason box wired to pi's own editor.
   *
   * WHY NOT `ui.editor()` DIRECTLY (2026-09-17): pi's signature is
   * `editor(title, prefill?)` — no `signal`. This gate's dialog model rests on
   * a box being taken OFF THE SCREEN the moment the other side answers first
   * (lib/orchestrator-child-channel.ts), and a box that outlives its answer
   * collects typing nobody will ever read. The RULES for that — how the two
   * kinds of `undefined` are told apart, which host falls back to what, and how
   * the signal-less fallback still stops being waited on — live in
   * lib/reason-editor.ts; what is here is only the wiring.
   */
  async function reasonBoxUi(host: ChoiceUi | undefined): Promise<(ChoiceUi & MultiChoiceHost) | undefined> {
    const pi = host as (ChoiceUi & {
      custom?: ExtensionUIContext["custom"];
      editor?: ExtensionUIContext["editor"];
    }) | undefined;
    // `hostEditorFallback` reads the signal ITSELF and never forwards our opts
    // into pi's prefill slot (lib/reason-editor.ts states the trap).
    const own = pi?.editor ? hostEditorFallback(pi.editor.bind(pi)) : undefined;
    const custom = pi?.custom;
    const Component = custom ? await loadEditorComponent() : undefined;
    // THE CHECKBOX SHAPE NEEDS NO PI COMPONENT CLASS (2026-09-22): it renders
    // its own lines and only borrows `ui.custom` to get on screen. So it is
    // wired off the SAME `custom` the reason box uses, before the branch below.
    const multiSelect: MultiChoiceHost["multiSelect"] = custom
      ? (title, spec, opts = {}) => mountMultiChoice(custom.bind(pi) as CustomDialogHost, title, spec, opts)
      : undefined;
    // No pi package to resolve, or no custom components on this host (RPC):
    // the host's own editor — ADAPTED, never handed our options.
    if (!custom || !Component) {
      const ui = own ? { ...host, editor: own } : host;
      return multiSelect ? { ...ui, multiSelect } : ui;
    }
    return {
      ...host,
      ...(multiSelect ? { multiSelect } : {}),
      editor: hostReasonEditor({
        custom: custom.bind(pi) as CustomDialogHost,
        ...(own ? { fallback: own } : {}),
        // THE BOX HAS TWO WAYS OUT (user decision, 2026-09-19): ESC hands the
        // question BACK to its own list — carrying whatever was typed so far,
        // so backing out costs nothing — while the LIST's ESC stays what it
        // always was, closing the question (and, in an interview, stopping the
        // rest). The component's own text is read defensively; see
        // `editorTextOf` (lib/reason-editor.ts).
        build: (tui, keybindings, title, done, prefill) => {
          const component = new Component(
            tui as ConstructorParameters<EditorComponentCtor>[0],
            keybindings as ConstructorParameters<EditorComponentCtor>[1],
            title,
            prefill,
            done,
            () => done(`${REASON_EDITOR_BACK}${editorTextOf(component)}`),
          );
          return component;
        },
      }),
    };
  }

  /**
   * MOUNT THE CHECKBOX BOX onto pi's `ui.custom` — the same abort discipline
   * the reason box has (lib/reason-editor.ts), for the same reason: this
   * gate's dialogs are raced against a project manager's answer, and a box
   * that cannot be taken down collects ticks nobody will ever read.
   *
   * A HOST THAT CANNOT MOUNT IT SAYS SO (RPC resolves `undefined` WITHOUT
   * running the factory). That `undefined` is then the caller's own “nothing
   * was shown”, never an invented empty answer.
   */
  function mountMultiChoice(
    custom: CustomDialogHost,
    title: string,
    spec: ChoiceSpec,
    opts: { signal?: AbortSignal; back?: boolean } = {},
  ): Promise<MultiSelectOutcome | undefined> {
    if (opts.signal?.aborted) return Promise.resolve({ kind: "dismissed" });
    let ran = false;
    return custom<MultiSelectOutcome | undefined>((tui, theme, keybindings, done) => {
      ran = true;
      let settled = false;
      const finish = (value: MultiSelectOutcome | undefined) => {
        if (settled) return;
        settled = true;
        done(value);
      };
      opts.signal?.addEventListener("abort", () => finish({ kind: "dismissed" }), { once: true });
      if (opts.signal?.aborted) queueMicrotask(() => finish({ kind: "dismissed" }));
      return buildMultiChoiceBox({
        title,
        spec,
        ...(opts.back ? { back: true } : {}),
        theme: theme as unknown as MultiChoiceTheme,
        readKey: multiChoiceKeyReader(keybindings),
        done: finish,
        requestRender: () => (tui as { requestRender?: () => void } | undefined)?.requestRender?.(),
      });
    }).then((outcome) =>
      // THE FACTORY NEVER RUNNING IS NOT A CLOSED BOX (reviewer P2, 2026-09-22):
      // RPC resolves `undefined` WITHOUT mounting anything, and reading that as
      // "the user dismissed it" stopped the whole interview over a question
      // nobody was ever shown.
      (ran ? outcome : { kind: "unavailable" as const }));
  }

  /**
   * THE HOST'S OWN KEY READER — pi's keybindings, so the checkbox box follows
   * whatever protocol the terminal negotiated and whatever the user rebound
   * `tui.select.*` to (reviewer P1, 2026-09-22: a terminal on the Kitty
   * keyboard protocol sends ESC as `\u001b[27u`, which a raw-byte table missed
   * entirely — the box could not be closed at all). Space is not one of pi's
   * select keybindings, so it falls through to the shape's own reader.
   */
  function multiChoiceKeyReader(keybindings: unknown): MultiChoiceKeyReader {
    const kb = keybindings as { matches?: (data: string, keybinding: string) => boolean } | undefined;
    return (data) => {
      if (kb?.matches) {
        if (kb.matches(data, "tui.select.up")) return "up";
        if (kb.matches(data, "tui.select.down")) return "down";
        if (kb.matches(data, "tui.select.confirm")) return "enter";
        if (kb.matches(data, "tui.select.cancel")) return "escape";
      }
      return defaultMultiChoiceKey(data);
    };
  }

  /**
   * ONE BOX AT A TIME, PER SESSION (2026-09-18).
   *
   * pi executes the tool calls of one assistant message in parallel, and the
   * host has one dialog slot: a second box REPLACES the first and the replaced
   * one's promise is never settled again — which hangs the first tool, the
   * batch, and the turn (lib/choice-dialog.ts `createDialogQueue` states the
   * measurement). Every dialog goes through `askChoice`, so the queue lives
   * here and covers all of them at once.
   */
  const scheduleDialog = createDialogQueue();

  /**
   * ASK THE PROXY (2026-09-19) — what happens when a dialog waits thirty
   * minutes with nobody at the terminal.
   *
   * NO ARBITER, NO PROXY: an unconfigured arbiter resolves to no model, and
   * this returns `undefined` — which the dialog reads exactly as it reads a
   * closed box, so a gate with no arbiter still cannot grant anything by
   * omission. Same fail-closed shape the arbitration paths use.
   *
   * The prompt carries a TRANSCRIPT POINTER, not the transcript: the proxy is a
   * one-shot process (lib/arbitration.ts) and is told where to read the
   * conversation rather than handed it — the choice `lib/adviser-brief.ts` makes
   * too, for the same reason (a session log dwarfs the question).
   */
  async function proxyAnswerFor(spec: ChoiceSpec, body: string | undefined, root: string): Promise<ProxyChoice | undefined> {
    const model = resolveArbiterModel();
    if (!model) return undefined;
    const transcript = ownTranscriptPath();
    const prompt = buildProxyPrompt({
      title: spec.title,
      // THE ROWS THE USER WOULD HAVE SEEN, verbatim, and the ONLY values the
      // answer may take: `raceWithUserProxy` refuses anything else, which is what
      // makes a proxied answer indistinguishable downstream.
      options: spec.options,
      // A CHECKBOX QUESTION TAKES SEVERAL (2026-09-22): the proxy may name
      // several rows, and the check that accepts them widens by SHAPE only.
      ...(spec.defaultChecked === undefined ? {} : { multiple: true }),
      ...(body === undefined ? {} : { body }),
      ...(transcript === undefined ? {} : { transcript }),
      // WHICH REPO THE PROXY IS ASKED ABOUT (review round 3 P1): the same one
      // its decision will be filed under. Reading it twice would let the prompt
      // and the sidecar disagree.
      repoRoot: root,
    });
    const raw = await runArbiterProcess(
      model, prompt, undefined, PROXY_ARBITER_TIMEOUT_MS, PROXY_SYSTEM_PROMPT,
      // THE READ-ONLY SET, NOT `--no-tools` (review round 2 P1). The appeal
      // arbiter's isolation is text-in/JSON-out; this one is asked to READ the
      // session, and a prompt carrying a transcript pointer is worthless to a
      // process that cannot open a file.
      PROXY_ISOLATION_FLAGS,
    );
    return parseProxyDecision(raw);
  }

  /**
   * WRITE THE DECISION WHERE THE USER WILL SEE IT (2026-09-19).
   *
   * This is the whole safety story of the proxy: downstream its answer is
   * indistinguishable from the user's own — it opens the same doors. The only
   * thing that keeps that honest is that it is VISIBLE, in three places: this
   * state record, a notice in the session, and the completion report
   * `declare_done` prints. A proxy decision that left no trace would be an
   * authorization the user never gave and cannot discover.
   */
  function recordProxyDecision(
    spec: ChoiceSpec,
    choice: string,
    byProxy: { rationale: string; at: string },
    /**
     * WHICH REPO'S SIDE CAR (review round 2 P1). The dialog does not know, and
     * `askChoice` is ONE function for all twelve sites — so the caller resolves
     * it. A decision recorded under the primary repo while its question belonged
     * to a secondary one lands in the wrong sidecar AND is missing from that
     * repo's completion report.
     */
    root: string,
  ): void {
    const st = stateForRepo(root);
    st.proxyDecisions = [
      ...(st.proxyDecisions ?? []),
      {
        at: byProxy.at,
        question: spec.title,
        options: [...spec.options],
        choice,
        rationale: byProxy.rationale,
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      },
    ];
    // `persistRepo`, not `persist`: the latter writes the CURRENT repo's
    // sidecar, and the decision belongs to `root` (review round 2 P1).
    if (latestCtx) persistRepo(latestCtx, root);
    try {
      latestCtx?.ui.notify(
        `review-gate: 对话框等了 30 分钟无人作答，已由 arbiter 代为决定 —— 「${spec.title}」→ ${choice}` +
          (byProxy.rationale ? `\n依据：${byProxy.rationale}` : "") +
          "\n这条会记入 declare_done 的完成报告；你回来可以推翻它（重新走一遍对应的步骤即可）。",
        "warning",
      );
    } catch { /* headless */ }
  }

  /**
   * EVERY PROXY DECISION OF THIS SESSION, ACROSS EVERY REPO IT TOUCHED
   * (review round 2 P1). `declare_done` runs ONCE for the session, while each
   * decision belongs to whichever repo its dialog was about — reading only the
   * primary repo's sidecar would silently omit the rest, and an incomplete list
   * reads as "that was all of them", which is the one thing this record cannot
   * get wrong.
   *
   * Deduped by (time, question, choice): a session that touched the same repo
   * twice must not print the same decision twice either.
   */
  function allProxyDecisions(): NonNullable<GateState["proxyDecisions"]> {
    // The dedupe lives in `mergeProxyDecisions` (哲学三: one implementation) —
    // this is the same union, folded over more than two sessions.
    let out: NonNullable<GateState["proxyDecisions"]> = [];
    for (const root of sessionRepos) {
      out = mergeProxyDecisions(out, stateForRepo(root).proxyDecisions);
    }
    return out;
  }

  /**
   * THE one dialog renderer (user decision, 2026-09-08): the gate's question
   * template, whole. Every dialog in this file — and
   * every dialog in the tool modules that inject this function — comes
   * through here, so exactly one shape ever reaches the screen: 2–4 options
   * (the recommended one marked), the `✎ 不选，我说明原因` row, and a text
   * box when that row is picked. A yes/no box is not a thing any more.
   *
   * NOTHING IS FITTED, NOTHING IS CUT (user decision, 2026-09-16). Both halves
   * used to be budgeted against the real terminal — a five-row dialog spends
   * rows the old two-row confirm never did — because an oversized dialog pushed
   * the animating spinner out of the viewport and made pi's DEFAULT renderer
   * clear the screen and the scrollback every frame (measured: 29 of 30 frames).
   * That cost landed on the lines the user is CONFIRMING, and the renderer the
   * user runs (fullscreen: the host owns the screen and scrolls) never had the
   * problem — so the budget is gone and a session that is NOT on it is told
   * once instead (lib/renderer-mode.ts).
   *
   * WHAT STILL MATTERS HERE IS ORDER. Callers put the facts being confirmed
   * BEFORE the agent's own text, because the box is read top-down and the
   * thing being approved should not come after the label of the thing it is
   * about (lib/loop-goal.ts states the policy for the goal dialog).
   *
   * `signal` is what lets an ORCHESTRATOR's answer take the box off the
   * user's screen: pi dismisses the dialog when it aborts, and the resolved
   * `undefined` is then read as "somebody else settled this", not as a
   * refusal (lib/orchestrator-child-channel.ts owns that distinction).
   */
  async function askDialog(
    uiCtx: { ui?: ChoiceUi; signal?: AbortSignal },
    spec: ChoiceSpec,
    opts: {
      body?: string;
      signal?: AbortSignal;
      back?: boolean;
      repo?: string;
      onUndecided?: () => void;
      /**
       * MAY THE ARBITER STAND IN FOR THE USER on this question?
       *
       * Default true — every dialog carries the thirty-minute hand-off
       * (lib/user-proxy.ts, user decision 2026-09-19). `false` is for the one
       * question a machine has no business answering: the stage checklist,
       * where a partial stand-in answer would switch gates OFF. The window
       * still runs; its expiry is the ordinary “nobody decided” landing.
       */
      proxy?: boolean;
    } = {},
    /**
     * WHICH OF THE TWO SHAPES IS DRAWN (2026-09-22). Everything else about a
     * dialog is shape-free — the queue, the banner, the thirty-minute proxy
     * race and the record all belong to the WORDS being asked, not to how the
     * rows are drawn — so the shape travels as this one flag rather than as a
     * second copy of a five-hundred-line function.
     */
    checkbox = false,
  ): Promise<string | undefined> {
    // THE HOST'S SIGNAL IS READ HERE, BEFORE QUEUEING: `ExtensionContext.signal`
    // is a getter that asserts the context is still alive, and a dialog can wait
    // a long time for its turn. Read once and captured, not read again inside.
    //
    // THE RACE'S OWN SIGNAL IS MERGED IN HERE (2026-09-19), not at the queue
    // call alone: the queue slot and the box on screen are the SAME dialog, and
    // both have to end when the race settles. A proxy answer that released the
    // queue wait while leaving `renderChoice` on screen would be a dialog the
    // user can still type into and nobody will ever read.
    const settledBy = new AbortController();
    const signal = dialogSignal(uiCtx.signal, opts.signal, settledBy.signal);
    // A BOX THAT IS ALREADY SETTLED IS NOT RAISED, AND NOT ANNOUNCED: the queue
    // drops a waiter whose signal aborts (before OR during its turn) without
    // raising anything or ringing a banner — telling the user to come answer
    // something nobody is asking any more is the same mistake.
    // THE WINDOW STARTS WHEN THE BOX DOES (2026-09-19). `askChoice` may be one
    // of several calls in a single assistant message, and the dialog queue shows
    // ONE box at a time — so a queued question could reach its thirty minutes
    // before the user ever saw it (review round 1). `displayed` resolves inside
    // the queue work below, which is the moment this dialog owns the screen.
    let markDisplayed: (() => void) | undefined;
    const displayed = new Promise<void>((resolve) => { markDisplayed = resolve; });
    // WHICH REPO, BOUND WHEN THE BOX APPEARS (review round 3 P1). The answer
    // belongs to the work this session was doing when the user would have SEEN
    // the question — and `activeRepoRoot.current` follows the edits, so a dialog
    // queued behind another one, or a thirty-minute wait, can move it. Bound on
    // the queue's own turn and never re-read: fixing the sidecar's repo while
    // the proxy reads a different one is the same defect from the other end.
    //
    // AN EXPLICIT `opts.repo` OUTRANKS IT AND NEVER DRIFTS (review round 4 P1):
    // callers that KNOW which repo their question is about (a goal, a
    // restatement) must say so — a secondary repo's question can be raised
    // without that repo ever having been the active one, and then the fallback
    // would file a stand-in's answer under the wrong sidecar AND point the proxy
    // at the wrong repository.
    const dialogRootNow = (): string => opts.repo ?? activeRepoRoot.current ?? primaryRepoRoot;
    let dialogRoot = dialogRootNow();
    const asked = scheduleDialog(async () => {
      markDisplayed?.();
      dialogRoot = dialogRootNow();
      // KIND THREE of three, and this is the whole wiring for it: EVERY dialog
      // any session shows comes through this function, so "the gate has stopped
      // and is waiting for the human" needs no second detector. The policy
      // decides who may be told (a child session's questions belong to its
      // manager, and the manager answers them) and the throttle keeps a
      // re-opened dialog from ringing again.
      //
      // WAITING, NOT ANSWERING: the banner goes out as the box appears, which
      // is the moment somebody who is NOT at the terminal needs to know. The
      // phrase being asked for rides along (body included) — a banner whose
      // whole text is "问题 1 / 4" tells the user nothing about what they are
      // being asked (user report, 2026-09-18).
      raiseBanner({
        kind: "needs-user",
        detail: dialogNotifyDetail(spec, opts.body),
      });
      // NO BUDGET, NO TRUNCATION (user decision, 2026-09-16). This used to fit
      // the title and the body into a rendered-row budget, because a dialog tall
      // enough to push the spinner out of the viewport made pi's DEFAULT renderer
      // clear the screen and the scrollback every frame. That cost landed on the
      // lines the user is confirming — a long repo path could take the station
      // line and the audit line with it while the dialog went on asking for
      // approval — and the renderer the user runs (`fullscreen`, the host owns
      // the screen and scrolls) never had the problem. A session that is NOT on
      // it is told once instead: see lib/renderer-mode.ts.
      //
      // THE HOST'S ABORT SIGNAL TRAVELS WITH IT (2026-09-18): `uiCtx.signal` is
      // `ExtensionContext.signal`, which is what an ESC aborts. Passing only the
      // caller's own signal left a box on screen after the user cancelled the
      // run, and the tool waiting on it never came back.
      const answerBox = await reasonBoxUi(uiCtx.ui);
      const answer = checkbox
        ? await renderMultiChoice(answerBox, spec, {
          ...(opts.body === undefined ? {} : { body: opts.body }),
          ...(opts.back ? { back: true } : {}),
          ...(signal ? { signal } : {}),
        })
        : await renderChoice(answerBox, spec, {
          ...(opts.body === undefined ? {} : { body: opts.body }),
          ...(opts.back ? { back: true } : {}),
          ...(signal ? { signal } : {}),
        });
      // THE ONE PLACE A GATE↔USER EXCHANGE IS RECORDED (2026-09-16). Every
      // dialog the gate shows — ask_user's interview, the restatement / goal /
      // plan approvals, the consent boxes for sensitive edits and scope limits —
      // reaches the user through this function, so this is where "the user
      // answered" becomes a fact. Its one reader is the stall breaker
      // (`stallInMotion`): a live negotiation must not be mistaken for a session
      // that has stopped moving (measured: 80 minutes of goal negotiation
      // tripped the breaker and was reported as a provider failure).
      //
      // Only a REAL answer counts: a dismissed box (undefined) is not the user
      // engaging with the gate — and neither is the checklist sentinel, which
      // says the opposite of “the user did something”: NO host could draw that
      // question (quality round P2, 2026-09-22).
      if (answer !== undefined && answer !== MULTI_UNAVAILABLE) {
        lastUserInteractionAt = new Date().toISOString();
      }
      return answer;
    }, signal);

    // THE THIRTY-MINUTE HAND-OFF (2026-09-19, user decision). The box above is
    // unchanged — not closed, not shortened, and a user who answers at minute 29
    // wins outright. What is new is that minute 30 no longer means "nobody will
    // ever answer": `arbiter` reads this session's own context and takes the
    // user's place, and what it answers is recorded as a proxy decision (see
    // `recordProxyDecision`) so the user can find it afterwards.
    //
    // THE RACE IS NOT WRITTEN HERE. Timing, the row check and the
    // human-always-wins rule live in lib/user-proxy.ts, the only arrangement
    // that makes them testable without waiting half an hour — this function is
    // the single render point for all twelve dialogs and stays wiring.
    const decided = await raceWithUserProxy<string>({
      direct: asked,
      displayed,
      // NO PROXY FOR A QUESTION A MACHINE MUST NOT ANSWER (quality round P1,
      // 2026-09-22). An empty option list IS how lib/user-proxy.ts turns the
      // arbiter off: the window still runs and its expiry still settles as
      // “nobody answered”, so an unattended session unblocks exactly as before —
      // it just does not get a machine-made decision. The one caller that asks
      // for this is the stage checklist (`choose_loop_stages`): a stand-in that
      // ticks a SUBSET of its rows would silently switch OFF the unticked
      // gates, which is the opposite of what that dialog is for.
      options: opts.proxy === false ? [] : spec.options,
      ...(spec.defaultChecked === undefined ? {} : { multiple: true }),
      startProxy: () => proxyAnswerFor(spec, opts.body, dialogRoot),
    });
    // Whatever settled it, the box is done — see `settledBy` above.
    settledBy.abort();
    if (decided.byProxy !== undefined && decided.answer !== undefined) {
      recordProxyDecision(spec, decided.answer, decided.byProxy, dialogRoot);
    } else if (decided.proxyFailed === true) {
      // NOBODY DECIDED, AND THE USER IS NOT HERE. Say so: a dialog that times
      // out silently is indistinguishable, to the user, from one that was
      // answered — and this is the only moment the fact exists. The gate does
      // NOT invent an answer here; the conservative landing is the absence of
      // one, which every caller already reads correctly.
      //
      // THE CALLER IS TOLD TOO (review round 3 P1): `undefined` alone cannot
      // distinguish this from a dismissed box, and for a consent request those
      // two must not have the same consequence — a decline LOCKS the request
      // for the session, and a timeout is not a decline.
      try {
        // THE NOTICE MUST NOT BLAME THE ARBITER FOR A CHOICE WE MADE (quality
        // round P2, 2026-09-22): with `proxy: false` the stand-in was switched
        // off on purpose, and the generic “arbiter 无法代答（未配置 / 失败 / 输出
        // 不可解析）” would tell the user their machine is broken.
        latestCtx?.ui.notify(
          opts.proxy === false
            ? `review-gate: 对话框「${spec.title}」等了 30 分钟无人作答 —— 这一题**不问 arbiter 代答**` +
              "（机器不替用户决定这一类问题），所以还没有任何决定，等你回来处理。"
            : `review-gate: 对话框「${spec.title}」等了 30 分钟无人作答，且 arbiter 无法代答` +
              "（未配置 / 失败 / 输出不可解析）—— 这一项**还没有任何决定**，等你回来处理。",
          "warning",
        );
      } catch { /* headless */ }
      try { opts.onUndecided?.(); } catch { /* the caller's own bookkeeping */ }
    }
    return decided.answer;
  }

  /** The radio shape — one answer (lib/choice-dialog.ts). */
  async function askChoice(
    uiCtx: { ui?: ChoiceUi; signal?: AbortSignal },
    spec: ChoiceSpec,
    opts: { body?: string; signal?: AbortSignal; back?: boolean; repo?: string; onUndecided?: () => void } = {},
  ): Promise<string | undefined> {
    return askDialog(uiCtx, spec, opts, false);
  }

  /** The checkbox shape — several answers (lib/multi-choice-dialog.ts). */
  async function askMultiChoice(
    uiCtx: { ui?: ChoiceUi; signal?: AbortSignal },
    spec: ChoiceSpec,
    opts: { body?: string; signal?: AbortSignal; back?: boolean; repo?: string; onUndecided?: () => void; proxy?: boolean } = {},
  ): Promise<string | undefined> {
    return askDialog(uiCtx, spec, opts, true);
  }

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
    orchestratorContinuations = 0; // goal 6 — reset with the loop budget
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

  /**
   * Full post-edit file projection (lib/edit-projection.ts). Scanning the
   * complete projected file — not newText fragments — closes the reviewer's
   * P1 bypass: an edit replacing just a label STRING (`'old label'` →
   * `'ceshi denglu'`) still yields a file where the lexer sees the
   * surrounding `it(...)` call.
   */
  function editedTestContent(input: Record<string, unknown>, path: string): string {
    return projectEditedContent(input, () => {
      // P2 fix: resolve relative tool paths against the SESSION cwd, not the
      // extension host's process.cwd() (they can differ under pi --cwd).
      const abs = path.startsWith("/") ? path : pathJoin(cwd, path);
      try { return readFileSync(abs, "utf8"); } catch { return undefined; }
    });
  }

  /**
   * L6 moved LEFT: the git-hook scanner (scripts/scan-test-labels.cjs) stays
   * the deterministic, zero-dependency backstop at commit time; here the SAME
   * lexer runs at edit time for immediate feedback, plus the flash semantic
   * layer for the Unicode blind spot (romanized non-English labels). Both are
   * tighten-only; scanner load/parse failure → pass (hook still enforces).
   */
  /** Cache of romanized-non-English verdicts, keyed by the exact label set
   *  (lib/llm-classify.ts documents why a failed call is never remembered). */
  const labelCheckMemo = createVerdictMemo();

  /** Status-bar line the gate owns for its LLM-guard notices. */
  const LLM_STATUS_KEY = "review-gate-llm";
  /**
   * The status bar of a HOOK's context.
   *
   * A `tool_call` handler has no `onUpdate` (that is a tool's channel), so a
   * multi-second classification would look like a frozen editor. The status
   * line is the one surface a hook has, and `withSlowNotice` only ever uses
   * it when the call is actually slow.
   */
  function llmNoticeUi(ctx: unknown): { setStatus?: (key: string, text: string | undefined) => void } | undefined {
    return (ctx as { ui?: { setStatus?: (key: string, text: string | undefined) => void } } | undefined)?.ui;
  }

  async function checkTestLabels(
    path: string,
    content: string,
    /** The hook's context: status-bar notices, and persisting a spent appeal pass. */
    ctx: unknown,
    /** Status-bar sink: an L6 classification slower than ~3s says so. */
    notice?: SlowNoticeSink,
  ): Promise<string | undefined> {
    if (!content) return undefined;
    let analyze: ((p: string, src: string) => { violations: Array<{ line: number; label: string }>; latinLabels: Array<{ line: number; label: string }> }) | undefined;
    let isTest: ((p: string) => boolean) | undefined;
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      // P1 fix: probe every install layout, mirroring resolveTrustedRunner().
      // The old single "../scripts/…" path only resolved in the dev repo
      // (extensions/ sibling); global installs put the extension in
      // extensions/pi-review-gate/ with scripts/ TWO levels up, so the
      // edit-time L6 check silently never ran in any installed layout.
      let mod: { analyzeFile?: typeof analyze; isTestFile?: typeof isTest } | undefined;
      for (const rel of [
        "../scripts/scan-test-labels.cjs",       // dev repo: extensions/ sibling
        "../../scripts/scan-test-labels.cjs",    // global/project: extensions/pi-review-gate/
        "./scripts/scan-test-labels.cjs",        // flat layout
      ]) {
        try { mod = req(rel); break; } catch { /* keep probing */ }
      }
      if (!mod) return undefined; /* scanner unavailable — hook backstop remains */
      analyze = mod.analyzeFile; isTest = mod.isTestFile;
    } catch { return undefined; /* scanner unavailable — hook backstop remains */ }
    // Classify on the RESOLVED path, for the same reason the sensitive-file
    // guard does: `foo.test.ts/x/..` names a test file that a segment-based
    // matcher would miss. (Such a spelling also fails at the fs layer and the
    // L3 hook scans the real committed paths, so this is consistency rather
    // than a hole being closed.) Messages keep the caller's spelling — that is
    // what the agent typed and can act on.
    if (!analyze || !isTest || !isTest(normalizeSensitivePath(path, cwd))) return undefined;
    let res: ReturnType<typeof analyze>;
    try { res = analyze(path, content); } catch { return undefined; }
    if (res.violations.length > 0) {
      const v = res.violations[0];
      return refuseText("test-label", v.label,
        `${l5BlockReason({ kind: "test-label", text: v.label })} 位置 ${path}:${v.line}。` +
        "测试描述必须是英文；确属特例时在上一行加 `// review-gate: allow-non-english`。", ctx);
    }
    // Unicode check passed — flash semantic layer for romanized non-English.
    if (projectConfig.llmGuards.englishCheck && res.latinLabels.length > 0) {
      const labels = res.latinLabels.map((l) => l.label);
      // Memoized on the exact label SET: an agent editing the same test file
      // repeatedly re-sent an identical label list and blocked each edit on a
      // ~2s model round-trip for an answer that cannot have changed.
      const key = labelCheckMemo.key(labels);
      let verdict = labelCheckMemo.get(key);
      if (verdict === undefined) {
        verdict = await withSlowNotice(
          notice,
          "review-gate: 正在做 L6 测试标签分类（语义判定）…",
          () => classifyNonEnglish(classifier(), labels),
        );
        labelCheckMemo.remember(key, verdict);
      }
      if (verdict === true) {
        return refuseText("test-label", labels.join("\n"),
          `test label reads as romanized non-English (L6, semantic check) in ${path}. ` +
          "测试描述必须是英文；确属特例时用 `// review-gate: allow-non-english` 豁免。", ctx);
      }
    }
    return undefined;
  }

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
      statusNotice(llmNoticeUi(ctx), LLM_STATUS_KEY),
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
    notice: (ctx) => statusNotice(llmNoticeUi(ctx), LLM_STATUS_KEY),
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
    lastToolActivity = describeToolActivity(
      String((event as { toolName?: unknown }).toolName ?? ""),
      (event as { input?: unknown }).input,
    );
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

  // Compute the current binding material for a parsed arbitrable action: hash
  // each --body-file's (path + content) so replacing the file after issue
  // invalidates the token.
  async function computeTokenBindings(action: ArbitrableAction, fingerprint: string): Promise<TokenBindings> {
    return {
      sessionId: state.sessionId,
      kind: action.kind,
      fingerprint,
      round: state.rounds.length,
      commandDigest: action.commandDigest,
      bodyFileDigest: bodyFileDigest(action.bodyFilePaths),
    };
  }


  /**
   * The arbiter model, resolved from the agents config layer (arbiter role).
   *
   * The arbiter USED to be a hard-coded constant (project-config's
   * DEFAULT_ARBITER_MODEL). Per the all-roles-through-config requirement it
   * now comes from agents.arbiter.slots[0]. Absent/unconfigured → undefined,
   * which callers treat as fail-closed (no arbiter, GATE_WINS).
   */
  function resolveArbiterModel(): string | undefined {
    try {
      const { map } = effectiveAgentsConfig(projectConfig.agentsGlobal, projectConfig.agentsProject);
      const arbiter = map.arbiter;
      if (arbiter && arbiter.auto === false && arbiter.slots.length > 0) return arbiter.slots[0]!;
      // NO BUILT-IN DEFAULT (criterion 1): an unconfigured arbiter returns
      // undefined and the caller fails closed (GATE_WINS). The legacy
      // projectConfig.arbiter.model field is NOT a fallback — its default
      // value is the hard-coded DEFAULT_ARBITER_MODEL, which this
      // requirement removes.
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Hear an appeal against an A-class TEXT block (lib/text-appeal.ts).
   *
   * Same shape as the `gh pr edit` arbitration below it — an independent
   * arbiter process, fail-closed on any failure — but what it may grant is a
   * CONTENT-bound single-use pass, never a command. The four brakes live in
   * the pure module; this function only does the I/O around them.
   */
  async function arbitrateText(
    block: AppealableBlock,
    argument: string,
    ctx: unknown,
  ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
    const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
    const digest = appealDigest(block.kind, block.text);
    const admission = admitAppeal(state.appeals, digest, projectConfig.arbiter.maxPerSession);
    if (!admission.ok) return deny(`review-gate: ${admission.reason}`);

    const verdict = await runArbiter(
      resolveArbiterModel() ?? "",
      buildTextAppealPrompt(block, argument),
      undefined,
      undefined,
      TEXT_APPEAL_SYSTEM_PROMPT,
    );
    // Fail-closed: a spawn failure, a timeout or an unparseable answer is a
    // GATE_WINS — and it still SPENDS the quota, so a broken arbiter cannot be
    // retried into a grant.
    const decision = verdict?.decision ?? "GATE_WINS";
    state.appeals = recordAppealDecision(state.appeals, digest, block.kind, decision, new Date().toISOString());
    persist(ctx as unknown as ExtensionContext);
    appendLesson(`text appeal (${block.kind}) decision=${decision} reason=${JSON.stringify(verdict?.reason ?? "(no verdict → GATE_WINS)")} text=${block.text.slice(0, 120)}`);
    if (decision === "AGENT_WINS") {
      return {
        content: [{
          type: "text",
          text: `review-gate: 仲裁者判定 AGENT_WINS — ${verdict?.reason ?? ""}\n` +
            "已对这段内容发放一次性通行证：把**完全相同**的文本再提交一次即可通过（改一个字就失效）。" +
            "它只放行这段文本，不影响代码审查与 precommit 门禁。",
        }],
        details: { decision, kind: block.kind, used: appealsUsed() },
      };
    }
    if (decision === "HUMAN") {
      return deny(
        `review-gate: 仲裁者把判断交给人 — ${verdict?.reason ?? ""}\n` +
        "本次不放行。要么改文案，要么请用户直接定夺（这条已计入配额）。",
      );
    }
    return deny(
      `review-gate: 仲裁者判定 GATE_WINS — ${verdict?.reason ?? "无有效裁决（fail-closed）"}。` +
      "按门禁要求改文案；同一段内容不能再申诉。",
    );
  }

  /**
   * Hear an appeal against a ZERO-INSPECTION READY refusal (the judge-side
   * class, lib/inspection-appeal.ts).
   *
   * Same three-part shape as the two appeals above — admission in the pure
   * module, an independent arbiter process, fail-closed on every failure —
   * and what it may grant is the narrowest thing in the gate: this judge's
   * THIS round may conclude READY once despite having inspected nothing. It
   * issues no bypass token, touches no verdict, and cannot reach a ship
   * command. The pass lives in memory because the round does.
   */
  async function arbitrateInspection(
    block: InspectionBlock,
    argument: string,
    ctx: unknown,
  ): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean }> {
    const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
    const key = inspectionDecisionKey(block.judgeId, block.round);
    const admission = admitInspectionAppeal({
      decided: arbitrationDecisions.get(key),
      used: appealsUsed(),
      maxPerSession: projectConfig.arbiter.maxPerSession,
    });
    if (!admission.ok) return deny(`review-gate: ${admission.reason}`);

    // The quota is SHARED with the two other classes, and it is spent BEFORE
    // the arbiter runs: a spawn that dies must not be retried into a grant.
    spendArbitration(ctx);
    const verdict = await runArbiter(
      resolveArbiterModel() ?? "",
      buildInspectionAppealPrompt(block, argument),
      undefined,
      undefined,
      INSPECTION_APPEAL_SYSTEM_PROMPT,
    );
    // Fail-closed, and the quota is spent either way: a broken arbiter cannot
    // be retried into a grant.
    const decision = verdict?.decision ?? "GATE_WINS";
    arbitrationDecisions.set(key, decision);
    appendLesson(
      `inspection appeal (${block.role} round ${block.round}) decision=${decision} ` +
      `reason=${JSON.stringify(verdict?.reason ?? "(no verdict → GATE_WINS)")} arg=${argument.slice(0, 200)}`,
    );
    if (decision === "AGENT_WINS") {
      inspectionPass = issueInspectionPass(block, Date.now());
      return {
        content: [{ type: "text", text: inspectionGrantedText(verdict?.reason ?? "") }],
        details: { decision, round: block.round, used: appealsUsed() },
      };
    }
    return deny(inspectionDeniedText(decision, verdict?.reason ?? ""));
  }


  function bodyFileDigest(paths: readonly string[]): string {
    if (paths.length === 0) return "";
    const parts: string[] = [];
    for (const p of paths) {
      let content = "";
      try { content = readFileSync(p.startsWith("/") ? p : pathJoin(cwd, p), "utf8"); } catch { content = "\0MISSING"; }
      parts.push(sha256(p + "\0" + content));
    }
    return sha256(parts.join("\0"));
  }

  function appendLesson(text: string) {
    try {
      const logPath = pathJoin(cwd, ".pi", "review-gate-arbitration.log");
      mkdirSync(pathDirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`);
    } catch { /* best effort audit log */ }
  }

  /**
   * Best-effort audit line for gate decisions the transcript alone cannot be
   * trusted to preserve: sensitive-file grants (issued/consumed) and loop-goal
   * approvals. All three are USER consent events — the one class of fact that
   * must stay checkable after a compaction, a crash, or a session the agent
   * later summarizes in its own words.
   *
   * This function was CALLED from three places before it existed: ESM only
   * throws `log is not defined` when the line finally runs, so every
   * propose_loop_goal / request_sensitive_edit approval crashed in front of the
   * user. `npm run typecheck` (TS2304) now catches that class before shipping.
   *
   * Writes under the REPO ROOT's `.pi/` — gate-owned, so it is excluded from
   * the fingerprint and from edit tracking: auditing a decision must never
   * invalidate the review binding the decision belongs to. Anchoring on the
   * session `cwd` instead would break exactly that when Pi runs in a
   * subdirectory of the repo, because `:/.pi` only excludes the ROOT one —
   * `<root>/sub/.pi/audit.log` is an ordinary worktree file, and appending to
   * it would move the digest under a recorded READY.
   */
  function log(text: string): void {
    try {
      const logPath = pathJoin(primaryRepoRoot, ".pi", "review-gate-audit.log");
      mkdirSync(pathDirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} [${state.sessionId ?? "no-session"}] ${text}\n`);
    } catch { /* best effort audit log */ }
  }

  // Evidence gatherers for the arbiter (the arbiter is tool-less; the extension
  // fetches trusted ground truth). All are best-effort read-only and degrade to
  // an explicit "unavailable" note rather than throwing.
  function runReadOnly(argv: string[], extraEnv?: Record<string, string>): string | undefined {
    try {
      return execFileSync(argv[0], argv.slice(1), {
        cwd, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      }).trim();
    } catch { return undefined; }
  }

  function gatherPrText(action: ArbitrableAction): string {
    // Query the SAME PR the blocked command targets: mirror its selector, repo,
    // and hostname so the arbiter's ground truth matches the action under
    // review (not the current branch's default PR). All values come from the
    // parsed, validated action (argv, never a shell).
    const argv = ["gh", "pr", "view"];
    if (action.selector) argv.push(action.selector);
    if (action.repo) argv.push("--repo", action.repo);
    argv.push("--json", "number,title,body,url");
    // P1 fix: `gh pr view` has NO --hostname flag (that spelling would make gh
    // exit with a usage error and the evidence degrade to "unavailable").
    // gh selects the host via the GH_HOST environment variable instead.
    const out = runReadOnly(argv, action.hostname ? { GH_HOST: action.hostname } : undefined);
    return out ?? "(current PR text unavailable — `gh pr view` failed; arbiter should weigh this as missing evidence)";
  }

  function gatherProposedText(action: ArbitrableAction): string {
    if (action.bodyFilePaths.length === 0) return "(no --body-file; inline --title/--body is inside the blocked command shown above)";
    const parts: string[] = [];
    for (const p of action.bodyFilePaths) {
      try {
        const abs = p.startsWith("/") ? p : pathJoin(cwd, p);
        parts.push(`--- ${p} ---\n${readFileSync(abs, "utf8")}`);
      } catch { parts.push(`--- ${p} ---\n(unreadable)`); }
    }
    return parts.join("\n\n");
  }

  function gatherGitLog(_cwd: string): string {
    return runReadOnly(["git", "log", "--oneline", "-15"]) ?? "(git log unavailable)";
  }

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
        inFlightPrecommit?.root === root &&
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
        const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
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
              const out = execFileSync("git", ["show", `${manifestBase}:package.json`], { cwd: root, encoding: "utf8" }) as string;
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
          // the message from the note via checkpointMessage(note) — so pass
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
        const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
          cwd: root,
          encoding: "utf8",
        }).split("\0").filter((p) => p.length > 0);
        const leftOut = planCheckpointSweep({ untracked, own: st.sessionEditedFiles ?? [] }).leftOut;
        execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
        if (leftOut.length > 0) {
          // Unstage, do not skip: `add -A` is still the right primitive for
          // the tracked half (deletes and renames included), and `reset`
          // leaves the leftover files exactly where they were — untracked, in
          // the worktree, and named in the receipt.
          execFileSync("git", ["reset", "-q", "--", ...leftOut], { cwd: root, encoding: "utf8" });
        }
        execFileSync("git", ["commit", "-m", message], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, REVIEW_GATE_BYPASS: "1" },
        });
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
        // THE COMMITTED FILES, READ FROM THE COMMIT (drill F4). The receipt
        // used to describe the WORKTREE — which is how the symlink above could
        // be committed without ever appearing in it — so it now reports what
        // the commit actually carries.
        const sweptIn = execFileSync(
          "git",
          ["diff-tree", "-r", "--no-commit-id", "--name-only", "-z", "--root", sha],
          { cwd: root, encoding: "utf8" },
        ).split("\0").filter((p) => p.length > 0);
        // Round-4 P2: the sha is persisted so prepare_review can compute
        // baseline..HEAD against it. Round-8 P1: record HEAD^ as prevSha —
        // the baseline start for the NEXT prepare — so the documented
        // checkpoint → prepare flow does not self-lock (baseline..HEAD would
        // be empty if the baseline were the checkpoint itself).
        let prevSha = "";
        try {
          prevSha = execFileSync("git", ["rev-parse", "HEAD^"], { cwd: root, encoding: "utf8" }).trim();
        } catch { /* root commit: no parent — prepare falls back to <sha>^ */ }
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
   * Everything that has to happen BEFORE a reviewer can judge, run by the gate.
   *
   * The agent used to do this by hand — run_precommit, review_checkpoint,
   * prepare_review, review_spawn — four calls in a fixed order, each with its
   * own failure mode, none of them creative work. Now it says what it changed
   * and the gate does the rest, or sends the round back with the reason.
   *
   * Each step is the TOOL's own implementation (`callTool`), never a copy:
   * the mechanical checks (precommit receipt, English message, checkpoint
   * marker, baseline..HEAD) all still run exactly once, where they live.
   */
  /**
   * THE IN-FLIGHT FULL PRECOMMIT (B1, 2026-09-10).
   *
   * The chain used to be strictly serial: 33s of full precommit, THEN freeze,
   * THEN dispatch — and the agent was blocked for every one of those 33s,
   * because `judge_submit` does not return until the reviewer is dispatched.
   * The precommit does not have to come first: the reviewer judges an
   * IMMUTABLE COMMIT RANGE, so the only thing that must precede the dispatch
   * is the checkpoint. The long pole starts first and the chain runs beside
   * it.
   *
   * WHAT THE CHECKPOINT GATE ACCEPTS WHILE THIS IS SET: content being verified
   * RIGHT NOW, by this session, in this repo. The receipt is the PROMISE, not
   * a file — a restart loses it, and a checkpoint with no live verification is
   * refused exactly as before (fail-closed).
   *
   * WHAT IS NOT WEAKENED: the ship side is untouched. A precommit PASS covers
   * the TREE it ran on, a READY covers the tree of the commit it judged, and a
   * round whose content moved while its precommit ran fails to ship on the
   * REVIEW side — which is exactly where that mismatch is visible.
   */
  let inFlightPrecommit: { root: string; settled: Promise<void>; abort: (why: string) => void } | undefined;

  /**
   * STOP A LANE WHOSE CONTENT IS ABOUT TO CHANGE (2026-09-15, user requirement).
   *
   * The full lane runs BESIDE the review on purpose, and that is right while
   * the round still stands. When the QUALITY round blocks, it no longer does:
   * the agent is going to edit this content, so the minutes the lane has left
   * verify a tree nobody will ship — and the next submission would wait for a
   * quiet lane (`waitForQuietLane`) before starting the one that matters. So
   * the abort is the whole point: it buys back the wait, not just the CPU.
   *
   * WHAT IT DOES NOT DO: touch the ship bindings. The lane's own landing path
   * treats an aborted run as "no verdict" (it never writes the pass-coverage
   * record and never reports a failure), so nothing is granted and no false
   * FAIL is blamed on a change that never ran.
   */
  function abortPrecommitLane(root: string, why: string): boolean {
    const lane = inFlightPrecommit;
    if (!lane || lane.root !== root) return false;
    lane.abort(why);
    return true;
  }

  /**
   * ONE LANE AT A TIME, AND IT MUST BE THIS ROUND'S (round-4 P2).
   *
   * The first version JOINED a running lane: same repo, so "this repo is being
   * verified" — which is true and also not enough. The running lane is
   * verifying an EARLIER content, and a PASS it writes when it finishes would
   * satisfy `readyLacksVerification` for a round whose checkpoint holds
   * something else. The ship gate's fingerprint match is still the real
   * backstop there, but this layer's own claim — "a READY without a full-lane
   * PASS is withheld" — would be false in exactly that sequence.
   *
   * So a round that finds a lane already running WAITS for it to finish and
   * then starts its own. The wait is bounded by one lane (and it only happens
   * when the agent submitted twice inside a single run of it); what it buys is
   * that the verdict on record always belongs to the content under review.
   */
  async function waitForQuietLane(root: string): Promise<void> {
    while (inFlightPrecommit?.root === root) {
      const running = inFlightPrecommit;
      await running.settled;
      if (inFlightPrecommit === running) return;
    }
  }

  /**
   * Start the full lane in the BACKGROUND and return immediately.
   *
   * ONE PER REPO: a second round submitted while the first is still verifying
   * would run two full suites side by side, fighting for the same cores and
   * the same cache file. The second round JOINS the first — that promise is
   * the same "this repo is being verified right now" receipt either way.
   */
  function startPrecommitBeside(root: string, ctx: unknown): Promise<void> {
    // The lane's kill switch (see `abortPrecommitLane`). ONE controller per
    // lane, held with the promise so a blocking quality verdict can reach it.
    const controller = new AbortController();
    // No joining: the caller waits for a quiet lane first (see
    // `waitForQuietLane`), so this is always THIS round's verification.
    //
    // THIS ROUND'S VERIFICATION HAS NO VERDICT YET, and saying so is what makes
    // the checkpoint gate's test exact. `inFlightPrecommit` is cleared in a
    // microtask after the promise settles, so for an instant a FINISHED — and
    // possibly FAILED — lane still looks in-flight. Resetting the record first
    // means the gate reads the VERDICT, which the runner writes the moment it
    // has one: once there is a verdict, the content is no longer pending.
    //
    // (A previous round's PASS is discarded by this reset. That is the
    // fail-closed direction: the only thing it can cost is a re-run.)
    stateForRepo(root).precommit = {
      verdict: "NOT_RUN",
      fingerprint: null,
      at: new Date().toISOString(),
      mode: "full",
    };
    // WHAT THIS LANE IS VERIFYING, READ BEFORE IT STARTS. Read here and not off
    // the run's own outcome, because the outcome's fingerprint is recomputed
    // AFTER the runner (lint:fix may have edited files) — i.e. it can already be
    // the NEXT round's content. This one is the frozen content this lane was
    // launched against, and it is what the notice names.
    const round = stateForRepo(root).rounds.length + 1;
    const settled = (async () => {
      let verdict = "no verdict";
      let detail = "";
      const verified = worktreeTree(root) ?? "";
      try {
        const pre = await callTool("run_precommit", { mode: "full", repo: root }, ctx, undefined, controller.signal);
        verdict = String(pre.details?.verdict ?? "no verdict");
        detail = toolText(pre);
      } catch (error) {
        detail = (error as Error).message;
      }
      // AN ABORTED LANE IS NOT A RESULT (user requirement, 2026-09-15: "质量
      // 审核失败，precommit 应该结束掉"). The content is about to change, so
      // this run's remaining minutes were spent on a tree nobody will ship:
      // it reports nothing, revokes nothing, and — the one fact that has to
      // survive — leaves NO PASS standing for content it never finished.
      if (controller.signal.aborted) {
        const st = stateForRepo(root);
        // REPLACED WHOLESALE, which is what revokes the coverage record: the
        // fresh object simply has no `lastFullPassTree`, `testScope` or PASS
        // fingerprint. (An earlier version also ran `delete
        // st.precommit.lastFullPassTree` right after this — dead code against
        // the object it had just built, and it made the revocation look like
        // the delete's doing. reviewer Nit, 2026-09-15.)
        st.precommit = { verdict: "NOT_RUN", fingerprint: null, at: new Date().toISOString(), mode: "full" };
        persistRepo(ctx as unknown as ExtensionContext, root);
        log(`precommit lane for ${root} aborted — nothing recorded for the content it was verifying`);
        return;
      }
      // THE PASS-COVERAGE RECORD (2026-09-14). `st.precommit` is a LIVE binding
      // that the session's own next edit invalidates on purpose — so the tree
      // THIS lane verified is written down separately, and `verified` is the
      // tree captured BEFORE the run: the runner's own fingerprint is
      // recomputed after it (lint:fix may have edited files) and can already
      // belong to the next round's content, which would record a tree no lane
      // ever ran on. The rule itself is `nextFullPassTree` (pure, in
      // lib/gate-state.ts); only the effect lives here.
      //
      // WHAT THE LANE COVERED COMES FROM THE GATE'S OWN RECORD, not from the
      // tool's reply. The reply's `details` never carried `testScope` (only
      // verdict/checksRun/repo/logPath/failedSteps), so an earlier version of
      // this call read `undefined`, never matched the PASS branch, and never
      // wrote anything — silently, with every test green (reviewer P1,
      // 2026-09-14). `st.precommit.testScope` is written by that same run and
      // is read by the SHIP gate, so it cannot go missing unnoticed the way a
      // field only this caller read could.
      const laneState = stateForRepo(root);
      const coveredTree = nextFullPassTree({
        current: laneState.precommit.lastFullPassTree,
        verdict,
        mode: "full",
        testScope: laneState.precommit.testScope,
        startedTree: verified,
      });
      if (coveredTree !== laneState.precommit.lastFullPassTree) {
        if (coveredTree === undefined) delete laneState.precommit.lastFullPassTree;
        else laneState.precommit.lastFullPassTree = coveredTree;
        persistRepo(ctx as unknown as ExtensionContext, root);
      }
      // WHAT THE LANE'S LANDING DOES TO THE ROUND (2026-09-16).
      //
      // FIRST, the cancel matrix's lane row: a FAILED lane ends the functional
      // round (its judge would spend minutes judging content the gate already
      // refuses to ship), while the QUALITY round carries on — it reads code,
      // and a failing suite says nothing about the code's quality. The abort is
      // already in effect for this lane: it is the lane itself landing.
      // THE LANE'S OWN ROW OF THE MATRIX, through the same table and the same
      // applier the judges' rows use — INCLUDING the PASS case, which the table
      // answers with "nothing" (a caller-side `if` would be the second copy of
      // that row the quality round caught on 2026-09-16).
      //
      // WHAT IT RETURNED IS DELIVERED, NOT DROPPED (quality round P2,
      // 2026-09-16): a judge's row has a sibling verdict whose standard report
      // carries its notes, and the lane's row has none — dropped here, 「本轮有
      // judge 判了非 READY，正在跑的全量 precommit 已终止」 reached nobody, and
      // the agent only saw "precommit failed" with no trace of why. The FAIL
      // notice below IS this row's delivery.
      const laneCancelNotes = applyCancelPlan(roundCancelPlan({ party: "lane", verdict }), root);
      // THEN the parked conclusion, re-asked from BOTH halves (`resumeParkedReady`
      // consults the trees, what THIS landing measured and the quality standing):
      // a non-PASS lane retires the parked round, a PASS on exactly that tree
      // WITH the quality verdict in hand replays it, and anything still owed
      // leaves it parked for the landing that is owed.
      await resumeParkedReady(root, ctx, { laneVerdict: verdict, coveredTree });
      // THE LANE'S LANDING IS AN EVENT EITHER WAY (2026-09-16). A PASS used to
      // be silent, and that silence is exactly what stranded a session in a
      // `judge_wait` it could not end: the report it had received said
      // 「正在等 precommit lane 落地（HELD）」, and nothing ever came to say it
      // had (measured: 6m47s, notification session 2026-09-15). FAIL keeps its
      // loud form; PASS gets the short one — there is nothing to do about it.
      if (verdict === "PASS") {
        reportAsyncPrecommitPass({ round, verified, current: worktreeTree(root) ?? "" });
      } else {
        // TELL THE AGENT (B1). The content the reviewer approved did not pass
        // its verification, so this round cannot produce a shippable READY —
        // and the failure channel names THAT reason, not "findings".
        reportAsyncPrecommit({
          round,
          verified,
          current: worktreeTree(root) ?? "",
          verdict,
          detail,
          ...(laneCancelNotes.length === 0 ? {} : { laneNotes: laneCancelNotes }),
        });
      }
    })();
    inFlightPrecommit = {
      root,
      settled,
      abort: (why: string) => {
        if (controller.signal.aborted) return;
        log(`precommit lane for ${root} aborting: ${why}`);
        controller.abort();
      },
    };
    void settled.finally(() => {
      if (inFlightPrecommit?.settled === settled) inFlightPrecommit = undefined;
    });
    return settled;
  }

  /**
   * TELL THE AGENT (B1). The round was dispatched before this verdict existed,
   * so nothing else will: a silent FAIL would leave a round that looks
   * dispatched and verified sitting inside a gate that will not ship it.
   *
   * `steer`, NOT `followUp` (2026-09-12). pi drains a follow-up message only
   * when the agent has no more tool calls — and this gate's own standing rule
   * forbids the agent to stop while a gate is unmet, so a follow-up here is
   * drained hours later, or never. Measured: three of these sat in the queue
   * behind a single 2.5-hour turn and were delivered at 05:14/05:21/05:24 for
   * failures from 03:01/03:15/03:23, long after the gate's own records said
   * PASS + READY, so the agent read them as the gate contradicting itself.
   * `steer` delivers at the next tool-batch boundary — the agent cannot be busy
   * for long without a tool call, and this message is the thing it must know
   * before its next one. The bound is therefore ONE TOOL CALL rather than the
   * whole turn (a long `judge_wait` is the worst case, minutes; before this it
   * was hours, or the end of the session).
   *
   * The wording rules (round identity, and downgrading when the content under
   * review has moved on) live in lib/async-precommit-report.ts.
   */
  function reportAsyncPrecommit(input: AsyncPrecommitReport): void {
    deliverPrecommitNotice(buildAsyncPrecommitReport(input));
  }

  /**
   * A PASS lands too — and this is the ONLY thing that says so
   * (2026-09-16): a session told it is 「等 precommit lane 落地」 has no other
   * event to wake on, so a silent PASS is indistinguishable from a lane that
   * never ran. Same delivery as the failure notice, on purpose: `steer`
   * reaches the agent at its next tool-call boundary, and the whole point is
   * that it stops waiting NOW.
   */
  function reportAsyncPrecommitPass(input: AsyncPrecommitPass): void {
    deliverPrecommitNotice(buildAsyncPrecommitPass(input));
  }

  function deliverPrecommitNotice(message: string): void {
    try {
      pi.sendMessage(
        { customType: "review-gate", content: message, display: true },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } catch {
      try { latestCtx?.ui.notify(message.slice(0, 400), "error"); } catch { /* headless */ }
    }
  }

  async function submitForReview(input: {
    root: string;
    note: string;
    message?: string;
    reason?: string;
    ctx: unknown;
    /** Progress sink for the chain (each step publishes as it starts/ends). */
    progress?: ProgressReporter;
  }): Promise<
    | {
        ok: true;
        /**
         * WHICH role this chain dispatches after prepare (see the routing rule
         * below). `null` = NOTHING was dispatched: the user switched the review
         * and quality stages off, so the chain ran only what is on (the
         * precommit lane) and there is no judge to start.
         */
        role: "reviewer" | typeof QUALITY_ROLE | null;
        taskText: string;
        streamPath?: string;
        /** Present when the quality round was SKIPPED — printed to the agent. */
        skipNote?: string;
        /**
         * WHY NOTHING WAS DISPATCHED WITH THE QUALITY STAGE STILL ON (quality
         * round P2, 2026-09-22): the same `role: null` shape is also reached
         * when the current head ALREADY carries a bound quality READY, and the
         * receipt's generic “no judge was dispatched (the user's stage
         * switches)” then reads as if a stage were missing. Carrying the real
         * reason keeps the receipt honest without a second decision anywhere.
         */
        qualityStandingNote?: string;
        /**
         * WHAT THIS CHAIN JUST FROZE (drill F4, 2026-09-20).
         *
         * `judge_submit` is the only surface the agent reads after a round is
         * submitted, and it used to name neither the commit nor the files in
         * it — so a checkpoint that swept something it should not have (F3:
         * the seeded `node_modules` symlink) left no trace anywhere the agent
         * or the user would look.
         */
        checkpoint?: { sha: string; files: string[]; leftOut: string[] };
        /**
         * THE FUNCTIONAL BRIEF OF A PARALLEL ROUND (2026-09-16). Present
         * exactly when `role` is the quality judge: the caller dispatches both
         * judges back to back, because they judge the SAME immutable range and
         * neither waits for the other. The cancel matrix
         * (`lib/quality-round.ts`'s `roundCancelPlan`) decides afterwards who
         * stops whom.
         */
        parallelReviewer?: { taskText: string; streamPath?: string };
      }
    | { ok: false; text: string }
  > {
    // 1. It has to build. A full lane, because a checkpoint that only ran the
    //    related tests cannot clear the ship gate later anyway.
    //
    //    UNLESS the user switched the precommit stage off (2026-09-22) — then
    //    there is nothing to run and nothing to wait for, and the whole lane
    //    (its spawn, its cache probe, its minutes) is skipped.
    //
    //    UNLESS the user issued a `/gate-bypass` (R-22). Then this step is
    //    SKIPPED rather than run-and-ignored: re-running a precommit that is
    //    failing for an environment reason costs minutes and changes nothing,
    //    and the whole point of the bypass is that the user already decided
    //    this round ships without it. The fact is recorded on the checkpoint
    //    and repeated to the reviewer.
    const precommitOn = stageIsOn("precommit", input.root);
    const bypassActive = stateForRepo(input.root).bypass.active;
    if (!precommitOn) {
      input.progress?.step("precommit（环节已关闭，跳过）");
      input.progress?.done("OFF");
    } else if (bypassActive) {
      input.progress?.step("precommit (被 /gate-bypass 覆盖，跳过)");
      input.progress?.done("BYPASSED");
    } else {
      // START IT, DO NOT AWAIT IT (B1). The freeze and the dispatch below are
      // quick, and the reviewer does not need this verdict to start judging an
      // immutable range — so the 33s lane runs BESIDE the chain instead of in
      // front of it, and the agent gets its turn back. A FAIL arrives as its
      // own follow-up message (`reportAsyncPrecommit`) and withholds the
      // round's READY; it can no longer be reported by returning early.
      //
      // …EXCEPT when an older lane is still running: then this round waits for
      // it (round-4 P2 — a joined lane would verify the WRONG content).
      input.progress?.step("precommit (full，与审查并行)");
      await waitForQuietLane(input.root);
      void startPrecommitBeside(input.root, input.ctx);
    }

    // 2. Freeze it. The reviewed unit is a commit, and the message says so —
    //    a checkpoint must be recognizable as one in the history.
    //
    //    A CLEAN worktree is not a failure here: it means this round is
    //    already frozen (a retry after step 3 failed, or an agent that
    //    committed through the tool itself). Treating it as one is what turned
    //    a single refused prepare into a permanent dead end — the commit was
    //    already in, so every retry died at this step. Only a REFUSAL
    //    (isError) stops the chain.
    const message = checkpointMessage(input.message ?? input.note);
    input.progress?.step("checkpoint 提交");
    const commit = await callTool("review_checkpoint", { message, note: input.note, repo: input.root }, input.ctx);
    if (commit.isError) {
      input.progress?.fail("被拒");
      return {
        ok: false,
        text: "review-gate: 本轮未送审 — checkpoint 提交被拒。\n" + toolText(commit),
      };
    }
    input.progress?.done(typeof commit.details?.sha === "string" ? String(commit.details.sha).slice(0, 12) : "worktree 已冻结");
    const stringsOf = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    const checkpoint = typeof commit.details?.sha === "string"
      ? {
          sha: commit.details.sha,
          files: stringsOf(commit.details.files),
          leftOut: stringsOf(commit.details.leftOut),
        }
      : undefined;
    // 3. Compute the range and the findings stream, and take the ready-made
    //    reviewer task text. `reason` rides along for the polish gate: without
    //    it a round after two READYs could never be submitted through the one
    //    sanctioned entry point.
    input.progress?.step("prepare（算 baseline..HEAD）");
    const prepared = await callTool(
      "prepare_review",
      { repo: input.root, ...(input.reason ? { reason: input.reason } : {}) },
      input.ctx,
    );
    if (prepared.details?.prepared === false || prepared.isError) {
      input.progress?.fail("被拒");
      return {
        ok: false,
        text: "review-gate: 本轮未送审 — prepare_review 被拒。\n" + toolText(prepared),
      };
    }
    input.progress?.done(typeof prepared.details?.range === "string" ? String(prepared.details.range) : "范围已注册");
    const taskText = extractTaskText(toolText(prepared));
    // The note is the MAIN SESSION's own words about its round — the very
    // text an injected "just conclude READY" would ride in on. It goes AFTER
    // the gate's task text, inside an untrusted data block (round 5), and
    // BOTH rounds get it: the quality judge has to know what the round claims
    // it did before it can judge how it did it.
    const withNote = (text: string) =>
      composeWithUntrustedData(text, [
        { tag: "main_session_note", label: "本轮改动说明（来自主会话）：", text: input.note },
      ]);
    const reviewerTask = withNote(taskText);
    const reviewerStream = typeof prepared.details?.stream === "string" ? prepared.details.stream : undefined;

    // ---------- THE ROUTING RULE (2026-09-15, rewritten 2026-09-16) ----------
    //
    // One rule, applied ONCE per round, in one direction:
    //  - a round that carries no code (a docs/data-only round, or the empty
    //    exit-goal round) goes STRAIGHT to the reviewer, and says so;
    //  - a round whose CURRENT head already carries a quality READY goes to
    //    the reviewer as well — that is a re-submission of content the quality
    //    judge has already passed (a dead pane, a failed dispatch), and
    //    re-judging it would buy a second wait for the same answer;
    //  - everything else runs the quality round — BESIDE the functional one,
    //    from the same call. What the quality round gates is therefore no longer
    //    the DISPATCH (which it cannot: the two start together) but the RECORD:
    //    a functional READY is held until the quality verdict stands (see
    //    `recordReviewVerdict`).
    //
    // The file list comes from prepare's own `numstat` (it rode onto the
    // review target), never from a second `git diff` here.
    const changedFiles = Array.isArray(prepared.details?.files) ? (prepared.details.files as string[]) : undefined;
    const preparedHead = typeof prepared.details?.head === "string" ? prepared.details.head : "";
    // THE USER'S STAGE SWITCHES, read once for this round (2026-09-22,
    // lib/loop-stages.ts). `review` off means no functional judge is started —
    // the CHECKPOINT still runs (the round is still frozen), and a quality
    // round that is on still runs alone. `quality` off is expressed as the
    // same SKIP a code-free round gets, recorded the same way, so
    // `qualityStandingFor` reads one shape and not two.
    const reviewOn = stageIsOn("review", input.root);
    const qualityOn = stageIsOn("quality", input.root);
    const skip = qualityOn
      ? qualityRoundSkip(changedFiles)
      : {
          skip: true as const,
          reason: "质量环节已关闭（用户设定的环节开关）—— 不派 quality-auditor",
        };
    const standing = qualityStandingFor({
      head: preparedHead,
      files: changedFiles,
      quality: stateForRepo(input.root).quality,
      // THE USER'S SWITCH travels with the record: a skip written while the
      // stage was off stops standing once it is back on (the rule itself is
      // lib/quality-round.ts's, read here as one input of the same judgement).
      stageOn: qualityOn,
    });
    if (!skip.skip && !standing.ok) {
      const qualityTaskText = typeof prepared.details?.qualityTask === "string" ? prepared.details.qualityTask : undefined;
      const qualityStream = typeof prepared.details?.qualityStream === "string" ? prepared.details.qualityStream : undefined;
      if (!qualityTaskText) {
        // prepare always builds it; a missing one means the tool and this
        // chain disagree about their own contract. Fail closed rather than
        // dispatching a judge with no brief.
        return { ok: false, text: "review-gate: 本轮未送审 — prepare 没有给出质量轮的任务文本（门禁内部不一致）。" };
      }
      return {
        ok: true,
        role: QUALITY_ROLE,
        taskText: withNote(qualityTaskText),
        ...(qualityStream === undefined ? {} : { streamPath: qualityStream }),
        ...(checkpoint === undefined ? {} : { checkpoint }),
        // The functional brief travels WITH it: the two judges are dispatched
        // in one breath (the caller owns the effects; this chain owns the
        // routing) — and only when the functional stage is ON: with that
        // switch off there is no second judge to start at all (user decision,
        // 2026-09-22).
        ...(reviewOn
          ? {
              parallelReviewer: {
                taskText: reviewerTask,
                ...(reviewerStream === undefined ? {} : { streamPath: reviewerStream }),
              },
            }
          : {}),
      };
    }
    if (skip.skip) {
      // Recorded, never silent: a skipped round and a judged round both end as
      // "quality is fine", and the difference must survive into the sidecar.
      const st = stateForRepo(input.root);
      const skipTarget = reviewTargets.get(input.root);
      st.quality = skippedQualityRecord({
        head: preparedHead,
        // THE SKIP CARRIES ITS TREE TOO (quality round P1, 2026-09-22): with the
        // review stage OFF the quality record IS the ship requirement, and a
        // record without a `treeSha` cannot be verified — so a docs-only SKIP
        // would have failed closed on a tree it never named. Same source the
        // verdict recorder reads (`reviewTargets`, registered by prepare).
        ...(skipTarget?.tree === undefined ? {} : { tree: skipTarget.tree }),
        // AND IT CARRIES WHY (functional round P1, 2026-09-22): the ship
        // readers accept a code-free skip and refuse a stage-off one, so the
        // cause is recorded here, where BOTH are known — `qualityOn` is false
        // exactly when the skip above was manufactured from the switch.
        cause: qualityOn ? "no-code" : "stage-off",
        reason: skip.reason ?? "",
        at: new Date().toISOString(),
      });
      persistRepo(input.ctx as unknown as ExtensionContext, input.root);
      input.progress?.done(qualityOn ? "质量轮跳过（无代码改动）" : "质量轮跳过（环节已关闭）");
    }
    if (!reviewOn) {
      // NOTHING LEFT TO DISPATCH: the functional stage is off, and a quality
      // round that was owed has already returned above. The chain still ran
      // the precommit lane and the checkpoint — those are their own switches —
      // so the round is frozen and the caller reports what it got.
      return {
        ok: true,
        role: null,
        taskText: "",
        ...(checkpoint === undefined ? {} : { checkpoint }),
        // REACHED TWO WAYS, AND THE RECEIPT MUST NOT CONFUSE THEM (quality
        // round P2, 2026-09-22): the quality stage is off (or the round is a
        // skip), OR it is ON and this head already carries a bound quality
        // READY — `standing.ok` above sent the other case to a quality
        // dispatch. The second one is not a missing stage: it is the same
        // content being judged once.
        ...(skip.skip
          ? { skipNote: skip.reason ?? "" }
          : {
              qualityStandingNote:
                "代码质量审查 quality-auditor：当前 head 已有绑定的质量结论（同一份内容不再重复派质量轮）。",
            }),
      };
    }
    return {
      ok: true,
      role: "reviewer",
      taskText: reviewerTask,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      // The findings stream is the agent's half of the round: it fixes what
      // the judge confirms WHILE the judge works. Dropping the path here would
      // leave that channel written but unread.
      ...(reviewerStream === undefined ? {} : { streamPath: reviewerStream }),
      ...(skip.skip ? { skipNote: skip.reason ?? "" } : {}),
    };
  }

  /**
   * The GOAL AUDIT, run by the gate from inside `propose_loop_goal`.
   *
   * WHY THIS IS NOT A SEPARATE TOOL ANY MORE (philosophy two). The audit was
   * three calls in a fixed order — `judge_submit({role:"goal-auditor"})`,
   * wait for the process, then a recording call — and the agent had to
   * sequence them correctly every time, for a chain in which it makes no
   * decision at all. It now says only "here is the draft"; the gate builds
   * the auditor's task, runs the judge process, waits for it to exit, records
   * the verdict against the exact text it dispatched, and either continues to
   * the user's dialog or hands the objections back.
   *
   * IT BLOCKS, and that is deliberate. `propose_loop_goal` is a minutes-long
   * call now, because the alternative — return early and make the agent come
   * back — is exactly the multi-step dance this removes. The findings still
   * stream while it runs, so the draft can be fixed against real objections
   * rather than a summary at the end.
   *
   * The recording itself is unchanged and still mechanical: the verdict binds
   * to the sha256 of the audited text (only P0/P1 block), so a PASS can never
   * belong to a different draft than the one the user is about to see.
   */
  async function runGoalAudit(input: {
    root: string;
    goalText: string;
    ctx: unknown;
    progress?: ProgressReporter;
    /** The caller's abort signal — ESC must be able to stop the audit wait. */
    signal?: AbortSignal | undefined;
  }): Promise<{ ok: true } | { ok: false; text: string }> {
    const { root, goalText, ctx } = input;
    input.progress?.step("组装 goal 审计任务");
    const built = await buildGoalAuditRound(goalText, root, ctx);
    if (!built.ok) {
      input.progress?.fail("被拒");
      return { ok: false, text: "review-gate: goal 审计任务无法生成。\n" + built.error };
    }
    input.progress?.done("已生成");

    input.progress?.step("goal-auditor 审计中（这一步是分钟级的）");
    // Everything that used to be spelled out here — dispatch, remember the
    // draft only after the dispatch is accepted, wait for the ROUND (not its
    // first message), fail closed on anything else, record, close the pane the
    // gate opened itself — is `runAuditRound`. The plan audit below is the
    // same call with the other spec.
    const outcome = await runAuditRound(auditRunDeps(ctx, input.progress, input.signal), {
      spec: GOAL_AUDIT_SPEC,
      root,
      task: built.task,
      streamPath: built.streamPath,
      pending: { kind: "goal", draft: goalText, startedAt: new Date().toISOString() },
    });
    if (outcome.ok) {
      input.progress?.done("审计完成");
      return outcome;
    }
    input.progress?.fail("未通过");
    return outcome;
  }

  /**
   * THE PLAN AUDIT, run by the gate from inside `orchestrator_plan`'s submit.
   *
   * The goal audit's twin, deliberately identical in shape (philosophy two):
   * ONE call builds the auditor's task, runs the judge process, waits for it
   * to exit, reads THIS round's output, adjudicates it and records the verdict
   * against the plan's canonical hash. The orchestrator submits a plan and
   * gets back either the user's dialog or a list of objections — it never
   * sequences an audit by hand, and it never sees a half-finished one.
   *
   * WHY A PLAN NEEDS THIS AT ALL: a wrong plan is more expensive than a wrong
   * goal. It decides what several children may touch, in what order, and how
   * many run at once — a task sent to the wrong repo burns a whole round. The
   * user asked for the asymmetry (goal audited, plan not) to be closed.
   *
   * IT BLOCKS for minutes, for the same reason `propose_loop_goal` does.
   *
   * The ROLE is `goal-auditor` (user decision): the same judgement — "is this
   * contract checkable, and does it match the repository?" — so no fourth
   * role, no new agent file, no new model pin.
   */
  async function runPlanAudit(
    plan: OrchestratorPlan,
    onUpdate?: { step?: (t: string) => void; done?: (t: string) => void } | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<{ ok: true } | { ok: false; text: string }> {
    // FAIL-CLOSED AROUND THE WHOLE CHAIN. Anything unexpected in here — a
    // judge that could not be spawned, an IO error reading its output — must
    // become "the plan was not audited", never an exception that escapes into
    // the tool and leaves the orchestrator unable to tell whether a dialog is
    // about to appear.
    try {
      return await auditPlanRound(plan, onUpdate, signal);
    } catch (error) {
      return {
        ok: false,
        text:
          `review-gate: plan 审计过程本身出错了（${(error as Error).message}）——` +
          "什么都没有记录，plan **没有**被送到用户面前。直接再 `submit` 一次即可重跑。",
      };
    }
  }
  async function auditPlanRound(
    plan: OrchestratorPlan,
    onUpdate?: { step?: (t: string) => void; done?: (t: string) => void } | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<{ ok: true } | { ok: false; text: string }> {
    const root = primaryRepoRoot;
    const hash = planAuditHash(plan);
    // A re-audit is handed the previous round's verdict and objections — the
    // same carryover contract the goal audit has: settled material gets a
    // consistency scan, not a re-derivation.
    const previous = state.planAudit;
    const carryover = previous && previous.hash !== hash
      ? formatPlanAuditCarryover(previous)
      : undefined;
    const task = buildPlanAuditTask(plan, {
      ...(carryover === undefined ? {} : { carryover }),
      ...(carryover !== undefined && previous?.planText ? { prevPlanText: previous.planText } : {}),
      repoRoot: root,
      ...(state.sessionId ? { sessionId: state.sessionId, sessionDir: sessionDirForCwd(cwd) } : {}),
    });

    onUpdate?.step?.("派发 plan 审计（goal-auditor 独立 pane）");
    // The goal audit's twin, and now literally the same code: the plan differs
    // from the goal only in its spec (its wording, its title, and the fact
    // that its record binds to a canonical hash rather than a draft's text).
    return runAuditRound(auditRunDeps(latestCtx, onUpdate, signal), {
      spec: PLAN_AUDIT_SPEC,
      root,
      task,
      pending: {
        kind: "plan",
        hash,
        planText: formatPlanSummary(plan),
        startedAt: new Date().toISOString(),
      },
    });
  }



  /**
   * The checkpoint's commit message — the whole rule (a legal Conventional
   * Commit for every note, plus the L5 non-English fallback) lives in
   * lib/checkpoint-message.ts, unit-tested there. This wrapper only names the
   * call site.
   */
  function checkpointMessage(raw: string): string {
    return buildCheckpointMessage(raw);
  }


  /** What one dispatch of a judge round produced (or why it could not). */
  interface JudgeDispatch {
    ok: boolean;
    /** The role's session already had a transcript — this round continues it. */
    reused: boolean;
    sessionId?: string;
    sessionDir?: string;
    /** tmux pane the round lives in (open) or was queued into (reuse). */
    paneId?: string;
    /** Judge id — the hierarchy key and channel file name. */
    judgeId?: string;
    error?: string;
    /**
     * DID THIS ROUND'S TASK REACH ITS JUDGE? — the fact a FAILED dispatch has
     * to carry.
     *
     * Two failures keep a `paneId` and they mean OPPOSITE things (quality round
     * P2, 2026-09-16): a boot-check timeout means the task rode in on the pane's
     * argv and the round is under way (the opener may still wait on it), while a
     * failed channel write into a REUSED pane means the pane is alive and this
     * round's task was never delivered. A caller that decides "is the round
     * running?" from `paneId` alone therefore gets one of the two wrong — and
     * the one it gets wrong leaves a judge working on a round the agent was
     * told had failed. Absent on success (it is `ok`), and NEVER inferred:
     * each failure site says which it is.
     */
    delivered?: boolean;
  }

  /** Does this role's session dir already hold a transcript to continue? */
  function hasTranscript(sessionDir: string): boolean {
    try {
      return readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
    } catch {
      return false; // no dir yet ⇒ nothing to continue
    }
  }

  /**
   * WHICH review object this repo's judges are serving right now.
   *
   * The priority is lib/judge-rotation.ts's, not this call site's: an
   * orchestration serves its approved PLAN, every other session its approved
   * GOAL. The goal hash counts only while the goal file still carries the
   * user's approval — an edited goal is a different contract, and reusing the
   * transcript of the one it replaced is precisely what the release point
   * exists to stop.
   */
  function judgeObjectIdFor(root: string): string {
    const st = root === primaryRepoRoot ? state : stateForRepo(root);
    return judgeObjectId({
      orchestrator: state.taskMode === "orchestrator",
      ...(state.orchestrator?.approvedPlanHash ? { planHash: state.orchestrator.approvedPlanHash } : {}),
      ...(loopGoalConfirmed(root, st) && st.loopGoal ? { goalHash: st.loopGoal.hash } : {}),
    });
  }

  /**
   * THE lane resolution — the ONE entry point every judge-starting path calls,
   * exactly once, before it derives anything.
   *
   * It reads the lane the role is currently in (a scan of the registry, since
   * a judge id now CONTAINS its lane and therefore cannot be derived before
   * the decision is made), asks the policy what this round's lane is, and hands
   * back the one action that finishes the move: `retirePrevious`, which closes
   * and forgets the lane this round replaces. Retiring belongs here rather than
   * in each caller for the reason the whole module map exists: the paths that
   * start a judge (`dispatchJudgeRound`, `judge_spawn`'s launch config and task
   * file) must not each reimplement "and close the pane we just stopped using",
   * and one of them would forget.
   *
   * WHY THE RETIRE IS NOT DONE HERE. Dropping the old row is irreversible, and
   * a dispatch can still fail after this call (no tmux, no model chain). The
   * next dispatch would then find NO previous lane, decide `first` at
   * generation 0 — and resume the very transcript that was just rotated away,
   * with the round count back at one and the context reading gone. So the
   * caller calls `retirePrevious()` once the replacement lane is registered.
   * It is idempotent, and a no-op when the lane did not actually change.
   */
  function resolveJudgeLane(root: string, role: string, opener: string): {
    decision: JudgeRotationDecision;
    previous?: JudgeEntry;
    retirePrevious(): void;
  } {
    const previous = findJudgeLane(judgeHierarchy, { role, repoRoot: root, openerId: opener });
    const decision = decideJudgeRotation({
      objectId: judgeObjectIdFor(root),
      ...(previous === undefined ? {} : { previous }),
    });
    // THE TEST IS THE ID, NOT THE VERDICT. A lane the gate stops using leaves a
    // whole judge behind — its registry row and its live pane — and nothing
    // downstream would ever look at either again, because the registry is
    // keyed by judge id and this round's id is a different one. That happens
    // on a rotation, and it ALSO happens on a decision the policy calls
    // `first`: an entry written by a pre-rotation build carries no lane, so
    // the policy has nothing to compare and says "first" while the derived id
    // still grows a lane suffix. Gating on `rotated` there left the old row in
    // place, and `judgeChildByRole` returns the FIRST match — so `judge_wait`
    // / `judge_close` would address the stale judge instead of the round just
    // dispatched (reviewer P1, 2026-09-05).
    const nextId = judgeSessionIdFor(role, shortRepoHash(root), opener, decision.lane);
    let retired = false;
    const retirePrevious = (): void => {
      if (retired || !previous || previous.judgeId === nextId) return;
      retired = true;
      retireJudgeLane(previous, {
        root,
        ownPane: process.env.TMUX_PANE?.trim() || undefined,
        tmuxServer: tmuxServerFrom(process.env),
        run: (argv: readonly string[]) => runTmux(argv),
      });
    };
    return { decision, ...(previous === undefined ? {} : { previous }), retirePrevious };
  }

  /**
   * The facts a rotated REVIEWER round hands over, gathered from this repo's
   * gate state. Empty for every other case — an unrotated round needs nothing,
   * and another role's hand-off is built by that role's own module.
   */
  function rotationCarryoverFacts(root: string, role: string, decision: JudgeRotationDecision): {
    settled?: SettledConclusion;
    openFindings?: string[];
    delta?: { files: string[]; lines?: number; reviewedFiles?: string[] };
  } {
    if (!decision.rotated || role !== "reviewer") return {};
    const st = root === primaryRepoRoot ? state : stateForRepo(root);
    const settled = settledConclusion(st);
    const openFindings = previousRoundFindings(st);
    let delta: { files: string[]; lines?: number; reviewedFiles?: string[] } | undefined;
    try {
      const scope = reviewScopeFor(root, st);
      delta = { files: scope.changedFiles, lines: scope.changedLines, reviewedFiles: scope.reviewedFiles };
    } catch {
      // A git read can fail (a repo mid-rebase, a missing tree). The hand-off
      // is still worth sending without its delta; inventing one is not.
      delta = undefined;
    }
    return {
      ...(settled === undefined ? {} : { settled }),
      openFindings,
      ...(delta === undefined ? {} : { delta }),
    };
  }

  /**
   * What every judge-pane close needs to know about this session's tmux.
   *
   * `opener` used to be here too — the label-bar release compared it against
   * each entry's opener to count "my" panes. That judgement is deleted
   * (2026-09-17, user decision), and with it the parameter: what remains is
   * the pane id to close and the runner that closes it.
   */
  interface JudgeCloseCtx {
    ownPane: string | undefined;
    tmuxServer: string | undefined;
    run: JudgePaneRunner;
  }

  /**
   * Close ONE judge's WINDOW.
   *
   * ONE copy, two callers (the `fresh` kill and the lane retire). It was two
   * copies for exactly one round — they sat 150 lines apart and differed only
   * in which variable held the entry, which is how a rule with six copies gets
   * its seventh (reviewer P2, 2026-09-05). Those two copies also each carried
   * a copy of the label-bar release; that whole judgement is gone
   * (2026-09-17), so what is left is the close itself.
   *
   * A WINDOW since 2026-09-25, addressed `<tmuxSession>:<windowId>` from the
   * entry itself, and only when `windowClosable` accepts both halves — a judge
   * from an older build (no window recorded) is not closed by a guess, which
   * is the same fail-closed rule its own `judge_close` applies.
   */
  function closeJudgePaneOf(entry: JudgeEntry, ctx: JudgeCloseCtx): void {
    if (!windowClosable(entry, ctx.tmuxServer)) return;
    try {
      closeSessionWindow(ctx.run, { ownSession: entry.tmuxSession, windowId: entry.windowId });
    } catch { /* best effort */ }
  }

  /**
   * Retire a lane the gate has stopped using: close its pane, forget its
   * row, and let its session dir age out where it stands.
   *
   * The dir is deliberately NOT deleted. "Archived in place" is the user's own
   * shape (2026-09-05): the transcript stays readable, and the existing TTL
   * sweep reclaims it once nothing in the registry points at it — which is
   * true the moment this function returns.
   *
   * CALL IT ONLY ONCE THE REPLACEMENT LANE IS REGISTERED. Dropping the row is
   * what makes the retirement irreversible: a dispatch that fails AFTER this
   * (no tmux, no model chain) would leave the next one with no previous lane
   * at all, and "no previous lane" decides `first` at generation 0 — which
   * resumes the very transcript that was just rotated away, with the round
   * count back at one (reviewer P2, 2026-09-05).
   */
  function retireJudgeLane(
    entry: JudgeEntry,
    ctx: JudgeCloseCtx & { root: string },
  ): void {
    const usable = paneIdUsable(entry, ctx.tmuxServer);
    const alive = usable && entry.paneId
      ? judgePaneAlive(ctx.run, entry.paneId)
      : undefined;
    if (alive === true) closeJudgePaneOf(entry, ctx);
    // The retired lane's scratch worktrees can never be used again — whether
    // its pane was closed here or had already died.
    reapReviewScratch(entry.judgeId);
    setHierarchy(removeJudge(judgeHierarchy, entry.judgeId));
    // An audit pending against the retired lane dies with it: a report from
    // the NEW lane must never be recorded against a draft it never judged.
    if (entry.role === "goal-auditor") dropAudits(ctx.root);
  }


  /**
   * Dispatch ONE round to a judge role — the single place a judge process is
   * ever started, and the only owner of its identity.
   *
   * Identity is a function of role + repo, never of the round: the session id
   * (the resume key) and the WORK DIR (B5 — a title-derived dir gave pi a new
   * `--session-dir` every round, so the "resumed" session started from zero)
   * both come from `role + repoHash + opener`. The title is a display label, and only
   * reaches `--name` and diagnostics.
   *
   * Reuse is the default and is what carries a judge's context across rounds:
   * an alive same-role process is left running and simply re-watched; a
   * finished one is dropped and re-spawned under the SAME session id, so pi
   * appends to the same transcript. `fresh` kills the incumbent first.
   */
  async function dispatchJudgeRound(opts: {
    root: string;
    role: string;
    title: string;
    task: string;
    fresh?: boolean;
    /** This round's findings stream, recorded on the child for judge_wait. */
    streamPath?: string;
    /**
     * THE ONE WAY PAST THE QUALITY PRECONDITION (2026-09-16): the caller
     * dispatched THIS ROUND's quality judge itself, a line above, and the
     * standing is checked when the verdict is recorded instead. Only
     * `judge_submit`'s parallel path may pass it — it is never derived from the
     * registry, because that would make the gate unfalsifiable (the quality
     * pane is reused and stays alive).
     */
    qualityRoundDispatched?: boolean;
  }): Promise<JudgeDispatch> {
    const { root, role } = opts;
    dropDeadForeignJudges();
    // THE QUALITY PRECONDITION (2026-09-15). This is the mechanical fact that
    // makes the quality round unbypassable rather than a convention: no
    // registered target, or no quality standing bound to its head, and the
    // reviewer is NOT dispatched.
    //
    // IT NO LONGER GATES THE PARALLEL PATH (2026-09-16): the one submission that
    // starts both judges passes `qualityRoundDispatched`, because it dispatched
    // the quality judge itself and the standing is checked at RECORD time
    // instead (`decideQualityHold` — a functional READY is held until the
    // quality verdict stands). That flag is an explicit argument from that one
    // call site, NEVER inferred from the registry: inferring it would turn the
    // mechanical guarantee into an always-true condition.
    //
    // Two exemptions remain, and both live in the rule (lib/quality-round.ts):
    // a round that carries no code at all (recorded as a skip), and a pass
    // already bound to this head (a re-submission after a dead pane).
    if (role === "reviewer" && opts.qualityRoundDispatched !== true) {
      const target = reviewTargets.get(root);
      if (!target) {
        return { ok: false, reused: false, error: "没有登记在案的审查范围（prepare 未跑）—— 不能派 reviewer。" };
      }
      const standing = qualityStandingFor({
        head: target.head,
        // Absent means "unknown", and unknown is treated as code-bearing —
        // never as "nothing to judge" (lib/quality-round.ts).
        files: target.files,
        quality: stateForRepo(root).quality,
        stageOn: stageIsOn("quality", root),
      });
      if (!standing.ok) {
        return { ok: false, reused: false, error: `质量轮还没有放行这一轮 —— ${standing.reason}` };
      }
    }
    const title = opts.title.replace(/[^A-Za-z0-9._-]/g, "-") || role;
    const opener = callerIdentity();
    if (!opener) {
      return { ok: false, reused: false, error: "无法确认调用者身份——身份不明时不能派 review。" };
    }
    sweepStaleJudgeSessionDirs(root);
    // THE LANE this round runs in, resolved ONCE (lib/judge-rotation.ts) and
    // handed to every derivation below. The session id, the work dir and the
    // registry row all render from this one value, which is the only way they
    // cannot end up naming different lanes.
    const rotation = resolveJudgeLane(root, role, opener);
    const lane = rotation.decision.lane;
    const sessionId = judgeSessionIdFor(role, shortRepoHash(root), opener, lane);
    const judgeId = sessionId;
    // STABLE per role+repo+opener+lane (B5) — identity, not a per-round path.
    const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener, lane));
    const sessionDir = pathJoin(workDir, "sessions");
    const continuesSession = hasTranscript(sessionDir);
    const ownPane = process.env.TMUX_PANE?.trim() || undefined;
    const run = (argv: readonly string[]) => runTmux(argv);
    // Stamped on every entry that records a pane, and checked before any use
    // of a recorded one (see lib/hierarchy.ts `paneClosable`).
    const tmuxServer = tmuxServerFrom(process.env);


    // The task text a rotated round is sent with: the history is gone, so the
    // hand-off (rendered by lib/review-carryover.ts, never re-written here)
    // travels in the task itself. A normal round passes through untouched.
    const task = rotationHandoffTask({
      role,
      task: opts.task,
      decision: rotation.decision,
      ...rotationCarryoverFacts(root, role, rotation.decision),
    });

    // Opener-scoped ids do not collide across sessions by construction: a second
    // opener derives a different id and opens its own review. Cross-opener protection
    // still lives in lib/hierarchy.ts (registration refuses two parents for one id).
    // The lookup IS that derivation: the registry is keyed by judge id, so
    // "same role, same session id in this repo" needs no scan of a second table.
    const existing = judgeHierarchy[judgeId];
    // FIRST, before the entry below is replaced: what the pane said about its
    // own model belongs to THIS decision (an exhausted chain never settles, so
    // a dispatch is the only reader such events ever get), and the cursor they
    // must be read against lives on the entry that is about to be rewritten.
    absorbJudgeModelEvents(root, judgeId);

    // THE LANE BOOKKEEPING every registration below writes, so the next
    // dispatch can make the same decision from the registry alone.
    // `roundsInObject` is counted at DISPATCH (abandoned rounds included), and
    // the judge's last context reading survives a REUSE but never a rotation:
    // a new transcript starts empty, and carrying the old number forward would
    // rotate the new one immediately.
    const laneFields = {
      objectId: lane.objectId,
      generation: lane.generation,
      roundsInObject: rotation.decision.roundsInObject,
      ...(rotation.decision.rotated || existing?.contextPercent === undefined
        ? {}
        : { contextPercent: existing.contextPercent }),
    };

    // A recorded pane is probed only when its id is still comparable: an entry
    // restored from disk may have been minted by a tmux server that has since
    // restarted, and `%7` would then be a stranger's pane — reusing it would
    // send this round's task into it. Not comparable ⇒ treat as dead, which
    // falls through to a fresh open below (transcript continues by id).
    // `paneIdUsable`, NOT `windowClosable`: this asks whether the recorded PANE
    // is still comparable (may I reuse it / am I waiting on it), while
    // `windowClosable` answers the narrower "may I kill it" — inside
    // `closeJudgePaneOf`. Judging reuse with the kill's rule made a live judge
    // pane from before the window topology look dead, and the dispatch opened a
    // SECOND window for the same judge id (2026-09-25, quality round P2).
    const paneUsable = existing !== undefined && paneIdUsable(existing, tmuxServer);
    const paneAlive = paneUsable && existing?.paneId ? judgePaneAlive(run, existing.paneId) : undefined;
    // A living pane takes the round through its channel: the pane is the
    // CARRIER, the round is the task. No busy refusal exists anymore — a pane judge
    // reads every round via its drain; only a one-shot process read once.
    if (existing?.paneId && paneAlive === true && !opts.fresh) {
      // THE ROUND NUMBER IS COMPUTED BEFORE THE RECORD IS WRITTEN, and that
      // order is half the fix (2026-09-16). The entry used to be numbered at
      // the END of this block, while the task sat queued on the wire — so a
      // pane finishing its PREVIOUS round in that window read the NEW number
      // and stamped the OLD conclusion with it: the old verdict landed on the
      // new round, and the real new one was then refused as a duplicate
      // (measured: a quality round's BLOCKED verdict booked as round 2, and
      // round 2's own conclusion dropped). Sending the number WITH the task is
      // what makes "which round am I concluding" a fact the judge owns.
      const roundSeq = nextJudgeRound(opener, judgeId);
      try {
        appendRecord(channelIO, judgeChannelTarget(opener, judgeId), {
          kind: "instruct",
          // `from` names the OPENER side of the file — planes differ by key.
          from: "orchestrator",
          at: new Date().toISOString(),
          instructId: newChannelId("in", Date.now()),
          // INTERRUPT, not followUp (user decision 2026-09-16): a re-dispatch
          // means the content under review CHANGED, so waiting for the round
          // in flight means waiting out a verdict on code that is already gone
          // — and that wait was also the window the numbering raced in.
          // `interrupt` stops it and delivers this task now.
          mode: "interrupt",
          roundSeq,
          text: task,
        });
      } catch (err) {
        // NOT DELIVERED: the reuse wrote nothing, so this round's task never
        // reached the judge — the pane being alive says nothing about it.
        return { ok: false, reused: true, delivered: false, sessionId, sessionDir, paneId: existing.paneId, judgeId, error: `本轮任务写不进通道 —— ${(err as Error).message}` };
      }
      // ONE write, not two: the Map used to be mutated here (streamPath,
      // spawnedAt) and the table registered right after, which is exactly how
      // the two drifted apart.
      // The wait cursors survive a re-dispatch: already-consumed reports must
      // not end the new round's wait (stale-report P0 — a wiped cursor ends
      // every fresh wait on the previous round's report instantly). The
      // FINDING cursor survives too, but only while the round writes to the
      // SAME stream file: a new stream starts at zero, and a reused one (a
      // re-audit of the same draft) must not replay what was already shown.
      const keptCursor = existing.lastReportId;
      const keptFindings = existing.streamPath === opts.streamPath
        ? existing.lastFindingCount
        : undefined;
      // `existing` was captured BEFORE this dispatch's absorb (which runs above,
      // on entry) — so its cursors can be one step behind the table. Reading the
      // entry again here is what keeps the absorb's cursor advance from being
      // rolled back by this registration (P1, reviewer round 2): a rolled-back
      // cursor hands the SAME events to the next round, and re-recording them
      // with `Date.now()` makes the cooldown永不过期.
      const live = judgeHierarchy[judgeId] ?? existing;
      const reg = registerJudge(judgeHierarchy, {
        judgeId, openerId: opener, role, repoRoot: root, title, sessionDir,
        // WHERE THE LIVE PANE IS, carried forward as one value (`paneCoordsOf`):
        // a re-registration that copies only some of these fields leaves an
        // entry its own close path must then refuse — the pane is alive, on
        // screen, and unaddressable (2026-09-25, quality round P1).
        ...paneCoordsOf(live),
        roundSeq,
        // The pane's model does not change because a new round was queued into
        // it — the entry keeps saying what the RUNNING pane was launched on.
        ...(live.modelSpec === undefined ? {} : { modelSpec: live.modelSpec }),
        // The MODEL-EVENT cursor survives for the same reason the report cursor
        // does: the channel is append-only across rounds, so a reset cursor
        // would hand this round the PREVIOUS round's events — and a stale
        // `exhausted` one would end a perfectly healthy round on its first
        // probe (the audit chains end with it too).
        ...(live.lastModelEventCount === undefined ? {} : { lastModelEventCount: live.lastModelEventCount }),
        ...(keptCursor === undefined ? {} : { lastReportId: keptCursor }),
        ...(keptFindings === undefined ? {} : { lastFindingCount: keptFindings }),
        ...(opts.streamPath === undefined ? {} : { streamPath: opts.streamPath }),
        ...laneFields,
        spawnedAt: new Date().toISOString(),
      });
      if (reg.ok) setHierarchy(reg.table);
      // The replacement lane is registered — only now may the lane it replaces
      // be closed and forgotten (a no-op on the normal reuse path, where the
      // "previous" lane IS this one).
      rotation.retirePrevious();
      return { ok: true, reused: true, sessionId, sessionDir, paneId: existing.paneId, judgeId };
    }
    // fresh:true kills the living pane FIRST (singleton per role+repo).
    // A dead record falls through to a fresh open below (the transcript
    // continues by session id, so the review never starts from zero).
    if (existing) {
      if (existing.paneId && paneAlive === true && opts.fresh) {
        // FIFTH CLOSE PATH (reviewer, 2026-09-05). A `fresh` round kills the
        // incumbent and re-opens immediately, so the border line would come
        // straight back — and the re-open can FAIL (no model chain, tmux
        // gone), which is why this close also drops the registry row. It used
        // to hand that failure to a label-bar judgement so the bar would not
        // be stranded; there is nothing to strand any more (2026-09-17: the
        // bar is turned on and left on).
        closeJudgePaneOf(existing, { ownPane, tmuxServer, run });
      }
      if (paneAlive === false) reapReviewScratch(sessionId);
      // One removal, one table.
      setHierarchy(removeJudge(judgeHierarchy, judgeId));
      // The killed round's audited draft dies with it: leaving it behind
      // would let a LATER report record a verdict against a draft that round
      // never judged.
      if (existing.role === "goal-auditor") dropAudits(root);
    }
    if (!ownPane) {
      return { ok: false, reused: continuesSession, sessionId, sessionDir, error: "当前会话不在 tmux 里，开不出 review pane——在 tmux 中重开本会话后重试；门禁不会退回旧的进程壳子。" };
    }
    try {
      const launch = resolveJudgeLaunch(root, role, workDir, title, judgeId);
      if (!launch.ok) {
        return { ok: false, reused: continuesSession, sessionId, sessionDir, error: launch.error };
      }
      const files = { sysPromptPath: launch.sysPromptPath, model: launch.spec };
      // "Reused" is a fact about the SESSION, not about the pane: the
      // transcript decided it above, before this round could add to it.
      mkdirSync(sessionDir, { recursive: true });
      const taskPath = pathJoin(sessionDir, `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.md`);
      writeFileSync(taskPath, task, "utf8");
      // fresh:true starts a NEW review object: everything the channel holds so
      // far belongs to an older object and must never end this round's wait.
      // Seed the cursor at the channel's current newest report (best-effort —
      // an unreadable channel leaves it unset, and the round check at record
      // time still refuses old rounds). Read BEFORE the pane opens, so a fast
      // judge's first record cannot land inside the read.
      const freshTarget = judgeChannelTarget(opener, judgeId);
      const judgeChannelPath = channelPathFor(freshTarget.orchestrationId, freshTarget.childId, freshTarget.home);
      let freshCursor: string | undefined;
      let freshModelEventCount: number | undefined;
      try {
        const freshProjection = projectChannel(readChannel(channelIO, judgeChannelPath).records);
        freshCursor = freshProjection.lastReport?.reportId;
        // The SAME watermark rule for the model events: the channel is
        // append-only, so a fresh entry that started at zero would replay every
        // old failure — including an `exhausted` event that would end this
        // round's very first probe.
        freshModelEventCount = freshProjection.modelEvents.length;
      } catch { freshCursor = undefined; freshModelEventCount = undefined; }
      // A judge's channel OUTLIVES its panes, so only a record ABOVE this
      // watermark proves that the pane opened below actually came up.
      const baselineRecords = channelRecordCount(channelIO, judgeChannelPath);
      const opened = await openSessionWindow(run, {
        scope: tmuxScope,
        cwd: root,
        layout: "own-session-window",
        role: {
          kind: "judge",
          openerId: opener,
          judgeId,
          role,
          ...(opts.streamPath === undefined ? {} : { streamPath: opts.streamPath }),
        },
        command: buildJudgePaneCommand({
          sessionId,
          taskPath,
          sessionDir,
          sysPromptPath: files.sysPromptPath,
          model: files.model,
        }),
        decor: judgePaneDecor(judgeId, role, paneOwnerIdentity()),
        // ONE write, one table, and it happens inside the open: the entry used
        // to be built here and mutated a second time, which is exactly how the
        // two drifted apart.
        register: (coords) => {
          const reg = registerJudge(judgeHierarchy, {
            judgeId,
            openerId: opener,
            role,
            repoRoot: root,
            title,
            sessionDir,
            paneId: coords.paneId,
            // The window and its session, recorded with the pane id: they are
            // what closes this judge (`kill-window -t <session>:<@window>`),
            // and the session half is what keeps the kill inside ours.
            ...(coords.windowId === undefined ? {} : { windowId: coords.windowId }),
            ...(coords.sessionName === undefined ? {} : { tmuxSession: coords.sessionName }),
            roundSeq: nextJudgeRound(opener, judgeId),
            ...(tmuxServer === undefined ? {} : { tmuxServer }),
            ...(freshCursor === undefined ? {} : { lastReportId: freshCursor }),
            ...(freshModelEventCount === undefined ? {} : { lastModelEventCount: freshModelEventCount }),
            // Which model this pane was launched on — the round's receipt says
            // who actually ran it (the pane may rotate later; that reports
            // itself through the channel).
            modelSpec: launch.spec,
            // Same rule as the reuse path: a re-run over the SAME stream file keeps
            // its finding cursor, so nothing already shown is shown again.
            ...(judgeHierarchy[judgeId]?.streamPath === opts.streamPath
              && judgeHierarchy[judgeId]?.lastFindingCount !== undefined
              ? { lastFindingCount: judgeHierarchy[judgeId]!.lastFindingCount }
              : {}),
            ...(opts.streamPath === undefined ? {} : { streamPath: opts.streamPath }),
            ...laneFields,
            spawnedAt: new Date().toISOString(),
          });
          if (reg.ok) setHierarchy(reg.table);
        },
        // EARN the receipt for a judge too: a judge that never boots leaves its
        // opener waiting forever, which is the one silence nobody can break.
        verify: () => verifyJudgeBoot(
          { channelIO: () => channelIO, sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)) },
          { channelPath: judgeChannelPath, baselineRecordCount: baselineRecords },
        ),
      });
      if (!opened.ok) {
        // A delivery failure KEEPS the pane and the registration (it may only
        // be slow), so the opener can still wait on it; anything else means no
        // pane exists at all.
        const detail = opened.deliveryFailed
          ? `review pane 开出来了（${opened.paneId}）但一直没在通道上报状态 —— ${opened.error}；` +
            "pane 与登记都保留着，可以先 judge_wait 看它有没有动静，确认没起来再用 fresh:true 重来。"
          : opened.error;
        // A pane that EXISTS (delivery failure) is a registered replacement
        // lane, so the old one is finished either way; a pane that never
        // opened leaves the previous lane alone, and the next dispatch decides
        // the same rotation again from a registry that still has it.
        if (opened.deliveryFailed) rotation.retirePrevious();
        // `deliveryFailed` is NOT "the task was lost": the pane exists and
        // was KEPT, and what failed is the BOOT VERIFICATION — the judge task
        // itself rode in on argv (lib/session-factory.ts). So a pane that
        // never acknowledged is still a delivered round the opener may wait
        // on, which is exactly what `delivered: true` means here (quality
        // round P2, 2026-09-16: the inverted-looking line needs to say so).
        return { ok: false, reused: continuesSession, delivered: opened.deliveryFailed === true, sessionId, sessionDir, error: detail, ...(opened.paneId === undefined ? {} : { paneId: opened.paneId }), judgeId };
      }
      // The new pane is up and registered: the lane it replaces is now safe to
      // close and forget (idempotent, and a no-op when nothing changed).
      rotation.retirePrevious();
      return { ok: true, reused: continuesSession, sessionId, sessionDir, paneId: opened.paneId, judgeId };
    } catch (err) {
      return { ok: false, reused: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Read a finished judge's conclusion and RECORD it — the gate's job, not
   * the agent's.
   *
   * The agent used to copy the reviewer's output into a recording tool by
   * hand: a transcription step with nothing creative in it, which could
   * silently carry the wrong round's text. The recorders keep every mechanical
   * check they had (no-prepare refusal, STALE detection, cwd
   * match, tree binding) — this only removes the copying.
   *
   * Returns the recorded summary, or undefined when there was nothing to
   * record (no report for this round yet, an adviser, an unknown child) — the
   * caller then simply tells the agent to read the child.
   */
  /** This round's raw output, or undefined when the log is unreadable. */
  function readRoundStdout(path: string): string | undefined {
    try {
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    } catch {
      return undefined;
    }
  }

  // `repoOfChild` is gone with the Map: an entry carries its own `repoRoot`,
  // so "which repo does this judge belong to" is a field read, not a search
  // through a second registry keyed by root.

  /** Advance the consumed cursor so a surfaced-but-unrecorded report is not re-announced. */
  function advanceReportCursor(sessionId: string, reportId: string): void {
    const entry = judgeHierarchy[sessionId];
    if (!entry || entry.lastReportId === reportId) return;
    const reg = registerJudge(judgeHierarchy, { ...entry, lastReportId: reportId });
    if (reg.ok) setHierarchy(reg.table);
  }

  /**
   * Record what a judge last said about its OWN context usage.
   *
   * The reading only exists inside the judge's process, so it rides its report
   * (lib/orchestrator-channel.ts) and lands here — the opener's registry —
   * where the next dispatch's rotation policy reads it. Taken from the NEWEST
   * report that carries one: a report from an older build carries none, and
   * "none" must leave the previous reading alone rather than erase it.
   */
  function noteJudgeContextFrom(judgeId: string, records: readonly ChannelRecord[]): void {
    const entry = judgeHierarchy[judgeId];
    if (!entry) return;
    let percent: number | undefined;
    for (const record of records) {
      if (record.kind !== "report") continue;
      const reading = sanitizeContextPercent((record as ChannelReportRecord).contextPercent);
      if (reading !== undefined) percent = reading;
    }
    if (percent === undefined || percent === entry.contextPercent) return;
    const reg = registerJudge(judgeHierarchy, { ...entry, contextPercent: percent });
    if (reg.ok) setHierarchy(reg.table);
  }

  /**
   * Close one judge's round — the SETTLE path's entry into the engine.
   *
   * Everything that used to live here (pick this round's report, keep the
   * adviser's prose out of the record, route a verdict to the right recorder,
   * advance the cursor exactly once) is now `settleAuditRound` in
   * lib/audit-round.ts, shared with `judge_wait` and with the synchronous
   * audits. This function only translates the outcome into the shape the two
   * callers here already speak.
   */
  async function recordJudgeConclusion(sessionId: string, ctx?: unknown): Promise<{ text?: string; recorded: boolean; bindingNote?: string; handOffNote?: string; scope?: ScopeStampRecord } | undefined> {
    try {
      const entry = judgeHierarchy[sessionId];
      if (!entry?.role) return undefined;
      const childRoot = entry.repoRoot || primaryRepoRoot;
      // The pane's own model report is a fact about the round that is ending
      // here: cool the bad slot down, warn, advance the cursor. This sweep (a
      // session that was NOT blocked in a wait) is a second settle entry point
      // and must read it the same way the wait does — the absorb is idempotent.
      absorbJudgeModelEvents(childRoot, sessionId);
      const settled = await settleAuditRound(auditRoundDeps(ctx), { judgeId: sessionId, root: childRoot });
      switch (settled.status) {
        case "recorded": {
          // A quality round OWNS the functional round that is waiting on it:
          // releasing it (or killing it) is part of the record landing, not a
          // follow-up the agent has to remember (philosophy one).
          const handOffNote = await applyRoundCancel(settled.kind, childRoot, ctx);
          return {
            text: settled.text,
            recorded: true,
            // Its OWN field, not a second line of `text`: the standard report
            // prints the recorded note first-line-only, so a hand-off appended
            // there would never be read (reviewer P1, 2026-09-15).
            ...(handOffNote === undefined ? {} : { handOffNote }),
            // Travels separately: the wake-up prints the record's first line
            // only, and a weaker binding nobody reads about is a silent one.
            ...(settled.bindingNote === undefined ? {} : { bindingNote: settled.bindingNote }),
            // The scope the round stamped on itself, for the same reason: the
            // wake-up is where the opener finds out WHAT was reviewed, and a
            // range recorded somewhere nobody prints is a range nobody checks.
            ...(settled.scope === undefined ? {} : { scope: settled.scope }),
          };
        }
        case "advice":
          return { text: settled.text, recorded: false };
        case "miss":
          // A consumed report on a cursor-bound round says nothing (it is
          // already recorded); every other miss carries its fail-closed text.
          return settled.text === undefined ? undefined : { text: settled.text, recorded: false };
        case "unrecorded":
          return { recorded: false }; // no ctx: stay armed, retry next settle
        default:
          return undefined;
      }
    } catch {
      return undefined; // recording is best-effort
    }
  }

  /**
   * Wake on finished rounds (criterion 4): for every judge THIS session opened,
   * probe the SAME criterion judge_wait used (a new channel report ends the
   * round) and deliver the gate-built standard report — verdict, evidence
   * pointer, record note, open questions — via followUp. Pane-dead rounds stay
   * with the watchdog below (no second waiter). Returns true when it woke.
   */
  async function settleFinishedRounds(ctx: ExtensionContext): Promise<boolean> {
    // A PARKED CONCLUSION IS RE-ASKED HERE, ONCE PER SETTLE (2026-09-16).
    //
    // The two landings that can release a hold (the precommit lane, the quality
    // round) both call it themselves; this call is the BACKSTOP for the case
    // where the second one will never come — a quality pane that died after the
    // record was parked, a lane that was aborted by the USER. Without it the
    // record would sit in the sidecar forever while the reply had already told
    // the agent not to re-submit, which is the one failure mode a hold may not
    // have (`decideQualityHold` refuses rather than holds whenever nobody can
    // end it; this covers the pane dying afterwards).
    for (const root of sessionRepos) await resumeParkedReady(root, ctx);
    // A judge may have handed its round to a successor since the last sweep:
    // the new session has a new id, hence a new channel, and this merge is what
    // makes the opener look there.
    reloadJudgeHierarchy(primaryRepoRoot);
    // A handover does not orphan the predecessor's judges: this session is
    // responsible for its own identity AND the one it replaced.
    const mine = new Set(callerIdentities());
    if (mine.size === 0) return false;
    const deps = {
      channelIO: () => channelIO,
      channelHome: () => undefined,
      tmux: (argv: readonly string[]) => runTmux(argv),
      now: () => Date.now(),
      tmuxServer: () => tmuxServerFrom(process.env),
      paneOwner: () => paneOwnerIdentity(),
    };
    const notices: string[] = [];
    for (const [judgeId, entry] of Object.entries(judgeHierarchy)) {
      if (!mine.has(entry.openerId)) continue;
      const target = judgeChannelTarget(entry.openerId, judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      const projection = projectChannel(read.records);
      const freshQuestions = (projection.openRequests ?? []).filter((q) => !announcedRequestIds.has(q.requestId));
      // The sweep probes with the SAME binding the recorder will apply, so it
      // can no longer wake the agent about a round the recorder refuses to
      // close (2026-09-05).
      const obs = probeJudgeRound(
        deps,
        judgeChildRecordOf(entry, entry.repoRoot ?? primaryRepoRoot),
        entry.lastReportId,
        roundBindingOf({ judgeId, role: entry.role, repoRoot: entry.repoRoot ?? primaryRepoRoot }),
      );
      if (!obs.done || obs.reason !== "report") {
        // No new report: announce only brand-new questions (once each) — and,
        // when one goes out, say which leftover report was set aside with it.
        for (const q of freshQuestions) {
          announcedRequestIds.add(q.requestId);
          notices.push(buildStandardReport({
            role: entry.role,
            judgeId,
            ...(entry.modelSpec === undefined ? {} : { modelSpec: entry.modelSpec }),
            openQuestions: [{ title: q.title, options: q.options, requestId: q.requestId }],
            ...(obs.notThisRound === undefined ? {} : { notThisRound: obs.notThisRound }),
          }));
        }
        continue;
      }
      const conclusion = await recordJudgeConclusion(judgeId, ctx);
      if (!conclusion) continue; // consumed elsewhere between probe and record
      for (const q of freshQuestions) announcedRequestIds.add(q.requestId);
      notices.push(buildStandardReport({
        role: entry.role,
        judgeId,
        ...(entry.modelSpec === undefined ? {} : { modelSpec: entry.modelSpec }),
        verdict: obs.verdict,
        findingsCount: obs.findingsCount,
        conclusionExcerpt: entry.role === "adviser" ? conclusion.text : undefined,
        streamPath: entry.streamPath,
        recordedNote: conclusion.recorded ? conclusion.text : undefined,
        bindingNote: conclusion.bindingNote,
        // The hand-off reported on ITS own line: folded into the recorded note
        // it would be invisible (that line prints first-line-only), and the
        // agent would wait for a reviewer the gate failed to start.
        handOffNote: conclusion.handOffNote,
        scope: conclusion.scope,
        unrecorded: !conclusion.recorded && entry.role !== "adviser" ? true : undefined,
        openQuestions: freshQuestions.map((q) => ({ title: q.title, options: q.options, requestId: q.requestId })),
      }));
    }
    if (notices.length === 0) return false;
    pi.sendUserMessage(
      notices.join("\n\n") + "\n\nContinue: drive the loop forward from the report(s) above. Do not summarize; execute.",
      { deliverAs: "followUp" },
    );
    return true;
  }

  /**
   * Run the gate's own verdict recording on exact reported bytes — the ONE
   * recorder behind both judge_wait's dep and recordJudgeConclusion, so one
   * round is never recorded twice through two paths.
   */
  // The stale-report guard that used to live here is GONE as a second entry
  // point: `selectRoundReport` (lib/audit-round.ts) answers "which report
  // closes this round" for every kind, and `settleAuditRound` is the only
  // caller. Two entry points are how the goal path and the plan path ended up
  // fail-closing on subtly different conditions.

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

  /** `checkpoint.at` of one repo — the content stamp a review verdict binds to. */
  function checkpointAtFor(root: string): string | undefined {
    const st = root === primaryRepoRoot ? state : stateForRepo(root);
    return st.checkpoint?.at;
  }

  /**
   * THIS round's report binding, derived ONCE and handed to both readers.
   *
   * The recorder (`settleAuditRound`) and the probe (`judge_wait`, the settle
   * sweep) have to agree on "is this report this round's?", and while they did
   * not, a leftover reviewer report ended the wait as a READY that the recorder
   * then bound to a commit the reviewer never saw (four reproductions,
   * 2026-09-05). The RULE lives in lib/audit-round.ts; this only supplies the
   * three facts it needs from THIS session — the pending audit kind, the round
   * this dispatch registered, and the repo's checkpoint stamp.
   */
  function roundBindingOf(judge: { judgeId: string; role: string; repoRoot: string }): RoundBinding {
    const roundSeq = judgeHierarchy[judge.judgeId]?.roundSeq;
    const pendingKind = pendingAudits.get(judge.repoRoot)?.kind;
    const checkpointAt = checkpointAtFor(judge.repoRoot);
    return roundBindingFor({
      role: judge.role,
      ...(pendingKind === undefined ? {} : { pendingKind }),
      ...(roundSeq === undefined ? {} : { roundSeq }),
      ...(checkpointAt === undefined ? {} : { checkpointAt }),
    });
  }

  /**
   * WHAT THE AUDIT-ROUND ENGINE NEEDS FROM THIS SESSION.
   *
   * The engine (lib/audit-round.ts) owns the DECISIONS — which report closes
   * this round, whether anything may be recorded, which kind's binding
   * applies, when the cursor advances. This object owns only the things it
   * cannot: the channel, the opener registry, gate state and the two record
   * writers whose bodies this refactor deliberately left alone
   * (`recordGoalPrereview` and `recordReviewVerdict` — the review one carries
   * the HEAD/TREE bindings a READY hangs on).
   *
   * `ctx` is the live tool context when there is one; without it the writers
   * fall back to the last UI context, and with neither they record NOTHING and
   * say so, which the engine turns into "stay armed, retry next settle".
   */
  /**
   * THE ONE CLOSE PATH for a judge THIS session opened.
   *
   * Two callers, one implementation (2026-09-21): the gate's synchronous
   * chains (`auditRunDeps.closeJudge`) and the round-end reclaim that now
   * frees an AGENT-dispatched review pane too
   * (`auditRoundDeps.reclaimJudgePane`). They are one function on purpose —
   * "read hadPane BEFORE the close, close by judgeId, map the reply's outcome"
   * is exactly the sequence whose two copies drift, and a reclaim that reports
   * the wrong outcome is a leftover pane nobody can find again (`judge_close`
   * drops the registry row even when the kill fails).
   *
   * SAME BYPASS AS THE WAIT (2026-09-08): the gate reclaims a judge it opened
   * itself — `callTool("judge_close", { repo: root })` would refuse on an
   * unedited repo and leak the pane (measured: five "judge pane 回收失败…is not
   * one of the repositories" in the audit log). `doClose` by judgeId keeps the
   * opener check and skips only the repo-addressing.
   */
  async function closeOwnedJudge(
    root: string,
    judgeId: string | undefined,
    role: string,
  ): Promise<JudgePaneReclaimOutcome> {
    // `hadPane` is read HERE, before the close, because it is the only moment
    // it is still knowable.
    const hadPane = judgeChildByRole(root, role)?.paneId !== undefined;
    if (judgeId === undefined) {
      return { ok: true, hadPane: false, terminated: false, note: "no judge on record — nothing to close." };
    }
    const closed = await doClose(selfSessionDeps(), { role, sessionId: judgeId }, true); // gateSelf: this session opened it
    return {
      ok: closed.isError !== true && (closed.details as { closed?: unknown } | undefined)?.closed === true,
      hadPane,
      terminated: (closed.details as { terminated?: unknown } | undefined)?.terminated === true,
      note: toolText(closed as { content: { type: string; text: string }[] }).split("\n")[0]?.trim() || undefined,
    };
  }

  function auditRoundDeps(ctx?: unknown): SettleAuditRoundDeps {
    return {
      judgeEntry: (judgeId) => {
        const e = judgeHierarchy[judgeId];
        if (!e) return undefined;
        return {
          judgeId: e.judgeId,
          openerId: e.openerId,
          role: e.role,
          ...(e.roundSeq === undefined ? {} : { roundSeq: e.roundSeq }),
          ...(e.lastReportId === undefined ? {} : { lastReportId: e.lastReportId }),
        };
      },
      readRoundRecords: (entry) => {
        try {
          const target = judgeChannelTarget(entry.openerId, entry.judgeId);
          const records = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home)).records;
          // The same read that finds this round's report also carries the
          // judge's own context reading — the one fact the opener cannot
          // measure and the rotation policy needs before the NEXT dispatch.
          noteJudgeContextFrom(entry.judgeId, records);
          return records;
        } catch {
          return []; // an unreadable channel is "no report", never a verdict
        }
      },
      conclusionOf: (report) => reportConclusion(channelIO, report),
      proseOf: (report) => reportText(channelIO, report),
      advanceCursor: (judgeId, reportId) => advanceReportCursor(judgeId, reportId),
      // ROUND END FREES THE PANE (2026-09-21, user decision): a review pane no
      // longer waits for declare_done. The verdict is already on record — what
      // the judge produced is the opener's — so the pane is screen space, and
      // closing it costs no context: the next `judge_submit` for this role
      // finds a dead pane and re-opens the SAME session id, transcript and all.
      reclaimJudgePane: async (root, judgeId, role) => {
        const outcome = await closeOwnedJudge(root, judgeId, role);
        // SILENCE IS THE NORMAL CASE (lib/judge-pane-policy.ts): a reclaim that
        // did what the policy promises is not news, and a log that records every
        // success is a log nobody greps. A line appears only when the pane's fate
        // is NOT what the policy promises — which is the one moment the leftover
        // pane would otherwise become unfindable (the registry row is dropped
        // even when the kill failed).
        const line = reclaimAuditLine({ role, policy: JUDGE_PANE_RECLAIM, outcome });
        if (line !== undefined) log(line);
        return outcome;
      },
      pendingAudit: (root) => pendingAudits.get(root),
      forgetPending: (root) => dropAudits(root),
      nowIso: () => new Date().toISOString(),
      checkpointAt: (root) => checkpointAtFor(root),
      savePlanAudit: (root, record) => {
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        st.planAudit = record;
        // (The audit VERDICT is written to `.pi/review-gate-audit.log` by
        // lib/audit-round.ts itself, through the `log` binding below — the
        // record and its trail are decided in one place, not two.)
        try {
          const persistCtx = latestCtx ?? lastUiCtx;
          if (persistCtx) persistRepo(persistCtx, root); else persist(undefined);
        } catch { /* best effort */ }
      },
      log: (message) => { log(message); },
      recordGoal: async ({ root, pending, concluded }) => {
        const recordCtx = ctx ?? lastUiCtx;
        if (!recordCtx) return undefined;
        return recordGoalPrereview(goalPrereviewDeps, {
          goal: pending.draft,
          conclusion: concluded,
          auditStartedAt: pending.startedAt,
          repo: root,
        }, recordCtx);
      },
      // The repo is named explicitly: a multi-repo session refuses an
      // unqualified record, and a verdict must never depend on which repo was
      // edited last.
      recordReview: async ({ root, concluded }) => {
        const recordCtx = ctx ?? lastUiCtx;
        if (!recordCtx) return undefined;
        return recordReviewVerdict(concluded, root, recordCtx);
      },
      recordQuality: async ({ root, concluded }) => {
        const recordCtx = ctx ?? lastUiCtx;
        if (!recordCtx) return undefined;
        return recordQualityVerdict(concluded, root, recordCtx);
      },
      // The acceptance round's recorder — the sixth, wired exactly like the
      // quality one: the round ENDS when its report lands, and what the report
      // says is adjudicated here, never by the agent.
      recordAcceptance: async ({ root, concluded }) => {
        const recordCtx = ctx ?? lastUiCtx;
        if (!recordCtx) return undefined;
        return recordAcceptanceVerdict(concluded, root, recordCtx);
      },
    };
  }

  /**
   * THE goal-auditor's task for one draft — assembled in ONE place.
   *
   * It used to be assembled three times, verbatim: in `runGoalAudit`, in
   * `judge_submit`'s goal-auditor branch, and in `judge_spawn`'s dep. Each
   * copy derived the same stream path, made the same directory and appended
   * the same stream directive, which is three chances to drift on where a
   * round's findings are written.
   */
  async function buildGoalAuditRound(draft: string, root: string, ctx: unknown):
    Promise<{ ok: true; task: string; streamPath: string } | { ok: false; error: string }> {
    const prepared = await callTool("prepare_goal_audit", { goal: draft, repo: root }, ctx);
    if (prepared.isError) return { ok: false, error: toolText(prepared) };
    const streamPath = pathJoin(root, ".pi", "review-stream", `goal-${goalTextHash(draft).slice(0, 12)}.jsonl`);
    try { mkdirSync(pathJoin(streamPath, ".."), { recursive: true }); } catch { /* the stream is optional */ }
    return {
      ok: true,
      task: `${extractTaskText(toolText(prepared))}\n\n${buildStreamDirective(streamPath)}`,
      streamPath,
    };
  }

  /**
   * The engine's deps for a SYNCHRONOUS round (goal / plan): the conclusion
   * half above, plus the four things only a blocking round needs — dispatch,
   * the wait, the O-6 close, and the content-bound "did it pass?".
   */
  function auditRunDeps(
    ctx: unknown,
    progress: { step?: (t: string) => void; done?: (t: string) => void; fail?: (t: string) => void; tail?: (t: string) => void } | undefined,
    signal: AbortSignal | undefined,
  ): RunAuditRoundDeps {
    const waitCtx = ctx ?? latestCtx;
    return {
      ...auditRoundDeps(ctx),
      dispatch: async ({ root, role, title, task, streamPath }) => {
        const dispatched = await dispatchJudgeRound({
          root,
          role,
          title,
          task,
          fresh: true,
          ...(streamPath === undefined ? {} : { streamPath }),
        });
        if (!dispatched.ok) {
          return { ok: false, ...(dispatched.error === undefined ? {} : { error: dispatched.error }) };
        }
        return { ok: true, judgeId: dispatched.judgeId ?? "" };
      },
      judgeIdOf: (root, role) => judgeChildByRole(root, role)?.judgeId,
      rememberPending: (root, pending) => {
        pendingAudits.set(root, pending);
        persistJudgeHierarchy();
      },
      // Wait through the SAME implementation `judge_wait` uses, but for the
      // END of the round: a streamed finding or a question — which every
      // auditor produces before it concludes — must not read as an unfinished
      // audit. Wait motion is forwarded into the chain's own progress, else a
      // minutes-long audit shows no motion at all.
      awaitRoundEnd: async (root) => {
        // THE GATE WAITS ON ITSELF (2026-09-08): this chain dispatched the
        // auditor itself and holds its judgeId, so it waits through `doWait`
        // DIRECTLY — routing through `callTool("judge_wait", { repo: root })`
        // would re-run `addressJudge`'s "has this session edited that repo"
        // check and refuse a legitimate self-audit of an unedited repo
        // (measured: five consecutive "等待未命中本轮 report"). The opener
        // check still runs inside `doWait`; only the repo-addressing is
        // bypassed. Waiting semantics are untouched: same round-end rule via
        // `awaitRoundReport` — see `selfAuditWait`.
        const waited = await selfAuditWait(root, waitCtx, forwardWaitUpdates(progress), signal);
        const details = (waited.details ?? {}) as { done?: unknown; reason?: unknown };
        if (!waited.isError && details.done === true && details.reason === "report") {
          return { ok: true, detail: "" };
        }
        return {
          ok: false,
          detail:
            details.reason === "pane-dead" ? "pane 已消失"
            : details.reason === "cancelled" ? "本轮已被门禁终止（没有 pane 可重开，按 findings 修完重送）"
            : "等待未命中本轮 report",
        };
      },
      // THE RECLAIM, AND WHAT IT ACHIEVED. The reply used to be awaited and
      // thrown away, which is where a half-done reclaim went to die:
      // `judge_close` drops the registry row even when the kill FAILS, so
      // after that reply is discarded the leftover pane is unreachable — the
      // row it would be found by no longer exists. `hadPane` is read HERE,
      // before the close, because it is the only moment it is still knowable.
      closeJudge: async (root, role) => closeOwnedJudge(root, judgeChildByRole(root, role)?.judgeId, role),
      auditPassed: (root, pending) => {
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        if (pending.kind === "goal") return goalPrereviewPassed(st.goalPrereview, pending.draft);
        // The same content binding `planAuditPassed` applies, stated against
        // the hash this round dispatched: a plan edited between the audit and
        // the dialog cannot ride in on someone else's PASS.
        return st.planAudit?.verdict === "PASS" && st.planAudit.hash === pending.hash;
      },
      // THE EVIDENCE THE RECLAIM CANNOT ERASE (2026-09-21). Same content
      // binding as `auditPassed`, but blind to the VERDICT — a recorded FAIL
      // closes the round just as much as a PASS does, and reading it as "not
      // recorded" is what threw the auditor's findings away and sent the
      // caller a fail-closed notice instead. The timestamp is what keeps an
      // earlier round's record for identical content from closing this one.
      recordedThisRound: (root, pending) => {
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        const record = pending.kind === "goal"
          ? (st.goalPrereview?.hash === goalTextHash(pending.draft) ? st.goalPrereview : undefined)
          : (st.planAudit?.hash === pending.hash ? st.planAudit : undefined);
        return record !== undefined && record.at >= pending.startedAt;
      },
      // Rebuilt from the RECORD, so a round the wait settled still hands the
      // caller its findings instead of a bare "审计记录：FAIL". The plan can:
      // `formatPlanAuditRefusal` is a pure function of the record it just
      // wrote, and the hash check keeps it bound to THIS round's content. The
      // goal cannot, and does not need to — its spec appends the findings
      // stream path, which is where a goal round's objections live.
      recordedRefusal: (root, pending) => {
        if (pending.kind !== "plan") return undefined;
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        const record = st.planAudit;
        if (!record || record.hash !== pending.hash) return undefined;
        return formatPlanAuditRefusal(record);
      },
      verdictLabel: (root, pending) => {
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        return (pending.kind === "goal" ? st.goalPrereview?.verdict : st.planAudit?.verdict) ?? "NONE";
      },
    };
  }



  /**
   * Reclaim the review worktrees a finished judge left behind (D — "whoever
   * creates it clears it"). A reviewer verifies by doing (`git worktree add
   * <tmp> HEAD` under its gate-owned $TMPDIR); the gate set that $TMPDIR to a
   * per-session dir, so on the judge's exit it can remove exactly those
   * worktrees — never a concurrent lane's live one. Best-effort and idempotent.
   */
  function reapReviewScratch(sessionId: string): void {
    const scratch = judgeScratchDir(sessionId);
    try {
      const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: primaryRepoRoot, encoding: "utf8" });
      for (const wt of reviewScratchWorktrees(list, scratch)) {
        try { execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: primaryRepoRoot, encoding: "utf8" }); }
        catch { /* already gone / not a registered worktree — the prune below still runs */ }
      }
      try { execFileSync("git", ["worktree", "prune"], { cwd: primaryRepoRoot, encoding: "utf8" }); } catch { /* best effort */ }
    } catch { /* worktree list unreadable — leave the dir for a later reap */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }


  /** The judge of one role in one repo THIS session owns, if the registry still holds it. */
  function judgeChildByRole(root: string, role: string): JudgeEntry | undefined {
    return ownJudges().find((e) => e.repoRoot === root && e.role === role);
  }

  /**
   * Locate a judge by ROLE (the agent's vocabulary) or by judge id (the
   * internal key). Role wins when both are given: the agent addresses
   * roles, and a stale id it copied from an old round would silently read the
   * wrong session.
   *
   * Own judges only, in BOTH branches. The id lookup used to run against a Map
   * that could only ever hold this session's own children; against the shared
   * table a bare `judgeHierarchy[id]` would hand back a peer's review, and the
   * caller (judge_wait's `findChild`) treats what it gets as its own.
   */
  function findJudgeChild(root: string, role?: string, judgeId?: string): JudgeEntry | undefined {
    if (role) return judgeChildByRole(root, role);
    if (judgeId) return ownJudges().find((e) => e.judgeId === judgeId);
    return undefined;
  }


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
    hierarchy: () => { dropDeadForeignJudges(); return judgeHierarchy; },
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
      const at = judgeHierarchy[child.judgeId]?.spawnedAt;
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
          // session.
          return closeSessionWindow(runTmux, coords).ok;
        } catch {
          return false;
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
      readRegistry: () => {
        try {
          return parseWorkerRegistry(JSON.parse(readFileSync(workerRegistryPath(), "utf8")));
        } catch {
          // No file yet, or an unreadable one: both mean "no workers", and a
          // registry that cannot be read must never be repaired into a guess
          // (lib/worker-pane.ts drops malformed ENTRIES for the same reason).
          return {};
        }
      },
      saveRegistry: (registry) => {
        try {
          mkdirSync(pathDirname(workerRegistryPath()), { recursive: true });
          writeFileSync(workerRegistryPath(), serializeWorkerRegistry(registry), "utf8");
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
    hierarchy: () => { dropDeadForeignJudges(); return judgeHierarchy; },
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
      isAncestor: (root, maybeAncestor, branch) => {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", maybeAncestor, branch], { cwd: root, stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      },
      revParse: (root, rev) => execFileSync("git", ["rev-parse", rev], { cwd: root, encoding: "utf8" }).trim(),
      // The FALLBACK read, and it carries the same two flags as the numstat
      // probe so the two can never disagree about which files moved: without
      // `--no-renames` name-only reports a rename as the NEW path alone (the
      // numstat path reports both halves of it), and without
      // `core.quotePath=false` a non-ASCII path comes back as an escaped C
      // string no shell would resolve.
      changedFilesInRange: (root, baseline, head) =>
        execFileSync(
          "git",
          ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", `${baseline}..${head}`],
          { cwd: root, encoding: "utf8" },
        ).trim().split("\n").filter(Boolean),
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
        execFileSync(
          "git",
          ["-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", `${baseline}..${head}`],
          { cwd: root, encoding: "utf8" },
        )
          .trim().split("\n").filter(Boolean)
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
        execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
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

  /**
   * Record ONE QUALITY round's verdict (2026-09-15, user requirement).
   *
   * A SIBLING OF `recordReviewVerdict`, not a smaller copy of it: the quality
   * round records a STANDING that gates the functional round's dispatch
   * (`lib/quality-round.ts`'s `qualityStandingFor`), while a review round
   * records the ship binding. What they MUST agree on — which commit is being
   * judged, that the judge really ran in this repo, that a READY cannot land
   * on content that moved underneath it — is checked here the same way, and
   * deliberately not factored out: the review recorder's checks are the
   * ship-gate's, and a shared helper would let a widening on one side silently
   * widen the other.
   *
   * THERE IS NO PRECOMMIT BINDING HERE, on purpose. The quality round runs
   * BESIDE the full lane (the user's requirement: verification failing must not
   * interrupt it), so refusing a quality READY for want of a PASS would refuse
   * every quality round that finishes first — which is the normal case.
   */

  /**
   * The user's scope exemption, in the shape the adjudicator takes — or
   * `undefined` when no scope limit is in force, which is the ordinary case
   * and must stay byte-for-byte the old behaviour.
   *
   * BOTH RECORDERS CALL THIS (2026-09-19), and that is the point: the two
   * adjudications answer different questions — the quality half gates the
   * reviewer's dispatch, the review half gates shipping — but a quality round
   * that blocks on an EXEMPTED file still kills the reviewer's pane through the
   * cancel matrix. Fixing one and not the other leaves the same deadlock
   * standing at the other door.
   */
  function scopeExemptionOf(st: GateState): ScopeExemption | undefined {
    return st.scopeLimit === undefined ? undefined : { exemptFiles: st.scopeLimit.preexistingFiles };
  }

  async function recordQualityVerdict(
    concluded: ReportConclusion,
    repo: string,
    ctx: unknown,
  ): Promise<string | undefined> {
    const verdictRaw = normalizeConcludedVerdict(concluded.verdict);
    if (!verdictRaw) {
      return "review-gate: 质量轮的 report 里没有可识别的 verdict —— 什么都没有记录（fail-closed）：" +
        "reviewer **不会**被派出去。用 judge_submit({role:\"reviewer\"}) 重新送这一轮。";
    }
    const target = resolveToolRepo(repo);
    if (!target.ok) return target.error;
    const targetRoot = target.root;
    if (!sessionInGit) return "review-gate: 非 git 目录 —— 无法记录质量裁决（无仓库可绑定）。";
    const st = stateForRepo(targetRoot);
    delete st.pausedQuestion;
    // ONE adjudication, scope-aware since 2026-09-19 — see `ScopeExemption`.
    const parsed = adjudicateReviewConclusion({
      verdict: verdictRaw,
      findings: concluded.findings as ReviewFinding[],
      ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
    }, scopeExemptionOf(st));
    // THE SAME TWO BINDINGS A REVIEW GETS, for the same reason — a quality
    // READY unlocks the functional round, so it must be bound to the content
    // it actually judged. No target registered ⇒ the round was never prepared
    // ⇒ nothing to bind to ⇒ withhold (fail-closed).
    const targetNow = reviewTargets.get(targetRoot);
    let stale = false;
    if (!targetNow) {
      stale = true;
    } else {
      try {
        stale = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRoot, encoding: "utf8" }).trim() !== targetNow.head;
      } catch { stale = true; }
    }
    let cwdMismatch: string | undefined;
    if (parsed.verdict === "READY") {
      const claimed = parsed.cwd;
      if (claimed === undefined || claimed.trim() === "") {
        cwdMismatch = "the verdict carries no `cwd` (a required field: run `pwd` and report it)";
      } else if (canonicalPath(claimed) !== canonicalPath(targetRoot)) {
        cwdMismatch = `the verdict's cwd ${JSON.stringify(claimed)} is not the repo this round was prepared for (${targetRoot})`;
      }
    }
    if (stale || cwdMismatch !== undefined) parsed.verdict = "BLOCKED";
    st.quality = {
      verdict: parsed.verdict,
      // Empty when no target was registered: `qualityStandingFor` compares it
      // with HEAD and only an exact match passes, so an empty string can never
      // unlock the functional reviewer.
      commitSha: targetNow?.head ?? "",
      ...(targetNow?.tree === undefined ? {} : { treeSha: targetNow.tree }),
      at: new Date().toISOString(),
      findingsTotal: parsed.findingsTotal,
    };
    persistRepo(ctx as unknown as ExtensionContext, targetRoot);
    appendTiming(targetRoot, {
      kind: "quality",
      at: new Date().toISOString(),
      repo: targetRoot,
      verdict: parsed.verdict,
      approxMs: Math.max(0, Date.now() - lastGateEventAt),
      approximate: true,
      findingsTotal: parsed.findingsTotal,
    });
    lastGateEventAt = Date.now();
    return `review-gate: 质量轮记录 ${parsed.verdict} for ${targetRoot}（findings: ${parsed.findingsTotal}）。` +
      (parsed.verdict === "BLOCKED"
        ? " 先把 findings 全部改掉（它们写在 findings 流里，报告里有路径），再 judge_submit 重新送审。" +
          "本轮功能轮如果还在跑，门禁已把它终止（内容要改，它的裁决没有意义）；如果它已经扣了一份 READY 下来，那份 READY 作废。"
        : stageIsOn("review", targetRoot)
        ? " 功能轮本来就在跑（同一个 judge_submit 启动的），你不需要再调一次；" +
          "若它先交卷的 READY 被扣下，这一步就是补记它的时刻。"
        : " 功能审查环节已关闭（用户设定的环节开关）—— 没有 reviewer 在跑，也不需要跑；" +
          "质量结论已记入 sidecar，ship 时按它自己的卡点生效。") +
      (stale
        ? "\nSTALE TARGET：质量轮判的那个 commit 已经不是 HEAD（prepare 之后又落了新 checkpoint）—— " +
          "结论记成 BLOCKED，按上面的方式重新送一轮即可。"
        : "") +
      (cwdMismatch === undefined
        ? ""
        : `\nCWD CHECK FAILED: ${cwdMismatch}。质量裁决需要 judge 自己的 \`pwd\`，与 prepare 的仓库不符时记成 BLOCKED。`);
  }

  /**
   * THE ACCEPTANCE ROUND's recorder — the sixth, beside `recordQualityVerdict`
   * (2026-09-22).
   *
   * WHAT DIFFERS from its siblings: the verdict binds to the WORKTREE
   * FINGERPRINT the gate dispatched the round against, and a mismatch is not a
   * dropped report — it is recorded as BLOCKED, because the judge really did
   * run and really did answer, just about content that is no longer there. The
   * record keeps the DISPATCH's fingerprint when it is stale, so it can never
   * release content the round never ran on: `acceptanceDecision` sees the
   * mismatch and re-dispatches.
   */
  async function recordAcceptanceVerdict(
    concluded: ReportConclusion,
    repo: string,
    ctx: unknown,
  ): Promise<string | undefined> {
    const verdictRaw = normalizeConcludedVerdict(concluded.verdict);
    if (!verdictRaw) {
      return "review-gate: 验收轮的 report 里没有可识别的 verdict —— 什么都没有记录（fail-closed）：" +
        "下一次 `declare_done` 会重新派验收轮。";
    }
    const target = resolveToolRepo(repo);
    if (!target.ok) return target.error;
    const targetRoot = target.root;
    if (!sessionInGit) return "review-gate: 非 git 目录 —— 无法记录验收裁决（无仓库可绑定）。";
    const st = stateForRepo(targetRoot);
    delete st.pausedQuestion;
    // ONE adjudication, shared with the review and quality recorders: a READY
    // carrying P0/P1 findings contradicts itself, and the cwd is a required
    // field of the verdict schema.
    const parsed = adjudicateReviewConclusion({
      verdict: verdictRaw,
      findings: concluded.findings as ReviewFinding[],
      ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
    }, scopeExemptionOf(st));
    const dispatchedFingerprint = st.acceptance?.fingerprint;
    const dispatchedJudgeId = st.acceptance?.judgeId;
    const fp = computeFingerprint(targetRoot);
    const currentFingerprint = fp.unavailable ? "" : fp.digest;
    // NO DISPATCH RECORD IS NOT A PASS: without the fingerprint the round was
    // dispatched against there is nothing to compare, so the verdict cannot
    // release anything (fail-closed — it is recorded as BLOCKED instead).
    const stale = currentFingerprint === "" || dispatchedFingerprint === undefined ||
      dispatchedFingerprint !== currentFingerprint;
    let cwdMismatch: string | undefined;
    if (parsed.verdict === "READY") {
      const claimed = parsed.cwd;
      if (claimed === undefined || claimed.trim() === "") {
        cwdMismatch = "the verdict carries no `cwd` (a required field: run `pwd` and report it)";
      } else if (canonicalPath(claimed) !== canonicalPath(targetRoot)) {
        cwdMismatch = `the verdict's cwd ${JSON.stringify(claimed)} is not the repo this round ran in (${targetRoot})`;
      }
    }
    if (stale || cwdMismatch !== undefined) parsed.verdict = "BLOCKED";
    // The RECORD's status vocabulary is narrower than a verdict's: `NEEDS_HUMAN`
    // is not a state the completion gate knows how to release, so anything that
    // is not READY is recorded as BLOCKED — which is what it does to
    // completion — while `verdict` keeps the judge's own word verbatim.
    const status: AcceptanceStatus = parsed.verdict === "READY" ? "READY" : "BLOCKED";
    const blockingSummary = (concluded.findings as ReviewFinding[])
      .filter((f) => isBlockingSeverity(f.severity))
      .slice(0, 3)
      .map((f) => `${f.severity}${f.file ? ` ${f.file}${f.line === undefined ? "" : `:${f.line}`}` : ""} ${f.issue}`.trim())
      .join("；");
    const at = new Date().toISOString();
    st.acceptance = {
      status,
      verdict: parsed.verdict,
      // THE CONTENT THIS VERDICT BELONGS TO: the dispatch's when the round is
      // stale, the current one when it is fresh.
      ...(stale
        ? (dispatchedFingerprint === undefined ? {} : { fingerprint: dispatchedFingerprint })
        : { fingerprint: currentFingerprint }),
      at,
      ...(dispatchedJudgeId === undefined ? {} : { judgeId: dispatchedJudgeId }),
      findingsTotal: parsed.findingsTotal,
      ...(parsed.verdict === "READY"
        ? {}
        : {
            reason: stale
              ? "本轮验收跑的内容已经不是当前内容（结论在验收期间内容又变了），这份结论作废"
              : blockingSummary || `${parsed.findingsTotal} 条 findings（见验收轮的 report / findings 流）`,
          }),
    };
    persistRepo(ctx as unknown as ExtensionContext, targetRoot);
    appendTiming(targetRoot, {
      kind: "acceptance",
      at,
      repo: targetRoot,
      verdict: parsed.verdict,
      approxMs: Math.max(0, Date.now() - lastGateEventAt),
      approximate: true,
      findingsTotal: parsed.findingsTotal,
    });
    lastGateEventAt = Date.now();
    return `review-gate: 验收轮记录 ${parsed.verdict} for ${targetRoot}（findings: ${parsed.findingsTotal}）。` +
      (parsed.verdict === "READY"
        ? " 真实验收这一关已过；内容不变的话，再调一次 `declare_done` 就会完成。"
        : " 按 findings 修完再走一遍审查循环（`judge_submit`）；内容一改，这份结论自动失效并重新验收。") +
      (stale
        ? "\nSTALE：验收轮跑的内容与当前内容不同（指纹不匹配）—— 结论记成 BLOCKED（绑定它当初跑的那份内容），" +
          "下一次 `declare_done` 会重新派验收轮。"
        : "") +
      (cwdMismatch === undefined
        ? ""
        : `\nCWD CHECK FAILED: ${cwdMismatch}。验收裁决需要 judge 自己的 \`pwd\`，与派发的仓库不符时记成 BLOCKED。`);
  }

  /**
   * KILL ONE PARTY OF A ROUND — for real (2026-09-16).
   *
   * The cancel matrix says "the quality round failing STOPS the reviewer", and
   * this is what "stops" has to mean: the pane's PROCESS is terminated and its
   * registry row is dropped. Reading past its output instead would leave a
   * max-thinking judge burning minutes on content whose verdict can no longer
   * be recorded — the whole reason the matrix exists is the minutes, not the
   * output.
   *
   * DROPPING THE ROW IS ALSO WHAT KEEPS THE KILL SILENT TO THE RIGHT PARTIES:
   * the child watchdog (`classifyChildren`) and the settle sweep both iterate
   * the registry, so a cancelled round can no longer be announced as a judge
   * that DIED (which would send the agent to `judge_recover` a round that is
   * deliberately gone — and recovery refuses too, since it looks the entry up
   * in the same registry). What the agent gets instead is the note this returns,
   * carried by the sibling verdict's standard report.
   *
   * THE SCRATCH WORKTREES GO WITH IT (`reapReviewScratch`): a cancelled round
   * can never use them again, and they are the gate's to reclaim (who creates,
   * reclaims).
   *
   * LIVE-ONLY, deliberately: a cancellation is an action on a running process,
   * so it does not survive a restart — and neither does the state that decided
   * it (the round is over either way).
   */
  function cancelJudgeRound(root: string, role: string, why: string): string | undefined {
    const entry = judgeChildByRole(root, role);
    if (!entry) return undefined; // already concluded and gone: nothing to stop
    // BEFORE the row goes: what the pane reported about its OWN model is a fact
    // this round earned (a failed slot has to be cooled down, warned about and
    // skipped by the next dispatch — lib/judge-model-rotation.ts), and the
    // absorb reads its cursor off the entry that is about to be removed.
    absorbJudgeModelEvents(root, entry.judgeId);
    const ownPane = process.env.TMUX_PANE?.trim() || undefined;
    const tmuxServer = tmuxServerFrom(process.env);
    const run = (argv: readonly string[]) => runTmux(argv);
    const alive = entry.paneId && paneIdUsable(entry, tmuxServer)
      ? judgePaneAlive(run, entry.paneId)
      : undefined;
    if (alive === true) closeJudgePaneOf(entry, { ownPane, tmuxServer, run });
    setHierarchy(removeJudge(judgeHierarchy, entry.judgeId));
    reapReviewScratch(entry.judgeId);
    log(`review-gate: cancelled the ${role} round of ${root} — ${why}`);
    return `已终止 ${role} 的这一轮（${why}）。`;
  }

  /**
   * RE-ASK A PARKED CONCLUSION'S TWO PRECONDITIONS and act on the answer.
   *
   * A parked READY waits for up to TWO landings — the full lane that verifies
   * its content, and the quality round that must pass before it may be
   * recorded — and they arrive in either order. So the fate is computed from
   * the STATE OF BOTH HALVES (lib/review-adjudicate.ts's `parkedReadyFate`)
   * rather than from whichever event fired, and this function is called from
   * every one of them: the lane's landing, the quality round's settlement, and
   * the settle sweep.
   *
   * The sweep call is not a duplicate of the other two — it is the BACKSTOP.
   * A hold is only legitimate while somebody can still end it
   * (`decideQualityHold` refuses otherwise, exactly as `unverified-idle`
   * does); the quality pane can die AFTER the record was parked, and without a
   * periodic re-ask the conclusion would sit there forever while the reply told
   * the agent not to re-submit.
   *
   * `clear` and `replay` both retire the record; only `replay` wakes the agent,
   * because only it changes the gate's verdict (a dropped hold leaves `review`
   * PENDING, which the ordinary RESUME already speaks for).
   *
   * `landing` is how the LANE's own callback hands over what it just measured:
   * a verdict that is not PASS retires the parked record NOW, rather than at
   * the next settle. The recorded tree alone cannot say it — a FAIL of some
   * other tree leaves `lastFullPassTree` standing (lib/gate-state.ts), and a
   * PASS for another tree is equally unreadable from the record (round-2 P2:
   * nothing may be left behind after the lane it was waiting for has landed).
   */
  async function resumeParkedReady(
    root: string,
    ctx?: unknown,
    landing?: { laneVerdict: string; coveredTree: string | undefined },
  ): Promise<string[]> {
    const st = stateForRepo(root);
    const parked = st.pendingReady;
    if (!parked) return [];
    const target = reviewTargets.get(root);
    const fate = parkedReadyFate({
      parkedTree: parked.tree,
      lane: parkedLaneHalf({
        parkedTree: parked.tree,
        // The landing's args are passed through when there IS one; otherwise
        // the half is read from the record (`laneVerdict` absent).
        ...(landing?.laneVerdict === undefined ? {} : { laneVerdict: landing.laneVerdict }),
        coveredTree: landing?.coveredTree ?? st.precommit.lastFullPassTree,
        currentTargetTree: target?.tree,
        laneRunning: inFlightPrecommit?.root === root,
        // BYPASS ARRIVES HERE TOO (quality round P1, 2026-09-16): a bypassed
        // session never gets a full lane (`submitForReview` skips it), so
        // "no lane, no tree covered" must not read as "disproven" — that is
        // exactly how a parked READY was cleared and re-submitted into the
        // identical park. The rule is shared with the recorder, not restated:
        // `laneVerificationWaived` is that ONE composition (and the precommit
        // stage switch joins the bypass in it, quality round P1 2026-09-22).
        bypassActive: laneVerificationWaived(root, st),
      }),
      quality: qualityPrecondition({
        standing: qualityStandingFor({ head: target?.head ?? "", files: target?.files, quality: st.quality, stageOn: stageIsOn("quality", root) }),
        qualityRoundInFlight: qualityRoundInFlight(root),
      }),
    });
    if (fate === "none" || fate === "hold") return [];
    // A LANDING NEEDS A CONTEXT TO WRITE WITH, AND WITHOUT ONE NOTHING MAY
    // CHANGE (quality round P1, 2026-09-16). This used to delete `pendingReady`
    // first and return when no ctx was in reach: the in-memory record was gone,
    // the delete never reached the sidecar, and the reply had already told the
    // agent not to re-submit — a round that could never be recorded. Now the
    // record is left exactly where it is and the next settle retries, which is
    // the same "stay parked until somebody can act" the old guard claimed.
    const liveCtx = ctx ?? latestCtx;
    if (!liveCtx) return [];
    delete st.pendingReady;
    persistRepo(liveCtx as unknown as ExtensionContext, root);
    if (fate === "clear") {
      log(
        `parked READY for ${root} dropped: its two preconditions can no longer both hold ` +
        `(round ${parked.round}, tree ${parked.tree.slice(0, 12)})`,
      );
      return [`本轮挂起的 READY 已作废（round ${parked.round}）：它的前提已不可能同时成立，重送一轮即可。`];
    }
    const recorded = await recordReviewVerdict(parked.conclusion as ReportConclusion, root, liveCtx);
    const note = buildParkedReadyReplayNotice({ round: parked.round, tree: parked.tree, recorded });
    try {
      // WAKE THE AGENT: this is a gate state change nobody else will report.
      // `steer`, exactly like the failure notice — a `followUp` would sit in the
      // queue behind a long turn, and the whole point is that the round is no
      // longer waiting on anything.
      pi.sendMessage(
        { customType: "review-gate", content: note, display: true },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } catch { /* headless — the recorded verdict is what matters */ }
    // NO NOTE BACK: the steer above IS the delivery, and a caller that also
    // prints the same sentence in its report would tell the agent the same
    // thing twice (one cause, one message).
    return [];
  }

  /**
   * APPLY ONE ROW OF THE CANCEL MATRIX — the ONLY place a party is stopped.
   *
   * Both the judges' settles and the lane's own landing come through here, so
   * the table's three rows share one effect implementation (quality round P1,
   * 2026-09-16: the lane's row was hand-written beside the table, which is
   * exactly the second implementation the table exists to prevent).
   *
   * The lane's remaining minutes verify a tree nobody will ship, and the NEXT
   * submission would wait for a quiet lane before starting the one that
   * matters (`waitForQuietLane`) — the abort buys back the wait, not just the
   * CPU.
   */
  function applyCancelPlan(plan: RoundCancelPlan, root: string): string[] {
    const notes: string[] = [];
    if (plan.cancelReviewer) {
      const stopped = cancelJudgeRound(root, "reviewer", "这一轮已经判不过了 —— 内容要改，功能轮不必再过");
      if (stopped) notes.push(stopped);
    }
    if (plan.cancelQuality) {
      const stopped = cancelJudgeRound(root, QUALITY_ROLE, "这一轮已经判不过了 —— 内容要改，质量轮不必再审");
      if (stopped) notes.push(stopped);
    }
    if (plan.abortLane) {
      notes.push(
        abortPrecommitLane(root, "本轮有 judge 判了非 READY —— 内容要改，这轮验证不再有意义")
          ? "正在跑的全量 precommit 已终止，它的结论作废（改完重新送审时会重跑）。"
          : "",
      );
    }
    return notes.filter((n) => n !== "");
  }

  /**
   * DID THIS ROUND PARK ITS VERDICT? — i.e. did the recorder deliberately leave
   * `st.review` at PENDING because something is still owed (the full lane's
   * PASS, or the quality round's verdict)?
   *
   * WHY THE CANCEL MATRIX HAS TO ASK (quality round P0, 2026-09-16).
   * `recordReviewVerdict` returns BEFORE it writes `st.review` when it HOLDS a
   * READY, so the settle path still sees `review.verdict === "PENDING"` — and
   * feeding that to the matrix reads as "a non-READY reviewer" and cancels the
   * quality round and the lane. That is the exact opposite of the design: the
   * hold exists so the quality verdict can still arrive. A parked round cancels
   * NOTHING; every landing re-asks it (`resumeParkedReady`).
   *
   * The parked record is matched to the CURRENT round by its tree (the same
   * identity every other binding check uses), so a leftover record from an
   * earlier round cannot excuse a real non-READY verdict.
   */
  function reviewVerdictIsParked(root: string): boolean {
    const st = stateForRepo(root);
    const target = reviewTargets.get(root);
    return st.pendingReady !== undefined && target !== undefined && st.pendingReady.tree === target.tree;
  }

  /**
   * WHAT A CONCLUDED ROUND DOES TO ITS SIBLINGS — the cancel matrix, applied
   * for a JUDGE's settle (`lib/quality-round.ts` owns the other row, the
   * lane's, which the lane's own callback applies).
   *
   * ONE decision, TWO settle entry points. A round is recorded by whichever
   * path sees it first — the settle sweep (`recordJudgeConclusion`) or
   * `judge_wait`'s `settleRound` — and the other then only ever reads
   * `already-consumed`; wired into the sweep alone, a quality round closed by a
   * wait would never stop the reviewer it just blocked (reviewer P1,
   * 2026-09-15, learned on the serial design that had the same two paths).
   *
   * The verdict it acts on is the RECORDED one, not the word the judge wrote:
   * both recorders downgrade a READY that fails its own bindings (stale target,
   * cwd, verification), and cancelling a party off the raw word would end a
   * round the gate itself just refused. The one state that is NOT a verdict —
   * a PARKED conclusion — cancels nothing at all (see above).
   */
  async function applyRoundCancel(kind: string | undefined, root: string, ctx?: unknown): Promise<string | undefined> {
    const notes: string[] = [];
    // THE KIND IS TRANSLATED, NEVER COMPARED TO A ROLE (functional round P1,
    // 2026-09-16): a functional round settles as kind `"review"`, so comparing
    // it with the ROLE name (`reviewer`) was dead code — the matrix's second
    // row never ran, and a BLOCKED reviewer left the quality round and the lane
    // running. `roundCancelParty` owns that translation, and the test beside it
    // pins both directions.
    const party = roundCancelParty(kind);
    if (party !== undefined) {
      const st = stateForRepo(root);
      // THE PARKED FACT IS PART OF THE DECISION, not an `if` beside it: the
      // table answers "a hold cancels nothing" (quality round P0, 2026-09-16).
      const landing: RoundLanding =
        party === "quality"
          ? { party, verdict: st.quality?.verdict ?? "" }
          : { party, verdict: st.review.verdict, held: reviewVerdictIsParked(root) };
      notes.push(...applyCancelPlan(roundCancelPlan(landing), root));
    }
    // ALWAYS RE-ASK THE PARKED CONCLUSION: this landing may be the second of
    // its two preconditions (the quality verdict releasing a reviewer READY
    // that the lane already passed, or the reverse).
    notes.push(...(await resumeParkedReady(root, ctx)));
    const text = notes.filter((n) => n !== "").join(" ");
    return text === "" ? undefined : text;
  }

  /**
   * Record ONE reviewer round's verdict.
   *
   * NOT A TOOL, on any surface (2026-09-04, user decision D4). It used to be
   * an `internalTool` taking `reviewer_output: string`, and the only reason
   * that shape existed was that the verdict had to be PARSED back out of text
   * the gate had itself serialised. The conclusion arrives structured now, so
   * the tool wrapper carried nothing but a second way to sequence the same
   * step by hand (philosophy two, philosophy three).
   *
   * Everything the OPENER owns still happens here and in this order: the STALE
   * commit-target check, the cwd consistency check, the tree binding, the round
   * record, the timing, and the auto-loop disarms.
   */
  async function recordReviewVerdict(
    concluded: ReportConclusion,
    repo: string,
    ctx: unknown,
  ): Promise<string> {
    const verdictRaw = normalizeConcludedVerdict(concluded.verdict);
    if (!verdictRaw) {
      return "review-gate: 本轮 report 里没有可识别的 verdict —— 什么都没有记录，门禁保持 PENDING（fail-closed）。" +
        "reviewer 必须通过 judge_conclude 交卷（verdict + findings + cwd）；散文不记录任何东西。" +
        "用 judge_submit({role:\"reviewer\"}) 重跑本轮。";
    }
    // The agent is running the loop again — a standing ask_user
    // pause is moot (liveness: a stale pause would silently swallow the
    // next auto-continuation after a BLOCKED verdict).
    // P-multi: the verdict binds to ONE repo — the repo the round was
    // dispatched for, named explicitly (a multi-repo session must never
    // depend on which repo was edited last). stateForRepo(primary) IS
    // `state`, so the local `st` writes land on the right object and
    // persistRepo persists to the right sidecar — no global state swap.
    const target = resolveToolRepo(repo);
    if (!target.ok) {
      return target.error;
    }
    const targetRoot = target.root;
    // NON-GIT SHORT-CIRCUIT (defense): judge_submit refuses outside a
    // repository, so this step should never be reached there;
    // fail closed anyway rather than bind a verdict to a non-repo.
    if (!sessionInGit) {
      return "review-gate: 非 git 目录 —— 无法记录裁决（无仓库可绑定）。";
    }

    const st = stateForRepo(targetRoot);
    delete st.pausedQuestion;
    // ONE adjudication for the record: a READY carrying an open P0/P1 is
    // contradictory and becomes BLOCKED, and the round's findings become the
    // count and the coarse cross-round fingerprints (lib/review-adjudicate.ts).
    //
    // SCOPE-AWARE since 2026-09-19 (`ScopeExemption`): a P0/P1 on a file the
    // USER exempted no longer contradicts a READY. It needs `st`, so it runs
    // after the repo is resolved — the pure adjudication is unchanged.
    const parsed = adjudicateReviewConclusion({
      verdict: verdictRaw,
      findings: concluded.findings as ReviewFinding[],
      ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
      ...(concluded.docSync === undefined ? {} : { docSync: concluded.docSync }),
    }, scopeExemptionOf(st));
    // THE ADJUDICATOR'S OWN VERDICT, captured before the three binding checks
    // below overwrite it (2026-09-15). Only THIS one answers "does the round
    // contradict itself on its findings?" — stale, unverified and the cwd check
    // each relabel `parsed.verdict` too, and feeding the relabelled word into
    // `classifyReadyWithholding` made every one of them look like a finding
    // conflict.
    const adjudicatedVerdict = parsed.verdict;
    const fp = computeFingerprint(targetRoot);
    // Scope THIS round was judged under — computed BEFORE the new verdict
    // overwrites the baseline, or it would always read as "nothing new".
    const scopeNow = reviewScopeFor(targetRoot, st);
    // COMMIT TARGET INTEGRITY — mechanical, not honour-based (2026-08-27
    // execution model). prepare_review registered the reviewed range
    // (baseline..HEAD) in reviewTargets; a verdict binds to THAT target:
    //  - no target registered ⇒ the round was never prepared ⇒ a READY has
    //    nothing to bind to ⇒ withhold (BLOCKED);
    //  - HEAD moved past the registered head (a new checkpoint landed after
    //    prepare) ⇒ STALE ⇒ BLOCKED: the reviewer judged an older commit
    //    and the change under review has since grown;
    //  - READY binds to the reviewed commit's TREE (content binding:
    //    squash preserves it). Tighten-only — this can withhold a READY,
    //    never grant one.
    let staleTarget = false;
    /**
     * WHY A READY WAS REFUSED FOR THE QUALITY ROUND (2026-09-16) — set only by
     * the `refuse` outcome of `decideQualityHold`, and printed in the recorded
     * note so the agent does not read it as a finding against its code.
     */
    let qualityRefusal: string | undefined;
    // THE VERIFICATION BINDING (B1, 2026-09-10). The checkpoint gate accepts
    // content whose full lane is STILL RUNNING (that is what makes the lane run
    // beside the chain instead of in front of it), so this is the place that
    // refuses a READY on content which never passed it. Without it a round
    // dispatched beside a failing suite would record a verdict nothing can
    // ship, and it would LOOK verified while it was not. Tighten-only, exactly
    // like the stale check above — and it reads the sidecar, so a session that
    // restarted mid-round is judged by what was actually written down.
    let unverified = false;
    if (parsed.verdict === "READY") {
      const target_ = reviewTargets.get(targetRoot);
      if (!target_) {
        staleTarget = true;
      } else {
        try {
          const headNow = execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetRoot, encoding: "utf8" }).trim();
          staleTarget = headNow !== target_.head;
        } catch { staleTarget = true; }
      }
      if (
        !staleTarget &&
        readyLacksVerification({
          precommitVerdict: st.precommit.verdict,
          // The round's own tree, registered by prepare against the checkpoint
          // it dispatched, and the tree a full lane passed if one is on
          // record: either answers "this content was verified" without
          // depending on the live binding the next round's edits reset.
          lastFullPassTree: st.precommit.lastFullPassTree,
          reviewedTree: reviewTargets.get(targetRoot)?.tree,
          // A bypass AND a switched-off precommit stage both mean "this round
          // owes no lane" — one composition, shared with the parked re-ask
          // (`laneVerificationWaived`).
          bypassActive: laneVerificationWaived(targetRoot, st),
        })
      ) {
        unverified = true;
        parsed.verdict = "BLOCKED";
      }
      if (staleTarget || unverified) parsed.verdict = "BLOCKED";
    }
    // THE cwd CHECK (round-9 P1, reviewer-reproduced). The schema and the
    // task text have always demanded a real `pwd` and said the gate checks
    // it — but nothing did, so a verdict claiming `/evil/elsewhere` produced
    // exactly the same READY. A stated check that does not run is worse than
    // no check, because it is believed.
    //
    // WHAT IT IS (round-11 P1): a consistency check on a SELF-REPORTED
    // value. It rejects a report that does not match the repo this round was
    // prepared for — a review run against the wrong repo. It proves nothing
    // about who produced the verdict: any value equal to the root passes.
    // Reading `paneCurrentPath` would not change that either, since a
    // finished judge's pane is gone by the time its verdict is recorded.
    //
    // The judge pane is spawned with `cwd: root`, so the expected answer is
    // this repo's root. Compared through realpath, because /var vs /private/var
    // (macOS) would otherwise fail a perfectly honest reviewer.
    let cwdMismatch: string | undefined;
    if (parsed.verdict === "READY") {
      const claimed = parsed.cwd;
      if (claimed === undefined || claimed.trim() === "") {
        cwdMismatch = "the verdict carries no `cwd` (a required field: run `pwd` and report it)";
      } else {
        // canonicalPath exists for exactly this: /var vs /private/var would
        // otherwise withhold an honest reviewer's READY.
        if (canonicalPath(claimed) !== canonicalPath(targetRoot)) {
          cwdMismatch = `the verdict's cwd ${JSON.stringify(claimed)} is not the repo this round was prepared for (${targetRoot})`;
        }
      }
      if (cwdMismatch) parsed.verdict = "BLOCKED";
    }

    const bindTree = parsed.verdict === "READY" ? reviewTargets.get(targetRoot)?.tree ?? null : null;
    // HOLD, DON'T REFUSE, WHEN THE ONLY THING MISSING IS TIME (2026-09-15).
    // This function used to write `unverified` straight to BLOCKED and be done
    // with it — permanently, while the lane that would have cleared it landed
    // seconds later. The agent read "fix ALL findings and re-review" on a round
    // whose only finding was a Nit saying nothing had changed, and its only way
    // forward was re-reviewing byte-identical content. Measured on this repo:
    // 16s of review against a 34s full lane, seven seconds short.
    const withholding = classifyReadyWithholding({
      concluded: verdictRaw,
      blockingFinding: adjudicatedVerdict !== "READY",
      staleTarget,
      lacksVerification: unverified,
      // A HOLD NEEDS SOMEONE TO COME BACK FOR IT (round-1 P1, 2026-09-15). The
      // only two things that revive a parked conclusion are this lane's own
      // completion callback and the next round's prepare; when the lane has
      // ALREADY landed (or never started), holding would park the round forever
      // while telling the agent not to re-submit. `inFlightPrecommit` is
      // cleared in a microtask AFTER the lane's own callback has run, so a lane
      // that is still listed here is one whose callback has not finished.
      laneStillRunning: inFlightPrecommit?.root === targetRoot,
      cwdMismatch: cwdMismatch !== undefined,
    });
    // THE QUALITY PRECONDITION AT THE RECORDING END (2026-09-16). The two
    // judges of a round start together, so this is where "the quality round has
    // not passed yet" is enforced now: a READY recorded here would ship a round
    // no quality judge ever passed.
    //
    // IT COMES AFTER the three binding checks on purpose — including the
    // promotion to BLOCKED from a finding conflict. Each of those is a fact
    // ABOUT THE WORK, which waiting cannot change; this one is a fact about
    // TIME, and only a conclusion that is otherwise recordable may be held.
    //
    // …AND A SKIP RECORD ONLY STANDS WHILE THE STAGE IS OFF (2026-09-22), so
    // the user's switch is read ONCE here and handed to both readers below
    // (this hold, and the baseline decision) — the rule itself lives in
    // `lib/quality-round.ts`'s `qualityStandingFor`.
    const qualityStageOn = stageIsOn("quality", targetRoot);
    const qualityHold =
      parsed.verdict === "READY" && !staleTarget && withholding === "none"
        ? decideQualityHold({
            standing: qualityStandingFor({
              head: reviewTargets.get(targetRoot)?.head ?? "",
              files: reviewTargets.get(targetRoot)?.files,
              quality: st.quality,
              stageOn: qualityStageOn,
            }),
            qualityRoundInFlight: qualityRoundInFlight(targetRoot),
          })
        : "record";
    // NOBODY IS COMING BACK WITH A QUALITY VERDICT (the quality pane died, or
    // this round never dispatched one): fail closed, exactly like
    // `unverified-idle`. A hold with nothing to end it parks the round forever.
    if (qualityHold === "refuse") {
      parsed.verdict = "BLOCKED";
      qualityRefusal = "质量轮在本轮没有留下任何有效结论（judge 未派出或已死亡）—— 本轮没有可 ship 的 READY。";
    }
    if (withholding === "unverified" || qualityHold === "hold") {
      const parkedTarget = reviewTargets.get(targetRoot);
      // No target ⇒ the stale check above already fired and this is a refusal,
      // not a hold: a parked conclusion with nothing to bind to could never be
      // replayed into a real verdict.
      if (parkedTarget) {
        st.pendingReady = {
          conclusion: {
            verdict: "READY",
            findings: (concluded.findings ?? []) as unknown[],
            ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
            ...(concluded.docSync === undefined ? {} : { docSync: concluded.docSync }),
            // The judge's OWN scope travels too: the recorder pairs it with the
            // dispatched half (round-1 P2), and a replay that lost it would
            // write a different audit pair than a straight record of the same
            // round.
            ...(concluded.scope === undefined ? {} : { scope: concluded.scope }),
          },
          tree: parkedTarget.tree,
          head: parkedTarget.head,
          round: st.rounds.length + 1,
          at: new Date().toISOString(),
        };
        persistRepo(ctx as unknown as ExtensionContext, targetRoot);
        // TWO REASONS TO HOLD, TWO SENTENCES — and the quality one also says
        // where to look: a quality judge is allowed to ask the USER a scope
        // question (`ask_user`), and an agent told only "do not re-submit"
        // would wait on a box nobody had told it about.
        if (qualityHold === "hold") {
          return `review-gate: this round's READY is being HELD, not refused — for ${targetRoot} ` +
            `(round ${st.rounds.length + 1}, tree ${parkedTarget.tree.slice(0, 12)}).\n` +
            "这一轮的内容**没有问题**：质量轮（`quality-auditor`）还在审同一段 commit range。" +
            "门禁把功能轮结论**原样扣下**了，`review` 仍是 PENDING ——\n" +
            "  - 质量轮落 READY ⇒ 门禁**自动补记 READY** 并唤醒你，可以继续收尾；\n" +
            "  - 质量轮落非 READY ⇒ 挂起作废，按它的 findings 修完重新送审；\n" +
            "  - 质量轮 pane 死掉（永远不会再有结论）⇒ 挂起作废，重送一轮即可。\n" +
            "**不要重跑审查**：重送的同一份内容不会更快拿到结果，只会白烧一轮。" +
            "若质量轮在问你问题（`judge_wait` / `judge_answer` 会显示），先把它答掉。";
        }
        return `review-gate: this round's READY is being HELD, not refused — for ${targetRoot} ` +
          `(round ${st.rounds.length + 1}, tree ${parkedTarget.tree.slice(0, 12)}).\n` +
          "这一轮的内容**没有任何问题**：只是全量 precommit 还没跑完（B1 让它与审查并行跑，" +
          "所以 reviewer 可以先交卷）。门禁把结论**原样扣下**了，`review` 仍是 PENDING ——\n" +
          "  - lane 落 PASS 且 tree 相同 ⇒ 门禁**自动补记 READY** 并唤醒你，可以继续收尾；\n" +
          "  - lane 落 FAIL ⇒ 挂起被清掉，并按失败通道告诉你原因；\n" +
          "  - lane 落 PASS 但覆盖的不是这一棵，或门禁已经走到下一轮（你又送了一轮）⇒ 挂起**作废**：" +
          "那一轮判的内容已经不是当前这一轮了，按常规继续即可。\n" +
          "**在 lane 跑期间照常编辑工作区**：那不会作废挂起 —— 挂起判的是已提交的那一棵，" +
          "编辑作废的是 ship 绑定（这是故意的）。\n" +
          "**不要重跑审查**：重送的同一份内容不会更快拿到结果，只会白烧一轮。";
      }
    }
    // WHICH COMMIT THE BASELINE STOPS AT. The field means "the commit of the
    // last round that CONCLUDED", and a round whose QUALITY half never
    // concluded did not conclude one — the content in its range then entered no
    // quality round at all, and a later READY whose quality judge read only the
    // increment would ship it. Recording THIS round's head there is what moved
    // the next prepare's baseline onto that content.
    //
    // THE TEST IS THE STANDING, NOT A LIST OF CASES (quality round P1,
    // 2026-09-17). It used to special-case ONE way of having no quality
    // conclusion — the recorder's own `refuse` — while a non-READY functional
    // verdict reached the same state by another door: the cancel matrix kills
    // the quality round when the functional one concludes non-READY, so THAT
    // round's content was quality-unaudited too and the special case did not
    // cover it. `qualityStandingFor` already answers "does a quality conclusion
    // stand for this head" (a recorded READY bound to it, or a round with no
    // code to judge) for the dispatch and for the hold, so it answers this one
    // as well: standing ⇒ this round's head, anything else ⇒ the previous
    // value. `refuse` needs no branch of its own; it is one way to fail it.
    //
    // …AND OMITTING THE FIELD IS NOT THE SAME FIX: `st.review` is REPLACED
    // wholesale, so an absent `commitSha` also erases the LAST REAL conclusion
    // and drops the next baseline to the BRANCH BASE (a full-branch re-review),
    // or — in a repo with no main/master/origin — back onto this round's own
    // head, reopening the very hole this guards. Carrying the previous value
    // forward states the fact exactly: this round concluded nothing, the
    // earlier ones still did.
    //
    // THERE IS A SECOND WAY TO HAVE NO HEAD TO RECORD (reviewer P2,
    // 2026-09-18): a round whose target is not registered in THIS process —
    // `reviewTargets` is in-memory, so a verdict landing after a restart is
    // exactly that shape. Its standing is unanswerable, `qualityStandingFor`
    // fails closed, and it falls through to the previous value like the rest.
    const qualityHalfConcluded = qualityStandingFor({
      head: reviewTargets.get(targetRoot)?.head ?? "",
      files: reviewTargets.get(targetRoot)?.files,
      quality: st.quality,
      stageOn: qualityStageOn,
    }).ok;
    const concludedCommit = (qualityHalfConcluded ? reviewTargets.get(targetRoot)?.head : undefined)
      ?? st.review.commitSha;
    st.review = {
      verdict: parsed.verdict,
      fingerprint: bindTree,
      // Round-9 P1: the reviewed COMMIT sha rides the verdict so the next
      // prepare can baseline from it (covering every later checkpoint).
      //
      // EVERY CONCLUDED VERDICT CARRIES IT (2026-09-16), not just READY. The
      // baseline rule is「从最后一个**有结论**的轮次起算」, and while only READY
      // was recorded, a round that produced NO conclusion — a re-submit that
      // interrupted it, a precommit FAIL, a crash — left the next prepare to
      // guess, and the guess was the newest checkpoint's parent. Measured that
      // day: a whole round's changes (d28714e..a70f2a1) dropped out of every
      // later range while the gate went on believing the chain was reviewed.
      //
      // …AND `refuse` IS NOT A CONCLUSION (quality round P1, 2026-09-18). The
      // rule above is about verdicts that CONCLUDED something; `refuse` is the
      // recorder reporting that the quality judge never left one (its pane
      // died, or this round dispatched none). Recording the head here moved the
      // NEXT round's baseline onto it (lib/review-prepare-tools.ts), so this
      // round's own content entered no quality round's range at all — one pane
      // death was enough to walk unreviewed code past the quality gate, which
      // is exactly what 「a round without a conclusion must never let the
      // baseline step past its content」 forbids. Carrying the previous value
      // keeps the baseline at the last round that truly concluded, so this
      // round's content stays inside the next round's range.
      ...(concludedCommit === undefined ? {} : { commitSha: concludedCommit }),
      at: new Date().toISOString(),
      // Code↔doc attestation travels with the verdict it came from; absent
      // stays absent (blocks under the docSync knob — fail-closed).
      ...(parsed.docSync !== undefined ? { docSync: parsed.docSync } : {}),
    };
    // EVERY CONCLUDED VERDICT MOVES THE INCREMENTAL BASELINE (2026-09-19), not
    // just a READY. See `GateState.lastReviewedTree` for the measurement (three
    // full deep reviews over one diff) and for why the verdict rides along:
    // `reviewScopeFor` asks what was READ, while `settledConclusion` asks what
    // was CONFIRMED — and only a READY answers the second, so this write does
    // not let a BLOCKED tree be handed on as settled.
    //
    // Only a round that actually got RECORDED reaches this point: a verdict
    // refused by a binding check, or a round the cancel matrix terminated, is
    // not a conclusion and must leave the baseline where it was.
    {
      const treeOid = reviewTargets.get(targetRoot)?.tree;
      if (treeOid) {
        // What this review ACTUALLY covered. Under a user-granted scope
        // limit that is only the session's own files — recording the whole
        // branch diff would later let the increment scoper call
        // never-reviewed, exempted files "already reviewed and unchanged"
        // and skip the escalation to a full round.
        const files = st.scopeLimit
          ? st.scopeLimit.sessionFiles.slice()
          : reviewCoverageFiles(targetRoot);
        st.lastReviewedTree = {
          treeOid,
          at: new Date().toISOString(),
          verdict: parsed.verdict,
          ...(files ? { files } : {}),
        };
      }
    }
    // Round-18 polish gate: record which files carried P2/Nit vs P0/P1
    // findings this round (severity + file straight off the judge's own
    // findings, never line counts). The next prepare_review derives the file
    // streak from these.
    const recorded = recordedFindingsFrom(fileFindingsFrom(concluded.findings as ReviewFinding[]));
    // THE AUDIT PAIR (t6a): what the gate dispatched this round to review, and
    // what the judge reported for itself. Recorded side by side so a finished
    // round says, on the record, WHICH range and WHICH depth it ran under —
    // the fact every after-the-fact question about this round starts from
    // ("was this round incremental, and over what?").
    //
    // WHAT THE PAIR DOES NOT PROVE. Both halves trace back to the same text
    // the gate wrote, so agreement is the normal case and says nothing about
    // how carefully the round was read — whether anything was actually read is
    // a different record, `inspection` (lib/judge-inspection.ts), and how well
    // is the reviewer's own verdict. What a DISAGREEMENT catches is the pair's
    // real value: a judge whose task text was not this round's, a pane running
    // a different build, or a scope kind carried over from an earlier round.
    // Nothing refuses a verdict over it — a divergence can be legitimate, and
    // the gate cannot tell which, so it records instead of guessing.
    const roundScope: RoundScopeRecord | undefined = sanitizeRoundScope({
      dispatched: reviewTargets.get(targetRoot)?.scope,
      reported: concluded.scope,
    });
    st.rounds.push({
      round: st.rounds.length + 1,
      findingsTotal: parsed.findingsTotal,
      fingerprints: parsed.findingFingerprints,
      verdict: parsed.verdict,
      at: new Date().toISOString(),
      ...(recorded.polishFiles.length > 0 ? { polishFiles: recorded.polishFiles } : {}),
      ...(recorded.blockingFiles.length > 0 ? { blockingFiles: recorded.blockingFiles } : {}),
      ...(roundScope === undefined ? {} : { scope: roundScope }),
    });
    // Observability: what this round cost and how much of the change it had
    // to judge. The duration is an UPPER BOUND — the reviewer is its own pi
    // process in a pane, which the extension does not watch turn by turn,
    // so all it can measure is the wall clock
    // since the previous gate event (see lib/gate-timings.ts).
    appendTiming(targetRoot, {
      kind: "review",
      at: new Date().toISOString(),
      repo: targetRoot,
      round: st.rounds.length,
      verdict: parsed.verdict,
      scope: scopeNow.scope,
      changedFiles: scopeNow.changedFiles.length,
      changedLines: scopeNow.changedLines,
      approxMs: Math.max(0, Date.now() - lastGateEventAt),
      approximate: true,
      fingerprint: fp.unavailable ? "" : fp.digest.slice(0, 12),
    });
    lastGateEventAt = Date.now();
    // A new review round changes the token's bound round; drop any standing
    // token explicitly too (defense in depth — tokenAuthorizes already
    // checks round).
    clearBypassToken();

    let note = "";
    if (parsed.verdict === "NEEDS_HUMAN") {
      loopArmed = false;
      note = " Auto-loop disarmed — waiting for a human decision.";
    } else if (st.rounds.length >= st.maxRounds) {
      loopArmed = false;
      note = ` Max rounds (${st.maxRounds}) reached — escalate to the user.`;
    } else if (isOscillating(st.rounds, OSCILLATION_LIMIT)) {
      // The reviewer keeps flipping READY→BLOCKED with fresh findings instead
      // of converging. Disarm the auto-loop and escalate (tighten-only: this
      // never permits a ship, it only stops the churn so a human/adviser can
      // break the tie). Plateau below stays for the stuck-on-same-finding case.
      loopArmed = false;
      note = ` Oscillation detected (${countOscillations(st.rounds)} READY→BLOCKED flips) — ` +
        "the review is not converging. Escalate to the user or consult the adviser (a judge child process) " +
        "instead of burning more rounds.";
    } else if (isPlateaued(st.rounds, PLATEAU_ROUNDS)) {
      loopArmed = false;
      note = " Plateau detected — escalate to the user.";
    } else if (parsed.verdict === "BLOCKED") {
      // R10: still blocked and approaching the cap → one-shot rethink nudge.
      note = maybeStrategicReset(st);
    }

    persistRepo(ctx as unknown as ExtensionContext, targetRoot);
    // The repo is named in the TEXT, not just in a details field: a session
    // that could not see which repo its verdicts landed on kept recording
    // READY for the wrong one and read the resulting block as sabotage.
    return `review-gate: recorded verdict ${parsed.verdict} for ${targetRoot} ` +
      `(round ${st.rounds.length}/${st.maxRounds}, findings: ${parsed.findingsTotal}).${note}` +
      (staleTarget
        ? "\nSTALE TARGET: the reviewer approved a commit that is no longer HEAD — a new " +
          "checkpoint landed after prepare_review, so the READY cannot bind to the change now " +
          "in place and is recorded as BLOCKED. This is the expected outcome of fixing while the " +
          "review runs: those fixes are already in, so the next round is short. Re-review the " +
          "current head with ONE call: judge_submit({role:\"reviewer\", task:<what you changed>})."
        : "") +
      (unverified
        ? "\nUNVERIFIED: the READY lands on content that has no full-lane precommit PASS — the round " +
          "was dispatched while its verification was still running (that is how the lane runs beside the " +
          "review instead of blocking it), and that verification did not pass. The verdict is recorded " +
          "as BLOCKED: nothing here is shippable. Fix what precommit reported and submit the round again; " +
          "if it failed for an environment reason unrelated to this change, that is the user's call — " +
          "`/gate-bypass <reason>` covers it and leaves a trace." +
          // TWO WAYS TO GET HERE, AND THEY TELL THE AGENT OPPOSITE THINGS. A lane
          // that is still running will record this very conclusion the moment it
          // passes on this tree (that is the hold's whole point), so re-submitting
          // buys nothing. With NO lane running there is nothing left to wait for
          // and nothing that could replay it — the round concluded after its own
          // verification had already landed without covering this content — so
          // saying "did not pass" would send the agent looking for a failure that
          // does not exist (round-7 finding, and the reason the second case is a
          // refusal at all rather than a hold).
          (withholding === "unverified-idle"
            ? " NOTE: no precommit lane is running for this content — nothing is coming back to verify it, " +
              "so there is nothing to wait for and nothing to replay. Re-submit once you have fixed what " +
              "precommit reported."
            : " A full lane IS still running for this content: if it passes on this same tree, this verdict " +
              "is recorded automatically and you are woken — do NOT re-submit byte-identical content.")
        : "") +
      (cwdMismatch
        ? `\nCWD CHECK FAILED: ${cwdMismatch}. The conclusion requires the judge's own \`pwd\`, ` +
          "and the gate compares it with the repo this round was prepared for — a READY reporting a " +
          "different directory is recorded as BLOCKED. If the reviewer ended inside its throwaway " +
          "worktree, have it `cd` back to the repo root and report that instead."
        : "") +
      // THE QUALITY REFUSAL (2026-09-16): the round's own quality judge never
      // delivered, so this READY was refused rather than held — and the agent
      // must not read it as a finding against its code.
      (qualityRefusal === undefined ? "" : `\nQUALITY PRECONDITION: ${qualityRefusal}`) +
      (parsed.verdict === "READY" ? " Next: run precommit for this same repo." : parsed.verdict === "BLOCKED" ? " Next: fix ALL findings and re-review." : "");
  }

  // ---------- review tooling: change collection ----------

  /** Collect changed files: tracked edits vs HEAD plus untracked, repo-relative. */
  async function listChangedFiles(
    cwd: string,
  ): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
    const { execFile } = await import("node:child_process");
    const run = (args: string[]): Promise<{ ok: true; lines: string[] } | { ok: false; error: string }> =>
      new Promise((resolve) => {
        execFile("git", args, { cwd }, (err, stdout) => {
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
      lastGateEventAt = Date.now();

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

  /**
   * THE GOAL THAT GOVERNS THE ACCEPTANCE ROUND — the ONE read of it.
   *
   * BOTH halves of the round read THIS: the “no real acceptance this round”
   * declaration and the acceptance plan handed to the judge. A goal that is
   * not IN FORCE is not this round's contract — a leftover `.pi/loop-goal.md`
   * from an earlier task, or an unapproved draft, could otherwise EXEMPT the
   * round from real acceptance or hand the judge a checklist nobody agreed to,
   * and with the goal stage switched OFF there is no approval requirement left
   * to notice such a file (`lib/loop-goal.ts`'s stage-off directive says out
   * loud that such a file is not this session's contract). `undefined` = no
   * contract for this round, and then there is no plan to work either.
   */
  function acceptanceGoalText(root: string, st: GateState): string | undefined {
    const goal = readSessionLoopGoal(root);
    if (!goal.present || !loopGoalConfirmed(root, st)) return undefined;
    // THE RAW FILE, NOT THE PROMPT COPY (real-session P1, 2026-09-22).
    // `goal.text` is capped at `LOOP_GOAL_MAX_CHARS` for prompt injection, and
    // the acceptance plan is the LAST section of the skeleton — measured on the
    // round that found this: a 3130-character goal with「真实验收方案」at offset
    // 2164, so the capped copy ends before it, `extractAcceptancePlan` answers
    // undefined, `hasPlan` is false and the acceptance round is SILENTLY
    // SKIPPED as “no approved plan” — the stricter gate released by a size
    // limit. The approval above already proved this file readable, so read it
    // whole; unreadable stays unapproved, the same fail-closed rule.
    try {
      return readFileSync(loopGoalPathIn(root), "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * IS THE DISPATCHED ACCEPTANCE ROUND'S PANE STILL THERE?
   *
   * `false` is what lets `acceptanceDecision` re-dispatch instead of waiting
   * for a report nobody will write. `undefined` (no own pane, an unverifiable
   * pane id) is NOT "dead": killing or replacing a pane on a guess is worse
   * than waiting, and `judge_recover` remains the explicit way out.
   */
  function acceptanceRoundAlive(root: string): boolean | undefined {
    const entry = judgeChildByRole(root, "acceptance");
    if (!entry) return false;
    const tmuxServer = tmuxServerFrom(process.env);
    if (!entry.paneId || !paneIdUsable(entry, tmuxServer)) return undefined;
    return judgePaneAlive((argv) => runTmux(argv), entry.paneId) === true;
  }

  /**
   * DISPATCH THE ACCEPTANCE ROUND — the gate's own, from completion.
   *
   * The round rides the EXISTING engine (`dispatchJudgeRound`): it gets the
   * same session-id derivation, the same pane, the same channel and the same
   * `settleAuditRound` closing path every other judge has, which is why this
   * function is a task builder and a bookkeeping write and nothing else. The
   * AWAITING record is written BEFORE anything can ask again: it is what makes
   * the second `declare_done` wait rather than dispatch beside a judge that is
   * already working.
   */
  async function dispatchAcceptanceRound(
    ctx: unknown,
    /** The repo this round runs in — one round per repo the session edited. */
    root: string,
    fingerprint: string,
    goalText: string,
  ): Promise<{ ok: true; judgeId: string } | { ok: false; error: string }> {
    const target = reviewTargets.get(root);
    const stamp = fingerprint !== "" ? fingerprint.slice(0, 12) : String(Date.now());
    const streamPath = pathJoin(root, ".pi", "review-stream", `acceptance-${stamp}.jsonl`);
    try { mkdirSync(pathJoin(streamPath, ".."), { recursive: true }); } catch { /* the stream is optional */ }
    const task = `${buildAcceptanceTask({
      repoRoot: root,
      goalText,
      ...(target === undefined
        ? {}
        : { range: `${target.baseline.slice(0, 12)}..${target.head.slice(0, 12)}` }),
      ...(target?.files === undefined ? {} : { files: target.files }),
    })}\n\n${buildStreamDirective(streamPath)}`;
    const d = await dispatchJudgeRound({
      root,
      role: "acceptance",
      title: `acceptance-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`,
      task,
      streamPath,
    });
    if (!d.ok) return { ok: false, error: d.error ?? "dispatch failed" };
    const judgeId = d.judgeId ?? d.sessionId;
    // A successful dispatch without an id would leave the round unaddressable —
    // a gate defect, reported instead of written down as a promise.
    if (judgeId === undefined) return { ok: false, error: "dispatch 没有返回 judge id（门禁自身的缺陷）" };
    const st = stateForRepo(root);
    st.acceptance = {
      status: "AWAITING",
      at: new Date().toISOString(),
      judgeId,
      ...(fingerprint === "" ? {} : { fingerprint }),
      reason: "验收轮已派出",
    };
    persistRepo(ctx as unknown as ExtensionContext, root);
    return { ok: true, judgeId };
  }

  /**
   * THE COMPLETION-TIME ACCEPTANCE STEP.
   *
   * Returns a tool reply when completion must NOT be accepted — a round was
   * just dispatched, a verdict blocks, or the dispatch itself failed — and
   * `undefined` when the acceptance question does not stand in the way.
   *
   * DELIBERATELY NOT IN `unmetRequirements` (lib/gate-state.ts). That function
   * is the SHIP authority the git hooks read, and an acceptance requirement
   * there would block its own remedy: fixing an acceptance finding needs a
   * commit, and the commit would still be waiting on acceptance. The Copilot
   * cycle (lib/copilot-review.ts) is held the same way, on completion only.
   */
  async function armAcceptanceRound(
    ctx: unknown,
    progress: { step?: (t: string) => void; fail?: (t: string) => void },
    /** Skip reasons worth telling the human — see the skip branch below. */
    notes: string[] = [],
  ) {
    // EVERY REPO THIS SESSION EDITED, each judged on its own facts
    // (2026-09-22). The record was always per-repo (`stateForRepo(root)`), and
    // so are the goal, the fingerprint and the code-change flag — reading only
    // the primary's `hasCodeChange` recorded 「SKIPPED —— 本轮没有代码改动」, a
    // reason that was simply not true, for a session whose code lived in a
    // secondary repo. One refusal is returned for all of them, each problem
    // labelled with its repo when there is more than one.
    const results: Array<{ root: string; problems: string[]; armed: boolean; judgeId?: string }> = [];
    for (const root of [...sessionRepos]) {
      const outcome = await acceptanceStepForRepo(ctx, root, progress, notes);
      if (outcome !== undefined) results.push({ root, ...outcome });
    }
    if (results.length === 0) return undefined;
    const problems = results.flatMap((r) => r.problems);
    const armedRows = results.filter((r) => r.armed);
    const armed = armedRows.length > 0;
    const judgeId = results.find((r) => r.judgeId !== undefined)?.judgeId;
    // WHICH REPO THE AGENT MUST NAME WHEN IT WAITS (reviewer P2 + quality round
    // P2, 2026-09-22): `judge_wait` REFUSES to guess once a session has edited
    // more than one repo (lib/repo-resolve.ts), so a copy line that says
    // `judge_wait({role:"acceptance"})` is a dead end in exactly the sessions
    // this per-repo aggregation is for. And an armed repo beside a blocking one
    // means BOTH have to be dealt with — the acceptance READY does not clear
    // the other repo's problem.
    const waitLine = (rows: typeof armedRows): string => {
      if (rows.length === 1 && sessionRepos.size === 1) {
        return "用 `judge_wait({role:\"acceptance\"})` 等它的结论（report 落盘后门禁会用标准报告唤醒你）";
      }
      const named = rows.map((r) => `\`judge_wait({role:"acceptance", repo:${JSON.stringify(r.root)}})\``);
      return named.length === 1
        ? `验收轮已派出（${repoLabel(rows[0]!.root)}）：用 ${named[0]} 等它的结论（多 repo 会话必须显式给 repo）`
        : `验收轮已在 ${rows.map((r) => repoLabel(r.root)).join("、")} 派出：逐个用 ` +
          "`judge_wait({role:\"acceptance\", repo:\"<该 repo 路径>\"})` 等它们的结论（多 repo 会话必须显式给 repo）";
    };
    // The tool call is ENDING without completing, so the progress line is
    // closed the same way every other refusal in `declare_done` closes it.
    progress.fail?.(armed ? "真实验收轮已派出" : "真实验收未过");
    return {
      content: [{
        type: "text" as const,
        text: buildRejection({
          what: armed
            ? "declare_done 暂不能完成 —— 真实验收轮已派出"
            : `declare_done 被拒 —— ${problems.length} 项门禁未满足`,
          why: problems.length > 0
            ? "下面是门禁**重新核对**出的未满足项（服务端复检，不看你的 summary）：\n" +
              problems.map((p) => `  - ${p}`).join("\n")
            : "门禁自己派出了 acceptance 轮，在它交卷之前这一轮不能算完成。",
          by: "agent",
          next: armed
            ? waitLine(armedRows) +
              (problems.length > 0
                ? "；**另外**上面列出的未满足项不会因为验收 READY 而消失 —— 两件事都处理干净再 declare_done。"
                : "；验收 READY 且内容没有变化时，再调一次 `declare_done` 就会完成。")
            : "按验收 findings 修 → 走一遍审查循环（`judge_submit({role:\"reviewer\"})`）→ 再 `declare_done`；" +
              "内容一改，旧的验收结论自动失效并重新验收。",
        }),
      }],
      details: {
        accepted: false,
        problems,
        ...(armed ? { acceptanceArmed: true } : {}),
        ...(judgeId === undefined ? {} : { judgeId }),
      },
      isError: true,
    };
  }

  /**
   * ONE REPO'S ACCEPTANCE STEP — the decision, its record writes and its
   * dispatch, for a SINGLE repo root.
   *
   * Extracted from `armAcceptanceRound` (2026-09-22) so that the round is
   * decided per repo: the goal, the fingerprint, the code-change flag and the
   * `acceptance` record are all per-repo facts, and a session whose code lived
   * in a secondary repo used to get a false 「本轮没有代码改动」 skip.
   *
   * Returns `undefined` when this repo owes nothing (pass or skip — the skip is
   * recorded here, with its reason), else the shape `armAcceptanceRound`
   * aggregates into one refusal.
   */
  async function acceptanceStepForRepo(
    ctx: unknown,
    root: string,
    /** Only `step` is used here: a skip the user has to act on must show up in the progress line. */
    progress: { step?: (t: string) => void },
    notes: string[],
  ): Promise<{ problems: string[]; armed: boolean; judgeId?: string } | undefined> {
    const st = stateForRepo(root);
    /** Names the repo in every problem, for the sessions that have more than one. */
    const label = sessionRepos.size > 1 ? `[${repoLabel(root)}] ` : "";
    // ONE READ FOR BOTH HALVES (quality round P2, 2026-09-22): the declaration
    // and the plan handed to the judge come from the SAME goal — and only from
    // one that is IN FORCE. `parseNoAcceptanceDeclaration` only reads TEXT, so
    // an unapproved draft or a leftover `.pi/loop-goal.md` could exempt this
    // round; read the other way, the same file could hand the judge a checklist
    // that was never approved for this round. See `acceptanceGoalText`.
    const goalText = acceptanceGoalText(root, st);
    const declared = goalText === undefined ? undefined : parseNoAcceptanceDeclaration(goalText);
    const plan = goalText === undefined ? undefined : extractAcceptancePlan(goalText);
    const fp = computeFingerprint(root);
    const fingerprint = fp.unavailable ? "" : fp.digest;
    const decision: AcceptanceDecision = acceptanceDecision({
      hasCodeChange: st.hasCodeChange,
      // TWO WAYS THIS ROUND CAN BE OFF, composed into the ONE `gateOpen` the
      // t2 module owns (2026-09-22): the dispatcher's environment value (an
      // orchestration child that is not the plan's acceptance task) and the
      // USER's stage switch. The internal semantics — DISABLED, the record, the
      // re-dispatch rules — stay lib/acceptance-round.ts's, unchanged.
      gateOpen: acceptanceGateOpen(process.env) && stageIsOn("acceptance", root),
      ...(declared === undefined ? {} : { goalSkipsAcceptance: declared.reason }),
      // NO PLAN ⇒ SKIP, never a dispatch with nothing to work from (quality
      // round P2, 2026-09-22): a judge told to work a checklist it does not
      // have can only answer BLOCKED, and no action of the agent could resolve
      // that. The module's reason names both ways out.
      ...(plan === undefined ? { hasPlan: false } : {}),
      fingerprint,
      ...(st.acceptance === undefined ? {} : { record: st.acceptance }),
      roundAlive: acceptanceRoundAlive(root),
    });
    if (decision.action === "pass") return undefined;
    if (decision.action === "skip") {
      // RECORDED, never silent — the same rule the quality round's SKIP
      // follows. Written only when it actually changes: a completion call must
      // not rewrite the sidecar on every try.
      //
      // THE REASON NAMES THE RELEVANT CAUSE (reviewer P2, 2026-09-22).
      // `acceptanceDecision` writes DISABLED for BOTH ways the gate can be off,
      // and its copy names the orchestration rule — which is the wrong story in
      // a standalone session whose USER switched the acceptance stage off. The
      // STATUS stays the module's (semantics untouched); only the recorded
      // reason is composed here, where the switch is known.
      const skippedReason = !stageIsOn("acceptance", root)
        ? "验收环节已关闭（用户设定的环节开关）—— 跳过真实验收。"
        : decision.reason;
      if (st.acceptance?.status !== decision.status || st.acceptance.reason !== skippedReason) {
        st.acceptance = {
          status: decision.status,
          at: new Date().toISOString(),
          reason: skippedReason,
        };
        persistRepo(ctx as unknown as ExtensionContext, root);
      }
      // RECORDED IS NOT ENOUGH FOR THIS ONE (quality round P2, 2026-09-22): the
      // sidecar is a file nobody reads, and a skip has to say so where the
      // outcome is read. The two STEADY-STATE skips never enter here — “no
      // code” and “the stage switched off” are excluded by the condition below
      // — so what is left is the class a user has to act on: an acceptance gate
      // he left ON, a round WITH code, released anyway (no approved plan, the
      // goal's own exemption, or a dispatcher-marked session). The note carries
      // `skippedReason`, the module's word for THIS skip.
      if (stageIsOn("acceptance", root) && st.hasCodeChange) {
        notes.push(skippedReason);
        // THE LINE STAYS GENERIC, THE REASON RIDES THE NOTE (reviewer Nit,
        // 2026-09-22): this branch is reached by THREE skips — no plan, the
        // goal's own exemption, and a dispatcher-marked session — so naming one
        // of them here would be wrong two times out of three. The reply below
        // carries `skippedReason`, which is the module's word for THIS skip.
        progress.step?.("真实验收（跳过）");
      }
      return undefined;
    }
    if (decision.action === "wait" || decision.action === "block") {
      // The projection, not a second reading of the decision: what declares
      // itself blocking is what lands in the completion problem list.
      return { problems: acceptanceProblems(decision).map((p) => label + p), armed: false };
    }
    // THE MODULE NEVER SAYS "dispatch" WITHOUT A USABLE FINGERPRINT: it blocks
    // instead (see `acceptanceDecision`'s no-fingerprint rule, lib/acceptance-round.ts),
    // so this call is only reachable with one. A second judgement here would be
    // the drift that rule exists to prevent.
    const dispatched = await dispatchAcceptanceRound(ctx, root, fingerprint, goalText ?? "");
    if (!dispatched.ok) {
      return {
        problems: [`${label}验收轮派不出去（${dispatched.error}）—— 门禁不会静默跳过它；修好之后再 declare_done。`],
        armed: false,
      };
    }
    return { problems: [], armed: true, judgeId: dispatched.judgeId };
  }

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
          setHierarchy(removeJudge(judgeHierarchy, child.judgeId));
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
      orchestratorContinuations = 0; // goal 6 — reset with the loop budget
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
            // WHO DECIDED WHAT (2026-09-19). Printed by the GATE, from the
            // state record, and never by the summary — a decision the proxy
            // took on the user's behalf is the one fact this report cannot let
            // an agent's prose forget. Empty in the ordinary case.
            // Only THIS session's (and its handoff predecessor's): the sidecar
            // list is a union across sessions and would otherwise replay
            // earlier tasks' decisions in every later report.
            formatProxyDecisionReport(
              sessionProxyDecisions(allProxyDecisions(), [state.sessionId ?? undefined, readInheritance().predecessorSession]),
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
    commitsAheadOfBase: () => commitsAheadOfBase(cwd),
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
        // three refuse on `runtimeConflict` (lib/orchestrator-tools.ts,
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
    if (state.taskMode !== "normal" && !handedOffSession && (await settleFinishedRounds(ctx))) {
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
    const paneList = listOwnWindowPanes();
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
      lastUserInteractionAt,
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
          lastUserInteractionAt,
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
      if (r !== primaryRepoRoot && existsSync(sidecarPath(r))) sessionRepos.add(r);
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
        commitsAhead: state.scopeLimit ? 0 : await commitsAheadOfBase(cwd),
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
      reconcileBlockedMarker(blockedMarkerPath(sidecarPath(cwd)), { sessionId: state.sessionId });
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
  });

  pi.on("session_shutdown", (event) => {
    // A CLEAN SHUTDOWN IS NOT A FAILURE (user decision, 2026-09-17): every
    // reason pi reports here — quit, reload, new, resume, fork — is the user
    // ending or restarting the session themselves, and they already know.
    // The flag is what the runtime's process-exit handler consults; without it
    // a crash and a `/quit` would look identical from there.
    notifyRuntime.markCleanShutdown();
    void event;
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
    lastUiCtx = undefined;
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
        commitsAhead: commitsAheadOfBaseSync(root),
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
      commitsAhead: state.scopeLimit ? 0 : await commitsAheadOfBase(cwd),
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
    backgroundWaits = foldBackgroundWaits(backgroundWaits, {
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
      const next = foldBackgroundWaits(backgroundWaits, {
        kind: "finished",
        id: (payload as { id?: unknown } | null | undefined)?.id,
      });
      // Nothing was waiting on that agent ⇒ nothing to say. Reporting anyway
      // would write a channel record per finished agent of every session.
      if (next === backgroundWaits) return;
      backgroundWaits = next;
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
    orchestratorContinuations = 0; // goal 6 — reset with the loop budget
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

  // Refresh the TUI widgets periodically while sub-agents run: agent_settled
  // only fires for the MAIN session, so a turn spent waiting on a sub-agent
  // would otherwise freeze the running-agents list. One cheap dir scan + a few
  // small file reads every 5s, content-compared inside updateWidget; .unref()
  // so the timer never keeps the process alive. Display-only — no gate reads
  // this state.
  //
  // The timer is owned by the CURRENT session instance: session_shutdown
  // disarms it, session_start (and updateWidget, idempotently) re-arms it.
  // A tick against a captured ctx from a replaced/reloaded session throws on
  // `ctx.hasUI`; before this guard that uncaught exception killed pi right
  // after every resume. The body is additionally crash-proofed: a stale ctx
  // is dropped, never re-thrown.
  let uiRefreshTimer: ReturnType<typeof setInterval> | undefined;
  function armUiRefreshTimer(): void {
    if (uiRefreshTimer) return;
    uiRefreshTimer = setInterval(() => {
      try {
        if (lastUiCtx) updateWidget(lastUiCtx);
      } catch {
        // Display-only — a widget refresh must never take the process down.
        // A stale ctx is dropped here and reinstalled by the next
        // updateWidget with a fresh one.
        lastUiCtx = undefined;
      }
    }, 5000);
    uiRefreshTimer.unref();
  }
  function disarmUiRefreshTimer(): void {
    if (uiRefreshTimer) {
      clearInterval(uiRefreshTimer);
      uiRefreshTimer = undefined;
    }
  }
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

interface PrecommitOutcome {
  verdict: "PASS" | "FAIL" | "NO_CHECKS_RUN" | "ERROR";
  checksRun: number;
  checksFailed: number;
  fingerprint: string;
  error?: string;
  /** Absolute path of the full run log, or "" when it could not be kept. */
  logPath: string;
  /** Names of the checks that failed, for pointing the agent at the log. */
  failedSteps: string[];
  /**
   * How much of the runnable suite the run covered. Absent for ERROR: a run
   * the extension could not trust reports no coverage claim either.
   */
  testScope?: TestScope;
  /**
   * Where the step commands came from: "project" (`.pi/review-gate.json`
   * `precommit` section) or "default" (package.json / ecosystem detection).
   * Diagnostics only — never part of the verdict. Absent for ERROR.
   */
  configSource?: "project" | "default";
  /** Per-step timings for `.pi/gate-timings.jsonl` (diagnostics only). */
  timings?: StepTiming[];
  /** Runner-measured wall clock for the whole run. */
  totalMs?: number;
}

/**
 * Resolve the runner path bundled alongside THIS extension (the installed
 * control-plane copy, not one named by the model at call time). We probe the
 * known install/dev layouts and require the file to exist.
 *
 * THREAT MODEL (see README): this is a control-plane component the extension
 * configures and launches; it does not accept a model-supplied command string,
 * and plain bash stdout can never grant a PASS. It does NOT defend against a
 * principal with write access to the current user's files (extension, runner,
 * hooks, or gate sidecar) — such a principal could tamper with any of them, so
 * a content hash here would add complexity without a real trust root. In
 * development the runner IS the editable repo copy, by design.
 */
function resolveTrustedRunner(): string | null {
  let here: string;
  try { here = pathDirname(fileURLToPath(import.meta.url)); } catch { return null; }
  const candidates = [
    pathJoin(here, "scripts", "precommit-runner.mjs"),           // repo layout
    pathJoin(here, "..", "scripts", "precommit-runner.mjs"),     // extensions/ sibling
    pathJoin(here, "..", "..", "scripts", "pi-review-gate-precommit.mjs"), // global install
  ];
  for (const c of candidates) {
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch { /* keep probing */ }
  }
  return null;
}

/**
 * Run the precommit runner and return a verified outcome. The extension — not
 * the model — spawns the runner with argv (never via a shell), hands it a
 * PRIVATE nonce + receipt path in an OS temp dir (never in the repo, never in a
 * tool parameter the model can see), then trusts ONLY a receipt the runner
 * atomically wrote that carries the exact nonce. This closes the stdout-forgery
 * class (a `## Overall: PASS` printed by any bash command). It is not a defense
 * against same-user tampering with the runner itself (see threat model above).
 *
 * Runs ASYNC (never spawnSync): a synchronous 20-minute spawn would block the
 * extension host's event loop, freezing the UI and making ESC/abort dead. The
 * runner is spawned detached in its own process group so an abort or timeout
 * kills the whole tree (runner + bash + npm test grandchildren).
 */
function killProcessTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL"); // negative pid = process group
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

interface SpawnOutcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  spawnError: boolean;
  aborted: boolean;
  timedOut: boolean;
}

/** Repo-root-relative run log. Under `.pi/` — gate-owned, see keepRunLog(). */
const PRECOMMIT_LOG_RELPATH = ".pi/precommit-last.log";
/** Only the last slice of a run log is kept: `npm test` can emit megabytes. */
const PRECOMMIT_LOG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Move the temp run log to `<repoRoot>/.pi/precommit-last.log`, tail-truncated.
 * Returns the kept path, or "" when nothing could be kept.
 *
 * `repoRoot` — NOT the run directory. `.pi/` is only gate-owned at the REPO
 * ROOT (GATE_EXCLUDE_PATHSPECS uses `:/.pi`), and the primary repo's precommit
 * may run in a subdirectory of it. A log written to `<root>/sub/.pi/` would be
 * an ordinary worktree file: every run would change the fingerprint and
 * invalidate the PASS it just produced.
 *
 * One file per repo, overwritten every run: "the last precommit" is the only
 * question this answers, and an accumulating log directory would be litter the
 * gate never cleans up. Two concurrent run_precommit calls on one repo are
 * therefore last-writer-wins, and a reader racing the copy can see a partial
 * file — acceptable for a diagnostics artifact that no decision depends on.
 */
function keepRunLog(repoRoot: string, tmpLog: string): string {
  const dest = pathJoin(repoRoot, PRECOMMIT_LOG_RELPATH);
  try {
    mkdirSync(pathDirname(dest), { recursive: true });
    const size = statSync(tmpLog).size;
    if (size <= PRECOMMIT_LOG_MAX_BYTES) {
      copyFileSync(tmpLog, dest);
      return dest;
    }
    // Tail-truncate: the interesting part of a failed run is its end.
    const fd = openSync(tmpLog, "r");
    try {
      const buf = Buffer.allocUnsafe(PRECOMMIT_LOG_MAX_BYTES);
      const read = readSync(fd, buf, 0, PRECOMMIT_LOG_MAX_BYTES, size - PRECOMMIT_LOG_MAX_BYTES);
      writeFileSync(
        dest,
        `[pi-review-gate] log truncated — ${size} bytes produced, last ${read} kept\n` +
          buf.subarray(0, read).toString("utf8"),
      );
    } finally {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    return dest;
  } catch {
    return "";
  }
}

async function runTrustedPrecommit(
  cwd: string,
  repoRoot: string,
  mode: "fast" | "full",
  abortSignal?: AbortSignal,
  /** Live-output sink: the tool's `onUpdate`, when the caller wants streaming. */
  onUpdate?: (partial: { content: { type: "text"; text: string }[]; details: undefined }) => void,
): Promise<PrecommitOutcome> {
  // `logPath` is filled in as soon as the run log has been kept, so every
  // failure path below still tells the agent where to look.
  let logPath = "";
  const fail = (error: string): PrecommitOutcome =>
    ({ verdict: "ERROR", checksRun: 0, checksFailed: 0, fingerprint: "", error, logPath, failedSteps: [] });

  const runner = resolveTrustedRunner();
  if (!runner) return fail("trusted precommit runner not found");
  if (abortSignal?.aborted) return fail("aborted before start");

  let dir: string;
  try { dir = mkdtempSync(pathJoin(tmpdir(), "rg-precommit-")); } catch { return fail("cannot create temp dir"); }
  const receipt = pathJoin(dir, "receipt.json");
  const tmpLog = pathJoin(dir, "output.log");
  const nonce = randomBytes(24).toString("hex");

  try {
    const res = await new Promise<SpawnOutcome>((resolve) => {
      let aborted = false;
      let timedOut = false;
      // Capture the runner's output into a FILE DESCRIPTOR, not a pipe. The
      // runner is detached and long-lived; with a pipe, anything that stops
      // draining it (an abort, a busy host) fills the 64KB buffer and blocks
      // the runner's next write forever. A file has no backpressure. It used
      // to be "ignore" outright, which is why a FAIL told the agent only
      // "1/3 checks failed" and nothing about which one or why.
      let logFd: number | undefined;
      try { logFd = openSync(tmpLog, "a"); } catch { logFd = undefined; }
      const child = spawn(
        process.execPath,
        [runner, "--mode", mode, "--cwd", cwd, "--receipt", receipt, "--nonce", nonce],
        { cwd, shell: false, detached: true,
          stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
          // The nonce travels ONLY via the runner's argv (not env), so the
          // runner's lint/test grandchildren never inherit it. A same-UID
          // observer could still read the runner argv via ps — accepted: that
          // principal is outside the threat model (see README).
          env: { ...process.env } },
      );
      // Live output: TAIL the log the runner is writing (see lib/precommit-tail.ts
      // for why this is a poll and not a pipe). The runner writes its plan
      // preamble before the first check, so the agent sees what is about to run
      // instead of a silent tool call for minutes.
      const tail = onUpdate
        ? tailLogFile(tmpLog, (text) => {
            onUpdate({ content: [{ type: "text", text }], details: undefined });
          })
        : undefined;
      const timer = setTimeout(() => { timedOut = true; killProcessTree(child); }, 20 * 60 * 1000);
      const onAbort = () => { aborted = true; killProcessTree(child); };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      let settled = false;
      const finish = (out: SpawnOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Stop BEFORE the log is kept: stop() does a final read, so the last
        // lines a killed runner wrote between two ticks still reach the agent.
        tail?.stop();
        abortSignal?.removeEventListener("abort", onAbort);
        // The child holds its own duplicate of this descriptor; closing ours
        // once it is gone just releases our handle.
        if (logFd !== undefined) { try { closeSync(logFd); } catch { /* already closed */ } }
        resolve(out);
      };
      child.on("error", () => finish({ status: null, signal: null, spawnError: true, aborted, timedOut }));
      child.on("close", (status, signal) => finish({ status, signal, spawnError: false, aborted, timedOut }));
    });

    // Keep the log BEFORE any early return: a timed-out or aborted run is
    // exactly when the agent most needs to see how far the checks got.
    logPath = keepRunLog(repoRoot, tmpLog);

    if (res.aborted) return fail("aborted by user — precommit run cancelled, no verdict recorded as PASS");
    if (res.timedOut) return fail("runner timed out after 20 minutes");

    // Recompute the fingerprint AFTER the runner (lint:fix may have edited files).
    // Round-8 P1: the binding is the WORKTREE TREE OID (the exact content the
    // checkpoint will commit — equal to the reviewed tree at ship time),
    // NOT the worktree digest: review.fingerprint already holds a tree OID,
    // and comparing a digest against it would mismatch every single PASS.
    const fp = computeFingerprint(cwd);
    const fingerprint = fp.unavailable ? "" : worktreeTreeOid(cwd);

    // Read the receipt (trusted channel): regular file, size-bounded, parseable.
    let parsed: unknown;
    try {
      const st = statSync(receipt);
      if (!st.isFile() || st.size > 1024 * 1024) return fail("receipt missing or oversized");
      parsed = JSON.parse(readFileSync(receipt, "utf8"));
    } catch { return fail("no/unparseable receipt — runner did not complete"); }

    // Full protocol validation (pure, unit-tested): every exit/verdict/count
    // contradiction becomes ERROR, never a silent business verdict.
    const v = validatePrecommitReceipt(parsed, {
      nonce, cwd, mode,
      exitStatus: res.status, signal: res.signal, spawnError: res.spawnError,
    });
    // Diagnostics only — read AFTER the verdict is decided, and never fed back
    // into it (see failedStepNames' docstring). The timings travel with the
    // outcome so the caller can append one observability record per run.
    const failedSteps = failedStepNames(parsed);
    const timings = stepTimings(parsed);
    const totalMs = receiptTotalMs(parsed);
    const cfg = (parsed as Record<string, unknown>).config as { source?: unknown } | undefined;
    const configSource: "project" | "default" | undefined =
      cfg && cfg.source === "project" ? "project" : "default";
    if (v.verdict === "PASS") {
      if (!fingerprint) return fail("worktree fingerprint unavailable post-run");
      return {
        verdict: "PASS", checksRun: v.checksRun, checksFailed: v.checksFailed,
        testScope: v.testScope, configSource, fingerprint, logPath, failedSteps, timings, totalMs,
      };
    }
    return {
      verdict: v.verdict, checksRun: v.checksRun, checksFailed: v.checksFailed,
      testScope: v.testScope, configSource, fingerprint, error: v.error, logPath, failedSteps, timings, totalMs,
    };
  } catch (e) {
    return fail(`runner spawn failed: ${(e as Error).message}`);
  } finally {
    // Single-use: destroy the receipt dir no matter what. The log has already
    // been copied out to the repo by then.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
