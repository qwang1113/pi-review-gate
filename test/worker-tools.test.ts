/**
 * THE WORKER PROTOCOL — dispatch, wait, answer, close, resume.
 *
 * What these tests hold is the set of promises `worker_submit` makes about a
 * LATER call, because every one of them is invisible until it breaks:
 *
 *  - a worker that cannot be configured must FAIL rather than run on some
 *    default model nobody chose;
 *  - the pane must have no WRITING tools on its surface (`--exclude-tools
 *    edit,write`), because that is what makes several workers safe to run at
 *    once — `bash` is deliberately NOT on that list (2026-09-22: a worker that
 *    cannot run `git log` or a test investigates nothing);
 *  - a wait must be INTERRUPTIBLE, and must consume nothing when interrupted;
 *  - a second submit to a LIVING worker is a message, not a second worker;
 *  - a closed worker's next submit RESUMES the same session, which is the
 *    whole reason closing one is allowed to save screen space.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { memoryChannelIO } from "./helpers/fake-orchestration.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import type { AgentsConfigMap } from "../lib/model-config.ts";
import { appendRecord, channelPathFor, readChannel, type ChannelRecord } from "../lib/orchestrator-channel.ts";
import {
  nextWorkerId,
  projectWorkerChannel,
  registerWorkerTools,
  resolveWorkerRole,
  workerChannelTarget,
  type WorkerToolDeps,
} from "../lib/worker-tools.ts";
import { parseWorkerRegistry, serializeWorkerRegistry, workerSessionId, type WorkerRegistry } from "../lib/worker-pane.ts";
import { appendWorkerReport } from "../lib/worker-side.ts";

const NOW = 1_700_000_000_000;

function agentsWith(overrides: Partial<AgentsConfigMap> = {}): AgentsConfigMap {
  return {
    ...overrides,
  } as AgentsConfigMap;
}

/** The configured preset every test starts from. */
function workerPreset(extra: Record<string, unknown> = {}) {
  return { auto: false, slots: ["onekey/gpt-5.6-sol:high"], source: "global" as const, ...extra };
}

