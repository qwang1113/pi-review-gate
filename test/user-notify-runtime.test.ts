/**
 * THE RUNTIME HALF: where the notifier is, where this session lives, and what
 * an exit means.
 *
 * Its policy half (lib/user-notify.ts) is tested on its own; what is tested
 * here is the plumbing only a process can have — the resolved binary, the tmux
 * address looked up lazily, the two spawns, and the throttle being written to
 * the sidecar. Everything is injected, so no test sends anything and none of
 * them need tmux.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createUserNotifyRuntime } from "../lib/user-notify-runtime.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { NOTIFY_DEDUP_MS } from "../lib/user-notify.ts";

const T0 = 1_700_000_000_000;

interface Harness {
  notify: (opts: Parameters<ReturnType<typeof createUserNotifyRuntime>["notify"]>[0]) => ReturnType<ReturnType<typeof createUserNotifyRuntime>["notify"]>;
  runtime: ReturnType<typeof createUserNotifyRuntime>;
  state: GateState;
  sent: string[][];
  blocking: string[][];
  tmuxCalls: string[][];
  persists: number;
  markCleanShutdown(): void;
  /** Run the registered exit handler the way node would. */
  exit(): void;
}

function harness(over: {
  env?: Record<string, string>;
  taskMode?: GateState["taskMode"];
  interactive?: boolean;
  notifier?: string | undefined;
  windowId?: string;
  /** Attached tmux clients, and the pane each of them is showing. */
  clients?: string[];
  clientPanes?: Record<string, string>;
  /** What `lsappinfo` would report — a test never shells out (a THROWING
   *  reader is expressible too: the fail-open path must survive it). */
  frontBundleId?: string | undefined | (() => string | undefined);
  /** Make every tmux call throw — the other half of the same fail-open rule. */
  tmuxThrows?: boolean;
} = {}): Harness {
  const state = emptyState("sess-1", 10);
  if (over.taskMode) state.taskMode = over.taskMode;
  const sent: string[][] = [];
  const blocking: string[][] = [];
  const tmuxCalls: string[][] = [];
  const exitHandlers: Array<() => void> = [];
  let persists = 0;
  const realOn = process.on.bind(process);
  // Capture the handler instead of registering it: a test process must not add
  // an exit listener per case.
  (process as unknown as { on: unknown }).on = (event: string, fn: () => void) => {
    if (event === "exit") { exitHandlers.push(fn); return process; }
    return (realOn as unknown as (e: string, f: () => void) => unknown)(event, fn) as unknown;
  };
  let runtime: ReturnType<typeof createUserNotifyRuntime>;
  try {
    runtime = createUserNotifyRuntime({
      state: () => state,
      persist: () => { persists += 1; },
      repoName: () => "pi-review-gate",
      taskMode: () => state.taskMode,
      env: () => ({ TMUX_PANE: "%7", __CFBundleIdentifier: "com.mitchellh.ghostty", ...(over.env ?? {}) } as NodeJS.ProcessEnv),
      interactive: () => over.interactive ?? true,
      runTmux: (argv) => {
        tmuxCalls.push([...argv]);
        if (over.tmuxThrows) throw new Error("tmux exploded");
        // THE THREE QUESTIONS THE RUNTIME ASKS tmux: where is this session's
        // window, which clients are attached, and what is each one showing.
        if (argv[0] === "list-clients") {
          return { ok: true, stdout: `${(over.clients ?? []).join("\n")}\n` };
        }
        if (argv[0] === "display-message" && argv.includes("-c")) {
          const client = argv[argv.indexOf("-c") + 1] ?? "";
          const shown = over.clientPanes?.[client];
          return shown ? { ok: true, stdout: `${shown}\n` } : { ok: false, stdout: "" };
        }
        return { ok: true, stdout: `${over.windowId ?? "@3"}\n` };
      },
      // A DIFFERENT app by default: the session's own bundle is
      // `com.mitchellh.ghostty`, and a test that sends a banner must not trip
      // the "user is already looking" suppression by accident.
      frontBundleId: () => {
        if (typeof over.frontBundleId === "function") return over.frontBundleId();
        return "frontBundleId" in over ? over.frontBundleId : "com.other.app";
      },
      now: () => T0,
      spawnDetached: (argv) => { sent.push([...argv]); },
      spawnBlocking: (argv) => { blocking.push([...argv]); },
      resolveNotifier: () => ("notifier" in over ? over.notifier : "/opt/homebrew/bin/terminal-notifier"),
    });
    runtime.armExitHandler();
  } finally {
    (process as unknown as { on: unknown }).on = realOn;
  }
  return {
    runtime,
    state,
    sent,
    blocking,
    tmuxCalls,
    get persists() { return persists; },
    notify: (opts) => runtime.notify(opts),
    markCleanShutdown: () => runtime.markCleanShutdown(),
    exit: () => { for (const handler of exitHandlers) handler(); },
  } as Harness;
}

