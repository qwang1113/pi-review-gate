/**
 * The SSE hub, the notification ledger and the watcher (lib/daemon/events.ts).
 *
 * The rules under test are the ones two independent senders have to agree on:
 * a notification key built by the gate's own helpers, a claim that only the
 * first caller wins, and a transition — never a state — that raises an event.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createNotificationStore, createSessionWatcher, createSseHub, notificationKindFor, type DaemonEvent } from "../lib/daemon/events.ts";
import { createSessionObserver, type DaemonSession, type SessionObserver } from "../lib/daemon/sessions.ts";
import { buildUserNotifyMessage, notifyKey } from "../lib/user-notify.ts";
import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";
import {
  agentHome,
  assistantRecord,
  paneLine,
  paneRunner,
  registryEntry,
  scratchHome,
  writeRegistry,
  writeTranscript,
} from "./daemon-helpers.ts";

test("the hub routes to the right subscribers and survives a throwing writer", () => {
  const hub = createSseHub();
  const all: DaemonEvent[] = [];
  const one: DaemonEvent[] = [];
  const off = hub.add((event) => all.push(event), null);
  hub.add((event) => one.push(event), "s1");
  hub.add(() => {
    throw new Error("the socket is gone");
  }, "s1");

  hub.emit({ event: "session", data: { kind: "updated" } }, "s1");
  assert.equal(all.length, 1, "a watcher of everything sees a session event");
  assert.equal(one.length, 1);
  hub.emit({ event: "session", data: { kind: "updated" } }, "s2");
  assert.equal(all.length, 2);
  assert.equal(one.length, 1, "a per-session subscriber does not see another session");

  assert.equal(hub.watched(), null, "one subscriber watching everything means 'tail them all'");
  off();
  hub.add(() => { /* keep the map non-empty */ }, "s1");
  assert.deepEqual([...(hub.watched() ?? [])], ["s1"]);
  assert.equal(hub.subscribers, 3);
});

test("the ledger lets exactly one caller claim a fact", () => {
  const home = scratchHome();
  let at = 1_700_000_000_000;
  const store = createNotificationStore(join(home, "notifications"), { now: () => at });
  const first = store.claim({ key: "k1", kind: "waiting-input", sessionId: "s1", title: "等你回答", body: "有人问你" });
  assert.equal(first.claimed, true);
  assert.equal(first.status, "claimed");
  assert.equal(first.count, 1);

  const second = store.claim({ key: "k1", kind: "waiting-input", sessionId: "s1", title: "等你回答", body: "有人问你" });
  assert.equal(second.claimed, false);
  assert.equal(second.status, "duplicate", "the machine-readable verdict, not just the boolean");
  assert.match(second.reason ?? "", /已发过/);
  assert.equal(second.firstSeenAt, first.firstSeenAt);

  assert.equal(store.claim({ key: "k2", kind: "done", sessionId: "s1", title: "任务完成", body: "好了" }).claimed, true);
  assert.equal(store.list().length, 2);

  // The dedup window is the gate's own (10 minutes): after it, the same fact
  // may be sent again.
  at += 11 * 60_000;
  assert.equal(store.claim({ key: "k1", kind: "waiting-input", sessionId: "s1", title: "等你回答", body: "有人问你" }).claimed, true);
  assert.equal(store.list().find((entry) => entry.key === "k1")?.count, 2);

  // THE CONTRACT'S PERMISSIONS (docs/daemon/api.md §8.3): the store's own
  // directories are 0700 — and RE-ASSERTED, so a ledger that has been around
  // since before the rule (or that the user loosened) is tightened on the next
  // claim rather than keeping its looser bits forever.
  const dir = join(home, "notifications");
  assert.equal(statSync(dir).mode & 0o777, 0o700, "the store dir is 0700");
  assert.equal(statSync(join(dir, "claims")).mode & 0o777, 0o700, "the claims dir is 0700");
  if (process.getuid?.() !== 0) {
    chmodSync(dir, 0o755);
    store.claim({ key: "k4", kind: "done", sessionId: "s1", title: "任务完成", body: "好了" });
    assert.equal(statSync(dir).mode & 0o777, 0o700, "a loosened dir is tightened again on the next claim");
  }
});

