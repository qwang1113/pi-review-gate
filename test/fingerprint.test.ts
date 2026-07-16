import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const { computeFingerprint, changedFiles } = await import(
  join(resolve(import.meta.dirname ?? "."), "..", "lib", "fingerprint.ts")
);

const tempDirs: string[] = [];
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-fp-"));
  tempDirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], {
    cwd: dir, stdio: "ignore",
  });
  return dir;
}
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

test("clean repo fingerprint is stable", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  const b = computeFingerprint(dir);
  assert.equal(a.digest, b.digest);
  assert.equal(a.unavailable, false);
});

test("brand-new UNTRACKED file changes the fingerprint", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "new.ts"), "// new file");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("untracked file inside a new directory is seen", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  mkdirSync(join(dir, "deep", "nested"), { recursive: true });
  writeFileSync(join(dir, "deep", "nested", "lib.ts"), "// deep");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("staged edit changes fingerprint", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1");
  const a = computeFingerprint(dir);
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("unstaged edit changes fingerprint", () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "file.ts"), "// v1");
  execFileSync("git", ["add", "file.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add"], { cwd: dir, stdio: "ignore" });
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "file.ts"), "// v2");
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("HEAD move changes fingerprint", () => {
  const dir = makeRepo();
  const a = computeFingerprint(dir);
  writeFileSync(join(dir, "f.ts"), "//");
  execFileSync("git", ["add", "f.ts"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add"], { cwd: dir, stdio: "ignore" });
  const b = computeFingerprint(dir);
  assert.notEqual(a.digest, b.digest);
});

test("non-git directory → unavailable=true (fail closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-nogit-"));
  tempDirs.push(dir);
  const fp = computeFingerprint(dir);
  assert.equal(fp.unavailable, true);
});

test("changedFiles: clean repo → [], dirty repo lists paths", () => {
  const dir = makeRepo();
  assert.deepEqual(changedFiles(dir), []);
  writeFileSync(join(dir, "x.ts"), "//");
  writeFileSync(join(dir, "y.md"), "//");
  const files = changedFiles(dir);
  assert.ok(files!.includes("x.ts"));
  assert.ok(files!.includes("y.md"));
});
