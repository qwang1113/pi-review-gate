/**
 * The DELIVERY STATION (lib/delivery-station.ts) — the field that says where a
 * round stops, and the table the ship gate will read in the next task.
 *
 * Two properties carry the whole module, and both fail SILENTLY if they
 * regress, which is why they are pinned here rather than left to the callers:
 *
 *  - an unreadable station degrades to the STRICTEST value. A contract that
 *    forgot to say where it stops must never be read as permission to publish,
 *    and the degradation is deliberately silent — so nothing else would
 *    complain if it degraded the wrong way.
 *  - the ship table speaks the gate's OWN vocabulary (`ShipCommandKind`), not
 *    a second one. The audit that caught this (2026-09-06) named the exact
 *    failure: a private three-value enum here would be the second
 *    classification of ship commands in a repo that already has one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { codeSurfaces, proseSurfaces, readRepoFile, readSurfaces } from "./helpers/doc-surfaces.ts";
import { SHIP_COMMAND_KINDS, type ShipCommandKind } from "../lib/constants.ts";
import {
  DEFAULT_DELIVERY_STATION,
  DELIVERY_STATIONS,
  DELIVERY_STATION_CHOICES_EN,
  allowedShipKinds,
  deliveryStationChoiceLines,
  describeDeliveryStationEn,
  deliveryStationLine,
  deliveryStationRank,
  describeDeliveryStation,
  isDeliveryStation,
  isStationWidening,
  parseDeliveryStation,
  shipKindAllowedAtStation,
  describeAllowedShipKinds,
  stationArrivalProblems,
  stationShipProblem,
  STATION_SHIP_NEXT_STEPS,

  type DeliveryStation,
} from "../lib/delivery-station.ts";
import {
  buildRestatementConfirmMessage,
  buildRestatementTranscriptMessage,
} from "../lib/restatement.ts";
import { formatPlanSummary, parsePlan } from "../lib/orchestrator-plan.ts";
import { buildPlanConfirmMessage, buildPlanTranscriptMessage } from "../lib/orchestrator-tools.ts";

/** A minimal, VALID plan carrying one station — parsed, never hand-shaped. */
function planWithStation(station: DeliveryStation) {
  const parsed = parsePlan({
    title: "t",
    intent: "i",
    maxParallel: 1,
    deliveryStation: station,
    tasks: [{ id: "t1", title: "任务一", fileBoundaries: ["lib/"], repo: "/repo" }],
    decisions: [],
  });
  assert.ok(parsed.plan, `the fixture plan must parse: ${parsed.problems.join("; ")}`);
  return parsed.plan!;
}


test("the three stations exist, ordered strictest first, and precommit is the default", () => {
  assert.deepEqual([...DELIVERY_STATIONS], ["precommit", "commit", "pr"]);
  assert.equal(DEFAULT_DELIVERY_STATION, "precommit");
  assert.equal(deliveryStationRank("precommit"), 0);
  assert.ok(deliveryStationRank("precommit") < deliveryStationRank("commit"));
  assert.ok(deliveryStationRank("commit") < deliveryStationRank("pr"));
});

test("parse: every valid spelling round-trips; everything else degrades to precommit", () => {
  for (const station of DELIVERY_STATIONS) {
    assert.equal(parseDeliveryStation(station), station);
    assert.equal(parseDeliveryStation(` ${station.toUpperCase()} `), station,
      "whitespace and case are tolerated — a typo is not the same as a wrong station");
    assert.ok(isDeliveryStation(station));
  }
  // The fail-closed direction, one case per way a value can be wrong.
  for (const broken of [undefined, null, "", "  ", "PRECOMMIT ish", "push", "merge", 3, {}, ["pr"], true]) {
    assert.equal(parseDeliveryStation(broken), "precommit",
      `an unreadable station (${JSON.stringify(broken)}) must read as the strictest one`);
    assert.equal(isDeliveryStation(broken), false);
  }
});

