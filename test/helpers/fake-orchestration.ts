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
import {
  registerOrchestratorSessionTools,
  type OrchestratorSessionDeps,
} from "../../lib/orchestrator-session-tools.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "../../lib/orchestrator-deps.ts";
import { parsePlan, planHash, type OrchestratorPlan } from "../../lib/orchestrator-plan.ts";
import { beginApprovalLineage, snapshotApprovedPlan } from "../../lib/orchestrator-plan-approval.ts";
import { restatementHash, type RestatementRecord } from "../../lib/restatement.ts";
import type { DeliveryStation } from "../../lib/delivery-station.ts";

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
  tools: Map<string, (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolReply>>;
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
  /** The options the world was built with (selectAnswers included). */
  options: FakeWorldOptions;
  /** Replace the runtime (used to pre-seed a grant). */
  saveRuntime: (next: OrchestratorRuntime) => void;
  /** Everything `showToUser` printed. */
  shown: string[];
  /** Every line the tools wrote to the repo's audit log (B2). */
  auditLog: string[];
  /** Orchestration ids adopted through a takeover (B1). */
  adopted: string[];
  now: () => number;
  advance: (ms: number) => void;
  /** Append a record to a child's channel AS THAT CHILD would. */
  childReports: (childId: string, state: ChildReportedState, extra?: Record<string, unknown>) => void;
  childAsks: (childId: string, request: {
    requestId: string;
    title: string;
    options: string[];
    payload?: string;
    /** The delivery station this question is about (restatement / goal). */
    station?: string;
    topic?: "goal-approval" | "restatement" | "workspace" | "ask-user" | "plan-approval" | "sensitive-edit" | "other";
    /** Its place in an `ask_user` interview, when it is part of one. */
    batch?: { id: string; index: number; total: number };

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
   * The orchestration runtime RECORDED ON DISK (B1). Set it to one carrying
   * a DIFFERENT id than the session holds to build the takeover situation:
   * an old project manager's registry left behind in the sidecar.
   */
  recordedRuntime?: OrchestratorRuntime;
  /** Channel directory names the gate will discover (one per orchestration). */
  channelDirs?: string[];
  /**
   * How many REVIEW panes this manager's window currently shows.
   *
   * The window's label bar is released by the last decorated pane of ANY kind,
   * so a manager closing its last child while a review is still open must not
   * take it down (the review's border would blank).
   */
  judgePanes?: number;
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
   * Simulate the IDENTITY conflict: the sidecar holds another orchestration's
   * runtime while this session minted its own id. `runtimeConflict()` then
   * returns that foreign id and every spawn must refuse.
   */
  identityConflict?: string;
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
  /** Answers the PM-pane `select` (grant door 3) gives, in order. */
  selectAnswers?: string[];
  /**
   * The requirement restatement `submit` requires (2026-09-06).
   *
   * DEFAULT: a confirmed one — the world models a manager that already did
   * the step, which is what every pre-existing plan test is about. Pass
   * `null` for the world where nothing was restated, and `submit` must refuse
   * without ever calling `confirm`.
   */
  restatement?: RestatementRecord | null;

}

/** The confirmed restatement a world has unless a test says otherwise. */
export function fakeRestatement(station: DeliveryStation = "precommit"): RestatementRecord {
  const text = [
    "需求反述：把项目经理对需求的理解说回给用户确认。",
    "举例：用户要求「提交前先反述」，这轮就把反述做成门禁的前置步骤。",
    "改之前：submit 直接派审计。",
    "改之后：submit 先查已确认的反述，没有就直接拒。",
    "哪几步会变得不同：submit 前多一步 propose_restatement。",
  ].join("\n");
  return { text, hash: restatementHash(text), at: "2026-09-06T00:00:00.000Z", station };
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
  /** What the DISK records, when that is somebody else's orchestration (B1). */
  let recordedOverride: OrchestratorRuntime | undefined = options.recordedRuntime;
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
      // …and the LINEAGE the real `submit` starts, so a world can model
      // taking a widening back (an approval without it could not).
      approvedPlanHistory: beginApprovalLineage(hash),
    };
  }

  const scratch = new Map<string, string>();
  const sidecars = new Map<string, Record<string, unknown>>();
  const shown: string[] = [];
  const auditLog: string[] = [];
  /** Ids this session ADOPTED through `orchestrator_attach` (B1). */
  const adopted: string[] = [];
  const confirmAnswers: boolean[] = [];
  let memory: SupervisionMemory = {};
  const paneDecor = new Map<string, { title: string; at: number }>();

  const env: Record<string, string> = { TMUX_PANE: "%0", ...(options.env ?? {}) };

  const tools = new Map<
    string,
    (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolReply>
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
    restatement: () => (options.restatement === null ? undefined : options.restatement ?? fakeRestatement()),
    runtime: () => runtime,
    runtimeConflict: () => options.identityConflict,
    // B1 — what the DISK records, which may name ANOTHER orchestration than
    // the one this session holds. Defaults to "the same", i.e. no takeover
    // situation at all.
    //
    // FAITHFUL ON WRITES: in production `recordedRuntime()` and
    // `saveRuntime()` are the same slot (`state.orchestrator`), so persisting
    // a runtime REPLACES what the disk records. A fake that kept answering
    // with the old record would make "the archive cleared the registry"
    // untestable — the assertion would pass whether or not the code did it.
    recordedRuntime: () => recordedOverride ?? runtime,
    channelDirNames: () => options.channelDirs ?? [],
    adoptOrchestrationId: (id) => {
      adopted.push(id);
      // FAITHFUL to lib/orchestrator-wiring.ts: once the ids match, `runtime()`
      // returns the STORED runtime — that inheritance of the previous holder's
      // child registry is the entire point of a takeover, and a fake that only
      // renamed our own empty runtime would test nothing.
      const recorded = recordedOverride;
      runtime = recorded && recorded.orchestrationId === id
        ? recorded
        : { ...runtime, orchestrationId: id };
    },
    archivePlan: (relPath, contents) => {
      // Faithful to the real writer: the archive lands, THEN the plan goes.
      scratch.set(`/repo/${relPath}`, contents);
      plan = undefined;
      return { ok: true, path: `/repo/${relPath}` };
    },
    saveRuntime: (next) => {
      runtime = next;
      // The write LANDED on the one slot the disk has: whatever another
      // orchestration had recorded there is now this.
      recordedOverride = undefined;
    },
    // The audit log the extension appends to `.pi/review-gate-audit.log`.
    // Collected in memory here so a test can assert WHAT was recorded (B2).
    log: (message) => { auditLog.push(message); },
    readPlan: () => (plan ? { plan, problems: [] } : { problems: [] }),
    savePlan: (next) => { plan = next; },
    tmux: (argv) => runFakeTmux(argv),
    ownPane: () => env.TMUX_PANE,
    // ONE dialog stub for the whole template (2026-09-08): every approval and
    // consent dialog is an askChoice now, so a test says which ROW it wants.
    // `confirmAnswers` keeps its old meaning (true ⇒ the first option); the
    // sensitive-edit grant door is recognized by its own row text and consumes
    // `selectAnswers` as before.
    askChoice: async (spec) => {
      if (spec.options.some((option) => option.includes("允许并记住"))) {
        return options.selectAnswers?.shift();
      }
      return (confirmAnswers.shift() ?? false) ? spec.options[0] : undefined;
    },
    showToUser: (title, text) => { shown.push(`${title}\n${text}`); },
    writeTaskFile: (name, content, repoRoot) => {
      const path = `${repoRoot ?? "/repo"}/.pi/tasks/${name}`;
      scratch.set(path, content);
      return { ok: true, path };
    },
    childGateState: (cwd) => sidecars.get(cwd),
    sleep: async () => { /* the fake has no latency */ },
    resolveTaskRepo: (repo) =>
      (options.resolvableRepos ?? ["/repo"]).includes(repo)
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
  // A manager's window holds review panes too, and the label-bar release counts
  // BOTH kinds. The real wiring reads the judge registry; a test just says how
  // many are on screen. Attached to the SAME deps object the tools were given —
  // a spread copy would freeze every other field at registration time, and
  // tests swap `channelIO` afterwards.
  (deps as OrchestratorSessionDeps).decoratedJudgePanes = () => options.judgePanes ?? 0;
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
    auditLog,
    adopted,
    confirmAnswers,
    options,
    saveRuntime: (next) => { runtime = next; },
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
        ...(request.station === undefined ? {} : { station: request.station }),
        ...(request.batch === undefined ? {} : {
          batchId: request.batch.id,
          batchIndex: request.batch.index,
          batchTotal: request.batch.total,
        }),

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
      { id: "t1", title: "任务一" },
      { id: "t2", title: "任务二" },
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
