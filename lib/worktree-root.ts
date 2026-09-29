/**
 * THE ONE PLACE EVERY GATE WORKTREE LIVES (2026-09-28, user decision).
 *
 * Three kinds of checkout are created or directed by the gate: an
 * orchestration child's isolated checkout, a judge's throwaway verification
 * worktree (its `$TMPDIR`), and a second session's own checkout when the repo
 * already has a live session. All three live under this root and nowhere else
 * — never beside the repository (they piled up there, invisible to
 * `git branch`), never in `os.tmpdir()` (macOS answers `/var/folders/…`).
 *
 * `realpath`, not the literal `/tmp`: on macOS `/tmp` is a symlink to
 * `/private/tmp`, and `git worktree list` reports the resolved path — every
 * prefix comparison against that listing must use the same spelling.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function gateWorktreeRoot(): string {
  let tmp = "/tmp";
  try { tmp = realpathSync("/tmp"); } catch { /* no /tmp: the literal is the honest answer */ }
  return join(tmp, "rg-worktrees");
}

/**
 * Create the root before a worktree is put under it. Every IO entry that
 * builds one calls this first, so nothing depends on `git worktree add`
 * happening to create leading directories.
 */
export function ensureGateWorktreeRoot(): string {
  const root = gateWorktreeRoot();
  mkdirSync(root, { recursive: true });
  return root;
}
