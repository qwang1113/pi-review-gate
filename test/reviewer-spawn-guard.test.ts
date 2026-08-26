/**
 * The reviewer snapshot pin, as BEHAVIOUR.
 *
 * The bug these tests exist for: for an entire session every reviewer was
 * spawned WITHOUT a `cwd`, so they all read the live worktree while their
 * snapshots sat untouched — and an untouched snapshot verifies as "clean", so
 * the gate reported successful isolation for reviews that never happened there.
 * Both halves of the fix are pure decisions, so they are pinned here as truth
 * tables rather than as the shape of the source: a mutant that neutralizes
 * either guard must fail a test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve as pathResolve } from "node:path";
import {
  decideReviewerSpawn,
  decideSnapshotUsage,
  extractVerdictCwds,
  isReviewerAgentName,
  normalizeToolName,
  reviewerAgentInScript,
  REVIEWER_AGENT_NAMES,
} from "../lib/reviewer-spawn-guard.ts";

const REPO = "/repo";
const SNAP_A = { label: "anthropic", dir: "/repo/.pi/review-snapshots/rg-review-snap-a/anthropic" };
const SNAP_B = { label: "openai", dir: "/repo/.pi/review-snapshots/rg-review-snap-b/openai" };
const SNAPS = [SNAP_A, SNAP_B];

function spawn(
  params: Record<string, unknown>,
  opts?: { snapshots?: typeof SNAPS; consumed?: string[]; toolName?: string },
) {
  return decideReviewerSpawn({
    toolName: opts?.toolName ?? "subagent",
    params,
    snapshots: opts?.snapshots ?? SNAPS,
    consumed: opts?.consumed ?? [],
    resolve: (p) => pathResolve(REPO, p),
  });
}

// ---------- normalization ----------

test("tool names are compared bare, so a proxied `subagent` is still guarded", () => {
  assert.equal(normalizeToolName("subagent"), "subagent");
  assert.equal(normalizeToolName("mcp__pi__subagent"), "subagent");
  assert.equal(normalizeToolName("pi/subagent"), "subagent");
  // A different tool must not collapse onto it.
  assert.notEqual(normalizeToolName("subagent_wait"), "subagent");
});

test("agent references normalize to the bare agent name", () => {
  for (const raw of ["reviewer", "Reviewer", "agents/reviewer.md", "./reviewer"]) {
    assert.equal(isReviewerAgentName(raw), true, raw);
  }
  for (const raw of ["adviser", "recon", "worker-readonly", "planner"]) {
    assert.equal(isReviewerAgentName(raw), false, raw);
  }
});

test("all three judge roles are pinned", () => {
  assert.deepEqual([...REVIEWER_AGENT_NAMES], ["reviewer", "reviewer-readonly", "module-reviewer"]);
});

// ---------- when the guard stays out of the way ----------

test("no snapshots: nothing to protect, the call passes", () => {
  const d = spawn({ agent: "reviewer", task: "review" }, { snapshots: [] });
  assert.equal(d.kind, "ignore");
});

test("a non-subagent tool is never touched", () => {
  const d = spawn({ agent: "reviewer" }, { toolName: "bash" });
  assert.equal(d.kind, "ignore");
});

test("read-only roles keep running in the live worktree while a review is open", () => {
  for (const agent of ["adviser", "recon", "worker-readonly"]) {
    assert.equal(spawn({ agent, task: "read the code" }).kind, "ignore", agent);
  }
});

test("management actions dispatch nothing and are not blocked", () => {
  assert.equal(spawn({ action: "list" }).kind, "ignore");
  assert.equal(spawn({ action: "status", id: "abc" }).kind, "ignore");
});

test("REGRESSION: booking every snapshot does NOT open a hole for the next reviewer", () => {
  // The escape hatch a reviewer found: "all snapshots booked ⇒ ignore" meant the
  // INTEGRATION reviewer after a sharded round could run in the live worktree
  // and still be accepted, because record-time evidence existed for every shard
  // snapshot. Being unpinned is blocked whatever the bookings say.
  const d = spawn({ agent: "reviewer", task: "integration" }, { consumed: [SNAP_A.dir, SNAP_B.dir] });
  assert.equal(d.kind, "block");
  if (d.kind !== "block") return;
  assert.match(d.reason, /already has a reviewer/);
  assert.match(d.reason, /call prepare_review again/);
});

test("a retry that carries a booked snapshot's cwd is still allowed", () => {
  // …which is why the hole was never needed: re-running a reviewer in the same
  // snapshot (same tree) goes through the normal path.
  const d = spawn({ agent: "reviewer", cwd: SNAP_A.dir }, { consumed: [SNAP_A.dir, SNAP_B.dir] });
  assert.deepEqual(d, { kind: "allow", snapshotDir: SNAP_A.dir });
});

test("non-reviewer children stay free even when every snapshot is booked", () => {
  assert.equal(spawn({ agent: "recon", task: "read" }, { consumed: [SNAP_A.dir, SNAP_B.dir] }).kind, "ignore");
});

// ---------- the actual bug ----------

test("REGRESSION: a reviewer spawned with NO cwd is blocked", () => {
  const d = spawn({ agent: "reviewer", task: "review the change", async: true });
  assert.equal(d.kind, "block", "this is the exact call that produced a session of false isolation");
  if (d.kind !== "block") return;
  assert.match(d.reason, /no `cwd`/);
  // The block must be actionable: it names the snapshots to use.
  assert.ok(d.reason.includes(SNAP_A.dir));
  assert.ok(d.reason.includes(SNAP_B.dir));
});

test("a reviewer pointed at the real worktree is blocked", () => {
  const d = spawn({ agent: "reviewer", cwd: REPO, task: "review" });
  assert.equal(d.kind, "block");
  if (d.kind !== "block") return;
  assert.match(d.reason, /not one of this round's snapshots/);
});

test("a reviewer pointed at its snapshot is allowed and booked", () => {
  const d = spawn({ agent: "reviewer", cwd: SNAP_B.dir, task: "review" });
  assert.deepEqual(d, { kind: "allow", snapshotDir: SNAP_B.dir });
});

test("a relative cwd is resolved before it is compared", () => {
  const d = spawn({ agent: "reviewer", cwd: ".pi/review-snapshots/rg-review-snap-a/anthropic" });
  assert.deepEqual(d, { kind: "allow", snapshotDir: SNAP_A.dir });
});

test("the other judge roles are pinned too", () => {
  for (const agent of ["reviewer-readonly", "module-reviewer", "agents/reviewer.md"]) {
    assert.equal(spawn({ agent, task: "review" }).kind, "block", agent);
  }
});

test("REGRESSION: the block prints a call that spawns the SAME role", () => {
  // A copyable shape is copied verbatim, so a block that names `module-reviewer`
  // and hands back `agent: "reviewer"` dispatches the wrong judge — in the
  // decompose module loop, an entirely different reviewer. Round 1 fixed this
  // and round 2 found the fix had no test: hard-coding "reviewer" back survived
  // the whole suite.
  for (const agent of ["module-reviewer", "reviewer-readonly"]) {
    const d = spawn({ agent, task: "review" });
    assert.equal(d.kind, "block");
    if (d.kind !== "block") continue;
    assert.match(d.reason, new RegExp(`subagent\\(\\{ agent: "${agent}"`), agent);
    assert.doesNotMatch(d.reason, /agent: "reviewer",/, "must not suggest a different role");
  }
});

test("REGRESSION: a sibling directory whose name merely STARTS with a snapshot is not a snapshot", () => {
  // The spawn side compares for equality; relaxing it to `startsWith` survived
  // the suite until this case existed. `<snap>-other` is a different directory,
  // and treating it as a hit would both let the reviewer out and book the
  // snapshot as used.
  for (const cwd of [SNAP_A.dir + "-other", SNAP_A.dir + "x", dirname(SNAP_A.dir)]) {
    assert.equal(spawn({ agent: "reviewer", cwd }).kind, "block", cwd);
  }
  // …while the snapshot itself, with a trailing slash, still resolves to a hit.
  assert.deepEqual(spawn({ agent: "reviewer", cwd: SNAP_A.dir + "/" }), { kind: "allow", snapshotDir: SNAP_A.dir });
});

test("REGRESSION: a management action that CARRIES a reviewer workflow is still blocked", () => {
  // `schedule.create` takes a workflowScript and eventually runs it, so the
  // "management calls dispatch nothing" short-circuit was a way out.
  const script = 'await runs.run("main", { agent: "reviewer", task: "review" });';
  assert.equal(spawn({ action: "schedule.create", workflowScript: script, every: "1h" }).kind, "block");
  // `validate` only type-checks the script offline — it must stay allowed, or a
  // workflow could not be validated while any review is open.
  assert.equal(spawn({ action: "validate", workflowScript: script }).kind, "ignore");
  // A management call with no script still dispatches nothing.
  assert.equal(spawn({ action: "schedule.create", name: "nightly" }).kind, "ignore");
});

test("a blocked spawn is not booked as used", () => {
  // Booking on a block would let the record-time guard believe the snapshot
  // had been entered — laundering the very failure it exists to catch.
  const d = spawn({ agent: "reviewer", task: "review" });
  assert.equal(d.kind, "block");
  assert.equal("snapshotDir" in d, false);
});

// ---------- the dispatch shape that cannot carry a cwd ----------

test("REGRESSION: a workflowScript that dispatches reviewers is blocked", () => {
  const script = 'const r = await runs.all([{key:"a", agent:"reviewer", task:"review"}]); return r;';
  const d = spawn({ workflowScript: script, async: true });
  assert.equal(d.kind, "block");
  if (d.kind !== "block") return;
  assert.match(d.reason, /NO per-child `cwd`/);
  assert.match(d.reason, /SEPARATE top-level calls/);
});

test("a workflow of read-only children is left alone", () => {
  const script = 'await runs.all([{key:"a", agent:"recon", task:"read"},{key:"b", agent:"adviser", task:"advise"}]);';
  assert.equal(spawn({ workflowScript: script }).kind, "ignore");
});

test("prose about reviewers does not block a workflow that dispatches none", () => {
  // Word boundaries: "reviewers" in a task string is not a dispatch.
  const script = 'await runs.all([{key:"a", agent:"recon", task:"summarize for the reviewers"}]);';
  assert.equal(spawn({ workflowScript: script }).kind, "ignore");
});

test("a script with no agent field falls back to a word-boundary scan", () => {
  assert.equal(reviewerAgentInScript("spawn the reviewer now"), "reviewer");
  assert.equal(reviewerAgentInScript("the reviewers will read this"), undefined);
  assert.equal(reviewerAgentInScript('runs.run("a", { agent: "module-reviewer" })'), "module-reviewer");
});

test("REGRESSION: a workflow FILE is judged by its contents, not its name", () => {
  // Matching only the path let `workflows/wave.js` dispatch reviewers untouched
  // — the caller can read the file, so the guard asks it to.
  const d = decideReviewerSpawn({
    toolName: "subagent",
    params: { workflowScriptPath: "workflows/wave.js" },
    snapshots: SNAPS,
    consumed: [],
    resolve: (p) => pathResolve(REPO, p),
    readScript: () => 'await runs.all([{key:"a", agent:"reviewer", task:"review"}]);',
  });
  assert.equal(d.kind, "block");
});

test("a neutrally-named workflow of read-only children still passes", () => {
  const d = decideReviewerSpawn({
    toolName: "subagent",
    params: { workflowScriptPath: "workflows/wave.js" },
    snapshots: SNAPS,
    consumed: [],
    resolve: (p) => pathResolve(REPO, p),
    readScript: () => 'await runs.all([{key:"a", agent:"worker-readonly", task:"patch"}]);',
  });
  assert.equal(d.kind, "ignore");
});

test("an unreadable workflow file falls back to its name", () => {
  // Last signal available; the record-time evidence guard is the real backstop.
  const d = spawn({ workflowScriptPath: "workflows/reviewer.js" });
  assert.equal(d.kind, "block");
  const neutral = spawn({ workflowScriptPath: "workflows/wave.js" });
  assert.equal(neutral.kind, "ignore");
});

// ---------- self-reported cwd ----------

test("the cwd a reviewer reports is read out of its verdict fence", () => {
  const out = '```json\n{"gate":"READY","cwd":"' + SNAP_A.dir + '","findings":[]}\n```';
  assert.deepEqual(extractVerdictCwds(out), [SNAP_A.dir]);
});

test("every fence contributes its cwd (one record can carry several shards)", () => {
  const out =
    "### shard-1\n```json\n" + JSON.stringify({ gate: "READY", cwd: SNAP_A.dir, findings: [] }) + "\n```\n" +
    "### shard-2\n```json\n" + JSON.stringify({ gate: "READY", cwd: SNAP_B.dir, findings: [] }) + "\n```";
  assert.deepEqual(extractVerdictCwds(out), [SNAP_A.dir, SNAP_B.dir]);
});

test("a fence whose JSON is broken still yields its cwd", () => {
  // Real reviewer output regularly carries unescaped quotes inside `issue`;
  // losing the cwd there would downgrade an honest READY.
  const out = '```json\n{"gate":"READY","cwd":"' + SNAP_A.dir + '","findings":[{"issue":"the "x" case"}]}\n```';
  assert.deepEqual(extractVerdictCwds(out), [SNAP_A.dir]);
});

test("no cwd reported means no evidence", () => {
  assert.deepEqual(extractVerdictCwds('```json\n{"gate":"READY","findings":[]}\n```'), []);
  assert.deepEqual(extractVerdictCwds("no fence at all"), []);
});

// ---------- the record-time truth table ----------

function usage(opts: { verdict?: string; snapshots?: typeof SNAPS; consumed?: string[]; cwds?: string[] }) {
  return decideSnapshotUsage({
    verdict: opts.verdict ?? "READY",
    snapshots: opts.snapshots ?? SNAPS,
    consumed: opts.consumed ?? [],
    verdictCwds: opts.cwds ?? [],
  });
}

test("no snapshots (isolation unavailable): the guard stays silent", () => {
  const r = usage({ snapshots: [] });
  assert.equal(r.verdict, "READY");
  assert.deepEqual(r.unusedLabels, []);
});

test("observed spawns are sufficient evidence", () => {
  const r = usage({ consumed: [SNAP_A.dir, SNAP_B.dir] });
  assert.equal(r.verdict, "READY");
  assert.deepEqual(r.unusedLabels, []);
});

test("self-reported cwds are sufficient evidence on their own", () => {
  const r = usage({ cwds: [SNAP_A.dir, SNAP_B.dir] });
  assert.equal(r.verdict, "READY");
});

test("the two kinds of evidence combine per snapshot", () => {
  const r = usage({ consumed: [SNAP_A.dir], cwds: [SNAP_B.dir] });
  assert.equal(r.verdict, "READY");
  assert.deepEqual(r.unusedLabels, []);
});

test("a cwd INSIDE the snapshot counts (the reviewer stayed in its copy)", () => {
  const r = usage({ consumed: [SNAP_A.dir], cwds: [SNAP_B.dir + "/lib"] });
  assert.equal(r.verdict, "READY");
});

test("a lookalike sibling directory does not count", () => {
  const r = usage({ consumed: [SNAP_A.dir], cwds: [SNAP_B.dir + "-other"] });
  assert.equal(r.verdict, "BLOCKED");
  assert.deepEqual(r.unusedLabels, [SNAP_B.label]);
});

test("REGRESSION: one entered snapshot does not vouch for the others", () => {
  const r = usage({ consumed: [SNAP_A.dir] });
  assert.equal(r.verdict, "BLOCKED", "the openai shard was never reviewed anywhere the gate can see");
  assert.deepEqual(r.unusedLabels, [SNAP_B.label]);
});

test("REGRESSION: no evidence at all withholds the READY", () => {
  const r = usage({});
  assert.equal(r.verdict, "BLOCKED");
  assert.deepEqual(r.unusedLabels, [SNAP_A.label, SNAP_B.label]);
});

test("tighten-only: a BLOCKED verdict is reported, never upgraded", () => {
  const r = usage({ verdict: "BLOCKED" });
  assert.equal(r.verdict, "BLOCKED");
  assert.deepEqual(r.unusedLabels, [SNAP_A.label, SNAP_B.label]);
  assert.equal(usage({ verdict: "NEEDS_HUMAN" }).verdict, "NEEDS_HUMAN");
});
