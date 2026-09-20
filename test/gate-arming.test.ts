/**
 * WHAT ARMS THE GATE, and what may clear it — drill F1, 2026-09-19.
 *
 * The bug this module exists to make impossible was a DRIFT between two copies
 * of one rule: `session_start` armed on "a dirty code/doc file OR commits ahead
 * of the base", while `turn_end` reconciled on the working tree's file kinds
 * alone. One untracked non-code file (the drill's seeded `node_modules`
 * symlink) then cleared `hasCodeChange` while eight unreviewed commits sat on
 * the branch, and the ship gate — which reads exactly these flags — let
 * `git commit`, `git push` and `gh pr create` straight through.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { armingFromFacts, couldReconcile, reconcileArming } from "../lib/gate-arming.ts";

test("branch commits arm the code flag on their own — a clean worktree is not a clean branch", () => {
  assert.deepEqual(
    armingFromFacts({ files: [], commitsAhead: 8 }),
    { hasCodeChange: true, hasDocChange: false },
    "commits ahead of the base ARE work to review, whatever the working tree looks like",
  );
});

test("a doc-only worktree arms the doc flag and NOT the code flag", () => {
  assert.deepEqual(
    armingFromFacts({ files: ["README.md"], commitsAhead: 0 }),
    { hasCodeChange: false, hasDocChange: true },
    "the two flags are not symmetric — a branch ahead is code, 'docs only' can only be said of a file",
  );
});

test("a dirty non-code file arms NOTHING (it is the F1 fuel, not a change)", () => {
  assert.deepEqual(
    armingFromFacts({ files: ["node_modules", ".env", "out.log"], commitsAhead: 0 }),
    { hasCodeChange: false, hasDocChange: false },
    "an untracked artefact of no code/doc kind is not this session's work",
  );
});

test("F1: an armed code flag SURVIVES while the branch is ahead, even with only a non-code file dirty", () => {
  const current = { hasCodeChange: true, hasDocChange: false };
  const kept = reconcileArming(current, { files: ["node_modules"], commitsAhead: 8 });
  assert.deepEqual(
    { hasCodeChange: kept.hasCodeChange, hasDocChange: kept.hasDocChange },
    current,
    "the reconciliation may not clear what the OTHER arming source still justifies — this is the fail-open",
  );
  assert.equal(kept.changed, false, "nothing changed ⇒ the caller owes no persist");
});

test("…and the SAME reconciliation clears it once the branch is not ahead", () => {
  const cleared = reconcileArming(
    { hasCodeChange: true, hasDocChange: false },
    { files: ["node_modules"], commitsAhead: 0 },
  );
  assert.deepEqual(
    { hasCodeChange: cleared.hasCodeChange, hasDocChange: cleared.hasDocChange },
    { hasCodeChange: false, hasDocChange: false },
    "with neither source left there is nothing to review, and the flag must go",
  );
  assert.equal(cleared.changed, true);
});

test("a dirty code file keeps the flag, and a doc flag is never propped up by branch commits", () => {
  const stillCode = reconcileArming(
    { hasCodeChange: true, hasDocChange: false },
    { files: ["lib/a.ts"], commitsAhead: 0 },
  );
  assert.equal(stillCode.hasCodeChange, true, "the file justifies the flag on its own");
  assert.equal(stillCode.changed, false);

  const docOnly = reconcileArming(
    { hasCodeChange: false, hasDocChange: true },
    { files: [], commitsAhead: 2 },
  );
  assert.equal(docOnly.hasDocChange, false, "a branch ahead is code work; it says nothing about documentation");
});

test("reconciliation never SETS a flag — arming happens where work happens", () => {
  const fromNothing = reconcileArming({ hasCodeChange: false, hasDocChange: false }, { files: ["lib/a.ts"], commitsAhead: 3 });
  assert.deepEqual(
    { hasCodeChange: fromNothing.hasCodeChange, hasDocChange: fromNothing.hasDocChange, changed: fromNothing.changed },
    { hasCodeChange: false, hasDocChange: false, changed: false },
    "clear-only, or the reconciliation becomes a second answer to the arming question",
  );
});

test("couldReconcile: skip the git call when nothing COULD be cleared", () => {
  assert.equal(
    couldReconcile({ hasCodeChange: true, hasDocChange: true }, ["lib/a.ts", "README.md"]),
    false,
    "both kinds are present — a `git rev-list` spawn on every turn would buy nothing",
  );
  assert.equal(couldReconcile({ hasCodeChange: true, hasDocChange: false }, ["README.md"]), true, "code flag, no code file");
  assert.equal(couldReconcile({ hasCodeChange: false, hasDocChange: true }, []), true, "an empty worktree may clear everything");
});
