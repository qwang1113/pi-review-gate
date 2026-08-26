/**
 * Review contract — the ONE reviewer per round, and what it is told.
 *
 * Every review round is a single reviewer over the WHOLE change, holding its
 * OWN disposable snapshot (created by the extension's `prepare_review`), and
 * its verdict is the only one the gate records (`record_review` parses every
 * fence; worst verdict wins if multiple appear).
 *
 * NO ENGINE HERE. Reviews are dispatched by the extension (`prepare_review` +
 * plain subagents), because the pdw engine discards a per-agent `cwd` and a
 * reviewer must hold its OWN snapshot of the change it judges. Every function
 * in this file is pure over strings, so the reviewer contract can be pinned by
 * tests with no workflow engine, no git and no filesystem.
 */

// Pure module: no engine, no snapshots, no I/O. Reviews are dispatched by the
// extension (prepare_review + subagents); this file only decides WHAT to say
// to the reviewer and what verdict shape to hand it as its outputSchema.
import { buildStreamDirective } from "./review-stream.ts";

/**
 * Shape of a single reviewer's structured verdict. Handed to the spawned
 * reviewer as its `outputSchema` (see REVIEW_VERDICT_SCHEMA below); the
 * recorded verdict itself is parsed by the gate's own all-fence parser.
 */
export interface ReviewVerdict {
  gate: "READY" | "BLOCKED" | "NEEDS_HUMAN";
  /**
   * The directory the reviewer ACTUALLY ran in, from its own `pwd`.
   *
   * Second, independent piece of evidence that the reviewer was inside the
   * snapshot prepared for it (the first is the spawn the gate observed). It
   * also catches the case the spawn guard cannot see: a reviewer pointed at its
   * snapshot correctly that then `cd`-ed into the live worktree. The prompt
   * insists on a real `pwd` rather than copying the path out of the task text,
   * because a copied value proves nothing.
   */
  cwd: string;
  /**
   * Code↔docs attestation, REQUIRED on the single-review path: no second
   * reviewer carries it, so the reviewer itself must attest (the gate
   * fails closed on a missing attestation).
   */
  docSync: "UPDATED" | "NOT_NEEDED";
  findings: Array<{
    file: string;
    line: number;
    severity: "P0" | "P1" | "P2" | "Nit";
    issue: string;
  }>;
  notes?: string;
}

/**
 * Verdict JSON schema enforced on the reviewer. `docSync` is REQUIRED on the
 * single-review path: there is no second reviewer to carry the
 * attestation, so the reviewer itself must attest code↔docs (the gate fails
 * closed on a missing attestation — see lib/gate-state.ts).
 */
export const REVIEW_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    gate: { type: "string", enum: ["READY", "BLOCKED", "NEEDS_HUMAN"] },
    cwd: {
      type: "string",
      description:
        "Absolute path you actually ran in, taken from your own `pwd` — not copied from the task text. " +
        "The gate checks it against the snapshot prepared for you.",
    },
    docSync: { type: "string", enum: ["UPDATED", "NOT_NEEDED"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "Nit"] },
          issue: { type: "string" },
        },
        required: ["file", "line", "severity", "issue"],
      },
    },
    notes: { type: "string" },
  },
  // `cwd` is REQUIRED: it is one of the two independent proofs that the
  // reviewer ran inside its snapshot, and an optional field would simply be
  // omitted by the models that most need to be checked.
  required: ["gate", "cwd", "docSync", "findings"],
} as const;

/**
 * Build the review prompt handed to the ONE reviewer.
 *
 * `isolation` is the SAFETY-CRITICAL argument. A reviewer that got its own
 * snapshot may edit and mutate freely; a reviewer running in the LIVE worktree
 * (isolation unavailable) must be told the opposite, because the engine-level
 * denylist only removes the edit/write TOOLS — `bash` stays, and a reviewer
 * that had been promised "you are in a disposable copy" would happily rewrite
 * the user's files through it. Omitting the argument therefore means "no
 * snapshot": the read-only contract is the DEFAULT, and the permissive one has
 * to be granted explicitly.
 */
