import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import {
  REVIEW_VERDICT_SCHEMA,
  buildReviewPrompt,
  formatPrecommitBaseline,
  extractPrecommitBaseline,
} from "../lib/parallel-review.ts";

test("buildReviewPrompt names the changed files and sets the COMMIT contract", () => {
  const prompt = buildReviewPrompt(
    "review",
    ["src/a.ts", "src/b.ts"],
    "criterion 1: tests pass",
    undefined,
    { streamPath: "/repo/.pi/review-stream/r-review.jsonl", commitRange: "abc123..def456" },
  );
  assert.match(prompt, /Audit the COMMIT RANGE abc123\.\.def456/);
  assert.match(prompt, /src\/a\.ts/);
  assert.match(prompt, /src\/b\.ts/);
  // The change under review is immutable history; the judge never writes.
  assert.match(prompt, /no edit\/write tools/);
  assert.match(prompt, /THROWAWAY worktree under \$TMPDIR/);
  assert.match(prompt, /ADVISORY/);
  // Shipping stays out of a reviewer's hands.
  assert.match(prompt, /Never run git commit\/push/);
  assert.match(prompt, /docSync is REQUIRED on the single-review path/);
  assert.match(prompt, /criterion 1: tests pass/);
  assert.match(prompt, /READY.*BLOCKED.*NEEDS_HUMAN/);
  assert.doesNotMatch(prompt, /完成信号/); // no channel → no signal instruction
});

test("round-16 P1: the done channel is embedded at the end of the reviewer task", () => {
  const prompt = buildReviewPrompt(
    "review",
    ["src/a.ts"],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "rg-review-abc123-done",
  );
  assert.match(prompt, /完成信号/);
  assert.match(prompt, /tmux wait-for -S rg-review-abc123-done/);
  // The instruction is at the END (after the OUTPUT/verdict contract).
  assert.ok(prompt.indexOf("tmux wait-for -S rg-review-abc123-done") > prompt.indexOf("Verdict shape"));

test("round-16 P2: the inbox question channel is embedded at the end of the reviewer task", () => {
  const prompt = buildReviewPrompt(
    "review",
    ["src/a.ts"],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "rg-review-abc123-done",
    { path: "/repo/.pi/tmux-sessions/rg-review-abc123/inbox.jsonl", channel: "rg-review-abc123-inbox" },
  );
  assert.match(prompt, /提问通道/);
  assert.match(prompt, /\/repo\/\.pi\/tmux-sessions\/rg-review-abc123\/inbox\.jsonl/);
  assert.match(prompt, /tmux wait-for -S rg-review-abc123-inbox/);
  // The channel is the FULL derived value (inboxChannelFor(title)) — never
  // literal "<channel>-inbox" concatenation (double-suffix trap).
  assert.match(prompt, /rg-review-abc123-inbox/);
  assert.doesNotMatch(prompt, /wait-for -S <channel>-inbox/);
  // No inbox param → no question-path instruction.
  const plain = buildReviewPrompt("review", [], undefined, undefined, undefined, undefined, undefined, undefined, undefined);
  assert.doesNotMatch(plain, /提问通道/);
  // Round-17: output discipline is part of the task text.
  assert.match(prompt, /输出纪律:verdict fence 在最前,其后最多 5 行结论要点/, "the discipline is pinned in the task");
});
});

