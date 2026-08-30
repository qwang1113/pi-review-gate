/**
 * THE CHECKPOINT COMMIT MESSAGE — a pure function of the agent's round note.
 *
 * A checkpoint must be identifiable AS a checkpoint in the history (user
 * requirement), and the marker is the gate's to add. The marker used to be a
 * bare `checkpoint: ` PREFIX, which produced `checkpoint: fix(orch): x` — not
 * a legal Conventional Commit (two colons, and `checkpoint` is not a type).
 * The marker is now INJECTED INTO THE SCOPE instead, so a checkpoint reads as
 * an ordinary `type(checkpoint-<scope>): subject` and passes any conventional
 * tooling (user decision, 2026-08-31). Nothing matched the old prefix — the
 * baseline is computed from the checkpoint's sha, never its message text — so
 * the change is safe.
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

/** A hyphen-delimited scope segment equal to `checkpoint`. */
const CHECKPOINT_IN_SCOPE = /(^|-)checkpoint($|-)/i;

/**
 * A Conventional Commits subject: `type(scope)!: description`. The scope and
 * the `!` are optional. Deliberately permissive on `type` (any word) — the
 * point is to place the checkpoint marker, not to validate the vocabulary.
 */
const CONVENTIONAL = /^([A-Za-z][A-Za-z0-9]*)(\(([^)]*)\))?(!)?:\s+(.+)$/;

/**
 * Put the `checkpoint` marker where a Conventional Commit keeps its scope.
 *
 * Four cases, matching the user's table:
 *  - has a scope        → `type(checkpoint-<scope>)…: desc`
 *  - has no scope       → `type(checkpoint)…: desc`
 *  - not CC at all      → `chore(checkpoint): <subject>`
 *  - already marked     → idempotent (a scope that already carries the
 *                         `checkpoint` segment is returned unchanged)
 */
export function injectCheckpointScope(subject: string): string {
  const trimmed = subject.trim();
  const m = CONVENTIONAL.exec(trimmed);
  if (!m) return `chore(checkpoint): ${trimmed}`;
  const type = m[1]!;
  const scope = m[3];
  const bang = m[4] ?? "";
  const desc = m[5]!;
  if (scope !== undefined && CHECKPOINT_IN_SCOPE.test(scope)) return trimmed;
  const newScope = scope && scope.length > 0 ? `checkpoint-${scope}` : "checkpoint";
  return `${type}(${newScope})${bang}: ${desc}`;
}

/**
 * Build the whole checkpoint commit message from the agent's raw round note.
 *
 * Pure: the same input always yields the same message, so the four scope
 * cases and the non-English fallback are unit-testable without a repository.
 */
export function buildCheckpointMessage(raw: string): string {
  const lines = raw.trim().split("\n");
  const firstLine = (lines[0] ?? "").trim().slice(0, 100);
  const usableSubject = firstLine.length > 0 && !containsNonLatinLetter(firstLine);
  const subject = usableSubject ? firstLine : "record this round for review";
  const rest = (usableSubject ? lines.slice(1).join("\n") : raw).trim();
  const body = containsNonLatinLetter(rest) ? "" : rest;
  const marked = injectCheckpointScope(subject);
  return body ? `${marked}\n\n${body}` : marked;
}
