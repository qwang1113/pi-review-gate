/**
 * `docs/module-map.md` §7 is the copy map: for a piece of doctrine that exists
 * in several places, it names WHICH test pins those copies together — so that
 * whoever edits one copy knows what else has to move and what will go red.
 *
 * That list is itself a copy of something (the test suite), and it is exactly
 * the kind of copy the section warns about: nothing forces it to stay true.
 * When a pinning test is renamed or deleted, the map keeps citing it and reads
 * as reassurance — the WORST failure mode here, because the map's whole job is
 * to tell you whether a copy is watched. §5 of the same document lived that
 * story already: it drifted in one direction until `test/module-map.test.ts`
 * made both directions mechanical (2026-09-05).
 *
 * So this file re-derives the citations from disk:
 *  - every test file the tables name must exist — whether or not that row also
 *    quotes a test name (7.2 cites files that pin behaviour, not documents),
 *  - every test NAME they quote must be a real `test("...")` in that file.
 *
 * WHAT IT DOES NOT CHECK, on purpose (the section says so too): whether the
 * pin actually covers the copies claimed, and whether the "no pin" rows are
 * still unpinned. Both are human judgement — a test that guessed at them
 * would be inventing a verdict, not deriving one. This guards the citations,
 * which is the part that rots mechanically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = readFileSync(join(ROOT, "docs", "module-map.md"), "utf8");

/** The §7 section, delimited by its own headings — never by line numbers. */
function copyMapSection(): string {
  const start = MAP.indexOf("## 七、");
  assert.ok(start > 0, "§7 (the copy map) must exist in docs/module-map.md");
  const after = MAP.indexOf("\n## ", start + 1);
  return after > start ? MAP.slice(start, after) : MAP.slice(start);
}

/**
 * Citations, in document order, read from the two TABLES only. §7 fixes the
 * format: a backticked test PATH, then one or more backticked "quoted names"
 * that belong to it, until the next path appears.
 *
 * TWO products, because a row may legitimately have only the first half: 7.2
 * cites files that pin BEHAVIOUR rather than any document, so they carry no
 * quoted name. Returning only (file, name) pairs silently dropped those rows
 * — three cited pin files were never checked at all, and deleting one left
 * the suite green while the map went on citing it (round-1 P1). `files` is
 * therefore every path the tables name, pairs or not.
 *
 * Table rows only, because the prose above them explains that format and any
 * example there would be parsed as a citation and demanded on disk (it was,
 * the first time this ran). A quoted name before any path is a format error,
 * not a silent skip — otherwise a mangled row would just stop being checked.
 */
function citations(): { files: string[]; pairs: { file: string; name: string }[] } {
  const section = copyMapSection()
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .join("\n");

  const files: string[] = [];
  const pairs: { file: string; name: string }[] = [];
  let current: string | undefined;
  const token = /`(test\/[A-Za-z0-9._-]+\.test\.ts)`|`"([^"]+)"`/g;
  for (const m of section.matchAll(token)) {
    if (m[1]) { current = m[1]; files.push(m[1]); continue; }
    assert.ok(current, `§7 quotes the test name "${m[2]}" before naming any test file`);
    pairs.push({ file: current!, name: m[2]! });
  }
  return { files: [...new Set(files)], pairs };
}


test("the derivation itself works before its verdict means anything", () => {
  const section = copyMapSection();
  // The window must be the RIGHT section: its own heading, its two tables, and
  // it must not have swallowed the sections around it.
  assert.match(section, /## 七、口径副本地图/, "§7 must be the copy-map section");
  assert.match(section, /### 7\.1 /, "…with the PINNED table");
  assert.match(section, /### 7\.2 /, "…and the UNPINNED table");
  assert.doesNotMatch(section, /## 六、/, "…and must start after §6");
  assert.ok(section.length < MAP.length, "the section is not the whole file");

  // A regex that matched nothing would make every assertion below vacuous.
  const { files, pairs } = citations();
  assert.ok(pairs.length >= 12, `§7 must cite real pins, found ${pairs.length}`);
  const named = new Set(pairs.map((c) => c.file));
  assert.ok(named.size >= 6, `pins must span several suites, found ${named.size}`);
  // The path-only rows must survive parsing — they are the ones that went
  // unchecked (round-1 P1), and both ways of losing them again land here:
  // dropping the path collection empties `files`, and dropping the rows
  // themselves shrinks it back to the named set. `>=` would have caught only
  // the first, since every named file comes FROM `files` (round-2 P2).
  assert.ok(
    files.length > named.size,
    `§7's tables cite ${files.length} test files but only ${named.size} carry a quoted test name. ` +
      "7.2 cites files that pin BEHAVIOUR and have no name to quote; if none parse, the parser " +
      "lost them. (If every row genuinely carries a name now, relax this — but check the parser first.)",
  );
  // And a sanity anchor: the pin everyone knows is in there.
  assert.ok(
    pairs.some((c) => c.file === "test/module-map.test.ts" && c.name.includes("both directions")),
    "§7 must cite the §5 double-difference pin",
  );
});

test("§7 cites only test files that exist", () => {
  // EVERY path the tables name — including 7.2's rows that cite a file without
  // quoting a test name. Those were the ones going unchecked (round-1 P1).
  for (const file of citations().files) {
    assert.ok(
      existsSync(join(ROOT, file)),
      `§7 of docs/module-map.md cites ${file}, which no longer exists — the copy map is pointing at a pin that is gone`,
    );
  }
});

test("§7 quotes only test names that are really declared in those files", () => {
  const cache = new Map<string, string>();
  for (const { file, name } of citations().pairs) {
    if (!cache.has(file)) cache.set(file, readFileSync(join(ROOT, file), "utf8"));
    const src = cache.get(file)!;
    // The literal as it is actually written: `test("<name>"`. Comparing against
    // the whole file would also match the name in a comment; this matches the
    // declaration, so a renamed test fails even if its old name lingers nearby.
    assert.ok(
      src.includes(`test("${name}"`),
      `§7 of docs/module-map.md says ${file} pins something with the test "${name}", but that file declares no such test — it was renamed or deleted, and the copy map is now reassuring a reader about a pin that is not there`,
    );
  }
});
