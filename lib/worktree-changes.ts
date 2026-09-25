/**
 * Worktree change probes — which paths moved, and by how much.
 *
 * Split out of lib/fingerprint.ts: these read `git status` / `git diff` to
 * LIST changes (prompt tokens, review scope, arming), whereas fingerprint.ts
 * computes the content-addressed digest a verdict binds to. Neither ever
 * decides whether a gate is satisfied.
 */

import { gitText as git, gitOrNull, gitRawOrNull } from "./git-exec.ts";
import { sha256 } from "./hash.ts";
import { statSync } from "node:fs";
import { join } from "node:path";
import { worktreeTreeOid } from "./fingerprint.ts";

/**
 * Status pathspecs for changedFiles(). `:(top,exclude)` = "exclude this path
 * measured from the repo root", the exclusion counterpart of `:/`.
 * (`git status` reports repo-root-relative paths already, so no `:/` include
 * spec is needed to widen its scope.)
 */
const STATUS_EXCLUDE_PATHSPECS: readonly string[] = Object.freeze([
  ":(top,exclude).pi",
  ":(top,exclude).pi-subagents",
]);

/**
 * ADVISORY-ONLY change token — a ~10ms stand-in for "has the worktree moved
 * since the last fingerprint?", used SOLELY to skip a redundant recompute
 * when rendering the per-turn system prompt.
 *
 * ####################################################################
 * # NEVER use this to decide whether a gate is SATISFIED. It is not a #
 * # fingerprint and it is not staging-invariant. Enforcement paths    #
 * # (ship blocks, declare_done, verdict recording, arbitration, git   #
 * # hooks) MUST call computeFingerprint() directly, every time.       #
 * ####################################################################
 *
 * Why a token instead of caching computeFingerprint() behind edit events:
 * an event-driven cache keyed on "the extension saw no edit tool call" is
 * unsound — `sed -i` in bash, an external editor, format-on-save, or a
 * background process all change the worktree without any event, and this
 * gate's threat model explicitly includes an agent editing files through
 * arbitrary bash. This token instead observes the FILESYSTEM:
 *
 *   sha256( porcelain status of the whole repo  ||  size+mtime of every
 *           path that status reports as changed )
 *
 * so it moves for every change the gate can normally see, including repeated
 * edits to a file that was ALREADY dirty (whose status line does not change —
 * the case that would make a status-only token useless in practice).
 *
 * Residual blind spot, deliberately accepted: an edit that keeps the file's
 * size AND lands in the same filesystem mtime bucket can leave the token
 * unchanged (exactly the racily-clean window that computeFingerprint spends
 * its ~466ms/9k-files defeating). The consequence is bounded to a STALE
 * PROMPT — the agent may be told "all gates satisfied" one turn too long —
 * because every path that can actually ship, end the task, or record a
 * verdict recomputes the real fingerprint. It can never turn a stale READY
 * into a commit.
 *
 * Returns null when the token cannot be computed (git unreadable): callers
 * must then fall back to computing the real fingerprint, never to reusing a
 * previous one.
 */
export function advisoryChangeToken(cwd: string): string | null {
  // --no-optional-locks: never let this convenience probe write the user's
  // index (a status refresh normally may). Keeps it read-only and cheap.
  const porcelain = gitRawOrNull(cwd, [
    "--no-optional-locks", "status", "--porcelain", "-uall", "-z", "--", ...STATUS_EXCLUDE_PATHSPECS,
  ]);
  if (porcelain === null) return null;

  const files = parsePorcelain(porcelain);

  // Stat every changed path so a SECOND edit to an already-dirty file (whose
  // status line is unchanged) still moves the token. A vanished/unreadable
  // path contributes a marker rather than being skipped, so deletes count too.
  const parts: string[] = [porcelain];
  for (const f of files.slice().sort()) {
    let stamp = "missing";
    try {
      const st = statSync(join(cwd, f));
      stamp = `${st.size}:${st.mtimeMs}`;
    } catch { /* keep "missing" */ }
    parts.push(`${f}\u0000${stamp}`);
  }
  return sha256(parts.join("\u0001"));
}

/**
 * Parse NUL-delimited porcelain into changed paths. Shared by changedFiles()
 * and advisoryChangeToken() so the token needs only ONE `git status` call.
 */
