/**
 * ONE PR PER REPO PER REQUIREMENT (2026-09-15, user decision) — as amended by
 * the LAST TWO LINKS' exemption (2026-09-18 / 2026-09-22).
 *
 * Measured, 2026-09-15: three tasks in one repo, all at station `pr`, shipped
 * three PRs (#1217/#1218/#1219) for one requirement. The rule this pins: a repo
 * holding more than one task stops at `commit` unless the user's own plan names
 * that repo in `allowMultiplePrs`.
 *
 * Measured, 2026-09-18: that rule applied to EVERY task left an orchestration
 * with nobody who could publish — the manager may not ship (constraint 2), the
 * children were all capped, and the round ended with the work committed and no
 * PR. Hence: the plan's LAST task takes `plan.deliveryStation` whatever its
 * repo holds and delivers — while still COUNTING as a task of that repo, so it
 * cannot publish beside a sibling that opened its own PR for the same
 * requirement.
 *
 * 2026-09-22: the tail is TWO tasks by position — the second-to-last is the
 * WRAP-UP (merge → one review → commit) and IS capped by the same-repo rule;
 * the last is the INDEPENDENT ACCEPTANCE task and is the only one the cap never
 * touches. Both are positions, not plan fields.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MULTI_TASK_REPO_STATION,
  acceptanceTaskId,
  allowsMultiplePrs,
  capStationAt,
  effectiveTaskStation,
  narrowedRepoLines,
  narrowedRepoStations,
  narrowingReasonFor,
  normalizeRepoPath,
  taskRepoOf,
  tasksByRepo,
} from "../lib/repo-pr-policy.ts";

const REPO = "/Users/dev/workspace/onchain";
const OTHER = "/Users/dev/workspace/dashboard";

// The tasks are shared objects because the API asks per TASK (2026-09-18) —
// which task is being asked about is half the answer.
const T1 = { id: "t1-ingest", repo: REPO };
const T2 = { id: "t2-blacklist", repo: REPO };
const T3 = { id: "t3-dashboard", repo: OTHER };
// The plan's last two tasks, by position: the wrap-up merges + commits, the
// acceptance task accepts + delivers.
const WRAP = { id: "wrap", repo: REPO };
const ACCEPT = { id: "accept", repo: REPO };

const plan = (over: Partial<Parameters<typeof effectiveTaskStation>[0]> = {}) => ({
  deliveryStation: "pr" as const,
  allowMultiplePrs: [],
  tasks: [T1, T2, T3],
  ...over,
});

test("a repo with more than one task stops at commit; a single-task repo keeps the plan's station", () => {
  const p = plan();
  assert.equal(effectiveTaskStation(p, T1, REPO), MULTI_TASK_REPO_STATION, "two tasks in one repo ⇒ one PR, merged locally");
  assert.equal(effectiveTaskStation(p, T3, REPO), "pr", "a repo with one task is not narrowed at all");
  assert.deepEqual(
    narrowedRepoStations(p, REPO).map((n) => ({ repo: n.repo, ids: n.taskIds })),
    [{ repo: REPO, ids: ["t1-ingest", "t2-blacklist"] }],
  );
});

test("the user's own plan text is the only way out", () => {
  const allowed = plan({ allowMultiplePrs: [REPO] });
  assert.equal(allowsMultiplePrs(allowed, REPO), true);
  assert.equal(effectiveTaskStation(allowed, T1, REPO), "pr", "explicitly allowed ⇒ each task may open its own PR");
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
  assert.equal(effectiveTaskStation(plan({ deliveryStation: "precommit" }), T1, REPO), "precommit",
    "narrowing never WIDENS a plan");
  assert.equal(effectiveTaskStation(plan({ deliveryStation: "precommit" }), ACCEPT, REPO), "precommit",
    "…and the acceptance task's station is the plan's, not a floor of its own");
});

test("a task without a repo belongs to the orchestration's own checkout — the same default the dispatcher applies", () => {
  const p = plan({ tasks: [{ id: "a" }, { id: "b" }] });
  assert.equal(taskRepoOf({}, REPO), REPO);
  assert.deepEqual([...tasksByRepo(p, REPO)], [[REPO, ["a", "b"]]]);
  assert.equal(effectiveTaskStation(p, { id: "a" }, REPO), MULTI_TASK_REPO_STATION,
    "two repo-less tasks are two tasks in ONE repo, which is what they are");
});

test("the ceiling only ever clamps — a request inside it passes through", () => {
  assert.equal(capStationAt("pr", "commit"), "commit");
  assert.equal(capStationAt("precommit", "commit"), "precommit", "asking for LESS is always allowed");
  assert.equal(capStationAt("pr", "pr"), "pr");
  assert.equal(capStationAt("pr", undefined), "pr", "no ceiling (a standalone loop session) changes nothing");
});

test("a one-task plan's acceptance task is that task — position, not a search", () => {
  const p = plan({ tasks: [T1] });
  assert.equal(acceptanceTaskId(p), "t1-ingest");
  assert.equal(acceptanceTaskId({ ...p, tasks: [] }), undefined, "no tasks ⇒ nothing to accept");
  assert.equal(effectiveTaskStation(p, T1, REPO), "pr", "a single task is never narrowed");
});

// ---------------------------------------------------------------------------
// THE LAST TWO LINKS — the plan's second-to-last task wraps up, the last one
// accepts and delivers (2026-09-22, user decision)

test("the plan's LAST task is the acceptance task, and it is NEVER narrowed", () => {
  const p = plan({ tasks: [T1, T2, WRAP, ACCEPT] });
  assert.equal(acceptanceTaskId(p), "accept", "the acceptance task is a POSITION in the plan, not a new field");
  assert.equal(effectiveTaskStation(p, ACCEPT, REPO), "pr",
    "the acceptance task keeps the plan's station — capping it leaves nobody who may publish");
  assert.equal(narrowingReasonFor(p, ACCEPT, REPO), undefined,
    "and there is no narrowing to explain to it");
  // The SECOND-to-last task is the wrap-up, and it is capped like any other:
  // merging is work, and work stops at commit when its repo publishes one PR.
  assert.equal(effectiveTaskStation(p, WRAP, REPO), MULTI_TASK_REPO_STATION,
    "the wrap-up is capped — the exemption belongs to the acceptance task alone");
  assert.equal(effectiveTaskStation(p, T1, REPO), MULTI_TASK_REPO_STATION, "the work tasks still stop at commit");
  assert.equal(effectiveTaskStation(p, T2, REPO), MULTI_TASK_REPO_STATION);
  assert.match(narrowingReasonFor(p, T1, REPO)!, /收尾任务/,
    "the capped task's reason says who delivers instead of it");
  assert.match(narrowingReasonFor(p, T1, REPO)!, /独立验收任务/);
  assert.match(narrowingReasonFor(p, WRAP, REPO)!, /独立验收任务/,
    "and so does the wrap-up's — it is capped too");
});

test("the acceptance task still COUNTS as a task of its repo (2026-09-18, user decision)", () => {
  // One work task + the acceptance task in one repo is still two tasks in one
  // repo: the acceptance task delivers, so the work task must not open a PR.
  const p = plan({ tasks: [T1, ACCEPT] });
  assert.equal(effectiveTaskStation(p, T1, REPO), MULTI_TASK_REPO_STATION,
    "the count is every task in the repo, the acceptance task included");
  assert.equal(effectiveTaskStation(p, ACCEPT, REPO), "pr");
  const [narrowing] = narrowedRepoStations(p, REPO);
  assert.deepEqual(narrowing!.taskIds, ["t1-ingest", "accept"], "the repo holds both…");
  assert.deepEqual(Object.keys(narrowing!).sort(), ["repo", "station", "taskIds"],
    "…and the narrowing carries only facts somebody reads (the dead per-task field went, 2026-09-18)");
});

test("an acceptance task alone in its repo is not a narrowing at all", () => {
  const p = plan({ tasks: [T1, T2, { id: "accept", repo: OTHER }] });
  assert.equal(effectiveTaskStation(p, { id: "accept", repo: OTHER }, REPO), "pr");
  assert.deepEqual(narrowedRepoStations(p, REPO).map((n) => n.repo), [REPO],
    "one task in the dashboard repo is still one task");
});

test("the line the user reads names the repo, the tasks and the way out", () => {
  const [line] = narrowedRepoLines(plan(), REPO);
  assert.match(line!, /同一 repo 一个需求只出一个 PR/);
  assert.match(line!, new RegExp(REPO.replace(/\//g, "\\/")));
  assert.match(line!, /t1-ingest/);
  assert.match(line!, /allowMultiplePrs/, "a rule the user cannot lift is a rule they cannot agree to");
});

test("the line says WHICH task is exempt, in the repo that holds it", () => {
  const [withAccept] = narrowedRepoLines(plan({ tasks: [T1, T2, WRAP, ACCEPT] }), REPO);
  assert.match(withAccept!, /accept/, "the user must be able to read who publishes");
  assert.match(withAccept!, /独立验收任务/, "…and under which name: the LAST task accepts");
  assert.match(withAccept!, /收尾任务汇合/, "the merge is the wrap-up's job, not the acceptor's");
  assert.match(withAccept!, /不受这条收窄/);
  // The exemption belongs to the acceptance task's OWN repo line, not to every line.
  const both = narrowedRepoLines(plan({ tasks: [T1, T2, T3, { id: "other-a", repo: OTHER }, ACCEPT] }), REPO);
  assert.equal(both.length, 2);
  const otherLine = both.find((l) => l.includes(OTHER))!;
  assert.doesNotMatch(otherLine, /不受这条收窄/);
});
