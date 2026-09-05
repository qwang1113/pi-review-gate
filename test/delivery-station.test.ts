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

import { SHIP_COMMAND_KINDS, type ShipCommandKind } from "../lib/constants.ts";
import {
  DEFAULT_DELIVERY_STATION,
  DELIVERY_STATIONS,
  allowedShipKinds,
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
  assert.match(describeDeliveryStation("precommit"), /你自己 commit/);
  assert.match(describeDeliveryStation("commit"), /你自己 push/);
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

test("arrival: `precommit` owes nothing beyond the gates that already ran", () => {
  assert.deepEqual(stationArrivalProblems("precommit", { dirtyRepos: ["repo"], recordedPr: null }), []);
});

test("arrival: `commit` owes a committed worktree", () => {
  assert.deepEqual(stationArrivalProblems("commit", { dirtyRepos: [], recordedPr: null }), []);
  const dirty = stationArrivalProblems("commit", { dirtyRepos: ["repo-a", "repo-b"], recordedPr: null });
  assert.equal(dirty.length, 1);
  assert.match(dirty[0]!, /repo-a、repo-b/, "the refusal names WHICH repo still holds work");
  assert.match(dirty[0]!, /commit/);
});

test("arrival: `pr` owes a committed worktree AND a PR the gate itself recorded", () => {
  assert.deepEqual(stationArrivalProblems("pr", { dirtyRepos: [], recordedPr: 42 }), []);

  const noPr = stationArrivalProblems("pr", { dirtyRepos: [], recordedPr: null });
  assert.equal(noPr.length, 1);
  assert.match(noPr[0]!, /没有记录到任何 PR/);

  // A missing field is the same fact as null — an older sidecar never opened
  // a PR either.
  assert.equal(stationArrivalProblems("pr", { dirtyRepos: [] }).length, 1);

  // Both halves missing ⇒ both are reported; a completion should learn
  // everything it still owes in one reply.
  assert.equal(stationArrivalProblems("pr", { dirtyRepos: ["repo"], recordedPr: null }).length, 2);
});

