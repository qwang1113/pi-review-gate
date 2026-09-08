/**
 * OUT-OF-REPO PATH JUDGEMENT — the one supervision question that survives the
 * plan's file boundaries: "did this child write somewhere it had no business
 * writing?"
 *
 * WHAT CHANGED (2026-09-17, user decision). This module used to be the tail of
 * `lib/orchestrator-boundaries.ts`, which existed to compare a task's declared
 * file boundaries. The boundaries are gone: since 2026-09-07 the scheduler
 * serializes WITHIN a repo and parallelizes only ACROSS repos
 * (`scheduleNextTasks` keys on `repo`), so a boundary had stopped preventing
 * any collision and survived only as an approval burden — every new file
 * outside the declared directories revoked the plan approval and woke the
 * user. What is left, and what this module owns, is the part that was never
 * about collisions: a landing OUTSIDE the repository altogether.
 *
 * THE SIGNAL IS ABSOLUTENESS. A child's gate records an edit repo-relative
 * when the file is inside its worktree and ABSOLUTE when it is not
 * (extensions/review-gate.ts's `repoRelative`), so "absolute" IS the
 * out-of-repo signal in `sessionEditedFiles` — and this module needs no
 * filesystem access to read it, which is what keeps it pure.
 *
 * NOT EVERY OUT-OF-REPO WRITE MATTERS. USER DECISION 2026-09-06 (方案 C),
 * measured twice in round 4: a child that wrote its completion report to
 * `/tmp` was reported as a violation for a purely mechanical reason. A
 * process artifact cannot pollute the worktree, cannot enter a checkpoint and
 * cannot reach a tracked file, and each false positive cost a manual approval
 * (~10 minutes across the round). Writing a report to `/tmp` and writing to
 * `~/.ssh/id_rsa` are not the same act, and only the first one is noise — so
 * only the SENSITIVE out-of-repo paths count.
 *
 * Pure string module: no filesystem, no git, no process.
 */

import { isSensitiveFile } from "./constants.ts";

/**
 * Is this edited path OUTSIDE the repository altogether?
 *
 * A relative path that escapes with `..` is deliberately NOT treated as
 * out-of-repo: it cannot be resolved without IO, so it is left to the caller
 * rather than guessed at here.
 */
export function isOutsideRepoPath(path: string): boolean {
  const raw = String(path ?? "").trim();
  return raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw);
}

/**
 * Directory names that make an out-of-repo path SENSITIVE regardless of where
 * the home directory happens to be.
 *
 * NAMED BY SEGMENT, NOT BY `~/` PREFIX — and that is the whole point (caught
 * in this task's own goal audit, P1): `sessionEditedFiles` holds paths the
 * shell already expanded (`/Users/x/.ssh/id_rsa`), so a literal `~/.ssh/`
 * comparison could never match, and a test written against the tilde form
 * would pass while the real path sailed through. Matching the SEGMENT also
 * makes the rule wider than the home directory — `/tmp/backup/.ssh/id_rsa` is
 * caught too, which is the fail-closed direction for a security floor.
 */
export const OUT_OF_REPO_SENSITIVE_SEGMENTS: readonly string[] = Object.freeze([
  ".ssh",     // keys, known_hosts, config
  ".pi",      // the agent's own configuration and gate state
  ".aws",     // cloud credentials
  ".gnupg",   // secret keyrings
  ".config",  // gh/, git/, and every other tool's credentials
  ".kube",    // cluster credentials
  ".docker",  // registry auth
]);

/**
 * Is this out-of-repo path one the gate still refuses to wave through?
 *
 * Two sources, deliberately both: the repo-wide sensitive-file patterns
 * (.env, private keys, credentials, `.git/` internals, the gate's own state)
 * and the directory segments above. Neither replaces the EDIT-TIME floor in
 * lib/ship-gate-edit-guard.ts — that one blocks the write itself and is
 * untouched. This is the supervision-time reading of the same question.
 */
export function isSensitiveOutsideRepoPath(path: string): boolean {
  const raw = String(path ?? "").trim();
  if (raw.length === 0) return false;
  if (isSensitiveFile(raw)) return true;
  const segments = raw.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.some((s) => OUT_OF_REPO_SENSITIVE_SEGMENTS.includes(s.toLowerCase()));
}

/**
 * The edited paths that count as a violation (empty ⇒ nothing to report).
 *
 * Only out-of-repo AND sensitive. Everything inside the repository is the
 * child's own worktree to write in — that question used to be answered by the
 * task's declared file boundaries, and the user removed them (2026-09-17):
 * with same-repo tasks serialized, two writers cannot collide, so a path
 * inside the repo is not the gate's business.
 */
export function sensitiveOutOfRepoEdits(paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const raw = String(p ?? "").trim();
    if (raw.length === 0) return false;
    return isOutsideRepoPath(raw) && isSensitiveOutsideRepoPath(raw);
  });
}
