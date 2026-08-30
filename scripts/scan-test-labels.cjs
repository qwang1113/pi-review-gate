#!/usr/bin/env node
/**
 * Test-label English gate (CJS, no Pi dependency).
 *
 * Enforces: the description string of a JS/TS test (`it(...)`, `test(...)`,
 * `describe(...)`, incl. `.only`/`.skip` chains) must be English, unless an
 * explicit bypass marker exempts it. Run by hooks/pre-commit over STAGED
 * content so it checks exactly what is about to be committed.
 *
 * Non-English detection mirrors lib/lang-detect.ts — keep them in sync: a
 * label is flagged when it contains ANY non-Latin letter (CJK/Kana/Hangul/
 * Cyrillic/…). Latin-with-diacritics (café), digits, punctuation, URLs and
 * emoji all pass.
 *
 * We do NOT regex raw source (that false-positives on comments, embedded
 * strings, `foo . it(...)`, and `it(` inside a regex literal). Instead a tiny
 * zero-dependency JS/TS lexer classifies every character as code / string /
 * comment / regex. Label extraction and marker recognition then run against
 * that classification:
 *   - a test call is `it|test|describe` (+ `.only`/`.skip` chains) in CODE,
 *     immediately followed by `(` and a STRING-literal first argument;
 *   - a bypass marker is only honored inside a `//` LINE comment.
 *
 * Bypass markers (case-insensitive), recognized ONLY in `//` line comments:
 *   - Line-level:  `// review-gate: allow-non-english`  — a standalone marker
 *                  line exempts the first test call on the NEXT line; a trailing
 *                  marker (`it('…'); // …`) exempts the call on ITS OWN line.
 *                  Each marker exempts EXACTLY ONE call (consume model).
 *   - File-level:  `// review-gate: allow-non-english-file` in a line comment
 *                  within the first 5 lines exempts the whole file.
 *
 * Scope (MVP, deliberately narrow to keep false positives ~zero):
 *   - Files whose name matches *.test.* / *.spec.* or that live under __tests__/,
 *     with extension in {ts,tsx,js,jsx,mjs,cjs}.
 *   - STATIC string labels only. Template literals with `${…}` interpolation
 *     are skipped (dynamic); a template with a literal `$` but no interpolation
 *     is still checked.
 *   - Known MVP limitations (documented, not blocked): a label wrapped in
 *     parentheses `it(('x'))`, or produced by `it.each([...])('x')`, is not
 *     matched; block-comment `/​* … *​/` markers are NOT honored (use `//`).
 *
 * Usage:  node scan-test-labels.cjs <repoDir>
 * Exit:   0 = clean (or nothing to check), 1 = a non-English label was found.
 */

const { execFileSync } = require("node:child_process");

const REPO = process.argv[2] || process.cwd();

// ---- test-file identification -------------------------------------------------
const TEST_EXT = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);
function extOf(p) {
  const base = p.split("/").pop() || "";
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : "";
}
function isTestFile(p) {
  if (!TEST_EXT.has(extOf(p))) return false;
  const base = p.split("/").pop() || "";
  return /\.(test|spec)\./.test(base) || /(^|\/)__tests__\//.test(p);
}

// ---- non-English detection (mirror of lib/lang-detect.ts) --------------------
// ONE HARD RULE, kept in sync with judgeEnglish() in lib/lang-detect.ts: a
// label with ANY non-Latin letter is refused. The whole label is scanned —
// code spans, URLs and markup included — because wrapping a label in backticks
// must not turn it into a bypass. Latin-with-diacritics (café), digits,
// punctuation, emoji and fullwidth punctuation carry no non-Latin LETTER and
// therefore pass. The majority-ratio policy this file used to mirror was
// retired on 2026-08-29 (see lib/lang-detect.ts for why); the sanctioned
// exceptions are the `// review-gate: allow-non-english` markers below and,
// inside a Pi session, an arbitrated appeal.
//
// This file is CJS with no Pi dependency (the git hook runs it with plain
// node), so the rule is duplicated here rather than imported — keep the two
// in sync.
function isNonEnglishText(text) {
  if (!text) return false;
  for (const ch of text.normalize("NFC")) {
    if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) return true;
  }
  return false;
}

// ---- bypass markers ----------------------------------------------------------
const FILE_MARKER = /review-gate:\s*allow-non-english-file\b/i;
// Line marker must NOT also match the `-file` variant.
const LINE_MARKER = /review-gate:\s*allow-non-english\b(?!-file)/i;

