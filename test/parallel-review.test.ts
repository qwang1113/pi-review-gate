import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SHARD_THRESHOLD_FILES,
  SHARD_THRESHOLD_LINES,
  shouldShardReview,
  DEFAULT_REVIEWER_MODEL,
  buildShardPrompt,
  formatShardReviewRecord,
  generateShardReviewScript,
  parseShardVerdict,
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

test("buildShardPrompt names the shard files and forbids edits", () => {
  const prompt = buildShardPrompt(
    { label: "shard-1", files: ["src/a.ts", "src/b.ts"], note: "2 file(s)" },
    "criterion 1: tests pass",
  );
  assert.match(prompt, /shard-1/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /src\/b\.ts/);
  assert.match(prompt, /Do NOT edit any file/);
  assert.match(prompt, /no docSync field/);
  assert.match(prompt, /criterion 1: tests pass/);
  assert.match(prompt, /READY.*BLOCKED.*NEEDS_HUMAN/);
});

test("buildShardPrompt includes diff context when shard.diff is provided", () => {
  const prompt = buildShardPrompt(
    { label: "shard-1", files: ["src/a.ts"], note: "1 file(s)", diff: "@@ -1,3 +1,4 @@\n+added line" },
  );
  assert.match(prompt, /Diff context/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /@@ -1,3 \+1,4 @@/);
  assert.match(prompt, /for reference only/);
  assert.match(prompt, /the diff may have drifted/);
});

test("buildShardPrompt does NOT include diff section when shard.diff is absent", () => {
  const prompt = buildShardPrompt(
    { label: "shard-1", files: ["src/a.ts"], note: "1 file(s)" },
  );
  assert.doesNotMatch(prompt, /Diff context/);
  assert.doesNotMatch(prompt, /```diff/);
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

test("generateShardReviewScript embeds prompts, model and schema", () => {
  const script = generateShardReviewScript({
    shards: [
      { label: "shard-1", files: ["a.ts"], note: "1 file(s)" },
      { label: "shard-2", files: ["b.ts"], note: "1 file(s)" },
    ],
    model: "claude-opus-5:max",
  });
  assert.match(script, /parallel\(shardDefs\.map/);
  assert.match(script, /agent\(def\.prompt/);
  // No agentType binding: the shard prompt itself carries the reviewer role.
  // Binding agents/reviewer.md (systemPromptMode: replace) made pdw load the
  // full agent definition — its pinned model overrode the resolved one and
  // the call hung/failed (reproduced). The engine-level excludeTools list is
  // the write protection.
  assert.doesNotMatch(script, /agentType/);
  assert.match(script, /claude-opus-5:max/);
  assert.match(script, /shard-1/);
  assert.match(script, /shard-2/);
  assert.match(script, /VERDICT_SCHEMA/);
  // Default model constant is wired in when omitted.
  const defaultScript = generateShardReviewScript({ shards: [] });
  assert.match(defaultScript, new RegExp(DEFAULT_REVIEWER_MODEL.replace(":", "\\:")));
});

test("parseShardVerdict accepts valid verdicts and rejects malformed ones", () => {
  const verdict = parseShardVerdict({
    gate: "BLOCKED",
    findings: [
      { file: "src/x.ts", line: 3, severity: "P1", issue: "swallowed error" },
    ],
  });
  assert.ok(verdict);
  assert.equal(verdict!.gate, "BLOCKED");
  assert.equal(verdict!.findings.length, 1);
  // Unknown gate → null (a shard that did not produce a usable verdict).
  assert.equal(parseShardVerdict({ gate: "MAYBE", findings: [] }), null);
  assert.equal(parseShardVerdict(null), null);
  assert.equal(parseShardVerdict("READY"), null);
  // Findings with a bad severity are dropped, not fatal.
  const partial = parseShardVerdict({
    gate: "READY",
    findings: [
      { file: "a", line: 1, severity: "P1", issue: "ok" },
      { file: "b", line: 2, severity: "P9", issue: "bad severity" },
    ],
  });
  assert.ok(partial);
  assert.equal(partial!.findings.length, 1);
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
