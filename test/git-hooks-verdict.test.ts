// Hook verdict/ship-gate tests: fingerprint migration, single materialization,
// installer snapshot refusal, unreviewed-commit and message-only-rewrite
// semantics. Split out of test/git-hooks.test.ts (2026-09-08) so the hook
// suites run as several files in parallel under node --test. Shared hermetic
// fixtures live in test/helpers/hook-fixtures.ts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, PRE_COMMIT, emptyHome, makeDir, makeGitRepo, writeState, runPreCommit, FP_VERSION, readyState, cleanupTempDirs } from "./helpers/hook-fixtures.ts";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

// Process-wide hermetic git (the shared fixtures neutralise too, but the
// hermetic-git guard requires the call to appear in THIS file's code).
neutraliseHostGitConfig();

after(cleanupTempDirs);

// ---------------------------------------------------------------------------
// FINGERPRINT ALGORITHM MIGRATION.
//
// A Pi extension is a resident process: it loads lib/fingerprint.ts once at
// session start and does not hot-reload. Right after an upgrade the extension
// therefore still writes bindings from the OLD algorithm while this hook
// already computes the NEW one, and the hook rejected the very commit the gate
// had just approved — reporting "code was modified after the last READY
// review" for a byte-identical worktree (reproduced while shipping this
// change: extension 7505ba86… vs hook 2d758793…). The hook must recognise that
// and say what to do, while still failing closed.

test("hook reports a MIGRATION (not a code change) for an unversioned binding", () => {
  const dir = makeGitRepo();
  const { fingerprintVersion, ...unversioned } = readyState(dir); // pre-migration sidecar
  void fingerprintVersion;
  writeState(dir, unversioned, /*withChangedFile=*/ true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1, "an unverifiable binding must still fail closed");
  assert.match(res.stderr, /fingerprint algorithm mismatch/);
  assert.match(res.stderr, /unversioned \(pre-migration\)/);
  assert.match(res.stderr, /code was NOT modified/);
  assert.match(res.stderr, /restart Pi/);
  assert.ok(!/code was modified after the last READY review/.test(res.stderr),
    "a migration must not be misreported as a code modification");
});

test("hook reports a MIGRATION for a binding from a different algorithm version", () => {
  const dir = makeGitRepo();
  writeState(dir, { ...readyState(dir), fingerprintVersion: FP_VERSION + 1 }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, new RegExp(`a v${FP_VERSION + 1} binding`));
  assert.match(res.stderr, /restart Pi/);
});

test("a forged non-integer fingerprintVersion is rejected by the shape check", () => {
  // Must not compare "equal" to the running version by type coercion.
  const dir = makeGitRepo();
  writeState(dir, { ...readyState(dir), fingerprintVersion: "2" }, true);
  const res = runPreCommit(dir);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /shape\/verdict invalid/);
});

test("no migration noise for a clean repo with no tracked changes", () => {
  // The migration check must not fire when there is nothing to gate; an
  // unversioned sidecar on an idle repo is not an error state.
  const dir = makeGitRepo();
  const { fingerprintVersion, ...unversioned } = readyState(dir);
  void fingerprintVersion;
  writeState(dir, { ...unversioned, hasCodeChange: false, hasDocChange: false });
  assert.equal(runPreCommit(dir).status, 0);
});

test("the current-version fixture does NOT take the migration path", () => {
  // Guards the fixture itself: if FP_VERSION drifts from the implementation,
  // every other hook test would silently exercise migration instead of gate
  // logic. Here the fingerprint simply mismatches, which is the normal path.
  const dir = makeGitRepo();
  writeState(dir, readyState(dir), true);
  const res = runPreCommit(dir);
  assert.ok(!/fingerprint algorithm mismatch/.test(res.stderr),
    `FP_VERSION (${FP_VERSION}) drifted from the shipped algorithm: ${res.stderr}`);
});

