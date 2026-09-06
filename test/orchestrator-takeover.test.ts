/**
 * TAKEOVER AND ARCHIVE — the two ways out of "somebody else's plan is here".
 *
 * The situation these cover was, for three measured sessions, unresolvable
 * with tools: entering the project-manager role was refused because a plan
 * existed, and the tools that could have dealt with the plan lived inside the
 * role. Every one of those sessions reached for `rm` on the gate's own state
 * file. So the interesting assertions here are not "does the happy path
 * work" but "is there always a way out, and does a refusal ever leave a
 * session with nothing it can execute".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_LISTED_CANDIDATES,
  belongsToRepo,
  buildArchiveConfirmMessage,
  buildPlanArchive,
  buildTakeoverRoute,
  decideTakeover,
  discoverOrchestrations,
  orchestrationStamp,
  planArchiveRelPath,
} from "../lib/orchestrator-takeover.ts";
import { newOrchestrationId, orchestrationRepoHash } from "../lib/orchestration-id.ts";
import { parsePlan, type OrchestratorPlan } from "../lib/orchestrator-plan.ts";
import type { ChildSession } from "../lib/orchestrator-registry.ts";

const REPO = "/Users/someone/workspace/thing";
const OTHER_REPO = "/Users/someone/workspace/other";

/** An id of REPO minted at `at` — the same way the gate mints one. */
function idOf(repo: string, at: number): string {
  return newOrchestrationId(repo, at);
}

function child(over: Partial<ChildSession> = {}): ChildSession {
  return {
    id: "t1-abc",
    taskId: "t1",
    paneId: "%3",
    cwd: REPO,
    createdAt: "2026-09-06T00:00:00.000Z",
    ...over,
  };
}

function planOf(): OrchestratorPlan {
  const parsed = parsePlan({
    title: "上一轮的计划",
    intent: "把编排层的缺陷清掉",
    tasks: [
      { id: "t1", title: "任务一", repo: REPO, fileBoundaries: ["lib/"] },
      { id: "t2", title: "任务二", repo: REPO, fileBoundaries: ["docs/"] },
    ],
  });
  assert.ok(parsed.plan, `fixture must parse: ${parsed.problems.join("; ")}`);
  return parsed.plan!;
}

// ---------------------------------------------------------------------------
// Discovery — the ids are read off disk, never stored a second time
// ---------------------------------------------------------------------------

test("an id says which repo it belongs to, and that is what filters discovery", () => {
  const mine = idOf(REPO, 1_700_000_000_000);
  const theirs = idOf(OTHER_REPO, 1_700_000_000_000);
  assert.notEqual(mine, theirs, "the repo hash is part of the id");
  assert.ok(belongsToRepo(mine, REPO));
  assert.ok(!belongsToRepo(theirs, REPO));
  assert.ok(!belongsToRepo("not-an-id", REPO), "garbage belongs to nobody");
});

test("discovery merges the sidecar record with the channel directories, newest first", () => {
  const older = idOf(REPO, 1_700_000_000_000);
  const newer = idOf(REPO, 1_800_000_000_000);
  const foreign = idOf(OTHER_REPO, 1_900_000_000_000);

  const found = discoverOrchestrations({
    repoRoot: REPO,
    recorded: older,
    channelDirNames: () => [foreign, newer, "not-an-id", ".DS_Store"],
  });

  assert.deepEqual(found.ids, [newer, older],
    "only this repo's ids, newest first — the mint stamp is in the id itself");
  assert.equal(found.recorded, older);
  assert.ok(orchestrationStamp(newer) > orchestrationStamp(older));
});

test("discovery survives an unreadable channel root — it only ever enriches a message", () => {
  const recorded = idOf(REPO, 1_700_000_000_000);
  const found = discoverOrchestrations({
    repoRoot: REPO,
    recorded,
    channelDirNames: () => { throw new Error("EACCES"); },
  });
  assert.deepEqual(found.ids, [recorded], "the sidecar record alone is still a candidate");
});

// ---------------------------------------------------------------------------
// Adoption — four conditions, each from a different accident
// ---------------------------------------------------------------------------

test("a discoverable id of this repo is adopted", () => {
  const wanted = idOf(REPO, 1_700_000_000_000);
  const decision = decideTakeover({
    wanted,
    repoRoot: REPO,
    candidates: discoverOrchestrations({ repoRoot: REPO, recorded: wanted, channelDirNames: () => [] }),
    ownChildren: [],
    currentId: idOf(REPO, 1_800_000_000_000),
  });
  assert.equal(decision.ok, true);
  if (decision.ok) {
    assert.equal(decision.id, wanted);
    assert.equal(decision.source, "recorded");
  }
});