function makeWorld(opts: {
  agents?: AgentsConfigMap;
  alive?: boolean;
  paneOpens?: boolean;
  /** This session's opener identity — the channel owner for NEW workers. */
  openerId?: string;
  /** Share one channel store with another world (a restart/handover). */
  io?: ReturnType<typeof memoryChannelIO>;
  /** The tmux server this session can read — omitted ⇒ it cannot be read. */
  tmuxServer?: string;
  /** `closeWindow` refuses (tmux rejected the kill) — the window may still exist. */
  closeFails?: boolean;
  /** `closeWindow` says the window is already gone (`can't find window`). */
  closeGone?: boolean;
  /** Runs inside every fake `sleep` — how a test writes a mid-wait ack. */
  onSleep?: () => void;
} = {}) {
  const io = opts.io ?? memoryChannelIO(() => NOW);
  const files = new Map<string, string>();
  let registry: WorkerRegistry = {};
  const opened: Array<{ command: readonly string[]; role: unknown; decor: unknown }> = [];
  const killed: string[] = [];
  const logs: string[] = [];
  const alive = opts.alive ?? true;
  // A CLOCK THE SLEEPS MOVE. Every wait loop in the module is bounded by
  // `now() - started >= budget`, so a frozen clock plus a no-op sleep is an
  // infinite loop — which is exactly what the first version of this fixture
  // did, and it was a real test hang rather than a missing assertion.
  let clock = NOW;

  const deps: WorkerToolDeps = {
    ownPane: () => "%1",
    paneAlive: () => alive,
    openPane: async (spec) => {
      if (opts.paneOpens === false) return { ok: false, error: "tmux 拒绝开 pane" };
      opened.push({ command: spec.command, role: spec.role, decor: spec.decor });
      // The WINDOW is what the registry records now (2026-09-25); the pane id
      // rides along because liveness is still read from it.
      spec.register({ paneId: "%42", windowId: "@42", sessionName: "rg-repo-abcdef1234" });
      return { ok: true, paneId: "%42" };
    },
    closeWindow: (coords) => {
      killed.push(coords.windowId);
      // TWO DIFFERENT FAILURES (2026-09-25, quality round P2): a refusal leaves
      // the window possibly on screen, while "it is already gone" means the
      // close DID happen (somebody else closed it, or a restart took the
      // server). A fake that can only say one of them cannot drive both paths.
      if (opts.closeGone === true) return { ok: false, error: "can't find window: @42" };
      if (opts.closeFails === true) return { ok: false, error: "tmux 拒绝" };
      return { ok: true };
    },
    openerId: () => opts.openerId ?? "%1",
    paneOwner: () => "self",
    repoRoot: () => "/repo",
    channelIO: io,
    channelHome: () => undefined,
    workDirFor: (workerId) => `/repo/.pi/worker-sessions/${workerId}`,
    sessionDirFor: (workerId) => `/repo/.pi/judge-sessions/${workerId}/sessions`,
    writeFile: (path, content) => { files.set(path, content); return { ok: true }; },
    readRegistry: () => registry,
    saveRegistry: (next) => { registry = next; },
    agents: () => opts.agents ?? agentsWith({ worker: workerPreset() }),
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; opts.onSleep?.(); },
    ...(opts.tmuxServer === undefined ? {} : { tmuxServer: () => opts.tmuxServer }),
    log: (m) => logs.push(m),
  };

  const tools = new Map<string, {
    execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolReply>;
  }>();
  const host = {
    registerTool: (def: { name: string; execute: unknown }) => {
      tools.set(def.name, def as never);
    },
  };
  registerWorkerTools(host as unknown as ToolHost, deps);

  return {
    deps, io, files, tools, opened, killed, logs,
    registry: () => registry,
    saveRegistry: (next: WorkerRegistry) => { registry = next; },
    call: (name: string, params: Record<string, unknown> = {}, signal?: AbortSignal) =>
      tools.get(name)!.execute("t", params, signal),
    text: (r: ToolReply) => r.content.map((c) => c.text).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// the role's launch
// ---------------------------------------------------------------------------

test("a worker role that is not configured FAILS — no silent default model", () => {
  const missing = resolveWorkerRole(agentsWith(), "worker");
  assert.equal(missing.ok, false);
  assert.match(missing.ok === false ? missing.reason : "", /agents/,
    "the refusal names where to configure it");

  const empty = resolveWorkerRole(agentsWith({ worker: workerPreset({ slots: [] }) }), "worker");
  assert.equal(empty.ok, false, "an empty slot list is not a default either");

  const malformed = resolveWorkerRole(agentsWith({ worker: workerPreset({ malformed: true }) }), "worker");
  assert.equal(malformed.ok, false);
});

test("the preset's first slot is the model, and `model` overrides it for one dispatch", () => {
  const agents = agentsWith({ worker: workerPreset({ prompt: "你是侦察兵。" }) });
  const plain = resolveWorkerRole(agents, "worker");
  assert.deepEqual(plain, { ok: true, model: "onekey/gpt-5.6-sol:high", prompt: "你是侦察兵。" });
  const overridden = resolveWorkerRole(agents, "worker", "onekey/gpt-6-astra:max");
  assert.equal(overridden.ok && overridden.model, "onekey/gpt-6-astra:max");
  assert.equal(overridden.ok && overridden.prompt, "你是侦察兵。",
    "overriding the model must not drop the preset's prompt");
});

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

test("a worker pane is READ-ONLY by its tool surface, and resumes by session id", async () => {
  const world = makeWorld();
  const reply = await world.call("worker_submit", { task: "列出 X 的全部调用点" });
  assert.equal(reply.isError, undefined, world.text(reply));
  assert.equal(world.opened.length, 1);
  const command = world.opened[0]!.command;
  assert.deepEqual(command.slice(command.indexOf("--exclude-tools"), command.indexOf("--exclude-tools") + 2),
    ["--exclude-tools", "edit,write"],
    "the WRITING tools are off the surface — and `bash` is not one of them (2026-09-22): " +
    "a worker that cannot run `git log`, `rg` or a test cannot investigate anything, " +
    "so bash rides on the prompt's read-only rule plus the gate's own ship block");
  assert.ok(command.includes("--session-id"));
  assert.equal(command[command.indexOf("--session-id") + 1], workerSessionId("worker-1"),
    "the session id is DERIVED from the worker id — that is what makes resume work");
  // The task travels as pi's own `@file`, never as a command-line phrase.
  assert.ok(command.some((arg) => arg.startsWith("@@") === false && arg.startsWith("@")), "the task is an @file argument");
  assert.match(reply.content[0]!.text, /worker-1/, "the receipt names the worker id it minted");
  assert.equal(world.registry()["worker-1"]?.sessionId, workerSessionId("worker-1"));
});

test("a worker pane is DECORATED like every other gate pane — identity on its border", async () => {
  const world = makeWorld();
  await world.call("worker_submit", { workerId: "probe", task: "看一眼" });
  assert.deepEqual(world.opened[0]!.decor, {
    label: "probe@self",
    colorSeed: "probe",
    state: "working",
  }, "the worker used to be the one gate-opened pane with a blank border");
});

test("the system prompt the pane runs carries the preset's own words", async () => {
  const world = makeWorld({ agents: agentsWith({ worker: workerPreset({ prompt: "你是侦察兵：只报事实。" }) }) });
  await world.call("worker_submit", { task: "看看这个模块" });
  const written = [...world.files.values()].join("\n");
  assert.match(written, /你是侦察兵：只报事实。/);
  assert.match(written, /只读/, "…and the read-only contract is stated to the worker as well");
});

test("the append receipt reads the LAST ack — a received-then-injected handshake is a confirmation", async () => {
  // The handshake ALWAYS writes `received` first and only writes `injected`
  // once the text reached the agent. Reading the FIRST ack therefore reported
  // "not confirmed" for every append that ever worked (quality round P1, 6th
  // report, 2026-09-21).
  let chan!: ReturnType<typeof memoryChannelIO>;
  let patched = false;
  const world = makeWorld({
    io: (chan = memoryChannelIO(() => NOW)),
    onSleep: () => {
      if (patched) return;
      patched = true;
      const id = [...chan.files.values()].join("\n").trim().split("\n")
        .map((line) => JSON.parse(line) as { kind?: string; instructId?: string })
        .findLast((r) => r.kind === "instruct")?.instructId;
      if (!id) return;
      const target = workerChannelTarget("%1", "worker-1");
      for (const stage of ["received", "injected"] as const) {
        appendRecord(chan, target, {
          kind: "instruct-ack", from: "child", at: new Date(NOW).toISOString(),
          instructId: id, delivered: true, stage,
        });
      }
    },
  });
  await world.call("worker_submit", { task: "第一次" });
  const reply = await world.call("worker_submit", { task: "追加", workerId: "worker-1" });
  assert.equal((reply.details as { injected?: boolean })?.injected, true,
    "the injected ack — the LAST one — is what confirms the append");
  assert.match(world.text(reply), /已确认注入/);
});

test("a preset whose model spec cannot be resolved is refused, not launched", () => {
  // Worker chains never pass through the render layer (it filters them), so
  // this is the only place a typo'd provider/model is caught before pi tries
  // and fails to start the pane (quality round P2, 2026-09-21).
  const agents = agentsWith({ worker: workerPreset() });
  const refused = resolveWorkerRole(agents, "worker", undefined, (spec) => ({ ok: false, reason: `unknown model ${spec}` }));
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.reason : "", /不可解析/);
  assert.match(refused.ok === false ? refused.reason : "", /agents\.worker\.slots/, "…and it names where to fix it");

  const good = resolveWorkerRole(agents, "worker", undefined, () => ({ ok: true }));
  assert.equal(good.ok, true, "a resolvable spec passes");
});

