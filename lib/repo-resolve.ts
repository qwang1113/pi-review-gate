/**
 * Multi-repo resolution for the ship gate.
 *
 * Why this exists (root cause): the gate binds review/precommit verdicts to a
 * worktree fingerprint of the SESSION cwd's git repository. An agent that
 * `cd`s into a DIFFERENT git repository (sibling checkout, submodule, …),
 * edits there, and ships from there was checked against the WRONG repo's
 * sidecar and fingerprint — a stale READY+PASS on the session repo legitimated
 * an unreviewed commit in the other repo.
 *
 * This module answers the one question the ship gate needs: "which git
 * repository(s) does this bash command operate on?" It resolves:
 *   - `cd <dir>` chains (absolute, relative, `..`), per shell segment,
 *   - `git -C <dir>` / `git --git-dir <dir>` / `-C<dir>` / `--git-dir=<dir>`,
 *   - a leading `GIT_DIR=<dir>` env assignment on the command head,
 *   - a fallback to the session cwd when nothing resolvable is present.
 *
 * Fail-closed philosophy (mirrors lib/ship-detect.ts):
 *   - anything we cannot statically resolve (`cd $VAR`, `cd ~`, bare `cd`,
 *     `cd -`, variable dirs) sets `ambiguous` — the caller must then widen the
 *     check to EVERY repository this session has edited, not just the parsed
 *     ones, so an unresolved directory can never smuggle an ungated ship.
 *   - a directory that is not inside a git repository resolves to itself; the
 *     caller's fingerprint will be UNAVAILABLE there, which unmetRequirements
 *     already treats as fail-closed.
 */

import { join as pathJoin } from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gitBaseEnv } from "./fingerprint.ts";
import { detectShipCommands, segments, normalizedTokens } from "./ship-detect.ts";

export interface ShipRepoResolution {
  /**
   * Repo roots (or bare dirs) that the command's ship segments operate on,
   * deduplicated, in first-appearance order. Always contains at least the
   * fallback cwd.
   */
  repos: string[];
  /**
   * True when the command contains a directory construct we cannot resolve
   * statically (`cd $VAR`, `cd -`, bare `cd`, `~`, variables in `-C`/GIT_DIR).
   * Callers MUST then also check every repo the session has edited.
   */
  ambiguous: boolean;
}

/** Resolve the git repository root containing `dir` (sanitized env; the same
 *  GIT_DIR/GIT_CONFIG stripping the fingerprint uses, so an ambient variable
 *  cannot relocate the answer). Returns null when `dir` is not in a repo. */
