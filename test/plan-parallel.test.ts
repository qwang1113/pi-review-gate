import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WAVE_WORKER_SCHEMA,
  applyPatchFile,
  buildWaveWorkerPrompt,
  checkPatchApplies,
  computeWave,
  diffHeaderFiles,
  parseWaveWorkerResult,
  patchFileList,
  validatePatchOwnership,
  writeWavePatches,
} from "../lib/plan-parallel.ts";

test("computeWave picks exactly the pending modules whose deps are ready", () => {
  const modules = [
    { id: "M-01", status: "pending", depends_on: [] },
    { id: "M-02", status: "pending", depends_on: ["M-01"] },
    { id: "M-03", status: "pending", depends_on: ["M-01", "M-02"] },
    { id: "M-04", status: "implemented", depends_on: [] },
  ];
  // Only M-01 has no deps and is pending.
  const wave = computeWave(modules);
  assert.deepEqual(wave.wave, ["M-01"]);
  assert.equal(wave.allDone, false);
});

test("computeWave advances to the next layer once deps are implemented", () => {
  const modules = [
    { id: "M-01", status: "implemented", depends_on: [] },
    { id: "M-02", status: "pending", depends_on: ["M-01"] },
    { id: "M-03", status: "pending", depends_on: ["M-01"] },
    { id: "M-04", status: "pending", depends_on: ["M-02", "M-03"] },
  ];
  const wave = computeWave(modules);
  assert.deepEqual(wave.wave, ["M-02", "M-03"]);
});

test("computeWave caps wave size and reports allDone", () => {
  const modules = [
    { id: "M-01", status: "pending", depends_on: [] },
    { id: "M-02", status: "pending", depends_on: [] },
    { id: "M-03", status: "pending", depends_on: [] },
    { id: "M-04", status: "pending", depends_on: [] },
    { id: "M-05", status: "pending", depends_on: [] },
  ];
  assert.equal(computeWave(modules, { maxWaveSize: 3 }).wave.length, 3);
  assert.equal(computeWave(modules).allDone, false);
  // Everything accepted ⇒ done.
  const done = computeWave(
    modules.map((m) => ({ ...m, status: "accepted" })),
  );
  assert.equal(done.wave.length, 0);
  assert.equal(done.allDone, true);
});

test("computeWave never schedules a module whose dep is stuck", () => {
  const modules = [
    { id: "M-01", status: "blocked", depends_on: [] },
    { id: "M-02", status: "pending", depends_on: ["M-01"] },
  ];
  const wave = computeWave(modules);
  assert.deepEqual(wave.wave, []);
  assert.equal(wave.allDone, false);
});

test("buildWaveWorkerPrompt enforces read-only and patch output", () => {
  const prompt = buildWaveWorkerPrompt({
    moduleId: "M-02",
    title: "auth middleware",
    ownedPaths: ["lib/auth.ts", "test/auth.test.ts"],
    worklogPath: ".pi/plan/worklog/M-02.md",
    goalText: "exit criterion 2",
  });
  assert.match(prompt, /M-02/);
  assert.match(prompt, /lib\/auth\.ts/);
  assert.match(prompt, /edit\/write AND bash tools are disabled/);
  assert.match(prompt, /patch-first/);
  assert.match(prompt, /unified git diff/);
  assert.match(prompt, /--- \/dev\/null/);
  assert.match(prompt, /exit criterion 2/);
  assert.match(prompt, /selfcheck/);
  assert.match(prompt, /Wave daily protocol/);
});

test("buildWaveWorkerPrompt without goalText omits wave daily protocol", () => {
  const prompt = buildWaveWorkerPrompt({
    moduleId: "M-03",
    title: "simple fix",
    ownedPaths: ["lib/x.ts"],
    worklogPath: ".pi/plan/worklog/M-03.md",
  });
  assert.match(prompt, /M-03/);
  assert.match(prompt, /patch-first/);
  // Wave daily protocol paragraph is only injected when goalText is present
  // (the goal drives the task — daily waves need the goal context).
  // Without goalText the prompt is still valid and carries the core constraints.
  assert.doesNotMatch(prompt, /Wave daily protocol/);
});

