/**
 * A FAKE ORCHESTRATION — tmux, panes, child sessions and the attention queue,
 * simulated well enough to drive the real tools end to end.
 *
 * WHY THIS EXISTS. The previous round shipped the orchestration layer with
 * 1867 green unit tests and it deadlocked on the first hop of the first real
 * run. Every one of the fourteen defects lived in the seam between a decision
 * and the world: the task text was typed into a pane and truncated, the Enter
 * that would have submitted it was never sent, the receipt said "delivered"
 * anyway, and the waiter treated somebody else's event as news. Not one of
 * those is visible to a test that stubs `tmux()` as "returns ok".
 *
 * So this fake models the PROTOCOL instead of the calls:
 *
 *  - a pane is a little state machine with a screen, an input buffer and an
 *    optional dialog, and it only changes when a plausible tmux command
 *    arrives (`send-keys -l` types, `send-keys Enter` submits, arrow keys move
 *    a highlight);
 *  - `capture-pane` renders that state the way pi actually renders it —
 *    `"→ "` for the selected row and `"  "` for the others, verified against
 *    the installed pi bundle;
 *  - a child only "starts" if it was launched with something to do, so a
 *    spawn that forgets the task cannot pass;
 *  - the attention queue is a real queue with addressed events, so a waiter
 *    that ignores the address can be caught doing it.
 *
 * It is deliberately NOT a mock library: tests assert on observable state
 * (what is on the screen, what the plan says, which task file was written),
 * not on which functions were called.
 */

import assert from "node:assert/strict";

import { registerOrchestratorStateTools } from "../../lib/orchestrator-tools.ts";
import { registerOrchestratorSessionTools } from "../../lib/orchestrator-session-tools.ts";
import { registerOrchestratorReadTools } from "../../lib/orchestrator-read-tools.ts";
import type { OrchestratorDeps, ToolHost, ToolReply } from "../../lib/orchestrator-deps.ts";
import { parsePlan, planHash, type OrchestratorPlan } from "../../lib/orchestrator-plan.ts";
import { emptyRuntime, type OrchestratorRuntime } from "../../lib/orchestrator-registry.ts";
import type { AttentionEvent } from "../../lib/attention.ts";
import type { TaskMode } from "../../lib/task-mode.ts";

/** Fixed clock so ids and timestamps are reproducible. */
export const NOW = 1_700_000_000_000;

/** One simulated pane. */
export interface FakePane {
  id: string;
  /** Lines already "printed" into the pane. */
  printed: string[];
  /** Text typed but not yet submitted (what `send-keys -l` accumulates). */
  buffer: string;
  /** The open choice dialog, if any. */
  dialog?: { title: string; options: string[]; selected: number };
  /** The argv the pane was started with (empty for the orchestrator's own). */
  command: string[];
  alive: boolean;
}

export interface FakeOrchestrationOptions {
  taskMode?: TaskMode;
  plan?: OrchestratorPlan;
  approved?: boolean;
  ownPane?: string;
  env?: NodeJS.ProcessEnv;
  notificationsWork?: boolean;
  orchestrationId?: string;
  /**
   * A spawned pane comes up as a running pi session. Set false to simulate the
   * F8 failure: the pane exists and nothing ever started in it.
   */
  childStarts?: boolean;
  /** `list-panes` fails — liveness becomes UNKNOWN (F14). */
  tmuxBroken?: boolean;
  /** Scratch writes fail (disk full, read-only /tmp…). */
  scratchBroken?: boolean;
}

export interface FakeOrchestration {
  call(name: string, params?: Record<string, unknown>): Promise<ToolReply>;
  deps: OrchestratorDeps;
  tmuxCalls: string[][];
  worktrees: string[];
  removed: string[];
  confirmAnswers: boolean[];
  emitted: string[];
  /** Everything handed to `showToUser` (the transcript, O-1). */
  shown: string[];
  /** name → content of every scratch file written. */
  scratch: Map<string, string>;
  /** Events waiting to be consumed, oldest first. */
  attention: AttentionEvent[];
  panes: Map<string, FakePane>;
  /** cwd|variant → the child's own sidecar contents. */
  sidecars: Map<string, Record<string, unknown>>;
  plan(): OrchestratorPlan | undefined;
  runtime(): OrchestratorRuntime;
  setEnv(env: NodeJS.ProcessEnv): void;
  setTmuxBroken(broken: boolean): void;
  /** Open a dialog in a pane, as a child session would. */
  openDialog(paneId: string, title: string, options: string[], selected?: number): void;
  /** The pane vanishes (crash, or the user closed it). */
  killPane(paneId: string): void;
  /** Queue an attention event addressed to `to`. */
  pushAttention(event: Partial<AttentionEvent> & { toSessionId: string }): void;
  setSidecar(cwd: string, variant: string | undefined, state: Record<string, unknown>): void;
  render(paneId: string): string;
}

