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
import type { ChoiceSpec } from "./choice-dialog.ts";
import type { ChannelIO } from "./channel-io.ts";
import type { TmuxScope } from "./session-tmux-scope.ts";
import type { TmuxRunResult } from "./orchestrator-tmux.ts";
import type { SupervisionMemory } from "./orchestrator-supervisor.ts";
import type { AnnouncedRequest } from "./orchestrator-wait.ts";


import type { TaskMode } from "./task-mode.ts";
import type { RestatementRecord } from "./restatement.ts";
import type { UserNotifyKind, UserNotifyOutcome } from "./user-notify.ts";

/**
 * The tool-registration seam moved to lib/tool-host.ts once a SECOND family
 * of tools (the judge tools) started registering through it — a shared host
 * type living in the orchestrator's own header would have made every other
 * module import "orchestrator" to mean "pi". Re-exported here so every
 * existing `import type { ToolHost, ToolReply } from "./orchestrator-deps.ts"`
 * keeps resolving.
 */
export type { ToolHost, ToolReply } from "./tool-host.ts";


/** Reading the plan can fail in a way the agent must be able to fix. */
export interface PlanRead {
  plan?: OrchestratorPlan;
  /** Validation problems when the file exists but does not parse. */
  problems: string[];
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
  /**
   * The REQUIREMENT RESTATEMENT the user confirmed for this repo, if any
   * (2026-09-06). `submit` refuses without one, and shows no dialog when it
   * does — the plan is the orchestration layer's contract, and a contract is
   * negotiated only after both sides agree on what was asked.
   *
   * REQUIRED, not optional: an optional member would make "the extension
   * forgot to wire it" indistinguishable from "the user never restated", and
   * the two have opposite fail directions.
   */
  restatement(): RestatementRecord | undefined;

  /** The orchestration's persistent runtime (registry + approvals). */
  runtime(): OrchestratorRuntime;
  saveRuntime(next: OrchestratorRuntime): void;

  /**
   * Append one line to the repo's audit log (`.pi/review-gate-audit.log`).
   *
   * WHY THE ORCHESTRATION LAYER NEEDS IT (B2, 2026-09-06). The plan's
   * approval and its audit verdict lived ONLY in the gate sidecar, and the
   * sidecar is reset the moment another session opens in the same repo — so
   * "who approved this plan, when, and against which content" became
   * unanswerable exactly when somebody needed to ask it. Its two siblings
   * already write here (`propose_restatement`, `propose_loop_goal`); the plan
   * was the one authority-granting record with no trail at all.
   *
   * Best-effort by contract: the log is a record for a human, never an input
   * to a decision, so a failed write must never fail the tool that was doing
   * the real work.
   */
  log(message: string): void;

  /**
   * When this session holds a DIFFERENT orchestration identity than the one
   * persisted in the sidecar, and it did NOT inherit that identity from its
   * environment (no RG_ORCHESTRATION_ID), returning a reason here means:
   * "the sidecar belongs to another orchestration — do not silently adopt it".
   * Undefined means no conflict (fresh session, or a legit relay inheritance).
   */
  runtimeConflict?(): string | undefined;

  /** Read `.pi/orchestrator-plan.json`, parsed and validated. */
  readPlan(): PlanRead;
  /** Persist a plan the agent just wrote or mutated. */
  savePlan(plan: OrchestratorPlan): void;
  /**
   * ARCHIVE the plan file: write `contents` to `relPath` and take
   * `.pi/orchestrator-plan.json` away (B1, user decision 2026-09-05 —
   * "归档由门禁做，绝不 rm"). One dep rather than a write plus a delete,
   * because a half-done archive (written but the plan still there, or the
   * plan gone but nothing written) is exactly the state a hand-run produced.
   */
  archivePlan(relPath: string, contents: string): { ok: true; path: string } | { ok: false; error: string };

  /**
   * The orchestration runtime RECORDED ON DISK for this repo, if any.
   *
   * Deliberately separate from `runtime()`, which is what this session HOLDS:
   * after B1 those two are allowed to differ, and telling them apart is the
   * whole of "there is an old orchestration here that I am not part of". Two
   * tools need the difference — `orchestrator_attach` (which id may I adopt)
   * and the archive action (whose children are still alive down there).
   */
  recordedRuntime(): OrchestratorRuntime | undefined;

