/**
 * The checkpoint commit message is a pure function of the agent's round note,
 * and it no longer marks the commit as a checkpoint (user decision,
 * 2026-09-16): the history reads as ordinary work, so a checkpoint is
 * `fix(gate): x`, not `fix(checkpoint-gate): x`. The one job left is that the
 * subject is a legal Conventional Commit even when the agent's note is not.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ensureConventionalSubject, buildCheckpointMessage } from "../lib/checkpoint-message.ts";

test("ensureConventionalSubject — a legal subject is returned UNCHANGED, scope and all", () => {
  assert.equal(
    ensureConventionalSubject("fix(orchestrator): stop waking the human"),
    "fix(orchestrator): stop waking the human",
  );
  assert.equal(
    ensureConventionalSubject("docs: repair markdown tables"),
    "docs: repair markdown tables",
  );
  // The regression this replaced: `checkpoint` used to be injected here.
  assert.equal(
    ensureConventionalSubject("fix(gate): guard the merge"),
    "fix(gate): guard the merge",
  );
  assert.doesNotMatch(ensureConventionalSubject("fix(gate): x"), /checkpoint/);
});

test("ensureConventionalSubject — a breaking `!` marker is preserved", () => {
  assert.equal(ensureConventionalSubject("feat(api)!: drop v1"), "feat(api)!: drop v1");
  assert.equal(ensureConventionalSubject("feat!: drop v1"), "feat!: drop v1");
});

test("ensureConventionalSubject — a NON-Conventional subject becomes chore", () => {
  assert.equal(
    ensureConventionalSubject("record this round for review"),
    "chore: record this round for review",
  );
});

test("buildCheckpointMessage — a legal CC stays exactly as written", () => {
  const msg = buildCheckpointMessage("fix(orchestrator): stop waking the human");
  assert.equal(msg, "fix(orchestrator): stop waking the human");
  assert.doesNotMatch(msg, /checkpoint/);
  // Exactly one colon after the type/scope — never a bare `checkpoint:` type.
  assert.doesNotMatch(msg, /^checkpoint:/);
});

test("buildCheckpointMessage — an English body is kept under the subject", () => {
  const msg = buildCheckpointMessage("docs: repair tables\n\nthe pipe broke the render");
  assert.equal(msg, "docs: repair tables\n\nthe pipe broke the render");
});

test("buildCheckpointMessage — a Chinese note falls back to the English default, body dropped", () => {
  const msg = buildCheckpointMessage("修复表格渲染\n\n管道符破坏了表格");
  // No non-Latin letter survives into the message (L5 would refuse it).
  assert.equal(msg, "chore: record this round for review");
});

test("buildCheckpointMessage — an English subject with a Chinese body drops only the body", () => {
  const msg = buildCheckpointMessage("fix(gate): guard the merge\n\n这里解释为什么");
  assert.equal(msg, "fix(gate): guard the merge");
});

test("L5 drops a Chinese justification from the message — the dep gate reads the NOTE, not the message", () => {
  // The contract (dependency-justification.ts): note first (agent's own
  // words, verbatim), message second (may carry an English restatement).
  const note = "新增 uuid，因为现有代码里没有可用的唯一 id 生成";
  const message = buildCheckpointMessage(note);
  assert.ok(!message.includes("因为"), "L5 drops the Chinese justification from the message");
  assert.ok(note.includes("因为"), "…so the gate must be fed the note (wired: note: input.note plumbs it)");
});
