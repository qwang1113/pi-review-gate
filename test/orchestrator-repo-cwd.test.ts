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
    // These tests drive repo resolution and identity, not the plan gate, so
    // the restatement binding only has to exist.
    restatement: () => undefined,
    loadRuntime: () => undefined,
    storeRuntime: () => {},
    log: () => {},
    adoptOrchestrationId: () => {},
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

test("resolveTaskRepo REFUSES a RELATIVE repo — it would resolve to the orchestrator's own repo", () => {
  const deps = depsWith(makeRepo());
  const resolved = deps.resolveTaskRepo("lib");
  assert.equal(resolved.ok, false, "fail-closed: a relative repo must never resolve against the PM cwd");
  if (!resolved.ok) assert.match(resolved.reason, /绝对路径/);
});
test("resolveTaskRepo REFUSES a RELATIVE path that is not inside a repo", () => {
  // The process cwd is this repo's own directory (a git repo), so a
  // relative path into a NON-repo sibling of the process cwd must refuse.
  const deps = depsWith(makeRepo());
  const resolved = deps.resolveTaskRepo("./definitely-not-a-repo-xyz");
  assert.equal(resolved.ok, false, "a relative path to a missing dir must refuse");
});

// ---------------------------------------------------------------------------
// runtimeConflict (2026-09-17): a fresh session must not adopt another
// orchestration's stale runtime; a relay successor legitimately may.
// ---------------------------------------------------------------------------

test("runtimeConflict: fresh session + foreign sidecar runtime => the foreign id", () => {
  const root = makeRepo();
  const host: OrchestratorHostBindings = {
    repoRoot: root,
    taskMode: () => "orchestrator" as const,
    restatement: () => undefined,
    // The sidecar holds ANOTHER orchestration's runtime.
    loadRuntime: () => ({
      orchestrationId: "orch-deadbeef-OLD",
      children: [],
      notify: { sentAt: [], lastByKey: {} },
    }),
    storeRuntime: () => {},
    log: () => {},
    adoptOrchestrationId: () => {},
    // No RG_ORCHESTRATION_ID in env: the session mints its own.
    orchestrationId: () => "orch-12345678-NEW",
    env: () => ({}) as NodeJS.ProcessEnv,
    confirm: async () => true,
    showToUser: () => {},
    sessionTranscriptPath: () => undefined,
    knownRepoRoots: () => [root],
  };
  const deps = createOrchestratorDeps(host);
  assert.equal(deps.runtimeConflict?.(), "orch-deadbeef-OLD",
    "a fresh session sees the foreign runtime's id as a conflict");
});

test("runtime(): a FOREIGN runtime is never re-stamped with this session's id (B1)", () => {
  // THE LINE THIS PINS used to read `{ ...stored, orchestrationId: id }`, and
  // it quietly undid the conflict check above: a fresh session adopted the
  // previous orchestration's child registry and plan approval under its own
  // new address, so the two ids `runtimeConflict` compares could never
  // differ. An empty runtime is the honest answer — the foreign record stays
  // on disk for `orchestrator_attach` to adopt deliberately.
  const root = makeRepo();
  const foreign = {
    orchestrationId: "orch-deadbeef-OLD",
    children: [{
      id: "t1-x", taskId: "t1", paneId: "%3", cwd: root, createdAt: "2026-09-05T00:00:00.000Z",
    }],
    notify: { sentAt: [], lastByKey: {} },
    approvedPlanHash: "a".repeat(64),
  };
  const host: OrchestratorHostBindings = {
    repoRoot: root,
    taskMode: () => "orchestrator" as const,
    restatement: () => undefined,
    loadRuntime: () => foreign,
    storeRuntime: () => {},
    log: () => {},
    adoptOrchestrationId: () => {},
    orchestrationId: () => "orch-12345678-NEW",
    env: () => ({}) as NodeJS.ProcessEnv,
    confirm: async () => true,
    showToUser: () => {},
    sessionTranscriptPath: () => undefined,
    knownRepoRoots: () => [root],
  };
  const deps = createOrchestratorDeps(host);

  const runtime = deps.runtime();
  assert.equal(runtime.orchestrationId, "orch-12345678-NEW", "we hold our own id");
  assert.deepEqual(runtime.children, [], "and NOT somebody else's children");
  assert.equal(runtime.approvedPlanHash, undefined, "nor their approval");
  assert.equal(deps.runtimeConflict?.(), "orch-deadbeef-OLD", "the conflict is still visible");
  assert.equal(deps.recordedRuntime()?.children.length, 1,
    "the foreign registry is not lost — a takeover is what adopts it");
});

