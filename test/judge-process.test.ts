/**
 * Opener-scoped judge identity (t1): the session id carries WHO opened it.
 *
 * These tests pin the two semantics that fix the measured cross-day
 * pollution (a new pi session resuming a previous session's transcript):
 *  - the SAME opener re-derives the SAME id (rounds reuse one transcript,
 *    and a crash recovery re-opens it);
 *  - a DIFFERENT opener derives a DIFFERENT id (a fresh transcript that can
 *    never inherit the previous session's context).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  judgeSessionIdFor,
  shortOpenerHash,
  shortRepoHash,
  MAX_SESSION_ID,
} from "../lib/judge-process.ts";

test("same opener re-derives the same session id (round reuse + crash recovery)", () => {
  const first = judgeSessionIdFor("reviewer", shortRepoHash("/repo"), "opener-session-1");
  const second = judgeSessionIdFor("reviewer", shortRepoHash("/repo"), "opener-session-1");
  assert.equal(first, second);
});

test("a different opener derives a different session id (no cross-session inheritance)", () => {
  const repo = shortRepoHash("/repo");
  const a = judgeSessionIdFor("reviewer", repo, "opener-session-1");
  const b = judgeSessionIdFor("reviewer", repo, "opener-session-2");
  assert.notEqual(a, b);
});

test("role and repo still discriminate within one opener", () => {
  const repo = shortRepoHash("/repo");
  assert.notEqual(
    judgeSessionIdFor("reviewer", repo, "opener"),
    judgeSessionIdFor("adviser", repo, "opener"),
  );
  assert.notEqual(
    judgeSessionIdFor("reviewer", repo, "opener"),
    judgeSessionIdFor("reviewer", shortRepoHash("/other"), "opener"),
  );
});

test("the id keeps the rg-<role>-<hash>-<openerHash> shape and the length cap", () => {
  const id = judgeSessionIdFor("goal-auditor", shortRepoHash("/repo"), "opener-session-1");
  assert.match(id, /^rg-goal-auditor-[0-9a-f]{8}-[0-9a-f]{8}$/);
  assert.ok(id.length <= MAX_SESSION_ID, id);
  const hostile = judgeSessionIdFor("../../x", "!!", "  opener  ");
  assert.ok(!hostile.includes("/") && !hostile.includes(" "), hostile);
  assert.ok(hostile.length <= MAX_SESSION_ID, hostile);
});

test("shortOpenerHash is deterministic, trims, and never empty", () => {
  assert.equal(shortOpenerHash("opener-1"), shortOpenerHash("opener-1"));
  assert.equal(shortOpenerHash("  opener-1  "), shortOpenerHash("opener-1"));
  assert.notEqual(shortOpenerHash("opener-1"), shortOpenerHash("opener-2"));
  assert.match(shortOpenerHash("opener-1"), /^[0-9a-f]{8}$/);
  assert.match(shortOpenerHash(""), /^[0-9a-f]{8}$/);
  assert.match(shortOpenerHash("   "), /^[0-9a-f]{8}$/);
});
