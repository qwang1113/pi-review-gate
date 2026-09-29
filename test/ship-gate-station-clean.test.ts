/**
 * N5 (2026-09-27, security): the delivery station is judged BEFORE the
 * "nothing changed" short-circuit.
 *
 * Measured: a loop session at station `precommit` got its READY, the
 * checkpoint left the worktree clean, and then `git commit --allow-empty`,
 * `git push` and `gh pr create` all ran — the `if (!anyChange) return` sat
 * above the station check. Here the ship gate runs against a REAL clean
 * repository on a feature branch, with a state whose round is settled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateShipCommand } from "../lib/ship-gate-bash.ts";
import type { ShipGateBashDeps } from "../lib/ship-gate-bash-deps.ts";
import { stationShipProblems, strictestStation, type DeliveryStation } from "../lib/delivery-station.ts";
import { defaultProjectConfig } from "../lib/project-config.ts";
import { emptyState } from "../lib/gate-state.ts";
import { DEFAULT_MAX_ROUNDS } from "../lib/constants.ts";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";

neutraliseHostGitConfig();

function cleanRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-n5-"));
  git(dir, ["init", "-q", "-b", "feat/demo"]);
  git(dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "chore: init"]);
  return dir;
}

function deps(root: string, station: DeliveryStation | undefined): ShipGateBashDeps {
  const base = defaultProjectConfig();
  // A settled round: READY recorded, nothing left in the worktree.
  const st = {
    ...emptyState("s1", DEFAULT_MAX_ROUNDS),
    review: { verdict: "READY" as const, fingerprint: "t", at: "2026-09-27T00:00:00.000Z", docSync: "NOT_NEEDED" as const },
  };
  return {
    cwd: () => root,
    primaryRepoRoot: () => root,
    taskMode: () => "loop",
    bypassActive: () => false,
    projectConfig: () => ({ ...base, llmGuards: { ...base.llmGuards, aiAttribution: false, englishCheck: false, shipDetect: false } }),
    sessionRepos: () => [root],
    knownRepoRoots: () => [root],
    enforcementStateFor: () => st,
    stateForRepo: () => st,
    repoLabel: () => "session repo",
    currentBranch: () => "feat/demo",
    worktreeTree: () => "t",
    headCommitTree: () => "t",
    hasStagedChanges: () => false,
    unreviewedTreesSince: () => [],
    loopGoalConfirmed: () => true,
    precommitLaneRunning: () => false,
    waitForQuietLane: async () => {},
    runFullLane: async () => {},
    deliveryStation: () => station,
    crossRepoVerdictHint: () => "",
    classifier: () => { throw new Error("no classifier"); },
    notice: () => undefined,
    refuseText: (_k, _t, message) => message,
    appendLesson: () => {},
    hint: () => {},
    tmuxAccess: () => undefined,
    consumeTmuxAccess: () => {},
    bypassToken: () => null,
    setBypassToken: () => {},
    clearBypassToken: () => {},
    computeTokenBindings: async () => { throw new Error("unused"); },
    setLastBlockedShip: () => {},
  };
}

const COMMIT = "git commit --allow-empty -m 'chore: sneak'";
const PUSH = "git push origin feat/demo";
const PR = "gh pr create --title 'feat: x' --body 'why'";

test("N5: a clean worktree does not skip the station — every ship beyond it is refused", async () => {
  const root = cleanRepo();
  try {
    for (const [station, command] of [
      ["precommit", COMMIT], ["precommit", PUSH], ["precommit", PR],
      ["commit", PUSH], ["commit", PR],
    ] as const) {
      const out = await evaluateShipCommand(deps(root, station), { command }, {});
      assert.equal(out?.block, true, `${station} must refuse: ${command}`);
      assert.match(out!.reason, /超出本轮的交付站点/, "the refusal is the station's own");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("N5 reverse: what the station allows still passes on a clean worktree", async () => {
  const root = cleanRepo();
  try {
    assert.equal(await evaluateShipCommand(deps(root, "commit"), { command: COMMIT }, {}), undefined);
    assert.equal(await evaluateShipCommand(deps(root, "pr"), { command: PUSH }, {}), undefined);
    assert.equal(await evaluateShipCommand(deps(root, "pr"), { command: PR }, {}), undefined);
    // No contract at all (explore / a repo never negotiated): nothing to hold.
    assert.equal(await evaluateShipCommand(deps(root, undefined), { command: PUSH }, {}), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("strictestStation: the strictest contract wins, a repo without one adds nothing", () => {
  assert.equal(strictestStation([]), undefined);
  assert.equal(strictestStation([undefined, undefined]), undefined);
  assert.equal(strictestStation(["pr", undefined, "commit"]), "commit");
  assert.equal(strictestStation(["pr", "precommit", "commit"]), "precommit");
});

test("stationShipProblems: one line per distinct kind beyond the station, none without a station", () => {
  assert.deepEqual(stationShipProblems(undefined, ["push"]), []);
  assert.deepEqual(stationShipProblems("pr", ["commit", "push", "pr-create"]), []);
  assert.deepEqual(stationShipProblems("commit", ["commit"]), []);
  const lines = stationShipProblems("commit", ["push", "push", "pr-create", "commit"]);
  assert.equal(lines.length, 2, "push once, pr-create once, commit allowed");
  assert.match(lines[0], /git push/);
  assert.equal(stationShipProblems("precommit", ["commit"]).length, 1);
});
