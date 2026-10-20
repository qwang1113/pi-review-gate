/**
 * COMMIT SIGNING (2026-10-20, user decision) — the gate's own rule, tested
 * against REAL git rather than a mock.
 *
 * Two halves, deliberately:
 *  1. the pure decisions (which %G? codes pass, what a repo needs before it can
 *     sign, what a push would publish), which is where every "is this signed"
 *     question is actually answered;
 *  2. real ed25519 SSH signing in a throwaway repository, so the constants and
 *     the git plumbing are exercised too — the parity test pins the hook side
 *     against this file, and neither is worth much if the git half is assumed.
 *
 * The fixtures neutralise the host git config (test/helpers/git.ts): once a
 * developer's machine signs every commit, an un-neutralised fixture would keep
 * passing while measuring the host instead of the code under test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SIGNATURE_LOG_FORMAT,
  assertCommitSigned,
  formatUnsignedCommits,
  parsePushRefs,
  parseSignatureLog,
  pushRefTarget,
  commandTokens,
  explicitSignFlag,
  parsePushCommand,
  prTargetsForSegment,
  pushTargetsForSegment,
  readSignatures,
  readSigningConfig,
  refspecSource,
  scanSignatures,
  signOptOut,
  signatureAccepted,
  signatureLogArgs,
  signatureProblem,
  signatureVerdict,
  signingGap,
  unsignedCommits,
} from "../lib/commit-signing.ts";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";

// Every fixture below spawns real git; the hermetic-git guard requires this
// call to appear in THIS file's code.
neutraliseHostGitConfig();

const TEMPS: string[] = [];

function cleanup(): void {
  for (const dir of TEMPS.splice(0)) rmSync(dir, { recursive: true, force: true });
}
process.on("exit", cleanup);

/**
 * A real repository with a real ed25519 signing key (no passphrase, so the
 * headless case the gate has to survive is the one measured here).
 */
