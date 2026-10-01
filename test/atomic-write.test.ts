/**
 * The shared atomic-write helper (lib/atomic-write.ts).
 *
 * Round-17 (reviewer): the attention test proved a round trip, not ATOMICITY —
 * it still passed when tmp+rename was reverted to a plain writeFileSync. This
 * file pins the property itself: the write goes through a temp sibling that is
 * consumed by the rename, so a concurrent reader never observes a partial file.
 * The stale-temp test is the falsifiable one — it is what fails when the
 * tmp+rename is reverted to an in-place write.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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

test("the temp sibling lives in the target directory and is consumed by the write", () => {
  // SCOPE (round-17 Nit, reviewer): this test pins the temp-name CONTRACT —
  // same directory (rename is only atomic within a filesystem) and nothing left
  // behind. It does NOT prove atomicity on its own and passes under a plain
  // writeFileSync; the stale-temp test below is what fails when the tmp+rename
  // is reverted.
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

test("the replacement keeps the target's permissions (a 0600 file stays 0600)", () => {
  // THE FAILURE THIS PINS (reviewer P1, 2026-10-01): the temp file is created at
  // the process umask (usually 0644), so an atomic replace used to WIDEN a
  // 0600 file — and a config holding an API key is exactly the file that must
  // not silently become readable to every user on the machine.
  const dir = scratch();
  const path = join(dir, "models.json");
  writeFileSync(path, "old", { mode: 0o600 });
  chmodSync(path, 0o600);
  writeFileAtomic(path, "new");
  assert.equal(readFileSync(path, "utf8"), "new");
  assert.equal(statSync(path).mode & 0o777, 0o600, "the swap must not widen the file");

  // …and a 0644 target stays 0644 (the rule is "keep", not "tighten everything").
  const loose = join(dir, "settings.json");
  writeFileSync(loose, "old", { mode: 0o644 });
  chmodSync(loose, 0o644);
  writeFileAtomic(loose, "new");
  assert.equal(statSync(loose).mode & 0o777, 0o644);
});

test("an explicit mode is ENFORCED — on a new file and on a looser one", () => {
  // The daemon's state / token / identity files must be 0600 even when they do
  // not exist yet ("keep the target's mode" has nothing to keep) and even when
  // an older build left them at the umask. This is the whole reason the second
  // hand-rolled writer could be deleted (quality round P2, 2026-10-01).
  const dir = scratch();
  const fresh = join(dir, "token");
  writeFileAtomic(fresh, "secret\n", { mode: 0o600 });
  assert.equal(statSync(fresh).mode & 0o777, 0o600, "a new file gets the enforced mode");

  const loose = join(dir, "state.json");
  writeFileSync(loose, "old", { mode: 0o644 });
  chmodSync(loose, 0o644);
  writeFileAtomic(loose, "new", { mode: 0o600 });
  assert.equal(statSync(loose).mode & 0o777, 0o600, "an explicit mode tightens, it does not preserve");
});

test("a crashed run's stale temp file is consumed, not left behind (THE atomicity pin)", () => {
  // This is the falsifiable one: reverting writeFileAtomic to an in-place
  // `writeFileSync(path, content)` leaves the pre-seeded temp file untouched,
  // so the directory listing gains a second entry and this test fails.
  const dir = scratch();
  const path = join(dir, "state.json");
  writeFileSync(tempPathFor(path), "leftover from a crashed run");
  writeFileAtomic(path, "fresh");
  assert.equal(readFileSync(path, "utf8"), "fresh");
  assert.deepEqual(readdirSync(dir), ["state.json"]);
});
