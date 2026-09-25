/**
 * MY OWN TMUX SESSION — the unit-level half of the window topology.
 *
 * The integration test (`test/tmux-session-topology.integration.test.ts`) proves
 * what tmux DOES with these argv on a real server. This file drives the same
 * module against a fake server so the paths a real one is hard to put into can
 * be asserted at all: an unreadable tmux, a session wearing our name that is not
 * ours, a marker write that failed, a session tmux has already reclaimed.
 *
 * The rule they all share, and the reason they are asserted here rather than
 * left to the integration test: an unknown is NEVER acted on. Nothing is
 * created, reused or killed unless the reading says it is ours.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  UnsafeTmuxCommand,
  assertSafeTmuxArgv,
  buildKillWindowArgv,
  isOwnSessionName,
  SESSION_OWNER_OPTION,
} from "../lib/orchestrator-tmux.ts";
import {
  addressableSessions,
  closeOwnSession,
  deriveSessionName,
  openScopeWindow,
  sanitizeScopeRecord,
  type ScopeRunResult,
  type ScopeRunner,
  type TmuxScope,
  type TmuxScopeRecord,
} from "../lib/session-tmux-scope.ts";

const SESSION_ID = "019fbb1d-9e78-7ebf-88bf-d104b8a270ed";
const NAME = deriveSessionName("/repo", SESSION_ID)!;
/** A DIFFERENT session (the same repo, another seat) — the successor's own. */
const SUCCESSOR_ID = "019fbb1d-9e78-7ebf-88bf-ffee00000011";
const SUCCESSOR_NAME = deriveSessionName("/repo", SUCCESSOR_ID)!;

/**
 * THE PREDECESSOR'S WINDOWS ARE STILL THE SUCCESSOR'S TO CLOSE (P1).
 *
 * A relay successor owns the previous seat's judges (`callerIdentities()`
 * counts them as its own), so it closes their windows — and those windows live
 * in the PREDECESSOR'S session. The declaration is therefore the set this
 * process holds coordinates for, not one name; this test runs the REAL builder
 * through the REAL guard, which is exactly the call `judge_close` makes.
 */
test("a successor may close a window in the session its predecessor's rows name", () => {
  const scope = fakeScope(SUCCESSOR_ID);
  const guard = {
    ownSessions: addressableSessions(scope, [NAME]),
  };
  assert.deepEqual(guard.ownSessions, [SUCCESSOR_NAME, NAME], "mine plus the one my rows name");
  assert.doesNotThrow(() => assertSafeTmuxArgv(buildKillWindowArgv(NAME, "@7"), guard),
    "the inherited judge's window is closable");
  assert.doesNotThrow(() => assertSafeTmuxArgv(buildKillWindowArgv(SUCCESSOR_NAME, "@7"), guard),
    "and so are the successor's own children");
  const third = deriveSessionName("/repo", "019fbb1d-9e78-7ebf-88bf-00000000ffee")!;
  assert.throws(() => assertSafeTmuxArgv(buildKillWindowArgv(third, "@7"), guard), UnsafeTmuxCommand,
    "a session nothing of mine names is still out of reach");
  // And with NO such row, the predecessor's session is out of reach too: the
  // wider list is the registries' doing, not a blanket permission.
  assert.throws(
    () => assertSafeTmuxArgv(buildKillWindowArgv(NAME, "@7"), { ownSessions: addressableSessions(scope, []) }),
    UnsafeTmuxCommand,
  );
});

