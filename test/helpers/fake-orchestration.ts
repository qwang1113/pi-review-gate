/**
 * A FAKE ORCHESTRATION — panes, plans and the supervision CHANNEL, simulated
 * well enough to drive the real tools end to end with no tmux and no pi.
 *
 * WHY THIS EXISTS. The round before last shipped the orchestration layer with
 * 1867 green unit tests and it deadlocked on the first hop of the first real
 * run: every defect lived in the seam between a decision and the world, and
 * none of them is visible to a test that stubs `tmux()` as "returns ok". So
 * this fake models the PROTOCOL rather than the calls.
 *
 * WHAT CHANGED (2026-08-30). The old fake simulated a TERMINAL — a screen, a
 * typed input buffer, a highlighted dialog row, arrow keys moving it — because
 * that was the interface the orchestrator had. That interface is gone, and so
 * is all of that machinery. What is left is much smaller and much closer to
 * the real thing:
 *
 *  - tmux does three things (`split-window`, `kill-pane`, `list-panes`) and a
 *    pane is just an id plus the argv it was started with, because that is
 *    genuinely all the orchestrator asks of it now;
 *  - the CHANNEL is an in-memory {@link ChannelIO} over a `Map`, driving the
 *    REAL `lib/orchestrator-channel.ts` — the records, the spill rule, the
 *    projection and the classifier are all the production code;
 *  - a fake CHILD is a few lines that append real records to that channel, so
 *    a test says "the child reported waiting-input" instead of drawing a box.
 *
 * It is deliberately NOT a mock library: tests assert on observable state
 * (what is in the channel, what the plan says, which task file was written),
 * not on which functions were called.
 */

import assert from "node:assert/strict";

import { registerOrchestratorStateTools } from "../../lib/orchestrator-tools.ts";
import { registerOrchestratorSessionTools } from "../../lib/orchestrator-session-tools.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "../../lib/orchestrator-deps.ts";
import { parsePlan, planHash, type OrchestratorPlan } from "../../lib/orchestrator-plan.ts";
import { snapshotApprovedPlan } from "../../lib/orchestrator-plan-approval.ts";

import { emptyRuntime, type OrchestratorRuntime } from "../../lib/orchestrator-registry.ts";
import {
  appendRecord,
  channelPathFor,
  projectChannel,
  readChannel,
  type ChannelIO,
  type ChannelRecord,
  type ChildReportedState,
} from "../../lib/orchestrator-channel.ts";
import type { SupervisionMemory } from "../../lib/orchestrator-supervisor.ts";
import type { TaskMode } from "../../lib/task-mode.ts";
import { STATE_VARIANT_ENV } from "../../lib/gate-state.ts";

/** Fixed clock so ids and timestamps are reproducible. */
export const NOW = 1_700_000_000_000;

/** One simulated pane: an id and what it was started with. Nothing renders. */
export interface FakePane {
  id: string;
  /** The argv the pane was started with (empty for the orchestrator's own). */
  command: string[];
  cwd?: string;
  env: Record<string, string>;
  alive: boolean;
}

/** An in-memory filesystem for the channel. Real records, no disk. */
export function memoryChannelIO(now: () => number): ChannelIO & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    ensureDir() { /* directories are implicit in a map */ },
    appendLine(path, line) {
      files.set(path, (files.get(path) ?? "") + line);
    },
    readText(path) {
      return files.get(path);
    },
    writeText(path, text) {
      files.set(path, text);
    },
    now,
  };
}

