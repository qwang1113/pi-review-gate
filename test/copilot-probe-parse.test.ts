/**
 * The two pure helpers of lib/copilot-probe-parse.ts that no other suite
 * reaches directly: the stderr line a gh failure is reported by, and the owner
 * half of a slug the availability allow-list matches on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { asRecord, firstErrorLine, ownerOfSlug } from "../lib/copilot-probe-parse.ts";

test("firstErrorLine reports gh's first real stderr line, capped, else the fallback", () => {
  assert.equal(firstErrorLine("\n  \nno pull requests found\nsecond\n", "fb"), "no pull requests found");
  assert.equal(firstErrorLine("  \r\n\t\n", "fb"), "fb", "blank stderr falls back");
  assert.equal(firstErrorLine("x".repeat(300), "fb").length, 200, "a runaway line is capped");
});

test("ownerOfSlug lowercases the owner and refuses what it cannot read", () => {
  assert.equal(ownerOfSlug("OneKeyHQ/app"), "onekeyhq");
  assert.equal(ownerOfSlug(" /app"), null, "an empty owner is not an owner");
  assert.equal(ownerOfSlug(null), null);
  assert.equal(ownerOfSlug(undefined), null);
});

test("asRecord accepts plain objects only", () => {
  assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
  assert.equal(asRecord([1]), undefined);
  assert.equal(asRecord(null), undefined);
  assert.equal(asRecord("x"), undefined);
});
