/**
 * WHAT THE ACCEPTANCE ROUND LOOKS AT (2026-09-29, user decision).
 *
 * Two measured failures, one fact behind both: the round was sized by the
 * sticky `hasCodeChange` flag and by the whole goal, never by what actually
 * changed since it last passed.
 *
 *   - a round that touched only docs or tests still dispatched a real
 *     acceptance (`*.test.ts` is `.ts`, and a branch ahead of its base keeps
 *     `hasCodeChange` set for good);
 *   - a 20-line fix after an acceptance READY re-ran the WHOLE plan (25+ min).
 *
 * So the round is scoped to `base..worktree`, where `base` is the HEAD the last
 * acceptance READY ran on, else the branch base. The decision itself stays in
 * lib/acceptance-round.ts; this module only answers "which files" and "does
 * any of them run".
 */

import { isDocFile } from "./constants.ts";
import { gitRawOrNull } from "./git-exec.ts";
import { branchBaseBaseline } from "./review-baseline.ts";
import { changedFiles } from "./worktree-changes.ts";

const TEST_DIR = /(^|\/)(test|tests|__tests__)\//;
const TEST_NAME = /\.(test|spec)\.[^./]+$/;

/**
 * Does this file need a real acceptance? Only a file that is POSITIVELY a doc
 * or a test is exempt — config, SQL, templates and extension-less hooks all run.
 */
export function needsAcceptance(path: string): boolean {
  return !(isDocFile(path) || TEST_DIR.test(path) || TEST_NAME.test(path));
}

/** Where the scope starts: the last accepted HEAD, else the branch base. */
export function acceptanceBase(root: string, acceptedHead: string | undefined): string | undefined {
  return acceptedHead ?? branchBaseBaseline(root);
}

/**
 * Files changed from `base` to the WORKTREE (committed + uncommitted +
 * untracked). `undefined` = git could not say — the caller then keeps the
 * stricter old behaviour (dispatch).
 */
export function filesSince(root: string, base: string | undefined): string[] | undefined {
  if (base === undefined) return undefined;
  const diff = gitRawOrNull(root, ["diff", "--name-only", "-z", base]);
  const dirty = changedFiles(root);
  if (diff === null || dirty === undefined) return undefined;
  return [...new Set([...diff.split("\0").filter(Boolean), ...dirty])];
}