test("compute-fingerprint.cjs reports its algorithm version", () => {
  const dir = makeGitRepo();
  const out = JSON.parse(execFileSync("node", [
    join(ROOT, "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" }));
  assert.equal(out.version, FP_VERSION,
    "the hook compares against the version the running algorithm reports");
});

// ---------------------------------------------------------------------------
// ONE MATERIALIZATION PER HOOK INVOCATION.
//
// The checker needs the worktree tree to compare entries and the fingerprint
// needs a digest over the same content. Building it twice doubled the git work
// and — because a repository `clean` filter is an arbitrary program — allowed
// two passes over an UNCHANGED worktree to disagree about what it contains.
// A counting clean filter makes the number of passes directly observable.

// NOTE ON A REJECTED MEASUREMENT: counting `clean` filter invocations looked
// like the obvious way to prove "materialized once", but the count is not a
// stable observable — git re-runs the filter a variable number of times per
// pass depending on what the scratch index's stat cache still holds (measured
// on one unchanged repo: 2 invocations for the checker, 5 for the fingerprint,
// through the SAME materialization function). Asserting a count would produce
// a flaky test that fails for reasons unrelated to sharing. The property is
// therefore pinned structurally (below) plus behaviourally by the digest
// agreement test that follows.

test("the checker memoizes the worktree tree so one run materializes it once", () => {
  const src = readFileSync(join(ROOT, "scripts", "check-staged-divergence.cjs"), "utf8");
  assert.match(src, /worktreeTreeCache = new Map\(\)/,
    "the tree must be memoized per repo path, not rebuilt per caller");
  assert.match(src, /if \(!worktreeTreeCache\.has\(key\)\)[\s\S]{0,200}sharedWorktreeTreeOid\(cwd\)/,
    "a cache miss must be the ONLY path that materializes the tree");
  assert.match(src, /require\("\.\/compute-fingerprint\.cjs"\)/,
    "the checker must reuse the fingerprint's materialization, not keep a second copy");
  // Must hand over the RESOLVER, not one tree: passing a single top-level OID
  // silently degrades to a fresh materialization for every submodule (the
  // fingerprint recurses), which is where a `clean` filter could make the two
  // passes disagree. That degradation is invisible in the digest, so it needs
  // its own assertion.
  assert.match(src, /sharedCompute\([^)]*treeOidForCwd: worktreeTree/,
    "the memoized resolver must be handed to the fingerprint, not a single tree OID");
});

test("the checker fails closed if the shared fingerprint implementation is missing", () => {
  // The checker now depends on compute-fingerprint.cjs; a partial install must
  // block rather than silently fall back to a private implementation.
  const root = makeDir();
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "check-staged-divergence.cjs"),
    readFileSync(join(ROOT, "scripts", "check-staged-divergence.cjs"), "utf8"));
  const dir = makeGitRepo();
  const res = spawnSync("node", [join(root, "scripts", "check-staged-divergence.cjs"), dir], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1, "a checker without its fingerprint dependency must fail closed");
  assert.match(res.stderr, /cannot load the fingerprint implementation/);
});

test("--emit-fingerprint agrees with the standalone fingerprint script", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "a.ts"), "// content");
  const combined = JSON.parse(spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), dir, "", "--emit-fingerprint",
  ], { encoding: "utf8" }).stdout);
  const standalone = JSON.parse(execFileSync("node", [
    join(ROOT, "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" }));
  assert.equal(combined.digest, standalone.digest,
    "sharing the tree must not change the digest");
  assert.equal(combined.version, standalone.version);
  assert.equal(combined.head, standalone.head);
});

test("without --emit-fingerprint the checker prints nothing (older hooks keep working)", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "a.ts"), "// content");
  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), dir,
  ], { encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "", "the old contract is stdout-silent");
});

