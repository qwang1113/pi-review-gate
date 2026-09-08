/**
 * THE SESSION FACTORY — one entry, five input combinations.
 *
 * The point of this file is that a combination cannot quietly lose a step. Each
 * of the five ways the gate opens a pi session (judge spawn, judge recover,
 * orchestration spawn, orchestration recover, relay successor) is asserted here
 * on the two things that are cross-process contracts — the ENV key set and the
 * argv shape — plus the decoration and the delivery check that used to exist on
 * one side only (C1, C2, and the judge-side receipt).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildJudgePaneCommand,
  buildJudgeRecoverCommand,
  buildSessionEnv,
  closeSessionPane,
  decorateSessionPane,
  judgePaneDecor,
  judgePaneLabel,
  openSessionPane,
  paneRecoverability,
  releasesWindowLabels,
  refreshSessionPaneTitle,
  PANE_REPAINT_MIN_MS,
  type PaneRunner,
  type PaneTitleMemory,
} from "../lib/session-factory.ts";

/** Fake tmux: a split prints %7, everything succeeds. */
function happyRunner(seen: string[][] = []): PaneRunner {
  return (argv) => {
    seen.push([...argv]);
    if (argv[0] === "split-window") return { ok: true, stdout: "%7\n", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
}

/**
 * Fake tmux whose window CHANGES SHAPE when the split lands: `list-panes`
 * answers `before` until a split has happened, then `after`. The strings are
 * the real `#{pane_id} #{pane_left} #{pane_top} #{window_zoomed_flag}` format,
 * so the geometry the rule reads is the geometry tmux prints.
 */
function windowRunner(before: string, after: string, seen: string[][] = []): PaneRunner {
  let split = false;
  return (argv) => {
    seen.push([...argv]);
    if (argv[0] === "list-panes") return { ok: true, stdout: split ? after : before, stderr: "" };
    if (argv[0] === "split-window") {
      split = true;
      return { ok: true, stdout: "%9\n", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
}

/** `-e K=V` pairs back out of a spawn argv, as a map. */
function envOf(argv: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== "-e") continue;
    const [key, ...rest] = argv[i + 1]!.split("=");
    env[key!] = rest.join("=");
  }
  return env;
}

const JUDGE_COMMAND = buildJudgePaneCommand({
  sessionId: "rg-reviewer-abc123",
  taskPath: "/repo/.pi/judge-sessions/task-1.md",
  sessionDir: "/repo/.pi/judge-sessions/sessions",
  sysPromptPath: "/repo/.pi/judge-sessions/sp.md",
  model: "anthropic/claude-fable-5:max",
});

// ---------------------------------------------------------------------------
// The five combinations
// ---------------------------------------------------------------------------

test("combination 1 — a judge SPAWN: judge env, own colour, border line, verified boot", async () => {
  const seen: string[][] = [];
  const registered: string[] = [];
  const outcome = await openSessionPane(happyRunner(seen), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "child-column",
    role: {
      kind: "judge",
      openerId: "session-child-1",
      judgeId: "rg-reviewer-abc123",
      role: "reviewer",
      taskPath: "/repo/.pi/judge-sessions/task-1.md",
      streamPath: "/repo/.pi/review-stream/r.jsonl",
    },
    command: JUDGE_COMMAND,
    decor: judgePaneDecor("rg-reviewer-abc123", "reviewer"),
    register: (paneId) => registered.push(paneId),
    verify: async () => ({ ok: true, detail: "上报了状态" }),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.paneId, "%7", "the id comes from tmux, never from a guess");
  assert.deepEqual(registered, ["%7"], "registration happens inside the open");
  assert.equal(outcome.deliveryNote, "上报了状态");

  const spawn = seen.find((argv) => argv[0] === "split-window")!;
  assert.deepEqual(envOf(spawn), {
    RG_JUDGE_OPENER: "session-child-1",
    RG_JUDGE_ID: "rg-reviewer-abc123",
    RG_JUDGE_ROLE: "reviewer",
    RG_JUDGE_TASK: "/repo/.pi/judge-sessions/task-1.md",
    RG_JUDGE_STREAM: "/repo/.pi/review-stream/r.jsonl",
  }, "exactly the five judge variables — the judge side reads these by name");

  const flat = seen.map((a) => a.join(" "));
  assert.ok(flat.some((s) => s.includes("select-pane") && s.includes("-P")), "a border colour is set");
  assert.ok(flat.some((s) => s.includes("@review-reviewer")), "the title names the review kind");
  // C1: the WINDOW option that renders the border line used to be set by the
  // orchestration spawn only, so a judge pane opened without a project manager
  // in the window had a colour nobody could see.
  assert.ok(flat.some((s) => s.includes("pane-border-status")), "the border LINE is turned on (C1)");
  assert.ok(flat.some((s) => s.includes("pane-border-format")), "and given its format (C1)");
});

test("combination 2 — a judge RECOVER: same three keys, resume argv, no task file", async () => {
  const seen: string[][] = [];
  const outcome = await openSessionPane(happyRunner(seen), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "child-column",
    role: { kind: "judge", openerId: "session-child-1", judgeId: "rg-reviewer-abc123", role: "reviewer" },
    command: buildJudgeRecoverCommand("rg-reviewer-abc123"),
    decor: judgePaneDecor("rg-reviewer-abc123", "reviewer"),
  });
  assert.equal(outcome.ok, true);
  const spawn = seen.find((argv) => argv[0] === "split-window")!;
  assert.deepEqual(envOf(spawn), {
    RG_JUDGE_OPENER: "session-child-1",
    RG_JUDGE_ID: "rg-reviewer-abc123",
    RG_JUDGE_ROLE: "reviewer",
  }, "no task and no stream on a recover — the transcript already holds the round");
  assert.ok(spawn.includes("--session-id"), "the transcript continues by id");
  assert.ok(!spawn.some((a) => a.startsWith("@")), "no argv message: nothing to re-deliver");
});

test("combination 3 — an orchestration SPAWN: orchestration env, stacked in the third column", async () => {
  const seen: string[][] = [];
  // Three columns already: the new child belongs under the third one's last
  // pane, whatever this opener's own child list says.
  const outcome = await openSessionPane(windowRunner(
    ["%1 0 0 0", "%2 100 0 0", "%5 200 0 0", "%6 200 30 0"].join("\n"),
    ["%1 0 0 0", "%2 100 0 0", "%5 200 0 0", "%6 200 30 0", "%9 200 60 0"].join("\n"),
    seen,
  ), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "child-column",
    role: { kind: "orchestration-child", orchestrationId: "orch-abc-1", stateVariant: "t1-xyz" },
    command: ["pi", "@.pi/tasks/t1.md"],
    decor: { label: "@t1-thing", colorSeed: "t1-xyz", state: "working", stateForSeconds: 0 },
    verify: async () => ({ ok: true, detail: "通道有记录" }),
  });
  assert.equal(outcome.ok, true);
  const spawn = seen.find((argv) => argv[0] === "split-window")!;
  assert.deepEqual(envOf(spawn), {
    RG_ORCHESTRATION_ID: "orch-abc-1",
    RG_GATE_MODE: "loop",
    RG_STATE_VARIANT: "t1-xyz",
  }, "the child's own sidecar variant is ALSO its exclusivity-guard exemption");
  assert.deepEqual(spawn.slice(0, 4), ["split-window", "-v", "-t", "%6"],
    "three columns ⇒ stack under the third column's last pane");
  assert.deepEqual(seen.filter((argv) => argv[0] === "select-layout").map((argv) => argv.join(" ")), [
    "select-layout -E -t %5",
    "select-layout -E -t %1",
  ], "then spread the third column's heights, then the columns' widths");
});

test("the three-column rule reads the WINDOW, never the opener's own child list", async () => {
  // The measured defect (2026-09-08): every session keeps its own child list,
  // so a judge opened by a child — or a second orchestration in the same
  // window — each saw "no children yet" and opened a NEW column. The user's
  // window had five. Here the opener has no children at all, and the window
  // already has two columns: the next pane must open the third one.
  const seen: string[][] = [];
  await openSessionPane(windowRunner(
    ["%1 0 0 0", "%2 100 0 0"].join("\n"),
    ["%1 0 0 0", "%2 100 0 0", "%9 200 0 0"].join("\n"),
    seen,
  ), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "child-column",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
  });
  const spawn = seen.find((argv) => argv[0] === "split-window")!;
  assert.deepEqual(spawn.slice(0, 4), ["split-window", "-h", "-t", "%2"],
    "two columns ⇒ open the third beside the rightmost column's lone pane");
  assert.deepEqual(seen.filter((argv) => argv[0] === "select-layout").map((argv) => argv.join(" ")),
    ["select-layout -E -t %1"], "the window is three columns wide now ⇒ spread the widths once");
});

