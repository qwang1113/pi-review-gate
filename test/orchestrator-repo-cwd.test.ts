/**
 * The DEFAULT `resolveTaskRepo` (lib/orchestrator-wiring.ts) against REAL
 * git repositories.
 *
 * Why real git: the whole point of the 2026-09-15 change is that a task's
 * declared repo may be a checkout this session has NEVER edited — so the
 * resolution must come from the PATH itself, not from session memory. The
 * production path is `git rev-parse --show-toplevel`; faking it would test
 * the fake. These tests build throwaway repos and resolve against them:
 *
 *   - an absolute path to a repo root resolves to itself;
 *   - a SUBDIRECTORY of a repo resolves to the repo ROOT (the child's cwd
 *     must be the root, so its gate's primaryRepoRoot binds there);
 *   - a path that is not inside any repo is a fail-closed refusal;
 *   - a relative path resolves against the current process cwd.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { neutraliseHostGitConfig } from "./helpers/git.ts";

neutraliseHostGitConfig();

import { createOrchestratorDeps } from "../lib/orchestrator-wiring.ts";
import type { OrchestratorHostBindings } from "../lib/orchestrator-wiring.ts";

const tempDirs: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-repo-cwd-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], {
    cwd: dir, stdio: "ignore",
  });
  return dir;
}
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

function depsWith(repoRoot: string) {
  const host: OrchestratorHostBindings = {
    repoRoot,
    taskMode: () => "orchestrator" as const,
    loadRuntime: () => undefined,
    storeRuntime: () => {},
    orchestrationId: () => "orch-test-1",
    confirm: async () => true,
    showToUser: () => {},
    sessionTranscriptPath: () => undefined,
    knownRepoRoots: () => [repoRoot],
  };
  return createOrchestratorDeps(host);
}

test("resolveTaskRepo resolves an absolute repo root to itself", () => {
  const root = makeRepo();
  const deps = depsWith(root);
  const resolved = deps.resolveTaskRepo(root);
  assert.ok(resolved.ok, JSON.stringify(resolved));
  if (resolved.ok) {
    // macOS /tmp is a symlink to /private/tmp; git reports the REAL path,
    // mkdtempSync may report the symlinked one. Compare canonical forms.
    assert.equal(realpathSync(resolved.root), realpathSync(root));
  }
});

test("resolveTaskRepo resolves a SUBDIRECTORY of a repo to the repo root", () => {
  const root = makeRepo();
  const sub = join(root, "src");
  mkdirSync(sub); // git --show-toplevel needs the directory to EXIST
  const deps = depsWith(root);
  const resolved = deps.resolveTaskRepo(sub);
  assert.ok(resolved.ok, JSON.stringify(resolved));
  if (resolved.ok) assert.equal(realpathSync(resolved.root), realpathSync(root), "the child's cwd must be the repo ROOT");
});

test("resolveTaskRepo REFUSES a path that is not inside a git repository", () => {
  const outside = mkdtempSync(join(tmpdir(), "rg-repo-cwd-none-"));
  tempDirs.push(outside);
  const deps = depsWith(outside);
  const resolved = deps.resolveTaskRepo(join(outside, "nowhere"));
  assert.equal(resolved.ok, false, "fail-closed: never resolve to a non-repo");
  if (!resolved.ok) assert.match(resolved.reason, /不是 git 仓库根/);
});

test("resolveTaskRepo REFUSES a path that does not exist", () => {
  const deps = depsWith(makeRepo());
  const resolved = deps.resolveTaskRepo("/definitely/not/a/repo-anywhere");
  assert.equal(resolved.ok, false, "fail-closed: a missing directory is not a repo");
});
test("resolveTaskRepo REFUSES a RELATIVE path that is not inside a repo", () => {
  // The process cwd is this repo's own directory (a git repo), so a
  // relative path into a NON-repo sibling of the process cwd must refuse.
  const deps = depsWith(makeRepo());
  const resolved = deps.resolveTaskRepo("./definitely-not-a-repo-xyz");
  assert.equal(resolved.ok, false, "a relative path to a missing dir must refuse");
});
