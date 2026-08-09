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
 *   L5 Commit/PR English — ADVISORY: tool_call warns (never blocks) when a git
 *                          commit message or PR title/body looks non-English;
 *                          the per-turn LANGUAGE_DIRECTIVE instructs the agent
 *                          to write ship text in English and the reviewer
 *                          checks it during review.
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
  mkdirSync, realpathSync, openSync, closeSync, readSync, copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
} from "./lib/constants.ts";
import { defaultProjectConfig, loadProjectConfig, type ProjectConfig } from "./lib/project-config.ts";
import { buildGitMemory } from "./lib/git-memory.ts";
import { detectShipCommands, extractCommitMessages, extractPrTextFields } from "./lib/ship-detect.ts";
import {
  gitRootOfDir,
  resolveShipRepos,
  resolveCommandRepos,
  resolveToolRepoTarget,
} from "./lib/repo-resolve.ts";
import { firstNonEnglish, containsNonLatinLetter } from "./lib/lang-detect.ts";
import { failedStepNames, validatePrecommitReceipt } from "./lib/precommit-receipt.ts";
import {
  advisoryChangeToken,
  changedFiles,
  computeFingerprint,
  isGateOwnedPath,
  mayBeGateOwned,
} from "./lib/fingerprint.ts";
import type { Fingerprint } from "./lib/fingerprint.ts";
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
} from "./lib/gate-state.ts";
import { parseReviewOutput, parsePrecommitOutput } from "./lib/verdict-parse.ts";
import {
  evaluateModeChange,
  buildModeConfirmMessage,
  normalizeTaskMode,
  GATE_MODE_DECISION_DIRECTIVE,
  MODE_CONFIRM_TITLE,
  type TaskMode,
  type TaskModeSource,
} from "./lib/task-mode.ts";
import {
  createLlmClassifier,
  classifyAiAttribution,
  classifyNonEnglish,
  classifyShipCommand,
  classifyTaskMode,
  createVerdictMemo,
  isSuspiciousShipCandidate,
  type LlmClassifier,
} from "./lib/llm-classify.ts";
import {
  BASH_WRITE_NUDGE,
  EDIT_DISCIPLINE_DIRECTIVE,
  EDIT_FAILURE_NUDGE,
  looksLikeBashFileWrite,
} from "./lib/edit-discipline.ts";
import { projectEditedContent } from "./lib/edit-projection.ts";
import {
  LOOP_GOAL_RELPATH,
  LOOP_GOAL_MAX_WRITE_CHARS,
  buildLoopGoalDirective,
  buildGoalConfirmMessage,
  goalTextHash,
  isLoopGoalConfirmed,
  normalizeGoalText,
  readLoopGoal,
  GOAL_CONFIRM_TITLE,
  LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK,
} from "./lib/loop-goal.ts";
import {
  COPILOT_ACTOR_QUERY,
  COPILOT_REVIEWER_LOGIN,
  COPILOT_THREADS_QUERY,
  analyzeCopilot,
  armCopilotReview,
  copilotProblems,
  evaluateCopilot,
  isCopilotOutstanding,
  parseCopilotActorProbe,
  parseCopilotPayload,
  parseCopilotRequestLanded,
  parseRestReviewRequests,
  parseNameWithOwner,
  parsePrView,
  recordCopilotRequest,
  releaseCopilotReview,
  slugFromPrUrl,
  type CopilotPayload,
  type PrSummary,
} from "./lib/copilot-review.ts";
import {
  SENSITIVE_GRANT_TTL_MS,
  addGrant,
  consumeGrant,
  findGrant,
  isGateIntegrityPath,
  normalizeSensitivePath,
  type SensitiveGrant,
} from "./lib/sensitive-grant.ts";
import {
  blockedMarkerPath,
  recordBlockedMarker,
  reconcileBlockedMarker,
} from "./lib/blocked-marker.ts";
import { WORKFLOW_COMMANDS, buildWorkflowPrompt, type WorkflowCommandName } from "./lib/workflow-commands.ts";
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
} from "./lib/arbitration.ts";