test("a ledger that cannot be written is fail-open: the caller still sends it", () => {
  const home = scratchHome();
  const dir = join(home, "notifications");
  mkdirSync(dir, { recursive: true });
  // THE LEDGER IS UNWRITABLE BECAUSE `claims` IS NOT A DIRECTORY: the store
  // re-asserts 0700 on its own directories on the way in (docs/daemon/api.md
  // §8.3), so “chmod it read-only” would be repaired by the very call under
  // test — a file in the directory's place cannot be.
  writeFileSync(join(dir, "claims"), "not a directory\n");
  const store = createNotificationStore(dir);
  const outcome = store.claim({ key: "k", kind: "done", sessionId: "s", title: "t", body: "b" });
  assert.equal(outcome.claimed, true, "a storage failure must never answer 'duplicate'");
  assert.equal(outcome.status, "claimed");
  assert.match(outcome.reason ?? "", /fail-open/);
});

test("claims for DIFFERENT keys never collide (one file per key, no shared document)", () => {
  const home = scratchHome();
  const dir = join(home, "notifications");
  const first = createNotificationStore(dir);
  const second = createNotificationStore(dir);
  assert.equal(first.claim({ key: "k1", kind: "done", sessionId: "s", title: "t1", body: "b1" }).claimed, true);
  // Two writers, two keys: neither can erase the other's claim (the earlier
  // whole-document design could), and both are visible to a fresh reader.
  assert.equal(second.claim({ key: "k2", kind: "done", sessionId: "s", title: "t2", body: "b2" }).claimed, true);
  assert.equal(first.claim({ key: "k1", kind: "done", sessionId: "s", title: "t1", body: "b1" }).status, "duplicate");
  assert.deepEqual(second.list().map((entry) => entry.key).sort(), ["k1", "k2"]);
});

test("the ledger is a directory: a second store sees the first one's claims", () => {
  const home = scratchHome();
  const dir = join(home, "notifications");
  const first = createNotificationStore(dir);
  assert.equal(first.claim({ key: "shared", kind: "done", sessionId: "s", title: "t", body: "b" }).claimed, true);
  const second = createNotificationStore(dir);
  assert.equal(second.claim({ key: "shared", kind: "done", sessionId: "s", title: "t", body: "b" }).claimed, false);
  assert.equal(second.list().length, 1);
});

test("an unreadable ledger reads as empty (one extra banner, never silence)", () => {
  const home = scratchHome();
  const dir = join(home, "notifications");
  mkdirSync(join(dir, "claims"), { recursive: true });
  writeFileSync(join(dir, "claims", "garbage.json"), "{ truncated");
  const store = createNotificationStore(dir);
  assert.equal(store.claim({ key: "k", kind: "done", sessionId: "s", title: "t", body: "b" }).claimed, true);
  assert.equal(store.list().length, 1, "the unreadable file is one missing row, not a failed read");
});

test("notificationKindFor names only the two transitions that are news", () => {
  assert.equal(notificationKindFor("waiting-input"), "needs-user");
  assert.equal(notificationKindFor("done"), "finished");
  assert.equal(notificationKindFor("working"), undefined);
  assert.equal(notificationKindFor("idle"), undefined);
  assert.equal(notificationKindFor("stalled"), undefined);
});