/** A tmux server in a Map: sessions by name, each with its owner marker. */
function fakeServer(opts: {
  /** Start with this session already there, owned by `owner`. */
  existing?: { name: string; owner: string };
  /** `list-sessions` itself fails — tmux is unreachable. */
  blind?: boolean;
  /** The marker write fails. */
  markerFails?: boolean;
  /** The kill fails. */
  killFails?: boolean;
} = {}): { run: ScopeRunner; calls: string[][]; sessions: Map<string, string> } {
  const sessions = new Map<string, string>();
  if (opts.existing) sessions.set(opts.existing.name, opts.existing.owner);
  const calls: string[][] = [];
  const run: ScopeRunner = (argv) => {
    calls.push([...argv]);
    const sub = argv[0];
    const target = String(argv[argv.indexOf("-t") + 1] ?? "");
    if (sub === "list-sessions") {
      return opts.blind
        ? { ok: false, stdout: "", stderr: "no server running" }
        : { ok: true, stdout: [...sessions.keys()].join("\n"), stderr: "" };
    }
    if (sub === "new-session") {
      const name = String(argv[argv.indexOf("-s") + 1]);
      sessions.set(name, "");
      return { ok: true, stdout: "@7 %8\n", stderr: "" };
    }
    if (sub === "new-window") return { ok: true, stdout: "@9 %10\n", stderr: "" };
    if (sub === "set") {
      if (opts.markerFails) return { ok: false, stdout: "", stderr: "tmux refused the option" };
      const value = String(argv[argv.length - 1]);
      const session = target.slice(0, target.indexOf(":") < 0 ? undefined : target.indexOf(":"));
      sessions.set(session, value);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (sub === "show-options") return { ok: true, stdout: `${sessions.get(target) ?? ""}\n`, stderr: "" };
    if (sub === "kill-session") {
      if (opts.killFails) return { ok: false, stdout: "", stderr: "tmux refused the kill" };
      sessions.delete(target);
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" } satisfies ScopeRunResult;
  };
  return { run, calls, sessions };
}

interface FakeScope extends TmuxScope {
  record: TmuxScopeRecord | undefined;
  writes: number;
  /** Replaced by tests that need an identity-less session. */
  sessionId: () => string | undefined;
}

function fakeScope(sessionId: string = SESSION_ID): FakeScope {
  const scope: FakeScope = {
    record: undefined,
    writes: 0,
    sessionId: () => sessionId,
    repoRoot: () => "/repo",
    read: () => scope.record,
    write: (record) => { scope.record = record; scope.writes += 1; },
    now: () => "2026-09-25T00:00:00.000Z",
  };
  return scope;
}

test("the name is derived from the id's TAIL — the head is a timestamp", () => {
  // pi's session ids are UUIDv7: their leading bits are the millisecond the
  // session started, so two sessions in the same minute share their first eight
  // hex characters (measured on this machine). A head-based name would collide
  // exactly among the sessions most likely to run at once.
  const later = `${SESSION_ID.slice(0, -6)}ffee00`;
  assert.equal(deriveSessionName("/repo", SESSION_ID), NAME);
  assert.notEqual(deriveSessionName("/repo", later), NAME, "same-millisecond ids must not share a name");
  assert.equal(NAME, "rg-repo-04b8a270ed");
  // The slug: a directory name is not a tmux session name until it is stripped.
  assert.equal(deriveSessionName("/Users/a/My Repo.Dir", SESSION_ID), "rg-my-repo-dir-04b8a270ed");
  assert.equal(deriveSessionName("/x/目录名", SESSION_ID), "rg-repo-04b8a270ed", "a non-ASCII slug falls back");
  assert.equal(deriveSessionName("/", SESSION_ID), "rg-repo-04b8a270ed", "and so does no slug at all");
  for (const id of ["/repo", "/x/My Repo"]) {
    assert.equal(isOwnSessionName(deriveSessionName(id, SESSION_ID)), true,
      "every derived name must pass the validator the guard applies");
  }
  // Too little entropy to name anything after: refuse rather than emit `rg-repo-`.
  assert.equal(deriveSessionName("/repo", "a1"), undefined);
  assert.equal(deriveSessionName("/repo", ""), undefined);
});

test("a persisted record is trusted only when it is complete", () => {
  const good = { name: NAME, owner: SESSION_ID, createdAt: "2026-09-25T00:00:00.000Z" };
  assert.deepEqual(sanitizeScopeRecord(good), good);
  for (const bad of [
    undefined,
    null,
    "rg-repo-04b8a270ed",
    { ...good, name: "my-work" },
    { ...good, name: "%1" },
    { ...good, owner: "   " },
    { ...good, owner: undefined },
    { ...good, createdAt: undefined },
  ]) {
    assert.equal(sanitizeScopeRecord(bad), undefined, `${JSON.stringify(bad)} is not a usable record`);
  }
});

test("the addressable set is MINE plus the sessions I hold coordinates for", () => {
  // "Mine" is not one name (2026-09-25, quality round P1): a relay successor
  // owns the previous seat's judges, whose windows live in the PREDECESSOR's
  // session — a declaration of one name made every one of those closes
  // impossible, and those windows are exactly what a successor is for.
  const scope = fakeScope();
  const other = "rg-other-repo-abcdef1234";
  assert.deepEqual(addressableSessions(scope, []), [NAME], "just my own, when I hold nothing else");
  assert.deepEqual(addressableSessions(scope, [other]), [NAME, other], "…plus every session a row names");
  // Deduplicated, and an id-less session contributes nothing.
  assert.deepEqual(addressableSessions(scope, [NAME, other, NAME]), [NAME, other]);
  // THE LIST CANNOT WIDEN THROUGH A REGISTRY: a row whose session name is not
  // something the gate could have derived (a hand-edited file, a user's own
  // session name) is dropped — the user's sessions are as unreachable through a
  // record as through a parameter.
  assert.deepEqual(addressableSessions(scope, ["my-work", "lab", "", undefined]), [NAME]);
});

test("a sidecar record is NOT a licence to kill another session (reviewer P1)", () => {
  // The shape of the attack: write a record naming ANOTHER gate session, with
  // that session's own marker as the owner, and the gate kills it on your
  // behalf. The name looked right and the marker matched — so the record itself
  // has to be bound to THIS process's identity before anything acts on it.
  const server = fakeServer();
  const scope = fakeScope();
  const victim = "rg-other-repo-abcdef1234";
  server.sessions.set(victim, "the-other-sessions-id");
  scope.record = { name: victim, owner: "the-other-sessions-id", createdAt: "2026-09-25T00:00:00.000Z" };

  const killed = closeOwnSession(server.run, scope);
  assert.equal(killed.ok, true);
  assert.equal(killed.ok ? killed.killed : true, false, "nothing is killed on an unbound record");
  assert.equal(server.sessions.has(victim), true, "the other session is still standing");
  assert.equal(server.calls.some((a) => a[0] === "kill-session"), false, "no kill was even attempted");

  // …and it cannot widen the EXECUTOR's declaration either: the addressable
  // list is derived from this process's identity, not from the file.
  assert.deepEqual(addressableSessions(scope, []), [NAME], "a tampered record adds nothing");

  // The same record pointing at OUR OWN name is honoured again — the fix is
  // about binding, not about distrusting the sidecar.
  scope.record = { name: NAME, owner: SESSION_ID, createdAt: "2026-09-25T00:00:00.000Z" };
  server.sessions.set(NAME, SESSION_ID);
  const ours = closeOwnSession(server.run, scope);
  assert.equal(ours.ok, true);
  assert.equal(ours.ok ? ours.killed : false, true, "our own session is still closed as before");
});

test("a session with no id cannot act through a record at all", () => {
  const server = fakeServer();
  const scope = fakeScope();
  scope.record = { name: NAME, owner: SESSION_ID, createdAt: "2026-09-25T00:00:00.000Z" };
  scope.sessionId = () => undefined;
  server.sessions.set(NAME, SESSION_ID);
  assert.deepEqual(addressableSessions(scope, []), [], "nothing to declare without an identity");
  const killed = closeOwnSession(server.run, scope);
  assert.equal(killed.ok, true);
  assert.equal(killed.ok ? killed.killed : true, false);
  assert.equal(server.sessions.has(NAME), true, "a name with no identity behind it is never killed");
});

test("the first child creates the session WITH it; a later one joins", () => {
  const server = fakeServer();
  const scope = fakeScope();
  const first = openScopeWindow(server.run, scope, { cwd: "/repo", command: ["pi"], windowName: "reviewer@self" });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual({ created: first.created, name: first.sessionName, coords: [first.windowId, first.paneId] },
    { created: true, name: NAME, coords: ["@7", "%8"] });
  // The marker is written on the session we just made, and the record follows.
  assert.equal(server.sessions.get(NAME), SESSION_ID, "the session says who created it");
  assert.equal(scope.record?.name, NAME);
  assert.equal(scope.record?.owner, SESSION_ID);
  assert.equal(scope.writes, 1, "one write, on creation only");
  assert.ok(server.calls.some((a) => a[0] === "set" && a.includes(SESSION_OWNER_OPTION)));

  const second = openScopeWindow(server.run, scope, { cwd: "/repo", command: ["pi"] });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.created, false, "the second child joins the session");
  assert.deepEqual([second.windowId, second.paneId], ["@9", "%10"]);
  assert.equal(scope.writes, 1, "and writes no second record");
  assert.equal(server.calls.filter((a) => a[0] === "new-session").length, 1);
});

test("a session wearing OUR name that is not ours is neither reused nor killed", () => {
  const server = fakeServer({ existing: { name: NAME, owner: "some-other-session-id" } });
  const scope = fakeScope();
  scope.record = { name: NAME, owner: SESSION_ID, createdAt: "2026-09-25T00:00:00.000Z" };
  const opened = openScopeWindow(server.run, scope, { cwd: "/repo", command: ["pi"] });
  assert.equal(opened.ok, false, "creation is refused");
  if (!opened.ok) assert.match(opened.error, /归属标记/);
  const killed = closeOwnSession(server.run, scope);
  assert.equal(killed.ok, false, "and so is the kill");
  if (!killed.ok) assert.match(killed.error, /归属标记/);
  assert.equal(server.sessions.get(NAME), "some-other-session-id", "the stranger's session is untouched");
  assert.equal(server.calls.some((a) => a[0] === "new-window"), false, "nothing was added to it");
  assert.equal(server.calls.some((a) => a[0] === "kill-session"), false, "and nothing was taken from it");
});

test("a session we own is reused even when the record was lost", () => {
  // The marker — not the sidecar — is what proves ownership: losing the record
  // costs a re-derivation (same name, same owner), never a refusal.
  const server = fakeServer({ existing: { name: NAME, owner: SESSION_ID } });
  const scope = fakeScope();
  const opened = openScopeWindow(server.run, scope, { cwd: "/repo", command: ["pi"] });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.created, false);
  assert.equal(scope.writes, 0, "nothing was created, so nothing is recorded");
});