// ---- lexer -------------------------------------------------------------------
// Keywords after which a `/` begins a REGEX (an expression is expected next).
// Deliberately EXCLUDES contextual words like `of`/`in` that are commonly used
// as ordinary identifiers/property names: misclassifying them as expr-keywords
// makes a following `/` look like a regex and can swallow a real test call.
const EXPR_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "new", "delete", "void",
  "do", "else", "yield", "throw", "case", "await",
]);
// Keywords whose `(` introduces a CONTROL-FLOW head, so the matching `)` is
// followed by a statement position where `/` begins a regex.
const CONTROL_HEADS = new Set(["if", "for", "while", "with", "switch", "catch"]);

// ECMAScript identifier character classes (Unicode-aware, plus `$`/`_`). Used so
// non-ASCII identifiers don't get mis-lexed and cause a regex/division misread.
// Tested against a whole CODE POINT string (may be an astral pair), never a lone
// surrogate, so astral identifiers (e.g. Mathematical Alphanumeric letters) are
// recognized too.
const ID_START = /[$_\p{ID_Start}]/u;
const ID_CONT = /[$\u200c\u200d\p{ID_Continue}]/u;

/** Code point (as a string) starting at `idx`, and its UTF-16 length. */
function cpAt(src, idx) {
  const cp = src.codePointAt(idx);
  if (cp === undefined) return { ch: "", len: 1 };
  const ch = String.fromCodePoint(cp);
  return { ch, len: ch.length };
}
/** Code point (as a string) ENDING just before `idx` (handles a trailing pair). */
function cpBefore(src, idx) {
  if (idx <= 0) return "";
  const lo = src.charCodeAt(idx - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && idx >= 2) {
    const hi = src.charCodeAt(idx - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return src.slice(idx - 2, idx);
  }
  return src[idx - 1] || "";
}

/**
 * Decode ONE backslash escape starting at src[i] (src[i] === "\\") following JS
 * string-literal semantics, so the extracted label VALUE matches what the test
 * runner would print. Tool-generated code (transpilers, JSON round-trips, i18n
 * pipelines) legitimately writes non-ASCII labels as \uXXXX — a fallible agent
 * pasting such output must not slip past the gate. Covers \uXXXX, \u{…}, \xXX,
 * the single-char escapes, and line continuations. Invalid escapes fall back to
 * the identity of the escaped character (they are SyntaxErrors in real JS, so
 * leniency here cannot hide a valid non-Latin letter). A surrogate pair written
 * as two \uXXXX escapes concatenates into the astral code point, which the
 * code-point-aware detector then sees whole. Returns { text, next }.
 */
function decodeEscape(src, i) {
  const e = src[i + 1];
  if (e === undefined) return { text: "", next: i + 1 };
  if (e === "u") {
    if (src[i + 2] === "{") {
      const close = src.indexOf("}", i + 3);
      const hex = close > 0 ? src.slice(i + 3, close) : "";
      if (close > 0 && /^[0-9a-fA-F]{1,6}$/.test(hex)) {
        const cp = parseInt(hex, 16);
        if (cp <= 0x10ffff) return { text: String.fromCodePoint(cp), next: close + 1 };
      }
    } else if (/^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
      return { text: String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)), next: i + 6 };
    }
    return { text: "u", next: i + 2 }; // invalid → lenient identity
  }
  if (e === "x") {
    if (/^[0-9a-fA-F]{2}$/.test(src.slice(i + 2, i + 4))) {
      return { text: String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)), next: i + 4 };
    }
    return { text: "x", next: i + 2 };
  }
  if (e === "\n") return { text: "", next: i + 2 };                              // line continuation
  if (e === "\r") return { text: "", next: src[i + 2] === "\n" ? i + 3 : i + 2 }; // CRLF continuation
  const SIMPLE = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
  if (SIMPLE[e] !== undefined) return { text: SIMPLE[e], next: i + 2 };
  return { text: e, next: i + 2 }; // \' \" \\ \` \$ … identity
}

/**
 * Lex JS/TS into the tokens we care about: string/template literals, `//` line
 * comments, block comments, and regex literals. Everything else is implicit
 * code. Returns an array of { kind, start, end, ... }.
 *
 * Regex-vs-division uses the "previous significant token" heuristic: `/` starts
 * a regex unless the previous significant token is a VALUE (identifier, number,
 * string, template, regex, `]`, postfix `++`/`--`, a value-keyword, or a `)`
 * that closed a call/grouping rather than a control-flow head). Keywords like
 * `return` and a `)` that closed `if (...)`/`while (...)` are followed by a
 * regex. A small `( )` stack tracks control-flow parens.
 */