test("a second submit to a LIVING worker is a message, not a second worker", async () => {
  const world = makeWorld();
  await world.call("worker_submit", { task: "第一件事" });
  const again = await world.call("worker_submit", { task: "再补一件事", workerId: "worker-1" });
  assert.equal(again.isError, undefined, world.text(again));
  assert.equal(world.opened.length, 1, "no second pane was opened");
  const channel = [...world.io.files.values()].join("\n");
  assert.match(channel, /再补一件事/, "the text went to the worker through its channel");
  assert.match(channel, /"kind":"instruct"/);
});

test("a worker that cannot be configured never opens a pane", async () => {
  const world = makeWorld({ agents: agentsWith() });
  const reply = await world.call("worker_submit", { task: "随便看看" });
  assert.equal(reply.isError, true);
  assert.equal(world.opened.length, 0);
});

test("a pane that refuses to open is reported, not swallowed", async () => {
  const world = makeWorld({ paneOpens: false });
  const reply = await world.call("worker_submit", { task: "随便看看" });
  assert.equal(reply.isError, true);
  assert.match(world.text(reply), /tmux 拒绝开 pane/);
});

test("a malformed workerId is refused (it is a filename, a pane title AND a session id)", async () => {
  const world = makeWorld();
  const reply = await world.call("worker_submit", { task: "x", workerId: "../evil" });
  assert.equal(reply.isError, true);
  assert.equal(world.opened.length, 0);
});

test("an empty task is refused — the worker sees nothing else", async () => {
  const world = makeWorld();
  const reply = await world.call("worker_submit", { task: "   " });
  assert.equal(reply.isError, true);
  assert.equal(world.opened.length, 0);
});

// ---------------------------------------------------------------------------
// wait / answer
// ---------------------------------------------------------------------------

test("worker_wait returns the report, and does not deliver the same one twice", async () => {
  const world = makeWorld();
  await world.call("worker_submit", { task: "列出 X 的调用点" });
  appendWorkerReport(world.io, workerChannelTarget("%1", "worker-1"), { result: "共 3 处：a.ts:10、b.ts:22、c.ts:7" });
  const first = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.match(world.text(first), /共 3 处/);
  assert.equal((first.details as { kind?: string })?.kind, "report");

  const second = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.equal((second.details as { kind?: string })?.kind, "timeout",
    "a report already consumed is not re-delivered — otherwise every later wait re-reports the same answer");
});

