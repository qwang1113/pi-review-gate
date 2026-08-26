import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import {
  SHARD_THRESHOLD_FILES,
  SHARD_THRESHOLD_LINES,
  shouldShardReview,
  SHARD_VERDICT_SCHEMA,
  buildShardPrompt,
  formatShardReviewRecord,
  planReviewShards,
} from "../lib/parallel-review.ts";

test("planReviewShards splits files into balanced disjoint shards", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
  const plan = planReviewShards(files, { maxShards: 3 });
  assert.equal(plan.fileCount, 7);
  assert.equal(plan.shards.length, 3);
  // Disjoint and covering.
  const seen = plan.shards.flatMap((s) => s.files);
  assert.equal(new Set(seen).size, 7);
  assert.deepEqual(seen.sort(), files.sort());
  // Balanced: with equal weights, 7 files over 3 shards ⇒ sizes 3/2/2.
  assert.deepEqual(plan.shards.map((s) => s.files.length).sort(), [2, 2, 3]);
  for (const shard of plan.shards) {
    assert.match(shard.label, /^shard-\d+$/);
    assert.ok(shard.note.length > 0);
  }
});

test("planReviewShards honors weights and caps", () => {
  const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
  const weights = { a: 10, b: 10, c: 10, d: 1, e: 1, f: 1 };
  const plan = planReviewShards(files, { maxShards: 4, weights });
  assert.ok(plan.shards.length <= 4);
  // Heavy files land in separate shards.
  const heavyShard = plan.shards.find((s) => s.files.includes("a.ts"))!;
  assert.deepEqual(heavyShard.files, ["a.ts"], "a 10-weight file should be alone");
});

test("planReviewShards handles empty and single-file input", () => {
  assert.deepEqual(planReviewShards([]), { shards: [], fileCount: 0 });
  const single = planReviewShards(["only.ts"], { maxShards: 8 });
  assert.equal(single.shards.length, 1);
  assert.deepEqual(single.shards[0].files, ["only.ts"]);
});

test("buildShardPrompt names the shard files and sets the snapshot contract", () => {
  const prompt = buildShardPrompt(
    { label: "shard-1", files: ["src/a.ts", "src/b.ts"], note: "2 file(s)" },
    "criterion 1: tests pass",
    undefined,
    { streamPath: "/repo/.pi/review-stream/r-shard-1.jsonl" },
  );
  assert.match(prompt, /shard-1/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /src\/b\.ts/);
  // The reviewer works in a disposable snapshot, so mutation analysis is
  // ENCOURAGED — but it must restore, and it must know why (the tree check).
  assert.match(prompt, /disposable snapshot worktree/);
  assert.match(prompt, /mutation analysis/i);
  assert.match(prompt, /RESTORE every mutation/);
  assert.match(prompt, /READY from you will not be accepted/);
  // Shipping stays out of a reviewer's hands, snapshot or not.
  assert.match(prompt, /Never run git commit\/push/);
  assert.match(prompt, /no docSync field/);
  assert.match(prompt, /criterion 1: tests pass/);
  assert.match(prompt, /READY.*BLOCKED.*NEEDS_HUMAN/);
});

