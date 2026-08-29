/**
 * The SEAM between the orchestration tools and the extension.
 *
 * The tools are registered from lib/ rather than from
 * `extensions/review-gate.ts` on purpose: that file is 8659 lines and is the
 * standing example of the architecture problem this very round adds a rule
 * against (task book §9). Adding 700 more lines of tool bodies to it would
 * have been the exact "just +100 lines" move that produced it.
 *
 * So the extension keeps what only it can do — the gate state, the sidecar,
 * the UI, git and the process spawning — and hands it over as this interface.
 * Everything on the other side of the seam is testable with a fake: there is
 * no tmux, no filesystem and no pi runtime in the tool logic itself.
 *
 * Types only: this module contains no behavior at all.
 */

import type { TSchema } from "typebox";
import type { AttentionEvent } from "./attention.ts";
import type { OrchestratorPlan } from "./orchestrator-plan.ts";
import type { OrchestratorRuntime } from "./orchestrator-registry.ts";
import type { TaskMode } from "./task-mode.ts";

/** Result shape the pi tool runtime expects. */
export interface ToolReply {
  content: Array<{ type: "text"; text: string }>;
  /** Present-but-undefined is required by the host's own result type. */
  details: Record<string, unknown> | undefined;
  isError?: boolean;
}

/**
 * Just enough of the pi extension API to register a tool.
 *
 * `parameters` is typed as typebox's `TSchema` (rather than `unknown`) so the
 * real `ExtensionAPI` satisfies this interface structurally: the host's own
 * signature is generic over the schema, and a widened `unknown` would make it
 * incompatible.
 */
export interface ToolHost {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: { readonly aborted: boolean } | undefined,
      onUpdate: unknown,
      ctx: unknown,
    ) => Promise<ToolReply>;
  }): void;
}

/** One tmux invocation, already validated by lib/orchestrator-tmux.ts. */
export interface TmuxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Reading the plan can fail in a way the agent must be able to fix. */
export interface PlanRead {
  plan?: OrchestratorPlan;
  /** Validation problems when the file exists but does not parse. */
  problems: string[];
}

/** Branch facts constraint 10 is decided on. */
export interface BranchFacts {
  workBranch?: string;
  baseBranch?: string;
  /** A base branch is recorded and no merge conflict is outstanding. */
  mergeSettled: boolean;
  mergeWaived: boolean;
}

/**
 * Everything the orchestration tools need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every method here is a thing
 * a test replaces with three lines.
 */
export interface OrchestratorDeps {
  /** Repo root the orchestration belongs to. */
  repoRoot: string;
  /** Injectable clock. */
  now(): number;
  /** This session's environment (orchestration id, inheritance, TMUX). */
  env(): NodeJS.ProcessEnv;
  /** Current gate mode — the tools refuse outside orchestrator mode. */
  taskMode(): TaskMode | undefined;

  /** The orchestration's persistent runtime (registry + approvals). */
  runtime(): OrchestratorRuntime;
  saveRuntime(next: OrchestratorRuntime): void;

  /** Read `.pi/orchestrator-plan.json`, parsed and validated. */
  readPlan(): PlanRead;
  /** Persist a plan the agent just wrote or mutated. */
  savePlan(plan: OrchestratorPlan): void;

  /** Run one tmux command (argv, never a shell string). */
  tmux(argv: readonly string[]): TmuxRunResult;
  /** The orchestrator's own pane id, from $TMUX_PANE. */
  ownPane(): string | undefined;

  /**
   * Ask the USER; the extension renders the dialog, the tool never claims consent.
   *
   * `pointer` is passed straight to the dialog fitter: when the body has to be
   * truncated it tells the user WHERE the untruncated text is. A caller may
   * only pass one after it has actually shown that text (see
   * {@link OrchestratorDeps.showToUser}) — promising a message nobody printed
   * is the bug O-1 filed against the plan dialog.
   */
  confirm(title: string, message: string, pointer?: string): Promise<boolean>;

  /**
   * Print something to the user's transcript BEFORE a dialog asks about it.
   *
   * The plan approval binds to CONTENT (tasks, boundaries, dependencies,
   * parallelism), and a dialog box cannot hold a six-task plan — O-1 measured
   * a user being asked to sign a truncated one. The loop goal solved this
   * years-equivalent ago by printing the full text first and pointing the
   * dialog at it; the plan now does the same.
   */
  showToUser(title: string, text: string): void;

  /**
   * Write a scratch file OUTSIDE the repository (task documents, F7).
   *
   * Outside on purpose: a task file inside the worktree lands in the first
   * child's `git add -A` checkpoint.
   */
  writeScratchFile(name: string, content: string): { ok: true; path: string } | { ok: false; error: string };

  /**
   * Read a child's OWN gate sidecar as parsed JSON (F10's channel).
   *
   * `undefined` when there is none yet — which is itself evidence: a child
   * that has not written one has not loaded the extension.
   */
  childGateState(cwd: string, variant?: string): Record<string, unknown> | undefined;

  /** Injectable sleep, so delivery verification can be tested without waiting. */
  sleep(ms: number): Promise<void>;


  /** Create an isolated worktree for a parallel child (constraint 7). */
  addWorktree(name: string): { ok: true; path: string } | { ok: false; error: string };
  /** Remove one the gate created. Best-effort: never throws. */
  removeWorktree(path: string): void;

  /** Take the next attention event addressed to THIS orchestration, if any. */
  consumeAttention(): AttentionEvent | undefined;

  /** Branch state for the exit checks. */
  branchFacts(): BranchFacts;

  /**
   * Put the desktop-notification escape sequence on the terminal. Returns
   * whether it actually went out.
   *
   * Injected rather than written directly for the reason lib/attention.ts
   * learned the hard way: a test run must never fire a real side effect. The
   * default implementation is gated by the same `sideEffectsEnabled` check
   * (no TTY, CI, or a test runner ⇒ false), and a caller that gets `false`
   * must not record the send against the throttle.
   */
  emitNotification(sequence: string): boolean;

  /** Size of a repo-relative file in characters; undefined when absent. */
  fileChars(relPath: string): number | undefined;

  /** This session's transcript path, handed to a successor on relay. */
  sessionTranscriptPath(): string | undefined;
}
