/**
 * R3-7 — the merge that could not run, and now can.
 *
 * A parallel orchestration lane finished everything (READY review, full
 * precommit, the right base branch on record) and `declare_done` still failed:
 * it ran `git checkout <base>` in a linked worktree, and the base branch was
 * held by the supervisor's checkout. That is not a rare collision — it is the
 * defining property of a worktree, so this path failed 100% of the time and
 * both lanes of the third run were merged by a human.
 *
 * These tests pin the venue algebra: strings in, a decision out, no git.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  branchHolder,
  decideMergeVenue,
  squashMergeArgv,
  squashMergeSubject,
  squashMergeMessage,
  parseConventionalSubject,
  parseWorktreeList,
  venueRefusal,
  type MergeVenue,
} from "../lib/worktree-merge.ts";

const MAIN = "/Users/q/workspace/repo";
const LANE = "/tmp/rg-orchestration/repo/t3-abc";

const PORCELAIN = [
  `worktree ${MAIN}`,
  "HEAD 55aab03d1f2e",
  "branch refs/heads/refactor/gate-heavy-agent-light",
  "",
  `worktree ${LANE}`,
  "HEAD 03e8f52aa119",
  "branch refs/heads/orch/t3-supervision-doc",
  "",
].join("\n");

test("the porcelain worktree list parses into paths, branches and heads", () => {
  const entries = parseWorktreeList(PORCELAIN);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    path: MAIN,
    head: "55aab03d1f2e",
    branch: "refactor/gate-heavy-agent-light",
  });
  assert.equal(entries[1]!.branch, "orch/t3-supervision-doc", "refs/heads/ is stripped");
});

test("a detached worktree is parsed as detached, and unknown attributes do not lose the record", () => {
  const entries = parseWorktreeList([
    `worktree ${LANE}`,
    "HEAD abc",
    "detached",
    "locked some reason",
    "",
  ].join("\n"));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.detached, true);
  assert.equal(entries[0]!.branch, undefined);
});

test("empty or unreadable output is an empty list, never a crash", () => {
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList("garbage\nlines\n"), []);
});

test("R3-7: a branch held by ANOTHER worktree moves the merge there instead of failing", () => {
  const venue = decideMergeVenue({
    base: "refactor/gate-heavy-agent-light",
    work: "session-01a04f14",
    selfPath: LANE,
    worktrees: parseWorktreeList(PORCELAIN),
  });
  assert.equal(venue.kind, "worktree");
  assert.equal((venue as Extract<MergeVenue, { kind: "worktree" }>).path, MAIN);
  assert.match(venue.reason, /不切分支/, "the old path switched branches; that is what could never work");
});

test("R3-7: a base nobody else holds still merges here — the ordinary session is untouched", () => {
  const venue = decideMergeVenue({
    base: "main",
    work: "session-x",
    selfPath: MAIN,
    worktrees: parseWorktreeList(PORCELAIN),
  });
  assert.equal(venue.kind, "self");
});

test("R3-7: the worktree this session IS does not count as a holder", () => {
  const entries = parseWorktreeList(PORCELAIN);
  assert.equal(branchHolder(entries, "refactor/gate-heavy-agent-light", MAIN), undefined,
    "standing on the base yourself is the normal case, not an obstacle");
  assert.equal(branchHolder(entries, "refactor/gate-heavy-agent-light", `${MAIN}/`)?.path, undefined,
    "a trailing slash is not a different worktree");
});

test("R3-7: a DIRTY holding worktree refuses the merge, and says what to do instead", () => {
  const venue: MergeVenue = { kind: "worktree", path: MAIN, reason: "…" };
  const refusal = venueRefusal(venue, {
    base: "refactor/gate-heavy-agent-light",
    currentBranch: "refactor/gate-heavy-agent-light",
    dirtyFiles: [" M lib/a.ts", "?? scratch.md"],
  });
  assert.ok(refusal, "merging over somebody's uncommitted work can lose it (user decision: never)");
  assert.match(refusal!, /不干净/);
  assert.match(refusal!, /waiveMerge/, "and the refusal names the escape hatch, which is the USER's");
});

test("R3-7: a holder standing on a DIFFERENT branch is refused — the gate does not check out for others", () => {
  const venue: MergeVenue = { kind: "worktree", path: MAIN, reason: "…" };
  const refusal = venueRefusal(venue, {
    base: "refactor/gate-heavy-agent-light",
    currentBranch: "some/other-branch",
    dirtyFiles: [],
  });
  assert.match(refusal!, /不会替别的工作区切分支/);
});

test("R3-7: a clean holder on the base is allowed, and the landing is a squash", () => {
  const venue: MergeVenue = { kind: "worktree", path: MAIN, reason: "…" };
  assert.equal(
    venueRefusal(venue, {
      base: "refactor/gate-heavy-agent-light",
      currentBranch: "refactor/gate-heavy-agent-light",
      dirtyFiles: [],
    }),
    undefined,
  );
  // The landing STAGES the squash (no `-m`, no commit); the gate commits it
  // separately from the derived, ASCII-only message.
  assert.deepEqual(squashMergeArgv("session-01a04f14"), ["merge", "--squash", "session-01a04f14"]);
});

test("squash subject — folds the dominant type/scope, always ASCII (L5-safe)", () => {
  // feat outranks fix/docs; `orchestrator` is the most common underlying scope
  // once the `checkpoint` marker is stripped back off.
  const subject = squashMergeSubject("orch/t2-ship-gate-mtfck5jl", [
    "fix(checkpoint-orchestrator): stop waking the human",
    "feat(checkpoint-orchestrator): add progress dimension",
    "docs(checkpoint): sync module map",
  ]);
  assert.equal(subject, "feat(orchestrator): land orch-t2-ship-gate-mtfck5jl branch");
  // No non-Latin letter can appear, whatever the checkpoints held.
  for (const ch of subject) {
    assert.ok(!(/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)), `non-Latin char: ${ch}`);
  }
});

test("squash subject — a scope of only `checkpoint` yields no scope", () => {
  assert.equal(
    squashMergeSubject("session-abc", ["docs(checkpoint): a", "docs(checkpoint): b"]),
    "docs: land session-abc branch",
  );
});

test("squash subject — nothing parseable falls back to chore", () => {
  assert.equal(
    squashMergeSubject("feature/xyz", ["not a conventional subject", "also not one"]),
    "chore: land feature-xyz branch",
  );
});

test("squash subject — a Chinese-tokened branch is sanitized to ASCII", () => {
  // The branch name is ASCII by policy, but the subject must be robust anyway:
  // any non-`[a-z0-9-]` is stripped, so L5 holds unconditionally.
  const subject = squashMergeSubject("会话-01", ["fix(checkpoint): x"]);
  assert.equal(subject, "fix: land 01 branch");
});

test("parseConventionalSubject — type/scope extraction", () => {
  assert.deepEqual(parseConventionalSubject("feat(api): x"), { type: "feat", scope: "api" });
  assert.deepEqual(parseConventionalSubject("fix!: y"), { type: "fix" });
  assert.equal(parseConventionalSubject("no colon here"), undefined);
});

test("squash message — the body names the count and stays English", () => {
  const { subject, body } = squashMergeMessage("session-abc", "main", [
    "feat(checkpoint): a",
    "fix(checkpoint): b",
  ]);
  assert.equal(subject, "feat: land session-abc branch");
  assert.match(body, /2 checkpoints folded/);
  assert.match(body, /session-abc into main/);
});


test("R3-7: merging in this very worktree is never refused for dirt elsewhere", () => {
  const venue: MergeVenue = { kind: "self", reason: "…" };
  assert.equal(venueRefusal(venue, { base: "main", dirtyFiles: ["M x"] }), undefined,
    "the self path is the pre-existing behavior and must stay exactly as it was");
});
