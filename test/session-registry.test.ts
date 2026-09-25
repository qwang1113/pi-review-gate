/**
 * THE GLOBAL SESSION REGISTRY — the rules that make a name mean something.
 *
 * The integration half (a real tmux server) proves tmux does what the argv say.
 * This file drives the registry against a fake file system and a fake tmux so
 * the states a real machine only reaches by accident can be asserted at all:
 * two sessions claiming one name at the same moment, a holder that died without
 * giving its name back, a registration file somebody hand-edited, tmux that
 * cannot be read at all.
 *
 * THE ONE RULE THEY ALL SHARE: a name is never taken away from a holder that
 * might still be alive, and an unknown reading is never acted on. A refused
 * name costs one question; a stolen one costs somebody's session.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimName,
  classifyEntry,
  findEntryBySessionId,
  isSessionName,
  listEntries,
  nodeRegistryIO,
  parseEntryText,
  parseRegistryEntry,
  releaseName,
  renewName,
  sessionEntryPath,
  sessionInboxPath,
  sessionInboxTakenPath,
  sessionNameProblem,
  SESSION_STALE_MS,
  type RegistryDeps,
  type RegistryIO,
  type SessionRegistryEntry,
} from "../lib/session-registry.ts";
// The sweep is the registry's other half in a module of its own: it acts on
// OTHER sessions' leftovers and its act is destructive, while the registry only
// ever reads one name.
import { sweepOrphans } from "../lib/session-orphan-sweep.ts";
import { SESSION_OWNER_OPTION } from "../lib/orchestrator-tmux.ts";

const ROOT = "/home/agent/.pi/agent/rg-sessions";
const MINE = "019fbb1d-9e78-7ebf-88bf-d104b8a270ed";
const THEIRS = "019fbb1d-9e78-7ebf-88bf-ffee00000011";
const NOW = Date.parse("2026-09-25T10:00:00.000Z");

/** A file system in a Map, with the three operations the claim protocol needs. */
function fakeIO(files: Map<string, string> = new Map()): RegistryIO & { files: Map<string, string> } {
  return {
    files,
    readText: (path) => files.get(path),
    writeText: (path, text) => {
      files.set(path, text);
      return true;
    },
    createExclusive: (path, text) => {
      if (files.has(path)) return false;
      files.set(path, text);
      return true;
    },
    rename: (from, to) => {
      const value = files.get(from);
      if (value === undefined || files.has(to)) return false;
      files.delete(from);
      files.set(to, value);
      return true;
    },
    remove: (path) => (files.delete(path), true),
    listFiles: () => [...files.keys()].map((path) => path.slice(path.lastIndexOf("/") + 1)),
  };
}

