/**
 * WHAT AN ISOLATED CHECKOUT IS SEEDED WITH (2026-09-15, onchain).
 *
 * The rule has two halves and both are pinned here: the DECISION (what may be
 * taken — only what the main checkout has AND git ignores) and the IO that
 * applies it. The measured failure behind it: a child whose worktree lacked
 * `.pi/review-gate.json` ran `yarn test` instead of the repository's
 * configured scoped jest, and 143 files failed for reasons unrelated to its
 * change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planWorktreeSeed, seedWorktree } from "../lib/worktree-seed.ts";
import { hermeticGitEnv } from "./helpers/git.ts";

test("only what git IGNORES and the main checkout HAS is taken", () => {
  const plan = planWorktreeSeed({
    exists: (path) => path === ".pi/review-gate.json" || path === "node_modules" || path === ".env",
    // `node_modules` is TRACKED in this fixture: a project that commits its
    // dependencies gets them from HEAD, so seeding it again would add an
    // untracked entry the gate's own fingerprint would read as a change.
    ignored: (path) => path !== "node_modules",
  });
  assert.deepEqual(
    plan.actions.map((a) => ({ kind: a.kind, path: a.path })),
    [
      { kind: "copy", path: ".pi/review-gate.json" },
      { kind: "link", path: ".env" },
    ],
    "the gate config is COPIED (a copy cannot be edited back) and .env is LINKED (one source of truth)",
  );
  const skipped = new Map(plan.skipped.map((s) => [s.path, s.reason]));
  assert.match(skipped.get("node_modules")!, /git 没有忽略它/, "a tracked path arrives with the commit — taking it again would be noise");
  for (const path of [".pi/settings.json", ".pi/agents", ".env.local"]) {
    assert.match(skipped.get(path)!, /主 checkout 里没有这个路径/, `${path} is simply absent`);
  }
});

test("a real checkout gets the gate config, .env and node_modules — and NOT the runtime state", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-seed-"));
  const repo = join(root, "repo");
  try {
    mkdirSync(join(repo, ".pi"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), ".pi/\n.env\nnode_modules/\n");
    writeFileSync(join(repo, ".pi/review-gate.json"), '{"precommit":{"test":{"fast":{"command":"scoped"}}}}\n');
    // RUNTIME state, which must never travel: two writers sharing one piece of
    // gate state is the exact damage the whole worktree mechanism prevents.
    writeFileSync(join(repo, ".pi/review-gate-state.json"), '{"review":{"verdict":"READY"}}\n');
    writeFileSync(join(repo, ".pi/orchestrator-plan.json"), '{"tasks":[]}\n');
    writeFileSync(join(repo, ".pi/precommit-cache.json"), '{}\n');
    writeFileSync(join(repo, ".env"), "MONGO=mongodb://127.0.0.1/onekey\n");
    mkdirSync(join(repo, "node_modules/dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules/dep/index.js"), "module.exports = 1;\n");
    writeFileSync(join(repo, "README.md"), "hi\n");

    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: hermeticGitEnv() });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init");

    // The checkout itself is not needed for the seed to be exercised — the
    // dispatcher creates it with `git worktree add` before calling this.
    const worktree = join(root, "repo-rg-child1");
    mkdirSync(worktree);

    const lines = seedWorktree(repo, worktree);

    const seededConfig = readFileSync(join(worktree, ".pi/review-gate.json"), "utf8");
    assert.match(seededConfig, /scoped/, "the repository's own precommit config is what the child must read");
    for (const linked of [".env", "node_modules"]) {
      assert.equal(lstatSync(join(worktree, linked)).isSymbolicLink(), true, `${linked} stays a single source of truth`);
    }
    for (const runtime of [".pi/review-gate-state.json", ".pi/orchestrator-plan.json", ".pi/precommit-cache.json"]) {
      assert.equal(existsSync(join(worktree, runtime)), false, `${runtime} is a SESSION's runtime, never seeded`);
    }
    assert.equal(lines.length, 3, "one receipt line per action (config copy + two links)");

    // A rerun (a recovered spawn, a re-created worktree) must converge rather
    // than fail on its own earlier work.
    const again = seedWorktree(repo, worktree);
    assert.equal(again.length, 3);
    assert.equal(lstatSync(join(worktree, ".env")).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a path git does NOT ignore is left alone, even when it exists", () => {
  const root = mkdtempSync(join(tmpdir(), "rg-seed-skip-"));
  const repo = join(root, "repo");
  try {
    mkdirSync(repo, { recursive: true });
    // `.env` is TRACKED here: taking it would create untracked content in the
    // isolated checkout, which the fingerprint and the review scope both read.
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, ".env"), "MONGO=committed\n");
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: hermeticGitEnv() });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");

    const worktree = join(root, "repo-rg-child1");
    mkdirSync(worktree);
    seedWorktree(repo, worktree);

    assert.equal(existsSync(join(worktree, ".env")), false, "an unignored path is never taken");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