  /** Channel directory names under the channel root — one per orchestration. */
  channelDirNames(): string[];

  /**
   * ADOPT an orchestration id as this session's own (`orchestrator_attach`).
   *
   * The id is a closure variable in the extension, not a field of any record,
   * because everything that addresses a child derives it from here. Only a
   * takeover that passed {@link decideTakeover} may call this.
   */
  adoptOrchestrationId(id: string): void;


  /** Run one tmux command (argv, never a shell string). */
  tmux(argv: readonly string[]): TmuxRunResult;
  /** The orchestrator's own pane id, from $TMUX_PANE. */
  ownPane(): string | undefined;
  /**
   * The MANAGER's own tmux session (lib/session-tmux-scope.ts): every child it
   * spawns is a window of it, so the manager's window never gains a pane (user
   * decision, 2026-09-25). Created lazily by the first spawn.
   */
  scope: TmuxScope;

  /**
   * Render the gate's ONE question template (lib/choice-dialog.ts) in the
   * ORCHESTRATOR's own pane, and return the line the user picked.
   *
   * ONE entry for every dialog the project manager raises — the plan
   * approval, the archive confirmation, and the first-answer grant door used
   * to be a boolean confirm plus a bare select (2026-09-08). They are the
   * same question shape now: 2–4 options, one marked （推荐）, and the
   * `✎ 不选，我说明原因` row whose text box is the reason a rejection carries.
   *
   * `body` is the long half (counts, consequences, the facts being confirmed)
   * and reaches the box WHOLE — no fitter, no `pointer` (user decision,
   * 2026-09-16: the row budget that used to cut it is gone, see
   * lib/renderer-mode.ts). What a caller still owes the user is the transcript
   * copy: anything long enough to need one is printed BEFORE the box opens
   * (see {@link OrchestratorDeps.showToUser}) — that was the bug O-1 filed
   * against the plan dialog, and it is why the copy stays even now that
   * nothing is truncated.
   */
  askChoice(spec: ChoiceSpec, opts?: { body?: string; signal?: AbortSignal }): Promise<string | undefined>;

  /**
   * Print something to the user's transcript BEFORE a dialog asks about it.
   *
   * The plan approval binds to CONTENT (tasks, repos, dependencies,
   * parallelism), and a dialog box cannot hold a six-task plan — O-1 measured
   * a user being asked to sign a truncated one. The loop goal solved this
   * years-equivalent ago by printing the full text first and pointing the
   * dialog at it; the plan now does the same.
   */
  showToUser(title: string, text: string): void;

  /**
   * Write a task document INSIDE the given repo's gate-owned `.pi/tasks/` (F7).
   *
   * The `.pi/` scope is covered by `.gitignore` and the fingerprint's
   * `:/.pi` exclusion, so the file can never land in a child's checkpoint;
   * the child receives it as the repo-relative `@.pi/tasks/<name>` ref,
   * resolved against ITS pane cwd — which for a recovery is the CHILD's
   * declared repo, not the orchestrator's. `repoRoot` defaults to the
   * orchestrator's own repo when omitted.
   */
  writeTaskFile(name: string, content: string, repoRoot?: string): { ok: true; path: string } | { ok: false; error: string };

  /**
   * Read a child's OWN gate sidecar as parsed JSON (F10's channel).
   *
   * `undefined` when there is none yet — which is itself evidence: a child
   * that has not written one has not loaded the extension.
   */
  childGateState(cwd: string, variant?: string): Record<string, unknown> | undefined;

  /** Injectable sleep, so delivery verification can be tested without waiting. */
  sleep(ms: number): Promise<void>;


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
   * The SUPERVISION CHANNEL's filesystem seam (lib/channel-io.ts).
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
   * An `orchestrator_wait` is blocking right now (2026-09-27). The background
   * supervisor stands aside while one is: the wait probes the same channels
   * every 2s and returns with the news itself, whereas a notice the timer
   * steers in would sit behind that very wait — and the event it drained from
   * the shared memory would be one the wait never sees.
   */
  waitActive(): boolean;
  /** Mark a blocking wait; call the returned function when it ends. */
  beginWait(): () => void;

