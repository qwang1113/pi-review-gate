import test from "node:test";
import assert from "node:assert/strict";

import {
  registerJudgeRelayTools,
  type JudgeRelayChild,
  type JudgeRelayDispatch,
  type JudgeRelayDispatchRequest,
  type JudgeRelayToolDeps,
} from "../lib/judge-relay-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";

/**
 * These three tools used to live inside the 9000-line extension, where the
 * only way to exercise them was to spawn a real judge. They are now a lib/
 * module whose entire outside world arrives as `deps` — so every rule below
 * runs in microseconds against a fake, and a behavior change during the move
 * would have to survive an assertion instead of a reviewer's eyes.
 */

const ROOT = "/repo";

interface Fake {
  deps: JudgeRelayToolDeps;
  tools: Map<string, (params: Record<string, unknown>) => Promise<ToolReply>>;
  schemas: Map<string, { properties?: Record<string, unknown>; required?: string[] }>;
  order: string[];
  children: JudgeRelayChild[];
  calls: string[];
  dispatched: JudgeRelayDispatchRequest[];
  repo: { ok: boolean; error: string };
  dispatch: JudgeRelayDispatch;
}

function child(overrides: Partial<JudgeRelayChild> = {}): JudgeRelayChild {
  return {
    sessionId: "rg-reviewer-abc",
    role: "reviewer",
    title: "reviewer-1200",
    sessionDir: "/sessions/reviewer",
    stdoutPath: "/logs/stdout.log",
    ...overrides,
  };
}

/** A live process: `exitCode === null` is what `judgeProcessAlive` reads. */
function alive() {
  return { exitCode: null as number | null, pid: 4242 };
}

function fake(): Fake {
  const state: Fake = {
    deps: undefined as unknown as JudgeRelayToolDeps,
    tools: new Map(),
    schemas: new Map(),
    order: [],
    children: [],
    calls: [],
    dispatched: [],
    repo: { ok: true, error: "" },
    dispatch: { ok: true, reused: false, sessionId: "rg-reviewer-abc", sessionDir: "/sessions/reviewer", stdoutPath: "/logs/stdout.log" },
  };
  state.deps = {
    resolveRepo: (requested) => {
      state.calls.push(`resolveRepo(${requested ?? "-"})`);
      return state.repo.ok ? { ok: true, root: ROOT } : { ok: false, error: state.repo.error };
    },
    dispatchRound: (request) => {
      state.dispatched.push(request);
      return state.dispatch;
    },
    childByRole: (root, role) => {
      state.calls.push(`childByRole(${root},${role})`);
      return state.children.find((c) => c.role === role);
    },
    findChild: (root, role, sessionId) => {
      state.calls.push(`findChild(${root},${role ?? "-"},${sessionId ?? "-"})`);
      if (role) return state.children.find((c) => c.role === role);
      return state.children.find((c) => c.sessionId === sessionId);
    },
    childBySessionId: (sessionId) => {
      state.calls.push(`childBySessionId(${sessionId})`);
      return state.children.find((c) => c.sessionId === sessionId);
    },
    registerWatch: (sessionId, label) => { state.calls.push(`registerWatch(${sessionId},${label})`); },
  };
  const host: ToolHost = {
    registerTool: (definition) => {
      state.order.push(definition.name);
      state.schemas.set(definition.name, definition.parameters as unknown as { properties?: Record<string, unknown>; required?: string[] });
      state.tools.set(definition.name, (params) => definition.execute("id", params, undefined, undefined, undefined));
    },
  };
  registerJudgeRelayTools(host, state.deps);
  return state;
}

