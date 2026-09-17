// Direct unit tests for scripts/pre-commit-check.cjs (goal ②: the heredoc
// verdict chains used to be un-requireable — now runCheck is exported and
// drivable). These complement the 121 behavioural hook tests: they drive the
// module in-process, through its own exit codes, instead of through the shell.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { makeGitRepo, writeState, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { GATE_MODES, MODE_REGISTRY } from "../lib/gate-modes.ts";
import { normalizeTaskMode } from "../lib/task-mode.ts";

// The fixtures under test shell out to git; the hermetic-git guard requires
// the neutralisation call to appear in THIS file's code.
neutraliseHostGitConfig();

after(cleanupTempDirs);

const requireCjs = createRequire(import.meta.url);
const { runCheck, runWithExit } = requireCjs("../scripts/pre-commit-check.cjs") as {
  runCheck: (statePath: string, repo: string, env?: Record<string, string>) => void;
  runWithExit: <T>(fn: () => T) => number;
};

/** Run the check in-process; exit is intercepted; returns its exit code. */
function check(dir: string, extraEnv: Record<string, string> = {}): number {
  return runWithExit(() => runCheck(join(dir, ".pi", "review-gate-state.json"), dir, {
    ...process.env, HOME: "/tmp/rg-check-unit-home", ...extraEnv,
  }));
}

test("module is requireable and exposes the chain (no side effects at require)", () => {
  // The regression this pins: the pre-refactor module ran its whole chain at
  // require time with argv[2] = whatever the test process had.
  assert.equal(typeof runCheck, "function");
  assert.equal(typeof runWithExit, "function");
});

test("bypass active in state → exit 10 (shell maps to allow)", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "PENDING", fingerprint: null, at: null },
    bypass: { active: true, reason: "hotfix", at: "t" },
  });
  assert.equal(check(dir), 10);
});

test("an unreadable sidecar fails closed with exit 1", () => {
  const dir = makeGitRepo();
  writeState(dir, { schema: 1 } as object); // truncated/partial state → invalid
  const code = runWithExit(() =>
    runCheck(join(dir, ".pi", "review-gate-state.json"), dir, { ...process.env, HOME: "/tmp/rg-check-unit-home" }));
  assert.equal(code, 1);
});

test("gates met with matching fingerprint → exit 0", () => {
  const dir = makeGitRepo();
  // readyState() binds the tree AS IT STANDS — create + stage the content
  // first, then compute the state so the fingerprint really matches.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.ts"), "// x\n");
  execFileSync("git", ["add", "src/lib.ts"], { cwd: dir, stdio: "ignore" });
  writeState(dir, {
    ...(readyState(dir) as Record<string, unknown>),
    review: {
      ...((readyState(dir).review ?? {}) as Record<string, unknown>),
      docSync: "NOT_NEEDED",
    },
  });
  assert.equal(check(dir), 0);
});

/** A repo whose sidecar is READY+PASS bound to the CURRENT tree. */
function gatesMetRepo(extra: Record<string, unknown> = {}): string {
  const dir = makeGitRepo();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.ts"), "// x\n");
  execFileSync("git", ["add", "src/lib.ts"], { cwd: dir, stdio: "ignore" });
  const bound = readyState(dir) as Record<string, unknown>;
  const tree = (bound.review as Record<string, unknown>).fingerprint as string;
  writeState(dir, {
    ...bound,
    review: { verdict: "READY", fingerprint: tree, at: "t", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: tree, at: "t" },
    ...extra,
  });
  return dir;
}

/** Run the check and read back what it printed on stderr. */
function captureErr(fn: () => number): { code: number; err: string } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { code: fn(), err: lines.join("\n") };
  } finally {
    console.error = orig;
  }
}

test("review not READY → exit 1 with the standard wording", () => {
  const dir = makeGitRepo();
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "PENDING", fingerprint: null, at: null },
  }, /*withChangedFile=*/ true);
  assert.equal(check(dir), 1);
});

test("a staged non-English test label blocks the chain (L6 in-process)", () => {
  const dir = makeGitRepo();
  writeState(dir, { ...readyState(dir), hasCodeChange: false, hasDocChange: false });
  const staged = join(dir, "l6.test.ts");
  writeFileSync(staged, "it('中文标签', () => {});\n");
  execFileSync("git", ["add", "l6.test.ts"], { cwd: dir, stdio: "ignore" });
  assert.equal(check(dir), 1);
});

