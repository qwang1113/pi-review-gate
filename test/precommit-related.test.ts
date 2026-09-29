/**
 * The fast lane's related-test set for `node --test` (scripts/precommit-related.mjs,
 * 2026-09-29) and its wiring into the planner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { relatedNodeTests } from "../scripts/precommit-related.mjs";
import { parseTestScript, planFastTests } from "../scripts/precommit-plan.mjs";
import { git } from "./helpers/git.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-related-"));
  git(dir, ["init", "-q"]);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const GLOBS = ["test/**/*.test.ts"];

test("the reverse closure follows imports, requires and quoted basenames; unrelated tests stay out", () => {
  const dir = repo({
    "lib/a.ts": "export const a = 1;\n",
    "lib/b.ts": "import { a } from \"./a.ts\";\nexport const b = a;\n",
    "lib/c.ts": "export const c = 3;\n",
    "lib/types.ts": "export type T = number;\n",
    "test/scan.test.ts": "for (const f of readdirSync(join(ROOT, \"lib\"))) count(f);\n",
    "lib/uses-type.ts": "import type { T } from \"./types.ts\";\nexport const u: T = 1;\n",
    "test/uses-type.test.ts": "import { u } from \"../lib/uses-type.ts\";\n",
    "scripts/hook.cjs": "const s = require('path').join(__dirname, \"scan.cjs\");\n",
    "scripts/scan.cjs": "module.exports = {};\n",
    "test/b.test.ts": "import { b } from \"../lib/b.ts\";\n",
    "test/c.test.ts": "import { c } from \"../lib/c.ts\";\n",
    "test/struct.test.ts": "readFileSync(join(ROOT, \"lib\", \"a.ts\"));\n",
    "test/hook.test.ts": "spawnSync(\"node\", [join(ROOT, \"scripts\", \"hook.cjs\")]);\n",
  });
  try {
    const rel = (changed: string[]) => relatedNodeTests({ repoRoot: dir, cwd: dir, changedFiles: changed.map((f) => join(dir, f)), testGlobs: GLOBS });
    assert.deepEqual(rel(["lib/a.ts"]), { files: ["test/b.test.ts", "test/scan.test.ts", "test/struct.test.ts"], reason: "3 related test file(s) over 1 changed source(s)" },
      "transitive import + a structural test that reads the source + a tree-scanning test");
    assert.deepEqual((rel(["scripts/scan.cjs"]) as { files: string[] }).files, ["test/hook.test.ts", "test/scan.test.ts"],
      "a script loaded by a runtime path reaches the test that runs its loader");
    assert.deepEqual((rel(["test/c.test.ts"]) as { files: string[] }).files, ["test/c.test.ts", "test/scan.test.ts"], "a changed test runs itself");
    assert.deepEqual((rel(["lib/types.ts"]) as { files: string[] }).files, ["test/scan.test.ts"], "an `import type` is no runtime edge");
    assert.match((rel(["package.json"]) as { full: string }).full, /not a JS\/TS source/, "an untraceable change runs everything");
    assert.ok("full" in relatedNodeTests({ repoRoot: dir, cwd: dir, changedFiles: [join(dir, "lib/a.ts")], testGlobs: [] }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the planner narrows a node --test script through the injected resolver", () => {
  const body = `node --test --test-concurrency=6 "test/**/*.test.ts"`;
  const plan = (answer: { files: string[]; reason: string } | { full: string }) => planFastTests({
    parsed: parseTestScript(body),
    changedFiles: ["/r/lib/a.ts"],
    fullCommand: "npm run test",
    resolveBin: () => "node",
    relatedNodeTests: () => answer,
  });
  const narrowed = plan({ files: ["test/b.test.ts"], reason: "1" });
  assert.equal(narrowed.testScope, "related");
  assert.equal(narrowed.command, "node --test --test-concurrency=6 'test/b.test.ts'");
  assert.equal(plan({ files: [], reason: "0" }).command, null, "nothing related \u21d2 no test command");
  const full = plan({ full: "why" });
  assert.equal(full.testScope, "full");
  assert.equal(full.command, "npm run test");
});
