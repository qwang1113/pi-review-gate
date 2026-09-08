#!/usr/bin/env node
/**
 * One-process pre-commit check (2026-09-08, goal ②).
 *
 * The git hook used to cold-start node FOUR times per commit: an inline
 * sidecar shape/bypass check, the L6 label scanner, the staged-divergence
 * checker (with --emit-fingerprint), and an inline verdict comparison. This
 * module runs the whole chain in ONE node process; hooks/pre-commit is now a
 * thin shell that only sanitizes variables, fails closed on the snapshot
 * layouts, and execs this file.
 *
 * The two checkers are REQUIRED IN-PROCESS (not spawned): scan-test-labels.cjs
 * and check-staged-divergence.cjs both gained a wrapped entry (`main` /
 * `runMain`) with the CLI behaviour byte-identical when run standalone. Their
 * process.exit calls are intercepted for the in-process call, and the
 * divergence fingerprint's stdout is captured the same way — the hook's own
 * stdout stays empty, exactly as it was when bash captured FP_JSON.
 *
 * The whole chain lives in runCheck() so tests can require this module and
 * drive it directly (the heredoc logic it replaced was un-requireable).
 *
 * Exit codes mirror the old hook chain: 0 = allow, 1 = block (any reason),
 * 10 = state bypass, 11 = user-chosen advisory (both mapped to allow by the
 * shell). The REVIEW_GATE_BYPASS=1 fast path never reaches this file (the
 * shell handles it before exec).
 *
 * Usage: node pre-commit-check.cjs <stateFile>   (cwd = the repository)
 * Env:    REVIEW_GATE_REQUIRE_FULL=1  (pre-push: full-lane requirement)
 *         GIT_INDEX_FILE              (git's own, for commit -a / -- <path>)
 */
const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const os = require("node:os");

const CHECK_DIR = __dirname;

// LAZY requires, on purpose: the partial-install tests (and real older
// installs) may lack one of the checkers. Loading them up front would turn a
// "checker missing → warn / fail closed with the right message" situation
// into a bare MODULE_NOT_FOUND crash. Only a MODULE_NOT_FOUND FOR THE PATH
// ITSELF means "not installed" — a missing transitive dependency of an
// installed script is a real failure and stays fatal.
function requireOrNull(path) {
  try {
    return require(path);
  } catch (err) {
    if (err && err.code === "MODULE_NOT_FOUND") {
      // Only a missing module NAMED IN THE FIRST LINE counts as "not
      // installed". A missing TRANSITIVE dep lists the required script in
      // its 'Require stack:' trailer, so matching the whole message would
      // silently skip an installed-but-broken script.
      const firstLine = String(err.message).split("\n")[0];
      if (firstLine.includes(path)) return null;
    }
    throw err; // a REAL failure (syntax, a missing transitive dep) stays fatal
  }
}

const divergenceScript = join(CHECK_DIR, "check-staged-divergence.cjs");
const labelScript = join(CHECK_DIR, "scan-test-labels.cjs");
const fingerprintScript = join(CHECK_DIR, "compute-fingerprint.cjs");

/**
 * The whole hook verdict chain (was: two inline node heredocs + two script
 * spawns). `statePath` is the sidecar path (relative to `repo` or absolute),
 * `repo` the repository root the hook runs in. process.exit is used for the
 * verdicts exactly like the chain it replaces — the CLI path exits natively,
 * a test caller wraps the call in an exit interceptor and reads the code.
 */
