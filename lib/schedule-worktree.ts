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

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { gitFailureText, gitOrNull, gitRawOrNull, gitText } from "./git-exec.ts";
import { GATE_EXCLUDE_DIRS } from "./fingerprint.ts";
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
  | {
      ok: false;
      problem: string;
      /**
       * NO RETRY CAN CHANGE THIS: there is no repository, or no git in it. The
       * scheduler consumes the slot for these and keeps it for every other
       * failure (`openScopeWindow`'s `permanent` is the same idea one layer
       * down — 2026-10-03).
       */
      permanent?: boolean;
    };

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
  // TWO OF THE FOUR PERMANENT OBSTACLES ARE CHECKED HERE, BEFORE ANY GIT RUNS
  // (2026-10-03): a repo that is gone or that was never a repository will not
  // become one by waiting, so the scheduler must be able to consume the slot
  // instead of retrying every 20 seconds forever.
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    return { ok: false, problem: `repo 不是存在的目录：${repo}`, permanent: true };
  }
  if (gitOrNull(repo, ["rev-parse", "--git-dir"]) === null) {
    return { ok: false, problem: `repo 不是 git 仓库：${repo}`, permanent: true };
  }
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

/**
 * THE RUN'S WORK, NOT THE GATE'S BOOKKEEPING (2026-10-03, reviewer P1).
 *
 * A run's session writes `.pi/loop-goal.md` and its sidecar state into its
 * checkout: that is how the gate records the contract it adopted. Whether those
 * show up in `git status` depends on the TARGET repo's `.gitignore`, which the
 * gate does not get to assume — but `.pi/` may not be excluded WHOLESALE either:
 * a repository that TRACKS files there would have the run's edits to them read
 * as "nothing" and recycled with the checkout.
 *
 * So the line is drawn by git itself. Files under `.pi/` that are UNTRACKED are
 * the gate's (it just wrote them); a MODIFIED tracked file is the repository's,
 * wherever it lives. {@link stageRunOutput} stages along the same line.
 */
function settlementStatus(path: string): string | undefined {
  const raw = gitRawOrNull(path, ["status", "--porcelain"]);
  if (raw === null) return undefined;
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !(line.startsWith("??") && line.slice(3).trimStart().startsWith(".pi/")))
    .join("\n");
}

/**
 * Does this checkout touch a directory the gate's fingerprint excludes wholesale
 * (`GATE_EXCLUDE_DIRS`, lib/fingerprint.ts — a P0 self-deadlock fix, because the
 * gate writes its own state there)?
 *
 * Such a change is the REPOSITORY's when the file is tracked (see
 * {@link settlementStatus}), so it must be preserved — but it was INVISIBLE to
 * the review, so it may not be merged either: the run keeps it on its branch and
 * a human decides (2026-10-03, reviewer P1).
 */
/** Is this repo-root-relative path inside a gate-owned directory? */
function isGateExcludedPath(entry: string): boolean {
  return GATE_EXCLUDE_DIRS.some((dir) => entry === dir || entry.startsWith(`${dir}/`));
}

function touchesGateExcludedDir(path: string, base: string): boolean {
  // COMMITTED FIRST (2026-10-03, quality round P2): a change already on the run's
  // branch is INVISIBLE to the working-tree status below, and it is exactly the
  // shape that must never be merged — it was never in front of a reviewer.
  // Asking only the working tree made the same change merge or not depending on
  // whether the session had committed it.
  const committed = (gitRawOrNull(path, ["diff", "--name-only", "-z", `${base}..HEAD`]) ?? "")
    .split("\0")
    .filter((entry) => entry !== "");
  if (committed.some(isGateExcludedPath)) return true;
  const raw = gitRawOrNull(path, ["status", "--porcelain"]);
  if (raw === null) return false; // an unreadable answer is the caller's tri-state
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .some((line) => {
      // UNTRACKED entries under those dirs are the GATE's own bookkeeping (see
      // {@link settlementStatus}): every run writes them when the target repo
      // does not ignore them, and reading them as "the run touched .pi" would
      // keep a branch for every run and never merge anything (quality round P1,
      // 2026-10-03).
      if (line.startsWith("??")) return false;
      const entry = line.slice(3).trim();
      // `R  old -> new` names both sides; the one that matters is the new one.
      const target = entry.includes(" -> ") ? entry.slice(entry.indexOf(" -> ") + 4) : entry;
      return isGateExcludedPath(target);
    });
}

