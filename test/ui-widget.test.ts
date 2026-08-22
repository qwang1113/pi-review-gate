import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanAgentArtifacts,
  buildAgentsWidget,
  buildModelConfigWidget,
  type AgentArtifactInfo,
} from "../lib/ui-widget.ts";


// ---------------------------------------------------------------------------
// scanAgentArtifacts
// ---------------------------------------------------------------------------

function makeArtifactsDir(): { dir: string; now: number; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ui-widget-test-"));
  const now = Date.now();
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, now, cleanup };
}

function writeArtifact(dir: string, file: string, content: string, ageMs: number, now: number): void {
  const p = join(dir, file);
  writeFileSync(p, content);
  utimesSync(p, new Date(now - ageMs), new Date(now - ageMs));
}

test("scanAgentArtifacts classifies running vs done and reads the task", () => {
  const { dir, now, cleanup } = makeArtifactsDir();
  try {
    // running: input + transcript, no meta
    writeArtifact(dir, "abc123_reviewer_input.md", "Review the diff for xyz", 2_000, now);
    writeArtifact(dir, "abc123_reviewer_transcript.jsonl", "{}", 2_000, now);
    // done: meta with exitCode + task
    writeArtifact(
      dir,
      "def456_adviser_meta.json",
      JSON.stringify({ runId: "def456", agent: "adviser", task: "Advise on the design of module X", exitCode: 0 }),
      60_000,
      now,
    );
    // unrelated file ignored
    writeArtifact(dir, "notes.txt", "hi", 1_000, now);

    const agents = scanAgentArtifacts(dir, now);
    assert.equal(agents.length, 2);
    const reviewer = agents.find((a) => a.name === "reviewer");
    const adviser = agents.find((a) => a.name === "adviser");
    assert.ok(reviewer);
    assert.ok(adviser);
    assert.equal(reviewer.state, "running");
    assert.equal(reviewer.task, "Review the diff for xyz");
    assert.equal(reviewer.ageSec, 2);
    assert.equal(adviser.state, "done");
    assert.equal(adviser.task, "Advise on the design of module X");
    // running sorts first
    assert.equal(agents[0]!.name, "reviewer");
  } finally {
    cleanup();
  }
});

test("scanAgentArtifacts returns [] for a missing directory and skips malformed meta", () => {
  const { dir, now, cleanup } = makeArtifactsDir();
  try {
    assert.deepEqual(scanAgentArtifacts(join(dir, "does-not-exist"), now), []);
    writeArtifact(dir, "bad_meta_meta.json", "{not json", 1_000, now);
    const agents = scanAgentArtifacts(dir, now);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "meta");
    assert.equal(agents[0]!.state, "done"); // presence of meta = done, task unknown
    assert.equal(agents[0]!.task, "");
  } finally {
    cleanup();
  }
});

test("scanAgentArtifacts ignores files with no run id and truncates long tasks", () => {
  const { dir, now, cleanup } = makeArtifactsDir();
  try {
    writeArtifact(dir, "_meta.json", "{}", 1_000, now); // no id before agent token
    const longTask = "x".repeat(500);
    writeArtifact(dir, "run1_worker_input.md", longTask, 1_000, now);
    const agents = scanAgentArtifacts(dir, now);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "worker");
    assert.ok(agents[0]!.task.length <= 120, "task must be truncated to 120 chars");
  } finally {
    cleanup();
  }
});

test("scanAgentArtifacts handles uuid-style run ids", () => {
  const { dir, now, cleanup } = makeArtifactsDir();
  try {
    writeArtifact(dir, "f67a0e6c-1aff-4a7d-be36-0650bc9914ab_reviewer_meta.json",
      JSON.stringify({ task: "Incremental review", exitCode: 0 }), 5_000, now);
    const agents = scanAgentArtifacts(dir, now);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.name, "reviewer");
    assert.equal(agents[0]!.state, "done");
  } finally {
    cleanup();
  }
});

