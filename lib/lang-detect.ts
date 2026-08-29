/**
 * Language gate for commit / PR text (L5) and test labels (L6).
 *
 * Requirement: commit messages and PR title/description must be ENGLISH. We do
 * not try to prove text *is* English (undecidable, and English borrows foreign
 * words); instead we score the writing system of its LETTERS and fail only when
 * a NON-LATIN script (CJK, Kana, Hangul, Cyrillic, Greek, Arabic, Hebrew, Thai,
 * Devanagari, …) is the MAJORITY of the letters in the prose body.
 *
 * MAJORITY-BODY policy (was: "any non-Latin letter fails"): a real deadlock
 * showed the old rule was too strict — a mostly-English PR body with a single
 * quoted foreign term (e.g. "确认中") was flagged non-English and blocked a
 * legitimate ship. The gate now measures the ratio: only text whose MAIN prose
 * is another writing system fails. A stray/minority foreign word passes. When
 * the rough script check is wrong at the margin, the agent may escalate to the
 * arbiter (lib/arbitration.ts) rather than being hard-stuck.
 *
 * This deliberately ALLOWS: ASCII, code identifiers, numbers, punctuation,
 * URLs, emoji, and Latin text with diacritics (café, naïve). Pure, no I/O,
 * unit-tested.
 */

/**
 * True if any character is a LETTER from a script other than Latin. Uses Unicode
 * property escapes: `\p{L}` = any letter, `\p{Script=Latin}` = a Latin letter.
 */
function isNonLatinLetter(ch: string): boolean {
  return /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch);
}

/**
 * Strip non-prose spans so the language ratio reflects the human-readable body,
 * not markup that would dilute it. Removes fenced/inline code, URLs and Markdown
 * link destinations (keeping the visible link text), and HTML tags. A big Latin
 * code block must not mask a non-Latin body, and a URL's Latin host must not
 * count as English prose.
 */
export function stripNonProse(text: string): string {
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, " "); // fenced code blocks
  t = t.replace(/~~~[\s\S]*?~~~/g, " "); // alt fenced code blocks
  t = t.replace(/`[^`]*`/g, " ");        // inline code
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"); // [text](url) → text (drop dest)
  t = t.replace(/\bhttps?:\/\/\S+/gi, " "); // bare URLs
  t = t.replace(/\bwww\.\S+/gi, " ");
  t = t.replace(/<[^>]+>/g, " ");         // HTML tags
  return t;
}

export type LanguageVerdict = "LATIN_DOMINANT" | "NON_LATIN_MAJORITY" | "NO_LETTERS";

export interface LanguageMix {
  latinLetters: number;
  nonLatinLetters: number;
  totalLetters: number;
  verdict: LanguageVerdict;
}

/**
 * Analyze the script mix of a single text after NFC normalization. Only `\p{L}`
 * letters count (punctuation, digits, emoji, whitespace, CJK punctuation are
 * NOT language-body evidence).
 *
 * ASYMMETRIC counting (closes the "hide the body in a code fence" bypass):
 *  - NON-Latin letters are counted over the FULL text — so `确认中` inside a
 *    ```code``` fence, `inline code`, or <html> still counts. You cannot hide a
 *    non-Latin body by wrapping it in markup.
 *  - LATIN letters are counted over the PROSE only (non-prose spans stripped) —
 *    so a big Latin code block / URL cannot DILUTE the ratio and mask a
 *    non-Latin prose body.
 * The verdict is NON_LATIN_MAJORITY when non-Latin letters are STRICTLY more
 * than half of (proseLatin + fullNonLatin) — exactly 50% (e.g. "English 中文")
 * passes as Latin-dominant. If there are non-Latin letters but ZERO Latin prose
 * letters, that is a fully non-Latin body → NON_LATIN_MAJORITY.
 */
export function analyzeLanguageMix(text: string): LanguageMix {
  if (!text) return { latinLetters: 0, nonLatinLetters: 0, totalLetters: 0, verdict: "NO_LETTERS" };
  const full = text.normalize("NFC");
  const prose = stripNonProse(full);
  let latin = 0;
  for (const ch of prose) {
    if (/\p{L}/u.test(ch) && !isNonLatinLetter(ch)) latin++;
  }
  let nonLatin = 0;
  for (const ch of full) {
    if (isNonLatinLetter(ch)) nonLatin++;
  }
  const total = latin + nonLatin;
  let verdict: LanguageVerdict;
  if (total === 0) verdict = "NO_LETTERS";
  else if (nonLatin * 2 > total) verdict = "NON_LATIN_MAJORITY";
  else verdict = "LATIN_DOMINANT";
  return { latinLetters: latin, nonLatinLetters: nonLatin, totalLetters: total, verdict };
}

/**
 * True if the text's MAIN prose is a non-Latin writing system (i.e. it is NOT
 * predominantly English/Latin). Empty/whitespace text is treated as English.
 * A minority foreign word passes; only a non-Latin-majority body fails.
 */
export function isNonEnglishText(text: string): boolean {
  return analyzeLanguageMix(text).verdict === "NON_LATIN_MAJORITY";
}

/**
 * True if the prose contains ANY non-Latin letter at all (even a minority one).
 * Used to decide whether the pure-Latin romanized-language semantic fallback is
 * worth running: it only makes sense when the text is 100% Latin script.
 */
export function containsNonLatinLetter(text: string): boolean {
  if (!text) return false;
  // Scan the FULL text (not prose-stripped): a non-Latin letter anywhere —
  // including inside code/URLs — means the pure-Latin romanized-language
  // semantic fallback is not applicable.
  for (const ch of text.normalize("NFC")) {
    if (isNonLatinLetter(ch)) return true;
  }
  return false;
}

/**
 * Given candidate strings (commit messages, or PR title+body), return the first
 * one whose main body is not English, or undefined if all are English. Each
 * string is judged SEPARATELY (never concatenated) so a long English body can
 * never mask a fully non-English title. Used to produce a precise block reason.
 */
export function firstNonEnglish(texts: readonly string[]): string | undefined {
  for (const t of texts) {
    if (isNonEnglishText(t)) return t;
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
 * L5 for ONE COMMIT MESSAGE: the SUBJECT line is judged STRICTLY, the body
 * keeps the majority policy.
 *
 * Why the subject is special (observed 2026-08-29): `firstNonEnglish` judges
 * a message as ONE body by majority, so a long English body — full of
 * identifiers, paths and code tokens — diluted a fully Chinese subject below
 * the 50% threshold and `checkpoint: 修掉…` shipped. The subject is the line
 * every log, blame and changelog shows, so it gets a zero-tolerance rule:
 * ANY non-Latin letter in it rejects. The body keeps `isNonEnglishText`, so a
 * minority foreign term in an English explanation still passes (the relaxation
 * documented at the top of this file is deliberately NOT reverted for bodies,
 * nor for PR title/body, which keep using `firstNonEnglish`).
 *
 * Takes ONE WHOLE message, deliberately: a `git commit -m A -m B` builds a
 * single message whose paragraphs are A and B, so only A is a subject. Judging
 * each `-m` as its own subject would reject a perfectly legal English commit
 * that merely mentions a foreign term in its second paragraph — callers must
 * join the paragraphs with a blank line first, exactly as git does.
 */
export function nonEnglishCommitMessage(message: string): NonEnglishCommitMessage | undefined {
  const subject = commitSubjectLine(message);
  if (containsNonLatinLetter(subject)) return { text: subject, part: "subject" };
  if (isNonEnglishText(message)) return { text: message, part: "body" };
  return undefined;
}