test("widths are spread off a pane that sits ALONE, never one inside a shared column", async () => {
  // A pane inside a multi-pane column spreads THAT COLUMN's heights, not the
  // window's widths (reviewer P2). The width pass therefore has to pick a lone
  // pane — and it must not touch a column this round never changed.
  const seen: string[][] = [];
  await openSessionPane(windowRunner(
    ["%1 0 0 0", "%2 0 30 0", "%3 100 0 0", "%5 200 0 0"].join("\n"),
    ["%1 0 0 0", "%2 0 30 0", "%3 100 0 0", "%5 200 0 0", "%9 200 60 0"].join("\n"),
    seen,
  ), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "child-column",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
  });
  assert.deepEqual(seen.filter((argv) => argv[0] === "select-layout").map((argv) => argv.join(" ")), [
    "select-layout -E -t %5",
    "select-layout -E -t %3",
  ], "the changed column first, then the widths off the lone pane in column 2");
});

test("an unreadable window falls back to splitting the opener — the pane must open", async () => {
  const seen: string[][] = [];
  await openSessionPane(happyRunner(seen), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "child-column",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
  });
  const spawn = seen.find((argv) => argv[0] === "split-window")!;
  assert.deepEqual(spawn.slice(0, 4), ["split-window", "-h", "-t", "%1"],
    "no geometry ⇒ split the opener itself; a layout we cannot read is not a reason to fail the spawn");
  assert.equal(seen.filter((argv) => argv[0] === "select-layout").length, 0, "and nothing is equalised");
});