function makeRepo(opts: { sign?: boolean } = {}): { dir: string; keyPath: string; allowed: string } {
  const dir = mkdtempSync(join(tmpdir(), "rg-commit-signing-"));
  TEMPS.push(dir);
  git(dir, ["init", "-q", "."]);
  git(dir, ["config", "user.name", "Test Signer"]);
  git(dir, ["config", "user.email", "signer@example.com"]);
  const keyPath = join(dir, "signing-key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "signer@example.com", "-f", keyPath]);
  const allowed = join(dir, "allowed_signers");
  const pub = String(execFileSync("cat", [keyPath + ".pub"], { encoding: "utf8" })).trim();
  writeFileSync(allowed, "signer@example.com " + pub + "\n");
  git(dir, ["config", "gpg.format", "ssh"]);
  git(dir, ["config", "user.signingkey", keyPath + ".pub"]);
  git(dir, ["config", "gpg.ssh.allowedSignersFile", allowed]);
  git(dir, ["config", "commit.gpgsign", opts.sign === false ? "false" : "true"]);
  return { dir, keyPath, allowed };
}

function commitFile(dir: string, name: string, body: string): string {
  writeFileSync(join(dir, name), body);
  git(dir, ["add", name]);
  git(dir, ["commit", "-q", "-m", "chore(test): " + name]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function uncheckedCommit(dir: string, name: string, body: string): string {
  writeFileSync(join(dir, name), body);
  git(dir, ["add", name]);
  git(dir, ["commit", "-q", "--no-gpg-sign", "-m", "chore(test): " + name]);
  return git(dir, ["rev-parse", "HEAD"]);
}

// ---------------------------------------------------------------------------
// 1. THE PURE DECISIONS

test("only a valid signature passes the verdict table", () => {
  // ONLY G passes. U is "untrusted": for SSH git raises it when the signing key
  // is not in gpg.ssh.allowedSignersFile — i.e. the commit is signed by SOMEONE,
  // and nobody can say who. Accepting it would let any key speak for the user.
  assert.equal(signatureAccepted(signatureVerdict("G")), true);
  assert.equal(signatureProblem(signatureVerdict("G")), undefined);
  for (const code of ["U", "B", "E", "N", "?", "X", "Y", "R", ""]) {
    assert.equal(signatureAccepted(signatureVerdict(code)), false, JSON.stringify(code) + " must not pass");
    assert.notEqual(signatureProblem(signatureVerdict(code)), undefined, "a refusal always says why");
  }
  // An unknown letter is not a pass — fail closed, never guess.
  assert.equal(signatureVerdict("Z"), "uncheckable");
});

test("a repo has to be able to sign before the gate lets a commit through", () => {
  assert.equal(signingGap({ gpgsign: "true", format: "ssh", signingKey: "/k.pub" }), undefined);
  assert.equal(signingGap({ gpgsign: "true", format: undefined, signingKey: "ABC" }), undefined);
  // Off in this repo — the two spellings produce different advice.
  assert.match(String(signingGap({ gpgsign: "false", format: "ssh", signingKey: "/k.pub" })), /commit\.gpgsign=false/);
  assert.match(String(signingGap({ gpgsign: undefined, format: "ssh", signingKey: "/k.pub" })), /is not true/);
  // gpg.format=ssh without a key fails outright, which is the expensive one to
  // discover halfway through a round.
  assert.match(String(signingGap({ gpgsign: "true", format: "ssh", signingKey: "" })), /user\.signingkey/);
});

test("flags are read as FLAGS — a commit message is data (round-1 P2)", () => {
  // Both directions of this were wrong when the whole segment was scanned:
  // a message mentioning --no-gpg-sign refused a legitimate commit, and a
  // message mentioning -S disabled the "this repo cannot sign" check, so the
  // commit landed unsigned.
  const messageWithNoSign = "git commit -m 'feat: explain why --no-gpg-sign is banned'";
  assert.equal(signOptOut(messageWithNoSign), undefined, "a message is not an opt-out");
  assert.equal(explicitSignFlag(messageWithNoSign), false);
  assert.equal(explicitSignFlag("git commit -m 'feat: pass -S through'"), false,
    "a message must not look like an explicit signature request");
  assert.equal(explicitSignFlag("git commit -S -m 'feat: x'"), true);
  assert.equal(explicitSignFlag("git commit --gpg-sign=ABC -m x"), true);
  assert.equal(explicitSignFlag("git commit -am 'fix: x'"), false, "-am is -a plus a message");
  assert.deepEqual(commandTokens("git commit -am 'feat: x' -S"), ["git", "commit", "-am", "-S"]);
});

test("an unrelated git env prefix is not a signing opt-out (round-2 P2)", () => {
  // GIT_CONFIG_GLOBAL=/dev/null touches nothing this rule is about; only the
  // ephemeral KEY/VALUE pair that actually sets commit.gpgsign=false is one.
  assert.equal(signOptOut("GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git commit -m x"), undefined);
  assert.match(
    String(signOptOut("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false git commit -m x")),
    /UNSIGNED/,
  );
});

test("only EXPLICIT refusals are read as an opt-out", () => {
  assert.match(String(signOptOut("git commit --no-gpg-sign -m x")), /--no-gpg-sign/);
  assert.match(String(signOptOut("git -c commit.gpgsign=false commit -m x")), /commit\.gpgsign=false/);
  // A plain commit is NOT an opt-out: that case is the repo's config, and its
  // advice ("configure a key") differs from "you asked not to sign".
  assert.equal(signOptOut("git commit -m 'feat: x'"), undefined);
  // -S is the opposite of an opt-out.
  assert.equal(signOptOut("git commit -S -m 'feat: x'"), undefined);
});

test("a push publishes only what it adds — never the whole history", () => {
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  const goneSha = "c".repeat(40);
  const refs = parsePushRefs([
    "refs/heads/main " + oldSha + " refs/heads/main " + oldSha,
    "refs/heads/feat " + newSha + " refs/heads/feat " + "0".repeat(40),
    "(delete) " + "0".repeat(40) + " refs/heads/gone " + goneSha,
    "",
    "not a ref line at all",
  ].join("\n"));
  assert.equal(refs.length, 3, "the arbitrary four-word line is not a ref, and neither is an empty one");
  assert.deepEqual(pushRefTarget(refs[0]!), { kind: "range", range: oldSha + ".." + oldSha });
  // A brand new branch has no remote sha: the lower bound is "not on a remote",
  // which is what keeps the repo's older unsigned commits out of scope.
  assert.deepEqual(pushRefTarget(refs[1]!), { kind: "unpushed", sha: newSha });
  assert.deepEqual(pushRefTarget(refs[2]!), { kind: "delete" });

  assert.deepEqual(
    signatureLogArgs([{ kind: "range", range: "a..b" }, { kind: "delete" }]),
    ["log", "--format=" + SIGNATURE_LOG_FORMAT, "a..b"],
  );
  assert.deepEqual(
    signatureLogArgs([{ kind: "unpushed", sha: "new111" }]),
    ["log", "--format=" + SIGNATURE_LOG_FORMAT, "new111", "--not", "--remotes"],
  );
});

test("a push command's refspecs are read, and --all means 'everything'", () => {
  assert.deepEqual(parsePushCommand("git push"), { refspecs: [], deleteAll: false });
  assert.deepEqual(parsePushCommand("git push origin feat/x"), { refspecs: ["feat/x"], deleteAll: false });
  assert.deepEqual(parsePushCommand("git push -u origin feat/x:feat/x"), { refspecs: ["feat/x:feat/x"], deleteAll: false });
  assert.deepEqual(parsePushCommand("git -C /repo push --force-with-lease origin main"), { refspecs: ["main"], deleteAll: false });
  assert.deepEqual(parsePushCommand("git push --all origin"), { refspecs: undefined, deleteAll: false });
  assert.deepEqual(parsePushCommand("git push --mirror origin"), { refspecs: undefined, deleteAll: false });
  assert.deepEqual(parsePushCommand("git push -d origin gone"), { refspecs: ["gone"], deleteAll: true });
  // A push OPTION whose value happens to be -d is a value, not a delete flag
  // (round-3 quality P2: it used to empty the whole target list).
  assert.deepEqual(parsePushCommand("git push -o -d origin feat/x"), { refspecs: ["feat/x"], deleteAll: false });
});

test("a GLOB refspec verifies every local branch instead of nothing (round-3 quality P2)", () => {
  const { dir } = makeRepo();
  commitFile(dir, "a.txt", "one");
  assert.deepEqual(pushTargetsForSegment(dir, "git push origin 'refs/heads/*:refs/heads/*'"), [
    { kind: "unpushed", sha: "--branches" },
  ]);
});

test("the log parser keeps a signer principal with spaces intact", () => {
  const raw = [
    "aaa\u0000G\u0000qwang1113 (王强) <qwang@onekey.so>\u0000FD68E914FE43009B",
    "bbb\u0000N\u0000\u0000",
    "",
  ].join("\n");
  const parsed = parseSignatureLog(raw);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.verdict, "good");
  assert.equal(parsed[0]!.signer, "qwang1113 (王强) <qwang@onekey.so>");
  assert.equal(parsed[1]!.verdict, "absent");
  assert.deepEqual(unsignedCommits(parsed).map((c) => c.sha), ["bbb"]);
  assert.match(formatUnsignedCommits(parsed), /bbb: no signature/);
});

// ---------------------------------------------------------------------------
// 2. REAL GIT

test("a signed commit passes and an unsigned one is refused (real ssh signing)", () => {
  const { dir } = makeRepo();
  const signed = commitFile(dir, "a.txt", "one\n");
  const commit = assertCommitSigned(dir, signed);
  assert.equal(commit.verdict, "good");
  assert.equal(commit.signer, "signer@example.com", "the signer principal comes from the allowed-signers line");

  const unsigned = uncheckedCommit(dir, "b.txt", "two\n");
  assert.throws(() => assertCommitSigned(dir, unsigned), /NOT signed.*no signature/s);
});

test("a signature nobody can check is NOT a pass", () => {
  // gpg.format=ssh without gpg.ssh.allowedSignersFile makes git report N even
  // for a genuinely signed commit. Reading that as "signed" would let an
  // unverifiable commit ship; the gate refuses instead.
  const { dir } = makeRepo();
  const sha = commitFile(dir, "a.txt", "one\n");
  // A different key in the allowed-signers file: git reports U (valid signature,
  // untrusted key), which the gate refuses. Unsetting the file alone would not
  // measure this — the host's own global config would supply one.
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "other@example.com", "-f", join(dir, "other-key")]);
  const other = join(dir, "other_signers");
  const otherPub = String(execFileSync("cat", [join(dir, "other-key.pub")], { encoding: "utf8" })).trim();
  writeFileSync(other, "other@example.com " + otherPub + "\n");
  git(dir, ["config", "gpg.ssh.allowedSignersFile", other]);
  assert.throws(() => assertCommitSigned(dir, sha), /NOT signed.*trusted set/s);
});