test("widening: raising the station grants; lowering it and staying put do not", () => {
  assert.equal(isStationWidening("precommit", "commit"), true);
  assert.equal(isStationWidening("precommit", "pr"), true);
  assert.equal(isStationWidening("commit", "pr"), true);
  assert.equal(isStationWidening("pr", "commit"), false);
  assert.equal(isStationWidening("commit", "precommit"), false);
  for (const station of DELIVERY_STATIONS) {
    assert.equal(isStationWidening(station, station), false, "no change grants nothing");
  }
});

test("ship table: each station × EVERY ShipCommandKind, spelled out", () => {
  // Written as a full matrix on purpose: the next task wires this into the
  // hook path, and "which kinds does `commit` allow" must be a fact with a
  // test, not a reading of an implementation.
  const expected: Record<DeliveryStation, ShipCommandKind[]> = {
    precommit: [],
    commit: ["commit"],
    pr: ["commit", "push", "pr-create", "pr-edit"],
  };
  for (const station of DELIVERY_STATIONS) {
    for (const kind of SHIP_COMMAND_KINDS) {
      assert.equal(
        shipKindAllowedAtStation(station, kind),
        expected[station].includes(kind),
        `station ${station} × kind ${kind}`,
      );
    }
    assert.deepEqual([...allowedShipKinds(station)], expected[station]);
  }
});

test("ship table: the vocabulary IS the gate's own — no fourth kind, no missing kind", () => {
  // The P1 this module was rewritten for: a private {commit,push,pr} enum here
  // would be a second classification of ship commands. `pr` therefore covers
  // exactly SHIP_COMMAND_KINDS — if a kind is ever added to the gate, this
  // fails until somebody decides which stations may reach it.
  assert.deepEqual([...allowedShipKinds("pr")], [...SHIP_COMMAND_KINDS]);
  for (const station of DELIVERY_STATIONS) {
    for (const kind of allowedShipKinds(station)) {
      assert.ok((SHIP_COMMAND_KINDS as readonly string[]).includes(kind),
        `${kind} is not a ShipCommandKind — this module must not invent one`);
    }
  }
});

test("the user-facing line names the station AND who does the next step", () => {
  // The line is what a user reads before agreeing to it, so it has to say what
  // is NOT done for them — that is the half a station name alone cannot carry.
  assert.match(describeDeliveryStation("precommit"), /precommit/);
  // The USER's rendering (2026-09-17: the audience is a parameter, and the
  // DEFAULT is the agent's — see the audience test at the end of this file).
  assert.match(describeDeliveryStation("precommit", "user"), /你自己 commit/);
  assert.match(describeDeliveryStation("commit", "user"), /你自己 push/);
  assert.match(describeDeliveryStation("pr"), /PR/);
  assert.match(deliveryStationLine("pr"), /本轮交付站点：/);
});

test("the module is PURE: no fs, no clock, no gate-state import", async () => {
  // The next task calls this from the ship gate's hook path, which runs in its
  // own process. An import of node:fs or of the gate state would make that
  // impossible to do cheaply — and the module header promises it does not.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const src = readFileSync(
    fileURLToPath(new URL("../lib/delivery-station.ts", import.meta.url)), "utf8",
  );
  const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["./constants.ts"],
    "the only dependency may be the ship-kind vocabulary itself");
});

// ---------------------------------------------------------------------------
// The consumer side (2026-09-06): what a station REFUSES, and what it still
// OWES when the round wants to finish.

test("a station refusal names the command, the station and what that station does allow", () => {
  const blocked = stationShipProblem("commit", "push");
  assert.match(blocked, /`git push`/, "the reader must see the command, not an enum name");
  assert.match(blocked, /commit/);
  assert.match(blocked, /`git commit`/, "…and what IS allowed, so the next step is obvious");

  assert.match(stationShipProblem("precommit", "commit"), /不放行任何 ship 命令/);
  assert.equal(describeAllowedShipKinds("precommit"), "无 —— 该站点不放行任何 ship 命令");
  assert.match(describeAllowedShipKinds("pr"), /gh pr create/);
});