test("runtime(): a session whose id MATCHES the record keeps the record (relay + post-attach)", () => {
  // The same code path serves both: a relay successor inherits the id via
  // env, and an `orchestrator_attach` adopts it — after either, the stored
  // registry IS this session's registry. Before B1 the relay successor lost
  // it entirely, because a fresh session id reset the sidecar.
  const root = makeRepo();
  const stored = {
    orchestrationId: "orch-deadbeef-OLD",
    children: [{
      id: "t1-x", taskId: "t1", paneId: "%3", cwd: root, createdAt: "2026-09-05T00:00:00.000Z",
    }],
    notify: { sentAt: [], lastByKey: {} },
  };
  const host: OrchestratorHostBindings = {
    repoRoot: root,
    taskMode: () => "orchestrator" as const,
    restatement: () => undefined,
    loadRuntime: () => stored,
    storeRuntime: () => {},
    log: () => {},
    adoptOrchestrationId: () => {},
    orchestrationId: () => "orch-deadbeef-OLD",
    env: () => ({ RG_ORCHESTRATION_ID: "orch-deadbeef-OLD" }) as NodeJS.ProcessEnv,
    confirm: async () => true,
    showToUser: () => {},
    sessionTranscriptPath: () => undefined,
    knownRepoRoots: () => [root],
  };
  const deps = createOrchestratorDeps(host);

  assert.equal(deps.runtime().children.length, 1,
    "the predecessor's children are reachable by whoever holds the id");
});

test("runtimeConflict: a relay successor (env id present) is NOT a conflict", () => {
  const root = makeRepo();
  const host: OrchestratorHostBindings = {
    repoRoot: root,
    taskMode: () => "orchestrator" as const,
    restatement: () => undefined,
    loadRuntime: () => ({
      orchestrationId: "orch-deadbeef-OLD",
      children: [],
      notify: { sentAt: [], lastByKey: {} },
    }),
    storeRuntime: () => {},
    log: () => {},
    adoptOrchestrationId: () => {},
    orchestrationId: () => "orch-deadbeef-OLD",
    env: () => ({ RG_ORCHESTRATION_ID: "orch-deadbeef-OLD" }) as NodeJS.ProcessEnv,
    confirm: async () => true,
    showToUser: () => {},
    sessionTranscriptPath: () => undefined,
    knownRepoRoots: () => [root],
  };
  const deps = createOrchestratorDeps(host);
  assert.equal(deps.runtimeConflict?.(), undefined,
    "inheriting the id via env makes the takeover legitimate");
});

test("runtimeConflict: no sidecar runtime is never a conflict", () => {
  const root = makeRepo();
  const host: OrchestratorHostBindings = {
    repoRoot: root,
    taskMode: () => "orchestrator" as const,
    restatement: () => undefined,
    loadRuntime: () => undefined,
    storeRuntime: () => {},
    log: () => {},
    adoptOrchestrationId: () => {},
    orchestrationId: () => "orch-12345678-NEW",
    env: () => ({}) as NodeJS.ProcessEnv,
    confirm: async () => true,
    showToUser: () => {},
    sessionTranscriptPath: () => undefined,
    knownRepoRoots: () => [root],
  };
  const deps = createOrchestratorDeps(host);
  assert.equal(deps.runtimeConflict?.(), undefined, "no stored runtime means nothing to conflict with");
});
