#!/usr/bin/env node
/**
 * COMMIT SIGNATURES AT THE HOOK BOUNDARY (2026-10-20, user decision).
 *
 * The TypeScript extension cannot run inside a git hook, so this file carries
 * the same decisions as lib/commit-signing.ts for the shell side:
 *
 *   - which commits a push actually publishes (pushTargets)
 *   - whether each of them carries a VALID signature (signatureVerdict)
 *   - what to refuse, and with which words (problemsFor)
 *
 * test/commit-signing-parity.test.ts drives both implementations over the same
 * fixtures, so they cannot drift apart: the gate saying "signed" while the hook
 * says "unsigned" is exactly the class of bug this file would otherwise
 * introduce.
 *
 * WHY IT RUNS IN hooks/pre-push BEFORE THE VERIFIED-BRANCHES FAST PATH: that
 * path exits 0 for a branch whose tree the gate already reviewed, which would
 * skip every signature check. A push from a plain terminal publishes work, so
 * the signature question is asked first, always.
 *
 * CommonJS, no dependencies: hooks run where node_modules may not exist.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

/* ---- the verdict table (mirrors SignatureVerdict in lib/commit-signing.ts) ---- */

const VERDICT_BY_CODE = Object.freeze({
  G: "good",
  U: "untrusted",
  B: "bad",
  E: "uncheckable",
  N: "absent",
  "?": "unknown-key",
  X: "expired",
  Y: "expired-key",
  R: "revoked-key",
});

const PROBLEM_BY_VERDICT = Object.freeze({
  absent: "no signature",
  untrusted: "signed, but the signing key is not in the trusted set — for SSH that means gpg.ssh.allowedSignersFile",
  bad: "signature does not verify (BAD)",
  uncheckable: "signature cannot be checked — configure gpg.ssh.allowedSignersFile (SSH) or register the signer key (OpenPGP)",
  "unknown-key": "signer key unknown",
  expired: "signature expired",
  "expired-key": "signing key expired",
  "revoked-key": "signing key revoked",
});

const LOG_FORMAT = "%H%x00%G?%x00%GS%x00%GK";
const ZERO_SHA = /^0+$/;
/** git's own object-id shape (sha1 40, sha256 64); a delete/absent ref is all zeroes. */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

function signatureVerdict(code) {
  return VERDICT_BY_CODE[String(code || "").charAt(0)] || "uncheckable";
}

// ONLY "good" PASSES. "untrusted" (U) is a refusal here: for SSH it means the
// key is not in gpg.ssh.allowedSignersFile (verified on this machine — pointing
// the file at another key turns a real signature into U), and accepting it
// would let any key speak for the user.
function signatureAccepted(verdict) {
  return verdict === "good";
}

function signatureProblem(verdict) {
  if (signatureAccepted(verdict)) return undefined;
  return PROBLEM_BY_VERDICT[verdict] || "signature state unrecognised";
}

/** Parse "git log --format=LOG_FORMAT" output. */
function parseSignatureLog(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (line.trim() === "") continue;
    const [sha = "", code = "", signer = "", key = ""] = line.split("\0");
    if (sha === "") continue;
    out.push({ sha: sha.trim(), verdict: signatureVerdict(code.trim()), signer: signer.trim(), key: key.trim() });
  }
  return out;
}

