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

import type { OrchestratorPlan } from "./orchestrator-plan.ts";
import type { OrchestratorRuntime } from "./orchestrator-registry.ts";
import type { ChannelIO } from "./orchestrator-channel.ts";
import type { SupervisionMemory } from "./orchestrator-supervisor.ts";


import type { TaskMode } from "./task-mode.ts";

/**
 * The tool-registration seam moved to lib/tool-host.ts once a SECOND family
 * of tools (the judge tools) started registering through it — a shared host
 * type living in the orchestrator's own header would have made every other
 * module import "orchestrator" to mean "pi". Re-exported here so every
 * existing `import type { ToolHost, ToolReply } from "./orchestrator-deps.ts"`
 * keeps resolving.
 */
export type { ToolHost, ToolReply } from "./tool-host.ts";

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

  /**
   * Is a JUDGE process in flight inside that child's worktree?
   *
   * The one structured fact that separates "blocked on work it started" from
   * "stopped" (R-23): a child sitting in `judge_wait` for 550s freezes its
   * token counter and its screen, and calling that idle would interrupt a
   * perfectly healthy review round. Answered from the judge run directories,
   * never from the screen.
   */
  childJudgeRunning(cwd: string): boolean;

  /**
   * The SUPERVISION CHANNEL's filesystem seam (lib/orchestrator-channel.ts).
   *
   * Injected rather than imported so a test drives the real protocol against
   * an in-memory map: no orchestration test needs a disk, and none needs a
   * tmux server either.
   */
  channelIO(): ChannelIO;

  /**
   * Root under which channel directories live. `undefined` = the real pi
   * agent home; a test points it somewhere of its own.
   */
  channelHome(): string | undefined;

  /**
   * The per-child memory the supervision event rules compare against
   * (lib/orchestrator-supervisor.ts).
   *
   * Shared rather than rebuilt per call: a memory created fresh inside
   * `orchestrator_wait` would see every state as "changed" and would re-ring
   * the same unanswered question on every poll. The background timer and the
   * waiter therefore read and write the SAME record.
   */
  supervisionMemory(): SupervisionMemory;
  saveSupervisionMemory(next: SupervisionMemory): void;

  /**
   * What each child's pane border currently says — the repaint throttle.
   *
   * Owned by the orchestration (like the supervision memory) rather than by
   * the module, for two reasons that are really one: the wait loop probes
   * every 2 seconds and the title carries a seconds counter, so without a
   * memory the gate would fork a tmux process per child per probe; and a
   * memory living in a module would be shared by every orchestration in the
   * process, which is exactly the kind of hidden global this layer removed
   * everywhere else.
   */
  paneDecorMemory(): Map<string, { title: string; at: number }>;


  /**
   * This orchestrator's OWN context usage, as a percentage (receipt block 4).
   *
   * `undefined` means the host genuinely could not measure it, and the receipt
   * says exactly that rather than implying room. Round 4 measured the other
   * failure: the extension never PASSED this binding at all, so every one of
   * 15+ receipts reported "宿主未提供读数" and the orchestrator had no way to
   * judge when to hand over — on the one axis (running long) that defines
   * unattended work.
   */
  contextPercent(): number | undefined;

  /**
   * Run the PLAN PRE-AUDIT and record its verdict (round-4 §7).
   *
   * Injected rather than implemented here because the whole chain belongs to
   * the extension: spawning the `goal-auditor` judge process, waiting for it,
   * parsing its fence, binding the verdict to the plan's canonical hash. The
   * tool only needs the answer — and the answer is deliberately narrow: `ok`
   * means "the dialog may open", anything else is text to hand back.
   *
   * It BLOCKS for minutes, exactly like the goal audit inside
   * `propose_loop_goal`, and for the same reason: returning early and asking
   * the agent to come back is the multi-step dance this design removes.
   */
  auditPlan(plan: OrchestratorPlan): Promise<{ ok: true } | { ok: false; text: string }>;



  /**
   * Which repository-level git hooks currently point INTO this path.
   *
   * `.git/hooks` is shared by every linked worktree, so a child that
   * installed the gate's hooks from inside its own orchestration worktree
   * repointed them at a directory `orchestrator_close` is about to delete —
   * and that broke committing for the WHOLE repository (R-28). Empty ⇒
   * nothing references it and the worktree is safe to remove.
   */
  gitHooksReferencing(path: string): string[];

  /**
   * The branch the ORCHESTRATION itself is standing on — the base every
   * child's work has to end up in (R3-6).
   *
   * Read from the supervisor's own worktree at spawn time and injected into
   * the child, because a child in a gate-created worktree would otherwise
   * default its base to the `orch/...` branch the gate had just invented for
   * it, and its lane's output would stop there.
   */
  currentBranch(): string | undefined;

  /**
   * Re-point the repository's hooks at the MAIN worktree's copy.
   *
   * Called before a referenced worktree is removed, so there is never a
   * window in which the repo cannot commit.
   */
  repairGitHooks(): { ok: true } | { ok: false; error: string };




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