/** A tmux server that answers exactly the questions this module asks. */
function fakeTmux(opts: {
  panes?: string[];
  /** The server's session names — what tells "already gone" from "unreadable". */
  sessions?: string[];
  markers?: Record<string, string>;
  blind?: boolean;
  /** Only the marker READ fails — the pane list still answers. */
  markerUnreadable?: boolean;
  killFails?: boolean;
} = {}) {
  const calls: string[][] = [];
  const killed: string[] = [];
  const run = (argv: readonly string[]) => {
    calls.push([...argv]);
    if (opts.blind) return { ok: false, stdout: "", stderr: "no server" };
    if (argv[0] === "list-panes") return { ok: true, stdout: (opts.panes ?? []).join("\n"), stderr: "" };
    if (argv[0] === "list-sessions") return { ok: true, stdout: (opts.sessions ?? []).join("\n"), stderr: "" };
    if (argv[0] === "show-options") {
      if (opts.markerUnreadable) return { ok: false, stdout: "", stderr: "cannot read option" };
      const target = argv[argv.indexOf("-t") + 1];
      return { ok: true, stdout: (opts.markers ?? {})[target] ?? "", stderr: "" };
    }
    if (argv[0] === "kill-session") {
      if (opts.killFails) return { ok: false, stdout: "", stderr: "denied" };
      killed.push(argv[argv.indexOf("-t") + 1]);
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  return { run, calls, killed };
}

function deps(opts: {
  files?: Map<string, string>;
  tmux?: ReturnType<typeof fakeTmux>;
  alive?: (pid: number) => boolean;
} = {}): RegistryDeps & { io: ReturnType<typeof fakeIO>; tmux: ReturnType<typeof fakeTmux> } {
  const io = fakeIO(opts.files);
  const tmux = opts.tmux ?? fakeTmux();
  return {
    root: ROOT,
    io,
    tmux,
    runTmux: tmux.run,
    alive: opts.alive ?? (() => false),
    now: () => NOW,
  };
}

function entry(over: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    schema: 1,
    name: "t2-registry",
    sessionId: THEIRS,
    pid: 4242,
    repo: "/repo/pi-review-gate",
    cwd: "/repo/pi-review-gate",
    mode: "loop",
    state: "working",
    tmux: { session: "rg-pi-review-gate-ffee000000", window: "@7", pane: "%42" },
    registeredAt: new Date(NOW - 60_000).toISOString(),
    // STALE BY DEFAULT: most of these tests are about a holder that went away,
    // and the ones that mean "alive" say so explicitly.
    heartbeatAt: new Date(NOW - SESSION_STALE_MS - 60_000).toISOString(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// the name itself
// ---------------------------------------------------------------------------

test("the name rule is kebab-case with a length cap, and it rejects what would escape the directory", () => {
  assert.equal(sessionNameProblem("t2-registry"), undefined);
  assert.equal(isSessionName("a1"), true);
  assert.match(sessionNameProblem("T2") ?? "", /kebab-case/);
  assert.match(sessionNameProblem("t2_registry") ?? "", /kebab-case/);
  assert.match(sessionNameProblem("-t2") ?? "", /kebab-case/);
  assert.match(sessionNameProblem("t2-") ?? "", /kebab-case/);
  assert.match(sessionNameProblem("t2/../registry") ?? "", /kebab-case|最长/);
  assert.match(sessionNameProblem("a") ?? "", /最短/);
  assert.match(sessionNameProblem("x".repeat(33)) ?? "", /最长 32/);
  assert.match(sessionNameProblem("t2 registry") ?? "", /kebab-case/);
  assert.equal(isSessionName("x".repeat(32)), true);
});

test("a stored entry is read back exactly, and anything doubtful is unreadable rather than half-trusted", () => {
  const stored = entry({ scopeSession: "rg-pi-review-gate-ffee000000" });
  assert.deepEqual(parseEntryText(JSON.stringify(stored)), stored);
  assert.equal(parseEntryText("not json"), undefined);
  assert.equal(parseEntryText(undefined), undefined);
  assert.equal(parseRegistryEntry({ ...stored, name: "BAD NAME" }), undefined, "an escaping name is not an entry");
  assert.equal(parseRegistryEntry({ ...stored, sessionId: "" }), undefined);
  assert.equal(parseRegistryEntry({ ...stored, pid: 0 }), undefined);
  assert.equal(parseRegistryEntry({ ...stored, heartbeatAt: "" }), undefined);
  assert.equal(parseRegistryEntry({ ...stored, scopeSession: "not-a-gate-session" })?.scopeSession, undefined,
    "a scope session that could not have come from the gate is dropped, not trusted");
});

// ---------------------------------------------------------------------------
// liveness: three facts, and an unknown is never a death
// ---------------------------------------------------------------------------

test("liveness needs the heartbeat to be stale AND the pid and the pane to be gone", () => {
  const dead = deps({ tmux: fakeTmux({ panes: ["%99"] }) });
  assert.equal(classifyEntry(dead, entry()), "dead", "stale + no pane + no pid");

  assert.equal(classifyEntry(deps({ tmux: fakeTmux({ panes: ["%42"] }) }), entry()), "live",
    "the pane is still there — a stuck session keeps its name");
  assert.equal(classifyEntry(deps({ alive: () => true }), entry()), "live",
    "a process with that pid exists — not this module's business to guess otherwise");
  assert.equal(classifyEntry(deps(), entry({ heartbeatAt: new Date(NOW - 5_000).toISOString() })), "live",
    "a fresh heartbeat is enough on its own");
  assert.equal(classifyEntry(deps({ tmux: fakeTmux({ blind: true }) }), entry()), "unknown",
    "tmux unreadable ⇒ unknown, never dead");
  assert.equal(classifyEntry(deps(), entry({ heartbeatAt: "whenever" })), "unknown", "an unparsable stamp is unknown");
});

// ---------------------------------------------------------------------------
// claiming
// ---------------------------------------------------------------------------

test("a free name is claimed, and a second claim by the same session is a renewal", () => {
  const d = deps();
  const first = claimName(d, entry({ sessionId: MINE }));
  assert.deepEqual(first, { ok: true, outcome: "claimed", note: "名字 t2-registry 已登记" });
  const again = claimName(d, entry({ sessionId: MINE }));
  assert.equal(again.ok && again.outcome, "renewed");
  assert.equal(parseEntryText(d.io.files.get(sessionEntryPath(ROOT, "t2-registry")))?.sessionId, MINE);
});

test("a LIVE holder is refused, with the occupant named, and its file is left byte-for-byte alone", () => {
  const live = JSON.stringify(entry({ heartbeatAt: new Date(NOW).toISOString() }));
  const files = new Map([[sessionEntryPath(ROOT, "t2-registry"), live]]);
  const d = deps({ files });
  const result = claimName(d, entry({ sessionId: MINE }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /已被别的活会话占用/);
  assert.match(result.ok ? "" : result.error, /repo=\/repo\/pi-review-gate/);
  assert.match(result.ok ? "" : result.error, /状态=working/);
  assert.match(result.ok ? "" : result.error, /登记时间=/);
  assert.equal(files.get(sessionEntryPath(ROOT, "t2-registry")), live, "nothing was written over it");
});

test("an occupant that cannot be judged is refused too — fail-closed, never a takeover", () => {
  // STALE heartbeat + unreadable tmux: exactly the state where a guess would be
  // tempting and must not be made.
  const d = deps({ files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry())]]), tmux: fakeTmux({ blind: true }) });
  const result = claimName(d, entry({ sessionId: MINE }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /判不出来/);
  assert.match(result.ok ? "" : result.error, /不接管/);
});

test("a registration file that does not parse is an occupant, not a free name", () => {
  const d = deps({ files: new Map([[sessionEntryPath(ROOT, "t2-registry"), "{ broken"]]) });
  const result = claimName(d, entry({ sessionId: MINE }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /读不出来/);
  assert.equal(d.io.files.get(sessionEntryPath(ROOT, "t2-registry")), "{ broken", "the evidence survives the refusal");
});

test("a provably dead holder loses the name — and only that: the takeover is one atomic move", () => {
  const dead = entry();
  const d = deps({ files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(dead)]]), tmux: fakeTmux({ panes: [] }) });
  const claimant = entry({ sessionId: MINE, registeredAt: new Date(NOW).toISOString() });
  const result = claimName(d, claimant);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.outcome, "reclaimed");
  assert.match(result.ok ? result.note : "", new RegExp(THEIRS));
  const stored = parseEntryText(d.io.files.get(sessionEntryPath(ROOT, "t2-registry")));
  assert.equal(stored?.sessionId, MINE);
  assert.equal(stored?.registeredAt, claimant.registeredAt, "the file is the new holder's entry, stamped by it");
});

