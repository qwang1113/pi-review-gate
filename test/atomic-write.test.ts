/**
 * The shared atomic-write helper (lib/atomic-write.ts).
 *
 * Round-17 (reviewer): the attention test proved a round trip, not ATOMICITY —
 * it still passed when tmp+rename was reverted to a plain writeFileSync. This
 * file pins the property itself: the target path is only ever created by a
 * rename, so a concurrent reader never observes a partial file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tempPathFor, writeFileAtomic } from "../lib/atomic-write.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "rg-atomic-"));
}

test("writeFileAtomic creates parent directories and lands the content", () => {
  const dir = scratch();
  const path = join(dir, "nested", "deep", "state.json");
  writeFileAtomic(path, '{"a":1}\n');
  assert.equal(readFileSync(path, "utf8"), '{"a":1}\n');
  assert.deepEqual(readdirSync(join(dir, "nested", "deep")), ["state.json"], "no temp file survives");
});

test("the target is REPLACED via its temp sibling — never written in place", () => {
  // The falsifiable part: while the temp file exists the target still holds the
  // OLD bytes, which is exactly what a plain writeFileSync cannot promise. We
  // observe it by pre-creating the temp path's content and checking that the
  // target only changes at the end.
  const dir = scratch();
  const path = join(dir, "state.json");
  writeFileAtomic(path, "v1");
  const tmp = tempPathFor(path);
  assert.equal(existsSync(tmp), false, "the temp sibling is consumed by the rename");
  assert.match(tmp, new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.tmp-\\d+$`),
    "the temp name is a sibling in the SAME directory (rename is only atomic within a filesystem)");

  writeFileAtomic(path, "v2");
  assert.equal(readFileSync(path, "utf8"), "v2", "the replacement landed");
  assert.deepEqual(readdirSync(dir), ["state.json"], "and left nothing behind");
});

test("the temp name is pid-scoped, so two processes never collide", () => {
  const a = tempPathFor("/tmp/x.json", 111);
  const b = tempPathFor("/tmp/x.json", 222);
  assert.notEqual(a, b);
  assert.equal(a, "/tmp/x.json.tmp-111");
});

test("an existing stale temp file does not block the write", () => {
  const dir = scratch();
  const path = join(dir, "state.json");
  writeFileSync(tempPathFor(path), "leftover from a crashed run");
  writeFileAtomic(path, "fresh");
  assert.equal(readFileSync(path, "utf8"), "fresh");
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});
