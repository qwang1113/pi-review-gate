import { test, after } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isPiSelfPath, isPiSelfRoot, GATE_PACKAGE_NAME } from "../lib/pi-self.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-pi-self-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

test("the gate's own checkout is pi-self (repo root, by path and by name)", () => {
  assert.equal(isPiSelfRoot(ROOT), true, "the gate's own repo must be pi-self");
  assert.equal(isPiSelfPath(ROOT), true, "the gate's own path must be pi-self");
  assert.equal(isPiSelfPath(join(ROOT, "lib", "pi-self.ts")), true, "files inside it too");
});

test("~/.pi and everything under it is pi-self", () => {
  assert.equal(isPiSelfPath(resolve(homedir(), ".pi")), true);
  assert.equal(isPiSelfPath(resolve(homedir(), ".pi", "agent", "settings.json")), true);
  assert.equal(isPiSelfPath(resolve(homedir(), ".pi", "does-not-exist")), true,
    "path membership must not depend on the file existing");
});

test("an unrelated package/repo is NOT pi-self", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-product" }));
  assert.equal(isPiSelfRoot(dir), false);
  assert.equal(isPiSelfPath(dir), false);
});

test("a checkout named pi-review-gate anywhere is pi-self (name check)", () => {
  const dir = makeDir(); // outside ~/.pi, outside the gate's own checkout
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: GATE_PACKAGE_NAME }));
  assert.equal(isPiSelfRoot(dir), true);
});

test("GATE_PACKAGE_NAME is the stable package identity", () => {
  assert.equal(GATE_PACKAGE_NAME, "pi-review-gate");
});
