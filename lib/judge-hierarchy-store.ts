/**
 * THE SHARED JUDGE REGISTRY FILE — how several processes write one
 * `.pi/judge-hierarchy.json` without erasing each other (2026-09-27).
 *
 * Every opener in a checkout (a project manager, a child session sharing the
 * checkout, the judges themselves) keeps its own in-memory copy of the table
 * and used to persist it by OVERWRITING the file with that copy — and by
 * deleting the file when its copy was empty. Measured (orch-f3eb4277,
 * 2026-09-26 15:22): a child reclaimed its last judge, its copy was empty, the
 * file went away one second before the manager's plan auditor concluded, and
 * `judge_conclude` refused with 「登记表里没有本 review」. Nobody answered the
 * auditor's follow-up question and the manager's `submit` ended in a bare
 * "no verdict".
 *
 * THE FIX IS A THREE-WAY MERGE UNDER A LOCK. Each process remembers the slice
 * it last read or wrote (`base`). On persist it takes the lock, re-reads the
 * file (`disk`), and writes back only what IT changed since `base` — an entry
 * it added, modified or removed — leaving every other entry exactly as the
 * file has it. No call site has to announce its changes: the diff against
 * `base` is the announcement.
 *
 * THE LOCK NEVER DEGRADES INTO AN UNLOCKED WRITE: a merge without it is the
 * race it exists to close. A lock whose holder is provably gone (its pid no
 * longer exists) is broken; a live holder is waited for, and past the budget
 * the write is REFUSED and the caller keeps its changes for the next attempt.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import { parseHierarchySnapshot, type JudgeEntry } from "./hierarchy.ts";
import type { PendingAudit } from "./audit-round-specs.ts";
import type { ModelHealth } from "./model-health.ts";
import { pidAlive as defaultPidAlive } from "./session-registry.ts";

/** One repo's slice of the registry — what the file holds. */
export interface HierarchySlice {
  judges: Record<string, JudgeEntry>;
  audit?: PendingAudit;
  modelHealth?: ModelHealth;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The three-way merge: `mine` wins exactly where it differs from `base`,
 * `disk` wins everywhere else. An id `mine` dropped since `base` is removed
 * from the result (a tombstone), so a peer's copy can never resurrect it — and
 * an id only `disk` has (a peer's judge) is kept, whatever `mine` looks like.
 */
export function mergeHierarchySlice(
  base: HierarchySlice | undefined,
  mine: HierarchySlice,
  disk: HierarchySlice | undefined,
): HierarchySlice {
  const baseJudges = base?.judges ?? {};
  const judges: Record<string, JudgeEntry> = { ...(disk?.judges ?? {}) };
  for (const id of new Set([...Object.keys(baseJudges), ...Object.keys(mine.judges)])) {
    if (same(baseJudges[id], mine.judges[id])) continue;
    const entry = mine.judges[id];
    if (entry === undefined) delete judges[id];
    else judges[id] = entry;
  }
  // The audit and the health are one value per repo: whoever changed it last wins.
  const audit = same(base?.audit, mine.audit) ? disk?.audit : mine.audit;
  const modelHealth = same(base?.modelHealth, mine.modelHealth) ? disk?.modelHealth : mine.modelHealth;
  return {
    judges,
    ...(audit === undefined ? {} : { audit }),
    ...(modelHealth === undefined || Object.keys(modelHealth).length === 0 ? {} : { modelHealth }),
  };
}

/** Read one slice file; missing or corrupt reads as "nothing there". */
export function readHierarchySlice(file: string): HierarchySlice | undefined {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return undefined; }
  const snap = parseHierarchySnapshot(raw);
  if (!snap) return undefined;
  return {
    judges: snap.judges,
    ...(snap.audit === undefined ? {} : { audit: snap.audit }),
    ...(snap.modelHealth === undefined ? {} : { modelHealth: snap.modelHealth }),
  };
}

export interface LockOptions {
  /** How long a LIVE holder is waited for before the write is refused. */
  timeoutMs?: number;
  /** Is this pid still a process? Injectable for tests. */
  pidAlive?: (pid: number) => boolean;
}

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_POLL_MS = 20;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take `<file>.lock` (its content: the holder's pid). Returns false when a
 * live holder kept it past the budget. A holder whose pid is gone is a crash
 * leftover and is broken; an unreadable or pid-less lock is treated as live —
 * it is most likely a holder between creating the file and writing its pid.
 */
function acquireLock(lock: string, opts: LockOptions): boolean {
  const deadline = Date.now() + (opts.timeoutMs ?? LOCK_TIMEOUT_MS);
  const pidAlive = opts.pidAlive ?? defaultPidAlive;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    let holder = Number.NaN;
    try { holder = Number.parseInt(readFileSync(lock, "utf8"), 10); } catch { /* vanished: retry now */ continue; }
    if (Number.isInteger(holder) && holder > 0 && !pidAlive(holder)) {
      try { rmSync(lock, { force: true }); } catch { /* the next attempt decides */ }
      continue;
    }
    if (Date.now() >= deadline) return false;
    sleepSync(LOCK_POLL_MS);
  }
}

/**
 * Merge `mine` into the file under the lock and return what the file now
 * holds — or `undefined` when the lock could not be taken or the write
 * failed, in which case NOTHING was written and the caller keeps its changes.
 * An empty result removes the file (no empty shells left behind).
 */
export function writeHierarchySlice(
  file: string,
  base: HierarchySlice | undefined,
  mine: HierarchySlice,
  opts: LockOptions = {},
): HierarchySlice | undefined {
  const lock = `${file}.lock`;
  try { mkdirSync(dirname(file), { recursive: true }); } catch { /* acquireLock reports it */ }
  if (!acquireLock(lock, opts)) return undefined;
  try {
    const merged = mergeHierarchySlice(base, mine, readHierarchySlice(file));
    const empty = Object.keys(merged.judges).length === 0 && !merged.audit && !merged.modelHealth;
    if (empty) rmSync(file, { force: true });
    else writeFileAtomic(file, JSON.stringify({ version: 1, ...merged }));
    return merged;
  } catch {
    return undefined;
  } finally {
    try { rmSync(lock, { force: true }); } catch { /* a leftover lock is broken by the pid check */ }
  }
}
