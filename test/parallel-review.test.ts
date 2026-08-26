import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import {
  REVIEW_VERDICT_SCHEMA,
  buildReviewPrompt,
} from "../lib/parallel-review.ts";

test("buildReviewPrompt names the changed files and sets the snapshot contract", () => {
  const prompt = buildReviewPrompt(
    "review",
    ["src/a.ts", "src/b.ts"],
    "criterion 1: tests pass",
    undefined,
    { streamPath: "/repo/.pi/review-stream/r-review.jsonl" },
  );
  assert.match(prompt, /Audit the WHOLE change/);
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
  assert.match(prompt, /docSync is REQUIRED on the single-review path/);
  assert.match(prompt, /criterion 1: tests pass/);
  assert.match(prompt, /READY.*BLOCKED.*NEEDS_HUMAN/);
});

test("buildReviewPrompt: isolation grants writes + an ABSOLUTE stream path; no isolation is READ-ONLY", () => {
  // Relative would land in the snapshot's own .pi/, where the main agent
  // never looks: the stream would appear to work and deliver nothing.
  const isolated = buildReviewPrompt(
    "review",
    ["src/a.ts"],
    undefined,
    undefined,
    { streamPath: "/repo/.pi/review-stream/run-review.jsonl" },
  );
  assert.match(isolated, /STREAM YOUR FINDINGS AS YOU CONFIRM THEM/);
  assert.match(isolated, /\/repo\/\.pi\/review-stream\/run-review\.jsonl/);
  assert.match(isolated, /NEVER put a verdict in the stream/);
  assert.match(isolated, /disposable snapshot worktree/);
  assert.match(isolated, /You may edit files and run tests freely/);

  // REGRESSION: without a snapshot the reviewer is in the USER'S worktree and
  // the engine-level denylist only removes edit/write TOOLS — bash stays. A
  // prompt that still promised "disposable copy, edit freely" turned that into
  // a fail-open: the reviewer would rewrite the user's files through bash.
  const bare = buildReviewPrompt("review", ["src/a.ts"]);
  assert.doesNotMatch(bare, /STREAM YOUR FINDINGS/);
  assert.doesNotMatch(bare, /You may edit files/);
  assert.match(bare, /USER'S LIVE WORKTREE/);
  assert.match(bare, /Do NOT edit any file/);
  assert.match(bare, /read-only inspection only/);
});

test("REGRESSION: no pre-baked diff is ever pasted into a review prompt", () => {
  // The reviewer holds a SNAPSHOT of the change, so it reads the real thing with
  // `git diff HEAD`. The old path pasted a per-shard diff "for orientation" that
  // could already have drifted; the field and the prompt block are gone, and
  // this test keeps them gone.
  const prompt = buildReviewPrompt(
    "review",
    ["src/a.ts"],
    undefined,
    undefined,
    { streamPath: "/repo/.pi/review-stream/r-review.jsonl" },
  );
  assert.doesNotMatch(prompt, /Diff context/);
  assert.doesNotMatch(prompt, /```diff/);
  assert.doesNotMatch(prompt, /the diff may have drifted/);
  // The replacement instruction has to be there instead.
  assert.match(prompt, /disposable snapshot worktree/);
});

test("REVIEW_VERDICT_SCHEMA is the shape handed to a spawned reviewer", () => {
  const schema = REVIEW_VERDICT_SCHEMA as unknown as {
    properties: Record<string, unknown> & {
      gate: { enum: readonly string[] };
      findings: { items: { required: readonly string[] } };
    };
    required: readonly string[];
  };
  assert.deepEqual([...schema.properties.gate.enum], ["READY", "BLOCKED", "NEEDS_HUMAN"]);
  assert.deepEqual([...schema.properties.findings.items.required], ["file", "line", "severity", "issue"]);
  assert.ok(schema.required.includes("gate"), "a verdict without a gate is not a verdict");
  // docSync IS on the schema: on the single-review path the reviewer itself
  // must attest code↔docs (there is no second reviewer to carry it).
  assert.equal("docSync" in schema.properties, true);
  assert.ok(schema.required.includes("docSync"), "docSync must be required")
});

test("the verdict must carry the reviewer's REAL cwd (second proof of isolation)", () => {
  // Evidence, not decoration: the gate matches this against the snapshot it
  // prepared, which is how a reviewer that ran in the live worktree — or was
  // pointed correctly and then `cd`-ed away — stops being able to approve.
  const schema = REVIEW_VERDICT_SCHEMA as unknown as {
    properties: Record<string, { description?: string }>;
    required: readonly string[];
  };
  assert.ok(schema.required.includes("cwd"), "an optional cwd is the one models would omit");
  assert.match(schema.properties.cwd.description ?? "", /pwd/);

  const prompt = buildReviewPrompt(
    "review",
    ["src/a.ts"],
    undefined,
    undefined,
    { streamPath: "/repo/.pi/review-stream/run-review.jsonl" },
  );
  // A copied path proves nothing about where the review happened, so the
  // prompt has to demand a measured one.
  assert.match(prompt, /run `pwd`/);
  assert.match(prompt, /do NOT copy the path out of this task text/i);
  assert.match(prompt, /"cwd": "<your real pwd>"/);
  assert.match(prompt, /gate checks it against the snapshot prepared for you/);

  // …and the NO-isolation branch must not promise a check that cannot happen:
  // it just told the reviewer there is no snapshot this round.
  const bare = buildReviewPrompt("review", ["src/a.ts"]);
  assert.match(bare, /run `pwd`/, "the pwd is still recorded without isolation");
  assert.doesNotMatch(bare, /the snapshot prepared for you/,
    "promising a snapshot check with no snapshot contradicts the same prompt");
  assert.match(bare, /gate does not match it against one/);
});

test("REGRESSION: this module is PURE — no engine, no snapshots, no I/O, no sharding", () => {
  // Review dispatch moved out of here on purpose: the engine dropped per-agent
  // cwd, so isolation had to move to the caller (prepare_review + subagents).
  // If engine or filesystem coupling ever comes back into this file, the
  // review path silently regains the collisions that made reviewer writes
  // unsafe. And the single-review contract has NO sharding left to plan.
  const src = readFileSync(join(ROOT, "lib", "parallel-review.ts"), "utf8");
  for (const gone of [
    "runParallelShardReview",
    "generateShardReviewScript",
    "pdw-bridge",
    "pdw-progress",
    "createReviewSnapshot",
    "excludeTools",
    "planReviewShards",
    "shouldShardReview",
    "SHARD_THRESHOLD",
    "formatShardReviewRecord",
    "buildShardPrompt",
    "SHARD_VERDICT_SCHEMA",
    "ShardVerdict",
    "shard",
  ]) {
    // The explanatory comment may name them; only real CODE references matter.
    const codeLines = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    assert.equal(
      codeLines.some((l) => l.includes(gone)),
      false,
      `${gone} must not be referenced by code in the pure review-contract module`,
    );
  }
  // What must remain: the single-review prompt and the verdict SCHEMA handed
  // to the spawned reviewer as its outputSchema.
  for (const kept of [
    "export interface ReviewVerdict",
    "export const REVIEW_VERDICT_SCHEMA",
    "export function buildReviewPrompt",
  ]) {
    assert.ok(src.includes(kept), `${kept} must survive the engine removal`);
  }
});