test("a banner goes out with this session's own pane as the click target", () => {
  const h = harness({ taskMode: "loop" });
  const outcome = h.notify({ kind: "finished", detail: "本轮完成" });
  assert.deepEqual(outcome, { status: "sent" });
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0], [
    "/opt/homebrew/bin/terminal-notifier",
    "-title", "任务完成 · pi-review-gate",
    "-message", "本轮完成",
    "-group", "sess-1",
    "-activate", "com.mitchellh.ghostty",
    "-execute", "tmux select-window -t @3; tmux select-pane -t %7",
  ]);
  assert.deepEqual(h.tmuxCalls, [
    ["display-message", "-p", "-t", "%7", "#{window_id}"],
    // …and the sweep that answers "is the user already looking at this pane":
    // no client is attached in this harness, so nothing is on screen.
    ["list-clients", "-F", "#{client_name}"],
  ]);
  assert.equal(h.state.notify?.sentAt.length, 1, "the throttle is written to the sidecar");
  assert.equal(h.persists, 1, "…and persisted, or a reload would forget it");
  assert.equal(h.blocking.length, 0, "a live session never blocks on the notifier");
});

test("a host app that cannot be named sends no `-activate` (reviewer Nit, 2026-09-17)", () => {
  const h = harness({ taskMode: "loop", env: { __CFBundleIdentifier: "" } });
  assert.equal(h.notify({ kind: "finished", detail: "x" }).status, "sent");
  assert.ok(!h.sent[0]!.includes("-activate"), "no guessed bundle: the click would raise somebody else's app");
  assert.ok(h.sent[0]!.includes("-execute"), "the tmux focus command still rides along");
});

test("nothing is spawned when the session may not send, and tmux is not even asked", () => {
  const h = harness({ taskMode: "loop", env: { RG_STATE_VARIANT: "t1-x" } });
  assert.equal(h.notify({ kind: "finished", detail: "x" }).status, "skipped");
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.tmuxCalls, [], "a child session must not pay for a tmux round trip");
  assert.equal(h.state.notify, undefined);
});

test("a user looking at this session's own pane is not interrupted (user decision, 2026-09-18)", () => {
  const h = harness({
    taskMode: "loop",
    clients: ["/dev/ttys001"],
    clientPanes: { "/dev/ttys001": "%7" },
    frontBundleId: "com.mitchellh.ghostty",
  });
  assert.equal(h.notify({ kind: "needs-user", detail: "选哪个方案？" }).status, "skipped");
  assert.deepEqual(h.sent, [], "the box is already on the screen they are looking at");
  assert.equal(h.state.notify, undefined, "a banner not sent does not spend a throttle slot");
  assert.equal(h.persists, 0, "…and writes nothing to the sidecar");
});

test("the SAME pane is worth a banner once the terminal is behind another app", () => {
  const h = harness({
    taskMode: "loop",
    clients: ["/dev/ttys001"],
    clientPanes: { "/dev/ttys001": "%7" },
    frontBundleId: "com.google.Chrome",
  });
  assert.equal(h.notify({ kind: "needs-user", detail: "选哪个方案？" }).status, "sent");
});

test("the terminal in front but showing ANOTHER pane still gets the banner", () => {
  const h = harness({
    taskMode: "loop",
    clients: ["/dev/ttys001"],
    clientPanes: { "/dev/ttys001": "%9" },
    frontBundleId: "com.mitchellh.ghostty",
  });
  assert.equal(h.notify({ kind: "needs-user", detail: "选哪个方案？" }).status, "sent");
});