function runCheck(statePath, repo, env = process.env) {
  const repoRoot = resolve(repo);

  // -------------------------------------------------------------------------
  // 1. Sidecar shape + bypass/advisory verdicts (was the first inline node
  //    heredoc). Exit codes 10 (bypass) / 11 (user-chosen advisory) mean the
  //    shell hook allows (it maps them to exit 0).
  // -------------------------------------------------------------------------
  const GATE_VERDICTS = new Set(["PENDING", "READY", "BLOCKED", "NEEDS_HUMAN"]);
  const PRECOMMIT_VERDICTS = new Set(["PASS", "FAIL", "NO_CHECKS_RUN", "NOT_RUN"]);

  const readState = () => {
    let state;
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      console.error("[review-gate] gate state unreadable — failing closed.");
      process.exit(1);
    }
    const nullableString = (v) => v === null || typeof v === "string";
    const validRound = (r) => r && Number.isInteger(r.round) && r.round > 0 &&
      (r.findingsTotal === null || (Number.isInteger(r.findingsTotal) && r.findingsTotal >= 0)) &&
      Array.isArray(r.fingerprints) && r.fingerprints.every((v) => typeof v === "string") &&
      typeof r.at === "string";
    if (state.schema !== 1) {
      console.error("[review-gate] unknown gate schema — failing closed.");
      process.exit(1);
    }
    if (!nullableString(state.sessionId) ||
        typeof state.hasCodeChange !== "boolean" || typeof state.hasDocChange !== "boolean" ||
        !state.review || !GATE_VERDICTS.has(state.review.verdict) ||
        !nullableString(state.review.fingerprint) || !nullableString(state.review.at) ||
        (state.review.docSync !== undefined && state.review.docSync !== "UPDATED" && state.review.docSync !== "NOT_NEEDED") ||
        !state.precommit || !PRECOMMIT_VERDICTS.has(state.precommit.verdict) ||
        !nullableString(state.precommit.fingerprint) || !nullableString(state.precommit.at) ||
        (state.precommit.mode !== undefined &&
          state.precommit.mode !== "fast" && state.precommit.mode !== "full") ||
        (state.precommit.testScope !== undefined &&
          state.precommit.testScope !== "related" && state.precommit.testScope !== "full" &&
          state.precommit.testScope !== "skipped") ||
        !Array.isArray(state.rounds) || !state.rounds.every(validRound) ||
        !Number.isInteger(state.maxRounds) || state.maxRounds < 3 || state.maxRounds > 50 ||
        !state.bypass || typeof state.bypass.active !== "boolean" ||
        !nullableString(state.bypass.reason) || !nullableString(state.bypass.at) ||
        (state.taskMode !== undefined && state.taskMode !== "loop" && state.taskMode !== "explore" && state.taskMode !== "normal") ||
        (state.taskModeSource !== undefined && state.taskModeSource !== "auto" && state.taskModeSource !== "user") ||
        (state.strategicResetFired !== undefined && typeof state.strategicResetFired !== "boolean") ||
        (state.pausedQuestion !== undefined &&
          !(state.pausedQuestion && typeof state.pausedQuestion === "object" &&
            typeof state.pausedQuestion.question === "string" &&
            typeof state.pausedQuestion.at === "string")) ||
        (state.scopeLimit !== undefined &&
          !(state.scopeLimit && typeof state.scopeLimit === "object" &&
            Array.isArray(state.scopeLimit.preexistingFiles) &&
            state.scopeLimit.preexistingFiles.every((v) => typeof v === "string") &&
            Array.isArray(state.scopeLimit.sessionFiles) &&
            state.scopeLimit.sessionFiles.every((v) => typeof v === "string") &&
            typeof state.scopeLimit.at === "string")) ||
        (state.sessionEditedFiles !== undefined &&
          !(Array.isArray(state.sessionEditedFiles) &&
            state.sessionEditedFiles.every((v) => typeof v === "string"))) ||
        (state.fingerprintVersion !== undefined && !Number.isInteger(state.fingerprintVersion)) ||
        (state.checkpoint !== undefined &&
          !(typeof state.checkpoint === "object" && state.checkpoint !== null &&
            typeof state.checkpoint.sha === "string" && /^[0-9a-f]{40}$/.test(state.checkpoint.sha) &&
            typeof state.checkpoint.at === "string")) ||
        typeof state.updatedAt !== "string") {
      console.error("[review-gate] gate state shape/verdict invalid — failing closed.");
      process.exit(1);
    }
    if (state.bypass.active) process.exit(10);
    // SECURITY: only a USER-chosen explore/normal (confirmed dialog or
    // /gate-mode) makes the hook advisory. An agent/auto classification must
    // never weaken the commit gate.
    if ((state.taskMode === "explore" || state.taskMode === "normal") &&
        state.taskModeSource === "user") process.exit(11);
    return state;
  };

  const state = readState();
  const requireFullTests = env.REVIEW_GATE_REQUIRE_FULL === "1";

  // -------------------------------------------------------------------------
  // Per-project docSync knob (defense-in-depth mirror of unmetRequirements).
  // Default ON; only an explicit `"docSync": false` in a valid config
  // disables. Project config wins; the user-global config is the fallback.
  // -------------------------------------------------------------------------
  const readDocSyncFlag = (path) => {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      if (cfg && typeof cfg === "object" && typeof cfg.docSync === "boolean") return cfg.docSync;
    } catch { /* missing/corrupt — fall through */ }
    return undefined;
  };
  const projectDocSync = readDocSyncFlag(join(repoRoot, ".pi", "review-gate.json"));
  const globalDocSync = readDocSyncFlag(join(os.homedir(), ".pi", "review-gate.json"));
  const docSyncEnforced =
    projectDocSync !== undefined ? projectDocSync
    : globalDocSync !== undefined ? globalDocSync
    : true;

  // -------------------------------------------------------------------------
  // 2. L6 test-label English gate (was `node "$LABEL_SCRIPT"`).
  //    Missing script → warn+skip (NOT fail-closed): an older install without
  //    this newer script must still be able to commit.
  // -------------------------------------------------------------------------
  const labels = requireOrNull(labelScript);
  if (labels) {
    const code = runWithExit(() => labels.main(repoRoot));
    if (code === 1) {
      console.error("[review-gate] Bypass: REVIEW_GATE_BYPASS=1 git commit ...");
      process.exit(1); // violations already printed by the scanner
    }
  } else {
    console.error("[review-gate] test-label scanner not installed (skipping L6) — reinstall hooks to enable.");
  }

  // -------------------------------------------------------------------------
  // 3. Staged/worktree divergence + fingerprint, ONE in-process run (was
  //    `FP_JSON=$(node "$DIVERGENCE_SCRIPT" … --emit-fingerprint)` with a
  //    separate compute fallback). The checker's stdout fingerprint is
  //    captured here — the hook's own stdout stays empty, as before.
  // -------------------------------------------------------------------------
  if (!existsSync(divergenceScript)) {
    // Missing script → FAIL CLOSED (the one guard for a core safety
    // property).
    console.error(`[review-gate] staged-divergence checker MISSING (${divergenceScript}) — failing closed.`);
    console.error("[review-gate] This check guards staged-vs-reviewed content; reinstall the hooks to restore it.");
    console.error("[review-gate] Bypass: REVIEW_GATE_BYPASS=1 git commit ...");
    process.exit(1);
  }
  // Probe the FILE SHAPE before requiring: a checker that predates the
  // require.main guard would execute its whole CLI at require time (with
  // argv[2] = the sidecar path) and exit the hook process. The shipped
  // checker is this package's own file, so the marker is stable. Older files
  // are spawned below, exactly like the pre-refactor hook ran them.
  let divergenceModern = false;
  try {
    divergenceModern = readFileSync(divergenceScript, "utf8").includes("function runMain");
  } catch { /* unreadable → treated as older; the spawn below fails closed */ }
  const divergence = divergenceModern ? requireOrNull(divergenceScript) : null;

  let fpJson = "";
  {
    const argv = [process.execPath, divergenceScript, repoRoot, env.GIT_INDEX_FILE || "", "--emit-fingerprint"];
    let code;
    let stdout = "";
    if (typeof divergence?.runMain === "function") {
      // New checker: run in-process (one node startup per commit). Its
      // fingerprint stdout is captured — the hook's own stdout stays empty.
      const captured = [];
      const origLog = console.log;
      console.log = (s) => { captured.push(String(s)); };
      try {
        divergence.runMain(argv, true); // interceptExit: the chain throws HookExit
        code = 0;
      } catch (err) {
        if (err instanceof divergence.HookExit) code = err.code;
        else throw err;
      } finally {
        console.log = origLog;
      }
      stdout = captured.join("\n");
    } else {
      // MIXED install: an OLDER checker predates runMain and executes its
      // whole CLI at require time (which would refuse with argv[2] = the
      // sidecar path), so it cannot run in-process. Spawn it like the
      // pre-refactor hook did — the check still runs, and its stdout stays
      // empty (older checkers do not know --emit-fingerprint), which is
      // exactly the mixed-install fallback condition below. argv.slice(1):
      // spawnSync takes the executable separately from its arguments.
      const spawned = spawnSync(process.execPath, argv.slice(1), { cwd: repoRoot, encoding: "utf8" });
      code = spawned.status ?? 1;
      stdout = spawned.stdout ?? "";
    }
    if (code === 1) {
      console.error("[review-gate] Bypass: REVIEW_GATE_BYPASS=1 git commit ...");
      process.exit(1); // divergence printed its block reason
    }
    fpJson = stdout;
  }
  // Fallback for a MIXED install (older checker that does not know
  // --emit-fingerprint and therefore printed nothing): compute the
  // fingerprint separately. Correctness is unaffected — only
  // single-materialization is lost.
  if (!fpJson.trim()) {
    const fingerprint = requireOrNull(fingerprintScript);
    if (!fingerprint) {
      console.error("[review-gate] cannot compute the worktree fingerprint — failing closed.");
      process.exit(1);
    }
    fpJson = JSON.stringify(fingerprint.compute(repoRoot));
  }

  // -------------------------------------------------------------------------
  // 4. Verdict comparison (was the second inline node heredoc). A worktree
  //    with nothing tracked is not an error state — it exits BEFORE the
  //    verdict chain, exactly where the old hook did (AFTER the L6/divergence
  //    checks, which run unconditionally past bypass).
  // -------------------------------------------------------------------------
  if (!state.hasCodeChange && !state.hasDocChange) process.exit(0);

  let currentFp;
  let runningVersion;
  try {
    const fp = JSON.parse(fpJson);
    if (fp.unavailable) throw new Error("fingerprint unavailable");
    runningVersion = fp.version;
    const fingerprint = requireOrNull(fingerprintScript);
    if (!fingerprint) throw new Error("fingerprint implementation missing");
    currentFp = fingerprint.worktreeTreeOid(repoRoot);
  } catch {
    console.error("[review-gate] cannot compute the worktree tree — failing closed.");
    process.exit(1);
  }

  // MESSAGE-ONLY REWRITE (mirror of lib/git-rewrite.ts isMessageOnlyRewrite):
  // a commit whose tree equals the one it replaces adds no content, so the
  // content gates have nothing to judge — except a PUSH, which publishes the
  // whole history (REVIEW_GATE_REQUIRE_FULL=1 is never exempt).
  if (!requireFullTests) {
    try {
      const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      let staged = true;
      try {
        // Honors GIT_INDEX_FILE, so `git commit -a`'s temporary index is the
        // one measured. Exit 1 = differences; any other failure stays "staged".
        execFileSync("git", ["diff", "--cached", "--quiet", "HEAD"], { cwd: repoRoot, stdio: "ignore" });
        staged = false;
      } catch { staged = true; }
      if (headTree && headTree === currentFp && !staged) process.exit(0);
    } catch { /* no HEAD (root commit) — the gates below apply as usual */ }
  }

  // FINGERPRINT ALGORITHM MIGRATION — recognise an old-algorithm binding and
  // say what to do, while still failing closed.
  const bindingVersion = state.fingerprintVersion;
  if ((state.hasCodeChange || state.hasDocChange) &&
      Number.isInteger(runningVersion) && bindingVersion !== runningVersion) {
    const boundTo = bindingVersion === undefined ? "an unversioned (pre-migration)" : `a v${bindingVersion}`;
    console.error(
      `[review-gate] fingerprint algorithm mismatch: the gate state carries ${boundTo} binding, ` +
      `this hook computes v${runningVersion}. The code was NOT modified — the binding simply cannot ` +
      "be verified under the current algorithm.");
    console.error("[review-gate] To clear it: (1) restart Pi (or /reload) so the extension picks up the " +
      "new algorithm, (2) run the precommit runner again, (3) get a fresh READY review.");
    console.error("[review-gate] Bypass: REVIEW_GATE_BYPASS=1 git commit ...");
    process.exit(1);
  }

  const problems = [];

  if (state.hasCodeChange) {
    if (state.review.verdict !== "READY") {
      problems.push(`review is ${state.review.verdict}`);
    } else if (!state.review.fingerprint) {
      problems.push("review PASS has no fingerprint binding — cannot verify");
    } else if (state.review.fingerprint !== currentFp) {
      problems.push("code was modified after the last READY review (fingerprint mismatch)");
    } else if (docSyncEnforced &&
               state.review.docSync !== "UPDATED" && state.review.docSync !== "NOT_NEEDED") {
      problems.push("docSync enforced: READY review lacks a code↔doc attestation (UPDATED | NOT_NEEDED)");
    }
    // Round-9 P1 / round-10 P1: the unreviewed-commit check is a STANDALONE
    // if, NOT an else-if on the fingerprint chain; it runs only when the
    // review passed every check above (problems.length === 0 — a length
    // guard, not error-message matching).
    if (state.review.verdict === "READY" && state.review.commitSha && state.review.fingerprint &&
        problems.length === 0) {
      let unreviewed = 0;
      try {
        const out = execFileSync("git", ["rev-list", "--format=%T", `${state.review.commitSha}..HEAD`], {
          cwd: repoRoot, encoding: "utf8",
        });
        unreviewed = out.split("\n").filter((l) => l && !l.startsWith("commit ") && l.trim() !== state.review.fingerprint).length;
      } catch {
        // Reviewed commit squashed/rebase away — the HEAD-tree match above is
        // the content proof; a rebase that changed content already failed the
        // fingerprint check.
        unreviewed = 0;
      }
      if (unreviewed > 0) {
        problems.push(`unreviewed commits since the last READY review (${unreviewed} commit(s) with content no reviewer saw) — checkpoint the new work and run the next review round before shipping`);
      }
    }

    // Fail-closed: only an explicit PASS bound to the current fingerprint passes.
    if (state.precommit.verdict === "PASS") {
      if (!state.precommit.fingerprint) {
        problems.push("precommit PASS has no fingerprint binding — cannot verify");
      } else if (state.precommit.fingerprint !== currentFp) {
        problems.push("code was modified after the last precommit PASS (fingerprint mismatch)");
      } else if (requireFullTests && state.precommit.testScope !== "full") {
        const covered = state.precommit.testScope || "unknown (sidecar predates the fast/full split)";
        problems.push(
          `push requires a FULL precommit run (tests covered: ${covered}) — ` +
          'the fast lane only runs the tests related to the changed files; re-run with mode "full"');
      }
    } else if (state.precommit.verdict === "NOT_RUN") {
      problems.push("precommit not run");
    } else if (state.precommit.verdict === "FAIL") {
      problems.push("precommit FAILED");
    } else if (state.precommit.verdict === "NO_CHECKS_RUN") {
      problems.push("precommit ran zero checks (not a pass)");
    } else {
      problems.push(`precommit verdict unrecognized (${String(state.precommit.verdict)})`);
    }
  } else if (state.hasDocChange) {
    if (state.review.verdict !== "READY") {
      problems.push(`doc review is ${state.review.verdict}`);
    } else if (!state.review.fingerprint) {
      problems.push("doc review PASS has no fingerprint binding");
    } else if (state.review.fingerprint !== currentFp) {
      problems.push("docs were modified after the last READY review (fingerprint mismatch)");
    }
  }

  if (problems.length) {
    console.error("[review-gate] commit blocked:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("[review-gate] Bypass: REVIEW_GATE_BYPASS=1 git commit ...");
    process.exit(1);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Exit interceptor for the in-process checker bodies (labels.main).
// ---------------------------------------------------------------------------
class HookExit extends Error {
  constructor(code) {
    super(`hook exit ${code}`);
    this.code = code;
  }
}

function runWithExit(fn) {
  const realExit = process.exit;
  process.exit = (code) => { throw new HookExit(code === undefined ? 0 : code); };
  try {
    fn();
    return 0;
  } catch (err) {
    if (err instanceof HookExit) return err.code;
    throw err;
  } finally {
    process.exit = realExit;
  }
}

// CLI entry. Requiring this module (tests) exposes runCheck without running
// anything — the chain the bash heredocs used to hide is now drivable.
if (require.main === module) {
  runCheck(process.argv[2], process.cwd());
}
module.exports = { runCheck, runWithExit, HookExit, requireOrNull };
