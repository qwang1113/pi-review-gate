import { test } from "node:test";
import assert from "node:assert/strict";

import {
  judgeEnglish,
  firstNonEnglishText,
  nonEnglishCommitMessage,
  commitSubjectLine,
  containsNonLatinLetter,
  l5BlockReason,
  L5_QUOTE_LENGTH,
  type L5Kind,
} from "../lib/lang-detect.ts";

const KINDS: L5Kind[] = ["commit-subject", "commit-body", "pr-text", "test-label"];

// --- the hard rule: ANY non-Latin letter refuses, on EVERY surface ----------

for (const t of [
  "修复登录",             // Chinese (all CJK letters)
  "ログイン修正",          // Japanese (Kana + Kanji)
  "로그인 수정",           // Korean (Hangul)
  "исправить вход",       // Russian (Cyrillic)
  "διόρθωση",             // Greek
  "إصلاح",                // Arabic
  "תיקון",                // Hebrew
  "แก้ไข",                // Thai
  "Հայերեն",           // Armenian
  "বাংলা",               // Bengali
  "ქართული",           // Georgian
  "ਪੰਜਾਬੀ",             // Gurmukhi
  "தமிழ்",              // Tamil
]) {
  test(`non-English refused on every kind: ${t}`, () => {
    for (const kind of KINDS) {
      assert.equal(judgeEnglish(kind, t)?.kind, kind);
      assert.equal(judgeEnglish(kind, t)?.text, t);
    }
  });
}

// --- English (incl. Latin diacritics, code, emoji) must pass ---------------

for (const t of [
  "fix login bug",
  "add OAuth2 support",
  "café naïve résumé Zürich",   // Latin diacritics = still English/Latin
  "fix #123: update API v2",
  "feat(auth): add JWT",
  "refactor lib/ship-detect.ts",
  "Über-fast cache (co-operate)",
  "「fix」",                     // fullwidth punctuation, no letters at all
  "release 🚀 v2",
  "",                            // empty = nothing to judge
  "   ",
]) {
  test(`English/Latin passes: ${JSON.stringify(t)}`, () => {
    for (const kind of KINDS) assert.equal(judgeEnglish(kind, t), undefined);
  });
}

// --- what the hard rule CHANGED: a minority foreign token no longer passes --

for (const t of [
  "add 功能",
  "Endpoint adds pendingReward (确认中) field",
  "English 中文",
]) {
  test(`a minority foreign token is refused too (majority policy retired): ${JSON.stringify(t)}`, () => {
    assert.ok(judgeEnglish("commit-body", t), "the ratio no longer decides anything");
  });
}

test("markup is not a hiding place: code fences, inline code and HTML all count", () => {
  for (const t of ["```\n确认中\n```", "`确认中`", "<确认中>", "[text](https://例子.com)"]) {
    assert.ok(judgeEnglish("pr-text", t), `${t} must not pass by being wrapped`);
  }
});

// --- containsNonLatinLetter (the primitive) ---------------------------------

test("containsNonLatinLetter is true for any non-Latin letter, false for pure Latin", () => {
  assert.equal(containsNonLatinLetter("mostly english 确"), true);
  assert.equal(containsNonLatinLetter("fix login bug café"), false);
  assert.equal(containsNonLatinLetter("english `变量` prose"), true);
  assert.equal(containsNonLatinLetter(""), false);
});

// --- firstNonEnglishText ----------------------------------------------------

test("firstNonEnglishText returns the FIRST offending string, judged separately", () => {
  const hit = firstNonEnglishText("pr-text", ["fix bug", "修复问题说明", "add test"]);
  assert.equal(hit?.text, "修复问题说明");
  assert.equal(hit?.kind, "pr-text");
});

test("firstNonEnglishText returns undefined when every string is English", () => {
  assert.equal(firstNonEnglishText("pr-text", ["fix bug", "add test"]), undefined);
  assert.equal(firstNonEnglishText("pr-text", []), undefined);
});

test("a long English text cannot mask a short non-English one", () => {
  const long = "A very long English PR description ".repeat(20);
  assert.ok(firstNonEnglishText("pr-text", [long, "标题"]), "each string is judged on its own");
});

// --- nonEnglishCommitMessage: one rule, two locations -----------------------

test("a non-English SUBJECT is reported as the subject, not as the whole message", () => {
  const hit = nonEnglishCommitMessage("修复问题\n\nA long English body that explains the change.");
  assert.equal(hit?.part, "subject");
  assert.equal(hit?.text, "修复问题");
});

test("a single non-Latin letter in the subject is enough", () => {
  const hit = nonEnglishCommitMessage("feat(api): add 分页");
  assert.equal(hit?.part, "subject");
});

test("an English subject with a foreign term in the BODY is reported as the body", () => {
  const msg = [
    "fix(api): handle expired refresh tokens",
    "",
    "The upstream error string is 确认中, quoted verbatim here.",
  ].join("\n");
  const hit = nonEnglishCommitMessage(msg);
  assert.equal(hit?.part, "body", "the body obeys the same hard rule (appealable, not exempt)");
});

test("a fully English message passes, empty and subject-only included", () => {
  assert.equal(nonEnglishCommitMessage("fix bug"), undefined);
  assert.equal(nonEnglishCommitMessage(""), undefined);
  assert.equal(nonEnglishCommitMessage("fix(api): add pagination\n\nWhy: the list endpoint timed out."), undefined);
});

test("commitSubjectLine skips leading blank lines, as git stripspace does", () => {
  assert.equal(commitSubjectLine("\n\n修复问题\n\nEnglish body here."), "修复问题");
  assert.equal(commitSubjectLine("fix: thing\n\nbody"), "fix: thing");
  assert.equal(commitSubjectLine("   \n  fix: padded  \n"), "fix: padded");
  assert.equal(commitSubjectLine(""), "");
  assert.equal(commitSubjectLine("\n\n\n"), "");
});

test("the leading-blank-line subject bypass stays closed", () => {
  const hit = nonEnglishCommitMessage("\n\n修复问题\n\nAn English body that follows it.");
  assert.equal(hit?.part, "subject");
  assert.equal(hit?.text, "修复问题");
});

test("a multi -m message is ONE message: only its first paragraph holds a subject", () => {
  const paragraphs = ["fix(api): add pagination", "Why: the list endpoint timed out."];
  assert.equal(nonEnglishCommitMessage(paragraphs.join("\n\n")), undefined);
  assert.equal(nonEnglishCommitMessage(["修复问题", "English body."].join("\n\n"))?.part, "subject");
});

// --- the shared block sentence ---------------------------------------------

test("l5BlockReason names the surface and quotes a bounded prefix", () => {
  const long = "确".repeat(200);
  const text = l5BlockReason({ kind: "commit-subject", text: long });
  assert.match(text, /the commit SUBJECT line is not English/);
  assert.match(text, /L5 accepts no non-Latin letters at all/);
  assert.ok(text.includes("确".repeat(L5_QUOTE_LENGTH)), "the quote is capped, not the whole text");
  assert.ok(!text.includes("确".repeat(L5_QUOTE_LENGTH + 1)));
});

test("every kind has its own sentence", () => {
  const seen = new Set(KINDS.map((kind) => l5BlockReason({ kind, text: "x" })));
  assert.equal(seen.size, KINDS.length, "no two surfaces share a reason");
});