test("a marker that failed to write takes the session with it (quality round P2)", () => {
  // The failure mode this pins: without the marker the session can neither be
  // reused (the next spawn reads an empty owner and refuses) nor killed
  // (`closeOwnSession` refuses a marker that is not ours) — one failed `set`
  // would block every future child of this session. The session is ours (this
  // call created it), so it is reclaimed on the spot.
  const server = fakeServer({ markerFails: true });
  const scope = fakeScope();
  const opened = openScopeWindow(server.run, scope, { cwd: "/repo", command: ["pi"] });
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.match(opened.error, /归属标记失败/);
  assert.equal(server.sessions.has(NAME), false, "the half-made session is gone");
  assert.deepEqual(server.calls.filter((a) => a[0] === "kill-session").length, 1);
  assert.equal(scope.record, undefined, "and nothing was recorded for it");
});

test("an unreadable tmux is 'I do not know' — nothing is created and nothing is killed", () => {
  const server = fakeServer({ blind: true });
  const scope = fakeScope();
  scope.record = { name: NAME, owner: SESSION_ID, createdAt: "2026-09-25T00:00:00.000Z" };
  const opened = openScopeWindow(server.run, scope, { cwd: "/repo", command: ["pi"] });
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.match(opened.error, /读不到 tmux server/);
  assert.equal(server.calls.some((a) => a[0] === "new-session"), false, "no session is created in the dark");
  const killed = closeOwnSession(server.run, scope);
  assert.equal(killed.ok, false);
  assert.equal(server.calls.some((a) => a[0] === "kill-session"), false, "and nothing is killed on a guess");
});