  /**
   * requestIds a WAIT has already handed to the orchestrator — the
   * de-duplication of the `pending-request` criterion, and nothing else's.
   *
   * SEPARATE FROM {@link supervisionMemory} ON PURPOSE (2026-09-22). That one
   * is keyed by child+STATE and is drained by three consumers (the 10s
   * supervision timer, the `agent_settled` continuation, the wait probe), so
   * a wait's ability to return depended on who got to it first — measured as
   * a 910-second wait beside a dialog that had been open for two seconds.
   * This record is keyed by the thing actually being announced, is written
   * only by the wait, and is PRUNED to the requests still open on every probe
   * — so an answered question leaves it by itself and it cannot grow without
   * bound.
   */
  announcedRequests(): readonly AnnouncedRequest[];
  saveAnnouncedRequests(next: readonly AnnouncedRequest[]): void;

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
   * reading its structured conclusion, binding the verdict to the plan's canonical hash. The
   * tool only needs the answer — and the answer is deliberately narrow: `ok`
   * means "the dialog may open", anything else is text to hand back.
   *
   * It BLOCKS for minutes, exactly like the goal audit inside
   * `propose_loop_goal`, and for the same reason: returning early and asking
   * the agent to come back is the multi-step dance this design removes.
   */
  auditPlan(plan: OrchestratorPlan, onUpdate?: { step?: (t: string) => void; done?: (t: string) => void }, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; text: string }>;



  /**




  /**
   * Raise the desktop banner for the HUMAN, if this session is one that may.
   *
   * Injected rather than written directly for the reason the old stdout
   * emitter existed: a test run must never fire a real side effect. The
   * extension owns the whole thing — which notifier binary, the tmux click
   * target, the throttle — and `lib/user-notify.ts` owns the policy; a caller
   * only says WHAT happened (`kind` + `detail`) and gets back an honest
   * four-way outcome to print.
   */
  notifyUser(opts: { kind: UserNotifyKind; detail: string }): UserNotifyOutcome;

  /** Size of a repo-relative file in characters; undefined when absent. */
  fileChars(relPath: string): number | undefined;

  /** This session's transcript path, handed to a successor on relay. */
  sessionTranscriptPath(): string | undefined;

  /**
   * Give a child its own checkout of `repoRoot` (2026-09-10).
   *
   * Two writers in one checkout overwrite each other, and the answer used to
   * be "never run two at once". `git worktree add -b <branch> <path> HEAD`
   * gives the second writer its own directory on its own branch, sharing the
   * object store — so same-repo tasks run side by side and the splice happens
   * at settlement time, once, with a human-decided merge.
   *
   * ABSENT means this session has no git capability wired: the spawner then
   * REFUSES the second child rather than sharing a checkout (lib/orchestrator-
   * dispatch.ts is the only caller, and it fails closed).
   */
  createWorktree?(repoRoot: string, childId: string):
    | {
      ok: true;
      path: string;
      branch: string;
      /**
       * What the checkout was SEEDED with (2026-09-15) — the local, gitignored
       * files copied or linked in (lib/worktree-seed.ts), one line each. It
       * rides back so the spawn receipt can say whether the child can actually
       * run the repository's own tests, which is the whole reason the seed
       * exists.
       */
      note?: string;
    }
    | { ok: false; reason: string };

  /**
   * Settle a finished child's isolated checkout (2026-09-10).
   *
   * The project manager says WHAT (keep / merge / discard) and never runs git
   * itself (philosophy one). The merge half is the one that can genuinely
   * fail: a squash-merge of a branch that touched the same lines CONFLICTS,
   * and the answer is to abort, leave the manager's checkout exactly as it
   * was, and report — the child's work is still in its own worktree, so a
   * conflict costs a decision, never the work.
   */
  settleWorktree?(input: {
    childId: string;
    taskId: string;
    repoRoot: string;
    worktreePath: string;
    settlement: "keep" | "merge" | "discard";
  }): {
    ok: boolean;
    text: string;
    /**
     * `false` ⇒ something was NOT removed; the caller must keep the record so
     * a later call can retry. Absent means "assume it is gone" for a
     * settlement that removes nothing.
     */
    reclaimed?: boolean;
  };