test("an ABORTED wait returns at once, says so, and consumes nothing", async () => {
  // Measured in prime (session 01a0c3ae-…, 2026-09-22): `worker_wait` ran a
  // hand-written `for(;;) await sleep(500)` and its registration dropped the
  // host's `signal`, so ESC did nothing and the call blocked out its full 300s.
  const world = makeWorld();
  await world.call("worker_submit", { task: "去看看" });
  appendWorkerReport(world.io, workerChannelTarget("%1", "worker-1"), { result: "没人读到的结论" });

  const reply = await world.call(
    "worker_wait",
    { workerId: "worker-1", timeoutMs: 300_000 },
    AbortSignal.abort(),
  );
  assert.equal((reply.details as { kind?: string })?.kind, "aborted", world.text(reply));
  assert.match(world.text(reply), /打断/, "the reply says WHY it came back empty-handed");
  assert.equal(world.registry()["worker-1"]?.reportedAt, undefined,
    "an interrupted wait must not advance the consumed-report cursor — nothing was handed over");

  // …and the proof that nothing was consumed: the next wait still delivers it.
  const next = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.equal((next.details as { kind?: string })?.kind, "report");
  assert.match(world.text(next), /没人读到的结论/);
});

test("an abort MID-WAIT ends it too — and still consumes nothing", async () => {
  // The realistic shape: the call is already blocking when the user gives up.
  // `pollUntil` races the signal against every sleep, so this must not run out
  // the 300s budget either.
  const controller = new AbortController();
  const world = makeWorld({ onSleep: () => controller.abort() });
  await world.call("worker_submit", { task: "去看看" });
  const reply = await world.call(
    "worker_wait",
    { workerId: "worker-1", timeoutMs: 300_000 },
    controller.signal,
  );
  assert.equal((reply.details as { kind?: string })?.kind, "aborted", world.text(reply));
  assert.equal(world.registry()["worker-1"]?.reportedAt, undefined);
});

test("worker_wait surfaces a QUESTION with its options, and worker_answer retires it", async () => {
  const world = makeWorld();
  await world.call("worker_submit", { task: "去看看" });
  const target = workerChannelTarget("%1", "worker-1");
  // Answering with no question open is a REFUSAL with the reason, not a silent
  // no-op: an answer that went nowhere would leave the worker blocked forever.
  const premature = await world.call("worker_answer", { workerId: "worker-1", answer: "x" });
  assert.equal(premature.isError, true);
  // The worker asks (the same record shape every gate dialog uses).
  appendRecord(world.io, target, {
    kind: "request", from: "child", at: new Date(NOW).toISOString(),
    requestId: "q1", dialogKind: "select", title: "要我把 wallet 那侧也看完吗？",
    options: ["看", "不用看"],
  });
  const waiting = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.equal((waiting.details as { kind?: string })?.kind, "question");
  assert.match(world.text(waiting), /看/);

  const answered = await world.call("worker_answer", { workerId: "worker-1", answer: "2" });
  assert.equal(answered.isError, undefined, world.text(answered));
  assert.match(world.text(answered), /不用看/, "a 1-based index resolves to the option text");

  const after = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.notEqual((after.details as { kind?: string })?.kind, "question",
    "an answered question is retired — `worker_answer` is the only thing that clears it");
});

test("worker_answer refuses an ambiguous answer rather than guessing", async () => {
  const world = makeWorld();
  await world.call("worker_submit", { task: "去看看" });
  appendRecord(world.io, workerChannelTarget("%1", "worker-1"), {
    kind: "request", from: "child", at: new Date(NOW).toISOString(),
    requestId: "q1", dialogKind: "select", title: "选一个", options: ["看 wallet", "看 prime"],
  });
  const reply = await world.call("worker_answer", { workerId: "worker-1", answer: "看" });
  assert.equal(reply.isError, true);
  assert.match(world.text(reply), /看 wallet/, "the refusal shows the real options");
});

// ---------------------------------------------------------------------------
// close / resume
// ---------------------------------------------------------------------------