test("closing is scoped, idempotent and honest about what it did", () => {
  const server = fakeServer();
  const scope = fakeScope();
  // Never opened a child: nothing to close, and no tmux call is even made.
  const empty = closeOwnSession(server.run, scope);
  assert.equal(empty.ok, true);
  assert.equal(empty.ok ? empty.killed : true, false);
  assert.deepEqual(server.calls, [], "a session that was never created costs no tmux call");

  openScopeWindow(server.run, scope, { cwd: "/repo", command: ["pi"] });
  const killed = closeOwnSession(server.run, scope);
  assert.equal(killed.ok, true);
  assert.equal(killed.ok ? killed.killed : false, true);
  assert.deepEqual(server.calls.filter((a) => a[0] === "kill-session").length, 1);
  assert.equal(server.sessions.has(NAME), false);

  // tmux reclaims a session whose last window closed, so the second close finds
  // nothing — a normal end, reported as such rather than as an error.
  const again = closeOwnSession(server.run, scope);
  assert.equal(again.ok, true);
  assert.equal(again.ok ? again.killed : true, false);
  if (again.ok) assert.match(again.note, /已不在/);
  assert.deepEqual(server.calls.filter((a) => a[0] === "kill-session").length, 1, "no second kill");
});

test("a kill that tmux refuses is REPORTED, never swallowed", () => {
  const server = fakeServer({ killFails: true });
  const scope = fakeScope();
  scope.record = { name: NAME, owner: SESSION_ID, createdAt: "2026-09-25T00:00:00.000Z" };
  server.sessions.set(NAME, SESSION_ID);
  const killed = closeOwnSession(server.run, scope);
  assert.equal(killed.ok, false);
  if (!killed.ok) assert.match(killed.error, /refused the kill/);
});
