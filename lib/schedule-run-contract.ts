/**
 * WHAT A SCHEDULED RUN INHERITS — the approved contract, read back at
 * `session_start`.
 *
 * ── WHY IT EXISTS ──
 *
 * The daemon starts a run as an ordinary loop session (lib/daemon/control.ts,
 * `launchTask`) with `RG_SCHEDULE_ID` / `RG_SCHEDULE_RUN` in its environment.
 * Those two names are constants of lib/schedule-store.ts because THREE sides
 * must agree on them — the dispatcher writes them, this reader consumes them,
 * and `GATE_ENV_NAMES` strips them so no child ever inherits them.
 *
 * The run must NOT re-negotiate its contract: the user already confirmed the
 * requirement restatement and approved the goal when the task was authored
 * (lib/schedule-tools.ts), and `lib/daemon/scheduler.ts` already sent the
 * contract's station as the run's ceiling. So the run ADOPTS what was
 * approved: it writes the contract's goal text to this session's
 * `.pi/loop-goal<variant>.md` and records the `restatement` / `loopGoal` pair
 * the L8 gate checks, with `at` = the contract's own approval time (not
 * "now" — the approval happened then, and pretending otherwise would make a
 * stale contract look freshly agreed).
 *
 * AND IT RUNS IN ITS OWN CHECKOUT (2026-10-03): the session's repo is the
 * isolated checkout cut from the task's repo (lib/schedule-worktree.ts), which
 * its owner record proves — "this is the task's repo" and "this is the checkout
 * cut from it" are both accepted, and anything else is not.
 *
 * ── FAIL-CLOSED, AND SILENT ──
 *
 * Every uncertainty means "do nothing but say so in the log": a missing
 * variable, an unreadable table, a contract whose hashes do not match its own
 * texts, a repo that is not this session's, or a `RG_SCHEDULE_RUN` that does
 * not name THIS session in the ledger. The last one is the loop-prevention
 * fact: an environment variable can be inherited or forged, the append-only
 * ledger cannot, so a session that is not really the run of that id gets
 * nothing. Nothing here throws into `session_start` — a broken adoption must
 * not take the session down with it.
 */

import { goalTextHash } from "./loop-goal.ts";
import { normalizeRepoPath } from "./repo-pr-policy.ts";
import { readScheduleWorktreeOwner } from "./schedule-worktree.ts";
import { restatementHash } from "./restatement.ts";
import {
  findScheduledTask,
  readScheduleRuns,
  SCHEDULE_ID_ENV,
  SCHEDULE_RUN_ENV,
  scheduleContractProblem,
  type ScheduledTask,
} from "./schedule-store.ts";
import type { RestatementRecord } from "./restatement.ts";
import type { GateState } from "./gate-state.ts";

/** What the adoption needs from the session it runs in. */
export interface ScheduledRunContractDeps {
  /**
   * The USER HOME the daemon's paths hang off (`RG_DAEMON_HOME ?? homedir()`),
   * read through a getter because it is an environment fact of the RUN, not of
   * this module.
   */
  home(): string;
  /** This session's own repo — the contract's repo must be exactly this. */
  repoRoot(): string;
  sessionId(): string | null | undefined;
  stateFor(root: string): GateState;
  persist(ctx: unknown, root: string): void;
  loopGoalPath(root: string): string;
  /** Write the approved goal (creating its directory). Throws on failure. */
  writeGoalFile(path: string, text: string): void;
  log(message: string): void;
}

export type ScheduledRunAdoption =
  | { adopted: true; taskId: string; runId: string; repo: string }
  | { adopted: false; reason: string };

/**
 * Adopt the contract of the scheduled run this process IS, or do nothing.
 *
 * Returns what happened so a test (and the log line) can name it; the caller
 * ignores the value. The environment is a parameter for the same reason
 * everything else is injected: the decision has to be testable without
 * mutating process-wide state.
 */
