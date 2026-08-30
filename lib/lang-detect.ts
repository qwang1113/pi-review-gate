/**
 * The L5 language gate: commit messages, PR text and test labels must be
 * ENGLISH.
 *
 * ONE RULE, ONE IMPLEMENTATION (2026-08-29). Every L5 decision in this project
 * is {@link judgeEnglish}: **any non-Latin letter rejects**. The call sites
 * differ only in the `kind` they pass, which decides the wording of the block
 * — not the verdict.
 *
 * WHY A HARD RULE AND NOT A RATIO. The previous policy failed a text only when
 * a non-Latin script was the MAJORITY of its letters. It was introduced to stop
 * a legitimate English body with one quoted foreign term from being blocked,
 * and it cost more than it bought: a long English body diluted a fully Chinese
 * SUBJECT below the threshold and shipped (observed 2026-08-29), the ratio was
 * un-obvious to reason about, and every reader had to know which of two
 * policies applied where. The dilution hole was patched for subjects only,
 * which left three different behaviours in four call sites.
 *
 * The hard rule is safe to apply everywhere BECAUSE the mistake is appealable:
 * a text the gate wrongly refuses (a Chinese filename in a subject, a pasted
 * Chinese stack trace in a body) goes to `request_arbitration`, which binds a
 * single-use pass to that exact content. A wrong guess costs one appeal, not a
 * stranded commit — see docs/execution-model.md.
 *
 * This deliberately ALLOWS: ASCII, code identifiers, numbers, punctuation,
 * URLs, emoji, and Latin text with diacritics (café, naïve). Pure, no I/O,
 * unit-tested.
 */

/**
 * True if any character is a LETTER from a script other than Latin. Uses
 * Unicode property escapes: `\p{L}` = any letter, `\p{Script=Latin}` = a Latin
 * letter.
 */
function isNonLatinLetter(ch: string): boolean {
  return /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch);
}

/**
 * True if the text contains ANY non-Latin letter.
 *
 * Scans the FULL text — code spans, URLs and HTML included. Nothing is
 * stripped first: a body hidden inside a ```fence``` is still the body, and
 * the gate must not offer markup as a bypass.
 */
export function containsNonLatinLetter(text: string): boolean {
  if (!text) return false;
  for (const ch of text.normalize("NFC")) {
    if (isNonLatinLetter(ch)) return true;
  }
  return false;
}

/** Which surface an L5 decision was made on. Wording only — never the rule. */
export type L5Kind = "commit-subject" | "commit-body" | "pr-text" | "test-label";

/** One refused text, with the surface it came from. */
export interface L5Rejection {
  kind: L5Kind;
  /** The exact text that was refused (callers truncate it for display). */
  text: string;
}

/**
 * THE L5 judgement — the single implementation every call site uses.
 *
 * Returns the rejection, or undefined when the text may pass. Empty text
 * passes (there is nothing to be non-English about).
 */
export function judgeEnglish(kind: L5Kind, text: string): L5Rejection | undefined {
  return containsNonLatinLetter(text) ? { kind, text } : undefined;
}

/**
 * The first of `texts` that L5 refuses, judged SEPARATELY (never concatenated)
 * so a long English text cannot mask a short non-English one.
 */
export function firstNonEnglishText(kind: L5Kind, texts: readonly string[]): L5Rejection | undefined {
  for (const t of texts) {
    const hit = judgeEnglish(kind, t);
    if (hit) return hit;
  }
  return undefined;
}

/** What part of a commit message failed the L5 check. */
export type CommitMessagePart = "subject" | "body";

/** The offending message plus WHICH part of it failed. */
export interface NonEnglishCommitMessage {
  /** The exact text that failed — the subject line, or the whole message. */
  text: string;
  /** Which part the verdict came from (drives a precise block reason). */
  part: CommitMessagePart;
}

/**
 * The SUBJECT line of a commit message, as GIT would resolve it.
 *
 * `git commit` runs the message through `git stripspace`, which drops leading
 * blank lines before taking the subject — so the subject of `"\n\n修复问题\n\nbody"`
 * is `修复问题`, NOT the empty first line. Reading the literal first line would
 * therefore hand a one-newline bypass to anything that judges the subject.
 */
export function commitSubjectLine(message: string): string {
  for (const line of message.split("\n")) {
    if (line.trim().length > 0) return line.trim();
  }
  return "";
}

/**
 * L5 for ONE COMMIT MESSAGE. Subject and body obey the SAME hard rule; the
 * split exists so the block can say WHERE the offending text is — the subject
 * is the line every log, blame and changelog shows, and pointing at the whole
 * message when only its first line is at fault wastes a round.
 *
 * Takes ONE WHOLE message, deliberately: `git commit -m A -m B` builds a
 * single message whose paragraphs are A and B, so only A is a subject.
 * Callers must join the paragraphs with a blank line first, exactly as git
 * does.
 */
export function nonEnglishCommitMessage(message: string): NonEnglishCommitMessage | undefined {
  const subject = commitSubjectLine(message);
  if (judgeEnglish("commit-subject", subject)) return { text: subject, part: "subject" };
  if (judgeEnglish("commit-body", message)) return { text: message, part: "body" };
  return undefined;
}

/** How much of a refused text a block reason quotes back. */
export const L5_QUOTE_LENGTH = 60;

const KIND_LABEL: Record<L5Kind, string> = {
  "commit-subject": "the commit SUBJECT line",
  "commit-body": "the commit message body",
  "pr-text": "the PR title/description",
  "test-label": "a test label",
};

/**
 * The one-sentence block reason for a rejection — the SAME sentence at every
 * call site, so the four surfaces cannot drift into four vocabularies. The
 * caller adds its own next step (appeal, rewrite hint).
 */
export function l5BlockReason(hit: L5Rejection): string {
  return `${KIND_LABEL[hit.kind]} is not English: "${hit.text.slice(0, L5_QUOTE_LENGTH)}". ` +
    "L5 accepts no non-Latin letters at all.";
}
