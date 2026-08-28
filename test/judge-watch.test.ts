/**
 * Judge-child watcher registry (lib/judge-watch.ts) — the completion
 * wake-up lifecycle behind review_spawn / review_watch, tested with fake
 * wait handles so the re-arm / shutdown race (round-16 Nit) is pinned
 * without a tmux server or a pi runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWatchRegistry, type WatchWaiter } from "../lib/judge-watch.ts";

interface FakeWaitResult {
  calls: Array<{ channel: string; cancelled: boolean }>;
  /** Resolve the n-th wait's promise with the given signalled value. */
  resolve(index: number, signalled: boolean): void;
  /** The waiter function handed to createWatchRegistry. */
  wait: WatchWaiter;
  /** Drain the microtask queue so .then callbacks run. */
  flush(): Promise<void>;
}

function fakeWait(): FakeWaitResult {
  const calls: Array<{ channel: string; cancelled: boolean }> = [];
  const resolvers: Array<(v: boolean) => void> = [];
  const wait: WatchWaiter = (channel) => {
    const entry = { channel, cancelled: false };
    calls.push(entry);
    let resolve!: (v: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    resolvers.push(resolve);
    return {
      promise,
      cancel: () => {
        entry.cancelled = true;
        resolve(false);
      },
    };
  };
  return {
    calls,
    resolve: (index, signalled) => resolvers[index]?.(signalled),
    wait,
    flush: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("register: one listener per channel, a re-registration cancels the old handle", () => {
  const f = fakeWait();
  const registry = createWatchRegistry(f.wait, () => {});
  registry.register("rg-x-done", "x");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.channel, "rg-x-done");
  // A DIFFERENT label replaces the handle (manual review_watch).
  registry.register("rg-x-done", "custom");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.cancelled, true, "the replaced handle must be cancelled");
});

test("P0 round-17: re-registering the SAME channel+label is idempotent (no leaked waiters)", () => {
  // session_start re-registers the cross-session attention channel on every
  // session; without idempotency each call spawned another `tmux wait-for`
  // that never ends — measured: 30 leaked children kept test processes alive
  // in uv__io_poll and precommit never returned.
  const f = fakeWait();
  const registry = createWatchRegistry(f.wait, () => {});
  for (let i = 0; i < 5; i++) registry.register("rg-user-attention", "跨会话用户注意");
  assert.equal(f.calls.length, 1, "only the FIRST registration may spawn a waiter");
  assert.equal(f.calls[0]!.cancelled, false, "the live handle is never cancelled by a no-op re-register");
  assert.equal(registry.active.size, 1);
});

test("signal: wakes the session and RE-ARMS for the next round on the same channel", async () => {
  const f = fakeWait();
  const wakes: Array<[string, string]> = [];
  const registry = createWatchRegistry(f.wait, (label, channel) => wakes.push([label, channel]));
  registry.register("rg-x-done", "x");
  f.resolve(0, true);
  await f.flush();
  assert.deepEqual(wakes, [["x", "rg-x-done"]]);
  assert.equal(f.calls.length, 2, "the listener must re-arm itself (round-14 P1)");
  assert.equal(f.calls[1]!.cancelled, false);
});

test("signal without signalled=true (cancel) does not wake", async () => {
  const f = fakeWait();
  const wakes: Array<[string, string]> = [];
  const registry = createWatchRegistry(f.wait, (label, channel) => wakes.push([label, channel]));
  registry.register("rg-x-done", "x");
  f.resolve(0, false);
  await f.flush();
  assert.deepEqual(wakes, []);
  assert.equal(f.calls.length, 1, "a cancelled wait must not re-arm");
});

test("shutdown: cancels every handle, clears the registry, blocks further registers", async () => {
  const f = fakeWait();
  const registry = createWatchRegistry(f.wait, () => {});
  registry.register("rg-x-done", "x");
  registry.shutdown();
  assert.equal(f.calls[0]!.cancelled, true);
  assert.equal(registry.active.size, 0);
  registry.register("rg-y-done", "y");
  assert.equal(f.calls.length, 1, "register must be a no-op after shutdown");
});

test("round-16 Nit race: a signal in flight during shutdown must NOT re-arm an orphan listener", async () => {
  const f = fakeWait();
  const wakes: Array<[string, string]> = [];
  const registry = createWatchRegistry(f.wait, (label, channel) => wakes.push([label, channel]));
  registry.register("rg-x-done", "x");
  // Signal resolves (the .then callback is now queued as a microtask)…
  f.resolve(0, true);
  // …then session_shutdown clears the registry before the callback runs.
  registry.shutdown();
  await f.flush();
  assert.deepEqual(wakes, [["x", "rg-x-done"]], "the wake still fires once");
  assert.equal(f.calls.length, 1, "no orphan re-arm may happen for the torn-down session");
});

test("reset: a new session may register watchers again", () => {
  const f = fakeWait();
  const registry = createWatchRegistry(f.wait, () => {});
  registry.shutdown();
  registry.register("rg-x-done", "x");
  assert.equal(f.calls.length, 0);
  registry.reset();
  registry.register("rg-x-done", "x");
  assert.equal(f.calls.length, 1);
});

test("manual replace: an agent-side review_watch keeps its own label until the next signal", async () => {
  const f = fakeWait();
  const wakes: Array<[string, string]> = [];
  const registry = createWatchRegistry(f.wait, (label, channel) => wakes.push([label, channel]));
  registry.register("rg-x-done", "auto");
  registry.register("rg-x-done", "custom");
  f.resolve(1, true);
  await f.flush();
  assert.deepEqual(wakes, [["custom", "rg-x-done"]], "only the replacement handle may wake");
  // calls[0] was cancelled by the replacement (resolve(false) → its .then
  // must neither wake nor re-arm); calls[1] is the replacement, and the
  // round-14 re-arm after its signal is calls[2].
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0]!.cancelled, true);
  assert.equal(f.calls[2]!.cancelled, false, "the replacement handle re-arms for the next round");
});

test("unregister: drops ONE channel (cancel + forget) without touching the others", async () => {
  // Round-17: a reused judge pane is rebound to the round's own channels, so
  // the previous round's listener must be dropped — a lingering `tmux wait-for`
  // would otherwise wake the session for a round that no longer exists.
  const wakes: Array<[string, string]> = [];
  const f = fakeWait();
  const registry = createWatchRegistry(f.wait, (label, channel) => { wakes.push([label, channel]); });
  registry.register("rg-old-done", "old");
  registry.register("rg-new-done", "new");
  registry.unregister("rg-old-done");
  assert.equal(f.calls[0]!.cancelled, true, "the dropped channel's handle is cancelled");
  assert.equal(registry.active.has("rg-old-done"), false, "and forgotten");
  assert.equal(registry.active.has("rg-new-done"), true, "the other channel survives");
  await f.flush();
  assert.deepEqual(wakes, [], "a cancelled handle wakes nobody and never re-arms");
  assert.equal(f.calls.length, 2, "no re-arm for the dropped channel");
  // A dropped channel can be registered again (a later round may reuse it).
  registry.register("rg-old-done", "old");
  assert.equal(f.calls.length, 3);
});