test("close frees the WINDOW, and the next submit RESUMES the same session", async () => {
  const world = makeWorld();
  await world.call("worker_submit", { task: "第一次" });
  const closed = await world.call("worker_close", { workerId: "worker-1" });
  assert.equal(closed.isError, undefined, world.text(closed));
  assert.deepEqual(world.killed, ["@42"], "the kill is addressed by WINDOW, not by pane");
  // THE ENTRY STAYS (reviewer P1, 2026-09-21): closing releases SCREEN SPACE,
  // not the conversation — the channel owner, the session id and the report
  // cursor are what a later resume needs.
  assert.equal(world.registry()["worker-1"]?.paneId, undefined, "the pane is released");
  assert.equal(world.registry()["worker-1"]?.sessionId, workerSessionId("worker-1"),
    "…while the entry (and the channel it names) is kept");
  assert.equal(world.registry()["worker-1"]?.openerId, "%1");

  // Closing twice is a no-op, not a second kill.
  const again = await world.call("worker_close", { workerId: "worker-1" });
  assert.equal(again.isError, undefined);
  assert.deepEqual(world.killed, ["@42"], "no second kill-window for an already-closed worker");

  const world2 = makeWorld({ alive: false });
  await world2.call("worker_submit", { task: "第一次", workerId: "worker-1" });
  const resumed = await world2.call("worker_submit", { task: "接着上次那个问题，换一批文件", workerId: "worker-1" });
  assert.equal(resumed.isError, undefined, world2.text(resumed));
  assert.equal(world2.opened.length, 2, "the dead pane was re-opened");
  for (const { command } of world2.opened) {
    assert.equal(command[command.indexOf("--session-id") + 1], workerSessionId("worker-1"),
      "both dispatches ran the SAME session id — the worker keeps its context");
  }
  assert.match(world2.text(resumed), /接着用/, "and the receipt says the context carried over");
});

test("a window that is ALREADY GONE counts as closed — only a refusal keeps the coordinates", async () => {
  // 2026-09-25 (quality round P2): the two failures were one boolean, so a
  // worker whose window had already been closed was reported as a FAILED close
  // and kept its coordinates forever — the same reading `orchestrator_close`
  // had already got right.
  const world = makeWorld({ closeGone: true });
  await world.call("worker_submit", { task: "第一次" });
  const closed = await world.call("worker_close", { workerId: "worker-1" });
  assert.equal(closed.isError, undefined, world.text(closed));
  assert.equal((closed.details as { closed?: boolean })?.closed, true, "gone is closed, not failed");
  assert.match(world.text(closed), /已经不在了/);
  assert.equal(world.registry()["worker-1"]?.windowId, undefined, "the coordinates go — there is nothing left to address");
  assert.equal(
    world.registry()["worker-1"]?.sessionId,
    workerSessionId("worker-1"),
    "…while the conversation is kept, exactly as a refused close keeps it",
  );
});

test("a close tmux REFUSED keeps the coordinates — the window may still be there, and a resume must not open a second one", async () => {
  // REVIEWER P1 (round 1): the receipt was made honest about a refused close
  // while the entry still lost its `windowId`/`tmuxSession` — so the next
  // `worker_submit` found no window to ride on and opened a SECOND one beside a
  // window that may well still be on screen (two workers, one leaked pane).
  const world = makeWorld({ closeFails: true });
  await world.call("worker_submit", { task: "第一次" });
  const refused = await world.call("worker_close", { workerId: "worker-1" });
  assert.equal(refused.isError, undefined, world.text(refused));
  assert.match(world.text(refused), /关闭失败/);
  assert.equal((refused.details as { closed?: boolean })?.closed, false, "nothing claims it was closed");
  assert.equal(world.registry()["worker-1"]?.windowId, "@42", "the window is still recorded — it may still be on screen");
  assert.equal(world.registry()["worker-1"]?.tmuxSession, "rg-repo-abcdef1234");

  // THE POINT: the unclosed window is still addressable, so a resume rides it
  // instead of opening a second one.
  await world.call("worker_submit", { task: "追加", workerId: "worker-1" });
  assert.equal(world.opened.length, 1, "no second window was opened while the first may still be there");
  // …and a retry of the close reports the same true thing (idempotent, no lie).
  const retried = await world.call("worker_close", { workerId: "worker-1" });
  assert.equal(retried.isError, undefined);
  assert.match(world.text(retried), /关闭失败/);
  assert.deepEqual(world.killed, ["@42", "@42"], "the retry tried the recorded window again");
});

test("a resume after close keeps the channel AND the consumed-report cursor", async () => {
  // The two things `withoutWorker` would have thrown away (reviewer P1).
  const first = makeWorld();
  await first.call("worker_submit", { task: "第一次" });
  appendWorkerReport(first.io, workerChannelTarget("%1", "worker-1"), { result: "第一份结论" });
  const consumed = await first.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.match(first.text(consumed), /第一份结论/);
  await first.call("worker_close", { workerId: "worker-1" });

  // A DIFFERENT session resumes it: the entry's recorded opener is what locates
  // the channel, and its cursor is what keeps the old report from being
  // delivered as if it had just landed.
  const second = makeWorld({ alive: false, openerId: "%999", io: first.io });
  second.saveRegistry(first.registry());
  await second.call("worker_submit", { task: "接着上次", workerId: "worker-1" });
  assert.equal(second.registry()["worker-1"]?.openerId, "%1", "the channel owner survives the close");
  const again = await second.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.doesNotMatch(second.text(again), /第一份结论/,
    "an already-consumed report is not re-delivered after a close+resume");
});