test("when another claimant won the takeover, this one is refused instead of overwriting the winner", () => {
  const io = fakeIO(new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry())]]));
  io.rename = () => false; // somebody else's rename landed first
  const d: RegistryDeps = { root: ROOT, io, runTmux: fakeTmux({ panes: [] }).run, alive: () => false, now: () => NOW };
  const result = claimName(d, entry({ sessionId: MINE }));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /另一个进程接管/);
});

// ---------------------------------------------------------------------------
// renewing and releasing
// ---------------------------------------------------------------------------

test("renewal refuses to take a name back, and says so", () => {
  const d = deps({ files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ sessionId: THEIRS }))]]) });
  const renewed = renewName(d, entry({ sessionId: MINE }));
  assert.equal(renewed.ok, false);
  assert.equal(renewed.ok === false && renewed.lost, true);
  assert.equal(parseEntryText(d.io.files.get(sessionEntryPath(ROOT, "t2-registry")))?.sessionId, THEIRS);

  const gone = renewName(deps(), entry({ sessionId: MINE }));
  assert.equal(gone.ok === false && gone.lost, true, "a swept registration is a lost name, not an error to retry");

  const mine = deps({ files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ sessionId: MINE }))]]) });
  const ok = renewName(mine, entry({ sessionId: MINE, heartbeatAt: new Date(NOW).toISOString() }));
  assert.equal(ok.ok, true);
  assert.equal(parseEntryText(mine.io.files.get(sessionEntryPath(ROOT, "t2-registry")))?.heartbeatAt, new Date(NOW).toISOString());
});

