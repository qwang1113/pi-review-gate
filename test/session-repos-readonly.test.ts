/**
 * N4 (2026-09-27): a repo this session does not own is READ-ONLY.
 *
 * Measured: the acceptance session's bash-result handling (ship evidence for a
 * `git commit` it ran in a /tmp scratch repo) persisted its own state variant
 * into that repo's `.pi/`, and the scratch repo's owner then saw it as a
 * foreign file. Driven here through the real tool-result hook and the real
 * `persistRepo`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";
import { emptyState } from "../lib/gate-state.ts";
import { sessionSidecarPath } from "../lib/loop-goal-host.ts";

import { createSessionCells } from "../lib/session-cells.ts";
import { createSessionRepos, isSessionOwnedRepo } from "../lib/session-repos-host.ts";
import { createToolResultHook } from "../lib/tool-event-hooks.ts";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";

neutraliseHostGitConfig();

function repo(prefix: string): string {
  // Real path: git reports `/private/var/…` for macOS's `/var/…` tmpdir, and the
  // session's repo set is keyed by git's answer.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  git(dir, ["init", "-q", "-b", "feat/x"]);
  return dir;
}

const listPi = (root: string) => (existsSync(join(root, ".pi")) ? readdirSync(join(root, ".pi")) : []);

test("N4: a ship observed in an external repo writes nothing into its .pi/; this session's own repo is written", async () => {
  const primary = repo("rg-n4-primary-");
  const external = repo("rg-n4-external-");
  const own = repo("rg-n4-own-");
  try {
    const cells = createSessionCells(primary);
    cells.state.taskMode = "loop";
    cells.projectConfig.copilotReview.enabled = true;
    cells.sessionRepos.add(own);
    const repos = createSessionRepos(cells, {
      persist: () => {},
      noteGateStatePersistSkip: () => false,
      callerIdentity: () => undefined,
      resolveJudgeLane: (() => { throw new Error("unused"); }) as never,
    });
    const hook = createToolResultHook(cells, {
      childSide: { noteChildProgress: () => {}, observeBackgroundToolResult: () => {} },
      isJudgePane: () => false,
      judgeCurrentRound: () => undefined,
      judgeOwnPaths: () => [],
      goalStageSatisfied: () => true,
      stateForRepo: repos.stateForRepo,
      persistRepo: repos.persistRepo,
      onEditResult: () => undefined,
    });
    const bash = (command: string) =>
      hook({ toolName: "bash", input: { command }, content: [], isError: false } as never, {} as never);

    assert.equal(isSessionOwnedRepo(cells, external), false);
    // Ship evidence, Copilot arming and checkout re-arming: all three observers.
    await bash(`git -C ${external} commit -q --allow-empty -m "chore: x" && git -C ${external} push origin feat/x`);
    await bash(`git -C ${external} checkout -q feat/x`);
    assert.deepEqual(listPi(external), [], "the external repo's .pi/ must stay untouched");

    // Reverse: the same observation in a repo this session edited is recorded.
    await bash(`git -C ${own} commit -q --allow-empty -m "chore: x"`);
    assert.ok(listPi(own).some((f) => f.startsWith("review-gate-state")),
      "this session's own secondary repo is still persisted");
    assert.equal(isSessionOwnedRepo(cells, own), true);
  } finally {
    for (const d of [primary, external, own]) rmSync(d, { recursive: true, force: true });
  }
});

test("N4: a sidecar's existence is not ownership — its sessionId is", () => {
  const primary = repo("rg-n4-p2-");
  const other = repo("rg-n4-other-");
  try {
    const cells = createSessionCells(primary);
    cells.state.sessionId = "s-mine";
    const path = sessionSidecarPath(other);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(emptyState("s-someone-else", DEFAULT_MAX_ROUNDS)));
    assert.equal(isSessionOwnedRepo(cells, other), false, "another session's sidecar under the same name");
    writeFileSync(path, JSON.stringify(emptyState("s-mine", DEFAULT_MAX_ROUNDS)));
    assert.equal(isSessionOwnedRepo(cells, other), true, "a repo whose goal this session negotiated");
  } finally {
    for (const d of [primary, other]) rmSync(d, { recursive: true, force: true });
  }
});