test("an UNREADABLE server does not make a pane ours — the ownership rule is the same one close uses", async () => {
  // `ownedPaneAlive`'s guard is `entry.tmuxServer !== undefined && entry.tmuxServer !== current`:
  // a RECORDED server that no longer matches — including "cannot be read at
  // all", where `current` is undefined — is not ours. Only an entry that never
  // recorded a server (written before the field existed) skips the check, and
  // that is exactly what `worker_close` does with the same data.
  const first = makeWorld({ tmuxServer: "srv-1" });
  await first.call("worker_submit", { task: "第一次" });
  assert.equal(first.registry()["worker-1"]?.tmuxServer, "srv-1");

  // Same registry, same channel, same LIVE pane id — but this session cannot
  // read which server it is on.
  const moved = makeWorld({ openerId: "%999", io: first.io, alive: true });
  moved.saveRegistry(first.registry());
  const waited = await moved.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.notEqual((waited.details as { kind?: string })?.kind, "report",
    "a pane we cannot prove is ours is not treated as ours");
  assert.equal((waited.details as { kind?: string; alive?: boolean })?.alive, false);

  const submitted = await moved.call("worker_submit", { task: "追加", workerId: "worker-1" });
  assert.equal(submitted.isError, undefined, moved.text(submitted));
  assert.equal(moved.opened.length, 1, "the append did NOT ride on the unprovable pane — it re-opened the session");
});

test("a resume keeps the recorded tmux server when the current one cannot be read", async () => {
  // `worker_close` refuses to kill when the recorded server disagrees with the
  // current one — so dropping the field on a resume would silently remove that
  // check (reviewer P1, 2026-09-21).
  const first = makeWorld({ tmuxServer: "srv-1" });
  await first.call("worker_submit", { task: "第一次" });
  assert.equal(first.registry()["worker-1"]?.tmuxServer, "srv-1");

  const second = makeWorld({ alive: false, openerId: "%999", io: first.io }); // no reading ⇒ none passed
  second.saveRegistry(first.registry());
  await second.call("worker_submit", { task: "接着上次", workerId: "worker-1" });
  assert.equal(second.registry()["worker-1"]?.tmuxServer, "srv-1",
    "an unreadable server must not erase the recorded one");
});

test("closing an already-closed worker is idempotent even when the server cannot be read", async () => {
  // Nothing to kill ⇒ no mis-kill for the ownership check to prevent, so the
  // check must not turn a no-op into a refusal (reviewer P2, 2026-09-21).
  const first = makeWorld({ tmuxServer: "srv-1" });
  await first.call("worker_submit", { task: "第一次" });
  await first.call("worker_close", { workerId: "worker-1" });

  const second = makeWorld({ openerId: "%999", io: first.io });
  second.saveRegistry(first.registry());
  const again = await second.call("worker_close", { workerId: "worker-1" });
  assert.equal(again.isError, undefined, "an already-closed worker is not a failed close");
  assert.deepEqual(second.killed, [], "and nothing was killed");
});

test("waiting on a CLOSED worker returns immediately, not after the timeout", async () => {
  // A closed worker can never write to its channel again, so "wait for it" is
  // a question with a known answer — and the answer used to take 300 seconds
  // (reviewer P2, 2026-09-21).
  const world = makeWorld();
  await world.call("worker_submit", { task: "第一次" });
  await world.call("worker_close", { workerId: "worker-1" });
  const reply = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 300_000 });
  assert.equal((reply.details as { kind?: string })?.kind, "gone");
  assert.match(world.text(reply), /已经关掉/);
  assert.match(world.text(reply), /worker_submit/, "and it says how to continue the conversation");
});

test("'gone' never outranks a report — a closed worker's last words are still delivered", async () => {
  // The race the reviewer named (2026-09-21): `worker_close` kills the pane,
  // and a report the worker had already written can reach the channel around
  // the same moment. Declaring it gone on a single read would drop that report.
  const world = makeWorld();
  await world.call("worker_submit", { task: "最后一次调查" });
  appendWorkerReport(world.io, workerChannelTarget("%1", "worker-1"), { result: "关掉之前写下的结论" });
  await world.call("worker_close", { workerId: "worker-1" });

  const reply = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.equal((reply.details as { kind?: string })?.kind, "report", "the report wins over the gone verdict");
  assert.match(world.text(reply), /关掉之前写下的结论/);
});

