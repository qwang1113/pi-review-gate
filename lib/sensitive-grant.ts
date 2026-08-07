/**
 * One-shot user authorization for editing a sensitive file.
 *
 * WHY THIS EXISTS. `isSensitiveFile()` blocks the model from writing `.env`,
 * private keys, credential files and `.git/` internals. That guard is a
 * security floor and stays on in EVERY task mode. But the honest answer to
 * "the user actually wants this `.env` line changed" used to be "ask the user
 * to do it by hand" — which, in a non-interactive turn, silently stalls the
 * task. This module models the missing third option: the agent ASKS, the USER
 * decides in an extension-rendered dialog, and a single edit gets through.
 *
 * THE SHAPE OF THE PERMISSION. Every property here is deliberately narrow,
 * because a sensitive-file write is exactly what an injected instruction would
 * want to buy with one careless "yes":
 *
 *   - PATH-EXACT. A grant authorizes one normalized absolute path, never a
 *     directory, a pattern, or "sensitive files" as a class.
 *   - SINGLE-USE. The grant is consumed by the first edit that SUCCEEDS on
 *     that path. A failed edit (bad anchor, unreadable file) does not burn it,
 *     so a retry does not need a second dialog. The bound is "one landed edit"
 *     rather than "one tool call" on purpose; with tools executing serially
 *     the two coincide, and the retry case is the one that actually happens.
 *   - TTL-BOUNDED. Even unused, a grant dies after {@link SENSITIVE_GRANT_TTL_MS}.
 *     A "yes" from twenty minutes ago is not consent for what the conversation
 *     has drifted into.
 *   - NEVER PERSISTED. The extension keeps grants in memory only. A crash, a
 *     resume, or a second session starts with none — the fail-closed default.
 *
 * WHAT IS NOT GRANTABLE. `.git/` internals are refused before any dialog is
 * shown (see {@link isGateIntegrityPath}). They are not the user's secrets;
 * they are the gate's own enforcement (`.git/hooks/pre-commit` is the L3
 * layer). A dialog there would let the agent talk the user into disarming the
 * thing that is supposed to be checking the agent. A human who really wants to
 * change a hook can still do it by hand.
 *
 * PURITY. No IO, no clock, no throwing: `now` is injected and every function
 * returns a new value. The extension owns the dialog, the timer, and the
 * storage; this module owns the rules.
 */

import { resolve as pathResolve } from "node:path";

/**
 * How long an unused grant stays valid.
 *
 * Short on purpose. The grant is normally consumed within seconds (ask →
 * edit), so this window only bounds the pathological case where the agent
 * asks, wanders off, and comes back with a different intention.
 */
export const SENSITIVE_GRANT_TTL_MS = 10 * 60 * 1000;

export interface SensitiveGrant {
  /** Normalized absolute path the user authorized — compared verbatim. */
  path: string;
  /** ISO timestamp of the user's approval (diagnostics + dialog copy). */
  at: string;
  /** Epoch ms after which the grant is dead. */
  expiresAt: number;
  /** The agent's stated reason, kept for the audit line in the tool result. */
  reason: string;
}

/**
 * Resolve a tool-supplied path to the form grants are keyed by.
 *
 * `resolve` also collapses `..` and `.`, so `/p/sub/../.env` and `/p/.env`
 * cannot be two different keys. Symlinks are deliberately NOT followed: that
 * would need filesystem IO (and would throw for a file about to be created).
 * The consequence is fail-CLOSED — a spelling that reaches the same inode by
 * another name simply does not match the grant and needs its own dialog.
 */
export function normalizeSensitivePath(raw: string, cwd: string): string {
  return pathResolve(cwd, raw);
}

/**
 * Paths that no user dialog may unlock (see the module header).
 *
 * Mirrors the `.git` branch of `SENSITIVE_FILE_PATTERNS`: `.git/…` or a bare
 * `.git` segment, but never `.gitignore` / `.github`.
 */
export function isGateIntegrityPath(filePath: string): boolean {
  return /(^|\/)\.git(\/|$)/i.test(filePath);
}

/** The live grant for `absPath`, or undefined when there is none / it expired. */
export function findGrant(
  grants: readonly SensitiveGrant[],
  absPath: string,
  now: number,
): SensitiveGrant | undefined {
  return grants.find((g) => g.path === absPath && g.expiresAt > now);
}

/**
 * Add a grant, replacing any previous one for the same path.
 *
 * Expired entries are dropped in the same pass so the list cannot grow without
 * bound in a long session.
 */
export function addGrant(
  grants: readonly SensitiveGrant[],
  grant: SensitiveGrant,
  now: number,
): SensitiveGrant[] {
  return [...grants.filter((g) => g.path !== grant.path && g.expiresAt > now), grant];
}

/**
 * Consume the grant for `absPath` (the edit landed).
 *
 * Returns the consumed grant plus the remaining list. When nothing matches,
 * `consumed` is undefined and the list is only pruned of expired entries — so
 * an ordinary edit to a non-sensitive file can call this unconditionally.
 */
export function consumeGrant(
  grants: readonly SensitiveGrant[],
  absPath: string,
  now: number,
): { consumed: SensitiveGrant | undefined; remaining: SensitiveGrant[] } {
  const consumed = findGrant(grants, absPath, now);
  const remaining = grants.filter((g) => g.expiresAt > now && g !== consumed);
  return { consumed, remaining };
}
