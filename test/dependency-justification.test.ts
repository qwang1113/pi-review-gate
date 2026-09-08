/**
 * DEPENDENCY JUSTIFICATION — the mechanical half of the minimalism doctrine.
 *
 * Two invariants the test pins, in the shape this repo's gate tests use:
 *
 *  1. THE GATE ACTUALLY READS BOTH INPUTS. `review_checkpoint` must compare
 *     the worktree manifest against a BASE (not just "package.json changed")
 *     AND must check the justification against the round note/message (not
 *     just "a dep was added"). A check that fires on every package.json
 *     touch, or that ignores the note, is a tripwire — not a justification
 *     gate. The wiring test below reads the extension source and proves both
 *     inputs are collected at the call site.
 *
 *  2. THE TWO PATHS. "With justification passes / without is refused" — the
 *     goal's acceptance criterion 6, asserted against the pure module (facts
 *     in, decisions out), so the verdict logic is pinned even when no repo
 *     is at hand.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dependencyJustificationVerdict,
  formatDependencyJustificationVerdict,
  dependencyKeysOf,
  newDependencyNames,
} from "../lib/dependency-justification.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The pure module: with justification passes, without is refused.
// ---------------------------------------------------------------------------

test("no new dependencies ⇒ empty verdict (most rounds never touch the manifest)", () => {
  const v = dependencyJustificationVerdict([], { note: "fix(auth): x", message: "fix(auth): x" });
  assert.deepEqual(v.blocking, []);
  assert.equal(formatDependencyJustificationVerdict(v), "");
});

test("new dep WITH justification passes (worth stays with the reviewer)", () => {
  const v = dependencyJustificationVerdict([{ name: "lodash" }], {
    note: "add lodash because the existing utils cannot cover deep-merge",
    message: "feat(checkpoint-util): add lodash",
  });
  assert.deepEqual(v.blocking, [], "a named dep with a why-word must pass the mechanical check");
});

test("new dep with a Chinese justification passes", () => {
  const v = dependencyJustificationVerdict([{ name: "uuid" }], {
    note: "新增 uuid，因为现有代码里没有可用的唯一 id 生成",
    message: "feat(checkpoint-id): use uuid",
  });
  assert.deepEqual(v.blocking, []);
});

test("new dep with NO mention at all is refused, and the refusal names the way out", () => {
  const v = dependencyJustificationVerdict([{ name: "lodash" }], {
    note: "fix(auth): handle expired tokens",
    message: "fix(checkpoint-auth): handle expired tokens",
  });
  assert.equal(v.blocking.length, 1);
  assert.match(v.blocking[0]!, /lodash/);
  assert.match(v.blocking[0]!, /送审说明或提交说明/);
  assert.match(formatDependencyJustificationVerdict(v), /新增依赖缺论证/);
});

test("new dep named but with NO why-word is refused (a bare mention is not a justification)", () => {
  const v = dependencyJustificationVerdict([{ name: "lodash" }], {
    note: "added lodash for utils",
    message: "feat(checkpoint-util): add lodash",
  });
  assert.equal(v.blocking.length, 1);
  assert.match(v.blocking[0]!, /只有点名/);
});

test("version bumps and removals are not new dependencies", () => {
  const base = JSON.stringify({ dependencies: { a: "1.0.0", b: "2.0.0" } });
  const bumped = JSON.stringify({ dependencies: { a: "1.1.0", b: "2.0.0" } });
  assert.deepEqual(newDependencyNames(bumped, base), []);
  const removed = JSON.stringify({ dependencies: { a: "1.0.0" } });
  assert.deepEqual(newDependencyNames(removed, base), []);
});

test("devDependencies do not count (test/build-only is the reviewer's call)", () => {
  const base = JSON.stringify({ dependencies: { a: "1.0.0" } });
  const worktree = JSON.stringify({ dependencies: { a: "1.0.0" }, devDependencies: { vitest: "1.0.0" } });
  assert.deepEqual(newDependencyNames(worktree, base), []);
});

test("an actually new key is reported", () => {
  const base = JSON.stringify({ dependencies: { a: "1.0.0" } });
  const worktree = JSON.stringify({ dependencies: { a: "1.0.0", lodash: "4.17.21" } });
  assert.deepEqual(newDependencyNames(worktree, base), ["lodash"]);
});

test("unreadable manifests yield no facts, never a block", () => {
  assert.deepEqual(newDependencyNames(undefined, "{}"), []);
  assert.deepEqual(newDependencyNames("not json", "{}"), []);
  assert.deepEqual(newDependencyNames("{}", undefined), []);
  assert.equal(dependencyKeysOf("not json"), undefined);
  assert.deepEqual(dependencyKeysOf("{}"), []);
});

test("a scoped dep is justified by naming either half", () => {
  const v = dependencyJustificationVerdict([{ name: "@uuid/v7" }], {
    note: "use uuid because 现有代码无法生成唯一 id",
    message: "feat(checkpoint-id): use uuid",
  });
  assert.deepEqual(v.blocking, []);
});

// ---------------------------------------------------------------------------
// The wiring: review_checkpoint must collect BOTH inputs — the manifest diff
// against a base, and the round note/message for the justification text.
// ---------------------------------------------------------------------------

test("review_checkpoint wires the dependency-justification gate (both inputs collected)", () => {
  const src = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");
  // The module is imported (not re-implemented at the call site).
  assert.match(src, /from "\.\.\/lib\/dependency-justification\.ts"/);
  assert.match(src, /dependencyJustificationVerdict/, "the verdict function must be called");
  // Input 1: the manifest diff against a BASE — a bare "package.json
  // changed" is not enough, or every version bump trips the gate.
  assert.match(src, /package\.json/, "the checkpoint must look at the manifest");
  // Input 2: the justification text comes from the round note/message — a
  // gate that ignores what the agent WROTE cannot be a justification gate.
  const callSite = src.indexOf("dependencyJustificationVerdict(");
  assert.ok(callSite > 0, "the call site must exist");
  const window = src.slice(Math.max(0, callSite - 3000), callSite + 1500);
  assert.match(window, /note|message/, "the verdict must be fed the round note/message text");
});
