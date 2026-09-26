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
 *    REAL `lib/channel-*.ts` — the records, the spill rule, the
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
  sanitizeScopeRecord,
  type TmuxScope,
  type TmuxScopeRecord,
} from "../../lib/session-tmux-scope.ts";
import { registerOrchestratorSessionTools } from "../../lib/orchestrator-session-tools.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "../../lib/orchestrator-deps.ts";
import { parsePlan, planHash, type OrchestratorPlan } from "../../lib/orchestrator-plan.ts";
import { beginApprovalLineage, snapshotApprovedPlan } from "../../lib/orchestrator-plan-approval.ts";
import { restatementHash, type RestatementRecord } from "../../lib/restatement.ts";
import type { DeliveryStation } from "../../lib/delivery-station.ts";

import { emptyRuntime, type OrchestratorRuntime } from "../../lib/orchestrator-registry.ts";
import { appendRecord, channelPathFor, type ChannelIO } from "../../lib/channel-io.ts";
import { projectChannel, readChannel } from "../../lib/channel-projection.ts";
import type { ChannelRecord, ChildReportedState } from "../../lib/channel-records.ts";
import type { SupervisionMemory } from "../../lib/orchestrator-supervisor.ts";
import type { AnnouncedRequest } from "../../lib/orchestrator-wait.ts";
import type { TaskMode } from "../../lib/task-mode.ts";
import { STATE_VARIANT_ENV } from "../../lib/gate-state-io.ts";
import { PREDECESSOR_PANE_ENV } from "../../lib/session-inheritance.ts";

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
  /**
   * The tmux SESSIONS and WINDOWS this world has (2026-09-25). A child is a
   * window of the opener's own session now, so a test asserts on these to pin
   * the topology — e.g. "the user's own window gained no pane".
   */
  sessions: Map<string, { owner: string; windows: Set<string> }>;
  windows: Map<string, { id: string; session: string; paneId: string; name?: string }>;
  /** What this session recorded about the tmux session it created. */
  scopeRecord: { value: TmuxScopeRecord | undefined };
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
  /**
   * How many times the runtime has been WRITTEN to that slot.
   *
   * A counter rather than an inspection of the value, because the two things a
   * test needs to tell apart are "the claim was made" and "the claim was
   * MADE DURABLE": `adoptOrchestrationId` changes the in-memory id and
   * `saveRuntime` is what a reload can still see, and both end up setting the
   * same variable here. (2026-09-17: attach adopted without persisting, so a
   * reload refused to resume the orchestration it had just taken over.)
   */
  runtimeWriteCount: () => number;
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
    topic?: "goal-approval" | "restatement" | "workspace" | "ask-user" | "plan-approval" | "scope-limit" | "sensitive-edit" | "tmux-access" | "other";
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
  /**
   * What each `orchestrator_close({worktree})` asked for, in order.
   *
   * The DECISION is the tool's whole contribution: it names `keep` / `merge` /
   * `discard` and hands the git work down. Recording it here is what makes the
   * settlement action — and the branches that refuse to take one — testable at
   * all (round-8 P1: the rule had no behavioural coverage).
   */
  settlements: Array<{ childId: string; settlement: string }>;
  /**
   * What a relay caused, in the order it happened: `release` (phase one of
   * the retirement), `pane-opened` (the successor's boot), `committed` (phase
   * two — this session going silent) or `rolledBack`.
   *
   * THE ORDER IS THE FIX, and it is invisible to a source grep: releasing
   * after the pane opens races the successor's boot, and going silent before
   * the relay record is persisted loses that record (persist() refuses to
   * write for a retired session).
   */
  handoffEvents: string[];

}