test("the station's next steps are the only two that exist, and no appeal is offered", () => {
  // Both routes end at the USER, because a station is the user's decision.
  assert.match(STATION_SHIP_NEXT_STEPS, /propose_restatement/);
  assert.match(STATION_SHIP_NEXT_STEPS, /deliveryStation/);
  // The review loop cannot clear a station, and the arbiter cannot hear this
  // block at all (it only takes a lone `gh pr edit`) — naming either would be
  // a dead end, and the arbiter one also costs an appeal.
  assert.doesNotMatch(STATION_SHIP_NEXT_STEPS, /judge_submit/);
  assert.doesNotMatch(STATION_SHIP_NEXT_STEPS, /request_arbitration/);
});

test("the station block answers 'I think the GATE is wrong', not only 'how do I comply'", () => {
  // USER REQUIREMENT (2026-09-06): every place the gate can misjudge must
  // carry a route that does NOT require getting around the gate — "otherwise
  // it will just invent ways around it". A list of ways to comply answers
  // "I did it wrong" and leaves the other question unanswered.
  //
  // A station really can be misread: the record may hold an older station than
  // the one the user agreed to, and a multi-repo command is judged by the
  // STRICTEST station among the repos it touches.
  assert.match(STATION_SHIP_NEXT_STEPS, /若你认为门禁把站点读错了/,
    "the misjudgement case must be named, not left for the reader to infer");
  assert.match(STATION_SHIP_NEXT_STEPS, /ask_user/,
    "…and answered with a route that exists: the station is the USER's to set");
  assert.match(STATION_SHIP_NEXT_STEPS, /最严/,
    "…including the multi-repo rule, which is the likeliest honest surprise");
  // …and the tempting shortcut is closed, because it silently does nothing:
  // the approval binds to content, so editing the file only drops the goal.
  assert.match(STATION_SHIP_NEXT_STEPS, /不要\*\*去手改|\*\*不要\*\*去手改/,
    "hand-editing the goal file must be named as the wrong move");
  assert.match(STATION_SHIP_NEXT_STEPS, /hash/,
    "…with the reason it cannot work");
});


test("arrival: `precommit` owes nothing beyond the gates that already ran", () => {
  assert.deepEqual(stationArrivalProblems("precommit", { dirty: true, recordedPr: null }), []);
});

test("arrival: `commit` owes a committed worktree", () => {
  assert.deepEqual(stationArrivalProblems("commit", { dirty: false, recordedPr: null }), []);
  const dirty = stationArrivalProblems("commit", { dirty: true, recordedPr: null });
  assert.equal(dirty.length, 1);
  assert.match(dirty[0]!, /未提交的改动/);
  assert.match(dirty[0]!, /commit/);
  // The line names no repo: the judgement is per repo, and the caller labels
  // it (a multi-repo declare_done prefixes `[repo]`). Naming it here too
  // printed the same repo twice — round-2 Nit.
  assert.doesNotMatch(dirty[0]!, /[[\]]/);
});

test("arrival: `pr` owes a committed worktree AND evidence that a PR was opened", () => {
  // EVIDENCE 1 — the gate watched `gh pr create` exit 0. This is the primary
  // one, and it must stand ALONE: a repo without `gh`, or one where
  // copilotReview is disabled, never gets a PR NUMBER, and an arrival gate
  // that insisted on the number would make such a `pr` round unfinishable
  // (round-1 reviewer P1, 2026-09-06).
  assert.deepEqual(stationArrivalProblems("pr", { dirty: false, observedPrCreate: true }), []);
  // EVIDENCE 2 — a PR number the Copilot cycle resolved, for a PR opened in
  // the browser or by an earlier session.
  assert.deepEqual(stationArrivalProblems("pr", { dirty: false, recordedPr: 42 }), []);

  const noPr = stationArrivalProblems("pr", { dirty: false, recordedPr: null });
  assert.equal(noPr.length, 1);
  assert.match(noPr[0]!, /没有看到 PR 被开出来/);
  // The refusal must name ways out that all actually work: the first version
  // claimed the gate records a PR number on any PR-class ship (false), and the
  // second pointed at `request_copilot_review` without saying that a project
  // with copilotReview disabled has to do something else (round-2 Nit).
  assert.match(noPr[0]!, /gh pr create/);
  assert.match(noPr[0]!, /request_copilot_review/);
  assert.match(noPr[0]!, /copilotReview/, "…and what to do when that switch is off");
  assert.match(noPr[0]!, /推分支还不算/, "a push is not a PR — say so, it is the likely confusion");

  // A missing field is the same fact as null — an older sidecar never opened
  // a PR either.
  assert.equal(stationArrivalProblems("pr", { dirty: false }).length, 1);
  // …and `false` evidence is not evidence.
  assert.equal(stationArrivalProblems("pr", { dirty: false, observedPrCreate: false }).length, 1);

  // Both halves missing ⇒ both are reported; a completion should learn
  // everything it still owes in one reply.
  assert.equal(stationArrivalProblems("pr", { dirty: true, recordedPr: null }).length, 2);
});

