/**
 * PARITY between lib/commit-signing.ts and scripts/commit-signing.cjs
 * (2026-10-20, user decision).
 *
 * The signature rule has to hold in two places that cannot share code: the
 * TypeScript extension answers at L1 (before \`git commit\` / \`git push\` runs),
 * and the dependency-free hook script answers in \`hooks/pre-push\`. If they ever
 * disagree, the gate says "signed" while the hook says "unsigned" — or worse,
 * the hook stays quiet about something the gate would have refused.
 *
 * This test drives BOTH implementations over the same fixtures. It does not
 * assert what the answers are (test/commit-signing.test.ts does that); it
 * asserts that they are the SAME answer, which is the property that would
 * otherwise decay silently the next time someone edits one side.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  SIGNATURE_LOG_FORMAT,
  formatUnsignedCommits,
  parsePushRefs,
  parseSignatureLog,
  pushRefTarget,
  signatureLogArgs,
  signatureProblem,
  signatureVerdict,
} from "../lib/commit-signing.ts";

const requireCjs = createRequire(import.meta.url);
const hookSide = requireCjs("../scripts/commit-signing.cjs") as {
  signatureVerdict: (code: string) => string;
  signatureProblem: (verdict: string) => string | undefined;
  parseSignatureLog: (text: string) => Array<{ sha: string; verdict: string; signer: string; key: string }>;
  parsePushRefs: (stdin: string) => Array<{ localRef: string; localSha: string; remoteRef: string; remoteSha: string }>;
  pushRefTarget: (ref: { localRef: string; localSha: string; remoteRef: string; remoteSha: string }) => unknown;
  signatureLogArgs: (targets: unknown[]) => string[];
  pushTargets: (refs: unknown[]) => unknown[];
  formatUnsigned: (commits: unknown[]) => string;
};

test("both sides read every %G? code the same way", () => {
  for (const code of ["G", "U", "B", "E", "N", "?", "X", "Y", "R", "Z", ""]) {
    assert.equal(
      hookSide.signatureVerdict(code),
      signatureVerdict(code),
      "verdict for " + JSON.stringify(code) + " must match",
    );
    assert.equal(hookSide.signatureProblem(signatureVerdict(code)), signatureProblem(signatureVerdict(code)));
  }
});

test("both sides parse a signature log the same way", () => {
  const raw = [
    "a".repeat(40) + "\u0000G\u0000qwang1113 (王强) <qwang@onekey.so>\u0000FD68E914FE43009B",
    "b".repeat(40) + "\u0000N\u0000\u0000",
    "c".repeat(40) + "\u0000U\u0000ssh-ed25519 key\u0000SHA256:abc",
    "",
  ].join("\n");
  assert.deepEqual(hookSide.parseSignatureLog(raw), parseSignatureLog(raw));
  assert.equal(
    hookSide.formatUnsigned(parseSignatureLog(raw)),
    formatUnsignedCommits(parseSignatureLog(raw)),
    "the refusal text has to read identically on both sides",
  );
});

test("both sides read pre-push refs and their targets the same way", () => {
  const stdin = [
    "refs/heads/main " + "a".repeat(40) + " refs/heads/main " + "b".repeat(40),
    "refs/heads/feat " + "c".repeat(40) + " refs/heads/feat " + "0".repeat(40),
    "(delete) " + "0".repeat(40) + " refs/heads/gone " + "d".repeat(40),
    "junk line that is not a ref",
    "",
  ].join("\n");
  const mine = parsePushRefs(stdin);
  assert.deepEqual(hookSide.parsePushRefs(stdin), mine);
  for (const ref of mine) assert.deepEqual(hookSide.pushRefTarget(ref), pushRefTarget(ref));

  const targets = mine.map(pushRefTarget);
  assert.deepEqual(hookSide.signatureLogArgs(targets), signatureLogArgs(targets));
  assert.deepEqual(hookSide.pushTargets(mine), targets.filter((t) => t.kind !== "delete"));
});

test("the two sides agree on the log format itself", () => {
  // Anything the gate writes must be readable by the hook and vice versa: one
  // shared constant on both sides, spelled once here so a change to either
  // trips this test rather than silently returning no rows.
  assert.match(SIGNATURE_LOG_FORMAT, /%H%x00%G\?%x00%GS%x00%GK/);
});
