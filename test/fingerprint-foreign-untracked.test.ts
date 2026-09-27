// D20 — untracked files this session never wrote stay out of the digest, in
// BOTH implementations (lib/fingerprint.ts and scripts/compute-fingerprint.cjs).
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { neutraliseHostGitConfig } from "./helpers/git.ts";
import { neutraliseGateEnv } from "./helpers/gate-env.ts";
import { computeFingerprint, sessionOwnedPaths, worktreeTreeOid } from "../lib/fingerprint.ts";

neutraliseHostGitConfig();
neutraliseGateEnv();
const cjs = createRequire(import.meta.url)(
  join(resolve(import.meta.dirname ?? "."), "..", "scripts", "compute-fingerprint.cjs"),
);

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// Tests below set a variant themselves; start each from none.
beforeEach(() => { delete process.env.RG_STATE_VARIANT; });

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-fp-foreign-"));
  dirs.push(dir);
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  g("add", "-A");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init");
  return dir;
}

function sidecar(dir: string, files: string[] | undefined, variant?: string): void {
  mkdirSync(join(dir, ".pi"), { recursive: true });
  const name = variant ? `review-gate-state.${variant}.json` : "review-gate-state.json";
  writeFileSync(join(dir, ".pi", name), JSON.stringify(files === undefined ? {} : { sessionEditedFiles: files }));
}

const tree = (dir: string) => worktreeTreeOid(dir);

test("a foreign untracked file does not move the tree", () => {
  const dir = repo();
  sidecar(dir, []);
  const before = tree(dir);
  writeFileSync(join(dir, "notes.md"), "pm notes\n");
  writeFileSync(join(dir, "yarn.lock"), "# generated\n");
  assert.equal(tree(dir), before);
});

test("an untracked file THIS session wrote still moves the tree", () => {
  const dir = repo();
  sidecar(dir, ["new.ts"]);
  const before = tree(dir);
  writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
  assert.notEqual(tree(dir), before);
});

test("a foreign file counts once it is staged", () => {
  const dir = repo();
  sidecar(dir, []);
  const before = tree(dir);
  writeFileSync(join(dir, "notes.md"), "pm notes\n");
  execFileSync("git", ["add", "notes.md"], { cwd: dir });
  assert.notEqual(tree(dir), before);
});

test("no readable sidecar ⇒ nothing is excluded (missing or corrupt)", () => {
  const dir = repo();
  const before = tree(dir);
  writeFileSync(join(dir, "notes.md"), "pm notes\n");
  assert.notEqual(tree(dir), before, "missing sidecar");
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, ".pi", "review-gate-state.json"), "{ not json");
  assert.notEqual(tree(dir), before, "corrupt sidecar");
  assert.equal(sessionOwnedPaths(dir), undefined);
});

test("the sidecar variant decides whose list is read", () => {
  const dir = repo();
  sidecar(dir, ["new.ts"], "child-1");
  sidecar(dir, []);
  writeFileSync(join(dir, "new.ts"), "export const n = 1;\n");
  const withoutVariant = tree(dir);
  process.env.RG_STATE_VARIANT = "child-1";
  assert.deepEqual(sessionOwnedPaths(dir), ["new.ts"]);
  assert.notEqual(tree(dir), withoutVariant);
});

test("computed from a subdirectory, paths are still repo-root-relative", () => {
  const dir = repo();
  mkdirSync(join(dir, "sub"));
  sidecar(dir, ["sub/own.ts"]);
  const before = tree(dir);
  writeFileSync(join(dir, "sub", "foreign.md"), "x\n");
  assert.equal(tree(join(dir, "sub")), before);
  writeFileSync(join(dir, "sub", "own.ts"), "x\n");
  assert.notEqual(tree(join(dir, "sub")), before);
});

test("parity: TS and CJS agree with foreign + own untracked files and a variant", () => {
  const dir = repo();
  mkdirSync(join(dir, "sub"));
  sidecar(dir, ["sub/own.ts"], "v-2");
  writeFileSync(join(dir, "sub", "own.ts"), "export const o = 1;\n");
  writeFileSync(join(dir, "notes.md"), "pm\n");
  writeFileSync(join(dir, "yarn.lock"), "# gen\n");
  for (const variant of [undefined, "v-2"]) {
    if (variant) process.env.RG_STATE_VARIANT = variant;
    else delete process.env.RG_STATE_VARIANT;
    assert.equal(cjs.worktreeTreeOid(dir), worktreeTreeOid(dir), `tree, variant=${variant}`);
    assert.equal(cjs.compute(dir).digest, computeFingerprint(dir).digest, `digest, variant=${variant}`);
    assert.equal(cjs.compute(dir).version, 3);
  }
});