export interface FakeWorldOptions {
  taskMode?: TaskMode;
  plan?: OrchestratorPlan;
  /** Pre-approve the plan (the usual starting point for a spawn test). */
  approvePlan?: boolean;
  env?: Record<string, string>;
  contextPercent?: number;
  /**
   * This session's own pi session id — the input the tmux session name is
   * derived from (lib/session-tmux-scope.ts). Defaults to a UUIDv7-shaped id,
   * including its DASHES, because the derivation takes the id's alphanumeric
   * tail and a test should see the real shape.
   */
  sessionId?: string;
  /** Make `list-panes` fail, so liveness is UNKNOWN rather than false. */
  tmuxBroken?: boolean;
  /**
   * Make the successor's `split-window` fail, so the relay cannot start one.
   * The property it pins: a handoff that never happened must ROLL BACK — the
   * predecessor stays the holder instead of going silent with nobody behind
   * it (and, before the two-phase split, with its wake-up timers dead).
   */
  splitWindowFails?: boolean;
  /**
   * Make `split-window` THROW instead of returning `ok: false`.
   *
   * The injected tmux seam permits both, and the difference is not cosmetic:
   * phase one of a retirement has already released the worktree claim by the
   * time the pane is opened, so an escaping exception would leave a
   * half-retired predecessor nobody notices. The relay has to undo it on both
   * paths.
   */
  splitWindowThrows?: boolean;
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
   * Give this session the ability to isolate a second child in one repo
   * (2026-09-10).
   *
   * ABSENT is the more interesting case and the default: a real session can
   * lack it (an unwired host), and the spawner must then REFUSE the second
   * child rather than put two writers in one checkout. Set it and the fake
   * hands out `/repo-rg-<childId>` with a matching branch, exactly as
   * lib/orchestrator-worktree.ts derives them.
   */
  isolateChild?: boolean;
  /**
   * Make `settleWorktree` report a FAILED reclamation (`reclaimed: false`).
   *
   * The branch it opens is the one that decides whether the worktree record
   * survives — "forget it only when the checkout is really gone" — and with the
   * fake hardcoding `reclaimed: true` nothing could reach it (round-10 P1).
   */
  settleReclaimed?: boolean;
  /**
   * Isolate the child but wire NO settlement capability — the fail-closed
   * shape (round-9 P2).
   *
   * A real session can have the one and not the other (a partially wired
   * host), and the rule it protects is: a checkout nobody can settle must not
   * be created by a close that will then walk away from it. Without this
   * option the fake always supplies both, so that branch was unreachable.
   */
  isolateWithoutSettle?: boolean;
  /**
   * Repos a task's `repo` declaration may resolve to (default: none, so a
   * declared repo is refused — the fake's equivalent of "not a git root").
   */
  resolvableRepos?: string[];
  /**
   * WHERE `resolveTaskRepo` LANDS a declared repo, when that is not the same
   * path (round-2 P2). In production the resolver returns a `git
   * --show-toplevel`, so a plan naming a subdirectory or a symlinked path gets
   * a DIFFERENT string back — and the station ceiling is counted over the
   * plan's own key (lib/orchestrator-dispatch.ts). Without this map the fake
   * resolved every declared repo to itself, so declared and resolved could
   * never disagree and no test could catch the two being mixed up.
   */
  taskRepoAliases?: Record<string, string>;
  /** Answers the PM-pane `select` (grant door 3) gives, in order. */
  selectAnswers?: string[];
  /**
   * The branch a checkout is on, as `deps.currentBranch` answers it
   * (2026-09-18, A).
   *
   * ABSENT is the more interesting case and the default: a host with no git
   * wired, where the task book must fall back to the naming rule rather than
   * guess at a branch it never read.
   */
  currentBranch?: string;
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
  /**
   * THE TMUX SESSIONS AND WINDOWS (2026-09-25), modelled because they are now
   * what a child IS: `new-session` creates the opener's own session with the
   * first child in it, `new-window` adds the next one, `kill-window` frees it
   * and `kill-session` takes the lot. A window records the pane it holds, so a
   * test can assert the user's own window gained nothing.
   */
  const sessions = new Map<string, { owner: string; windows: Set<string>; env: Record<string, string> }>();
  const windows = new Map<string, { id: string; session: string; paneId: string; name?: string }>();
  let windowSeq = 0;
  const scopeRecord: { value: TmuxScopeRecord | undefined } = { value: undefined };
  const scope: TmuxScope = {
    sessionId: () => options.sessionId ?? "019fbb1d-9e78-7ebf-88bf-d104b8a270ed",
    repoRoot: () => "/repo",
    read: () => sanitizeScopeRecord(scopeRecord.value),
    write: (record) => { scopeRecord.value = record; },
    now: () => new Date(now()).toISOString(),
  };
  let runtime: OrchestratorRuntime = emptyRuntime(ORCHESTRATION_ID);
  /** What the DISK records, when that is somebody else's orchestration (B1). */
  let recordedOverride: OrchestratorRuntime | undefined = options.recordedRuntime;
  let runtimeWrites = 0;
  let planAudits = 0;
  const tmuxCalls: string[][] = [];
  const handoffEvents: string[] = [];
  /** Worktree settlements this session ran, in order. */
  const settlements: Array<{ childId: string; settlement: string }> = [];


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
  let activeWaits = 0;
  let announced: readonly AnnouncedRequest[] = [];
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
      runtimeWrites += 1;
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
    scope,
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
        ? { ok: true, root: options.taskRepoAliases?.[repo] ?? repo }
        : { ok: false, reason: `fake: "${repo}" 不是已知仓库` },
    ...(options.currentBranch === undefined ? {} : { currentBranch: () => options.currentBranch }),
    knownRepoRoots: () => ["/repo"],
    childJudgeRunning: () => false,
    channelIO: () => io,
    channelHome: () => "/home/test",
    supervisionMemory: () => memory,
    saveSupervisionMemory: (next) => { memory = next; },
    waitActive: () => activeWaits > 0,
    beginWait: () => {
      activeWaits += 1;
      return () => { activeWaits -= 1; };
    },
    announcedRequests: () => announced,
    saveAnnouncedRequests: (next) => { announced = next; },
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