test("a release deletes only the release's own name, and a missing file is success", () => {
  const d = deps({ files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ sessionId: THEIRS }))]]) });
  const refused = releaseName(d, "t2-registry", MINE);
  assert.equal(refused.ok, false);
  assert.equal(d.io.files.has(sessionEntryPath(ROOT, "t2-registry")), true, "somebody else's name is not ours to delete");

  const mine = deps({ files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ sessionId: MINE }))]]) });
  assert.deepEqual(releaseName(mine, "t2-registry", MINE), { ok: true, released: true });
  assert.equal(mine.io.files.has(sessionEntryPath(ROOT, "t2-registry")), false);
  assert.deepEqual(releaseName(mine, "t2-registry", MINE), { ok: true, released: false }, "idempotent");
});

test("a release takes the name's inbox with it — the address is gone, so is its mail", () => {
  // 2026-09-25 (t3): a name's inbox belongs to that name. Releasing the name
  // without the inbox would leave mail nobody can read — and hand it to whoever
  // takes the same name next, which is somebody else's correspondence.
  const files = new Map([
    [sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ sessionId: MINE }))],
    [sessionInboxPath(ROOT, "t2-registry"), '{"kind":"session-message"}\n'],
    [sessionInboxTakenPath(ROOT, "t2-registry"), '{"kind":"session-message"}\n'],
    [`${sessionInboxPath(ROOT, "t2-registry")}.msg-1.payload`, "一大段正文"],
    // A DIFFERENT name's spilled body must survive both calls (the removal is by
    // this name's prefix, not by "anything that looks like mail").
    [`${sessionInboxPath(ROOT, "t9-pm")}.msg-2.payload`, "别人的正文"],
  ]);
  const d = deps({ files });
  assert.deepEqual(releaseName(d, "t2-registry", MINE), { ok: true, released: true });
  assert.equal(d.io.files.has(sessionInboxPath(ROOT, "t2-registry")), false, "the inbox goes with the name");
  assert.equal(d.io.files.has(sessionInboxTakenPath(ROOT, "t2-registry")), false, "and so does the parked copy");
  assert.equal(
    d.io.files.has(`${sessionInboxPath(ROOT, "t2-registry")}.msg-1.payload`),
    false,
    "and so does the spilled body — a side file is not a second inbox",
  );
  assert.equal(d.io.files.has(`${sessionInboxPath(ROOT, "t9-pm")}.msg-2.payload`), true, "not somebody else's");

  // A refused release is NOT a reason to destroy somebody else's mail.
  const other = new Map([
    [sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ sessionId: THEIRS }))],
    [sessionInboxPath(ROOT, "t2-registry"), '{"kind":"session-message"}\n'],
  ]);
  const refused = deps({ files: other });
  assert.equal(releaseName(refused, "t2-registry", MINE).ok, false);
  assert.equal(refused.io.files.has(sessionInboxPath(ROOT, "t2-registry")), true, "not ours to delete");
});