test("a BLOCKED run exits nonzero BEFORE emitting a fingerprint", () => {
  // The hook keys off the exit status, never off stdout being present: a
  // blocked run must not hand it a digest that could be mistaken for approval.
  const dir = makeGitRepo();
  writeFileSync(join(dir, "x.ts"), "// v1");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  writeFileSync(join(dir, "x.ts"), "// vA");
  execFileSync("git", ["add", "x.ts"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "x.ts"), "// vB");

  const res = spawnSync("node", [
    join(ROOT, "scripts", "check-staged-divergence.cjs"), dir, "", "--emit-fingerprint",
  ], { encoding: "utf8" });
  assert.equal(res.status, 1, "the divergence must still block");
  assert.match(res.stderr, /differs from the reviewed worktree/);
  assert.equal(res.stdout.trim(), "", "no fingerprint may be emitted once the commit is blocked");
});

test("the checker asks the divergence run for the fingerprint, with a fallback for mixed installs", () => {
  const checker = readFileSync(join(ROOT, "scripts", "pre-commit-check.cjs"), "utf8");
  assert.match(checker, /typeof divergence\?\.runMain === "function"/,
    "the checker must run the divergence + fingerprint chain in-process");
  assert.match(checker, /spawnSync\(process\.execPath, argv/,
    "an OLDER checker (predating runMain) must be spawned, not required — " +
    "its CLI would execute at require time with the sidecar as argv[2]");
});

test("a sparse-checkout (skip-worktree) repo can now be fingerprinted at all", () => {
  // Previously `git add` aborted with "outside of your sparse-checkout
  // definition" and the whole fingerprint failed closed, so such a repo could
  // never pass the gate. Clearing the bit in the scratch index fixes it.
  const dir = makeGitRepo();
  writeFileSync(join(dir, "a.ts"), "// v1");
  execFileSync("git", ["add", "a.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c"], {
    cwd: dir, stdio: "ignore",
  });
  execFileSync("git", ["update-index", "--skip-worktree", "a.ts"], { cwd: dir, stdio: "ignore" });

  const fp = JSON.parse(execFileSync("node", [
    join(ROOT, "scripts", "compute-fingerprint.cjs"), dir,
  ], { encoding: "utf8" }));
  assert.equal(fp.unavailable, false,
    "a skip-worktree repository must produce a usable fingerprint");
  assert.match(fp.digest, /^[0-9a-f]{40}$/);
});

test("REGRESSION: the hook installer REFUSES to run from a review snapshot", () => {
  // A review snapshot is a LINKED WORKTREE, so `.git/hooks` is the real repo's
  // hook layer, not a copy. Installing from inside one repointed the real hooks
  // at a snapshot directory that was then deleted with the round — after which
  // every commit died with "No such file or directory" from .git/hooks/pre-commit.
  // (Observed for real while committing this very change.)
  const repo = makeGitRepo();
  const snapshot = join(repo, ".pi", "review-snapshots", "rg-review-snap-XXXX", "integration");
  mkdirSync(snapshot, { recursive: true });
  // Make the snapshot path a real git worktree of the same repo, so
  // `rev-parse --show-toplevel` resolves there exactly as it does in production.
  execFileSync("git", ["worktree", "add", "--detach", "-f", snapshot, "HEAD"], {
    cwd: repo,
    stdio: "ignore",
  });

  const refused = spawnSync("bash", [join(ROOT, "scripts", "install-git-hooks.sh")], {
    cwd: snapshot,
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome },
  });
  assert.notEqual(refused.status, 0, "installing from a snapshot must FAIL");
  assert.match(refused.stderr, /refusing to install hooks from a review snapshot/);
  assert.match(refused.stderr, /shared with the real checkout/);
  // …and it must not have touched the shared hook dir.
  assert.equal(existsSync(join(repo, ".git", "hooks", "pre-commit")), false,
    "the refusal must happen BEFORE any hook is written");

  // The same installer still works from the real worktree.
  const ok = spawnSync("bash", [join(ROOT, "scripts", "install-git-hooks.sh")], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome },
  });
  assert.equal(ok.status, 0, ok.stderr);
  const installed = readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(installed, /pi-review-gate:installed/);
  // Assert the hook points at THIS package's real hook, by exact path.
  //
  // The obvious version of this check — `doesNotMatch(installed, /review-snapshots/)`
  // — is environment-dependent and was wrong: a reviewer runs the suite INSIDE a
  // snapshot, so ROOT itself contains `review-snapshots` and a perfectly correct
  // install then "failed". Same family as the earlier /tmp divergence: never
  // assert on a substring of the absolute path the test happens to live at.
  assert.ok(
    installed.includes(join(ROOT, "hooks", "pre-commit")),
    `the installed hook must exec this package's hook, got:\n${installed}`,
  );
  // …and never the TEST repo's snapshot copy (that is the failure being guarded).
  assert.equal(installed.includes(snapshot), false, "the hook must not point into a snapshot");

  try {
    execFileSync("git", ["worktree", "remove", "--force", snapshot], { cwd: repo, stdio: "ignore" });
  } catch { /* the dir is inside the temp repo and removed with it */ }
});

