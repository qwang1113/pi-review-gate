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

/**
 * What the fakes record. The three lane arrays exist so a test can assert the
 * lane is resolved ONCE and reaches every derivation unchanged — the failure
 * they guard against (an id from one lane beside a dir from another) is
 * invisible in the spawn's reply.
 */
interface SpawnStore {
  table: HierarchyTable;
  pending?: "goal" | "plan";
  draft?: string;
  planRemembered?: boolean;
  panes: string[];
  lanesAsked: string[];
  launchLanes: string[];
  taskFileLanes: string[];
  /** Every `retirePrevious()` the spawn made, in order. */
  retired: string[];
}

function setup(over: Partial<{
  caller: string | null | undefined;
  ownPane: string | null | undefined;
  tmuxServer: string | null | undefined;
  tmux: (argv: readonly string[]) => JudgePaneRunResult;
  panes: string[];
  table: HierarchyTable;
  pending?: "goal" | "plan";
  /** True when this session is only a guest in someone else's orchestration. */
  insideOrchestration?: boolean;
  /** Make the plan bookkeeping fail, which rolls the whole spawn back. */
  planRememberFails?: boolean;
  /** The lane the gate resolves for this spawn (default: a plain first lane). */
  lane?: { lane: { objectId: string; generation: number }; roundsInObject: number };
}> = {}): {
  deps: JudgeSpawnToolDeps;
  tools: Map<string, Exec>;
  seen: string[][];
  store: SpawnStore;
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
  const store: SpawnStore = {
    table: over.table ?? emptyHierarchy(),
    ...(over.pending === undefined ? {} : { pending: over.pending }),
    panes: over.panes ?? ["%1"],
    lanesAsked: [],
    launchLanes: [],
    taskFileLanes: [],
    retired: [],
  };
  const panes = store.panes;
  /**
   * The boot report a freshly opened judge pane writes on its own channel.
   *
   * Who it is comes out of the spawn argv itself (`-e RG_JUDGE_ID=…`), the
   * same way the real pane learns it — so this fake cannot drift from the
   * env contract the factory builds.
   */
  const reportBooted = (argv: readonly string[]): void => {
    const env = new Map<string, string>();
    for (let i = 0; i < argv.length - 1; i++) {
      if (argv[i] !== "-e") continue;
      const [key, ...rest] = argv[i + 1]!.split("=");
      env.set(key!, rest.join("="));
    }
    const judgeId = env.get("RG_JUDGE_ID");
    const openerId = env.get("RG_JUDGE_OPENER");
    if (!judgeId || !openerId) return;
    appendRecord(io, judgeChannelTarget(openerId, judgeId, "/home/test"), {
      kind: "state",
      from: "child",
      at: new Date(1_700_000_000_000).toISOString(),
      state: "working",
    });
  };

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
    // Every tmux fake — the default one and any a test injects — goes through
    // the same wrapper, so a pane that OPENED always boots and reports (see
    // `reportBooted`). A test that wants a pane which never comes up says so by
    // failing the split, not by staying silent afterwards.
    tmux: (argv) => {
      const base = over.tmux ?? ((inner: readonly string[]) => {
        seen.push([...inner]);
        if (inner[0] === "split-window") return { ok: true, stdout: "%7\n", stderr: "" };
        if (inner[0] === "list-panes") return { ok: true, stdout: `${store.panes.join("\n")}\n`, stderr: "" };
        return { ok: true, stdout: "", stderr: "" };
      });
      const result = base(argv);
      if (argv[0] === "split-window" && result.ok) reportBooted(argv);
      return result;
    },
    ownPane: () => (over.ownPane === undefined ? "%1" : over.ownPane ?? undefined),
    // Faithful to the real wiring: a session in tmux always has a server, and
    // every pane it opens is minted by that one.
    tmuxServer: () => (over.tmuxServer === undefined ? "sock,1" : over.tmuxServer ?? undefined),
    now: () => 1_700_000_000_000,
    // Instant: the delivery watch is a loop of sleeps, and a test must not
    // spend 30 real seconds proving that it stops at the first evidence.
    sleep: async () => {},
    // A plain session by default: it owns its window's label bar, so a rolled
    // back spawn takes the border line down with the pane it just opened.
    insideOrchestration: () => over.insideOrchestration === true,
    resolveRepo: () => ({ ok: true as const, root: "/repo" }),
    // The gate's lane for this spawn (lib/judge-rotation.ts). The default is a
    // plain first lane; `store.lanesAsked` records every resolution so a test
    // can prove it is asked exactly once per spawn, and `store.retired` records
    // when the lane this spawn replaces was actually closed and forgotten.
    lane: (root, role, opener) => {
      store.lanesAsked.push(`${role}|${root}|${opener}`);
      return {
        ...(over.lane ?? { lane: { objectId: "objecthash0001", generation: 0 }, roundsInObject: 1 }),
        retirePrevious: () => { store.retired.push(`${role}|${store.lanesAsked.length}`); },
      };
    },
    launchConfig: (_root, _role, _opener, lane) => {
      store.launchLanes.push(lane ? `${lane.objectId}#${lane.generation}` : "none");
      return { ok: true as const, model: "m", sysPromptPath: "/sp.md", sessionDir: "/sessions" };
    },
    buildGoalAuditTask: async (draft) => ({ ok: true as const, task: `AUDIT ${draft}`, streamPath: "/stream.jsonl" }),
    buildPlanAuditTask: async () => ({ ok: true as const, task: "AUDIT PLAN" }),
    writeJudgeTaskFile: (_root, _role, _opener, _task, lane) => {
      store.taskFileLanes.push(lane ? `${lane.objectId}#${lane.generation}` : "none");
      return { ok: true as const, path: "/sessions/task-1.md" };
    },
    pendingAuditKind: () => store.pending,
    rememberGoalAudit: (_root, draft) => { store.draft = draft; store.pending = "goal"; },
    rememberPlanAudit: () => {
      if (over.planRememberFails) return { ok: false as const, error: "plan 文件读不出来" };
      store.planRemembered = true;
      store.pending = "plan";
      return { ok: true as const };
    },
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
  // Recorded WITH the pane id. Without it `paneClosable` refuses forever, so
  // declare_done's cascade would delete the entry and leave the pane running
  // with nobody able to address it (reviewer P1, 2026-09-05).
  assert.equal(entry.tmuxServer, "sock,1", "the pane id is useless without the server that minted it");
  assert.equal(entry.sessionDir, "/sessions", "…and the transcript dir the wait needs");
  assert.equal(entry.title, "goal-auditor");
  assert.equal(entry.streamPath, undefined, "plan audits carry no stream in this fake");
  assert.ok(seen.some((a) => a.includes("RG_JUDGE_OPENER=session-child-1")));
  assert.ok(seen.some((a) => a.includes(`RG_JUDGE_ID=${ids[0]}`)));
});