test("a zoomed window is left alone — the user is reading it", async () => {
  // DEFENSIVE BRANCH, and this test pins the BRANCH, not a state a live server
  // reaches: measured on the lab server, `split-window`, `kill-pane` and
  // `select-layout -E` each unzoom the window, so the probe feeding this can
  // only see `zoomed` if tmux changes that behaviour. The user asked for the
  // guard, so it stays — asserted here so it cannot rot.
  const seen: string[][] = [];
  await openSessionPane(windowRunner(
    ["%1 0 0 1", "%2 100 0 0", "%5 200 0 0", "%6 200 30 0"].join("\n"),
    ["%1 0 0 1", "%2 100 0 0", "%5 200 0 0", "%6 200 30 0", "%9 200 60 0"].join("\n"),
    seen,
  ), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "child-column",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
  });
  assert.equal(seen.filter((argv) => argv[0] === "select-layout").length, 0,
    "equalising a zoomed window would fight what the user is looking at");
});

test("combination 4 — an orchestration RECOVER: same env, split off the opener when no column exists", async () => {
  const seen: string[][] = [];
  await openSessionPane(happyRunner(seen), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "child-column",
    role: { kind: "orchestration-child", orchestrationId: "orch-abc-1", stateVariant: "t1-xyz" },
    command: ["pi", "--session-id", "rg-child-t1", "@.pi/tasks/note.md"],
    decor: { label: "@t1-thing", colorSeed: "t1-xyz", state: "working", stateForSeconds: 0 },
  });
  const spawn = seen.find((argv) => argv[0] === "split-window")!;
  assert.equal(envOf(spawn).RG_STATE_VARIANT, "t1-xyz", "a recovered child keeps its exemption");
  assert.deepEqual(spawn.slice(0, 4), ["split-window", "-h", "-t", "%1"], "no column yet ⇒ split the opener");
});