/** Parse git's pre-push stdin. */
function parsePushRefs(stdin) {
  const out = [];
  for (const line of String(stdin || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    // A ref line carries OBJECT IDS on both sides; anything else is not a ref.
    if (!OBJECT_ID.test(parts[1]) || !OBJECT_ID.test(parts[3])) continue;
    out.push({ localRef: parts[0], localSha: parts[1], remoteRef: parts[2], remoteSha: parts[3] });
  }
  return out;
}

/** The commits one pushed ref publishes; a delete publishes nothing. */
function pushRefTarget(ref) {
  if (ZERO_SHA.test(ref.localSha)) return { kind: "delete" };
  if (ref.remoteSha === "" || ZERO_SHA.test(ref.remoteSha)) return { kind: "unpushed", sha: ref.localSha };
  return { kind: "range", range: ref.remoteSha + ".." + ref.localSha };
}

function signatureLogArgs(targets) {
  const args = ["log", "--format=" + LOG_FORMAT];
  const positive = [];
  let excludeUnpushed = false;
  for (const t of targets) {
    if (t.kind === "delete") continue;
    if (t.kind === "range") positive.push(t.range);
    else { positive.push(t.sha); excludeUnpushed = true; }
  }
  args.push(...positive);
  if (excludeUnpushed) args.push("--not", "--remotes");
  return args;
}

/** The targets a push actually publishes — empty when it publishes nothing. */
function pushTargets(refs) {
  return refs.map(pushRefTarget).filter((t) => t.kind !== "delete");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * The offending commits among the ones the given targets cover, and whether the
 * scan could run at all.
 *
 * The two are different answers: a history git cannot read is a REFUSAL, never
 * "nothing unsigned here" (round-1 reviewer P1 — the gate side had exactly that
 * fail-open through an unsanitized refspec).
 */
function unsignedForTargets(cwd, targets) {
  if (targets.length === 0) return { unsigned: [] };
  const args = signatureLogArgs(targets);
  if (args.length <= 2) return { unsigned: [] };
  let raw;
  try {
    raw = git(cwd, args);
  } catch (error) {
    const line = String((error && error.stderr) || (error && error.message) || "git log failed").trim().split("\n")[0];
    return { unsigned: [], error: line };
  }
  return { unsigned: parseSignatureLog(raw).filter((c) => !signatureAccepted(c.verdict)) };
}

function formatUnsigned(commits, limit) {
  const max = limit === undefined ? 8 : limit;
  const shown = commits.slice(0, max).map((c) => {
    const who = c.signer ? " (" + c.signer + ")" : "";
    return c.sha.slice(0, 12) + who + ": " + (signatureProblem(c.verdict) || c.verdict);
  });
  const rest = commits.length > max ? " … +" + (commits.length - max) + " more" : "";
  return shown.join("; ") + rest;
}

/** The refusal text for a push, or undefined when every published commit is signed. */
function problemsFor(cwd, stdin) {
  const targets = pushTargets(parsePushRefs(stdin));
  if (targets.length === 0) return undefined;
  const { unsigned, error } = unsignedForTargets(cwd, targets);
  if (error !== undefined) {
    return (
      "[review-gate] push rejected: the signatures of the commits being published could NOT be verified (" + error + ").\n" +
      "[review-gate] An unreadable history is not evidence of a signature — refusing to publish it."
    );
  }
  if (unsigned.length === 0) return undefined;
  return (
    "[review-gate] push rejected: " + unsigned.length + " commit(s) being published carry no valid signature — " +
    formatUnsigned(unsigned) + "\n" +
    "[review-gate] Every commit this gate produces must be signed. Configure commit.gpgsign=true and a signing key " +
    "(user.signingkey; plus gpg.ssh.allowedSignersFile when gpg.format=ssh), then rewrite the commits with " +
    "git rebase --exec 'git commit --amend --no-edit -S' <base>."
  );
}

module.exports = {
  signatureVerdict,
  signatureAccepted,
  signatureProblem,
  parseSignatureLog,
  parsePushRefs,
  pushRefTarget,
  signatureLogArgs,
  pushTargets,
  unsignedForTargets,
  formatUnsigned,
  problemsFor,
};

if (require.main === module) {
  let text = "";
  try {
    text = readFileSync(0, "utf8");
  } catch {
    text = "";
  }
  const failure = problemsFor(process.cwd(), text);
  if (failure === undefined) process.exit(0);
  process.stderr.write(failure + "\n");
  process.exit(1);
}
