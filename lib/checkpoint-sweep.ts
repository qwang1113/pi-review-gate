/**
 * WHAT A CHECKPOINT COMMITS — the untracked half of it, in one place.
 *
 * THE MEASURED BUG (drill F3, 2026-09-19). The gate's own checkpoint ran a
 * bare `git add -A` with the hooks silenced, so it committed EVERY path in the
 * worktree that no `.gitignore` covers — including the `node_modules` symlink a
 * seeded isolated checkout carries. Measured in the drill: the symlink went into
 * the repository as `+1/−0 node_modules`, and the reviewer recognised it out of
 * its own CHANGE INDEX. Anything else of that shape travels the same way: a
 * `.env`, an artefact carrying an absolute path, build output, a scratch file.
 * Nothing asked the agent or the user.
 *
 * THE RULE. A checkpoint commits the round's work, and untracked paths count as
 * the round's work only when THIS SESSION wrote them (`edit`/`write`, recorded
 * in `GateState.sessionEditedFiles`). Everything else untracked and unignored is
 * left exactly where it is and named in the receipt — a file the session never
 * touched is not this round's business, and silently committing it is how a
 * secret ends up in the history of the one tool whose job is to be careful.
 *
 * TRACKED changes are not part of this decision: they are the round itself
 * (`M`/`D`/`R`), and the caller sweeps them with `git add -A` as before.
 *
 * The two decisions are pure (two lists in, one plan out); `pendingCheckpoint`
 * is the ONE place that reads git for them, so the checkpoint and the
 * empty-range review round cannot disagree about what "clean" means (N1
 * residual, 2026-09-27: prepare_review kept a bare `git status --porcelain`).
 */

import { gitRaw } from "./git-exec.ts";

export interface CheckpointSweep {
  /** Untracked paths this session wrote — the caller stages these. */
  own: string[];
  /**
   * Untracked, unignored paths nobody recorded. The caller must NOT stage
   * them, and must say so: an uncommitted change is a change outside the
   * reviewed range `baseline..HEAD`.
   */
  leftOut: string[];
}

/**
 * Split a repo's untracked, unignored paths into "this session's own" and
 * "leave it alone".
 *
 * EXACT MATCHING, deliberately: paths arrive from `git ls-files --others
 * --exclude-standard -z` (raw form, never the quoted `status` form) and from
 * the edit handler's `repoRelative(path)`, so the two are directly comparable.
 * A pattern match here would be a second, silently different answer to "did
 * this session write it" than the one the edit handler gave.
 */
export function planCheckpointSweep(input: {
  /** Untracked and unignored, in the repo's own raw path form. */
  untracked: readonly string[];
  /** Paths this session wrote, repo-relative. */
  own: readonly string[];
}): CheckpointSweep {
  const own = new Set(input.own);
  const seen = new Set<string>();
  const result: CheckpointSweep = { own: [], leftOut: [] };
  for (const path of input.untracked) {
    // A path listed twice (a rerun, a race between two readers) is one path.
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    if (own.has(path)) result.own.push(path);
    else result.leftOut.push(path);
  }
  return result;
}

/**
 * Every path the checkpoint will commit: the tracked changes (index or
 * worktree) plus the untracked paths this session wrote. EMPTY means there is
 * nothing to commit — the SAME answer the fingerprint gives (D20), so a
 * worktree holding only foreign untracked files reads as clean here too (N1,
 * 2026-09-27: `git status --porcelain` counted them, the commit then died on
 * git's own "nothing added to commit"). It is also the only set the sensitive
 * and file-size checks may judge: a path left out is never committed.
 */
export function checkpointCommitPaths(tracked: readonly string[], sweep: CheckpointSweep): string[] {
  return [...new Set([...tracked, ...sweep.own])];
}

/**
 * Read the repo and answer "what would a checkpoint commit now?". `paths`
 * EMPTY is the worktree being CLEAN — for the checkpoint and for the
 * empty-range exit-goal round alike. Throws on a git failure: callers fail
 * closed.
 */
export function pendingCheckpoint(root: string, own: readonly string[]): { paths: string[]; leftOut: string[] } {
  const status = gitRaw(root, ["status", "--porcelain", "--untracked-files=no"]);
  // The untracked list comes from `ls-files -z`, NOT from porcelain: git
  // QUOTES unusual names in `status`, and handing that form back as a
  // pathspec matches nothing (drill F3).
  const untracked = gitRaw(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0").filter((p) => p.length > 0);
  const sweep = planCheckpointSweep({ untracked, own });
  // Round-5 P2: porcelain has rename (`R  old -> new`) and quoted non-ASCII
  // (`A  "\344\270…"`) forms — take the DESTINATION side of a rename and strip
  // surrounding quotes. Round-6 P2 (measured): NEVER trim the whole status
  // before slicing — porcelain v1 lines carry a leading space in the X column,
  // and `" M path".trim()` shifts the path left, so slice(3) eats a character.
  const pathOf = (l: string): string => {
    let p = l.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4);
    if (p.startsWith("\"") && p.endsWith("\"")) p = p.slice(1, -1);
    return p;
  };
  const tracked = status.split("\n").filter((l) => l.trim().length > 0).map(pathOf);
  return { paths: checkpointCommitPaths(tracked, sweep), leftOut: sweep.leftOut };
}