test("combination 5 — a relay SUCCESSOR: beside the opener, its own env, no border", async () => {
  const seen: string[][] = [];
  // No `register` and no `decor`: a successor is not a child — it takes the
  // orchestration over, so nothing registers it and nothing paints it.
  const outcome = await openSessionPane(happyRunner(seen), {
    ownPane: "%1",
    cwd: "/repo",
    layout: "beside-opener",
    role: {
      kind: "successor",
      env: { RG_ORCHESTRATION_ID: "orch-abc-1", RG_GATE_MODE: "orchestrator", RG_HANDOFF_PATH: "docs/h.md" },
    },
    command: ["pi"],
  });
  assert.equal(outcome.ok, true);
  const spawn = seen.find((argv) => argv[0] === "split-window")!;
  assert.deepEqual(envOf(spawn), {
    RG_ORCHESTRATION_ID: "orch-abc-1",
    RG_GATE_MODE: "orchestrator",
    RG_HANDOFF_PATH: "docs/h.md",
  }, "a successor's env is the relay's own, passed through unchanged");
  assert.deepEqual(spawn.slice(0, 4), ["split-window", "-h", "-t", "%1"], "beside the opener, so it inherits the left column");
  assert.equal(seen.filter((a) => a[0] === "select-pane").length, 0, "no border: a successor is not a child");
  assert.equal(seen.filter((a) => a[0] === "setw").length, 0, "and no window option either");
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test("a failed split is a failed open — never a guessed pane id", async () => {
  const outcome = await openSessionPane(() => ({ ok: false, stdout: "", stderr: "no server" }), {
    ownPane: "%1", cwd: "/repo", layout: "child-column",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /no server/);
  assert.equal(outcome.paneId, undefined, "nothing exists, so nothing is named");
});

test("an empty spawn print is a failed open", async () => {
  const outcome = await openSessionPane(() => ({ ok: true, stdout: "\n", stderr: "" }), {
    ownPane: "%1", cwd: "/repo", layout: "child-column",
    role: { kind: "successor", env: {} },
    command: ["pi"],
  });
  assert.equal(outcome.ok, false);
});

test("a thrown tmux call is a failed open, not an exception the caller must catch", async () => {
  const outcome = await openSessionPane(() => { throw new Error("tmux exploded"); }, {
    ownPane: "%1", cwd: "/repo", layout: "child-column",
    role: { kind: "successor", env: {} },
    command: ["pi"],
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /tmux exploded/);
});

test("decor failure degrades to a warning, never to a failed open", async () => {
  const run: PaneRunner = (argv) => {
    if (argv[0] === "split-window") return { ok: true, stdout: "%7\n", stderr: "" };
    return { ok: false, stdout: "", stderr: "select failed" };
  };
  const outcome = await openSessionPane(run, {
    ownPane: "%1", cwd: "/repo", layout: "child-column",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
    decor: judgePaneDecor("j", "reviewer"),
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // The warning is FRAMED, not a bare tmux stderr: every caller pastes it into
  // a receipt, and "select failed" on its own reads like the session failed.
  assert.match(outcome.decorWarning ?? "", /降级/);
  assert.match(outcome.decorWarning ?? "", /select failed/);
});

test("a failed delivery check KEEPS the pane and its registration", async () => {
  const registered: string[] = [];
  const outcome = await openSessionPane(happyRunner(), {
    ownPane: "%1", cwd: "/repo", layout: "child-column",
    role: { kind: "judge", openerId: "o", judgeId: "j", role: "reviewer" },
    command: ["pi"],
    register: (paneId) => registered.push(paneId),
    verify: async () => ({ ok: false, detail: "通道里一条记录都没有" }),
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.deliveryFailed, true);
  assert.equal(outcome.paneId, "%7", "the pane is named so the caller can wait on it");
  assert.deepEqual(registered, ["%7"], "the registration survives: it may only be slow");
  assert.match(outcome.error, /一条记录都没有/);
});

// ---------------------------------------------------------------------------
// Decoration and the repaint (C2)
// ---------------------------------------------------------------------------

test("decoration writes colour, title and BOTH window options", () => {
  const seen: string[][] = [];
  const warning = decorateSessionPane(happyRunner(seen), "%7", {
    label: "@review-adviser", colorSeed: "j2", state: "working",
  });
  assert.equal(warning, undefined);
  const flat = seen.map((a) => a.join(" "));
  assert.equal(seen.length, 4, "colour + title + two window options");
  assert.ok(flat[0]!.includes("select-pane") && flat[0]!.includes("-P"));
  assert.ok(flat[1]!.includes("@review-adviser · working"));
  assert.ok(flat.some((s) => s.includes("pane-border-status top")));
  assert.ok(flat.some((s) => s.includes("pane-border-format")));
});

test("the repaint is throttled, skips an unchanged title, and swallows tmux failures", () => {
  const store = new Map<string, { title: string; at: number }>();
  const memory: PaneTitleMemory = store;
  const seen: string[][] = [];
  const run = happyRunner(seen);
  const paint = (state: "working" | "waiting-input", now: number, seconds: number): boolean =>
    refreshSessionPaneTitle(run, {
      paneId: "%7", label: "@review-reviewer", state, stateForSeconds: seconds, now, memory,
    });

  assert.equal(paint("working", 1_000, 0), true, "first paint always lands");
  assert.equal(paint("working", 1_000, 0), false, "an unchanged title is not repainted");
  assert.equal(paint("waiting-input", 1_500, 1), false, "…and a change inside the throttle window waits");
  assert.equal(paint("waiting-input", 1_000 + PANE_REPAINT_MIN_MS + 1, 9), true, "…until the window passes");
  assert.equal(seen.length, 2, "exactly two tmux calls for four requests");
  assert.ok(seen[1]!.join(" ").includes("waiting-input 9s"), "the state and its age are what the border shows");

  const exploding: PaneRunner = () => { throw new Error("tmux gone"); };
  assert.doesNotThrow(() => refreshSessionPaneTitle(exploding, {
    paneId: "%9", label: "@review-reviewer", state: "done", now: 5_000, memory,
  }), "a cosmetic write never breaks supervision");
});

test("judge labels are stable and sanitized", () => {
  assert.equal(judgePaneLabel("reviewer"), "@review-reviewer");
  assert.equal(judgePaneLabel("../../etc"), "@review-..-..-etc");
  assert.doesNotMatch(judgePaneLabel("../../etc"), /\//, "no path separator survives (dots are display-only, never a path)");
  assert.equal(judgePaneDecor("rg-reviewer-x", "adviser").colorSeed, "rg-reviewer-x", "colour hashes on the judge id");
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

test("close kills exactly one pane, and takes the label bar down only when asked", () => {
  const seen: string[][] = [];
  assert.equal(closeSessionPane(happyRunner(seen), "%7").ok, true);
  assert.deepEqual(seen.map((argv) => argv[0]), ["list-panes", "kill-pane"],
    "the window is probed while the pane still exists, then the pane dies");
  assert.deepEqual(seen[1], ["kill-pane", "-t", "%7"]);

  const withLabels: string[][] = [];
  // Addressed through the CALLER'S pane (%1), never the dying one (%7): `setw`
  // only needs a pane to name the window, and the pane being closed is exactly
  // the id that may already be gone — a failed option write would leave the
  // border line switched on in the user's window for good.
  closeSessionPane(happyRunner(withLabels), "%7", { hideLabelsVia: "%1" });
  const flat = withLabels.map((a) => a.join(" "));
  assert.equal(flat.length, 4, "two option resets, the probe, then the kill");
  assert.ok(flat[0]!.includes("-u") && flat[0]!.includes("pane-border-status"));
  assert.ok(flat[0]!.includes("-t %1") && !flat[0]!.includes("%7"), "the window is named by a pane we know is alive");
  assert.equal(flat[3], "kill-pane -t %7", "the options come down BEFORE the pane dies");
});

test("closing a pane equalises what is left of its column", () => {
  const closeWith = (before: string, after: string): string[] => {
    const seen: string[][] = [];
    let killed = false;
    const run: PaneRunner = (argv) => {
      seen.push([...argv]);
      if (argv[0] === "kill-pane") { killed = true; return { ok: true, stdout: "", stderr: "" }; }
      if (argv[0] === "list-panes") return { ok: true, stdout: killed ? after : before, stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
    assert.equal(closeSessionPane(run, "%6").ok, true);
    return seen.filter((argv) => argv[0] === "select-layout").map((argv) => argv.join(" "));
  };
  // The third column survives with two panes ⇒ its heights AND the widths.
  assert.deepEqual(
    closeWith(
      ["%1 0 0 0", "%2 100 0 0", "%5 200 0 0", "%6 200 30 0"].join("\n"),
      ["%1 0 0 0", "%2 100 0 0", "%5 200 0 0", "%8 200 30 0"].join("\n"),
    ),
    ["select-layout -E -t %5", "select-layout -E -t %1"],
  );
  // Down to one pane in that column ⇒ there is no height left to share.
  assert.deepEqual(
    closeWith(
      ["%1 0 0 0", "%2 100 0 0", "%5 200 0 0", "%6 200 30 0"].join("\n"),
      ["%1 0 0 0", "%2 100 0 0", "%5 200 0 0"].join("\n"),
    ),
    ["select-layout -E -t %1"],
  );
});

test("who may take the window's label bar down: the last pane, and never a guest", () => {
  // Turning the bar ON is what makes a decorated border visible (C1); leaving
  // it on forever is litter in the user's window, and turning it off while a
  // sibling still needs it blanks a border that is in use.
  assert.equal(releasesWindowLabels({ remainingDecoratedPanes: 0, insideOrchestration: false }), true);
  assert.equal(releasesWindowLabels({ remainingDecoratedPanes: 1, insideOrchestration: false }), false,
    "a sibling still on screen keeps it up");
  assert.equal(releasesWindowLabels({ remainingDecoratedPanes: 0, insideOrchestration: true }), false,
    "inside an orchestration the project manager owns that bar — a child never releases it");
});


test("close failure is reported, not swallowed", () => {
  const outcome = closeSessionPane(() => ({ ok: false, stdout: "", stderr: "gone" }), "%7");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error, "gone");
});

// ---------------------------------------------------------------------------
// The recovery judgement both recover tools share
// ---------------------------------------------------------------------------

test("one recovery judgement: refuse unknown, closed, pane-less, alive and unreadable", () => {
  assert.equal(paneRecoverability({ registered: false }), "unknown");
  assert.equal(paneRecoverability({ registered: true, closedAt: "2026-09-05T00:00:00Z", paneId: "%7" }), "closed");
  assert.equal(paneRecoverability({ registered: true }), "no-pane");
  assert.equal(paneRecoverability({ registered: true, paneId: "%7", paneAlive: true }), "alive");
  assert.equal(paneRecoverability({ registered: true, paneId: "%7", paneAlive: undefined }), "unknown-liveness",
    "tmux unreadable is missing information — never a licence to open a second process");
  assert.equal(paneRecoverability({ registered: true, paneId: "%7", paneAlive: false }), "recoverable");
});

// ---------------------------------------------------------------------------
// The env builder, on its own
// ---------------------------------------------------------------------------

test("the env builder is the only assembly point, and it omits what it was not given", () => {
  assert.deepEqual(buildSessionEnv({ kind: "judge", openerId: "o", judgeId: "j", role: "adviser" }), {
    RG_JUDGE_OPENER: "o", RG_JUDGE_ID: "j", RG_JUDGE_ROLE: "adviser",
  });
  assert.deepEqual(buildSessionEnv({ kind: "orchestration-child", orchestrationId: "orch-1", stateVariant: "t2" }), {
    RG_ORCHESTRATION_ID: "orch-1", RG_GATE_MODE: "loop", RG_STATE_VARIANT: "t2",
  });
  const relay = { RG_ORCHESTRATION_ID: "orch-1", RG_GATE_MODE: "orchestrator" };
  const built = buildSessionEnv({ kind: "successor", env: relay });
  assert.deepEqual(built, relay);
  assert.notEqual(built, relay, "a copy: the caller's object is never handed to tmux by reference");
});

test("the judge argv carries the read-only contract and the resume keys", () => {
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
