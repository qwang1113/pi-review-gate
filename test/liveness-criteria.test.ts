/**
 * THE THREE LIVENESS CRITERIA ARE NOT ONE RULE — and this file is what stops
 * the next reader from "converging" them.
 *
 * Three checks in this repository read like "is that thing still alive":
 *
 *   - lib/blocked-marker.ts     — is a RECORD ON DISK still somebody's?
 *   - lib/session-exclusivity.ts — is a HEARTBEAT still fresh?
 *   - lib/judge-pane.ts          — is a tmux PANE still listed?
 *   - lib/session-registry.ts    — is the HOLDER OF A NAME gone? (2026-09-25:
 *     the only criterion that MIXES the others: heartbeat stale AND pid gone
 *     AND pane gone, anything unreadable meaning unknown; argued in its header)
 *
 * They were reviewed together on 2026-09-06 under philosophy three ("never two
 * implementations of one thing") and found to be THREE questions, not one: they
 * differ in subject, in FAILURE DIRECTION, and in time scale — each argued from
 * its own cost. Their own module headers carry the argument; the tests below
 * carry the BEHAVIOUR, side by side, so that a future attempt to unify them
 * fails here rather than in production.
 *
 * A fourth criterion (pid + process start time, "is that pid still OUR judge",
 * lib/judge-session.ts) was deleted the same day. That one really WAS a
 * philosophy-three violation: a second implementation with no production caller
 * left. The distinction this file exists to make is exactly that one — an
 * unused duplicate is deleted, differently-argued rules are not. (The plain pid
 * probe returned in 2026-09-25 as ONE fact among three for the registry's name
 * release; the ratchet at the bottom of this file pins it to that one home.)
 */
import test from "node:test";
import assert from "node:assert/strict";

import { reconcileBlockedOwners, type BlockedMarker } from "../lib/blocked-marker.ts";
import { CONCURRENT_SESSION_WINDOW_MS } from "../lib/constants.ts";
import {
  PRESENCE_FRESH_MS,
  checkSessionExclusivity,
  parsePresence,
} from "../lib/session-exclusivity.ts";
import { judgePaneAlive, type JudgePaneRunner } from "../lib/judge-pane.ts";

const NOW = 1_700_000_000_000;

function markerWith(at: string): BlockedMarker {
  return {
    schema: 1,
    owners: [{ sessionId: "some-other-session", pid: 999, host: "other.local", at }],
  };
}

test("the SAME unknown — an unreadable timestamp — is refused by one and waved through by the other", () => {
  // (a) blocked-marker: an owner whose age cannot be read is KEPT, so the
  //     marker keeps refusing commits. Being wrong here ships unreviewed code.
  const kept = reconcileBlockedOwners(markerWith("not-a-timestamp"), "my-session", NOW);
  assert.equal(kept.survivors.length, 1, "an unreadable owner age must fail CLOSED (keep the owner)");

  // (b) session-exclusivity: a record that cannot be parsed is NO HOLDER, so
  //     the session is allowed to work. Being wrong here locks a human out of
  //     their own checkout.
  assert.equal(parsePresence("not-json-at-all"), undefined, "a corrupt presence record is no holder");
  const allowed = checkSessionExclusivity({
    env: {},
    repoRoot: "/repo",
    sessionId: "my-session",
    existing: parsePresence("not-json-at-all"),
    now: NOW,
  });
  assert.equal(allowed.ok, true, "an unparsable presence record must fail OPEN (let the session work)");
});

test("a FUTURE timestamp (clock skew on a shared checkout) is kept by one and ignored by the other", () => {
  const future = new Date(NOW + 60 * 60 * 1000).toISOString();

  // Skew must never delete a live fail-closed signal…
  const kept = reconcileBlockedOwners(markerWith(future), "my-session", NOW);
  assert.equal(kept.survivors.length, 1, "a future owner stamp must not be reclaimed");

  // …but a future heartbeat is not a positive fact about NOW either, and this
  // side refuses nobody without one.
  const verdict = checkSessionExclusivity({
    env: {},
    repoRoot: "/repo",
    sessionId: "my-session",
    existing: { sessionId: "incumbent", pid: 1, host: "h", at: future },
    now: NOW,
  });
  assert.equal(verdict.ok, true, "a future heartbeat must fail OPEN, not lock the checkout");
});

