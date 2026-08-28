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

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Temp sibling used for one atomic write. Exported for the tests' benefit. */
export function tempPathFor(path: string, pid: number = process.pid): string {
  return `${path}.tmp-${pid}`;
}

/**
 * Write `content` to `path` atomically, creating the parent directory. Throws
 * what fs throws: callers that treat their state as best-effort catch it, the
 * ones that must not lose data let it propagate.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
