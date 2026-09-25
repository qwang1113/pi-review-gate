/**
 * The gate's own `pr` evidence (lib/station-pr-evidence.ts).
 *
 * Two halves, tested differently because they fail differently:
 *
 *  - `hasUnpushedCommits` is REAL git against a throwaway repository. Its whole
 *    value is the FAIL-CLOSED direction — no upstream, not a repository, an
 *    unreadable answer all have to read as "there is work here that has not
 *    been pushed", or the arrival check it feeds would grant a station on a
 *    branch nobody published.
 *  - the `gh` half takes a fake lookup, so the `state === "OPEN"` rule (a
 *    CLOSED or MERGED PR is NOT an arrival, and neither is an unreadable one)
 *    is exercised without GitHub — and the result type has NOWHERE to put the
 *    push reading, which is the point: that question is a separate local git
 *    fact, asked of every `pr` evidence, and `test/delivery-station.test.ts`
 *    is where the rule about it lives (round-1 review Nit, 2026-09-16).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  existingPrNotice,
  hasUnpushedCommits,
  probeOpenPr,
  type OpenPrLookup,
} from "../lib/station-pr-evidence.ts";
import type { PrSummary } from "../lib/copilot-probe-parse.ts";
import { hermeticGitEnv } from "./helpers/git.ts";

// Hermetic env on EVERY spawn: these fixtures run real `git commit`, and a
// developer's global `commit.gpgsign` / `core.hooksPath` would otherwise make
// them slow on one machine and wrong on another (test/hermetic-git.test.ts
// enforces this for the whole suite). Identity still comes from `-c` at the
// commit call sites — the hermetic env also removes `user.name`/`user.email`.
function runGit(dir: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: dir,
    env: hermeticGitEnv(),
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A repository with one commit and NO remote — the "never pushed" case. */
function freshRepo(): string {
  const dir = scratch("rg-station-pr-");
  runGit(dir, "init", "-q", "-b", "main");
  runGit(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

function commit(dir: string, message: string): void {
  runGit(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", message);
}

test("hasUnpushedCommits: a branch WITH an upstream is compared against it", () => {
  const remote = scratch("rg-station-remote-");
  runGit(remote, "init", "-q", "--bare", "-b", "main");
  const dir = freshRepo();
  runGit(dir, "remote", "add", "origin", remote);
  runGit(dir, "push", "-q", "-u", "origin", "main");

  assert.equal(hasUnpushedCommits(dir), false, "pushed and in sync is the ONE case that is not ahead");
  commit(dir, "ahead");
  assert.equal(hasUnpushedCommits(dir), true, "a commit that exists only here");
});

test("hasUnpushedCommits: fail-CLOSED — an unreadable answer reads as unpushed", () => {
  // The gate can only ever get STRICTER from this reading, so every way it can
  // fail to answer has to land on "there is work here that was not pushed".
  // Both of these reach git and come back with nothing usable: the branch has
  // no upstream at all, and the directory is not a repository.
  assert.equal(hasUnpushedCommits(freshRepo()), true, "no upstream: the branch was never pushed");
  assert.equal(hasUnpushedCommits(scratch("rg-not-a-repo-")), true, "not a repository");
});

test("probeOpenPr: only an OPEN state grants arrival", async () => {
  const dir = freshRepo();
  const pr = (state: string | null): PrSummary => ({
    number: 7,
    head: null,
    url: "https://github.com/o/r/pull/7",
    state,
  });

  const lookup = (value: PrSummary | undefined): OpenPrLookup => async () => ({ pr: value });
  const open = await probeOpenPr(dir, { lookup: lookup(pr("OPEN")) });
  assert.equal(open.number, 7);
  assert.equal(open.url, "https://github.com/o/r/pull/7");

  // A finished PR is not an arrival — `gh pr view` happily returns the CLOSED
  // or MERGED one sitting on this branch, and treating it as "we arrived" is
  // how a round would finish on a PR that is already over.
  for (const state of ["CLOSED", "MERGED", null]) {
    const got = await probeOpenPr(dir, { lookup: lookup(pr(state)) });
    assert.equal(got.number, null, `state=${String(state)} is not an open PR`);
  }
  // gh said "no PR" (or the probe could not answer): no evidence, no guess.
  assert.deepEqual(await probeOpenPr(dir, { lookup: lookup(undefined) }), { number: null, url: null });
  // The push question is NOT part of this answer (round-1 quality P1): it is a
  // local git reading asked of every evidence, and `probeOpenPr`'s result type
  // deliberately has nowhere to put it.
  assert.deepEqual(Object.keys(open).sort(), ["number", "url"]);
});

test("existingPrNotice: names the PR, and names the one move that is right", () => {
  assert.equal(
    existingPrNotice({ number: null, url: null }),
    null,
    "no answer found ⇒ the gate has no second opinion on gh's own error",
  );

  const text = existingPrNotice({ number: 167, url: "https://github.com/o/r/pull/167" })!;
  assert.match(text, /#167/);
  assert.match(text, /pull\/167/, "the URL is useful when gh printed one");
  assert.match(text, /追加提交/, "the action that is actually right");
  assert.match(text, /不要关掉/, "…and the destructive guess, closed out loud");
});
