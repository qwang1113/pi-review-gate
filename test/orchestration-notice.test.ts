/**
 * The orchestration notice (lib/orchestration-notice.ts) and its delivery
 * (lib/orchestrator-runtime-host.ts `superviseTick` + the `message_end` check).
 *
 * The measured defect (2026-09-27): notices piled up in pi's one-at-a-time
 * steer queue while the manager was blocked, then leaked out one stale line
 * per turn — a settled tmux request from a closed pane was injected a dozen
 * more times, and every line named children by `h1-muih4hsa` handles.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";

neutraliseGateEnv();

import { makeFakeWorld, replyText, twoTaskPlan, type FakeWorld } from "./helpers/fake-orchestration.ts";
import {
  childLabel,
  describePendingRequest,
  freshNoticeEvents,
  noticeText,
  requestLabel,
  NOTICE_KIND,
  type NoticeEvent,
  type NoticeFacts,
} from "../lib/orchestration-notice.ts";
import { createOrchestratorRuntime } from "../lib/orchestrator-runtime-host.ts";
import type { SessionHost } from "../lib/session-host.ts";
import type { OrchestratorRuntimeDeps } from "../lib/orchestrator-runtime-host.ts";

// ---- pure: names ----

test("names lead with the task and the kind of dialog; the handles follow for tool calls", () => {
  assert.equal(requestLabel("h1", "tmux-access"), "h1 的 tmux 授权请求");
  assert.equal(requestLabel("p2", "goal-approval"), "p2 的 goal 确认");
  assert.equal(requestLabel("p2", undefined), "p2 的 提问");
  assert.equal(childLabel("h1", "h1-muih4hsa"), "h1（childId=h1-muih4hsa）");
  assert.equal(
    describePendingRequest({
      taskId: "h1", childId: "h1-muih4hsa", requestId: "req-muih4hsa-h8kctz",
      topic: "tmux-access", title: "允许 tmux？", options: ["是", "否"],
    }),
    "h1 的 tmux 授权请求在等回答：「允许 tmux？」（2 个选项；childId=h1-muih4hsa，requestId=req-muih4hsa-h8kctz）",
  );
});

// ---- pure: freshness ----

const asked: NoticeEvent = { childId: "h1-a", state: "waiting-input", requestId: "req-1", summary: "q" };
const finished: NoticeEvent = { childId: "l1-b", state: "done", summary: "d" };
const facts = (over: Partial<NoticeFacts> = {}): NoticeFacts => ({
  children: [
    { childId: "h1-a", taskId: "h1", state: "waiting-input" },
    { childId: "l1-b", taskId: "l1", state: "done" },
  ],
  openRequestIds: new Set(["req-1"]),
  doneTaskIds: new Set(),
  ...over,
});

test("an event still true is kept", () => {
  assert.deepEqual(freshNoticeEvents([asked, finished], facts()), [asked, finished]);
});

test("a settled request, a closed child, a done task, a moved state — each is dropped", () => {
  assert.deepEqual(freshNoticeEvents([asked], facts({ openRequestIds: new Set() })), [], "request settled");
  assert.deepEqual(freshNoticeEvents([finished], facts({ children: [] })), [], "child closed");
  assert.deepEqual(freshNoticeEvents([finished], facts({ doneTaskIds: new Set(["l1"]) })), [], "task done");
  assert.deepEqual(
    freshNoticeEvents([asked], facts({ children: [{ childId: "h1-a", taskId: "h1", state: "working" }] })),
    [], "state moved on",
  );
});

test("nothing left ⇒ the body says it expired, and names nothing", () => {
  const text = noticeText([]);
  assert.match(text, /已全部过期/);
  assert.doesNotMatch(text, /子会话需要你/);
  assert.match(noticeText([asked]), /子会话需要你：\n- q/);
});

// ---- delivery: the runtime host over a fake orchestration ----

interface Harness {
  world: FakeWorld;
  sent: Array<{ message: { content: string; details: { kind: string; events: NoticeEvent[] } }; options: unknown }>;
  tick(): void;
  deliver(index?: number): { message: { content: string } } | undefined;
  agentEnd(): void;
  childId: string;
}

async function harness(): Promise<Harness> {
  const world = makeFakeWorld({ plan: twoTaskPlan(), approvePlan: true });
  const spawned = await world.call("orchestrator_spawn", { taskId: "t1", task: "做任务一" });
  assert.equal(spawned.isError, undefined, replyText(spawned));
  const childId = world.runtime().children[0]!.id;
  const handlers = new Map<string, (event: unknown) => unknown>();
  const sent: Harness["sent"] = [];
  const pi = {
    sendMessage: (message: never, options: unknown) => { sent.push({ message, options }); },
    sendUserMessage: () => {},
    on: (name: string, handler: (event: unknown) => unknown) => { handlers.set(name, handler); },
  };
  const host = {
    state: () => ({ taskMode: "orchestrator" }),
    repos: () => ({ primary: "/repo", cwd: "/repo", all: ["/repo"] }),
    ctx: () => undefined,
  } as unknown as SessionHost;
  const runtime = createOrchestratorRuntime(host, {
    pi: pi as unknown as OrchestratorRuntimeDeps["pi"],
    orchestratorDeps: world.deps,
    channelIO: world.io,
    currentOrchestrationId: () => world.runtime().orchestrationId,
  } as unknown as OrchestratorRuntimeDeps);
  return {
    world,
    sent,
    childId,
    tick: () => runtime.superviseTick(),
    deliver: (index = sent.length - 1) =>
      handlers.get("message_end")!({ message: { role: "custom", customType: "review-gate", ...sent[index]!.message } }) as never,
    agentEnd: () => { handlers.get("agent_end")!({}); },
  };
}

test("a question is announced once, readably, as a steer", async () => {
  const h = await harness();
  h.world.childAsks(h.childId, { requestId: "req-x", title: "允许 tmux？", options: ["是", "否"], topic: "tmux-access" });
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0]!.options, { triggerTurn: true, deliverAs: "steer" }, "a steer: not held for the turn to end");
  assert.equal(h.sent[0]!.message.details.kind, NOTICE_KIND);
  assert.match(h.sent[0]!.message.content, /t1 的 tmux 授权请求在等回答：「允许 tmux？」/);
  assert.match(h.sent[0]!.message.content, /requestId=req-x/);
  assert.equal(h.deliver(), undefined, "still true on delivery ⇒ delivered as written");
});

test("while one notice is in flight no second one is queued; delivery frees the slot", async () => {
  const h = await harness();
  h.world.childAsks(h.childId, { requestId: "req-x", title: "q", options: ["a", "b"] });
  h.tick();
  for (let i = 0; i < 20; i++) { h.world.advance(60_000); h.tick(); }
  assert.equal(h.sent.length, 1, "the backlog that leaked one stale line per turn");
  h.deliver();
  h.world.advance(60_000);
  h.tick();
  assert.equal(h.sent.length, 2, "the re-ring comes once the first one landed");
});

test("answered while queued ⇒ rewritten to the expired line on delivery", async () => {
  const h = await harness();
  h.world.childAsks(h.childId, { requestId: "req-x", title: "q", options: ["a", "b"], topic: "tmux-access" });
  h.tick();
  h.world.childSettles(h.childId, "req-x", "human");
  const revised = h.deliver();
  assert.ok(revised, "a stale notice must be replaced");
  assert.match(revised!.message.content, /已全部过期/);
  assert.doesNotMatch(revised!.message.content, /req-x/);
});

test("closed child or done task ⇒ nothing is injected, before or after queueing", async () => {
  const h = await harness();
  h.world.childReports(h.childId, "done");
  h.tick();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!.message.content, /t1（childId=.*）：已完成/);
  const set = await h.world.call("orchestrator_plan", { action: "set-status", taskId: "t1", status: "done" });
  assert.equal(set.isError, undefined, replyText(set));
  assert.match(h.deliver()!.message.content, /已全部过期/, "task done while queued");
  h.world.advance(600_000);
  h.tick();
  assert.equal(h.sent.length, 1, "a done task rings no more");

  const g = await harness();
  g.world.childReports(g.childId, "done");
  const closed = await g.world.call("orchestrator_close", { childId: g.childId });
  assert.equal(closed.isError, undefined, replyText(closed));
  g.tick();
  assert.equal(g.sent.length, 0, "a closed child is not supervised");
});

test("an orchestrator_wait in progress has the news to itself", async () => {
  const h = await harness();
  h.world.childAsks(h.childId, { requestId: "req-x", title: "q", options: ["a", "b"] });
  const end = h.world.deps.beginWait();
  h.tick();
  assert.equal(h.sent.length, 0);
  end();
  h.tick();
  assert.equal(h.sent.length, 1);
});

test("a notice lost to an abort does not silence supervision: agent_end frees the slot", async () => {
  const h = await harness();
  h.world.childAsks(h.childId, { requestId: "req-x", title: "q", options: ["a", "b"] });
  h.tick();
  h.agentEnd();
  h.world.advance(60_000);
  h.tick();
  assert.equal(h.sent.length, 2);
});