test("buildShardPrompt: isolation grants writes + an ABSOLUTE stream path; no isolation is READ-ONLY", () => {
  // Relative would land in the snapshot's own .pi/, where the main agent
  // never looks: the stream would appear to work and deliver nothing.
  const isolated = buildShardPrompt(
    { label: "shard-1", files: ["src/a.ts"], note: "1 file(s)" },
    undefined,
    undefined,
    { streamPath: "/repo/.pi/review-stream/run-shard-1.jsonl" },
  );
  assert.match(isolated, /STREAM YOUR FINDINGS AS YOU CONFIRM THEM/);
  assert.match(isolated, /\/repo\/\.pi\/review-stream\/run-shard-1\.jsonl/);
  assert.match(isolated, /NEVER put a verdict in the stream/);
  assert.match(isolated, /disposable snapshot worktree/);
  assert.match(isolated, /You may edit files and run tests freely/);

  // REGRESSION: without a snapshot the reviewer is in the USER'S worktree and
  // the engine-level denylist only removes edit/write TOOLS — bash stays. A
  // prompt that still promised "disposable copy, edit freely" turned that into
  // a fail-open: the reviewer would rewrite the user's files through bash.
  const bare = buildShardPrompt({ label: "shard-1", files: ["src/a.ts"], note: "1 file(s)" });
  assert.doesNotMatch(bare, /STREAM YOUR FINDINGS/);
  assert.doesNotMatch(bare, /You may edit files/);
  assert.match(bare, /USER'S LIVE WORKTREE/);
  assert.match(bare, /Do NOT edit any file/);
  assert.match(bare, /read-only inspection only/);
});

test("REGRESSION: no pre-baked diff is ever pasted into a shard prompt", () => {
  // The reviewer holds a SNAPSHOT of the change, so it reads the real thing with
  // `git diff HEAD`. The old path pasted a per-shard diff "for orientation" that
  // could already have drifted; the field and the prompt block are gone, and
  // this test keeps them gone.
  const prompt = buildShardPrompt(
    { label: "shard-1", files: ["src/a.ts"], note: "1 file(s)" },
    undefined,
    undefined,
    { streamPath: "/repo/.pi/review-stream/r-shard-1.jsonl" },
  );
  assert.doesNotMatch(prompt, /Diff context/);
  assert.doesNotMatch(prompt, /```diff/);
  assert.doesNotMatch(prompt, /the diff may have drifted/);
  // The replacement instruction has to be there instead.
  assert.match(prompt, /disposable snapshot worktree/);
});

test("shouldShardReview triggers on file count threshold", () => {
  assert.equal(shouldShardReview(SHARD_THRESHOLD_FILES - 1, 0), false);
  assert.equal(shouldShardReview(SHARD_THRESHOLD_FILES, 0), true);
  assert.equal(shouldShardReview(SHARD_THRESHOLD_FILES + 1, 0), true);
});

test("shouldShardReview triggers on line count threshold", () => {
  assert.equal(shouldShardReview(1, SHARD_THRESHOLD_LINES - 1), false);
  assert.equal(shouldShardReview(1, SHARD_THRESHOLD_LINES), true);
  assert.equal(shouldShardReview(1, SHARD_THRESHOLD_LINES + 1), true);
});

test("shouldShardReview returns false when both counts are below thresholds", () => {
  assert.equal(shouldShardReview(5, 100), false);
  assert.equal(shouldShardReview(0, 0), false);
});

// (`generateShardReviewScript` tests removed with the engine review path: no
// workflow script is generated for reviews any more. The shard PLAN and the
// per-shard PROMPT are still pure and tested above; dispatch is now
// prepare_review + subagents, covered in test/extension-structure.test.ts.)

test("SHARD_VERDICT_SCHEMA is the shape handed to a spawned reviewer", () => {
  // It replaced `parseShardVerdict`: the engine used to parse structured results
  // itself, whereas a spawned reviewer is given this as its `outputSchema` and
  // the gate parses the recorded fence with lib/verdict-parse.ts. Keeping a
  // second parser around would be dead code.
  const schema = SHARD_VERDICT_SCHEMA as unknown as {
    properties: Record<string, unknown> & {
      gate: { enum: readonly string[] };
      findings: { items: { required: readonly string[] } };
    };
    required: readonly string[];
  };
  assert.deepEqual([...schema.properties.gate.enum], ["READY", "BLOCKED", "NEEDS_HUMAN"]);
  assert.deepEqual([...schema.properties.findings.items.required], ["file", "line", "severity", "issue"]);
  assert.ok(schema.required.includes("gate"), "a verdict without a gate is not a verdict");
  // No docSync on a shard verdict: only the integration reviewer attests docs.
  assert.equal("docSync" in schema.properties, false);
});

test("the verdict must carry the reviewer's REAL cwd (second proof of isolation)", () => {
  // Evidence, not decoration: the gate matches this against the snapshot it
  // prepared, which is how a reviewer that ran in the live worktree — or was
  // pointed correctly and then `cd`-ed away — stops being able to approve.
  const schema = SHARD_VERDICT_SCHEMA as unknown as {
    properties: Record<string, { description?: string }>;
    required: readonly string[];
  };
  assert.ok(schema.required.includes("cwd"), "an optional cwd is the one models would omit");
  assert.match(schema.properties.cwd.description ?? "", /pwd/);

  const prompt = buildShardPrompt(
    { label: "shard-1", files: ["src/a.ts"], note: "1 file(s)" },
    undefined,
    undefined,
    { streamPath: "/repo/.pi/review-stream/run-shard-1.jsonl" },
  );
  // A copied path proves nothing about where the review happened, so the
  // prompt has to demand a measured one.
  assert.match(prompt, /run `pwd`/);
  assert.match(prompt, /do NOT copy the path out of this task text/i);
  assert.match(prompt, /"cwd": "<your real pwd>"/);
  assert.match(prompt, /gate checks it against the snapshot prepared for you/);

  // …and the NO-isolation branch must not promise a check that cannot happen:
  // it just told the reviewer there is no snapshot this round.
  const bare = buildShardPrompt({ label: "shard-1", files: ["src/a.ts"], note: "1 file(s)" });
  assert.match(bare, /run `pwd`/, "the pwd is still recorded without isolation");
  assert.doesNotMatch(bare, /the snapshot prepared for you/,
    "promising a snapshot check with no snapshot contradicts the same prompt");
  assert.match(bare, /gate does not match it against one/);
});

test("formatShardReviewRecord joins every shard and wraps bare JSON in a fence", () => {
  const record = formatShardReviewRecord([
    { label: "shard-1", output: '{"gate":"READY","findings":[]}' },
    { label: "shard-2", output: '```json\n{"gate":"BLOCKED","findings":[]}\n```' },
  ]);
  assert.match(record, /### shard-1/);
  assert.match(record, /### shard-2/);
  assert.match(record, /BLOCKED/);
  assert.match(record, /---/);
  // record_review only parses fenced JSON: bare shard output must be wrapped,
  // already-fenced output must not be double-wrapped.
  assert.match(record, /```json/);
  assert.equal(record.match(/```/g)!.length, 4, "exactly two fences (one per shard)");
});

test("REGRESSION: this module is PURE — no engine, no snapshots, no I/O", () => {
  // Review dispatch moved out of here on purpose: the engine dropped per-agent
  // cwd, so isolation had to move to the caller (prepare_review + subagents).
  // If engine or filesystem coupling ever comes back into this file, the shard
  // path silently regains the collisions that made reviewer writes unsafe.
  const src = readFileSync(join(ROOT, "lib", "parallel-review.ts"), "utf8");
  for (const gone of [
    "runParallelShardReview",
    "generateShardReviewScript",
    "pdw-bridge",
    "pdw-progress",
    "createReviewSnapshot",
    "excludeTools",
  ]) {
    // The explanatory comment names them; only real CODE references matter.
    const codeLines = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    assert.equal(
      codeLines.some((l) => l.includes(gone)),
      false,
      `${gone} must not be referenced by code in the pure review-planning module`,
    );
  }
  // What must remain: the tiered threshold, the planner, the prompt, the verdict
  // SCHEMA (handed to each spawned reviewer as its outputSchema) and the record
  // merger. `parseShardVerdict` / `DEFAULT_REVIEWER_MODEL` are deliberately gone
  // — the engine parsed structured results and needed a model spec; a spawned
  // reviewer's verdict is parsed by lib/verdict-parse.ts and its model comes
  // from the pinned agent definition.
  for (const kept of [
    "export function shouldShardReview",
    "export function planReviewShards",
    "export function buildShardPrompt",
    "export const SHARD_VERDICT_SCHEMA",
    "export function formatShardReviewRecord",
  ]) {
    assert.ok(src.includes(kept), `${kept} must survive the engine removal`);
  }
  for (const goneToo of ["export function parseShardVerdict", "DEFAULT_REVIEWER_MODEL ="]) {
    assert.equal(src.includes(goneToo), false, `${goneToo} is dead after the engine removal`);
  }
});

test("REGRESSION: wave workers stay strictly read-only (bash included)", () => {
  // Scope guard for the shard-review unban: patch-first waves depend on
  // workers producing diffs, never touching the worktree. The engine-level
  // denylist is gone (docs/handoff-remove-pdw.md step 2), so the worker's
  // read-only-ness must live in the static agent definition — pi-subagents
  // has no per-call tool denylist.
  const worker = readFileSync(join(ROOT, "agents", "worker-readonly.md"), "utf8");
  const toolsLine = worker.split(/\r?\n/).find((l) => l.startsWith("tools:")) ?? "";
  assert.match(toolsLine, /\bread\b/, "the worker must be able to read the worklog and code");
  for (const forbidden of ["bash", "edit", "write"]) {
    assert.doesNotMatch(toolsLine, new RegExp(`\\b${forbidden}\\b`, "i"),
      `worker-readonly must not list ${forbidden}`);
  }
  // The engine's old denylist must not linger in lib/plan-parallel.ts either.
  const src = readFileSync(join(ROOT, "lib", "plan-parallel.ts"), "utf8");
  const codeLines = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  assert.equal(
    codeLines.some((l) => l.includes("excludeTools") || l.includes("pdw-bridge")),
    false,
    "engine coupling must not come back into the wave layer",
  );
});
