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

import { existsSync, statSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, dirname as pathDirname } from "node:path";
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
} from "./lib/constants.ts";
import { defaultProjectConfig, loadProjectConfig, type ProjectConfig } from "./lib/project-config.ts";
import { buildGitMemory } from "./lib/git-memory.ts";
import { detectShipCommands, extractCommitMessages, extractPrTextFields } from "./lib/ship-detect.ts";
import { firstNonEnglish, containsNonLatinLetter } from "./lib/lang-detect.ts";
import { validatePrecommitReceipt } from "./lib/precommit-receipt.ts";
import { advisoryChangeToken, changedFiles, computeFingerprint } from "./lib/fingerprint.ts";
import type { Fingerprint } from "./lib/fingerprint.ts";
import {
  emptyState,
  isPlateaued,
  isOscillating,
  countOscillations,
  loadSidecar,
  migrateFingerprintVersion,
  FINGERPRINT_MIGRATION_NOTICE,
  saveSidecar,
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
   */
  function maybeStrategicReset(): string {
    if (!shouldStrategicReset(state, projectConfig.thinkHarder, STRATEGIC_RESET_OFFSET)) return "";
    state.strategicResetFired = true;
    return "\n\n" + STRATEGIC_RESET_CHECKLIST;
  }

  // ---------- persistence ----------

  function persist(ctx: ExtensionContext) {
    try {
      saveSidecar(sidecarPath(cwd), state);
      // P1-5: clear stale .blocked marker on successful write.
      try { unlinkSync(sidecarPath(cwd) + ".blocked"); } catch { /* didn't exist */ }
    } catch {
      try { writeFileSync(sidecarPath(cwd) + ".blocked", "FAILED_WRITE"); } catch { /* */ }
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
        return {
          block: true,
          reason: `review-gate: "${path}" matches a sensitive-file pattern (.env/keys/credentials). Ask the user to edit it themselves.`,
        };
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
    if (ships.length === 0) {
      // Guard #4 additional layer (tighten-only): the static parser saw no ship
      // op, but the command mentions git/gh with dynamic shell constructs the
      // parser cannot resolve (encodings, aliases, substitutions). Ask flash
      // whether it would ship; only a positive answer ADDS a detection — "none"
      // or a failed call changes nothing (the command was passing anyway).
      if (
        projectConfig.llmGuards.shipDetect &&
        (state.hasCodeChange || state.hasDocChange) &&
        isSuspiciousShipCandidate(command)
      ) {
        const kind = await classifyShipCommand(classifier(), command);
        if (kind !== undefined && kind !== "none") {
          ships.push({ kind, segment: command });
        }
      }
      if (ships.length === 0) return;
    }

    // Short-circuit: if no changes tracked, no gate to enforce.
    if (!state.hasCodeChange && !state.hasDocChange) return;

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

    const fp = computeFingerprint(cwd);
    const problems = unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync });
    if (problems.length === 0) return;

    // Single-use arbiter bypass token (lib/arbitration.ts). Only a lone,
    // in-scope `gh pr edit` (title/body) can EVER match — the token is bound to
    // the exact command + worktree fingerprint + review round + body-file
    // content, and is consumed on the first authorized run. It never bypasses
    // commit/push/pr-create (those are not arbitrable, so no token is ever
    // issued for them) and never touches the code review loop.
    if (ships.length === 1 && ships[0].kind === "pr-edit" && bypassToken && !fp.unavailable) {
      const parsed = parseArbitrableAction(command);
      if (parsed.ok) {
        const bindings = await computeTokenBindings(parsed.action, fp.digest);
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
    const blockReason =
      `review-gate: ${desc(command, ships)} blocked — quality gates unmet:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      (ships.length > 1 ? "\nCompound ship commands are unsafe: later operations run after HEAD changes. Split them." : "");
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
      let dirty = false;
      if (isCodeFile(path) && !state.hasCodeChange) { state.hasCodeChange = true; dirty = true; }
      if (isDocFile(path) && !state.hasDocChange) { state.hasDocChange = true; dirty = true; }
      if (isCodeFile(path) || isDocFile(path)) {
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
        if (verdict && verdict !== "PASS" && state.precommit.verdict === "PASS") {
          state.precommit = { verdict, fingerprint: null, at: new Date().toISOString() };
          persist(ctx);
        }
      }
      // P0-7: re-arm gate if a git operation restored dirty state
      // without going through an edit tool (bypass prevention).
      if (cmd && /(^|[\s;&|])(git\s+(stash\s+(pop|apply)|checkout|switch|restore|reset\s+--hard|merge|pull|rebase|cherry-pick|am)|gh\s+pr\s+checkout)\b/.test(cmd)) {
        const files = changedFiles(cwd);
        if (files && files.length > 0) {
          if (files.some(isCodeFile) && !state.hasCodeChange) { state.hasCodeChange = true; }
          if (files.some(isDocFile) && !state.hasDocChange) { state.hasDocChange = true; }
          if (state.hasCodeChange || state.hasDocChange) {
            if (state.review.verdict === "READY") state.review.verdict = "PENDING";
            if (state.precommit.verdict === "PASS") state.precommit.verdict = "NOT_RUN";
            clearBypassToken();
            persist(ctx);
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
      delete state.pausedQuestion;
      const fp = computeFingerprint(cwd);
      state.review = {
        verdict: parsed.verdict,
        fingerprint: parsed.verdict === "READY" ? fp.digest : null,
        at: new Date().toISOString(),
        // Code↔doc attestation travels with the verdict it came from; absent
        // stays absent (blocks under the docSync knob — fail-closed).
        ...(parsed.docSync !== undefined ? { docSync: parsed.docSync } : {}),
      };
      state.rounds.push({
        round: state.rounds.length + 1,
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
      } else if (state.rounds.length >= state.maxRounds) {
        loopArmed = false;
        note = ` Max rounds (${state.maxRounds}) reached — escalate to the user.`;
      } else if (isOscillating(state.rounds, OSCILLATION_LIMIT)) {
        // The reviewer keeps flipping READY→BLOCKED with fresh findings instead
        // of converging. Disarm the auto-loop and escalate (tighten-only: this
        // never permits a ship, it only stops the churn so a human/adviser can
        // break the tie). Plateau below stays for the stuck-on-same-finding case.
        loopArmed = false;
        note = ` Oscillation detected (${countOscillations(state.rounds)} READY→BLOCKED flips) — ` +
          "the review is not converging. Escalate to the user or consult the adviser subagent " +
          "instead of burning more rounds.";
      } else if (isPlateaued(state.rounds, PLATEAU_ROUNDS)) {
        loopArmed = false;
        note = " Plateau detected — escalate to the user.";
      } else if (parsed.verdict === "BLOCKED") {
        // R10: still blocked and approaching the cap → one-shot rethink nudge.
        note = maybeStrategicReset();
      }

      persist(ctx as unknown as ExtensionContext);
      return {
        content: [{
          type: "text",
          text: `review-gate: recorded verdict ${parsed.verdict} (round ${state.rounds.length}/${state.maxRounds}, findings: ${parsed.findingsTotal ?? "?"}).${note}` +
            (parsed.verdict === "READY" ? " Next: run precommit." : parsed.verdict === "BLOCKED" ? " Next: fix ALL findings and re-review." : ""),
        }],
        details: { verdict: parsed.verdict, round: state.rounds.length },
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
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      // Available in every mode: explore allows edits/bash, so the agent may
      // legitimately want to verify its investigation with the trusted runner.
      const mode = params.mode === "full" ? "full" : "fast";
      // Same liveness rule as record_review: running precommit proves the
      // agent is not waiting on the user — clear any stale question pause.
      delete state.pausedQuestion;
      // P1 fix: pass the session cwd. runTrustedPrecommit previously derived
      // its own process.cwd(), which can differ from ctx.cwd (e.g. pi --cwd),
      // running checks — and binding the PASS fingerprint — in the wrong dir.
      const outcome = await runTrustedPrecommit(cwd, mode, _signal);

      if (outcome.verdict === "PASS") {
        // Bind PASS to the fingerprint recomputed AFTER the runner finished
        // (a lint:fix step may have modified files).
        state.precommit = { verdict: "PASS", fingerprint: outcome.fingerprint, at: new Date().toISOString() };
      } else {
        // P0 fix: "ERROR" is a runner-protocol outcome, NOT a GateState
        // PrecommitVerdict enum member. Persisting it would make loadSidecar
        // and the git pre-commit hook reject the whole sidecar as forged
        // (fail-closed — which then bricks even the USER's manual commits).
        // Map ERROR → NOT_RUN (accurate: no trusted verdict was recorded);
        // FAIL / NO_CHECKS_RUN persist as themselves. The error detail still
        // reaches the model via the tool result text below.
        const persisted = outcome.verdict === "ERROR" ? "NOT_RUN" : outcome.verdict;
        state.precommit = { verdict: persisted, fingerprint: null, at: new Date().toISOString() };
      }
      persist(ctx as unknown as ExtensionContext);

      const detail =
        outcome.verdict === "PASS" ? `PASS (${outcome.checksRun} checks ran, 0 failed).`
        : outcome.verdict === "FAIL" ? `FAIL (${outcome.checksFailed}/${outcome.checksRun} checks failed).`
        : outcome.verdict === "NO_CHECKS_RUN" ? "NO CHECKS RUN — zero runnable checks; this is NOT a pass. Configure real checks or /gate-bypass."
        : `ERROR (${outcome.error ?? "runner could not be trusted"}) — fail-closed.`;
      return {
        content: [{ type: "text", text: `review-gate: precommit ${detail}` }],
        details: { verdict: outcome.verdict, checksRun: outcome.checksRun, checksFailed: outcome.checksFailed },
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
      const fp = computeFingerprint(cwd);
      const problems = unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync });
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
      // satisfied. This only clears already-satisfied history — the next code
      // edit re-arms hasCodeChange and a fresh review is still required, so it
      // cannot loosen the gate.
      state.rounds = [];
      state.strategicResetFired = false;
      // P1 fix: the L2 auto-continuation budget must reset with the task too.
      // continuationsInjected is capped against maxRounds in agent_settled; if
      // task A consumed it, task B in the same session would get ZERO
      // auto-continuations. Like rounds above, this only clears satisfied
      // history — it cannot loosen the ship gate.
      continuationsInjected = 0;
      persist(ctx as unknown as ExtensionContext);
      return {
        content: [{ type: "text", text: `review-gate: done accepted. ${params.summary}` }],
        details: { accepted: true },
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
        return {
          content: [{
            type: "text",
            text:
              `review-gate: gate mode set to "${effective}" (source: ${decision.source})` +
              (classifiedBy ? ` — DeepSeek V4 首次自动判定，无需用户确认` : "") +
              (classifiedBy && effective !== requested
                ? `。你请求的是 "${requested}"，已以模型判定为准。`
                : "."),
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
    if (!state.hasCodeChange && !state.hasDocChange) return;
    if (continuationsInjected >= state.maxRounds) return;
    if (!ctx.isIdle()) return;

    const fp = computeFingerprint(cwd);
    const problems = unmetRequirements(state, fp.digest, fp.unavailable, { requireDocSync: projectConfig.docSync });
    if (problems.length === 0) return;

    continuationsInjected += 1;
    // R10: fire the strategic-reset checklist BEFORE persist so the fired flag
    // survives restarts (one-shot per gate-state lifetime).
    const reset = maybeStrategicReset();
    persist(ctx);
    pi.sendUserMessage(
      "[REVIEW_GATE_RESUME] Quality gates are still unmet:\n" +
        problems.map((p) => `- ${p}`).join("\n") +
        `\n(continuation ${continuationsInjected}/${state.maxRounds}) ` +
        "Continue: fix → re-review → record_review → precommit → declare_done. Do not summarize; execute." +
        reset,
      { deliverAs: "followUp" },
    );
  });

  // ---------- lifecycle ----------

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    // USER REQUIREMENT: "no changes" for the first classification means THIS
    // session — a new session starts with a clean edit slate even if the
    // worktree carries pre-existing changes from before (they still arm the
    // ship gate via the P0-2 detection below).
    sessionEdited = false;
    let sessionId: string | null = null;
    try { sessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.() ?? null; } catch { /* */ }
    restore(ctx, sessionId);
    state.sessionId = sessionId;

    // Per-project overrides (sd0x-dev-flow R6): maxRounds is clamped to [3,50]
    // by the loader, so a forged config cannot make the cap unreachable.
    projectConfig = loadProjectConfig(cwd);
    state.maxRounds = projectConfig.maxRounds;

    // A restored pause survives the restart: keep auto-continuation disarmed
    // until the user's next message clears it (input handler).
    if (state.pausedQuestion) loopArmed = false;

    // P0-2: detect pre-existing changes — worktree AND branch commits.
    if (!state.hasCodeChange && !state.hasDocChange && !state.bypass.active) {
      const files = changedFiles(cwd);
      const hasDirtyFiles = files && files.length > 0;
      const ahead = await commitsAheadOfBase(cwd);
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

    // Clean orphan .blocked marker from a prior session.
    try { unlinkSync(sidecarPath(cwd) + ".blocked"); } catch { /* didn't exist */ }

    // Explain an invalidated binding instead of letting READY silently become
    // PENDING after an upgrade (see migrateFingerprintVersion).
    if (fingerprintMigrated) {
      try { ctx.ui.notify(FINGERPRINT_MIGRATION_NOTICE, "warning"); } catch { /* headless */ }
      fingerprintMigrated = false;
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
    const files = changedFiles(cwd);
    if (files === undefined) return;
    if (files.length === 0 && (await commitsAheadOfBase(cwd)) === 0) {
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
      const lines = [
        `review:    ${state.review.verdict}${state.review.at ? ` (${state.review.at})` : ""}`,
        `precommit: ${state.precommit.verdict}${state.precommit.at ? ` (${state.precommit.at})` : ""}`,
        `changes:   code=${state.hasCodeChange} docs=${state.hasDocChange}`,
        `docSync:   ${projectConfig.docSync ? `ENFORCED (attested: ${state.review.docSync ?? "none"})` : "off"}`,
        `rounds:    ${state.rounds.length}/${state.maxRounds}`,
        `config:    thinkHarder=${projectConfig.thinkHarder}${state.strategicResetFired ? " (fired)" : ""} gitMemory=${projectConfig.gitMemory}`,
        `task mode: ${state.taskMode ?? "undecided (behaves as loop; agent decides via set_gate_mode)"}`,
        ...(state.pausedQuestion
          ? [`paused:    awaiting user answer to "${state.pausedQuestion.question.slice(0, 120)}" (${state.pausedQuestion.at})`]
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
      ];
      ctx.ui.notify(lines.join("\n"), problems.length ? "warning" : "info");
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
      agentDowngradesLocked = false;
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

async function runTrustedPrecommit(cwd: string, mode: "fast" | "full", abortSignal?: AbortSignal): Promise<PrecommitOutcome> {
  const fail = (error: string): PrecommitOutcome =>
    ({ verdict: "ERROR", checksRun: 0, checksFailed: 0, fingerprint: "", error });

  const runner = resolveTrustedRunner();
  if (!runner) return fail("trusted precommit runner not found");
  if (abortSignal?.aborted) return fail("aborted before start");

  let dir: string;
  try { dir = mkdtempSync(pathJoin(tmpdir(), "rg-precommit-")); } catch { return fail("cannot create temp dir"); }
  const receipt = pathJoin(dir, "receipt.json");
  const nonce = randomBytes(24).toString("hex");

  try {
    const res = await new Promise<SpawnOutcome>((resolve) => {
      let aborted = false;
      let timedOut = false;
      const child = spawn(
        process.execPath,
        [runner, "--mode", mode, "--cwd", cwd, "--receipt", receipt, "--nonce", nonce],
        { cwd, shell: false, detached: true, stdio: ["ignore", "ignore", "ignore"],
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
        resolve(out);
      };
      child.on("error", () => finish({ status: null, signal: null, spawnError: true, aborted, timedOut }));
      child.on("close", (status, signal) => finish({ status, signal, spawnError: false, aborted, timedOut }));
    });

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
    if (v.verdict === "PASS") {
      if (!fingerprint) return fail("worktree fingerprint unavailable post-run");
      return { verdict: "PASS", checksRun: v.checksRun, checksFailed: v.checksFailed, fingerprint };
    }
    return { verdict: v.verdict, checksRun: v.checksRun, checksFailed: v.checksFailed, fingerprint, error: v.error };
  } catch (e) {
    return fail(`runner spawn failed: ${(e as Error).message}`);
  } finally {
    // Single-use: destroy the receipt dir no matter what.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