    // No notifier in the fake world: the three events still call this and the
    // answer is the honest one ("nothing was sent, and here is why"), which
    // is exactly what a session without `terminal-notifier` sees.
    notifyUser: () => ({ status: "skipped" as const, note: "测试世界：没有通知通道" }),
    fileChars: () => 500,
    sessionTranscriptPath: () => "/tmp/transcript.jsonl",
    ...(options.isolateChild || options.isolateWithoutSettle
      ? {
          createWorktree: (repoRoot: string, childId: string) => ({
            ok: true as const,
            path: `${repoRoot}-rg-${childId}`,
            branch: `rg-child-${childId}`,
          }),
        }
      : {}),
    ...(options.isolateChild
      ? {
          // The settlement ACTION, recorded rather than executed: what the
          // tool owes the manager is the DECISION it passes down, and the git
          // sequence itself is lib/orchestrator-worktree.ts's (unit-tested).
          settleWorktree: (input: { childId: string; settlement: string }) => {
            settlements.push({ childId: input.childId, settlement: input.settlement });
            const reclaimed = options.settleReclaimed !== false;
            return {
              ok: true,
              reclaimed,
              text: reclaimed ? `fake: settled ${input.settlement}` : `fake: settled ${input.settlement}，但没能回收`,
            };
          },
        }
      : {}),
    // The predecessor's OWN id, which the successor carries as its proof of
    // heirship (lib/session-exclusivity.ts).
    ownSessionId: () => "session-under-test",
    // RETIREMENT, in two observable phases. The fake records the order rather
    // than asserting it: `release` has to precede the pane, `committed` has to
    // follow the persisted relay record.
    onHandoff: () => {
      handoffEvents.push("release");
      return {
        committed: () => { handoffEvents.push("committed"); },
        rolledBack: () => { handoffEvents.push("rolledBack"); },
      };
    },
  };

  function runFakeTmux(argv: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
    tmuxCalls.push([...argv]);
    const sub = argv[0];
    // Cosmetic writes (`select-pane -P`, `set -p @rg_label`, `setw
    // pane-border-*`) are the ones a spawn must survive losing —
    // `tmuxDecorFails` is how a test proves that. `set` is in the list since
    // 2026-09-22: the label moved to a pane user option, and leaving it out
    // would drop it into the catch-all failure below, so every fake world
    // would see a decoration failure it never asked for.
    //
    // `set -p` is the PANE option; `set -t <session> @…` is a SESSION option
    // (the ownership marker) and is handled below — hence the `-p` test.
    const decorative = sub === "select-pane" || sub === "setw" || (sub === "set" && argv.includes("-p"));
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
    if (sub === "list-sessions") {
      if (options.tmuxBroken) return { ok: false, stdout: "", stderr: "no server running" };
      return { ok: true, stdout: [...sessions.keys()].join("\n"), stderr: "" };
    }
    if (sub === "set") {
      // The ownership marker: `set -t <session> @rg_scope_owner <value>`.
      const target = String(argv[argv.indexOf("-t") + 1]);
      const session = sessions.get(target);
      if (!session) return { ok: false, stdout: "", stderr: `can't find session: ${target}` };
      // Other session options (pin, pid, pane) are separate slots on a real server.
      if (argv[argv.length - 2] === "@rg_scope_owner") session.owner = String(argv[argv.length - 1]);
      return { ok: true, stdout: "", stderr: "" };
    }
    // THE SESSION'S OWN ENVIRONMENT (2026-09-25). The gate reads it before it
    // REUSES a session and removes anything a previous build left there
    // (`healSessionEnv`): passing a child's environment through tmux `-e` put
    // the first child's identity in the session, every later window inherited
    // it, and a judge reported into the worker's channel. The fake models the
    // two calls so a test can drive that heal for real.
    if (sub === "show-environment") {
      const target = String(argv[argv.indexOf("-t") + 1]);
      const session = sessions.get(target);
      if (!session) return { ok: false, stdout: "", stderr: `can't find session: ${target}` };
      return {
        ok: true,
        stdout: Object.entries(session.env).map(([key, value]) => `${key}=${value}`).join("\n"),
        stderr: "",
      };
    }
    if (sub === "set-environment") {
      const target = String(argv[argv.indexOf("-t") + 1]);
      // `-g` writes the SERVER's environment (tmux ignores `-t` when `-g` is
      // given) — every session the user has. The gate refuses it at the argv
      // layer, and the fake refuses it too: a fake that modelled `-g` as a
      // session write would show green for a call that changes the user's
      // global environment (quality round P2, 2026-09-25).
      if (argv.includes("-g")) {
        return { ok: false, stdout: "", stderr: "fake tmux: -g is the user's global environment, not a session's" };
      }
      const session = sessions.get(target);
      if (!session) return { ok: false, stdout: "", stderr: `can't find session: ${target}` };
      const unset = argv.includes("-u");
      const key = String(argv[argv.length - (unset ? 1 : 2)]);
      if (unset) delete session.env[key];
      else session.env[key] = String(argv[argv.length - 1]);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (sub === "show-options") {
      const target = String(argv[argv.indexOf("-t") + 1]);
      const session = sessions.get(target);
      if (!session) return { ok: false, stdout: "", stderr: `can't find session: ${target}` };
      const owner = argv[argv.length - 1] === "@rg_scope_owner" ? session.owner : undefined;
      return { ok: true, stdout: owner ? `${owner}\n` : "", stderr: "" };
    }
    if (sub === "new-session" || sub === "new-window" || sub === "split-window") {
      if (options.splitWindowThrows) throw new Error(`fake tmux: ${String(sub)} blew up`);
      if (options.splitWindowFails) return { ok: false, stdout: "", stderr: "fake tmux: cannot create pane" };
      const id = `%${paneSeq++}`;
      const cwdAt = argv.indexOf("-c");
      const nameAt = argv.indexOf("-n");
      // The format element is searched by CONTAINS: the window builders print
      // `#{window_id} #{pane_id}` in one argv element, the relay prints
      // `#{pane_id}` alone. The command starts after whichever one it was.
      const marker = argv.findIndex((arg) => arg.includes("#{pane_id}"));
      const raw = marker >= 0 ? argv.slice(marker + 1).map(String) : [];
      // THE CHILD'S ENVIRONMENT RIDES ITS OWN COMMAND (`env K=V … pi`), never
      // tmux `-e` (2026-09-25): `new-session -e` writes the SESSION environment,
      // and every window opened later in that session inherited it — a judge
      // came up wearing the worker's identity and reported into the worker's
      // channel. The fake reads the shape the builders really send.
      const paneEnv: Record<string, string> = {};
      let command = raw;
      if (raw[0] === "env") {
        let i = 1;
        for (; i < raw.length; i++) {
          const token = raw[i]!;
          if (token === "-u") { i++; continue; } // a gate variable the child is NOT given
          if (!token.includes("=")) break;
          const [key, ...rest] = token.split("=");
          paneEnv[key!] = rest.join("=");
        }
        command = raw.slice(i);
      }
      panes.set(id, {
        id,
        command,
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
      // A RELAY pane is not a child: it carries the predecessor's pane id
      // instead of a state variant. Recorded as the boot line in the handoff
      // event stream, so a test can pin "release came first".
      if (paneEnv[PREDECESSOR_PANE_ENV] !== undefined) handoffEvents.push("pane-opened");
      if (sub === "split-window") return { ok: true, stdout: `${id}\n`, stderr: "" };
      // New session or new window: the session is named with `-s`, an added
      // window with `-t`, and BOTH print the window id first.
      const sessionName = sub === "new-session"
        ? String(argv[argv.indexOf("-s") + 1])
        : String(argv[argv.indexOf("-t") + 1]);
      if (sub === "new-session") {
        if (sessions.has(sessionName)) {
          panes.get(id)!.alive = false;
          return { ok: false, stdout: "", stderr: `duplicate session: ${sessionName}` };
        }
        sessions.set(sessionName, { owner: "", windows: new Set(), env: {} });
      } else if (!sessions.has(sessionName)) {
        panes.get(id)!.alive = false;
        return { ok: false, stdout: "", stderr: `can't find session: ${sessionName}` };
      }
      const windowId = `@${windowSeq++}`;
      windows.set(windowId, {
        id: windowId,
        session: sessionName,
        paneId: id,
        ...(nameAt >= 0 ? { name: String(argv[nameAt + 1]) } : {}),
      });
      sessions.get(sessionName)!.windows.add(windowId);
      return { ok: true, stdout: `${windowId} ${id}\n`, stderr: "" };
    }
    if (sub === "kill-window") {
      const target = String(argv[argv.indexOf("-t") + 1]);
      const windowId = target.includes(":") ? target.slice(target.indexOf(":") + 1) : target;
      const window = windows.get(windowId);
      if (!window) return { ok: false, stdout: "", stderr: `can't find window: ${windowId}` };
      windows.delete(windowId);
      const session = sessions.get(window.session);
      session?.windows.delete(windowId);
      const pane = panes.get(window.paneId);
      if (pane) pane.alive = false;
      // tmux reclaims a session whose last window is gone.
      if (session && session.windows.size === 0) sessions.delete(window.session);
      return { ok: true, stdout: "", stderr: "" };
    }
    if (sub === "kill-session") {
      const target = String(argv[argv.indexOf("-t") + 1]);
      const session = sessions.get(target);
      if (!session) return { ok: false, stdout: "", stderr: `can't find session: ${target}` };
      for (const windowId of session.windows) {
        const window = windows.get(windowId);
        if (window) {
          const pane = panes.get(window.paneId);
          if (pane) pane.alive = false;
          windows.delete(windowId);
        }
      }
      sessions.delete(target);
      return { ok: true, stdout: "", stderr: "" };
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
  // BOTH kinds used to be counted here for the label-bar release; that
  // decision is gone (2026-09-17, user decision), so the fake carries no
  // decoration bookkeeping at all — it just registers the tools.
  registerOrchestratorSessionTools(host, deps);

  const target = (childId: string) => ({ orchestrationId: ORCHESTRATION_ID, childId, home: "/home/test" });
  const stamp = () => new Date(now()).toISOString();

  return {
    tools,
    deps,
    panes,
    sessions,
    windows,
    scopeRecord,
    io,
    scratch,
    sidecars,
    shown,
    auditLog,
    adopted,
    confirmAnswers,
    options,
    saveRuntime: (next) => { runtimeWrites += 1; runtime = next; },
    runtimeWriteCount: () => runtimeWrites,
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
    handoffEvents,
    settlements,


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