export function adoptScheduledRunContract(
  deps: ScheduledRunContractDeps,
  ctx: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ScheduledRunAdoption {
  /**
   * Fail-closed: nothing is written, and a REAL mismatch leaves one log line.
   * A session with no `RG_SCHEDULE_*` at all is silent on purpose — that is
   * every ordinary session start, and a line per start would be noise.
   */
  const skip = (reason: string, quiet = false): ScheduledRunAdoption => {
    if (!quiet) deps.log(`schedule_task: 本次会话没有继承调度契约（${reason}）`);
    return { adopted: false, reason };
  };
  try {
    const taskId = (env[SCHEDULE_ID_ENV] ?? "").trim();
    const runId = (env[SCHEDULE_RUN_ENV] ?? "").trim();
    // Not a scheduled run at all — the ordinary case, and not worth a log line.
    if (taskId === "" || runId === "") return skip("not a scheduled run", true);
    const sessionId = (deps.sessionId() ?? "").trim();
    if (sessionId === "") return skip("no session id");
    const home = deps.home();
    // A task whose table cannot be read is NOT "no task": the store refuses to
    // hand back a list it could not parse, and so does this.
    const task: ScheduledTask | undefined = findScheduledTask(home, taskId);
    if (task === undefined) return skip(`no scheduled task ${taskId}`);
    const problem = scheduleContractProblem(task.contract);
    if (problem !== undefined) return skip(`契约不成立：${problem}`);
    const repo = deps.repoRoot();
    // THE TASK'S REPO, OR THE CHECKOUT CUT FROM IT (2026-10-03): a scheduled
    // run works in its OWN checkout (lib/schedule-worktree.ts), and "is this
    // the task's repository" is answered by that checkout's owner record. Asking
    // only for path equality would refuse every run the scheduler starts.
    const owner = readScheduleWorktreeOwner(repo);
    const fromTaskRepo = owner !== undefined && normalizeRepoPath(owner.repo) === normalizeRepoPath(task.repo);
    if (normalizeRepoPath(task.repo) !== normalizeRepoPath(repo) && !fromTaskRepo) {
      return skip(`任务 ${task.id} 的 repo 是 ${task.repo}，本会话在 ${repo}（也不是它的隔离 checkout）`);
    }
    // THE LEDGER PROVES IT: only a `run-started` line naming THIS session for
    // THIS run id makes this process the run it claims to be.
    const started = readScheduleRuns(home).some(
      (record) => record.kind === "run-started" && record.runId === runId &&
        record.taskId === task.id && record.sessionId === sessionId,
    );
    if (!started) return skip(`台账里没有 ${runId} 属于本会话（${sessionId}）的 run-started 记录`);

    const goalText = task.contract.goal.text;
    // THE FILE FIRST, THE RECORDS SECOND: a session whose goal file could not
    // be written must not carry an approval record claiming it was.
    deps.writeGoalFile(deps.loopGoalPath(repo), goalText + "\n");
    const st = deps.stateFor(repo);
    // THE HASHES ARE RECOMPUTED, never copied. `scheduleContractProblem` just
    // proved the stored ones match their texts, and a record that carries a
    // hash it did not compute itself is exactly what the readers of these two
    // records refuse to trust.
    const restatement: RestatementRecord = {
      text: task.contract.restatement.text,
      hash: restatementHash(task.contract.restatement.text),
      at: task.contract.approvedAt,
      station: task.contract.restatement.station,
    };
    st.restatement = restatement;
    st.loopGoal = {
      hash: goalTextHash(goalText),
      at: task.contract.approvedAt,
      station: task.contract.restatement.station,
    };
    deps.persist(ctx, repo);
    deps.log(
      `schedule_task: 会话 ${sessionId} 继承了定时任务 ${task.name}（${task.id}）的契约 ` +
      `（运行 ${runId}，站点 ${task.contract.restatement.station}，批准于 ${task.contract.approvedAt}）`,
    );
    return { adopted: true, taskId: task.id, runId, repo };
  } catch (error) {
    // An adoption that throws must not take `session_start` down with it.
    return skip(`继承失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
