import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseGoalTasks,
  buildTasksWidget,
  scanAgentArtifacts,
  buildAgentsWidget,
  type AgentArtifactInfo,
} from "../lib/ui-widget.ts";

const SAMPLE_GOAL = `# Some task

**Intent**: something.

## Exit criteria

1. **First criterion**: do the thing with \`npm test\` green.
2. **Second criterion**: update the docs.

## Non-goals

- not doing the other thing
`;

// ---------------------------------------------------------------------------
// parseGoalTasks
// ---------------------------------------------------------------------------

test("parseGoalTasks extracts numbered bolded criteria under Exit criteria", () => {
  const tasks = parseGoalTasks(SAMPLE_GOAL);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks[0], { index: 1, title: "First criterion", body: "do the thing with `npm test` green." });
  assert.deepEqual(tasks[1], { index: 2, title: "Second criterion", body: "update the docs." });
});

test("parseGoalTasks stops at the next ## heading (Non-goals)", () => {
  const tasks = parseGoalTasks(SAMPLE_GOAL);
  assert.ok(!tasks.some((t) => t.body.includes("not doing")), "Non-goals content must not leak in");
});

test("parseGoalTasks is case-insensitive on the section heading", () => {
  const tasks = parseGoalTasks(SAMPLE_GOAL.replace("## Exit criteria", "## EXIT CRITERIA"));
  assert.equal(tasks.length, 2);
});

test("parseGoalTasks returns [] for a goal without criteria", () => {
  assert.deepEqual(parseGoalTasks("# no criteria here\n\n## Non-goals\n- x\n"), []);
  assert.deepEqual(parseGoalTasks(""), []);
});

test("parseGoalTasks skips non-numbered lines inside the criteria section", () => {
  const text = `## Exit criteria\n\nSome intro prose.\n\n1. **Only**: one.\n\n- a bullet\n\n## Non-goals\n`;
  const tasks = parseGoalTasks(text);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, "Only");
});

// ---------------------------------------------------------------------------
// buildTasksWidget
// ---------------------------------------------------------------------------

test("buildTasksWidget renders unchecked tasks with a status footer", () => {
  const lines = buildTasksWidget(SAMPLE_GOAL, { reviewReady: false, precommitPass: false });
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /^\[ \] 1\. First criterion/);
  assert.match(lines[1]!, /^\[ \] 2\. Second criterion/);
  assert.match(lines[2]!, /gate: review pending · precommit not-run/);
});

test("buildTasksWidget checks all tasks off when review READY and precommit PASS", () => {
  const lines = buildTasksWidget(SAMPLE_GOAL, { reviewReady: true, precommitPass: true });
  assert.match(lines[0]!, /^\[x\] 1\./);
  assert.match(lines[1]!, /^\[x\] 2\./);
  assert.match(lines[2]!, /gate: review READY · precommit PASS/);
});

test("buildTasksWidget handles a missing goal and an unparseable one", () => {
  assert.deepEqual(buildTasksWidget(undefined, { reviewReady: false, precommitPass: false }), [
    "[no loop goal yet — negotiate with the user]",
  ]);
  const noCriteria = buildTasksWidget("# just a title\n", { reviewReady: false, precommitPass: false });
  assert.equal(noCriteria.length, 1);
  assert.match(noCriteria[0]!, /no parseable exit criteria/);
});

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
