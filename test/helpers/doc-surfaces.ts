/**
 * READING THE SURFACES A PIECE OF DOCTRINE IS COPIED ONTO — with the scan
 * proving, first, that it really saw them.
 *
 * `docs/module-map.md` §7 is the map of those copies, and §7.2 is its list of
 * the ones NO test watches: an orchestrator tool inventory hand-written in
 * five places, a child-state enumeration in four, a hard limit whose number is
 * typed out beside the constant that defines it. Each of them goes stale
 * silently — the 2026-09-17 sweep found a README that still said "seven
 * states" for a union of eight, and a design doc naming three tools that were
 * deleted a month earlier.
 *
 * Converging a copy means the same three moves every time (the shape
 * `lib/review-carryover.ts` established): ONE authority, summaries that point
 * at it, and a test that re-derives the claim from disk. This helper owns the
 * boring half of that test — locating the surfaces and refusing to let a scan
 * conclude anything before it has proved it read them.
 *
 * WHY THE ANCHOR IS MANDATORY. A scan that reads a file which no longer
 * discusses the doctrine at all passes vacuously, and a vacuous pass is worse
 * than no pin: the copy map would go on citing a test that checks nothing.
 * So every surface is declared with the anchor that proves the doctrine is
 * still discussed there, and a missing anchor fails the test rather than
 * silently narrowing the scan.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** One place a piece of doctrine is written down. */
export interface Surface {
  /** Repo-relative path. */
  path: string;
  /**
   * Proof that this file still discusses the doctrine. A string is a literal
   * substring; a RegExp is matched against the whole file.
   */
  anchor: string | RegExp;
}

/** A surface, read — with its text, once its anchor has been proved. */
export interface ReadSurface extends Surface {
  text: string;
}

/**
 * Read every surface, PROVING first that each exists and still carries its
 * anchor. Any failure is the test's failure: the caller's verdict is only
 * worth something if the window it looked through was the right one.
 */
export function readSurfaces(surfaces: readonly Surface[]): ReadSurface[] {
  assert.ok(surfaces.length > 0, "a doctrine scan with no surfaces proves nothing");
  return surfaces.map((surface) => {
    const abs = join(ROOT, surface.path);
    assert.ok(
      existsSync(abs),
      `the doctrine scan claims ${surface.path} carries a copy, but that file does not exist — ` +
        "either the surface moved (update the scan) or the copy is gone (drop the row)",
    );
    const text = readFileSync(abs, "utf8");
    const found = typeof surface.anchor === "string"
      ? text.includes(surface.anchor)
      : surface.anchor.test(text);
    assert.ok(
      found,
      `${surface.path} no longer contains ${String(surface.anchor)} — the scan would have read it ` +
        "and concluded nothing. Fix the anchor if the section was rewritten; drop the surface if " +
        "the copy is genuinely gone.",
    );
    return { ...surface, text };
  });
}

/**
 * Every file that could carry a SECOND copy of a doctrine written in code:
 * `lib/`, the extension, the standalone scripts and the hooks.
 *
 * Tests are excluded on purpose — a test that quotes a sentence in order to
 * assert it is not a copy that can go stale, it is the thing that catches one.
 */
export function codeSurfaces(): string[] {
  const out: string[] = [];
  const dirs: Array<[string, RegExp]> = [
    ["lib", /\.ts$/],
    ["extensions", /\.ts$/],
    ["scripts", /\.(mjs|cjs|sh)$/],
    ["hooks", /^[a-z-]+$/],
  ];
  for (const [dir, pattern] of dirs) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (pattern.test(name)) out.push(`${dir}/${name}`);
    }
  }
  return out.sort();
}

/**
 * The prose surfaces a doctrine gets copied onto: the two agent-facing files,
 * the user-facing ones, the living design docs and the shipped skill.
 *
 * `docs/rounds/` is deliberately absent — it is a historical record of what
 * was true in a given round, and rewriting history to match today would
 * destroy the only evidence of what actually happened.
 */
export function proseSurfaces(): string[] {
  const out = ["AGENTS.md", "README.md", "QUICKSTART.md", "skills/review-loop/SKILL.md"];
  for (const name of readdirSync(join(ROOT, "docs"))) {
    if (name.endsWith(".md")) out.push(`docs/${name}`);
  }
  return out.filter((rel) => existsSync(join(ROOT, rel))).sort();
}

/** Read a repo-relative file. */
export function readRepoFile(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * The paragraph a match sits in (blank-line delimited), which is the unit a
 * removal marker has to be read at: a doc that spends a paragraph explaining
 * what was deleted names the dead tool on one line and says "已整体删除" two
 * lines later, and judging the line alone would call that a stale copy.
 */
export function paragraphAround(text: string, index: number): string {
  const before = text.lastIndexOf("\n\n", index);
  const after = text.indexOf("\n\n", index);
  return text.slice(before === -1 ? 0 : before + 2, after === -1 ? text.length : after);
}