/** Render a pane the way pi renders one (see the header). */
function renderPane(pane: FakePane): string {
  const lines = [...pane.printed];
  if (pane.dialog) {
    lines.push(pane.dialog.title);
    pane.dialog.options.forEach((option, i) => {
      lines.push(`${i === pane.dialog!.selected ? "→ " : "  "}${option}`);
    });
  }
  if (pane.buffer) lines.push(`> ${pane.buffer}`);
  return lines.join("\n");
}

export function fakeOrchestration(options: FakeOrchestrationOptions = {}): FakeOrchestration {
  const tools = new Map<string, (params: Record<string, unknown>, signal?: { aborted: boolean }) => Promise<ToolReply>>();
  const host: ToolHost = {
    registerTool(def) {
      tools.set(def.name, (params, signal) =>
        def.execute("id", params, signal ?? { aborted: false }, undefined, undefined));
    },
  };

  const orchestrationId = options.orchestrationId ?? "orch-abc-1";
  let plan = options.plan;
  let runtime: OrchestratorRuntime = emptyRuntime(orchestrationId);
  if (options.approved && plan) {
    runtime = { ...runtime, approvedPlanHash: planHash(plan), approvedPlanAt: new Date(NOW).toISOString() };
  }
  let env = options.env ?? ({} as NodeJS.ProcessEnv);
  let tmuxBroken = options.tmuxBroken ?? false;
  const childStarts = options.childStarts ?? true;
  const ownPane = options.ownPane ?? "%1";

  const panes = new Map<string, FakePane>();
  panes.set(ownPane, { id: ownPane, printed: ["orchestrator"], buffer: "", command: [], alive: true });

  const tmuxCalls: string[][] = [];
  const worktrees: string[] = [];
  const removed: string[] = [];
  const confirmAnswers: boolean[] = [];
  const emitted: string[] = [];
  const shown: string[] = [];
  const scratch = new Map<string, string>();
  const attention: AttentionEvent[] = [];
  const sidecars = new Map<string, Record<string, unknown>>();
  let nextPane = 2;

  const sidecarKey = (cwd: string, variant?: string): string => `${cwd}|${variant ?? ""}`;

  /** Apply one key to a pane, exactly as a TUI would. */
  function pressKey(pane: FakePane, key: string): void {
    if (pane.dialog) {
      const size = pane.dialog.options.length;
      if (key === "Up") pane.dialog.selected = (pane.dialog.selected - 1 + size) % size;
      else if (key === "Down") pane.dialog.selected = (pane.dialog.selected + 1) % size;
      else if (key === "Enter") {
        pane.printed.push(`answered: ${pane.dialog.options[pane.dialog.selected]}`);
        delete pane.dialog;
      } else if (key === "Escape") {
        pane.printed.push("dialog dismissed");
        delete pane.dialog;
      }
      return;
    }
    if (key === "Enter" && pane.buffer) {
      pane.printed.push(`> ${pane.buffer}`);
      pane.buffer = "";
    }
  }

  const deps: OrchestratorDeps = {
    repoRoot: "/repo",
    now: () => NOW,
    env: () => env,
    taskMode: () => options.taskMode ?? "orchestrator",
    runtime: () => runtime,
    saveRuntime: (next) => { runtime = next; },
    readPlan: () => ({ plan, problems: [] }),
    savePlan: (next) => { plan = next; },
    tmux: (argv) => {
      tmuxCalls.push([...argv]);
      const [sub] = argv;
      if (sub === "list-panes") {
        if (tmuxBroken) return { ok: false, stdout: "", stderr: "no server running" };
        const alive = [...panes.values()].filter((p) => p.alive).map((p) => p.id);
        return { ok: true, stdout: alive.join("\n"), stderr: "" };
      }
      if (sub === "split-window") {
        const id = `%${nextPane++}`;
        const dashDash = argv.indexOf("#{pane_id}");
        const command = argv.slice(dashDash + 1);
        // A pane only LOOKS like a running pi session when it was actually
        // given something to run — this is what makes an F8-style spawn
        // (pane opened, nothing started) observable instead of assumed.
        const printed = childStarts && command.length > 0
          ? [`pi ${command.slice(1).join(" ")}`, "Context 2% · esc to interrupt"]
          : [];
        panes.set(id, { id, printed, buffer: "", command, alive: true });
        return { ok: true, stdout: `${id}\n`, stderr: "" };
      }
      if (sub === "capture-pane") {
        const target = argv[argv.indexOf("-t") + 1]!;
        const pane = panes.get(target);
        if (!pane || !pane.alive) return { ok: false, stdout: "", stderr: "can't find pane" };
        return { ok: true, stdout: renderPane(pane), stderr: "" };
      }
      if (sub === "send-keys") {
        const target = argv[argv.indexOf("-t") + 1]!;
        const pane = panes.get(target);
        if (!pane || !pane.alive) return { ok: false, stdout: "", stderr: "can't find pane" };
        const literal = argv.indexOf("-l");
        if (literal !== -1) {
          pane.buffer += argv.slice(literal + 1).join(" ");
          return { ok: true, stdout: "", stderr: "" };
        }
        for (const key of argv.slice(argv.indexOf("-t") + 2)) pressKey(pane, key);
        return { ok: true, stdout: "", stderr: "" };
      }
      if (sub === "kill-pane") {
        const target = argv[argv.indexOf("-t") + 1]!;
        const pane = panes.get(target);
        if (!pane) return { ok: false, stdout: "", stderr: "can't find pane" };
        pane.alive = false;
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    ownPane: () => ownPane,
    confirm: async () => confirmAnswers.shift() ?? false,
    showToUser: (title, text) => { shown.push(`${title}\n${text}`); },
    writeScratchFile: (name, content) => {
      if (options.scratchBroken) return { ok: false, error: "read-only file system" };
      scratch.set(name, content);
      return { ok: true, path: `/tmp/rg-orchestration/tasks/${name}` };
    },
    childGateState: (cwd, variant) => sidecars.get(sidecarKey(cwd, variant)),
    sleep: async () => {},
    addWorktree: (name) => {
      const path = `/tmp/wt/${name}`;
      worktrees.push(path);
      return { ok: true, path };
    },
    removeWorktree: (path) => { removed.push(path); },
    consumeAttention: () => {
      const index = attention.findIndex((e) => e.toSessionId === orchestrationId && !e.handledAt);
      if (index === -1) return undefined;
      const event = { ...attention[index]!, handledAt: new Date(NOW).toISOString() };
      attention[index] = event;
      return event;
    },
    branchFacts: () => ({ mergeSettled: true, mergeWaived: false }),
    emitNotification: (sequence) => {
      emitted.push(sequence);
      return options.notificationsWork ?? true;
    },
    fileChars: () => 1000,
    sessionTranscriptPath: () => "/sessions/self.jsonl",
  };

  registerOrchestratorStateTools(host, deps);
  registerOrchestratorSessionTools(host, deps);
  registerOrchestratorReadTools(host, deps);

  return {
    async call(name, params = {}) {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} must be registered`);
      return tool(params, params.__signal as { aborted: boolean } | undefined);
    },
    deps,
    tmuxCalls,
    worktrees,
    removed,
    confirmAnswers,
    emitted,
    shown,
    scratch,
    attention,
    panes,
    sidecars,
    plan: () => plan,
    runtime: () => runtime,
    setEnv: (next) => { env = next; },
    setTmuxBroken: (broken) => { tmuxBroken = broken; },
    openDialog: (paneId, title, opts, selected = 0) => {
      const pane = panes.get(paneId);
      assert.ok(pane, `pane ${paneId} must exist`);
      pane.dialog = { title, options: opts, selected };
    },
    killPane: (paneId) => {
      const pane = panes.get(paneId);
      if (pane) pane.alive = false;
    },
    pushAttention: (event) => {
      attention.push({
        id: `evt-${attention.length + 1}`,
        fromSessionId: "child-session",
        repo: "/repo",
        reason: "等待回答提问",
        createdAt: new Date(NOW).toISOString(),
        ...event,
      });
    },
    setSidecar: (cwd, variant, state) => { sidecars.set(sidecarKey(cwd, variant), state); },
    render: (paneId) => {
      const pane = panes.get(paneId);
      return pane ? renderPane(pane) : "";
    },
  };
}

/** A minimal two-task plan: `a` serial, `b` parallel with a disjoint boundary. */
export function samplePlan(input?: unknown): OrchestratorPlan {
  const parsed = parsePlan(input ?? {
    title: "拆分",
    intent: "把大文件拆成模块",
    maxParallel: 2,
    tasks: [
      { id: "a", title: "抽 plan", fileBoundaries: ["lib/plan"] },
      { id: "b", title: "抽 tmux", fileBoundaries: ["lib/tmux"], execution: "parallel" },
    ],
  }, new Date(NOW).toISOString());
  assert.ok(parsed.ok, parsed.problems.join("; "));
  return parsed.plan!;
}

/** The text of a tool reply, joined. */
export function replyText(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}
