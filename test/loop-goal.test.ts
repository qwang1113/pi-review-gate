import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GOAL_CONFIRM_MAX_CHARS,
  LOOP_GOAL_MAX_CHARS,
  LOOP_GOAL_MISSING_DIRECTIVE,
  LOOP_GOAL_RELPATH,
  LOOP_GOAL_STALE_MS,
  buildGoalConfirmMessage,
  buildLoopGoalDirective,
  goalTextHash,
  isLoopGoalConfirmed,
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

test("no goal ⇒ the Step 0 directive: grill the user, then propose_loop_goal", () => {
  const root = repoWithGoal();
  const text = buildLoopGoalDirective(readLoopGoal(root));
  rmSync(root, { recursive: true, force: true });
  assert.equal(text, LOOP_GOAL_MISSING_DIRECTIVE);
  assert.match(text, /Step 0/);
  assert.match(text, new RegExp(LOOP_GOAL_RELPATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // USER REQUIREMENT: the goal is NEGOTIATED, not assumed — interview first,
  // then submit it for the user's approval through the trusted tool.
  assert.match(text, /GRILL the user first/);
  assert.match(text, /recommended answer/);
  assert.match(text, /propose_loop_goal/);
  assert.match(text, /Writing that file yourself grants nothing/);
  // The engineering skills stay user-invoked accelerators, never a dependency.
  assert.match(text, /\/to-spec/);
  assert.match(text, /\/to-tickets/);
  assert.match(text, /only if the USER runs them/);
});

test("an APPROVED goal is injected verbatim with the acceptance contract attached", () => {
  const text = buildLoopGoalDirective({
    present: true,
    text: "1. `node --test` passes",
    truncated: false,
    ageMs: 2 * 60 * 60 * 1000,
    stale: false,
  }, true);
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
  }, true);
  assert.match(again, new RegExp("<<<" + fence![1]), "the fence must be stable within a process");
});

test("USER REQUIREMENT: an UNAPPROVED goal is never quoted — body withheld, renegotiate", () => {
  // The exact failure this closes: a goal file left over from the PREVIOUS
  // task kept being injected verbatim, so a new session inherited someone
  // else's exit contract and worked to it.
  const stale = { present: true, text: "1. previous task's criteria", truncated: false, ageMs: 0, stale: false };
  const text = buildLoopGoalDirective(stale);            // default: unapproved
  assert.doesNotMatch(text, /previous task's criteria/, "an unapproved goal body must NOT be injected");
  assert.match(text, /DRAFT exists but the user has not approved it/);
  assert.match(text, /propose_loop_goal/);
  assert.doesNotMatch(text, /<<<LOOP-GOAL-/, "no data fence — there is no approved data to fence");
});

test("a stale APPROVED goal carries the confirm-or-renegotiate warning", () => {
  const text = buildLoopGoalDirective({
    present: true,
    text: "1. old goal",
    truncated: false,
    ageMs: 3 * 24 * 60 * 60 * 1000,
    stale: true,
  }, true);
  assert.match(text, /older than 24h/);
  assert.match(text, /updated 3d ago/);
});

test("the directive is honest about WHAT the goal gates (ship, not the hooks)", () => {
  const injected = buildLoopGoalDirective({
    present: true, text: "g", truncated: false, ageMs: 0, stale: false,
  }, true);
  // An approved goal never claims to gate anything by its mere existence…
  assert.doesNotMatch(injected, /HARD-BLOCK/i);
  assert.match(injected, /gate-excluded|never invalidates a review/);
  // …while the Step-0 directive must state the real consequence of skipping
  // the negotiation (L1 ship block), so the agent is not surprised by it.
  assert.match(LOOP_GOAL_MISSING_DIRECTIVE, /blocks commit\/push\/PR/);
});

// ---------------------------------------------------------------------------
// L8 — the approval is a content hash, not a timestamp

test("approval binds to the exact text: whitespace-equivalent yes, edited no", () => {
  const goalText = "# Goal\n\n1. tests pass\n";
  const confirmation = { hash: goalTextHash(goalText), at: "2026-08-07T10:00:00Z" };
  const goal = { present: true, text: "unused", truncated: false, ageMs: 0, stale: false };

  // Same text, CRLF + trailing blank lines — still the approved contract.
  assert.equal(isLoopGoalConfirmed(goal, confirmation, "# Goal\r\n\r\n1. tests pass\r\n\n"), true);
  // One criterion edited after the dialog ⇒ approval is gone.
  assert.equal(isLoopGoalConfirmed(goal, confirmation, "# Goal\n\n1. tests pass\n2. and ship it\n"), false);
  // No confirmation on record, or no goal file at all ⇒ unapproved.
  assert.equal(isLoopGoalConfirmed(goal, undefined, goalText), false);
  assert.equal(isLoopGoalConfirmed({ ...goal, present: false }, confirmation, goalText), false);
});

test("a TRUNCATED goal cannot be verified from the prompt copy alone (fail-closed)", () => {
  const long = "z".repeat(LOOP_GOAL_MAX_CHARS + 50);
  const confirmation = { hash: goalTextHash(long), at: "2026-08-07T10:00:00Z" };
  const truncated = { present: true, text: long.slice(0, LOOP_GOAL_MAX_CHARS), truncated: true, ageMs: 0, stale: false };
  // Without the raw file text there is nothing trustworthy to hash.
  assert.equal(isLoopGoalConfirmed(truncated, confirmation), false);
  // With it, the same approval verifies.
  assert.equal(isLoopGoalConfirmed(truncated, confirmation, long), true);
});

test("the confirm dialog shows the goal as untrusted, capped data", () => {
  const msg = buildGoalConfirmMessage("x".repeat(GOAL_CONFIRM_MAX_CHARS + 400));
  assert.match(msg, new RegExp(LOOP_GOAL_RELPATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(msg, /不可信数据/);
  assert.ok(msg.length < GOAL_CONFIRM_MAX_CHARS + 800, "the dialog must stay bounded");
  assert.match(msg, /已截断/);
  // The fixed copy must state what approval buys — the user is the one who
  // needs to understand the consequence.
  assert.match(msg, /commit\/push\/PR/);
});
