/**
 * Hermetic git environment for tests.
 *
 * Tests build throwaway repositories and run REAL `git commit` in them. Those
 * commits inherit the developer's global git config, and a personal
 * `commit.gpgsign = true` then makes every fixture commit a real OpenPGP
 * signature: gpg-agent re-derives the private key from its cached passphrase
 * for each one (S2K KDF, measured at ~0.17s per signature on the machine that
 * motivated this helper). A single suite run cost ~19s of pure signing in
 * `git-hooks.test.ts` alone and kept gpg-agent burning CPU in the background.
 *
 * Host config is not just slow, it is a correctness hazard: `core.hooksPath`,
 * `init.templateDir`, `core.excludesFile` or a global `user.signingkey` can
 * flip a fixture's behaviour on one machine and not another.
 *
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` pointed at /dev/null neutralise
 * both layers at once, which is strictly broader than `-c commit.gpgsign=false`
 * (that flag only silences signing). Identity still has to be supplied per
 * fixture — `/dev/null` also removes `user.name` / `user.email` — either with
 * `-c user.name=…` arguments or the GIT_AUTHOR / GIT_COMMITTER variables.
 *
 * NOTE: the product's own `gitBaseEnv()` (lib/fingerprint.ts) deliberately
 * strips every `GIT_CONFIG*` variable before it shells out, so this env only
 * governs git processes the TESTS spawn themselves — which is exactly where
 * the fixture commits happen.
 */

import { execFileSync } from "node:child_process";

/** The two variables that disable the host's global and system git config. */
export const HERMETIC_GIT_CONFIG_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
});

/**
 * `process.env` plus the hermetic overrides (and optional extras, which win).
 * Read at call time, so a test that mutates `process.env` first still sees it.
 */
export function hermeticGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...HERMETIC_GIT_CONFIG_ENV, ...extra };
}

/**
 * Neutralise the host git config for EVERY git subprocess this test file
 * spawns, by writing the overrides into `process.env` once at module load.
 *
 * Threading `env:` through a call site is clearer and is what small fixtures
 * should do (see `hermeticGitEnv`). Files that shell out to git from dozens of
 * scattered places use this instead: `execFileSync`/`spawnSync` inherit
 * `process.env` by default, so one call covers call sites that would otherwise
 * be missed — including any added later. `node --test` runs each test file in
 * its own process, so this cannot leak into another file.
 */
export function neutraliseHostGitConfig(): void {
  Object.assign(process.env, HERMETIC_GIT_CONFIG_ENV);
}

/**
 * Run git in `cwd` with the hermetic env. Returns trimmed stdout; pass
 * `quiet: true` for fixtures that only care about the side effect.
 *
 * stderr is captured even when quiet, so a failing fixture command still
 * carries git's own message (`gpg failed to sign the data`, a missing
 * identity, …) on the thrown error instead of an opaque exit status.
 */
export function git(cwd: string, args: string[], opts: { quiet?: boolean; extraEnv?: NodeJS.ProcessEnv } = {}): string {
  const out = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: hermeticGitEnv(opts.extraEnv),
    stdio: opts.quiet ? ["ignore", "ignore", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  return (out ?? "").trim();
}