test("REVIEW_GATE_REQUIRE_FULL=1 with a fast-lane PASS → exit 1 (push gate)", () => {
  const dir = makeGitRepo();
  // Fingerprints must REALLY match so the lane branch is the ONLY thing that
  // can block — null fingerprints would trip the earlier 'no fingerprint
  // binding' problems and fail the test for the wrong reason.
  const base = readyState(dir) as Record<string, unknown>;
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.ts"), "// x\n");
  execFileSync("git", ["add", "src/lib.ts"], { cwd: dir, stdio: "ignore" });
  const bound = readyState(dir) as Record<string, unknown>;
  const tree = (bound.review as Record<string, unknown>).fingerprint as string;
  writeState(dir, {
    ...base,
    review: { verdict: "READY", fingerprint: tree, at: "t", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: tree, at: "t", mode: "fast", testScope: "related" },
  });
  const code = check(dir, { REVIEW_GATE_REQUIRE_FULL: "1" });
  assert.equal(code, 1);
  // Sanity: the same state without the push requirement passes (the lane gate
  // is what the env adds).
  assert.equal(check(dir), 0);
});

// ---------------------------------------------------------------------------
// THE SESSION-MODE WHITELIST — a TS/CJS pair, kept honest BEHAVIOURALLY
// ---------------------------------------------------------------------------
// The hook carries its own copy of the session-mode enum: it runs on every
// commit and push, in checkouts where the extension may not be loaded at all.
// It had drifted (2026-09-18): `orchestrator` had been a legal mode since
// lib/task-mode.ts introduced it, and was MISSING here — so every push from an
// orchestration was refused with "gate state shape/verdict invalid", a message
// that reads as a CORRUPT sidecar when the sidecar was fine. The state is one
// file per worktree, so the user's own `git push` was refused too.
//
// Behavioural, not textual (the same shape as the fingerprint pair in
// test/constants.test.ts): the modes are DERIVED from the gate's own registry
// and the checker is run once per mode. A mode added on the TS side and
// forgotten here is a RED test, not a fail-closed push.
test("the hook accepts every session mode the TS registry declares (drift guard)", () => {
  const sessionModes = GATE_MODES.filter((mode) => !MODE_REGISTRY[mode].internalOnly);
  // Self-proof: the derivation must still yield the four session modes — an
  // empty list would make every assertion below vacuous.
  assert.deepEqual([...sessionModes].sort(), ["explore", "loop", "normal", "orchestrator"]);

  // What each mode must do, from the two halves of the rule: explore/normal are
  // ADVISORY (exit 11) when the USER chose them; loop and orchestrator are not.
  const expected: Record<string, number> = { explore: 11, normal: 11, loop: 0, orchestrator: 0 };
  for (const mode of sessionModes) {
    assert.equal(normalizeTaskMode(mode), mode, `${mode} must also be a TaskMode (lib/task-mode.ts)`);
    const dir = gatesMetRepo({ taskMode: mode, taskModeSource: "user" });
    assert.equal(check(dir), expected[mode],
      `taskMode "${mode}" must be legal — and must never weaken the gate`);
  }
});

test("an orchestrator-mode sidecar is VALIDATED, not reported as corrupt (2026-09-18)", () => {
  const dir = gatesMetRepo({ taskMode: "orchestrator", taskModeSource: "user" });
  const { code, err } = captureErr(() => check(dir));
  assert.equal(code, 0, "the gates are met, so the mode is the only thing that could have blocked this");
  assert.doesNotMatch(err, /shape\/verdict invalid/, "a legal mode must never be reported as a corrupted sidecar");
});

test("a forged taskMode still fails closed — and SAYS so (a whitelist, not 'anything else')", () => {
  for (const forged of ["readonly", "orchestrator ", 7]) {
    const dir = gatesMetRepo({ taskMode: forged, taskModeSource: "user" });
    const { code, err } = captureErr(() => check(dir));
    assert.equal(code, 1, `forged taskMode ${JSON.stringify(forged)} must fail closed`);
    assert.match(err, /shape\/verdict invalid/,
      "an unknown mode IS a broken sidecar — that message is the honest one here");
  }
});