test("a frontmost app that cannot be read must not silence the channel", () => {
  const h = harness({
    taskMode: "loop",
    clients: ["/dev/ttys001"],
    clientPanes: { "/dev/ttys001": "%7" },
    frontBundleId: undefined,
  });
  assert.equal(h.notify({ kind: "needs-user", detail: "选哪个方案？" }).status, "sent");
});

test("evidence that THROWS must not suppress the banner (fail open)", () => {
  // Reviewer P1, 2026-09-18: the injected reader used to sit outside the
  // try/catch, so a throwing one escaped into `notify()`'s catch-all and the
  // outcome came back `skipped` — an error while LOOKING for the user silently
  // silencing the channel. That catch-all is for the notifier failing, never
  // for the evidence about where the user is.
  const bundle = harness({
    taskMode: "loop",
    frontBundleId: () => { throw new Error("lsappinfo exploded"); },
  });
  assert.equal(bundle.notify({ kind: "needs-user", detail: "选哪个？" }).status, "sent");

  const tmux = harness({ taskMode: "loop", tmuxThrows: true });
  assert.equal(tmux.notify({ kind: "needs-user", detail: "选哪个？" }).status, "sent",
    "a tmux that cannot be asked is \"nobody is looking\", not \"say nothing\"");
});

test("the notifier is resolved once, and a missing one is reported not swallowed", () => {
  const missing = harness({ taskMode: "loop", notifier: undefined });
  const outcome = missing.notify({ kind: "finished", detail: "x" });
  assert.equal(outcome.status, "missing");
  assert.match((outcome as { note: string }).note, /brew install terminal-notifier/);
  assert.deepEqual(missing.sent, []);
  assert.match(missing.runtime.startHint(), /通知是关的/);

  const present = harness({ taskMode: "loop" });
  assert.equal(present.runtime.startHint(), "");
});

test("the same banner twice inside the dedup window is throttled, and the argv is not built", () => {
  const h = harness({ taskMode: "loop" });
  assert.equal(h.notify({ kind: "finished", detail: "同一句话" }).status, "sent");
  const second = h.notify({ kind: "finished", detail: "同一句话" });
  assert.equal(second.status, "throttled");
  assert.equal(h.sent.length, 1);
  assert.equal(h.persists, 1, "a throttled send changes nothing");
  assert.equal(NOTIFY_DEDUP_MS, 10 * 60_000);
});

test("an exit WITHOUT a clean shutdown is the one banner nobody else can raise", () => {
  const crashed = harness({ taskMode: "loop" });
  crashed.exit();
  assert.equal(crashed.blocking.length, 1, "the exit path sends, and sends blocking");
  assert.match(crashed.blocking[0]!.join(" "), /异常结束 · pi-review-gate/);
  // WHAT THE BANNER CLAIMS IS BOUNDED BY WHAT THE JUDGE READS (reviewer P2,
  // 2026-09-17): `cleanShutdown` is the whole decision, so the copy says
  // "abnormal end" — a session that DID declare_done and then died on a
  // signal lands here too, and "you never declared done" would be the
  // opposite of what happened.
  assert.match(crashed.blocking[0]!.join(" "), /异常结束：进程没有走正常关闭流程/);
  assert.doesNotMatch(crashed.blocking[0]!.join(" "), /declare_done/);
  assert.deepEqual(crashed.sent, [], "the process is leaving: a detached child would be killed with it");

  const quit = harness({ taskMode: "loop" });
  quit.markCleanShutdown();
  quit.exit();
  assert.deepEqual(quit.blocking, [], "quit | reload | new | resume | fork — the user did it on purpose");

  const child = harness({ taskMode: "loop", env: { RG_STATE_VARIANT: "t1-x" } });
  child.exit();
  assert.deepEqual(child.blocking, [], "a child's crash is its manager's business");

  const judge = harness({ env: {}, taskMode: "normal" });
  judge.exit();
  assert.deepEqual(judge.blocking, [], "a judge pane may never raise a banner");
});

test("a clean shutdown recorded AFTER a crash-shaped exit is still silence, and vice versa", () => {
  // The flag is read at exit time, not at registration time — the ordering of
  // pi's teardown must not decide whether the user is told.
  const h = harness({ taskMode: "loop" });
  h.exit();
  assert.equal(h.blocking.length, 1);
  h.markCleanShutdown();
  h.exit();
  assert.equal(h.blocking.length, 1, "the second exit is a recorded clean one");
});
