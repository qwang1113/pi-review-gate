/**
 * The pane is the CARRIER: open reports the id tmux itself printed, decor
 * failure degrades to a warning, an unreadable pane list is never "dead",
 * and close only ever closes one pane.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildJudgePaneCommand,
  buildJudgeRecoverCommand,
  closeJudgePane,
  judgePaneAlive,
  judgePaneLabel,
  listJudgePanes,
  openJudgePane,
  type JudgePaneRunner,
} from "../lib/judge-pane.ts";

/** Fake tmux: first split prints %7, list shows %1 and %7, everything ok. */
function happyRunner(seen: string[][] = []): JudgePaneRunner {
  return (argv) => {
    seen.push([...argv]);
    if (argv[0] === "split-window") return { ok: true, stdout: "%7\n", stderr: "" };
    if (argv[0] === "list-panes") return { ok: true, stdout: "%1\n%7\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
}

const OPTS = {
  ownPane: "%1",
  cwd: "/repo",
  sessionId: "rg-reviewer-abc123",
  judgeId: "rg-reviewer-abc123",
  role: "reviewer",
  command: buildJudgePaneCommand({
    sessionId: "rg-reviewer-abc123",
    taskPath: "/repo/.pi/judge-sessions/task-1.md",
    sessionDir: "/repo/.pi/judge-sessions/sessions",
    sysPromptPath: "/repo/.pi/judge-sessions/sp.md",
    model: "anthropic/claude-fable-5:max",
  }),
  env: { RG_JUDGE_OPENER: "session-child-1" },
};

test("open reports the pane id tmux printed and decorates it", () => {
  const seen: string[][] = [];
  const outcome = openJudgePane(happyRunner(seen), OPTS);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.paneId, "%7");
  const flat = seen.map((a) => a.join(" "));
  assert.ok(flat.some((s) => s.startsWith("split-window")), "a pane is opened");
  assert.ok(flat.some((s) => s.includes("select-pane") && s.includes("-P")), "a border colour is set");
  assert.ok(flat.some((s) => s.includes("@review-reviewer")), "the title names the review kind");
  assert.ok(flat.some((s) => s.includes("RG_JUDGE_OPENER=session-child-1")), "the opener rides into the pane env");
});

test("the pane command carries the read-only contract and resume keys", () => {
  assert.deepEqual(buildJudgePaneCommand({
    sessionId: "rg-reviewer-x", taskPath: "/r/task-1.md", sessionDir: "/r/sessions",
    sysPromptPath: "/r/sp.md", model: "m",
  }),
  ["pi", "--no-skills", "--exclude-tools", "edit,write",
    "--system-prompt", "/r/sp.md", "--model", "m",
    "--session-dir", "/r/sessions", "--session-id", "rg-reviewer-x", "@/r/task-1.md"]);
  assert.deepEqual(buildJudgeRecoverCommand("rg-reviewer-x"),
    ["pi", "--exclude-tools", "edit,write", "--session-id", "rg-reviewer-x"]);
});

test("a failed split is a failed open — never a guessed pane id", () => {
  const outcome = openJudgePane(() => ({ ok: false, stdout: "", stderr: "no server" }), OPTS);
  assert.equal(outcome.ok, false);
});

test("an empty spawn print is a failed open", () => {
  const outcome = openJudgePane(() => ({ ok: true, stdout: "\n", stderr: "" }), OPTS);
  assert.equal(outcome.ok, false);
});

test("decor failure degrades to a warning, never to a failed open", () => {
  const run: JudgePaneRunner = (argv) => {
    if (argv[0] === "split-window") return { ok: true, stdout: "%7\n", stderr: "" };
    return { ok: false, stdout: "", stderr: "select failed" };
  };
  const outcome = openJudgePane(run, OPTS);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.paneId, "%7");
  assert.match(outcome.decorWarning ?? "", /降级/);
});

test("close kills exactly one pane", () => {
  const seen: string[][] = [];
  const run: JudgePaneRunner = (argv) => {
    seen.push([...argv]);
    return { ok: true, stdout: "", stderr: "" };
  };
  assert.equal(closeJudgePane(run, "%7").ok, true);
  assert.deepEqual(seen, [["kill-pane", "-t", "%7"]]);
});

test("close failure is reported, not swallowed", () => {
  const outcome = closeJudgePane(() => ({ ok: false, stdout: "", stderr: "gone" }), "%7");
  assert.equal(outcome.ok, false);
});

test("an unreadable pane list is missing information, never death", () => {
  assert.equal(listJudgePanes(() => ({ ok: false, stdout: "", stderr: "x" }), "%1"), undefined);
  assert.equal(judgePaneAlive(() => ({ ok: false, stdout: "", stderr: "x" }), "%1", "%7"), undefined);
  const run = happyRunner();
  assert.deepEqual(listJudgePanes(run, "%1"), ["%1", "%7"]);
  assert.equal(judgePaneAlive(run, "%1", "%7"), true);
  assert.equal(judgePaneAlive(run, "%1", "%9"), false);
});

test("judge labels are stable and sanitized", () => {
  assert.equal(judgePaneLabel("reviewer"), "@review-reviewer");
  assert.equal(judgePaneLabel("../../etc"), "@review-..-..-etc");
  assert.doesNotMatch(judgePaneLabel("../../etc"), /\//, "no path separator survives (dots are display-only, never a path)");
});