test("the watcher raises session, output and notification events on transitions", async () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "t1-work", sessionId: "abc123", repo: "/Users/me/project", cwd: "/Users/me/project", mode: "loop" }));
  writeTranscript(home, { sessionId: "abc123", cwd: "/Users/me/project", records: [] });

  let state = "working";
  // A clock that MOVES: the observer serves one collection per second (the
  // watcher's own cadence) and answering the same collection twice would make
  // this test pass without ever looking at the new state word.
  let clock = Date.now();
  const now = (): number => (clock += 2_000);
  // The pane list is read through the observer's runner, so the state word is
  // swapped by changing what that runner reports.
  const runner: TmuxRunner = (argv) =>
    argv[0] === "list-panes"
      ? {
          ok: true,
          stdout: `${paneLine({ sid: "abc123", repo: "/Users/me/project", kind: "loop", state, stateAt: String(Math.floor(Date.now() / 1000)) })}\n`,
          stderr: "",
        }
      : { ok: false, stdout: "", stderr: "unexpected" };
  const observer = createSessionObserver({ userHome: home, runTmux: runner, now });

  const events: DaemonEvent[] = [];
  const hub = createSseHub();
  hub.add((event) => events.push(event), null);
  const watcher = createSessionWatcher({ observer, hub, intervalMs: 60_000, now });

  watcher.tick();
  assert.ok(events.some((event) => event.event === "session" && (event.data as { kind: string }).kind === "added"));

  state = "waiting-input";
  watcher.tick();
  const notification = events.find((event) => event.event === "notification");
  assert.ok(notification, "entering waiting-input is news");
  const payload = notification!.data as { kind: string; key: string; title: string; body: string; sessionId: string };
  assert.equal(payload.kind, "waiting-input");
  assert.equal(payload.sessionId, "abc123");
  const expected = buildUserNotifyMessage({ kind: "needs-user", repoName: "project", detail: payload.body });
  assert.equal(payload.key, notifyKey(expected.title, expected.body), "the key is the gate's own key for the same banner");
  assert.equal(payload.title, expected.title);

  // The same state on the next tick is NOT a second notification.
  const before = events.filter((event) => event.event === "notification").length;
  watcher.tick();
  assert.equal(events.filter((event) => event.event === "notification").length, before);

  state = "done";
  watcher.tick();
  const done = events.filter((event) => event.event === "notification").pop()!;
  assert.equal((done.data as { kind: string }).kind, "done");
  watcher.stop();
});

test("a child session's transition is not raised as a notification (its manager is)", async () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({
    name: "t1-child",
    sessionId: "child-1",
    repo: "/repo",
    cwd: "/repo",
    mode: "loop",
  }));
  let state = "working";
  let clock = Date.now();
  const now = (): number => (clock += 2_000);
  const runner: TmuxRunner = (argv) =>
    argv[0] === "list-panes"
      ? {
          ok: true,
          stdout: `${paneLine({ sid: "child-1", repo: "/repo", kind: "child", state, stateAt: String(Math.floor(Date.now() / 1000)) })}\n`,
          stderr: "",
        }
      : { ok: false, stdout: "", stderr: "unexpected" };
  const observer = createSessionObserver({ userHome: home, runTmux: runner, now });
  const events: DaemonEvent[] = [];
  const hub = createSseHub();
  hub.add((event) => events.push(event), null);
  const watcher = createSessionWatcher({ observer, hub, intervalMs: 60_000, now });
  watcher.tick();
  state = "waiting-input";
  watcher.tick();
  // PROOF the new state was seen: the watcher reported the change as a session
  // update, and only the notification was withheld.
  assert.ok(events.some((event) => event.event === "session" && (event.data as { kind: string }).kind === "updated"));
  assert.equal(events.filter((event) => event.event === "notification").length, 0, "a child asks its manager, not the human");
  watcher.tick();
  watcher.stop();
});

/** One session as the observer would report it — shared by the two liveness tests. */
function daemonSession(over: Partial<DaemonSession> = {}): DaemonSession {
  return {
    sessionId: "s-1",
    name: "t1-work",
    kind: "loop",
    repo: "/Users/me/project",
    cwd: "/Users/me/project",
    branch: null,
    mode: "loop",
    state: "working",
    stateAt: null,
    stateSource: "pane",
    alive: true,
    tmux: null,
    pid: null,
    transcript: null,
    lastActivityAt: null,
    rounds: { sent: 0, recorded: 0, lastVerdict: null },
    completedAt: null,
    gateStateFound: false,
    unmet: [],
    registeredAt: null,
    heartbeatAt: null,
    ...over,
  };
}

