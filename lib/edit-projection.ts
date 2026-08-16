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
 * Input shapes handled:
 *  - pi's vanilla edit: `edits: [{oldText, newText}]` (and bare old/newText).
 *  - the hashline edit engine (pi-hashline-readmap REPLACES pi's edit tool,
 *    so this is what a real session sends): `set_line`, `replace_lines`,
 *    `insert_after`, each anchor-based (`{anchor, new_text}` …). An
 *    unrecognized hashline item is still folded in as raw text — scanning
 *    newText is strictly better than dropping it (fail-closed for the scan).
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

/** Copy of pi-hashline-readmap's HashlineEditItem variants (local, deduped). */
interface HashlineEditItem {
  set_line?: { anchor: string; new_text: string };
  replace_lines?: { start_anchor: string; end_anchor: string; new_text: string };
  insert_after?: { anchor: string; new_text?: string; text?: string };
}

/** Best-effort line reference → 1-based line number, or undefined. */
function lineRefToNumber(ref: string | undefined): number | undefined {
  if (!ref) return undefined;
  // `2:645` / `2:0` / bare `2`.
  const m = /^(\d+)(?::\d+)?$/.exec(ref.trim());
  return m ? Number(m[1]) : undefined;
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
 * Fold a hashline-format edit item into the projection (anchor-based, so the
 * oldText carrier of the vanilla format does not apply). Each shape carries
 * its `new_text` payload; the item is ALWAYS included so a label cannot dodge
 * the scan by spelling its edit in hashline form. A parseable line anchor
 * makes the projection accurate; an unparseable one degrades to an append,
 * which over-scans (safe) rather than dropping content.
 */
export function applyHashlineItem(
  projected: string,
  item: unknown,
): string {
  if (!item || typeof item !== "object") return projected;
  const hl = item as HashlineEditItem;
  const lines = projected.split("\n");
  const anchorNum = (ref: string | undefined) => lineRefToNumber(ref);
  if (hl.set_line && typeof hl.set_line.anchor === "string") {
    const n = anchorNum(hl.set_line.anchor);
    const newText = hl.set_line.new_text ?? "";
    if (n !== undefined && n >= 1 && n <= lines.length) {
      lines[n - 1] = newText;
      return lines.join("\n");
    }
    return projected + "\n" + newText;
  }
  if (hl.replace_lines && typeof hl.replace_lines.start_anchor === "string") {
    const start = anchorNum(hl.replace_lines.start_anchor);
    const end = anchorNum(hl.replace_lines.end_anchor);
    const newText = hl.replace_lines.new_text ?? "";
    if (start !== undefined && end !== undefined && start >= 1 && end >= start && end <= lines.length) {
      return [
        ...lines.slice(0, start - 1),
        newText,
        ...lines.slice(end),
      ].join("\n");
    }
    return projected + "\n" + newText;
  }
  if (hl.insert_after && typeof hl.insert_after.anchor === "string") {
    const n = anchorNum(hl.insert_after.anchor);
    const newText = hl.insert_after.new_text ?? hl.insert_after.text ?? "";
    if (newText) {
      if (n !== undefined && n >= 1 && n <= lines.length) {
        return [
          ...lines.slice(0, n),
          newText,
          ...lines.slice(n),
        ].join("\n");
      }
      return projected + "\n" + newText;
    }
  }
  return projected;
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
  // Hashline-form edits (pi-hashline-readmap replaces pi's edit tool with
  // anchor-based items): each item folds its new_text into the projection
  // directly. Pure add-ons — no oldText carrier, so they never "fail to
  // match" and drop content.
  if (Array.isArray(input.edits)) {
    const hasHashlineItem = input.edits.some(
      (e) => e && typeof e === "object" &&
        ((e as Record<string, unknown>).set_line ||
         (e as Record<string, unknown>).replace_lines ||
         (e as Record<string, unknown>).insert_after),
    );
    if (hasHashlineItem) {
      const base = readFile();
      let projected = base ?? "";
      for (const item of input.edits) {
        if (item && typeof item === "object" &&
            ((item as Record<string, unknown>).set_line ||
             (item as Record<string, unknown>).replace_lines ||
             (item as Record<string, unknown>).insert_after)) {
          projected = applyHashlineItem(projected, item);
        } else if (item && typeof item === "object" &&
                   typeof (item as Record<string, unknown>).newText === "string") {
          const f = item as EditFragment;
          if (f.oldText && projected.includes(f.oldText)) {
            projected = projected.replace(f.oldText, () => f.newText);
          } else {
            projected += "\n" + f.newText;
          }
        }
      }
      return projected;
    }
  }
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
