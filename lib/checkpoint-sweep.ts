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
 * Pure: two lists in, one plan out. The git calls stay at the call site.
 */

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
