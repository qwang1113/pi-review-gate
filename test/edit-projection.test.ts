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