function textOf(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

async function call(f: Fake, tool: string, params: Record<string, unknown>): Promise<ToolReply> {
  const run = f.tools.get(tool);
  assert.ok(run, `${tool} must be registered`);
  return run(params);
}

test("the module registers exactly the three relay tools", () => {
  const f = fake();
  assert.deepEqual(f.order, ["review_spawn", "review_watch", "review_send"]);
});

test("the schemas are the ones the agent-facing contract documents", () => {
  const f = fake();
  const spawn = f.schemas.get("review_spawn");
  assert.deepEqual(Object.keys(spawn?.properties ?? {}), ["role", "title", "repo", "task", "fresh"]);
  // repo and fresh are the only optional half of the spawn contract: a round
  // without a role, a title or a task is not a round.
  assert.deepEqual(spawn?.required, ["role", "title", "task"]);
  const watch = f.schemas.get("review_watch");
  assert.deepEqual(Object.keys(watch?.properties ?? {}), ["sessionId", "label"]);
  assert.deepEqual(watch?.required, ["sessionId"]);
  const send = f.schemas.get("review_send");
  assert.deepEqual(Object.keys(send?.properties ?? {}), ["role", "sessionId", "text", "repo"]);
  assert.deepEqual(send?.required, ["text"]);
  // The role enum is ONE definition shared by the two tools that take it —
  // a second spelling is how they would silently start accepting different
  // roles.
  const roles = (spawn?.properties?.role as { enum?: string[] }).enum;
  assert.deepEqual(roles, ["reviewer", "adviser", "goal-auditor"]);
  assert.deepEqual((send?.properties?.role as { enum?: string[] }).enum, roles);
});

// ---------- review_spawn ----------

test("review_spawn: an unresolved repo is reported as the resolver worded it", async () => {
  const f = fake();
  f.repo = { ok: false, error: "review-gate: which repo?" };
  const reply = await call(f, "review_spawn", { role: "reviewer", title: "t", task: "do it" });
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: which repo?");
  assert.deepEqual(reply.details, {});
  assert.deepEqual(f.dispatched, [], "an unaddressed call never reaches the dispatch owner");
});

test("review_spawn: an unknown role is refused by name", async () => {
  const f = fake();
  const reply = await call(f, "review_spawn", { role: "fixer", title: "t", task: "do it" });
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), 'review-gate: review_spawn rejected — unknown role "fixer".');
  assert.deepEqual(reply.details, { spawned: false });
  assert.deepEqual(f.dispatched, []);
});

test("review_spawn: an empty task is refused before a process is started", async () => {
  const f = fake();
  const reply = await call(f, "review_spawn", { role: "reviewer", title: "t", task: "   " });
  assert.equal(reply.isError, true);
  assert.equal(
    textOf(reply),
    "review-gate: review_spawn rejected — the task text is empty. Write the task first, then pass it.",
  );
  assert.deepEqual(reply.details, { spawned: false });
  assert.deepEqual(f.dispatched, [], "an empty round is never dispatched");
});

test("review_spawn: a failed dispatch reports the owner's reason, and a missing one by default", async () => {
  const f = fake();
  f.dispatch = { ok: false, reused: false, error: "the judge process could not start" };
  const reply = await call(f, "review_spawn", { role: "adviser", title: "t", task: "do it" });
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: review_spawn failed — the judge process could not start");
  assert.deepEqual(reply.details, { spawned: false });

  const g = fake();
  g.dispatch = { ok: false, reused: false };
  const bare = await call(g, "review_spawn", { role: "adviser", title: "t", task: "do it" });
  assert.equal(textOf(bare), "review-gate: review_spawn failed — no child");
});

test("review_spawn: a NEW child reports its session dir and stdout, and the round's inputs reach the owner", async () => {
  const f = fake();
  f.children = [child({ title: "reviewer-1200" })];
  const reply = await call(f, "review_spawn", { role: "reviewer", title: "reviewer-1200", task: "review it", fresh: true, repo: "/repo" });
  assert.equal(reply.isError, undefined);
  const text = textOf(reply);
  assert.match(text, /^review-gate: reviewer child spawned as session rg-reviewer-abc \(reviewer-1200\)\./);
  assert.match(text, /- session dir: \/sessions\/reviewer \(transcript jsonl; resume = same session id\)/);
  assert.match(text, /- stdout: \/logs\/stdout\.log/);
  assert.match(text, /任务文本已随 spawn 传入\(@file\)；进程退出即完成，监听已自动注册，唤醒会作为新 turn 到达。/);
  assert.deepEqual(reply.details, {
    spawned: true,
    reused: false,
    sessionId: "rg-reviewer-abc",
    role: "reviewer",
    title: "reviewer-1200",
    sessionDir: "/sessions/reviewer",
    stdoutPath: "/logs/stdout.log",
    watching: true,
  });
  assert.deepEqual(f.dispatched, [{ root: ROOT, role: "reviewer", title: "reviewer-1200", task: "review it", fresh: true }]);
});