  /**
   * This session's OWN pi session id (2026-09-10, relay takeover).
   *
   * Handed to the successor as its proof of heirship: the worktree-exclusivity
   * guard refuses a second gate session in the same checkout, and the one
   * thing that lets the successor take the claim over is being able to name
   * the session it replaces (lib/session-exclusivity.ts).
   */
  ownSessionId?(): string | undefined;

  /**
   * Every repo this session is accountable for, primary first (2026-09-07:
   * cross-repo parallelism needs the scheduler to know which repos exist).
   */
  /**
   * Resolve a task's declared `repo` to the repo root the child's pane
   * should start in (2026-09-15).
   *
   * A task may declare ANY git checkout — not only the ones this session
   * has already edited — so membership in `knownRepoRoots()` is NOT the
   * test. The declared path must be a real git repository root; the
   * resolved root is what the child's cwd (and therefore its gate's
   * primaryRepoRoot) binds to. A path that is not a repo root is a
   * fail-closed refusal — the spawn must never silently fall back to the
   * orchestrator's own repo.
   */
  resolveTaskRepo(repo: string): { ok: true; root: string } | { ok: false; reason: string };

  /**
   * Every repo this session is accountable for, primary first (2026-09-07:
   * cross-repo parallelism needs the scheduler to know which repos exist).
   */
  knownRepoRoots(): string[];

  /**
   * The branch a checkout is on right now, when the gate can read one
   * (2026-09-18, A).
   *
   * The task book states where the child WORKS instead of telling the agent to
   * run `git checkout -b` (philosophy one), and this is the one fact that
   * statement needs. `undefined` — a detached HEAD, a directory that is not a
   * repository, a host with no git capability wired — is NOT an error: the
   * task book falls back to the naming rule, which is exactly the case where a
   * new branch really is owed.
   */
  currentBranch?(root: string): string | undefined;

  /**
   * Fired on every orchestration-tool execution (2026-08-30, symmetric
   * re-arm).
   *
   * The extension wires this to re-arm `loopArmed` — the loop session
   * re-arms itself by EDITING, and an orchestrator writes no code
   * (constraint 2), so its work (plan, spawn, instruct, wait, ...) is the
   * equivalent motion. Without this, one early return under `!loopArmed`
   * would leave the project manager permanently disarmed.
   */
  onToolCall?(name: string): void;

  /**
   * RETIRE this session as the orchestration's holder, called by
   * `orchestrator_handoff` BEFORE the successor pane opens (2026-09-10).
   *
   * Phase one is the RELEASE, and it has to be first: the successor arms its
   * gate in this SAME worktree, and the exclusivity guard refuses it while
   * this session's heartbeat is fresh. Phase two is the SILENCE, and it has to
   * come after the successor's registry row is persisted —
   * {@link HandoffRetirement} is where that order (and the two defects that
   * pinned it) is written down.
   *
   * `undefined` means this session has nothing to retire.
   */
  onHandoff?(): HandoffRetirement | undefined;
}

/**
 * The two follow-ups a RETIREMENT owes its caller.
 *
 * WHY IT IS TWO PHASES AND NOT ONE FLAG (2026-09-10, review round 1 — two P2s
 * that were one root cause). Stopping everything at once broke two things:
 *
 *  - the relay record is written AFTER the successor's pane opens, and it goes
 *    through `persist()` — which refuses to write for a retired session (two
 *    sessions, one sidecar). Marking retirement first made the successor's own
 *    registry row memory-only, lost on any restart;
 *  - stopping the two wake-up timers is not something a rollback can undo by
 *    itself (it needs a context), so a relay that never started its successor
 *    left the session with no supervision and no revival clock — silent, and
 *    still the holder.
 *
 * So the OUTSIDE resource (the worktree claim) is released up front — that is
 * the half the successor's boot races — and the INWARD silence happens only
 * once the record is safely on disk. A rollback then has exactly one thing to
 * undo, because the other two never happened.
 */
export interface HandoffRetirement {
  /** The successor is up AND its relay record is persisted: go silent now. */
  committed(): void;
  /** The successor never started: take the worktree back and carry on. */
  rolledBack(): void;
}
