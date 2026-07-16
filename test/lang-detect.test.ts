import { test } from "node:test";
import assert from "node:assert/strict";

import { isNonEnglishText, firstNonEnglish } from "../lib/lang-detect.ts";

// --- non-English scripts must be flagged -----------------------------------

for (const t of [
  "修复登录bug",          // Chinese
  "ログイン修正",          // Japanese (Kana + Kanji)
  "로그인 수정",           // Korean (Hangul)
  "исправить вход",       // Russian (Cyrillic)
  "διόρθωση",             // Greek
  "إصلاح",                // Arabic
  "תיקון",                // Hebrew
  "แก้ไข",                // Thai
  "add 功能",             // mixed English + CJK
  "「fix」",              // fullwidth CJK punctuation
  "Հայերեն",           // Armenian
  "বাংলা",               // Bengali
  "ქართული",           // Georgian
  "ਪੰਜਾਬੀ",             // Gurmukhi
  "தமிழ்",              // Tamil
]) {
  test(`non-English flagged: ${t}`, () => {
    assert.equal(isNonEnglishText(t), true);
  });
}

// --- English (incl. Latin diacritics, code, emoji) must pass ---------------

for (const t of [
  "fix login bug",
  "add OAuth2 support",
  "café naïve résumé Zürich",   // Latin diacritics = still English/Latin
  "fix #123: update API v2",
  "feat(auth): add JWT 🔐",     // emoji is fine
  "refactor lib/ship-detect.ts",
  "Über-fast cache (co-operate)",
  "",                            // empty = nothing to flag
  "   ",
]) {
  test(`English/Latin passes: ${JSON.stringify(t)}`, () => {
    assert.equal(isNonEnglishText(t), false);
  });
}

// --- firstNonEnglish --------------------------------------------------------

test("firstNonEnglish returns the first offending string", () => {
  assert.equal(firstNonEnglish(["fix bug", "修复问题", "add test"]), "修复问题");
});
test("firstNonEnglish returns undefined when all English", () => {
  assert.equal(firstNonEnglish(["fix bug", "add test"]), undefined);
});
test("firstNonEnglish handles empty list", () => {
  assert.equal(firstNonEnglish([]), undefined);
});