/** A watcher over a session list the test replaces between ticks. */
function watcherOver(live: () => DaemonSession[]): { tick: () => void; stop: () => void; events: DaemonEvent[] } {
  const events: DaemonEvent[] = [];
  const hub = createSseHub();
  hub.add((event) => events.push(event), null);
  const observer = {
    collect: () => ({ now: new Date().toISOString(), tmuxReadable: true, sessions: live(), problems: [] }),
    transcriptFor: () => undefined,
    outputFor: () => [],
  };
  const watcher = createSessionWatcher({ observer, hub, intervalMs: 60_000 });
  return { tick: () => watcher.tick(), stop: () => watcher.stop(), events };
}

test("a session that disappears notifies — but only when the gate would have (same predicate)", () => {
  for (const [kind, expected] of [["loop", 1], ["child", 0]] as const) {
    let live: DaemonSession[] = [daemonSession({ kind })];
    const watcher = watcherOver(() => live);
    watcher.tick();
    live = [];
    watcher.tick();
    const notifications = watcher.events.filter((event) => event.event === "notification");
    assert.equal(notifications.length, expected, `${kind} session: ${expected} notification(s)`);
    if (expected > 0) {
      assert.equal((notifications[0]!.data as { kind: string }).kind, "exited");
    }
    watcher.stop();
  }
});

test("a session that already finished is not reported as 异常结束 when it goes away (round-2 P1)", () => {
  // THE OTHER HALF OF THE SAME FIX (quality round 2, 2026-10-01). `done` is a
  // PANE word and the pane is what disappears first: the moment it is gone the
  // word degrades to the registry's coarse `idle` (extensions/review-gate.ts
  // writes only idle/working), while liveness flips 180 s later. Reading the
  // death tick's own word therefore called a normally finished session
  // "异常结束" — the one event the contract excludes (docs/daemon/api.md §8.2),
  // and the exact shape of the round-1 fix's own regression.
  const steps = [
    daemonSession({ state: "done", stateSource: "pane" }),
    daemonSession({ state: "idle", stateSource: "registry" }),
  ];
  // (a) it dies in place; (b) it is swept out of the list.
  let live: DaemonSession[] = [steps[0]!];
  const inPlace = watcherOver(() => live);
  inPlace.tick();
  live = [steps[1]!];
  inPlace.tick();
  live = [daemonSession({ state: "idle", stateSource: "registry", alive: false })];
  inPlace.tick();
  assert.equal(
    inPlace.events.filter((event) => event.event === "notification").length,
    0,
    "a finished session that is exited later is not a crash",
  );
  inPlace.stop();

  live = [steps[0]!];
  const removed = watcherOver(() => live);
  removed.tick();
  live = [steps[1]!];
  removed.tick();
  live = [];
  removed.tick();
  assert.equal(
    removed.events.filter((event) => event.event === "notification").length,
    0,
    "…and neither is one that leaves the list after finishing",
  );
  removed.stop();
});

test("a session that dies IN PLACE notifies on the liveness flip alone (review round 1 P1)", () => {
  // MEASURED (2026-10-01, quality round): the state word and liveness flip on
  // DIFFERENT polls. `working → idle` is not news, and the session's `alive`
  // only turns false on a LATER tick — a tick that carries NO state change.
  // With the `exited` branch nested under `previous.state !== session.state`,
  // the frozen contract's own event (docs/daemon/api.md §8.2) was unreachable
  // on this path: the panel was never told a session had died in place.
  for (const [kind, expected] of [["loop", 1], ["child", 0]] as const) {
    let live: DaemonSession[] = [daemonSession({ kind, state: "working" })];
    const watcher = watcherOver(() => live);
    watcher.tick();
    live = [daemonSession({ kind, state: "idle" })];
    watcher.tick();
    live = [daemonSession({ kind, state: "idle", alive: false })];
    watcher.tick();
    const notifications = watcher.events.filter((event) => event.event === "notification");
    assert.equal(notifications.length, expected, `${kind} session: ${expected} notification(s)`);
    if (expected > 0) {
      assert.equal((notifications[0]!.data as { kind: string }).kind, "exited");
      assert.match(String((notifications[0]!.data as { body: string }).body), /异常结束/);
    }
    watcher.stop();
  }
});

