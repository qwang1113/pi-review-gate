/**
 * COMMIT SIGNING (2026-10-20, user decision) — every commit this gate creates
 * and every commit this session publishes must carry a VALID signature.
 *
 * Three questions live here, and they are answered the same way for the gate's
 * own commits, for the agent's `git commit`, for `git push` / `gh pr create`
 * at L1, and for the shell hook that guards a push from a plain terminal:
 *
 *  1. CAN this repo sign?          -> `signingGap` / `readSigningConfig`
 *  2. DID this commit sign?        -> `parseSignatureLog` + `unsignedCommits`
 *  3. WHICH commits would ship?    -> `parsePushRefs` / `pushRefTarget`
 *
 * The identity is NEVER hard-coded: whatever `git config` resolves for that
 * repo wins (the user's own `includeIf` layers choose the work identity for
 * OneKeyHQ checkouts and the personal one everywhere else). The gate's job is
 * to refuse a commit that cannot be signed and a ship that carries one that
 * was not — not to decide who the user is.
 *
 * THE PURE HALF IS THE CONTRACT. Every decision above is a pure function, and
 * `scripts/commit-signing.cjs` mirrors it for the hooks, which run without the
 * TypeScript extension. `test/commit-signing-parity.test.ts` pins the two
 * together so they cannot drift.
 */

import { gitOrNull, gitText } from "./git-exec.ts";

/* ------------------------------------------------------------------ *
 * 1. WHAT GIT SAYS ABOUT ONE COMMIT (`%G?`)
 * ------------------------------------------------------------------ */

/**
 * `git log --format=%G?` answers with ONE letter; this is what each means.
 *
 * ONLY `good` PASSES. `untrusted` (U) is deliberately a refusal, because the
 * letter means two different things and only one of them is safe:
 *   - OpenPGP: a valid signature whose key is not in gpg's trustdb;
 *   - SSH: a valid signature by a key that is NOT in `gpg.ssh.allowedSignersFile`
 *     — i.e. "somebody signed it, we cannot say who".
 * Measured on this machine: pointing allowedSignersFile at a different key turns
 * a genuine signature into U. Accepting U would let any key speak for the user.
 */
export type SignatureVerdict =
  | "good"
  | "untrusted"
  | "bad"
  | "uncheckable"
  | "absent"
  | "unknown-key"
  | "expired"
  | "expired-key"
  | "revoked-key";