test("readSigningConfig answers with the repo's own layers", () => {
  const { dir, keyPath } = makeRepo();
  const cfg = readSigningConfig(dir);
  assert.equal(cfg.gpgsign, "true");
  assert.equal(cfg.format, "ssh");
  assert.equal(cfg.signingKey, keyPath + ".pub");
});

test("a push reports exactly the commits it would add that are unsigned", () => {
  const { dir } = makeRepo();
  commitFile(dir, "a.txt", "one\n");
  assert.deepEqual(scanSignatures(dir, pushTargetsForSegment(dir, "git push origin main")).unsigned, [],
    "signed history publishes clean");

  uncheckedCommit(dir, "b.txt", "two\n");
  const unsigned = scanSignatures(dir, pushTargetsForSegment(dir, "git push origin main")).unsigned;
  assert.equal(unsigned.length, 1, "only the unsigned commit is named");
  assert.equal(unsigned[0]!.verdict, "absent");
});

test("a FORCE push refspec is not fed to git as a rev (round-1 P1)", () => {
  // `git log +branch` exits 128. The scan used to swallow that into an empty
  // list, which read as "nothing unsigned" — an unsigned force push shipped.
  assert.equal(refspecSource("+work"), "work");
  assert.equal(refspecSource("work:other"), "work");
  assert.equal(refspecSource(":gone"), undefined, "a delete publishes nothing");
  assert.equal(refspecSource("^exclude"), undefined, "an exclusion is not a source");

  const { dir } = makeRepo();
  uncheckedCommit(dir, "a.txt", "one\n");
  const targets = pushTargetsForSegment(dir, "git push --force origin +main");
  assert.deepEqual(targets, [{ kind: "unpushed", sha: "main" }]);
  const scan = scanSignatures(dir, targets);
  assert.equal(scan.error, undefined, "the sanitized rev is readable");
  assert.equal(scan.unsigned.length, 1, "the unsigned commit is still named");
});

