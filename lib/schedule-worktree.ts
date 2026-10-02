/**
 * THE ISOLATED CHECKOUT A SCHEDULED RUN WORKS IN (2026-10-03, user decision).
 *
 * ── WHY IT EXISTS ──
 *
 * A scheduled run used to work directly in the task's repository. Anything else
 * living in that checkout — the user's own session, or an earlier run of the
 * same task that had not settled yet — was therefore a reason to SKIP the slot
 * entirely. Measured on this machine (2026-10-02): six skipped slots in a day,
 * three of them caused by nothing but a session in the main repo. The user's
 * decision was to stop reading "the repo is busy" as "the task cannot run":
 * every run gets its own checkout under the gate's worktree root, and the main
 * repo's occupants stop mattering.
 *
 * ── WHAT IS DURABLE, AND WHAT IS DISPOSABLE ──
 *
 * The checkout is disposable; the BRANCH is the durable half, and what happens
 * to it is `settleScheduleWorktree`'s question — answered from the run's
 * OUTCOME and its STATION (`docs/daemon/api.md` §13.7):
 *
 *   - nothing was produced ⇒ the branch and the checkout are recycled whole;
 *   - something was produced, and the run concluded READY (`passed`) with a
 *     station below `pr` ⇒ the branch is merged into the main repo, STAGED and
 *     uncommitted (the user commits — that is what `precommit`/`commit` mean);
 *   - anything else (a run that did not conclude READY, a `pr` run that ships
 *     its own branch, a merge that would collide) ⇒ the branch is KEPT and
 *     named in the ledger and the panel. Un-passed output is never landed: the
 *     gate's whole reason for existing is that a recorded READY is what makes
 *     an artifact shippable.
 *
 * A run's UNCOMMITTED work is committed onto the run's own branch before the
 * checkout is removed (the same rule `orchestrator_close({worktree:"reclaim"})`
 * follows): the directory is about to be deleted, and the branch is the only
 * copy that survives it.
 *
 * ── HOW A RUN'S SESSION IS RECOGNISED AS OURS ──
 *
 * The checkout carries an owner record beside it (`<path>.owner.json`, the same
 * shape lib/session-worktree.ts uses) naming the task's repo, the run id and
 * the branch. `adoptScheduledRunContract` reads it to accept a run whose cwd is
 * this checkout as being "in the task's repo" — without that, the contract's
 * repo check would refuse every run, and a session the gate refuses cannot
 * adopt the contract it was started for.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { gitFailureText, gitOrNull, gitText } from "./git-exec.ts";
import { ensureGateWorktreeRoot, gateWorktreeRoot } from "./worktree-root.ts";
import { seedWorktree } from "./worktree-seed.ts";
import type { DeliveryStation } from "./delivery-station.ts";
import type { ScheduleRunOutcome } from "./schedule-store.ts";

/** Branch prefix for a scheduled run's own branch. */
export const SCHEDULE_BRANCH_PREFIX = "rg-schedule-";

/** The owner record sits BESIDE the checkout, so it dies with it. */
const OWNER_SUFFIX = ".owner.json";

/** `run-abcdef12` ⇒ `abcdef12`. The run id is the token: it is already unique. */
export function scheduleWorktreeToken(runId: string): string {
  const cleaned = runId.replace(/[^A-Za-z0-9]/g, "");
  return cleaned === "" ? "run" : cleaned.slice(0, 24);
}

export function scheduleWorktreePath(repoRoot: string, token: string): string {
  const slug = basename(repoRoot).replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
  return join(gateWorktreeRoot(), `${slug}-sch-${token}`);
}

export function scheduleWorktreeBranch(token: string): string {
  return `${SCHEDULE_BRANCH_PREFIX}${token}`;
}

export function scheduleOwnerRecordPath(worktreePath: string): string {
  return `${worktreePath}${OWNER_SUFFIX}`;
}

/** Is this path one of OUR scheduled-run checkouts (a direct child of the root)? */
export function isScheduleWorktreePath(path: string): boolean {
  return dirname(path) === gateWorktreeRoot() && /-sch-[A-Za-z0-9]+$/.test(basename(path));
}

/** What the owner record says, and therefore what a run's cwd really is. */
export interface ScheduleWorktreeOwner {
  /** The task's repository — the one the contract is bound to. */
  repo: string;
  /** The run that owns this checkout. */
  runId: string;
  /** The branch the gate cut for it. */
  branch: string;
  /** The commit the branch was cut from (`HEAD` of the main repo at cut time). */
  base: string;
  path: string;
}

export function parseScheduleOwner(raw: string | undefined): ScheduleWorktreeOwner | undefined {
  if (raw === undefined) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const s = (k: string): string | undefined =>
      typeof v[k] === "string" && (v[k] as string).length > 0 ? (v[k] as string) : undefined;
    const repo = s("repo"), runId = s("runId"), branch = s("branch"), path = s("path"), base = s("base");
    if (!repo || !runId || !branch || !path || !base) return undefined;
    return { repo, runId, branch, base, path };
  } catch {
    return undefined;
  }
}