function lex(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  // prev significant token: { kind: 'value'|'expr-kw'|'punct', value }
  let prev = null;
  const parenCtrl = []; // per '(' : did it follow a control-flow keyword?

  function regexAllowed() {
    if (!prev) return true;
    if (prev.kind === "value") return false;    // ident/num/string/regex/]/++/value-kw
    if (prev.kind === "expr-kw") return true;   // return / typeof / …
    // punct:
    if (prev.value === ")") return prev.ctrl === true; // if(...)/re/ vs f()/2
    // `}` is genuinely ambiguous (block-statement end → regex, but object/
    // function/class-EXPRESSION end → division). We cannot disambiguate without a
    // full parser, so we fail-closed AGAINST swallowing a real test call: treat
    // `}` as a value so `{} / it('…') / 2` stays division and the it() is still
    // scanned. Cost: a genuine regex after a bare block statement is read as
    // code (a possible false positive, which only costs one bypass marker).
    if (prev.value === "}") return false;
    return true;                                // = ( , ; : ! & | ? + - * etc.
  }

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === "/" && c2 === "/") {
      const start = i;
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      tokens.push({ kind: "line", start, end: i, text: src.slice(start, i) });
      continue; // comments don't update prev
    }
    if (c === "/" && c2 === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      tokens.push({ kind: "block", start, end: i, text: src.slice(start, i) });
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i;
      const quote = c;
      i++;
      let value = "";
      while (i < n) {
        const ch = src[i];
        if (ch === "\\") { const d = decodeEscape(src, i); value += d.text; i = d.next; continue; }
        if (ch === quote) { i++; break; }
        if (ch === "\n") break; // unterminated on this line — stop
        value += ch;
        i++;
      }
      tokens.push({ kind: "string", start, end: i, value });
      prev = { kind: "value", value: "str" };
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      let value = "";
      let dynamic = false;
      while (i < n) {
        const ch = src[i];
        if (ch === "\\") { const d = decodeEscape(src, i); value += d.text; i = d.next; continue; }
        if (ch === "`") { i++; break; }
        if (ch === "$" && src[i + 1] === "{") { dynamic = true; i += 2; continue; }
        value += ch;
        i++;
      }
      tokens.push({ kind: "string", start, end: i, value, dynamic });
      prev = { kind: "value", value: "tmpl" };
      continue;
    }
    if (c === "/" && regexAllowed()) {
      // Regex literal: consume body honoring `\` escapes and `[...]` classes.
      const start = i;
      i++;
      let inClass = false;
      let ok = false;
      while (i < n) {
        const ch = src[i];
        if (ch === "\\") { i += 2; continue; }
        if (ch === "\n") break; // unterminated regex — bail
        if (ch === "[") { inClass = true; i++; continue; }
        if (ch === "]") { inClass = false; i++; continue; }
        if (ch === "/" && !inClass) { i++; ok = true; break; }
        i++;
      }
      if (ok) {
        while (i < n && /[a-z]/i.test(src[i])) i++; // flags
        tokens.push({ kind: "regex", start, end: i });
        prev = { kind: "value", value: "regex" };
        continue;
      }
      i = start; // not a regex after all; fall through to punct handling of `/`
    }
    // identifier / keyword / private name (#name). Identifier chars follow the
    // ECMAScript ID_Start/ID_Continue Unicode sets (plus `$` and `_`), read by
    // CODE POINT so non-ASCII identifiers (`é`, `甲`, astral `𝟙`, `obj.返回`,
    // `#é`) lex as one value token and a following `/` is division, not a
    // mis-inferred regex.
    const cp0 = cpAt(src, i);
    const afterHash = c === "#" ? cpAt(src, i + 1) : null;
    if (ID_START.test(cp0.ch) || (c === "#" && afterHash && ID_START.test(afterHash.ch))) {
      const priv = c === "#";
      let j = i + (priv ? 1 : cp0.len);
      for (;;) {
        if (j >= n) break;
        const { ch, len } = cpAt(src, j);
        if (!ID_CONT.test(ch)) break;
        j += len;
      }
      const word = src.slice(i, j);
      i = j;
      // A word right after `.` / `?.` is a PROPERTY NAME, and a `#name` is a
      // private member name — never a keyword. So `obj.return`, `obj.await`,
      // `this.#return`, `this.#if` are member accesses and a following `/` is
      // division. Classify as a plain value and never a control head.
      const isProperty = priv || (prev && prev.kind === "punct" && prev.value === ".");
      if (!isProperty && EXPR_KEYWORDS.has(word)) prev = { kind: "expr-kw", value: word };
      else prev = { kind: "value", value: word, ctrlHead: !isProperty && CONTROL_HEADS.has(word) };
      continue;
    }
    // number
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j])) j++;
      i = j;
      prev = { kind: "value", value: "num" };
      continue;
    }
    // punctuators
    if (c === "+" && c2 === "+") { i += 2; prev = { kind: "value", value: "++" }; continue; }
    if (c === "-" && c2 === "-") { i += 2; prev = { kind: "value", value: "--" }; continue; }
    if (c === "(") {
      // control-flow head if the previous significant token was if/for/while/…
      parenCtrl.push(prev && prev.kind === "value" && prev.ctrlHead === true);
      i++;
      prev = { kind: "punct", value: "(" };
      continue;
    }
    if (c === ")") {
      const ctrl = parenCtrl.length ? parenCtrl.pop() : false;
      i++;
      prev = { kind: "punct", value: ")", ctrl };
      continue;
    }
    if (c === "]") { i++; prev = { kind: "value", value: "]" }; continue; }
    if (/\s/.test(c)) { i++; continue; } // whitespace: prev unchanged
    // any other single punctuator
    i++;
    prev = { kind: "punct", value: c };
  }
  return tokens;
}