test("review_spawn: a REUSED session says the context carries over, and reports no fresh paths", async () => {
  const f = fake();
  f.dispatch = { ok: true, reused: true, sessionId: "rg-adviser-xyz" };
  f.children = [child({ role: "adviser", sessionId: "rg-adviser-xyz", title: "adviser-9" })];
  const reply = await call(f, "review_spawn", { role: "adviser", title: "adviser-9", task: "advise" });
  const text = textOf(reply);
  assert.match(text, /^review-gate: reusing existing adviser child session rg-adviser-xyz — context carries over across rounds\./);
  assert.match(text, /- 本轮任务已提交；进程退出即完成，监听已重新注册。/);
  assert.doesNotMatch(text, /session dir:/, "a reused session is not re-announced as a new child");
  assert.equal(reply.details?.spawned, false, "a reuse is not a spawn");
  assert.equal(reply.details?.reused, true);
  // The registry still answers the display title and the paths the dispatch
  // did not carry — that fallback is what keeps a reuse's details complete.
  assert.equal(reply.details?.title, "adviser-9");
  assert.equal(reply.details?.sessionDir, "/sessions/reviewer");
  assert.equal(reply.details?.watching, true);
});

test("review_spawn: without a title the role IS the title, and a dropped child falls back to it", async () => {
  const f = fake();
  f.children = [];
  const reply = await call(f, "review_spawn", { role: "goal-auditor", task: "audit" });
  assert.match(textOf(reply), /goal-auditor child spawned as session rg-reviewer-abc \(goal-auditor\)\./);
  assert.equal(f.dispatched[0]?.title, "goal-auditor");
  assert.equal(reply.details?.title, undefined, "no child on record ⇒ no title to report");
});

// ---------- review_watch ----------

test("review_watch: an empty session id is refused", async () => {
  const f = fake();
  const reply = await call(f, "review_watch", { sessionId: "  " });
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: review_watch rejected — the session id is empty.");
  assert.deepEqual(reply.details, { watching: false });
  assert.deepEqual(f.calls, [], "an unaddressed watch never touches the registry");
});

test("review_watch: an unknown or already-finished child cannot be watched", async () => {
  const f = fake();
  const unknown = await call(f, "review_watch", { sessionId: "rg-ghost" });
  assert.equal(unknown.isError, true);
  assert.equal(textOf(unknown), "review-gate: no LIVE judge child with session id rg-ghost — nothing to watch.");
  assert.deepEqual(unknown.details, { watching: false });

  // A watcher listens on a PROCESS exit: an exited child's event can never
  // arrive again, so registering one would wait forever.
  f.children = [child({ child: { exitCode: 0, pid: 7 } })];
  const dead = await call(f, "review_watch", { sessionId: "rg-reviewer-abc" });
  assert.equal(dead.isError, true);
  assert.equal(textOf(dead), "review-gate: no LIVE judge child with session id rg-reviewer-abc — nothing to watch.");
  assert.ok(!f.calls.some((c) => c.startsWith("registerWatch(")), "no watcher is registered for a dead child");
});

test("review_watch: a live child is watched, with the custom label or the session id", async () => {
  const f = fake();
  f.children = [child({ child: alive() })];
  const reply = await call(f, "review_watch", { sessionId: "rg-reviewer-abc", label: "round-9" });
  assert.equal(reply.isError, undefined);
  assert.equal(textOf(reply), "review-gate: watching rg-reviewer-abc — 进程退出时会主动唤醒本会话（无需轮询）。");
  assert.deepEqual(reply.details, { watching: true, sessionId: "rg-reviewer-abc" });
  assert.ok(f.calls.includes("registerWatch(rg-reviewer-abc,round-9)"));

  const g = fake();
  g.children = [child({ child: alive() })];
  await call(g, "review_watch", { sessionId: "rg-reviewer-abc", label: "   " });
  assert.ok(
    g.calls.includes("registerWatch(rg-reviewer-abc,rg-reviewer-abc)"),
    "a blank label falls back to the session id",
  );
});

// ---------- review_send ----------

