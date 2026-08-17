/**
 * Streaming findings — the parser's authority boundary.
 *
 * The whole point of the stream is that the main agent may ACT on it before
 * the verdict exists. That is only safe while a stream line can never become
 * a decision, so the "no verdict keys" rule is pinned here from every angle,
 * together with the evidence/severity filter that decides what is worth
 * fixing early.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONABLE_SEVERITIES,
  VERDICT_KEYS,
  actionableFindings,
  buildStreamConsumerDirective,
  buildStreamDirective,
  parseStream,
  parseStreamLine,
} from "../lib/review-stream.ts";

const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

test("a well-formed finding parses with all fields", () => {
  const { finding, reason } = parseStreamLine(
    line({
      id: "f1",
      severity: "P1",
      file: "lib/a.ts",
      line: 12,
      issue: "off-by-one",
      evidence: "loop runs to <= len",
    }),
  );
  assert.equal(reason, undefined);
  assert.deepEqual(finding, {
    id: "f1",
    severity: "P1",
    location: "lib/a.ts:12",
    issue: "off-by-one",
    evidence: "loop runs to <= len",
  });
});

test("REGRESSION: a verdict-shaped line is REFUSED, never sanitized", () => {
  // This is the one rule that keeps a partial stream from becoming a recorded
  // decision. Accepting a cleaned copy would hide the protocol violation.
  for (const key of VERDICT_KEYS) {
    const { finding, reason } = parseStreamLine(line({ issue: "x", evidence: "y", [key]: "READY" }));
    assert.equal(finding, undefined, `${key} must not yield a finding`);
    assert.match(reason ?? "", new RegExp(`"${key}"`));
    assert.match(reason ?? "", /evidence, never a decision/);
  }
});

test("a stream carrying a verdict fence contributes NO findings and reports why", () => {
  const text = [
    line({ id: "a", severity: "P1", issue: "real", evidence: "seen" }),
    line({ gate: "READY", findings: [] }),
  ].join("\n");
  const { findings, rejected } = parseStream(text);
  assert.deepEqual(findings.map((f) => f.id), ["a"]);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason, /gate/);
});

test("malformed lines are reported, not silently dropped", () => {
  const { findings, rejected } = parseStream(["not json", "[]", "{}", ""].join("\n"));
  assert.deepEqual(findings, []);
  assert.deepEqual(rejected.map((r) => r.reason), ["not JSON", "not a JSON object", "no issue text"]);
});

test("a re-emitted finding is delivered once (no double fixing)", () => {
  const same = line({ id: "dup", severity: "P0", issue: "boom", evidence: "stack" });
  const { findings } = parseStream([same, same, same].join("\n"));
  assert.equal(findings.length, 1);
});

test("missing fields degrade instead of failing the line", () => {
  const { finding } = parseStreamLine(line({ issue: "something" }));
  assert.equal(finding?.severity, "Note", "unsevered findings default to the weakest class");
  assert.equal(finding?.evidence, "");
  assert.ok(finding?.id.includes("something"), "an id is derived so dedup still works");
});

test("actionable = P0/P1/P2 AND carries evidence", () => {
  const findings = parseStream(
    [
      line({ id: "p0", severity: "P0", issue: "a", evidence: "proof" }),
      line({ id: "p2", severity: "p2", issue: "b", evidence: "proof" }), // case-insensitive
      line({ id: "nit", severity: "Nit", issue: "c", evidence: "proof" }),
      line({ id: "hunch", severity: "P1", issue: "might race" }), // no evidence
    ].join("\n"),
  ).findings;
  assert.deepEqual(actionableFindings(findings).map((f) => f.id), ["p0", "p2"]);
  // Nits and evidence-free hunches are exactly the items reviewers withdraw.
  assert.deepEqual(ACTIONABLE_SEVERITIES, ["P0", "P1", "P2"]);
});

test("the reviewer directive demands an absolute path and forbids verdicts", () => {
  const text = buildStreamDirective("/abs/repo/.pi/review-stream/run-shard-1.jsonl");
  assert.match(text, /\/abs\/repo\/\.pi\/review-stream\/run-shard-1\.jsonl/);
  assert.match(text, /the moment a finding is CONFIRMED/);
  assert.match(text, /NEVER put a verdict in the stream/);
  assert.match(text, /final output must still contain EVERY finding/);
});

test("the consumer directive pins the cadence and the fix discipline", () => {
  const text = buildStreamConsumerDirective(["/abs/a.jsonl", "/abs/b.jsonl"]);
  assert.match(text, /\/abs\/a\.jsonl/);
  assert.match(text, /\/abs\/b\.jsonl/);
  assert.match(text, /Never poll in a tight loop/);
  assert.match(text, /confirm the finding\s+yourself first/);
  assert.match(text, /Leave Nits until the verdict lands/);
  // It must state the consequence of fixing mid-review rather than hide it —
  // and state it as ENFORCED, because it is (the stale-tree comparison in
  // record_review). The earlier wording promised a round that no code produced.
  assert.match(text, /ENFORCES the consequence/);
  assert.match(text, /STALE TREE/);
  assert.match(text, /recorded as BLOCKED/);
  assert.match(text, /Stream lines are never a verdict/);
});
