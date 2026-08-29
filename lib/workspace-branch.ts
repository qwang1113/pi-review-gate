/**
 * Workspace and branch facts — the decisions behind `setup_workspace` and the
 * automatic finish inside `declare_done`.
 *
 * WHY THIS MODULE EXISTS (user ask, 2026-08-29). Two procedural jobs were the
 * agent's: deciding what to do with a dirty worktree it did not create, and
 * running the branch dance by hand (`git checkout -b`, `git merge`, and the
 * "which branch was I supposed to merge back into?" reconstruction). Both are
 * gate business — they are about WHERE work lands, not about the work.
 *
 * The gate therefore keeps an append-only `branchOps` log: every checkout,
 * discard, checkpoint and branch decision, in order. At the end it does not
 * have to guess where the work came from — it reads it.
 *
 * Pure functions over injected facts; the extension runs git and the dialogs.
 */

/** One entry of the worktree's `git status --porcelain` output. */
export interface DirtyFile {
  /** Two-character status code, e.g. " M", "??", "A ". */
  status: string;
  path: string;
  /** `??` — git does not know this file at all. */
  untracked: boolean;
}

/**
 * Parse `git status --porcelain` (v1). Renames (`R  old -> new`) report the
 * NEW path: that is the file that exists now, and the one a discard removes.
 */
export function parsePorcelain(out: string): DirtyFile[] {
  const files: DirtyFile[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    if (!path) continue;
    files.push({ status, path, untracked: status === "??" });
  }
  return files;
}

/** A short, honest description of what is dirty (dialog + injection copy). */
export function describeDirty(files: DirtyFile[], maxListed = 12): string {
  if (!files.length) return "工作区干净";
  const listed = files.slice(0, maxListed).map((f) => `${f.status.trim() || "??"} ${f.path}`);
  const rest = files.length - listed.length;
  const tracked = files.filter((f) => !f.untracked).length;
  return `${files.length} 个改动（${tracked} 个已跟踪，${files.length - tracked} 个未跟踪）：\n` +
    listed.join("\n") + (rest > 0 ? `\n…还有 ${rest} 个` : "");
}

/** What the user chose to do with a dirty worktree. */
export type WorktreeChoice = "baseline" | "handled" | "discard";

export const WORKTREE_CHOICES: Record<WorktreeChoice, string> = {
  baseline: "接受为本会话基线（随后提交成 checkpoint）",
  handled: "我已自行处理，重新检测",
  discard: "丢弃这些改动（门禁代执行，不可恢复）",
};

/** Map a dialog line back to the choice it stands for. */
export function interpretWorktreeChoice(picked: string | undefined): WorktreeChoice | undefined {
  if (!picked) return undefined;
  const hit = (Object.keys(WORKTREE_CHOICES) as WorktreeChoice[])
    .find((k) => picked === WORKTREE_CHOICES[k]);
  return hit;
}

/** One recorded branch/worktree operation (append-only audit log). */
export type BranchOp =
  | { op: "checkout"; from: string | null; to: string; at: string }
  | { op: "worktree_discard"; files: string[]; at: string; reason: string }
  | { op: "checkpoint_commit"; sha: string; branch: string; at: string; message: string }
  | { op: "base_branch_set"; branch: string; at: string }
  | { op: "work_branch_set"; branch: string; base: string; at: string };

/** Cap: the log is a diagnostic, not a journal — keep the newest entries. */
export const MAX_BRANCH_OPS = 200;

/** Append one op, keeping the log bounded (oldest dropped first). */
export function appendBranchOp(log: BranchOp[] | undefined, op: BranchOp): BranchOp[] {
  const next = [...(log ?? []), op];
  return next.length > MAX_BRANCH_OPS ? next.slice(next.length - MAX_BRANCH_OPS) : next;
}

/** Branches a session must never work on directly. */
export const PROTECTED_BRANCHES = ["main", "master"];

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.includes(branch.trim());
}

/**
 * The work branch name for a session: `session-<slug>`, or the agent's own
 * proposal when it gave one. Sanitized to what git accepts, and never a
 * protected branch name.
 */
export function deriveWorkBranchName(proposed: string | undefined, fallbackSeed: string): string {
  const raw = (proposed ?? "").trim() || `session-${fallbackSeed}`;
  const safe = raw
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]+|[-/.]+$/g, "")
    .slice(0, 60);
  const name = safe || `session-${fallbackSeed}`;
  return isProtectedBranch(name) ? `session-${fallbackSeed}` : name;
}

export type FinishAction =
  /** Work and base are the same branch (single-branch repo): nothing to merge. */
  | "no-branching"
  /** The work branch is already an ancestor of the base: nothing to merge. */
  | "already-merged"
  /** The base must absorb the work branch. */
  | "merge";

/**
 * What finishing this session's work means. Deliberately conservative: the
 * merge is only proposed when the branches actually differ AND the work is
 * not already in the base.
 */
export function decideFinish(input: {
  workBranch: string | undefined;
  baseBranch: string | undefined;
  workIsAncestorOfBase: boolean;
}): FinishAction {
  const { workBranch, baseBranch } = input;
  if (!workBranch || !baseBranch || workBranch === baseBranch) return "no-branching";
  return input.workIsAncestorOfBase ? "already-merged" : "merge";
}

/**
 * May a commit land on this branch?
 *
 * FAIL-CLOSED: with no work branch on record the answer is no — the whole
 * point of the branch rule is that a session never commits onto whatever
 * branch it happened to start on (the user's own work).
 */
export function commitBranchAllowed(input: {
  workBranch: string | undefined;
  currentBranch: string | undefined;
}): { allowed: boolean; reason?: string } {
  if (!input.workBranch) {
    return {
      allowed: false,
      reason: "本会话还没有工作分支：先调 setup_workspace（门禁会确认基准分支并建工作分支），再提交。",
    };
  }
  if (!input.currentBranch) {
    return { allowed: false, reason: "无法确定当前分支（detached HEAD?）——先回到工作分支再提交。" };
  }
  if (input.currentBranch !== input.workBranch) {
    return {
      allowed: false,
      reason: `当前在 ${input.currentBranch}，本会话的工作分支是 ${input.workBranch}。切回工作分支再提交，避免污染别人的分支。`,
    };
  }
  return { allowed: true };
}

/** Conflicted paths from `git merge`'s output / `git diff --name-only --diff-filter=U`. */
export function parseConflictFiles(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 50);
}
