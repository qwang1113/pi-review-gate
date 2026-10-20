/**
 * THE PRE-PUSH HOOK AND COMMIT SIGNATURES (2026-10-20, user decision).
 *
 * \`hooks/pre-push\` is the one surface where a push from a PLAIN TERMINAL meets
 * the gate, so a signature rule that only lived in the extension would leave
 * every push outside pi unguarded. Two things are pinned here:
 *
 *  1. ORDER — the signature check runs BEFORE the verified-branches fast path.
 *     That path exits 0 for a branch whose tree the gate already reviewed
 *     (scripts/pre-push-verified.cjs), so a signature check placed after it
 *     would be skipped exactly in the case it exists to catch.
 *  2. BEHAVIOUR — the real hook, driven with git's own pre-push stdin, refuses
 *     a push that publishes an unsigned commit and allows one that publishes
 *     only signed commits.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { git, neutraliseHostGitConfig } from "./helpers/git.ts";

neutraliseHostGitConfig();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRE_PUSH = join(ROOT, "hooks", "pre-push");

const TEMPS: string[] = [];
process.on("exit", () => {
  for (const dir of TEMPS.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository with a real, passphrase-free SSH signing key. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-prepush-sign-"));
  TEMPS.push(dir);
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.name", "Test Signer"]);
  git(dir, ["config", "user.email", "signer@example.com"]);
  const key = join(dir, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "signer@example.com", "-f", key]);
  const pub = String(execFileSync("cat", [key + ".pub"], { encoding: "utf8" })).trim();
  writeFileSync(join(dir, "allowed_signers"), "signer@example.com " + pub + "\n");
  git(dir, ["config", "gpg.format", "ssh"]);
  git(dir, ["config", "user.signingkey", key + ".pub"]);
  git(dir, ["config", "gpg.ssh.allowedSignersFile", join(dir, "allowed_signers")]);
  return dir;
}

function commit(dir: string, name: string, signed: boolean): string {
  writeFileSync(join(dir, name), name + "\n");
  git(dir, ["add", name]);
  git(dir, ["commit", "-q", signed ? "-S" : "--no-gpg-sign", "-m", "chore(test): " + name]);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** Run the REAL hook the way git does: pre-push stdin, cwd = the repo. */
function runHook(dir: string, stdin: string): { status: number | null; stderr: string } {
  const res = spawnSync("bash", [PRE_PUSH], { cwd: dir, input: stdin, encoding: "utf8" });
  return { status: res.status, stderr: String(res.stderr ?? "") };
}

const NEW_BRANCH = "0".repeat(40);
const refLine = (sha: string) => "refs/heads/main " + sha + " refs/heads/main " + NEW_BRANCH + "\n";

test("the signature check runs BEFORE the verified-branches fast path", () => {
  // Ordering is the safety property, and it is invisible at runtime when the
  // fast path happens not to fire — so it is pinned in the source.
  const hook = readFileSync(PRE_PUSH, "utf8");
  const signature = hook.indexOf("commit-signing.cjs");
  const verified = hook.indexOf("pre-push-verified.cjs");
  assert.ok(signature > 0, "the hook must run the signature checker at all");
  assert.ok(verified > 0, "the verified-branches release must still be there");
  assert.ok(
    signature < verified,
    "SIGNATURES FIRST: the verified-branches fast path exits 0 for a reviewed tree, "
      + "so a signature check after it would be skipped in exactly the case it exists for",
  );
});

test("the hook REFUSES a push that publishes an unsigned commit", () => {
  const dir = makeRepo();
  const sha = commit(dir, "a.txt", /*signed=*/false);
  const { status, stderr } = runHook(dir, refLine(sha));
  assert.equal(status, 1, "an unsigned commit must not be published");
  assert.match(stderr, /no valid signature/);
  assert.match(stderr, new RegExp(sha.slice(0, 12)), "the refusal names the commit");
  assert.match(stderr, /commit\.gpgsign=true/, "and says how to fix it");
});

test("the hook ALLOWS a push that publishes only signed commits", () => {
  const dir = makeRepo();
  const sha = commit(dir, "a.txt", /*signed=*/true);
  const { status, stderr } = runHook(dir, refLine(sha));
  assert.equal(status, 0, "a signed history passes the signature gate: " + stderr);
});

test("a DELETE publishes nothing and stays out of the signature question", () => {
  const dir = makeRepo();
  const { status, stderr } = runHook(dir, "refs/heads/gone " + NEW_BRANCH + " refs/heads/gone " + "a".repeat(40) + "\n");
  assert.equal(status, 0, "a branch deletion adds no commit: " + stderr);
});