test("parseWaveWorkerResult tolerates malformed structured output", () => {
  const ok = parseWaveWorkerResult("M-01", {
    patches: [{ path: "lib/a.ts", diff: "--- a/lib/a.ts\n+++ b/lib/a.ts\n" }],
    summary: "done",
    selfcheck: [{ must_have: "mh-1", met: true, evidence: "ran npm test" }],
  });
  assert.equal(ok.moduleId, "M-01");
  assert.equal(ok.patches.length, 1);
  assert.equal(ok.selfcheck.length, 1);
  assert.equal(ok.summary, "done");

  const garbage = parseWaveWorkerResult("M-02", "not an object");
  assert.deepEqual(garbage.patches, []);
  assert.equal(garbage.summary, "worker returned no structured result");

  const partial = parseWaveWorkerResult("M-03", {
    patches: [
      { path: "ok.ts", diff: "x" },
      { path: "bad.ts" },
      { diff: "no path" },
    ],
    selfcheck: [
      { must_have: "a", met: false, evidence: "e" },
      { must_have: "b" },
    ],
    summary: 42,
  });
  assert.equal(partial.patches.length, 1);
  assert.equal(partial.selfcheck.length, 1);
  assert.equal(partial.summary, "");
});

test("validatePatchOwnership enforces owned paths fail-closed", () => {
  const patches = [
    { path: "lib/a.ts", diff: "x" },
    { path: "lib/sub/b.ts", diff: "y" },
    { path: "src/other.ts", diff: "z" },
  ];
  const ok = validatePatchOwnership(patches.slice(0, 2), ["lib/a.ts", "lib/sub"]);
  assert.deepEqual(ok, { ok: true });
  const bad = validatePatchOwnership(patches, ["lib/a.ts"]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.violations, ["lib/sub/b.ts", "src/other.ts"]);
  // Leading slashes are normalized away on both sides.
  const slashed = validatePatchOwnership([{ path: "/lib/a.ts", diff: "x" }], ["/lib/a.ts/"]);
  assert.deepEqual(slashed, { ok: true });
});

test("diffHeaderFiles parses the EFFECTIVE write surface from diff headers", () => {
  const diff = `--- a/lib/a.ts
+++ b/lib/a.ts
@@ -1 +1 @@
-old
+new
--- /dev/null
+++ b/lib/new.ts
@@ -0,0 +1 @@
+content
--- a/lib/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
`;
  assert.deepEqual(diffHeaderFiles(diff), ["lib/a.ts", "lib/new.ts", "lib/gone.ts"]);
});

test("diffHeaderFiles flags traversal headers and skips junk", () => {
  const flags = diffHeaderFiles("--- a/lib/../evil.ts\n+++ b/lib/../evil.ts\n");
  assert.equal(flags.length, 1, "the same traversal header must be deduplicated");
  assert.match(flags[0], /^<traversal:/);
  assert.deepEqual(diffHeaderFiles("no headers here"), []);
});

test("validatePatchOwnership checks diff headers, not just the declared path", () => {
  // Declared path is owned, but the diff header targets an UNOWNED file:
  // git apply would write the header path — this must be a violation.
  const sneaky = [{ path: "lib/a.ts", diff: "--- a/lib/a.ts\n+++ b/extensions/review-gate.ts\n@@ -1 +1 @@\n-x\n+y\n" }];
  const bad = validatePatchOwnership(sneaky, ["lib/a.ts"]);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.violations, ["extensions/review-gate.ts"]);
  // Traversal in a header is a violation too.
  const traversal = validatePatchOwnership(
    [{ path: "lib/a.ts", diff: "--- a/lib/a.ts\n+++ b/lib/../../evil.ts\n" }],
    ["lib/a.ts"],
  );
  assert.equal(traversal.ok, false);
});

test("patchFileList returns the declared paths", () => {
  assert.deepEqual(
    patchFileList([
      { path: "a.ts", diff: "x" },
      { path: " b.ts ", diff: "y" },
    ]),
    ["a.ts", "b.ts"],
  );
});

test("writeWavePatches persists patches under plan dir and returns paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "pdw-wave-"));
  const written = writeWavePatches(dir, "M-01", [
    { path: "a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+x\n" },
  ]);
  assert.equal(written.length, 1);
  const file = join(dir, "patches", "M-01", "01.patch");
  assert.equal(written[0], file);
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8"), /^--- a\/a\.ts/m);
});

test("git apply check and apply work on a real repo patch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdw-apply-"));
  // Minimal real git repo so git apply has an index/tree to check against.
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "seed"], { cwd: dir });

  const patch = join(dir, "change.patch");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(patch, "--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n", "utf8");
  assert.equal(await checkPatchApplies(dir, patch), true);
  const applied = await applyPatchFile(dir, patch);
  assert.deepEqual(applied, { ok: true });
  assert.ok(existsSync(join(dir, "new.txt")));
  // A second apply must fail (already applied).
  const again = await applyPatchFile(dir, patch);
  assert.equal(again.ok, false);

  // A bogus patch fails the check.
  const bogus = join(dir, "bogus.patch");
  writeFileSync(bogus, "--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-x\n+x\n", "utf8");
  assert.equal(await checkPatchApplies(dir, bogus), false);
});