test("an entry is found by the session that owns it — that is how a restart keeps its name", () => {
  const d = deps({ files: new Map([
    [sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ sessionId: MINE }))],
    [sessionEntryPath(ROOT, "t1-topology"), JSON.stringify(entry({ name: "t1-topology", sessionId: THEIRS }))],
  ]) });
  assert.equal(findEntryBySessionId(d, MINE)?.name, "t2-registry");
  assert.equal(findEntryBySessionId(d, "nobody"), undefined);
  const listed = listEntries(d);
  assert.deepEqual(listed.entries.map((e) => e.name).sort(), ["t1-topology", "t2-registry"]);
  assert.deepEqual(listed.unreadable, []);
});

// ---------------------------------------------------------------------------
// the orphan sweep
// ---------------------------------------------------------------------------

test("the sweep reclaims a dead session's tmux session, registration and inbox — marker first", () => {
  const scope = "rg-pi-review-gate-ffee000000";
  const d = deps({
    files: new Map([
      [sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ scopeSession: scope }))],
      [sessionInboxPath(ROOT, "t2-registry"), "{\"from\":\"@other\"}\n"],
    ]),
    tmux: fakeTmux({ panes: [], sessions: [scope], markers: { [scope]: THEIRS } }),
  });
  const report = sweepOrphans(d, { sessionId: MINE });
  assert.deepEqual(report.reaped, [{ name: "t2-registry", sessionId: THEIRS, sessionKilled: true, inboxRemoved: true }]);
  assert.deepEqual(d.tmux.killed, [scope]);
  assert.equal(d.io.files.has(sessionEntryPath(ROOT, "t2-registry")), false);
  assert.equal(d.io.files.has(sessionInboxPath(ROOT, "t2-registry")), false);
  const markerReads = d.tmux.calls.filter((argv) => argv[0] === "show-options").map((argv) => argv.at(-1));
  assert.deepEqual(markerReads, [SESSION_OWNER_OPTION], "the marker is read before the kill");
});

test("a session wearing a name that is not the dead holder's is NOT killed — looking like ours is not being ours", () => {
  const scope = "rg-pi-review-gate-ffee000000";
  const d = deps({
    files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ scopeSession: scope }))]]),
    tmux: fakeTmux({ panes: [], markers: { [scope]: "someone-else" } }),
  });
  const report = sweepOrphans(d, {});
  assert.deepEqual(report.reaped, []);
  assert.deepEqual(d.tmux.killed, [], "nothing was killed");
  assert.match(report.kept[0]?.reason ?? "", /归属标记是 someone-else/);
  assert.equal(d.io.files.has(sessionEntryPath(ROOT, "t2-registry")), true,
    "a registration whose scope session could not be proven is left for a human, not deleted");
});

test("an unreadable marker, an unreadable tmux and an unreadable registration all stop the sweep", () => {
  const scope = "rg-pi-review-gate-ffee000000";
  const noMarker = deps({
    files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ scopeSession: scope }))]]),
    // The session IS there: the option read failed, which is not the same fact
    // as "it is gone", and only the server's own name list separates them.
    tmux: fakeTmux({ panes: [], sessions: [scope], markerUnreadable: true }),
  });
  const first = sweepOrphans(noMarker, {});
  assert.deepEqual(noMarker.tmux.killed, []);
  assert.match(first.kept[0]?.reason ?? "", /归属标记读不到/);
  assert.equal(noMarker.io.files.has(sessionEntryPath(ROOT, "t2-registry")), true, "the entry stays: nothing was proven");

  const blind = deps({
    files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ scopeSession: scope }))]]),
    tmux: fakeTmux({ blind: true }),
  });
  assert.deepEqual(sweepOrphans(blind, {}).reaped, []);
  assert.equal(blind.io.files.has(sessionEntryPath(ROOT, "t2-registry")), true, "unknown never deletes");

  const corrupt = deps({ files: new Map([[sessionEntryPath(ROOT, "t2-registry"), "{not json"]]) });
  const third = sweepOrphans(corrupt, {});
  assert.deepEqual(third.reaped, []);
  assert.match(third.notes.join(" "), /读不出来/);
});