// ---------------------------------------------------------------------------
// Round-9 P1: unreviewed-commit check (content-changing commits after the
// reviewed commit must block even when HEAD's tree matches — a
// change-and-revert or a never-re-reviewed checkpoint ships unreviewed
// content otherwise). Behavior tests, not token-presence tests.
// The hook gates this branch on problems.length === 0 — a length guard, not
// error-message wording: any problem raised by the review checks above keeps
// the unreviewed-commit branch off (fail-safe; rephrasing a message can never
// re-gate it).
// ---------------------------------------------------------------------------

test("unreviewed-commit check: a content-changing commit after the reviewed commit BLOCKS", () => {
  const dir = makeGitRepo();
  // Reviewed commit C: state records commitSha + its tree.
  writeFileSync(join(dir, "code.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "reviewed"], { cwd: dir, stdio: "ignore" });
  const reviewedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const reviewedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  // New checkpoint AFTER the review with DIFFERENT content, then a revert
  // that restores the reviewed tree — HEAD tree matches, content shipped.
  writeFileSync(join(dir, "code.ts"), "export const v = 2;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "unreviewed"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "code.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "revert"], { cwd: dir, stdio: "ignore" });
  const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(headTree, reviewedTree, "fixture: HEAD tree equals the reviewed tree (change-and-revert)");
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "READY", fingerprint: reviewedTree, commitSha: reviewedSha, at: "t", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: headTree, at: "t" },
  });
  // Checked on the PUSH path: after the revert the worktree tree equals HEAD's,
  // so a COMMIT here would publish no content and is exempt by design
  // (message-only rewrite). A push publishes the whole history — including the
  // unreviewed commit — so that is where this check has to hold.
  const res = runPreCommit(dir, { REVIEW_GATE_REQUIRE_FULL: "1" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /unreviewed commits since the last READY/);
});

test("unreviewed-commit check: a squash of the reviewed tree does NOT block", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "code.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "reviewed"], { cwd: dir, stdio: "ignore" });
  const reviewedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const reviewedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  // Content-identical squash commit on top (same tree, new commit).
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "squash"], { cwd: dir, stdio: "ignore" });
  const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(headTree, reviewedTree);
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "READY", fingerprint: reviewedTree, commitSha: reviewedSha, at: "t", docSync: "NOT_NEEDED" },
    precommit: { verdict: "PASS", fingerprint: headTree, at: "t" },
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 0, `squash must keep the READY alive: ${res.stderr}`);
});

