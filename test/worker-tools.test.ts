/**
 * THE WORKER PROTOCOL — dispatch, wait, answer, close, resume.
 *
 * What these tests hold is the set of promises `worker_submit` makes about a
 * LATER call, because every one of them is invisible until it breaks:
 *
 *  - a worker that cannot be configured must FAIL rather than run on some
 *    default model nobody chose;
 *  - the pane must be read-only by its tool surface (`--exclude-tools
 *    edit,write`), because that is what makes several workers safe to run at
 *    once;
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
import { appendRecord, type ChannelRecord } from "../lib/orchestrator-channel.ts";
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

function makeWorld(opts: { agents?: AgentsConfigMap; alive?: boolean; paneOpens?: boolean } = {}) {
  const io = memoryChannelIO(() => NOW);
  const files = new Map<string, string>();
  let registry: WorkerRegistry = {};
  const opened: Array<{ command: readonly string[]; role: unknown }> = [];
  const killed: string[] = [];
  const logs: string[] = [];
  const alive = opts.alive ?? true;

  const deps: WorkerToolDeps = {
    ownPane: () => "%1",
    paneAlive: () => alive,
    openPane: async (spec) => {
      if (opts.paneOpens === false) return { ok: false, error: "tmux 拒绝开 pane" };
      opened.push({ command: spec.command, role: spec.role });
      spec.register("%42");
      return { ok: true, paneId: "%42" };
    },
    killPane: (paneId) => { killed.push(paneId); return true; },
    openerId: () => "%1",
    repoRoot: () => "/repo",
    channelIO: io,
    channelHome: () => undefined,
    workDirFor: (workerId) => `/repo/.pi/worker-sessions/${workerId}`,
    sessionDirFor: (workerId) => `/repo/.pi/judge-sessions/${workerId}/sessions`,
    writeFile: (path, content) => { files.set(path, content); return { ok: true }; },
    readRegistry: () => registry,
    saveRegistry: (next) => { registry = next; },
    agents: () => opts.agents ?? agentsWith({ worker: workerPreset() }),
    now: () => NOW,
    sleep: async () => { /* the wait loops are driven by the channel, not the clock */ },
    log: (m) => logs.push(m),
  };

  const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<ToolReply> }>();
  const host = {
    registerTool: (def: { name: string; execute: unknown }) => {
      tools.set(def.name, def as never);
    },
  };
  registerWorkerTools(host as unknown as ToolHost, deps);

  return {
    deps, io, files, tools, opened, killed, logs,
    registry: () => registry,
    call: (name: string, params: Record<string, unknown> = {}) => tools.get(name)!.execute("t", params),
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
    "read-only is the tool surface, not a rule the worker is asked to obey");
  assert.ok(command.includes("--session-id"));
  assert.equal(command[command.indexOf("--session-id") + 1], workerSessionId("worker-1"),
    "the session id is DERIVED from the worker id — that is what makes resume work");
  // The task travels as pi's own `@file`, never as a command-line phrase.
  assert.ok(command.some((arg) => arg.startsWith("@@") === false && arg.startsWith("@")), "the task is an @file argument");
  assert.match(reply.content[0]!.text, /worker-1/, "the receipt names the worker id it minted");
  assert.equal(world.registry()["worker-1"]?.sessionId, workerSessionId("worker-1"));
});

test("the system prompt the pane runs carries the preset's own words", async () => {
  const world = makeWorld({ agents: agentsWith({ worker: workerPreset({ prompt: "你是侦察兵：只报事实。" }) }) });
  await world.call("worker_submit", { task: "看看这个模块" });
  const written = [...world.files.values()].join("\n");
  assert.match(written, /你是侦察兵：只报事实。/);
  assert.match(written, /只读/, "…and the read-only contract is stated to the worker as well");
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

test("close frees the pane and the next submit RESUMES the same session", async () => {
  const world = makeWorld();
  await world.call("worker_submit", { task: "第一次" });
  const closed = await world.call("worker_close", { workerId: "worker-1" });
  assert.equal(closed.isError, undefined, world.text(closed));
  assert.deepEqual(world.killed, ["%42"]);
  assert.equal(world.registry()["worker-1"], undefined, "a closed worker is not addressable as a pane");

  // The pane is gone (paneAlive false) ⇒ the same id re-opens the SAME session.
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
  const parsed = parseWorkerRegistry({
    workers: {
      good: { role: "worker", model: "m", paneId: "%9", sessionId: "s", repoRoot: "/repo", createdAt: "t" },
      missingPane: { role: "worker", model: "m", sessionId: "s", repoRoot: "/repo", createdAt: "t" },
      "../evil": { role: "worker", model: "m", paneId: "%1", sessionId: "s", repoRoot: "/repo", createdAt: "t" },
    },
  });
  assert.deepEqual(Object.keys(parsed), ["good"],
    "a bad entry would make worker_close aim a kill at somebody else's session");
  assert.deepEqual(parseWorkerRegistry(JSON.parse(serializeWorkerRegistry(parsed))), parsed, "round trip");
  assert.deepEqual(parseWorkerRegistry("not an object"), {});
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
