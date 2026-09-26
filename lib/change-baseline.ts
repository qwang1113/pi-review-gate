/**
 * WHICH COMMITS A WORKTREE CHANGE IS COMPARED AGAINST — and the merge fact
 * that was missing from it.
 *
 * ── THE MEASURED DEADLOCK (2026-09-15, dashboard) ──
 *
 * A session merged `main` into a PR branch to resolve conflicts. Resolving a
 * conflict only STAGES the merge; the merge commit is what the session is
 * about to make. Two mechanical gates at the checkpoint asked the same
 * question — "does this file exist in HEAD?" — and HEAD, in that window, is
 * still the BRANCH TIP. So every file `main` brought in "did not exist" and
 * counted as newly created by this session: the file-size gate refused the
 * checkpoint over three files of 847/988/608 lines that `main` had authored
 * long before, and the dependency gate would have demanded a written
 * justification for dependencies `main` added. Measured at the moment of
 * refusal: 104 staged additions, all 104 present in `origin/main`, none of
 * them this session's.
 *
 * The checkpoint is the ONLY way into the review loop, so the round was
 * deadlocked — the gate refused the commit the gate itself requires — and the
 * session escaped by switching the gate OFF (`/gate-mode normal`). Following
 * the gate is what broke the work; that is the failure mode this module
 * removes.
 *
 * ── WHY MERGE_HEAD, AND WHY IT IS THE WHOLE FIX ──
 *
 * A merge commit has more than one parent, and while the merge is in progress
 * git records every parent that is not HEAD in `.git/MERGE_HEAD` — exactly the
 * window the checkpoint runs in. A file that exists in ANY of those parents
 * was not created by this session. Comparing against HEAD alone answers "did
 * this session create it?" with "yes" for everything the other side of the
 * merge carries, which is the wrong answer for the one question the callers
 * are asking.
 *
 * The list is a LIST because octopus merges have more than one extra parent,
 * and the refs are returned as `HEAD` FIRST — the callers that want "the base
 * this session's side is measured from" take the first one that has the path,
 * which keeps the pre-merge behaviour identical when there is no merge.
 *
 * Pure decision (`changeBaseRefsFromMergeHeads`) plus two tiny git readers, so
 * the rule itself is testable without a repository.
 */

import { gitText } from "./git-exec.ts";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** A git object name: sha1 (40) or sha256 (64), lower-case hex. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The refs every "is this new?" question is asked against, given git's raw
 * `MERGE_HEAD` output (one object name per line, or undefined when no merge is
 * in progress).
 *
 * `HEAD` is always first and always present: it is the one base the callers
 * had before, so a repository that is not merging behaves exactly as it did.
 * Anything that is not an object name is dropped rather than passed to git —
 * a malformed line would otherwise become an argv that fails open or closed
 * for reasons nobody can see.
 */
export function changeBaseRefsFromMergeHeads(mergeHeads: string | undefined): string[] {
  const refs = ["HEAD"];
  for (const line of (mergeHeads ?? "").split("\n")) {
    const name = line.trim();
    if (!OBJECT_NAME.test(name)) continue;
    if (!refs.includes(name)) refs.push(name);
  }
  return refs;
}

/** The same list, read from the repository itself. Never throws. */
export function readChangeBaseRefs(root: string): string[] {
  let mergeHeads: string | undefined;
  try {
    // THE FILE, NOT `git rev-parse MERGE_HEAD` (round-1 P1, 2026-09-15). The
    // pseudo-ref resolves to the FIRST parent only: measured on an octopus
    // merge, the reader came back with HEAD plus one side, so every file the
    // OTHER side brought in still looked newly created — the same deadlock
    // this module removes, just harder to hit, and unreproducible from the
    // pure half (which handles a list correctly and so hid the bug).
    //
    // `--git-path` is what makes the read correct inside a linked worktree:
    // the merge state is per-worktree, so the file does NOT live beside the
    // common `.git` we would otherwise guess. A relative answer is resolved
    // against `root`, which is what it is relative to.
    const path = gitText(root, ["rev-parse", "--git-path", "MERGE_HEAD"]);
    if (path.length === 0) return changeBaseRefsFromMergeHeads(undefined);
    mergeHeads = readFileSync(isAbsolute(path) ? path : join(root, path), "utf8");
  } catch {
    // Not merging (or git cannot answer, or the file is gone between the two
    // calls): HEAD alone, the pre-existing behaviour. An unreadable answer
    // must not invent extra bases — a base that does not exist would make
    // every file look NEW, which is the bug this module exists to fix.
    mergeHeads = undefined;
  }
  return changeBaseRefsFromMergeHeads(mergeHeads);
}

/**
 * The FIRST base that carries this path, or undefined when none does.
 *
 * `HEAD` first is deliberate: the callers that compare CONTENT (the dependency
 * justification gate) want the base this session's side branched from, and
 * that is HEAD whenever HEAD has the file. The merge parent is the fallback
 * for the one case HEAD cannot answer — a file the other side introduced.
 */
export function firstBaseContaining(
  root: string,
  path: string,
  refs: readonly string[],
): string | undefined {
  for (const ref of refs) {
    try {
      gitText(root, ["cat-file", "-e", `${ref}:${path}`]);
      return ref;
    } catch {
      // Not in this base — try the next one.
    }
  }
  return undefined;
}

/**
 * Did THIS session create this path? True only when NO base carries it.
 *
 * The name says what the callers mean; the implementation is the whole point
 * of the module: "absent from HEAD" and "created by this session" are the same
 * statement only when HEAD is the only parent.
 */
export function isNewInWorktree(root: string, path: string, refs: readonly string[]): boolean {
  return firstBaseContaining(root, path, refs) === undefined;
}