test("'gone' is not a dead end — a report that lands later is read by the next wait", async () => {
  // What makes a late report safe is NOT the wait window (no finite window can
  // promise anything about a process being killed): it is that nothing is
  // discarded — the entry and the channel both stay. This test pins that
  // property, which is the one the reviewer's P1 was actually about.
  const world = makeWorld();
  await world.call("worker_submit", { task: "第一次" });
  await world.call("worker_close", { workerId: "worker-1" });

  const first = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.equal((first.details as { kind?: string })?.kind, "gone");

  // The report lands AFTER the wait already said "gone".
  appendWorkerReport(world.io, workerChannelTarget("%1", "worker-1"), { result: "慢了一拍落地的结论" });
  const second = await world.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.equal((second.details as { kind?: string })?.kind, "report", "nothing was thrown away by the gone verdict");
  assert.match(world.text(second), /慢了一拍落地的结论/);
});

test("close on an unknown worker is a no-op, not an error", async () => {
  const world = makeWorld();
  const reply = await world.call("worker_close", { workerId: "worker-9" });
  assert.equal(reply.isError, undefined);
  assert.deepEqual(world.killed, []);
});

// ---------------------------------------------------------------------------
// the pure pieces
// ---------------------------------------------------------------------------

test("nextWorkerId never reuses a registered id", () => {
  assert.equal(nextWorkerId({}), "worker-1");
  assert.equal(nextWorkerId({ "worker-1": {} as never }), "worker-2");
  assert.equal(nextWorkerId({ "worker-2": {} as never }), "worker-1", "a freed id is reusable");
});

test("the registry drops a malformed entry instead of guessing a pane", () => {
  const good = { openerId: "s1", role: "worker", model: "m", paneId: "%9", sessionId: "s", repoRoot: "/repo", createdAt: "t" };
  const parsed = parseWorkerRegistry({
    workers: {
      good,
      missingPane: { ...good, paneId: undefined },
      missingOpener: { ...good, openerId: undefined },
      "../evil": good,
    },
  });
  assert.deepEqual(Object.keys(parsed), ["good"],
    "a bad entry would make worker_close aim a kill at somebody else's session, or a wait read somebody else's channel");
  assert.deepEqual(parseWorkerRegistry(JSON.parse(serializeWorkerRegistry(parsed))), parsed, "round trip");
  assert.deepEqual(parseWorkerRegistry("not an object"), {});
});

test("the registry sanitizes the WINDOW pair by SHAPE, like the orchestration sidecar does", () => {
  // Both halves become a tmux target (`<session>:<@window>`), and this file is
  // on disk — so they are validated exactly as lib/orchestrator-registry.ts
  // validates the same fields on the orchestration side (2026-09-25, quality
  // round P2: the two disk boundaries had two answers to one question).
  const good = {
    openerId: "s1", role: "worker", model: "m", paneId: "%9", windowId: "@9",
    tmuxSession: "rg-repo-abcdef1234", sessionId: "s", repoRoot: "/repo", createdAt: "t",
  };
  const parsed = parseWorkerRegistry({
    workers: {
      good,
      // A window id that is really a pane id, a session name the gate could not
      // have derived, and a target carrying tmux syntax of its own.
      badwindow: { ...good, windowId: "%9" },
      badsession: { ...good, tmuxSession: "my-work" },
      injected: { ...good, tmuxSession: "rg-repo-abcdef1234:@9" },
      missingwindow: { ...good, windowId: undefined },
    },
  });
  assert.deepEqual(parsed.good, { workerId: "good", ...good }, "a well-formed record round-trips untouched");
  for (const id of ["badwindow", "badsession", "injected"]) {
    assert.equal(parsed[id]?.windowId, undefined, `${id}: nothing half-recorded is carried`);
    assert.equal(parsed[id]?.tmuxSession, undefined, `${id}: neither half survives on its own`);
    assert.equal(parsed[id]?.paneId, "%9", "…while the rest of the entry is kept (liveness still reads it)");
  }
  // A record from before the window topology has neither half: that is a
  // legitimate entry (it just cannot be closed by window), not a malformed one.
  assert.equal(parsed.missingwindow?.paneId, "%9");
  assert.equal(parsed.missingwindow?.windowId, undefined);
});

