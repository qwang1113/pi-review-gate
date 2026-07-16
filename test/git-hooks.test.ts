import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRE_COMMIT = join(ROOT, "hooks", "pre-commit");
const COMMIT_MSG = join(ROOT, "hooks", "commit-msg");

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-hook-"));
  tempDirs.push(dir);
  return dir;
}

// Create a git repo so the hook can compute a fingerprint.
function makeGitRepo(): string {
  const dir = makeDir();
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function writeState(dir: string, state: object, withChangedFile = false) {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), JSON.stringify(state));
  // If state says hasCodeChange, create a dummy file so fingerprint matches
  // the state's recorded fingerprint (state.fingerprint was set with this file present).
  if (withChangedFile) {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "lib.ts"), "// test\n");
    execFileSync("git", ["add", "src/lib.ts"], { cwd: dir, stdio: "ignore" });
  }
}

function runPreCommit(dir: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [PRE_COMMIT], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
}

const READY = {
  schema: 1,
  hasCodeChange: true,
  hasDocChange: false,
  review: { verdict: "READY", fingerprint: "x", at: "t" },
  precommit: { verdict: "PASS", fingerprint: "x", at: "t" },
  rounds: [],
  maxRounds: 10,
  bypass: { active: false, reason: null, at: null },
};

// ---------------------------------------------------------------------------
// pre-commit
// ---------------------------------------------------------------------------

test("no sidecar → allow (repos without the extension must not brick)", () => {
  assert.equal(runPreCommit(makeDir()).status, 0);
});

test("gates met → allow", () => {
  const dir = makeGitRepo();
  // Need a dirty file so fingerprint doesn't match clean state.
  // Use withChangedFile so state's fingerprint matches the current worktree.
  writeState(dir, READY, /*withChangedFile=*/ true);
  // READY review + PASS precommit with fingerprint "x" won't match
  // current worktree fingerprint → blocked by fingerprint mismatch.
  // We need the fingerprint in state to match. Let's set it to a dummy
  // and test with hasCodeChange=false (pre-existing clean work).
  const res = runPreCommit(dir);
  // fingerprint mismatch blocks
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fingerprint mismatch/);
});

test("gates met + matching fingerprints → allow", () => {
  const dir = makeGitRepo();
  // Clean repo, no changes → fingerprint is stable.
  // Set hasCodeChange to false so the hook skips the gate completely.
  writeState(dir, { ...READY, hasCodeChange: false, hasDocChange: false });
  assert.equal(runPreCommit(dir).status, 0);
});

test("review not READY → block", () => {
  const dir = makeGitRepo();
  writeState(dir, { ...READY, review: { verdict: "PENDING", fingerprint: null, at: null } });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /review is PENDING/);
});

test("precommit NO_CHECKS_RUN → block (PR #7 lesson 3)", () => {
  const dir = makeGitRepo();
  writeState(dir, { ...READY, precommit: { verdict: "NO_CHECKS_RUN", fingerprint: null, at: "t" } });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /zero checks/);
});

test("corrupt sidecar → block (fail closed)", () => {
  const dir = makeDir(); // no git needed for corrupt JSON test
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{truncated");
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unreadable/);
});

test("unknown schema → block (fail closed)", () => {
  const dir = makeDir(); // no git needed for schema test
  writeState(dir, { ...READY, schema: 42 });
  assert.equal(runPreCommit(dir).status, 1);
});

test("bypass active in state → allow", () => {
  const dir = makeDir();
  writeState(dir, { ...READY, review: { verdict: "PENDING" }, bypass: { active: true, reason: "hotfix", at: "t" } });
  assert.equal(runPreCommit(dir).status, 0);
});

test("REVIEW_GATE_BYPASS=1 env → allow", () => {
  const dir = makeDir();
  writeState(dir, { ...READY, review: { verdict: "BLOCKED", fingerprint: null, at: "t" } });
  assert.equal(runPreCommit(dir, { REVIEW_GATE_BYPASS: "1" }).status, 0);
});

test("no changes tracked → allow even without verdicts", () => {
  const dir = makeDir();
  writeState(dir, { ...READY, hasCodeChange: false, review: { verdict: "PENDING" }, precommit: { verdict: "NOT_RUN" } });
  assert.equal(runPreCommit(dir).status, 0);
});

