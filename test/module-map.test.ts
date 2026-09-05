/**
 * `docs/module-map.md` §5 claims to list EVERY module in `lib/`. That claim is
 * an assertion; until 2026-09-05 it was only a sentence asking people to
 * remember, and a table maintained that way does not decay evenly — it drifts
 * in ONE direction. Adding a module, you are already writing it, so the row
 * gets added; deleting one, you are in another file entirely and the table is
 * nowhere near you.
 *
 * BOTH directions, and the count, because they fail differently:
 *  - a row with no file  = a ghost (the map sends a reader to a module that is gone),
 *  - a file with no row  = an unlisted module (the map is not the map it claims to be),
 *  - a stale count       = the header lying about a table that is otherwise fine.
 * Counting alone is not enough: one ghost plus one missing row cancel out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAP = readFileSync(join(ROOT, "docs", "module-map.md"), "utf8");

/** The §5 table, delimited by its own headings — never by line numbers. */
function quickReferenceSection(): string {
  const start = MAP.indexOf("## 五、");
  assert.ok(start > 0, "§5 (the lib/ quick-reference table) must exist");
  const after = MAP.indexOf("\n## ", start + 1);
  assert.ok(after > start, "§5 must be closed by the next heading");
  return MAP.slice(start, after);
}

/** Every `lib/x.ts` named in the first column of that table. */
function modulesInTable(): string[] {
  const section = quickReferenceSection();
  const rows = [...section.matchAll(/^\| `([^`]+\.ts)` \|/gm)].map((m) => m[1]!);
  return rows;
}

function modulesOnDisk(): string[] {
  return readdirSync(join(ROOT, "lib"))
    .filter((f) => f.endsWith(".ts"))
    .sort();
}

test("the derivation itself works before its verdict means anything", () => {
  const section = quickReferenceSection();
  // The window must be the RIGHT section: it contains the table's own header
  // and a module everyone knows, and it must NOT have swallowed §6.
  assert.match(section, /\| 模块 \| 一句话职责 \|/, "§5 must contain the table header");
  assert.ok(modulesInTable().includes("hierarchy.ts"), "…and real rows");
  assert.doesNotMatch(section, /## 六、/, "…and must stop before §6");
  // A window that grabbed the whole document would also "contain" everything.
  assert.ok(section.length < MAP.length, "the section is not the whole file");
});

test("§5 lists exactly the modules in lib/ — both directions", () => {
  const table = modulesInTable();
  const disk = modulesOnDisk();
  const tableSet = new Set(table);
  const diskSet = new Set(disk);

  const ghosts = table.filter((m) => !diskSet.has(m));
  const unlisted = disk.filter((m) => !tableSet.has(m));
  assert.deepEqual(ghosts, [], "表里有、lib/ 里没有——幽灵行（模块已删除，行没删）");
  assert.deepEqual(unlisted, [], "lib/ 里有、表里没有——漏登（新增模块时忘了加一行）");

  // Duplicates would let the two diffs pass while the count is still wrong.
  assert.equal(tableSet.size, table.length, "一个模块只应有一行");
});

test("§5's header count matches the table it heads", () => {
  const heading = quickReferenceSection().split("\n")[0]!;
  const declared = Number(/（(\d+) 个模块）/.exec(heading)?.[1]);
  assert.ok(Number.isFinite(declared), `§5 heading must declare a count: ${heading}`);
  // The count is the field BOTH deleting commits forgot (it sits furthest from
  // the row being edited), so it is asserted separately from the diffs.
  assert.equal(declared, modulesInTable().length, "标题里的条目数与表里的行数不一致");
  assert.equal(declared, modulesOnDisk().length, "标题里的条目数与 lib/ 的模块数不一致");
});
