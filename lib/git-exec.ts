/**
 * The ONE way the gate runs git synchronously.
 *
 * Every call goes through `gitBaseEnv()` unless the caller hands in its own
 * env (which it must then build FROM `gitBaseEnv()`). Before this module the
 * extension and a dozen lib modules each spelled their own `execFileSync("git")`
 * and most of them forgot the sanitized env: an inherited `GIT_DIR` /
 * `GIT_WORK_TREE` (a git hook, a wrapper script) then made the gate describe a
 * DIFFERENT repository than the one it was asked about.
 *
 * stderr is always piped, never inherited: a failing probe is an answer the
 * caller interprets (via the thrown error's `status` / `stdout` / `stderr`),
 * not text sprayed over the user's terminal.
 */

import { execFileSync } from "node:child_process";

/**
 * Git environment variables that RELOCATE the repository, the worktree, the
 * index or the object store. They must never be inherited.
 *
 * Reproduced fail-open: with `GIT_DIR`/`GIT_WORK_TREE` pointing at another
 * repository, `computeFingerprint(A)` returned a digest describing repo B — so
 * a real edit in A left "its" fingerprint unchanged and a stale READY binding
 * stayed valid. The gate must describe the repository it was asked about, not
 * whatever an ambient variable points at. Discovery falls back to the cwd,
 * which is what every caller means (and what git hooks already run in).
 *
 * `GIT_INDEX_FILE` is included because the fingerprint's shadow-index passes
 * set it explicitly; inheriting an outer value would let a caller substitute
 * the index the digest is built from.
 *
 * Mirrored in scripts/compute-fingerprint.cjs and
 * scripts/check-staged-divergence.cjs — a parity test enforces it.
 */
export const GIT_LOCATION_ENV: readonly string[] = Object.freeze([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

/**
 * Any variable matching this prefix injects CONFIG into the git invocation:
 * `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`,
 * `GIT_CONFIG_PARAMETERS`, and the `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` /
 * `GIT_CONFIG_NOSYSTEM` source overrides.
 *
 * This is a second, independent way to reach the same fail-open as GIT_DIR:
 * `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.excludesFile
 * GIT_CONFIG_VALUE_0=/tmp/patterns` makes the named files invisible to
 * `git add`, so a real untracked edit never enters the digest and a stale
 * READY binding stays valid — with no GIT_DIR involved. Matched by PREFIX
 * because the numbered forms are unbounded.
 */
const GIT_CONFIG_ENV_PREFIX = /^GIT_CONFIG(_|$)/;

/**
 * process.env minus every variable that can relocate the repository or inject
 * configuration. The user's real `~/.gitconfig` still applies (that is the
 * user's own, deliberate configuration); what is removed is the ability of an
 * AMBIENT variable to substitute or add to it for this process only.
 */
export function gitBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (GIT_CONFIG_ENV_PREFIX.test(key)) delete env[key];
  }
  return env;
}

export interface GitOptions {
  /**
   * Full replacement env — build it from `gitBaseEnv()`. It is NOT optional
   * decoration for the fingerprint's shadow-index passes: they reach git
   * through GIT_INDEX_FILE, and a helper that dropped it once wiped the user's
   * real skip-worktree bits.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Milliseconds; `0` means none (a commit or merge may run the user's hooks). */
  readonly timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 32 * 1024 * 1024;

/**
 * Raw stdout, untrimmed; throws on a non-zero exit (the error carries
 * `status`, `stdout`, `stderr`).
 *
 * Untrimmed matters for `--porcelain -z`: an unstaged modification is
 * ` M f.ts` and trimming ate the leading space of the FIRST entry only.
 */
export function gitRaw(cwd: string, args: readonly string[], opts: GitOptions = {}): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    env: opts.env ?? gitBaseEnv(),
  });
}

/** Trimmed stdout; throws on a non-zero exit. */
export function gitText(cwd: string, args: readonly string[], opts: GitOptions = {}): string {
  return gitRaw(cwd, args, opts).trim();
}

/**
 * A thrown git failure as text an agent can act on. Node's `message` carries
 * stderr only, but git writes some refusals to STDOUT (`git commit` on a clean
 * tree: "nothing to commit, working tree clean") — without it the reason is lost.
 */
export function gitFailureText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const stdout = String((err as { stdout?: unknown }).stdout ?? "").trim();
  return stdout ? `${err.message.trim()}\n${stdout}` : err.message;
}

/** Trimmed stdout, or null on any failure. */
export function gitOrNull(cwd: string, args: readonly string[], opts: GitOptions = {}): string | null {
  try {
    return gitText(cwd, args, opts);
  } catch {
    return null;
  }
}

/** Untrimmed stdout, or null on any failure. */
export function gitRawOrNull(cwd: string, args: readonly string[], opts: GitOptions = {}): string | null {
  try {
    return gitRaw(cwd, args, opts);
  } catch {
    return null;
  }
}