/**
 * Stage the run's output, along the line {@link settlementStatus} draws:
 * TRACKED changes of every path (a `.pi/` file the repository tracks is the
 * repository's, wherever it lives), then the run's NEW files minus the gate's
 * own bookkeeping under `.pi/`.
 *
 * WHY NOT A PATHSPEC: `git add -A -- . ':(exclude).pi'` is the obvious spelling
 * and it fails outright when `.pi/` is ignored (a global `core.excludesFile` is
 * enough) — git treats the exclude as an explicit request for an ignored path
 * and refuses the whole call (measured 2026-10-03). `-u` plus a filtered
 * `ls-files` asks the same question without that trap.
 */
function stageRunOutput(path: string): void {
  gitText(path, ["add", "-u"]);
  const untracked = (gitRawOrNull(path, ["ls-files", "-z", "--others", "--exclude-standard"]) ?? "")
    .split("\0")
    .filter((entry) => entry !== "" && !isGateExcludedPath(entry));
  if (untracked.length > 0) gitText(path, ["add", "--", ...untracked]);
}

/**
 * Does this checkout hold anything? The base is the commit it was cut from.
 *
 * `undefined` means CANNOT TELL, and that is deliberately not `false`: the
 * caller deletes the directory when this says "nothing", so an unreadable
 * answer must never be read as emptiness.
 */
function hasChanges(path: string, base: string): boolean | undefined {
  const dirty = settlementStatus(path);
  if (dirty === undefined) return undefined;
  if (dirty.trim() !== "") return true;
  const ahead = gitOrNull(path, ["rev-list", "--count", `${base}..HEAD`]);
  if (ahead === null) return undefined;
  return Number.parseInt(ahead, 10) > 0;
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
  const dirty = settlementStatus(path);
  if (dirty === undefined || dirty.trim() === "") return undefined;
  try {
    stageRunOutput(path);
    // NO `--no-verify` (2026-10-03, reviewer P1): the project's own hooks are
    // the judgement about whether this content may be committed at all, and the
    // gate does not get to route around its own gate. A refusal is not a
    // failure — it is the answer that says "keep the checkout for a human",
    // which is exactly what the caller does with a non-empty return.
    gitText(path, ["commit", "-m", `chore(schedule): keep the output of ${runId}`]);
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
  if (!existsSync(path)) {
    // ALREADY SETTLED, OR TAKEN BY HAND: an earlier settlement whose ledger
    // write failed (so the tick tries again), or a directory somebody deleted.
    // Nothing is decided and — above all — NOTHING IS DELETED: the branch is the
    // only copy, and a second settlement must be a no-op rather than a
    // destroyer.
    return {
      action: "branch-kept",
      branch,
      changes: true,
      note: `隔离 checkout 已经不在了（${path}）—— 分支 ${branch} 保持原样，结算不再动它`,
    };
  }
  const changes = hasChanges(path, base);
  if (changes === undefined) {
    // CANNOT TELL IS NOT "NOTHING": the next step would delete the directory,
    // and deleting work is the one mistake this module must not make. Both
    // halves stay (the directory is the only copy of whatever is in it) and a
    // human looks.
    return {
      action: "branch-kept",
      branch,
      changes: true,
      note: `读不出这次运行的 checkout（${path}）有没有改动 —— 目录与分支都留着，请人工确认`,
    };
  }
  // ASKED BEFORE THE COMMIT: `commitLeftovers` clears the working-tree status
  // this reads (2026-10-03).
  const gateOwned = changes && touchesGateExcludedDir(path, base);
  if (changes) {
    const leftovers = commitLeftovers(path, runId);
    if (leftovers !== undefined) {
      // Uncommitted work that could not be put on the branch: the directory is
      // the only copy that exists, so it stays exactly where it is.
      return {
        action: "branch-kept",
        branch,
        changes: true,
        note: `结算时提交遗留改动失败（${leftovers}）—— 分支 ${branch} 与目录 ${path} 都留着，请人工处理`,
      };
    }
  }
  // THE CHECKOUT IS REMOVED FROM HERE ON — the branch is the durable half.
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
  if (gateOwned) {
    discardCheckout(repo, path, undefined);
    return {
      action: "branch-kept",
      branch,
      changes: true,
      note: `改动涉及 ${GATE_EXCLUDE_DIRS.join(" / ")}（不在审查范围内，不会被合并）：留在分支 ${branch} 上`,
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