// ---------------------------------------------------------------------------
// ONE DEFINITION (2026-09-17): the sentence that says what a station MEANS
// ---------------------------------------------------------------------------
//
// `docs/module-map.md` §7.2 listed this as an unpinned copy and was right: the
// Chinese definition was written out a second time in `lib/restatement.ts`, the
// English one a third and fourth time in `lib/restatement.ts` and
// `lib/loop-goal.ts`, and a fifth in `README.md` — inside a paragraph that
// claimed the rules "are not restated here". Nothing tied any of them to
// `describeDeliveryStation`, so a corrected definition would have reached the
// dialog and left every tool description saying the old thing.
//
// The convergence is structural: callers RENDER (`describeDeliveryStationEn`,
// `DELIVERY_STATION_CHOICES_EN`, `deliveryStationChoiceLines`) and never
// restate. These two tests are what keeps it that way.

test("the station definitions live in ONE file — no other source restates them", () => {
  const AUTHORITY = "lib/delivery-station.ts";
  const definitions = [
    // BOTH audiences: the dialog's wording and the refusal's wording are two
    // renderings of one definition, and either could be hand-copied back in.
    ...DELIVERY_STATIONS.map((station) => describeDeliveryStation(station, "user")),
    ...DELIVERY_STATIONS.map((station) => describeDeliveryStation(station, "agent")),
    ...DELIVERY_STATIONS.map(describeDeliveryStationEn),
  ];

  // The part of each sentence that carries the MEANING. The actor word is
  // interpolated (user vs. agent), so the full rendering is not a literal in
  // the source — these fragments are, and a hand-copy would carry them too.
  const fragments = [
    "门禁检查跑通即交付", "提交完成即交付", "一路做到 PR 开出来",
    ...DELIVERY_STATIONS.map(describeDeliveryStationEn),
  ];
  const needles = [...definitions, ...fragments];

  // (1) The needles are real needles: the authority itself contains every
  // fragment literally, and renders every definition. Without this, a renamed
  // sentence would empty the scan and pass silently.
  const authorityText = readRepoFile(AUTHORITY);
  for (const fragment of fragments) {
    assert.ok(
      authorityText.includes(fragment),
      `${AUTHORITY} must literally contain the definition fragment it renders: ${fragment}`,
    );
  }
  for (const definition of definitions) {
    assert.ok(
      fragments.some((fragment) => definition.includes(fragment)),
      `the rendered definition "${definition}" contains none of the fragments the scan hunts for`,
    );
  }

  // (2) The scan sees what it claims to — including every file that used to
  // carry a copy. A scan that lost them would report "converged" forever.
  const scanned = [...codeSurfaces(), ...proseSurfaces()];
  for (const rel of ["lib/restatement.ts", "lib/loop-goal.ts", "lib/orchestrator-plan.ts", "README.md", "AGENTS.md"]) {
    assert.ok(scanned.includes(rel), `the scan must cover ${rel} — it carried a copy before`);
  }
  assert.ok(scanned.length > 100, `the scan looks too narrow (${scanned.length} files)`);

  // (3) The verdict.
  for (const rel of scanned) {
    if (rel === AUTHORITY) continue;
    const text = readRepoFile(rel);
    for (const definition of needles) {
      assert.ok(
        !text.includes(definition),
        `${rel} writes out a delivery-station definition ("${definition}") that ${AUTHORITY} already owns. ` +
          "Render it instead (describeDeliveryStation / describeDeliveryStationEn / " +
          "DELIVERY_STATION_CHOICES_EN / deliveryStationChoiceLines) — a hand-copied definition is one " +
          "nobody updates when the real one changes.",
      );
    }
  }
});

