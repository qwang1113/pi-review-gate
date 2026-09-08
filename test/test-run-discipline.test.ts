/**
 * TEST-RUN DISCIPLINE nudge — recognition + wording (2026-09-08).
 *
 * Two invariants, in the shape this repo's discipline tests use:
 *
 *  1. RECOGNITION IS PURE AND TARGETED. Full-lane shapes (bare
 *     `npm test` / `node --test` over the whole tree / `tsc --noEmit`) are
 *     flagged; a targeted run (`node --test test/foo.test.ts`, `npm test --
 *     file`) is NOT — the nudge exists to push back toward the targeted
 *     path, and flagging the targeted path too would be noise.
 *
 *  2. WHO HEARS IT IS THE CALL SITE'S CALL. A full-suite run is legitimate
 *     from a judge pane (the reviewer verifies the reviewed commit in its
 *     throwaway worktree), from the user's own hands, and as a deliberate
 *     diagnostic — so the extension decides who gets the nudge
 *     (judge-side env ⇒ silent), and this module only recognises shapes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  looksLikeFullSuiteRun,
  looksLikeTypecheck,
  looksLikeFullLaneRun,
  FULL_LANE_NUDGE,
} from "../lib/test-run-discipline.ts";

test("full-suite runs are recognised", () => {
  for (const cmd of [
    "npm test",
    "npm run test",
    "yarn test",
    "pnpm test",
    "npm test 2>&1 | tail -15",
    "node --test $(find test -name '*.test.ts')",
    "node --test",
    "npm run test 2>&1 | tail",
  ]) {
    assert.equal(looksLikeFullSuiteRun(cmd), true, `full suite: ${cmd}`);
  }
});

test("targeted test runs are NOT flagged", () => {
  for (const cmd of [
    "node --test test/dependency-justification.test.ts",
    "node --test test/foo.test.ts 2>&1 | tail -5",
    "npm test -- test/foo.test.ts",
    "ls test/",
    "git log --oneline -3",
  ]) {
    assert.equal(looksLikeFullSuiteRun(cmd), false, `targeted: ${cmd}`);
  }
});

test("typecheck runs are recognised, targeted compiles are not", () => {
  for (const cmd of ["npx tsc --noEmit", "tsc --noEmit", "npm run typecheck", "yarn typecheck"]) {
    assert.equal(looksLikeTypecheck(cmd), true, `typecheck: ${cmd}`);
  }
  assert.equal(looksLikeTypecheck("tsc --noEmit test/foo.ts"), false, "single-file compile");
  assert.equal(looksLikeTypecheck("ls"), false);
});

test("$(find …) alone is NOT flagged — only a node --test $(find …) tree run (P2)", () => {
  assert.equal(looksLikeFullSuiteRun("git log -- $(find test -name '*.ts')"), false,
    "a read-only command substitution must not read as a full-suite run");
  assert.equal(looksLikeFullSuiteRun("rg foo $(find lib -name '*.ts')"), false);
  assert.equal(looksLikeFullSuiteRun("node --test $(find test -name '*.test.ts')"), true,
    "the actual full-tree run still is");
});

test("looksLikeFullLaneRun is the union", () => {
  assert.equal(looksLikeFullLaneRun("npm test"), true);
  assert.equal(looksLikeFullLaneRun("npx tsc --noEmit"), true);
  assert.equal(looksLikeFullLaneRun("node --test test/foo.test.ts"), false);
});

test("the nudge names the cheaper path and why the lane is not the agent's job", () => {
  assert.match(FULL_LANE_NUDGE, /judge_submit/, "it points at the submission chain");
  assert.match(FULL_LANE_NUDGE, /full precommit/, "…which runs the full lane itself");
  assert.match(FULL_LANE_NUDGE, /缓存/, "…with input caching");
  assert.match(FULL_LANE_NUDGE, /node --test test\//, "it names the targeted alternative");
  assert.ok(!FULL_LANE_NUDGE.includes("BLOCKED"), "a nudge never threatens");
});