/** The whole fake world one test runs against. */
export interface FakeWorld {
  /** Tools registered by the modules under test, by name. */
  tools: Map<string, (params: Record<string, unknown>, signal?: { readonly aborted: boolean }) => Promise<ToolReply>>;
  deps: OrchestratorDeps;
  panes: Map<string, FakePane>;
  io: ChannelIO & { files: Map<string, string> };
  runtime: () => OrchestratorRuntime;
  plan: () => OrchestratorPlan | undefined;
  /** Scratch files the gate wrote (task documents, recovery notes). */
  scratch: Map<string, string>;
  /** Child gate sidecars, keyed by cwd. */
  sidecars: Map<string, Record<string, unknown>>;
  /** Answers the fake user/orchestrator dialog will give, in order. */
  confirmAnswers: boolean[];
  /** Everything `showToUser` printed. */
  shown: string[];
  now: () => number;
  advance: (ms: number) => void;
  /** Append a record to a child's channel AS THAT CHILD would. */
  childReports: (childId: string, state: ChildReportedState, extra?: Record<string, unknown>) => void;
  childAsks: (childId: string, request: {
    requestId: string;
    title: string;
    options: string[];
    payload?: string;
    topic?: "goal-approval" | "workspace" | "ask-user" | "plan-approval" | "other";
  }) => void;
  childSettles: (childId: string, requestId: string, by: "human" | "orchestrator" | "dismissed") => void;
  childAcks: (
    childId: string,
    instructId: string,
    delivered: boolean,
    detail?: string,
    /** Which half of the handshake — omit for the legacy "injected" shape. */
    stage?: "received" | "injected",
  ) => void;

  /** Everything currently on a child's channel. */
  channelOf: (childId: string) => ChannelRecord[];
  call: (name: string, params?: Record<string, unknown>) => Promise<ToolReply>;
  /** How many times the plan pre-audit was dispatched. */
  planAudits: () => number;
  /** Every tmux argv the gate ran, in order — the decoration lives in here. */
  tmuxCalls: string[][];

}


export interface FakeWorldOptions {
  taskMode?: TaskMode;
  plan?: OrchestratorPlan;
  /** Pre-approve the plan (the usual starting point for a spawn test). */
  approvePlan?: boolean;
  env?: Record<string, string>;
  contextPercent?: number;
  /** Make `list-panes` fail, so liveness is UNKNOWN rather than false. */
  tmuxBroken?: boolean;
  /**
   * Whether a spawned child's gate "boots and reports" (the default, and what
   * a healthy child does on its first `turn_end`). Set false to test the
   * F8 case: a pane opened, but nothing proves the session ever started.
   */
  autoReport?: boolean;
  /**
   * Make the plan pre-audit BLOCK, with this text as the refusal.
   *
   * Set it and `submit` must hand the text back without ever calling
   * `confirm` — "a failed audit shows no dialog" is the property, and the
   * only way to test it is to be able to fail one.
   */
  planAuditFails?: string;
  /**
   * Make every COSMETIC tmux write fail (`select-pane`, `setw`).
   *
   * The property it proves: a spawn must survive losing its decoration. A
   * session that works with a plain border beats a refused session with a
   * pretty one.
   */
  tmuxDecorFails?: boolean;
  /**
   * Repos a task's `repo` declaration may resolve to (default: none, so a
   * declared repo is refused — the fake's equivalent of "not a git root").
   */
  resolvableRepos?: string[];

}


const ORCHESTRATION_ID = "orch-deadbeef-abc";