export function buildReviewPrompt(
  label: string,
  files: string[],
  goalText?: string,
  repoRoot?: string,
  isolation?: { streamPath: string },
): string {
  const streamPath = isolation?.streamPath;
  const lines = [
    "You are the reviewer of this round. Audit the WHOLE change listed below — nothing else covers it. Read each file in the worktree, verify from the code (never guess), and report findings with file paths and line numbers.",
    "",
    `Changed files (${files.length}):`,
    files.map((f) => `- ${f}`).join("\n"),
    "",
    "Review for: correctness, edge cases, test coverage quality, doc sync for the behavior you see, unintended side effects, and impossibility claims (TODO/FIXME/skipped tests).",
    isolation
      // In a THROWAWAY SNAPSHOT of the change under review, mutation analysis
      // (delete the code, prove the test fails) is the strongest check there is.
      ? "You are running inside a disposable snapshot worktree of the change under review — NOT the user's live worktree. You may edit files and run tests freely, including mutation analysis: delete or break the code a test claims to cover and confirm the test actually fails. RESTORE every mutation before you finish: the gate re-derives this snapshot's tree afterwards, and a snapshot left modified means your final checks ran against your own edits, so a READY from you will not be accepted. Write scratch files OUTSIDE the snapshot (use $TMPDIR), and never write under `node_modules` (it is a symlink to the real repository). Never run git commit/push or any gh command."
      // No snapshot: this IS the user's worktree and the main agent may be
      // working in it. Read-only, exactly as before snapshot isolation existed.
      : "You are reading the USER'S LIVE WORKTREE — snapshot isolation was unavailable for this run, and the main agent may be editing it right now. Do NOT edit any file. Do NOT run tests that write files. `bash` is read-only inspection only (git diff/log/show, reading files). Never run git commit/push or any gh command. Report what you find; verifying by mutation is not available this round.",
  ];
  if (streamPath) lines.push("", buildStreamDirective(streamPath));
  // NOTE: the `diff` field and its prompt block are gone. Nothing produces a
  // per-reviewer diff any more, and nothing should: the reviewer holds a snapshot
  // of the change, so it runs `git diff HEAD` against the real thing instead of
  // reading a copy that may have drifted. Keeping a dead field invites someone
  // to "restore" the weaker path.
  if (goalText && goalText.trim()) {
    lines.push("", "Loop goal (accept the change against it, criterion by criterion):", goalText.trim());
  }
  lines.push(
    "",
    "OUTPUT: fenced JSON verdict FIRST (the gate parses it; docSync is REQUIRED on the single-review path), then a prose review below the fence.",
    // The reviewer's own `pwd` is EVIDENCE, and only if it is measured: a value
    // copied out of this prompt would prove nothing about where the review
    // actually happened, which is precisely the failure this field exists for.
    //
    // The SECOND sentence is branch-specific. Promising "the gate checks it
    // against the snapshot prepared for you" on the no-isolation branch
    // contradicts the paragraph above it (which just said there is no snapshot
    // this round) and could push a literal-minded reviewer into a needless
    // non-READY.
    'Before you answer, run `pwd` and put its output in the verdict\'s "cwd" field. Report what the command printed — do NOT copy the path out of this task text.' +
      (isolation
        ? " The gate checks it against the snapshot prepared for you, and a reviewer that ran outside its snapshot cannot approve the change."
        : " There is no snapshot this round, so this only records where you read; the gate does not match it against one."),
    // eslint-disable-next-line max-len
    'Verdict shape: {"gate": "READY"|"BLOCKED"|"NEEDS_HUMAN", "cwd": "<your real pwd>", "docSync": "UPDATED"|"NOT_NEEDED", "findings": [{"file": "...", "line": 1, "severity": "P0|P1|P2|Nit", "issue": "..."}], "notes": "<prose review>"}',
    "Severity: P0 = must fix now, P1 = must fix before ship, P2 = should fix, Nit = optional. Any open P0/P1 ⇒ BLOCKED.",
  );
  return lines.join("\n");
}
