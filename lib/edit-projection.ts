/**
 * Project the FULL post-edit file content from an edit/write tool input.
 *
 * Why full-file projection matters (review P1): scanning only newText
 * fragments lets an edit that replaces just a label STRING
 * (`'old label'` → `'ceshi denglu'`) hide the surrounding `it(...)` call from
 * the test-label lexer — a permanent fail-open for romanized non-English
 * labels (the deterministic git hook cannot catch those either). Projecting
 * the whole file restores the lexer's context.
 *
 * Fallback semantics (fail-closed for the scan): when the base file cannot be
 * read, or an oldText does not match, the fragments are still included in the
 * returned text so their labels cannot dodge the scan. Over-scanning at worst
 * over-blocks one edit; it never hides content.
 *
 * Pure: the file read is injected, so tests need no real filesystem.
 */

export interface EditFragment {
  oldText: string;
  newText: string;
}

/** Extract oldText/newText pairs from the tool-input shapes we know. */
export function extractEditFragments(input: Record<string, unknown>): EditFragment[] {
  const fragments: EditFragment[] = [];
  if (Array.isArray(input.edits)) {
    for (const e of input.edits) {
      if (e && typeof e === "object" &&
          typeof (e as Record<string, unknown>).newText === "string" &&
          typeof (e as Record<string, unknown>).oldText === "string") {
        fragments.push({
          oldText: (e as Record<string, unknown>).oldText as string,
          newText: (e as Record<string, unknown>).newText as string,
        });
      }
    }
  } else if (typeof input.newText === "string") {
    fragments.push({
      oldText: typeof input.oldText === "string" ? input.oldText : "",
      newText: input.newText,
    });
  }
  return fragments;
}

/**
 * Full projected post-edit content.
 *  - `write` (input.content) → the new file verbatim.
 *  - `edit` → base file with every oldText→newText applied (first match, the
 *    edit tool's own semantics; edits are disjoint by contract). An unmatched
 *    oldText appends its newText instead — the real edit would fail, but the
 *    fragment stays scannable.
 *  - No base file → fragments joined (a real edit would fail anyway; fragments
 *    over-block at worst).
 * Returns "" when the input carries no content at all.
 */
export function projectEditedContent(
  input: Record<string, unknown>,
  readFile: () => string | undefined,
): string {
  if (typeof input.content === "string") return input.content;
  const fragments = extractEditFragments(input);
  if (fragments.length === 0) return "";
  const base = readFile();
  if (base === undefined) return fragments.map((f) => f.newText).join("\n");
  let projected = base;
  for (const f of fragments) {
    if (f.oldText && projected.includes(f.oldText)) {
      projected = projected.replace(f.oldText, () => f.newText);
    } else {
      projected += "\n" + f.newText;
    }
  }
  return projected;
}
