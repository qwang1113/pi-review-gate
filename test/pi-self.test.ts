import { test, after } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isPiSelfPath, isPiSelfRoot } from "../lib/pi-self.ts";

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

test("~/.pi and everything under it is pi-self (the user's global pi config)", () => {
  assert.equal(isPiSelfPath(resolve(homedir(), ".pi")), true);
  assert.equal(isPiSelfPath(resolve(homedir(), ".pi", "agent", "settings.json")), true);
  assert.equal(isPiSelfPath(resolve(homedir(), ".pi", "agent", "extensions", "pi-review-gate", "review-gate.ts")), true,
    "the INSTALLED extension copy is config, not development");
  assert.equal(isPiSelfPath(resolve(homedir(), ".pi", "does-not-exist")), true,
    "path membership must not depend on the file existing");
});

test("the gate's OWN checkout is NOT pi-self — developing it runs the full loop", () => {
  // USER REQUIREMENT: pi-review-gate development is regular development and
  // must go through the full review loop; only pi's global config is exempt.
  assert.equal(isPiSelfRoot(ROOT), false, "the gate's own repo must NOT be pi-self");
  assert.equal(isPiSelfPath(ROOT), false, "the gate's own path must NOT be pi-self");
  assert.equal(isPiSelfPath(join(ROOT, "lib", "pi-self.ts")), false);
});

test("a checkout named pi-review-gate anywhere is NOT pi-self (name is irrelevant)", () => {
  const dir = makeDir(); // outside ~/.pi, outside the gate's own checkout
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-review-gate" }));
  assert.equal(isPiSelfRoot(dir), false, "the package name must not grant an exemption");
});

test("an unrelated package/repo is NOT pi-self", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-product" }));
  assert.equal(isPiSelfRoot(dir), false);
  assert.equal(isPiSelfPath(dir), false);
});

test("a per-project .pi install is NOT pi-self (project config, not global)", () => {
  const dir = makeDir(); // a product repo with its own .pi
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-product" }));
  assert.equal(isPiSelfPath(join(dir, ".pi", "review-gate.json")), false);
});
