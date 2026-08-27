/**
 * Per-step precommit cache — end-to-end against a real git worktree.
 *
 * The cache is the answer to "a one-character README fix re-runs everything".
 * Because a hit SKIPS real work, the properties that matter are the negative
 * ones: it must miss whenever the step's inputs could have changed. These
 * tests drive the actual runner over a real repository rather than unit-testing
 * the key function, because the guarantee being checked is about git content,
 * not about a hash helper.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { hermeticGitEnv } from "./helpers/git.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(ROOT, "scripts", "precommit-runner.mjs");

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore", env: hermeticGitEnv() });
}

/** A real git repo whose only checks are cheap shell commands. */
function makeRepo(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-cache-"));
  tempDirs.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts }, null, 2));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "README.md"), "# hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

interface Step { name: string; status: string; cached: boolean; durationMs: number }

function run(dir: string, extra: string[] = []): { code: number | null; steps: Step[]; testScope: string } {
  const res = spawnSync("node", [RUNNER, "--cwd", dir, "--json", ...extra], { encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  return { code: res.status, steps: parsed.steps as Step[], testScope: parsed.testScope as string };
}

const ran = (steps: Step[]) => steps.filter((s) => s.status !== "skip");

// ---------------------------------------------------------------------------
// Hits
// ---------------------------------------------------------------------------

test("re-running an unchanged worktree reuses every step's PASS", () => {
  const dir = makeRepo({ lint: "true", typecheck: "true", build: "true" });
  const first = run(dir);
  assert.equal(first.code, 0);
  assert.ok(ran(first.steps).length >= 3);
  assert.ok(ran(first.steps).every((s) => !s.cached), "the first run cannot hit anything");

  const second = run(dir);
  assert.equal(second.code, 0);
  assert.ok(ran(second.steps).every((s) => s.cached), "an unchanged tree must hit every step");
});

test("a Markdown-only edit leaves every step cached", () => {
  // The headline case: docs churn must not re-run typecheck/build/test. `lint`
  // is deliberately absent here — linters do process Markdown, so their cache
  // busts on a doc change (covered below).
  const dir = makeRepo({ typecheck: "true", build: "true", test: "true" });
  run(dir);
  writeFileSync(join(dir, "README.md"), "# hello\n\nmore prose\n");
  const second = run(dir);
  assert.equal(second.code, 0);
  assert.ok(
    ran(second.steps).every((s) => s.cached),
    `expected all cached, got ${JSON.stringify(ran(second.steps))}`,
  );
});

// ---------------------------------------------------------------------------
// Misses — every one of these is a fail-open if it stops working
// ---------------------------------------------------------------------------

test("a source edit busts every step", () => {
  const dir = makeRepo({ lint: "true", typecheck: "true", build: "true" });
  run(dir);
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
  const second = run(dir);
  assert.ok(ran(second.steps).every((s) => !s.cached), "a code change must re-run every step");
});

test("a same-SIZE source edit busts the cache (the racily-clean trap)", () => {
  // `// v1` → `// v2` keeps size and mtime bucket identical. A stat-based key
  // would call this unchanged and skip the checks — the exact fail-open the
  // tree-based key exists to prevent.
  const dir = makeRepo({ typecheck: "true", build: "true" });
  writeFileSync(join(dir, "src", "a.ts"), "// v1\n");
  run(dir);
  writeFileSync(join(dir, "src", "a.ts"), "// v2\n");
  const second = run(dir);
  assert.ok(ran(second.steps).every((s) => !s.cached), "same-size edits must still bust the cache");
});

test("a Markdown edit DOES bust a lint step (linters read Markdown)", () => {
  const dir = makeRepo({ lint: "true", typecheck: "true" });
  run(dir);
  writeFileSync(join(dir, "README.md"), "# changed\n");
  const second = run(dir);
  const byName = Object.fromEntries(ran(second.steps).map((s) => [s.name, s]));
  assert.equal(byName.lint.cached, false, "lint must re-run on a doc change");
  assert.equal(byName.typecheck.cached, true, "typecheck must not");
});

test("a failing step is never cached — the fix always re-runs it", () => {
  const dir = makeRepo({ typecheck: "false", build: "true" });
  const first = run(dir);
  assert.equal(first.code, 1);
  const second = run(dir);
  const byName = Object.fromEntries(ran(second.steps).map((s) => [s.name, s]));
  assert.equal(byName.typecheck.cached, false, "a FAIL result must never be reused");
  assert.equal(byName.typecheck.status, "fail");
});

test("changing a step's command busts that step (a different check is a different result)", () => {
  const dir = makeRepo({ typecheck: "true" });
  run(dir);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "t", version: "1.0.0", scripts: { typecheck: "true # changed" } }, null, 2),
  );
  const second = run(dir);
  assert.ok(ran(second.steps).every((s) => !s.cached));
});

