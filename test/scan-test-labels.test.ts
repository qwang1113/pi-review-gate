import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNER = join(ROOT, "scripts", "scan-test-labels.cjs");

const tempDirs: string[] = [];
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Fresh git repo with the given files, all staged. Returns the repo dir. */
function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-label-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function scan(dir: string) {
  return spawnSync("node", [SCANNER, dir], { cwd: dir, encoding: "utf8" });
}

test("English labels pass", () => {
  const dir = repoWith({
    "a.test.ts": "it('computes the sum', () => {});\ntest(\"handles empty input\", () => {});\ndescribe('the parser', () => {});\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("a non-English label with no bypass is blocked", () => {
  const dir = repoWith({ "b.test.ts": "it('返佣金额按 currencyRate 换算', () => {});\n" });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /b\.test\.ts:1:/);
  assert.match(r.stderr, /返佣金额/);
});

test("line-level marker on the line above exempts exactly that case", () => {
  const dir = repoWith({
    "c.test.ts": "// review-gate: allow-non-english\nit('被豁免的中文', () => {});\nit('没有豁免的中文', () => {});\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /c\.test\.ts:3:/);
  assert.doesNotMatch(r.stderr, /被豁免的中文/);
});

test("same-line trailing marker also exempts the case", () => {
  const dir = repoWith({
    "c2.test.ts": "it('中文同行豁免', () => {}); // review-gate: allow-non-english\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("file-level marker in first 5 lines exempts the whole file", () => {
  const dir = repoWith({
    "d.test.ts": "// review-gate: allow-non-english-file\nit('中文一', () => {});\nit('中文二', () => {});\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("the -file marker must not be matched by the plain line marker regex", () => {
  // A bare `allow-non-english-file` on the line above should behave as a FILE
  // marker (exempt all), not accidentally as a line marker for one case.
  const dir = repoWith({
    "d2.test.ts": "// review-gate: allow-non-english-file\nit('中文', () => {});\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("file marker BEYOND the first 5 lines does NOT exempt the file", () => {
  const dir = repoWith({
    "d3.test.ts": "//1\n//2\n//3\n//4\n//5\n// review-gate: allow-non-english-file\nit('第7行中文', () => {});\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /d3\.test\.ts:7:/);
});

test("a marker sitting INSIDE a string literal does NOT exempt anything", () => {
  const dir = repoWith({
    "d4.test.ts": "const marker = \"review-gate: allow-non-english-file\";\nit('应该被拦截的中文', () => {});\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /d4\.test\.ts:2:/);
});

test("a standalone line marker exempts ONLY the first call on the next line", () => {
  const dir = repoWith({
    "cm1.test.ts": "// review-gate: allow-non-english\nit('被豁免', () => {});\nit('未豁免', () => {});\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cm1\.test\.ts:3:/);
  assert.doesNotMatch(r.stderr, /被豁免/);
});

test("a trailing line marker exempts EXACTLY ONE call on its own line", () => {
  const dir = repoWith({
    "cm2.test.ts": "it('中文甲', () => {}); it('中文乙', () => {}); // review-gate: allow-non-english\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  // one of the two is exempted, exactly one remains flagged
  const flagged = (r.stderr.match(/cm2\.test\.ts:1:/g) || []).length;
  assert.equal(flagged, 1);
});

test("marker binds the FIRST test call on the target line, not the first non-English one", () => {
  // Standalone marker; next line is `it('english'); it('中文')`. The marker must
  // bind (and be consumed by) the English call, leaving the Chinese neighbour
  // flagged — a marker must never silently spill onto a neighbour.
  const dir = repoWith({
    "cm4.test.ts": "// review-gate: allow-non-english\nit('english', () => {}); it('中文邻居', () => {});\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /中文邻居/);
});

test("a block-comment /* */ marker is NOT honored (only // markers)", () => {
  const dir = repoWith({
    "cm3.test.ts": "/* review-gate: allow-non-english */\nit('块注释 marker 不豁免', () => {});\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cm3\.test\.ts:2:/);
});

test("an it(...) inside a regex literal is NOT a test call", () => {
  const dir = repoWith({
    "rx.test.ts": "const r = /it\\('正则中文'\\)/;\nvoid r;\nit('real english', () => {});\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("regex after `return` / control-flow `)` is masked, not treated as division", () => {
  const dir = repoWith({
    "rx2.test.ts":
      "function f(){ return /it('正则中文')/; }\n" +
      "if (ok) /it('控制流中文')/.test(s);\n" +
      "it('real english', () => {});\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("division that merely resembles a regex does NOT swallow a real test call", () => {
  // `x++ / it('中文', ...) / 2` is division, not a regex — the it() call inside
  // must still be detected (a regex misparse here would silently drop it).
  const dir = repoWith({
    "rx3.test.ts": "const y = x++ / it('除法中文', () => {}) / 2;\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /除法中文/);
});

test("a keyword used as a property name or identifier does NOT trigger regex masking", () => {
  // `obj.return` / `obj.await` are member accesses, `of` is an identifier here;
  // a following `/` is division, so the real test calls must still be found.
  const dir = repoWith({
    "kw.test.ts":
      "const a = of / it('of后中文', () => {}) / 2;\n" +
      "const b = obj.return / test('属性return后中文', () => {}) / 2;\n" +
      "const c = obj.await / describe('属性await后中文', () => {}) / 2;\n" +
      "const d = obj.if(ok) / it('方法名 if 后中文', () => {}) / 2;\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /of后中文/);
  assert.match(r.stderr, /属性return后中文/);
  assert.match(r.stderr, /属性await后中文/);
  assert.match(r.stderr, /方法名 if 后中文/);
});

test("Unicode identifiers/member names/private names don't cause a regex misread", () => {
  // Non-ASCII identifiers are valid JS; a `/` after them is division, so a real
  // test call must still be detected (not swallowed by a mis-inferred regex).
  const dir = repoWith({
    "uni.test.ts":
      "var 甲=4; const r1 = 甲 / it('甲后中文', () => {}) / 2;\n" +
      "const obj={返回:4}; const r2 = obj.返回 / it('返回属性后中文', () => {}) / 2;\n" +
      "class C { #甲=4; m(){ const z = this.#甲 / it('私有甲后中文', () => {}) / 2; return z; } }\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /甲后中文/);
  assert.match(r.stderr, /返回属性后中文/);
  assert.match(r.stderr, /私有甲后中文/);
});

test("Unicode escapes in string labels are decoded (\\uXXXX, \\u{...}, template)", () => {
  // Tool-generated code (JSON round-trips, i18n pipelines) writes non-ASCII as
  // \uXXXX; the runtime label IS Chinese, so the gate must decode and flag it.
  const dir = repoWith({
    "esc.test.ts":
      "it('\\u4e2d\\u6587', () => {});\n" +               // \u4e2d\u6587 -> 中文
      "test(\"\\u{4e2d}\\u{6587}\", () => {});\n" +      // \u{...} form
      "describe(`\\u4e2d\\u6587tpl`, () => {});\n",        // template literal
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  const flagged = (r.stderr.match(/esc\.test\.ts:\d+:/g) || []).length;
  assert.equal(flagged, 3);
});

test("escape decoding does not false-positive on English labels with escapes", () => {
  const dir = repoWith({
    "esc2.test.ts":
      "it('caf\\xe9 accent ok', () => {});\n" +             // \xe9 -> é (Latin)
      "it('\\ud83d\\ude00 emoji pair ok', () => {});\n" +  // surrogate pair -> emoji
      "it('tabs\\tnewlines\\n ok', () => {});\n" +
      "it('line\\\ncontinuation ok', () => {});\n",         // backslash-newline
  });
  assert.equal(scan(dir).status, 0);
});

test("invalid/boundary escapes are fail-safe: a real non-Latin char is not swallowed", () => {
  // Malformed escapes (short \u, unclosed \u{, out-of-range, short \x, trailing
  // backslash) must not crash and must not hide the trailing real Chinese char.
  const dir = repoWith({
    "esc3.test.ts":
      "it('\\u12中文', () => {});\n" +      // short \u then 中文
      "it('\\u{110000}中文', () => {});\n" +  // out-of-range code point then 中文
      "it('\\x中文', () => {});\n",           // short \x then 中文
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  const flagged = (r.stderr.match(/esc3\.test\.ts:\d+:/g) || []).length;
  assert.equal(flagged, 3);
});

test("astral (surrogate-pair) identifiers/private names don't cause a regex misread", () => {
  // U+1D400 MATHEMATICAL BOLD CAPITAL A is a valid astral ID_Start letter; the
  // lexer must read it as one code point so a following `/` is division and the
  // real it()/test() calls are not swallowed by a mis-inferred regex.
  const A = String.fromCodePoint(0x1d400);
  const dir = repoWith({
    "astral.test.ts":
      `var ${A}=4; const r1 = ${A} / it('astral标识符后中文', () => {}) / 2;\n` +
      `class C { #${A}=4; m(){ const z = this.#${A} / test('astral私有后中文', () => {}) / 2; return z; } }\n`,
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /astral标识符后中文/);
  assert.match(r.stderr, /astral私有后中文/);
});

test("an it/test/describe that is only a SUFFIX of a longer name is not a global call", () => {
  // ASCII `\b` in the head regex can't see a Unicode-letter boundary; `甲it(`,
  // `myit(`, and the private method `this.#it(` are all NOT global test calls.
  const dir = repoWith({
    "suffix.test.ts":
      "const 甲it = (s) => s; 甲it('后缀中文不应误报');\n" +
      "class C { #it(s){ return s; } m(){ return this.#it('私有方法中文不应误报'); } }\n" +
      "function myit(s){ return s; } myit('前缀中文不应误报');\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("a private member name (#return/#if) is not a keyword; following / is division", () => {
  const dir = repoWith({
    "priv.test.ts":
      "class C {\n  #return = 4;\n  #if() { return 4; }\n  m() {\n" +
      "    const x = this.#return / it('私有return后中文', () => {}) / 2;\n" +
      "    const y = this.#if() / it('私有if后中文', () => {}) / 2;\n" +
      "    return x + y;\n  }\n}\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /私有return后中文/);
  assert.match(r.stderr, /私有if后中文/);
});

test("real regex after `return`/`typeof` is still masked (no over-correction)", () => {
  const dir = repoWith({
    "kw2.test.ts": "function f(){ return /it('中文一')/; }\nconst x = typeof /it('中文二')/;\nit('genuine english', () => {});\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("division after `}` (object/function/class expr) does NOT swallow a real call", () => {
  // `}` is ambiguous; we fail-closed toward division so a real it()/test()/
  // describe() after a `}` is never hidden by a mis-inferred regex.
  const dir = repoWith({
    "rx4.test.ts":
      "const a = {} / it('对象字面量后中文', () => {}) / 2;\n" +
      "const b = function() {} / test('函数表达式后中文', () => {}) / 2;\n" +
      "const c = class {} / describe('类表达式后中文', () => {}) / 2;\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /对象字面量后中文/);
  assert.match(r.stderr, /函数表达式后中文/);
  assert.match(r.stderr, /类表达式后中文/);
});

test("a comment between `(` and the label is skipped; the label is still checked", () => {
  const dir = repoWith({ "lc.test.ts": "it(/*c*/'参数前注释中文', () => {});\n" });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lc\.test\.ts:1:/);
});

test("non-test filenames are ignored entirely", () => {
  const dir = repoWith({ "helpers.ts": "it('中文但不是测试文件', () => {});\n" });
  assert.equal(scan(dir).status, 0);
});

test("files under __tests__/ are scanned", () => {
  const dir = repoWith({ "__tests__/x.ts": "it('中文用例', () => {});\n" });
  assert.equal(scan(dir).status, 1);
});

test("method calls and embedded strings do NOT false-positive", () => {
  const dir = repoWith({
    "e.test.ts":
      "it('validates', () => { const s = '返佣金额'; expect(s).toBe('返佣金额'); });\n" +
      "re.test('中文');\n" +
      "foo.describe('中文方法调用');\n" +
      "obj.it('还是方法调用');\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("whitespace member access `foo . it(...)` / `re . test(...)` is NOT a test call", () => {
  const dir = repoWith({
    "e2.test.ts": "foo . it('方法中文带空格', () => {});\nre . test('正则中文');\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("a non-English label inside a // or /* comment is NOT flagged (lexer)", () => {
  const dir = repoWith({
    "e3.test.ts":
      "// it('注释中文', () => {});\n" +
      "/* it('块注释中文', () => {});\n   describe('跨行块注释中文') */\n" +
      "it('actual english', () => {});\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("a test call embedded inside a string literal is NOT flagged (lexer)", () => {
  const dir = repoWith({
    "e4.test.ts": "const src = \"it('字符串内嵌中文', () => {})\";\nvoid src;\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("interpolated template labels are skipped; plain backtick labels are checked", () => {
  const dir = repoWith({
    "f.test.ts": "it.only(`跑${name}参数化`, () => {});\nit(`纯反引号中文`, () => {});\n",
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /f\.test\.ts:2:/);
  assert.match(r.stderr, /纯反引号中文/);
});

test("a STATIC template with a literal $ (no interpolation) is still checked", () => {
  // `[^`$]*` used to skip any backtick label containing `$`; only real ${...}
  // interpolation should cause a skip.
  const dir = repoWith({ "f2.test.ts": "it(`price $100 中文`, () => {});\n" });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /price \$100 中文/);
});

test(".only/.skip modifier chains are still detected", () => {
  const dir = repoWith({ "g.test.ts": "describe.skip('跳过的中文块', () => {});\n" });
  assert.equal(scan(dir).status, 1);
});

test("Latin-with-diacritics and emoji labels pass (not flagged as non-English)", () => {
  const dir = repoWith({
    "h.test.ts": "it('café tests work 🎉', () => {});\ntest('naïve resumé', () => {});\n",
  });
  assert.equal(scan(dir).status, 0);
});

test("scans STAGED content, not the working tree", () => {
  const dir = repoWith({ "y.test.ts": "it('english staged', () => {});\n" });
  // Dirty the working tree with a Chinese label WITHOUT staging it.
  writeFileSync(join(dir, "y.test.ts"), "it('未暂存的中文', () => {});\n");
  const r = scan(dir);
  assert.equal(r.status, 0, "staged content is English; working-tree change must be ignored");
});

test("nothing staged → exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-label-empty-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  assert.equal(scan(dir).status, 0);
});

test("a staged test file with a NON-ASCII name is still scanned (git path quoting)", () => {
  // Default `git diff --name-only` C-quotes non-ASCII paths; the scanner must
  // use -z so `中文.test.ts` is recognized rather than silently skipped.
  const dir = repoWith({ "中文.test.ts": "it('中文标签', () => {});\n" });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /中文标签/);
});

test("a symlink REPLACED by a regular test file is scanned (diff-filter includes T)", () => {
  // Committed symlink link.test.ts → replaced by a real file with a non-English
  // label produces a staged type-change (T); it must be scanned, not skipped.
  const dir = mkdtempSync(join(tmpdir(), "rg-label-type-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "target.txt"), "target\n");
  execFileSync("git", ["-C", dir, "config", "core.symlinks", "true"], { stdio: "ignore" });
  symlinkSync("target.txt", join(dir, "link.test.ts"));
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir, stdio: "ignore" });
  unlinkSync(join(dir, "link.test.ts"));
  writeFileSync(join(dir, "link.test.ts"), "it('中文类型变更', () => {});\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /link\.test\.ts:1:/);
  assert.match(r.stderr, /中文类型变更/);
});

test("a staged path with leading/trailing/dir whitespace is read verbatim (no trim)", () => {
  // A path is NOT trimmed: `git show :0:<path>` must receive the exact bytes, so
  // legitimately space-padded paths (leading space, a trailing-space directory
  // segment) with ENGLISH labels pass cleanly (a trimming bug would mangle the
  // path and fail-close the commit).
  const dir = repoWith({
    " lead.test.ts": 'it("plain english ok", () => {});\n',
    "dir /trail.test.ts": 'it("another english label", () => {});\n',
  });
  const r = scan(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("a file RENAMED into a test-file name is scanned (diff-filter includes R)", () => {
  // Committing then `git mv helper.ts renamed.test.ts` produces a staged rename;
  // --diff-filter must include R so the destination path is scanned.
  const dir = mkdtempSync(join(tmpdir(), "rg-label-rename-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "helper.ts"), "it('重命名前中文', () => {});\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["mv", "helper.ts", "renamed.test.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /renamed\.test\.ts:1:/);
  assert.match(r.stderr, /重命名前中文/);
});

// The scanner's non-English detection must stay in sync with lib/lang-detect.ts.
// Guard against this repo's OWN test labels tripping the gate (236 English
// labels, 0 CJK — a regression here means we broke label extraction or the repo
// added a non-English label without a marker).
test("this repo's own staged test labels are all English (self-check)", () => {
  const r = spawnSync("node", [SCANNER, ROOT], { cwd: ROOT, encoding: "utf8" });
  // ROOT may have unrelated staged files in CI; we only assert no label
  // violation is reported for our own test/*.test.ts files.
  if (r.status === 1) {
    assert.doesNotMatch(r.stderr, /test\/.*\.test\.ts:/, `own test labels flagged:\n${r.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// Module exports (extension-side L6: analyzeFile / isTestFile / scanFile)

test("module export: require() does NOT run main (no argv side effects)", () => {
  // Requiring in a subprocess with no staged repo must exit 0 silently.
  const r = spawnSync("node", ["-e", `
    const m = require(${JSON.stringify(SCANNER)});
    if (typeof m.analyzeFile !== "function") process.exit(2);
    if (typeof m.scanFile !== "function") process.exit(3);
    if (typeof m.isTestFile !== "function") process.exit(4);
    if (typeof m.isNonEnglishText !== "function") process.exit(5);
  `], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("analyzeFile separates violations from latin labels honoring exemptions", () => {
  const r = spawnSync("node", ["-e", `
    const { analyzeFile } = require(${JSON.stringify(SCANNER)});
    const src = [
      "it('computes the sum', () => {});",
      "// review-gate: allow-non-english",
      "it('返佣金额', () => {});",
      "it('另一个中文', () => {});",
      "it('ceshi yonghu denglu', () => {});",
    ].join("\\n");
    const res = analyzeFile("x.test.ts", src);
    console.log(JSON.stringify(res));
  `], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  // exempted 返佣金额 is neither a violation nor a latin label
  assert.equal(res.violations.length, 1);
  assert.match(res.violations[0].label, /另一个中文/);
  // both pure-Latin labels (English + pinyin) surface for the LLM layer
  assert.deepEqual(res.latinLabels.map((l: { label: string }) => l.label),
    ["computes the sum", "ceshi yonghu denglu"]);
});

test("analyzeFile: file-level marker exempts latin labels from the LLM layer too", () => {
  const r = spawnSync("node", ["-e", `
    const { analyzeFile } = require(${JSON.stringify(SCANNER)});
    const src = "// review-gate: allow-non-english-file\\nit('ceshi denglu', () => {});\\nit('中文', () => {});";
    console.log(JSON.stringify(analyzeFile("x.test.ts", src)));
  `], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.violations.length, 0);
  assert.equal(res.latinLabels.length, 0);
});

test("hook behavior unchanged: scanFile still returns violations only", () => {
  const dir = repoWith({ "c.test.ts": "it('ceshi yonghu denglu', () => {});\n" });
  // pinyin passes the deterministic hook (Unicode check) — LLM layer is
  // extension-side only, so the zero-dependency hook stays permissive here.
  const r = scan(dir);
  assert.equal(r.status, 0, r.stderr);
});
