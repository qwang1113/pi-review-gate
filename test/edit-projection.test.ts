import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEditFragments, projectEditedContent } from "../lib/edit-projection.ts";

// ---------------------------------------------------------------------------
// extractEditFragments

test("extracts edits[] pairs and single oldText/newText inputs", () => {
  assert.deepEqual(
    extractEditFragments({ edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }] }),
    [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }],
  );
  assert.deepEqual(
    extractEditFragments({ oldText: "a", newText: "b" }),
    [{ oldText: "a", newText: "b" }],
  );
  // malformed entries are skipped, unknown shapes yield []
  assert.deepEqual(extractEditFragments({ edits: [{ newText: 42 }, null, "x"] }), []);
  assert.deepEqual(extractEditFragments({}), []);
});

// ---------------------------------------------------------------------------
// projectEditedContent

test("write input returns the full content verbatim", () => {
  assert.equal(
    projectEditedContent({ content: "it('x', f)" }, () => "ignored"),
    "it('x', f)",
  );
});

test("SECURITY: label-string-only edit still projects the surrounding test call (P1 bypass)", () => {
  // The reviewer's bypass: replacing ONLY the label string must not hide the
  // it(...) context from the lexer.
  const base = "it('old label', () => {});\n";
  const projected = projectEditedContent(
    { edits: [{ oldText: "'old label'", newText: "'ceshi denglu'" }] },
    () => base,
  );
  assert.equal(projected, "it('ceshi denglu', () => {});\n");
});

test("multiple disjoint edits are all applied", () => {
  const base = "it('one', a);\nit('two', b);\n";
  const projected = projectEditedContent(
    { edits: [
      { oldText: "'one'", newText: "'uno'" },
      { oldText: "'two'", newText: "'dos'" },
    ] },
    () => base,
  );
  assert.equal(projected, "it('uno', a);\nit('dos', b);\n");
});

test("unmatched oldText appends newText so the fragment stays scannable", () => {
  const base = "it('kept', a);\n";
  const projected = projectEditedContent(
    { edits: [{ oldText: "'not present'", newText: "it('ceshi', b);" }] },
    () => base,
  );
  assert.ok(projected.includes("it('kept', a);"));
  assert.ok(projected.includes("it('ceshi', b);"));
});

test("missing base file falls back to joined fragments (never hides content)", () => {
  const projected = projectEditedContent(
    { edits: [
      { oldText: "x", newText: "it('a', f);" },
      { oldText: "y", newText: "it('b', g);" },
    ] },
    () => undefined,
  );
  assert.equal(projected, "it('a', f);\nit('b', g);");
});

test("replacement is literal — regex/$-patterns in newText are not expanded", () => {
  const projected = projectEditedContent(
    { edits: [{ oldText: "X", newText: "$& $' $` $1" }] },
    () => "before X after",
  );
  assert.equal(projected, "before $& $' $` $1 after");
});

test("no content and no fragments yields empty string", () => {
  assert.equal(projectEditedContent({}, () => "base"), "");
});

// ---------------------------------------------------------------------------
// hashline edit format (pi-hashline-readmap replaces pi's edit tool with
// anchor-based items: set_line / replace_lines / insert_after). Regression:
// the edit-time L6 label check silently passed EVERY hashline edit because
// extractEditFragments only knew oldText/newText and the projection came back
// empty — a Chinese test label added via edit sailed through while the same
// label in a write was blocked.

test("hashline insert_after folds new_text into the projection after the anchor line", () => {
  const base = "it('one', a);\nit('two', b);\n";
  const projected = projectEditedContent(
    { edits: [{ insert_after: { anchor: "2:5", new_text: "it('三', c);" } }] },
    () => base,
  );
  assert.equal(projected, "it('one', a);\nit('two', b);\nit('三', c);\n");
});

test("hashline insert_after with bare line anchor works", () => {
  const base = "line1\nline2\n";
  const projected = projectEditedContent(
    { edits: [{ insert_after: { anchor: "1", new_text: "inserted" } }] },
    () => base,
  );
  assert.equal(projected, "line1\ninserted\nline2\n");
});

test("hashline set_line replaces the anchored line", () => {
  const base = "it('one', a);\nit('two', b);\n";
  const projected = projectEditedContent(
    { edits: [{ set_line: { anchor: "1:0", new_text: "it('一', a);" } }] },
    () => base,
  );
  assert.equal(projected, "it('一', a);\nit('two', b);\n");
});

test("hashline replace_lines replaces the anchored range", () => {
  const base = "a\nb\nc\nd\n";
  const projected = projectEditedContent(
    { edits: [{ replace_lines: { start_anchor: "2:0", end_anchor: "3:0", new_text: "B\nC" } }] },
    () => base,
  );
  assert.equal(projected, "a\nB\nC\nd\n");
});

test("hashline edit with an unparseable anchor still includes new_text (fail-closed)", () => {
  const base = "a\nb\n";
  const projected = projectEditedContent(
    { edits: [{ insert_after: { anchor: "zzz", new_text: "it('中文', c);" } }] },
    () => base,
  );
  assert.ok(projected.includes("it('中文', c);"), "new_text must be scannable even with a bad anchor");
});

test("hashline edits mix with oldText/newText entries in one call", () => {
  const base = "it('one', a);\n";
  const projected = projectEditedContent(
    { edits: [
      { oldText: "'one'", newText: "'uno'" },
      { insert_after: { anchor: "1:0", new_text: "it('two', b);" } },
    ] },
    () => base,
  );
  assert.ok(projected.includes("'uno'"), "oldText/newText fragment must apply");
  assert.ok(projected.includes("it('two', b);"), "hashline fragment must apply");
});