const ENTRY_TYPE = "review-gate-state";
const EDIT_TOOL_NAMES = new Set(["edit", "write", "Edit", "Write", "NotebookEdit", "notebook_edit"]);

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
  let continuationsInjected = 0; // total auto-continuation injections (persisted)
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
  // USER REQUIREMENT: the user's FIRST real message, captured cache-only so
  // the DeepSeek V4 first classification sees the actual request, not just the
  // agent's paraphrase. Input handler stores text; it never decides anything
  // (no classifier call, no mode write) — classification stays exclusively in
  // set_gate_mode. undefined = not captured yet (e.g. print/JSON mode).
  let firstUserInput: string | undefined;
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
      const unmet = unmetRequirements(st, rfp.digest, rfp.unavailable, { requireDocSync: projectConfig.docSync });
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

  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const parts: string[] = [];
    if (state.bypass.active) {
      parts.push("gate: BYPASSED");
    } else if (state.taskMode === "normal") {
      parts.push("gate: normal (off)");
    } else if (!state.hasCodeChange && !state.hasDocChange) {
      if (state.taskMode === "explore") parts.push("gate: explore (advisory)");
      else parts.push(state.taskMode === "loop" ? "gate: loop · idle" : "gate: undecided");
    } else {
      // Explore shows the same live verdict status, tagged advisory — the
      // agent can edit in this mode, so a static label would hide real state.
      if (state.taskMode === "explore") parts.push("explore (advisory)");
      if (state.pausedQuestion) parts.push("paused: awaiting user");
      if (lastRunAborted) parts.push("paused: user abort (esc)");
      if (state.scopeLimit) parts.push("scope: session-only");
      parts.push(`review: ${state.review.verdict}`);
      parts.push(`precommit: ${state.precommit.verdict}`);
      parts.push(`round ${state.rounds.length}/${state.maxRounds}`);
    }
    try { ctx.ui.setStatus("review-gate", parts.join(" · ")); } catch { /* non-TUI */ }
  }

  // SECURITY: source is persisted so the git pre-commit hook can distinguish a
  // user-chosen explore/normal (advisory hook) from an LLM/agent selection
  // (hook stays fully enforced). The in-session mode decision is made via the
  // set_gate_mode tool (or the user via /gate-mode): DeepSeek V4 classifies
  // the FIRST decision automatically (user requirement — no confirmation
  // dialog); later changes go through lib/task-mode.ts consent rules.
  function setTaskMode(mode: TaskMode, source: TaskModeSource, ctx: ExtensionContext) {
    state.taskMode = mode;
    state.taskModeSource = source;
    // A fresh mode decision supersedes a standing question pause: loop re-arms
    // (or the mode itself turns auto-continuation off for explore/normal).
    delete state.pausedQuestion;
    loopArmed = mode === "loop";
    continuationsInjected = 0;
    completionContinuations = 0;
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
    if (!analyze || !isTest || !isTest(path)) return undefined;
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
      if (path && isSensitiveFile(path)) {
        // A live grant means the USER already approved this exact path in a
        // dialog (request_sensitive_edit). It is consumed on the successful
        // tool_result, so the pass here is for one landing edit only.
        // `cwd` (the session cwd), not ctx.cwd: the grant is keyed at
        // request time with the same base, and a mismatched base would make a
        // relative path miss its own grant.
        const absPath = normalizeSensitivePath(path, cwd);
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
      // Normal mode: user-consented “as if not installed” — the L6 label check
      // (and its LLM call) is skipped. The sensitive-file guard ABOVE runs in
      // every mode: it is a security floor, not workflow enforcement.
      if (state.taskMode === "normal") return;
      // Explore mode does NOT block edits: the system prompt asks the agent to
      // prefer read-only work, but small edits during an investigation are
      // allowed. Sensitive-file and L6 label checks above/below stay active.
      if (path) {
        const labelProblem = await checkTestLabels(path, editedTestContent(input, path));
        if (labelProblem) return { block: true, reason: labelProblem };
      }
      // USER REQUIREMENT: a passed edit counts as THIS session's work — from
      // here on, any mode change (including the first classification) goes
      // through the normal consent rules. Blocked edits (sensitive file / L6)
      // and normal-mode edits do not set it: they change nothing.
      //
      // Gate-owned writes (.pi/, .pi-subagents/) are excluded for the same
      // reason tool_result skips them: everything under those dirs is invisible
      // to a review (excluded from the fingerprint AND from changedFiles), so
      // no edit there is session WORK — the gate's own sidecar, a loop goal, a
      // subagent artifact and the project config alike. Counting them would
      // suppress the "changes pre-date this session" hint and force consent for
      // a mode change the agent never earned. mayBeGateOwned pre-filters on
      // the raw path, so ordinary edits pay no filesystem cost here.
      if (path) {
        const abs = path.startsWith("/") ? path : pathJoin(cwd, path);
        if (mayBeGateOwned(abs) && isGateOwnedPath(abs, gitRootOfDir(pathDirname(abs)) ?? primaryRepoRoot)) {
          return;
        }
      }
      sessionEdited = true;
      return;
    }

    if (event.toolName !== "bash") return;
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return;

    // Normal mode (ALWAYS user-confirmed — evaluateModeChange requires a
    // consented dialog or /gate-mode for every path into it): the ship gate,
    // commit-message checks, and LLM ship classification are all off. This is
    // the mode's defining behavior; explore below never gets this branch.
    if (state.taskMode === "normal") return;

    // Explore mode does NOT block bash — investigations need diagnostic
    // commands. Ship commands below stay FULLY gated in every mode except the
    // user-confirmed normal: explore only relaxes auto-continuation and
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

    // AI attribution (HARD) + English-language (L5, ADVISORY) checks on commit
    // messages and PR title/description. L5 no longer hard-blocks: extraction
    // heuristics can mis-read complex shell forms (e.g. `-m "$(cat <<'EOF' …)"`
    // heredocs), so a wrong language guess must not stop a legitimate ship.
    // Instead we warn, the per-turn LANGUAGE_DIRECTIVE tells the agent to write
    // ship text in English, and the reviewer checks commit/PR language.
    const l5Advisories: string[] = [];
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
        const nonEn = firstNonEnglish(msgs);
        if (nonEn) {
          l5Advisories.push(`commit message is predominantly non-English: "${nonEn.slice(0, 60)}"`);
        } else if (msgs.length > 0 && projectConfig.llmGuards.englishCheck
          && !msgs.some(containsNonLatinLetter)
          && await classifyNonEnglish(classifier(), msgs) === true) {
          // L5 blind spot: the majority-body check passed, but a message that is
          // 100% Latin script may still be romanized non-English (pinyin/romaji).
          // Only run the semantic check when there is NO non-Latin letter at all
          // — a minority foreign word already passes under the majority policy.
          l5Advisories.push("commit message reads as romanized non-English (semantic check)");
        }
      } else if (s.kind === "pr-create" || s.kind === "pr-edit") {
        const prTexts = extractPrTextFields(s.segment);
        const nonEn = firstNonEnglish(prTexts);
        if (nonEn) {
          l5Advisories.push(`PR title/description is predominantly non-English: "${nonEn.slice(0, 60)}"`);
        } else if (prTexts.length > 0 && projectConfig.llmGuards.englishCheck
          && !prTexts.some(containsNonLatinLetter)
          && await classifyNonEnglish(classifier(), prTexts) === true) {
          l5Advisories.push("PR title/description reads as romanized non-English (semantic check)");
        }
      }
    }
    if (l5Advisories.length > 0) {
      // Advisory only — never a block. Surface to the user; the reviewer is
      // instructed to flag non-English ship text during review.
      try {
        ctx.ui.notify(
          "review-gate (L5 advisory): " + l5Advisories.join("; ") +
            " — commit/PR text must be English. Consider amending (git commit --amend / gh pr edit).",
          "warning",
        );
      } catch { /* headless UI — advisory is best-effort */ }
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
    for (const root of checkRoots) {
      const st = enforcementStateFor(root);
      const fp = computeFingerprint(root);
      if (root === primaryRepoRoot) primaryFp = fp;
      if (st) {
        const unmet = unmetRequirements(st, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync });
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
   * Optimistic poll inside check_copilot_review: a couple of quick retries
   * catch the common "Copilot answered while we were talking" case without
   * turning the tool into a long block. Anything slower is handled by the
   * persistent AWAITING state and the next continuation.
   */
  const COPILOT_CHECK_ATTEMPTS = 3;
  const COPILOT_CHECK_DELAY_MS = 10000;

  /**
   * Pause before the second "did the request land?" read. Review requests are
   * eventually consistent, so an immediate single read could call a supported
   * repo unsupported. Only ever paid on the path that is about to RELEASE the
   * requirement, i.e. once, on a repo where Copilot appears to be absent.
   */
  const COPILOT_LANDING_RECHECK_DELAY_MS = 3000;

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
    const res = await runGh(["gh", "pr", "view", "--json", "number,headRefOid,url,state"], dir, { signal });
    if (!res.ok) return { error: ghError(res, "`gh pr view` failed (gh missing, not authenticated, or no PR)") };
    const pr = parsePrView(res.stdout);
    if (!pr) return { error: "`gh pr view` returned no recognizable pull request" };
    return { pr };
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
   * Heuristic pre-flight: does this repo look like it has a Copilot actor?
   * `undefined` when the answer could not be read (gh missing, API refusal,
   * unparseable payload) — the caller must then assume nothing.
   */
  async function probeCopilotActor(
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
      "-f", `query=${COPILOT_ACTOR_QUERY}`,
    ], dir, { signal });
    if (!res.ok) return undefined;
    return parseCopilotActorProbe(res.stdout);
  }

  /**
   * Did the request we just sent actually land on the PR? `undefined` when the
   * read-back failed — never treated as "it did not land".
   */
  async function copilotRequestLanded(
    dir: string,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    const res = await runGh(
      ["gh", "pr", "view", String(prNumber), "--json", "reviewRequests,reviews"],
      dir,
      { signal },
    );
    if (!res.ok) return undefined;
    return parseCopilotRequestLanded(res.stdout);
  }

  /**
   * The same question asked of a DIFFERENT surface: the REST review-request
   * endpoint. Used only as the confirming second read before releasing the
   * requirement, because review requests are eventually consistent and an
   * older `gh` may omit a Bot login from its JSON export.
   */
  async function copilotRequestLandedViaRest(
    dir: string,
    slug: string | null,
    prNumber: number,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    if (!slug) return undefined;
    const res = await runGh(
      ["gh", "api", `repos/${slug}/pulls/${prNumber}/requested_reviewers`],
      dir,
      { signal },
    );
    if (!res.ok) return undefined;
    return parseRestReviewRequests(res.stdout);
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
   */
  function loopGoalConfirmed(): boolean {
    const goal = readLoopGoal(primaryRepoRoot);
    if (!goal.present || !state.loopGoal) return false;
    let raw: string;
    try {
      raw = readFileSync(pathJoin(primaryRepoRoot, LOOP_GOAL_RELPATH), "utf8");
    } catch {
      return false; // unreadable ⇒ unapproved (fail-closed)
    }
    return isLoopGoalConfirmed(goal, state.loopGoal, raw);
  }
  // ---------- track edits & precommit results ----------

  pi.on("tool_result", async (event, ctx) => {
    // 1. Edits: only arm gate on success.
    if (EDIT_TOOL_NAMES.has(event.toolName)) {
      if (event.isError) {
        // Edit-discipline nudge (prompt-only, non-blocking): a failed edit is
        // the classic trigger for the "shell edits the file instead"
        // workaround. Append guidance to THIS result and arm the same-turn
        // bash window; the failure semantics stay untouched (isError true).
        // Skipped in normal mode: the user-consented step-aside must not add
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
      if (isSensitiveFile(path)) {
        const { consumed, remaining } = consumeGrant(
          sensitiveGrants,
          normalizeSensitivePath(path, cwd),
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
      st.review = {
        verdict: parsed.verdict,
        fingerprint: parsed.verdict === "READY" ? fp.digest : null,
        at: new Date().toISOString(),
        // Code↔doc attestation travels with the verdict it came from; absent
        // stays absent (blocks under the docSync knob — fail-closed).
        ...(parsed.docSync !== undefined ? { docSync: parsed.docSync } : {}),
      };
      st.rounds.push({
        round: st.rounds.length + 1,
        findingsTotal: parsed.findingsTotal,
        fingerprints: parsed.findingFingerprints,
        verdict: parsed.verdict,
        at: new Date().toISOString(),
      });
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
            (parsed.verdict === "READY" ? " Next: run precommit for this same repo." : parsed.verdict === "BLOCKED" ? " Next: fix ALL findings and re-review." : ""),
        }],
        details: { verdict: parsed.verdict, round: st.rounds.length, repo: repoLabel(targetRoot) },
      };
    },
  });

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
      const outcome = await runTrustedPrecommit(targetDir, targetRoot, mode, _signal);

      if (outcome.verdict === "PASS") {
        // Bind PASS to the fingerprint recomputed AFTER the runner finished
        // (a lint:fix step may have modified files).
        st.precommit = { verdict: "PASS", fingerprint: outcome.fingerprint, at: new Date().toISOString() };
      } else {
        // P0 fix: "ERROR" is a runner-protocol outcome, NOT a GateState
        // PrecommitVerdict enum member. Persisting it would make loadSidecar
        // and the git pre-commit hook reject the whole sidecar as forged
        // (fail-closed — which then bricks even the USER's manual commits).
        // Map ERROR → NOT_RUN (accurate: no trusted verdict was recorded);
        // FAIL / NO_CHECKS_RUN persist as themselves. The error detail still
        // reaches the model via the tool result text below.
        const persisted = outcome.verdict === "ERROR" ? "NOT_RUN" : outcome.verdict;
        st.precommit = { verdict: persisted, fingerprint: null, at: new Date().toISOString() };
      }
      persistRepo(ctx as unknown as ExtensionContext, targetRoot);

      const detail =
        outcome.verdict === "PASS" ? `PASS (${outcome.checksRun} checks ran, 0 failed).`
        : outcome.verdict === "FAIL" ? `FAIL (${outcome.checksFailed}/${outcome.checksRun} checks failed).`
        : outcome.verdict === "NO_CHECKS_RUN" ? "NO CHECKS RUN — zero runnable checks; this is NOT a pass. Configure real checks or /gate-bypass."
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
          for (const p of unmetRequirements(st, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync })) {
            problems.push(root === primaryRepoRoot ? p : `[${repoLabel(root)}] ${p}`);
          }
        } else {
          // An edited repo always has a state (edit hook initializes it);
          // this is defense against future drift. Fail-closed.
          problems.push(`[${repoLabel(root)}] gate state missing (fail-closed)`);
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
      persist(ctx as unknown as ExtensionContext);
      return {
        content: [{ type: "text", text: `review-gate: done accepted. ${params.summary}` }],
        details: { accepted: true },
      };
    },
  });

  // ---------- propose_loop_goal tool (L8 — the user approves the contract) ----------

  pi.registerTool({
    name: "propose_loop_goal",
    label: "Propose Loop Goal",
    description:
      "Submit the NEGOTIATED loop goal (this session's exit contract) for the user's approval. " +
      "Grill the user first — numbered questions, each with your recommended answer — and only " +
      "submit what they actually agreed to. The extension shows the text in a confirmation " +
      "dialog and, if the user approves, writes .pi/loop-goal.md itself and records the approval. " +
      "Writing that file yourself grants nothing: in loop mode an unapproved goal blocks " +
      "commit/push/PR and its body is withheld from your prompt. Shape: task title, one-line " +
      "intent, 3–7 checkable exit criteria, non-goals, ISO date.",
    parameters: Type.Object({
      goal: Type.String({ description: "The full goal text (Markdown) as agreed with the user" }),
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

      // Consent comes from a dialog the EXTENSION renders — there is no
      // parameter the model could set to claim it. No UI ⇒ no approval; a
      // session without a UI is forced to normal mode at session_start, so
      // reaching this branch means the UI disappeared, not a headless run.
      const uiCtx = ctx as unknown as ExtensionContext;
      let approved = false;
      try {
        approved = (await uiCtx.ui?.confirm?.(GOAL_CONFIRM_TITLE, buildGoalConfirmMessage(goalText))) === true;
      } catch {
        approved = false;
      }
      if (!approved) {
        return {
          content: [{
            type: "text",
            text: "review-gate: the user did NOT approve this goal. Ask what is wrong with it, " +
              "renegotiate, and submit the corrected goal again — do not start shipping work in " +
              "the meantime.",
          }],
          details: { approved: false },
        };
      }

      // The EXTENSION writes the file: an approval must describe the text the
      // user saw, not text the agent might swap in afterwards. The path lives
      // in the gate-owned .pi/ scope, so this write never moves the worktree
      // fingerprint and cannot invalidate a READY review or a precommit PASS.
      const goalPath = pathJoin(primaryRepoRoot, LOOP_GOAL_RELPATH);
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
      state.loopGoal = { hash: goalTextHash(goalText), at: new Date().toISOString() };
      persist(uiCtx);
      log(`loop goal approved by the user (${goalText.length} chars)`);
      return {
        content: [{
          type: "text",
          text: `review-gate: goal approved and written to ${LOOP_GOAL_RELPATH}. Work to it; if it has to ` +
            "change, renegotiate with the user and call propose_loop_goal again (editing the file " +
            "yourself drops the approval and blocks shipping).",
        }],
        details: { approved: true },
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
      const maxRounds = projectConfig.copilotReview.maxRounds;

      // Budget check BEFORE spending another round: a PR where Copilot keeps
      // finding new things has to end with a human, not with an endless loop.
      if ((st.copilot?.rounds ?? 0) >= maxRounds) {
        st.copilot = releaseCopilotReview(st.copilot, "EXHAUSTED",
          `Copilot review budget spent (${st.copilot?.rounds ?? 0}/${maxRounds} rounds)`, nowIso);
        persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{
            type: "text",
            text: `review-gate: Copilot review budget spent (${maxRounds} rounds). The requirement is released ` +
              "— tell the user what is still open on the PR and let them decide.",
          }],
          details: { status: "EXHAUSTED" },
        };
      }

      const resolved = await resolveOpenPr(dir, signal);
      if (!resolved.pr) {
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          `no Copilot review possible: ${resolved.error}`, nowIso);
        persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{
            type: "text",
            text: `review-gate: no Copilot review for this repo — ${resolved.error}. Requirement released ` +
              "(UNSUPPORTED); it is not blocking completion.",
          }],
          details: { status: "UNSUPPORTED" },
        };
      }
      const pr = resolved.pr;
      const slug = await resolveRepoSlug(dir, pr, signal);
      // Pre-flight: look for a Copilot actor BEFORE spending a round on a repo
      // that cannot do Copilot review at all.
      const hasActor = await probeCopilotActor(dir, slug, signal);
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
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          `Copilot review could not be requested: ${why}`, nowIso, pr.head);
        persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{
            type: "text",
            text: `review-gate: Copilot code review is not available for PR #${pr.number} — ${why}. ` +
              "Requirement released (UNSUPPORTED).",
          }],
          details: { status: "UNSUPPORTED", pr: pr.number },
        };
      }
      // The probe is a heuristic, so a negative one only earns a read-back:
      // `gh pr edit --add-reviewer @copilot` exits 0 (and the REST endpoint
      // answers 200) even where GitHub silently drops the bot, which used to
      // park the requirement in AWAITING until the 20-minute budget expired.
      // Only hard evidence — Copilot in neither the request list nor the
      // reviews — releases it; an unreadable read-back changes nothing.
      if (hasActor === false) {
        let landed = await copilotRequestLanded(dir, pr.number, signal);
        if (landed === false) {
          // Confirm before releasing: wait out the eventual consistency of
          // review requests, then ask a different API surface. Anything other
          // than a second explicit "not there" (true, or unreadable) keeps the
          // requirement — including an abort, which can confirm nothing, so it
          // downgrades the first read to "cannot tell" instead of releasing.
          if (signal?.aborted) {
            landed = undefined;
          } else {
            await new Promise((r) => setTimeout(r, COPILOT_LANDING_RECHECK_DELAY_MS));
            // Ask BOTH surfaces again: REST alone would miss a Copilot that
            // reviewed and left the request list during the pause, and the
            // JSON export alone is what an old gh renders bot-blind.
            const viaCli = await copilotRequestLanded(dir, pr.number, signal);
            const viaRest = await copilotRequestLandedViaRest(dir, slug, pr.number, signal);
            landed = (viaCli === true || viaRest === true)
              ? true
              : (viaCli === false && viaRest === false ? false : undefined);
          }
        }
        if (landed === false) {
          st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
            "the review request did not land: Copilot is not among this repository's actors, and " +
            "a confirming second pass over both surfaces (gh pr view reviewRequests+reviews, REST " +
            "requested_reviewers) still found no Copilot review request",
            nowIso, pr.head);
          persistRepo(ctx as unknown as ExtensionContext, root);
          return {
            content: [{
              type: "text",
              text: `review-gate: Copilot code review is not available for PR #${pr.number} — the ` +
                "request was accepted by the API but never landed on the PR (this repository or " +
                "account has no Copilot reviewer). Requirement released (UNSUPPORTED); it is not " +
                "blocking completion.",
            }],
            details: { status: "UNSUPPORTED", pr: pr.number },
          };
        }
      }
      st.copilot = recordCopilotRequest(st.copilot, { pr: pr.number, head: pr.head, nowIso });
      persistRepo(ctx as unknown as ExtensionContext, root);
      loopArmed = true;
      return {
        content: [{
          type: "text",
          text: `review-gate: Copilot review requested for PR #${pr.number} (round ${st.copilot.rounds}/${maxRounds}). ` +
            "Copilot usually answers within a minute — call check_copilot_review to see whether it " +
            "has, and what it left open.",
        }],
        details: { status: "AWAITING", pr: pr.number, rounds: st.copilot.rounds },
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
              "deliberately call request_copilot_review again while rounds remain.",
          }],
          details: { status: settled.status, ...(settled.pr === null ? {} : { pr: settled.pr }) },
        };
      }
      const dir = repoDirFor(root);
      const resolved = await resolveOpenPr(dir, signal);
      if (!resolved.pr) {
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          `no Copilot review possible: ${resolved.error}`, new Date().toISOString());
        persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{ type: "text", text: `review-gate: no pull request to check — ${resolved.error}. Requirement released (UNSUPPORTED).` }],
          details: { status: "UNSUPPORTED" },
        };
      }
      const pr = resolved.pr;
      const slug = await resolveRepoSlug(dir, pr, signal);
      if (!slug) {
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          "could not determine the GitHub owner/repo for this PR", new Date().toISOString());
        persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{ type: "text", text: "review-gate: could not determine owner/repo for this PR. Requirement released (UNSUPPORTED)." }],
          details: { status: "UNSUPPORTED" },
        };
      }

      // Short optimistic poll for the fast path (Copilot often answers within
      // seconds). The REAL waiting mechanism is the persistent AWAITING state
      // plus the L2 continuation: blocking a tool call for minutes would burn
      // the turn and ignore an ESC in the meantime.
      let payload: CopilotPayload | undefined;
      let next = st.copilot ?? armCopilotReview(undefined, new Date().toISOString());
      for (let attempt = 0; attempt < COPILOT_CHECK_ATTEMPTS; attempt++) {
        if (signal?.aborted) break;
        payload = await fetchCopilotPayload(dir, slug, pr.number, signal);
        if (payload) {
          next = evaluateCopilot(
            next,
            analyzeCopilot(payload, { anchorAt: next.requestedAt ?? next.armedAt }),
            { nowIso: new Date().toISOString(), now: Date.now(), maxRounds: projectConfig.copilotReview.maxRounds },
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
        // never strand a task over an unreachable API.
        st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
          "the Copilot review query failed (gh missing, unauthenticated, or API refusal)", new Date().toISOString());
        persistRepo(ctx as unknown as ExtensionContext, root);
        return {
          content: [{ type: "text", text: "review-gate: could not read the PR's review threads (gh missing, unauthenticated, or API refusal). Requirement released (UNSUPPORTED)." }],
          details: { status: "UNSUPPORTED" },
        };
      }

      st.copilot = next;
      persistRepo(ctx as unknown as ExtensionContext, root);
      if (isCopilotOutstanding(next)) loopArmed = true;

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
          : `review-gate: Copilot review of PR #${pr.number} — ${next.note ?? next.status}.`;
      return {
        content: [{ type: "text", text }],
        details: {
          status: next.status,
          pr: pr.number,
          actionable: analysis.actionable.length,
          resolved: analysis.resolved,
          answered: analysis.answered,
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
      "missing credentials or access). After calling this, ask the question clearly in your reply " +
      "and END the turn; the pause clears automatically on the user's next message. The ship gate " +
      "is NOT affected — git commit/push and gh pr stay blocked while gates are unmet. Do NOT use " +
      "this to ask permission to continue routine loop work, to skip a review round, or to end the " +
      "task — those remain prohibited.",
    parameters: Type.Object({
      question: Type.String({ description: "The exact question the user must answer before work can continue" }),
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
      // Explore/normal have no auto-continuation to pause — the agent can
      // simply ask and end its turn. Informational no-op, never an error.
      if (state.taskMode === "explore" || state.taskMode === "normal") {
        return {
          content: [{
            type: "text",
            text: `review-gate: no enforced loop in "${state.taskMode}" mode — auto-continuation is already off. Ask the user in your reply and end the turn.`,
          }],
          details: { mode: state.taskMode },
        };
      }
      if (state.pausedQuestion) {
        return {
          content: [{
            type: "text",
            text: "review-gate: the loop is already paused for a user question. Ask it in your reply and END the turn — the user's next message resumes the loop.",
          }],
          details: { alreadyPaused: true },
        };
      }
      // Loop (or undecided → behaves as loop): record the pause. Persisted so
      // it survives a restart while waiting; the ship gate ignores it entirely
      // (unmetRequirements never reads pausedQuestion — tighten-only).
      state.pausedQuestion = { question: question.slice(0, 2000), at: new Date().toISOString() };
      loopArmed = false;
      persist(ctx as unknown as ExtensionContext);
      try {
        ctx.ui.notify(
          "review-gate: AI 申请暂停循环等待你的回答 — 你的下一条消息会自动恢复循环（ship 命令仍被拦截）。",
          "warning",
        );
      } catch { /* headless */ }
      return {
        content: [{
          type: "text",
          text:
            "review-gate: loop PAUSED — auto-continuation is off until the user's next message. " +
            "Now ask the user your question clearly in your reply and END the turn; do not keep working. " +
            "Ship commands stay blocked while gates are unmet. The pause clears automatically when the " +
            "user replies (or on your next code/doc edit).",
        }],
        details: { paused: true },
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
      const preexistingList = preexisting.slice(0, 20).join(", ") || "（仅分支上已有的提交）";
      const sessionList = sessionRel.length > 0 ? sessionRel.slice(0, 20).join(", ") : "（无）";
      let ok = false;
      let dialogFailed = false;
      try {
        ok = await ctx.ui.confirm(
          "review-gate: AI 请求把审查范围缩小到本会话的修改——是否同意？",
          "门禁当前要求覆盖【本会话之前就存在】的修改。\n" +
            `既有变更（同意后不再触发门禁）: ${preexistingList}` +
            (ahead > 0 ? `；分支领先基线 ${ahead} 个提交` : "") + "\n" +
            `本会话修改（仍需完整审查）: ${sessionList}\n` +
            "同意后：审查只需覆盖本会话自己的修改；若本会话没有任何修改，ship 拦截将解除。\n" +
            "拒绝后：AI 本会话内不能再次请求缩小范围。\n" +
            `AI 给出的理由（未经核实）: ${params.reason.slice(0, 300)}`,
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
      "persisted, so it dies with the session. `.git/` internals are NEVER grantable (they are " +
      "the gate's own enforcement). If the user declines, that path is locked for the session — " +
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
          `review-gate: "${raw}" is git internals — never authorizable from here, because editing ` +
          "`.git/hooks/*` would disarm the gate's own enforcement. If this change is really needed, " +
          "the USER must make it by hand.",
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
      let ok = false;
      let dialogFailed = false;
      try {
        ok = await ctx.ui.confirm(
          "review-gate: AI 请求一次性修改敏感文件——是否同意？",
          `文件（默认禁止 AI 写入）: ${absPath}\n` +
            "同意后：只授权这一个路径，写入成功一次即失效；10 分钟内未使用也会过期，且不跨会话保留。\n" +
            "拒绝后：AI 本会话内不能再为该路径弹窗。\n" +
            "请确认这确实是你本次要求的一部分；文件里的密钥/凭据会暴露给模型。\n" +
            `AI 给出的理由（未经核实）: ${params.reason.slice(0, 300)}`,
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

  // USER REQUIREMENT: cache-only capture of the user's first real message,
  // feeding the DeepSeek V4 first classification its primary signal. This
  // handler ONLY stores text — it never intercepts, transforms, classifies,
  // or writes mode state; all decisions stay inside set_gate_mode (the
  // input-transform/decision flow is deliberately not resurrected).
  pi.on("input", (event, ctx) => {
    if (firstUserInput === undefined && event.source === "interactive") {
      firstUserInput = event.text;
    }
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
      "(gate fully off). Call this FIRST in a new session to classify the task: DeepSeek V4 " +
      "(the llmGuards model) classifies the FIRST decision and it is applied AUTOMATICALLY — " +
      "no user confirmation for the first classification (user requirement); the model may " +
      "override your pick, and a failed model call falls back to the normal consent rules. " +
      "Upgrades (toward loop) apply immediately; downgrades after the first classification pop a " +
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
      // FIRST CLASSIFICATION (USER REQUIREMENT): while the mode is undecided
      // and no session work exists yet, DeepSeek V4 (the llmGuards model)
      // classifies the task and its verdict applies AUTOMATICALLY — no
      // consent dialog. The model sees the user's ACTUAL first message (via
      // the cache-only input handler) plus the agent's reason; its verdict
      // WINS over the agent's own pick. A failed call (undefined, e.g. model
      // unreachable) falls back to the pure rule engine exactly as before
      // (fail-back: the agent's pick then follows the normal consent rules).
      // The engine still refuses the LLM verdict on a dirty session
      // (hasChanges) or without a UI, and source stays "auto" so the git
      // hooks remain fully enforced.
      let effective = requested;
      let classifiedBy: string | null = null;
      if (
        state.taskMode === undefined &&
        !sessionEdited &&
        ctx.hasUI
      ) {
        // Facts are constant here: this branch is reachable only when THIS
        // session has not edited anything (guarded above). Pre-existing
        // worktree/branch changes may still exist — they arm the ship gate
        // (state.hasCodeChange) but do not block the consent-free first
        // classification: source stays "auto" so the git hooks remain fully
        // enforced, and explore never weakens the ship gate.
        const facts =
          "this session has made no edits yet (pre-existing workspace changes may exist); " +
          "interactive session: yes; mode undecided.";
        const verdict = await classifyTaskMode(classifier(), firstUserInput, params.reason, facts);
        if (verdict !== undefined) {
          effective = verdict;
          classifiedBy = projectConfig.llmGuards.model;
        }
      }
      // The pure rule engine decides; this tool only supplies FACTS. Consent
      // is obtained below by the EXTENSION (there is deliberately no
      // "confirmed" parameter the model could set). hasChanges = THIS
      // session's own edits only (pre-existing changes arm the gate via
      // state.hasCodeChange but must not force a confirmation dialog on the
      // first classification).
      const decision = evaluateModeChange({
        current: state.taskMode,
        requested: effective,
        hasChanges: sessionEdited,
        hasUI: ctx.hasUI,
        downgradesLocked: agentDowngradesLocked,
        firstDecideAuto: classifiedBy !== null,
      });

      if (decision.action === "noop") {
        return {
          content: [{ type: "text", text: `review-gate: gate mode is already "${effective}".` }],
          details: { mode: effective },
        };
      }

      if (decision.action === "apply") {
        setTaskMode(effective, decision.source, ctx as unknown as ExtensionContext);
        try {
          const sourceNote = classifiedBy
            ? `（由 ${classifiedBy} 自动判定，无需确认）`
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
              (classifiedBy ? ` — DeepSeek V4 首次自动判定，无需用户确认` : "") +
              (classifiedBy && effective !== requested
                ? `。你请求的是 "${requested}"，已以模型判定为准。`
                : ".") +
              goalNote,
          }],
          details: { mode: effective, source: decision.source, classifiedBy },
        };
      }

      if (decision.action === "confirm") {
        // USER CONSENT — rendered by the extension with fixed consequence copy;
        // the agent's reason is displayed as clearly-labeled untrusted data.
        // The dialog must describe what "yes" actually grants: the decision was
        // computed on `effective` (the LLM verdict wins over the agent's pick),
        // so the copy is built from `effective` — never from `requested`.
        let ok = false;
        try {
          ok = await ctx.ui.confirm(MODE_CONFIRM_TITLE, buildModeConfirmMessage(effective, params.reason));
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
            "Continue: fix → re-review → record_review → precommit → declare_done. Do not summarize; execute."
          : `\n(completion continuation ${completionContinuations}/${COMPLETION_CONTINUATION_CAP}) ` +
            "Continue: work these off — Copilot threads get a fix + resolve or a reply explaining why " +
            "not (check_copilot_review verifies), an unapproved goal gets negotiated and submitted via " +
            "propose_loop_goal. Do not summarize; execute.") +
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
    // P-multi: re-derive the primary repo and reset per-repo tracking for the
    // new session (a switched session may target a different checkout).
    primaryRepoRoot = gitRootOfDir(cwd) ?? cwd;
    activeRepoRoot.current = primaryRepoRoot;
    sessionRepos.clear();
    sessionRepos.add(primaryRepoRoot);
    repoStateCache.clear();
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
    projectConfig = loadProjectConfig(cwd);
    state.maxRounds = projectConfig.maxRounds;

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
    if (!state.hasCodeChange && !state.hasDocChange && !state.bypass.active) {
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
        pi.sendUserMessage(buildWorkflowPrompt(name, args ?? ""));
      },
    });
  }

  for (const name of Object.keys(WORKFLOW_COMMANDS) as WorkflowCommandName[]) {
    registerWorkflowCommand(name);
  }

  pi.registerCommand("gate-status", {
    description: "Show review-gate state",
    handler: async (_args, ctx) => {
      const fp = computeFingerprint(cwd);
      const problems = unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync });
      const others = otherRepoStatus();
      const lines = [
        `review:    ${state.review.verdict}${state.review.at ? ` (${state.review.at})` : ""}`,
        `precommit: ${state.precommit.verdict}${state.precommit.at ? ` (${state.precommit.at})` : ""}`,
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
            ` (round ${state.copilot.rounds}/${projectConfig.copilotReview.maxRounds}` +
            `${state.copilot.note ? `; ${state.copilot.note.slice(0, 120)}` : ""})`]
          : []),
        `bypass:    ${state.bypass.active ? `ACTIVE (${state.bypass.reason})` : "off"}`,
        `fingerprint: ${fp.unavailable ? "UNAVAILABLE" : fp.digest.slice(0, 12)}`,
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
        ? await ctx.ui.confirm("Bypass review gate?", `Reason: ${reason}\nDisables ship blocking until /gate-reset.`)
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

    // Normal mode (always user-consented): the extension steps aside — no
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
      systemPrompt += "\n\n" + buildLoopGoalDirective(readLoopGoal(primaryRepoRoot), loopGoalConfirmed());
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
        "independent second opinion, pinned to a top-tier model at xhigh thinking) BEFORE " +
        "and DURING non-trivial, ambiguous, or risky work \u2014 consulting early is cheaper " +
        "than a failed review later. The `reviewer` (also a top-tier model at xhigh) is the " +
        "independent gatekeeper that emits the recorded verdict.\n" +
        "Prohibited while gates are unmet (sd0x-dev-flow auto-loop rules): claiming a fix " +
        "is done without re-reviewing; asking for permission to continue the loop; citing " +
        "context length or token budget as a reason to skip review; outputting a polished " +
        "completion-style summary. Brief status lines are fine; execute the next step.\n" +
        "EXCEPTION — genuine blockers: if progress is stopped by a question only the user can " +
        "answer (ambiguous requirement, a product decision, missing access), call " +
        "pause_for_question with the question, then ask it in your reply and end the turn. " +
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
        (problems.length
          ? `Current unmet:\n${problems.map((p) => `- ${p}`).join("\n")}`
          : "All gates satisfied — you may ship."),
    };
  });
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
      const timer = setTimeout(() => { timedOut = true; killProcessTree(child); }, 20 * 60 * 1000);
      const onAbort = () => { aborted = true; killProcessTree(child); };
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      let settled = false;
      const finish = (out: SpawnOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
    const fp = computeFingerprint(cwd);
    const fingerprint = fp.unavailable ? "" : fp.digest;

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
    // into it (see failedStepNames' docstring).
    const failedSteps = failedStepNames(parsed);
    if (v.verdict === "PASS") {
      if (!fingerprint) return fail("worktree fingerprint unavailable post-run");
      return { verdict: "PASS", checksRun: v.checksRun, checksFailed: v.checksFailed, fingerprint, logPath, failedSteps };
    }
    return {
      verdict: v.verdict, checksRun: v.checksRun, checksFailed: v.checksFailed,
      fingerprint, error: v.error, logPath, failedSteps,
    };
  } catch (e) {
    return fail(`runner spawn failed: ${(e as Error).message}`);
  } finally {
    // Single-use: destroy the receipt dir no matter what. The log has already
    // been copied out to the repo by then.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
