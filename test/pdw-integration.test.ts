import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// (review no longer runs on the engine — see the note below)
import { runWaveWorkflow } from "../lib/plan-parallel.ts";
import { isModelAllowed, resolveBestModel } from "../lib/pdw-bridge.ts";

/**
 * A stub WorkflowAgentRunner mirroring the PRODUCTION shape: for a schema'd
 * agent() call pdw's default WorkflowAgent returns the structured value ITSELF
 * (resolveStructuredOutput's capture.value), not a {text, structured} wrapper.
 * The workflow engine still really runs (parallel fan-out, schema enforcement,
 * result plumbing), only the subagent sessions are fake.
 */
function stubRunner(byLabel: Record<string, unknown>): { run: (prompt: string, opts: { label?: string; schema?: unknown }) => Promise<unknown> } {
  return {
    async run(prompt: string, opts: { label?: string; schema?: unknown }) {
      const label = opts?.label ?? "?";
      const value = byLabel[label];
      return typeof value === "string" ? value : (value ?? null);
    },
  };
}

test("USER REQUIREMENT: opencode-go may only run deepseek-v4-flash", () => {
  // The registry lists every opencode-go model; the allowlist is what stops a
  // pinned candidate from silently landing on an expensive one.
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "deepseek-v4-flash" }), true);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "qwen3.8-max" }), false);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "gpt-5.6-luna" }), false);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "deepseek-v4-pro" }), false);
  // Every other provider is unrestricted (claude / onekey / ... may be added
  // later and must not be blocked by this rule).
  assert.equal(isModelAllowed({ provider: "anthropic", id: "claude-fable-5" }), true);
  assert.equal(isModelAllowed({ provider: "onekey", id: "gpt-5.6-sol" }), true);
  assert.equal(isModelAllowed({ provider: "opencode-go", id: "DEEPSEEK-V4-FLASH" }), false,
    "id match is exact (registry ids are lowercase)");
  // Malformed entries are rejected (fail-closed: never trust a bare string).
  assert.equal(isModelAllowed(null), false);
  assert.equal(isModelAllowed("opencode-go/qwen3.8-max"), false);
  assert.equal(isModelAllowed({ provider: "opencode-go" }), false);
});

// REVIEW-SIDE ENGINE TESTS REMOVED WITH THE PATH THEY COVERED.
//
// `runParallelShardReview` is gone: the engine discards a per-agent `cwd`
// (verified against workflow.js — its `runCwd` comes only from its own
// `isolation: "worktree"`, a checkout of HEAD without the change under
// review), so shard reviewers could not hold their own snapshot of what they
// were judging. Reviews now go through `prepare_review` + plain subagents,
// which honor a per-call cwd; the shard PLAN is still pure and still tested in
// test/parallel-review.test.ts, and the snapshot/verification behaviour in
// test/review-snapshot.test.ts + test/extension-structure.test.ts.
//
// The wave-worker tests below stay: `run_wave_workflow` still runs on the
// engine (docs/handoff-remove-pdw.md plans that migration separately).

test("runWaveWorkflow THROWS with install guidance when the engine is missing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-wave-missing-"));
  await assert.rejects(
    runWaveWorkflow({
      cwd,
      modules: [{ id: "M-01", title: "a", ownedPaths: ["lib/a.ts"], worklogPath: "wl", model: "claude-sonnet-5:max" }],
      pdwOverride: null,
    }),
    /pdw engine \(@quintinshaw\/pi-dynamic-workflows\) is not available/,
  );
});

