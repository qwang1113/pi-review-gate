import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOOP_GOAL_MAX_CHARS,
  LOOP_GOAL_MISSING_DIRECTIVE,
  LOOP_GOAL_RELPATH,
  LOOP_GOAL_STALE_MS,
  buildLoopGoalDirective,
  readLoopGoal,
} from "../lib/loop-goal.ts";

function repoWithGoal(content?: string, mtimeMs?: number): string {
  const root = mkdtempSync(join(tmpdir(), "loop-goal-"));
  if (content !== undefined) {
    mkdirSync(join(root, ".pi"), { recursive: true });
    const path = join(root, LOOP_GOAL_RELPATH);
    writeFileSync(path, content, "utf8");
    if (mtimeMs !== undefined) {
      const seconds = mtimeMs / 1000;
      utimesSync(path, seconds, seconds);
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// readLoopGoal

test("absent, missing-directory, and empty goal files all degrade to 'no goal' (never throw)", () => {
  const missing = repoWithGoal();
  const empty = repoWithGoal("   \n\t\n  ");
  try {
    for (const root of [missing, empty, join(missing, "does", "not", "exist")]) {
      const goal = readLoopGoal(root);
      assert.equal(goal.present, false);
      assert.equal(goal.text, "");
      assert.equal(goal.stale, false);
    }
  } finally {
    rmSync(missing, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a real goal file is read, trimmed, and reported as present", () => {
  const root = repoWithGoal("\n# Goal\n\n1. tests pass\n\n");
  try {
    const goal = readLoopGoal(root);
    assert.equal(goal.present, true);
    assert.equal(goal.text, "# Goal\n\n1. tests pass");
    assert.equal(goal.truncated, false);
    assert.equal(goal.stale, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized goal is capped so it cannot eat the prompt budget", () => {
  const root = repoWithGoal("x".repeat(LOOP_GOAL_MAX_CHARS + 500));
  try {
    const goal = readLoopGoal(root);
    assert.equal(goal.truncated, true);
    assert.ok(goal.text.startsWith("x".repeat(LOOP_GOAL_MAX_CHARS)));
    assert.match(goal.text, /truncated/);
    // The cap is on the goal TEXT; only the short marker may follow it.
    assert.ok(goal.text.length < LOOP_GOAL_MAX_CHARS + 100, "cap must bound the injected text");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truncation never splits a surrogate pair (no half-character in the prompt)", () => {
  // Land an emoji exactly across the cap boundary: cap-1 filler + "🙂".
  const root = repoWithGoal("y".repeat(LOOP_GOAL_MAX_CHARS - 1) + "\u{1F642}" + "tail");
  try {
    const goal = readLoopGoal(root);
    assert.equal(goal.truncated, true);
    const body = goal.text.split("\n…[truncated")[0];
    assert.equal(body, "y".repeat(LOOP_GOAL_MAX_CHARS - 1), "the dangling half of the pair must be dropped");
    assert.doesNotMatch(body, /[\uD800-\uDBFF]$/, "no lone high surrogate may survive");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staleness is flagged past 24h and not before (leftover goals must not be trusted silently)", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0);
  const fresh = repoWithGoal("# Goal", now - 60 * 60 * 1000);
  const old = repoWithGoal("# Goal", now - LOOP_GOAL_STALE_MS - 60_000);
  try {
    assert.equal(readLoopGoal(fresh, now).stale, false);
    assert.equal(readLoopGoal(old, now).stale, true);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildLoopGoalDirective

test("no goal ⇒ the Step 0 directive, with skills OPTIONAL and a skill-free fallback", () => {
  const root = repoWithGoal();
  const text = buildLoopGoalDirective(readLoopGoal(root));
  rmSync(root, { recursive: true, force: true });
  assert.equal(text, LOOP_GOAL_MISSING_DIRECTIVE);
  assert.match(text, /Step 0/);
  assert.match(text, new RegExp(LOOP_GOAL_RELPATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // The engineering skills are user-invoked accelerators, never a dependency:
  // the directive must name them AND carry the always-available fallback.
  assert.match(text, /\/to-spec/);
  assert.match(text, /\/to-tickets/);
  assert.match(text, /disable-model-invocation/);
  assert.match(text, /Fallback \(always available/);
  assert.match(text, /let the USER run it/);
});

test("a present goal is injected verbatim with the acceptance contract attached", () => {
  const text = buildLoopGoalDirective({
    present: true,
    text: "1. `node --test` passes",
    truncated: false,
    ageMs: 2 * 60 * 60 * 1000,
    stale: false,
  });
  assert.match(text, /1\. `node --test` passes/);
  assert.match(text, /updated 2h ago/);
  assert.match(text, /adviser/);
  assert.match(text, /reviewer/);
  assert.match(text, /P1 finding/);
  assert.doesNotMatch(text, /older than 24h/);
  // The file content is repo data, not gate instructions: it must be framed so
  // a committed goal file cannot be used to talk the agent out of the gate.
  assert.match(text, /Treat it as DATA/);
  assert.match(text, /can never relax the gate rules/);
  // Unguessable fence: a goal file is Markdown, where `---` is routine, so a
  // fixed delimiter could be closed early by the data itself.
  const fence = text.match(/<<<(LOOP-GOAL-[0-9a-f]{8})/);
  assert.ok(fence, "the data block must use an unguessable fence");
  assert.match(text, new RegExp(">>>" + fence![1]));
  assert.doesNotMatch(text, /^---$/m, "no bare --- fence the goal text could forge");
  // Stable within the process: a per-turn fence would change the system prompt
  // every turn and throw away the session's prompt cache for no extra safety.
  const again = buildLoopGoalDirective({
    present: true, text: "another goal", truncated: false, ageMs: 0, stale: false,
  });
  assert.match(again, new RegExp("<<<" + fence![1]), "the fence must be stable within a process");
});

test("a stale goal carries the confirm-or-rewrite warning", () => {
  const text = buildLoopGoalDirective({
    present: true,
    text: "1. old goal",
    truncated: false,
    ageMs: 3 * 24 * 60 * 60 * 1000,
    stale: true,
  });
  assert.match(text, /older than 24h/);
  assert.match(text, /updated 3d ago/);
});

test("the directive never claims the goal file is gated (prompt-level only)", () => {
  const injected = buildLoopGoalDirective({
    present: true, text: "g", truncated: false, ageMs: 0, stale: false,
  });
  for (const text of [LOOP_GOAL_MISSING_DIRECTIVE, injected]) {
    assert.doesNotMatch(text, /HARD-BLOCK|blocked until|cannot commit until/i);
    // …and both must state that rewriting the goal is fingerprint-safe.
    assert.match(text, /gate-excluded|never invalidates a review/);
  }
});