test("a lint:fix that EDITS the tree is never reused, and never mis-keys the other steps", () => {
  // The fail-open this guards against: `lint:fix` runs first and rewrites
  // files, so typecheck/build/test consume the FIXED tree. Keying them on the
  // pre-fix tree meant that restoring that pre-fix content later (a `git add`
  // + `git checkout -- .`, a stash cycle) replayed the entire run from cache —
  // publishing a PASS for a tree those checks had never seen, with the fix
  // itself skipped too.
  const dir = makeRepo({
    "lint:fix": "printf 'export const a = 1;\\n// fixed\\n' > src/a.ts",
    typecheck: "true",
  });
  const pristine = "export const a = 1;\n";

  const first = run(dir);
  assert.equal(first.code, 0);
  assert.ok(ran(first.steps).every((s) => !s.cached));

  // Restore the exact pre-fix content: the tree is now byte-identical to what
  // the first run STARTED from.
  writeFileSync(join(dir, "src", "a.ts"), pristine);
  const second = run(dir);
  const byName = Object.fromEntries(ran(second.steps).map((s) => [s.name, s]));
  assert.equal(byName.lint.cached, false, "an editing fix step must run again");
  // The fix really re-applied — the whole point is that its SIDE EFFECT is not
  // skippable, not merely that the log says it ran.
  assert.match(readFileSync(join(dir, "src", "a.ts"), "utf8"), /fixed/);
  // typecheck may legitimately hit here: it was recorded against the POST-fix
  // tree, and after the fix re-ran the tree is that same post-fix tree, which
  // is exactly the content it verified. What must never happen is the run
  // replaying entirely from cache while the fix is skipped.
  assert.ok(
    ran(second.steps).some((s) => !s.cached),
    "a restored pre-fix tree must never replay the whole run from cache",
  );
});

test("a NO-OP lint:fix stays reusable (the common steady state)", () => {
  // Once the tree is already clean the fix changes nothing, so reusing it
  // skips no side effect — this is what keeps the cache useful on repos that
  // do have a lint:fix script.
  const dir = makeRepo({ "lint:fix": "true", typecheck: "true" });
  run(dir);
  const second = run(dir);
  assert.ok(
    ran(second.steps).every((s) => s.cached),
    `expected all cached, got ${JSON.stringify(ran(second.steps))}`,
  );
});

test("after an editing fix, an unchanged POST-fix tree still hits", () => {
  // The other half of the rule: re-keying on the post-fix tree must not
  // destroy the cache, it must relocate it. The second run's fix is a no-op
  // (the file is already fixed), so everything downstream may be reused.
  const dir = makeRepo({
    "lint:fix": "grep -q fixed src/a.ts || printf 'export const a = 1;\\n// fixed\\n' > src/a.ts",
    typecheck: "true",
    build: "true",
  });
  run(dir);
  const second = run(dir);
  const byName = Object.fromEntries(ran(second.steps).map((s) => [s.name, s]));
  assert.equal(byName.typecheck.cached, true, "post-fix keys must survive into the next run");
  assert.equal(byName.build.cached, true);
});

test("no cache outside a git worktree — an untrackable tree is never assumed unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-nogit-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "1.0.0", scripts: { typecheck: "true" } }));
  run(dir);
  const second = run(dir);
  assert.ok(ran(second.steps).every((s) => !s.cached), "without git there is no trustworthy key");
});

test("running from a SUBDIRECTORY still anchors on the repo root", () => {
  // `git status --porcelain` reports repo-root-relative paths while the checks
  // run in `--cwd`. Anchoring on the repo root is what keeps the changed-file
  // list, the cache keys and the doc-framework probe consistent; getting it
  // wrong made related-test derivation silently match nothing.
  const dir = makeRepo({ typecheck: "true" });
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "package.json"), JSON.stringify({ name: "s", version: "1.0.0", scripts: { typecheck: "true" } }));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "sub"]);

  const sub = join(dir, "sub");
  const first = run(sub);
  assert.equal(first.code, 0);
  const second = run(sub);
  assert.ok(ran(second.steps).every((s) => s.cached), "a subdirectory run must still cache");
  // The cache belongs to the repo, not the subdirectory: `.pi/` is only
  // gate-owned (fingerprint-excluded) at the ROOT, so writing it anywhere else
  // would make every run invalidate its own binding.
  assert.ok(existsSync(join(dir, ".pi", "precommit-cache.json")), "cache lives at the repo root");
  assert.ok(!existsSync(join(sub, ".pi", "precommit-cache.json")), "never inside the subdirectory");

  // And a change ANYWHERE in the repo (not just under the subdirectory) busts it.
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 99;\n");
  assert.ok(ran(run(sub).steps).every((s) => !s.cached), "a repo-wide change must bust a subdirectory run");
});

// ---------------------------------------------------------------------------
// Lane reporting
// ---------------------------------------------------------------------------

test("a project with no test script reports testScope full in BOTH lanes", () => {
  // Nothing was narrowed away: a full run would cover the same empty set.
  // Reporting anything else would deadlock the push gate on such a repo.
  const dir = makeRepo({ typecheck: "true" });
  assert.equal(run(dir, ["--mode", "fast"]).testScope, "full");
  assert.equal(run(dir, ["--mode", "full"]).testScope, "full");
});

test("fast lane drops an underivable test step, and says so via testScope", () => {
  const dir = makeRepo({ typecheck: "true", test: "true" });
  const fast = run(dir, ["--mode", "fast"]);
  assert.equal(fast.testScope, "skipped");
  assert.equal(fast.steps.find((s) => s.name === "test")?.status, "skip");
  const full = run(dir, ["--mode", "full"]);
  assert.equal(full.testScope, "full");
  assert.equal(full.steps.find((s) => s.name === "test")?.status, "pass");
});

test("a lone underivable test suite still RUNS in the fast lane (never NO_CHECKS_RUN)", () => {
  // Dropping it would leave zero checks, so a repo whose only check is an
  // underivable suite could never commit. It runs in full instead.
  const dir = makeRepo({ test: "true" });
  const fast = run(dir, ["--mode", "fast"]);
  assert.equal(fast.code, 0);
  assert.equal(fast.testScope, "full");
  assert.equal(fast.steps.find((s) => s.name === "test")?.status, "pass");
});
