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
  mergeArgv,
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

test("R3-7: a clean holder on the base is allowed, and the merge keeps its --no-ff shape", () => {
  const venue: MergeVenue = { kind: "worktree", path: MAIN, reason: "…" };
  assert.equal(
    venueRefusal(venue, {
      base: "refactor/gate-heavy-agent-light",
      currentBranch: "refactor/gate-heavy-agent-light",
      dirtyFiles: [],
    }),
    undefined,
  );
  assert.deepEqual(
    mergeArgv("session-01a04f14", "refactor/gate-heavy-agent-light"),
    ["merge", "--no-ff", "session-01a04f14", "-m", "merge session-01a04f14 into refactor/gate-heavy-agent-light"],
  );
});

test("R3-7: merging in this very worktree is never refused for dirt elsewhere", () => {
  const venue: MergeVenue = { kind: "self", reason: "…" };
  assert.equal(venueRefusal(venue, { base: "main", dirtyFiles: ["M x"] }), undefined,
    "the self path is the pre-existing behavior and must stay exactly as it was");
});