test("the watcher does not read a transcript nobody is watching", async () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "t1-work", sessionId: "abc123", repo: "/repo", cwd: "/repo" }));
  writeTranscript(home, { sessionId: "abc123", cwd: "/repo", records: [] });
  const observer = createSessionObserver({ userHome: home, runTmux: paneRunner([]) });
  const events: DaemonEvent[] = [];
  const hub = createSseHub();
  hub.add((event) => events.push(event), "somebody-else");
  const watcher = createSessionWatcher({ observer, hub, intervalMs: 60_000 });
  watcher.tick();
  assert.equal(events.filter((event) => event.event === "output").length, 0);
  watcher.stop();
});

/**
 * A watcher over ONE synthetic session whose transcript appears only when the
 * returned `state.exists` is flipped — the panel's own moment, right after
 * `POST /api/tasks`.
 */
function watcherOverAPendingTranscript(options: { home: string; sessionId: string; now?: () => number }) {
  const state = { exists: false };
  const transcript = join(
    agentHome(options.home),
    "sessions",
    "--repo--",
    `2026-01-01T00-00-00-000Z_${options.sessionId}.jsonl`,
  );
  const session: DaemonSession = {
    sessionId: options.sessionId,
    name: null,
    kind: "loop",
    repo: "/repo",
    cwd: "/repo",
    branch: null,
    mode: "loop",
    state: "working",
    stateAt: null,
    stateSource: "registry",
    alive: true,
    tmux: null,
    pid: 4242,
    transcript: null,
    lastActivityAt: null,
    rounds: { sent: 0, recorded: 0, lastVerdict: null },
    completedAt: null,
    gateStateFound: false,
    unmet: [],
    registeredAt: null,
    heartbeatAt: null,
  };
  const observer = {
    collect: () => ({ now: new Date().toISOString(), tmuxReadable: true, problems: [], sessions: [session] }),
    transcriptFor: (id: string) => (id === options.sessionId && state.exists ? transcript : undefined),
    outputFor: () => [],
  } as unknown as SessionObserver;
  const hub = createSseHub();
  const events: DaemonEvent[] = [];
  hub.add((event) => events.push(event), options.sessionId);
  const watcher = createSessionWatcher({
    observer,
    hub,
    intervalMs: 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { state, events, watcher };
}

test("a subscription made before the transcript exists still receives its first output", () => {
  const home = scratchHome();
  const sessionId = "abc123";
  const { state, events, watcher } = watcherOverAPendingTranscript({ home, sessionId });

  // THE PANEL'S OWN MOMENT: a session started seconds ago has written nothing
  // yet (`POST /api/tasks` then straight into the detail page).
  watcher.prime(sessionId);
  watcher.tick();
  assert.equal(events.filter((event) => event.event === "output").length, 0, "no file yet, so nothing to send — yet");

  // Everything the file will hold was written AFTER the subscription.
  writeTranscript(home, { sessionId, cwd: "/repo", records: [assistantRecord("第一句话")] });
  state.exists = true;

  watcher.tick();
  const output = events.find((event) => event.event === "output");
  assert.ok(output, "the first output written after the subscription must reach it, not be bookmarked away");
  const entries = (output.data as { entries: { text: string }[] }).entries;
  assert.equal(entries[0]?.text, "第一句话");
  watcher.stop();
});

test("a bookmark for a transcript that never appears expires instead of accumulating", () => {
  const home = scratchHome();
  const sessionId = "never-writes";
  let clock = 1_700_000_000_000;
  const { state, events, watcher } = watcherOverAPendingTranscript({ home, sessionId, now: () => clock });

  // A stale deep link (or a session that disappeared before the subscription)
  // parks a bookmark nobody will ever use. The panel keeps one global
  // subscription alive, so "the subscriber is gone" cannot be observed — time
  // is the bound, and the trade-off is deliberate: past the TTL the transcript
  // is treated as history rather than as output written after the subscription.
  watcher.prime(sessionId);
  clock += 61_000;
  watcher.tick();

  writeTranscript(home, { sessionId, cwd: "/repo", records: [assistantRecord("迟到的话")] });
  state.exists = true;
  watcher.tick();
  assert.equal(events.filter((event) => event.event === "output").length, 0, "an expired bookmark does not replay history");
  watcher.stop();
});
