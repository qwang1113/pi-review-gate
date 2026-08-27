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
  mkdirSync, realpathSync, openSync, closeSync, readSync, copyFileSync, readdirSync,
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
  requiresFullPrecommit,
  type ShipCommandKind,
} from "../lib/constants.ts";
import { defaultProjectConfig, globalConfigPath, loadProjectConfig, type ProjectConfig } from "../lib/project-config.ts";
import { buildGitMemory } from "../lib/git-memory.ts";
import { detectShipCommands, extractCommitMessages, extractPrTextFields } from "../lib/ship-detect.ts";
import { buildAgentsWidget, buildModelConfigWidget, scanAgentArtifacts } from "../lib/ui-widget.ts";
import {
  gitRootOfDir,
  resolveShipRepos,
  resolveCommandRepos,
  resolveToolRepoTarget,
} from "../lib/repo-resolve.ts";
import { firstNonEnglish, containsNonLatinLetter, isNonEnglishText } from "../lib/lang-detect.ts";
import {
  waitForSignalAsync,
  spawnJudgePane,
  paneAlive,
  killPane,
  paneCurrentPath,
  capturePane,
  sendMessage,
  tmuxAvailable,
  type WaitHandle,
} from "../lib/tmux-session.ts";
import {
  writeJudgeSpawnFiles,
  doneChannelFor,
  inboxChannelFor,
  JUDGE_ROLES,
  judgeRoleInScript,
  normalizeToolName,
} from "../lib/judge-prompt.ts";
import {
  failedStepNames,
  receiptTotalMs,
  stepTimings,
  validatePrecommitReceipt,
  type StepTiming,
  type TestScope,
} from "../lib/precommit-receipt.ts";
import {
  appendTiming,
  formatPrecommitSummary,
  lastPrecommitTiming,
} from "../lib/gate-timings.ts";
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
  mayBeGateOwned,
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
  sidecarPath,
  unmetRequirements,
  type GateState,
} from "../lib/gate-state.ts";
import { parseReviewOutput, parsePrecommitOutput, parseFenceFindings } from "../lib/verdict-parse.ts";
import { buildAdviserBrief, countAdviserConclusions, parseAdviserConclusions, type AdviserConclusion } from "../lib/adviser-brief.ts";
import { sessionDirForCwd } from "../lib/session-dir.ts";
import {
  evaluateModeChange,
  buildModeConfirmMessage,
  normalizeTaskMode,
  scratchFirstMode,
  GATE_MODE_DECISION_DIRECTIVE,
  MODE_CONFIRM_TITLE,
  type TaskMode,
  type TaskModeSource,
} from "../lib/task-mode.ts";
import {
  createLlmClassifier,
  classifyAiAttribution,
  classifyNonEnglish,
  classifyShipCommand,
  createVerdictMemo,
  isSuspiciousShipCandidate,
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
  LOOP_GOAL_MAX_WRITE_CHARS,
  buildLoopGoalDirective,
  buildGoalConfirmMessage,
  buildGoalTranscriptMessage,
  goalTextHash,
  isLoopGoalConfirmed,
  normalizeGoalText,
  readLoopGoal,
  formatGoalPrereviewCarryover,
  buildGoalAuditTask,
  GOAL_CONFIRM_TITLE,
  LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK,
  LOOP_GOAL_UNCONFIRMED_EDIT_BLOCK,
  loopGoalEditGate,
  goalPrereviewPassed,
  buildGoalPrereviewRefusal,
} from "../lib/loop-goal.ts";
import type { GoalPrereviewRecord } from "../lib/loop-goal.ts";
import { fitDialogMessage } from "../lib/dialog-budget.ts";
import { diagnoseChain, formatModelDiagnosis, type RegistryFacts } from "../lib/model-diagnose.ts";
import { factsFromRegistry, formatDoctorReport, runGateDoctor } from "../lib/gate-doctor.ts";
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
} from "../lib/model-config.ts";
import type { ModelRegistry, RegistryModelInfo } from "../lib/model-config.ts";
import { buildStreamConsumerDirective, buildStreamDirective } from "../lib/review-stream.ts";
import { isModelAllowed } from "../lib/model-allowlist.ts";
import { squashPointBaseline, branchBaseBaseline } from "../lib/review-baseline.ts";
import {
  COPILOT_HISTORY_PR_COUNT,
  COPILOT_HISTORY_QUERY,
  COPILOT_REVIEWER_LOGIN,
  COPILOT_THREADS_QUERY,
  analyzeCopilot,
  armCopilotReview,
  copilotProblems,
  decideCopilotSupport,
  decidePrView,
  evaluateCopilot,
  isCopilotOutstanding,
  isUnknownJsonFieldError,
  PR_VIEW_JSON_FIELDS,
  parseCopilotHistoryProbe,
  parseCopilotPayload,
  parseNameWithOwner,
  parsePrView,
  recordCopilotRequest,
  releaseCopilotReview,
  slugFromPrUrl,
  type CopilotPayload,
  type CopilotReviewState,
  type CopilotSupport,
  type CopilotThread,
  type PrSummary,
} from "../lib/copilot-review.ts";
import {
  SENSITIVE_GRANT_TTL_MS,
  addGrant,
  consumeGrant,
  findGrant,
  isGateIntegrityPath,
  normalizeSensitivePath,
  type SensitiveGrant,
} from "../lib/sensitive-grant.ts";
import {
  blockedMarkerPath,
  recordBlockedMarker,
  reconcileBlockedMarker,
} from "../lib/blocked-marker.ts";
import { WORKFLOW_COMMANDS, buildWorkflowPrompt, type WorkflowCommandName } from "../lib/workflow-commands.ts";
import {
  buildReviewPrompt,
  formatPrecommitBaseline,
  extractPrecommitBaseline,
  REVIEW_VERDICT_SCHEMA,
} from "../lib/parallel-review.ts";
import {
  parseArbitrableAction,
  tokenAuthorizes,
  buildArbiterPrompt,
  runArbiter,
  sha256,
  BYPASS_TOKEN_TTL_MS,
  type ArbitrableAction,
  type BypassToken,
  type TokenBindings,
} from "../lib/arbitration.ts";

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
  let state: GateState = emptyState(null, DEFAULT_MAX_ROUNDS);
  let cwd = process.cwd();
  /**
   * Set when session_start runs inside a REVIEW SNAPSHOT worktree. The whole
   * extension goes inert for that session: no state init, no sidecar writes,
   * and — critically — the tool_call/tool_result hooks must not run either,
   * otherwise the L8 edit gate would block the reviewer's own mutation
   * analysis inside its disposable copy (see session_start).
   */
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
      'review the blocked repo and call record_review (then run_precommit) with "repo": "<that repo path>".'
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
    // A snapshot session owns NO gate state by design (session_start early-
    // returns before init/arming). Returning the untouched empty state here
    // would make the bash ship gate see hasCodeChange=false for the snapshot
    // root (which IS primaryRepoRoot for a real reviewer child process) and
    // let a `git push` through — so an inert session is always treated as
    // sidecar-less, and the caller's fail-closed "no gate state" handling
    // (changedFiles) applies.
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
  let lastBlockedShip: { command: string; problems: string[]; blockReason: string } | null = null;
  // Per-session arbitration request count (capped by projectConfig.arbiter).
  let arbitrationsUsed = 0;
  // Re-roll prevention: decisions cached by (commandDigest#round). A GATE_WINS /
  // HUMAN outcome cannot be re-requested for the same action+round.
  const arbitrationDecisions = new Map<string, "GATE_WINS" | "AGENT_WINS" | "HUMAN">();

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
   * Background done/inbox channel listeners (review_watch): one handle per
   * channel. When a child signals, the listener wakes THIS session via
   * pi.sendMessage(triggerTurn) — the "the child finished" notification that
   * makes main-session polling unnecessary. Cancelled on session_shutdown so
   * a reload/resume never leaks a tmux wait-for process.
   */
  const activeWatchers = new Map<string, WaitHandle>();
  /**
   * Judge child sessions spawned by review_spawn: repo root → children.
   * In-memory for now (persisted listing lands with the declare_done residual
   * check); each entry carries the tmux pane id and the derived channels.
   */
  interface JudgeChild {
    paneId: string;
    role: string;
    title: string;
    doneChannel: string;
    inboxChannel: string;
    inboxPath: string;
    spawnedAt: string;
  }
  const childSessions = new Map<string, JudgeChild[]>();
  /**
   * Review targets registered by prepare_review (commit mode): repo root →
   * the reviewed baseline..HEAD plus HEAD's tree. record_review consumes it:
   * a READY binds to the reviewed tree, and a HEAD that moved past the
   * registered head (a new checkpoint after prepare) is STALE ⇒ BLOCKED.
   */
  interface ReviewTarget { baseline: string; head: string; tree: string; }
  const reviewTargets = new Map<string, ReviewTarget>();
  /** HEAD commit tree OID — the content-boundary every ship binding compares against (round-8 P1). */
  function headCommitTree(root: string): string {
    try {
      return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return "";
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

  function persist(ctx: ExtensionContext) {
    // A snapshot session owns NO gate state and must never write one: the
    // persist path is shared by every tool (propose_loop_goal, set_gate_mode,
    // run_precommit …), so the inert guard lives HERE rather than per tool —
    // writing a sidecar into the snapshot would recreate .pi/ (round Nit).
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
    updateWidget(ctx);
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
  function isJudgeRoleAgent(raw: string): boolean {
    const tail = raw.trim().split(/[\\/]/).pop() ?? raw;
    const name = tail.replace(/\.md$/i, "").trim().toLowerCase();
    return name === "reviewer" || name === "reviewer-readonly" || name === "adviser" || name === "goal-auditor";
  }

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

  /**
   * Max characters of a sensitive path echoed INSIDE the dialog. The path is
   * agent-chosen, so an unbounded one would push the authorization copy out of
   * the row budget; the full path is shown in the transcript instead.
   */
  const SENSITIVE_PATH_DIALOG_MAX_CHARS = 60;

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
   */
  async function confirmBounded(
    uiCtx: { ui?: { confirm?: (title: string, message: string) => Promise<boolean> } },
    title: string,
    message: string,
    pointer?: string,
  ): Promise<boolean> {
    const fitted = pointer === undefined
      ? fitDialogMessage(title, message)
      : fitDialogMessage(title, message, pointer);
    return (await uiCtx.ui?.confirm?.(title, fitted.message)) === true;
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
    // A fresh mode decision supersedes a standing question pause: loop re-arms
    // (or the mode itself turns auto-continuation off for explore/normal).
    delete state.pausedQuestion;
    loopArmed = mode === "loop";
    continuationsInjected = 0;
    completionContinuations = 0;
    loopStall = undefined; // a mode decision is a change of circumstances
    stallNoticeShown = false;
    persist(ctx);
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

  async function checkTestLabels(path: string, content: string): Promise<string | undefined> {
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
      return `review-gate: non-English test label (L6) in ${path}:${v.line}: "${v.label.slice(0, 60)}". ` +
        "Test descriptions must be English. Use `// review-gate: allow-non-english` on the line above to exempt one case.";
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
        verdict = await classifyNonEnglish(classifier(), labels);
        labelCheckMemo.remember(key, verdict);
      }
      if (verdict === true) {
        return `review-gate: test label reads as romanized non-English (L6, semantic check) in ${path}. ` +
          "Test descriptions must be English. Use `// review-gate: allow-non-english` to exempt a deliberate case.";
      }
    }
    return undefined;
  }

  // ---------- L1: tool_call — sensitive files + ship gate ----------

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown>;
    if (EDIT_TOOL_NAMES.has(event.toolName)) {
      const path = coalesceToolPath(input);
      // Match on the NORMALIZED path, not the raw one. `resolve` collapses `.`
      // and `..`, so `.pi/./precommit-cache.json` and `a/../.env` cannot slip
      // past a pattern that anchors on path segments. (The grant lookup below
      // already keyed on the normalized form; matching the raw string here was
      // the inconsistency.)
      const absPath = path ? normalizeSensitivePath(path, cwd) : undefined;
      if (absPath && isSensitiveFile(absPath)) {
        // A live grant means the USER already approved this exact path in a
        // dialog (request_sensitive_edit). It is consumed on the successful
        // tool_result, so the pass here is for one landing edit only.
        // `cwd` (the session cwd), not ctx.cwd: the grant is keyed at
        // request time with the same base, and a mismatched base would make a
        // relative path miss its own grant.
        if (!findGrant(sensitiveGrants, absPath, Date.now())) {
          // absPath in both checks, so the hint matches what the tool would do.
          const askable = !isGateIntegrityPath(absPath) && !sensitiveDeclinedPaths.has(absPath);
          return {
            block: true,
            reason:
              `review-gate: "${path}" matches a sensitive-file pattern (.env/keys/credentials). ` +
              (askable
                ? "Ask the user to edit it themselves, or call request_sensitive_edit to ask them " +
                  "for one-time authorization for this exact path."
                : "Ask the user to edit it themselves — this path cannot be authorized from here."),
          };
        }
      }
      // A snapshot-cwd session is a reviewer the gate itself spawned: the
      // WORKFLOW layers stay inert there (see session_start) — in particular
      // the L8 edit gate must NOT block the reviewer's own mutation analysis.
      // The sensitive-file floor above already ran and stays active in every
      // session type, and the bash ship gate below also stays active (a
      // snapshot is a linked worktree sharing the real .git, so a push from
      // it ships the real repo).
        // Normal mode (“as if not installed” — consent-free first classification,
      // /tmp clamp, no-UI session_start, or later user consent): the L6 label check
      // (and its LLM call) is skipped. The sensitive-file guard ABOVE runs in
      // every mode: it is a security floor, not workflow enforcement.
      if (state.taskMode === "normal") return;
      // Explore mode does NOT block edits: the system prompt asks the agent to
      // prefer read-only work, but small edits during an investigation are
      // allowed. Sensitive-file and L6 label checks above/below stay active.
      //
      // USER REQUIREMENT: a passed edit counts as THIS session's work — from
      // here on, any mode change (including the first classification) goes
      // through the normal consent rules. Blocked edits (sensitive file / L6 /
      // L8 goal) and normal-mode edits do not set it: they change nothing.
      //
      // Gate-owned writes (.pi/, .pi-subagents/) are excluded for the same
      // reason tool_result skips them: everything under those dirs is invisible
      // to a review (excluded from the fingerprint AND from changedFiles), so
      // no edit there is session WORK — the gate's own sidecar, a loop goal, a
      // subagent artifact and the project config alike. Counting them would
      // suppress the "changes pre-date this session" hint and force consent for
      // a mode change the agent never earned. mayBeGateOwned pre-filters on
      // the raw path, so ordinary edits pay no filesystem cost here. The
      // exemption comes BEFORE the L8 goal gate on purpose: without it the
      // gate would deadlock on its own files (the goal file itself, the
      // sidecar, the project config) before a goal can even be approved.
      if (path) {
        const abs = path.startsWith("/") ? path : pathJoin(cwd, path);
        // nearestExistingDir: a write creating a NEW nested gate-owned path
        // (e.g. .pi/plan/state.json) must still resolve its repo instead of
        // losing the exemption to the primary-repo fallback (round P2).
        if (mayBeGateOwned(abs) && isGateOwnedPath(abs, gitRootOfDir(nearestExistingDir(pathDirname(abs))) ?? primaryRepoRoot)) {
          return;
        }
      }
      // L8 edit gate (HARD): in loop mode (or undecided, which behaves as
      // loop) an edit/write call requires a loop goal the USER approved — for
      // THE REPO THE WRITE LANDS IN. The goal must be negotiated BEFORE the
      // work starts: blocking at ship time only is theatre, because by then
      // the agent has already written its own exit contract. Each repo is
      // checked against its own sidecar confirmation, so one repo's approved
      // goal never opens another repo's write surface. Path-less edit calls
      // cannot be attributed to a repo, so they fail closed against the
      // primary repo.
      // (Reaching this line means the write is a normal edit: the sensitive
      // floor passed above and the gate-owned exemption already returned.)
      const goalBlock = loopGoalEditBlockFor(absPath);
      if (goalBlock) return goalBlock;
      // L6 label check. NOTE the ordering: it runs AFTER the gate-owned
      // exemption and the L8 goal gate on purpose — a gate-owned write (.pi/
      // test files included) or a goal-blocked write pays neither the L6
      // classification nor its LLM call.
      if (path) {
        const labelProblem = await checkTestLabels(path, editedTestContent(input, path));
        if (labelProblem) return { block: true, reason: labelProblem };
      }
      sessionEdited = true;
      return;
    }

    // ---------- judge-role subagent block (HARD) ----------
    //
    // 2026-08-27 execution model: judge roles (reviewer / adviser /
    // goal-auditor) run ONLY as tmux judge children (review_spawn), never as
    // subagents. A subagent call naming a judge role is refused here — the
    // agent is told to use the tmux flow instead. This is the INVERTED
    // successor of the snapshot-pin guard: the same failure it blocked (a
    // judge running in the live worktree where the gate looks) is now blocked
    // by removing the dispatch shape entirely.
    const subagentTool = normalizeToolName(event.toolName);
    if (subagentTool === "subagent") {
      const agentName = typeof input.agent === "string" ? input.agent : "";
      // Round-8 P1: the top-level agent field is NOT the only channel — a
      // workflowScript can name a judge role INSIDE its body (runs.run({
      // agent: "reviewer" })), and the sandbox still cannot give per-child
      // isolation. Scan the script text with judgeRoleInScript (the retired
      // guard's own detector, now covering all four judge roles).
      const script = typeof input.workflowScript === "string" ? input.workflowScript : undefined;
      const scriptPath = typeof input.workflowScriptPath === "string" ? input.workflowScriptPath : undefined;
      const scriptText = script !== undefined
        ? script
        : scriptPath !== undefined
          ? (() => {
              try {
                const abs = pathResolve(cwd, scriptPath);
                return readFileSync(abs, "utf8");
              } catch { return undefined; }
            })()
          : undefined;
      const judgeName = (agentName && isJudgeRoleAgent(agentName))
        ? agentName
        : scriptText !== undefined ? judgeRoleInScript(scriptText) : undefined;
      // Round-9 P2: a workflowScriptPath that cannot be read must FAIL CLOSED
      // — the catch above yields undefined and no scan would run, letting an
      // unreadable script dispatch a judge role unchecked.
      const unreadableScript = scriptPath !== undefined && script === undefined && scriptText === undefined;
      if (judgeName || unreadableScript) {
        return {
          block: true,
          reason:
            judgeName
              ? `review-gate: \`${judgeName}\` is a judge role and runs ONLY as a tmux judge child — ` +
                "subagent dispatch for it is retired (2026-08-27 execution model). Use the tmux flow: " +
                "review_checkpoint → prepare_review → review_spawn → review_send → review_watch → " +
                "record_review. (A judge dispatched as a subagent would run in your live worktree " +
                "with no isolation at all — the exact failure the model was built to end.)"
              : "review-gate: workflowScriptPath could not be read, so a judge role inside it cannot be ruled out — failing closed. Read the script, then dispatch non-judge work through it or use the tmux flow for judge roles.",
        };
      }
    }

    if (event.toolName !== "bash") return;
    // Snapshot sessions keep the L1 ship gate ACTIVE (unlike the other inert
    // hooks): a reviewer's disposable copy is a linked worktree sharing the
    // real .git, so `git push`/`git commit` from it ships the real repo. The
    // snapshot's own uncommitted diff then trips the fail-closed sidecar-less
    // check below — exactly what should happen if a reviewer tries to ship.
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return;

    // Normal mode (user-confirmed, or the consent-free /tmp scratchFirstMode
    // first classification which maps loop / missing picks to normal):
    // the ship gate,
    // commit-message checks, and LLM ship classification are all off. This is
    // the mode's defining behavior; explore below never gets this branch.
    if (state.taskMode === "normal") return;

    // /gate-bypass (user-authorized, reason logged in state): the L1 ship gate
    // steps aside for the rest of the session. The git hooks mirror it via
    // REVIEW_GATE_BYPASS=1 for commits made OUTSIDE Pi; inside the session
    // this is the only in-session escape. (Missing before 2026-08-16: the
    // command set state.bypass but L1 never consulted it, so a bypassed
    // session still blocked every ship — only the hooks honored it.)
    if (state.bypass.active) return;

    // Explore mode does NOT block bash — investigations need diagnostic
    // commands. Ship commands below stay FULLY gated in every mode except the
    // normal mode: explore only relaxes auto-continuation and
    // declare_done, never the ship gate.

    // P0-5: detect ALL ship commands, not just the first. Block if ANY operation
    // would ship ungated and warn about compound commands.
    const ships = detectShipCommands(command);

    // P-multi: resolve the repos this command operates on — but ONLY once
    // there is something to check. A plain command (no ship op, not even a
    // suspicious git/gh mention) must not pay for the per-segment git
    // subprocesses in resolveShipRepos.
    if (ships.length === 0
      && !(projectConfig.llmGuards.shipDetect && isSuspiciousShipCandidate(command))) {
      return;
    }
    const resolution = resolveShipRepos(command, cwd);
    const checkRoots = new Set(resolution.repos);
    if (resolution.ambiguous) {
      for (const r of sessionRepos) checkRoots.add(r);
    }
    let anyChange = false;
    for (const root of checkRoots) {
      const st = enforcementStateFor(root);
      if (st) {
        if (st.hasCodeChange || st.hasDocChange) { anyChange = true; break; }
      } else {
        // Sidecar-less repo: uncommitted work still counts as a change so the
        // fail-closed "state missing" check below actually runs (an agent that
        // edited files via bash, not the edit tool, must not short-circuit).
        // changedFiles() returning UNDEFINED (dir missing / bare repo / .git
        // internals) is itself unverifiable — count it as a change so the
        // block loop fails closed instead of silently passing.
        const files = changedFiles(root);
        if ((files && files.length > 0) || files === undefined) { anyChange = true; break; }
      }
    }

    if (ships.length === 0) {
      // Guard #4 additional layer (tighten-only): the static parser saw no ship
      // op, but the command mentions git/gh with dynamic shell constructs the
      // parser cannot resolve (encodings, aliases, substitutions). Ask flash
      // whether it would ship; only a positive answer ADDS a detection — "none"
      // or a failed call changes nothing (the command was passing anyway).
      if (
        projectConfig.llmGuards.shipDetect &&
        anyChange &&
        isSuspiciousShipCandidate(command)
      ) {
        const kind = await classifyShipCommand(classifier(), command);
        if (kind !== undefined && kind !== "none") {
          ships.push({ kind, segment: command });
        }
      }
      if (ships.length === 0) return;
    }

    // Short-circuit: if no changes tracked in any touched repo, no gate to
    // enforce. (A sidecar-less repo with uncommitted work still fails closed
    // in the per-repo check below — it has no state here, so it never
    // short-circuits; the block loop treats it as "state missing".)
    if (!anyChange) return;

    // AI attribution (HARD) + English-language (L5, HARD) checks on commit
    // messages and PR title/description. L5 HARD: a predominantly non-English
    // commit message or PR title/body blocks the ship (the majority-body
    // policy keeps minority foreign tokens passing; the escape hatch is named
    // in every reason so a wrong guess never strands a legitimate commit).
    for (const s of ships) {
      if (s.kind === "commit") {
        const msgs = extractCommitMessages(s.segment);
        for (const msg of msgs) {
          if (COMMIT_MSG_FORBIDDEN.some((re) => re.test(msg))) {
            return {
              block: true,
              reason: "review-gate: commit message contains AI attribution. Rewrite without it.",
            };
          }
        }
        // Guard #2 (tighten-only): regexes missed — ask flash about paraphrased
        // AI attribution ("pair-programmed with an assistant"). Failure → pass
        // (exact pre-LLM behavior).
        if (msgs.length > 0 && projectConfig.llmGuards.aiAttribution) {
          if (await classifyAiAttribution(classifier(), msgs) === true) {
            return {
              block: true,
              reason: "review-gate: commit message contains AI attribution (semantic check). Rewrite without it.",
            };
          }
        }
        // L5 HARD (user policy): predominantly non-English commit messages
        // block the ship — same majority-body policy that used to be advisory
        // only. The escape hatch is named in the reason: a wrong guess must
        // never permanently strand a legitimate commit.
        const nonEn = firstNonEnglish(msgs);
        if (nonEn) {
          return {
            block: true,
            reason:
              `review-gate: commit message is predominantly non-English: "${nonEn.slice(0, 60)}". ` +
              "Commit messages must be English — rewrite it (git commit --amend). " +
              "Escape hatch: the user may run /gate-bypass <reason> (in-session; REVIEW_GATE_BYPASS=1 " +
              "only applies outside the session, at the git-hook layer).",
          };
        } else if (msgs.length > 0 && projectConfig.llmGuards.englishCheck
          && !msgs.some(containsNonLatinLetter)
          && await classifyNonEnglish(classifier(), msgs) === true) {
          // L5 blind spot: the majority-body check passed, but a message that is
          // 100% Latin script may still be romanized non-English (pinyin/romaji).
          // Only run the semantic check when there is NO non-Latin letter at all
          // — a minority foreign word already passes under the majority policy.
          return {
            block: true,
            reason:
              "review-gate: commit message reads as romanized non-English (semantic check). " +
              "Rewrite it in English. Escape hatch: the user may run /gate-bypass <reason> " +
              "(in-session; REVIEW_GATE_BYPASS=1 only applies outside the session).",
          };
        }
      } else if (s.kind === "pr-create" || s.kind === "pr-edit") {
        const prTexts = extractPrTextFields(s.segment);
        const nonEn = firstNonEnglish(prTexts);
        if (nonEn) {
          return {
            block: true,
            reason:
              `review-gate: PR title/description is predominantly non-English: "${nonEn.slice(0, 60)}". ` +
              "PR text must be English — rewrite it (gh pr edit --title/--body). " +
              "Escape hatch: the user may run /gate-bypass <reason> (in-session; REVIEW_GATE_BYPASS=1 " +
              "only applies outside the session, at the git-hook layer).",
          };
        } else if (prTexts.length > 0 && projectConfig.llmGuards.englishCheck
          && !prTexts.some(containsNonLatinLetter)
          && await classifyNonEnglish(classifier(), prTexts) === true) {
          return {
            block: true,
            reason:
              "review-gate: PR title/description reads as romanized non-English (semantic check). " +
              "Rewrite it in English. Escape hatch: the user may run /gate-bypass <reason> " +
              "(in-session; REVIEW_GATE_BYPASS=1 only applies outside the session).",
          };
        }
      }
    }

    // P-multi: check every repo this command ships FROM (checkRoots was
    // already resolved above, before the short-circuits). Each ship segment's
    // repo is checked with ITS OWN sidecar + fingerprint.
    const problems: string[] = [];
    // Label EVERY problem line once more than one repo is in play. An
    // unlabelled "code review gate is PENDING" from the primary repo is what
    // a real multi-repo session read as being about the repo it had just
    // reviewed; single-repo wording is left untouched.
    const multiRepo = checkRoots.size > 1 || knownRepoRoots().length > 1;
    const blockedUnreviewed: string[] = [];
    // Primary-repo fingerprint for the arbiter token path below (kept from the
    // loop so we do not re-hash the primary repo).
    let primaryFp: Fingerprint = { digest: "", head: "", unavailable: true };
    // Lane requirement for THIS command. A commit is local and reversible, so
    // the fast lane satisfies it; anything that publishes (push, gh pr) needs a
    // run whose tests were not narrowed. A compound command is judged by its
    // strictest segment — `git commit && git push` must satisfy the push rule.
    const requireFullTests = ships.some((s) => requiresFullPrecommit(s.kind as ShipCommandKind));
    for (const root of checkRoots) {
      const st = enforcementStateFor(root);
      const fp = computeFingerprint(root);
      if (root === primaryRepoRoot) primaryFp = fp;
      if (st) {
        const unmet = unmetRequirements(st, headCommitTree(root), false, {
          requireDocSync: projectConfig.docSync,
          unreviewedCommits: unreviewedTreesSince(root, st.review),
          requireFullTests,
        });
        for (const p of unmet) {
          problems.push(multiRepo ? `[${repoLabel(root)}] ${p}` : p);
        }
        // Only a repo that is actually holding this ship up is worth pointing
        // the cross-repo hint at; a clean repo that simply never needed a
        // review would make the hint name an innocent bystander.
        if (unmet.length > 0 && st.review.verdict !== "READY") blockedUnreviewed.push(root);
      } else {
        // No sidecar for a non-primary repo: fail-closed when it holds
        // uncommitted work (an unreviewed diff must not ship through a repo
        // that never initialized its gate), but allow ships from a clean repo
        // this session has not touched. changedFiles() returning UNDEFINED
        // (dir missing / bare repo / .git internals) is UNVERIFIABLE — that
        // fails closed too (P0: a mis-parsed fake dir must never sail through
        // on "zero information").
        const files = changedFiles(root);
        if (files && files.length > 0) {
          problems.push(
            `[${repoLabel(root)}] gate state missing (fail-closed) — ${files.length} uncommitted change(s) but no review-gate sidecar; initialize the gate for that repo (edit a file via the edit tool, then review + precommit there) before shipping`,
          );
        } else if (files === undefined) {
          problems.push(
            `[${repoLabel(root)}] worktree unverifiable (fail-closed) — not inside a readable git repository and no review-gate sidecar; refusing to ship there`,
          );
        }
      }
    }
    // L8 — loop mode ships only against a goal the USER approved. The
    // negotiation is the point: without it the agent writes its own exit
    // contract, works to it, and grades itself against it, and a leftover file
    // from a previous task passes for a contract too. Blocking at ship time
    // (rather than at declare_done) is what makes the negotiation happen
    // BEFORE the work lands — by the time `declare_done` runs, the code is
    // already pushed and agreeing on the goal is theatre.
    //
    // L1 only, deliberately: the git hooks judge code facts from the sidecar
    // and cannot see a dialog, so this requirement never enters
    // unmetRequirements() (the ship authority they share).
    if (state.taskMode === "loop" && !loopGoalConfirmed()) {
      problems.push(multiRepo ? `[${repoLabel(primaryRepoRoot)}] ${LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK}` : LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
    }

    if (problems.length === 0) return;

    // Single-use arbiter bypass token (lib/arbitration.ts). Only a lone,
    // in-scope `gh pr edit` (title/body) can EVER match — the token is bound to
    // the exact command + worktree fingerprint + review round + body-file
    // content, and is consumed on the first authorized run. It never bypasses
    // commit/push/pr-create (those are not arbitrable, so no token is ever
    // issued for them) and never touches the code review loop.
    if (ships.length === 1 && ships[0].kind === "pr-edit" && bypassToken && !primaryFp.unavailable) {
      const parsed = parseArbitrableAction(command);
      if (parsed.ok) {
        const bindings = await computeTokenBindings(parsed.action, primaryFp.digest);
        if (tokenAuthorizes(bypassToken, bindings, Date.now())) {
          bypassToken = { ...bypassToken, consumed: true }; // consume on attempt
          clearBypassToken();
          try {
            ctx.ui.notify("review-gate: single-use arbiter bypass consumed for this `gh pr edit`. Re-review after PR text is fixed.", "warning");
          } catch { /* headless */ }
          appendLesson(`arbiter AGENT_WINS bypass consumed: ${desc(command, ships)}`);
          return;
        }
      }
    }

    // Record this block so request_arbitration can only contest a REAL block.
    // The cross-repo hint is part of the recorded text: the arbiter should read
    // exactly what the agent read, and "your READY is on another repo" is the
    // single most relevant fact when a multi-repo block is being contested.
    const blockReason =
      `review-gate: ${desc(command, ships)} blocked — quality gates unmet:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      (ships.length > 1 ? "\nCompound ship commands are unsafe: later operations run after HEAD changes. Split them." : "") +
      crossRepoVerdictHint(blockedUnreviewed);
    lastBlockedShip = { command, problems, blockReason };

    return {
      block: true,
      reason:
        blockReason +
        "\nRun the review loop to clear the gate, or /gate-bypass <reason>." +
        (ships.length === 1 && ships[0].kind === "pr-edit"
          ? "\nIf this block is genuinely CIRCULAR (the only fix requires this exact `gh pr edit`), you may call request_arbitration with your argument."
          : ""),
    };
  });

  // P0-5: describe compound vs single ship for block/lesson messages.
  function desc(_command: string, ships: Array<{ kind: string }>): string {
    return ships.length > 1
      ? `compound command with ${ships.map((s) => s.kind).join(" + ")}`
      : ships[0].kind;
  }

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
  // Everything the gate BELIEVES about a Copilot review is gathered here, by
  // the extension itself: `gh` runs as an argv (never through a shell), in the
  // target repo, with a timeout, and the JSON is interpreted by the pure
  // lib/copilot-review.ts rules. The agent drives the loop but can never
  // report its own review outcome — the same trust split as run_precommit.

  /**
   * Optimistic poll inside check_copilot_review: a few quick retries catch the
   * common "Copilot answered while we were talking" case without turning the
   * tool into a long block. Anything slower is handled by the persistent
   * AWAITING state and the next continuation.
   *
   * Sized against measurements, not folklore: GitHub documents "usually less
   * than 30 seconds", and an observed real review took 2m43s. 3 x 20s covers
   * the documented case in a single tool call without pretending to cover the
   * slow tail.
   */
  const COPILOT_CHECK_ATTEMPTS = 3;
  const COPILOT_CHECK_DELAY_MS = 20000;

  interface GhResult { ok: boolean; stdout: string; stderr: string }

  /**
   * Run one `gh` invocation. Never throws; a missing or failing gh is an
   * ordinary result.
   *
   * ASYNC on purpose, and for the same reason run_precommit is: a synchronous
   * spawn blocks the extension host's event loop, so a slow API call would
   * freeze the session and swallow the user's ESC. The child is killed on
   * timeout and on abort.
   */
  async function runGh(
    argv: string[],
    dir: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<GhResult> {
    const timeoutMs = opts.timeoutMs ?? 30000;
    // Already aborted: an AbortSignal never fires for a listener registered
    // after the fact, so spawning here would run the whole command past the
    // user's ESC. `ok: false` is also the answer every caller must draw from
    // an abort — "could not tell", never a negative finding.
    if (opts.signal?.aborted) {
      return { ok: false, stdout: "", stderr: "aborted before gh started" };
    }
    return await new Promise<GhResult>((resolveResult) => {
      let child: ChildProcess;
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: dir,
          // GH_PAGER="" keeps gh from piping JSON into a pager; NO_COLOR keeps
          // ANSI escapes out of the payloads we parse.
          env: { ...process.env, GH_PAGER: "", NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        resolveResult({ ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) });
        return;
      }
      let out = "";
      let err = "";
      let settled = false;
      const finish = (r: GhResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolveResult(r);
      };
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
      const timer = setTimeout(() => {
        kill();
        finish({ ok: false, stdout: out, stderr: `gh timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      const onAbort = () => { kill(); finish({ ok: false, stdout: out, stderr: "aborted" }); };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", (e: Error) => finish({ ok: false, stdout: out, stderr: e.message }));
      child.on("close", (code: number | null) => finish({ ok: code === 0, stdout: out, stderr: err }));
    });
  }

  /** First meaningful line of gh's stderr, for the tool's explanation text. */
  function ghError(res: GhResult, fallback: string): string {
    const line = res.stderr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    return line ? line.slice(0, 200) : fallback;
  }

  /** The PR for the repo's current branch, or the reason there is none. */
  async function resolveOpenPr(dir: string, signal?: AbortSignal): Promise<{ pr?: PrSummary; error?: string }> {
    // gh's --json field whitelist is version-dependent: `headRefOid` exists
    // only in newer gh builds. Legacy gh (measured: 2.4.0) rejects the modern
    // list with `Unknown JSON field: "headRefOid"` BEFORE even looking up
    // the PR — so only retry with the legacy list when that whitelist error
    // is actually what failed (the decision logic lives in the pure
    // lib/copilot-review.ts decidePrView; it also makes sure THE RETRY's
    // error is reported when it fails — the whitelist error would mask the
    // real cause, e.g. "no pull requests found"). `analyzeCopilot` anchors
    // proof on timestamps when head is absent (documented fallback).
    const modern = await runGh(["gh", "pr", "view", "--json", PR_VIEW_JSON_FIELDS.modern], dir, { signal });
    const decision = decidePrView(
      modern,
      isUnknownJsonFieldError(modern.stderr)
        ? await runGh(["gh", "pr", "view", "--json", PR_VIEW_JSON_FIELDS.legacy], dir, { signal })
        : undefined,
    );
    if (decision.ok) return { pr: decision.pr };
    return { error: decision.error };
  }

  /** owner/name for the repo, preferring gh's own answer over URL parsing. */
  async function resolveRepoSlug(dir: string, pr: PrSummary | undefined, signal?: AbortSignal): Promise<string | null> {
    const res = await runGh(["gh", "repo", "view", "--json", "nameWithOwner"], dir, { signal });
    return (res.ok ? parseNameWithOwner(res.stdout) : null) ?? slugFromPrUrl(pr?.url ?? null);
  }

  /**
   * Ask GitHub for Copilot's review of one PR (reviews + review threads).
   * Variables travel as separate argv values — nothing is interpolated into
   * the query text.
   */
  async function fetchCopilotPayload(
    dir: string,
    slug: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<CopilotPayload | undefined> {
    const [owner, name] = slug.split("/");
    if (!owner || !name) return undefined;
    const res = await runGh([
      "gh", "api", "graphql",
      "-F", `owner=${owner}`,
      "-F", `name=${name}`,
      "-F", `number=${prNumber}`,
      "-f", `query=${COPILOT_THREADS_QUERY}`,
    ], dir, { signal });
    if (!res.ok) return undefined;
    return parseCopilotPayload(res.stdout);
  }

  /**
   * Request the Copilot reviewer.
   *
   * The argv is FIXED — the only variable is a PR number that came out of
   * `gh pr view` as an integer. No agent-authored text can reach this command,
   * which is what makes running a `gh pr edit` (a command the ship gate
   * blocks) sound here: the gate blocks that command because it can carry PR
   * title and body text, and this spelling cannot.
   *
   * Older `gh` builds have no `@copilot` shorthand, so a failure falls back to
   * the documented REST review-request endpoint before giving up.
   */
  async function requestCopilotReviewer(
    dir: string,
    pr: PrSummary,
    slug: string | null,
    signal?: AbortSignal,
  ): Promise<GhResult> {
    const viaCli = await runGh(["gh", "pr", "edit", String(pr.number), "--add-reviewer", "@copilot"], dir, { signal });
    if (viaCli.ok || !slug) return viaCli;
    return await runGh([
      "gh", "api", "--method", "POST",
      `repos/${slug}/pulls/${pr.number}/requested_reviewers`,
      "-f", `reviewers[]=${COPILOT_REVIEWER_LOGIN}`,
    ], dir, { signal });
  }

  /**
   * Availability probe: has Copilot reviewed ANY recent PR in this repo?
   *
   * `undefined` when the answer could not be read (gh missing, API refusal,
   * unparseable payload) — the caller must then assume nothing.
   *
   * Replaces a `suggestedActors` capability probe and a pair of
   * "did the review request land?" read-backs. All three were measured and
   * found unusable: the capability filter answers a different question
   * (assignee, not reviewer) and returned no Copilot on a repo Copilot
   * demonstrably reviews, and a request that GitHub silently drops still
   * leaves `reviewRequests` empty on every surface — gh JSON, GraphQL and
   * REST alike — while both request calls report success. Together they made
   * "unsupported" the near-certain verdict for any PR that had not already
   * been reviewed by Copilot once.
   */
  async function probeCopilotHistory(
    dir: string,
    slug: string | null,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    const [owner, name] = (slug ?? "").split("/");
    if (!owner || !name) return undefined;
    const res = await runGh([
      "gh", "api", "graphql",
      "-F", `owner=${owner}`,
      "-F", `name=${name}`,
      "-F", `count=${COPILOT_HISTORY_PR_COUNT}`,
      "-f", `query=${COPILOT_HISTORY_QUERY}`,
    ], dir, { signal });
    if (!res.ok) return undefined;
    return parseCopilotHistoryProbe(res.stdout);
  }

  /**
   * Decide availability for one repo, cheapest evidence first.
   *
   * Remembered evidence short-circuits the query entirely; the history probe
   * only runs when nothing is known yet. `confirmed` tells the caller whether
   * the answer is worth remembering in the sidecar (policy is not evidence).
   */
  async function resolveCopilotSupport(
    dir: string,
    slug: string | null,
    st: GateState,
    opts: { onPr?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ support: CopilotSupport; confirmed: boolean }> {
    const remembered = st.copilot?.supportConfirmed === true;
    if (remembered || opts.onPr === true) {
      return { support: "CONFIRMED", confirmed: true };
    }
    const history = await probeCopilotHistory(dir, slug, opts.signal);
    const support = decideCopilotSupport({
      history,
      slug,
      owners: projectConfig.copilotReview.owners,
    });
    return { support, confirmed: support === "CONFIRMED" };
  }

  /**
   * The thread list an agent must carry to the user when a cycle is released
   * with findings still open. Released ≠ handled: the gate stops blocking, the
   * agent still owes the user an explanation.
   */
  function copilotUnhandledText(threads: CopilotThread[]): string {
    if (threads.length === 0) return "";
    const lines = threads.slice(0, 20).map((t) =>
      `  - ${t.path ?? "(no file)"}${t.line ? ":" + t.line : ""} — ${t.excerpt}`);
    return `\n${threads.length} Copilot thread(s) are still unhandled — tell the user about them ` +
      `before you finish:\n${lines.join("\n")}`;
  }

  /**
   * The same duty, for the paths that release WITHOUT a readable payload.
   *
   * These are the ones that actually happen: the PR vanished, the slug cannot
   * be resolved, `gh` lost its credentials, the API refused. They release to
   * keep the task moving — and used to do it in total silence, even when the
   * previous check had recorded open Copilot findings. The count is the only
   * thing left (there is no payload to list from), so the count is what gets
   * reported.
   */
  function copilotAbandonedText(prev: CopilotReviewState | undefined): string {
    const open = prev?.openThreads ?? 0;
    if (open <= 0) return "";
    return `\n${open} Copilot thread(s) were still waiting on you at the last check and are now ` +
      "being abandoned unverified — tell the user about them before you finish" +
      `${prev?.pr ? ` (PR #${prev.pr})` : ""}.`;
  }

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
    const goal = readLoopGoal(root);
    if (!goal.present || !st.loopGoal) return false;
    let raw: string;
    try {
      raw = readFileSync(pathJoin(root, LOOP_GOAL_RELPATH), "utf8");
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
   * rest" pointer would dangle — the snapshot carries no `.pi/` any more
   * (see SNAPSHOT_CARRIED_FILES) — so a truncated goal appends the REAL
   * file path instead.
   */
  function goalTextForReviewers(root: string): string | undefined {
    const goal = readLoopGoal(root);
    if (!goal.present) return undefined;
    if (!goal.truncated) return goal.text;
    return goal.text + "\n(全文: " + pathJoin(root, LOOP_GOAL_RELPATH) + ")";
  }
  // ---------- track edits & precommit results ----------

  pi.on("tool_result", async (event, ctx) => {
    // Inert in snapshot sessions (see session_start): a reviewer's own edits
    // inside its disposable copy must not arm or disturb any gate state.
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
        loopArmed = true;
        // The agent resumed working on its own — a standing question pause
        // (pause_for_question) is moot; clear it so the loop enforces again.
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

  pi.registerTool({
    name: "review_checkpoint",
    label: "Review Checkpoint",
    description:
      "Commit the current worktree as a checkpoint commit — the ONLY way to commit before a READY " +
      "review. Requires a precommit PASS (it bypasses READY only, never precommit), validates the " +
      "message is English (L5), commits everything (git add -A), and records the commit sha. " +
      "Every later review round judges baseline..HEAD, so checkpoints are the review unit: commit " +
      "after each batch of fixes, before sending the round to the reviewer.",
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
        return {
          content: [{ type: "text", text: "review-gate: review_checkpoint rejected — commit message contains AI attribution. Rewrite without it." }],
          details: { committed: false },
          isError: true,
        };
      }
      const nonEn = firstNonEnglish([message]);
      if (nonEn) {
        return {
          content: [{
            type: "text",
            text: `review-gate: review_checkpoint rejected — the message is predominantly non-English (\"${nonEn.slice(0, 60)}\"). Write it in English.`,
          }],
          details: { committed: false },
          isError: true,
        };
      }
      const st = stateForRepo(root);
      if (st.precommit.verdict !== "PASS") {
        return {
          content: [{
            type: "text",
            text: `review-gate: review_checkpoint rejected — precommit is ${st.precommit.verdict}; run run_precommit and get a PASS first (a checkpoint bypasses READY only, never precommit).`,
          }],
          details: { committed: false },
          isError: true,
        };
      }
      // Round-4 P2: dev-flow requires the FULL suite (lint + typecheck +
      // build + test) before a checkpoint and 送审 — a fast-lane PASS would
      // otherwise let a round go to review with the suite never run.
      if (st.precommit.testScope !== "full") {
        return {
          content: [{
            type: "text",
            text: `review-gate: review_checkpoint rejected — the precommit PASS covers ${st.precommit.testScope ?? "unknown"}; run run_precommit with mode "full" first (dev-flow: 全量通过才允许送审).`,
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
        st.checkpoint = { sha, prevSha, at: new Date().toISOString() };
        persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{
            type: "text",
            text: `review-gate: checkpoint committed ${sha.slice(0, 12)} — \"${message}\". This commit is the review unit for the next round (baseline..HEAD).` +
              `\n\nCHECKPOINT_SHA=${sha}\nFiles: ${sweptIn.length} — ${sweptIn.slice(0, 20).join(", ")}${sweptIn.length > 20 ? " …" : ""}` +
              "\n\nThe required full precommit already ran typecheck + build + the COMPLETE test suite on this exact content " +
              "(cache: an unchanged input set is reused in seconds — do NOT manually re-run the full suite or `tsc`; " +
              "run only targeted tests for files you keep editing, and let run_precommit be the single full gate).",
          }],
          details: { committed: true, sha },
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

  // ---------- review_spawn / review_send / review_read / review_close ----------

  pi.registerTool({
    name: "review_spawn",
    label: "Spawn Judge Child",
    description:
      "Spawn a judge child (reviewer / adviser / goal-auditor) as its OWN pi process in a tmux pane " +
      "of the main window's right column (pane layout, not a detached session). The child runs with " +
      "no review-gate extension, its role definition + judge protocol as system prompt, the configured " +
      "model, and --exclude-tools edit,write. Returns the pane id and the done/inbox channels; call " +
      "review_watch with the done channel after sending the task so the session is woken when the " +
      "child finishes.",
    parameters: Type.Object({
      role: Type.Enum({ reviewer: "reviewer", adviser: "adviser", "goal-auditor": "goal-auditor" }),
      title: Type.String({
        description: "Human-readable child label (sanitized; prefix 'rg-' is added; done/inbox channels derive from it)",
      }),
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
      const role = String(params.role ?? "");
      if (!JUDGE_ROLES.includes(role as (typeof JUDGE_ROLES)[number])) {
        return {
          content: [{ type: "text", text: `review-gate: review_spawn rejected — unknown role \"${role}\".` }],
          details: { spawned: false },
          isError: true,
        };
      }
      if (!tmuxAvailable()) {
        return {
          content: [{ type: "text", text: "review-gate: review_spawn rejected — tmux is not available on this host. Install tmux (brew install tmux) or review without a judge child." }],
          details: { spawned: false },
          isError: true,
        };
      }
      // P2 (round-6): the title is the RAW label — the rg- prefix is added
      // ONCE by spawnJudgePane and by the channel derivations, so titles and
      // channels never read rg-rg-….
      const title = String(params.title ?? role).replace(/[^A-Za-z0-9._-]/g, "-");
      const workDir = pathJoin(root, ".pi", "tmux-sessions", `rg-${title}`);
      try {
        const { map: agents } = effectiveAgentsConfig(projectConfig.agentsGlobal, projectConfig.agentsProject);
        const files = writeJudgeSpawnFiles({
          repoRoot: root,
          role,
          agents,
          title,
          workDir,
        });
        // Round-7 P2: layout is decided inside spawnJudgePane (no anchor ⇒
        // carve the right column; anchor ⇒ stack) — the caller no longer
        // participates, so the module is the single layout owner.
        const spawned = spawnJudgePane({
          title,
          cwd: root,
          command: files.command,
          env: files.env,
        });
        if (!spawned.ok || !spawned.paneId) {
          return {
            content: [{ type: "text", text: `review-gate: review_spawn failed — ${spawned.error ?? "no pane id"}` }],
            details: { spawned: false },
            isError: true,
          };
        }
        const child: JudgeChild = {
          paneId: spawned.paneId,
          role,
          title,
          doneChannel: doneChannelFor(title),
          inboxChannel: inboxChannelFor(title),
          inboxPath: pathJoin(workDir, "inbox.jsonl"),
          spawnedAt: new Date().toISOString(),
        };
        const list = childSessions.get(root) ?? [];
        list.push(child);
        childSessions.set(root, list);
        return {
          content: [{
            type: "text",
            text: `review-gate: ${role} child spawned as pane ${child.paneId} (${title}).\n` +
              `- done channel: ${child.doneChannel} (register with review_watch after sending the task)\n` +
              `- inbox: ${child.inboxPath}\n` +
              `- system prompt: ${files.sysPromptPath}\n` +
              `Send the task text as a single line referencing its file, then call review_watch.`,
          }],
          details: { spawned: true, paneId: child.paneId, role, title, doneChannel: child.doneChannel, inboxPath: child.inboxPath },
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `review-gate: review_spawn failed — ${reason}` }],
          details: { spawned: false },
          isError: true,
        };
      }
    },
  });

  // ---------- review_watch tool (the wake-up mechanism) ----------

  pi.registerTool({
    name: "review_watch",
    label: "Watch Review Child",
    description:
      "Register a background listener on a judge child's completion channel. When the child runs " +
      "`tmux wait-for -S <channel>` (its protocol requires it after finishing), the listener wakes " +
      "THIS session via pi.sendMessage(triggerTurn) — you are notified without polling. Call once " +
      "per round after sending the task; the wake message names the child. Listeners are cancelled " +
      "on session shutdown.",
    parameters: Type.Object({
      channel: Type.String({
        description: "The done channel the child will signal (e.g. rg-reviewer-done)",
      }),
      label: Type.Optional(Type.String({
        description: "Human-readable child label for the wake message (default: the channel)",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate) {
      const channel = String(params.channel ?? "").trim();
      const label = String(params.label ?? "").trim() || channel;
      if (channel.length === 0) {
        return {
          content: [{ type: "text", text: "review-gate: review_watch rejected — the channel is empty." }],
          details: { watching: false },
          isError: true,
        };
      }
      // One listener per channel; a re-watch replaces the old handle.
      activeWatchers.get(channel)?.cancel();
      const handle = waitForSignalAsync(channel);
      activeWatchers.set(channel, handle);
      handle.promise.then((signalled) => {
        if (activeWatchers.get(channel) === handle) activeWatchers.delete(channel);
        if (!signalled) return;
        // Wake the main session: a custom message with triggerTurn that
        // arrives as a steer — the agent is idle by now (it called this tool
        // and went back to work), so this fires immediately.
        try {
          pi.sendMessage({
            customType: "review-gate",
            content: `[review-gate] 子会话 ${label} 完成（channel ${channel}）— 读取其输出并继续。`,
            display: true,
          }, { triggerTurn: true, deliverAs: "steer" });
        } catch { /* the session may be shutting down — the listener is gone anyway */ }
      });
      return {
        content: [{
          type: "text",
          text: `review-gate: watching ${channel} — 完成信号到达时会主动唤醒本会话（无需轮询）。`,
        }],
        details: { watching: true, channel },
      };
    },
  });

  pi.registerTool({
    name: "review_send",
    label: "Send to Judge Child",
    description:
      "Send ONE single-line message to a judge child pane (Enter is appended). Multi-line content must " +
      "ride a FILE — write it (e.g. under .pi/tmux-sessions/<title>/) and send a one-line reference " +
      "(\"read /path/task.md and execute it\"), because pi's TUI shreds pasted multi-line text into " +
      "one message per line.",
    parameters: Type.Object({
      paneId: Type.String({ description: "The pane id returned by review_spawn (e.g. %103)" }),
      text: Type.String({ description: "Single-line message" }),
    }),
    async execute(_id, params, _signal) {
      const paneId = String(params.paneId ?? "");
      const text = String(params.text ?? "");
      try {
        const ok = sendMessage(paneId, text);
        return {
          content: [{ type: "text", text: ok ? "review-gate: message sent." : "review-gate: send failed — is the pane still alive?" }],
          details: { sent: ok },
          ...(ok ? {} : { isError: true }),
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `review-gate: send rejected — ${err instanceof Error ? err.message : String(err)}` }],
          details: { sent: false },
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "review_read",
    label: "Read Judge Child",
    description:
      "Read a judge child's pane output (plus optional scrollback), its liveness (pane_dead), its cwd, " +
      "and any inbox questions the child posted. The pane is a screen, not a channel: parse it for " +
      "YOUR marker (a verdict fence), never for byte-exact equivalence.",
    parameters: Type.Object({
      paneId: Type.String({ description: "The pane id returned by review_spawn" }),
      history: Type.Optional(Type.Integer({ description: "Scrollback lines before the visible screen (default 0)" })),
    }),
    async execute(_id, params, _signal) {
      const paneId = String(params.paneId ?? "");
      const history = typeof params.history === "number" ? params.history : 0;
      const alive = paneAlive(paneId);
      const output = capturePane(paneId, { history });
      const cwd = paneCurrentPath(paneId);
      const child = [...childSessions.values()].flat().find((c) => c.paneId === paneId);
      let inbox = "";
      if (child) {
        try {
          inbox = existsSync(child.inboxPath) ? readFileSync(child.inboxPath, "utf8") : "";
        } catch { /* inbox is optional */ }
      }
      return {
        content: [{
          type: "text",
          text: `review-gate: pane ${paneId} alive=${alive}${cwd ? ` cwd=${cwd}` : ""}\n` +
            (output !== undefined ? `--- pane output (${history > 0 ? `history ${history} + ` : ""}screen) ---\n${output}` : "--- no pane output (dead?) ---") +
            (child && inbox ? `\n--- inbox ---\n${inbox}` : ""),
        }],
        details: { alive, hasInbox: Boolean(child && inbox) },
      };
    },
  });

  pi.registerTool({
    name: "review_close",
    label: "Close Judge Child",
    description:
      "Kill a judge child's pane and drop it from the session registry. Use it at task completion (before " +
      "declare_done) or to rebuild a child with a fresh perspective; children that crashed keep their " +
      "pane (remain-on-exit) until closed.",
    parameters: Type.Object({
      paneId: Type.String({ description: "The pane id returned by review_spawn" }),
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
    }),
    async execute(_id, params, _signal) {
      const paneId = String(params.paneId ?? "");
      // P2 (round-6): cancel the child's done-channel listener so no wake
      // fires for a dead pane, and no tmux wait-for process leaks.
      const child = [...childSessions.values()].flat().find((c) => c.paneId === paneId);
      if (child) {
        activeWatchers.get(child.doneChannel)?.cancel();
        activeWatchers.get(child.inboxChannel)?.cancel(); // round-7 Nit
      }
      const ok = killPane(paneId);
      for (const [root, list] of childSessions) {
        childSessions.set(root, list.filter((c) => c.paneId !== paneId));
      }
      return {
        content: [{ type: "text", text: ok ? `review-gate: pane ${paneId} closed.` : `review-gate: pane ${paneId} already gone.` }],
        details: { closed: ok },
      };
    },
  });

  pi.registerTool({
    name: "prepare_review",
    label: "Prepare Review",
    description:
      "Compute the review unit (checkpoint baseline..HEAD), write the finding stream path and hand " +
      "back the ready-made task text for the ONE reviewer of this round, plus the tmux spawn flow " +
      "(review_spawn → review_send → review_watch). ALWAYS call this before spawning the reviewer — " +
      "review no longer runs through subagents. One reviewer, one commit range: no split, one " +
      "reviewer — everything the reviewer judges is the whole change in baseline..HEAD. Call " +
      "review_checkpoint first: the reviewed range is defined by the last checkpoint sha.",
    parameters: Type.Object({
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
      const st = stateForRepo(root);
      if (!st.checkpoint?.sha) {
        return {
          content: [{ type: "text", text: "review-gate: prepare_review rejected — no checkpoint on record. Call review_checkpoint first (commit the current work): the reviewed range is baseline..HEAD, and the baseline is the last checkpoint sha." }],
          details: { prepared: false },
          isError: true,
        };
      }
      // Round-8 P1: the baseline is the checkpoint's PARENT (prevSha) — the
      // checkpoint itself is the HEAD under review, so baseline..HEAD is the
      // checkpoint's own commits. Old records without prevSha fall back to
      // `git rev-parse <sha>^`.
      // Round-9 P1 (unreviewed-commit gap): the baseline must be the LAST
      // REVIEWED commit, not the latest checkpoint's parent — two checkpoints
      // since the last READY would otherwise leave the earlier one's content
      // outside every reviewed range while its tree still ships. The READY's
      // commitSha is used when it is an ancestor of HEAD (the normal chain).
      // When it is NOT an ancestor the chain was rewritten (squash/rebase):
      // walk the new chain from the checkpoint's parent to find the SQUASH
      // POINT — the newest commit whose tree equals the reviewed tree — and
      // baseline from there, so the range covers the whole new chain (the
      // squash commit plus every checkpoint after it). No matching tree
      // (a content-changing rebase) falls back to the branch base so the
      // review covers everything.
      const lastReviewed = st.review?.verdict === "READY" ? st.review.commitSha : undefined;
      let baseline: string | undefined;
      if (lastReviewed) {
        try {
          execFileSync("git", ["merge-base", "--is-ancestor", lastReviewed, "HEAD"], { cwd: root, stdio: "ignore" });
          baseline = lastReviewed;
        } catch {
          // Chain rewritten: find the squash point by tree identity (pure
          // logic in lib/review-baseline.ts, pinned by tests — round-12 P2);
          // a clean miss falls back to the branch base, then the checkpoint
          // baseline below.
          baseline = st.checkpoint?.prevSha && st.review.fingerprint
            ? squashPointBaseline(root, st.review.fingerprint, st.checkpoint!.prevSha)
            : undefined;
          if (!baseline) baseline = branchBaseBaseline(root);
        }
      }
      if (!baseline) {
        baseline =
          st.checkpoint.prevSha ||
          (() => {
            try {
              return execFileSync("git", ["rev-parse", `${st.checkpoint!.sha}^`], { cwd: root, encoding: "utf8" }).trim();
            } catch {
              // Round-9 P2 / round-10 Nit: a root commit or an unreachable sha
              // must not throw out of the tool — fall back to the checkpoint
              // sha itself as the baseline (an empty range at worst: the
              // reviewer audits the checkpoint commit alone).
              return st.checkpoint!.sha;
            }
          })();
      }
      let head = "";
      let tree = "";
      try {
        head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
        tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      } catch (err) {
        return {
          content: [{ type: "text", text: `review-gate: prepare_review failed — cannot read HEAD: ${err instanceof Error ? err.message : String(err)}` }],
          details: { prepared: false },
          isError: true,
        };
      }
      if (head === baseline) {
        return {
          content: [{ type: "text", text: "review-gate: prepare_review — HEAD equals the checkpoint baseline, so the range is empty. Call review_checkpoint again after your fixes, then prepare." }],
          details: { prepared: false },
          isError: true,
        };
      }
      const range = `${baseline.slice(0, 12)}..${head.slice(0, 12)}`;
      let files: string[] = [];
      try {
        files = execFileSync("git", ["diff", "--name-only", `${baseline}..${head}`], { cwd: root, encoding: "utf8" })
          .trim().split("\n").filter(Boolean);
      } catch { /* empty file list is still a valid round */ }
      const runId = `review-${Date.now().toString(36)}`;
      const streamPath = pathJoin(root, ".pi", "review-stream", `${runId}-review.jsonl`);
      try { mkdirSync(pathJoin(streamPath, ".."), { recursive: true }); } catch { /* stream is optional */ }
      const goalSt = root === primaryRepoRoot ? state : stateForRepo(root);
      const goalText = loopGoalConfirmed(root, goalSt) ? goalTextForReviewers(root) : undefined;
      const scopeNow = reviewScopeFor(root, st);
      const task = buildReviewPrompt(
        "review",
        files,
        goalText,
        root,
        { streamPath, commitRange: range },
        formatReviewScopeDirective(
          scopeNow,
          previousRoundFindings(st),
          settledConclusion(st),
          "reviewer",
        ),
        scopeNow.scope,
        { dir: sessionDirFor(ctx, cwd), id: st.sessionId ?? "unknown" },
        precommitBaselineFor(root, st),
      );
      // Register the review target: record_review verifies HEAD is still the
      // reviewed commit and binds a READY to the reviewed tree.
      reviewTargets.set(root, { baseline, head, tree });
      const lines = [
        `review-gate: review round ready — range ${range} (${files.length} file(s)).`,
        `stream=${streamPath}`,
        "Spawn the reviewer as a judge child (tmux pane), then send the task and register the wake-up:",
        `- review_spawn({ role: "reviewer", title: "review-${runId.slice(-6)}", repo: "${root}" }) → returns paneId + doneChannel`,
        `- 把下面的任务文本写入文件，然后 review_send({ paneId, text: "读取 <task 文件> 并执行" })`,
        "- review_watch({ channel: <doneChannel> })  ← 完成信号到达时本会话会被主动唤醒",
        "",
        "--- task text ---",
        task,
        "",
        "The reviewer judges the COMMIT RANGE (immutable): you may keep fixing the worktree while it ",
        "works. record_review re-checks that HEAD is still the reviewed commit; a new checkpoint ",
        "after this prepare ⇒ STALE ⇒ BLOCKED.",
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          prepared: true,
          baseline,
          head,
          range,
          fileCount: files.length,
          stream: streamPath,
          files,
        },
      };
    },
  });

  // ---------- prepare_adviser tool (incremental advisory — goal criterion 3) ----------

  /** The session dir pi is ACTUALLY using: the live manager knows the final
   *  --session-dir / env / settings selection (round-10 P1). Fallbacks stay
   *  in lib/session-dir.ts for contexts without a manager.
   */
  function sessionDirFor(ctx: unknown, cwd: string): string {
    const sm = (ctx as { sessionManager?: { getSessionDir?: () => string } })?.sessionManager;
    return sessionDirForCwd(cwd, undefined, sm?.getSessionDir?.());
  }

  /**
   * The LAST conclusion an adviser appended for this goal, if any. Lines are
   * JSON; malformed ones are skipped and only a conclusion for THIS goal
   * (the artifact is named per goal, so this is belt-and-braces) counts.
   */
  function readLastAdviserConclusion(artifactPath: string, goalHash: string): AdviserConclusion | undefined {
    try {
      return parseAdviserConclusions(readFileSync(artifactPath, "utf8"), goalHash);
    } catch { /* no artifact yet */ }
    return undefined;
  }

  // sessionDirForCwd lives in lib/session-dir.ts (realpath-resolved, matching
  // pi's session-manager encoding — round-4 P1) so it is unit-testable.

  /**
   * The trusted-checks block for the reviewer's task text: what precommit
   * already verified (sidecar verdict + cache steps), so the reviewer does
   * not re-run the full suite.
   *
   * SAFETY (round-9 P1): the baseline is only trusted when the recorded PASS
   * is bound to the CURRENT worktree fingerprint — a PASS for an older tree
   * proves nothing about this change, and claiming it would suppress exactly
   * the verification this round needs. Cache entries recorded AFTER the PASS
   * itself are skipped (they belong to a later tree). Undefined when no
   * matching PASS is on record — the reviewer then decides on its own.
   */
  function precommitBaselineFor(root: string, st: GateState): string | undefined {
    let digest: string | undefined;
    try {
      const fp = computeFingerprint(root);
      digest = fp.unavailable ? undefined : fp.digest;
    } catch { digest = undefined; }
    let cacheRaw: string | undefined;
    try { cacheRaw = readFileSync(pathJoin(root, ".pi", "precommit-cache.json"), "utf8"); } catch { /* no cache */ }
    // The pure decision (fingerprint match + stale-entry filter + wording) is
    // in lib/parallel-review.ts so the safety behavior is testable.
    return extractPrecommitBaseline(st.precommit, digest, cacheRaw);
  }

  pi.registerTool({
    name: "prepare_adviser",
    label: "Prepare Adviser Brief",
    description:
      "Hand back the ready-made task text for an `adviser` subagent consultation on the CURRENT loop goal. " +
      "Call this before dispatching `adviser`: the brief carries (a) the main session's transcript location " +
      "for ON-DEMAND reading (the adviser runs context:\"fresh\" — it no longer inherits a fork of this " +
      "conversation), (b) the artifact path where the adviser appends its conclusion, and (c) when a " +
      "previous consultation of this goal exists, that conclusion plus the files changed since, so the " +
      "adviser settles what already stands instead of re-arguing it from zero. First consultation of a " +
      "goal is a full brief.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = resolveToolRepo(params.repo);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const st = stateForRepo(target.root);
      // goalText (display) may be capped for the prompt; the ARTIFACT identity
      // must hash the FULL approved text, or distinct long goals would share
      // one conclusion file (round-4 P1).
      const confirmed = loopGoalConfirmed(target.root, st);
      // Identity hashes the RAW FILE content, never the capped display text:
      // readLoopGoal() truncates past LOOP_GOAL_MAX_CHARS, and two distinct
      // long goals must not share one conclusion artifact (round-5 P1).
      let fullGoalRaw: string | undefined;
      try { fullGoalRaw = readFileSync(pathJoin(target.root, LOOP_GOAL_RELPATH), "utf8"); } catch { /* no goal file */ }
      const goalText = confirmed ? goalTextForReviewers(target.root) : undefined;
      const goalHash = confirmed && fullGoalRaw
        ? goalTextHash(fullGoalRaw)
        // No approved goal: a STABLE per-session identity (sessionId is set at
        // session start; "anon" is the defensive fallback) so repeated
        // consultations within one session reuse each other's conclusions —
        // a fresh random id every call would defeat the incremental contract.
        : `no-goal-${st.sessionId ?? "anon"}`;
      const artifactPath = pathJoin(target.root, ".pi", "review-stream", `adviser-${goalHash}.jsonl`);
      // The artifact must be writable on the FIRST consultation too — review
      // snapshots create this directory, but an adviser consult can precede
      // any review.
      try { mkdirSync(pathDirname(artifactPath), { recursive: true }); } catch { /* best-effort */ }
      const previous = readLastAdviserConclusion(artifactPath, goalHash);
      // Baseline advance is CONFIRMATION-BASED (round-3 P1): the baseline must
      // never advance past a consultation that appended no conclusion — its
      // examined changes would silently vanish from the next brief while an
      // older conclusion is carried forward. The gate cannot observe the
      // adviser's write, so it counts VALID conclusions in the artifact:
      //   - count > baseline.confirmed ⇒ the last consultation SUCCEEDED ⇒
      //     changed files are computed against baseline.tree (that consult's
      //     START) and the baseline advances;
      //   - count ≤ baseline.confirmed ⇒ the last consultation ABORTED ⇒
      //     compute against baseline.prevTree (the last CONFIRMED start) so
      //     its changes are re-listed, and do NOT advance. prevTree null ⇒
      //     nothing is confirmed yet (cross-session first advance) ⇒ full
      //     re-check (round-4 P1).
      const artifactRaw = (() => {
        try { return readFileSync(artifactPath, "utf8"); } catch { return ""; }
      })();
      const confirmedCount = countAdviserConclusions(artifactRaw, goalHash);
      const baseline = st.adviserBaselines?.[goalHash];
      const baseTree = baseline
        ? confirmedCount > baseline.confirmed ? baseline.tree : baseline.prevTree
        : undefined;
      let changedFiles: string[] | null = null;
      if (!baseTree) {
        // No baseline for this goal in this state. An OLDER conclusion may
        // still exist (cross-session artifact): the increment vs it cannot be
        // computed, so demand a full re-check (null) — never pretend "no
        // changes" against a conclusion this session never saw.
        changedFiles = previous ? null : [];
      } else {
        const inc = incrementSinceTree(target.root, baseTree);
        if (inc) changedFiles = inc.files;
        // else: stays null → brief demands a full check
      }
      // Advance ONLY on confirmed success (a conclusion beyond the last
      // count). prevTree = the start the just-confirmed consultation read
      // (baseline.tree), so an aborted NEXT consultation rolls back to
      // exactly this confirmed point instead of hiding its changes.
      if (!baseline || confirmedCount > baseline.confirmed) {
        try {
          const treeNow = headCommitTree(target.root);
          st.adviserBaselines = {
            ...(st.adviserBaselines ?? {}),
            [goalHash]: { tree: treeNow, prevTree: baseline ? baseline.tree : null, confirmed: confirmedCount },
          };
        } catch { /* keep the old baseline */ }
      }
      persistRepo(ctx as unknown as ExtensionContext, target.root);
      const brief = buildAdviserBrief({
        goalHash,
        sessionDir: sessionDirFor(ctx, cwd),
        sessionId: st.sessionId ?? "unknown",
        artifactPath,
        ...(previous ? { previous } : {}),
        changedFiles,
        ...(goalText ? { goalText } : {}),
      });
      return {
        content: [{ type: "text", text: `adviser brief ready (${previous ? "incremental" : "full"}):\n\n${brief}` }],
        details: { incremental: !!previous, artifactPath, changedFiles },
      };
    },
  });

  // ---------- prepare_goal_audit tool (the auditor's ready-made task, PRE-dispatch) ----------

  pi.registerTool({
    name: "prepare_goal_audit",
    label: "Prepare Goal Audit Task",
    description:
      "Hand back the ready-made task text for a `goal-auditor` audit of a DRAFT loop goal — call this BEFORE " +
      "dispatching the auditor. The task carries the draft, the audit criteria, the fresh-context transcript " +
      "pointer, and — when a previous audit of a DIFFERENT draft is on record — the carryover block (previous " +
      "verdict + findings + previous draft) and the mechanically computed draft delta, so a re-audit judges " +
      "the increment instead of re-deriving the whole contract. record_goal_prereview stays a pure record; " +
      "this is where the task text comes from.",
    parameters: Type.Object({
      goal: Type.String({ description: "The FULL draft goal text to be audited (the exact text you will submit)" }),
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const target = resolveToolRepo(params.repo);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const draft = normalizeGoalText(String(params.goal ?? ""));
      if (!draft) {
        return {
          content: [{ type: "text", text: "review-gate: prepare_goal_audit rejected — the goal text is empty." }],
          details: {},
          isError: true,
        };
      }
      const st = stateForRepo(target.root);
      const newHash = goalTextHash(draft);
      const prev = st.goalPrereview;
      const carryover = prev && prev.hash !== newHash ? formatGoalPrereviewCarryover(prev) : undefined;
      const taskText = buildGoalAuditTask(draft, {
        ...(carryover ? { carryover } : {}),
        ...(prev?.draft ? { prevDraft: prev.draft } : {}),
        sessionDir: sessionDirFor(ctx, cwd),
        sessionId: st.sessionId ?? "unknown",
      });
      return {
        content: [{ type: "text", text: `goal-auditor task ready (${carryover ? "re-audit with carryover" : "first audit"}):\n\n${taskText}` }],
        details: { reaudit: !!carryover, hash: newHash.slice(0, 12) },
      };
    },
  });
  // ---------- record_review tool ----------

  pi.registerTool({
    name: "record_review",
    label: "Record Review",
    description:
      "Record the verdict of an independent code/doc review. Pass the FULL raw output of a REAL, " +
      "independent reviewer run (do not hand-write the verdict). The gate parses every JSON fence " +
      "(worst verdict wins). Call after every review round.",
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

      // The agent is running the loop again — a standing pause_for_question
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
      st.rounds.push({
        round: st.rounds.length + 1,
        findingsTotal: parsed.findingsTotal,
        fingerprints: parsed.findingFingerprints,
        verdict: parsed.verdict,
        at: new Date().toISOString(),
      });
      // Observability: what this round cost and how much of the change it had
      // to judge. The duration is an UPPER BOUND — the reviewer is a subagent
      // the extension never sees, so all it can measure is the wall clock
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
          "the review is not converging. Escalate to the user or consult the adviser subagent " +
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
                "current head (review_checkpoint → prepare_review → review_spawn → record_review)."
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

  // ---------- review tooling: change collection + snapshot materialization ----------

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

  pi.registerTool({
    name: "run_precommit",
    label: "Run Precommit",
    description:
      "Run the trusted precommit checks and record the verdict. This is the ONLY way to " +
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
    async execute(_id, params, _signal, _onUpdate, ctx) {
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
      // `_onUpdate` streams the runner's log while it runs (plan preamble first,
      // then each check's output) — a precommit used to be a silent multi-minute
      // tool call with no way to see what it was doing.
      const outcome = await runTrustedPrecommit(targetDir, targetRoot, mode, _signal, _onUpdate);

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
    description: "Declare the current task complete. Re-validates all gates server-side; rejects if unmet.",
    parameters: Type.Object({
      summary: Type.String({ description: "One-paragraph completion summary" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // P-multi: completion requires EVERY repo this session has edited to
      // pass its own review + precommit — a multi-repo task is not done while
      // any of its repos still holds unreviewed work.
      const problems: string[] = [];
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

      // Residual judge children (execution-model standard 5): a task is not
      // done while a judge child session is still open — its context may hold
      // a pending verdict or an unanswered inbox question, and dropping it
      // silently strands a pane (and its expensive model context). The round
      // must be closed out with record_review / review_close first. In loop
      // mode this is a hard requirement; explore/normal report it as
      // advisory via the branch below.
      for (const [root, list] of childSessions) {
        if (list.length > 0) {
          problems.push(`[${repoLabel(root)}] ${list.length} judge child session(s) still open (` +
            `${list.map((c) => c.paneId).join(", ")}) — finish the round (record_review / review_close) ` +
            "before declaring done");
        }
      }

      // L7/L8 — completion-only requirements. Neither is in
      // unmetRequirements(): the Copilot loop needs commits to make progress
      // (gating ships on it would deadlock it), and the goal approval is a
      // dialog fact the git hooks cannot see. Both still decide whether the
      // TASK is finished, which is exactly what this tool answers.
      const completionProblems: string[] = [];
      for (const root of sessionRepos) {
        const st = root === primaryRepoRoot ? state : stateForRepo(root);
        for (const p of copilotProblemsFor(st)) {
          completionProblems.push(root === primaryRepoRoot ? p : `[${repoLabel(root)}] ${p}`);
        }
      }
      if (state.taskMode === "loop" && !loopGoalConfirmed()) {
        completionProblems.push(LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
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
        return {
          content: [{
            type: "text",
            text: "review-gate: declare_done REJECTED — gates unmet:\n" +
              problems.map((p) => `  - ${p}`).join("\n") +
              "\nComplete the loop (fix → review → record_review → precommit) and try again." +
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
      loopArmed = false;
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
        st.strategicResetFired = false;
        if (root !== primaryRepoRoot) persistRepo(ctx as unknown as ExtensionContext, root);
      }
      state.rounds = [];
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
        content: [{ type: "text", text: `review-gate: done accepted. ${params.summary}` }],
        details: { accepted: true },
      };
    },
  });

  // ---------- record_goal_prereview tool (L8b — the goal-auditor's verdict) ----------

  pi.registerTool({
    name: "record_goal_prereview",
    label: "Record Goal Pre-review",
    description:
      "Record the dedicated `goal-auditor` subagent's audit of a DRAFT loop goal. propose_loop_goal " +
      "refuses to show the user's approval dialog until this records a PASS for the IDENTICAL text, " +
      "so the flow is: draft (in Simplified Chinese) → call `prepare_goal_audit` for the ready-made " +
      "auditor task (carryover + draft delta on a re-audit) → dispatch goal-auditor with it → record " +
      "its FULL raw output here → propose_loop_goal. The EXTENSION parses the auditor's JSON fence " +
      "itself (PASS only for a READY verdict; a fence with unresolved P0/P1 is already downgraded to " +
      "BLOCKED) and hashes the draft itself — there is no `passed` parameter you could set, and a " +
      "hand-written verdict is not a review. A FAIL means: fix the objections, re-audit the revised " +
      "text (its hash differs, so it needs its own PASS).",
    parameters: Type.Object({
      goal: Type.String({ description: "The FULL draft goal text that was audited (the exact text you will submit)" }),
      auditor_output: Type.String({ description: "Complete raw output from the goal-auditor subagent" }),
      repo: Type.Optional(Type.String({
        description:
          "Absolute path of the repo this goal binds to (default: the session repo) — must match the " +
          "repo you pass to propose_loop_goal.",
      })),
      auditStartedAt: Type.Optional(Type.String({
        description:
          "ISO timestamp of when you DISPATCHED the goal-auditor (the wall-clock start of this audit). " +
          "Goal criterion 6 records first-vs-re-audit durations, and the gate cannot see the dispatch " +
          "— the tool only records verdicts. Omit on re-records of the same audit.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const goalText = normalizeGoalText(String(params.goal ?? ""));
      if (goalText.length === 0) {
        return {
          content: [{ type: "text", text: "review-gate: record_goal_prereview rejected — the goal text is empty." }],
          details: { recorded: false },
          isError: true,
        };
      }
      // Same cap as propose_loop_goal: auditing a draft the approval tool can
      // never accept would burn a full audit round to produce a PASS that is
      // structurally unusable.
      if (goalText.length > LOOP_GOAL_MAX_WRITE_CHARS) {
        return {
          content: [{
            type: "text",
            text: `review-gate: record_goal_prereview rejected — the goal is ${goalText.length} chars, over the ` +
              `${LOOP_GOAL_MAX_WRITE_CHARS} limit propose_loop_goal enforces. Shorten it BEFORE auditing: an ` +
              "exit contract is 3–7 checkable criteria, not a design doc.",
          }],
          details: { recorded: false },
          isError: true,
        };
      }
      // SAME resolution as propose_loop_goal, deliberately NOT resolveToolRepo:
      // that helper requires a repo the session already EDITED, but a goal (and
      // therefore its audit) is recorded before the first edit lands. Using it
      // here would make a second repo's goal impossible to pre-review — a dead
      // end with no way out.
      let goalRoot = primaryRepoRoot;
      const rawRepo = String(params.repo ?? "").trim();
      if (rawRepo) {
        const abs = pathResolve(cwd, rawRepo);
        const root = gitRootOfDir(abs);
        if (!root) {
          return {
            content: [{
              type: "text",
              text: `review-gate: repo "${rawRepo}" (resolved ${abs}) is not inside a readable git repository — ` +
                "a goal pre-review can only bind to a real repo.",
            }],
            details: { recorded: false },
            isError: true,
          };
        }
        goalRoot = root;
      }
      const goalSt = goalRoot === primaryRepoRoot ? state : stateForRepo(goalRoot);

      // The EXTENSION reads the verdict; the agent only carries the output.
      // parseReviewOutput already encodes the two rules that matter here: a
      // READY carrying unresolved P0/P1 is contradictory and becomes BLOCKED,
      // and a fence we could not fully parse can never come back READY.
      const parsed = parseReviewOutput(params.auditor_output);
      if (!parsed) {
        return {
          content: [{
            type: "text",
            text: "review-gate: no recognizable verdict in the goal-auditor's output — NOTHING was recorded " +
              "(fail-closed). The auditor must end its reply with exactly ONE fenced JSON verdict, e.g.\n" +
              `\`\`\`json\n{"gate":"READY"|"BLOCKED","findings":[{"severity":"P1","issue":"…"}]}\n\`\`\`\n` +
              "Common causes: the reply was pure prose with no fence, it was truncated before the fence, " +
              "or an unescaped straight quote inside a string broke the JSON. Re-run the audit — do not " +
              "hand-write the verdict.",
          }],
          details: { recorded: false },
          isError: true,
        };
      }
      const passed = parsed.verdict === "READY";
      const newHash = goalTextHash(goalText);
      const findings = parseFenceFindings(params.auditor_output);
      // Wall-clock duration of THIS audit, when the agent reported when it
      // dispatched the auditor (goal criterion 6). Parsed leniently: a bogus
      // timestamp records no duration rather than failing the record.
      const startedAt = typeof params.auditStartedAt === "string" ? Date.parse(params.auditStartedAt) : NaN;
      // A future timestamp (clock skew, a typo) records NO duration rather
      // than a negative one that would poison the timing diagnostic.
      const now = Date.now();
      const durationMs = Number.isFinite(startedAt) && startedAt > 0 && startedAt <= now ? now - startedAt : undefined;
      const record: GoalPrereviewRecord = {
        hash: newHash,
        verdict: passed ? "PASS" : "FAIL",
        at: new Date().toISOString(),
        findingsTotal: parsed.findingsTotal,
        ...(findings.length ? { findings } : {}),
        draft: normalizeGoalText(goalText),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      // Re-audit carryover (goal criterion 2): replacing a record for a
      // DIFFERENT draft means this audit is a re-audit — hand the previous
      // verdict and its findings back so the agent can put them in the
      // auditor's task text. Same-hash re-records (a PASS retried) carry
      // nothing: there is no revised draft to judge.
      const prev = goalSt.goalPrereview;
      const carryover = prev && prev.hash !== newHash ? formatGoalPrereviewCarryover(prev) : undefined;
      // Latest-only for the CHECK (propose_loop_goal matches the CURRENT
      // draft's PASS), but EVERY audit is persisted in the history (goal
      // criterion 2: PASS or FAIL, oldest first) so the re-audit chain and
      // its carryover data survive newer drafts.
      goalSt.goalPrereviewHistory = [...(goalSt.goalPrereviewHistory ?? []), record];
      goalSt.goalPrereview = record;
      if (goalRoot === primaryRepoRoot) persist(ctx as unknown as ExtensionContext);
      else persistRepo(ctx as unknown as ExtensionContext, goalRoot);
      log(`goal pre-review recorded for ${goalRoot}: ${record.verdict} (${goalText.length} chars, findings: ${parsed.findingsTotal ?? "unparseable"})`);
      // Wall-clock since the previous audit — the incremental-economy datum
      // (goal criterion 6, (a)): re-audits of a revised draft should be
      // measurably cheaper than first audits. Diagnostic only.
      const prevAt = prev?.at ? Date.parse(prev.at) : NaN;
      const auditGapMin = Number.isFinite(prevAt)
        ? Math.round((Date.now() - prevAt) / 60000)
        : null;
      return {
        content: [{
          type: "text",
          text:
            (passed
              ? `review-gate: goal pre-review PASS recorded (${record.hash.slice(0, 12)}…). Call propose_loop_goal with ` +
                "the IDENTICAL text — any edit changes the hash and needs a fresh audit."
              : `review-gate: goal pre-review FAIL recorded (verdict ${parsed.verdict}, ` +
                `${parsed.findingsTotal ?? "unparseable"} findings). propose_loop_goal stays blocked: fix the ` +
                "auditor's P0/P1 objections, then re-audit the revised draft.") +
            (durationMs !== undefined
              ? `\n(This audit took ${Math.round(durationMs / 1000)}s — report auditStartedAt to record durations.)`
              : "") +
            (auditGapMin !== null
              ? `\n(Re-audit: ${auditGapMin} min since the previous audit of a different draft.)`
              : "") +
            (carryover
              ? "\nRe-audit context: call `prepare_goal_audit` with the REVISED draft BEFORE dispatching the " +
                "auditor — it returns the ready-made task with this audit's carryover and the draft delta."
              : "")
        }],
        details: { recorded: true, verdict: record.verdict, findingsTotal: parsed.findingsTotal ?? null, reaudit: !!carryover, auditGapMin, durationMs: durationMs ?? null },
      };
    },
  });

  // ---------- propose_loop_goal tool (L8 — the user approves the contract) ----------

  pi.registerTool({
    name: "propose_loop_goal",
    label: "Propose Loop Goal",
    description:
      "Submit the NEGOTIATED loop goal (this session's exit contract) for the user's approval. " +
      "Interview the user first — ONE question per turn, labeled \"N of M\", each with your " +
      "recommended answer (all at once only when the user asks for it) — and only " +
      "submit what they actually agreed to. Write the goal in SIMPLIFIED CHINESE (technical " +
      "identifiers, paths and code tokens stay English). REQUIRED FIRST: the draft must pass a " +
      "dedicated `goal-auditor` audit recorded via record_goal_prereview — this tool refuses " +
      "(no dialog at all) unless the sidecar holds a PASS for the IDENTICAL text. " +
      "The extension shows the text in a confirmation " +
      "dialog and, if the user approves, writes .pi/loop-goal.md itself and records the approval. " +
      "Writing that file yourself grants nothing: in loop mode an unapproved goal blocks " +
      "commit/push/PR and its body is withheld from your prompt. Shape: task title, one-line " +
      "intent, 3–7 checkable exit criteria, non-goals, ISO date. `repo` selects WHICH repo the " +
      "goal binds to (default: this session's repo) — a multi-repo session approves a goal per " +
      "repo before editing there; one repo's approval never opens another's write surface.",
    parameters: Type.Object({
      goal: Type.String({ description: "The full goal text (Markdown) as agreed with the user" }),
      repo: Type.Optional(Type.String({
        description:
          "Absolute path of the repo this goal binds to (default: the session repo). Required to " +
          "unlock edit/write in a SECOND repo the session works in.",
      })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const goalText = normalizeGoalText(String(params.goal ?? ""));
      if (goalText.length === 0) {
        return {
          content: [{ type: "text", text: "review-gate: propose_loop_goal rejected — the goal text is empty." }],
          details: { approved: false },
          isError: true,
        };
      }
      if (goalText.length > LOOP_GOAL_MAX_WRITE_CHARS) {
        return {
          content: [{
            type: "text",
            text: `review-gate: propose_loop_goal rejected — the goal is ${goalText.length} chars, over the ` +
              `${LOOP_GOAL_MAX_WRITE_CHARS} limit. An exit contract is 3–7 checkable criteria, not a design doc.`,
          }],
          details: { approved: false },
          isError: true,
        };
      }
      // Per-repo binding: the goal belongs to the repo the WRITES land in.
      // Default is the session repo; a multi-repo session passes `repo` so
      // each repo gets its own contract (the L8 edit gate checks each repo's
      // own goal + sidecar confirmation, so without this a second repo could
      // never be unlocked — the block message would point at a dead end).
      // Deliberately NOT resolveToolRepo: that helper requires the target to
      // be a repo the session has ALREADY edited, but the whole point of the
      // goal is to be approved BEFORE the first edit lands.
      let goalRoot = primaryRepoRoot;
      const rawRepo = String(params.repo ?? "").trim();
      if (rawRepo) {
        const abs = pathResolve(cwd, rawRepo);
        // A goal bound to a NON-repo path could never satisfy the edit gate
        // (it checks gitRootOfDir of the target write) — that would be a dead
        // approval, and writing .pi/ into an arbitrary directory is worse.
        // Refuse instead of silently recording it.
        const root = gitRootOfDir(abs);
        if (!root) {
          return {
            content: [{
              type: "text",
              text: `review-gate: repo \"${rawRepo}\" (resolved ${abs}) is not inside a readable git repository — ` +
                "a loop goal can only bind to a real repo.",
            }],
            details: { approved: false },
            isError: true,
          };
        }
        goalRoot = root;
      }
      const goalSt = goalRoot === primaryRepoRoot ? state : stateForRepo(goalRoot);

      // L8b GOAL PRE-REVIEW — fail-closed, and BEFORE any user-facing surface.
      // The user should only ever be asked about a draft a dedicated auditor
      // already judged: without this the pre-review was protocol the agent
      // could simply skip, and the dialog is exactly what it would skip it for.
      // Placed ahead of showToUser/confirm so a refusal costs the user nothing
      // — no transcript spam, no dialog, no file write.
      if (!goalPrereviewPassed(goalSt.goalPrereview, goalText)) {
        const packageAgentsDir = resolvePackageAgentsDir();
        // Dispatchability is what matters, not a filename: pi-subagents keys
        // agents by their frontmatter `name`, so a copy called custom.md that
        // declares `name: goal-auditor` IS dispatchable and must not be
        // reported as missing. EVERY layer is resolved that way — the same
        // rule gate-doctor applies — so the two never disagree.
        const auditorInstalled =
          findProjectAgentText(pathJoin(homedir(), ".pi", "agent", "agents"), "goal-auditor") !== undefined ||
          // Both project layers are consulted: pi-subagents loads them from the
          // SESSION's project root, while a multi-repo goal binds to goalRoot —
          // checking only one of them would show (or hide) the bootstrap hint
          // against the wrong directory. This flag is advisory copy only; it
          // never affects the refusal itself.
          [pathJoin(goalRoot, ".pi", "agents"), pathJoin(primaryRepoRoot, ".pi", "agents")]
            .some((dir) => findProjectAgentText(dir, "goal-auditor") !== undefined);
        return {
          content: [{
            type: "text",
            text: buildGoalPrereviewRefusal({
              ...(goalSt.goalPrereview ? { record: goalSt.goalPrereview } : {}),
              goalText,
              auditorInstalled,
              repoRoot: goalRoot,
              packageAgentsDir,
            }),
          }],
          details: { approved: false, prereview: goalSt.goalPrereview?.verdict ?? "NONE" },
          isError: true,
        };
      }
      // The goal text goes to the TRANSCRIPT; the binding repo must be shown
      // at CONSENT time (both surfaces), so a repo-scoped approval is never
      // given for a repo the user was not shown.
      const repoLine = goalRoot === primaryRepoRoot
        ? "本仓库 (" + primaryRepoRoot + ")"
        : goalRoot;

      // Consent comes from a dialog the EXTENSION renders — there is no
      // parameter the model could set to claim it. No UI ⇒ no approval; a
      // session without a UI is forced to normal mode at session_start, so
      // reaching this branch means the UI disappeared, not a headless run.
      const uiCtx = ctx as unknown as ExtensionContext;
      // The goal itself is shown in the TRANSCRIPT first: it is the thing the
      // user has to read, and it is far too tall for a dialog (that is what
      // made the terminal flicker). ui.notify renders synchronously, so it is
      // on screen BEFORE the dialog below asks about it; the dialog that
      // follows carries only the decision.
      // The pre-review fact is shown to the USER too: the approval is more
      // informed when it is visible that an independent auditor already passed
      // THIS text. It goes AFTER the repo line on purpose — the dialog budget
      // truncates from the tail, and the repo binding is the consent-critical
      // fact that must never be the thing that gets cut.
      // The record is guaranteed to exist here: goalPrereviewPassed() above
      // already required a PASS bound to this text, so this reads it directly
      // rather than advertising a fallback state that cannot occur.
      const prereviewLine = "goal-auditor 预审: PASS @ " + goalSt.goalPrereview!.at;
      showToUser(
        uiCtx,
        GOAL_CONFIRM_TITLE,
        buildGoalTranscriptMessage(goalText) + "\n\n本次目标绑定的仓库: " + repoLine + "\n" + prereviewLine,
      );
      let approved = false;
      try {
        approved = await confirmBounded(
          uiCtx,
          GOAL_CONFIRM_TITLE,
          buildGoalConfirmMessage(goalText, "绑定仓库(不可信数据): " + repoLine + "\n" + prereviewLine),
          "（目标全文见上方消息）",
        );
      } catch {
        approved = false;
      }
      // The decision may carry a REASON — but only on REJECTION: the user
      // rejects with the objection so the agent renegotiates against the real
      // problem instead of re-asking. The CONFIRM path no longer asks for a
      // reason (the approval is the whole signal; a per-approval input box was
      // friction with nothing to act on). Reason input is best-effort — a
      // headless/no-input environment simply yields no reason.
      let reason: string | undefined;
      if (!approved) {
        try {
          const typed = await uiCtx.ui?.input?.(
            "拒绝原因(将转达给 AI 供重新协商;留空则退回通用提示)",
            "必填:哪里不合适",
          );
          reason = (typed ?? "").trim() || undefined;
        } catch {
          reason = undefined;
        }
      }
      if (!approved) {
        return {
          content: [{
            type: "text",
            text: "review-gate: the user did NOT approve this goal." +
              (reason
                ? ` Reason: ${reason}. Renegotiate against THAT objection and submit the corrected goal again — `
                : " Ask what is wrong with it, renegotiate, and submit the corrected goal again — ") +
              "do not start shipping work in the meantime.",
          }],
          details: { approved: false, reason: reason ?? null },
        };
      }

      // The EXTENSION writes the file: an approval must describe the text the
      // user saw, not text the agent might swap in afterwards. The path lives
      // in the gate-owned .pi/ scope, so this write never moves the worktree
      // fingerprint and cannot invalidate a READY review or a precommit PASS.
      const goalPath = pathJoin(goalRoot, LOOP_GOAL_RELPATH);
      try {
        mkdirSync(pathDirname(goalPath), { recursive: true });
        writeFileSync(goalPath, goalText + "\n", "utf8");
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `review-gate: could not write ${LOOP_GOAL_RELPATH} (${e instanceof Error ? e.message : String(e)}). ` +
              "The approval was NOT recorded.",
          }],
          details: { approved: false },
          isError: true,
        };
      }
      goalSt.loopGoal = { hash: goalTextHash(goalText), at: new Date().toISOString(), ...(reason ? { reason } : {}) };
      if (goalRoot === primaryRepoRoot) persist(uiCtx);
      else persistRepo(uiCtx, goalRoot);
      log(`loop goal approved by the user for ${goalRoot} (${goalText.length} chars${reason ? `, reason: ${reason}` : ""})`);
      return {
        content: [{
          type: "text",
          text: `review-gate: goal approved and written to ${LOOP_GOAL_RELPATH} (repo: ${goalRoot}). Work to it; if it has to ` +
            "change, renegotiate with the user and call propose_loop_goal again (editing the file " +
            "yourself drops the approval and blocks shipping)." +
            (reason ? `\nUser's note on approval: ${reason}` : ""),
        }],
        details: { approved: true, reason: reason ?? null },
      };
    },
  });

  // ---------- L7 Copilot review tools (trusted: the extension runs gh) ----------

  pi.registerTool({
    name: "request_copilot_review",
    label: "Request Copilot Review",
    description:
      "Ask GitHub Copilot to review the current branch's pull request. Call this after a PR was " +
      "created or updated (the gate arms the requirement on a successful gh pr create / gh pr " +
      "edit / git push). The extension resolves the PR, requests the review itself, and stamps " +
      "the authoritative request time. If the repo or account cannot do Copilot code review (no " +
      "gh, no GitHub remote, no PR, API refusal) the requirement is released as UNSUPPORTED.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Absolute path of the repository (required once the session edited several repos)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      // resolveToolRepo takes only `requested`; a second "tool name" argument
      // was being passed and silently dropped (TS2554, now caught by
      // `npm run typecheck`). The resolver's error already lists every
      // candidate repo, so the tool name added nothing to it.
      const target = resolveToolRepo(params.repo);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const root = target.root;
      const st = root === primaryRepoRoot ? state : stateForRepo(root);
      if (!copilotEnabled(st)) {
        return {
          content: [{ type: "text", text: "review-gate: the Copilot review loop is off for this repo/mode — nothing to do." }],
          details: { status: "DISABLED" },
        };
      }
      const nowIso = new Date().toISOString();
      const dir = repoDirFor(root);
      // No round budget any more. The old pre-flight check released the cycle
      // as EXHAUSTED once `rounds` hit the cap — i.e. it stopped asking about
      // Copilot's comments because the conversation had gone on a while. The
      // only bound left is the wait timeout, which fires when there is no
      // feedback to lose.

      const resolved = await resolveOpenPr(dir, signal);
      if (!resolved.pr) {
        const abandoned = copilotAbandonedText(st.copilot);
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          `no Copilot review possible: ${resolved.error}`, nowIso);
        persistRepo(ctx as unknown as ExtensionContext, root);
        log(`copilot cycle released UNSUPPORTED on request: ${resolved.error}`);
        return {
          content: [{
            type: "text",
            text: `review-gate: no Copilot review for this repo — ${resolved.error}. Requirement released ` +
              "(UNSUPPORTED); it is not blocking completion." + abandoned,
          }],
          details: { status: "UNSUPPORTED" },
        };
      }
      const pr = resolved.pr;
      const slug = await resolveRepoSlug(dir, pr, signal);
      // Availability, from evidence, BEFORE spending a round. Not a veto: the
      // request goes out either way (it is cheap, and a repo nobody has asked
      // yet can only start producing evidence once someone asks). It decides
      // how long a silent Copilot is worth waiting for.
      const support = await resolveCopilotSupport(dir, slug, st, { signal });
      const requested = await requestCopilotReviewer(dir, pr, slug, signal);
      if (!requested.ok) {
        // An abort is the user pressing ESC, not GitHub refusing: it proves
        // nothing about Copilot, so it must not release the requirement.
        if (signal?.aborted) {
          return {
            content: [{
              type: "text",
              text: "review-gate: aborted before the Copilot review request completed — nothing " +
                "recorded; call request_copilot_review again.",
            }],
            details: { ...(st.copilot ? { status: st.copilot.status } : {}), pr: pr.number },
          };
        }
        const why = ghError(requested, "the review request was refused");
        const abandoned = copilotAbandonedText(st.copilot);
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          `Copilot review could not be requested: ${why}`, nowIso, pr.head);
        persistRepo(ctx as unknown as ExtensionContext, root);
        log(`copilot cycle released UNSUPPORTED on request for PR #${pr.number}: ${why}`);
        return {
          content: [{
            type: "text",
            text: `review-gate: Copilot code review is not available for PR #${pr.number} — ${why}. ` +
              "Requirement released (UNSUPPORTED)." + abandoned,
          }],
          details: { status: "UNSUPPORTED", pr: pr.number },
        };
      }
      // NOTE: no read-back here on purpose. Measured on a repository where
      // GitHub drops the request: `gh pr edit --add-reviewer @copilot` exits
      // 0, REST POST answers 200, and `reviewRequests` stays empty on all
      // three surfaces with no ReviewRequestedEvent in the timeline. A
      // read-back therefore cannot distinguish "dropped" from "not visible
      // yet", and using it as a veto declared healthy repos unsupported.
      // Availability is judged by evidence (above) and by whether a review
      // actually shows up (check_copilot_review).
      st.copilot = recordCopilotRequest(st.copilot, {
        pr: pr.number,
        head: pr.head,
        nowIso,
        supportConfirmed: support.confirmed,
      });
      persistRepo(ctx as unknown as ExtensionContext, root);
      loopArmed = true;
      log(`copilot review requested for PR #${pr.number} (round ${st.copilot.rounds}, ` +
        `availability ${support.support})`);
      const waitNote = support.support === "UNKNOWN"
        ? "No Copilot review has ever appeared on this repository's recent PRs and its owner is not " +
          "on the allow-list, so if nothing comes back the requirement is released instead of " +
          "waiting."
        : "Copilot usually answers within a minute.";
      return {
        content: [{
          type: "text",
          text: `review-gate: Copilot review requested for PR #${pr.number} (round ${st.copilot.rounds}). ` +
            `${waitNote} Call check_copilot_review to see whether it answered, and what it left open.`,
        }],
        details: {
          status: "AWAITING",
          pr: pr.number,
          rounds: st.copilot.rounds,
          support: support.support,
        },
      };
    },
  });

  pi.registerTool({
    name: "check_copilot_review",
    label: "Check Copilot Review",
    description:
      "Check what GitHub Copilot's review of the current PR left open. The extension queries the " +
      "reviews and review threads itself — you cannot report this outcome yourself. A thread " +
      "counts as handled when it is resolved OR when the last comment in it is yours (the " +
      "explanation of why it will not be fixed). Returns AWAITING (Copilot has not answered yet), " +
      "OPEN (threads still waiting on you, listed with their IDs) or SATISFIED.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Absolute path of the repository (required once the session edited several repos)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const target = resolveToolRepo(params.repo);
      if ("error" in target) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const root = target.root;
      const st = root === primaryRepoRoot ? state : stateForRepo(root);
      if (!copilotEnabled(st)) {
        return {
          content: [{ type: "text", text: "review-gate: the Copilot review loop is off for this repo/mode — nothing to check." }],
          details: { status: "DISABLED" },
        };
      }
      // Already released: SATISFIED / UNSUPPORTED / EXHAUSTED are decisions,
      // not snapshots. Re-running the checks here would spend gh calls to
      // re-derive a state the gate has already let go — and, before the state
      // machine grew its terminal short-circuit, could resurrect it and block
      // `declare_done` on a requirement that was finished.
      const settled = st.copilot;
      if (settled && !isCopilotOutstanding(settled)) {
        return {
          content: [{
            type: "text",
            text: `review-gate: the Copilot requirement is already released (${settled.status})` +
              `${settled.note ? ` — ${settled.note}` : ""}. It is not blocking completion; checking ` +
              "again changes nothing. A fresh round starts only on a new push / PR update, or if you " +
              "deliberately call request_copilot_review again." +
              // A cycle can be released with findings still open (any of the
              // fail-safe paths below). Repeating the reminder here means the
              // duty survives a re-check instead of scrolling away.
              copilotAbandonedText(settled),
          }],
          details: {
            status: settled.status,
            ...(settled.pr === null ? {} : { pr: settled.pr }),
            ...(settled.openThreads ? { unhandled: settled.openThreads } : {}),
          },
        };
      }
      const dir = repoDirFor(root);
      const resolved = await resolveOpenPr(dir, signal);
      if (!resolved.pr) {
        const abandoned = copilotAbandonedText(st.copilot);
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          `no Copilot review possible: ${resolved.error}`, new Date().toISOString());
        persistRepo(ctx as unknown as ExtensionContext, root);
        log(`copilot cycle released UNSUPPORTED on check: ${resolved.error}`);
        return {
          content: [{
            type: "text",
            text: `review-gate: no pull request to check — ${resolved.error}. Requirement released ` +
              "(UNSUPPORTED)." + abandoned,
          }],
          details: { status: "UNSUPPORTED" },
        };
      }
      const pr = resolved.pr;
      const slug = await resolveRepoSlug(dir, pr, signal);
      if (!slug) {
        const abandoned = copilotAbandonedText(st.copilot);
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          "could not determine the GitHub owner/repo for this PR", new Date().toISOString());
        persistRepo(ctx as unknown as ExtensionContext, root);
        log(`copilot cycle released UNSUPPORTED on check: no owner/repo for PR #${pr.number}`);
        return {
          content: [{
            type: "text",
            text: "review-gate: could not determine owner/repo for this PR. Requirement released " +
              "(UNSUPPORTED)." + abandoned,
          }],
          details: { status: "UNSUPPORTED" },
        };
      }

      // Short optimistic poll for the fast path (GitHub documents "usually
      // less than 30 seconds"). The REAL waiting mechanism is the persistent
      // AWAITING state plus the L2 continuation: blocking a tool call for
      // minutes would burn the turn and ignore an ESC in the meantime.
      let payload: CopilotPayload | undefined;
      let next = st.copilot ?? armCopilotReview(undefined, new Date().toISOString());
      let support: CopilotSupport = "CONFIRMED";
      let supportResolved = false;
      for (let attempt = 0; attempt < COPILOT_CHECK_ATTEMPTS; attempt++) {
        if (signal?.aborted) break;
        payload = await fetchCopilotPayload(dir, slug, pr.number, signal);
        if (payload) {
          const analysis = analyzeCopilot(payload, { anchorAt: next.requestedAt ?? next.armedAt });
          // Availability is only worth a query when the PR itself shows
          // nothing yet, and only once per call. Copilot on THIS PR is the
          // strongest evidence there is, and it costs no API call at all.
          if (!supportResolved || analysis.present) {
            const decided = await resolveCopilotSupport(dir, slug, st, {
              onPr: analysis.present,
              signal,
            });
            support = decided.support;
            supportResolved = true;
            if (decided.confirmed) next = { ...next, supportConfirmed: true };
          }
          next = evaluateCopilot(
            next,
            analysis,
            {
              nowIso: new Date().toISOString(),
              now: Date.now(),
              support,
            },
          );
          next = { ...next, pr: pr.number };
          if (next.status !== "AWAITING") break;
        }
        if (attempt < COPILOT_CHECK_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, COPILOT_CHECK_DELAY_MS));
        }
      }

      if (!payload) {
        // The GraphQL query failed outright (no gh, no permission, API down).
        // Releasing is the fail-SAFE direction here: this requirement must
        // never strand a task over an unreachable API. What it must NOT do is
        // go quiet about findings an earlier check already found.
        const abandoned = copilotAbandonedText(st.copilot);
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          "the Copilot review query failed (gh missing, unauthenticated, or API refusal)", new Date().toISOString());
        persistRepo(ctx as unknown as ExtensionContext, root);
        log(`copilot cycle released UNSUPPORTED on check: thread query failed for PR #${pr.number}`);
        return {
          content: [{
            type: "text",
            text: "review-gate: could not read the PR's review threads (gh missing, unauthenticated, " +
              "or API refusal). Requirement released (UNSUPPORTED)." + abandoned,
          }],
          details: { status: "UNSUPPORTED" },
        };
      }

      st.copilot = next;
      persistRepo(ctx as unknown as ExtensionContext, root);
      if (isCopilotOutstanding(next)) loopArmed = true;
      log(`copilot check for PR #${pr.number}: ${next.status} (availability ${support}` +
        `${next.note ? `, ${next.note}` : ""})`);

      const analysis = analyzeCopilot(payload, { anchorAt: next.requestedAt ?? next.armedAt });
      const lines = analysis.actionable.slice(0, 20).map((t) =>
        `  - ${t.id} ${t.path ?? "(no file)"}${t.line ? ":" + t.line : ""}` +
        `${t.isOutdated ? " [outdated — the code moved; if that fixed it, resolve the thread]" : ""}\n      ${t.excerpt}`);
      const text = next.status === "OPEN"
        ? `review-gate: PR #${pr.number} — ${analysis.actionable.length} Copilot thread(s) waiting on you ` +
          `(${analysis.resolved} resolved, ${analysis.answered} answered):\n${lines.join("\n")}\n` +
          "For each: fix it and resolve the thread, or reply in the thread with the reason it will " +
          "not be fixed. Resolve: gh api graphql -f query='mutation($t:ID!){resolveReviewThread" +
          "(input:{threadId:$t}){thread{isResolved}}}' -F t=<threadId>. Reply: " +
          "gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply" +
          "(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' -F t=<threadId> -F b='<why>'. " +
          "Then call check_copilot_review again."
        : next.status === "AWAITING"
          ? `review-gate: Copilot has not posted its review of PR #${pr.number} yet. Do something useful and ` +
            "call check_copilot_review again in a minute."
          // Released with a readable payload. `evaluateCopilot` puts
          // actionable threads ahead of every release, so this list is
          // normally empty — it is kept as the belt to the sidecar-count
          // braces used by the fail-safe paths above, and it costs one call
          // on data that is already in hand.
          : `review-gate: Copilot review of PR #${pr.number} — ${next.note ?? next.status}.` +
            copilotUnhandledText(analysis.actionable);
      return {
        content: [{ type: "text", text }],
        details: {
          status: next.status,
          pr: pr.number,
          actionable: analysis.actionable.length,
          resolved: analysis.resolved,
          answered: analysis.answered,
          support,
        },
      };
    },
  });

  // ---------- pause_for_question tool (agent-requested loop pause) ----------

  pi.registerTool({
    name: "pause_for_question",
    label: "Pause For Question",
    description:
      "Pause the review-gate auto-continuation loop because you hit a GENUINE blocker only the " +
      "user can resolve (ambiguous requirement, a product/design decision between valid options, " +
      "missing credentials or access). Waiting on the user's answer to a question you already " +
      "asked — e.g. the grill questions while negotiating the loop goal — is such a blocker: " +
      "call this instead of re-asking. The extension shows the `question` parameter to the user " +
      "IN FULL, as a notification in the transcript, so do NOT repeat it " +
      "in your reply — write one short line pointing at it (\"see the question above\") or add only " +
      "the context the parameter does not carry, then END the turn. If the tool result says the " +
      "question could NOT be shown, write it out in your reply instead. The pause " +
      "clears automatically on the user's next message. The " +
      "ship gate is NOT affected — git commit/push and gh pr stay blocked while gates are unmet. " +
      "Do NOT use this to ask permission to continue routine loop work, to skip a review round, " +
      "or to end the task — those remain prohibited.",
    parameters: Type.Object({
      question: Type.String({
        description:
          "The COMPLETE question the user must answer, including the options and your recommendation. " +
          "It is rendered to the user verbatim, so it must stand on its own — your reply should not restate it.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const question = params.question.trim();
      if (!question) {
        return {
          content: [{ type: "text", text: "review-gate: pause rejected — provide the actual question the user must answer." }],
          details: {},
          isError: true,
        };
      }
      // THE POINT OF THIS TOOL IS THAT THE USER SEES THE QUESTION.
      //
      // REGRESSION THIS FIXES: the question used to be stored in
      // `state.pausedQuestion` and nowhere else, while the tool result told the
      // agent it had been "delivered to the user verbatim". The agent duly
      // wrote "see the question above" — and the user saw a bare warning with no
      // question in it. Every channel that claims delivery must actually
      // deliver, and the result text below reports what really happened.
      const banner = "───── AI 需要你回答 ─────\n";
      const askUser = (lead: string): boolean => showToUser(ctx, lead, banner + question);
      // Honesty extends to the edges: a question past the notice cap is shown
      // CLIPPED, so the agent is told to carry the rest itself rather than
      // being assured the user saw everything. The banner is part of what
      // showToUser measures, so it is part of what decides "clipped".
      const clipped = banner.length + question.length > USER_NOTICE_MAX_CHARS;
      const deliveryNote = (delivered: boolean) => !delivered
        ? "WARNING: the question could NOT be shown (no interactive UI). Write " +
          "the COMPLETE question out in your reply instead, then END the turn."
        : clipped
        ? `WARNING: the question exceeded the ${USER_NOTICE_MAX_CHARS}-character notice cap and was ` +
          "shown CLIPPED. Put whatever was cut off in your reply, keep future questions shorter, " +
          "then END the turn."
        : "Your question was shown to the user in full, so do NOT repeat it in your reply. Write " +
          "one short line pointing at it (or only the context the parameter did not carry) and " +
          "END the turn.";

      // Explore/normal have no auto-continuation to pause — the agent can
      // simply ask and end its turn. Informational no-op, never an error.
      if (state.taskMode === "explore" || state.taskMode === "normal") {
        const delivered = askUser(`review-gate: AI 有一个问题在等你回答（${state.taskMode} 模式，本来就没有自动循环）。`);
        return {
          content: [{
            type: "text",
            text: `review-gate: no enforced loop in "${state.taskMode}" mode — auto-continuation is already off. ${deliveryNote(delivered)}`,
          }],
          details: { mode: state.taskMode, delivered },
        };
      }
      if (state.pausedQuestion) {
        const delivered = askUser("review-gate: AI 又提了一个问题（循环已处于暂停中）。");
        return {
          content: [{
            type: "text",
            text: "review-gate: the loop is ALREADY paused for an earlier question, so this call did not " +
              `change the pause state. ${deliveryNote(delivered)}`,
          }],
          details: { alreadyPaused: true, delivered },
        };
      }
      // Loop (or undecided → behaves as loop): record the pause. Persisted so
      // it survives a restart while waiting; the ship gate ignores it entirely
      // (unmetRequirements never reads pausedQuestion — tighten-only).
      state.pausedQuestion = { question: question.slice(0, 2000), at: new Date().toISOString() };
      loopArmed = false;
      persist(ctx as unknown as ExtensionContext);
      const delivered = askUser("review-gate: AI 申请暂停循环等待你的回答 — 你的下一条消息会自动恢复循环（ship 命令仍被拦截）。");
      return {
        content: [{
          type: "text",
          text:
            "review-gate: loop PAUSED — auto-continuation is off until the user's next message. " +
            `${deliveryNote(delivered)} Do not keep working. ` +
            "Ship commands stay blocked while gates are unmet. The pause clears automatically when the " +
            "user replies (or on your next code/doc edit).",
        }],
        details: { paused: true, delivered },
      };
    },
  });

  // ---------- request_scope_limit tool (user-consented gate fence narrowing) ----------

  pi.registerTool({
    name: "request_scope_limit",
    label: "Request Scope Limit",
    description:
      "Ask the USER whether the review gate may be limited to THIS session's own edits when it " +
      "is demanding coverage of PRE-EXISTING changes (dirty files or branch commits that pre-date " +
      "this session). The extension shows the user a confirmation dialog — you cannot approve it " +
      "yourself. If the user agrees, the pre-existing changes recorded at grant time stop arming " +
      "the gate: with no session edits the ship gate disarms entirely; with session edits the " +
      "review scope narrows to the files this session touched (instruct the reviewer accordingly; " +
      "out-of-scope findings become advisory). If the user declines, scope requests lock for the " +
      "session — do not ask again. This never weakens the gate for the session's OWN edits.",
    parameters: Type.Object({
      reason: Type.String({ description: "One-line justification: which unmet requirements target pre-existing changes (shown to the user as untrusted data)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });

      if (state.taskMode === "normal") {
        return { content: [{ type: "text", text: "review-gate: normal mode — the gate is already off; no scope limit needed." }], details: {} };
      }
      if (state.scopeLimit) {
        return {
          content: [{ type: "text", text: "review-gate: a user-granted scope limit is already active — the gate covers only this session's edits." }],
          details: { alreadyLimited: true },
        };
      }
      if (scopeLimitDeclined) {
        return deny("review-gate: the user already DECLINED a scope limit this session — do not ask again; satisfy the full gate or let the USER run /gate-bypass.");
      }
      if (!ctx.hasUI) {
        return deny("review-gate: no interactive UI — narrowing the gate fence requires the user's explicit dialog approval (fail-closed). Ask the user out-of-band.");
      }
      const all = changedFiles(cwd);
      if (all === undefined) {
        return deny("review-gate: git status unavailable — cannot determine the pre-existing change set (fail-closed).");
      }
      const sessionRel = [...sessionEditedPaths];
      const sessionSet = new Set(sessionRel);
      // Only code/doc files arm the gate, so only they justify a dialog — but
      // the exemption snapshot below covers EVERY non-session changed file.
      const preexisting = all.filter((f) => (isCodeFile(f) || isDocFile(f)) && !sessionSet.has(f));
      const ahead = await commitsAheadOfBase(cwd);
      if (preexisting.length === 0 && ahead === 0) {
        return deny("review-gate: every current change was made in THIS session — there is nothing pre-existing to exempt; the full gate applies.");
      }

      // USER CONSENT — extension-rendered dialog with fixed consequence copy;
      // the agent's reason is displayed as clearly-labeled untrusted data.
      //
      // The file LISTS go to the transcript, not the dialog: twenty paths is
      // easily twenty rendered rows, which is exactly the geometry that makes
      // the terminal flicker (lib/dialog-budget.ts). The dialog keeps the
      // counts and the consequences.
      const preexistingList = preexisting.slice(0, 20).join(", ") || "（仅分支上已有的提交）";
      const sessionList = sessionRel.length > 0 ? sessionRel.slice(0, 20).join(", ") : "（无）";
      const moreP = preexisting.length > 20 ? `（另有 ${preexisting.length - 20} 个未列出）` : "";
      const moreS = sessionRel.length > 20 ? `（另有 ${sessionRel.length - 20} 个未列出）` : "";
      showToUser(
        ctx,
        "review-gate: AI 请求缩小审查范围——涉及的文件如下。",
        `既有变更 ${preexisting.length} 个（同意后不再触发门禁）: ${preexistingList}${moreP}` +
        (ahead > 0 ? `\n分支领先基线 ${ahead} 个提交` : "") + "\n" +
        `本会话修改 ${sessionRel.length} 个（仍需完整审查）: ${sessionList}${moreS}\n` +
        `AI 给出的理由（未经核实）: ${params.reason.slice(0, 300)}`,
      );
      let ok = false;
      let dialogFailed = false;
      try {
        ok = await confirmBounded(
          ctx as unknown as ExtensionContext,
          "review-gate: AI 请求把审查范围缩小到本会话的修改——是否同意？",
          "门禁当前要求覆盖【本会话之前就存在】的修改。\n" +
            `既有变更 ${preexisting.length} 个` +
            (ahead > 0 ? `，分支领先基线 ${ahead} 个提交` : "") +
            `；本会话修改 ${sessionRel.length} 个（清单见上方消息）。\n` +
            "同意后：审查只需覆盖本会话自己的修改；若本会话没有任何修改，ship 拦截将解除。\n" +
            "拒绝后：AI 本会话内不能再次请求缩小范围。",
          "（清单与理由见上方消息）",
        );
      } catch { dialogFailed = true; }

      // A dialog that could not be shown is NOT a decline: fail closed for
      // THIS request without burning the session's anti-grinding lock.
      if (dialogFailed) {
        return deny(
          "review-gate: the confirmation dialog could not be shown — no scope limit granted (fail-closed), " +
          "and this does NOT count as a user decline; retry when an interactive dialog is possible.",
        );
      }

      if (!ok) {
        scopeLimitDeclined = true;
        return deny(
          "review-gate: the user DECLINED the scope limit — the FULL gate applies (pre-existing " +
          "changes included). Scope requests are now locked for this session; continue the loop and cover everything.",
        );
      }

      // GRANTED: snapshot EVERY non-session changed file as exempt (non-code
      // files never arm the gate, but freezing the full set keeps later
      // re-arm filtering unambiguous), then re-derive arming from THIS
      // session's own edits only. Verdicts/bindings are untouched — narrowing
      // the fence never fabricates a READY or a PASS.
      state.scopeLimit = {
        preexistingFiles: all.filter((f) => !sessionSet.has(f)),
        sessionFiles: sessionRel,
        at: new Date().toISOString(),
      };
      state.hasCodeChange = sessionRel.some(isCodeFile);
      state.hasDocChange = sessionRel.some(isDocFile);
      persist(ctx as unknown as ExtensionContext);
      const stillArmed = state.hasCodeChange || state.hasDocChange;
      try {
        ctx.ui.notify(
          stillArmed
            ? "review-gate: 用户已同意缩小审查范围——门禁只覆盖本会话的修改（既有变更已豁免）。"
            : "review-gate: 用户已同意缩小审查范围——本会话没有自身修改，ship 拦截已解除（既有变更已豁免）。",
          "warning",
        );
      } catch { /* headless */ }
      return {
        content: [{
          type: "text",
          text: stillArmed
            ? "review-gate: the user GRANTED the scope limit. The gate now covers ONLY this session's edits: " +
              `${sessionRel.join(", ")}. When you run the review, instruct the reviewer to verdict only on ` +
              "findings in these files — pre-existing issues elsewhere are advisory, not blocking. Precommit " +
              "still runs project-wide; if it fails on pre-existing problems, report that to the user (only " +
              "the USER can /gate-bypass)."
            : "review-gate: the user GRANTED the scope limit and this session has no edits of its own — the " +
              "ship gate is disarmed for the pre-existing changes; you may proceed.",
        }],
        details: { granted: true, stillArmed, sessionFiles: sessionRel },
      };
    },
  });

  // ---------- request_sensitive_edit tool (user-consented one-shot sensitive write) ----------

  pi.registerTool({
    name: "request_sensitive_edit",
    label: "Request Sensitive File Edit",
    description:
      "Ask the USER for one-time authorization to edit ONE sensitive file (.env, private key, " +
      "credentials…) that the gate blocks by default. The extension shows a confirmation dialog — " +
      "you cannot approve it yourself. A granted authorization covers that EXACT path only, is " +
      "consumed by the first edit that SUCCEEDS, and expires after 10 minutes; it is never " +
      "persisted, so it dies with the session. The gate's OWN enforcement is NEVER grantable: " +
      "`.git/` internals (the L3 hooks) and `.pi/review-gate-state.json` / " +
      "`.pi/precommit-cache.json` (the verdicts and the already-passed record a commit is checked " +
      "against). If the user declines, that path is locked for the session — " +
      "do not ask again, ask the user to edit it by hand. Call this only when the edit is genuinely " +
      "required by the user's request, and state exactly what you will change.",
    parameters: Type.Object({
      path: Type.String({ description: "The sensitive file to edit — absolute, or relative to the session cwd" }),
      reason: Type.String({ description: "One line: what you will change in this file and why (shown to the user as untrusted data)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });

      const raw = params.path.trim();
      if (raw.length === 0) return deny("review-gate: path is required — name the exact file you need to edit.");
      const absPath = normalizeSensitivePath(raw, cwd);

      if (!isSensitiveFile(absPath)) {
        return deny(
          `review-gate: "${raw}" is not a sensitive file — the gate does not block it. Edit it directly; ` +
          "no authorization is needed.",
        );
      }
      // Gate-integrity paths are refused BEFORE any dialog: a "yes" here would
      // let the agent talk the user into disarming the L3 hook that checks it.
      if (isGateIntegrityPath(absPath)) {
        return deny(
          `review-gate: "${raw}" is part of the gate's own enforcement — never authorizable from ` +
          "here. `.git/hooks/*` IS the L3 layer, and `.pi/review-gate-state.json` / " +
          "`.pi/precommit-cache.json` are the verdicts and the already-passed record a commit is " +
          "checked against. A dialog here would be the agent asking permission to disarm its own " +
          "gate. If this change is really needed, the USER must make it by hand.",
        );
      }
      if (sensitiveDeclinedPaths.has(absPath)) {
        return deny(
          `review-gate: the user already DECLINED editing "${raw}" this session — do not ask again. ` +
          "Tell the user what the file needs and let them edit it themselves.",
        );
      }
      const existing = findGrant(sensitiveGrants, absPath, Date.now());
      if (existing) {
        return {
          content: [{
            type: "text",
            text:
              `review-gate: "${raw}" is already authorized (until ` +
              `${new Date(existing.expiresAt).toISOString()}). Make the edit now — the authorization ` +
              "is consumed once it succeeds.",
          }],
          details: { alreadyGranted: true, path: absPath },
        };
      }
      if (!ctx.hasUI) {
        return deny(
          "review-gate: no interactive UI — writing a sensitive file requires the user's explicit dialog " +
          "approval (fail-closed). Ask the user out-of-band to make the edit.",
        );
      }

      // USER CONSENT — extension-rendered dialog with fixed consequence copy;
      // the agent's reason is displayed as clearly-labeled untrusted data.
      //
      // The full path and reason go to the transcript first; the dialog gets a
      // TAIL-truncated path and the reason last, so a pathological path (the
      // agent picks it) can never push the authorization copy out of a
      // budget-bounded dialog.
      const shownPath = absPath.length > SENSITIVE_PATH_DIALOG_MAX_CHARS
        ? "…" + absPath.slice(-SENSITIVE_PATH_DIALOG_MAX_CHARS)
        : absPath;
      showToUser(
        ctx,
        "review-gate: AI 请求一次性修改敏感文件——完整信息如下。",
        `文件（完整路径）: ${absPath}\n` +
        `AI 给出的理由（未经核实）: ${params.reason.slice(0, 300)}`,
      );
      let ok = false;
      let dialogFailed = false;
      try {
        ok = await confirmBounded(
          ctx as unknown as ExtensionContext,
          "review-gate: AI 请求一次性修改敏感文件——完整信息如下。",
          `文件（完整路径）: ${absPath}\n` +
          `AI 给出的理由（未经核实）: ${params.reason.slice(0, 300)}\n` +
          "同意后：只授权这一个路径，写入成功一次即失效；10 分钟内未使用也会过期，且不跨会话保留。\n" +
            "拒绝后：AI 本会话内不能再为该路径弹窗。\n" +
            "请确认这确实是你本次要求的一部分；文件里的密钥/凭据会暴露给模型。\n" +
            `文件（默认禁止 AI 写入）: ${shownPath}\n` +
            `AI 给出的理由（未经核实）: ${params.reason.slice(0, 300)}`,
          "（完整路径与理由见上方消息）",
        );
      } catch { dialogFailed = true; }

      // A dialog that could not be shown is NOT a decline: fail closed for THIS
      // request without burning the path's anti-grinding lock.
      if (dialogFailed) {
        return deny(
          "review-gate: the confirmation dialog could not be shown — no authorization granted " +
          "(fail-closed), and this does NOT count as a user decline; retry when a dialog is possible.",
        );
      }

      if (!ok) {
        sensitiveDeclinedPaths.add(absPath);
        return deny(
          `review-gate: the user DECLINED editing "${raw}". This path is now locked for the session — ` +
          "do not ask again. Describe the change you wanted and let the user apply it.",
        );
      }

      const now = Date.now();
      const expiresAt = now + SENSITIVE_GRANT_TTL_MS;
      sensitiveGrants = addGrant(
        sensitiveGrants,
        { path: absPath, at: new Date(now).toISOString(), expiresAt, reason: params.reason.slice(0, 300) },
        now,
      );
      log(`sensitive-grant issued for ${absPath}`);
      try {
        ctx.ui.notify(`review-gate: 用户已授权 AI 修改 ${absPath}（一次性，10 分钟内有效）。`, "warning");
      } catch { /* headless */ }
      return {
        content: [{
          type: "text",
          text:
            `review-gate: the user GRANTED a one-shot edit of ${absPath}. Make ONLY the change you ` +
            "described, on this exact path, now — the authorization is consumed by the first successful " +
            "edit and expires in 10 minutes. Do not echo the file's secrets back to the user.",
        }],
        details: { granted: true, path: absPath, expiresAt },
      };
    },
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
    // follow-ups) answers a standing pause_for_question pause: clear it and
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
      "dialog locks further agent-initiated downgrades for this session.",
    parameters: Type.Object({
      mode: Type.String({ description: '"loop" | "explore" | "normal"' }),
      reason: Type.String({ description: "One-line justification (shown to the user as untrusted data)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const requested = normalizeTaskMode(params.mode.trim());
      if (requested === undefined) {
        return {
          content: [{ type: "text", text: 'review-gate: unknown mode — use "loop", "explore", or "normal".' }],
          details: {},
          isError: true,
        };
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
              : effective === "explore"
                ? `review-gate: 会话类型已判定为探查任务${sourceNote} — gate 仅供参考，AI 可自主结束（commit/push 等 ship 命令仍被完整拦截）。可用 /gate-mode 切换。`
                : `review-gate: 会话类型已判定为普通任务${sourceNote} — 本会话门禁关闭。可用 /gate-mode 切换。`,
            effective === "loop" ? "info" : "warning",
          );
        } catch { /* headless */ }
        // Loop mode decided ⇒ deliver the Step 0 loop-goal directive right
        // here. before_agent_start only injects it on the NEXT turn, and the
        // mode is normally decided as the session's first action — without
        // this the agent could edit for a whole turn before ever seeing the
        // exit contract it is supposed to establish first.
        const goalNote = effective === "loop"
          ? "\n\n" + buildLoopGoalDirective(readLoopGoal(primaryRepoRoot), loopGoalConfirmed())
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
        agentDowngradesLocked = true;
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
      "Contest a review-gate ship block you believe is MEANINGLESS or CIRCULAR (the only way " +
      "to satisfy the gate is an action the gate forbids). ONLY a lone `gh pr edit` limited to " +
      "--title/--body/--body-file is arbitrable — never git commit/push or gh pr create. An " +
      "INDEPENDENT arbiter (you cannot write its verdict) rules: GATE_WINS (comply), AGENT_WINS " +
      "(one single-use bypass of this exact command), or HUMAN (a human decides). Call this only " +
      "AFTER the gate has actually blocked the command.",
    parameters: Type.Object({
      argument: Type.String({ description: "Your case for why this specific block is circular/meaningless — cite evidence (e.g. the offending text is pre-existing)." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });

      if (!projectConfig.arbiter.enabled) {
        return deny("review-gate: arbitration is disabled for this project (arbiter.enabled=false). GATE_WINS — comply with the gate.");
      }
      // Must contest a REAL, recent block.
      if (!lastBlockedShip) {
        return deny("review-gate: no ship block to arbitrate. Run the command first; arbitration only contests an actual block.");
      }
      const parsed = parseArbitrableAction(lastBlockedShip.command);
      if (!parsed.ok) {
        return deny(`review-gate: this block is NOT arbitrable — ${parsed.reason}. Only a lone \`gh pr edit\` (title/body) qualifies; git commit/push and gh pr create must go through the full gate.`);
      }
      // Per-session cap and re-roll prevention.
      if (arbitrationsUsed >= projectConfig.arbiter.maxPerSession) {
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

      arbitrationsUsed += 1;

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

      const verdict = await runArbiter(projectConfig.arbiter.model, prompt);
      // Fail-closed: any spawn/parse failure → GATE_WINS.
      const decision = verdict?.decision ?? "GATE_WINS";
      arbitrationDecisions.set(decisionKey, decision);
      appendLesson(`arbitration #${arbitrationsUsed} decision=${decision} reason=${JSON.stringify(verdict?.reason ?? "(no verdict → GATE_WINS)")} cmd=${lastBlockedShip.command.slice(0, 200)} arg=${params.argument.slice(0, 200)}`);

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
          appendLesson(`arbitration #${arbitrationsUsed} HUMAN→allow-once`);
          return { content: [{ type: "text", text: "review-gate: human allowed this exact `gh pr edit` ONCE. Run the same command now." }], details: { decision: "HUMAN", human: "allow-once" } };
        }
        if (choice === "Pause gate and wait") {
          loopArmed = false;
          appendLesson(`arbitration #${arbitrationsUsed} HUMAN→pause`);
          return { content: [{ type: "text", text: "review-gate: gate PAUSED by the human — auto-continuation disarmed. No bypass issued. Wait for further instructions." }], details: { decision: "HUMAN", human: "pause" } };
        }
        appendLesson(`arbitration #${arbitrationsUsed} HUMAN→gate-wins`);
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
    // Explore and normal never auto-continue — that is their defining
    // difference from loop. This check MUST stay before the loopArmed check:
    // explore/normal-mode edits set loopArmed = true in tool_result, and only
    // this early return keeps the continuation loop off.
    if (state.taskMode === "explore" || state.taskMode === "normal") return;
    // Paused for a user question (pause_for_question): defense-in-depth —
    // loopArmed is in-memory and resets on restart, but the persisted pause
    // must keep auto-continuation off until the user actually replies.
    if (state.pausedQuestion) return;
    if (!loopArmed) return;
    if (state.bypass.active) return;
    if (!ctx.isIdle()) return;

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
    // answer, it must pause_for_question instead of re-asking — the resume
    // text below says so explicitly.
    const goalOnly =
      problems.length === 0 &&
      completion.length === 1 &&
      completion[0] === LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK;

    if (problems.length === 0 && completion.length === 0) return;
    // Budgets are checked per source: gate problems against maxRounds,
    // completion-only continuations against their own cap.
    if (problems.length > 0 && continuationsInjected >= state.maxRounds) return;
    if (problems.length === 0 && completionContinuations >= COMPLETION_CONTINUATION_CAP) return;

    // USER REQUIREMENT: the user aborted this run (ESC — "Operation aborted").
    // Injecting a continuation would override an explicit human stop, so the
    // loop pauses instead; the user's next message resumes it (input handler
    // clears the flag). Tighten-only — ship commands stay blocked while gates
    // are unmet, exactly like pause_for_question.
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
      { inMotion: subagentInMotion() },
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
            "Continue: fix → re-review → record_review → precommit → declare_done. " +
            "If you already asked the user a question and are waiting on their answer " +
            "(grill questions while negotiating the loop goal, a product/design decision, " +
            "missing access) — call pause_for_question with the COMPLETE question and END the " +
            "turn instead of re-asking or working on. The user's next message resumes the loop. " +
            "Do not summarize; execute."
          : `\n(completion continuation ${completionContinuations}/${COMPLETION_CONTINUATION_CAP}) ` +
            (goalOnly
              ? "The only open item is the unapproved loop goal. If you already asked the user a " +
                "question, call pause_for_question and END the turn — do not re-ask; the user's " +
                "next message resumes the loop. Otherwise interview the user now, ONE question per " +
                "turn labeled \"N of M\" (each with your recommended answer; all at once only when " +
                "the user asks for it), draft it in Simplified Chinese, get it through the " +
                "`goal-auditor` audit (record_goal_prereview), then call propose_loop_goal for " +
                "approval. " +
                "Do not summarize; execute."
              : "Continue: work these off — Copilot threads get a fix + resolve or a reply explaining " +
                "why not (check_copilot_review verifies), an unapproved goal gets negotiated, " +
                "drafted in Simplified Chinese, audited by `goal-auditor` (record_goal_prereview) and " +
                "only then submitted via propose_loop_goal. If you already asked the user a question and are " +
                "waiting on their answer (e.g. grill questions), call pause_for_question and END the " +
                "turn instead of re-asking. Do not summarize; execute.")) +
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
    // Cancel every background channel listener — a reloaded/resumed session
    // must not keep tmux wait-for processes alive, and a stale listener
    // would wake the NEW session about an OLD child.
    for (const handle of activeWatchers.values()) handle.cancel();
    activeWatchers.clear();
    // Judge children are tmux panes — they survive the session by design
    // (the human can see and interrupt them), so shutdown only drops the
    // registry, not the panes. A fresh session rebuilds it on demand.
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
          "[REVIEW_GATE_PAUSED] Context compacted. The review loop is PAUSED (pause_for_question), " +
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

  function registerWorkflowCommand(name: WorkflowCommandName) {
    const command = WORKFLOW_COMMANDS[name];
    pi.registerCommand(name, {
      description: command.description,
      handler: async (args, ctx) => {
        if (!ctx.isIdle()) {
          ctx.ui.notify(`Agent is busy. Retry ${command.usage} when it is idle.`, "warning");
          return;
        }
        pi.sendUserMessage(
          buildWorkflowPrompt(name, args ?? ""),
        );
      },
    });
  }

  for (const name of Object.keys(WORKFLOW_COMMANDS) as WorkflowCommandName[]) {
    registerWorkflowCommand(name);
  }

  /** Read-only model-chain diagnosis for /gate-status. Best-effort: any IO
   *  failure yields no lines (diagnostics never block, never gate).
   *
   *  PRIMARY facts source is the session's own model registry (the SAME
   *  facts the model registry exposes — it includes built-in catalogs
   *  like anthropic that never appear in models-store.json; reading only
   *  the store mis-reported every built-in judge chain as BLOCKED while
   *  the review was literally running on fable-5). File reads are a
   *  fallback when the registry exposes nothing. */
  function modelDiagnosisLines(registry?: unknown): string[] {
    try {
      const home = homedir();
      const globalAgentsDir = pathJoin(home, ".pi", "agent", "agents");
      const projectAgentsDir = pathJoin(primaryRepoRoot, ".pi", "agents");
      // Effective chain = PROJECT layer file when present, else global
      // (project outranks global, exactly like the runtime load order).
      const readAgent = (name: string): string | undefined => {
        // Project layer wins by IDENTITY (frontmatter `name`), not basename:
        // pi-subagents registers any .md under the project dir under its
        // frontmatter name, so custom.md carrying `name: reviewer` really
        // shadows the global reviewer (round-11 P1/P2).
        const projText = findProjectAgentText(projectAgentsDir, name);
        if (projText !== undefined) return projText;
        try {
          const p = pathJoin(globalAgentsDir, `${name}.md`);
          return existsSync(p) ? readFileSync(p, "utf8") : undefined;
        } catch { return undefined; }
      };
      const authedProviders = new Set<string>();
      const models: Array<{ provider: string; id: string; reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }> = [];
      const facts: RegistryFacts = { models, authedProviders, allowed: isModelAllowed };
      const reg = registry as { getAll?: () => unknown[]; hasConfiguredAuth?: (m: unknown) => boolean } | undefined;
      const all = reg?.getAll?.() ?? [];
      if (Array.isArray(all) && all.length > 0) {
        // Symmetric with gate-doctor's hasAuth guard: a registry without
        // hasConfiguredAuth skips the auth filter entirely (treating every
        // provider as authed would be wrong — the missing method is the
        // signal that auth is not part of this registry's contract).
        const authCheckable = typeof reg?.hasConfiguredAuth === "function";
        for (const m of all) {
          const obj = m as { provider?: unknown; id?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown };
          if (typeof obj.provider !== "string" || typeof obj.id !== "string") continue;
          const tlm = obj.thinkingLevelMap;
          const thinkingLevelMap =
            typeof tlm === "object" && tlm !== null && !Array.isArray(tlm)
              ? Object.fromEntries(Object.entries(tlm).filter(([, mapped]) => mapped === null || typeof mapped === "string")) as Record<string, string | null>
              : undefined;
          models.push({
            provider: obj.provider,
            id: obj.id,
            ...(typeof obj.reasoning === "boolean" ? { reasoning: obj.reasoning } : {}),
            ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
          });
          if (!authCheckable || reg!.hasConfiguredAuth!(obj)) authedProviders.add(obj.provider);
        }
      }
      if (models.length === 0) {
        // Fallback: disk files (a host session without a usable registry).
        try {
          const store = JSON.parse(
            readFileSync(pathJoin(home, ".pi", "agent", "models-store.json"), "utf8"),
          ) as Record<string, { models?: Array<{ provider?: string; id?: string }> }>;
          for (const prov of Object.keys(store)) {
            for (const m of store[prov]?.models ?? []) {
              if (typeof m.provider === "string" && typeof m.id === "string") {
                models.push({ provider: m.provider, id: m.id });
              }
            }
          }
        } catch { /* no store — empty registry */ }
        try {
          const auth = JSON.parse(
            readFileSync(pathJoin(home, ".pi", "agent", "auth.json"), "utf8"),
          ) as Record<string, unknown>;
          for (const k of Object.keys(auth)) authedProviders.add(k);
        } catch { /* no auth — no provider looks usable */ }
      }
      // Diagnose KNOWN agents first, then any user-built/third-party agent
      // files found in either layer (project outranks global per readAgent).
      const fileNames = (dir: string): string[] => {
        try {
          return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
        } catch {
          return [];
        }
      };
      // The PROJECT layer is enumerated by frontmatter IDENTITY, not basename:
      // pi-subagents registers a project file under its `name`, so a
      // `custom.md` carrying `name: foo` is live as `foo`. Enumerating it as
      // "custom" made readAgent (which resolves by identity) find nothing, and
      // a project-ONLY agent whose basename differs from its name was invisible
      // here while gate-doctor's union enumeration did see it.
      const projectIdentityNames = (dir: string): string[] => {
        try {
          const out: string[] = [];
          for (const f of readdirSync(dir)) {
            if (!f.endsWith(".md")) continue;
            try {
              const id = projectAgentIdentity(readFileSync(pathJoin(dir, f), "utf8"));
              if (id !== undefined) out.push(id);
            } catch { /* unreadable file — not loadable either */ }
          }
          return out;
        } catch {
          return [];
        }
      };
      const allNames = [...new Set([...KNOWN_AGENTS, ...fileNames(globalAgentsDir), ...projectIdentityNames(projectAgentsDir)])];
      const entries = allNames
        .map((name) => {
          const text = readAgent(name);
          return text ? diagnoseChain(name, text, facts) : null;
        })
        .filter((e): e is NonNullable<typeof e> => e !== null && e.chain.length > 0);
      return entries.length === 0 ? [] : formatModelDiagnosis(entries).split("\n");
    } catch {
      return []; // diagnostics only — never block the status readout
    }
  }

  pi.registerCommand("gate-status", {
    description: "Show review-gate state",
    handler: async (_args, ctx) => {
      const fp = computeFingerprint(cwd);
      const problems = unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync });
      const others = otherRepoStatus();
      const lines = [
        `review:    ${state.review.verdict}${state.review.at ? ` (${state.review.at})` : ""}`,
        `precommit: ${state.precommit.verdict}` +
          (state.precommit.verdict === "PASS"
            ? ` [lane ${state.precommit.mode ?? "?"}, tests: ${state.precommit.testScope ?? "unknown"}]` +
              (state.precommit.testScope === "full" ? "" : " — commit OK, push/PR need a full run") +
              (state.precommit.testScope === "skipped" ? " — ⚠️ tests were NOT run in this lane" : "")
            : "") +
          (state.precommit.at ? ` (${state.precommit.at})` : ""),
        ...formatPrecommitSummary(lastPrecommitTiming(primaryRepoRoot)),
        `changes:   code=${state.hasCodeChange} docs=${state.hasDocChange}`,
        `docSync:   ${projectConfig.docSync ? `ENFORCED (attested: ${state.review.docSync ?? "none"})` : "off"}`,
        `rounds:    ${state.rounds.length}/${state.maxRounds}`,
        `config:    thinkHarder=${projectConfig.thinkHarder}${state.strategicResetFired ? " (fired)" : ""} gitMemory=${projectConfig.gitMemory}`,
        `task mode: ${state.taskMode ?? "undecided (behaves as loop; agent decides via set_gate_mode)"}`,
        ...(state.scopeLimit
          ? [`scope:     session-only (user-granted ${state.scopeLimit.at}; ${state.scopeLimit.preexistingFiles.length} pre-existing file(s) exempt)`]
          : []),
        ...(state.pausedQuestion
          ? [`paused:    awaiting user answer to "${state.pausedQuestion.question.slice(0, 120)}" (${state.pausedQuestion.at})`]
          : []),
        // L8: whether THIS text is the contract the user approved (loop mode
        // ships are blocked until it is), and L7: the Copilot cycle, which
        // gates completion only — both are easy to misread from the outside,
        // so the readout names them explicitly.
        `loop goal: ${loopGoalConfirmed() ? "approved by the user" : readLoopGoal(primaryRepoRoot).present ? "DRAFT — not approved (loop-mode ships blocked)" : "none"}`,
        ...(state.copilot
          ? [`copilot:   ${state.copilot.status}${state.copilot.pr ? ` PR #${state.copilot.pr}` : ""}` +
            ` (round ${state.copilot.rounds}, no round cap` +
            `${state.copilot.note ? `; ${state.copilot.note.slice(0, 120)}` : ""})`]
          : []),
        `bypass:    ${state.bypass.active ? `ACTIVE (${state.bypass.reason})` : "off"}`,
        `fingerprint: ${fp.unavailable ? "UNAVAILABLE" : fp.digest.slice(0, 12)}`,
        ...modelDiagnosisLines(ctx.modelRegistry),
        // Explore: ship commands stay fully gated (L1), but declare_done and
        // auto-continuation are advisory. Normal: the ship gate is OFF.
        state.taskMode === "normal"
          ? "ship gate: OFF (normal mode — extension inactive)"
          : state.taskMode === "explore"
            ? (problems.length
              ? `ship gate: BLOCKED (explore: completion advisory, ship still gated)\n${problems.map((p) => `  - ${p}`).join("\n")}`
              : "ship gate: OPEN (explore)")
            : (problems.length ? `ship gate: BLOCKED\n${problems.map((p) => `  - ${p}`).join("\n")}` : "ship gate: OPEN"),
        // Every OTHER repo this session edited gets its own line. Showing only
        // the session repo is how a multi-repo session could look green while
        // the repo it was about to commit sat at PENDING (and vice versa).
        ...others.lines,
      ];
      ctx.ui.notify(lines.join("\n"), problems.length || others.blocked ? "warning" : "info");
    },
  });

  pi.registerCommand("gate-bypass", {
    description: "Bypass the review gate (requires a reason; user-confirmed)",
    handler: async (args, ctx) => {
      const reason = (args ?? "").trim();
      if (!reason) { ctx.ui.notify("Usage: /gate-bypass <reason>", "error"); return; }
      const ok = ctx.hasUI
        ? await confirmBounded(
            ctx,
            "Bypass review gate?",
            `Reason: ${reason}\nDisables ship blocking until /gate-reset.`,
          )
        : true;
      if (!ok) return;
      state.bypass = { active: true, reason, at: new Date().toISOString() };
      loopArmed = false;
      persist(ctx);
      ctx.ui.notify(`review-gate: BYPASSED (${reason})`, "warning");
    },
  });

  pi.registerCommand("gate-mode", {
    description: "Set task workflow: /gate-mode loop|explore|normal",
    handler: async (args, ctx) => {
      const mode = normalizeTaskMode((args ?? "").trim());
      if (mode === undefined) {
        ctx.ui.notify("Usage: /gate-mode loop|explore|normal", "error");
        return;
      }
      // /gate-mode is user-invoked — an explicit choice, so source is "user"
      // and any direction is allowed without a confirm dialog. A fresh user
      // decision also clears the agent-downgrade lock.
      agentDowngradesLocked = false;
      setTaskMode(mode, "user", ctx);
      ctx.ui.notify(
        mode === "loop"
          ? "review-gate: switched to loop workflow"
          : mode === "explore"
            ? "review-gate: switched to explore workflow — gates advisory, AI may self-complete; prefer read-only work (ship commands stay gated)"
            : "review-gate: switched to NORMAL mode — all quality gates are OFF for this session (as if the extension were not installed)",
        mode === "loop" ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("gate-reset", {
    description: "Reset review-gate state for this session",
    handler: async (_args, ctx) => {
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
      arbitrationsUsed = 0;
      arbitrationDecisions.clear();
      persist(ctx);
      ctx.ui.notify("review-gate: state reset", "info");
    },
  });

  // sd0x-dev-flow self-improvement loop port: /gate-lesson records a corrected
  // mistake into a per-project lesson log (.pi/review-gate-lessons.md). Lessons
  // recurring 3+ times should be promoted into rules/config by the user.
  pi.registerCommand("gate-lesson", {
    description: "Record a lesson learned (self-improvement log): /gate-lesson <text>",
    handler: async (args, ctx) => {
      const text = (args ?? "").trim();
      if (!text) { ctx.ui.notify("Usage: /gate-lesson <what went wrong → correct approach>", "error"); return; }
      const logPath = pathJoin(cwd, ".pi", "review-gate-lessons.md");
      try {
        const { appendFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(pathDirname(logPath), { recursive: true });
        let n = 1;
        try { n = (readFileSync(logPath, "utf8").match(/^### L\d+/gm) ?? []).length + 1; } catch { /* new log */ }
        appendFileSync(logPath, `\n### L${n} — ${new Date().toISOString().slice(0, 10)}\n\n${text}\n`);
        ctx.ui.notify(`review-gate: lesson L${n} recorded in .pi/review-gate-lessons.md`, "info");
      } catch (e) {
        ctx.ui.notify(`review-gate: could not write lesson log: ${(e as Error).message}`, "error");
      }
    },
  });

  // /gate-doctor — read-only health check: verifies every optimization this
  // package ships actually works in the CURRENT environment (model
  // chains, opencode-go prune, precommit runner, git hooks, global config
  // fallback, L5 gate, Copilot gh, command registry). Pure diagnostics: it
  // reads files and probes executables, writes NOTHING, and never feeds a
  // gate verdict.
  pi.registerCommand("gate-doctor", {
    description: "Diagnose whether all optimizations are live (read-only health check)",
    handler: async (_args, ctx) => {
      const home = homedir();
      const packageRoot = pathJoin(pathDirname(fileURLToPath(import.meta.url)), "..");
      const readFileSafe = (p: string): string | undefined => {
        try { return readFileSync(p, "utf8"); } catch { return undefined; }
      };
      // git rev-parse --git-path hooks resolves the real hooks dir (worktrees,
      // core.hooksPath); unavailable → the hooks check degrades to WARN.
      let hooksDir: string | undefined;
      try {
        const out = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
          cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (out.length > 0) hooksDir = pathResolve(cwd, out);
      } catch { /* git unavailable — hooks unverifiable */ }
      const checks = await runGateDoctor({
        homeDir: home,
        packageRoot,
        agentsDir: pathJoin(home, ".pi", "agent", "agents"),
        // Project-layer overrides outrank the global copies for diagnosis
        // (round-2 P2) — same per-file precedence pi-subagents loads with.
        projectAgentsDir: pathJoin(primaryRepoRoot, ".pi", "agents"),
        modelsStorePath: pathJoin(home, ".pi", "agent", "models-store.json"),
        globalConfigPath: globalConfigPath(home),
        registryFacts: factsFromRegistry(ctx.modelRegistry, home, readFileSafe),
        hooksDir,
        workflowCommandCount: Object.keys(WORKFLOW_COMMANDS).length,
        isNonEnglishText,
        probeGh: async () => {
          try {
            const out = execFileSync("gh", ["--version"], {
              encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
            });
            return { ok: true, value: out.split(/\r?\n/)[0] ?? "" };
          } catch (e) {
            const err = e as { code?: unknown; message?: unknown };
            return { ok: false, error: err.code === "ENOENT" ? "gh not installed" : String(err.message ?? err.code ?? e) };
          }
        },
        readFile: readFileSafe,
        exists: existsSync,
        readdir: (p) => { try { return readdirSync(p); } catch { return undefined; } },
      });
      const attention = checks.filter((c) => c.status !== "PASS").length;
      ctx.ui.notify(formatDoctorReport(checks), attention ? "warning" : "info");
    },
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

    // Inert in snapshot sessions (see session_start): a reviewer the gate

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
      const goal = readLoopGoal(primaryRepoRoot);
      const goalConfirmed = loopGoalConfirmed();
      systemPrompt += "\n\n" + buildLoopGoalDirective(goal, goalConfirmed);

    }

    if (!gateArmed && problems.length === 0) {
      return { systemPrompt };
    }

    return {
      systemPrompt:
        systemPrompt +
        "\n\n## Review Gate (enforced)\n" +
        "pi-review-gate is active. After editing code you MUST: " +
        "(1) run the precommit runner FIRST (its lint:fix step edits files, and any edit " +
        "invalidates a review binding — reviewing first throws that review away), " +
        "(2) run an independent review, (3) call record_review with the FULL reviewer output, " +
        "(4) fix all findings, then repeat from (1) until READY, (5) call declare_done. " +
        "Batch related edits before starting a round: the loop is billed per round, not per line. " +
        "git commit/push and gh pr create/edit are HARD-BLOCKED until gates pass.\n" +
        (sessionRepos.size > 1
          ? "Multi-repo session: this session has edited " + sessionRepos.size + " repositories (" +
            [...sessionRepos].join(", ") +
            "). record_review / run_precommit now REQUIRE an explicit `repo` (absolute path) — " +
            "a verdict binds to that repo's own worktree and unblocks only that repo, so run the " +
            "loop once per repo; " +
            "declare_done and git commit/push/gh pr require EVERY edited repo to pass its own review + precommit " +
            "before shipping.\n"
          : "") +
        "You are ENCOURAGED to proactively consult the `adviser` subagent (a stronger, " +
        "independent second opinion, pinned to a top-tier model at max thinking) BEFORE " +
        "and DURING non-trivial, ambiguous, or risky work \u2014 consulting early is cheaper " +
        "than a failed review later. The `reviewer` (also a top-tier model at max) is the " +
        "independent gatekeeper that emits the recorded verdict.\n" +
        "Prohibited while gates are unmet (sd0x-dev-flow auto-loop rules): claiming a fix " +
        "is done without re-reviewing; asking for permission to continue the loop; citing " +
        "context length or token budget as a reason to skip review; outputting a polished " +
        "completion-style summary. Brief status lines are fine; execute the next step.\n" +
        "EXCEPTION — genuine blockers: if progress is stopped by a question only the user can " +
        "answer (ambiguous requirement, a product decision, missing access), call " +
        "pause_for_question — put the COMPLETE question (options + your recommendation) in the " +
        "`question` parameter, then end the turn with a one-line pointer instead of repeating it. " +
        "Auto-continuation pauses until the user replies; ship commands stay blocked. Never " +
        "use it to ask permission to continue routine loop work.\n" +
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