test("the pane criterion answers a THIRD way: missing information, neither alive nor dead", () => {
  const blindRunner: JudgePaneRunner = () => ({ ok: false, stdout: "", stderr: "no server" });
  assert.equal(
    judgePaneAlive(blindRunner, "%1"),
    undefined,
    "an unreadable pane list is missing information — never a dead judge",
  );

  const seeing: JudgePaneRunner = () => ({ ok: true, stdout: "%0\n%1\n", stderr: "" });
  assert.equal(judgePaneAlive(seeing, "%1"), true);
  assert.equal(judgePaneAlive(seeing, "%7"), false);
});

test("the two time windows are different quantities on purpose (a session vs a heartbeat)", () => {
  // Not a style preference: four hours is a session's lifetime, sixty seconds
  // is one 10s heartbeat's tolerance. If someone ever "shares the constant",
  // one of the two arguments has been thrown away — see both module headers.
  assert.equal(CONCURRENT_SESSION_WINDOW_MS, 4 * 60 * 60 * 1000);
  assert.equal(PRESENCE_FRESH_MS, 60_000);
  assert.equal(
    CONCURRENT_SESSION_WINDOW_MS / PRESENCE_FRESH_MS,
    240,
    "the 240× gap is the evidence that these measure different things",
  );
});

test("pid liveness lives in EXACTLY ONE place, and it is the weakest of three facts", async () => {
  // IT WAS DELETED ONCE (2026-09-06, "no production caller") AND IT CAME BACK
  // WITH ONE (2026-09-25, user decision, the session registry): a NAME is
  // released only when the holder is provably gone, and "provably" is three
  // facts — a stale heartbeat AND no process with that pid AND no pane in tmux
  // — with anything unreadable meaning `unknown`, which releases nothing. The
  // pid is the WEAKEST of the three (pids are recycled, so a live pid never
  // proves the session is alive; only a dead one adds evidence), and that is
  // exactly why the ratchet below is now an ALLOW-LIST rather than a
  // prohibition: one module may probe, nobody else may, and the day a second
  // one starts it fails here instead of becoming a second answer to "is that
  // session still alive".
  const { readdirSync, readFileSync } = await import("node:fs");
  const libDir = new URL("../lib/", import.meta.url);
  const offenders: string[] = [];
  for (const name of readdirSync(libDir)) {
    if (!name.endsWith(".ts")) continue;
    if (name === "session-registry.ts") continue; // the one home, argued in its header
    const src = readFileSync(new URL(name, libDir), "utf8");
    // CODE only. blocked-marker.ts's own header argues AGAINST pid probing by
    // naming the call, and a test that cannot tell the warning from the deed
    // would forbid documenting the decision at all.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
      .join("\n");
    // `process.kill(pid, 0)` is the liveness probe; a real termination
    // (`process.kill(pid, "SIGTERM")`) is a different thing and stays allowed.
    if (/process\.kill\([^,)]+,\s*0\s*\)/.test(code)) offenders.push(name);
    if (/ps\s+-o\s+lstart/.test(code)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    "pid liveness escaped its one home (lib/session-registry.ts `pidAlive`) — " +
      "a second implementation is a second answer to whether a session is alive",
  );
  // AND THE ONE HOME IS THE WEAKEST LINK ON PURPOSE: a live pid alone is not
  // enough to call a holder alive in the tool's own refusals/takeovers — the
  // classification reads the heartbeat first and the pane list before the pid
  // (lib/session-registry.ts `classifyEntry`), which the registry's own tests
  // pin branch by branch.
});
