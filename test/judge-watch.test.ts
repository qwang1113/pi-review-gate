/**
 * Judge-child watcher registry (lib/judge-watch.ts) — the completion
 * wake-up lifecycle behind review_spawn / review_watch, tested with fake
 * children so the exit-event semantics and the shutdown race (round-16 Nit)
 * are pinned without a pi runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProcessWatchRegistry,
  rememberChildProcess,
  forgetChildProcess,
  waitForProcessExit,
  type ProcessWaiter,
} from "../lib/judge-watch.ts";

/** A fake child that records exit listeners and can be exited on demand. */
function fakeChild(initialExitCode: number | null = null): {
  exitCode: number | null;
  listeners: Array<() => void>;
  on: (ev: string, fn: () => void) => unknown;
  exit: (code: number) => void;
} {
  const listeners: Array<() => void> = [];
  const c = {
    exitCode: initialExitCode,
    listeners,
    on: (ev: string, fn: () => void) => {
      if (ev === "exit") listeners.push(fn);
      return undefined;
    },
    exit: (code: number) => {
      c.exitCode = code;
      for (const fn of [...listeners]) fn();
    },
  };
  return c;
}

/** A waiter that resolves when the fake child exits (mirrors waitForProcessExit). */
function fakeWait(): {
  waiter: ProcessWaiter;
  children: Array<ReturnType<typeof fakeChild>>;
  flush(): Promise<void>;
} {
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const waiter: ProcessWaiter = (child) => {
    const c = child as unknown as ReturnType<typeof fakeChild>;
    children.push(c);
    let cancelled = false;
    const promise = new Promise<boolean>((resolve) => {
      c.listeners.push(() => {
        if (!cancelled) resolve(true);
      });
      if (c.exitCode !== null && c.exitCode !== undefined) resolve(true);
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
      },
    };
  };
  return {
    waiter,
    children,
    flush: async () => {
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

test("register: one watcher per session id, a re-registration replaces the old handle", () => {
  const f = fakeWait();
  const registry = createProcessWatchRegistry(f.waiter, () => {});
  const child = fakeChild();
  rememberChildProcess("rg-reviewer-abc", child);
  registry.register("rg-reviewer-abc", "x");
  assert.equal(f.children.length, 1);
  // A DIFFERENT label replaces the handle (manual review_watch).
  registry.register("rg-reviewer-abc", "custom");
  assert.equal(f.children.length, 2);
  registry.unregister("rg-reviewer-abc");
});

test("P0 round-17: re-registering the SAME session id + label is idempotent (no leaked watchers)", () => {
  const f = fakeWait();
  const registry = createProcessWatchRegistry(f.waiter, () => {});
  rememberChildProcess("rg-reviewer-abc", fakeChild());
  for (let i = 0; i < 5; i++) registry.register("rg-reviewer-abc", "reviewer");
  assert.equal(f.children.length, 1, "only the FIRST registration may add a watcher");
  assert.equal(registry.active.size, 1);
});

test("exit: wakes the session once with (label, sessionId)", async () => {
  const f = fakeWait();
  const wakes: Array<[string, string]> = [];
  const registry = createProcessWatchRegistry(f.waiter, (label, sessionId) => wakes.push([label, sessionId]));
  const child = fakeChild();
  rememberChildProcess("rg-reviewer-abc", child);
  registry.register("rg-reviewer-abc", "reviewer");
  child.exit(0);
  await f.flush();
  assert.deepEqual(wakes, [["reviewer", "rg-reviewer-abc"]]);
  assert.equal(registry.active.size, 0, "the watcher is consumed on exit");
});

test("already-exited child fires immediately on registration (race)", async () => {
  const f = fakeWait();
  const wakes: Array<[string, string]> = [];
  const registry = createProcessWatchRegistry(f.waiter, (label, sessionId) => wakes.push([label, sessionId]));
  const child = fakeChild(0); // already exited
  rememberChildProcess("rg-reviewer-abc", child);
  registry.register("rg-reviewer-abc", "reviewer");
  await f.flush();
  assert.deepEqual(wakes, [["reviewer", "rg-reviewer-abc"]]);
});

test("cancel (unregister/shutdown) does not wake", async () => {
  const f = fakeWait();
  const wakes: Array<[string, string]> = [];
  const registry = createProcessWatchRegistry(f.waiter, (label, sessionId) => wakes.push([label, sessionId]));
  const child = fakeChild();
  rememberChildProcess("rg-reviewer-abc", child);
  registry.register("rg-reviewer-abc", "x");
  registry.unregister("rg-reviewer-abc");
  child.exit(0);
  await f.flush();
  assert.deepEqual(wakes, []);
  assert.equal(registry.active.size, 0);
});

test("shutdown: cancels every handle, clears the registry, blocks further registers", () => {
  const f = fakeWait();
  const registry = createProcessWatchRegistry(f.waiter, () => {});
  rememberChildProcess("rg-reviewer-abc", fakeChild());
  registry.register("rg-reviewer-abc", "x");
  registry.shutdown();
  assert.equal(registry.active.size, 0);
  registry.register("rg-reviewer-abc", "y");
  assert.equal(f.children.length, 1, "register must be a no-op after shutdown");
});

test("reset: a new session may register watchers again", () => {
  const f = fakeWait();
  const registry = createProcessWatchRegistry(f.waiter, () => {});
  rememberChildProcess("rg-reviewer-abc", fakeChild());
  registry.shutdown();
  registry.register("rg-reviewer-abc", "x");
  assert.equal(f.children.length, 0);
  registry.reset();
  registry.register("rg-reviewer-abc", "x");
  assert.equal(f.children.length, 1);
});

test("manual replace: an agent-side review_watch keeps its own label until the next exit", async () => {
  const f = fakeWait();
  const wakes: Array<[string, string]> = [];
  const registry = createProcessWatchRegistry(f.waiter, (label, sessionId) => wakes.push([label, sessionId]));
  const child = fakeChild();
  rememberChildProcess("rg-reviewer-abc", child);
  registry.register("rg-reviewer-abc", "auto");
  registry.register("rg-reviewer-abc", "custom");
  child.exit(0);
  await f.flush();
  assert.deepEqual(wakes, [["custom", "rg-reviewer-abc"]], "only the replacement handle may wake");
});

test("unregister: drops ONE session id (cancel + forget) without touching the others", async () => {
  const wakes: Array<[string, string]> = [];
  const f = fakeWait();
  const registry = createProcessWatchRegistry(f.waiter, (label, sessionId) => { wakes.push([label, sessionId]); });
  const a = fakeChild();
  const b = fakeChild();
  rememberChildProcess("rg-reviewer-abc", a);
  rememberChildProcess("rg-adviser-abc", b);
  registry.register("rg-reviewer-abc", "reviewer");
  registry.register("rg-adviser-abc", "adviser");
  registry.unregister("rg-reviewer-abc");
  assert.equal(registry.active.has("rg-reviewer-abc"), false, "and forgotten");
  assert.equal(registry.active.has("rg-adviser-abc"), true, "the other watcher survives");
  b.exit(0);
  await f.flush();
  assert.deepEqual(wakes, [["adviser", "rg-adviser-abc"]]);
  // A dropped session id can be registered again (a later round may reuse it).
  registry.register("rg-reviewer-abc", "reviewer");
  assert.equal(f.children.length, 3);
});
