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
} from "node:fs";
import { tmpdir, homedir, hostname } from "node:os";
import { join as pathJoin, dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
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
  PLATEAU_ROUNDS,
  OSCILLATION_LIMIT,
  STRATEGIC_RESET_OFFSET,
  STRATEGIC_RESET_CHECKLIST,
  TASK_TEXT_MARKER,
} from "../lib/constants.ts";
import { SETTLED_TOOL_REMINDER, WAIT_DISCIPLINE_HINT } from "../lib/agent-directives.ts";

import { MODE_REGISTRY, resolveGateMode } from "../lib/gate-modes.ts";
import { defaultProjectConfig, loadProjectConfig, type ProjectConfig } from "../lib/project-config.ts";
import { buildGitMemory } from "../lib/git-memory.ts";
import { detectShipCommands } from "../lib/ship-detect.ts";
import { buildGateWidget, type GateWidgetFacts } from "../lib/ui-widget.ts";
import {
  gitRootOfDir,
  resolveCommandRepos,
  resolveToolRepoTarget,
} from "../lib/repo-resolve.ts";
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
  type ChannelIO,
  type ChannelRecord,
  type ReportConclusion,
  type ChildReportedState,
} from "../lib/orchestrator-channel.ts";
import {
  acknowledgeInstruct,
  askThroughChannel,
  pendingInstructions,
  reportState,
  type ChannelDialogOutcome,
  type ChannelDialogRequest,
  type ChildChannelBinding,
} from "../lib/orchestrator-child-channel.ts";
import { supervisionTarget } from "../lib/orchestration-id.ts";
import { emptyHierarchy, judgeLive, listByOpener, paneClosable, parseHierarchySnapshot, registerJudge, removeJudge, tmuxServerFrom, type HierarchyTable, type JudgeEntry } from "../lib/hierarchy.ts";
import {
  buildJudgePaneCommand,
  buildJudgeRecoverCommand,
  closeJudgePane,
  judgePaneAlive,
  listJudgePanes,
  openJudgePane,
  JUDGE_ID_ENV,
  JUDGE_OPENER_ENV,
  JUDGE_ROLE_ENV,
} from "../lib/judge-pane.ts";
import {
  readJudgeSideEnv,
  gateStatePersistSkip,
  JUDGE_STREAM_ENV,
} from "../lib/judge-side.ts";
import {
  PRESENCE_FILENAME,
  PRESENCE_HEARTBEAT_MS,
  checkSessionExclusivity,
  claimsMainSidecar,
  parsePresence,
  presenceFor,
  presenceIsOurs,
  type PresenceRecord,
} from "../lib/session-exclusivity.ts";
import { buildStandardReport, STANDARD_REPORT_EXCERPT_CHARS } from "../lib/judge-report.ts";
import { nextRoundSeq, registerJudgeConcludeTool } from "../lib/judge-conclude.ts";
import { runTmux } from "../lib/orchestrator-wiring.ts";
import type { ToolHost } from "../lib/tool-host.ts";
// ---- orchestration layer (project-manager role). Everything but these few
// wires lives in lib/orchestrator-*.ts, deliberately: this file is the
// repository's own worst example of the architecture rule this round adds.
import { newOrchestrationId, orchestrationIdFromEnv, ORCHESTRATION_ID_ENV } from "../lib/orchestration-id.ts";
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
import { contextPercentFromUsage } from "../lib/orchestrator-handoff-advice.ts";

import {
  buildPlanAuditTask,
  formatPlanAuditCarryover,
  formatPlanAuditRefusal,
  planAuditHash,
} from "../lib/orchestrator-plan-audit.ts";
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
  superviseChildren,
  type SupervisionMemory,
} from "../lib/orchestrator-supervisor.ts";
import { formatChildHealth } from "../lib/orchestrator-child-state.ts";

import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";
import { registerOrchestratorSessionTools } from "../lib/orchestrator-session-tools.ts";


import { formatInheritanceBrief, readInheritance } from "../lib/orchestrator-relay.ts";
import { addGrant, emptyRuntime, hasGrant, type OrchestratorRuntime } from "../lib/orchestrator-registry.ts";
import { fileSizeVerdict, formatFileSizeVerdict, isSizeJudgedFile } from "../lib/file-size-gate.ts";
import { buildCheckpointMessage } from "../lib/checkpoint-message.ts";
import { classifyChildren, buildChildWaitNotice, type ChildSnapshot } from "../lib/child-watch.ts";
// (Nothing is imported from lib/judge-session.ts here anymore: the transcript
// READ died with judge_read — a round's conclusion is the channel report.)

// The judge tools that observe/end a session (judge_close / judge_wait) are
// registered from lib/, like the orchestration tools: this file keeps only
// what it alone owns and hands the rest over as deps.

import {
  registerJudgeSessionTools,
  registerJudgeWaitTool,
  probeJudgeRound,
  type JudgeSessionToolDeps,
} from "../lib/judge-session-tools.ts";

import { registerJudgeSpawnTools } from "../lib/judge-spawn-tools.ts";
import { awaitRoundReport } from "../lib/judge-lifecycle.ts";

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
import { registerAdvisoryPrepareTools } from "../lib/advisory-prepare-tools.ts";

// The L7 Copilot tools moved the same way: this file wires them, the module
// owns their bodies (and lib/copilot-gh.ts the `gh` calls they make).
import { registerCopilotReviewTools } from "../lib/copilot-review-tools.ts";
// The L8 goal family (the agent-facing `propose_loop_goal` and the audit
// recorder behind it) moved the same way: this file wires them, the
// module owns their bodies (and lib/goal-prereview-tools.ts the audit record).
import { registerGoalTools } from "../lib/goal-tools.ts";
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
  writeJudgeSpawnFiles,
  JUDGE_ROLES,
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
import {
  decideReviewScope,
  formatReviewScopeDirective,
  type ReviewScopeDecision,
  type SettledConclusion,
} from "../lib/review-scope.ts";
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
  type GateState,
  invalidateBindings,
} from "../lib/gate-state.ts";
import { parsePrecommitOutput } from "../lib/precommit-parse.ts";
import {
  adjudicateReviewConclusion,
  fileFindingsFrom,
  normalizeConcludedVerdict,
  type ReviewFinding,
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
import { projectEditedContent } from "../lib/edit-projection.ts";
import {
  READONLY_STALL_NUDGE,
  evaluateReadonlyStall,
  type ReadonlyStallState,
} from "../lib/readonly-stall.ts";
import {
  LOOP_GOAL_RELPATH,
  loopGoalRelPath,

  buildLoopGoalDirective,
  goalTextHash,
  isLoopGoalConfirmed,
  readLoopGoal,
  // buildGoalAuditTask moved with prepare_goal_audit (lib/advisory-prepare-tools.ts);
  // the goal family's own text builders (transcript/confirm/refusal messages,
  // the length cap, the carryover) moved with it into lib/goal-tools.ts +
  // lib/goal-prereview-tools.ts.
  LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK,
  LOOP_GOAL_UNCONFIRMED_EDIT_BLOCK,
  loopGoalEditGate,
  goalPrereviewPassed,
  goalReminderDue,
  GOAL_FORCE_NEGOTIATE_TURN_THRESHOLD,
  buildGoalForceNegotiateDirective,
  goalNegotiationOverdue,
} from "../lib/loop-goal.ts";
import type { LoopGoal } from "../lib/loop-goal.ts";

import { fitDialogMessage } from "../lib/dialog-budget.ts";
// The model-chain diagnosis and the /gate-doctor checks are reached only
// through lib/gate-diagnosis-commands.ts now — this file wires that module,
// it no longer runs either diagnosis itself.
import {
  buildStallNotice,
  evaluateStall,
  progressSignature,
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
  KNOWN_AGENTS,
  projectAgentIdentity,
  frontmatterBlock,
  resolvePackageAgentsDir,
  ensureAgentFilesPresent,
  validateAgentsForStartup,
} from "../lib/model-config.ts";
import type { ModelRegistry, RegistryModelInfo } from "../lib/model-config.ts";
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
  sha256,
  BYPASS_TOKEN_TTL_MS,
  type ArbitrableAction,
  type BypassToken,
  type TokenBindings,
} from "../lib/arbitration.ts";

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
  "\n[review-gate] 你还没协商并获批本会话的 loop goal —— 记得先用 `propose_loop_goal` " +
  "走完协商再改代码（未批准前 L8 会拦下 edit/write）。";



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
    checks @{upstream} so local commits ahead of remote on any branch are caught. */
