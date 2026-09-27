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
  renderer(type: string): ((message: unknown) => unknown) | undefined;
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
    registerMessageRenderer: (type: string, renderer: (message: unknown) => unknown) => { renderers.set(type, renderer); },
  };
  const renderers = new Map<string, (message: unknown) => unknown>();
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
    renderer: (type: string) => renderers.get(type),
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

// ---- D43: the answered-but-unsettled window, and the screen half ----

test("D43: a notice for a question the manager ANSWERED, before the child settled it, is dropped on delivery", async () => {
  // Measured (a1, 2026-09-26 23:32:19): answer .260, notice entered the
  // context .270, request-settled .416 — the check read "open" as "not settled".
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { appendRecord, nodeChannelIO } = await import("../lib/channel-io.ts");
  const { superviseChildren } = await import("../lib/orchestrator-supervisor.ts");
  const { noticeFactsFrom } = await import("../lib/orchestration-notice.ts");
  const home = mkdtempSync(join(tmpdir(), "notice-d43-"));
  const io = nodeChannelIO();
  const at = Date.parse("2026-09-26T23:32:19.270Z");
  const binding = { orchestrationId: "orch-d43", childId: "t-acc-x", home };
  const write = (record: Record<string, unknown>) => appendRecord(io, binding, record as never);
  write({ kind: "state", from: "child", at: "2026-09-26T23:31:54.000Z", state: "waiting-input" });
  write({ kind: "request", from: "child", at: "2026-09-26T23:31:54.604Z", requestId: "req-d43", dialogKind: "select", topic: "restatement", title: "理解对了吗？", options: ["A", "B"] });
  const children = [{ id: "t-acc-x", taskId: "t-acc", paneId: "%7", cwd: home }] as never;
  const read = () => superviseChildren({ orchestrationId: "orch-d43", children, livePanes: new Set(["%7"]), io, home, at });
  const carried: NoticeEvent = { childId: "t-acc-x", state: "waiting-input", requestId: "req-d43", summary: "t-acc 在等回答" };

  assert.equal(freshNoticeEvents([carried], noticeFactsFrom(read(), [])).length, 1, "still unanswered ⇒ delivered");
  write({ kind: "answer", from: "orchestrator", at: "2026-09-26T23:32:19.260Z", requestId: "req-d43", answer: "A" });
  assert.deepEqual(freshNoticeEvents([carried], noticeFactsFrom(read(), [])), [], "answered, not yet settled ⇒ stale");
});

test("D43: the notice on SCREEN re-reads the message, so the delivery rewrite reaches the pixels", async () => {
  const { liveNoticeComponent } = await import("../lib/orchestration-notice.ts");
  const message = { content: "[ORCHESTRATION] 子会话需要你：\n- 旧" };
  let builds = 0;
  const view = liveNoticeComponent(message, (text) => { builds += 1; return { render: () => text.split("\n"), invalidate() {} }; });
  assert.deepEqual(view.render(80), ["[ORCHESTRATION] 子会话需要你：", "- 旧"]);
  view.render(80);
  assert.equal(builds, 1, "unchanged content is not rebuilt every frame");
  // pi's `_replaceMessageInPlace`: same object, new content.
  message.content = [{ type: "text", text: noticeText([]) }] as never;
  assert.deepEqual(view.render(80), [noticeText([])]);
  assert.equal(builds, 2);
});

test("D43: the host renders ONLY notices live; every other review-gate message keeps pi's default look", async () => {
  const h = await harness();
  const render = h.renderer("review-gate");
  assert.ok(render, "a renderer is registered for the notice's customType");
  const notice = { role: "custom", customType: "review-gate", content: "x", details: { kind: NOTICE_KIND, events: [] } };
  const theme = { bg: (_k: string, t: string) => t, fg: (_k: string, t: string) => t };
  const renderer = render as (m: unknown, o: unknown, t: unknown) => unknown;
  // pi's components load lazily; wait for them.
  for (let i = 0; i < 100 && renderer(notice, {}, theme) === undefined; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(renderer({ ...notice, details: { kind: "other" } }, {}, theme), undefined, "non-notices keep the default look");

  // pi's OWN width rules: every row fits, emoji included (⏳ ⌚ ⏰ overflowed a hand-rolled table).
  const { initTheme } = await import("@earendil-works/pi-coding-agent");
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  initTheme();
  const message = { ...notice, content: "[ORCHESTRATION] 子会话需要你：⏳⌚⏰🚀✅ h1 的 tmux 授权请求在等回答" };
  const view = renderer(message, {}, theme) as { render(w: number): string[] };
  for (const width of [8, 20, 60]) {
    const rows = view.render(width);
    assert.ok(rows.every((l) => visibleWidth(l) <= width), `${width}: ${JSON.stringify(rows)}`);
  }
  assert.ok(view.render(60).join("\n").includes("子会话需要你"));
  message.content = "已全部过期";
  assert.ok(view.render(60).join("\n").includes("已全部过期"), "the screen follows the in-place rewrite");
});
