/**
 * THE CHECKPOINT COMMIT MESSAGE — a pure function of the agent's round note.
 *
 * THE MARKER IS GONE (user decision, 2026-09-16). A checkpoint used to be
 * identifiable AS a checkpoint in the history: first by a bare `checkpoint: `
 * prefix (which produced `checkpoint: fix(x): y` — not a legal Conventional
 * Commit), then by injecting the marker into the SCOPE, so it read
 * `fix(checkpoint-gate): x`. The user has now asked for the opposite: the
 * history should read as ordinary work, so the same round lands as
 * `fix(gate): x`. Nothing read the marker — the baseline is computed from the
 * checkpoint's sha, never from its message text — so removing it changes no
 * behaviour, only what a human sees in `git log`.
 *
 * WHAT SURVIVES IS THE ONE REAL JOB: the note must come out as a legal
 * Conventional Commit, including when the agent did not write one.
 *
 * L5 IS THE CONSTRAINT, AND THIS FUNCTION MUST NOT BUILD A MESSAGE IT WOULD
 * REFUSE. The agent's round note is usually CHINESE (this project's output
 * language) while a commit message must be English — subject AND body, since
 * the rule was unified (2026-08-29). So a note carrying any non-Latin letter
 * is NOT used as message text at all: the subject falls back to the English
 * default and the note is DROPPED from the body. Nothing is lost — the same
 * note is what the reviewer receives as the round's description, verbatim, in
 * the task text.
 */

import { containsNonLatinLetter } from "./lang-detect.ts";

/**
 * A Conventional Commits subject: `type(scope)!: description`. The scope and
 * the `!` are optional. Deliberately permissive on `type` (any word) — the
 * point is a legal shape, not a validated vocabulary.
 */
const CONVENTIONAL = /^([A-Za-z][A-Za-z0-9]*)(\(([^)]*)\))?(!)?:\s+(.+)$/;

/**
 * Make `subject` a legal Conventional Commit.
 *
 * A subject that already is one comes back untouched — the agent's own
 * `type(scope): description`, `!` included. Anything else is wrapped as
 * `chore: <subject>`, which is the only legal shape left when the first token
 * is not a type at all (the English fallback `record this round for review`
 * is the common case).
 */
export function ensureConventionalSubject(subject: string): string {
  const trimmed = subject.trim();
  return CONVENTIONAL.test(trimmed) ? trimmed : `chore: ${trimmed}`;
}

/**
 * Build the whole checkpoint commit message from the agent's raw round note.
 *
 * Pure: the same input always yields the same message, so both the
 * conventional-commit fallback and the non-English fallback are unit-testable
 * without a repository.
 */
export function buildCheckpointMessage(raw: string): string {
  const lines = raw.trim().split("\n");
  const firstLine = (lines[0] ?? "").trim().slice(0, 100);
  const usableSubject = firstLine.length > 0 && !containsNonLatinLetter(firstLine);
  const subject = usableSubject ? firstLine : "record this round for review";
  const rest = (usableSubject ? lines.slice(1).join("\n") : raw).trim();
  const body = containsNonLatinLetter(rest) ? "" : rest;
  const legal = ensureConventionalSubject(subject);
  return body ? `${legal}\n\n${body}` : legal;
}
