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
 *   2 fail-open parse  → verdict-parse scans ALL fences; BLOCKED wins
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
import { tmpdir, homedir } from "node:os";
import { join as pathJoin, dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  coalesceToolPath,
  CONCURRENT_SESSION_WINDOW_MS,
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
import { buildAgentDirectives, SETTLED_TOOL_REMINDER } from "../lib/agent-directives.ts";
import { defaultProjectConfig, loadProjectConfig, type ProjectConfig } from "../lib/project-config.ts";
import { buildGitMemory } from "../lib/git-memory.ts";
import { detectShipCommands } from "../lib/ship-detect.ts";
import { buildAgentsWidget, buildModelConfigWidget, scanAgentArtifacts } from "../lib/ui-widget.ts";
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
  spawnJudgeProcess,
  judgeSessionIdFor,
  shortRepoHash,
  judgeProcessAlive,
  judgeScratchDir,
  reviewScratchWorktrees,
  type JudgeProcessResult,
} from "../lib/judge-process.ts";
import { createProcessWatchRegistry, rememberChildProcess, forgetChildProcess, waitForProcessExit } from "../lib/judge-watch.ts";
import {
  judgeWorkDirFor,
  decideJudgeDispatch,
  judgeRunDirName,
  hasJudgeFence,
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

import {
  parsePorcelain,
  describeDirty,
  appendBranchOp,
  deriveWorkBranchName,
  decideFinish,
  commitBranchAllowed,
  parseConflictFiles,
  interpretWorktreeChoice,
  isProtectedBranch,
  WORKTREE_CHOICES,
  type DirtyFile,
  type BranchOp,
} from "../lib/workspace-branch.ts";
import {
  decideMergeVenue,
  squashMergeArgv,
  squashMergeMessage,
  parseWorktreeList,
  venueRefusal,
  type MergeVenue,
} from "../lib/worktree-merge.ts";
// ---- the SUPERVISION CHANNEL (both sides). A child reports on it and reads
// its instructions from it; an orchestrator reads it and writes answers. It
// replaced the global attention queue, the screen scraping and send-keys.
import {
  instructText,
  nodeChannelIO,
  type ChannelIO,
  type ChildReportedState,

} from "../lib/orchestrator-channel.ts";
import {
  acknowledgeInstruct,
  askThroughChannel,
  pendingInstructions,
  reportState,
  type ChannelDialogRequest,
  type ChildChannelBinding,
} from "../lib/orchestrator-child-channel.ts";
import { supervisionTarget } from "../lib/orchestration-id.ts";
import type { ToolHost } from "../lib/tool-host.ts";
// ---- orchestration layer (project-manager role). Everything but these few
// wires lives in lib/orchestrator-*.ts, deliberately: this file is the
// repository's own worst example of the architecture rule this round adds.
import { newOrchestrationId, orchestrationIdFromEnv } from "../lib/orchestration-id.ts";
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
  adjudicatePlanAudit,
  buildPlanAuditTask,
  formatPlanAuditCarryover,
  formatPlanAuditRefusal,
  planAuditHash,
  planAuditPassed,
  type PlanAuditRecord,
} from "../lib/orchestrator-plan-audit.ts";

import {
  decideSupervisionEvents,
  superviseChildren,
  type SupervisionMemory,
} from "../lib/orchestrator-supervisor.ts";
import { formatChildHealth } from "../lib/orchestrator-child-state.ts";

import { registerOrchestratorStateTools } from "../lib/orchestrator-tools.ts";
import { registerOrchestratorSessionTools } from "../lib/orchestrator-session-tools.ts";


import { formatInheritanceBrief, readInheritance } from "../lib/orchestrator-relay.ts";
import { emptyRuntime, type OrchestratorRuntime } from "../lib/orchestrator-registry.ts";
import { fileSizeVerdict, formatFileSizeVerdict, isSizeJudgedFile } from "../lib/file-size-gate.ts";
import { buildCheckpointMessage } from "../lib/checkpoint-message.ts";
import { classifyChildren, buildChildWaitNotice, type ChildSnapshot } from "../lib/child-watch.ts";
import {
  readJudgeSessionState,
  readJudgeConclusion,
  readStderrTail,
  lastActivityAt,
} from "../lib/judge-session.ts";
// The judge tools that observe/end a session (judge_read / judge_close /
// judge_wait) are registered from lib/, like the orchestration tools: this
// file keeps only what it alone owns and hands the rest over as deps.
import { registerJudgeSessionTools } from "../lib/judge-session-tools.ts";
import { JUDGE_WAIT_MAX_TIMEOUT_MS } from "../lib/judge-lifecycle.ts";
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
// Seven of them are still IMPLEMENTATIONS, registered into `internalHost`
// instead of into `pi`: the chain calls them so the mechanical checks live in
// exactly one place, and no model can see the names. The other three
// (`review_spawn` / `review_watch` / `review_send`) were deleted outright,
// module included.
import { registerReviewPrepareTools } from "../lib/review-prepare-tools.ts";
import { registerAdvisoryPrepareTools } from "../lib/advisory-prepare-tools.ts";