test("scanAgentArtifacts strips the trailing shard index (<runId>_<agent>_<n>_<kind>)", () => {
  const { dir, now, cleanup } = makeArtifactsDir();
  try {
    // Real-world pi-subagents naming: the index after the agent name is a shard
    // counter, NOT part of the agent name.
    writeArtifact(dir, "011bc09c_reviewer_0_input.md", "Review shard zero", 2_000, now);
    writeArtifact(dir, "011bc09c_reviewer_0_transcript.jsonl", "{}", 2_000, now);
    writeArtifact(dir, "011bc09c_reviewer_0_meta.json",
      JSON.stringify({ task: "Review shard zero", exitCode: 0 }), 2_000, now);
    // Same run, second shard index — must coalesce into the SAME run.
    writeArtifact(dir, "011bc09c_reviewer_1_meta.json",
      JSON.stringify({ task: "Review shard one", exitCode: 0 }), 1_000, now);
    const agents = scanAgentArtifacts(dir, now);
    assert.equal(agents.length, 1, "shard-indexed files must coalesce into one run");
    assert.equal(agents[0]!.name, "reviewer", "shard index must not become the agent name");
    assert.equal(agents[0]!.state, "done");
  } finally {
    cleanup();
  }
});

test("scanAgentArtifacts prunes old DONE runs beyond maxAgeSec but keeps running ones", () => {
  const { dir, now, cleanup } = makeArtifactsDir();
  try {
    // Old completed run: beyond the window.
    writeArtifact(dir, "old_reviewer_meta.json",
      JSON.stringify({ task: "Old review", exitCode: 0 }), 3 * 3600_000, now);
    // Recent completed run: inside the window.
    writeArtifact(dir, "new_adviser_meta.json",
      JSON.stringify({ task: "Fresh advice", exitCode: 0 }), 600_000, now);
    // Old but still RUNNING (no meta): must be kept.
    writeArtifact(dir, "running_worker_input.md", "Long-running worker", 3 * 3600_000, now);
    const agents = scanAgentArtifacts(dir, now, { maxAgeSec: 2 * 3600 });
    assert.deepEqual(
      agents.map((a) => a.name).sort(),
      ["adviser", "worker"],
      "old done runs are pruned; running runs stay regardless of age",
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// buildAgentsWidget
// ---------------------------------------------------------------------------

test("buildAgentsWidget renders running with age, done without", () => {
  const agents: AgentArtifactInfo[] = [
    { name: "reviewer", task: "Review the diff", state: "running", ageSec: 12 },
    { name: "adviser", task: "Advise", state: "done", ageSec: 600 },
  ];
  const lines = buildAgentsWidget(agents);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^▶ reviewer \| Review the diff \| 12s$/);
  assert.match(lines[1]!, /^✓ adviser \| Advise$/);
});

test("buildAgentsWidget handles empty list and limit", () => {
  assert.deepEqual(buildAgentsWidget([]), ["[no sub-agents this session]"]);
  const many: AgentArtifactInfo[] = Array.from({ length: 10 }, (_, i) => ({
    name: `a${i}`,
    task: "",
    state: "running",
    ageSec: i,
  }));
  const lines = buildAgentsWidget(many, { limit: 4 });
  assert.equal(lines.length, 5);
  assert.match(lines[4]!, /^… and 6 more$/);
});

test("scan + build round-trip on a real directory", () => {
  const { dir, now, cleanup } = makeArtifactsDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeArtifact(dir, "r1_recon_input.md", "Find the pagination code", 3_000, now);
    const lines = buildAgentsWidget(scanAgentArtifacts(dir, now));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^▶ recon \| Find the pagination code \| 3s$/);
  } finally {
    cleanup();
  }
});

test("buildModelConfigWidget renders one line per entry with spec · auto state · source", () => {
  const lines = buildModelConfigWidget([
    { name: "reviewer", spec: "onekey/gpt-5.6-sol:high", auto: false, source: "project" },
    { name: "adviser", spec: "claude-fable-5:max", auto: true, source: "default" },
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^model reviewer: onekey\/gpt-5\.6-sol:high  \[auto OFF · project\]$/);
  assert.match(lines[1]!, /^model adviser: claude-fable-5:max  \[auto on · default\]$/);
});

test("buildModelConfigWidget maps every auto state and source label deterministically", () => {
  const states = [
    { auto: false, source: "project" as const, expect: "auto OFF · project" },
    { auto: false, source: "global" as const, expect: "auto OFF · global" },
    { auto: true, source: "global" as const, expect: "auto on · global" },
    { auto: true, source: "default" as const, expect: "auto on · default" },
  ];
  for (const { auto, source, expect } of states) {
    const [line] = buildModelConfigWidget([{ name: "reviewer", spec: "claude-fable-5", auto, source }]);
    assert.ok(line!.includes(`[${expect}]`), `${auto}/${source} should render [${expect}]`);
  }
});
