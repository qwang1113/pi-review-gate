/**
 * MESSAGE-ONLY history rewrites, and where a rebase thinks it is.
 *
 * THE DEADLOCK THIS ENDS (observed 2026-08-29). The gate requires English
 * commit messages. When a non-English one is already in the history, BOTH ways
 * to fix it were blocked by the gate itself:
 *
 *   - while the review is BLOCKED, `git commit --amend` is a commit, so L1
 *     refused it;
 *   - after a READY, `git rebase -i` reword stops in a DETACHED HEAD, and the
 *     branch rule ("commit only on this session's work branch") could not name
 *     a branch, so it refused too — and the mid-rebase HEAD is an older commit,
 *     so its tree did not match the reviewed one either.
 *
 * The only remaining exit was a human running `/gate-bypass`: the gate had
 * turned its own rule into an unfixable knot.
 *
 * THE FIX IS AN OBSERVATION, NOT AN EXCEPTION: a commit whose TREE equals the
 * tree of the commit it replaces publishes no content. Every content gate
 * (review binding, precommit binding, unreviewed-commit scan) exists to judge
 * CONTENT, so it has nothing to say about such a commit — and the message it
 * rewrites still goes through L5 at both the tool layer and the commit-msg
 * hook. Nothing is waived: the gates simply do not apply to a no-content
 * commit.
 *
 * Pure: the caller supplies the git facts.
 */

/** What the gate can observe about a commit that may be a message-only rewrite. */
export interface RewriteFacts {
  /** Does the command carry `--amend`? */
  amend: boolean;
  /** Tree the commit would publish, or undefined when it cannot be read. */
  newTree?: string;
  /** Tree of the commit being replaced (HEAD), or undefined. */
  replacedTree?: string;
}

/**
 * True when this commit rewrites a message and nothing else.
 *
 * Fail-closed on missing facts: an unreadable tree proves nothing, so the
 * normal gates apply. The `--amend` requirement keeps the exemption to the
 * shape it was written for — a plain `git commit` with an identical tree is
 * either impossible (git refuses an empty commit) or an explicit
 * `--allow-empty`, which has no reason to skip the gates.
 */
export function isMessageOnlyRewrite(facts: RewriteFacts): boolean {
  if (!facts.amend) return false;
  if (!facts.newTree || !facts.replacedTree) return false;
  return facts.newTree === facts.replacedTree;
}

/**
 * Does this command carry `--amend`? Recognizes the flag as its own token
 * only, so `--amend-something` or an `--amend` inside a quoted message does
 * not count. (The caller passes ONE ship segment, already split by the shared
 * lexer.)
 */
export function hasAmendFlag(command: string): boolean {
  return /(^|\s)--amend(=[^\s]*)?(\s|$)/.test(command);
}

/**
 * The branch a rebase in progress will land back on.
 *
 * `git rebase` records the original ref in `.git/rebase-merge/head-name` (or
 * `.git/rebase-apply/head-name` for the am-based backend) as a full ref name,
 * e.g. `refs/heads/feature`. During the rebase HEAD is detached, so this file
 * is the ONLY way to answer "which branch is this commit for?" — and answering
 * it is what keeps the branch rule from blocking every reword.
 *
 * A detached rebase started from a raw sha records `detached HEAD`, which is
 * not a branch: that yields undefined, and the branch rule refuses as before.
 */
export function rebaseBranchName(headNameFileContent: string | undefined): string | undefined {
  const raw = headNameFileContent?.trim();
  if (!raw) return undefined;
  const name = raw.startsWith("refs/heads/") ? raw.slice("refs/heads/".length) : raw;
  if (!name || name.includes(" ")) return undefined; // "detached HEAD" and friends
  return name;
}
