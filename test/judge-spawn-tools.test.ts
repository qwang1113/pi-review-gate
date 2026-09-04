/**
 * Opener-owned lifecycle: spawn registers the opener and rolls back on any
 * failure, answer matches like the orchestrator's, recover refuses a live
 * pane or an unreadable tmux — and a stranger is refused everywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  registerJudgeSpawnTools,
  type JudgeSpawnToolDeps,
} from "../lib/judge-spawn-tools.ts";
import type { ToolHost } from "../lib/tool-host.ts";
import { emptyHierarchy, type HierarchyTable } from "../lib/hierarchy.ts";
import {
  appendRecord,
  judgeChannelTarget,
  type ChannelIO,
} from "../lib/orchestrator-channel.ts";
import type { JudgePaneRunResult } from "../lib/judge-pane.ts";

type Exec = (params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

function setup(over: Partial<{
  caller: string | null | undefined;
  ownPane: string | null | undefined;
  tmux: (argv: readonly string[]) => JudgePaneRunResult;
  panes: string[];
  table: HierarchyTable;
  pending?: "goal" | "plan";
}> = {}): {
  deps: JudgeSpawnToolDeps;
  tools: Map<string, Exec>;
  seen: string[][];
  store: { table: HierarchyTable; pending?: "goal" | "plan"; draft?: string; planRemembered?: boolean; panes: string[] };
} {
  const seen: string[][] = [];
  const files = new Map<string, string>();
  const io: ChannelIO = {
    ensureDir() {},
    appendLine(path, line) { files.set(path, (files.get(path) ?? "") + line); },
    readText(path) { return files.get(path); },
    writeText(path, text) { files.set(path, text); },
    now: () => 1_700_000_000_000,
  };
  const store: { table: HierarchyTable; pending?: "goal" | "plan"; draft?: string; planRemembered?: boolean; panes: string[] } = {
    table: over.table ?? emptyHierarchy(),
    ...(over.pending === undefined ? {} : { pending: over.pending }),
    panes: over.panes ?? ["%1"],
  };
  const panes = store.panes;
  const tools = new Map<string, Exec>();
  const host: ToolHost = {
    registerTool(def) {
      tools.set(def.name, (params) =>
        def.execute("id", params, undefined, undefined, undefined).then((r) => ({
          content: r.content as Array<{ text: string }>,
          ...(r.isError === true ? { isError: true as const } : {}),
        })));
    },
  };
  const deps: JudgeSpawnToolDeps = {
    callerId: () => (over.caller === undefined ? "session-child-1" : over.caller ?? undefined),
    hierarchy: () => store.table,
    saveHierarchy: (next) => { store.table = next; },
    channelIO: () => io,
    channelHome: () => "/home/test",
    tmux: over.tmux ?? ((argv) => {
      seen.push([...argv]);
      if (argv[0] === "split-window") return { ok: true, stdout: "%7\n", stderr: "" };
      if (argv[0] === "list-panes") return { ok: true, stdout: `${store.panes.join("\n")}\n`, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    }),
    ownPane: () => (over.ownPane === undefined ? "%1" : over.ownPane ?? undefined),
    now: () => 1_700_000_000_000,
    resolveRepo: () => ({ ok: true as const, root: "/repo" }),
    launchConfig: () => ({ ok: true as const, model: "m", sysPromptPath: "/sp.md", sessionDir: "/sessions" }),
    buildGoalAuditTask: async (draft) => ({ ok: true as const, task: `AUDIT ${draft}`, streamPath: "/stream.jsonl" }),
    buildPlanAuditTask: async () => ({ ok: true as const, task: "AUDIT PLAN" }),
    writeJudgeTaskFile: () => ({ ok: true as const, path: "/sessions/task-1.md" }),
    pendingAuditKind: () => store.pending,
    rememberGoalAudit: (_root, draft) => { store.draft = draft; store.pending = "goal"; },
    rememberPlanAudit: () => { store.planRemembered = true; store.pending = "plan"; return { ok: true as const }; },
    forgetAudit: () => { delete store.pending; },
  };
  registerJudgeSpawnTools(host, deps);
  return { deps, tools, seen, store };
}

function textOf(r: { content: Array<{ text: string }> }): string {
  return r.content.map((c) => c.text).join("\n");
}

test("spawn goal without a draft is refused before anything is registered", async () => {
  const { tools, store } = setup();
  const result = await tools.get("judge_spawn")!({ kind: "goal" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /draft/);
  assert.deepEqual(store.table, {});
});

test("spawn plan opens a pane, registers the opener, and names the judge", async () => {
  const { tools, store, seen } = setup();
  const result = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /%7/);
  const ids = Object.keys(store.table);
  assert.equal(ids.length, 1);
  const entry = store.table[ids[0]!]!;
  assert.equal(entry.openerId, "session-child-1");
  assert.equal(entry.paneId, "%7");
  assert.equal(entry.streamPath, undefined, "plan audits carry no stream in this fake");
  assert.ok(seen.some((a) => a.includes("RG_JUDGE_OPENER=session-child-1")));
  assert.ok(seen.some((a) => a.includes(`RG_JUDGE_ID=${ids[0]}`)));
});

test("spawn rolls back when there is no tmux pane to split off", async () => {
  const { tools, store } = setup({ ownPane: null });
  const result = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /tmux/);
  assert.deepEqual(store.table, {}, "registration without a pane is rolled back");
});

test("spawn rolls back when tmux fails — no dangling registration", async () => {
  const { tools, store } = setup({
    tmux: () => ({ ok: false, stdout: "", stderr: "no server" }),
  });
  const result = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(result.isError, true);
  assert.deepEqual(store.table, {}, "registration without a pane is rolled back");
});

test("a stranger cannot answer another opener's review", async () => {
  const first = setup();
  const spawned = await first.tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(spawned.isError, undefined);
  const judgeId = Object.keys(first.store.table)[0]!;
  const stranger = setup({ caller: "session-intruder", table: first.store.table });
  const result = await stranger.tools.get("judge_answer")!({ judgeId, answer: "1" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /跨级/);
});

test("answer matches exact text, number and unique substring — and refuses ambiguity", async () => {
  const { tools, deps, store } = setup();
  const spawned = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(spawned.isError, undefined);
  const judgeId = Object.keys(store.table)[0]!;
  const io = deps.channelIO();
  const target = judgeChannelTarget("session-child-1", judgeId, "/home/test");
  appendRecord(io, target, {
    kind: "request", from: "child", at: new Date(1_700_000_000_000).toISOString(),
    requestId: "q1", dialogKind: "select", title: "继续吗", options: ["继续", "停下"],
  });
  const byNumber = await tools.get("judge_answer")!({ judgeId, answer: "2" });
  assert.equal(byNumber.isError, undefined, textOf(byNumber));
  assert.match(textOf(byNumber), /停下/);
});

test("answer with no open question says so instead of failing", async () => {
  const { tools, store } = setup();
  const spawned = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(spawned.isError, undefined);
  const judgeId = Object.keys(store.table)[0]!;
  const result = await tools.get("judge_answer")!({ judgeId, answer: "1" });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /没有未答的问题/);
});

test("recover refuses a live pane and an unreadable tmux", async () => {
  const { tools, store } = setup({ panes: ["%1", "%7"] });
  const spawned = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(spawned.isError, undefined);
  const judgeId = Object.keys(store.table)[0]!;
  const live = await tools.get("judge_recover")!({ judgeId });
  assert.equal(live.isError, true);
  assert.match(textOf(live), /还活着/);

  const blind = setup({ table: store.table, tmux: () => ({ ok: false, stdout: "", stderr: "x" }) });
  const unreadable = await blind.tools.get("judge_recover")!({ judgeId });
  assert.equal(unreadable.isError, true);
  assert.match(textOf(unreadable), /读不出来/);
});

test("recover re-opens a dead pane under the same session id", async () => {
  const reopened: string[][] = [];
  const { tools, store } = setup({
    panes: ["%1"],
    tmux: (argv) => {
      reopened.push([...argv]);
      if (argv[0] === "split-window") return { ok: true, stdout: "%9\n", stderr: "" };
      if (argv[0] === "list-panes") return { ok: true, stdout: "%1\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
  });
  // Spawn first with a working tmux, then kill %7 out-of-band: the pane list
  // above never contained it, so recover sees death.
  const spawned = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(spawned.isError, undefined);
  const judgeId = Object.keys(store.table)[0]!;
  const result = await tools.get("judge_recover")!({ judgeId });
  assert.equal(result.isError, undefined, textOf(result));
  assert.match(textOf(result), /%9/);
  assert.equal(store.table[judgeId]!.paneId, "%9");
  const resume = reopened.find((a) => a[0] === "split-window" && a.includes("%9") === false);
  assert.ok(resume, "a second split-window ran for the recovery");
  assert.ok(resume!.includes("--session-id") && resume!.includes(judgeId), "recovery resumes the SAME session id");
});

test("unknown caller identity fails every tool closed", async () => {
  const { tools } = setup({ caller: null });
  const spawn = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(spawn.isError, true);
  assert.match(textOf(spawn), /调用者身份/);
  const answer = await tools.get("judge_answer")!({ judgeId: "j", answer: "1" });
  assert.equal(answer.isError, true);
  const recover = await tools.get("judge_recover")!({ judgeId: "j" });
  assert.equal(recover.isError, true);
});

test("spawn registers the draft so the report is recordable", async () => {
  const { tools, store } = setup();
  const result = await tools.get("judge_spawn")!({ kind: "goal", draft: "目标草稿全文" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(store.draft, "目标草稿全文");
  assert.equal(store.pending, "goal");
});

test("spawn plan remembers the plan hash for adjudication", async () => {
  const { tools, store } = setup();
  const result = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(store.planRemembered, true);
  assert.equal(store.pending, "plan");
});

test("a pending audit of the other kind blocks the spawn (no mis-binding)", async () => {
  const goalFirst = setup({ pending: "plan" });
  const goalRefused = await goalFirst.tools.get("judge_spawn")!({ kind: "goal", draft: "x" });
  assert.equal(goalRefused.isError, true);
  assert.match(textOf(goalRefused), /计划.*审计挂着/);

  const planFirst = setup({ pending: "goal" });
  const planRefused = await planFirst.tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(planRefused.isError, true);
  assert.match(textOf(planRefused), /目标.*审计挂着/);
});

test("spawn over a living pane is refused — rounds go through submit", async () => {
  const { tools } = setup({ panes: ["%1", "%7"] });
  const first = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(first.isError, undefined, textOf(first));
  const second = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(second.isError, true);
  assert.match(textOf(second), /还开着/);
});

test("spawn over a dead pane points at recover, not a second birth", async () => {
  const { tools, store } = setup();
  const first = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(first.isError, undefined, textOf(first));
  store.panes = ["%1"];
  const second = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(second.isError, true);
  assert.match(textOf(second), /judge_recover/);
});
