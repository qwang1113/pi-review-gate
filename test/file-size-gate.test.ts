import test from "node:test";
import assert from "node:assert/strict";

import {
  EXISTING_FILE_SOFT_LIMIT,
  NEW_FILE_HARD_LIMIT,
  fileSizeVerdict,
  formatFileSizeVerdict,
  isSizeJudgedFile,
} from "../lib/file-size-gate.ts";

test("only files whose LENGTH says something about module design are judged", () => {
  for (const path of ["lib/a.ts", "src/app.tsx", "scripts/x.mjs", "server/main.go", "a/b/c.py"]) {
    assert.equal(isSizeJudgedFile(path), true, `${path} is source`);
  }
  for (const path of [
    "docs/task-book.md",          // a task book has every right to be long
    "package-lock.json",
    "test/fixtures/data.json",
    "lib/types.d.ts",             // generated declarations
    "dist/bundle.js",
    "node_modules/x/index.js",
    "vendor/lib/thing.ts",
    "web/app.min.js",
    "Makefile",
  ]) {
    assert.equal(isSizeJudgedFile(path), false, `${path} must be exempt`);
  }
});

test("THE ASYMMETRY: a new oversized file BLOCKS, an existing one only reminds", () => {
  const verdict = fileSizeVerdict([
    { path: "lib/huge-new.ts", lines: NEW_FILE_HARD_LIMIT + 1, isNew: true },
    { path: "extensions/review-gate.ts", lines: 8659, isNew: false, addedLines: 120 },
  ]);
  assert.equal(verdict.blocking.length, 1, "the new file is one decision, made right now — refusing it is cheap");
  assert.match(verdict.blocking[0]!, /lib\/huge-new\.ts/);
  assert.match(verdict.blocking[0]!, new RegExp(String(NEW_FILE_HARD_LIMIT)));
  assert.match(verdict.blocking[0]!, /拆成几个模块/, "the useful response is a split, not smaller functions");

  assert.equal(verdict.advisory.length, 1,
    "8659 lines accumulated a hundred at a time; blocking here punishes the wrong commit");
  assert.match(verdict.advisory[0]!, /本次 \+120/);
  assert.doesNotMatch(verdict.advisory[0]!, /rejected|拒绝/);
});

test("the limits are boundaries, not ranges", () => {
  assert.deepEqual(
    fileSizeVerdict([{ path: "lib/a.ts", lines: NEW_FILE_HARD_LIMIT, isNew: true }]).blocking,
    [],
    "exactly at the limit is allowed",
  );
  assert.equal(
    fileSizeVerdict([{ path: "lib/a.ts", lines: NEW_FILE_HARD_LIMIT + 1, isNew: true }]).blocking.length,
    1,
  );
  assert.deepEqual(
    fileSizeVerdict([{ path: "lib/a.ts", lines: EXISTING_FILE_SOFT_LIMIT, isNew: false }]).advisory,
    [],
  );
  assert.equal(
    fileSizeVerdict([{ path: "lib/a.ts", lines: EXISTING_FILE_SOFT_LIMIT + 1, isNew: false }]).advisory.length,
    1,
  );
});

test("an ordinary change says nothing at all", () => {
  const verdict = fileSizeVerdict([
    { path: "lib/small.ts", lines: 120, isNew: true },
    { path: "lib/other.ts", lines: 300, isNew: false, addedLines: 12 },
    { path: "docs/notes.md", lines: 5000, isNew: true },
  ]);
  assert.deepEqual(verdict, { blocking: [], advisory: [] });
  assert.equal(formatFileSizeVerdict(verdict), "", "silence is the normal outcome");
});

test("the rendering separates what blocks from what merely reminds", () => {
  const text = formatFileSizeVerdict(fileSizeVerdict([
    { path: "lib/new.ts", lines: 900, isNew: true },
    { path: "lib/old.ts", lines: 700, isNew: false },
  ]));
  assert.match(text, /文件规模硬拦/);
  assert.match(text, /文件规模提醒/);
  assert.ok(text.indexOf("硬拦") < text.indexOf("提醒"), "the blocker comes first — it is what stops the commit");
});

test("this round's own modules would pass the rule they introduce", () => {
  // Self-consistency: a rule the repository breaks on the very commit that
  // adds it is a rule nobody will respect.
  const facts = [
    "lib/orchestration-id.ts", "lib/orchestrator-boundaries.ts", "lib/orchestrator-plan.ts",
    "lib/orchestrator-tmux.ts", "lib/orchestrator-guard.ts", "lib/orchestrator-notify.ts",
    "lib/orchestrator-registry.ts", "lib/orchestrator-gate.ts", "lib/orchestrator-relay.ts",
    "lib/orchestrator-wait.ts", "lib/orchestrator-tools.ts", "lib/orchestrator-session-tools.ts",
    "lib/orchestrator-wiring.ts", "lib/orchestrator-deps.ts", "lib/orchestrator-tool-kit.ts",
    "lib/orchestrator-directives.ts", "lib/file-size-gate.ts",
  ].map((path) => ({ path, lines: NEW_FILE_HARD_LIMIT, isNew: true }));
  assert.deepEqual(fileSizeVerdict(facts).blocking, []);
});