test("a DELETE publishes nothing, so it is never judged as a push of HEAD (round-2 P2)", () => {
  const { dir } = makeRepo();
  commitFile(dir, "a.txt", "one");
  // "`:gone`" is a delete; so is `--delete gone`, even when a local branch of
  // that name has already been removed.
  assert.deepEqual(pushTargetsForSegment(dir, "git push origin :gone"), []);
  assert.deepEqual(pushTargetsForSegment(dir, "git push origin --delete gone"), []);
  assert.deepEqual(pushTargetsForSegment(dir, "git push origin :work"), []);
});

test("a stale LOCAL base does not drag published history into the PR range (round-2 P2)", () => {
  const { dir } = makeRepo();
  const first = commitFile(dir, "a.txt", "one");
  const second = commitFile(dir, "b.txt", "two");
  // The REMOTE is ahead of the local branch: a base resolved locally would put
  // the already-published commit inside the range and demand a re-sign of
  // history the user was told would never be rewritten.
  git(dir, ["update-ref", "refs/remotes/origin/main", second]);
  git(dir, ["reset", "-q", "--hard", first]);
  git(dir, ["checkout", "-q", "-b", "work", second]);
  uncheckedCommit(dir, "c.txt", "three");
  const targets = prTargetsForSegment(dir, "gh pr create --base main --head work --title x");
  assert.deepEqual(targets, [{ kind: "range", range: "origin/main..work" }]);
  const scan = scanSignatures(dir, targets);
  assert.equal(scan.unsigned.length, 1, "only the commit the PR adds is judged");
});

test("an unreadable history is a refusal, not a clean scan", () => {
  const { dir } = makeRepo();
  commitFile(dir, "a.txt", "one\n");
  const scan = scanSignatures(dir, [{ kind: "unpushed", sha: "+main" }]);
  assert.notEqual(scan.error, undefined, "git refuses the operator, and the caller must hear it");
  assert.deepEqual(scan.unsigned, []);
});

test("a tracked branch is verified as upstream..local, not as the whole unpushed set", () => {
  const { dir } = makeRepo();
  const first = commitFile(dir, "a.txt", "one\n");
  // A REAL remote-tracking setup: without the fetch refspec git refuses to call
  // refs/heads/work's upstream a remote-tracking branch at all.
  git(dir, ["config", "remote.origin.url", "https://example.invalid/x.git"]);
  git(dir, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  git(dir, ["update-ref", "refs/remotes/origin/work", first]);
  git(dir, ["config", "branch.work.remote", "origin"]);
  git(dir, ["config", "branch.work.merge", "refs/heads/work"]);
  git(dir, ["checkout", "-q", "-b", "work"]);
  const second = uncheckedCommit(dir, "b.txt", "two\n");
  // The upstream comes back as the full ref — unambiguous, and valid as a rev.
  assert.deepEqual(pushTargetsForSegment(dir, "git push origin work"), [
    { kind: "range", range: "refs/remotes/origin/work..work" },
  ]);
  const scan = scanSignatures(dir, pushTargetsForSegment(dir, "git push origin work"));
  assert.deepEqual(scan.unsigned.map((c) => c.sha), [second], "only the added commit is judged");
});

test("gh pr create is verified as base..head from its own flags", () => {
  const { dir } = makeRepo();
  const first = commitFile(dir, "a.txt", "one\n");
  git(dir, ["update-ref", "refs/remotes/origin/main", first]);
  git(dir, ["branch", "-m", "work"]);
  uncheckedCommit(dir, "b.txt", "two\n");
  assert.deepEqual(prTargetsForSegment(dir, "gh pr create --base main --head work --title x"), [
    { kind: "range", range: "origin/main..work" },
  ]);
});

test("a range target sees only the commits inside it", () => {
  const { dir } = makeRepo();
  const first = commitFile(dir, "a.txt", "one\n");
  const second = uncheckedCommit(dir, "b.txt", "two\n");
  const inRange = readSignatures(dir, [{ kind: "range", range: first + ".." + second }]);
  assert.deepEqual(inRange.map((c) => c.sha), [second]);
  assert.equal(unsignedCommits(inRange).length, 1);
});
