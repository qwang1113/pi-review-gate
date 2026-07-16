/**
 * Language gate for commit / PR text (L5).
 *
 * Requirement: commit messages and PR title/description must be ENGLISH. We do
 * not try to prove text *is* English (undecidable, and English borrows foreign
 * words); instead we fail-closed on the unambiguous signal that it is NOT:
 * the presence of a NON-LATIN writing system (CJK, Kana, Hangul, Cyrillic,
 * Greek, Arabic, Hebrew, Thai, Devanagari, …).
 *
 * This deliberately ALLOWS: ASCII, code identifiers, numbers, punctuation,
 * URLs, emoji, and Latin text with diacritics (café, naïve) — so it never
 * blocks legitimate English-with-loanwords, only text written in another
 * script. Pure, no I/O, unit-tested.
 */

/**
 * True if any character is a LETTER from a script other than Latin. Uses Unicode
 * property escapes: `\p{L}` = any letter, `\p{Script=Latin}` = a Latin letter.
 * "A letter that is not Latin" catches EVERY non-Latin writing system (CJK,
 * Kana, Hangul, Cyrillic, Greek, Arabic, Hebrew, Thai, Armenian, Bengali,
 * Georgian, Gurmukhi, Tamil, …) with no per-script whitelist, while Latin
 * letters (incl. accented é/ü/ñ) are excluded so English loanwords pass.
 */
function hasNonLatinLetter(text: string): boolean {
  for (const ch of text) {
    if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) return true;
  }
  return false;
}

/**
 * Non-letter CJK punctuation/symbols that also signal non-English text
 * (、。「」, fullwidth forms), which `\p{L}` alone wouldn't catch.
 */
const CJK_PUNCT = /[\u3000-\u303f\uff00-\uffef]/u;

/**
 * True if the text contains a non-Latin writing system (i.e. it is NOT plain
 * English/Latin). Empty/whitespace text is treated as English. Allows Latin
 * letters with diacritics, digits, punctuation, URLs, and emoji.
 */
export function isNonEnglishText(text: string): boolean {
  if (!text) return false;
  return hasNonLatinLetter(text) || CJK_PUNCT.test(text);
}

/**
 * Given candidate strings (commit messages, or PR title+body), return the first
 * one that is not English, or undefined if all are English. Used to produce a
 * precise block reason.
 */
export function firstNonEnglish(texts: readonly string[]): string | undefined {
  for (const t of texts) {
    if (isNonEnglishText(t)) return t;
  }
  return undefined;
}