test("an id found ONLY in the channel directories is still adoptable, and says so", () => {
  // This is the common case after the sidecar was reset by another session:
  // the registry is gone but the channel — the orchestration's actual address
  // — is still on disk, and adopting the id is what reaches its children.
  const wanted = idOf(REPO, 1_700_000_000_000);
  const decision = decideTakeover({
    wanted,
    repoRoot: REPO,
    candidates: discoverOrchestrations({ repoRoot: REPO, channelDirNames: () => [wanted] }),
    ownChildren: [],
    currentId: idOf(REPO, 1_800_000_000_000),
  });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.source, "channel");
});

test("an id nobody recorded is REFUSED — naming one is not evidence it exists", () => {
  const decision = decideTakeover({
    wanted: idOf(REPO, 1_700_000_000_000),
    repoRoot: REPO,
    candidates: discoverOrchestrations({ repoRoot: REPO, channelDirNames: () => [] }),
    ownChildren: [],
    currentId: idOf(REPO, 1_800_000_000_000),
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.match(decision.reason, /盘上没有/);
});

test("another repo's orchestration is REFUSED", () => {
  const decision = decideTakeover({
    wanted: idOf(OTHER_REPO, 1_700_000_000_000),
    repoRoot: REPO,
    // Even if it were somehow discoverable, the repo hash decides first.
    candidates: { ids: [idOf(OTHER_REPO, 1_700_000_000_000)] },
    ownChildren: [],
    currentId: idOf(REPO, 1_800_000_000_000),
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.match(decision.reason, /不是本仓库/);
});

test("a session that already registered children may NOT change identity", () => {
  // The half of the old refusal that was right: those children are addressed
  // to the id this session holds, and they would lose their supervisor.
  const wanted = idOf(REPO, 1_700_000_000_000);
  const decision = decideTakeover({
    wanted,
    repoRoot: REPO,
    candidates: { recorded: wanted, ids: [wanted] },
    ownChildren: [child()],
    currentId: idOf(REPO, 1_800_000_000_000),
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.match(decision.reason, /不能在运行中改换编排身份/);
});

test("a CLOSED child does not block a takeover — only live registrations do", () => {
  const wanted = idOf(REPO, 1_700_000_000_000);
  const decision = decideTakeover({
    wanted,
    repoRoot: REPO,
    candidates: { recorded: wanted, ids: [wanted] },
    ownChildren: [child({ closedAt: "2026-09-06T01:00:00.000Z" })],
    currentId: idOf(REPO, 1_800_000_000_000),
  });
  assert.equal(decision.ok, true);
});

test("a malformed id is refused before anything else looks at it", () => {
  for (const wanted of ["", "not-an-id", 42, null, "orch-", `orch-${orchestrationRepoHash(REPO)}`]) {
    const decision = decideTakeover({
      wanted,
      repoRoot: REPO,
      candidates: { ids: [] },
      ownChildren: [],
      currentId: idOf(REPO, 1_800_000_000_000),
    });
    assert.equal(decision.ok, false, `${JSON.stringify(wanted)} must not be adoptable`);
  }
});

// ---------------------------------------------------------------------------
// The route — a refusal must never leave a session with nothing to run
// ---------------------------------------------------------------------------

test("the route names both ways out, with copyable commands", () => {
  const newer = idOf(REPO, 1_800_000_000_000);
  const older = idOf(REPO, 1_700_000_000_000);
  const route = buildTakeoverRoute({
    candidates: { recorded: older, ids: [newer, older] },
    attempting: "派活（spawn）",
  });
  assert.match(route, /派活（spawn）/, "it says what was refused");
  assert.match(route, new RegExp(`orchestrator_attach\\(\\{ orchestrationId: "${newer}" \\}\\)`));
  assert.match(route, new RegExp(`orchestrator_attach\\(\\{ orchestrationId: "${older}" \\}\\)`));
  assert.match(route, /orchestrator_plan\(\{ action: "archive" \}\)/);
  assert.match(route, /不要手动删 plan 文件/, "the move that actually happened three times is named");
});

test("the route asserts NO fact about the session or the repo (reviewer P2)", () => {
  // It is appended to EVERY identity refusal — including ones raised by a
  // session that DID inherit an orchestration id, and in repos with no plan
  // file at all. An earlier version opened by stating both of those as
  // facts, which made the gate's own message wrong at several of its call
  // sites. The specific reason is printed by the caller, right above this.
  const route = buildTakeoverRoute({
    candidates: { ids: [idOf(REPO, 1_700_000_000_000)] },
    attempting: "接管一个编排",
  });
  assert.doesNotMatch(route, /RG_ORCHESTRATION_ID/,
    "it must not claim anything about this session's environment");
  assert.doesNotMatch(route, /已经有一份别人写好的 plan/,
    "nor about what is in the repo — it may be a mistyped id and nothing else");
  assert.match(route, /orchestrator_attach/, "what it DOES say is what can be done");
  assert.match(route, /action: "archive"/);
});


test("with nothing discoverable the route says takeover is impossible — and still offers archive", () => {
  const route = buildTakeoverRoute({ candidates: { ids: [] }, attempting: "plan 的 write" });
  assert.match(route, /做不到/, "it must not print an attach command with no id in it");
  assert.doesNotMatch(route, /orchestrator_attach\(\{ orchestrationId: "" \}\)/);
  assert.match(route, /orchestrator_plan\(\{ action: "archive" \}\)/,
    "there is ALWAYS an executable way out — that is the whole point");
});

test("the candidate list is bounded, and says what it left out", () => {
  const ids = Array.from({ length: MAX_LISTED_CANDIDATES + 3 }, (_, i) => idOf(REPO, 1_700_000_000_000 + i * 1000));
  const route = buildTakeoverRoute({ candidates: { ids }, attempting: "接管一个编排" });
  const shown = [...route.matchAll(/orchestrator_attach/g)].length;
  assert.equal(shown, MAX_LISTED_CANDIDATES, "a repo with 40 old orchestrations must not print 40 lines");
  assert.match(route, /还有 3 个更早的/, "and a silent truncation would read as 'that is all there is'");
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

test("the archive path is inside the gate scope and carries a timestamp", () => {
  const path = planArchiveRelPath("2026-09-06T12:34:56.789Z");
  assert.ok(path.startsWith(".pi/orchestrator-plan.archived-"), path);
  assert.ok(path.endsWith(".json"));
  assert.doesNotMatch(path, /[:]/, "a colon in a file name is a bad idea on half the world's filesystems");
  assert.notEqual(path, planArchiveRelPath("2026-09-06T12:34:57.789Z"), "two archives never collide");
});

test("the archive carries the plan AND the registry — either half alone is enough to write one", () => {
  const plan = planOf();
  const both = JSON.parse(buildPlanArchive({
    plan,
    runtime: { orchestrationId: idOf(REPO, 1_700_000_000_000), children: [child()] },
    at: "2026-09-06T12:00:00.000Z",
    by: idOf(REPO, 1_800_000_000_000),
  }));
  assert.equal(both.plan.title, "上一轮的计划");
  assert.equal(both.orchestration.children.length, 1, "the registry goes with it, not just the plan");
  assert.equal(both.archivedAt, "2026-09-06T12:00:00.000Z");

  // A repo left over from the `rm` era: registry, no plan.
  const registryOnly = JSON.parse(buildPlanArchive({
    runtime: { orchestrationId: idOf(REPO, 1_700_000_000_000), children: [] },
    at: "2026-09-06T12:00:00.000Z",
    by: idOf(REPO, 1_800_000_000_000),
  }));
  assert.equal(registryOnly.plan, undefined);
  assert.ok(registryOnly.orchestration, "the surviving half is still archivable");
});

test("the confirm message tells the user what is moving and that nothing is deleted", () => {
  const message = buildArchiveConfirmMessage({
    plan: planOf(),
    archivePath: ".pi/orchestrator-plan.archived-2026-09-06.json",
    liveChildren: 2,
  });
  assert.match(message, /上一轮的计划/, "the user must see WHICH plan they are putting away");
  assert.match(message, /不是删除/);
  assert.match(message, /2 个子会话/);
  assert.match(message, /\.pi\/orchestrator-plan\.archived-2026-09-06\.json/, "and where it lands");

  const noPlan = buildArchiveConfirmMessage({ archivePath: ".pi/x.json", liveChildren: 0 });
  assert.match(noPlan, /没有 plan 文件/, "the registry-only case is a different sentence, not a crash");
});
