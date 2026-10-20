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
 * NOTE: the product's own `gitBaseEnv()` (lib/git-exec.ts) deliberately
 * strips every `GIT_CONFIG*` variable before it shells out, so this env only
 * governs git processes the TESTS spawn themselves — which is exactly where
 * the fixture commits happen.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
 * A REAL SIGNING KEY FOR FIXTURES (2026-10-20, user decision on signature
 * enforcement).
 *
 * The gate now signs the commits it creates and refuses a commit it cannot
 * sign, so a fixture repository that the gate commits into has to be able to
 * sign — exactly as a real checkout is. One ed25519 key per test PROCESS
 * (generated on first use, ~50ms) is enough: the identity is the repo's own
 * `user.email`, which is what an SSH allowed-signers line matches against.
 *
 * Files live OUTSIDE the fixture repo on purpose: several fixtures assert a
 * clean worktree, and an untracked key file would make them lie.
 */
let signingKeyPath: string | undefined;

function signingKey(): string {
  if (signingKeyPath === undefined) {
    const dir = mkdtempSync(join(tmpdir(), "rg-test-signing-"));
    const key = join(dir, "id_ed25519");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test-fixture", "-f", key]);
    process.on("exit", () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });
    signingKeyPath = key;
  }
  return signingKeyPath;
}

/**
 * Make this fixture repository sign its commits, with the key above.
 *
 * Repo-LOCAL config, so it also reaches git processes the gate spawns: the
 * product's `gitBaseEnv()` strips GIT_CONFIG_* (the hermetic layer this helper
 * is called next to), but local config is read whatever the environment says.
 */
export function configureTestSigning(repo: string): void {
  const key = signingKey();
  const email = git(repo, ["config", "--get", "user.email"]);
  if (email === "") {
    throw new Error("configureTestSigning: the fixture must set user.email first — it becomes the allowed-signers principal");
  }
  const allowed = join(dirname(key), "allowed_" + email.replace(/[^A-Za-z0-9]/g, "_"));
  if (!existsSync(allowed)) {
    writeFileSync(allowed, email + " " + readFileSync(key + ".pub", "utf8").trim() + "\n");
  }
  git(repo, ["config", "gpg.format", "ssh"]);
  git(repo, ["config", "user.signingkey", key + ".pub"]);
  git(repo, ["config", "gpg.ssh.allowedSignersFile", allowed]);
  git(repo, ["config", "commit.gpgsign", "true"]);
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
