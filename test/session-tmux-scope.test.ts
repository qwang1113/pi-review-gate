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
  isOwnSessionName,
  type TmuxRunner,
  type TmuxRunResult,
} from "../lib/orchestrator-tmux.ts";
import {
  buildKillWindowArgv,
  buildUnsetSessionEnvArgv,
  SESSION_OWNER_OPTION,
  SESSION_OWNER_PANE_OPTION,
  SESSION_OWNER_PID_OPTION,
  SESSION_PINNED_OPTION,
} from "../lib/tmux-session-argv.ts";
import {
  addressableSessions,
  closeOwnSession,
  createOwnershipProbe,
  deriveSessionName,
  openScopeWindow,
  pinOwnSession,
  sanitizeScopeRecord,
  scopeNameOwnedBy,
  sessionNameBelongsTo,
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
  // The predecessor's session IS on the server, marked with the id its own name
  // derives from — the fact the ownership probe reads (t4 review P1).
  const server = fakeServer({ existing: { name: NAME, owner: SESSION_ID } });
  const probe = createOwnershipProbe(scope, server.run);
  const guard = {
    ownSessions: addressableSessions(scope, [NAME], probe),
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
    () => assertSafeTmuxArgv(buildKillWindowArgv(NAME, "@7"), { ownSessions: addressableSessions(scope, [], probe) }),
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
  /** What the session's OWN environment already holds (a polluted session). */
  env?: Record<string, string>;
  /** `show-environment` itself fails — the gate cannot see what is in there. */
  envReadFails?: boolean;
  /** tmux refuses the removal. */
  envUnsetFails?: boolean;
  /** …or throws while trying. */
  envUnsetThrows?: boolean;
} = {}): { run: TmuxRunner; calls: string[][]; sessions: Map<string, string>; env: Record<string, string> } {
  const sessions = new Map<string, string>();
  if (opts.existing) sessions.set(opts.existing.name, opts.existing.owner);
  const env: Record<string, string> = { ...(opts.env ?? {}) };
  const calls: string[][] = [];
  const run: TmuxRunner = (argv) => {
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
    if (sub === "show-environment") {
      if (opts.envReadFails) return { ok: false, stdout: "", stderr: "tmux refused the read" };
      return { ok: true, stdout: Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"), stderr: "" };
    }
    if (sub === "set-environment") {
      if (opts.envUnsetThrows) throw new Error("tmux blew up on set-environment");
      if (opts.envUnsetFails) return { ok: false, stdout: "", stderr: "tmux refused the unset" };
      delete env[String(argv[argv.length - 1])];
      return { ok: true, stdout: "", stderr: "" };
    }
    if (sub === "kill-session") {
      if (opts.killFails) return { ok: false, stdout: "", stderr: "tmux refused the kill" };
      sessions.delete(target);
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" } satisfies TmuxRunResult;
  };
  return { run, calls, sessions, env };
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

test("the addressable set is MINE plus every session a MARKER proves", () => {
  // "Mine" is not one name (2026-09-25, quality round P1): a relay successor
  // owns the previous seat's judges, whose windows live in the PREDECESSOR's
  // session — a declaration of one name made every one of those closes
  // impossible, and those windows are exactly what a successor is for.
  //
  // AND A RECORD IS NOT PROOF (2026-09-25, t4 whole-branch review P1). The
  // first version kept every held name that LOOKED like one of ours, so a
  // tampered registry widened the executor's declaration and a `kill-window`
  // could be aimed at another session. A candidate now has to be vouched for by
  // the session itself: its `@rg_scope_owner` marker must name the id its own
  // name derives from.
  const scope = fakeScope();
  const otherId = "019fbb1d-9e78-7ebf-88bf-00000000ffee";
  const other = deriveSessionName("/repo", otherId)!;
  const server = fakeServer();
  server.sessions.set(other, otherId);
  const probe = createOwnershipProbe(scope, server.run);

  assert.deepEqual(addressableSessions(scope, [], probe), [NAME], "just my own, when I hold nothing else");
  assert.deepEqual(addressableSessions(scope, [other], probe), [NAME, other],
    "…plus a session whose marker says the name is its own");
  assert.deepEqual(addressableSessions(scope, [NAME, other, NAME], probe), [NAME, other], "deduplicated");

  // THE LIST CANNOT WIDEN THROUGH A REGISTRY. Three ways a row fails now:
  //  - not a name this module could have derived (a user's own session, junk);
  assert.deepEqual(addressableSessions(scope, ["my-work", "lab", "", undefined], probe), [NAME]);
  //  - a name that looks right but that NO session on the server carries;
  const absent = deriveSessionName("/repo", "019fbb1d-9e78-7ebf-88bf-11111111aaaa")!;
  assert.deepEqual(addressableSessions(scope, [absent], probe), [NAME], "nothing on the server vouches for it");
  //  - and a session that exists and even carries a marker, whose marker names
  //    an id its own name does NOT derive from — the tampered-registry shape.
  const liar = deriveSessionName("/repo", "019fbb1d-9e78-7ebf-88bf-22222222bbbb")!;
  server.sessions.set(liar, "some-other-sessions-id");
  assert.deepEqual(addressableSessions(scope, [liar], probe), [NAME], "a name its own marker disagrees with is dropped");
});

test("a PROVEN name rides along without a marker read", () => {
  // The orphan sweep kills the dedicated session of a session that is GONE
  // (lib/session-orphan-sweep.ts): it reads the dead holder's own marker and
  // compares it with that holder's id BEFORE it gets here, so the name arrives
  // proven — a licence earn by READING, not a name a file mentioned.
  const scope = fakeScope();
  const deadId = "019fbb1d-9e78-7ebf-88bf-00000000dead";
  const dead = deriveSessionName("/repo", deadId)!;
  const alwaysNo = (): boolean => false;
  assert.deepEqual(addressableSessions(scope, [dead], alwaysNo), [NAME], "not a candidate without a proof");
  assert.deepEqual(addressableSessions(scope, [dead], alwaysNo, [dead]), [NAME, dead],
    "…and declarable the moment the caller proves it");
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
  const probe = createOwnershipProbe(scope, server.run);
  assert.deepEqual(addressableSessions(scope, [], probe), [NAME], "a tampered record adds nothing");
  assert.deepEqual(addressableSessions(scope, [victim], probe), [NAME],
    "and the name it points at is vouched for by nobody: its marker belongs to the victim's own id");

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
  assert.deepEqual(addressableSessions(scope, [], createOwnershipProbe(scope, server.run)), [],
    "nothing to declare without an identity");
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

test("a polluted session is healed before it is reused — and a heal that FAILS refuses the spawn", () => {
  // 1) HEALED, before the child opens, and only the gate's own namespace.
  const polluted = fakeServer({
    existing: { name: NAME, owner: SESSION_ID },
    env: { RG_WORKER_ID: "worker-5", PATH: "/usr/bin" },
  });
  const opened = openScopeWindow(polluted.run, fakeScope(), { cwd: "/repo", command: ["pi"] });
  assert.equal(opened.ok, true, opened.ok ? "" : opened.error);
  assert.equal(polluted.env.RG_WORKER_ID, undefined, "the gate's own variable is gone");
  assert.equal(polluted.env.PATH, "/usr/bin", "and nothing that is not ours is touched");
  const unsetAt = polluted.calls.findIndex((a) => a[0] === "set-environment");
  const windowAt = polluted.calls.findIndex((a) => a[0] === "new-window");
  assert.ok(unsetAt >= 0 && windowAt > unsetAt, "the clean-up precedes the child that would inherit it");

  // 3) A NAME THAT IS ODD BUT REAL IS STILL REMOVABLE (quality round P2, then
  // acceptance round P2): a strict identifier rule here would brick the session
  // — the key could never be cleared, and the fail-closed heal would then
  // refuse every later spawn. A SPACE counts as real: tmux accepts it and an
  // argv element carries it verbatim.
  const odd = fakeServer({
    existing: { name: NAME, owner: SESSION_ID },
    env: { "RG_A-B": "junk", "RG_A B": "junk" },
  });
  const oddOpened = openScopeWindow(odd.run, fakeScope(), { cwd: "/repo", command: ["pi"] });
  assert.equal(oddOpened.ok, true, oddOpened.ok ? "" : oddOpened.error);
  assert.equal(odd.env["RG_A-B"], undefined, "an odd-but-removable name does not brick the session");
  assert.equal(odd.env["RG_A B"], undefined, "and neither does one with a space in it");
  // What cannot ride an argv is still refused: a leading `-` would be read as a
  // flag by tmux, and a `=` in a name is really two arguments.
  assert.throws(() => buildUnsetSessionEnvArgv(NAME, "-g"), UnsafeTmuxCommand);
  assert.throws(() => buildUnsetSessionEnvArgv(NAME, "A=B"), UnsafeTmuxCommand);

  // 4) THE READ FAILS ⇒ the spawn is refused: an unknown is never acted on.
  const blindEnv = fakeServer({ existing: { name: NAME, owner: SESSION_ID }, envReadFails: true });
  const refused = openScopeWindow(blindEnv.run, fakeScope(), { cwd: "/repo", command: ["pi"] });
  assert.equal(refused.ok, false, "a child that might wear somebody else's identity is not worth the risk");
  if (!refused.ok) assert.match(refused.error, /读不到/);
  assert.equal(blindEnv.calls.some((a) => a[0] === "new-window"), false, "and no window is opened");

  // 5) TMUX REFUSES THE UNSET ⇒ refused, naming the variable that could not go.
  const stubborn = fakeServer({
    existing: { name: NAME, owner: SESSION_ID },
    env: { RG_JUDGE_ID: "reviewer-1" },
    envUnsetFails: true,
  });
  const refused2 = openScopeWindow(stubborn.run, fakeScope(), { cwd: "/repo", command: ["pi"] });
  assert.equal(refused2.ok, false);
  if (!refused2.ok) assert.match(refused2.error, /RG_JUDGE_ID/);

  // 6) …OR THROWS: same refusal, same naming — the failure direction is the point.
  const blowsUp = fakeServer({
    existing: { name: NAME, owner: SESSION_ID },
    env: { RG_JUDGE_ID: "reviewer-1" },
    envUnsetThrows: true,
  });
  const refused3 = openScopeWindow(blowsUp.run, fakeScope(), { cwd: "/repo", command: ["pi"] });
  assert.equal(refused3.ok, false);
  if (!refused3.ok) assert.match(refused3.error, /RG_JUDGE_ID/);
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

// ---------------------------------------------------------------------------
// the owner's liveness facts (what a crashed session's sweeper reads)
// ---------------------------------------------------------------------------

/** fakeServer, with the pid/pane options kept apart from the owner marker — and failable. */
function factsServer(opts: Parameters<typeof fakeServer>[0] & { factFails?: string } = {}) {
  const server = fakeServer(opts);
  const facts = new Map<string, string>();
  const run: TmuxRunner = (argv, env, declared) => {
    const option = argv.find((a) => a === SESSION_OWNER_PID_OPTION || a === SESSION_OWNER_PANE_OPTION || a === SESSION_PINNED_OPTION);
    if (argv[0] === "set" && option !== undefined) {
      server.calls.push([...argv]);
      if (opts.factFails === option) return { ok: false, stdout: "", stderr: "tmux refused the fact" };
      facts.set(`${argv[argv.indexOf("-t") + 1]} ${option}`, String(argv.at(-1)));
      return { ok: true, stdout: "", stderr: "" };
    }
    return server.run(argv, env, declared);
  };
  return { ...server, run, facts };
}

function liveScope(pid = 4242, pane: string | undefined = "%3"): FakeScope {
  return { ...fakeScope(), ownerProcess: () => ({ pid, pane }) };
}

test("a created session carries its owner's pid and pane, written after the marker", () => {
  const server = factsServer();
  const opened = openScopeWindow(server.run, liveScope(), { cwd: "/repo", command: ["pi"] });
  assert.equal(opened.ok, true);
  assert.equal(server.facts.get(`${NAME} ${SESSION_OWNER_PID_OPTION}`), "4242");
  assert.equal(server.facts.get(`${NAME} ${SESSION_OWNER_PANE_OPTION}`), "%3");
  const order = server.calls.filter((a) => a[0] === "set").map((a) => a[3]);
  assert.deepEqual(order, [SESSION_OWNER_OPTION, SESSION_OWNER_PID_OPTION, SESSION_OWNER_PANE_OPTION]);
});

test("a failed fact write on CREATION still spawns — the session is merely never swept", () => {
  const server = factsServer({ factFails: SESSION_OWNER_PID_OPTION });
  const opened = openScopeWindow(server.run, liveScope(), { cwd: "/repo", command: ["pi"] });
  assert.equal(opened.ok, true);
  assert.equal(server.sessions.has(NAME), true);
  assert.equal(server.facts.size, 0, "no pane without its pid: a lone stale-able fact is worse than none");
});

test("REUSE overwrites the facts an earlier process of this id left — and a failed overwrite refuses the spawn", () => {
  const server = factsServer({ existing: { name: NAME, owner: SESSION_ID } });
  server.facts.set(`${NAME} ${SESSION_OWNER_PID_OPTION}`, "1");
  const opened = openScopeWindow(server.run, liveScope(5151, "%9"), { cwd: "/repo", command: ["pi"] });
  assert.equal(opened.ok, true);
  assert.equal(server.facts.get(`${NAME} ${SESSION_OWNER_PID_OPTION}`), "5151");
  assert.equal(server.facts.get(`${NAME} ${SESSION_OWNER_PANE_OPTION}`), "%9");

  for (const failing of [SESSION_OWNER_PID_OPTION, SESSION_OWNER_PANE_OPTION]) {
    const stuck = factsServer({ existing: { name: NAME, owner: SESSION_ID }, factFails: failing });
    const refused = openScopeWindow(stuck.run, liveScope(), { cwd: "/repo", command: ["pi"] });
    assert.equal(refused.ok, false, `${failing} not refreshed ⇒ no window in a session a sweeper may read as dead`);
    if (!refused.ok) assert.match(refused.error, /refused the fact/);
    assert.equal(stuck.calls.some((a) => a[0] === "new-window"), false);
  }
});

test("a PIN rides with the window it protects: written on create and reuse, and a failed pin refuses the window", () => {
  const created = factsServer();
  assert.equal(openScopeWindow(created.run, liveScope(), { cwd: "/repo", command: ["pi"], pin: "orchestration-child" }).ok, true);
  assert.ok(created.calls.some((a) => a[0] === "set" && a[3] === SESSION_PINNED_OPTION && a[4] === "orchestration-child"));

  const reused = factsServer({ existing: { name: NAME, owner: SESSION_ID } });
  assert.equal(openScopeWindow(reused.run, liveScope(), { cwd: "/repo", command: ["pi"], pin: "orchestration-child" }).ok, true);
  assert.ok(reused.calls.some((a) => a[0] === "set" && a[3] === SESSION_PINNED_OPTION));

  const failing = factsServer({ factFails: SESSION_PINNED_OPTION });
  const refused = openScopeWindow(failing.run, liveScope(), { cwd: "/repo", command: ["pi"], pin: "orchestration-child" });
  assert.equal(refused.ok, false);
  assert.equal(failing.sessions.has(NAME), false, "the unpinned session is reclaimed on the spot");
});

test("pinOwnSession pins only a session that is provably mine, and is a no-op when there is none", () => {
  const none = factsServer();
  assert.deepEqual(pinOwnSession(none.run, fakeScope(), "handed-off"), { ok: true });
  assert.equal(none.calls.some((a) => a[0] === "set"), false);

  const mine = factsServer({ existing: { name: NAME, owner: SESSION_ID } });
  assert.deepEqual(pinOwnSession(mine.run, fakeScope(), "handed-off"), { ok: true });
  assert.equal(mine.facts.get(`${NAME} ${SESSION_PINNED_OPTION}`), "handed-off");

  const foreign = factsServer({ existing: { name: NAME, owner: SUCCESSOR_ID } });
  assert.equal(pinOwnSession(foreign.run, fakeScope(), "handed-off").ok, false);
  assert.equal(foreign.facts.size, 0);

  assert.equal(pinOwnSession(factsServer({ blind: true }).run, fakeScope(), "handed-off").ok, false);
  assert.equal(pinOwnSession(factsServer({ existing: { name: NAME, owner: SESSION_ID }, factFails: SESSION_PINNED_OPTION }).run, fakeScope(), "x").ok, false);
});

test("a name belongs to an owner only when that owner derives it — from any repo", () => {
  assert.equal(scopeNameOwnedBy(NAME, SESSION_ID), true);
  assert.equal(scopeNameOwnedBy(deriveSessionName("/elsewhere/Other.Repo", SESSION_ID)!, SESSION_ID), true);
  assert.equal(scopeNameOwnedBy(NAME, SUCCESSOR_ID), false);
  assert.equal(scopeNameOwnedBy(NAME, ""), false);
  assert.equal(scopeNameOwnedBy("work", SESSION_ID), false);
  // A slug cut to 24 characters right after a separator keeps that trailing `-`.
  const cut = deriveSessionName("/r/abcdefghijklmnopqrstuvw-xyz", SESSION_ID)!;
  assert.match(cut, /w--/);
  assert.equal(scopeNameOwnedBy(cut, SESSION_ID), true);
  // The readable shape (s1): the role rides in the middle, the tail still binds.
  assert.equal(scopeNameOwnedBy(deriveSessionName("/r/abcdefghijklmnopqrstuvwxyz", SESSION_ID, "orchestrator")!, SESSION_ID), true);
  assert.equal(scopeNameOwnedBy(deriveSessionName("/repo", SESSION_ID, "pm")!, SUCCESSOR_ID), false);
});

test("readable session names: rg-<repo>-<role>-<tail>, capped, still a legal own-session name", () => {
  assert.equal(deriveSessionName("/w/pi-review-gate", SESSION_ID, "pm"), "rg-pi-review-gate-pm-04b8a270ed");
  assert.equal(deriveSessionName("/w/pi-review-gate", SESSION_ID, "s1"), "rg-pi-review-gate-s1-04b8a270ed");
  assert.equal(deriveSessionName("/w/pi-review-gate", SESSION_ID, ""), "rg-pi-review-gate-04b8a270ed", "no role ⇒ the older shape");
  assert.equal(deriveSessionName("/w/r", SESSION_ID, "A.B:c#{x}"), "rg-r-a-b-c-x-04b8a270ed", "tmux separators never survive");
  const longest = deriveSessionName("/w/abcdefghijklmnopqrstuvwxyz", SESSION_ID, "abcdefghijklmnopq")!;
  assert.equal(isOwnSessionName(longest), true, longest);
});

test("sessionNameBelongsTo: this repo and this id, either shape — never another's", () => {
  assert.equal(sessionNameBelongsTo("/repo", SESSION_ID, NAME), true, "the older shape");
  assert.equal(sessionNameBelongsTo("/repo", SESSION_ID, deriveSessionName("/repo", SESSION_ID, "pm")!), true);
  assert.equal(sessionNameBelongsTo("/repo", SESSION_ID, deriveSessionName("/repo", SUCCESSOR_ID, "pm")!), false, "another tail");
  assert.equal(sessionNameBelongsTo("/repo", SESSION_ID, deriveSessionName("/other", SESSION_ID, "pm")!), false, "another repo");
  assert.equal(sessionNameBelongsTo("/repo", SESSION_ID, `rg-repo--${NAME.split("-").pop()}`), false, "an empty role");
});

test("a role change mid-session keeps the session the sidecar recorded; a foreign record is ignored", () => {
  let role = "self";
  const scope = fakeScope();
  scope.role = () => role;
  const server = fakeServer();
  const first = openScopeWindow(server.run, scope, { cwd: "/repo" });
  assert.equal(first.ok && first.sessionName, deriveSessionName("/repo", SESSION_ID, "self"));
  role = "pm"; // loop → project manager
  const second = openScopeWindow(server.run, scope, { cwd: "/repo" });
  assert.equal(second.ok && second.sessionName, deriveSessionName("/repo", SESSION_ID, "self"), "same session, no second one");
  assert.equal(server.sessions.size, 1);
  const closed = closeOwnSession(server.run, scope);
  assert.equal(closed.ok && closed.killed, true, "and it is still ours to close");

  // A record naming ANOTHER session's readable name is not ours to act on.
  const liar = fakeScope();
  liar.role = () => "pm";
  const foreign = deriveSessionName("/repo", SUCCESSOR_ID, "pm")!;
  liar.record = { name: foreign, owner: SESSION_ID, createdAt: "x" };
  const other = fakeServer({ existing: { name: foreign, owner: SESSION_ID } });
  const refused = closeOwnSession(other.run, liar);
  assert.equal(refused.ok && refused.killed, false);
  assert.equal(other.sessions.has(foreign), true);
});

test("an old-name session created by the previous build is still recognised and closed by its owner", () => {
  const scope = fakeScope();
  scope.role = () => "pm";
  scope.record = { name: NAME, owner: SESSION_ID, createdAt: "x" };
  const server = fakeServer({ existing: { name: NAME, owner: SESSION_ID } });
  const reused = openScopeWindow(server.run, scope, { cwd: "/repo" });
  assert.equal(reused.ok && reused.sessionName, NAME, "reused, not orphaned beside a new one");
  const probe = createOwnershipProbe(scope, server.run);
  assert.equal(probe(NAME), true);
});
