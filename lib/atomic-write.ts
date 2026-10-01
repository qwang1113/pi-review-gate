/**
 * Atomic file replacement — the one implementation of the write-temp-then-rename
 * idiom this package uses.
 *
 * Every state file the gate keeps (gate state, blocked marker, timings,
 * attention events) is read by OTHER processes while it is being written: a
 * plain writeFileSync leaves a window in which a reader sees a truncated file
 * and, since these readers all fail open on a parse error, silently loses the
 * state. rename(2) within one directory is atomic, so a reader observes either
 * the old file or the new one.
 *
 * Round-17 Nit (reviewer): the idiom had been hand-rolled four times, with
 * diverging temp-name conventions; this is the consolidation. The temp name
 * carries the pid so two processes never collide on it, and it stays in the
 * TARGET directory because rename is only atomic within a filesystem.
 */

import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Temp sibling used for one atomic write. Exported for the tests' benefit. */
export function tempPathFor(path: string, pid: number = process.pid): string {
  return `${path}.tmp-${pid}`;
}

/**
 * Write `content` to `path` atomically, creating the parent directory. Throws
 * what fs throws: callers that treat their state as best-effort catch it, the
 * ones that must not lose data let it propagate.
 *
 * THE REPLACEMENT KEEPS THE TARGET'S PERMISSIONS (reviewer P1, 2026-10-01). A
 * temp file created at the process umask is usually 0644, so replacing a 0600
 * file with it made the result world-readable — a config holding an API key is
 * exactly the file that must not silently lose its mode. The mode is applied at
 * creation (umask can only CLEAR bits) and re-asserted after the rename, which
 * is what keeps a restrictive file restrictive through the swap.
 *
 * `opts.mode` IS THE OTHER HALF OF THAT (quality round P2, 2026-10-01): when
 * the caller knows what the file must be (the daemon's 0600 state / token /
 * identity), "keep whatever is there" is not enough — the target may not exist
 * yet, or may exist at a looser mode. Passing a mode ENFORCES it: created with
 * it, and re-asserted after the rename. `lib/daemon/state.ts` used to hand-roll
 * the same temp+rename+chmod for exactly this reason; the parameter is what
 * removed the second implementation.
 *
 * Passing neither leaves the target's own bits alone, which is what every
 * other caller wants.
 */
export function writeFileAtomic(path: string, content: string, opts: { mode?: number } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = opts.mode ?? existingMode(path);
  const tmp = tempPathFor(path);
  writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
  if (mode !== undefined) {
    try {
      chmodSync(path, mode);
    } catch {
      /* the creation mode already carried it; a failed chmod is not a data loss */
    }
  }
}

/** The target's permission bits, or undefined when it does not exist yet. */
function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}
