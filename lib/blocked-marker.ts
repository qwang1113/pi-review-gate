/**
 * Ownership for the `.blocked` fail-closed marker.
 *
 * WHAT THE MARKER IS. When the extension cannot write the gate sidecar, the
 * L3 git hook would otherwise verify a STALE sidecar and happily ship a tree
 * nobody reviewed. So a write failure drops a `<sidecar>.blocked` file, and
 * `hooks/pre-commit` refuses to commit while it exists.
 *
 * WHY OWNERSHIP. The marker used to be a content-free flag, removed with an
 * unconditional `unlink` on session start and after every successful write.
 * That made two very different situations indistinguishable:
 *
 *   - an ORPHAN left by a session that has since died (must be reclaimed,
 *     otherwise the repo stays uncommittable forever), and
 *   - a LIVE fail-closed signal from a CONCURRENT session whose state never
 *     reached disk (must be preserved — deleting it turns the gate's
 *     fail-CLOSED into a fail-OPEN, because the surviving sidecar is stale
 *     but perfectly well-formed).
 *
 * The marker therefore carries its owners. Reclaiming is allowed only for
 * owners this session can prove are gone.
 *
 * WHAT THE HOOK DOES NOT DO. `hooks/pre-commit` still tests EXISTENCE ONLY and
 * never parses this file. That is deliberate and load-bearing: during an
 * upgrade an OLD extension still writes the legacy plain-text marker, and a
 * hook that "parsed and failed open" on it would ship unreviewed code. Parsing
 * lives here, in the extension, where a parse failure can be resolved
 * conservatively (keep the file).
 */

import { hostname } from "node:os";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

import { CONCURRENT_SESSION_WINDOW_MS } from "./constants.ts";

/**
 * One session's claim on the marker.
 *
 * `pid`/`host` are DIAGNOSTIC ONLY — they exist so a human staring at a stuck
 * repo can tell which process failed. They are deliberately NOT part of the
 * reclaim decision: a liveness probe (`process.kill(pid, 0)`) is meaningless
 * for a repo shared across hosts/containers and, with pid reuse, can even
 * report a stranger's process as "our" owner.
 */
export interface BlockedOwner {
  /** Pi session id, or null when the host process exposes none. */
  sessionId: string | null;
  /** Diagnostic only (see above). */
  pid: number;
  /** Diagnostic only (see above). */
  host: string;
  /** ISO timestamp of the write failure — the only aging signal used. */
  at: string;
}

export interface BlockedMarker {
  schema: 1;
  owners: BlockedOwner[];
}

/** What reconcileBlockedMarker() actually did, for tests and diagnostics. */
export type BlockedMarkerAction =
  /** No marker file present. */
  | "absent"
  /** Present but unparsable (legacy/corrupt/hand-written) → left untouched. */
  | "kept-unparsable"
  /** Parsed; nothing was reclaimable → left untouched. */
  | "kept"
  /** Some owners reclaimed, others survive → file rewritten. */
  | "rewritten"
  /** Every owner reclaimed → file removed. */
  | "removed"
  /** An IO error prevented the update → assume the marker still stands. */
  | "io-error";

/** The marker path for a sidecar path. Single, fixed suffix: the git hook
 *  tests exactly this name, so it must never become a glob or a directory. */
export function blockedMarkerPath(sidecar: string): string {
  return `${sidecar}.blocked`;
}

function isOwner(v: unknown): v is BlockedOwner {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (o.sessionId === null || typeof o.sessionId === "string") &&
    typeof o.pid === "number" && Number.isInteger(o.pid) &&
    typeof o.host === "string" &&
    typeof o.at === "string" && Number.isFinite(Date.parse(o.at));
}

/**
 * Parse marker content, or null when it cannot be trusted.
 *
 * STRICT ON PURPOSE: a single malformed owner invalidates the WHOLE file
 * rather than being dropped. Dropping it would silently shrink the owner set,
 * and an owner set that reaches zero gets the marker deleted — i.e. a corrupt
 * byte could delete a live session's fail-closed signal. Callers must treat
 * null as "keep the file exactly as it is".
 *
 * An empty `owners` array is valid and means "nobody claims this anymore":
 * that empty shell IS reclaimable, which is how a rewritten-to-empty marker
 * (should a crash ever produce one) gets cleaned up.
 */
export function parseBlockedMarker(raw: string): BlockedMarker | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const m = parsed as Record<string, unknown>;
  if (m.schema !== 1 || !Array.isArray(m.owners)) return null;
  if (!m.owners.every(isOwner)) return null;
  return { schema: 1, owners: m.owners as BlockedOwner[] };
}

/**
 * Add/refresh this session's claim.
 *
 * Keyed by sessionId so repeated failures in one session do not grow the file.
 * A null sessionId (no session identity available) cannot be keyed, so each
 * such failure appends a distinct owner — deliberately: without an identity
 * we must not assume two anonymous failures came from the same process.
 */
