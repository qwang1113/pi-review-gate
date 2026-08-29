import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isNonEnglishText,
  firstNonEnglish,
  nonEnglishCommitMessage,
  commitSubjectLine,
  analyzeLanguageMix,
  stripNonProse,
  containsNonLatinLetter,
} from "../lib/lang-detect.ts";

// --- predominantly non-English (majority body) must be flagged -------------

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
  test(`non-English flagged (majority): ${t}`, () => {
    assert.equal(isNonEnglishText(t), true);
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
  "",                            // empty = nothing to flag
  "   ",
]) {
  test(`English/Latin passes: ${JSON.stringify(t)}`, () => {
    assert.equal(isNonEnglishText(t), false);
  });
}

// --- majority-body policy: a MINORITY foreign token passes -----------------

for (const t of [
  "add 功能",                                 // 3 Latin vs 2 CJK → Latin-dominant
  "「fix」",                                   // fullwidth punctuation, no letters → passes
  "Endpoint adds pendingReward (确认中) field", // one quoted CJK term in English prose
  "English 中文",                              // exactly 50% letters → passes (not majority)
]) {
  test(`minority-foreign passes: ${JSON.stringify(t)}`, () => {
    assert.equal(isNonEnglishText(t), false);
  });
}

// --- majority-body policy: a MAJORITY non-Latin body fails -----------------

for (const t of [
  "中文 English 说明文字更多",   // more CJK than Latin
  "确认中 确认中 ok",           // 4 CJK vs 2 Latin
]) {
  test(`majority-foreign flagged: ${JSON.stringify(t)}`, () => {
    assert.equal(isNonEnglishText(t), true);
  });
}

// --- analyzeLanguageMix boundary -------------------------------------------

test("exactly 50% non-Latin letters is LATIN_DOMINANT (not majority)", () => {
  const m = analyzeLanguageMix("ab中文"); // 2 Latin, 2 CJK
  assert.equal(m.latinLetters, 2);
  assert.equal(m.nonLatinLetters, 2);
  assert.equal(m.verdict, "LATIN_DOMINANT");
});

test("just over 50% non-Latin letters is NON_LATIN_MAJORITY", () => {
  const m = analyzeLanguageMix("ab中文字"); // 2 Latin, 3 CJK
  assert.equal(m.verdict, "NON_LATIN_MAJORITY");
});

test("no letters at all is NO_LETTERS (passes)", () => {
  const m = analyzeLanguageMix("123 !@# 「」 😀");
  assert.equal(m.totalLetters, 0);
  assert.equal(m.verdict, "NO_LETTERS");
  assert.equal(isNonEnglishText("123 !@# 「」 😀"), false);
});

// --- non-prose stripping ----------------------------------------------------

test("fenced code block does not dilute a non-Latin body", () => {
  // A big Latin code fence must not mask a mostly-Chinese prose body.
  const text = "说明文字全部是中文的正文内容\n```\nconst x = someVeryLongLatinIdentifierList = 1;\n```";
  assert.equal(isNonEnglishText(text), true);
});

test("a fully non-Latin body hidden in a code fence is STILL flagged (asymmetric count)", () => {
  // Reviewer P1: wrapping the whole non-English body in markup must not pass it.
  assert.equal(isNonEnglishText("```\n确认中确认中\n```"), true);
  assert.equal(isNonEnglishText("`确认中确认中`"), true);
  assert.equal(isNonEnglishText("<确认中确认中>"), true);
});

test("non-Latin letters count even inside code; Latin code does not dilute them", () => {
  const m = analyzeLanguageMix("```\nconst x = veryLongLatinIdentifier = 1;\n```\n确认中的说明");
  // Latin code stripped from the denominator; the CJK prose is the majority.
  assert.equal(m.verdict, "NON_LATIN_MAJORITY");
});

test("inline code and URLs are stripped before counting", () => {
  const stripped = stripNonProse("see `constVar` at https://example.com/path中文");
  assert.ok(!stripped.includes("constVar"));
  assert.ok(!stripped.includes("example.com"));
});

test("markdown link keeps visible text, drops destination", () => {
  const stripped = stripNonProse("[click here](https://例子.com/中文路径)");
  assert.ok(stripped.includes("click here"));
  assert.ok(!stripped.includes("例子"));
});

// --- containsNonLatinLetter -------------------------------------------------

test("containsNonLatinLetter true for any non-Latin letter", () => {
  assert.equal(containsNonLatinLetter("mostly english 确"), true);
});
test("containsNonLatinLetter false for pure Latin/ASCII", () => {
  assert.equal(containsNonLatinLetter("fix login bug café"), false);
});
test("containsNonLatinLetter scans the FULL text incl. code/URLs (disables romanized fallback)", () => {
  // A non-Latin letter anywhere means the text is not pure-Latin, so the
  // romanized-non-English semantic fallback must not run.
  assert.equal(containsNonLatinLetter("english `变量` prose"), true);
});

// --- firstNonEnglish --------------------------------------------------------