/** Read the owner record of a checkout, or undefined when it is not ours. */
export function readScheduleWorktreeOwner(worktreePath: string): ScheduleWorktreeOwner | undefined {
  try {
    return parseScheduleOwner(readFileSync(scheduleOwnerRecordPath(worktreePath), "utf8"));
  } catch {
    return undefined;
  }
}

export type CutScheduleWorktree =
  | { ok: true; worktree: ScheduleWorktreeOwner; seed: string[] }
  | { ok: false; problem: string };

/**
 * Cut the run's own checkout from the MAIN repo's `HEAD`.
 *
 * The base is `HEAD`, not the working tree: a run deliberately starts from what
 * is committed, so the user's uncommitted work in the main repo can neither be
 * half-copied into a run nor be overwritten by one.
 *
 * Every failure lands as a VALUE — the scheduler treats "could not cut it" as a
 * temporary obstacle and keeps the slot, so a failure here must say why.
 */
export function createScheduleWorktree(input: {
  repo: string;
  runId: string;
  /** Injected in tests so a fake failure can be staged. */
  seed?: (mainRoot: string, worktreeRoot: string) => string[];
}): CutScheduleWorktree {
  const repo = input.repo;
  const token = scheduleWorktreeToken(input.runId);
  const path = scheduleWorktreePath(repo, token);
  const branch = scheduleWorktreeBranch(token);
  try {
    mkdirSync(ensureGateWorktreeRoot(), { recursive: true });
  } catch (error) {
    return { ok: false, problem: `门禁 worktree 根目录建不出来：${gitFailureText(error)}` };
  }
  // A LEFTOVER FROM AN EARLIER ATTEMPT AT THE SAME RUN ID IS CLEARED FIRST: both
  // the directory and the BRANCH are named after the run id, so `worktree add
  // -b` would refuse on a branch that is still there (a daemon killed between
  // cutting and launching) and the run would never start again.
  if (existsSync(path)) rmQuietly(path);
  try {
    gitText(repo, ["worktree", "prune"]);
  } catch {
    /* a prune that fails costs nothing: the add below reports what it cannot do */
  }
  try {
    gitText(repo, ["branch", "-D", branch]);
  } catch {
    /* no such branch — the normal case */
  }
  try {
    gitText(repo, ["worktree", "add", "-b", branch, path, "HEAD"]);
  } catch (error) {
    return { ok: false, problem: `git worktree add 失败：${gitFailureText(error)}` };
  }
  const base = gitOrNull(path, ["rev-parse", "HEAD"]);
  if (base === null) {
    // The checkout exists but cannot name its own base: nothing about its
    // contents could be judged later, so it is undone now rather than left as
    // an orphan nothing can settle.
    discardCheckout(repo, path, branch);
    return { ok: false, problem: "新建的 checkout 读不出 HEAD" };
  }
  const owner: ScheduleWorktreeOwner = { repo, runId: input.runId, branch, base, path };
  try {
    writeFileSync(scheduleOwnerRecordPath(path), JSON.stringify(owner));
  } catch (error) {
    discardCheckout(repo, path, branch);
    return { ok: false, problem: `写归属记录失败：${gitFailureText(error)}` };
  }
  // SEEDING NEVER THROWS and never undoes the checkout (lib/worktree-seed.ts):
  // a `.env` that could not be linked degrades the run, it does not cancel it.
  const seed = (input.seed ?? seedWorktree)(repo, path);
  return { ok: true, worktree: owner, seed };
}

export type ScheduleSettlementAction =
  /** Nothing was produced: branch and checkout are gone. */
  | "reclaimed"
  /** The branch was merged into the main repo, staged and uncommitted. */
  | "merged"
  /** The branch was kept (and why is in `note`); the checkout is gone. */
  | "branch-kept";

export interface ScheduleSettlement {
  action: ScheduleSettlementAction;
  /** The branch the run's work is on — kept unless `reclaimed`. */
  branch: string;
  /** Did the checkout hold anything at all (commits ahead of `base`, or a dirty tree)? */
  changes: boolean;
  /** One line for the ledger, the panel and the log. */
  note: string;
}

/** Does this checkout hold anything? The base is the commit it was cut from. */
function hasChanges(path: string, base: string): boolean {
  const dirty = gitOrNull(path, ["status", "--porcelain"]);
  if (dirty !== null && dirty.trim() !== "") return true;
  const ahead = gitOrNull(path, ["rev-list", "--count", `${base}..HEAD`]);
  return ahead !== null && Number.parseInt(ahead, 10) > 0;
}

