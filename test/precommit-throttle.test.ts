// Load-adaptive test concurrency (goal ③, 2026-09-08): the throttle must be a
// pure two-state mechanism — an idle machine gets the command VERBATIM (the
// command is a cache key, so even one extra character would split the cache),
// a loaded machine gets --test-concurrency injected with the right value.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  testConcurrencyForLoad,
  throttleNodeTestCommand,
} from "../scripts/precommit-plan.mjs";

// --- idle state: byte-identical commands (the cache-key contract) ---

test("idle load returns null (no injection) for any core count", () => {
  assert.equal(testConcurrencyForLoad(0.5, 14), null);
  assert.equal(testConcurrencyForLoad(9.7, 14), null); // just under 14 * 0.7
  assert.equal(testConcurrencyForLoad(0.1, 1), null);
});

test("idle load leaves every command shape verbatim", () => {
  const direct = `node --test test/a.test.ts test/b.test.ts`;
  assert.equal(throttleNodeTestCommand(direct, 1, 14), direct);
  const npm = `npm run test`;
  assert.equal(throttleNodeTestCommand(npm, 1, 14), npm);
  const npmShort = `npm test`;
  assert.equal(throttleNodeTestCommand(npmShort, 1, 14), npmShort);
  const foreign = `yarn test`;
  assert.equal(throttleNodeTestCommand(foreign, 20, 14), foreign,
    "an unknown runner shape must never be mangled — missing a throttle is harmless");
});

// --- loaded state: injection with the right value and position ---

test("loaded load halves the worker pool (floor, minimum 1)", () => {
  assert.equal(testConcurrencyForLoad(20, 14), 7);   // 14 cores → 7
  assert.equal(testConcurrencyForLoad(20, 4), 2);    // 4 cores → 2
  assert.equal(testConcurrencyForLoad(20, 2), 1);    // 2 cores → 1
  assert.equal(testConcurrencyForLoad(20, 1), 1);    // 1 core → 1, never 0
});

test("a direct node --test command gets the flag right after --test", () => {
  const cmd = `node --test test/a.test.ts`;
  assert.equal(
    throttleNodeTestCommand(cmd, 20, 14),
    `node --test --test-concurrency=7 test/a.test.ts`,
  );
});

test("an npm-style script gets the flag via npm's `--` passthrough — only when the body runs node --test", () => {
  // npmOk attests the script body is node --test (the runner checks the
  // package.json body); without it the npm shape must NOT be mangled — a
  // `cat …` body would receive the flag as an argument of its own command.
  assert.equal(throttleNodeTestCommand(`npm run test`, 20, 14), `npm run test`,
    "no npmOk → npm scripts stay verbatim (their body may not be node --test)");
  assert.equal(
    throttleNodeTestCommand(`npm run test`, 20, 14, { npmOk: true }),
    `npm run test -- --test-concurrency=7`,
  );
  assert.equal(
    throttleNodeTestCommand(`npm test`, 20, 14, { npmOk: true }),
    `npm test -- --test-concurrency=7`,
  );
});

test("an already-throttled-looking flag is not double-injected", () => {
  // The regex anchors on `node --test` followed by a non-flag character, so a
  // command that somehow already carries --test-concurrency (a user's own
  // script) is left alone rather than gaining a second flag.
  const cmd = `node --test --test-concurrency=3 test/a.test.ts`;
  assert.equal(throttleNodeTestCommand(cmd, 20, 14), cmd);
});

test("non-finite inputs never inject (fail-safe)", () => {
  assert.equal(testConcurrencyForLoad(Number.NaN, 14), null);
  assert.equal(testConcurrencyForLoad(Infinity, 14), null);
  assert.equal(throttleNodeTestCommand(`npm test`, Number.NaN, 14), `npm test`);
});
