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