const VERDICT_BY_CODE: Readonly<Record<string, SignatureVerdict>> = Object.freeze({
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

/** Map one `%G?` letter. An unparsable code is treated as "cannot verify". */
export function signatureVerdict(code: string): SignatureVerdict {
  return VERDICT_BY_CODE[(code ?? "").charAt(0)] ?? "uncheckable";
}

/** Is this verdict acceptable evidence that the commit is signed and valid? */
export function signatureAccepted(verdict: SignatureVerdict): boolean {
  return verdict === "good";
}

/** A short, agent-readable reason, or `undefined` when the verdict passes. */
export function signatureProblem(verdict: SignatureVerdict): string | undefined {
  if (signatureAccepted(verdict)) return undefined;
  switch (verdict) {
    case "absent":
      return "no signature";
    case "bad":
      return "signature does not verify (BAD)";
    case "uncheckable":
      return "signature cannot be checked — configure gpg.ssh.allowedSignersFile (SSH) or register the signer key (OpenPGP)";
    case "untrusted":
      return "signed, but the signing key is not in the trusted set — for SSH that means gpg.ssh.allowedSignersFile";
    case "unknown-key":
      return "signer key unknown";
    case "expired":
      return "signature expired";
    case "expired-key":
      return "signing key expired";
    case "revoked-key":
      return "signing key revoked";
    default:
      return "signature state unrecognised";
  }
}

/* ------------------------------------------------------------------ *
 * 2. READING `git log` BACK
 * ------------------------------------------------------------------ */

/** One commit's signature, as git reported it. */
export interface CommitSignature {
  sha: string;
  verdict: SignatureVerdict;
  /** `%GS` — the signer principal (empty when there is no signature). */
  signer: string;
  /** `%GK` — the signing key's fingerprint (empty when there is none). */
  key: string;
}

/**
 * The `--format` every reader of this module uses. NUL-separated because a
 * signer principal contains spaces ("qwang1113 (王强) <qwang@onekey.so>").
 */
export const SIGNATURE_LOG_FORMAT = "%H%x00%G?%x00%GS%x00%GK";

/** Parse `git log --format=SIGNATURE_LOG_FORMAT` output. */
export function parseSignatureLog(text: string): CommitSignature[] {
  const out: CommitSignature[] = [];
  for (const line of (text ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const [sha = "", code = "", signer = "", key = ""] = line.split("\0");
    if (sha === "") continue;
    out.push({ sha: sha.trim(), verdict: signatureVerdict(code.trim()), signer: signer.trim(), key: key.trim() });
  }
  return out;
}

/** The commits in that list that must not ship. */
export function unsignedCommits(commits: readonly CommitSignature[]): CommitSignature[] {
  return commits.filter((c) => !signatureAccepted(c.verdict));
}

/** One block of text naming every offending commit — used in refusals. */
export function formatUnsignedCommits(commits: readonly CommitSignature[], limit = 8): string {
  const shown = commits.slice(0, limit).map((c) => {
    const who = c.signer ? " (" + c.signer + ")" : "";
    return c.sha.slice(0, 12) + who + ": " + (signatureProblem(c.verdict) ?? c.verdict);
  });
  const rest = commits.length > limit ? " … +" + (commits.length - limit) + " more" : "";
  return shown.join("; ") + rest;
}

/* ------------------------------------------------------------------ *
 * 3. WHAT A SHIP WOULD PUBLISH
 * ------------------------------------------------------------------ */

/** One line of git's pre-push stdin. */
export interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

const ZERO_SHA = /^0+$/;
/** git's own object-id shape (sha1 40, sha256 64); a delete/absent ref is all zeroes. */
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;

/**
 * Parse git's pre-push stdin (`<local ref> <local sha> <remote ref> <remote
 * sha>`, one per line). Anything unparsable is dropped: a hook that cannot
 * read a line must not invent a target for it.
 */
export function parsePushRefs(stdin: string): PushRef[] {
  const out: PushRef[] = [];
  for (const line of (stdin ?? "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts as [string, string, string, string];
    // A ref line carries OBJECT IDS on both sides. Requiring that shape is what
    // keeps an arbitrary four-word line from becoming a verification target.
    if (!OBJECT_ID.test(localSha) || !OBJECT_ID.test(remoteSha)) continue;
    out.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return out;
}

/**
 * What to verify for one pushed ref.
 *
 * A DELETE (local sha all zeroes) publishes nothing and is skipped. A normal
 * push is `<remote-sha>..<local-sha>` — the commits actually being added. A
 * NEW branch has no remote sha, so the lower bound is "everything not already
 * on a remote" (`<local-sha> --not --remotes`): an empty range would either
 * verify nothing or walk the whole history, and the repo's older unsigned
 * commits are explicitly out of scope.
 */
export type VerifyTarget =
  | { kind: "range"; range: string }
  | { kind: "unpushed"; sha: string }
  | { kind: "delete" };

export function pushRefTarget(ref: PushRef): VerifyTarget {
  if (ZERO_SHA.test(ref.localSha)) return { kind: "delete" };
  if (ref.remoteSha === "" || ZERO_SHA.test(ref.remoteSha)) return { kind: "unpushed", sha: ref.localSha };
  return { kind: "range", range: ref.remoteSha + ".." + ref.localSha };
}

/** The `git log` argv that reads every target's commits, in one call. */
export function signatureLogArgs(targets: readonly VerifyTarget[]): string[] {
  const args = ["log", "--format=" + SIGNATURE_LOG_FORMAT];
  const positive: string[] = [];
  let excludeUnpushed = false;
  for (const t of targets) {
    if (t.kind === "delete") continue;
    if (t.kind === "range") positive.push(t.range);
    else { positive.push(t.sha); excludeUnpushed = true; }
  }
  args.push(...positive);
  // `--not --remotes` comes AFTER the positive side it excludes from.
  if (excludeUnpushed) args.push("--not", "--remotes");
  return args;
}

/**
 * The refs a `git push` command would publish — the L1 reading of a command,
 * where the hook instead gets git's exact refs. Returns `undefined` when the
 * command pushes "everything" (`--all` / `--mirror` / `--tags`): there is no
 * explicit refspec then, and the caller verifies every local branch.
 */
export function pushRefspecs(segment: string): string[] | undefined {
  // Strip quoting and split: a refspec never contains whitespace.
  const tokens = (segment ?? "").replace(/["']/g, "").split(/\s+/).filter((t) => t !== "");
  const at = tokens.indexOf("push");
  if (at < 0) return [];
  const rest = tokens.slice(at + 1);
  const refspecs: string[] = [];
  let sawRemote = false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok.startsWith("-")) {
      if (tok === "--all" || tok === "--mirror" || tok === "--tags") return undefined;
      // Options that take a value: skip the value too, or it reads as a ref.
      if (tok === "--repo" || tok === "-o" || tok === "--push-option" || tok === "--receive-pack" || tok === "--exec") i++;
      continue;
    }
    if (!sawRemote) { sawRemote = true; continue; }
    refspecs.push(tok);
  }
  return refspecs;
}

/* ------------------------------------------------------------------ *
 * 4. CAN THIS REPO SIGN AT ALL
 * ------------------------------------------------------------------ */

/** The three config values that decide whether `git commit` produces a signature. */
export interface SigningConfig {
  gpgsign: string | undefined;
  /** `gpg.format`: "openpgp" (default) or "ssh". */
  format: string | undefined;
  /** `user.signingkey` — a key id (OpenPGP) or a public-key path (SSH). */
  signingKey: string | undefined;
}

const TRUTHY = new Set(["true", "1", "yes", "on", "always"]);

/**
 * Why this repo cannot produce a signed commit, or `undefined` when it can.
 *
 * The SSH branch is the strict one on purpose: `gpg.format=ssh` without
 * `user.signingkey` fails outright, and that failure is what a headless
 * checkpoint would otherwise discover halfway through a round.
 */
export function signingGap(cfg: SigningConfig): string | undefined {
  const gpgsign = (cfg.gpgsign ?? "").trim().toLowerCase();
  if (!TRUTHY.has(gpgsign)) {
    return gpgsign === ""
      ? "commit signing is off in this repo (`commit.gpgsign` is not true)"
      : "commit signing is off in this repo (`commit.gpgsign=" + gpgsign + "`) — set it to true";
  }
  const format = (cfg.format ?? "openpgp").trim().toLowerCase();
  if (format === "ssh" && (cfg.signingKey ?? "").trim() === "") {
    return "this repo signs with `gpg.format=ssh` but `user.signingkey` is empty — point it at the public key to sign with";
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 5. "DO NOT SIGN THIS ONE" — the explicit opt-out
 * ------------------------------------------------------------------ */

/**
 * The opt-out a command carries, or `undefined`.
 *
 * Only EXPLICIT switches are read here — `--no-gpg-sign` and a
 * `commit.gpgsign=false` override. A repo whose config merely leaves signing
 * off is `signingGap`'s business: the two produce different advice, and telling
 * an agent "you asked not to sign" when it did not is worse than silence.
 */
export function signOptOut(segment: string): string | undefined {
  const text = segment ?? "";
  if (/--no-gpg-sign\b/.test(text)) return "`--no-gpg-sign` asks for an UNSIGNED commit";
  if (/-c\s+["']?commit\.gpgsign=(false|no|off|0)\b/i.test(text)) {
    return "`-c commit.gpgsign=false` asks for an UNSIGNED commit";
  }
  if (/GIT_CONFIG_[A-Z_]*gpgsign/i.test(text)) return "a git config override asks for an UNSIGNED commit";
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 6. THE GIT EXECUTING HALF (thin, always through lib/git-exec.ts)
 * ------------------------------------------------------------------ */

function configGet(root: string, key: string): string | undefined {
  const value = gitOrNull(root, ["config", "--get", key]);
  return value === null ? undefined : value.trim();
}

/** Read the three signing values as THIS repo resolves them (all layers). */
export function readSigningConfig(root: string): SigningConfig {
  return {
    gpgsign: configGet(root, "commit.gpgsign"),
    format: configGet(root, "gpg.format"),
    signingKey: configGet(root, "user.signingkey"),
  };
}

/** `signingGap` for a repo on disk. */
export function signingGapFor(root: string): string | undefined {
  return signingGap(readSigningConfig(root));
}

/**
 * Read the signature of every commit a set of targets covers.
 *
 * A git failure yields an empty list — the caller then has no evidence a
 * commit is signed, and every caller treats "no evidence" as a refusal.
 */
export function readSignatures(root: string, targets: readonly VerifyTarget[]): CommitSignature[] {
  const args = signatureLogArgs(targets);
  if (args.length <= 2) return [];
  const raw = gitOrNull(root, args);
  return raw === null ? [] : parseSignatureLog(raw);
}

/** The signature of ONE commit (an empty list when git cannot read it). */
export function readCommitSignatures(root: string, shas: readonly string[]): CommitSignature[] {
  if (shas.length === 0) return [];
  const raw = gitOrNull(root, ["log", "--no-walk", "--format=" + SIGNATURE_LOG_FORMAT, ...shas]);
  return raw === null ? [] : parseSignatureLog(raw);
}

/**
 * THE GATE'S OWN COMMIT: assert that the commit it just made is signed.
 *
 * Throws with an actionable message, so the caller's existing failure path
 * carries it to the agent instead of a bare `git commit` exit code. There is
 * deliberately no "unsigned but useful" mode — a checkpoint that is not signed
 * is the defect this module exists to prevent.
 */
export function assertCommitSigned(root: string, sha: string): CommitSignature {
  const [commit] = readCommitSignatures(root, [sha]);
  if (commit === undefined) {
    throw new Error(
      "review-gate: commit " + sha.slice(0, 12) + " could not be verified (git log failed) — refusing to treat an unverified commit as signed",
    );
  }
  const problem = signatureProblem(commit.verdict);
  if (problem !== undefined) {
    throw new Error(
      "review-gate: commit " + sha.slice(0, 12) + " is NOT signed (" + problem + "). " +
      "Every commit this gate creates must carry a valid signature: configure `commit.gpgsign=true` and a signing key " +
      "(`user.signingkey`, plus `gpg.ssh.allowedSignersFile` when `gpg.format=ssh`) for this repo, then retry.",
    );
  }
  return commit;
}

/**
 * The commits a `git push` segment would publish that are NOT signed.
 *
 * `undefined` refspecs (`--all` / `--mirror` / `--tags`) verify every local
 * branch — the conservative reading of "ship everything".
 */
export function unsignedForPushSegment(root: string, segment: string): CommitSignature[] {
  const refspecs = pushRefspecs(segment);
  const targets: VerifyTarget[] =
    refspecs === undefined
      ? [{ kind: "unpushed", sha: "--branches" }]
      : refspecs.length === 0
        ? [{ kind: "unpushed", sha: "HEAD" }]
        : refspecs
          // "<src>:<dst>" publishes <src>; ":<dst>" is a delete and ships nothing.
          .map((r) => r.split(":")[0] ?? "")
          .filter((src) => src !== "")
          .map((src) => ({ kind: "unpushed" as const, sha: src }));
  return unsignedCommits(readSignatures(root, targets));
}