test("buildReviewPrompt: isolation grants writes + an ABSOLUTE stream path; no isolation is READ-ONLY", () => {
  // Relative would land in the snapshot's own .pi/, where the main agent
  // never looks: the stream would appear to work and deliver nothing.
  const isolated = buildReviewPrompt(
    "review",
    ["src/a.ts"],
    undefined,
    undefined,
    { streamPath: "/repo/.pi/review-stream/run-review.jsonl", commitRange: "abc123..def456" },
  );
  assert.match(isolated, /STREAM YOUR FINDINGS AS YOU CONFIRM THEM/);
  assert.match(isolated, /\/repo\/\.pi\/review-stream\/run-review\.jsonl/);
  assert.match(isolated, /NEVER put a verdict in the stream/);
  assert.match(isolated, /abc123\.\.def456/);
  assert.match(isolated, /no edit\/write tools/);

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
    { streamPath: "/repo/.pi/review-stream/r-review.jsonl", commitRange: "abc123..def456" },
  );
  assert.doesNotMatch(prompt, /Diff context/);
  assert.doesNotMatch(prompt, /```diff/);
  assert.doesNotMatch(prompt, /the diff may have drifted/);
  // The replacement instruction has to be there instead.
  assert.match(prompt, /git show/);
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
    { streamPath: "/repo/.pi/review-stream/run-review.jsonl", commitRange: "abc123..def456" },
  );
  // A copied path proves nothing about where the review happened, so the
  // prompt has to demand a measured one.
  assert.match(prompt, /run `pwd`/);
  assert.match(prompt, /do NOT copy the path out of this task text/i);
  assert.match(prompt, /"cwd": "<your real pwd>"/);
  assert.match(prompt, /matches it against the pane it spawned you in/);

  // …and the NO-isolation branch must not promise a check that cannot happen:
  // it just told the reviewer there is no snapshot this round.
  const bare = buildReviewPrompt("review", ["src/a.ts"]);
  assert.match(bare, /run `pwd`/, "the pwd is still recorded without isolation");
  assert.doesNotMatch(bare, /pane it spawned you in/,
    "promising a pane check with no pane contradicts the same prompt");
  assert.match(bare, /does not match it against one/);
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

test("scopeDirective rides the task text when given (goal criterion 1)", () => {
  const scope =
    "Review scope for this round:\n- INCREMENTAL. small increment.\n- SETTLED last round — verdict READY.";
  const withScope = buildReviewPrompt("review", ["src/a.ts"], undefined, undefined, undefined, scope);
  assert.match(withScope, /Review scope for this round:/);
  assert.match(withScope, /INCREMENTAL/);
  assert.match(withScope, /SETTLED last round/);
  // The scope block is injected whole, not re-worded.
  assert.ok(withScope.includes(scope), "the directive is embedded verbatim");
  // Absent → the prompt says nothing about scope (round 1 / no baseline).
  const plain = buildReviewPrompt("review", ["src/a.ts"]);
  assert.doesNotMatch(plain, /Review scope for this round:/);
});

test("round-18: the polish-gate REASON rides the task text verbatim, absent when not given", () => {
  const reason = { reason: "把 P2 修干净再收尾", at: "2026-08-28T06:00:00.000Z", round: 4 };
  const withReason = buildReviewPrompt("review", ["src/a.ts"], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { path: "x", channel: "y" }, reason);
  assert.match(withReason, /REASON FOR THIS ROUND/);
  assert.match(withReason, /把 P2 修干净再收尾/);
  assert.match(withReason, /round 4/);
  const plain = buildReviewPrompt("review", ["src/a.ts"]);
  assert.doesNotMatch(plain, /REASON FOR THIS ROUND/, "no reason, no block");
});

test("opening instruction is scope-aware: incremental rounds audit the INCREMENT, full rounds the COMMIT RANGE (round-2/3 P1)", () => {
  const scope =
    "Review scope for this round:\n- INCREMENTAL. small increment.\n- SETTLED last round — verdict READY.";
  const incremental = buildReviewPrompt("review", ["src/a.ts"], undefined, undefined, undefined, scope, "incremental");
  assert.match(incremental, /Audit the INCREMENT/);
  assert.doesNotMatch(incremental, /Audit the WHOLE change/);
  assert.match(incremental, /consistency scan, not a re-derivation/);
  assert.match(incremental, /reopen any settled conclusion you can contradict with evidence/);
  // The changed-files list stays the full visible set — the increment narrows
  // FOCUS, never authority (non-goal: reviewer scope is guidance, not a fence).
  assert.match(incremental, /src\/a\.ts/);

  // REGRESSION (round-3 P1): a non-empty FULL directive must STILL open with
  // WHOLE — prepare_review always passes a formatted directive, even when
  // there is no READY baseline. Keying on the directive being non-empty made
  // every production round open with the INCREMENT wording.
  const fullDirective =
    "Review scope for this round:\n- FULL deep review. no previous READY review to build on — full deep review.";
  const full = buildReviewPrompt("review", ["src/a.ts"], undefined, undefined, undefined, fullDirective, "full");
  assert.match(full, /Audit the COMMIT RANGE baseline\.\.HEAD below/);
  assert.doesNotMatch(full, /Audit the INCREMENT/);

  // Absent scopeKind (older callers) still opens with the commit-range wording.
  const legacy = buildReviewPrompt("review", ["src/a.ts"], undefined, undefined, undefined, fullDirective);
  assert.match(legacy, /Audit the COMMIT RANGE baseline\.\.HEAD below/);
});

test("session pointer rides the task text when given (goal criterion 4)", () => {
  const withSession = buildReviewPrompt(
    "review",
    ["src/a.ts"],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { dir: "/home/u/.pi/agent/sessions/--repo--", id: "sess-1" },
  );
  assert.match(withSession, /Main session transcript/);
  assert.match(withSession, /--repo--/);
  assert.match(withSession, /sess-1/);
  assert.match(withSession, /ON DEMAND/);
  const plain = buildReviewPrompt("review", ["src/a.ts"]);
  assert.doesNotMatch(plain, /Main session transcript/);
});

test("formatPrecommitBaseline states what was verified and steers to targeted tests (user ask 2026-08-27)", () => {
  const block = formatPrecommitBaseline({
    verdict: "PASS",
    mode: "full",
    testScope: "full",
    at: "2026-08-27T00:00:00.000Z",
    steps: [
      { name: "typecheck", command: "npm run typecheck", status: "passed", durationMs: 3428 },
      { name: "test", command: "npm run test", status: "passed", durationMs: 131859 },
    ],
  });
  assert.match(block, /PRE-COMMIT BASELINE/);
  assert.match(block, /PASS \(mode full, tests full/);
  assert.match(block, /typecheck: passed — `npm run typecheck` \(3s\)/);
  assert.match(block, /test: passed — `npm run test` \(132s\)/);
  assert.match(block, /do NOT re-run the full suite or typecheck/);
  assert.match(block, /Run ONLY targeted tests/);
  assert.match(block, /re-run only that one step/);
  // The baseline rides the reviewer task text when given, absent otherwise.
  const withBaseline = buildReviewPrompt(
    "review",
    ["src/a.ts"],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    block,
  );
  assert.match(withBaseline, /PRE-COMMIT BASELINE/);
  const plain = buildReviewPrompt("review", ["src/a.ts"]);
  assert.doesNotMatch(plain, /PRE-COMMIT BASELINE/);
});

test("formatPrecommitBaseline: lane-aware wording — a fast/related PASS must not suppress verification (round-9 P1)", () => {
  const fast = formatPrecommitBaseline({
    verdict: "PASS",
    mode: "fast",
    testScope: "related",
    at: "2026-08-27T00:00:00.000Z",
    steps: [{ name: "test", command: "npm run test", status: "passed" }],
  });
  assert.doesNotMatch(fast, /do NOT re-run the full suite/);
  assert.match(fast, /related lane — it covered only the related tests/);
  assert.match(fast, /re-run the full suite or/);
  assert.match(fast, /only if you have reason to doubt the fast lane/);
  const full = formatPrecommitBaseline({
    verdict: "PASS",
    mode: "full",
    testScope: "full",
    at: "2026-08-27T00:00:00.000Z",
    steps: [],
  });
  assert.match(full, /TRUST IT — do NOT re-run the full suite or typecheck/);
});

test("extractPrecommitBaseline: behavioral safety — fingerprint match, stale-entry filter (round-10 P1)", () => {
  const pass = {
    verdict: "PASS",
    fingerprint: "fp1",
    mode: "full",
    testScope: "full",
    at: "2026-08-27T00:00:00.000Z",
  };
  const cache = JSON.stringify({
    schema: 1,
    entries: {
      typecheck: { command: "npm run typecheck", status: "pass", at: "2026-08-27T00:00:00.000Z" },
      test: { command: "npm run test", status: "pass", at: "2026-08-27T01:00:00.000Z" }, // AFTER the pass: stale
    },
  });
  // Matching fingerprint: baseline with only the pre-pass entry.
  const ok = extractPrecommitBaseline(pass, "fp1", cache);
  assert.ok(ok);
  assert.match(ok, /typecheck: passed/);
  assert.doesNotMatch(ok, /test: passed/, "an entry recorded after the PASS is stale and must be dropped");
  // Mismatched fingerprint (a PASS for an older tree): no baseline at all.
  assert.equal(extractPrecommitBaseline(pass, "fp2", cache), undefined);
  assert.equal(extractPrecommitBaseline(pass, undefined, cache), undefined);
  // Not a PASS: no baseline.
  assert.equal(extractPrecommitBaseline({ verdict: "FAIL", fingerprint: "fp1" }, "fp1", cache), undefined);
  // Corrupt cache body: the verdict line alone still yields a baseline.
  const degraded = extractPrecommitBaseline(pass, "fp1", "{broken");
  assert.ok(degraded);
  assert.match(degraded, /PRE-COMMIT BASELINE/);
});