function parsePorcelain(porcelain: string): string[] {
  if (!porcelain) return [];
  const entries = porcelain.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    if (!path) continue;
    // P0-6: rename in -z format: "R  orig\0dest". Include BOTH paths
    // so a code→doc rename arms both gates, not just the destination.
    if (status.startsWith("R") && i + 1 < entries.length && entries[i + 1].length > 0 && !entries[i + 1].startsWith("?")) {
      files.push(path);            // old path
      files.push(entries[++i]);    // new path (destination)
    } else {
      files.push(path);
    }
  }
  return files;
}

/** List changed file paths (repo-root-relative) from NUL-delimited porcelain. */
export function changedFiles(cwd: string): string[] | undefined {
  try {
    const porcelain = gitRawOrNull(cwd, ["status", "--porcelain", "-uall", "-z", "--", ...STATUS_EXCLUDE_PATHSPECS]);
    if (porcelain === null) return undefined;
    return parsePorcelain(porcelain);
  } catch {
    return undefined;
  }
}

/** Files and changed-line count between two trees. */
export interface TreeIncrement {
  files: string[];
  lines: number;
}

/**
 * Parse `git diff --numstat -z` output.
 *
 * The `-z` form emits `adds\tdels\tpath\0` for ordinary changes and
 * `adds\tdels\t\0old\0new\0` for renames — the trailing tab with an empty
 * path is the marker that two more records follow. Binary files report `-`
 * for both counts, which contributes 0 lines but still counts as a file.
 */
function parseNumstatZ(out: string): TreeIncrement {
  const parts = out.split("\0");
  const files: string[] = [];
  let lines = 0;
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const fields = rec.split("\t");
    if (fields.length < 3) continue;
    const adds = parseInt(fields[0], 10);
    const dels = parseInt(fields[1], 10);
    if (Number.isFinite(adds)) lines += adds;
    if (Number.isFinite(dels)) lines += dels;
    if (fields[2] === "") {
      // Rename: the next two records are the old and the new path. Only the
      // destination is reported — that is the file a reviewer must read.
      const dest = parts[i + 2];
      i += 2;
      if (dest) files.push(dest);
      continue;
    }
    files.push(fields[2]);
  }
  return { files, lines };
}

/**
 * What changed between a previously recorded tree and the worktree as it
 * stands now.
 *
 * Used by the incremental-review scope: `baseTree` is the tree the last READY
 * review was bound to, so this is exactly "what the reviewer has not seen".
 * Returns undefined when it cannot be computed (unknown tree after a `git gc`,
 * unreadable repo) — callers must then fall back to a full review.
 *
 * `baseTree` is re-validated here even though loadSidecar already rejects a
 * malformed one: it ends up in an argv, so "it was checked upstream" is not a
 * property worth betting a `--upload-pack=…`-class injection on.
 */
export function incrementSinceTree(cwd: string, baseTree: string): TreeIncrement | undefined {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(baseTree)) return undefined;
  try {
    const current = worktreeTreeOid(cwd);
    if (current === baseTree) return { files: [], lines: 0 };
    const out = git(cwd, ["diff", "--numstat", "-z", baseTree, current]);
    return parseNumstatZ(out);
  } catch {
    return undefined;
  }
}

/**
 * Every file the CURRENT change covers, relative to the branch's base: the
 * committed work on this branch plus the dirty worktree.
 *
 * This is the scope a full review reads, so recording it with a READY verdict
 * is what later lets the gate say "the increment only touches files that
 * review already covered". Returns undefined when no base can be resolved,
 * which makes the next round fall back to a full review.
 */
export function reviewCoverageFiles(cwd: string): string[] | undefined {
  const bases = ["@{upstream}", "main", "master", "origin/main", "origin/master"];
  let current: string;
  try {
    current = worktreeTreeOid(cwd);
  } catch {
    return undefined;
  }
  for (const base of bases) {
    const merge = gitOrNull(cwd, ["merge-base", base, "HEAD"]);
    if (!merge) continue;
    const out = gitRawOrNull(cwd, ["diff", "--name-only", "-z", merge, current]);
    if (out === null) continue;
    return out.split("\0").filter(Boolean);
  }
  return undefined;
}
