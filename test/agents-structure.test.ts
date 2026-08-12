import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(ROOT, "agents");

function frontmatter(file: string): string {
  const src = readFileSync(join(AGENTS, file), "utf8");
  const fm = src.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, `${file}: frontmatter missing`);
  return fm![1];
}

test("every agent frontmatter carries the required fields", () => {
  const files = readdirSync(AGENTS).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 5, `expected at least 5 agents, found ${files.length}`);
  for (const f of files) {
    const body = frontmatter(f);
    for (const key of ["name", "description", "model", "fallbackModels", "thinking", "systemPromptMode", "tools"]) {
      assert.match(body, new RegExp(`^${key}:`, "m"), `${f}: missing ${key}`);
    }
  }
});

test("L3 judges (reviewer/adviser/arbiter) think at max — the verdict tier never degrades", () => {
  for (const f of ["reviewer.md", "adviser.md", "arbiter.md"]) {
    assert.match(frontmatter(f), /^thinking: max$/m, `${f}: L3 must think at max`);
  }
});

test("L1 triage is read-only, cheap-tier, and defined without verdict power", () => {
  const body = frontmatter("triage.md");
  assert.match(body, /^model: claude-haiku-4-5$/m, "L1 primary must be the cheap model");
  assert.match(body, /^fallbackModels: deepseek-v4-flash$/m);
  assert.doesNotMatch(body, /tools:.*\b(edit|write)\b/, "triage must be read-only");
});

test("L2 fixer is the execution tier: write-capable, mid-tier, never a judge", () => {
  const body = frontmatter("fixer.md");
  assert.match(body, /^model: claude-sonnet-5$/m, "L2 primary must be the mid-tier model");
  assert.match(body, /^thinking: medium$/m);
  assert.match(body, /tools:.*\b(edit|write)\b/, "fixer needs write tools");
  const src = readFileSync(join(AGENTS, "fixer.md"), "utf8");
  assert.match(src, /NOT a judge/i, "fixer must declare it never judges");
});

test("the orchestration roles keep the serial contract: one writer, read-only reviewers", () => {
  const planner = frontmatter("planner.md");
  assert.doesNotMatch(planner, /tools:.*\bbash\b/, "the planner sequences; it never executes");
  assert.doesNotMatch(planner, /tools:.*\bedit\b/, "the planner writes state, not source");
  const plannerSrc = readFileSync(join(AGENTS, "planner.md"), "utf8");
  assert.match(plannerSrc, /SHORT-LIVED/i, "the planner must know it is disposable");
  assert.match(plannerSrc, /Do not dispatch\s+subagents/i, "only the main session dispatches");

  const worker = frontmatter("worker.md");
  assert.match(worker, /tools:.*\bedit\b/, "the worker is the only writer");
  const workerSrc = readFileSync(join(AGENTS, "worker.md"), "utf8");
  assert.match(workerSrc, /owned_paths/, "the worker must be scoped to its module");
  assert.match(workerSrc, /Do not start subagents/i);
  assert.match(workerSrc, /git commit/, "the worker must be told shipping is not its job");

  const reviewer = frontmatter("module-reviewer.md");
  assert.doesNotMatch(reviewer, /tools:.*\b(edit|write)\b/, "a shard reviewer must be read-only");
  assert.match(reviewer, /^thinking: max$/m, "verdict power stays on the L3 tier");
});

test("the shard reviewer is forbidden from emitting docSync — the two-phase protocol depends on it", () => {
  const src = readFileSync(join(AGENTS, "module-reviewer.md"), "utf8");
  assert.match(src, /Never include a `docSync` field/i, "the prohibition must be in the role, not the task text");
  assert.match(src, /integration reviewer/i, "and it must say where the single attestation comes from");
});
