/**
 * ONE PR PER REPO PER REQUIREMENT (2026-09-15, user decision).
 *
 * Measured: three tasks in one repo, all at station `pr`, shipped three PRs
 * (#1217/#1218/#1219) for one requirement. The rule this pins: a repo holding
 * more than one task stops at `commit` unless the user's own plan names that
 * repo in `allowMultiplePrs`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MULTI_TASK_REPO_STATION,
  allowsMultiplePrs,
  capStationAt,
  effectiveRepoStation,
  narrowedRepoLines,
  narrowedRepoStations,
  normalizeRepoPath,
  taskRepoOf,
  tasksByRepo,
} from "../lib/repo-pr-policy.ts";

const REPO = "/Users/dev/workspace/onchain";
const OTHER = "/Users/dev/workspace/dashboard";
const plan = (over: Partial<Parameters<typeof effectiveRepoStation>[0]> = {}) => ({
  deliveryStation: "pr" as const,
  allowMultiplePrs: [],
  tasks: [
    { id: "t1-ingest", repo: REPO },
    { id: "t2-blacklist", repo: REPO },
    { id: "t3-dashboard", repo: OTHER },
  ],
  ...over,
});

test("a repo with more than one task stops at commit; a single-task repo keeps the plan's station", () => {
  const p = plan();
  assert.equal(effectiveRepoStation(p, REPO, REPO), MULTI_TASK_REPO_STATION, "two tasks in one repo ⇒ one PR, merged locally");
  assert.equal(effectiveRepoStation(p, OTHER, REPO), "pr", "a repo with one task is not narrowed at all");
  assert.deepEqual(narrowedRepoStations(p, REPO).map((n) => ({ repo: n.repo, ids: n.taskIds })), [
    { repo: REPO, ids: ["t1-ingest", "t2-blacklist"] },
  ]);
});

test("the user's own plan text is the only way out", () => {
  const allowed = plan({ allowMultiplePrs: [REPO] });
  assert.equal(allowsMultiplePrs(allowed, REPO), true);
  assert.equal(effectiveRepoStation(allowed, REPO, REPO), "pr", "explicitly allowed ⇒ each task may open its own PR");
  assert.deepEqual(narrowedRepoStations(allowed, REPO), []);

  // A trailing slash is the same repository, not a second one — otherwise the
  // permission would silently not apply and the manager would be refused.
  const slashed = plan({ allowMultiplePrs: [`${REPO}/`] });
  assert.equal(allowsMultiplePrs(slashed, REPO), true);
  assert.equal(normalizeRepoPath(`${REPO}//`), REPO);
});

test("a plan that already stops at or below commit is never described as 'narrowed'", () => {
  for (const station of ["precommit", "commit"] as const) {
    const p = plan({ deliveryStation: station });
    assert.deepEqual(narrowedRepoStations(p, REPO), [], `${station} is not a lie to call narrowed`);
    assert.deepEqual(narrowedRepoLines(p, REPO), []);
  }
  assert.equal(effectiveRepoStation(plan({ deliveryStation: "precommit" }), REPO, REPO), "precommit",
    "narrowing never WIDENS a plan");
});

test("a task without a repo belongs to the orchestration's own checkout — the same default the dispatcher applies", () => {
  const p = plan({ tasks: [{ id: "a" }, { id: "b" }] });
  assert.equal(taskRepoOf({}, REPO), REPO);
  assert.deepEqual([...tasksByRepo(p, REPO)], [[REPO, ["a", "b"]]]);
  assert.equal(effectiveRepoStation(p, REPO, REPO), MULTI_TASK_REPO_STATION,
    "two repo-less tasks are two tasks in ONE repo, which is what they are");
});

test("the ceiling only ever clamps — a request inside it passes through", () => {
  assert.equal(capStationAt("pr", "commit"), "commit");
  assert.equal(capStationAt("precommit", "commit"), "precommit", "asking for LESS is always allowed");
  assert.equal(capStationAt("pr", "pr"), "pr");
  assert.equal(capStationAt("pr", undefined), "pr", "no ceiling (a standalone loop session) changes nothing");
});

test("the line the user reads names the repo, the tasks and the way out", () => {
  const [line] = narrowedRepoLines(plan(), REPO);
  assert.match(line!, /同一 repo 一个需求只出一个 PR/);
  assert.match(line!, new RegExp(REPO.replace(/\//g, "\\/")));
  assert.match(line!, /t1-ingest/);
  assert.match(line!, /allowMultiplePrs/, "a rule the user cannot lift is a rule they cannot agree to");
});