async function commitsAheadOfBase(cwd: string): Promise<number> {
  try {
    const { execFileSync } = await import("node:child_process");
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
   * checkpoint marker, the audit adjudication) whose behavior is the point of
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
   * Wait for an INTERNAL audit's REPORT — the gate's own chains want the end of
   * the round, not the first message.
   *
   * `judge_wait` is message-driven for the AGENT, and that is right for an
   * agent: a streamed finding or a question is exactly what an opener wants
   * the moment it happens. The goal/plan audit chains are the opposite case.
   * They are one synchronous call inside `propose_loop_goal` /
   * `orchestrator_plan`, nobody is there to act on a finding, and both treat
   * "anything but a report" as an unfinished audit — so a message-driven
   * return would close the auditor mid-round. Since every auditor streams its
   * findings BEFORE concluding, that made any draft with findings fail closed
   * forever (P0, found by the reviewer 2026-09-05).
   *
   * So the chain keeps calling the SAME tool — no second waiting loop, no
   * second criterion (哲学三) — until the round really ends. It terminates:
   * the cursors mean a finding or a question can end one wait and never the
   * next, and the total budget is the tool's own hard cap, spent across the
   * calls rather than by each of them.
   */
  async function awaitAuditReport(
    root: string,
    ctx: unknown,
    onUpdate: ToolUpdate | undefined,
    signal: AbortSignal | undefined,
  ) {
    return awaitRoundReport({
      wait: (timeoutMs) => callTool(
        "judge_wait",
        { role: "goal-auditor", repo: root, timeoutMs },
        ctx,
        onUpdate,
        signal,
      ),
      now: () => Date.now(),
      aborted: () => signal?.aborted === true,
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
  // edit/write tool call FAILS, cleared at turn start, on new user input, on a
  // successful edit, and after one nudge. While set, a bash result that looks
  // like a direct file write gets BASH_WRITE_NUDGE appended (lib/edit-
  // discipline.ts). This targets the recurring "edit failed → shell edits the
  // file" workaround without policing ordinary bash usage.
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
      if (existing && existing.sessionId === state.sessionId) {
        s = existing;
      } else {
        s = emptyState(state.sessionId ?? null, projectConfig.maxRounds);
        const files = changedFiles(root);
        if (files && files.length > 0) {
          if (files.some(isCodeFile)) s.hasCodeChange = true;
          if (files.some(isDocFile)) s.hasDocChange = true;
          if (s.hasCodeChange || s.hasDocChange) {
            s.review.verdict = "PENDING";
            s.precommit.verdict = "NOT_RUN";
          }
        }
      }
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
   *  primary's live state, the in-memory cache, or a sidecar left by THIS
   *  session. A sidecar from ANOTHER session is NOT trusted here (same policy
   *  as stateForRepo — see its docstring): it falls through to undefined so
   *  the caller's fail-closed "no gate state" handling applies (a never-
   *  edited repo with uncommitted work blocks shipping from it). */
  function enforcementStateFor(root: string): GateState | undefined {
    // The session's OWN repo answers from the in-memory state; any other repo
    // must produce a sidecar written by THIS session, or the caller's
    // fail-closed "no gate state" handling applies.
    if (root === primaryRepoRoot) return state;
    const cached = repoStateCache.get(root);
    if (cached) return cached;
    const loaded = loadSidecar(sidecarPath(root));
    return loaded && loaded.sessionId === state.sessionId ? loaded : undefined;
  }

  /** Normalize a tool/git path to a repo-relative form for scope comparisons
   *  (changedFiles() emits repo-root-relative paths; edit tools may pass
   *  absolute). NOTE: assumes the session cwd IS the repo root — the same
   *  standing assumption sidecarPath() and every changedFiles()/isCodeFile()
   *  consumer in this file already make; scope-set membership relies on it. */
  function repoRelative(p: string): string {
    const abs = p.startsWith("/") ? p : pathJoin(cwd, p);
    return abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;
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
   * review covered) and hands them to the pure decision function. Every
   * missing fact resolves to a FULL review — see lib/review-scope.ts.
   */
  function reviewScopeFor(root: string, st: GateState): ReviewScopeDecision {
    const base = st.lastReadyReview;
    if (!base) return decideReviewScope({});
    const increment = incrementSinceTree(root, base.treeOid);
    return decideReviewScope({
      baseTree: base.treeOid,
      changedFiles: increment?.files,
      changedLines: increment?.lines,
      previouslyReviewedFiles: base.files,
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
    const base = st.lastReadyReview;
    if (!base) return undefined;
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
    const reported: ChildReportedState = opts.state ?? (judging
      ? "waiting-judge"
      : streaming
        ? "working"
        : state.completion?.at
          ? "done"
          : "idle");
    const now = Date.now();
    const changed = reported !== lastReportedChildState;
    if (!opts.force && !changed && now - lastChildReportAt < CHILD_STATE_REFRESH_MS) return;
    lastReportedChildState = reported;
    lastChildReportAt = now;
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
      },
    );
  }

  /** How often the heartbeat ticks (drain + a state refresh when it is due). */
  const CHILD_HEARTBEAT_MS = 10_000;
  /** How stale an unchanged state report may get before it is rewritten. */
  const CHILD_STATE_REFRESH_MS = 60_000;
  let childHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
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
   * Epoch ms of the child's last FORWARD PROGRESS (E). Advanced ONLY by a real
   * agent event — a tool result or a turn boundary — never by the heartbeat, so
   * a `working` child that keeps turning the crank shows a small "no progress"
   * reading while one wedged in place shows a growing one. Undefined until the
   * first event, so a booting session is not reported as stuck.
   */
  let lastChildProgressAt: number | undefined;
  /** Stamp forward progress. Called from the agent-event handlers, not the heartbeat. */
  function noteChildProgress(): void {
    if (childBinding()) lastChildProgressAt = Date.now();
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
    }, CHILD_HEARTBEAT_MS);
  }

  function stopChildHeartbeat(): void {
    if (childHeartbeatTimer) clearInterval(childHeartbeatTimer);
    childHeartbeatTimer = undefined;
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
    const verdict = checkSessionExclusivity({
      env: process.env,
      sessionId: state.sessionId,
      existing: readPresence(cwd),
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
          // STOP-FIRST (user decision 2026-09-01): any OPEN dialog is
          // dismissed as INTERRUPTED before the message is injected — a
          // goal box, a question, a consent. The controller is swapped so
          // the NEXT dialog starts clean; the abort below additionally
          // stops the current turn if one is running.
          gateInterruptController.abort();
          gateInterruptController = new AbortController();
          ctx.abort?.();
          if (interruptText) {
            // sendUserMessage is fire-and-forget in this pi build (the loader
            // does not return the promise), so there is nothing to await or
            // race: the message is handed to pi synchronously and the ack
            // records that. A failure surfaces as the child never acking.
            pi.sendUserMessage(interruptText, { deliverAs: "steer" });
            acknowledgeInstruct(binding, instruction.instructId, true, "已解除等待并立即投递正文 (deliverAs:steer)", "injected");
          } else {
            acknowledgeInstruct(binding, instruction.instructId, true, "已调用 ctx.abort()", "injected");
          }
          continue;
        }
        const text = instructText(channelIO, instruction);
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
  function currentOrchestrationId(): string {
    if (!orchestrationIdValue) orchestrationIdValue = newOrchestrationId(primaryRepoRoot, Date.now());
    return orchestrationIdValue;
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
    state.orchestrator = runtime;
    // No `if (latestCtx)`: an in-memory-only runtime would silently lose the
    // user's plan approval and the child registry on a restart. persist()
    // takes the context only to refresh the status widget, so a missing one
    // costs a redraw, never the record.
    persist(latestCtx);
  }
  const orchestratorDeps = createOrchestratorDeps({
    repoRoot: primaryRepoRoot,
    taskMode: () => state.taskMode,
    loadRuntime: () => state.orchestrator,
    storeRuntime: persistOrchestration,
    orchestrationId: currentOrchestrationId,
    confirm: (title, message, pointer) => confirmBounded(latestCtx ?? {}, title, message, pointer),
    select: (title, options) => {
      const ctx = latestCtx as { ui?: { select?: (t: string, o: string[]) => Promise<string | undefined> } } | undefined;
      if (!ctx?.ui?.select) return Promise.resolve(undefined);
      return ctx.ui.select(title, [...options]);
    },
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
    knownRepoRoots: () => knownRepoRoots(),
    // Symmetric re-arm (goal 5): the project manager's work is its
    // orchestration tools — the loop session's work is its edits. The
    // whole reason `loopArmed` has three re-arm sites on the edit path
    // and none for the manager is that the manager never edits; here it
    // re-arms itself by managing.
    onToolCall: () => { armLoop(); },
    // Goal 7 — a handoff is a VOLUNTARY exit. The successor inherits the
    // orchestration; waking the retired session would put two project
    // managers on one orchestration.
    onHandoff: () => { handedOffOrchestration = true; },
  });
  registerOrchestratorStateTools(pi, orchestratorDeps);
  registerOrchestratorSessionTools(pi, orchestratorDeps);

  /** Constraints 3, 4 and 11 — the orchestration's own exit contract. */
  function orchestrationDoneProblems(): string[] {
    if (state.taskMode !== "orchestrator") return [];
    const runtime = state.orchestrator ?? emptyRuntime(currentOrchestrationId());
    const panes = (() => {
      try {
        const self = orchestratorDeps.ownPane();
        if (!self) return [] as string[];
        const listed = orchestratorDeps.tmux(["list-panes", "-t", self, "-F", "#{pane_id}"]);
        return listed.ok ? listed.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
      } catch { return [] as string[]; }
    })();
    return orchestratorDoneProblems({
      plan: readPlanFile(primaryRepoRoot).plan,
      runtime,
      alivePaneIds: panes,
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
  /** A session that handed its orchestration over must not be revived. */
  let handedOffOrchestration = false;
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
  function drainSupervisionNews(): string[] {
    if (state.taskMode !== "orchestrator") return [];
    try {
      const runtime = orchestratorDeps.runtime();
      const open = runtime.children.filter((c) => !c.closedAt);
      if (open.length === 0) return [];
      const panes = alivePaneIdsForSupervision();
      const snapshot = superviseChildren({
        orchestrationId: runtime.orchestrationId,
        children: open,
        livePanes: panes,
        io: channelIO,
        at: Date.now(),
      });
      lastSupervisionHealth = formatChildHealth(snapshot.health);
      const decided: { events: { summary: string }[]; memory: SupervisionMemory } =
        decideSupervisionEvents(snapshot, orchestratorDeps.supervisionMemory(), Date.now());
      orchestratorDeps.saveSupervisionMemory(decided.memory);
      return decided.events.map((event) => event.summary);
    } catch {
      return []; // supervision is a convenience for the timer, never a gate
    }
  }

  /** Pane ids that exist right now; `undefined` when tmux cannot be read. */
  function alivePaneIdsForSupervision(): Set<string> | undefined {
    const self = process.env.TMUX_PANE?.trim();
    if (!self) return undefined;
    try {
      const out = execFileSync("tmux", ["list-panes", "-t", self, "-F", "#{pane_id}"], {
        encoding: "utf8", timeout: 5000,
      });
      return new Set(out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    } catch {
      return undefined;
    }
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
          handedOff: handedOffOrchestration,
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
   * on, and only while the session is idle — a wake-up delivered mid-turn
   * would just be noise, and `orchestrator_wait` reads the same channels
   * itself.
   */
  function startSupervisionTimer(ctx: ExtensionContext): void {
    if (supervisionTimer || state.taskMode !== "orchestrator") return;
    supervisionTimer = setInterval(() => {
      try {
        if (state.taskMode !== "orchestrator") { stopSupervisionTimer(); return; }
        if (!ctx.isIdle?.()) return;
        const news = drainSupervisionNews();
        if (news.length === 0) return;
        pi.sendMessage({
          customType: "review-gate",
          content:
            "[ORCHESTRATION] 子会话需要你：\n" +
            news.map((n) => `- ${n}`).join("\n") +
            "\n调 `orchestrator_wait({ timeoutMs: 0 })` 拿完整回执（问题正文与选项都在里面），" +
            "再用 `orchestrator_answer` 回；别让它就这么等着。",
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
    if (!loopGoalConfirmed()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
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
    startSupervisionTimer(ctx);
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
   * Who THIS session is for opener checks: the orchestration id when this
   * session manages one, else its own session id. Unknown ⇒ fail-closed.
   */
  function callerIdentity(): string | undefined {
    const orch = process.env[ORCHESTRATION_ID_ENV]?.trim();
    if (state.taskMode === "orchestrator" && orch) return orch;
    return state.sessionId ?? undefined;
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
  function ownJudges(): JudgeEntry[] {
    const caller = callerIdentity();
    return caller ? listByOpener(judgeHierarchy, caller) : [];
  }

  /** The judge panes this window currently has, or undefined when unreadable. */
  function listOwnWindowPanes(): string[] | undefined {
    const ownPane = process.env.TMUX_PANE?.trim() || undefined;
    try { return ownPane ? listJudgePanes((argv) => runTmux(argv), ownPane) : undefined; }
    catch { return undefined; }
  }

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
      const slices = new Map<string, { judges: Record<string, JudgeEntry>; audit?: PendingAudit }>();
      const slice = (root: string) => {
        let s = slices.get(root);
        if (!s) { s = { judges: {} }; slices.set(root, s); }
        return s;
      };
      for (const [id, e] of Object.entries(judgeHierarchy)) slice(e.repoRoot).judges[id] = e;
      for (const [root, v] of pendingAudits) slice(root).audit = v;
      for (const root of hierarchyFileRoots) slice(root);
      for (const [root, s] of slices) {
        hierarchyFileRoots.add(root);
        const file = pathJoin(root, ".pi", HIERARCHY_FILENAME);
        const empty = Object.keys(s.judges).length === 0 && !s.audit;
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
  interface ReviewTarget { baseline: string; head: string; tree: string; }
  const reviewTargets = new Map<string, ReviewTarget>();

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
    const skip = gateStatePersistSkip(process.env);
    if (!skip) return false;
    if (!gateStateSkipAnnounced) {
      gateStateSkipAnnounced = true;
      try { pi.appendEntry(GATE_STATE_SKIP_ENTRY, { ...skip, at: new Date().toISOString() }); }
      catch { /* older Pi without appendEntry — the notice below still tells someone */ }
      try { ctx?.ui.notify(skip.reason, "info"); } catch { /* headless */ }
    }
    return true;
  }

  // `ctx` is optional because it is used for ONE thing — refreshing the status
  // widget. A caller that has no context (the orchestration tools persist from
  // a callback) must still be able to write the record: dropping the write
  // instead would lose the user's plan approval on a restart.
  function persist(ctx?: ExtensionContext) {
    // A judge writes NO gate state (lib/judge-side.ts explains why). Checked
    // here, at the single funnel every gate-state write goes through, rather
    // than at each call site — a new caller must not be able to reintroduce it.
    if (noteGateStatePersistSkip(ctx)) return;
    // Nor does a session another one holds this worktree against: that sidecar
    // is the HOLDER's — its mode, its verdicts, its unmet list — and the whole
    // point of refusing is that these two must not overwrite each other. (The
    // refusal itself is memory-only; saveSidecar strips it as well.)
    if (state.exclusivityRefusal) return;
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
    } else if (restored && restored.sessionId !== sessionId) {
      state = emptyState(sessionId, restored.maxRounds ?? DEFAULT_MAX_ROUNDS);
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

  let lastLayerNotifyText = "";
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
  function ensureModelLayersRendered(ctx: ExtensionContext): void {
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
      if (projectConfig.agentsGlobalCorrupt) {
        problems.push("global: ~/.pi/review-gate.json is corrupt or its agents section is invalid — keeping the last rendered model chains (fail-safe)");
      } else {
        const { map, diagnostics } = effectiveAgentsConfig(projectConfig.agentsGlobal ?? undefined, undefined);
        problems.push(...diagnostics);
        problems.push(...projectConfig.agentsDiagnostics.filter((d) => d.startsWith("global:")));
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
      if (projectConfig.agentsProjectCorrupt) {
        problems.push("project: .pi/review-gate.json is corrupt or its agents section is invalid — keeping the last rendered model chains (fail-safe)");
      } else {
        const { map, diagnostics } = effectiveAgentsConfig(undefined, projectConfig.agentsProject ?? undefined);
        problems.push(...diagnostics);
        problems.push(...projectConfig.agentsDiagnostics.filter((d) => d.startsWith("project:")));
        // (The cross-layer reviewer-readonly guard retired 2026-08-27 with
        // the follow rule: the readonly dispatch path no longer exists.)
        const res = applyAgentConfigLayer({
          agents: map,
          targetDir: pathJoin(primaryRepoRoot, ".pi", "agents"),
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
    if (sessionInGit && !loopGoalConfirmed()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
    return {
      mode: state.taskMode,
      nonGit: !sessionInGit,
      // NON-GIT SHORT-CIRCUIT: `currentBranch` would run git and, outside a
      // repository, leak "fatal: not a git repository" to the terminal.
      // The user decision (2026-09-02): in a non-git directory, do not call
      // git at all — no branch is shown.
      branch: sessionInGit ? currentBranch(primaryRepoRoot) ?? "(detached)" : undefined,
      edited: sessionEdited || state.hasCodeChange || state.hasDocChange || sessionEditedPaths.size > 0,
      unmet: completion,
    };
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
    // belowEditor — the gate status panel. Content-compared so pi only
    // belowEditor — the gate status strip. Content-compared so pi only
    // re-renders when something actually changed.
    try {
      const lines = buildGateWidget(gateWidgetFacts());
      const key = lines.join("\n");
      if (key !== lastAgentsWidget) {
        lastAgentsWidget = key;
        ctx.ui.setWidget("review-gate-agents", lines, { placement: "belowEditor" });
      }
    } catch { /* display-only */ }
  }


  /**
   * Is a judge child process (reviewer / adviser / goal-auditor) still in
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
  // Two rules, both learned the hard way (see lib/dialog-budget.ts):
  //
  //  1. LONG TEXT GOES TO THE TRANSCRIPT. `ui.confirm` renders its text as one
  //     unclipped block at the bottom of the screen; anything tall enough to
  //     push the animating spinner row out of the viewport turns every spinner
  //     frame into a full-screen clear (measured: 29 of 30 frames). The
  //     transcript scrolls, the dialog does not.
  //  2. A DIALOG ONLY CARRIES THE DECISION. Every ui.confirm in this file goes
  //     through confirmBounded, which enforces the row budget.

  /** Hard cap on one transcript notice, so nothing can flood the screen. */
  const USER_NOTICE_MAX_CHARS = 4000;

  // (The sensitive-path dialog cap moved to lib/consent-request-tools.ts with
  // the tool that echoes the path — SENSITIVE_PATH_DIALOG_MAX_CHARS.)

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
   * Returns false when there is no UI to render into (headless): callers must
   * report that honestly instead of claiming the user saw something.
   */
  function showToUser(
    uiCtx: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
    lead: string,
    body: string,
  ): boolean {
    const clipped = body.length > USER_NOTICE_MAX_CHARS
      ? body.slice(0, USER_NOTICE_MAX_CHARS) + "\n…（已截断）"
      : body;
    try {
      const notify = uiCtx.ui?.notify;
      if (!notify) return false;
      notify(`${lead}\n${clipped}`, "warning");
      return true;
    } catch {
      return false; // headless / no UI
    }
  }

  /**
   * `ui.confirm` with the dialog-height budget applied. Never let a caller pass
   * unbounded text straight to the host: that is the flicker bug.
   *
   * `signal` is what lets an ORCHESTRATOR's answer take the box off the
   * user's screen: pi dismisses the dialog when it aborts, and the resolved
   * `undefined` is then read as "somebody else settled this", not as a
   * refusal (lib/orchestrator-child-channel.ts owns that distinction).
   */
  async function confirmBounded(
    uiCtx: { ui?: { confirm?: (title: string, message: string, opts?: { signal?: AbortSignal }) => Promise<boolean> } },
    title: string,
    message: string,
    pointer?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const fitted = pointer === undefined
      ? fitDialogMessage(title, message)
      : fitDialogMessage(title, message, pointer);
    return (await uiCtx.ui?.confirm?.(title, fitted.message, signal ? { signal } : undefined)) === true;
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
    // A HINT, not a refusal: the hook can only block or stay silent, so this
    // is how the gate says "there is a tool for that" without taking the
    // command away. Deduplicated per session — the same advice on every
    // iteration of a loop would be noise, and noise is ignored.
    hint: (message) => {
      if (deliveredHints.has(message)) return;
      deliveredHints.add(message);
      try { pi.sendUserMessage(message, { deliverAs: "followUp" }); } catch { /* session gone */ }
    },

    isEditTool: (toolName) => EDIT_TOOL_NAMES.has(toolName),
    isJudgeSession: () => readJudgeSideEnv(process.env) !== undefined,
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
    loopGoalConfirmed: () => loopGoalConfirmed(),
    crossRepoVerdictHint,
    classifier,
    notice: (ctx) => statusNotice(llmNoticeUi(ctx), LLM_STATUS_KEY),
    refuseText,
    appendLesson,
    bypassToken: () => bypassToken,
    setBypassToken: (token) => { bypassToken = token; },
    clearBypassToken,
    computeTokenBindings,
    setLastBlockedShip: (record) => { lastBlockedShip = record; },
  };

  pi.on("tool_call", (event, ctx) => evaluateToolCall(shipGateHookDeps, event, ctx));

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
  // The two tools that drive it (`request_copilot_review`,
  // `check_copilot_review`) live in lib/copilot-review-tools.ts, and the `gh`
  // access they run on in lib/copilot-gh.ts — their wiring is further down.
  // What stays here is what the REST of the extension consults: whether the
  // loop is active for a repo, the completion-only problems it reports, and
  // the directory `gh` must run in (both closures over this extension's own
  // project config, primary root and cwd).

  /** Is the L7 loop active for this repo's state? (mode + project config) */
  function copilotEnabled(st: GateState): boolean {
    return projectConfig.copilotReview.enabled && st.taskMode !== "normal";
  }

  /**
   * Copilot problems for one repo — a COMPLETION-only requirement.
   * Never consulted by the ship gate (see lib/copilot-review.ts header).
   */
  function copilotProblemsFor(st: GateState | undefined): string[] {
    if (!st || !copilotEnabled(st)) return [];
    return copilotProblems(st.copilot);
  }

  /** The directory `gh` should run in for a given repo root. */
  function repoDirFor(root: string): string {
    return root === primaryRepoRoot ? cwd : root;
  }

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
    if (!loopGoalEditGate({ taskMode: state.taskMode, goalConfirmed: loopGoalConfirmed(goalRoot, goalSt) })) {
      // Name the repo that lacks an approved goal: in a multi-repo session an
      // anonymous block makes the agent re-approve the PRIMARY goal and stay
      // blocked forever — the propose_loop_goal `repo` parameter is what
      // binds a goal to a specific repo.
      const repoHint = goalRoot === primaryRepoRoot ? "" : ` (repo: ${goalRoot})`;
      return { block: true, reason: LOOP_GOAL_UNCONFIRMED_EDIT_BLOCK + repoHint };
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
    noteChildProgress();
    // 1. Edits: only arm gate on success.
    if (EDIT_TOOL_NAMES.has(event.toolName)) {
      if (event.isError) {
        // Edit-discipline nudge (prompt-only, non-blocking): a failed edit is
        // the classic trigger for the "shell edits the file instead"
        // workaround. Append guidance to THIS result and arm the same-turn
        // bash window; the failure semantics stay untouched (isError true).
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
      // A code/doc file's repo becomes the active repo (the target for the
      // next verdict record / run_precommit) and joins the declare_done set.
      // A non-code/doc edit (config dumps, scratch) must NOT retarget the
      // active repo or grow the set (round-3 Nit — it would only waste a
      // round on a change-less repo).
      const absEditPath = path.startsWith("/") ? path : pathJoin(cwd, path);
      const editRepo = gitRootOfDir(pathDirname(absEditPath));

      // Gate-owned paths (.pi/, .pi-subagents/) are excluded from the
      // fingerprint AND from changedFiles(), so a reviewer can never see them.
      // Tracking such an edit would arm the doc gate and demote READY→PENDING
      // over a file with nothing to review — exactly the self-deadlock the
      // exclusion exists to prevent. It covers the gate's own sidecar/lesson
      // writes and the agent-authored .pi/loop-goal.md alike.
      if (isGateOwnedPath(absEditPath, editRepo ?? primaryRepoRoot)) return;
      if (editRepo && editRepo !== primaryRepoRoot) {
        const isProjectFile = isCodeFile(path) || isDocFile(path);
        const isNewRepo = !sessionRepos.has(editRepo);
        if (isProjectFile) {
          sessionRepos.add(editRepo);
          activeRepoRoot.current = editRepo;
        }
        const s = stateForRepo(editRepo);
        let dirty = false;
        if (isCodeFile(path) && !s.hasCodeChange) { s.hasCodeChange = true; dirty = true; }
        if (isDocFile(path) && !s.hasDocChange) { s.hasDocChange = true; dirty = true; }
        if (isProjectFile) {
          const rel = absEditPath.startsWith(editRepo + "/")
            ? absEditPath.slice(editRepo.length + 1)
            : absEditPath;
          if (!s.sessionEditedFiles) s.sessionEditedFiles = [];
          if (!s.sessionEditedFiles.includes(rel)) s.sessionEditedFiles.push(rel);
          invalidateBindings(s);
          // A NEW EDIT UN-FINISHES THE TASK (round-2 hardening). The
          // completion record is what a supervising orchestrator reads to
          // decide a child is `done`; a session that starts editing again is
          // working, whoever asked it to — including a human typing straight
          // into the pane, which no orchestration tool can observe.
          if (s.completion) delete s.completion;
          armLoop();
          if (s.pausedQuestion) delete s.pausedQuestion;
          dirty = true;
          clearBypassToken(); // any edit invalidates a standing arbiter bypass
        }
        if (dirty) {
          persistRepo(ctx as unknown as ExtensionContext, editRepo);
          // P-multi (round-2 P2): the FIRST cross-repo edit grows the repo
          // set — record it in the PRIMARY sidecar's sessionReposPaths NOW so
          // a crash/restart before the next primary persist cannot drop this
          // repo from the resumed declare_done set.
          if (isNewRepo) persist(ctx as unknown as ExtensionContext);
        }
        return;
      }

      let dirty = false;
      // P-multi: an edit in the PRIMARY repo makes it the active repo again —
      // otherwise a single cross-repo edit would leave verdict recording /
      // run_precommit pointed at the other repo forever (multi-repo deadlock).
      // (An edit OUTSIDE any git repo — editRepo null, e.g. a /tmp scratch
      // file — must NOT retarget the active repo; that would silently point
      // the next recorded verdict at the primary and waste a round.)
      if (editRepo === primaryRepoRoot) activeRepoRoot.current = primaryRepoRoot;
      if (isCodeFile(path) && !state.hasCodeChange) { state.hasCodeChange = true; dirty = true; }
      if (isDocFile(path) && !state.hasDocChange) { state.hasDocChange = true; dirty = true; }
      if (isCodeFile(path) || isDocFile(path)) {
        // Scope tracking: this file is part of THIS session's own work — it is
        // always IN scope, even under a user-granted scope limit (which the
        // persisted lists must reflect across restarts).
        const rel = repoRelative(path);
        sessionEditedPaths.add(rel);
        if (!state.sessionEditedFiles) state.sessionEditedFiles = [];
        if (!state.sessionEditedFiles.includes(rel)) state.sessionEditedFiles.push(rel);
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
        // Same as the cross-repo branch above: editing again means this task
        // is not finished any more, so the completion an orchestrator reads
        // must go with it.
        if (state.completion) delete state.completion;
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
        !loopGoalConfirmed() &&
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
      // READONLY_STALL_LIMIT append the nudge (never a block). Skipped in
      // normal mode like the edit-discipline nudges. State is in-memory
      // only — no persistence.
      if (state.taskMode !== "normal" && event.isError !== true) {
        const stall = evaluateReadonlyStall({
          previous: readonlyStallState,
          produced: false,
          read: true,
        });
        readonlyStallState = stall.state;
        if (stall.nudge) {
          return {
            content: [...(event.content ?? []), { type: "text", text: READONLY_STALL_NUDGE }],
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
          if (arming.some(isCodeFile) && !st.hasCodeChange) { st.hasCodeChange = true; }
          if (arming.some(isDocFile) && !st.hasDocChange) { st.hasDocChange = true; }
          if (st.hasCodeChange || st.hasDocChange) {
            invalidateBindings(st);
            clearBypassToken();
            persistRepo(ctx as unknown as ExtensionContext, root);
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

      // Read-only drill stall guard (lib/readonly-stall.ts): bash is the
      // drill workhorse (grep/sed through node_modules/), so count it like
      // the read family. Deliberately at the END of the bash branch — after
      // every state-maintenance safety net (sentinel invalidation, re-arm,
      // copilot, edit-discipline nudge) — so this nudge can never skip them.
      // Skipped in normal mode. State is in-memory only — no persistence.
      if (state.taskMode !== "normal" && event.isError !== true) {
        const stall = evaluateReadonlyStall({
          previous: readonlyStallState,
          produced: false,
          read: true,
        });
        readonlyStallState = stall.state;
        if (stall.nudge) {
          return {
            content: [...(event.content ?? []), { type: "text", text: READONLY_STALL_NUDGE }],
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
      "submission chain (and stamps the checkpoint marker on the subject) — call it directly only " +
      "to freeze work without submitting it. " +
      "Commits the current worktree as a checkpoint commit — the ONLY way to commit before a READY " +
      "review. Requires a precommit PASS (it bypasses READY only, never precommit), validates the " +
      "message is English (L5), commits everything (git add -A), records the commit sha and the " +
      "branch it landed on, and refuses any branch that is not this session's work branch. " +
      "Every review round judges baseline..HEAD, so checkpoints are the review unit.",
    parameters: Type.Object({
      message: Type.String({ description: "English commit message (Conventional Commits style)" }),
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
          content: [{ type: "text", text: `review-gate: checkpoint 拒绝 — 不能在受保护分支 ${here} 上提交（checkpoint 也是 commit）。请先切到功能分支（如 git checkout -b <branch>）再 checkpoint。` }],
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

      if (!precommitBypassed && st.precommit.verdict !== "PASS") {
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
      if (!precommitBypassed && st.precommit.testScope !== "full") {
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
            let isNew = false;
            try {
              execFileSync("git", ["cat-file", "-e", `HEAD:${p}`], { cwd: root, stdio: "ignore" });
            } catch {
              isNew = true; // not in HEAD ⇒ this change creates it
            }
            return { path: p, lines, isNew };
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

        const sweptIn = paths;
        execFileSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
        execFileSync("git", ["commit", "-m", message], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, REVIEW_GATE_BYPASS: "1" },
        });
        const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
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
              (precommitBypassed
                // R-22: never let a bypassed round read like a clean one.
                ? "\n\n**本轮 precommit 被 `/gate-bypass` 覆盖**（用户授权）：全量测试并没有在这份内容上跑过。" +
                  "这条事实已经记进 checkpoint，reviewer 与 declare_done 都会看到 —— 请在送审说明里写清 bypass 的理由。" +
                  "注意 bypass 是**会话级**的：在本会话里它对之后每一次 checkpoint 同样生效，" +
                  "根因修好之后请让用户 `/gate-reset`（或重开会话），别让它一直挂着。"

                : "\n\nThe required full precommit already ran typecheck + build + the COMPLETE test suite on this exact content " +
                  "(cache: an unchanged input set is reused in seconds — do NOT manually re-run the full suite or `tsc`; " +
                  "run only targeted tests for files you keep editing, and let the round's own full lane be the single gate).") +
              (sizeCheck.advisory.length ? "\n\n" + formatFileSizeVerdict(sizeCheck) : ""),
          }],
          details: { committed: true, sha, precommitBypassed },

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
  async function submitForReview(input: {
    root: string;
    note: string;
    message?: string;
    reason?: string;
    ctx: unknown;
    /** Progress sink for the chain (each step publishes as it starts/ends). */
    progress?: ProgressReporter;
  }): Promise<{ ok: true; taskText: string; streamPath?: string } | { ok: false; text: string }> {
    // 1. It has to build. A full lane, because a checkpoint that only ran the
    //    related tests cannot clear the ship gate later anyway.
    //
    //    UNLESS the user issued a `/gate-bypass` (R-22). Then this step is
    //    SKIPPED rather than run-and-ignored: re-running a precommit that is
    //    failing for an environment reason costs minutes and changes nothing,
    //    and the whole point of the bypass is that the user already decided
    //    this round ships without it. The fact is recorded on the checkpoint
    //    and repeated to the reviewer.
    const bypassActive = stateForRepo(input.root).bypass.active;
    if (bypassActive) {
      input.progress?.step("precommit (被 /gate-bypass 覆盖，跳过)");
      input.progress?.done("BYPASSED");
    } else {
    input.progress?.step("precommit (full)");

    const pre = await callTool(
      "run_precommit",
      { mode: "full", repo: input.root },
      input.ctx,
      // The runner's live log is this step's tail: the 92s (median) precommit
      // is where the chain spends most of its time, so it is where the human
      // needs to see something moving.
      input.progress ? (partial) => input.progress?.tail(partial.content.map((c) => c.text).join("\n")) : undefined,
    );
    if (pre.details?.verdict !== "PASS") {
      input.progress?.fail(String(pre.details?.verdict ?? "no verdict"));
      return {
        ok: false,
        text: "review-gate: 本轮未送审 — precommit 没过。\n" + toolText(pre) +
          "\n修好后重新 judge_submit({role:\"reviewer\"})；无需手动再跑 precommit。" +
          "\n如果它是因为**与本次改动无关的环境问题**失败的（例如注入的环境变量污染了测试子进程），" +
          "那是用户的决定：让用户 `/gate-bypass <理由>` —— bypass 会连这条前置一起覆盖，并全程留痕。",
      };
    }
    input.progress?.done("PASS");
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
    const commit = await callTool("review_checkpoint", { message, repo: input.root }, input.ctx);
    if (commit.isError) {
      input.progress?.fail("被拒");
      return {
        ok: false,
        text: "review-gate: 本轮未送审 — checkpoint 提交被拒。\n" + toolText(commit),
      };
    }
    input.progress?.done(typeof commit.details?.sha === "string" ? String(commit.details.sha).slice(0, 12) : "worktree 已冻结");
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
    return {
      ok: true,
      taskText: `本轮改动说明（来自主会话）：\n${input.note}\n\n${taskText}`,
      // The findings stream is the agent's half of the round: it fixes what
      // the reviewer confirms WHILE the reviewer works. Dropping the path
      // here would leave that channel written but unread.
      ...(typeof prepared.details?.stream === "string" ? { streamPath: prepared.details.stream } : {}),
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
   * many run at once — a missed boundary puts two writers in one file. The
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
   * The checkpoint's commit message — the whole rule (Conventional Commits
   * with the `checkpoint` marker injected into the SCOPE, and the L5
   * non-English fallback) lives in lib/checkpoint-message.ts, unit-tested
   * there. This wrapper only names the call site.
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
  function dispatchJudgeRound(opts: {
    root: string;
    role: string;
    title: string;
    task: string;
    fresh?: boolean;
    /** This round's findings stream, recorded on the child for judge_wait. */
    streamPath?: string;
  }): JudgeDispatch {
    const { root, role, task } = opts;
    dropDeadForeignJudges();
    const title = opts.title.replace(/[^A-Za-z0-9._-]/g, "-") || role;
    const opener = callerIdentity();
    if (!opener) {
      return { ok: false, reused: false, error: "无法确认调用者身份——身份不明时不能派 review。" };
    }
    sweepStaleJudgeSessionDirs(root);
    const sessionId = judgeSessionIdFor(role, shortRepoHash(root), opener);
    const judgeId = sessionId;
    // STABLE per role+repo+opener (B5) — identity, not a per-round path.
    const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener));
    const sessionDir = pathJoin(workDir, "sessions");
    const continuesSession = hasTranscript(sessionDir);
    const ownPane = process.env.TMUX_PANE?.trim() || undefined;
    const run = (argv: readonly string[]) => runTmux(argv);
    // Opener-scoped ids do not collide across sessions by construction: a second
    // opener derives a different id and opens its own review. Cross-opener protection
    // still lives in lib/hierarchy.ts (registration refuses two parents for one id).
    // The lookup IS that derivation: the registry is keyed by judge id, so
    // "same role, same session id in this repo" needs no scan of a second table.
    const existing = judgeHierarchy[judgeId];

    // Stamped on every entry that records a pane, and checked before any use
    // of a recorded one (see lib/hierarchy.ts `paneClosable`).
    const tmuxServer = tmuxServerFrom(process.env);

    // A recorded pane is probed only when its id is still comparable: an entry
    // restored from disk may have been minted by a tmux server that has since
    // restarted, and `%7` would then be a stranger's pane — reusing it would
    // send this round's task into it. Not comparable ⇒ treat as dead, which
    // falls through to a fresh open below (transcript continues by id).
    const paneUsable = existing !== undefined && paneClosable(existing, tmuxServer);
    const paneAlive = paneUsable && ownPane ? judgePaneAlive(run, ownPane, existing!.paneId!) : undefined;
    // A living pane takes the round through its channel: the pane is the
    // CARRIER, the round is the task. No busy refusal exists anymore — a pane judge
    // reads every round via its drain; only a one-shot process read once.
    if (existing?.paneId && paneAlive === true && !opts.fresh) {
      try {
        appendRecord(channelIO, judgeChannelTarget(opener, judgeId), {
          kind: "instruct",
          // `from` names the OPENER side of the file — planes differ by key.
          from: "orchestrator",
          at: new Date().toISOString(),
          instructId: newChannelId("in", Date.now()),
          mode: "followUp",
          text: task,
        });
      } catch (err) {
        return { ok: false, reused: true, sessionId, sessionDir, paneId: existing.paneId, judgeId, error: `本轮任务写不进通道 —— ${(err as Error).message}` };
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
      const reg = registerJudge(judgeHierarchy, {
        judgeId, openerId: opener, role, repoRoot: root, title, sessionDir,
        paneId: existing.paneId, roundSeq: nextJudgeRound(opener, judgeId),
        ...(tmuxServer === undefined ? {} : { tmuxServer }),
        ...(keptCursor === undefined ? {} : { lastReportId: keptCursor }),
        ...(keptFindings === undefined ? {} : { lastFindingCount: keptFindings }),
        ...(opts.streamPath === undefined ? {} : { streamPath: opts.streamPath }),
        spawnedAt: new Date().toISOString(),
      });
      if (reg.ok) setHierarchy(reg.table);
      return { ok: true, reused: true, sessionId, sessionDir, paneId: existing.paneId, judgeId };
    }
    // fresh:true kills the living pane FIRST (singleton per role+repo).
    // A dead record falls through to a fresh open below (the transcript
    // continues by session id, so the review never starts from zero).
    if (existing) {
      if (existing.paneId && paneAlive === true && opts.fresh) {
        try { closeJudgePane(run, existing.paneId); } catch { /* best effort */ }
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
      const { map: agents } = effectiveAgentsConfig(projectConfig.agentsGlobal, projectConfig.agentsProject);
      const files = writeJudgeSpawnFiles({ repoRoot: root, role, agents, workDir, title });
      if (!files.model) {
        // NO BUILT-IN DEFAULT (user requirement 2026-08-30): a role with no
        // resolvable chain cannot be dispatched. Fail closed with the reason
        // (the startup hard check surfaces it too, but a runtime config
        // change after start must not silently spawn a default model).
        return {
          ok: false,
          reused: continuesSession,
          sessionId,
          sessionDir,
          error: `角色 ${role} 没有可派发的模型链（agents 配置缺失或不可解析）——请修复 ~/.pi/review-gate.json 后重试`,
        };
      }
      // "Reused" is a fact about the SESSION, not about the pane: the
      // transcript decided it above, before this round could add to it.
      mkdirSync(sessionDir, { recursive: true });
      const taskPath = pathJoin(sessionDir, `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.md`);
      writeFileSync(taskPath, task, "utf8");
      const opened = openJudgePane(run, {
        ownPane,
        cwd: root,
        sessionId,
        judgeId,
        role,
        command: buildJudgePaneCommand({
          sessionId,
          taskPath,
          sessionDir,
          sysPromptPath: files.sysPromptPath,
          model: files.model,
        }),
        env: {
          [JUDGE_OPENER_ENV]: opener,
          [JUDGE_ID_ENV]: judgeId,
          [JUDGE_ROLE_ENV]: role,
          ...(opts.streamPath === undefined ? {} : { [JUDGE_STREAM_ENV]: opts.streamPath }),
        },
      });
      if (!opened.ok) {
        return { ok: false, reused: continuesSession, sessionId, sessionDir, error: opened.error };
      }
      // The freshly opened pane is registered ONCE, below — there is no
      // second record to build here anymore.
      // fresh:true starts a NEW review object: everything the channel holds so
      // far belongs to an older object and must never end this round's wait.
      // Seed the cursor at the channel's current newest report (best-effort —
      // an unreadable channel leaves it unset, and the round check at record
      // time still refuses old rounds).
      let freshCursor: string | undefined;
      try {
        const freshTarget = judgeChannelTarget(opener, judgeId);
        freshCursor = projectChannel(readChannel(channelIO, channelPathFor(freshTarget.orchestrationId, freshTarget.childId, freshTarget.home)).records).lastReport?.reportId;
      } catch { freshCursor = undefined; }
      const reg = registerJudge(judgeHierarchy, {
        judgeId,
        openerId: opener,
        role,
        repoRoot: root,
        title,
        sessionDir,
        paneId: opened.paneId, roundSeq: nextJudgeRound(opener, judgeId),
        ...(tmuxServer === undefined ? {} : { tmuxServer }),
        ...(freshCursor === undefined ? {} : { lastReportId: freshCursor }),
        // Same rule as the reuse path: a re-run over the SAME stream file keeps
        // its finding cursor, so nothing already shown is shown again.
        ...(judgeHierarchy[judgeId]?.streamPath === opts.streamPath
          && judgeHierarchy[judgeId]?.lastFindingCount !== undefined
          ? { lastFindingCount: judgeHierarchy[judgeId]!.lastFindingCount }
          : {}),
        ...(opts.streamPath === undefined ? {} : { streamPath: opts.streamPath }),
        spawnedAt: new Date().toISOString(),
      });
      if (reg.ok) setHierarchy(reg.table);
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
   * Close one judge's round — the SETTLE path's entry into the engine.
   *
   * Everything that used to live here (pick this round's report, keep the
   * adviser's prose out of the record, route a verdict to the right recorder,
   * advance the cursor exactly once) is now `settleAuditRound` in
   * lib/audit-round.ts, shared with `judge_wait` and with the synchronous
   * audits. This function only translates the outcome into the shape the two
   * callers here already speak.
   */
  async function recordJudgeConclusion(sessionId: string, ctx?: unknown): Promise<{ text?: string; recorded: boolean; bindingNote?: string } | undefined> {
    try {
      const entry = judgeHierarchy[sessionId];
      if (!entry?.role) return undefined;
      const childRoot = entry.repoRoot || primaryRepoRoot;
      const settled = await settleAuditRound(auditRoundDeps(ctx), { judgeId: sessionId, root: childRoot });
      switch (settled.status) {
        case "recorded":
          return {
            text: settled.text,
            recorded: true,
            // Travels separately: the wake-up prints the record's first line
            // only, and a weaker binding nobody reads about is a silent one.
            ...(settled.bindingNote === undefined ? {} : { bindingNote: settled.bindingNote }),
          };
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
    const mine = callerIdentity();
    if (!mine) return false;
    const ownPane = process.env.TMUX_PANE?.trim() || undefined;
    const deps = {
      channelIO: () => channelIO,
      channelHome: () => undefined,
      tmux: (argv: readonly string[]) => runTmux(argv),
      ownPane: () => ownPane,
    };
    const notices: string[] = [];
    for (const [judgeId, entry] of Object.entries(judgeHierarchy)) {
      if (entry.openerId !== mine) continue;
      const target = judgeChannelTarget(entry.openerId, judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      const projection = projectChannel(read.records);
      const freshQuestions = (projection.openRequests ?? []).filter((q) => !announcedRequestIds.has(q.requestId));
      // The sweep probes with the SAME binding the recorder will apply, so it
      // can no longer wake the agent about a round the recorder refuses to
      // close (2026-09-05).
      const obs = probeJudgeRound(
        deps,
        { openerId: entry.openerId, judgeId, paneId: entry.paneId },
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
        verdict: obs.verdict,
        findingsCount: obs.findingsCount,
        conclusionExcerpt: entry.role === "adviser" ? conclusion.text : undefined,
        streamPath: entry.streamPath,
        recordedNote: conclusion.recorded ? conclusion.text : undefined,
        bindingNote: conclusion.bindingNote,
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
          return readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home)).records;
        } catch {
          return []; // an unreadable channel is "no report", never a verdict
        }
      },
      conclusionOf: (report) => reportConclusion(channelIO, report),
      proseOf: (report) => reportText(channelIO, report),
      advanceCursor: (judgeId, reportId) => advanceReportCursor(judgeId, reportId),
      pendingAudit: (root) => pendingAudits.get(root),
      forgetPending: (root) => dropAudits(root),
      nowIso: () => new Date().toISOString(),
      checkpointAt: (root) => checkpointAtFor(root),
      savePlanAudit: (root, record) => {
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        st.planAudit = record;
        try {
          const persistCtx = latestCtx ?? lastUiCtx;
          if (persistCtx) persistRepo(persistCtx, root); else persist(undefined);
        } catch { /* best effort */ }
      },
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
      dispatch: ({ root, role, title, task, streamPath }) => {
        const dispatched = dispatchJudgeRound({
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
        const waited = await awaitAuditReport(root, waitCtx, forwardWaitUpdates(progress), signal);
        const details = (waited.details ?? {}) as { done?: unknown; reason?: unknown };
        if (!waited.isError && details.done === true && details.reason === "report") {
          return { ok: true, detail: "" };
        }
        return {
          ok: false,
          detail: details.reason === "pane-dead" ? "pane 已消失" : "等待未命中本轮 report",
        };
      },
      closeJudge: async (root, role) => {
        await callTool("judge_close", { role, repo: root }, waitCtx);
      },
      auditPassed: (root, pending) => {
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        if (pending.kind === "goal") return goalPrereviewPassed(st.goalPrereview, pending.draft);
        // The same content binding `planAuditPassed` applies, stated against
        // the hash this round dispatched: a plan edited between the audit and
        // the dialog cannot ride in on someone else's PASS.
        return st.planAudit?.verdict === "PASS" && st.planAudit.hash === pending.hash;
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
      "goal-auditor. The gate owns everything procedural: the session id and its directory " +
      "(derived from role+repo, so the judge's context carries across rounds), pane open vs. channel-queued vs. " +
      "fresh kill, and the channel verdict. You pass WHO and WHAT; you never pass a session id, a " +
      "title or a directory. It returns as soon as the round is SUBMITTED, not when the judge is " +
      "done — the round ends when its channel report lands, and the gate wakes you with " +
      "the standard report (verdict, evidence pointer, record note, open questions). A living pane takes the round " +
      "through its channel (nothing is silently dropped): wait for it, or pass " +
      "fresh:true to kill the pane and start over.",
    parameters: Type.Object({
      role: Type.Enum({ reviewer: "reviewer", adviser: "adviser", "goal-auditor": "goal-auditor" }),
      task: Type.String({
        description:
          "reviewer: what you changed this round, in your words (the gate wraps it in the review " +
          "task it builds). adviser / goal-auditor: the question or the draft to judge.",
      }),
      message: Type.Optional(Type.String({
        description:
          "reviewer only: the checkpoint commit message (English, Conventional Commits). The gate " +
          "adds the checkpoint marker itself. Omit it and the gate derives the message from your " +
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
      // NON-GIT SHORT-CIRCUIT: the review chain (precommit → checkpoint →
      // baseline..HEAD) is meaningless outside a repository, and its git
      // steps would leak fatal to the terminal. Refuse up front.
      if (!sessionInGit) {
        return {
          content: [{ type: "text", text: "review-gate: 非 git 目录 —— judge_submit 不可用（无仓库可审查）。" }],
          details: { submitted: false },
          isError: true,
        };
      }
      const role = String(params.role ?? "");
      if (!JUDGE_ROLES.includes(role as (typeof JUDGE_ROLES)[number])) {
        return {
          content: [{ type: "text", text: `review-gate: judge_submit rejected — unknown role "${role}".` }],
          details: { submitted: false },
          isError: true,
        };
      }
      const task = String(params.task ?? "").trim();
      if (!task) {
        return {
          content: [{ type: "text", text: "review-gate: judge_submit rejected — the task text is empty." }],
          details: { submitted: false },
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
       * Where THIS round's findings stream lives — the channel the agent
       * reads while the judge is still working. Every role that has one
       * reports it in the reply; criterion 1 requires it in the return.
       */
      let streamPath: string | undefined;
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
        reviewTask = `你要回答的问题（来自主会话）：\n${task}\n\n${extractTaskText(toolText(prepared))}`;
      }
      // The title is a DISPLAY label the gate derives itself (B5: it must not
      // reach the session's directory, or every round starts a new session).
      const title = `${role}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
      progress.step(`spawn ${role}`);
      const dispatch = dispatchJudgeRound({ root, role, title, task: reviewTask, fresh: params.fresh === true, streamPath });
      if (!dispatch.ok) {
        progress.fail("spawn 失败");
        const lead = "review-gate: judge_submit 失败 — ";
        return {
          content: [{ type: "text", text: `${lead}${dispatch.error ?? "review pane 未能开出来"}` }],
          details: { submitted: false, busy: false },
          isError: true,
        };
      }
      progress.done(dispatch.reused ? "已受理（续接同一会话）" : "已受理（新会话）");
      // The round is ACCEPTED — only now is the audited draft on record. A
      // refused submission (a busy role, a failed spawn) must never replace
      // the draft a running audit is judging: its verdict would be recorded
      // against text no auditor ever read, and propose_loop_goal would then
      // show the user an unaudited goal.
      if (role === "goal-auditor") {
        pendingAudits.set(root, { kind: "goal", draft: task, startedAt: new Date().toISOString() });
        persistJudgeHierarchy();
      }
      const child = judgeChildByRole(root, role);
      const lines = [
        `review-gate: ${role} 已受理本轮任务（${dispatch.reused ? "复用同一 pane，上下文延续" : "新 pane"}，judge ${dispatch.judgeId}）。`,
        `- pane: ${dispatch.paneId ?? child?.paneId ?? "(pending)"}`,
        `- transcript: ${dispatch.sessionDir ?? child?.sessionDir ?? "(pending)"}`,
        ...(streamPath ? [`- findings 流（边审边修）: ${streamPath}`] : []),
        "- 本轮结束（通道 report 落盘）即完成；门禁会用标准报告唤醒你（结论、证据位置、记录情况、待答问题）。现在别等，先做别的确定性工作。",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          submitted: true,
          role,
          reused: dispatch.reused,
          paneId: dispatch.paneId ?? child?.paneId,
          judgeId: dispatch.judgeId ?? child?.judgeId,
          sessionDir: dispatch.sessionDir ?? child?.sessionDir,
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
  const judgeSessionDeps: JudgeSessionToolDeps = {

    resolveRepo: (requested) => {
      const resolved = resolveToolRepo(requested);
      if (resolved.ok) ensureHierarchyLoaded(resolved.root);
      return resolved;
    },
    callerId: () => callerIdentity(),
    hierarchy: () => { dropDeadForeignJudges(); return judgeHierarchy; },
    saveHierarchy: (next) => setHierarchy(next),
    findChild: (root, role, judgeId) => {
      const c = findJudgeChild(root, role, judgeId);
      if (!c) return undefined;
      return {
        judgeId: c.judgeId,
        role: c.role,
        repoRoot: root,
        openerId: c.openerId,
        ...(c.paneId === undefined ? {} : { paneId: c.paneId }),
        // Carried, not dropped: judge_close decides whether it may kill by
        // that pane id, and it can only do so if it knows which server minted it.
        ...(c.tmuxServer === undefined ? {} : { tmuxServer: c.tmuxServer }),
        sessionDir: c.sessionDir,
        ...(c.streamPath === undefined ? {} : { streamPath: c.streamPath }),
      };
    },
    channelIO: () => channelIO,
    channelHome: () => undefined,
    tmux: (argv) => runTmux(argv),
    ownPane: () => process.env.TMUX_PANE?.trim() || undefined,
    tmuxServer: () => tmuxServerFrom(process.env),
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
      const settled = await settleAuditRound(auditRoundDeps(undefined), { judgeId, root });
      switch (settled.status) {
        case "recorded":
          return {
            text: settled.text,
            verdict: settled.verdict,
            hasVerdict: settled.hasVerdict,
            ...(settled.bindingNote === undefined ? {} : { bindingNote: settled.bindingNote }),
          };
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
  };
  registerJudgeSessionTools(internalHost, judgeSessionDeps);
  // The SAME implementation on the agent surface — one waiting tool, two
  // hosts. A second registration is not a second implementation: both
  // executes close over `judgeSessionDeps`.
  registerJudgeWaitTool(pi, judgeSessionDeps);

  // judge_conclude is the ONLY tool that exists on one side only: a judge
  // concludes its own round through it, and the main session must never see
  // it (a main session that could self-certify a verdict breaks the gate).
  // The guard is the registration itself — anti-forgery by surface, not secret.
  if (readJudgeSideEnv(process.env)) {
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
    });
  }
  registerJudgeSpawnTools(pi, {
    callerId: () => callerIdentity(),
    hierarchy: () => { dropDeadForeignJudges(); return judgeHierarchy; },
    saveHierarchy: (next) => setHierarchy(next),
    channelIO: () => channelIO,
    channelHome: () => undefined,
    tmux: (argv) => runTmux(argv),
    ownPane: () => process.env.TMUX_PANE?.trim() || undefined,
    tmuxServer: () => tmuxServerFrom(process.env),
    now: () => Date.now(),
    resolveRepo: (requested) => {
      const resolved = resolveToolRepo(requested);
      if (resolved.ok) ensureHierarchyLoaded(resolved.root);
      return resolved;
    },
    launchConfig: (root, role, opener) => {
      const { map: agents } = effectiveAgentsConfig(projectConfig.agentsGlobal, projectConfig.agentsProject);
      const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener));
      const files = writeJudgeSpawnFiles({ repoRoot: root, role, agents, workDir, title: role });
      if (!files.model) {
        return { ok: false, error: `角色 ${role} 没有可派发的模型链——请修复 ~/.pi/review-gate.json 后重试` };
      }
      const sessionDir = pathJoin(workDir, "sessions");
      try { mkdirSync(sessionDir, { recursive: true }); } catch { /* best effort */ }
      return { ok: true, model: files.model, sysPromptPath: files.sysPromptPath, sessionDir };
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
          repoRoot: root,
          ...(state.sessionId ? { sessionId: state.sessionId, sessionDir: sessionDirForCwd(cwd) } : {}),
        }),
      };
    },
    writeJudgeTaskFile: (root, role, opener, task) => {
      try {
        const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root), opener));
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
    registerReviewTarget: (root, target) => { reviewTargets.set(root, target); },
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
      changedFilesInRange: (root, baseline, head) =>
        execFileSync("git", ["diff", "--name-only", `${baseline}..${head}`], { cwd: root, encoding: "utf8" })
          .trim().split("\n").filter(Boolean),
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
    // ONE adjudication for the record: a READY carrying an open P0/P1 is
    // contradictory and becomes BLOCKED, and the round's findings become the
    // count and the coarse cross-round fingerprints (lib/review-adjudicate.ts).
    const parsed = adjudicateReviewConclusion({
      verdict: verdictRaw,
      findings: concluded.findings as ReviewFinding[],
      ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
      ...(concluded.docSync === undefined ? {} : { docSync: concluded.docSync }),
    });
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
      if (staleTarget) parsed.verdict = "BLOCKED";
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
    st.review = {
      verdict: parsed.verdict,
      fingerprint: bindTree,
      // Round-9 P1: the reviewed COMMIT sha rides the READY so the next
      // prepare can baseline from it (covering every later checkpoint).
      ...(parsed.verdict === "READY" && reviewTargets.get(targetRoot)
        ? { commitSha: reviewTargets.get(targetRoot)!.head }
        : {}),
      at: new Date().toISOString(),
      // Code↔doc attestation travels with the verdict it came from; absent
      // stays absent (blocks under the docSync knob — fail-closed).
      ...(parsed.docSync !== undefined ? { docSync: parsed.docSync } : {}),
    };
    // A READY verdict moves the incremental-review baseline: it records the
    // git TREE that was approved and the files that approval covered, so the
    // NEXT round can state precisely what is new instead of making the
    // reviewer re-derive the whole diff (lib/review-scope.ts). Neither field
    // authorizes anything — `review.fingerprint` still does that alone.
    if (parsed.verdict === "READY") {
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
        st.lastReadyReview = {
          treeOid,
          at: new Date().toISOString(),
          ...(files ? { files } : {}),
        };
      }
    }
    // Round-18 polish gate: record which files carried P2/Nit vs P0/P1
    // findings this round (severity + file straight off the judge's own
    // findings, never line counts). The next prepare_review derives the file
    // streak from these.
    const recorded = recordedFindingsFrom(fileFindingsFrom(concluded.findings as ReviewFinding[]));
    st.rounds.push({
      round: st.rounds.length + 1,
      findingsTotal: parsed.findingsTotal,
      fingerprints: parsed.findingFingerprints,
      verdict: parsed.verdict,
      at: new Date().toISOString(),
      ...(recorded.polishFiles.length > 0 ? { polishFiles: recorded.polishFiles } : {}),
      ...(recorded.blockingFiles.length > 0 ? { blockingFiles: recorded.blockingFiles } : {}),
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
      (cwdMismatch
        ? `\nCWD CHECK FAILED: ${cwdMismatch}. The conclusion requires the judge's own \`pwd\`, ` +
          "and the gate compares it with the repo this round was prepared for — a READY reporting a " +
          "different directory is recorded as BLOCKED. If the reviewer ended inside its throwaway " +
          "worktree, have it `cd` back to the repo root and report that instead."
        : "") +
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
      const ownedJudges = ownJudges();
      if (ownedJudges.length > 0 && (state.taskMode === "loop" || orchestratorMode)) {
        const ownPane = process.env.TMUX_PANE?.trim() || undefined;
        const run = (argv: readonly string[]) => runTmux(argv);
        const closed: string[] = [];
        const tmuxServer = tmuxServerFrom(process.env);
        for (const child of ownedJudges) {
          // `paneClosable`, not just "has a pane id": a persisted id from a
          // tmux server that has since restarted names whatever now holds that
          // number, and this is a kill (2026-09-05, adviser P1). Unverifiable
          // ⇒ the entry and its scratch are still reclaimed below, we simply
          // do not send kill-pane into someone else's window.
          if (paneClosable(child, tmuxServer) && ownPane) {
            try {
              if (closeJudgePane(run, child.paneId!).ok) closed.push(child.paneId!);
            } catch { /* best effort */ }
          }
          try { reapReviewScratch(child.judgeId); } catch { /* best effort */ }
          setHierarchy(removeJudge(judgeHierarchy, child.judgeId));
          if (child.role === "goal-auditor") dropAudits(child.repoRoot);
        }
        progress.step(`联关 ${ownedJudges.length} 个 review pane${closed.length ? `（已关 ${closed.join("、")}）` : ""}`);
      } else if (ownedJudges.length > 0) {
        for (const child of ownedJudges) {
          problems.push(`[${repoLabel(child.repoRoot)}] judge pane ${child.paneId ?? "(无 pane)"} (${child.role}) 仍开着——explore/normal 下仅提醒，不代关。`);
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
        if (state.taskMode === "loop" && !loopGoalConfirmed()) {
          completionProblems.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
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
        return {
          content: [{
            type: "text",
            text: "review-gate: declare_done REJECTED — gates unmet:\n" +
              problems.map((p) => `  - ${p}`).join("\n") +
              (orchestratorMode
                // R-30: an orchestrator has no review of its own to run, so
                // pointing it at the loop would be pointing it at nothing.
                // These are the SAME items block 5 of the `orchestrator_wait`
                // receipt lists — one decision function, two surfaces.
                ? "\n把上面这些做完再退出（这就是 `orchestrator_wait` 回执第 5 块「还差什么」，两处用的是同一个判据函数）。"
                : "\nComplete the loop (fix → judge_submit({role:\"reviewer\"}) → READY) and try again.") +
              (problems.some((p) => p.includes("modified after the last READY"))
                ? "\nTip: any code OR doc edit after a READY review invalidates it — including handoff/design/" +
                  "plan docs. Finish ALL edits (docs included) FIRST, then run the final review + precommit " +
                  "as the last steps before declare_done, so the READY fingerprint still matches."
                : ""),

          }],
          details: { accepted: false, problems },
          isError: true,
        };
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
        if (root !== primaryRepoRoot) persistRepo(ctx as unknown as ExtensionContext, root);
      }
      state.rounds = [];
      state.lastPolishReason = undefined;
      state.strategicResetFired = false;
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
      return {
        content: [{
          type: "text",
          text: `review-gate: done accepted. ${params.summary}` +
            // R-22 — a round that shipped without a precommit says so, here,
            // where the human reads the outcome.
            (state.checkpoint?.precommitBypassed
              ? "\n注意：本次交付的 checkpoint 是在 `/gate-bypass` 覆盖 precommit 前置的情况下完成的" +
                "（用户授权，理由已记在 bypass 里）—— 全量测试没有在这份内容上跑过。"
              : ""),
        }],
        details: { accepted: true, precommitBypassed: state.checkpoint?.precommitBypassed === true },

      };
    },
  });

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
    confirmBounded: (uiCtx, title, message, pointer, signal) =>
      confirmBounded(uiCtx as ExtensionContext, title, message, pointer, signal),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
    loopGoalPath: (root) => loopGoalPathIn(root),
    loopGoalRelPath: loopGoalRelPath(SESSION_STATE_VARIANT),
    findProjectAgent: (dir, name) => findProjectAgentText(dir, name),
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
   * The two L7 Copilot tools — `request_copilot_review` (ask for the review,
   * stamp the authoritative request time) and `check_copilot_review` (read
   * what it left open, and decide whether the requirement still blocks
   * completion) — live in lib/copilot-review-tools.ts; only their wiring is
   * here. They stay TRUSTED across the move: the `gh` calls run in this
   * process (lib/copilot-gh.ts), never through the agent, so the agent can
   * still not report its own review outcome.
   *
   * What they need from THIS file arrives as this deps object: the repo
   * resolution, gate state and its persistence, the directory `gh` runs in,
   * whether the loop is on for a repo (project config + mode), the
   * auto-continuation arming and the log channel. The GitHub surface is
   * injected too — one `gh` member per call the tools make — so every branch
   * they take is unit-testable without a pull request.
   */
  registerCopilotReviewTools(pi, {
    resolveRepo: (requested) => resolveToolRepo(requested),
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    repoDir: (root) => repoDirFor(root),
    copilotEnabled: (st) => copilotEnabled(st),
    armLoop: () => { armLoop(); },
    log: (message) => log(message),
    gh: {
      resolveOpenPr: (dir, signal) => resolveOpenPr(dir, signal),
      resolveRepoSlug: (dir, pr, signal) => resolveRepoSlug(dir, pr, signal),
      fetchCopilotPayload: (dir, slug, prNumber, signal) => fetchCopilotPayload(dir, slug, prNumber, signal),
      requestCopilotReviewer: (dir, pr, slug, signal) => requestCopilotReviewer(dir, pr, slug, signal),
      // The allow-list is THIS extension's project config; lib/copilot-gh.ts
      // carries no configuration of its own.
      resolveCopilotSupport: (dir, slug, supportConfirmed, opts) =>
        resolveCopilotSupport(dir, slug, supportConfirmed, projectConfig.copilotReview.owners, opts),
    },
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
  // confirmBounded / askEitherSide are this file's helpers, and the last is
  // what lets an orchestrator answer the same box the human can).
  registerUserInteractionTools(pi, {
    state: () => state,
    persist: (ctx) => persist(ctx as unknown as ExtensionContext),
    setLoopArmed: (armed) => { loopArmed = armed; },
    showToUser: (uiCtx, lead, body) => showToUser(uiCtx as Parameters<typeof showToUser>[0], lead, body),
    confirmBounded: (uiCtx, title, message, pointer, signal) =>
      confirmBounded(uiCtx as Parameters<typeof confirmBounded>[0], title, message, pointer, signal),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
    canChannelDialogs: () => childBinding() !== undefined,
    grantProxyScope: (scope, via) => {
      if (!state.orchestrator) return; // not an orchestration — nothing to grant
      persistOrchestration(addGrant(state.orchestrator, { scope, grantedAt: new Date().toISOString(), via }));
    },
    cwd,
    sessionEditedPaths: () => [...sessionEditedPaths],
    commitsAheadOfBase: () => commitsAheadOfBase(cwd),
    scopeLimitDeclined: () => scopeLimitDeclined,
    declineScopeLimit: () => { scopeLimitDeclined = true; },
    sensitiveGrants: () => sensitiveGrants,
    storeSensitiveGrants: (next) => { sensitiveGrants = next; },
    sensitiveDeclinedPaths,
    log: (message) => log(message),
  });

  // ---------- set_gate_mode tool (in-session mode decision + self-service switching) ----------

  pi.on("input", (event, ctx) => {
    // A fresh user message resets the edit-failure nudge window.
    editFailurePending = false;
    // A real user message resumes an ESC-abort pause: the user is speaking
    // again, so auto-continuation may re-arm from this turn on ("extension"
    // is how the gate injects its own follow-ups — those never count).
    if (event.source !== "extension") lastRunAborted = false;
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
        // IDENTITY TAKE-OVER GUARD (2026-09-17, user decision): a session
        // that did NOT inherit an orchestration id (no RG_ORCHESTRATION_ID)
        // and finds a plan ALREADY written by somebody else must not
        // silently become that orchestration's holder. The plan carries the
        // user's approval and authorizes spawning; adopting it under a NEW
        // minted id would spawn children nobody can address.
        if (!process.env[ORCHESTRATION_ID_ENV] && readPlanFile(primaryRepoRoot).plan !== undefined) {
          return {
            content: [{
              type: "text",
              text:
                "review-gate: 当前会话没有继承编排身份（无 RG_ORCHESTRATION_ID），" +
                "但本仓库已有别人写好的 plan —— 不接管旧编排。" +
                "若这是你要接手的旧编排，请用同一个 RG_ORCHESTRATION_ID 启动会话；" +
                "若是新编排，先清掉旧 plan（或换一个 repo）。",
            }],
            details: { mode: state.taskMode ?? null },
            isError: true,
          };
        }
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
        const goalNote = effective === "loop"
          ? "\n\n" + buildLoopGoalDirective(readSessionLoopGoal(primaryRepoRoot), loopGoalConfirmed())
          : "";
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
        // The dialog must describe what "yes" actually grants: the decision was
        // computed on `effective`, so the copy is built from it — never from `requested`.
        let ok = false;
        try {
          ok = await confirmBounded(
            ctx as unknown as ExtensionContext,
            MODE_CONFIRM_TITLE,
            buildModeConfirmMessage(effective, params.reason),
          );
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
              "review-gate: the user DECLINED the downgrade. Agent-initiated downgrades are now " +
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
      "Contest a review-gate block you believe is a MISJUDGEMENT. Two things are contestable, " +
      "both only AFTER the gate actually blocked: (a) a TEXT the language/attribution heuristics " +
      "refused (commit subject/body, PR title/body, romanized non-English, AI attribution, test " +
      "label) — a granted appeal passes THAT EXACT CONTENT once; (b) a ship block on a lone " +
      "`gh pr edit` limited to --title/--body/--body-file that is genuinely CIRCULAR. Never " +
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
      // Must contest a REAL, recent block — and the MOST RECENT one, when both
      // kinds happened: that is the block the agent is actually stuck on.
      if (!lastBlockedShip && !lastBlockedText) {
        return deny("review-gate: 没有可申诉的拦截。先把命令/编辑真跑一次——申诉只受理已经发生的拦截。");
      }
      if (lastBlockedText && (!lastBlockedShip || lastBlockedText.at >= lastBlockedShip.at)) {
        return arbitrateText(lastBlockedText, String(params.argument ?? ""), ctx);
      }
      if (!lastBlockedShip) {
        return deny("review-gate: no ship block to arbitrate. Run the command first; arbitration only contests an actual block.");
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
        try {
          choice = await ctx.ui.select(
            `review-gate: arbiter is unsure — you decide.\nBlock: ${lastBlockedShip.blockReason.split("\n")[0]}\nArbiter: ${verdict?.reason ?? ""}`,
            ["Gate wins — require correction", "Allow this exact `gh pr edit` once", "Pause gate and wait"],
          );
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
    // SUPERVISION, first thing and unconditionally: report what this session
    // is doing and apply whatever the orchestrator has sent. It runs before
    // every early return below because a child that is paused, bypassed or in
    // explore mode still has a supervisor waiting to hear from it — silence
    // is exactly the failure this replaced (a finished child classified
    // `working` for 725 seconds, R3-5).
    noteChildProgress(); // E — a settled turn is forward progress.
    reportChildState(ctx);
    await drainChildInstructions(ctx);
    // Judge panes conclude through judge_conclude (their own round-ending tool) —
    // there is no settle-time verdict scraping, so nothing to do here.
    // Finished rounds wake in every mode except normal (gate fully off): explore
    // is advisory on enforcement, not deaf — its reports still land and record.
    if (state.taskMode !== "normal" && (await settleFinishedRounds(ctx))) return;
    // Explore and normal never auto-continue — that is their defining
    // difference from loop. This check MUST stay before the loopArmed check:
    // explore/normal-mode edits set loopArmed = true in tool_result, and only
    // this early return keeps the continuation loop off.
    if (state.taskMode === "explore" || state.taskMode === "normal") return;
    // Paused for a user question (ask_user): defense-in-depth —
    // loopArmed is in-memory and resets on restart, but the persisted pause
    // must keep auto-continuation off until the user actually replies.
    if (state.pausedQuestion) return;
    if (!loopArmed) return;
    if (state.bypass.active) return;
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
    if (!loopGoalConfirmed()) {
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
    if (!loopGoalConfirmed()) completion.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
    // Goal-only continuation: the ONLY remaining item is the unapproved loop
    // goal. If the agent already grilled the user and is waiting for the
    // answer, ask_user already paused the loop — the resume text below
    // points at it instead of re-asking.
    const goalOnly =
      problems.length === 0 &&
      completion.length === 1 &&
      completion[0] === LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK;

    if (problems.length === 0 && completion.length === 0) return;
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
    if (problems.length > 0 && continuationsInjected >= state.maxRounds) return;
    if (problems.length === 0 && completionContinuations >= COMPLETION_CONTINUATION_CAP) return;

    // L2 circuit breaker: an unmet gate justifies another turn only while
    // something is still MOVING. When the fingerprint, both verdicts, the round
    // count and the unmet list are all unchanged for STALL_REPEAT_LIMIT
    // evaluations in a row, the blocker is external (provider out of quota,
    // subagent launch failure, unreachable model) and another injection would
    // only burn the budget telling the agent to retry the impossible — the
    // observed 7-injection quota burn. Stop injecting and name the cause.
    // Tighten-only: no verdict is granted, ship commands stay blocked.
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
    const stall = evaluateStall(
      loopStall,
      progressSignature({
        fingerprint: fp.unavailable ? "" : fp.digest,
        reviewVerdict: state.review.verdict,
        precommitVerdict: state.precommit.verdict,
        rounds: state.rounds.length,
        problems: [...problems, ...completion],
      }),
      STALL_REPEAT_LIMIT,
      // A running reviewer is why the signature is unchanged: the verdict it
      // will produce does not exist yet. Cutting the loop off there would
      // orphan the very review the gate is waiting for, so observable work in
      // flight counts as motion — until it is too old to be believable.
      { inMotion: judgeChildInMotion() || forceNegotiate },
    );
    loopStall = stall;
    if (stall.stalled) {
      // Once per stall, not once per turn: the state persists in `loopStall`,
      // and any real progress resets both the count and this flag.
      if (!stallNoticeShown) {
        stallNoticeShown = true;
        try { ctx.ui.notify(buildStallNotice(stall.repeats), "warning"); } catch { /* headless */ }
      }
      updateWidget(ctx);
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
                "why not (check_copilot_review verifies), an unapproved goal gets negotiated with " +
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
    const startBranch = currentBranch(primaryRepoRoot);
    if (startBranch && isProtectedBranch(startBranch) && ctx.hasUI) {
      showToUser(
        ctx as unknown as ExtensionContext,
        "───── 当前在受保护分支 ─────",
        `本会话在 ${startBranch} 上开始。checkpoint 会直接提交到当前分支；` +
        `在受保护分支上提交前门禁会弹框确认。若这不是你的意图，先切换分支。`,
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
    if (ctx.hasUI && state.taskMode === undefined) {
      const requestedBySpawner = requestedModeFromEnv();
      if (isEnforcedMode(requestedBySpawner) && requestedBySpawner !== undefined) {
        if (requestedBySpawner !== "orchestrator" || process.env.TMUX) {
          setTaskMode(requestedBySpawner, "auto", ctx);
        }
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

    // P-multi: a same-session resume re-arms the repo set too (persisted as
    // sessionReposPaths by persist()). Only repos whose sidecar still exists
    // are re-added — a deleted checkout must not block declare_done forever.
    for (const r of state.sessionReposPaths ?? []) {
      if (r !== primaryRepoRoot && existsSync(sidecarPath(r))) sessionRepos.add(r);
    }

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
      const hasDirtyFiles = files && files.length > 0;
      const ahead = state.scopeLimit ? 0 : await commitsAheadOfBase(cwd);
      const hasBranchCommits = ahead > 0;

      if (hasDirtyFiles || hasBranchCommits) {
        if (hasDirtyFiles && files!.some(isCodeFile)) {
          state.hasCodeChange = true;
        } else if (hasBranchCommits) {
          state.hasCodeChange = true;
        }
        if (hasDirtyFiles && files!.some(isDocFile)) {
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
    if (!gateStatePersistSkip(process.env) && !state.exclusivityRefusal) {
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

  pi.on("session_shutdown", () => {
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
    if (files.length === 0 && ((await commitsAheadOfBase(cwd)) === 0 || state.scopeLimit !== undefined)) {
      state.hasCodeChange = false;
      state.hasDocChange = false;
      persist(ctx);
      return;
    }
    let dirty = false;
    if (state.hasCodeChange && files.length > 0 && !files.some(isCodeFile)) {
      state.hasCodeChange = false; dirty = true;
    }
    if (state.hasDocChange && files.length > 0 && !files.some(isDocFile)) {
      state.hasDocChange = false; dirty = true;
    }
    if (dirty) persist(ctx);
  });

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
    state = emptyState(state.sessionId, state.maxRounds);
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
    hasProxyGrant: (scope) => hasGrant(state.orchestrator ?? emptyRuntime("none"), scope),
    grantProxyScope: (scope, via) => {
      if (!state.orchestrator) return;
      persistOrchestration(addGrant(state.orchestrator, { scope, grantedAt: new Date().toISOString(), via }));
    },
    confirmBounded: (uiCtx, title, message) =>
      confirmBounded(uiCtx as Parameters<typeof confirmBounded>[0], title, message),
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

    // New turn: the edit-failure nudge window from the PREVIOUS turn is stale
    // (a same-turn workaround is what we care about). Reset BEFORE the
    // normal-mode early return so the window can never leak across turns in
    // any mode.
    editFailurePending = false;

    // STARTUP HARD CHECK (user requirement 2026-08-30): every role must have
    // a resolvable model chain in the agents config layer — no silent
    // built-in fallback. A missing/corrupt/unresolvable chain STOPS the
    // session with the reason (normal mode is exempt: the user turned the
    // gate off explicitly).
    if (state.taskMode !== "normal") {
      try {
        const { map } = effectiveAgentsConfig(projectConfig.agentsGlobal, projectConfig.agentsProject);
        const checks = validateAgentsForStartup(map, loadRegistry(), KNOWN_AGENTS);
        const bad = Object.entries(checks).filter(([, c]) => c && !c.ok);
        if (bad.length > 0) {
          const details = bad.map(([name, c]) => `- ${name}: ${c?.reason ?? "未知原因"}`).join("\n");
          return {
            systemPrompt:
              systemPrompt +
              `\n\n## REVIEW-GATE: 配置错误，会话无法启动\n` +
              `角色模型配置不完整 —— 以下角色无法获得可派发的模型链：\n${details}\n` +
              `\n请修复 ~/.pi/review-gate.json（或运行安装脚本重建默认配置）后重开会话。` +
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
    if (state.taskMode === "explore") {
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
    if (state.taskMode === "loop") {
      const goal = readSessionLoopGoal(primaryRepoRoot);

      const goalConfirmed = loopGoalConfirmed();
      systemPrompt += "\n\n" + buildLoopGoalDirective(goal, goalConfirmed);
      // 2026-09-17: once the un-goaled turn count hits the threshold, the
      // standing goal directive is escalated to the force-negotiate form on
      // EVERY turn (not only in the RESUME injection) — the agent cannot miss
      // that the ONLY acceptable next action is goal negotiation.
      if (!goalConfirmed && goalNegotiationOverdue(state.turnsWithoutGoal)) {
        systemPrompt += "\n\n" + buildGoalForceNegotiateDirective(state.turnsWithoutGoal);
      }

    }

    // The orchestration layer's two prompts, and they are deliberately
    // asymmetric (task book §5). The ORCHESTRATOR gets the whole contract;
    // a CHILD gets one sentence — telling it about the plan would make it
    // optimize for the plan instead of for its own task.
    if (state.taskMode === "orchestrator") {
      systemPrompt += "\n\n" + ORCHESTRATOR_DIRECTIVE;
      const inherited = formatInheritanceBrief(readInheritance(), currentOrchestrationId());
      if (inherited) systemPrompt += "\n\n" + inherited;
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
      state.taskMode === "loop" ? "\n\n" + MODE_REGISTRY.loop.prompt : "";
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
            "If the user has replied, continue the loop; otherwise end the turn after asking.\n"
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
          : state.taskMode === "loop"
            ? "All gates satisfied — 收尾：跑一次 `declare_done`（门禁合并分支）；若已建 PR，还有 `request_copilot_review` / `check_copilot_review` 周期待收。"
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