test("round-10 P1: docSync enforcement survives the unreviewed-commit branch (commitSha present, no attestation)", () => {
  // v10-1 regression: the unreviewed-commit check was chained as an else-if
  // keyed on the mere presence of review.commitSha, swallowing the docSync
  // branch behind it — record_review always sets commitSha on READY, so
  // docSync was unreachable at the hook layer. The check must be standalone.
  const dir = makeGitRepo();
  writeFileSync(join(dir, "code.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "reviewed"], { cwd: dir, stdio: "ignore" });
  const reviewedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const reviewedTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "READY", fingerprint: reviewedTree, commitSha: reviewedSha, at: "t" }, // NO docSync
    precommit: { verdict: "PASS", fingerprint: reviewedTree, at: "t" },
  });
  // Push path: the worktree is clean here, so a commit would publish HEAD's own
  // tree and is exempt (message-only rewrite). docSync must still hold on push.
  const res = runPreCommit(dir, { REVIEW_GATE_REQUIRE_FULL: "1" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /docSync enforced/,
    "docSync must still block when commitSha is present (it was unreachable before the fix)");
});

test("unreviewed-commit check: a fingerprint mismatch keeps the branch off (guard is problems.length === 0)", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "code.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "reviewed"], { cwd: dir, stdio: "ignore" });
  const reviewedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  // A real unreviewed commit sits on top, but the review fingerprint is stale:
  // the fingerprint chain already raised a problem, so the unreviewed-commit
  // branch must NOT run — it would only pile a second message on the real
  // cause. A per-message guard (p.includes("fingerprint")) would depend on
  // that exact wording; problems.length === 0 cannot.
  writeFileSync(join(dir, "code.ts"), "export const v = 2;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "unreviewed"], { cwd: dir, stdio: "ignore" });
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "READY", fingerprint: "wrong-fp", commitSha: reviewedSha, at: "t", docSync: "NOT_NEEDED" },
  });
  // Push path, same reason as above: the commit here would add no content.
  const res = runPreCommit(dir, { REVIEW_GATE_REQUIRE_FULL: "1" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fingerprint mismatch/);
  assert.doesNotMatch(res.stderr, /unreviewed commits since the last READY/,
    "a fingerprint problem must keep the unreviewed-commit branch off (length guard, not message matching)");
});

// ---------------------------------------------------------------------------
// Message-only rewrite (2026-08-29). Fixing a non-English commit message used
// to be impossible from inside a session: `git commit --amend` and
// `git rebase -i` reword both land here, and an unmet gate refused both. A
// commit that publishes HEAD's own tree adds no content, so the CONTENT gates
// have nothing to judge — but a PUSH publishes the whole history and stays
// gated.
// ---------------------------------------------------------------------------

test("a commit that publishes no new content passes even with the gate unmet", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "code.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "committed"], { cwd: dir, stdio: "ignore" });
  // Worktree clean ⇒ the tree an amend would publish equals HEAD's.
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "BLOCKED", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
  });
  const res = runPreCommit(dir);
  assert.equal(res.status, 0, `a message-only rewrite must not be blocked: ${res.stderr}`);
});

test("the same no-content state still BLOCKS a push", () => {
  const dir = makeGitRepo();
  writeFileSync(join(dir, "code.ts"), "export const v = 1;\n");
  execFileSync("git", ["add", "code.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "committed"], { cwd: dir, stdio: "ignore" });
  writeState(dir, {
    ...readyState(dir),
    review: { verdict: "BLOCKED", fingerprint: null, at: null },
    precommit: { verdict: "NOT_RUN", fingerprint: null, at: null },
  });
  const res = runPreCommit(dir, { REVIEW_GATE_REQUIRE_FULL: "1" });
  assert.equal(res.status, 1, "a push publishes history the exemption never judged");
  assert.match(res.stderr, /review is BLOCKED/);
});

test("commit-msg refuses a non-English message and accepts an English one", () => {
  const dir = makeGitRepo();
  const msg = join(dir, "MSG");
  writeFileSync(msg, "fix(api): handle expired tokens\n\n# a git comment 中文 is not the message\n");
  const ok = spawnSync("bash", [join(ROOT, "hooks", "commit-msg"), msg], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  writeFileSync(msg, "fix: 修复问题\n");
  const bad = spawnSync("bash", [join(ROOT, "hooks", "commit-msg"), msg], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not English/);
});