test("every surface that summarises the station points at the module that defines it", () => {
  // The other half of the contract: a summary is allowed, an unattributed
  // summary is not — the reader has to be able to reach the authority.
  const surfaces = readSurfaces([
    { path: "AGENTS.md", anchor: "交付站点" },
    { path: "README.md", anchor: "delivery station" },
    { path: "QUICKSTART.md", anchor: "交付站点" },
    { path: "docs/dev-flow.md", anchor: "交付站点" },
    { path: "skills/review-loop/SKILL.md", anchor: "station" },
  ]);
  for (const { path, text } of surfaces) {
    assert.ok(
      text.includes("lib/delivery-station.ts"),
      `${path} summarises the delivery station but never names lib/delivery-station.ts — ` +
        "a summary without a pointer is where the next stale copy starts",
    );
  }
});

test("the rendered choice lists are derived, not typed out again", () => {
  // Structural, not textual: if someone replaces the renderers with literals,
  // changing `describeDeliveryStation` stops moving them and this fails.
  for (const station of DELIVERY_STATIONS) {
    assert.ok(DELIVERY_STATION_CHOICES_EN.includes(describeDeliveryStationEn(station)));
    assert.ok(deliveryStationChoiceLines().includes(describeDeliveryStation(station, "agent")));
    assert.ok(deliveryStationChoiceLines("- ", "user").includes(describeDeliveryStation(station, "user")));
  }
  // One line per station, and the indent is the caller's.
  assert.equal(deliveryStationChoiceLines().split("\n").length, DELIVERY_STATIONS.length);
  assert.ok(deliveryStationChoiceLines("* ").startsWith("* precommit"));

  // WHO COMMITS. A choice list is read by the AGENT, and the agent is never
  // the one who commits at `precommit` — rendering the dialog's second person
  // into a refusal said the opposite (round-1 P2). The dialog keeps it.
  assert.ok(deliveryStationChoiceLines().includes("由用户自己 commit"), "the refusal names the USER as the committer");
  assert.ok(!deliveryStationChoiceLines().includes("由你自己 commit"), "…and never the reader");
  // The station LINE defaults to the safe wording too, and the dialogs opt in
  // to the second person — the direction that cannot mislead a reader who is
  // not the user (round-2 P2).
  assert.ok(deliveryStationLine("precommit").includes("由用户自己 commit"), "the default line is safe for an agent");
  assert.ok(deliveryStationLine("precommit", "user").includes("由你自己 commit"), "a dialog speaks to the user directly");
});

test("every default in the module is the SAFE person, and the user surfaces opt out of it", () => {
  // (1) The base renderer, not just the wrappers (round-3 P2): a default that
  // stopped one level short left the ship BLOCK — which only an agent ever
  // reads — telling the reader it was the one who commits.
  assert.ok(describeDeliveryStation("precommit").includes("由用户自己 commit"));
  assert.ok(stationShipProblem("precommit", "push").includes("由用户自己 commit"));
  assert.ok(!stationShipProblem("precommit", "push").includes("由你自己 commit"));

  // (2) The surfaces the USER reads DO speak to them — each one, by output
  // rather than by call site (round-3 Nit: only one of the five opt-ins was
  // pinned, so dropping "user" from any of the others went unnoticed).
  const userSurfaces: [string, string][] = [
    ["restatement transcript", buildRestatementTranscriptMessage("反述正文", "precommit")],
    ["restatement dialog", buildRestatementConfirmMessage("precommit")],
    ["plan transcript", buildPlanTranscriptMessage(planWithStation("precommit"))],
    ["plan dialog", buildPlanConfirmMessage(planWithStation("precommit"))],
  ];
  for (const [what, text] of userSurfaces) {
    assert.ok(
      text.includes("由你自己 commit"),
      `the ${what} is read by the USER — it must address them, not describe them in the third person`,
    );
  }
  // (3) …and the plan SUMMARY, whose other readers are all agents, does not.
  assert.ok(formatPlanSummary(planWithStation("precommit")).includes("由用户自己 commit"));
});