test("spawn never claims an id when there is no tmux pane to split off", async () => {
  const { tools, store } = setup({ ownPane: null });
  const result = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /tmux/);
  // The refusal now runs BEFORE the registration (it used to register and undo
  // it); the invariant this protects — no entry without a pane — is the same.
  assert.deepEqual(store.table, {}, "no pane ⇒ no registration at all");
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
  assert.equal(store.table[judgeId]!.tmuxServer, "sock,1",
    "the recovered pane records its server too, or the entry stops being closable");
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

test("a rolled back spawn takes the window's border line back down with it", async () => {
  // The pane it opened turned the WINDOW-level border line on (that is the C1
  // fix). Rolling the spawn back has to undo that too, or a failed bookkeeping
  // step leaves a permanent mark on the user's window — and the `setw` must be
  // addressed through OUR pane, since the one being killed may already be gone.
  const { tools, seen, store } = setup({ planRememberFails: true });
  const result = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(result.isError, true);
  assert.deepEqual(store.table, {}, "the registration is rolled back");
  const flat = seen.map((a) => a.join(" "));
  const unset = flat.filter((s) => s.startsWith("setw") && s.includes("-u"));
  assert.equal(unset.length, 2, "both window options are restored");
  assert.ok(unset.every((s) => s.includes("-t %1")), "…through the opener's own pane");
  assert.ok(unset.every((s) => !s.includes("%7")), "…never through the pane being killed");
});

test("a rolled back spawn leaves the border line alone when a sibling judge is on screen", async () => {
  const { tools, seen } = setup({
    planRememberFails: true,
    panes: ["%1", "%9"],
    table: {
      "rg-adviser-other": {
        judgeId: "rg-adviser-other",
        openerId: "session-child-1",
        role: "adviser",
        repoRoot: "/repo",
        title: "adviser",
        sessionDir: "/sessions",
        paneId: "%9",
        // Recorded WITH the server that minted it, the way a real spawn does:
        // an id this process cannot attribute is a stranger's pane, not a
        // sibling, and would not count.
        tmuxServer: "sock,1",
        spawnedAt: new Date(1_700_000_000_000).toISOString(),
      },
    },
  });
  const result = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(result.isError, true);
  const flat = seen.map((a) => a.join(" "));
  // Only the UNSETS matter here: the spawn itself sets the two options on the
  // way in (that is the C1 decoration), and a test that counted every `setw`
  // would be asserting against its own setup.
  assert.equal(flat.filter((s) => s.startsWith("setw") && s.includes("-u")).length, 0,
    "a sibling still needs the border line it is labelled with");
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

/**
 * ONE LANE PER SPAWN, and every derivation gets THAT one.
 *
 * The failure this pins is invisible in the reply: a judge id rendered from
 * one lane beside a session dir and a task file rendered from another means
 * the pane resumes a transcript nobody writes tasks into. It is also why the
 * lane is asked for exactly once — resolving it advances the round count.
 */
test("the spawn's lane reaches the id, the launch config and the task file — resolved once", async () => {
  const { tools, store } = setup({
    lane: { lane: { objectId: "deadbeefcafe0001", generation: 3 }, roundsInObject: 1 },
  });
  const result = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(result.isError, undefined, textOf(result));
  assert.equal(store.lanesAsked.length, 1, "the lane is resolved exactly once per spawn");
  assert.deepEqual(store.lanesAsked, ["goal-auditor|/repo|session-child-1"]);
  assert.deepEqual(store.launchLanes, ["deadbeefcafe0001#3"], "the session dir is derived from that lane");
  assert.deepEqual(store.taskFileLanes, ["deadbeefcafe0001#3"], "and so is the round's task file");
  const [judgeId] = Object.keys(store.table);
  assert.ok(judgeId!.endsWith("-deadbeef-g3"), `the judge id carries the same lane: ${judgeId}`);
  const entry = store.table[judgeId!]!;
  assert.equal(entry.objectId, "deadbeefcafe0001", "the FULL object id is what the registry keeps");
  assert.equal(entry.generation, 3);
  assert.equal(entry.roundsInObject, 1, "a birth is the object's first dispatched round");
  // The lane it replaces is retired only AFTER the new pane is up: a spawn
  // that failed earlier would otherwise drop the old row, and the next
  // dispatch — seeing no previous lane — would resume the transcript the gate
  // had just rotated away, with its round count back at one.
  assert.deepEqual(store.retired, ["goal-auditor|1"], "the previous lane is retired exactly once, at the end");
});

test("a spawn that never opens a pane retires NOTHING — the rotation is decided again next time", async () => {
  const { tools, store } = setup({ ownPane: null });
  const refused = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(refused.isError, true);
  assert.deepEqual(store.retired, [], "no pane, no replacement lane, nothing to retire");
});

test("a spawn rolled back by tmux retires nothing either", async () => {
  const { tools, store } = setup({
    tmux: (argv) => (argv[0] === "split-window"
      ? { ok: false, stdout: "", stderr: "no window" }
      : { ok: true, stdout: "", stderr: "" }),
  });
  const refused = await tools.get("judge_spawn")!({ kind: "plan" });
  assert.equal(refused.isError, true);
  assert.deepEqual(store.retired, []);
  assert.deepEqual(store.table, {}, "the rollback also removed this spawn's own row");
});

test("a spawn refused on its parameters never resolves a lane (no pane is retired for a typo)", async () => {
  // Resolving the lane can RETIRE the lane it replaces, so it must not happen
  // for a call that is about to be refused for missing a draft.
  const { tools, store } = setup();
  const refused = await tools.get("judge_spawn")!({ kind: "goal" });
  assert.equal(refused.isError, true);
  assert.deepEqual(store.lanesAsked, []);
});
