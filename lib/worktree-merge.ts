/**
 * WHERE A MERGE CAN ACTUALLY RUN — the question `declare_done` never asked.
 *
 * THE MEASURED FAILURE (R3-7, third end-to-end run). A parallel orchestration
 * child finished in its own worktree: reviewer READY, full precommit, base
 * branch correctly recorded. Then the gate merged the way it always had —
 * `git checkout <base>` followed by `git merge --no-ff <work>` — and git
 * refused:
 *
 *     fatal: 'refactor/gate-heavy-agent-light' is already used by worktree at
 *     '/Users/qwang/workspace/pi-review-gate'
 *
 * That is not an edge case; it is the DEFINING property of a linked worktree.
 * A branch can be checked out in exactly one worktree, so the base branch of
 * a parallel lane is, by construction, held by somebody else — the merge path
 * could never work there. The child's only exit was `waiveMerge`, handing the
 * merge to the project manager, i.e. to the one role that is forbidden to
 * touch the code repository. Both lanes of that run were merged by hand.
 *
 * WHY "just fetch into the branch" is not the fix: git refuses to update a
 * ref that is checked out somewhere (`refusing to fetch into branch`), and
 * `--update-head-ok` would leave that worktree's index disagreeing with its
 * HEAD — a corrupted checkout in exchange for a green receipt. The only
 * honest option is to run the merge IN the worktree that holds the branch,
 * without switching anything (user decision, 2026-08-30).
 *
 * Pure module: strings in, a decision out. Every IO fact it needs (the
 * worktree list, whether a checkout is dirty) is passed in by the caller, so
 * the whole venue algebra is unit-testable without a second checkout.
 */

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  /** Short branch name (`refs/heads/x` → `x`); absent when detached. */
  branch?: string;
  head?: string;
  detached?: boolean;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Records are separated by blank lines and always start with `worktree`.
 * Anything unrecognized is ignored rather than fatal: a future git may add
 * attributes, and losing the whole list would silently downgrade the merge
 * back to the broken path.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const rawLine of String(porcelain ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD" && value) current.head = value;
    else if (key === "branch" && value) current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") current.detached = true;
  }
  if (current) entries.push(current);
  return entries.filter((e) => e.path.length > 0);
}

/** Compare two worktree paths (trailing slashes are noise). */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string): string => p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/**
 * Which OTHER worktree currently holds `branch`, if any.
 *
 * `selfPath` is excluded deliberately: a branch this very checkout holds is
 * not an obstacle — it is the ordinary case.
 */
export function branchHolder(
  entries: readonly WorktreeEntry[],
  branch: string,
  selfPath: string,
): WorktreeEntry | undefined {
  return entries.find((e) => e.branch === branch && !samePath(e.path, selfPath));
}

/** Where the merge of `work` into `base` has to be executed. */
export type MergeVenue =
  /** Nobody else holds the base: the classic `checkout base; merge work`. */
  | { kind: "self"; reason: string }
  /** Another worktree holds the base: merge INSIDE it, switching nothing. */
  | { kind: "worktree"; path: string; reason: string };

export interface MergeVenueInput {
  base: string;
  work: string;
  /** The worktree `declare_done` is running in. */
  selfPath: string;
  worktrees: readonly WorktreeEntry[];
}

/**
 * Decide the venue. This is the whole R3-7 fix in one function.
 *
 * Note what it does NOT do: it never proposes creating a temporary checkout
 * of the base. That was the tempting third option, and it is unsound for the
 * same reason as the fetch — the temporary worktree could not check out a
 * branch another worktree already holds either.
 */
export function decideMergeVenue(input: MergeVenueInput): MergeVenue {
  const holder = branchHolder(input.worktrees, input.base, input.selfPath);
  if (!holder) {
    return {
      kind: "self",
      reason: `基准分支 ${input.base} 没有被别的 worktree 占用，可以在本工作区切过去合并`,
    };
  }
  return {
    kind: "worktree",
    path: holder.path,
    reason:
      `基准分支 ${input.base} 正被 worktree ${holder.path} 检出（git 的硬限制：一个分支只能被一个 worktree 检出），` +
      `所以合并在那个工作区里就地执行（不切分支、不动 HEAD），把 ${input.work} 合进它当前所在的 ${input.base}`,
  };
}

/** Why a remote venue cannot be used right now (undefined ⇒ it can). */
export function venueRefusal(
  venue: MergeVenue,
  facts: { dirtyFiles?: readonly string[]; currentBranch?: string; base: string },
): string | undefined {
  if (venue.kind !== "worktree") return undefined;
  if (facts.currentBranch !== undefined && facts.currentBranch !== facts.base) {
    return (
      `worktree ${venue.path} 持有 ${facts.base}，但它现在停在 ${facts.currentBranch || "(detached HEAD)"} 上 —— ` +
      "门禁不会替别的工作区切分支，这一步交给人。"
    );
  }
  const dirty = facts.dirtyFiles ?? [];
  if (dirty.length > 0) {
    return (
      `worktree ${venue.path} 持有基准分支 ${facts.base}，但它的工作区不干净（${dirty.length} 个改动：` +
      `${dirty.slice(0, 5).join("、")}${dirty.length > 5 ? " 等" : ""}）—— ` +
      "在别人有未提交改动的工作区里跑 merge 可能弄丢它们，所以门禁**什么都不做**。\n" +
      "处理方式：让那个工作区干净下来后重新 declare_done；或 declare_done({ waiveMerge: \"<理由>\" }) 让用户确认本次不合并。"
    );
  }
  return undefined;
}

/** The argv for the merge itself, in the venue's own directory. */
export function mergeArgv(work: string, base: string): string[] {
  return ["merge", "--no-ff", work, "-m", `merge ${work} into ${base}`];
}