/** 1 where a char is inside a string/comment/regex token, 0 in code. */
function maskOf(src, tokens) {
  const mask = new Uint8Array(src.length);
  for (const t of tokens) {
    for (let k = t.start; k < t.end && k < src.length; k++) mask[k] = 1;
  }
  return mask;
}

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineAt(starts, offset) {
  let lo = 0, hi = starts.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans + 1;
}

// A test-call head in CODE: it/test/describe (+ .only/.skip …) then `(`.
//
// The three standard names alone are NOT enough: a repo may import them under
// a LOCAL ALIAS (often another language's word — `import { describe as 描述 }
// from "node:test"`), and abused aliases then dodge the gate because `描述(`
// never matches an ASCII-only pattern. So the head set is the STANDARD three
// plus every import-alias bound to one of them found in the same file
// (`import { it as 应该 }` → `应该` is a test head too). Aliases are matched
// against a Unicode-aware identifier boundary (the ASCII `\b` cannot see a
// CJK boundary), while the standard names keep `\b` — see
// buildTestHeadRegex().
const HEAD_RE = /\b(it|test|describe)((?:\s*\.\s*\w+)*)\s*\(/g;

/**
 * Collect test-function import aliases from the file: every binding that
 * aliases one of `it|test|describe` (`import { describe as 描述 }`, incl.
 * `.only`/`.skip` are METHODS on the alias, not separate bindings). Both
 * named bindings (`{ it as x }`) and default-of-known shapes are handled; a
 * namespace import (`import * as t`) is deliberately NOT treated as a test
 * head — `t.it('…')` is a member call the same way `foo.it(` is, and the
 * method-name gate already covers the standard names on it.
 * Returns the alias identifiers in source order (deduped).
 */
function testImportAliases(src) {
  const aliases = [];
  const seen = new Set();
  // import { it as 应该, test as 检查, describe as 描述 } from "...";
  const namedRe = /\bimport\s*\{\s*([\s\S]*?)\s*\}\s*from\s*[\x27"`][\s\S]*?[\x27"`]\s*;?/g;
  let m;
  while ((m = namedRe.exec(src)) !== null) {
    const body = m[1];
    // Split top-level commas at brace depth 0 inside the body.
    let depth = 0;
    let cur = "";
    for (const ch of body) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (ch === "," && depth === 0) {
        const spec = cur.trim();
        if (spec && !seen.has(spec)) { seen.add(spec); aliases.push(spec); }
        cur = "";
        continue;
      }
      cur += ch;
    }
    const last = cur.trim();
    if (last && !seen.has(last)) { seen.add(last); aliases.push(last); }
  }
  const out = [];
  for (const spec of aliases) {
    // `import { describe as 描述 }` — the IMPORTED name is `describe` (the
    // framework's), the LOCAL alias is `描述` (what the source calls). Only
    // bind the alias when the imported name is one of the test functions.
    const parts = spec.split(/\s+as\s+/i);
    if (parts.length !== 2) continue;             // plain `{ it }` — standard name
    const imported = parts[0].trim().replace(/,$/, "");
    const local = parts[1].trim();
    if (!/^(it|test|describe)$/.test(imported)) continue;
    if (!local || !/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(local)) continue;
    if (!out.includes(local)) out.push(local);
  }
  return out;
}

/** Build the per-file test-head matcher: standard names plus import aliases. */
function buildTestHeadRegex(src) {
  const aliases = testImportAliases(src);
  if (aliases.length === 0) return HEAD_RE;
  // The ASCII `\b` cannot see a CJK boundary, so an alias alternative needs
  // its own left boundary: not preceded by an identifier char / `.` / `#`.
  // Positive-lookbehind `(?<![\w$.])` is ES2018 and fine for a node script;
  // the standard branch keeps its historical `\b` behavior (a member access
  // `foo.it(` is filtered by isMemberAccess anyway).
  const aliasAlt = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?:\\b(it|test|describe)|(?<![\\w$.#])(?:${aliasAlt}))((?:\\s*\\.\\s*\\w+)*)\\s*\\(`, "g");
}

/** Not a standalone global `it(`/`test(`/`describe(` call when either:
 *  - the char immediately before is an identifier char or `#`, so the match is
 *    only a SUFFIX of a longer name (`甲it`, `myit`, `#it`) — HEAD_RE's `\b` is
 *    ASCII-only and doesn't see a Unicode-letter boundary; or
 *  - skipping whitespace lands on `.` (member access `foo.it(`, `foo . it(`).
 */
function isMemberAccess(src, idStart) {
  if (idStart > 0) {
    const before = cpBefore(src, idStart);
    if (before === "#" || ID_CONT.test(before)) return true;
  }
  let j = idStart - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j >= 0 && src[j] === ".";
}

/** The first argument as a string token: from `(` skip whitespace AND comment
 * tokens, then require a string literal exactly there. */
function firstArgString(src, tokens, tokenByStart, from) {
  let j = from;
  for (;;) {
    while (j < src.length && /\s/.test(src[j])) j++;
    const t = tokenByStart.get(j);
    if (t && (t.kind === "line" || t.kind === "block")) { j = t.end; continue; }
    break;
  }
  const tok = tokenByStart.get(j);
  return tok && tok.kind === "string" ? tok : null;
}

/**
 * Full analysis of one file: deterministic violations (non-Latin labels, for
 * the pre-commit hook) AND the non-exempt static labels that PASSED the
 * Unicode check (`latinLabels`) — the extension feeds those to the LLM
 * english-check layer, which catches romanized non-English (pinyin/romaji)
 * that Unicode script detection cannot see. Exempt markers apply to both.
 */
function analyzeFile(path, src) {
  const violations = [];
  const latinLabels = [];
  const result = { violations, latinLabels };
  const tokens = lex(src);
  const mask = maskOf(src, tokens);
  const starts = lineStarts(src);
  const tokenByStart = new Map();
  for (const t of tokens) tokenByStart.set(t.start, t);

  // File-level bypass: a `//` LINE comment within the first 5 lines whose OWN
  // line (line comments are single-line) carries the file marker.
  for (const t of tokens) {
    if (t.kind === "line" && FILE_MARKER.test(t.text) && lineAt(starts, t.start) <= 5) {
      return result;
    }
  }

  // Line markers (only `//` comments). Each carries its true line and whether it
  // is trailing (code precedes it on the line) — used by the consume model.
  const markers = [];
  for (const t of tokens) {
    if (t.kind !== "line" || !LINE_MARKER.test(t.text)) continue;
    const line = lineAt(starts, t.start);
    const lineStart = starts[line - 1];
    const isTrailing = src.slice(lineStart, t.start).trim().length > 0;
    markers.push({ line, offset: t.start, isTrailing });
  }

  // Collect ALL test calls in source order (English ones too), so a marker can
  // bind to the genuine FIRST test call on its target line — not merely the
  // first non-English one (which would let a marker silently skip an English
  // neighbour and exempt a non-English call further along).
  const calls = [];
  const headRe = buildTestHeadRegex(src);
  let m;
  headRe.lastIndex = 0;
  while ((m = headRe.exec(src)) !== null) {
    const idStart = m.index;
    if (mask[idStart]) continue;                 // inside string/comment/regex
    if (isMemberAccess(src, idStart)) continue;  // foo.it( / foo.描述(
    const parenIdx = m.index + m[0].length;
    const arg = firstArgString(src, tokens, tokenByStart, parenIdx);
    // A call whose first arg is a static non-English string literal is a
    // violation candidate; every other test call is still a real call that a
    // marker may legitimately bind to (and thereby be consumed).
    const violation = !!arg && !arg.dynamic && isNonEnglishText(arg.value);
    calls.push({
      line: lineAt(starts, idStart), offset: idStart,
      label: arg ? arg.value : "", violation, exempt: false,
    });
  }

  // Consume model: each marker binds to EXACTLY ONE call and consumes it. A
  // trailing marker binds to the first not-yet-exempt call earlier on its own
  // line; a standalone marker binds to the first not-yet-exempt call on the
  // next line. The bound call is exempt whether or not it is a violation, so a
  // marker can never "spill over" onto a neighbour.
  for (const mk of markers) {
    const bound = mk.isTrailing
      ? calls.find((c) => !c.exempt && c.line === mk.line && c.offset < mk.offset)
      : calls.find((c) => !c.exempt && c.line === mk.line + 1);
    if (bound) bound.exempt = true;
  }

  for (const c of calls) {
    if (c.exempt) continue;
    if (c.violation) violations.push({ path, line: c.line, label: c.label });
    else if (c.label) latinLabels.push({ path, line: c.line, label: c.label });
  }
  return result;
}

/** Hook-facing wrapper — exact historical behavior (violations only). */
function scanFile(path, src) {
  return analyzeFile(path, src).violations;
}

// ---- staged I/O --------------------------------------------------------------
function gitShowStaged(path) {
  return execFileSync("git", ["show", `:0:${path}`], {
    cwd: REPO, encoding: "utf8", timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}
function stagedTestFiles() {
  // `-z` gives NUL-separated, UNQUOTED paths (default output C-quotes non-ASCII
  // paths like `中文.test.ts`, which would then fail isTestFile()); belt-and-
  // braces `core.quotepath=false` too. `--diff-filter=ACMRT` includes RENAMES so
  // a plain refactor `git mv helper.ts renamed.test.ts` still scans the target,
  // and TYPE-CHANGES so a symlink replaced by a real test file is scanned. With
  // `--name-only -z`, a rename emits ONLY its destination path (the name the
  // commit will carry), which is exactly what we want to scan.
  const out = execFileSync(
    "git",
    ["-c", "core.quotepath=false", "diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"],
    { cwd: REPO, encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  // Split on NUL and drop only the trailing empty field. Do NOT trim: a path
  // may legitimately start/end with whitespace, and altering it would break the
  // subsequent `git show :0:<path>` and fail-close a valid commit.
  return out.split("\0").filter(Boolean).filter(isTestFile);
}

function main() {
  let files;
  try {
    files = stagedTestFiles();
  } catch {
    // Cannot enumerate staged files (not a git repo / git broken). This is an
    // ADDITIVE content gate; overall git health is owned by the main fingerprint
    // gate. Failing closed HERE would wrongly block paths the main gate allows
    // (bypass, no-change). So defer: exit 0.
    process.exit(0);
  }
  if (files.length === 0) process.exit(0);

  const all = [];
  for (const f of files) {
    let src;
    try {
      src = gitShowStaged(f);
    } catch {
      console.error(`[review-gate] cannot read staged content of ${f} — failing closed.`);
      process.exit(1);
    }
    all.push(...scanFile(f, src));
  }

  if (all.length === 0) process.exit(0);

  console.error("[review-gate] non-English test label(s) found (L6):");
  for (const v of all) {
    console.error(`  ${v.path}:${v.line}: ${v.label.slice(0, 60)}`);
  }
  console.error("[review-gate] Test descriptions must be English. To allow a specific case, put");
  console.error("[review-gate]   // review-gate: allow-non-english");
  console.error("[review-gate] on the line above it, or add");
  console.error("[review-gate]   // review-gate: allow-non-english-file");
  console.error("[review-gate] within the first 5 lines to exempt the whole file.");
  process.exit(1);
}

// Run as a script (the pre-commit hook path); requiring as a module only
// exposes the analysis functions — zero behavior change for the hook.
if (require.main === module) main();

module.exports = { scanFile, analyzeFile, isTestFile, isNonEnglishText, testImportAliases };
