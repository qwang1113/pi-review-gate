import { test } from "node:test";
import assert from "node:assert/strict";

import { lexSegmentTokens } from "../lib/shell-lex.ts";

test("splits on unquoted operators", () => {
  assert.deepEqual(lexSegmentTokens("a && b; c | d"), [["a"], ["b"], ["c"], ["d"]]);
});

test("does NOT split on quoted operators", () => {
  assert.deepEqual(lexSegmentTokens("printf 'a; b'"), [["printf", "a; b"]]);
});

test("does NOT split on a quoted real newline", () => {
  assert.deepEqual(lexSegmentTokens("printf 'a\nb'"), [["printf", "a\nb"]]);
});

test("dequotes intra-word quote splices", () => {
  assert.deepEqual(lexSegmentTokens('g"i"t commit'), [["git", "commit"]]);
  assert.deepEqual(lexSegmentTokens("gi't' push"), [["git", "push"]]);
});

test("resolves backslash escapes and line continuations", () => {
  assert.deepEqual(lexSegmentTokens("\\g\\i\\t status"), [["git", "status"]]);
  assert.deepEqual(lexSegmentTokens("git \\\ncommit"), [["git", "commit"]]);
});

test("strips unquoted comments", () => {
  assert.deepEqual(lexSegmentTokens("node runner.mjs # precommit-runner.mjs"), [["node", "runner.mjs"]]);
});

test("blanks command substitutions and here-doc bodies", () => {
  assert.deepEqual(lexSegmentTokens("printf x $(echo danger)"), [["printf", "x"]]);
  assert.deepEqual(lexSegmentTokens("cat <<EOF\ndanger cmd\nEOF"), [["cat"]]);
  assert.deepEqual(lexSegmentTokens("cat <<123\ndanger\n123"), [["cat"]]);
});

test("unterminated quote does not throw or hang", () => {
  assert.doesNotThrow(() => lexSegmentTokens('git "commit'));
});

test("empty / whitespace command → no segments", () => {
  assert.deepEqual(lexSegmentTokens(""), []);
  assert.deepEqual(lexSegmentTokens("   \n  "), []);
});