test("firstNonEnglish returns the first offending string", () => {
  assert.equal(firstNonEnglish(["fix bug", "修复问题说明", "add test"]), "修复问题说明");
});
test("firstNonEnglish ignores a minority-foreign string", () => {
  assert.equal(firstNonEnglish(["fix bug", "add 功能", "add test"]), undefined);
});
test("firstNonEnglish returns undefined when all English", () => {
  assert.equal(firstNonEnglish(["fix bug", "add test"]), undefined);
});
test("firstNonEnglish handles empty list", () => {
  assert.equal(firstNonEnglish([]), undefined);
});

// --- nonEnglishCommitMessage (subject strict, body majority) -----------------
//
// Regression origin (2026-08-29): checkpoint f161146 landed with a fully
// Chinese subject because the majority check judged the WHOLE message and the
// long English body diluted the subject below the 50% threshold.

/** The real message that slipped through: Chinese subject, English-heavy body. */
const DILUTED_SUBJECT = [
  "checkpoint: 修掉上一轮重构遗留的 2 条非阻塞 P2 提示文案（纯文案 + 死变量清理，无行为改动）：",
  "",
  "1. extensions/review-gate.ts record_review STALE TARGET: replace the manual",
  "   review_checkpoint -> prepare_review -> review_spawn -> record_review chain",
  "   with one judge_submit call. The STALE cause and the short-next-round line",
  "   are preserved verbatim, and prepare_review keeps stream, waiting discipline",
  "   and the truncated goal instructions untouched.",
].join("\n");

test("nonEnglishCommitMessage catches a non-English SUBJECT that the majority check missed", () => {
  // The exact bypass: the whole-message majority check passes...
  assert.equal(firstNonEnglish([DILUTED_SUBJECT]), undefined);
  // ...but the subject-line rule rejects it.
  const hit = nonEnglishCommitMessage(DILUTED_SUBJECT);
  assert.equal(hit?.part, "subject");
  assert.match(hit?.text ?? "", /^checkpoint: 修掉/);
});

test("nonEnglishCommitMessage rejects even a SINGLE non-Latin letter in the subject", () => {
  const hit = nonEnglishCommitMessage("feat(api): add 分页");
  assert.equal(hit?.part, "subject");
  assert.equal(hit?.text, "feat(api): add 分页");
  // The majority policy alone would have let this through — that is the point.
  assert.equal(firstNonEnglish(["feat(api): add 分页"]), undefined);
});

test("nonEnglishCommitMessage passes an English subject with a minority foreign term in the BODY", () => {
  const msg = [
    "feat(api): add pagination to list endpoints",
    "",
    "The client team calls this 分页, but the body stays English overall so the",
    "majority policy documented for bodies keeps applying unchanged here.",
  ].join("\n");
  assert.equal(nonEnglishCommitMessage(msg), undefined);
});

test("nonEnglishCommitMessage still flags a predominantly non-English BODY", () => {
  const msg = "fix(auth): handle expired tokens\n\n这个提交修复了刷新令牌过期之后无法续期的问题，并补充了相应的回归测试。";
  const hit = nonEnglishCommitMessage(msg);
  assert.equal(hit?.part, "body");
});

test("nonEnglishCommitMessage handles empty and subject-only messages", () => {
  assert.equal(nonEnglishCommitMessage(""), undefined);
  assert.equal(nonEnglishCommitMessage("fix bug"), undefined);
  // A single-line (subject-only) message is judged strictly too.
  assert.equal(nonEnglishCommitMessage("修复问题")?.part, "subject");
});

// --- the two bypasses found in review (2026-08-29, round 2) ------------------

test("commitSubjectLine skips leading blank lines, as git stripspace does", () => {
  // A single leading newline used to make the subject look empty, so a Chinese
  // subject sailed through while git still recorded it AS the subject.
  // (Known, harmless divergence: stripspace preserves a line's leading indent
  // and this trims it. Indentation carries no letters, so L5 is unaffected —
  // only the echoed text in a refusal differs.)
  assert.equal(commitSubjectLine("\n\n修复问题\n\nEnglish body here."), "修复问题");
  assert.equal(commitSubjectLine("fix: thing\n\nbody"), "fix: thing");
  assert.equal(commitSubjectLine("   \n  fix: padded  \n"), "fix: padded");
  assert.equal(commitSubjectLine(""), "");
  assert.equal(commitSubjectLine("\n\n\n"), "");
});

test("nonEnglishCommitMessage closes the leading-blank-line subject bypass", () => {
  const hit = nonEnglishCommitMessage("\n\n修复问题\n\nA long English body that would otherwise dominate the majority count here.");
  assert.equal(hit?.part, "subject", "the real subject is judged, not the empty first line");
  assert.equal(hit?.text, "修复问题");
});

test("nonEnglishCommitMessage judges a multi -m message as ONE message, not many subjects", () => {
  // `git commit -m A -m B` produces "A\n\nB": only A is a subject. Judging each
  // -m as its own subject would reject this legal English commit.
  const paragraphs = [
    "feat(api): add pagination to list endpoints",
    "The client team calls this 分页, but the body stays English overall so the majority policy applies.",
  ];
  assert.equal(nonEnglishCommitMessage(paragraphs.join("\n\n")), undefined,
    "a foreign term in the SECOND paragraph is body text, not a subject");
  // ...while a Chinese FIRST paragraph is still caught.
  assert.equal(nonEnglishCommitMessage(["修复问题", "English body."].join("\n\n"))?.part, "subject");
});

