/**
 * Which repository — if any — an edit belongs to.
 *
 * THE BUG THIS EXISTS FOR (reported round 2 through round 8, never fixed until
 * now). The edit tracker asked `gitRootOfDir(dirname(path))` and treated a
 * `null` answer as "the session repo". A file outside every git repository —
 * the `/tmp/report.md` a child session writes its completion report to —
 * therefore armed the session repo's doc gate, ran `invalidateBindings`
 * (READY → PENDING, PASS → NOT_RUN), deleted the completion record and joined
 * the round's edited-file set. Nothing inside the repo had changed: the file is
 * absent from `changedFiles()` and from the worktree fingerprint, so no
 * reviewer could ever see it, yet a whole extra review round was owed. One
 * measured session paid three of them.
 *
 * The one direction this must never get wrong is the other one: a file that
 * really is in the repo must never be classified `outside`, because that would
 * let an edit the reviewer WILL see keep a stale READY alive. Hence:
 *
 *  - git's own answer wins whenever it has one (a nested/sibling repository
 *    keeps its existing cross-repo treatment — that path is untouched);
 *  - when git has none, both sides are resolved through the SAME realpath
 *    helpers the gate-owned check uses (`lib/fingerprint.ts`), so a symlink
 *    pointing into the repo, a `..` that climbs back in, and a symlinked
 *    worktree all land inside;
 *  - containment is tested on a `root + "/"` boundary, so `<repo>-backup/x.ts`
 *    and `<repo>2/y.ts` are outside rather than accidental prefix matches;
 *  - and a path that resolves outside the session repo is asked about ONE more
 *    time, because "no repository" and "another repository" are different
 *    answers and only the first may be skipped: a write into a sibling
 *    checkout arms THAT checkout's gate, exactly as it did before;
 *  - anything unresolvable falls back to `primary`, i.e. to the pre-existing
 *    invalidating behaviour. Being wrong there costs a review round; being
 *    wrong the other way costs the gate.
 */

import { realDir, realFile } from "./fingerprint.ts";

export type EditRepoScope =
  /** Inside the session's own repository (or too unresolvable to claim otherwise). */
  | { scope: "primary" }
  /** Inside a DIFFERENT git repository, whose own gate the edit arms. */
  | { scope: "other-repo"; root: string }
  /** Inside no repository the session tracks — nothing reviewable changed. */
  | { scope: "outside" };

export interface EditRepoScopeInput {
  /** The edited path, already made absolute against the session cwd. */
  absPath: string;
  /** The session repo root, as git reports it. */
  primaryRepoRoot: string;
  /**
   * Repo root containing the edit, as the caller's git attribution answered
   * it, or null when git could not attribute it. The caller MUST climb to the
   * nearest existing ancestor before asking git (`git rev-parse` fails on a
   * directory that does not exist yet, which is precisely what a `write`
   * creating a new nested file targets), so a null answer really does mean
   * "git found no repository here".
   */
  editRepo: string | null;
  /**
   * Second opinion for a path git could not attribute: given the RESOLVED
   * (physical) file path, which repository does it belong to? A symlink from
   * /tmp into a checkout is the case that needs it — the raw path's directory
   * is in no repository while the file itself is. Omitted ⇒ no second
   * opinion, which can only make the answer `outside`, so unit tests may
   * leave it out.
   */
  resolveRepoRoot?: (absFile: string) => string | null;
  /** Injection seam for the tests; defaults to the shared realpath helpers. */
  resolveFile?: (p: string) => string;
  resolveDir?: (p: string) => string;
}

export function classifyEditRepoScope(input: EditRepoScopeInput): EditRepoScope {
  const { absPath, primaryRepoRoot, editRepo } = input;
  if (editRepo && editRepo !== primaryRepoRoot) return { scope: "other-repo", root: editRepo };
  if (editRepo) return { scope: "primary" };

  // git has no answer. Decide by resolved containment — and only a CONFIDENT
  // "not under the root" may say outside.
  if (!absPath || !absPath.startsWith("/") || !primaryRepoRoot.startsWith("/")) {
    return { scope: "primary" };
  }
  const toFile = input.resolveFile ?? realFile;
  const toDir = input.resolveDir ?? realDir;
  let file: string;
  let root: string;
  try {
    file = toFile(absPath);
    root = toDir(primaryRepoRoot);
  } catch {
    return { scope: "primary" };
  }
  if (!file || !root) return { scope: "primary" };
  const boundary = root.endsWith("/") ? root : `${root}/`;
  // `file === root` means the path IS the repo root (a directory, not a file):
  // unexpected enough to keep the old behaviour rather than skip tracking.
  if (file === root || file.startsWith(boundary)) return { scope: "primary" };

  // Not under the session repo — but "no repository" and "another repository"
  // are different answers, and only the first one may be skipped. Ask git
  // again about where the file REALLY lives: a write through a symlink into a
  // sibling checkout must arm that checkout's gate, not vanish.
  let resolvedRoot: string | null = null;
  try {
    resolvedRoot = input.resolveRepoRoot?.(file) ?? null;
  } catch {
    return { scope: "primary" };
  }
  if (resolvedRoot === primaryRepoRoot || resolvedRoot === root) return { scope: "primary" };
  if (resolvedRoot) return { scope: "other-repo", root: resolvedRoot };
  return { scope: "outside" };
}