test("review_send: an unaddressed message names the roles it accepts", async () => {
  const f = fake();
  const reply = await call(f, "review_send", { text: "answer" });
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: review_send needs a role (reviewer / adviser / goal-auditor).");
  assert.deepEqual(reply.details, { sent: false, sessionId: undefined });
  assert.ok("sessionId" in (reply.details ?? {}), "the failure carries every field the success path reports");
  assert.deepEqual(f.dispatched, []);
});

test("review_send: an empty message is refused before the repo is even resolved", async () => {
  const f = fake();
  const reply = await call(f, "review_send", { role: "reviewer", text: "   " });
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: review_send rejected — the message is empty.");
  assert.deepEqual(reply.details, { sent: false, sessionId: undefined });
  assert.deepEqual(f.calls, [], "nothing is looked up for a message that cannot be sent");
});

test("review_send: an unresolved repo is never guessed", async () => {
  const f = fake();
  f.repo = { ok: false, error: "review-gate: which repo?" };
  const reply = await call(f, "review_send", { role: "reviewer", text: "answer" });
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: which repo?");
  assert.deepEqual(reply.details, { sent: false, sessionId: undefined });
});

test("review_send: no child on record is reported by the address that was used", async () => {
  const f = fake();
  const byRole = await call(f, "review_send", { role: "adviser", text: "answer" });
  assert.equal(byRole.isError, true);
  assert.equal(textOf(byRole), "review-gate: no judge child on record for adviser.");
  assert.deepEqual(byRole.details, { sent: false, sessionId: undefined });

  const byId = await call(f, "review_send", { sessionId: "rg-ghost", text: "answer" });
  assert.equal(textOf(byId), "review-gate: no judge child on record for rg-ghost.");
});

test("review_send: a failed delivery is an error that still names the session", async () => {
  const f = fake();
  f.children = [child()];
  f.dispatch = { ok: false, reused: false, sessionId: "rg-reviewer-abc", error: "busy" };
  const reply = await call(f, "review_send", { role: "reviewer", text: "answer" });
  assert.equal(reply.isError, true);
  assert.equal(textOf(reply), "review-gate: review_send did not deliver — busy");
  assert.deepEqual(reply.details, { sent: false, sessionId: "rg-reviewer-abc" });

  const g = fake();
  g.children = [child()];
  g.dispatch = { ok: false, reused: false };
  const bare = await call(g, "review_send", { role: "reviewer", text: "answer" });
  assert.equal(textOf(bare), "review-gate: review_send did not deliver — the judge process could not start");
});

test("review_send: a resume goes through the dispatch owner, keeping role, title and stream", async () => {
  const f = fake();
  f.children = [child({ streamPath: "/streams/round-9.jsonl" })];
  const reply = await call(f, "review_send", { sessionId: "rg-reviewer-abc", text: "the answer" });
  assert.equal(reply.isError, undefined);
  assert.equal(textOf(reply), "review-gate: reviewer 已收到本轮消息（同一 session 续接，上下文保留）。");
  assert.deepEqual(reply.details, { sent: true, sessionId: "rg-reviewer-abc" });
  // A resume IS a dispatch under the same session id — the owner allocates a
  // FRESH run dir, which is what keeps judge_wait from reporting the PREVIOUS
  // round's verdict instantly.
  assert.deepEqual(f.dispatched, [{
    root: ROOT,
    role: "reviewer",
    title: "reviewer-1200",
    task: "the answer",
    streamPath: "/streams/round-9.jsonl",
  }]);
  assert.ok(f.calls.includes("findChild(/repo,-,rg-reviewer-abc)"), "the id addresses the child when no role is given");
});

test("review_send: a role wins over a session id", async () => {
  const f = fake();
  f.children = [child({ role: "adviser", sessionId: "rg-adviser-xyz", title: "adviser-9" })];
  f.dispatch = { ok: true, reused: true, sessionId: "rg-adviser-xyz" };
  const reply = await call(f, "review_send", { role: "adviser", sessionId: "rg-stale-id", text: "answer" });
  assert.equal(textOf(reply), "review-gate: adviser 已收到本轮消息（同一 session 续接，上下文保留）。");
  assert.ok(f.calls.includes("findChild(/repo,adviser,rg-stale-id)"), "both addresses reach the resolver, which prefers the role");
  assert.equal(f.dispatched[0]?.role, "adviser");
});
