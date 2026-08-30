/**
 * The checkpoint commit message is a pure function of the agent's round note,
 * and the marker goes into the SCOPE (user decision, 2026-08-31) so the result
 * is a legal Conventional Commit — `checkpoint: fix(x): y` was not one.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { injectCheckpointScope, buildCheckpointMessage } from "../lib/checkpoint-message.ts";

test("injectCheckpointScope — a subject WITH a scope keeps it, prefixed", () => {
  assert.equal(
    injectCheckpointScope("fix(orchestrator): stop waking the human"),
    "fix(checkpoint-orchestrator): stop waking the human",
  );
});

test("injectCheckpointScope — a subject WITHOUT a scope gets `(checkpoint)`", () => {
  assert.equal(
    injectCheckpointScope("docs: repair markdown tables"),
    "docs(checkpoint): repair markdown tables",
  );
});

test("injectCheckpointScope — a NON-Conventional subject becomes chore(checkpoint)", () => {
  assert.equal(
    injectCheckpointScope("record this round for review"),
    "chore(checkpoint): record this round for review",
  );
});

test("injectCheckpointScope — already-marked scopes are idempotent", () => {
  // Exactly `checkpoint`.
  assert.equal(
    injectCheckpointScope("docs(checkpoint): x"),
    "docs(checkpoint): x",
  );
  // `checkpoint-<scope>` (a re-injection would double it).
  assert.equal(
    injectCheckpointScope("fix(checkpoint-orchestrator): y"),
    "fix(checkpoint-orchestrator): y",
  );
});

test("injectCheckpointScope — a breaking `!` marker is preserved", () => {
  assert.equal(
    injectCheckpointScope("feat(api)!: drop v1"),
    "feat(checkpoint-api)!: drop v1",
  );
  assert.equal(
    injectCheckpointScope("feat!: drop v1"),
    "feat(checkpoint)!: drop v1",
  );
});

test("buildCheckpointMessage — a legal CC becomes a legal checkpoint CC", () => {
  const msg = buildCheckpointMessage("fix(orchestrator): stop waking the human");
  assert.equal(msg, "fix(checkpoint-orchestrator): stop waking the human");
  // Every produced subject is a legal Conventional Commit: exactly one colon
  // after the type/scope, and `checkpoint` never appears as a bare type.
  assert.doesNotMatch(msg, /^checkpoint:/);
});

test("buildCheckpointMessage — an English body is kept under the marked subject", () => {
  const msg = buildCheckpointMessage("docs: repair tables\n\nthe pipe broke the render");
  assert.equal(msg, "docs(checkpoint): repair tables\n\nthe pipe broke the render");
});

test("buildCheckpointMessage — a Chinese note falls back to the English default, body dropped", () => {
  const msg = buildCheckpointMessage("修复表格渲染\n\n管道符破坏了表格");
  // No non-Latin letter survives into the message (L5 would refuse it).
  assert.equal(msg, "chore(checkpoint): record this round for review");
});

test("buildCheckpointMessage — an English subject with a Chinese body drops only the body", () => {
  const msg = buildCheckpointMessage("fix(gate): guard the merge\n\n这里解释为什么");
  assert.equal(msg, "fix(checkpoint-gate): guard the merge");
});
