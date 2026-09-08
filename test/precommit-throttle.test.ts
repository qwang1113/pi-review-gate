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

test("loaded load halves the worker pool (floor 2, never below)", () => {
  assert.equal(testConcurrencyForLoad(20, 14), 7);   // 14 cores → 7
  assert.equal(testConcurrencyForLoad(20, 4), 2);    // 4 cores → 2
  assert.equal(testConcurrencyForLoad(20, 2), 2);    // 2 cores → 2 (contracted floor)
  assert.equal(testConcurrencyForLoad(20, 3), 2);    // 3 cores → 2
  assert.equal(testConcurrencyForLoad(20, 1), null,  // 1 core: no useful throttle
    "a single core cannot host two workers — left unthrottled");
});

test("a direct node --test command gets the flag right after --test", () => {
  const cmd = `node --test test/a.test.ts`;
  assert.equal(
    throttleNodeTestCommand(cmd, 20, 14),
    `node --test --test-concurrency=7 test/a.test.ts`,
  );
});

test("an npm-style script is throttled by EXPANDING its node --test body (trailing flags are ignored by node)", () => {
  // node silently ignores --test-concurrency AFTER positional files
  // (measured: a 3×800ms suite stayed concurrent with the flag appended), so
  // the npm shape must become the body with the flag BEFORE the files.
  const body = `node --test $(find test -name '*.test.ts')`;
  assert.equal(
    throttleNodeTestCommand(`npm run test`, 20, 14, { npmOk: true, npmBody: body }),
    `node --test --test-concurrency=7 $(find test -name '*.test.ts') # npm run test (expanded by the load throttle)`,
    "the throttled npm run becomes its body with the flag inserted after --test"
  );
  // Without npmOk (non-node body) the npm shape stays verbatim.
  assert.equal(throttleNodeTestCommand(`npm run test`, 20, 14), `npm run test`);
  // With npmOk but no body to expand, nothing changes either.
  assert.equal(throttleNodeTestCommand(`npm run test`, 20, 14, { npmOk: true }), `npm run test`);
  // Idle load: the npm shape never expands (byte-identical, cache-key rule).
  assert.equal(throttleNodeTestCommand(`npm run test`, 1, 14, { npmOk: true, npmBody: body }), `npm run test`);
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
