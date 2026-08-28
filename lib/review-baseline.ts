/**
 * Review baseline resolution for the commit execution model (2026-08-27).
 *
 * `prepare_review` baselines the reviewed range from the last READY's
 * reviewed commit. When that commit is no longer an ancestor of HEAD (the
 * chain was squashed or rebased), the baseline must be recovered from the
 * CONTENT: walk the new chain from the checkpoint's parent until a commit
 * whose tree equals the reviewed tree (the SQUASH POINT) — every commit
 * after it is new content the review must cover. Pure over git facts, so
 * the three outcomes are pinned by tests (round-12 P2).
 */

import { execFileSync } from "node:child_process";

/**
 * Walk the parent chain starting at `startSha` and return the NEWEST commit
 * whose tree equals `reviewedTree` — the squash point. Returns undefined
 * when no commit on the walk carries that tree (a content-changing rewrite:
 * the caller falls back to the branch base or the checkpoint baseline).
 *
 * The walk is bounded (`maxSteps`) so a pathological chain cannot hang the
 * tool; hitting the cap falls through to undefined exactly like a clean
 * miss — the caller's fallbacks still cover the content.
 */
export function squashPointBaseline(
  root: string,
  reviewedTree: string,
  startSha: string,
  maxSteps = 100,
): string | undefined {
  let cur = startSha;
  for (let i = 0; i < maxSteps && cur; i++) {
    try {
      const tree = execFileSync("git", ["rev-parse", `${cur}^{tree}`], { cwd: root, encoding: "utf8" }).trim();
      if (tree === reviewedTree) return cur;
      cur = execFileSync("git", ["rev-parse", `${cur}^`], { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return undefined; // chain ended (root commit) or unreadable — clean miss
    }
  }
  return undefined; // cap hit or chain ended — same fallback path as a miss
}

/**
 * The branch base covering every commit of the current branch, whatever the
 * repo calls its default branch: origin/HEAD first (the symbolic default),
 * then the common candidates. Returns undefined when none resolves (a repo
 * with no remote and no main/master — caller falls back further).
 */
export function branchBaseBaseline(root: string): string | undefined {
  const candidates = ["origin/HEAD", "main", "origin/main", "master", "origin/master"];
  for (const base of candidates) {
    try {
      const mb = execFileSync("git", ["merge-base", base, "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      if (mb) return mb;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}