// The opener id in an entry is what locates the worker's CHANNEL, and it is
// read back from the entry rather than re-derived from this session — deriving
// it from `TMUX_PANE` meant every restart/re-attach/handover silently moved the
// channel, and the report landed where nobody was waiting (reviewer P1,
// 2026-09-21).
test("a worker stays reachable after the opener's own identity changes", async () => {
  const first = makeWorld();
  await first.call("worker_submit", { task: "看一下" });
  assert.equal(first.registry()["worker-1"]?.openerId, "%1", "the opener is recorded at dispatch");
  appendWorkerReport(first.io, workerChannelTarget("%1", "worker-1"), { result: "结论" });

  // SAME registry and SAME channel store, but this session's opener identity
  // is different now (a restarted pane, a handover).
  const second = makeWorld({ openerId: "%999", io: first.io });
  second.saveRegistry(first.registry());
  const reply = await second.call("worker_wait", { workerId: "worker-1", timeoutMs: 0 });
  assert.match(second.text(reply), /结论/,
    "the channel is found through the RECORDED opener — re-deriving it reads an empty file");
});

test("resuming a dead worker keeps the channel it already had", async () => {
  // A worker that already exists owns a channel under the opener that FIRST
  // opened it. Re-stamping this session's identity on a resume would move the
  // address while everything the worker ever said stayed behind — including
  // the report the caller is waiting for (reviewer P1, 2026-09-21).
  const first = makeWorld();
  await first.call("worker_submit", { task: "第一次" });
  assert.equal(first.registry()["worker-1"]?.openerId, "%1");

  // Same worker, same channel store, but resumed by a session whose own
  // identity is different (a restart, a handover) — and the pane is gone, so
  // this really is the resume path.
  const second = makeWorld({ alive: false, openerId: "%999", io: first.io });
  second.saveRegistry(first.registry());
  const resumed = await second.call("worker_submit", { task: "接着上次那个", workerId: "worker-1" });
  assert.equal(resumed.isError, undefined, second.text(resumed));
  assert.equal(second.registry()["worker-1"]?.openerId, "%1", "the channel stays where the history is");
  const role = second.opened.at(-1)?.role as { openerId?: string } | undefined;
  assert.equal(role?.openerId, "%1", "…and the resumed pane is told to report there");
});

test("the projection answers the two questions a caller has", () => {
  const io = memoryChannelIO(() => NOW);
  const target = workerChannelTarget("%1", "worker-1");
  appendWorkerReport(io, target, { result: "第一次的结论" });
  appendRecord(io, target, {
    kind: "request", from: "child", at: new Date(NOW).toISOString(),
    requestId: "q1", dialogKind: "confirm", title: "继续吗？", options: [],
  });
  const written = [...(io as unknown as { files: Map<string, string> }).files.values()].join("\n");
  const records = written.trim().split("\n").map((line) => JSON.parse(line) as ChannelRecord);
  const projection = projectWorkerChannel(io, records);
  assert.equal(projection.report?.text, "第一次的结论");
  assert.equal(projection.question?.title, "继续吗？");
  assert.equal(projection.question?.options.length, 0, "an option-less question is still a question");
});

test("a report too long to inline still reaches the caller — the summaryRef is READ (2026-09-22)", () => {
  const io = memoryChannelIO(() => NOW);
  const target = workerChannelTarget("%1", "worker-1");
  // MEASURED IN THE FIELD: a worker's long report is spilled to a side file
  // (`{"kind":"report",…,"summaryRef":{…,"chars":19657}}`) and the record keeps
  // no `summary` at all — reading the inline field alone made `worker_wait`
  // answer 「没有新消息」 forever while the report sat on disk.
  const long = "结论：这一轮查到的每一处调用点都在下面。".repeat(120);
  appendWorkerReport(io, target, { result: long });
  const records = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records;
  const stored = records.at(-1) as { summary?: string; summaryRef?: { path: string; chars: number } };
  assert.equal(stored.summary, undefined, "the fixture really did spill the report");
  assert.ok(stored.summaryRef, "…and the only copy is the side file");

  assert.equal(projectWorkerChannel(io, records).report?.text, long);
});

test("a report nobody can read is SAID, never silently dropped", () => {
  const io = memoryChannelIO(() => NOW);
  const target = workerChannelTarget("%1", "worker-1");
  appendRecord(io, target, {
    kind: "report", from: "child", at: new Date(NOW).toISOString(), verdict: "READY",
    reportId: "rep-gone", summaryRef: { path: "/gone/rep-gone.payload", chars: 4096 },
  });
  appendRecord(io, target, {
    kind: "report", from: "child", at: new Date(NOW).toISOString(), verdict: "READY",
    reportId: "rep-empty",
  });
  const records = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records;

  const unreadable = projectWorkerChannel(io, [records[0]!]);
  assert.match(unreadable.report?.text ?? "", /报告读不到/,
    "a dropped report and a worker that never reported are indistinguishable to the caller");
  assert.match(unreadable.report?.text ?? "", /\/gone\/rep-gone\.payload/);

  const empty = projectWorkerChannel(io, [records[1]!]);
  assert.match(empty.report?.text ?? "", /没有内容/);
});