test("a scope session that is already gone is cleaned up, not kept: there is nothing to kill", () => {
  const scope = "rg-pi-review-gate-ffee000000";
  const d = deps({
    files: new Map([
      [sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ scopeSession: scope }))],
      [sessionInboxPath(ROOT, "t2-registry"), "{}\n"],
    ]),
    // Readable server, and that name is not on it: the session was reclaimed
    // (or never created). The registration and the inbox are still this name's.
    // The marker read fails exactly as it does for a session tmux cannot find.
    tmux: fakeTmux({ panes: [], sessions: ["rg-someone-else-0000000000"], markerUnreadable: true }),
  });
  const report = sweepOrphans(d, {});
  assert.deepEqual(report.reaped, [{ name: "t2-registry", sessionId: THEIRS, sessionKilled: false, inboxRemoved: true }]);
  assert.deepEqual(d.tmux.killed, []);
  assert.equal(d.io.files.has(sessionEntryPath(ROOT, "t2-registry")), false);
});

test("the sweep leaves live sessions, its own registration and a failed kill alone, and reports each", () => {
  const mine = entry({ name: "mine", sessionId: MINE, scopeSession: "rg-pi-review-gate-0000000000" });
  const live = entry({ name: "alive", tmux: { session: "s", window: "@7", pane: "%42" } });
  const killFails = entry({ name: "stubborn", scopeSession: "rg-pi-review-gate-ffffffffff", tmux: { session: "s", window: "@9", pane: "%43" } });
  const d = deps({
    files: new Map([
      [sessionEntryPath(ROOT, "mine"), JSON.stringify(mine)],
      [sessionEntryPath(ROOT, "alive"), JSON.stringify(live)],
      [sessionEntryPath(ROOT, "stubborn"), JSON.stringify(killFails)],
    ]),
    tmux: fakeTmux({ panes: ["%42"], markers: { "rg-pi-review-gate-ffffffffff": THEIRS }, killFails: true }),
  });
  const report = sweepOrphans(d, { sessionId: MINE });
  assert.equal(report.examined, 3);
  assert.deepEqual(report.reaped, []);
  assert.match(report.kept.find((k) => k.name === "mine")?.reason ?? "", /本会话自己的登记/);
  assert.match(report.kept.find((k) => k.name === "alive")?.reason ?? "", /还活着/);
  assert.match(report.kept.find((k) => k.name === "stubborn")?.reason ?? "", /回收 .* 失败/);
});

test("a registration taken over during the sweep is put back, not deleted", () => {
  const d = deps({
    files: new Map([[sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry())]]),
    tmux: fakeTmux({ panes: [] }),
  });
  // Simulate the hand-over: while the sweep classifies, the file is replaced by
  // a LIVE registration for another session — the sweep must notice.
  const originalRename = d.io.rename;
  d.io.rename = (from, to) => {
    if (from === sessionEntryPath(ROOT, "t2-registry")) {
      d.io.files.set(from, JSON.stringify(entry({ sessionId: MINE, heartbeatAt: new Date(NOW).toISOString() })));
    }
    return originalRename(from, to);
  };
  const report = sweepOrphans(d, {});
  assert.deepEqual(report.reaped, []);
  assert.match(report.kept[0]?.reason ?? "", /重新登记/);
  assert.equal(d.io.files.has(sessionEntryPath(ROOT, "t2-registry")), true, "the new holder keeps its registration");
});

