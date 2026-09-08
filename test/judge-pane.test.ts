/**
 * What lib/judge-pane.ts still owns after the session factory landed: the
 * judge's cross-process env keys and pane liveness. An unreadable pane list is
 * missing information, never "dead" — opening, decorating and closing a pane
 * are tested in test/session-factory.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  judgePaneAlive,
  listJudgePanes,
  JUDGE_ID_ENV,
  JUDGE_OPENER_ENV,
  JUDGE_ROLE_ENV,
  type JudgePaneRunner,
} from "../lib/judge-pane.ts";

/** Fake tmux: list shows %1 and %7, everything ok. */
function happyRunner(seen: string[][] = []): JudgePaneRunner {
  return (argv) => {
    seen.push([...argv]);
    if (argv[0] === "list-panes") return { ok: true, stdout: "%1\n%7\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
}

test("an unreadable pane list is missing information, never death", () => {
  assert.equal(listJudgePanes(() => ({ ok: false, stdout: "", stderr: "x" }), "%1"), undefined);
  assert.equal(judgePaneAlive(() => ({ ok: false, stdout: "", stderr: "x" }), "%1", "%7"), undefined);
  const run = happyRunner();
  assert.deepEqual(listJudgePanes(run, "%1"), ["%1", "%7"]);
  assert.equal(judgePaneAlive(run, "%1", "%7"), true);
  assert.equal(judgePaneAlive(run, "%1", "%9"), false);
});

test("a thrown tmux call is missing information too, never death", () => {
  const throwing: JudgePaneRunner = () => { throw new Error("no server"); };
  assert.equal(listJudgePanes(throwing, "%1"), undefined);
  assert.equal(judgePaneAlive(throwing, "%1", "%7"), undefined);
});

test("the judge env keys are a frozen wire format", () => {
  // A judge pane is a DIFFERENT process running whatever build is on disk when
  // it boots, and these three names are how it recognizes itself (and how the
  // session-exclusivity guard grants it its exemption). Renaming one does not
  // degrade a feature — it kills the pane at boot.
  assert.equal(JUDGE_OPENER_ENV, "RG_JUDGE_OPENER");
  assert.equal(JUDGE_ID_ENV, "RG_JUDGE_ID");
  assert.equal(JUDGE_ROLE_ENV, "RG_JUDGE_ROLE");
});