test("runWaveWorkflow really fans out workers and parses patches", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-wave-"));
  const outcome = await runWaveWorkflow({
    cwd,
    modules: [
      {
        id: "M-01",
        title: "a",
        ownedPaths: ["lib/a.ts"],
        worklogPath: join(cwd, ".pi", "plan", "worklog", "M-01.md"),
        model: "claude-sonnet-5:max",
      },
      {
        id: "M-02",
        title: "b",
        ownedPaths: ["lib/b.ts"],
        worklogPath: join(cwd, ".pi", "plan", "worklog", "M-02.md"),
        model: "claude-sonnet-5:max",
      },
    ],
    agent: stubRunner({
      "M-01": {
        patches: [{ path: "lib/a.ts", diff: "--- a/lib/a.ts\n+++ b/lib/a.ts\n@@ -1 +1 @@\n-old\n+new\n" }],
        summary: "done",
        selfcheck: [{ must_have: "mh-1", met: true, evidence: "ran test" }],
      },
      "M-02": {
        patches: [],
        summary: "nothing needed",
        selfcheck: [],
      },
    }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.results.length, 2);
  const m01 = outcome.results.find((r) => r.moduleId === "M-01")!;
  assert.equal(m01.patches.length, 1);
  assert.equal(m01.patches[0].path, "lib/a.ts");
  assert.equal(m01.selfcheck[0].met, true);
  const m02 = outcome.results.find((r) => r.moduleId === "M-02")!;
  assert.deepEqual(m02.patches, []);
  assert.equal(outcome.agentCount, 2);
  assert.match(outcome.runId, /^run-/);
  assert.ok(outcome.progressFile.endsWith(`${outcome.runId}.ndjson`));
  assert.ok(existsSync(outcome.progressFile));
  try {
    // Remove the whole project dir (runs/ + locks), not just the log.
    rmSync(dirname(dirname(outcome.engineLogFile)), { recursive: true, force: true });
  } catch {
    // Best-effort test hygiene.
  }
});

test("runWaveWorkflow splits recoverable-null workers into failedModules", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-wave-fail-"));
  const outcome = await runWaveWorkflow({
    cwd,
    modules: [
      { id: "M-01", title: "a", ownedPaths: ["lib/a.ts"], worklogPath: "wl1", model: "claude-sonnet-5:max" },
      { id: "M-02", title: "b", ownedPaths: ["lib/b.ts"], worklogPath: "wl2", model: "claude-sonnet-5:max" },
    ],
    // One worker succeeds, the other fails (pdw folds a failing agent into null).
    agent: stubRunner({
      "M-01": { patches: [], summary: "done", selfcheck: [] },
      "M-02": null,
    }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(
    outcome.results.map((r) => r.moduleId),
    ["M-01"],
    "failed worker must be excluded from results",
  );
  assert.deepEqual(outcome.failedModules, ["M-02"], "failed worker must be reported separately");
  try {
    // Remove the whole project dir (runs/ + locks), not just the log.
    rmSync(dirname(dirname(outcome.engineLogFile)), { recursive: true, force: true });
  } catch {
    // Best-effort test hygiene.
  }
});


// resolveBestModel resolves candidates through pdw's OWN model resolver
// (resolveModelSpecWithThinking imported from the engine) against a registry
// that exposes getAll() + hasConfiguredAuth(model) — the pi ModelRegistry
// shape. An earlier implementation called a registry method and passed the
// spec STRING to hasConfiguredAuth, so every candidate looked unavailable
// and candidates[0] (the unauthenticated pinned default) was always picked.
const mkRegistry = (
  models: Array<{ provider: string; id: string }>,
  auth: (m: { provider: string; id: string }) => boolean = () => true,
) => ({
  getAll: () => models,
  hasConfiguredAuth: (m: { provider: string; id: string }) => auth(m),
});

test("resolveBestModel returns first candidate when registry is undefined", async () => {
  assert.equal(await resolveBestModel(["claude-sonnet-5", "onekey/deepseek-v4-pro"]), "claude-sonnet-5");
});

test("resolveBestModel returns first candidate when registry is null", async () => {
  assert.equal(await resolveBestModel(["claude-sonnet-5", "onekey/deepseek-v4-pro"], null), "claude-sonnet-5");
});

test("resolveBestModel returns empty string for empty candidates", async () => {
  assert.equal(await resolveBestModel([]), "");
});

test("resolveBestModel returns first candidate when registry lacks getAll", async () => {
  const registry = { someOtherMethod: () => true };
  assert.equal(await resolveBestModel(["a", "b"], registry), "a");
});

test("resolveBestModel picks the first candidate the registry can resolve", async () => {
  const registry = mkRegistry([
    { provider: "onekey", id: "deepseek-v4-pro" },
    { provider: "onekey", id: "gpt-5.6-sol" },
  ]);
  assert.equal(
    await resolveBestModel(["claude-sonnet-5", "onekey/deepseek-v4-pro"], registry),
    "onekey/deepseek-v4-pro",
  );
});

test("USER REQUIREMENT: candidate loop skips a resolvable but disallowed opencode-go model", async () => {
  // opencode-go/deepseek-v4-pro resolves AND has auth, but the allowlist
  // forbids it — the loop must skip it and take the next candidate. Without
  // this test, deleting the isModelAllowed call at the loop site leaves the
  // whole suite green while a pinned candidate silently lands on the
  // expensive model.
  const registry = mkRegistry([
    { provider: "opencode-go", id: "deepseek-v4-pro" },
    { provider: "onekey", id: "gpt-5.6-sol" },
  ]);
  assert.equal(
    await resolveBestModel(["opencode-go/deepseek-v4-pro", "onekey/gpt-5.6-sol"], registry),
    "onekey/gpt-5.6-sol",
  );
});

test("USER REQUIREMENT: registry fallback picks flash over a disallowed opencode-go model", async () => {
  // Neither pinned candidate resolves; the getAll fallback must NOT pick
  // opencode-go/deepseek-v4-pro (resolvable + auth, but disallowed) — it
  // must pick deepseek-v4-flash. Without this test, deleting the
  // isModelAllowed call at the fallback site leaves the suite green while
  // the fallback silently chooses the expensive model.
  const registry = mkRegistry([
    { provider: "opencode-go", id: "deepseek-v4-pro" },
    { provider: "opencode-go", id: "deepseek-v4-flash" },
  ]);
  assert.equal(
    await resolveBestModel(["claude-fable-5"], registry),
    "opencode-go/deepseek-v4-flash",
  );
});

test("resolveBestModel falls back to an authenticatable registry model when none of the pinned candidates resolve", async () => {
  // The pinned judge chain (claude-fable-5 etc.) does not exist in a minimal
  // registry that only carries e.g. opencode-go/deepseek-v4-flash. Returning
  // candidates[0] hands pdw a spec it rejects with MODEL_NOT_FOUND, killing
  // the whole parallel run — the resolver must degrade to a model the
  // registry can actually run.
  const registry = mkRegistry([{ provider: "opencode-go", id: "deepseek-v4-flash" }]);
  assert.equal(
    await resolveBestModel(["anthropic/claude-fable-5:max", "onekey/gpt-5.6-sol"], registry),
    "opencode-go/deepseek-v4-flash:max",
  );
});

test("resolveBestModel keeps the pinned thinking suffix on the registry fallback", async () => {
  const registry = mkRegistry([{ provider: "opencode-go", id: "deepseek-v4-flash" }]);
  assert.equal(
    await resolveBestModel(["claude-sonnet-5:max", "grok-4.6"], registry),
    "opencode-go/deepseek-v4-flash:max",
  );
});

test("resolveBestModel skips registry candidates without configured auth when falling back", async () => {
  // opencode-go is allowlisted to deepseek-v4-flash only (USER REQUIREMENT),
  // so this scenario uses a different provider to isolate the auth rule.
  const registry = mkRegistry(
    [
      { provider: "onekey", id: "deepseek-v4-flash" },
      { provider: "onekey", id: "deepseek-v4-pro" },
    ],
    (m) => m.id !== "deepseek-v4-flash",
  );
  assert.equal(
    await resolveBestModel(["claude-fable-5"], registry),
    "onekey/deepseek-v4-pro",
  );
});

test("resolveBestModel falls back to first candidate when registry offers nothing usable", async () => {
  const registry = mkRegistry([{ provider: "onekey", id: "deepseek-v4-pro" }], () => false);
  assert.equal(
    await resolveBestModel(["claude-sonnet-5", "grok-4.6"], registry),
    "claude-sonnet-5",
  );
});

test("resolveBestModel falls back to first candidate when registry has no usable models", async () => {
  const registry = mkRegistry([{ provider: "onekey", id: "deepseek-v4-pro" }]);
  // "grok-4.6" ✗ unknown in registry, "claude-sonnet-5" ✗ unknown in registry,
  // and the only registry model is NOT in the candidates list — the registry
  // fallback still finds it because it is a real, authenticatable model.
  assert.equal(
    await resolveBestModel(["claude-sonnet-5", "grok-4.6"], registry),
    "onekey/deepseek-v4-pro",
  );
});

test("resolveBestModel skips candidates without configured auth", async () => {
  const registry = mkRegistry(
    [
      { provider: "onekey", id: "deepseek-v4-pro" },
      { provider: "onekey", id: "gpt-5.6-sol" },
    ],
    (m) => m.id !== "deepseek-v4-pro",
  );
  assert.equal(
    await resolveBestModel(["onekey/deepseek-v4-pro", "onekey/gpt-5.6-sol"], registry),
    "onekey/gpt-5.6-sol",
  );
});

test("resolveBestModel returns first candidate when all fail auth and registry has nothing else", async () => {
  const registry = mkRegistry(
    [
      { provider: "onekey", id: "deepseek-v4-pro" },
      { provider: "onekey", id: "gpt-5.6-sol" },
    ],
    () => false,
  );
  assert.equal(
    await resolveBestModel(["onekey/deepseek-v4-pro", "onekey/gpt-5.6-sol"], registry),
    "onekey/deepseek-v4-pro",
  );
});