export function gitRootOfDir(dir: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: gitBaseEnv(),
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

interface ResolvedSegment {
  /** The directory this segment executes in (after the cd chain and any
   *  git -C / --git-dir / GIT_DIR override). */
  dir: string;
  /** True when this segment contains a ship operation. */
  ship: boolean;
}

/**
 * Per-segment resolution shared by resolveShipRepos / resolveCommandRepos.
 *
 * Walks the command's shell segments in order, tracking the cd chain and each
 * segment's own git-location override. Any construct that cannot be resolved
 * statically marks the whole command ambiguous (callers widen their check).
 */
function resolveSegments(command: string, cwd: string): { segs: ResolvedSegment[]; ambiguous: boolean } {
  const segsOut: ResolvedSegment[] = [];
  let dir = cwd;
  let ambiguous = false;
  // Command-level: a `cd` target containing $(…) / `…` has its substitution
  // stripped by segments() BEFORE the per-segment pass — detect it on the RAW
  // command so `cd /tmp$(mktemp -u -d) && git commit` stays ambiguous.
  if (/cd\s+[^ \t;|&]*[$`]/.test(command)) ambiguous = true;
  const pushDir = (d: string) => {
    // A directory naming a .git dir means its parent is the repo root
    // (git --git-dir=…/.git, GIT_DIR=…/.git). Strip it here so the
    // fingerprint/sidecar lookups target the worktree, not the internals.
    // Normalize the trailing slash FIRST so `/x/.git/` also resolves to /x
    // (round-3 Nit: stripping .git before the slash left a false-blocking
    // `/x/` vs the real root `/x`).
    let dir2 = d;
    if (dir2.length > 1 && dir2.endsWith("/")) dir2 = dir2.slice(0, -1);
    if (dir2.endsWith("/.git")) dir2 = dir2.slice(0, dir2.length - ".git".length);
    return dir2;
  };

  for (const seg of segments(command)) {
    const tokens = normalizedTokens(seg);
    if (tokens.length === 0) continue;

    // Un-modeled directory constructs that would silently resolve to the
    // WRONG directory (or fall back to cwd) if ignored — every one of these
    // marks the command ambiguous (fail-closed; the caller widens its check
    // to every repo the session has edited):
    //   - pushd/popd change the directory stack, not the cwd chain
    //   - a quoted path with spaces is mangled by whitespace tokenizing
    //     (`cd "/tmp/my repo"` tokenizes to [cd, /tmp/my, repo])
    //   - nested shells (`bash -c "cd X && git commit"`) hide a cd inside a
    //     quoted body the segment splitter cuts in the middle
    //   - substitution/expansion in the cd target (`cd $X`, `cd $(d)`, `cd ~/x`)
    //   - `env` relocations: `env -C /b git commit` / `env --chdir /b …`
    //     change the working dir and `env GIT_DIR=… git …` sets the env var
    //     — both bypass the bare-assignment parsing below
    //   - subshell cd (`(cd b); git push`) leaks the cd out of the tracked
    //     chain; the `)` token trips the mangled-path check below, but keep
    //     the intent explicit here
    if (/^(pushd|popd|(ba|z|da)?sh\s+(-[a-z]*\s+)*-c)\b/.test(seg)
      || /^\s*\(/.test(seg)
      || /\benv\s+[^;|&]*(-C|--chdir)/.test(seg)
      || /(^|[\s;|&])env\s+[^;|&]*GIT_DIR=/.test(seg)) {
      ambiguous = true;
      continue;
    }

    // Track the cd chain. Only a bare `cd <path>` at the segment head is
    // resolved; every un-resolvable form (no arg, `-`, `~`, `~/x`, variables,
    // substitutions, or a space-mangled quoted path) marks the command
    // ambiguous.
    if (tokens[0] === "cd") {
      const target = tokens[1];
      // segments() strips $(…) / `…` from the target, so detect expansion in
      // the RAW segment text (a `$` or backtick in a bare-cd segment can only
      // be the target expanding).
      const rawExpands = /[$`]/.test(seg);
      const mangled = tokens.length > 2; // quoted path with spaces got split
      const expands = !target || target === "-" || target === "~" || target === "--"
        || target.startsWith("~") || rawExpands;
      if (expands || mangled) {
        ambiguous = true;
      } else if (target.startsWith("/")) {
        dir = target;
      } else {
        dir = pathJoin(dir, target);
      }
      continue;
    }

    // Locate the git/gh command head so wrapper prefixes (sudo, env, …) do
    // not confuse option scanning; scan AFTER it for the relocation option
    // -C / --git-dir.
    const gitIdx = tokens.findIndex((t) => t === "git" || t.endsWith("/git"));
    let gitDir: string | null = null;
    if (gitIdx >= 0) {
      // Options that take a SEPARATE value must be consumed, or the scanner
      // breaks on their VALUE and misses a later -C (git -c user.name=x -C
      // /other commit would lose the -C). Only -C / --git-dir RELOCATE the
      // repo; the rest (-c k=v, --namespace, …) are skipped.
      // --work-tree does NOT relocate the repo: git still discovers the
      // git-dir from the cwd (-C/--git-dir) chain, so `git --work-tree=/x
      // commit` commits the DISCOVERED repo's index while touching /x's
      // files — treating it as a relocation (round-2 review P1, verified
      // with real git) would check the wrong repo. Mark it ambiguous instead.
      for (let i = gitIdx + 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (t === "--work-tree") {
          ambiguous = true;
          if (tokens[i + 1] !== undefined) i++; // consume its value
        } else if (t.startsWith("--work-tree=")) {
          ambiguous = true;
        } else if (t === "-C" || t === "--git-dir") {
          const v = tokens[i + 1];
          if (v !== undefined) {
            // git -C accumulates (later -C resolves relative to the earlier
            // one); --git-dir overwrites.
            if (t === "-C" && gitDir !== null) gitDir = v.startsWith("/") ? v : pathJoin(gitDir, v);
            else gitDir = v;
            i++;
          }
        } else if (t.startsWith("--git-dir=")) {
          gitDir = t.slice("--git-dir=".length);
        } else if (t.startsWith("-C") && t.length > 2) {
          gitDir = t.slice(2);
        } else if (t === "-c" || t === "--namespace" || t === "--exec-path" || t === "--super-prefix"
          || t === "--attr-source" || t === "--config-env") {
          if (tokens[i + 1] !== undefined) i++; // consume the value
        } else if (t.startsWith("-")) {
          continue;
        } else {
          break;
        }
      }
    }
    // Leading env assignments (e.g. `A=1 GIT_DIR=/x git commit`, `export
    // GIT_DIR=/x git push`) are stripped from tokens by normalizedTokens, so
    // scan the RAW segment head for GIT_DIR (it may point at the .git dir).
    // Dequoted, fail-closed: unparseable forms are simply not seen (the cd
    // chain / -C still apply).
    const envHead =
      /^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:export\s+)?GIT_DIR=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(seg);
    if (!gitDir && envHead) {
      gitDir = envHead[1] ?? envHead[2] ?? envHead[3] ?? null;
    }
    // A GIT_DIR= the head parser could NOT consume — its value was stripped
    // by segments() (`` GIT_DIR=`echo /x/.git` ``), or it rides behind an
    // env/sudo wrapper — must not silently fall back to cwd (round-2 review
    // P1, probe-verified fail-open). Ambiguous widens the check.
    if (!gitDir && /\bGIT_DIR=/.test(seg)) {
      ambiguous = true;
    }

    let segDir = dir;
    if (gitDir !== null) {
      if (/\$/.test(gitDir)) {
        ambiguous = true;
      } else {
        segDir = gitDir.startsWith("/") ? gitDir : pathJoin(dir, gitDir);
      }
    }
    segsOut.push({ dir: pushDir(segDir), ship: detectShipCommands(seg).length > 0 });
  }

  return { segs: segsOut, ambiguous };
}

