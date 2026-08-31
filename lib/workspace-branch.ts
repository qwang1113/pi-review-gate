/**
 * Branch-safety facts — the soft guardrail that replaced the work-branch
 * machinery.
 *
 * WHY THIS MODULE IS NOW TINY (2026-09-07, user decision). The workspace
 * settlement layer (`setup_workspace`, dirty-worktree edit blocking, the
 * mandatory session work branch, `declare_done`'s squash-merge) is gone:
 * sessions work directly on the current branch, including main, and the
 * checkpoint review chain (baseline..HEAD, READY tree binding) is what
 * protects the work. What remains is a SOFT prompt — when the session sits on
 * a branch that is obviously not a development branch, the gate says so and
 * asks for confirmation before a checkpoint lands there.
 *
 * Pure functions over injected facts; the extension runs git and the dialogs.
 */

/** Branches a session should never silently checkpoint onto. */
export const PROTECTED_BRANCHES = ["main", "master", "dev", "develop"];

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.includes(branch.trim());
}
