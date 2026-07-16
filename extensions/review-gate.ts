/**
 * pi-review-gate — quality gates for Pi.
 *
 * Enforcement layers:
 *   L1 Ship gate (HARD)  — tool_call blocks git commit/push & gh pr create
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
 *   L5 Commit/PR English — tool_call blocks git commit / gh pr create whose
 *                          message or PR title/body contains a non-Latin script
 *                          (commit & PR text must be English).
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
 *   R9  opt-in [GIT_CONTEXT] git memory after compaction (filtered, capped)
 *   R10 one-shot [STRATEGIC_RESET] think-harder checklist near the round cap
 *   —   auto-loop prohibited behaviors in the per-turn reminder
 *   —   .git/ internals in SENSITIVE_FILE_PATTERNS (pre-edit-guard port)
 *   —   /gate-lesson self-improvement log (.pi/review-gate-lessons.md)
 */

import { existsSync, statSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin, dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  STRATEGIC_RESET_OFFSET,
  STRATEGIC_RESET_CHECKLIST,
} from "./lib/constants.ts";
import { defaultProjectConfig, loadProjectConfig, type ProjectConfig } from "./lib/project-config.ts";
import { buildGitMemory } from "./lib/git-memory.ts";
import { detectShipCommands, extractCommitMessages, extractPrTextFields } from "./lib/ship-detect.ts";
import { firstNonEnglish } from "./lib/lang-detect.ts";
import { validatePrecommitReceipt } from "./lib/precommit-receipt.ts";
import { changedFiles, computeFingerprint } from "./lib/fingerprint.ts";
import {
  emptyState,
  isPlateaued,
  loadSidecar,
  saveSidecar,
  shouldStrategicReset,
  sidecarPath,
  unmetRequirements,
  type GateState,
} from "./lib/gate-state.ts";
import { parseReviewOutput, parsePrecommitOutput } from "./lib/verdict-parse.ts";

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
      for (const e of entries) {
        if ((e.customType) === ENTRY_TYPE && e.data?.state?.schema === 1) {
          restored = e.data.state;
          if (typeof e.data.continuationsInjected === "number") restoredInjections = e.data.continuationsInjected;
        }
      }
    } catch { /* session manager unavailable */ }

    // Fall back to sidecar for cross-process state (L3 hooks read it).
    if (!restored) {
      restored = loadSidecar(sidecarPath(cwd));
    }

    // Sidecar corruption detection: file exists but couldn't parse → fail-closed.
    const sidecarFile = sidecarPath(cwd);
    let sidecarCorrupt = false;
    try {
      if (existsSync(sidecarFile) && statSync(sidecarFile).isFile() && !restored) {
        sidecarCorrupt = true;
      }
    } catch { /* best effort */ }

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
  }

  function updateWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const parts: string[] = [];
    if (state.bypass.active) {
      parts.push("gate: BYPASSED");
    } else if (!state.hasCodeChange && !state.hasDocChange) {
      parts.push("gate: idle");
    } else {
      parts.push(`review: ${state.review.verdict}`);
      parts.push(`precommit: ${state.precommit.verdict}`);
      parts.push(`round ${state.rounds.length}/${state.maxRounds}`);
    }
    try { ctx.ui.setStatus("review-gate", parts.join(" · ")); } catch { /* non-TUI */ }
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
      return;
    }

    if (event.toolName !== "bash") return;
    const command = typeof input.command === "string" ? input.command : "";
    if (!command) return;

    // P0-5: detect ALL ship commands, not just the first. Block if ANY operation
    // would ship ungated and warn about compound commands.
    const ships = detectShipCommands(command);
    if (ships.length === 0) return;

    // Short-circuit: if no changes tracked, no gate to enforce.
    if (!state.hasCodeChange && !state.hasDocChange) return;

    // AI attribution + English-language (L5) checks on commit messages and PR
    // title/description. commit messages and PR title/body must be English;
    // block if a non-Latin script is present.
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
        const nonEn = firstNonEnglish(msgs);
        if (nonEn) {
          return {
            block: true,
            reason: `review-gate: commit message must be English (L5). Non-English text found: "${nonEn.slice(0, 60)}". Rewrite the message in English.`,
          };
        }
      } else if (s.kind === "pr-create") {
        const nonEn = firstNonEnglish(extractPrTextFields(s.segment));
        if (nonEn) {
          return {
            block: true,
            reason: `review-gate: PR title/description must be English (L5). Non-English text found: "${nonEn.slice(0, 60)}". Rewrite the title and body in English.`,
          };
        }
      }
    }

    const fp = computeFingerprint(cwd);
    const problems = unmetRequirements(state, fp.digest, fp.unavailable);
    if (problems.length === 0) return;

    // P0-5: warn about compound commands where later ops might ship after HEAD changes.
    const desc = ships.length > 1
      ? `compound command with ${ships.map(s => s.kind).join(" + ")}`
      : ships[0].kind;

    return {
      block: true,
      reason:
        `review-gate: ${desc} blocked — quality gates unmet:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        (ships.length > 1 ? "\nCompound ship commands are unsafe: later operations run after HEAD changes. Split them." : "") +
        `\nRun the review loop to clear the gate, or /gate-bypass <reason>.`,
    };
  });

  // ---------- track edits & precommit results ----------

  pi.on("tool_result", async (event, ctx) => {
    // 1. Edits: only arm gate on success.
    if (EDIT_TOOL_NAMES.has(event.toolName)) {
      if (event.isError) return;
      const path = coalesceToolPath(event.input as Record<string, unknown>);
      if (!path) return;
      let dirty = false;
      if (isCodeFile(path) && !state.hasCodeChange) { state.hasCodeChange = true; dirty = true; }
      if (isDocFile(path) && !state.hasDocChange) { state.hasDocChange = true; dirty = true; }
      if (isCodeFile(path) || isDocFile(path)) {
        if (state.review.verdict === "READY") state.review.verdict = "PENDING";
        if (state.precommit.verdict === "PASS") state.precommit.verdict = "NOT_RUN";
        loopArmed = true;
        dirty = true;
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
            persist(ctx);
          }
        }
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
            text: "review-gate: no recognizable review verdict found. The reviewer must output a JSON fence with " +
              `{"gate":"READY"|"BLOCKED"|"NEEDS_HUMAN","findings":[...]}. Gate remains PENDING (fail-closed).`,
          }],
          details: {},
        };
      }

      const fp = computeFingerprint(cwd);
      state.review = {
        verdict: parsed.verdict,
        fingerprint: parsed.verdict === "READY" ? fp.digest : null,
        at: new Date().toISOString(),
      };
      state.rounds.push({
        round: state.rounds.length + 1,
        findingsTotal: parsed.findingsTotal,
        fingerprints: parsed.findingFingerprints,
        at: new Date().toISOString(),
      });

      let note = "";
      if (parsed.verdict === "NEEDS_HUMAN") {
        loopArmed = false;
        note = " Auto-loop disarmed — waiting for a human decision.";
      } else if (state.rounds.length >= state.maxRounds) {
        loopArmed = false;
        note = ` Max rounds (${state.maxRounds}) reached — escalate to the user.`;
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
      const mode = params.mode === "full" ? "full" : "fast";
      const outcome = runTrustedPrecommit(mode);

      if (outcome.verdict === "PASS") {
        // Bind PASS to the fingerprint recomputed AFTER the runner finished
        // (a lint:fix step may have modified files).
        state.precommit = { verdict: "PASS", fingerprint: outcome.fingerprint, at: new Date().toISOString() };
      } else {
        state.precommit = { verdict: outcome.verdict, fingerprint: null, at: new Date().toISOString() };
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
      const problems = unmetRequirements(state, fp.digest, fp.unavailable);
      if (problems.length > 0) {
        return {
          content: [{
            type: "text",
            text: "review-gate: declare_done REJECTED — gates unmet:\n" +
              problems.map((p) => `  - ${p}`).join("\n") +
              "\nComplete the loop (fix → review → record_review → precommit) and try again.",
          }],
          details: { accepted: false, problems },
          isError: true,
        };
      }
      loopArmed = false;
      persist(ctx as unknown as ExtensionContext);
      return {
        content: [{ type: "text", text: `review-gate: done accepted. ${params.summary}` }],
        details: { accepted: true },
      };
    },
  });

  // ---------- L2: auto-continuation ----------

  pi.on("agent_settled", async (_event, ctx) => {
    if (!loopArmed) return;
    if (state.bypass.active) return;
    if (!state.hasCodeChange && !state.hasDocChange) return;
    if (continuationsInjected >= state.maxRounds) return;
    if (!ctx.isIdle()) return;

    const fp = computeFingerprint(cwd);
    const problems = unmetRequirements(state, fp.digest, fp.unavailable);
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
    let sessionId: string | null = null;
    try { sessionId = (ctx.sessionManager as { getSessionId?: () => string }).getSessionId?.() ?? null; } catch { /* */ }
    restore(ctx, sessionId);
    state.sessionId = sessionId;

    // Per-project overrides (sd0x-dev-flow R6): maxRounds is clamped to [3,50]
    // by the loader, so a forged config cannot make the cap unreachable.
    projectConfig = loadProjectConfig(cwd);
    state.maxRounds = projectConfig.maxRounds;

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

    persist(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    const fp = computeFingerprint(cwd);
    const problems = unmetRequirements(state, fp.digest, fp.unavailable);
    if (problems.length === 0 || state.bypass.active) return;
    // R9 (git memory, opt-in): filtered git snapshot so the model recovers its
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

  pi.registerCommand("gate-status", {
    description: "Show review-gate state",
    handler: async (_args, ctx) => {
      const fp = computeFingerprint(cwd);
      const problems = unmetRequirements(state, fp.digest, fp.unavailable);
      const lines = [
        `review:    ${state.review.verdict}${state.review.at ? ` (${state.review.at})` : ""}`,
        `precommit: ${state.precommit.verdict}${state.precommit.at ? ` (${state.precommit.at})` : ""}`,
        `changes:   code=${state.hasCodeChange} docs=${state.hasDocChange}`,
        `rounds:    ${state.rounds.length}/${state.maxRounds}`,
        `config:    thinkHarder=${projectConfig.thinkHarder}${state.strategicResetFired ? " (fired)" : ""} gitMemory=${projectConfig.gitMemory}`,
        `bypass:    ${state.bypass.active ? `ACTIVE (${state.bypass.reason})` : "off"}`,
        `fingerprint: ${fp.unavailable ? "UNAVAILABLE" : fp.digest.slice(0, 12)}`,
        problems.length ? `ship gate: BLOCKED\n${problems.map((p) => `  - ${p}`).join("\n")}` : "ship gate: OPEN",
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

  pi.registerCommand("gate-reset", {
    description: "Reset review-gate state for this session",
    handler: async (_args, ctx) => {
      state = emptyState(state.sessionId, state.maxRounds);
      loopArmed = true;
      continuationsInjected = 0;
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

    const fp = computeFingerprint(cwd);
    const problems = unmetRequirements(state, fp.digest, fp.unavailable);
    if (!state.hasCodeChange && !state.hasDocChange && problems.length === 0) {
      return { systemPrompt };
    }

    return {
      systemPrompt:
        systemPrompt +
        "\n\n## Review Gate (enforced)\n" +
        "pi-review-gate is active. After editing code you MUST: " +
        "(1) run an independent review, (2) call record_review with the FULL reviewer output, " +
        "(3) fix all findings and re-review until READY, " +
        "(4) run the precommit runner, (5) call declare_done. " +
        "git commit/push and gh pr create are HARD-BLOCKED until gates pass.\n" +
        "You are ENCOURAGED to proactively consult the `adviser` subagent (a stronger, " +
        "independent second opinion, pinned to a top-tier model at xhigh thinking) BEFORE " +
        "and DURING non-trivial, ambiguous, or risky work \u2014 consulting early is cheaper " +
        "than a failed review later. The `reviewer` (also a top-tier model at xhigh) is the " +
        "independent gatekeeper that emits the recorded verdict.\n" +
        "Prohibited while gates are unmet (sd0x-dev-flow auto-loop rules): claiming a fix " +
        "is done without re-reviewing; asking for permission to continue the loop; citing " +
        "context length or token budget as a reason to skip review; outputting a polished " +
        "completion-style summary. Brief status lines are fine; execute the next step.\n" +
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
 */
function runTrustedPrecommit(mode: "fast" | "full"): PrecommitOutcome {
  const cwd = process.cwd();
  const fail = (error: string): PrecommitOutcome =>
    ({ verdict: "ERROR", checksRun: 0, checksFailed: 0, fingerprint: "", error });

  const runner = resolveTrustedRunner();
  if (!runner) return fail("trusted precommit runner not found");

  let dir: string;
  try { dir = mkdtempSync(pathJoin(tmpdir(), "rg-precommit-")); } catch { return fail("cannot create temp dir"); }
  const receipt = pathJoin(dir, "receipt.json");
  const nonce = randomBytes(24).toString("hex");

  try {
    const res = spawnSync(
      process.execPath,
      [runner, "--mode", mode, "--cwd", cwd, "--receipt", receipt, "--nonce", nonce],
      { cwd, encoding: "utf8", timeout: 20 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, shell: false,
        // Do NOT leak the nonce to child lint/test processes.
        env: { ...process.env } },
    );

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
      exitStatus: res.status, signal: res.signal, spawnError: !!res.error,
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