/**
 * Put whatever the run left UNCOMMITTED onto its own branch.
 *
 * The checkout is about to be removed, so an uncommitted edit is otherwise
 * lost — and at `precommit`/`commit` stations the run is expected to stop with
 * its work uncommitted (`precommit` means "the user commits"). Committing it on
 * the run's branch is what makes the work survive the cleanup.
 */
function commitLeftovers(path: string, runId: string): string | undefined {
  const dirty = gitOrNull(path, ["status", "--porcelain"]);
  if (dirty === null || dirty.trim() === "") return undefined;
  try {
    gitText(path, ["add", "-A"]);
    gitText(path, ["commit", "-m", `chore(schedule): keep the output of ${runId}`, "--no-verify"]);
    return undefined;
  } catch (error) {
    return gitFailureText(error);
  }
}

/** Remove the checkout, its owner record, and (when asked) its branch. */
function discardCheckout(repo: string, path: string, branch: string | undefined): void {
  try {
    gitText(repo, ["worktree", "remove", "--force", path]);
  } catch {
    rmQuietly(path);
  }
  rmQuietly(scheduleOwnerRecordPath(path));
  if (branch !== undefined) {
    try {
      gitText(repo, ["branch", "-D", branch]);
    } catch {
      /* the branch was already gone, or is checked out somewhere: nothing to do */
    }
  }
}

/**
 * Settle one finished run's checkout: the ONE place that decides where its
 * output lands. See the module header for the rules; the exhaustive cases are
 * the tests' subject.
 */
export function settleScheduleWorktree(input: {
  worktree: ScheduleWorktreeOwner;
  outcome: ScheduleRunOutcome;
  station: DeliveryStation;
}): ScheduleSettlement {
  const { repo, path, branch, base, runId } = input.worktree;
  const committed = hasChanges(path, base);
  const leftovers = committed ? commitLeftovers(path, runId) : undefined;
  const changes = committed || leftovers === undefined ? committed : true;
  // THE CHECKOUT IS ALWAYS REMOVED — the branch is the durable half. A branch
  // whose output was never recorded (a failed leftover commit) is KEPT, never
  // silently dropped: that is the one case where a human has to look.
  if (changes && !committed && leftovers !== undefined) {
    return {
      action: "branch-kept",
      branch,
      changes: true,
      note: `结算时提交遗留改动失败（${leftovers}）—— 分支 ${branch} 与它所在的目录都留着，请人工处理`,
    };
  }
  if (!changes) {
    discardCheckout(repo, path, branch);
    return { action: "reclaimed", branch, changes: false, note: "本次运行没有产生任何改动" };
  }
  if (input.station === "pr") {
    // The run ships its own branch (it pushed and opened the PR while it ran):
    // merging here would make that PR pointless.
    discardCheckout(repo, path, undefined);
    return {
      action: "branch-kept",
      branch,
      changes: true,
      note: `站点 pr：成果在分支 ${branch} 上，由这次运行自己 push / 开 PR`,
    };
  }
  if (input.outcome !== "passed") {
    discardCheckout(repo, path, undefined);
    return {
      action: "branch-kept",
      branch,
      changes: true,
      note: `本次运行结论是 ${input.outcome}（不是 READY）：改动留在分支 ${branch} 上，没有合并回主 repo`,
    };
  }
  // READY, and the station says the work lands in the main repo. Only a CLEAN
  // main checkout may receive it: `merge --no-commit` with local changes can
  // refuse half-way, and a run does not get to disturb work a human is in the
  // middle of.
  const dirty = gitOrNull(repo, ["status", "--porcelain"]);
  if (dirty === null) {
    discardCheckout(repo, path, undefined);
    return { action: "branch-kept", branch, changes: true, note: `读不出主 repo 的状态，改动留在分支 ${branch} 上` };
  }
  if (dirty.trim() !== "") {
    discardCheckout(repo, path, undefined);
    return {
      action: "branch-kept",
      branch,
      changes: true,
      note: `主 repo 有未提交改动，没有自动合并：改动留在分支 ${branch} 上`,
    };
  }
  try {
    gitText(repo, ["merge", "--no-commit", "--no-ff", branch]);
  } catch (error) {
    try {
      gitText(repo, ["merge", "--abort"]);
    } catch {
      /* nothing was half-merged, or the abort itself failed: the note says so */
    }
    discardCheckout(repo, path, undefined);
    return {
      action: "branch-kept",
      branch,
      changes: true,
      note: `合并回主 repo 失败（主 repo 未被改动）：${gitFailureText(error)} —— 改动留在分支 ${branch} 上`,
    };
  }
  discardCheckout(repo, path, undefined);
  return {
    action: "merged",
    branch,
    changes: true,
    note: `已把分支 ${branch} 合并回主 repo（staged、未提交），你 commit 的时机不变`,
  };
}

/** Best-effort removal that never throws and never follows a symlink out. */
function rmQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* a directory we cannot remove is reported by the caller that needed it gone */
  }
}
