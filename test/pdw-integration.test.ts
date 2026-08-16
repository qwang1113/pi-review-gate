import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { runParallelShardReview } from "../lib/parallel-review.ts";
import { runWaveWorkflow } from "../lib/plan-parallel.ts";
import { resolveBestModel } from "../lib/pdw-bridge.ts";

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

test("runParallelShardReview really fans out through the workflow engine", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-review-"));
  const updates: Array<{ text: string; progress?: number }> = [];
  const outcome = await runParallelShardReview({
    cwd,
    shards: [
      { label: "shard-1", files: ["a.ts"], note: "1 file(s)" },
      { label: "shard-2", files: ["b.ts"], note: "1 file(s)" },
      { label: "shard-3", files: ["c.ts"], note: "1 file(s)" },
    ],
    goalText: "criterion: tests pass",
    agent: stubRunner({
      "shard-1": { gate: "READY", findings: [], notes: "clean" },
      "shard-2": { gate: "READY", findings: [] },
      "shard-3": { gate: "BLOCKED", findings: [{ file: "c.ts", line: 2, severity: "P1", issue: "bug" }] },
    }),
    onProgress: (text: string, progress?: number) => {
      updates.push({ text, progress });
    },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.shards.length, 3);
  assert.equal(outcome.agentCount, 3);
  const byLabel = new Map(outcome.shards.map((s) => [s.label, s]));
  assert.equal(byLabel.get("shard-1")!.verdict!.gate, "READY");
  assert.equal(byLabel.get("shard-3")!.verdict!.gate, "BLOCKED");
  assert.equal(byLabel.get("shard-3")!.verdict!.findings.length, 1);
  assert.match(outcome.shards[0].output, /READY/);
  // Progress wiring: the run owns a runId, an ndjson event file and the
  // engine log path; the event file records real engine callbacks.
  assert.match(outcome.runId, /^run-/);
  assert.ok(outcome.progressFile.endsWith(`${outcome.runId}.ndjson`));
  assert.ok(outcome.progressFile.includes(join(cwd, ".pi", "pdw-progress")));
  assert.ok(existsSync(outcome.progressFile), "ndjson progress file must exist");
  assert.ok(outcome.engineLogFile.includes(join("workflows", "projects")));
  assert.ok(outcome.engineLogFile.endsWith(`${outcome.runId}.log`));
  assert.ok(existsSync(outcome.engineLogFile), "engine log must persist (persistLogs default true)");
  const lines = readFileSync(outcome.progressFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string });
  const types = lines.map((e) => e.type);
  assert.ok(types.includes("agent-start"), "ndjson must record agent starts");
  assert.ok(types.includes("agent-end"), "ndjson must record agent ends");
  assert.equal(lines[lines.length - 1].type, "run-end", "ndjson must end with the terminal event");
  // The onUpdate stream carries label/status text and a bounded progress pct.
  assert.ok(updates.length >= 3, `expected live progress updates, got ${updates.length}`);
  assert.ok(updates.some((u) => /shard-\d/.test(u.text)), "updates must name shard labels");
  assert.ok(updates.some((u) => /done|FAILED/.test(u.text)), "updates must carry per-agent status");
  for (const u of updates) {
    if (u.progress !== undefined) {
      assert.ok(Number.isInteger(u.progress) && u.progress >= 0 && u.progress <= 100);
    }
  }
  const lastPct = [...updates].reverse().find((u) => u.progress !== undefined);
  assert.equal(lastPct?.progress, 100, "the last percentage-carrying update must report 100%");
  // Cleanup: remove the engine log the run persisted under the user home.
  try {
    // Remove the whole project dir (runs/ + locks), not just the log.
    rmSync(dirname(dirname(outcome.engineLogFile)), { recursive: true, force: true });
  } catch {
    // Best-effort test hygiene.
  }
});

test("runParallelShardReview surfaces a workflow failure as ok:false", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-review-fail-"));
  const runner = {
    run: async () => {
      throw new Error("boom");
    },
  };
  const outcome = await runParallelShardReview({
    cwd,
    shards: [{ label: "shard-1", files: ["a.ts"], note: "1 file(s)" }],
    agent: runner,
  });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "workflow-failed");
    // pdw's parallel() folds a failing agent into null; the caller sees a
    // descriptive "all shard reviewers failed" summary instead of the raw throw.
    assert.match(outcome.error ?? "", /failed/);
    // Diagnostic paths survive failures too (goal exit criterion 4).
    assert.match(outcome.runId, /^run-/);
    assert.ok(outcome.progressFile.endsWith(`${outcome.runId}.ndjson`));
    assert.ok(outcome.engineLogFile.endsWith(`${outcome.runId}.log`));
    assert.ok(existsSync(outcome.progressFile), "ndjson must exist even when the run fails");
    try {
      // Remove the whole project dir (runs/ + locks), not just the log.
      rmSync(dirname(dirname(outcome.engineLogFile)), { recursive: true, force: true });
    } catch {
      // Best-effort test hygiene.
    }
  }
});

test("runParallelShardReview THROWS with install guidance when the engine is missing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-missing-"));
  await assert.rejects(
    runParallelShardReview({
      cwd,
      shards: [{ label: "shard-1", files: ["a.ts"], note: "1 file(s)" }],
      pdwOverride: null,
    }),
    /pdw engine \(@quintinshaw\/pi-dynamic-workflows\) is not available/,
  );
});

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
  const registry = mkRegistry(
    [
      { provider: "opencode-go", id: "deepseek-v4-flash" },
      { provider: "opencode-go", id: "deepseek-v4-pro" },
    ],
    (m) => m.id !== "deepseek-v4-flash",
  );
  assert.equal(
    await resolveBestModel(["claude-fable-5"], registry),
    "opencode-go/deepseek-v4-pro",
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