/** Build the world and register the real tools against it. */
export function makeFakeWorld(options: FakeWorldOptions = {}): FakeWorld {
  let clock = NOW;
  const now = () => clock;
  const io = memoryChannelIO(now);
  const panes = new Map<string, FakePane>([
    ["%0", { id: "%0", command: [], env: {}, alive: true }],
  ]);
  let paneSeq = 1;
  let runtime: OrchestratorRuntime = emptyRuntime(ORCHESTRATION_ID);
  let planAudits = 0;
  const tmuxCalls: string[][] = [];


  let plan: OrchestratorPlan | undefined = options.plan;
  if (plan && options.approvePlan) {
    const hash = planHash(plan);
    // A real approval records WHAT was approved, not just its hash — that
    // snapshot is what lets a later narrowing edit skip the dialog, so a fake
    // approval without it would test a world that cannot happen.
    runtime = {
      ...runtime,
      approvedPlanHash: hash,
      approvedPlanAt: new Date(NOW).toISOString(),
      approvedPlan: snapshotApprovedPlan(plan, hash, new Date(NOW).toISOString()),
    };
  }

  const scratch = new Map<string, string>();
  const sidecars = new Map<string, Record<string, unknown>>();
  const shown: string[] = [];
  const confirmAnswers: boolean[] = [];
  let memory: SupervisionMemory = {};
  const paneDecor = new Map<string, { title: string; at: number }>();

  const env: Record<string, string> = { TMUX_PANE: "%0", ...(options.env ?? {}) };

  const tools = new Map<
    string,
    (params: Record<string, unknown>, signal?: { readonly aborted: boolean }) => Promise<ToolReply>
  >();
  const host: ToolHost = {
    registerTool(definition) {
      tools.set(definition.name, (params, signal) =>
        definition.execute(`test-${definition.name}`, params, signal, undefined, undefined));
    },
  };

  const deps: OrchestratorDeps = {
    repoRoot: "/repo",
    now,
    env: () => env as unknown as NodeJS.ProcessEnv,
    taskMode: () => options.taskMode ?? "orchestrator",
    runtime: () => runtime,
    saveRuntime: (next) => { runtime = next; },
    readPlan: () => (plan ? { plan, problems: [] } : { problems: [] }),
    savePlan: (next) => { plan = next; },
    tmux: (argv) => runFakeTmux(argv),
    ownPane: () => env.TMUX_PANE,
    confirm: async () => confirmAnswers.shift() ?? false,
    showToUser: (title, text) => { shown.push(`${title}\n${text}`); },
    writeScratchFile: (name, content) => {
      const path = `/tmp/rg-scratch/${name}`;
      scratch.set(path, content);
      return { ok: true, path };
    },
    childGateState: (cwd) => sidecars.get(cwd),
    sleep: async () => { /* the fake has no latency */ },
    resolveTaskRepo: (repo) =>
      options.resolvableRepos?.includes(repo)
        ? { ok: true, root: repo }
        : { ok: false, reason: `fake: "${repo}" 不是已知仓库` },
    knownRepoRoots: () => ["/repo"],
    childJudgeRunning: () => false,
    channelIO: () => io,
    channelHome: () => "/home/test",
    supervisionMemory: () => memory,
    saveSupervisionMemory: (next) => { memory = next; },
    paneDecorMemory: () => paneDecor,

    contextPercent: () => options.contextPercent,
    // The plan pre-audit is a judge PROCESS in production; the fake answers
    // from a canned verdict so a protocol test can drive both branches (a PASS
    // opens the dialog, a FAIL must open nothing at all).
    auditPlan: async () => {
      planAudits += 1;
      return options.planAuditFails
        ? { ok: false as const, text: options.planAuditFails }
        : { ok: true as const };
    },

    emitNotification: () => true,
    fileChars: () => 500,
    sessionTranscriptPath: () => "/tmp/transcript.jsonl",
  };

  function runFakeTmux(argv: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
    tmuxCalls.push([...argv]);
    const sub = argv[0];
    // Cosmetic writes (`select-pane -P/-T`, `setw pane-border-*`) are the ones
    // a spawn must survive losing — `tmuxDecorFails` is how a test proves that.
    const decorative = sub === "select-pane" || sub === "setw";
    if (decorative) {
      return options.tmuxDecorFails
        ? { ok: false, stdout: "", stderr: "fake tmux: refused a cosmetic option" }
        : { ok: true, stdout: "", stderr: "" };
    }

    if (sub === "list-panes") {
      if (options.tmuxBroken) return { ok: false, stdout: "", stderr: "no server running" };
      const live = [...panes.values()].filter((p) => p.alive).map((p) => p.id);
      return { ok: true, stdout: live.join("\n"), stderr: "" };
    }
    if (sub === "split-window") {
      const id = `%${paneSeq++}`;
      const cwdAt = argv.indexOf("-c");
      const paneEnv: Record<string, string> = {};
      for (let i = 0; i < argv.length - 1; i++) {
        if (argv[i] === "-e") {
          const [key, ...rest] = String(argv[i + 1]).split("=");
          paneEnv[key!] = rest.join("=");
        }
      }
      const marker = argv.indexOf("#{pane_id}");
      panes.set(id, {
        id,
        command: marker >= 0 ? argv.slice(marker + 1).map(String) : [],
        ...(cwdAt >= 0 ? { cwd: String(argv[cwdAt + 1]) } : {}),
        env: paneEnv,
        alive: true,
      });
      // A healthy child's gate boots and reports on its own channel; that is
      // the ONLY thing that proves to the spawner that the session started
      // (F8). `autoReport: false` is the failure case.
      const spawnedChildId = paneEnv[STATE_VARIANT_ENV];
      if (options.autoReport !== false && spawnedChildId) {
        appendRecord(io, { orchestrationId: ORCHESTRATION_ID, childId: spawnedChildId, home: "/home/test" }, {
          kind: "state", from: "child", at: new Date(now()).toISOString(), state: "working",
          sessionId: `rg-child-${spawnedChildId}`,
        });
      }
      return { ok: true, stdout: `${id}\n`, stderr: "" };
    }
    if (sub === "kill-pane") {
      const target = String(argv[argv.indexOf("-t") + 1]);
      const pane = panes.get(target);
      if (pane) pane.alive = false;
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `fake tmux: unsupported ${String(sub)}` };
  }

  registerOrchestratorStateTools(host, deps);
  registerOrchestratorSessionTools(host, deps);

  const target = (childId: string) => ({ orchestrationId: ORCHESTRATION_ID, childId, home: "/home/test" });
  const stamp = () => new Date(now()).toISOString();

  return {
    tools,
    deps,
    panes,
    io,
    scratch,
    sidecars,
    shown,
    confirmAnswers,
    now,
    advance: (ms) => { clock += ms; },
    runtime: () => runtime,
    plan: () => plan,
    childReports: (childId, state, extra = {}) => {
      appendRecord(io, target(childId), {
        kind: "state", from: "child", at: stamp(), state, ...extra,
      } as ChannelRecord);
    },
    childAsks: (childId, request) => {
      appendRecord(io, target(childId), {
        kind: "request",
        from: "child",
        at: stamp(),
        requestId: request.requestId,
        dialogKind: "select",
        ...(request.topic ? { topic: request.topic } : {}),
        title: request.title,
        options: request.options,
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      });
      appendRecord(io, target(childId), {
        kind: "state", from: "child", at: stamp(), state: "waiting-input", dialogTitle: request.title,
      });
    },
    childSettles: (childId, requestId, by) => {
      appendRecord(io, target(childId), { kind: "request-settled", from: "child", at: stamp(), requestId, by });
    },
    childAcks: (childId, instructId, delivered, detail, stage) => {
      appendRecord(io, target(childId), {
        kind: "instruct-ack", from: "child", at: stamp(), instructId, delivered,
        ...(stage === undefined ? {} : { stage }),
        ...(detail === undefined ? {} : { detail }),
      });
    },

    channelOf: (childId) =>
      readChannel(io, channelPathFor(ORCHESTRATION_ID, childId, "/home/test")).records,
    call: async (name, params = {}) => {
      const run = tools.get(name);
      assert.ok(run, `tool ${name} is not registered`);
      return run!(params);
    },
    planAudits: () => planAudits,
    tmuxCalls,


  };
}

/** A minimal two-task plan, both tasks touching different files. */
export function twoTaskPlan(): OrchestratorPlan {
  const parsed = parsePlan({
    title: "测试计划",
    intent: "两个互不重叠的任务",
    tasks: [
      { id: "t1", title: "任务一", fileBoundaries: ["lib/a/"] },
      { id: "t2", title: "任务二", fileBoundaries: ["lib/b/"] },
    ],
  });
  assert.ok(parsed.plan, `plan fixture must parse: ${parsed.problems.join("; ")}`);
  return parsed.plan!;
}

/** The text a tool reply carries. */
export function replyText(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

/** What is still outstanding on a child's channel. */
export function projectionOf(world: FakeWorld, childId: string) {
  return projectChannel(world.channelOf(childId));
}