test("the REAL io creates the registry directory on the first claim — an absent directory is not an occupant", () => {
  // MEASURED DEFECT (2026-09-25, found by a live worker session):
  // `O_EXCL` create fails with ENOENT when `rg-sessions/` does not exist yet,
  // and "false" was read as "somebody else created it" — so the FIRST EVER
  // `name_session` on a machine answered "已被别的活会话占用" about a file that
  // did not exist. The unit tests above inject an IO fake that has no notion of
  // directories, which is exactly why the real one has to be exercised.
  const base = mkdtempSync(join(tmpdir(), "rg-registry-real-"));
  try {
    const root = join(base, "nested", "rg-sessions");
    const d = { root, io: nodeRegistryIO(root), runTmux: fakeTmux().run, alive: () => false, now: () => NOW };
    const claim = claimName(d, entry({ sessionId: MINE }));
    assert.equal(claim.ok, true, claim.ok ? "" : claim.error);
    assert.equal(claim.ok && claim.outcome, "claimed");
    assert.equal(parseEntryText(readFileSync(sessionEntryPath(root, "t2-registry"), "utf8"))?.sessionId, MINE);
    // …and a second session still gets the live-occupant refusal, not a crash.
    const other = claimName({ ...d, now: () => NOW }, entry({ sessionId: MINE }));
    assert.equal(other.ok, true);
    assert.equal(other.ok && other.outcome, "renewed");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("losing the exclusive-create race RE-READS the winner instead of answering about a file it never opened", () => {
  // REVIEWER P1 (round 1). `existingText` is `undefined` in exactly the branch
  // where the create lost the race (the winner wrote between our read and our
  // create), and the code used to decide against that stale `undefined` — so a
  // name that was created a microsecond ago was reported as "its registration
  // file cannot be read", refusing a claim the winner's entry may well allow.
  const winner = JSON.stringify(entry({ sessionId: THEIRS, heartbeatAt: new Date(NOW).toISOString() }));
  const raceIO = () => {
    const files = new Map<string, string>();
    const io = fakeIO(files);
    const create = io.createExclusive;
    io.createExclusive = (path, text) => {
      files.set(path, winner); // the winner lands first…
      return create(path, text); // …so this create reports "exists", not "created"
    };
    return { io, files };
  };

  const live = raceIO();
  const refused = claimName({ root: ROOT, io: live.io, runTmux: fakeTmux({ panes: [] }).run, alive: () => false, now: () => NOW }, entry({ sessionId: MINE }));
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /已被别的活会话占用/, "the WINNER is what the claim is decided against");
  assert.doesNotMatch(refused.ok ? "" : refused.error, /读不出来/);
  assert.equal(live.files.get(sessionEntryPath(ROOT, "t2-registry")), winner, "and the winner's bytes are untouched");

  // The winner may also be US (a previous process of this same session).
  const mine = raceIO();
  mine.files.set(sessionEntryPath(ROOT, "t2-registry"), JSON.stringify(entry({ sessionId: MINE })));
  mine.io.createExclusive = () => false;
  const renewed = claimName({ root: ROOT, io: mine.io, runTmux: fakeTmux().run, alive: () => false, now: () => NOW }, entry({ sessionId: MINE }));
  assert.equal(renewed.ok && renewed.outcome, "renewed", "losing to ourselves is a renewal, not a refusal");

  // And when the re-read really cannot read anything, the refusal says so.
  const blind = fakeIO(new Map());
  blind.readText = () => undefined;
  blind.createExclusive = () => false;
  const unreachable = claimName({ root: ROOT, io: blind, runTmux: fakeTmux().run, alive: () => false, now: () => NOW }, entry({ sessionId: MINE }));
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.ok ? "" : unreachable.error, /占不下来：登记文件读不出来/);
});

test("stale is six missed beats, not one: a long-blocked session is not a dead one", () => {
  assert.equal(SESSION_STALE_MS, 180_000);
  const d = deps({ tmux: fakeTmux({ panes: [] }) });
  assert.equal(classifyEntry(d, entry({ heartbeatAt: new Date(NOW - SESSION_STALE_MS + 1).toISOString() })), "live");
  assert.equal(classifyEntry(d, entry({ heartbeatAt: new Date(NOW - SESSION_STALE_MS - 1).toISOString() })), "dead");
});
