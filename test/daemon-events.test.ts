/**
 * The SSE hub, the notification ledger and the watcher (lib/daemon/events.ts).
 *
 * The rules under test are the ones two independent senders have to agree on:
 * a notification key built by the gate's own helpers, a claim that only the
 * first caller wins, and a transition — never a state — that raises an event.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createNotificationStore, createSessionWatcher, createSseHub, notificationKindFor, type DaemonEvent } from "../lib/daemon/events.ts";
import { createSessionObserver, type DaemonSession } from "../lib/daemon/sessions.ts";
import { buildUserNotifyMessage, notifyKey } from "../lib/user-notify.ts";
import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";
import { paneLine, paneRunner, registryEntry, scratchHome, writeRegistry, writeTranscript } from "./daemon-helpers.ts";

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
  const observer = createSessionObserver({ home, runTmux: runner, now });

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
  const observer = createSessionObserver({ home, runTmux: runner, now });
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

test("a session that disappears notifies — but only when the gate would have (same predicate)", () => {
  const session = (over: Partial<DaemonSession> = {}): DaemonSession => ({
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
    gateStateFound: false,
    unmet: [],
    registeredAt: null,
    heartbeatAt: null,
    ...over,
  });

  for (const [kind, expected] of [["loop", 1], ["child", 0]] as const) {
    let live: DaemonSession[] = [session({ kind })];
    const observer = {
      collect: () => ({ now: new Date().toISOString(), tmuxReadable: true, sessions: live, problems: [] }),
      transcriptFor: () => undefined,
      outputFor: () => [],
    };
    const events: DaemonEvent[] = [];
    const hub = createSseHub();
    hub.add((event) => events.push(event), null);
    const watcher = createSessionWatcher({ observer, hub, intervalMs: 60_000 });
    watcher.tick();
    live = [];
    watcher.tick();
    const notifications = events.filter((event) => event.event === "notification");
    assert.equal(notifications.length, expected, `${kind} session: ${expected} notification(s)`);
    if (expected > 0) {
      assert.equal((notifications[0]!.data as { kind: string }).kind, "exited");
    }
    watcher.stop();
  }
});

test("the watcher does not read a transcript nobody is watching", async () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "t1-work", sessionId: "abc123", repo: "/repo", cwd: "/repo" }));
  writeTranscript(home, { sessionId: "abc123", cwd: "/repo", records: [] });
  const observer = createSessionObserver({ home, runTmux: paneRunner([]) });
  const events: DaemonEvent[] = [];
  const hub = createSseHub();
  hub.add((event) => events.push(event), "somebody-else");
  const watcher = createSessionWatcher({ observer, hub, intervalMs: 60_000 });
  watcher.tick();
  assert.equal(events.filter((event) => event.event === "output").length, 0);
  watcher.stop();
});