export function upsertBlockedOwner(prev: BlockedMarker | null, me: BlockedOwner): BlockedMarker {
  const others = (prev?.owners ?? []).filter(
    (o) => !(me.sessionId !== null && o.sessionId === me.sessionId),
  );
  return { schema: 1, owners: [...others, me] };
}

export interface ReconcileResult {
  /** Owners that must keep the marker alive. */
  survivors: BlockedOwner[];
  /** True when at least one owner was reclaimed. */
  changed: boolean;
}

/**
 * Decide which owners still hold the marker.
 *
 * Exactly two reclaim signals, both cheap, deterministic and unit-testable:
 *
 *  1. IT IS OURS. We are running right now and just wrote the sidecar
 *     successfully, so our earlier failure is resolved. Zero risk of deleting
 *     someone else's signal.
 *
 *  2. IT IS OLDER THAN THE CONCURRENT-SESSION WINDOW. A live session persists
 *     far more often than the window; an owner that has not been refreshed
 *     within it belongs to a session that died. The same window already
 *     defines "another session is live in this repo" elsewhere in the gate.
 *
 * The age is read from `owner.at`, never from the file's mtime: any owner's
 * upsert rewrites the file and would reset a shared mtime (and `touch` would
 * resurrect a dead owner). Timestamps in the FUTURE (clock skew between hosts
 * sharing a checkout) are not reclaimed — skew must not delete a live signal.
 */
export function reconcileBlockedOwners(
  marker: BlockedMarker,
  mySessionId: string | null,
  nowMs: number,
  windowMs: number = CONCURRENT_SESSION_WINDOW_MS,
): ReconcileResult {
  const cutoff = nowMs - windowMs;
  const survivors = marker.owners.filter((o) => {
    if (mySessionId !== null && o.sessionId === mySessionId) return false;
    const at = Date.parse(o.at);
    if (!Number.isFinite(at)) return true; // unreadable age → keep (fail-closed)
    return at > cutoff;
  });
  return { survivors, changed: survivors.length !== marker.owners.length };
}

/** Atomic write, so a concurrent upsert can never leave truncated JSON that a
 *  later parse would reject forever (an unparsable marker is never removed). */
function writeMarkerAtomically(path: string, marker: BlockedMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
  renameSync(tmp, path);
}

/** File content, or null when the marker does not exist (an EMPTY file is
 *  content: it exists, fails to parse, and is therefore kept). */
function readMarkerFile(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/**
 * Record a sidecar write failure for this session (fail-closed).
 *
 * Never throws: this runs on the path where writing already failed, and the
 * marker's whole job is to stop a commit. If it cannot be written at all, the
 * caller has nothing better to do than continue.
 *
 * An existing UNPARSABLE marker is left byte-for-byte alone. It already blocks
 * commits, which is the entire point, and overwriting it would discard the
 * evidence a human needs to understand where it came from.
 */
export function recordBlockedMarker(
  path: string,
  owner: { sessionId: string | null; nowMs?: number },
): void {
  try {
    const raw = readMarkerFile(path);
    const prev = raw === null ? null : parseBlockedMarker(raw);
    if (raw !== null && prev === null) return; // unparsable → already fail-closed
    let host = "";
    try { host = hostname(); } catch { /* sandbox without hostname */ }
    const me: BlockedOwner = {
      sessionId: owner.sessionId,
      pid: process.pid,
      host,
      at: new Date(owner.nowMs ?? Date.now()).toISOString(),
    };
    writeMarkerAtomically(path, upsertBlockedOwner(prev, me));
  } catch { /* best effort: the gate is already fail-closed without this */ }
}

/**
 * Reclaim what this session may reclaim, keep everything else.
 *
 * Replaces the old unconditional `unlink` on both call paths (session start and
 * a successful sidecar write). Never throws — a failure here must not break
 * persistence — and reports what it did so callers/tests can assert it.
 */
export function reconcileBlockedMarker(
  path: string,
  opts: { sessionId: string | null; nowMs?: number; windowMs?: number },
): BlockedMarkerAction {
  const raw = readMarkerFile(path);
  if (raw === null) return "absent";
  const marker = parseBlockedMarker(raw);
  if (!marker) return "kept-unparsable";
  const { survivors, changed } = reconcileBlockedOwners(
    marker, opts.sessionId, opts.nowMs ?? Date.now(), opts.windowMs,
  );
  // An owner-less marker is reclaimed even though `changed` is false: nobody
  // claims it, so keeping it would block commits forever with no signal behind
  // it. Our own writes never produce one (an upsert always includes us, and a
  // reconcile that empties the set unlinks instead of writing) — this only
  // catches a hand-written shell.
  if (survivors.length === 0) {
    try {
      unlinkSync(path);
      return "removed";
    } catch {
      // Could not remove it → the marker stands, which is the safe direction.
      return "io-error";
    }
  }
  if (!changed) return "kept";
  try {
    writeMarkerAtomically(path, { schema: 1, owners: survivors });
    return "rewritten";
  } catch {
    // Could not update it → the marker stands, which is the safe direction.
    return "io-error";
  }
}