/** Repo roots (or bare dirs) for every segment of the command. Used by the
 *  stash/checkout re-arm path, which must touch the same repos the command
 *  does even when it contains no ship operation. */
export function resolveCommandRepos(command: string, cwd: string): { repos: string[]; ambiguous: boolean } {
  const { segs, ambiguous: baseAmbiguous } = resolveSegments(command, cwd);
  const repos: string[] = [];
  let ambiguous = baseAmbiguous;
  for (const s of segs) {
    const root = gitRootOfDir(s.dir);
    // A resolved dir that does not EXIST is almost certainly a mis-parsed
    // construct (cd "/my repo" → /my, cd ~/x → <cwd>/~/x); fail-closed:
    // widen the check.
    if (!root && !existsSync(s.dir)) ambiguous = true;
    const target = root ?? s.dir;
    if (!repos.includes(target)) repos.push(target);
  }
  if (repos.length === 0) repos.push(cwd);
  return { repos, ambiguous };
}

/**
 * Resolve every SHIP segment's operating directory into repository roots
 * (the ship gate's check set). Segments without a ship operation contribute
 * nothing; the fallback cwd is always present.
 */
export function resolveShipRepos(command: string, cwd: string): ShipRepoResolution {
  const { segs, ambiguous: baseAmbiguous } = resolveSegments(command, cwd);
  const repos: string[] = [];
  let ambiguous = baseAmbiguous;
  for (const s of segs) {
    if (!s.ship) continue;
    const root = gitRootOfDir(s.dir);
    // Same non-existent-dir fail-closed as resolveCommandRepos.
    if (!root && !existsSync(s.dir)) ambiguous = true;
    const target = root ?? s.dir;
    if (!repos.includes(target)) repos.push(target);
  }
  if (repos.length === 0) repos.push(cwd);
  return { repos, ambiguous };
}