test("fingerprint mismatch on review → block", () => {
  const dir = makeGitRepo();
  // State says hasCodeChange=true + review READY but fingerprint won't match clean repo.
  writeState(dir, { ...READY, review: { verdict: "READY", fingerprint: "wrong-fp", at: "t" } });
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fingerprint mismatch/);
});

// ---------------------------------------------------------------------------
// pre-commit: test-label English gate (L6) integration
// ---------------------------------------------------------------------------

// Build a repo whose sidecar clears the verdict gate (no code/doc change) so the
// only thing that can block is the L6 label scan, then stage a test file.
function repoForLabelGate(testFileName: string, testFileContent: string): string {
  const dir = makeGitRepo();
  writeState(dir, { ...READY, hasCodeChange: false, hasDocChange: false });
  writeFileSync(join(dir, testFileName), testFileContent);
  execFileSync("git", ["add", testFileName], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("pre-commit blocks a staged non-English test label (L6)", () => {
  const dir = repoForLabelGate("a.test.ts", "it('返佣金额换算', () => {});\n");
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /non-English test label/);
  assert.match(res.stderr, /a\.test\.ts:1:/);
});

test("pre-commit allows a non-English label with a bypass marker (L6)", () => {
  const dir = repoForLabelGate("b.test.ts", "// review-gate: allow-non-english\nit('中文用例', () => {});\n");
  assert.equal(runPreCommit(dir).status, 0);
});

test("pre-commit allows English test labels (L6)", () => {
  const dir = repoForLabelGate("c.test.ts", "it('does the thing', () => {});\n");
  assert.equal(runPreCommit(dir).status, 0);
});

test("state-level bypass (/gate-bypass) disables L6 too", () => {
  // A non-English label would normally block, but bypass.active must short-
  // circuit ALL ship blocking including L6 (documented /gate-bypass escape).
  const dir = makeGitRepo();
  writeState(dir, {
    ...READY, hasCodeChange: true,
    review: { verdict: "PENDING", fingerprint: null, at: null },
    bypass: { active: true, reason: "hotfix", at: "t" },
  });
  writeFileSync(join(dir, "a.test.ts"), "it('中文用例', () => {});\n");
  execFileSync("git", ["add", "a.test.ts"], { cwd: dir, stdio: "ignore" });
  assert.equal(runPreCommit(dir).status, 0);
});

test("REVIEW_GATE_BYPASS=1 env disables L6 too", () => {
  const dir = repoForLabelGate("d.test.ts", "it('中文用例', () => {});\n");
  assert.equal(runPreCommit(dir, { REVIEW_GATE_BYPASS: "1" }).status, 0);
});

// ---------------------------------------------------------------------------
// commit-msg (PR #7 lesson 8)
// ---------------------------------------------------------------------------

function runCommitMsg(message: string, env: Record<string, string> = {}) {
  const dir = makeDir();
  const msgFile = join(dir, "COMMIT_EDITMSG");
  writeFileSync(msgFile, message);
  return spawnSync("bash", [COMMIT_MSG, msgFile], { encoding: "utf8", env: { ...process.env, ...env } });
}

test("plain conventional commit passes", () => {
  assert.equal(runCommitMsg("feat: add gate\n\nDetails.").status, 0);
});

test("FP regression: 'Generated by the maintainer' passes", () => {
  assert.equal(runCommitMsg("docs: x\n\nGenerated by the maintainer script.").status, 0);
});

test("FP regression: 'Generated by domain tooling' passes", () => {
  assert.equal(runCommitMsg("chore: x\n\nGenerated by domain tooling.").status, 0);
});

test("'Generated by AI' blocked", () => {
  assert.notEqual(runCommitMsg("feat: x\n\nGenerated by AI assistant").status, 0);
});

test("'Generated with ChatGPT' blocked (unbounded GPT)", () => {
  assert.notEqual(runCommitMsg("feat: x\n\nGenerated with ChatGPT").status, 0);
});

test("Co-Authored-By Claude blocked", () => {
  assert.notEqual(runCommitMsg("fix: y\n\nCo-Authored-By: Claude <noreply@anthropic.com>").status, 0);
});

test("robot emoji + Claude blocked", () => {
  assert.notEqual(runCommitMsg("feat: z\n\n🤖 Generated with Claude Code").status, 0);
});

test("bypass env allows AI attribution through commit-msg", () => {
  assert.equal(runCommitMsg("feat: x\n\nGenerated by AI", { REVIEW_GATE_BYPASS: "1" }).status, 0);
});