// The L7 Copilot tools moved the same way: this file wires them, the module
// owns their bodies (and lib/copilot-gh.ts the `gh` calls they make).
import { registerCopilotReviewTools } from "../lib/copilot-review-tools.ts";
// The L8 goal family (the agent-facing `propose_loop_goal` and the internal
// `record_goal_prereview`) moved the same way: this file wires them, the
// module owns their bodies (and lib/goal-prereview-tools.ts the audit record).
import { registerGoalTools } from "../lib/goal-tools.ts";
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
  ORCH_BASE_BRANCH_ENV,

  unmetRequirements,
  type GateState,
} from "../lib/gate-state.ts";
import { parseReviewOutput, parsePrecommitOutput, parseFenceFindings, parseFenceFileFindings } from "../lib/verdict-parse.ts";
import { sessionDirForCwd, sessionDirFromContext } from "../lib/session-dir.ts";
import {
  evaluateModeChange,
  buildModeConfirmMessage,
  normalizeTaskMode,
  scratchFirstMode,
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
import { isPiSelfRoot } from "../lib/pi-self.ts";
import {
  BASH_WRITE_NUDGE,
  EDIT_DISCIPLINE_DIRECTIVE,
  EDIT_FAILURE_NUDGE,
  looksLikeBashFileWrite,
} from "../lib/edit-discipline.ts";
import { projectEditedContent } from "../lib/edit-projection.ts";
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
const EDIT_TOOL_NAMES = new Set(["edit", "write", "Edit", "Write", "NotebookEdit", "notebook_edit"]);

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
  ) {
    const run = toolExecutes.get(name);
    if (!run) throw new Error(`review-gate: internal tool ${name} is not registered`);
    return run(`internal-${name}`, params, undefined, onUpdate, ctx);
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
      const hasChildren = [...childSessions.values()].some((list) => list.length > 0);
      if (!hasChildren) return;
      try {
        pi.sendUserMessage(
          "[REVIEW_GATE_CHILD_WATCHDOG] 门禁托管等待到期，重新检查子会话的 done channel、是否已结束（exit-code 文件出现，或记录的进程已不在）与静默上限；读取已有输出并继续，不要结束 turn。",
          { deliverAs: "followUp" },
        );
      } catch { /* session was replaced or shut down */ }
    }, Math.max(1_000, delayMs));
    // Deliberately keep this timer referenced: it is the main-session liveness
    // anchor while the child may have stopped without signalling.
  }
  let loopArmed = true; // /gate-bypass or NEEDS_HUMAN disarms auto-continuation
  // Per-project knobs (sd0x-dev-flow auto-loop-project.md port). Loaded at
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
  // of record_review / run_precommit. `sessionRepos` collects every repo this
  // session has edited; declare_done requires ALL of them to pass.
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
   * Resolve the repo a `record_review` / `run_precommit` call targets.
   *
   * Before this existed both tools wrote to `activeRepoRoot`, which only an
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
  /** Set when restore() found the sidecar owned by ANOTHER, recently active
   *  session in this same repo, so session_start can warn the user. */
  let concurrentSessionNotice: string | null = null;
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
  // record_review, arbitration, precommit binding, git hooks) calls
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
    if (!orchestrationId || !childId) return undefined;
    return {
      io: channelIO,
      target: { orchestrationId, childId },
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
   * that spawned the judge, so it does not have to infer anything: the child
   * process is in its own registry, and `exitCode === null` is liveness.
   */
  function activeJudgeWait(): { role: string; since: number } | undefined {
    for (const children of childSessions.values()) {
      for (const judge of children) {
        if (judge.child && judge.child.exitCode === null) {
          const since = Date.parse(judge.spawnedAt);
          return { role: judge.role, since: Number.isFinite(since) ? since : Date.now() };
        }
      }
    }
    return undefined;
  }

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
          ctx.abort?.();
          acknowledgeInstruct(binding, instruction.instructId, true, "已调用 ctx.abort()", "injected");
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
        await pi.sendUserMessage(text, { deliverAs: instruction.mode });
        acknowledgeInstruct(
          binding,
          instruction.instructId,
          true,
          `pi.sendUserMessage(deliverAs:${instruction.mode})`,
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
  ): Promise<string | undefined> {
    const binding = childBinding();
    if (!binding) return hasUI ? render(new AbortController().signal) : undefined;
    const outcome = await askThroughChannel(binding, { ...request, hasUI }, render);
    return outcome.answer;
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
    // O-1 — the plan's full text goes into the TRANSCRIPT before the dialog
    // asks about it, exactly like the loop goal. A plan approval binds to
    // content, so a truncated dialog body was asking the user to sign
    // something they could not read.
    showToUser: (title, text) => { showToUser(latestCtx ?? {}, title, text); },

    branchFacts: () => ({
      workBranch: state.workBranch,
      baseBranch: state.baseBranch,
      // "Settled", not "already merged": declare_done merges AFTER these
      // checks, so requiring a completed merge here could never pass.
      mergeSettled: Boolean(state.baseBranch) && !state.mergeConflict,
      mergeWaived: Boolean(state.mergeWaived),
    }),
    // ROUND-4 P1 — THIS BINDING WAS SIMPLY MISSING. `orchestrator_wait`'s
    // fourth block (context usage + when to hand over) is computed from it,
    // and because nothing was passed, all 15+ receipts of the fourth run said
    // "宿主未提供读数": the orchestrator could not tell whether it had room
    // for another task round, on the one axis — running long — that defines
    // unattended work. The reading itself was always available; nobody wired
    // it. `latestCtx` is refreshed on every tool_call, so it is current by
    // the time any orchestration tool runs.
    contextPercent: () => contextPercentOf(latestCtx as unknown as { getContextUsage?: () => unknown }),
    auditPlan: (plan, onUpdate) => runPlanAudit(plan, onUpdate as { step?: (t: string) => void; done?: (t: string) => void } | undefined),

    sessionTranscriptPath: () => {
      try {
        const dir = sessionDirForCwd(cwd);
        return state.sessionId ? `${dir}/${state.sessionId}.jsonl` : undefined;
      } catch { return undefined; }
    },
  });
  registerOrchestratorStateTools(pi, orchestratorDeps);
  registerOrchestratorSessionTools(pi, orchestratorDeps);

  /** Constraints 3, 4, 10 and 11 — the orchestration's own exit contract. */
  function orchestrationDoneProblems(): string[] {
    if (state.taskMode !== "orchestrator") return [];
    const runtime = state.orchestrator ?? emptyRuntime(currentOrchestrationId());
    const branch = orchestratorDeps.branchFacts();
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
      workBranch: branch.workBranch,
      baseBranch: branch.baseBranch,
      mergeSettled: branch.mergeSettled,
      mergeWaived: branch.mergeWaived,
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
   * The orchestrator's own `agent_settled` continuation (R-3).
   *
   * Same shape as the loop's, entirely different criteria: the plan, the
   * children, and the decisions — never a review or a precommit this session
   * will never have.
   */
  function orchestratorSettled(ctx: ExtensionContext): void {
    startSupervisionTimer(ctx);
    const problems = orchestrationDoneProblems();
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


  // The watcher registry (lib/judge-watch.ts) owns the handle map and the
  // shutdown latch: a signal that resolves while session_shutdown is
  // clearing the registry must not re-arm an orphan listener (round-16 Nit).
  // The watcher registry (lib/judge-watch.ts) owns the handle map and the
  // shutdown latch: a child's PROCESS EXIT is the completion event (no tmux
  // wait-for channel, no signal the child could forget to send).
  const watchRegistry = createProcessWatchRegistry(
    (child) => waitForProcessExit(child),
    (label, sessionId) => {
      // The judge finished: the gate reads its verdict and records it BEFORE
      // waking the session, so the agent never has to carry the output from
      // one tool to another (and cannot mis-carry it).
      void recordJudgeConclusion(sessionId).then((recorded) => {
        const content = `[review-gate] 子会话 ${label} 完成（session ${sessionId}）。` +
          (recorded ? `\n${recorded}` : " 用 judge_read({role}) 读它的输出并继续。");
        pi.sendMessage({ customType: "review-gate", content, display: true }, { triggerTurn: true, deliverAs: "steer" });
      });
    },
  );
  /**
   * Judge child sessions spawned by review_spawn: repo root → children.
   * Each entry carries the deterministic session id (the resume key), the
   * live ChildProcess (liveness = its exitCode), and the per-run artifact
   * paths (session transcript dir, stdout/stderr logs, pid/exit-code files
   * for cross-session takeover).
   */
  interface JudgeChild {
    sessionId: string;
    role: string;
    title: string;
    spawnedAt: string;
    /** The live child process; liveness is child.exitCode === null. */
    child?: { exitCode?: number | null; pid?: number };
    /** Directory pi writes its transcript jsonl into (stable per role). */
    sessionDir: string;
    /** Per-run stdout log (this round's raw output). */
    stdoutPath: string;
    /** Per-run stderr log (crash diagnosis). */
    stderrPath: string;
    /** pid record `<pid> <start>` — cross-session takeover (judge-session.ts). */
    pidPath: string;
    /** exit-code file — the authoritative 'session finished' fact. */
    exitCodePath: string;
    /** This round's findings stream, when the role has one (judge_wait reads it). */
    streamPath?: string;
  }
  const childSessions = new Map<string, JudgeChild[]>();
  /**
   * The goal draft a running audit is judging, per repo. The verdict binds to
   * the draft's CONTENT, so the gate has to remember which text it dispatched
   * — the auditor's output alone cannot say what it audited.
   */
  const pendingGoalAudits = new Map<string, { draft: string; startedAt: string }>();
  /**
   * Review targets registered by prepare_review (commit mode): repo root →
   * the reviewed baseline..HEAD plus HEAD's tree. record_review consumes it:
   * a READY binds to the reviewed tree, and a HEAD that moved past the
   * registered head (a new checkpoint after prepare) is STALE ⇒ BLOCKED.
   */
  interface ReviewTarget { baseline: string; head: string; tree: string; }
  const reviewTargets = new Map<string, ReviewTarget>();

  /**
   * Register the completion watcher for one judge session id. One watcher
   * per session id (a re-registration replaces the old handle). When the
   * child's PROCESS EXITS, THIS session is woken via
   * pi.sendMessage(triggerTurn, deliverAs:"steer") — no polling, no sleep:
   * the agent can end its turn and do other work; the wake arrives as a
   * new turn. review_spawn registers this AUTOMATICALLY; review_watch
   * exists to re-register with a custom label.
   */
  function registerWatch(sessionId: string, label: string): void {
    watchRegistry.register(sessionId, label);
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

  /** `git status --porcelain`, parsed. An unreadable repo reports clean. */
  function dirtyFiles(root: string): DirtyFile[] {
    try {
      return parsePorcelain(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }));
    } catch {
      return [];
    }
  }

  /** Append one entry to the branch audit log (bounded, best-effort). */
  function logBranchOp(st: GateState, op: BranchOp): void {
    st.branchOps = appendBranchOp(st.branchOps, op);
  }

  /**
   * Record where this session STARTED: the branch it is on and whatever was
   * already uncommitted. Both are facts the session must not silently absorb
   * — the dirty worktree blocks edits until `setup_workspace` settles it, and
   * the branch is the first entry of the trail declare_done follows back.
   */
  function recordSessionStartWorkspace(): void {
    try {
      const files = dirtyFiles(primaryRepoRoot);
      if (files.length) {
        state.worktreeDirty = {
          files: files.map((f) => `${f.status.trim() || "??"} ${f.path}`).slice(0, 200),
          at: new Date().toISOString(),
        };
      } else {
        delete state.worktreeDirty;
      }
      const branch = currentBranch(primaryRepoRoot);
      if (branch) {
        logBranchOp(state, { op: "checkout", from: null, to: branch, at: new Date().toISOString() });
      }
    } catch { /* never block a session start on bookkeeping */ }
  }

  /** What `finishWorkBranch` reports — including HOW the work landed (R3-5). */
  type FinishResult = { ok: boolean; text: string; merge: "merged" | "waived" | "none" };

  /** `git worktree list --porcelain`; "" when it cannot be read (⇒ no holder). */
  function gitWorktreeList(root: string): string {
    try {
      return execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: root, encoding: "utf8" });
    } catch {
      return "";
    }
  }

  /**
   * Best-effort refresh of `base` from its remote before a work branch is cut
   * off it (D — the fetch + `--ff-only` update the AGENTS.md branch dance used
   * to leave to the agent). setup_workspace expresses the intent ("branch off a
   * current base"); the gate does the git.
   *
   * NEVER fatal, and never anything but a fast-forward: offline is a note, a
   * DIVERGED base is a note (a merge/rebase/force there is the user's call, not
   * the gate's). Returns the notes to fold into the setup_workspace receipt.
   */
  function refreshBaseBeforeBranch(root: string, base: string): string[] {
    const notes: string[] = [];
    let fetched = false;
    try {
      execFileSync("git", ["fetch", "--quiet"], { cwd: root, encoding: "utf8" });
      fetched = true;
    } catch {
      notes.push(`基准分支 ${base} 未能从远端更新（git fetch 失败，可能离线）—— 它可能落后于远端。`);
    }
    // Fast-forward only, and only when actually standing on base (the common
    // case at branch-cut time). No upstream ⇒ nothing to fast-forward to.
    if (fetched && currentBranch(root) === base) {
      let hasUpstream = false;
      try {
        execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: root, encoding: "utf8" });
        hasUpstream = true;
      } catch { /* no tracking branch */ }
      if (hasUpstream) {
        try {
          execFileSync("git", ["merge", "--ff-only", "@{u}"], { cwd: root, encoding: "utf8" });
          notes.push(`基准分支 ${base} 已快进到远端最新。`);
        } catch {
          notes.push(`基准分支 ${base} 与远端已分叉，门禁不会替你 merge/rebase —— 请自行处理后再开工作分支（本次仍按当前 ${base} 建分支）。`);
        }
      }
    }
    return notes;
  }

  /**
   * THE GATE'S SQUASH LANDING, executed in ONE worktree (`cwd`) — the shared
   * core of both merge venues (self and holder).
   *
   * It folds the work branch into base as a SINGLE commit (the checkpoint
   * history stays off the target branch) and commits it with a message the
   * gate DERIVES, never the loop goal's title: that title is Simplified Chinese
   * and L5 refuses a non-English commit, so the subject is composed from the
   * checkpoints' own Conventional-Commit type/scope (always ASCII — see
   * lib/worktree-merge.ts `squashMergeSubject`).
   *
   * REVIEW_GATE_BYPASS=1, like the checkpoint commit above: this is a
   * gate-authored landing of content that already passed a READY review. The
   * fingerprint hook cannot meaningfully judge a commit made on the BASE branch
   * (self venue) or inside a FOREIGN holder worktree whose sidecar is not this
   * review's state (holder venue) — which is exactly why the previous
   * `--no-ff` merge, a merge commit, never ran these commit hooks at all.
   */
  function runSquashLanding(cwd: string, work: string, base: string):
    | { ok: true }
    | { ok: false; conflicted: boolean; files: string[]; cleaned: boolean; error?: string } {
    let subjects: string[] = [];
    try {
      subjects = execFileSync("git", ["log", "--format=%s", `${base}..${work}`], { cwd, encoding: "utf8" })
        .split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    } catch { /* unreadable range → an empty list still yields a legal chore subject */ }
    const { subject, body } = squashMergeMessage(work, base, subjects);
    try {
      execFileSync("git", squashMergeArgv(work), { cwd, encoding: "utf8" });
      execFileSync("git", ["commit", "-m", subject, "-m", body], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, REVIEW_GATE_BYPASS: "1" },
      });
      return { ok: true };
    } catch (err) {
      let files: string[] = [];
      try {
        files = parseConflictFiles(
          execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], { cwd, encoding: "utf8" }),
        );
      } catch { /* the cleanup below still runs */ }
      // A `--squash` merge sets no MERGE_HEAD, so `git merge --abort` cannot
      // undo it; the staged/conflicted state is discarded with `git reset
      // --hard HEAD` instead. Safe because the venue was verified clean first
      // (the self venue just checked out `base`; the holder passed venueRefusal).
      let cleaned = true;
      try { execFileSync("git", ["merge", "--abort"], { cwd, encoding: "utf8" }); } catch { /* squash: nothing to abort */ }
      try { execFileSync("git", ["reset", "--hard", "HEAD"], { cwd, encoding: "utf8" }); } catch { cleaned = false; }
      return {
        ok: false,
        conflicted: files.length > 0,
        files,
        cleaned,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * R3-7 — land the work by merging INSIDE the worktree that holds the base.
   *
   * This is the only path that works for a parallel orchestration lane: its
   * base branch is checked out in the supervisor's worktree, so switching to
   * it here is impossible by git's own rules. Nothing is checked out and no
   * HEAD is moved — the merge is executed in that directory, on the branch it
   * is already standing on.
   *
   * The safety rule the user set (2026-08-30): touch that worktree ONLY when
   * it is clean and actually standing on the base. Anything else refuses and
   * says why, because a merge run over somebody's uncommitted work can lose
   * it, and no receipt is worth that.
   */
  function mergeInHoldingWorktree(
    ctx: ExtensionContext,
    venue: Extract<MergeVenue, { kind: "worktree" }>,
    work: string,
    base: string,
  ): FinishResult {
    const st = state;
    const refusal = venueRefusal(venue, {
      base,
      ...(currentBranch(venue.path) ? { currentBranch: currentBranch(venue.path)! } : {}),
      dirtyFiles: dirtyFiles(venue.path).map((f) => `${f.status.trim() || "??"} ${f.path}`),
    });
    if (refusal) {
      return { ok: false, merge: "none", text: `review-gate: declare_done 被拒 — ${refusal}` };
    }
    const landed = runSquashLanding(venue.path, work, base);
    if (landed.ok) {
      delete st.mergeConflict;
      logBranchOp(st, { op: "merge", work, base, at: new Date().toISOString(), venue: venue.path });
      persist(ctx);
      return { ok: true, merge: "merged", text: `squash-merged ${work} into ${base} —— ${venue.reason}` };
    }
    // The holder worktree is left exactly as it was found — the squash cleanup
    // (`reset --hard HEAD`, since a `--squash` sets no MERGE_HEAD to abort) is
    // reported rather than assumed (round-1 Nit): this is the module whose
    // whole point is that a receipt never overstates.
    const restored = landed.cleaned
      ? "，已回退，那个工作区回到原样"
      : "，**但回退没有成功** —— 请自己去 " + `${venue.path} 看一眼它现在的状态`;
    if (landed.conflicted) st.mergeConflict = { branch: work, base, files: landed.files, at: new Date().toISOString() };
    persist(ctx);
    return {
      ok: false,
      merge: "none",
      text: landed.conflicted
        ? `review-gate: declare_done 被拒 — ${work} squash 合并回 ${base} 有冲突（合并在持有基准分支的 worktree ` +
          `${venue.path} 里执行${restored}）。\n` +
          `冲突文件：\n${landed.files.map((f) => `  ${f}`).join("\n")}\n` +
          `处理方式：把 ${base} 合进 ${work} 解决冲突后重新 declare_done；` +
          "或 declare_done({ waiveMerge: \"<理由>\" }) 让用户确认本次不合并。"
        : `review-gate: declare_done 被拒 — 在 worktree ${venue.path} 里 squash 合并 ${work} → ${base} 失败` +
          `（不是冲突：没有未解决路径）${restored}。` +
          `\n${(landed.error ?? "").split("\n")[0]}` +
          "\n先手动确认两条分支的状态，再重试。",
    };
  }

  /**
   * Land this session's work on the branch the user confirmed — the last
   * procedural job of a task, and the gate's, not the agent's.
   *
   * It reads its own record (workBranch/baseBranch, both set by
   * setup_workspace) rather than inferring anything from the current
   * checkout. Three outcomes, all honest: nothing to merge, merged, or
   * CONFLICT — and a conflict aborts the merge, records the files and
   * refuses. Resolving it is creative work (the agent's), waiving it is a
   * decision (the user's); guessing is neither.
   */
  function finishWorkBranch(ctx: ExtensionContext): FinishResult {
    const st = state;
    if (st.mergeWaived) {
      return { ok: true, text: `merge waived by the user (${st.mergeWaived.reason})`, merge: "waived" };
    }
    const action = decideFinish({
      workBranch: st.workBranch,
      baseBranch: st.baseBranch,
      workIsAncestorOfBase: isAncestor(primaryRepoRoot, st.workBranch, st.baseBranch),
    });
    if (action === "no-branching") return { ok: true, text: "no work branch to merge", merge: "none" };
    if (action === "already-merged") {
      return { ok: true, text: `${st.workBranch} is already in ${st.baseBranch}`, merge: "none" };
    }
    const work = st.workBranch as string;
    const base = st.baseBranch as string;
    // R3-7 — WHERE can this merge even run? In a linked worktree the base
    // branch is, by construction, checked out somewhere else, and `git
    // checkout <base>` there fails 100% of the time. Decide the venue first.
    const venue = decideMergeVenue({
      base,
      work,
      selfPath: primaryRepoRoot,
      worktrees: parseWorktreeList(gitWorktreeList(primaryRepoRoot)),
    });
    if (venue.kind === "worktree") return mergeInHoldingWorktree(ctx, venue, work, base);
    try {
      execFileSync("git", ["checkout", base], { cwd: primaryRepoRoot, encoding: "utf8" });
      logBranchOp(st, { op: "checkout", from: work, to: base, at: new Date().toISOString() });
    } catch (err) {
      return {
        ok: false,
        merge: "none" as const,
        text: `review-gate: declare_done 被拒 — 切到基准分支 ${base} 失败：` +
          `${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`,
      };
    }
    const landed = runSquashLanding(primaryRepoRoot, work, base);
    if (landed.ok) {
      delete st.mergeConflict;
      // WHERE THE WORKTREE IS LEFT STANDING, and it depends on whose worktree
      // it is (R-26).
      //
      // An ordinary session goes back to its work branch: standing on the base
      // would make its NEXT checkpoint illegal (a commit may only land on the
      // work branch), for no reason the agent could see.
      //
      // An ORCHESTRATION CHILD borrowed this worktree from its supervisor, and
      // it is finished with it. Measured on 2026-08-30: the child merged, went
      // back to its own intermediate branch, and left the SUPERVISOR's
      // worktree standing there — so the project manager's view of its own
      // repository was two commits stale (`wc -l` on a file that had already
      // been split, a new module reported as "does not exist"), and the next
      // serial child spawned from it would have branched off the wrong
      // baseline. Handing the worktree back on the BASE branch is what makes
      // "borrowed" honest.
      const handBackToBase = isOrchestrationChild();
      try {
        if (!handBackToBase) {
          execFileSync("git", ["checkout", work], { cwd: primaryRepoRoot, encoding: "utf8" });
          logBranchOp(st, { op: "checkout", from: base, to: work, at: new Date().toISOString() });
        }
      } catch { /* the merge landed; where we stand is diagnostics */ }

      logBranchOp(st, { op: "merge", work, base, at: new Date().toISOString() });
      persist(ctx);
      return { ok: true, text: `squash-merged ${work} into ${base}`, merge: "merged" };
    }
    // The squash failed. runSquashLanding already discarded its staged/
    // conflicted state (`reset --hard HEAD`, since a `--squash` sets no
    // MERGE_HEAD to abort); restore the session's own checkout on the work
    // branch so a later checkpoint is legal again.
    try {
      execFileSync("git", ["checkout", work], { cwd: primaryRepoRoot, encoding: "utf8" });
      logBranchOp(st, { op: "checkout", from: base, to: work, at: new Date().toISOString() });
    } catch { /* best-effort: the branch may already be checked out */ }
    if (landed.conflicted) {
      st.mergeConflict = { branch: work, base, files: landed.files, at: new Date().toISOString() };
    }
    persist(ctx);
    return {
      ok: false,
      merge: "none" as const,
      text: landed.conflicted
        ? `review-gate: declare_done 被拒 — ${work} squash 合并回 ${base} 有冲突，已回退（工作区回到 ${work}，无残留）。\n` +
          `冲突文件：\n${landed.files.map((f) => `  ${f}`).join("\n")}\n` +
          `处理方式：把 ${base} 合进 ${work} 解决冲突后重新 declare_done；` +
          "或 declare_done({ waiveMerge: \"<理由>\" }) 让用户确认本次不合并。"
        : `review-gate: declare_done 被拒 — squash 合并 ${work} → ${base} 失败（不是冲突：没有未解决路径），已回退并回到 ${work}。` +
          `\n${(landed.error ?? "").split("\n")[0]}` +
          "\n先手动确认两条分支的状态，再重试。",
    };
  }

  /** Is `maybeAncestor` already contained in `branch`? */
  function isAncestor(root: string, maybeAncestor: string | undefined, branch: string | undefined): boolean {
    if (!maybeAncestor || !branch) return false;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", maybeAncestor, branch], { cwd: root, encoding: "utf8" });
      return true;
    } catch {
      return false; // not an ancestor, or one of the refs does not exist
    }
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

  // `ctx` is optional because it is used for ONE thing — refreshing the status
  // widget. A caller that has no context (the orchestration tools persist from
  // a callback) must still be able to write the record: dropping the write
  // instead would lose the user's plan approval on a restart.
  function persist(ctx?: ExtensionContext) {
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

    // Note a RECENT other session in this repo (independent of which source
    // won above: the session entry may have restored our own state while the
    // shared sidecar belongs to someone else). The sidecar holds one session
    // at a time and only it is visible to the git hooks, so two live sessions
    // here can surprise each other; saying so beats leaving the user to infer
    // it from a rejected commit.
    //
    // There is no liveness signal available (a pid would be wrong the moment
    // the extension runs anywhere but this machine), so the recency window
    // cannot distinguish "still running" from "finished an hour ago" — hence
    // the conditional wording. A warning that asserts more than it knows is
    // how users learn to ignore this gate's warnings.
    try {
      const onDisk = loadSidecar(sidecarPath(cwd));
      const otherId = onDisk?.sessionId;
      const at = onDisk?.updatedAt ? Date.parse(onDisk.updatedAt) : NaN;
      const recent = Number.isFinite(at) && Date.now() - at < CONCURRENT_SESSION_WINDOW_MS;
      if (otherId && sessionId && otherId !== sessionId && recent) {
        concurrentSessionNotice =
          `review-gate: another Pi session (${otherId}) last wrote this repo's gate state at ${onDisk?.updatedAt}. ` +
          "If it is still open, note that two sessions in one worktree share a single sidecar — the only " +
          "thing the git hooks can see — and a single set of uncommitted changes: a READY/PASS that still " +
          "matches the worktree survives the next session's write, but only until that session writes " +
          "again, and each session's edits re-arm the other's gate. Prefer one session per worktree " +
          "(git worktree add for parallel work). If that session is closed, ignore this.";
      }
    } catch { /* best effort — a missing/unreadable sidecar means nothing to warn about */ }
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
   * Current adviser/reviewer model configuration for the belowEditor widget:
   * the effective spec (the DEPLOYED frontmatter model when a rendered file
   * exists, else slots[0] when auto is OFF, else "?"), the auto switch state
   * and the deciding config layer. Display-only — it never throws and never
   * influences a verdict.
   */
  function modelConfigWidgetLines(): string[] {
    try {
      const { map } = effectiveAgentsConfig(projectConfig.agentsGlobal, projectConfig.agentsProject);
      const deployed = (name: string): string | undefined => {
        // Project layer wins by IDENTITY (frontmatter `name`), not basename:
        // pi-subagents registers any .md under <repo>/.pi/agents under its
        // frontmatter name, so custom.md carrying `name: reviewer` really
        // shadows the global reviewer (round-11 P1/P2).
        const projectDir = pathJoin(primaryRepoRoot, ".pi", "agents");
        const projText = findProjectAgentText(projectDir, name);
        const text = projText ?? (() => {
          try {
            const p = pathJoin(homedir(), ".pi", "agent", "agents", `${name}.md`);
            return existsSync(p) ? readFileSync(p, "utf8") : undefined;
          } catch { return undefined; }
        })();
        if (text === undefined) return undefined;
        // Match `model:` only INSIDE the frontmatter block, never a body line
        // that happens to start with "model:". Same delimiter authority as the
        // identity lookup above (lib/model-config.ts), so a file found by
        // identity always has its deployed model read too.
        const fm = frontmatterBlock(text);
        const m = fm !== undefined ? /^model:\s*(.+)$/m.exec(fm) : undefined;
        return m ? m[1]!.trim() : undefined;
      };
      const entries = ["reviewer", "adviser"].map((name) => {
        const s = map[name] ?? { auto: true, slots: [], source: "default" as const };
        // Show what is actually DEPLOYED (the rendered frontmatter) when there
        // is one — a validation-refused or never-rendered chain must not be
        // displayed as if in force. Fall back to the intended slots[0]/?
        // only when no deployed file exists.
        const spec = deployed(name) ?? (s.auto === false && s.slots.length > 0 ? s.slots[0]! : "?");
        return { name, spec, auto: s.auto, source: s.source };
      });
      return buildModelConfigWidget(entries);
    } catch {
      return []; // display-only — never break the TUI
    }
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
    // belowEditor — agent model config, then sub-agent runs (running first).
    try {
      const agents = scanAgentArtifacts(pathJoin(cwd, ".pi-subagents", "artifacts"), Date.now(), { maxAgeSec: 2 * 3600 });
      const modelLines = modelConfigWidgetLines();
      const lines = [...modelLines, ...(modelLines.length > 0 ? [""] : []), ...buildAgentsWidget(agents)];
      const key = lines.join("\n");
      if (key !== lastAgentsWidget) {
        lastAgentsWidget = key;
        ctx.ui.setWidget("review-gate-agents", lines, { placement: "belowEditor" });
      }
    } catch { /* display-only */ }
  }

  /**
   * Is a subagent demonstrably still working? Read from the same artifact scan
   * the TUI widget uses, so the breaker and the display can never disagree.
   *
   * Only FRESH runs count (`STALL_MOTION_MAX_AGE_SEC`): a run that has been
   * "running" for hours is the hung case the breaker exists for, not motion.
   * Any failure to scan yields false — the breaker keeps its normal behavior
   * rather than being silently disabled by an unreadable directory.
   */

  function subagentInMotion(): boolean {
    try {
      // `maxAgeSec` only prunes FINISHED runs from the scan (lib/ui-widget.ts:
      // a running run is always kept). The age bound that matters here is the
      // explicit predicate below — the option merely keeps the scan cheap.
      const agents = scanAgentArtifacts(pathJoin(cwd, ".pi-subagents", "artifacts"), Date.now(), {
        maxAgeSec: STALL_MOTION_MAX_AGE_SEC,
      });
      return agents.some((a) => a.state === "running" && a.ageSec <= STALL_MOTION_MAX_AGE_SEC);
    } catch {
      return false;
    }
  }

  /**
   * Is a judge child process (reviewer / adviser / goal-auditor) still in
   * flight? The stall breaker must not cut the loop off while a judge is
   * working — its verdict is exactly what the unchanged signature is waiting
   * for (round-16 P2: only subagentInMotion was consulted, so a waiting
   * main session tripped the breaker with 'check provider status' while the
   * reviewer was mid-round).
   *
   * Freshness bound like subagentInMotion's: a child that has been alive
   * since before STALL_MOTION_MAX_AGE_SEC is the HUNG case the breaker
   * exists for, not motion (goal-auditor P2: alive-forever must not
   * disable the breaker).
   */
  function judgeChildInMotion(): boolean {
    const cutoff = Date.now() - STALL_MOTION_MAX_AGE_SEC * 1000;
    const fresh = [...childSessions.values()]
      .flat()
      .filter((c) => {
        const at = Date.parse(c.spawnedAt);
        return Number.isFinite(at) && at >= cutoff;
      });
    return fresh.some((c) => judgeProcessAlive(c.child));
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
    isEditTool: (toolName) => EDIT_TOOL_NAMES.has(toolName),
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
    // explore never gates on the goal (loopGoalEditGate would return true
    // anyway) — skip the lookup before paying for it.
    if (state.taskMode === "explore") return undefined;
    // The session started on top of changes it did not make. Until the user
    // has said what those are (baseline / handled / discarded), an edit would
    // silently mix them into what this session ships — so it is refused at
    // the same layer as the unapproved goal.
    if (state.worktreeDirty && !state.worktreeDirty.settled) {
      return {
        block: true,
        reason:
          "review-gate: 会话开始时工作区有未提交改动，尚未与用户确认处置——先调 setup_workspace。" +
          `\n${state.worktreeDirty.files.slice(0, 12).map((f) => `  ${f}`).join("\n")}` +
          (state.worktreeDirty.files.length > 12 ? `\n  …还有 ${state.worktreeDirty.files.length - 12} 个` : "") +
          "\nsetup_workspace 会让用户四选一（接受为基线 / 已自行处理重检 / 门禁代执行丢弃 / 放行这些改动豁免进审查），随后建立工作分支。",
      };
    }
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
      // next record_review / run_precommit) and joins the declare_done set.
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
          if (s.review.verdict === "READY") s.review.verdict = "PENDING";
          if (s.precommit.verdict === "PASS") s.precommit.verdict = "NOT_RUN";
          // A NEW EDIT UN-FINISHES THE TASK (round-2 hardening). The
          // completion record is what a supervising orchestrator reads to
          // decide a child is `done`; a session that starts editing again is
          // working, whoever asked it to — including a human typing straight
          // into the pane, which no orchestration tool can observe.
          if (s.completion) delete s.completion;
          loopArmed = true;
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
      // otherwise a single cross-repo edit would leave record_review /
      // run_precommit pointed at the other repo forever (multi-repo deadlock).
      // (An edit OUTSIDE any git repo — editRepo null, e.g. a /tmp scratch
      // file — must NOT retarget the active repo; that would silently point
      // the next record_review at the primary and waste a round.)
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
        if (state.review.verdict === "READY") state.review.verdict = "PENDING";
        if (state.precommit.verdict === "PASS") state.precommit.verdict = "NOT_RUN";
        // Same as the cross-repo branch above: editing again means this task
        // is not finished any more, so the completion an orchestrator reads
        // must go with it.
        if (state.completion) delete state.completion;
        loopArmed = true;
        // The agent resumed working on its own — a standing question pause
        // (ask_user) is moot; clear it so the loop enforces again.
        if (state.pausedQuestion) delete state.pausedQuestion;
        dirty = true;
        clearBypassToken(); // any edit invalidates a standing arbiter bypass
      }
      if (dirty) persist(ctx);
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
            if (st.review.verdict === "READY") st.review.verdict = "PENDING";
            if (st.precommit.verdict === "PASS") st.precommit.verdict = "NOT_RUN";
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
            loopArmed = true;
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
      // A checkpoint IS a commit, so it obeys the same branch rule — and
      // FAIL-CLOSED, like every other commit: no work branch on record means
      // no commit, or a session with no branch of its own would quietly
      // checkpoint onto whatever it started on (main included). The branch is
      // compared against the TARGET repo's own record, not the primary's.
      const checkpointState = root === primaryRepoRoot ? state : stateForRepo(root);
      const where = commitBranchAllowed({ workBranch: checkpointState.workBranch, currentBranch: currentBranch(root) });
      if (!where.allowed) {
        return {
          content: [{ type: "text", text: `review-gate: review_checkpoint rejected — ${where.reason}` }],
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

        // Which branch did this checkpoint land on? declare_done reads the
        // log to merge the right branch back into the right base.
        logBranchOp(st, {
          op: "checkpoint_commit",
          sha,
          branch: currentBranch(root) ?? "(detached)",
          at: new Date().toISOString(),
          message: message.split("\n")[0].slice(0, 120),
        });
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
   * wait for the process, then `record_goal_prereview` — and the agent had to
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
  }): Promise<{ ok: true } | { ok: false; text: string }> {
    const { root, goalText, ctx } = input;
    input.progress?.step("组装 goal 审计任务");
    const prepared = await callTool("prepare_goal_audit", { goal: goalText, repo: root }, ctx);
    if (prepared.isError) {
      input.progress?.fail("被拒");
      return { ok: false, text: "review-gate: goal 审计任务无法生成。\n" + toolText(prepared) };
    }
    const streamPath = pathJoin(root, ".pi", "review-stream", `goal-${goalTextHash(goalText).slice(0, 12)}.jsonl`);
    try { mkdirSync(pathJoin(streamPath, ".."), { recursive: true }); } catch { /* the stream is optional */ }
    const task = `${extractTaskText(toolText(prepared))}\n\n${buildStreamDirective(streamPath)}`;
    input.progress?.done("已生成");

    input.progress?.step("goal-auditor 审计中（这一步是分钟级的）");
    const startedAt = new Date().toISOString();
    const dispatch = dispatchJudgeRound({
      root,
      role: "goal-auditor",
      title: `goal-auditor-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`,
      task,
      // A previous audit still running is judging a DIFFERENT draft (this one
      // has no PASS yet), so it cannot answer the question being asked here.
      fresh: true,
      streamPath,
    });
    if (!dispatch.ok) {
      input.progress?.fail("spawn 失败");
      return { ok: false, text: `review-gate: goal 审计没能启动 — ${dispatch.error ?? "judge 进程未能启动"}` };
    }
    // The draft is on record only AFTER the dispatch is accepted: a verdict
    // must never be recorded against text no auditor ever read.
    pendingGoalAudits.set(root, { draft: goalText, startedAt });
    const child = judgeChildByRole(root, "goal-auditor");
    if (!child) {
      input.progress?.fail("registry 里找不到刚起的 judge");
      return { ok: false, text: "review-gate: goal 审计已启动，但登记表里找不到它 —— 这是门禁自身的缺陷，请重试。" };
    }
    // Wait through the SAME implementation `judge_wait` uses (three criteria:
    // the process exited, its exit-code file landed, or a verdict fence is
    // already in this round's stdout). Re-using it means the audit cannot
    // hang on a criterion the tool would have accepted.
    await callTool("judge_wait", { role: "goal-auditor", repo: root, timeoutMs: JUDGE_WAIT_MAX_TIMEOUT_MS }, ctx);
    // Recording is idempotent: the exit watcher may have got there first, and
    // the pending-draft entry it consumes makes the second call a no-op.
    const note = await recordJudgeConclusion(child.sessionId);
    // O-6 — WHOEVER DISPATCHED IT CLOSES IT. This goal-auditor is the gate's
    // OWN internal implementation of `propose_loop_goal`; the agent never asked
    // for it and never sees it in any receipt. Leaving it registered made
    // `declare_done` block on "a judge child is still open" that the caller was
    // never told about (the round-5 P1, in the orchestration twin). Its verdict
    // is already recorded above, so close it now — the transcript stays on disk
    // and a re-audit resumes the same session by id.
    await callTool("judge_close", { role: "goal-auditor", repo: root }, ctx);

    input.progress?.done("审计完成");

    const goalSt = root === primaryRepoRoot ? state : stateForRepo(root);
    if (goalPrereviewPassed(goalSt.goalPrereview, goalText)) return { ok: true };
    return {
      ok: false,
      text:
        "review-gate: goal 审计**没过**，用户那一关连问都没问 —— 先按下面的 findings 改草稿，" +
        "改完直接再调一次 `propose_loop_goal`（门禁会重新审计；裁决绑定文本，改一个字就要重审）。\n\n" +
        (note ?? `审计记录：${goalSt.goalPrereview?.verdict ?? "NONE"}`) +
        `\n\nfindings 流：${streamPath}`,
    };
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
  ): Promise<{ ok: true } | { ok: false; text: string }> {
    // FAIL-CLOSED AROUND THE WHOLE CHAIN. Anything unexpected in here — a
    // judge that could not be spawned, an IO error reading its output — must
    // become "the plan was not audited", never an exception that escapes into
    // the tool and leaves the orchestrator unable to tell whether a dialog is
    // about to appear.
    try {
      return await auditPlanRound(plan, onUpdate);
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

    onUpdate?.step?.("派发 plan 审计（goal-auditor 独立进程）");
    const dispatch = dispatchJudgeRound({
      root,
      role: "goal-auditor",
      title: `plan-auditor-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`,
      task,
      // A previous audit still running is judging a DIFFERENT plan (this one
      // has no PASS yet), so it cannot answer the question being asked here.
      fresh: true,
    });
    if (!dispatch.ok) {
      return {
        ok: false,
        text: `review-gate: plan 审计没能启动 —— ${dispatch.error ?? "judge 进程未能启动"}。plan 没有被送到用户面前。`,
      };
    }
    const child = judgeChildByRole(root, "goal-auditor");
    if (!child) {
      return {
        ok: false,
        text: "review-gate: plan 审计已启动，但登记表里找不到它 —— 这是门禁自身的缺陷，请重试。",
      };
    }
    // The SAME wait implementation `judge_wait` uses (process exit, exit-code
    // file, or a verdict fence already in this round's stdout).
    onUpdate?.step?.("审计运行中（最长 10 分钟，完成即返回）");
    await callTool("judge_wait", { role: "goal-auditor", repo: root, timeoutMs: JUDGE_WAIT_MAX_TIMEOUT_MS }, latestCtx);
    onUpdate?.done?.("审计进程结束");
    // O-6 — the gate dispatched this plan auditor internally, so the gate
    // closes it (the round-5 P1). The orchestrator never asked for a judge
    // child and never saw one in an `orchestrator_wait` receipt; leaving it
    // registered made `declare_done` refuse to finish on a child the caller was
    // never told about. The verdict is recorded from `child.stdoutPath` below
    // (the close keeps the record object and its paths; only the process and
    // the registry entry go away), so read the round's output first, THEN drop
    // it. Placed before every return path so no branch can leak the child.
    const closeAuditor = () => callTool("judge_close", { role: "goal-auditor", repo: root }, latestCtx);

    // THIS round's output only — the transcript accumulates every round of the
    // role's session, so its last fence could belong to a goal audit that ran
    // before this one.
    const output = readRoundStdout(child.stdoutPath);
    const parsed = output ? parseReviewOutput(output) : undefined;
    await closeAuditor();
    if (!parsed) {
      const why = readStderrTail(child.stderrPath)?.trim().split("\n").slice(-3).join(" ") ?? "";
      return {
        ok: false,
        text:
          "review-gate: plan 审计没有产出可解析的裁决，什么都没有记录（fail-closed）——" +
          "plan **没有**被送到用户面前。\n" +
          (why ? `审计进程最后的错误输出：${why.slice(0, 200)}\n` : "") +
          "直接再 `submit` 一次即可重跑审计。",
      };
    }
    const findings = parseFenceFindings(output!);
    const adjudication = adjudicatePlanAudit(parsed.verdict, findings);
    const record: PlanAuditRecord = {
      hash,
      verdict: adjudication.verdict,
      at: new Date().toISOString(),
      findingsTotal: parsed.findingsTotal,
      ...(findings.length ? { findings } : {}),
      planText: formatPlanSummary(plan),
    };
    state.planAudit = record;
    persist(latestCtx);

    // The PASS must bind to the plan that was actually judged — the same
    // content binding the user's approval uses, so a plan edited between the
    // audit and the dialog cannot ride in on someone else's PASS.
    if (planAuditPassed(record, plan)) return { ok: true };
    return { ok: false, text: formatPlanAuditRefusal(record) };
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
    /** Refused because the role is still working on its previous round. */
    busy?: boolean;
    sessionId?: string;
    sessionDir?: string;
    runDir?: string;
    stdoutPath?: string;
    sysPromptPath?: string;
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
   * both come from `role + repoHash`. The title is a display label, and only
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
    const title = opts.title.replace(/[^A-Za-z0-9._-]/g, "-") || role;
    // Children whose PROCESS has ended are dropped first: a finished judge
    // must never answer a reuse hit (its context lives in the transcript,
    // which the next spawn re-opens by session id anyway).
    for (const [repoRoot, list] of childSessions) {
      const alive = list.filter((c) => judgeProcessAlive(c.child));
      if (alive.length !== list.length) {
        // D — a dead judge's scratch review worktrees are reclaimed as it is
        // dropped from the registry.
        for (const dead of list.filter((c) => !judgeProcessAlive(c.child))) reapReviewScratch(dead.sessionId);
        childSessions.set(repoRoot, alive);
      }
    }
    const sessionId = judgeSessionIdFor(role, shortRepoHash(root));
    // STABLE per role+repo (B5) — identity, not a per-round path. Each round's
    // own artifacts live under `runs/<ts>-<rand>/`.
    const workDir = pathJoin(root, judgeWorkDirFor(role, shortRepoHash(root)));
    const sessionDir = pathJoin(workDir, "sessions");
    const running = (childSessions.get(root) ?? [])
      .find((c) => c.role === role && c.sessionId === sessionId && judgeProcessAlive(c.child));
    // The decision itself is a pure function (lib/judge-lifecycle.ts): a round
    // is DELIVERED or REFUSED, never silently dropped.
    const decision = decideJudgeDispatch({
      aliveSameRole: running !== undefined,
      fresh: opts.fresh === true,
      hasTranscript: hasTranscript(sessionDir),
    });
    if (decision.action === "refuse-busy") {
      return {
        ok: false,
        reused: decision.continuesSession,
        sessionId: running?.sessionId ?? sessionId,
        sessionDir: running?.sessionDir ?? sessionDir,
        stdoutPath: running?.stdoutPath,
        busy: true,
        error: `${role} 仍在处理上一轮任务，本轮未提交。等它结束（完成会唤醒本会话，或用 judge_wait 阻塞等待）后重新提交；确实要丢弃它就传 fresh:true。`,
      };
    }
    if (decision.action === "kill-and-spawn") {
      const stale = (childSessions.get(root) ?? []).find((c) => c.role === role);
      if (stale) {
        watchRegistry.unregister(stale.sessionId);
        forgetChildProcess(stale.sessionId);
        try { (stale.child as { kill?: (s?: string) => boolean } | undefined)?.kill?.("SIGTERM"); } catch { /* already gone */ }
        childSessions.set(root, (childSessions.get(root) ?? []).filter((c) => c.sessionId !== stale.sessionId));
        // The killed round's audited draft dies with it: leaving it behind
        // would let a LATER exit record a verdict against a draft that round
        // never judged.
        if (stale.role === "goal-auditor") pendingGoalAudits.delete(root);
      }
    }
    try {
      const { map: agents } = effectiveAgentsConfig(projectConfig.agentsGlobal, projectConfig.agentsProject);
      const files = writeJudgeSpawnFiles({
        repoRoot: root,
        role,
        agents,
        title,
        workDir,
        parentSessionId: state.sessionId ?? undefined,
      });
      if (!files.model) {
        // NO BUILT-IN DEFAULT (user requirement 2026-08-30): a role with no
        // resolvable chain cannot be dispatched. Fail closed with the reason
        // (the startup hard check surfaces it too, but a runtime config
        // change after start must not silently spawn a default model).
        return {
          ok: false,
          reused: decision.continuesSession,
          error: `角色 ${role} 没有可派发的模型链（agents 配置缺失或不可解析）——请修复 ~/.pi/review-gate.json 后重试`,
        };
      }
      // "Reused" is a fact about the SESSION, not about the process: the
      // transcript decided it above, before this round could add to it.
      const continuesSession = decision.continuesSession;
      const runDir = pathJoin(workDir, "runs", judgeRunDirName(new Date(), randomBytes(3).toString("hex")));
      const stdoutPath = pathJoin(runDir, "stdout.log");
      const stderrPath = pathJoin(runDir, "stderr.log");
      const pidPath = pathJoin(runDir, "pid");
      const exitCodePath = pathJoin(runDir, "exit-code");
      mkdirSync(runDir, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
      const spawned = spawnJudgeProcess({
        role,
        repoRoot: root,
        sessionId,
        sysPromptPath: files.sysPromptPath,
        model: files.model,
        sessionDir,
        taskText: task,
        parentSessionId: state.sessionId ?? undefined,
        title,
      });
      if (!spawned.ok || !spawned.child) {
        return { ok: false, reused: false, error: spawned.error ?? "no child" };
      }
      const child: JudgeChild = {
        sessionId,
        role,
        title,
        spawnedAt: new Date().toISOString(),
        child: spawned.child,
        sessionDir,
        stdoutPath,
        stderrPath,
        pidPath,
        exitCodePath,
        streamPath: opts.streamPath,
      };
      // Tee stdout/stderr to this round's logs: stdout is where the verdict
      // fence is readable as PLAIN text (the transcript escapes it), stderr is
      // the crash record.
      try {
        const outFd = openSync(stdoutPath, "a");
        const errFd = openSync(stderrPath, "a");
        (spawned.child.stdout as NodeJS.ReadableStream | null)?.on("data", (d: Buffer) => writeSync(outFd, d));
        (spawned.child.stderr as NodeJS.ReadableStream | null)?.on("data", (d: Buffer) => writeSync(errFd, d));
        spawned.child.on("close", () => { try { closeSync(outFd); closeSync(errFd); } catch { /* best-effort */ } });
      } catch { /* logs are best-effort */ }
      try {
        if (spawned.child.pid) writeFileSync(pidPath, `${spawned.child.pid} ${new Date().toString()}\n`, "utf8");
        spawned.child.on("exit", (code) => {
          try { writeFileSync(exitCodePath, String(code ?? -1), "utf8"); } catch { /* best-effort */ }
        });
      } catch { /* best-effort */ }
      const list = childSessions.get(root) ?? [];
      list.push(child);
      childSessions.set(root, list);
      // Completion listener: the child's process EXIT wakes this session as a
      // new turn. Nobody polls, nobody sleeps.
      rememberChildProcess(sessionId, spawned.child);
      registerWatch(sessionId, title);
      return {
        ok: true,
        reused: continuesSession,
        sessionId,
        sessionDir,
        runDir,
        stdoutPath,
        sysPromptPath: files.sysPromptPath,
      };
    } catch (err) {
      return { ok: false, reused: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Read a finished judge's conclusion and RECORD it — the gate's job, not
   * the agent's.
   *
   * The agent used to copy the reviewer's output into record_review by hand:
   * a transcription step with nothing creative in it, which could silently
   * carry the wrong round's text. The recording tools keep every mechanical
   * check they had (fence parsing, no-prepare refusal, STALE detection, cwd
   * match, tree binding) — this only removes the copying.
   *
   * Returns the recorded summary, or undefined when there was nothing to
   * record (no fence yet, an adviser, an unknown child) — the caller then
   * simply tells the agent to read the child.
   */
  /** This round's raw output, or undefined when the log is unreadable. */
  function readRoundStdout(path: string): string | undefined {
    try {
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    } catch {
      return undefined;
    }
  }

  /** Which repo a judge child belongs to (the registry is keyed by root). */
  function repoOfChild(child: JudgeChild): string {
    for (const [root, list] of childSessions) {
      if (list.some((c) => c.sessionId === child.sessionId)) return root;
    }
    return primaryRepoRoot;
  }


  async function recordJudgeConclusion(sessionId: string): Promise<string | undefined> {
    try {
      const child = [...childSessions.values()].flat().find((c) => c.sessionId === sessionId);
      if (!child || child.role === "adviser") return undefined; // an adviser's conclusion is advice, not a verdict
      // THIS ROUND's output only. The transcript accumulates every round of
      // the role's session, so its "last verdict fence" can be the PREVIOUS
      // round's — a judge that exited with a question, a crash or plain prose
      // would then have last round's READY recorded against a tree nobody
      // judged. The per-round stdout log contains this round and nothing else.
      const roundOutput = readRoundStdout(child.stdoutPath);
      if (!roundOutput || !hasJudgeFence(roundOutput)) {
        // A judge that produced NOTHING did not "have output to read": it
        // crashed, or the model call failed. Say that, with what it left on
        // stderr — the round has to be dispatched again, and an agent told to
        // "read its output" reads an empty file and learns nothing.
        // (Measured: a reviewer died with "Connection error." and an empty
        // stdout mid-task.)
        const failed = readJudgeSessionState({ pidPath: child.pidPath, exitCodePath: child.exitCodePath });
        if (!roundOutput?.trim() || (failed.exitCode !== undefined && failed.exitCode !== 0)) {
          const why = readStderrTail(child.stderrPath)?.trim().split("\n").slice(-3).join(" ") ?? "";
          return `${child.role} 本轮没有产出结论` +
            (failed.exitCode !== undefined ? `（exit ${failed.exitCode}）` : "") +
            (why ? `：${why.slice(0, 200)}` : "。") +
            ` 什么都没有记录——用同样的 task 重新 judge_submit({role:"${child.role}"}) 即可（同一 session 续接）。`;
        }
        return undefined; // output without a fence: the agent reads it and decides
      }
      // A QUESTION is not a verdict. Feeding it to the recorder would answer
      // "no recognizable verdict" — technically fail-closed, but it reads as
      // a parse error when the judge simply asked something.
      if (!/"gate"\s*:\s*"(READY|BLOCKED|NEEDS_HUMAN)"/.test(roundOutput)) {
        return `${child.role} 提了一个问题（没有 verdict）。用 judge_read({role:"${child.role}"}) 看问题，` +
          `再用 judge_submit({role:"${child.role}", task:<你的回答>}) 带着答案续接同一会话。`;
      }
      if (child.role === "reviewer") {
        // No live tool ctx here (this runs from a process-exit callback), so
        // the last one the session bound is what persists the record. The repo
        // is named explicitly: a multi-repo session refuses an unqualified
        // record, and this record must not depend on which repo was edited last.
        if (!lastUiCtx) return undefined;
        const result = await callTool("record_review", { reviewer_output: roundOutput, repo: repoOfChild(child) }, lastUiCtx);
        return toolText(result);
      }
      // A goal audit is recorded the same way, against the draft the gate
      // dispatched — the record binds to that text's hash, so remembering it
      // is the gate's job, not the agent's to re-paste.
      const pending = pendingGoalAudits.get(repoOfChild(child));
      if (!pending || !lastUiCtx) return undefined;
      pendingGoalAudits.delete(repoOfChild(child));
      const audit = await callTool("record_goal_prereview", {
        goal: pending.draft,
        auditor_output: roundOutput,
        auditStartedAt: pending.startedAt,
        repo: repoOfChild(child),
      }, lastUiCtx);
      return toolText(audit);
    } catch {
      return undefined; // recording is best-effort; the wake still happens
    }
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


  /** The judge child of one role in one repo, if the registry still holds it. */
  function judgeChildByRole(root: string, role: string): JudgeChild | undefined {
    return (childSessions.get(root) ?? []).find((c) => c.role === role);
  }

  /**
   * Locate a judge child by ROLE (the agent's vocabulary) or by session id
   * (the internal key). Role wins when both are given: the agent addresses
   * roles, and a stale id it copied from an old round would silently read the
   * wrong session.
   */
  function findJudgeChild(root: string, role?: string, sessionId?: string): JudgeChild | undefined {
    if (role) return judgeChildByRole(root, role);
    if (sessionId) return [...childSessions.values()].flat().find((c) => c.sessionId === sessionId);
    return undefined;
  }

  pi.registerTool({
    name: "judge_submit",
    label: "Submit To Judge",
    description:
      "Submit one round of work to a judge role — the ONE entry point for reviewer / adviser / " +
      "goal-auditor. The gate owns everything procedural: the session id and its directory " +
      "(derived from role+repo, so the judge's context carries across rounds), spawn vs. resume vs. " +
      "kill, and the completion listener. You pass WHO and WHAT; you never pass a session id, a " +
      "title or a directory. It returns as soon as the round is SUBMITTED, not when the judge is " +
      "done — the judge's process exit wakes this session as a new turn, and you then read the " +
      "verdict with judge_read (or judge_wait, when nothing else is left to do). A role that is " +
      "still working REFUSES the round (nothing is silently dropped): wait for it, or pass " +
      "fresh:true to discard it.",
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
        const prepared = await callTool("prepare_goal_audit", { goal: task, repo: root }, ctx);
        if (prepared.isError) {
          return {
            content: [{ type: "text", text: "review-gate: 本轮未受理 — goal 审计任务无法生成。\n" + toolText(prepared) }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        // A goal audit streams its findings too (criterion 2): the agent can
        // fix the draft while the auditor is still working, exactly as it
        // does with a code review.
        streamPath = pathJoin(root, ".pi", "review-stream", `goal-${goalTextHash(task).slice(0, 12)}.jsonl`);
        try { mkdirSync(pathJoin(streamPath, ".."), { recursive: true }); } catch { /* the stream is optional */ }
        reviewTask = `${extractTaskText(toolText(prepared))}\n\n${buildStreamDirective(streamPath)}`;
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
        // A busy role is a normal state with a next step, not a malfunction —
        // the reason text already says what to do, so it stands alone.
        progress.fail(dispatch.busy ? "该 role 仍在跑上一轮" : "spawn 失败");
        const lead = dispatch.busy ? "review-gate: " : "review-gate: judge_submit 失败 — ";
        return {
          content: [{ type: "text", text: `${lead}${dispatch.error ?? "judge 进程未能启动"}` }],
          details: { submitted: false, busy: dispatch.busy === true },
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
        pendingGoalAudits.set(root, { draft: task, startedAt: new Date().toISOString() });
      }
      const child = judgeChildByRole(root, role);
      const lines = [
        `review-gate: ${role} 已受理本轮任务（${dispatch.reused ? "复用同一会话，上下文延续" : "新会话"}）。`,
        `- stdout: ${dispatch.stdoutPath ?? child?.stdoutPath ?? "(pending)"}`,
        `- transcript: ${dispatch.sessionDir ?? child?.sessionDir ?? "(pending)"}`,
        ...(streamPath ? [`- findings 流（边审边修）: ${streamPath}`] : []),
        "- 进程退出即完成，届时会唤醒本会话；用 judge_read({role}) 取结论。现在别等，先做别的确定性工作。",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          submitted: true,
          role,
          reused: dispatch.reused,
          runDir: dispatch.runDir,
          stdoutPath: dispatch.stdoutPath ?? child?.stdoutPath,
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
   * The three tools that OBSERVE or END a judge session — judge_read,
   * judge_close, judge_wait — live in lib/judge-session-tools.ts; only their
   * wiring is here. What they need from THIS file (the repo resolution, the
   * child registry, the exit watcher, the pending audit, the hosted-wait
   * watchdog) arrives as this deps object, and nothing else of them does:
   * every rule they apply is unit-testable without a spawned judge.
   */
  registerJudgeSessionTools(pi, {
    resolveRepo: (requested) => resolveToolRepo(requested),
    findChild: (root, role, sessionId) => findJudgeChild(root, role, sessionId),
    sessionState: (child) => readJudgeSessionState({ pidPath: child.pidPath, exitCodePath: child.exitCodePath }),
    conclusion: (child) => readJudgeConclusion(child.sessionDir),
    stderrTail: (child) => readStderrTail(child.stderrPath),
    readText: (path) => {
      try {
        if (!existsSync(path)) return undefined;
        return readFileSync(path, "utf8");
      } catch { return undefined; }
    },
    fileExists: (path) => existsSync(path),
    cancelWatch: (sessionId) => {
      // Cancel the exit watcher so no wake fires for a close we initiated.
      watchRegistry.unregister(sessionId);
      forgetChildProcess(sessionId);
    },
    dropChild: (sessionId) => {
      for (const [repoRoot, list] of childSessions) {
        childSessions.set(repoRoot, list.filter((c) => c.sessionId !== sessionId));
      }
      // D — the judge is gone, so reclaim its scratch review worktrees.
      reapReviewScratch(sessionId);
    },
    dropPendingAudit: (root) => { pendingGoalAudits.delete(root); },
    cancelWaitTimer: () => cancelChildWaitTimer(),
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
  // ---------- record_review tool ----------

  // INTERNAL, not registered: the gate records a verdict itself when the
  // reviewer's process exits, from that round's own output.
  internalTool({
    name: "record_review",
    label: "Record Review",
    description:
      "ADVANCED / internal: the gate records the verdict ITSELF when the reviewer's process exits " +
      "(from that round's own output), so you do not call this in the normal flow — only when you " +
      "have a reviewer output the gate could not read. " +
      "Records the verdict of an independent code/doc review. Pass the FULL raw output of a REAL, " +
      "independent reviewer run (do not hand-write the verdict). The gate parses every JSON fence " +
      "(worst verdict wins).",
    parameters: Type.Object({
      reviewer_output: Type.String({ description: "Complete raw output from the reviewer" }),
      repo: Type.Optional(Type.String({
        description:
          "Absolute path of the repository this review covers. REQUIRED once the session has edited " +
          "more than one repository — the verdict binds to that repo's own worktree fingerprint and " +
          "unblocks only that repo.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // P0-1: record_review only accepts JSON fence verdicts, NOT precommit
      // `## Overall:` sentinels. Review and precommit are separate gates.
      const parsed = parseReviewOutput(params.reviewer_output);
      if (!parsed) {
        return {
          content: [{
            type: "text",
            text: "review-gate: no recognizable review verdict found. The reviewer must output a fenced JSON verdict, " +
              `e.g.\n\`\`\`json\n{"gate":"READY"|"BLOCKED"|"NEEDS_HUMAN","docSync":"UPDATED"|"NOT_NEEDED","findings":[...]}\n\`\`\`\n` +
              "Common causes: (1) the review was pure Markdown (`### Blocker`) with no JSON fence — add the fence; " +
              "(2) an unescaped quote inside a string (full-width “” are fine; a straight \" inside `issue` breaks JSON — " +
              "escape it or rephrase). Gate remains PENDING (fail-closed).",
          }],
          details: {},
        };
      }

      // The agent is running the loop again — a standing ask_user
      // pause is moot (liveness: a stale pause would silently swallow the
      // next auto-continuation after a BLOCKED verdict).
      // P-multi: the verdict binds to ONE repo — `repo` when given, else the
      // repo the agent most recently edited (single-repo sessions only; with
      // several repos in play resolveToolRepo rejects the ambiguity instead
      // of guessing). stateForRepo(primary) IS `state`, so the local `st`
      // writes land on the right object and persistRepo persists to the right
      // sidecar — no global state swap (same rationale as run_precommit: a
      // swap would let a parallel tool_result arm the wrong repo's state).
      const target = resolveToolRepo(params.repo);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const targetRoot = target.root;
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
      // it — but nothing did, so a fence claiming `/evil/elsewhere` produced
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
      // findings this round (severity + file from the RAW reviewer output,
      // never line counts). The next prepare_review derives the file streak
      // from these.
      const fileFindings = parseFenceFileFindings(params.reviewer_output);
      const recorded = recordedFindingsFrom(fileFindings);
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
      return {
        content: [{
          type: "text",
          // The repo is named in the TEXT, not just details: a session that
          // could not see which repo its verdicts landed on kept recording
          // READY for the wrong one and read the resulting block as sabotage.
          text: `review-gate: recorded verdict ${parsed.verdict} for ${targetRoot} ` +
            `(round ${st.rounds.length}/${st.maxRounds}, findings: ${parsed.findingsTotal ?? "?"}).${note}` +
            (staleTarget
              ? "\nSTALE TARGET: the reviewer approved a commit that is no longer HEAD — a new " +
                "checkpoint landed after prepare_review, so the READY cannot bind to the change now " +
                "in place and is recorded as BLOCKED. This is the expected outcome of fixing while the " +
                "review runs: those fixes are already in, so the next round is short. Re-review the " +
                "current head with ONE call: judge_submit({role:\"reviewer\", task:<what you changed>})."
              : "") +
            (cwdMismatch
              ? `\nCWD CHECK FAILED: ${cwdMismatch}. The verdict schema requires the judge's own \`pwd\`, ` +
                "and the gate compares it with the repo this round was prepared for — a READY reporting a " +
                "different directory is recorded as BLOCKED. If the reviewer ended inside its throwaway " +
                "worktree, have it `cd` back to the repo root and report that instead."
              : "") +
            (parsed.verdict === "READY" ? " Next: run precommit for this same repo." : parsed.verdict === "BLOCKED" ? " Next: fix ALL findings and re-review." : ""),
        }],
        details: {
          verdict: parsed.verdict,
          round: st.rounds.length,
          repo: repoLabel(targetRoot),
          ...(staleTarget ? { staleTarget: true } : {}),
        },
      };
    },
  });

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
      const targetDir = targetRoot === primaryRepoRoot ? cwd : targetRoot;
      const st = stateForRepo(targetRoot);
      // Same liveness rule as record_review: running precommit proves the
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
        // Name the REPO in the text (not just details) — see record_review.
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
      "Declare the current task complete. Re-validates every gate server-side, then LANDS the work: " +
      "the gate merges this session's work branch into the base the user confirmed. A merge " +
      "conflict is reported with its files and refuses completion — resolve it and call again, or " +
      "pass waiveMerge to ask the user to leave the branch unmerged.",
    parameters: Type.Object({
      summary: Type.String({ description: "One-paragraph completion summary" }),
      waiveMerge: Type.Optional(Type.String({
        description:
          "Ask the USER to finish WITHOUT merging the work branch (they confirm in a dialog, and " +
          "the reason is recorded). Use it only when they chose to handle the merge themselves.",
      })),
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


      // Residual judge children (execution-model standard 5): a task is not
      // done while a judge child session is still open — its context may hold
      // a pending verdict or an unanswered question, and dropping it silently
      // strands a process (and its expensive model context). The round
      // must be closed out first — either the judge exits and the gate
      // records its verdict, or `judge_close` ends it. In loop
      // mode this is a hard requirement; explore/normal report it as
      // advisory via the branch below.
      for (const [root, list] of childSessions) {
        if (list.length > 0) {
          problems.push(`[${repoLabel(root)}] ${list.length} judge child session(s) still open (` +
            `${list.map((c) => c.sessionId).join(", ")}) — let the round finish (the gate records its ` +
            "verdict when the judge exits) or close it with `judge_close({role})` " +
            "before declaring done");
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
      // The USER's escape hatch from the merge, and it is theirs: the agent
      // can only ASK. A waiver granted in a dialog is recorded with its
      // reason, so "why is this branch still unmerged?" has an answer.
      const waiveReason = String(params.waiveMerge ?? "").trim();
      if (waiveReason && state.workBranch && !state.mergeWaived) {
        const granted = await confirmBounded(
          ctx as unknown as { ui?: { confirm?: (t: string, m: string) => Promise<boolean> } },
          "review-gate: 本次不把工作分支合并回基准分支？",
          `工作分支 ${state.workBranch} → 基准 ${state.baseBranch ?? "(未记录)"}\n` +
          `理由（不可信数据）：${waiveReason.slice(0, 300)}\n` +
          "选 Yes：分支留在原地，由你自己处理合并。",
        );
        if (granted) {
          state.mergeWaived = { at: new Date().toISOString(), reason: waiveReason.slice(0, 300) };
          persist(ctx as unknown as ExtensionContext);
        } else {
          return {
            content: [{ type: "text", text: "review-gate: 用户没有同意跳过合并 — 先解决合并（或让用户确认后重试）。" }],
            details: { accepted: false, problems: ["merge waiver declined by the user"] },
            isError: true,
          };
        }
      }
      // The gates are met — now the work has to LAND. The gate follows its own
      // branch log back to the base the user confirmed and merges the work
      // branch into it. A conflict is not the gate's to resolve: it stops,
      // records what conflicted, and hands the list back.
      progress.step(`合并工作分支 → ${state.baseBranch ?? "(基准未记录)"}`);
      const finish = finishWorkBranch(ctx as unknown as ExtensionContext);
      if (!finish.ok) {
        progress.fail("冲突/未完成");
        return {
          content: [{ type: "text", text: finish.text }],
          details: { accepted: false, problems: [finish.text] },
          isError: true,
        };
      }
      progress.done("已合并");
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
        merge: finish.merge,
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
   * session's exit contract) and the internal `record_goal_prereview` (L8b:
   * the goal-auditor's verdict becomes a record) — lives in
   * lib/goal-tools.ts + lib/goal-prereview-tools.ts; only its wiring is here.
   *
   * TWO HOSTS, deliberately named at the call site: the agent's tool goes to
   * `pi`, the internal implementation to `internalHost`, which pi never
   * learns a name from. The audit stays TRUSTED across the move — the fence
   * is parsed and the draft hashed in THIS process (lib/verdict-parse.ts +
   * lib/loop-goal.ts), never by the agent.
   *
   * What they need from THIS file arrives as this deps object: the repo roots
   * and their gate state, the persistence, the audit chain (`runGoalAudit` —
   * dispatch the judge, wait for it, record the verdict), the three
   * user-facing surfaces (transcript notice, bounded dialog, and the
   * either-side funnel an orchestrator may answer through), this session's
   * own loop-goal path, the project-layer agent lookup and the one file write
   * an approval performs.
   */
  registerGoalTools({ agent: pi, internal: internalHost }, {
    // Getters: session_start re-resolves both, and a goal bound to the
    // pre-session cwd would be recorded where nothing ever reads it.
    primaryRepoRoot: () => primaryRepoRoot,
    cwd: () => cwd,
    stateFor: (root) => stateForRepo(root),
    persist: (ctx, root) => persistRepo(ctx as unknown as ExtensionContext, root),
    log: (message) => log(message),
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
    armLoop: () => { loopArmed = true; },
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

  // ---------- setup_workspace tool (dirty worktree + branch, in one call) ----------

  pi.registerTool({
    name: "setup_workspace",
    label: "Set Up Workspace",
    description:
      "Settle where this session works, in ONE call: what to do with changes that were already in " +
      "the worktree (accept as this session's baseline / you handled them / the gate discards " +
      "them) and which branch is the BASE this session's work must end up in. The gate asks the " +
      "user, executes what they choose — including creating the work branch — and records every " +
      "step in its branch log, which declare_done later follows back to merge. Call it once, " +
      "early: while a dirty worktree is unsettled, edits are refused, and without a work branch " +
      "commits are refused.",
    parameters: Type.Object({
      branch: Type.Optional(Type.String({
        description: "Your proposed work branch name (default: session-<short id>; pass the CURRENT branch to keep working on it)",
      })),
      base: Type.Optional(Type.String({
        description: "The branch the work must merge back into (default: the current one, which the user confirms)",
      })),
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (default: this session's repo)",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = params.repo ? (gitRootOfDir(pathResolve(cwd, String(params.repo))) ?? primaryRepoRoot) : primaryRepoRoot;
      const st = root === primaryRepoRoot ? state : stateForRepo(root);
      const uiCtx = ctx as unknown as {
        ui?: {
          select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
          notify?: (message: string, type?: "info" | "warning" | "error") => void;
        };
      };
      const notes: string[] = [];
      /**
       * Every workspace question goes through the channel funnel, so an
       * orchestration child can be settled by its project manager exactly as
       * it can by the human sitting in the pane — and neither waits for the
       * other. A standalone session just renders the dialog, as before.
       */
      const askWorkspace = (title: string, choices: string[]): Promise<string | undefined> =>
        askEitherSide(
          { dialogKind: "select", topic: "workspace", title, options: choices },
          typeof uiCtx.ui?.select === "function",
          (signal) => uiCtx.ui!.select!(title, choices, { signal }),
        ).catch(() => undefined);


      // ---- 1. the dirty worktree, if there is one ----
      let files = dirtyFiles(root);
      if (files.length) {
        showToUser(uiCtx, "───── 工作区有未提交改动 ─────", describeDirty(files));
        const choices = Object.values(WORKTREE_CHOICES);
        const picked = await askWorkspace("这些改动怎么处理？", choices);
        const choice = interpretWorktreeChoice(picked);
        if (!choice) {
          // A dismissed dialog decides nothing — and deciding for the user
          // here would mean either shipping their changes or deleting them.
          return {
            content: [{ type: "text", text: "review-gate: 用户没有选择处置方式，工作区仍未确认（编辑保持拦截）。等他回答后重试。" }],
            details: { settled: false, workBranch: undefined as string | undefined },
            isError: true,
          };
        }
        if (choice === "discard") {
          try {
            execFileSync("git", ["checkout", "--", "."], { cwd: root, encoding: "utf8" });
            execFileSync("git", ["clean", "-fd"], { cwd: root, encoding: "utf8" });
          } catch (err) {
            return {
              content: [{ type: "text", text: `review-gate: 丢弃失败 — ${err instanceof Error ? err.message : String(err)}。工作区仍未确认。` }],
              details: { settled: false, workBranch: undefined as string | undefined },
              isError: true,
            };
          }
          logBranchOp(st, {
            op: "worktree_discard",
            files: files.map((f) => f.path).slice(0, 50),
            at: new Date().toISOString(),
            reason: "用户在 setup_workspace 中选择丢弃",
          });
          files = dirtyFiles(root);
          notes.push(files.length ? `已丢弃，但仍有 ${files.length} 个改动残留（可能被 .gitignore 覆盖）。` : "改动已丢弃，工作区干净。");
        } else if (choice === "handled") {
          files = dirtyFiles(root);
          if (files.length) {
            // "I handled it" is a claim the gate CHECKS: still dirty ⇒ still
            // unsettled, or the edit gate would open on a false statement.
            st.worktreeDirty = { files: files.map((f) => `${f.status.trim() || "??"} ${f.path}`), at: new Date().toISOString() };
            persistRepo(ctx as unknown as ExtensionContext, root);
            return {
              content: [{ type: "text", text: `review-gate: 重新检测后工作区仍不干净（${files.length} 个改动），未放行。\n${describeDirty(files)}` }],
              details: { settled: false, workBranch: undefined as string | undefined },
              isError: true,
            };
          }
          notes.push("用户已自行处理，复检干净。");
        } else if (choice === "exempt") {
          // USER REQUIREMENT (2026-08-30): a "pass through" option for
          // pre-existing mock/local changes. Snapshot the dirty files into
          // the same scopeLimit structure request_scope_limit uses — the
          // ship gate and the review scope then treat them as exempt (no
          // review coverage required), the files stay in the worktree
          // untouched, and declare_done still merges them.
          //
          // NEVER exempt THIS session's own edits (mirrors
          // request_scope_limit's preexisting filter): a session that edited
          // first and then picks 放行 must not get its own work out of the
          // review. The grant covers only files the session did not touch.
          const sessionSet = new Set(sessionEditedPaths);
          const preexisting = files.map((f) => f.path).filter((p) => !sessionSet.has(p));
          const exemptedOwnWork = files.map((f) => f.path).filter((p) => sessionSet.has(p));
          if (st.scopeLimit) {
            // A grant from request_scope_limit already exists — extend it
            // with the dirty files (never shrink).
            st.scopeLimit = {
              ...st.scopeLimit,
              preexistingFiles: [...new Set([...st.scopeLimit.preexistingFiles, ...preexisting])],
            };
          } else {
            st.scopeLimit = {
              preexistingFiles: preexisting,
              sessionFiles: [...sessionSet],
              at: new Date().toISOString(),
            };
          }
          // RE-ARM from THIS session's own edits only (mirrors
          // request_scope_limit's granted branch): pre-existing dirty files
          // are exempt, so the gate is armed exactly by what this session
          // edited — never weakened for its own work.
          st.hasCodeChange = [...st.scopeLimit.sessionFiles].some(isCodeFile);
          st.hasDocChange = [...st.scopeLimit.sessionFiles].some(isDocFile);
          // The worktree is now settled; the files stay put.
          const exemptCount = preexisting.length;
          notes.push(
            exemptedOwnWork.length > 0
              ? `已放行 ${exemptCount} 个本会话之外的改动（不删不改，豁免进审查）；本会话自己改的 ${exemptedOwnWork.length} 个文件仍要审查。`
              : `已放行 ${exemptCount} 个改动（不删不改，豁免进审查；快照 ${new Date().toISOString()}）。`
          );
        } else {
          notes.push(`接受 ${files.length} 个改动为本会话基线（记得提交成 checkpoint）。`);
        }
      }
      // Settled either way: clean, discarded, or accepted as the baseline.
      st.worktreeDirty = files.length
        ? { files: files.map((f) => `${f.status.trim() || "??"} ${f.path}`), at: new Date().toISOString(), settled: true }
        : undefined;
      if (!st.worktreeDirty) delete st.worktreeDirty;

      // ---- 2. the base branch ----
      const here = currentBranch(root);
      if (!here) {
        return {
          content: [{ type: "text", text: "review-gate: 当前是 detached HEAD，无法确定基准分支。先 checkout 一个分支再调 setup_workspace。" }],
          details: { settled: false, workBranch: undefined as string | undefined },
          isError: true,
        };
      }
      let base = here;
      // R3-6 — an orchestration child's base is DECLARED by its supervisor,
      // not derived from where it happens to stand. A parallel lane runs in a
      // gate-created worktree checked out on `orch/<task>-<stamp>`, so the
      // "current branch" default would make it merge its work into that
      // scratch branch — which is exactly what happened to a whole lane in the
      // third run. The agent may still override it, and the USER still
      // confirms it in the dialog below.
      const injectedBase = String(process.env[ORCH_BASE_BRANCH_ENV] ?? "").trim();
      const proposedBase = String(params.base ?? "").trim() || injectedBase;
      if (proposedBase && proposedBase !== here) {
        // The agent knows this session continues an existing feature branch:
        // the base is elsewhere. The USER still confirms it — a wrong base is
        // a merge into somebody else's work.
        const ok = await askWorkspace(
          `基准分支 = ${proposedBase}，工作分支 = ${params.branch ? String(params.branch) : "新建"}。确认吗？`,
          [`是，合并回 ${proposedBase}`, "否，用当前分支作为基准"],
        );

        if (!ok) {
          return {
            content: [{ type: "text", text: `review-gate: 基准分支未确认（提议 ${proposedBase}）。` }],
            details: { settled: false, workBranch: undefined as string | undefined },
            isError: true,
          };
        }
        if (ok.startsWith("是")) {
          try {
            execFileSync("git", ["rev-parse", "--verify", proposedBase], { cwd: root, encoding: "utf8" });
          } catch {
            return {
              content: [{ type: "text", text: `review-gate: 基准分支 ${proposedBase} 不存在。` }],
              details: { settled: false, workBranch: undefined as string | undefined },
              isError: true,
            };
          }
          st.baseBranch = proposedBase;
          logBranchOp(st, { op: "base_branch_set", branch: proposedBase, at: new Date().toISOString() });
          notes.push(...refreshBaseBeforeBranch(root, proposedBase));
          const work = deriveWorkBranchName(params.branch ? String(params.branch) : here, here);
          if (work !== here) {
            try {
              execFileSync("git", ["checkout", "-b", work], { cwd: root, encoding: "utf8" });
              logBranchOp(st, { op: "checkout", from: here, to: work, at: new Date().toISOString() });
            } catch (err) {
              return {
                content: [{ type: "text", text: `review-gate: 创建工作分支 ${work} 失败 — ${err instanceof Error ? err.message : String(err)}` }],
                details: { settled: false, workBranch: undefined as string | undefined },
                isError: true,
              };
            }
          }
          st.workBranch = work;
          logBranchOp(st, { op: "work_branch_set", branch: work, base: proposedBase, at: new Date().toISOString() });
          persistRepo(ctx as unknown as ExtensionContext, root);
          return {
            content: [{
              type: "text",
              text: `review-gate: 工作区已确认。基准分支 ${proposedBase}，工作分支 ${work}（当前所在）。` +
                (notes.length ? `\n${notes.join("\n")}` : "") +
                "\ndeclare_done 时门禁会把工作分支合回基准（冲突则中止并交还给你处理）。",
            }],
            details: { settled: true, baseBranch: proposedBase, workBranch: work },
          };
        }
      }
      if (isProtectedBranch(here)) {
        // main/master is never a base a session commits onto; the user picks
        // the development branch it should branch from and merge back into.
        const proposed = `dev/${new Date().toISOString().slice(0, 10)}`;
        const picked = await askWorkspace(
          `当前在受保护分支 ${here}，本会话不能直接在它上面开发。基准分支用哪个？`,
          [`从 ${here} 拉一条基准分支 ${proposed}`, `就用 ${here} 作为基准（工作分支仍会另建）`],
        );

        if (!picked) {
          return {
            content: [{ type: "text", text: `review-gate: 用户未确认基准分支（当前 ${here}），未建立工作分支。` }],
            details: { settled: false, workBranch: undefined as string | undefined },
            isError: true,
          };
        }
        if (picked.startsWith("从 ")) {
          try {
            execFileSync("git", ["checkout", "-b", proposed], { cwd: root, encoding: "utf8" });
            logBranchOp(st, { op: "checkout", from: here, to: proposed, at: new Date().toISOString() });
            base = proposed;
          } catch (err) {
            return {
              content: [{ type: "text", text: `review-gate: 创建基准分支失败 — ${err instanceof Error ? err.message : String(err)}` }],
              details: { settled: false, workBranch: undefined as string | undefined },
              isError: true,
            };
          }
        }
      } else {
        const picked = await askWorkspace(
          `把当前分支 ${here} 作为本会话的基准分支吗？（工作完成后合并回它）`,
          [`是，基准分支 = ${here}`, "否，我先自己切到正确的分支再来"],
        );

        if (!picked || picked.startsWith("否")) {
          return {
            content: [{ type: "text", text: `review-gate: 基准分支未确认（当前 ${here}）。切到正确的分支后重新调 setup_workspace。` }],
            details: { settled: false, workBranch: undefined as string | undefined },
            isError: true,
          };
        }
      }
      st.baseBranch = base;
      logBranchOp(st, { op: "base_branch_set", branch: base, at: new Date().toISOString() });
      notes.push(...refreshBaseBeforeBranch(root, base));

      // ---- 3. the work branch ----
      const seed = (state.sessionId ?? randomBytes(3).toString("hex")).slice(0, 8);
      const work = deriveWorkBranchName(params.branch ? String(params.branch) : undefined, seed);
      if (work !== currentBranch(root)) {
        try {
          execFileSync("git", ["checkout", "-b", work], { cwd: root, encoding: "utf8" });
        } catch (err) {
          return {
            content: [{ type: "text", text: `review-gate: 创建工作分支 ${work} 失败 — ${err instanceof Error ? err.message : String(err)}` }],
            details: { settled: false, workBranch: undefined as string | undefined },
            isError: true,
          };
        }
        logBranchOp(st, { op: "checkout", from: base, to: work, at: new Date().toISOString() });
      }
      st.workBranch = work;
      logBranchOp(st, { op: "work_branch_set", branch: work, base, at: new Date().toISOString() });
      persistRepo(ctx as unknown as ExtensionContext, root);
      return {
        content: [{
          type: "text",
          text: `review-gate: 工作区已确认。基准分支 ${base}，工作分支 ${work}（当前所在）。` +
            (notes.length ? `\n${notes.join("\n")}` : "") +
            "\ndeclare_done 时门禁会按分支日志把工作分支合回基准（冲突则中止并交还给你处理）。",
        }],
        details: { settled: true, baseBranch: base, workBranch: work },
      };
    },
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
    confirmBounded: (uiCtx, title, message, pointer) =>
      confirmBounded(uiCtx as Parameters<typeof confirmBounded>[0], title, message, pointer),
    askEitherSide: (request, hasUI, render) => askEitherSide(request, hasUI, render),
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
      if (state.taskMode !== "explore" && state.taskMode !== "normal") loopArmed = true;
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
      "In /tmp, scratchFirstMode keeps only an explicit explore and otherwise applies normal. " +
      "Upgrades (toward loop) apply immediately except in /tmp, where the agent cannot enter loop " +
      "(first classification is remapped to normal; later agent loop upgrades are rejected; only " +
      "the user can force loop via /gate-mode). Downgrades after the first classification pop a " +
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
          content: [{ type: "text", text: 'review-gate: unknown mode — use "loop", "explore", "normal", or "orchestrator".' }],
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
      const piSelf = isPiSelfRoot(primaryRepoRoot);
      if (
        state.taskMode === undefined &&
        !sessionEdited &&
        ctx.hasUI
      ) {
        if (piSelf) {
          // /tmp is scratch space: it can never reach loop via the agent, and the
          // /tmp is scratch space: it can never reach loop via the agent. Asking the
          // model here would spend up to the full guard timeout on an answer
          // nobody reads, so a scratch session makes NO LLM call at all — the
          // same promise the pre-refactor code kept.
          effective = scratchFirstMode(requested);
        } else {
        }
      }
      // Defense in depth: even if the first-classification block was skipped
      // (session already edited) or a future caller forgets scratchFirstMode,
      // a /tmp first classification must never hand "loop" to setTaskMode.
      // evaluateModeChange remaps internally too, but it does not return the
      // remapped mode — the tool applies `effective`.
      if (piSelf && state.taskMode === undefined && effective === "loop") {
        effective = "normal";
      }
      // The pure rule engine decides; this tool only supplies FACTS. Consent
      // is obtained below by the EXTENSION (there is deliberately no
      // "confirmed" parameter the model could set). hasChanges = THIS
      // session's own edits only (pre-existing changes arm the gate via
      // state.hasCodeChange but must not force a confirmation dialog on the
      // first classification). piSelfTask is the session cwd, not a
      // first-classification-only flag: later agent loop upgrades must also
      // be rejected.
      const decision = evaluateModeChange({
        current: state.taskMode,
        requested: effective,
        hasChanges: sessionEdited,
        hasUI: ctx.hasUI,
        downgradesLocked: agentDowngradesLocked,
        piSelfTask: piSelf,
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
        const scratchFirst = piSelf && state.taskMode === undefined;
        setTaskMode(effective, decision.source, ctx as unknown as ExtensionContext);
        try {
          const sourceNote = scratchFirst
            ? "（/tmp 临时会话，规则禁止 loop，无需确认）"
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
                ? `。你请求的是 "${requested}"，/tmp 临时会话规则已将其调整为 "${effective}"。`
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
        // computed on `effective` (which the /tmp clamp may have rewritten), so
        // the copy is built from `effective` — never from `requested`. When the
        // two differ, `requested` is passed as well so the fixed copy can say
        // why the agent's reason argues for another mode.
        let ok = false;
        try {
          ok = await confirmBounded(
            ctx as unknown as ExtensionContext,
            MODE_CONFIRM_TITLE,
            buildModeConfirmMessage(effective, params.reason, requested),
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
    const childSnapshots: ChildSnapshot[] = [];
    const sessionIdsBySession = new Map<string, string>();
    for (const list of childSessions.values()) {
      for (const c of list) {
        childSnapshots.push({
          title: c.title,
          sessionId: c.sessionId,
          role: c.role,
          spawnedAt: c.spawnedAt,
          // Criterion (b): the live PROCESS's exitCode — an exited child is
          // finished even if its artifacts were never written.
          alive: judgeProcessAlive(c.child),
          // Round-5 P1: activity is the evidence a child is still working —
          // newest write among its transcript and stderr/stdout logs.
          lastActivityAt: lastActivityAt(
            { sessionDir: c.sessionDir, stderrPath: c.stderrPath },
            [c.stdoutPath],
          ),
        });
        sessionIdsBySession.set(c.sessionId, c.title);
      }
    }
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
      { inMotion: subagentInMotion() || judgeChildInMotion() },
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
    // A new session may register watchers again — session_shutdown latched
    // the registry shut (round-16 Nit); the latch must not survive into
    // the resumed/reloaded session or its wake-ups would never arm.
    watchRegistry.reset();
    // (Snapshot sessions were retired 2026-08-27: judge roles run as tmux
    // child processes that never load this extension, so no inert-session
    // special-case is needed — there is nothing to make inert.)
    // P-multi: re-derive the primary repo and reset per-repo tracking for the
    // new session (a switched session may target a different checkout).
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
    // A new session negotiates its OWN goal: whatever audit rounds a previous
    // session spent on its draft do not carry into this one's count.
    delete state.goalAuditRound;
    // A session's OWN branch decisions do not carry over: it confirms its
    // base and creates its work branch (setup_workspace) or it does not
    // commit at all.
    delete state.baseBranch;
    delete state.workBranch;
    delete state.mergeConflict;
    delete state.mergeWaived;
    // Where did this session start, and on top of what? Both are gate facts
    // from the first turn: the dirty worktree blocks edits until the user
    // settles it, and the starting branch is the first branchOps entry — the
    // beginning of the trail declare_done follows back.
    recordSessionStartWorkspace();

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
    reconcileBlockedMarker(blockedMarkerPath(sidecarPath(cwd)), { sessionId: state.sessionId });

    // Explain an invalidated binding instead of letting READY silently become
    // PENDING after an upgrade (see migrateFingerprintVersion).
    if (fingerprintMigrated) {
      try { ctx.ui.notify(FINGERPRINT_MIGRATION_NOTICE, "warning"); } catch { /* headless */ }
      fingerprintMigrated = false;
    }

    // Say it out loud when another Pi session is live in this same repo.
    // saveSidecarPreservingConcurrent keeps a still-valid foreign READY/PASS
    // alive, but the two sessions still share one file and one worktree, and
    // an unexplained "the hook rejects what the gate just approved" is what
    // sent a real session chasing a phantom.
    if (concurrentSessionNotice) {
      try { ctx.ui.notify(concurrentSessionNotice, "warning"); } catch { /* headless */ }
      concurrentSessionNotice = null;
    }

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
    // Cancel every background watcher — a reloaded/resumed session must not
    // keep stale exit listeners, and a stale listener would wake the NEW
    // session about an OLD child. The registry latches shutdown so a signal
    // already in flight cannot re-arm an orphan listener (round-16 Nit);
    // session_start calls reset().
    watchRegistry.shutdown();
    // The supervision probe is a timer this session owns; a leaked one would
    // keep waking a session that is gone.
    stopSupervisionTimer();
    // Same for the child heartbeat: a leaked timer would keep reporting on
    // behalf of a session that is gone, and its supervisor would read those
    // reports as a healthy child.
    stopChildHeartbeat();


    // Judge children are independent pi processes — they survive the session
    // by design (their session files persist, so a fresh session can resume
    // or close them). Shutdown only drops the registry; the processes keep
    // running and their transcripts stay on disk.
    childSessions.clear();
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
    loopArmed = true;
    continuationsInjected = 0;
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

    // While the mode is undecided, ask the agent to classify the task
    // IN-SESSION as its first action (set_gate_mode). Enforcement below stays
    // full loop behavior until it does — never deciding is fail-closed.
    if (state.taskMode === undefined) {
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
          "\n\n## Explore workflow (investigation)\n" +
          "This is an explore (investigation/troubleshooting) task, not a delivery loop. " +
          "PREFER read-only work: inspect, run diagnostic/read-only commands, and reason — avoid editing files unless a small change is genuinely needed for the investigation (e.g. a temporary probe). " +
          "Review/precommit gates are advisory in this mode, auto-continuation is disabled, and you may call declare_done " +
          "as soon as the task is satisfactorily complete — you decide when it is done. " +
          "Ship commands (git commit/push, gh pr) remain fully gated; if the task turns into delivery work, ask the user to run /gate-mode loop." +
          (problems.length ? `\nAdvisory gate status:\n${problems.map((p) => `- ${p}`).join("\n")}` : ""),
      };
    }
    // Loop goal (Step 0): loop mode works to an explicit exit contract
    // (`.pi/loop-goal.md` — see lib/loop-goal.ts for the full rationale).
    // Injected AFTER the explore early-return and BEFORE the unarmed one: the
    // goal must be set while the worktree is still clean, i.e. before the
    // first edit arms the gate. An UNCONFIRMED goal has its body withheld
    // (L8) and blocks ships at L1; the hooks stay out of it.
    if (state.taskMode === "loop") {
      const goal = readSessionLoopGoal(primaryRepoRoot);

      const goalConfirmed = loopGoalConfirmed();
      systemPrompt += "\n\n" + buildLoopGoalDirective(goal, goalConfirmed);

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


    if (!gateArmed && problems.length === 0) {
      return { systemPrompt };
    }

    return {
      systemPrompt:
        systemPrompt +
        "\n\n## Review Gate (enforced)\n" +
        "改完就送审：`judge_submit({role:\"reviewer\", task:<本轮改动说明>})` —— 门禁自己跑 " +
        "precommit、提交 checkpoint、算审查范围、派 reviewer，并在它退出时机械记录 verdict。" +
        "被打回就按 findings 修，然后再 judge_submit；READY 了就 `declare_done`（门禁自己把工作分支合回基准）。" +
        "攒一批改动再送审：循环按轮计费，不按行。" +
        "git commit/push 与 gh pr create/edit 在门禁通过前是硬拦截。\n" +
        buildAgentDirectives() + "\n" +
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
