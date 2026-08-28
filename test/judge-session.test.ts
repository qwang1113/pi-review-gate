/**
 * The judge session as the managed entity (user ask 2026-08-28).
 *
 * These tests pin the two rules that were MEASURED during the change and are
 * easy to regress into something that looks right:
 *  - a finished session is recognised by its own exit-code file, even when the
 *    pid it recorded happens to be alive again (recycled);
 *  - the conclusion is the last text carrying a VERDICT FENCE, not the last
 *    text — judges sign off after their verdict, and "last message" silently
 *    returns the sign-off.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readJudgeSessionState,
  newestTranscript,
  readJudgeConclusion,
  readStderrTail,
  terminateJudgeSession,
} from "../lib/judge-session.ts";
import { spawnJudgePane, killPane, killSession, tmuxAvailable, paneAlive } from "../lib/tmux-session.ts";
import { writeJudgeSpawnFiles } from "../lib/judge-prompt.ts";

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "rg-judge-session-"));
}

function paths(dir: string) {
  return {
    sessionDir: join(dir, "sessions"),
    pidPath: join(dir, "pid"),
    exitCodePath: join(dir, "exit-code"),
    stderrPath: join(dir, "stderr.log"),
  };
}

/** One transcript line in pi's session-jsonl shape. */
function assistantLine(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
}

test("lifecycle: nothing recorded yet is 'unknown' (a just-spawned child is not 'ended')", () => {
  const dir = workdir();
  try {
    assert.equal(readJudgeSessionState(paths(dir)).lifecycle, "unknown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle: a live recorded pid is 'running'", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242");
    const state = readJudgeSessionState(paths(dir), () => true);
    assert.equal(state.lifecycle, "running");
    assert.equal(state.pid, 4242);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * THE CRASH PATH (round-1 P1, reviewer-reproduced): a wrapper killed BEFORE it
 * could record an exit code leaves a pid file and nothing else. Once the OS
 * reassigns that number, "the pid is alive" is not "our judge is running" —
 * and signalling its GROUP would SIGTERM a stranger's whole process tree.
 *
 * The recorded START TIME is what distinguishes them.
 */
test("lifecycle: a RECYCLED pid (alive, but not the process we recorded) is 'vanished'", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242 Fri Aug 28 10:00:00 2026");
    const state = readJudgeSessionState(
      paths(dir),
      () => true,                              // the number is in use…
      () => "Mon Jan  1 00:00:00 2020",        // …by a process that started elsewhen
    );
    assert.equal(state.lifecycle, "vanished");
    assert.equal(state.pid, 4242);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: a RECYCLED pid is never signalled (the reviewer's reproduction)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242 Fri Aug 28 10:00:00 2026");
    let calls = 0;
    const res = terminateJudgeSession(
      paths(dir),
      () => { calls++; },
      () => "Mon Jan  1 00:00:00 2020",   // that pid started at a different time
    );
    assert.equal(calls, 0, "signalling a stranger's process group is the accident this prevents");
    assert.equal(res.signalled, false);
    assert.equal(res.reason, "not-ours");
    assert.equal(res.pid, 4242);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: the SAME process (start time matches) is still signalled — the guard is not a blanket refusal", () => {
  const dir = workdir();
  try {
    const started = "Fri Aug 28 10:00:00 2026";
    writeFileSync(join(dir, "pid"), `4242 ${started}`);
    const seen: number[] = [];
    const res = terminateJudgeSession(paths(dir), (t) => { seen.push(t); }, () => started);
    assert.equal(res.signalled, true);
    assert.deepEqual(seen, [-4242], "still the whole group");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * FAIL CLOSED WHEN IDENTITY CANNOT BE ESTABLISHED (round-1 P1, reviewer).
 *
 * The reviewer put a `ps` stub on PATH that exits 0 printing nothing. The
 * launcher then wrote `"30327 "` — indistinguishable from the old format — and
 * the identity guard silently FAILED OPEN, signalling `-30326`, i.e. exactly
 * the unrelated-process-group hazard the guard exists to prevent.
 *
 * The two readers deliberately disagree about this state, because their
 * failure modes differ: mis-reading liveness disrupts a round, mis-directing a
 * SIGTERM destroys somebody else's work.
 */
test("terminate: an UNVERIFIABLE identity is never signalled (ps produced no start time)", () => {
  const dir = workdir();
  try {
    // Exactly what the launcher writes when `ps` prints nothing.
    writeFileSync(join(dir, "pid"), "30327 ");
    let calls = 0;
    const res = terminateJudgeSession(paths(dir), () => { calls++; }, () => undefined);
    assert.equal(calls, 0, "an unverifiable pid must never be signalled — this was the fail-open hole");
    assert.equal(res.signalled, false);
    assert.equal(res.reason, "unverifiable");
    assert.equal(res.pid, 30327);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle: an unverifiable identity stays LENIENT (a running judge is not declared dead)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "30327 ");
    // Liveness still decides here: killing a round because `ps` is unavailable
    // would be its own bug, and nothing is destroyed by being wrong this way.
    assert.equal(readJudgeSessionState(paths(dir), () => true, () => undefined).lifecycle, "running");
    assert.equal(readJudgeSessionState(paths(dir), () => false, () => undefined).lifecycle, "vanished");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle: a pid file with NO start time degrades to plain liveness (older format, never crashes)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242");
    assert.equal(readJudgeSessionState(paths(dir), () => true, () => undefined).lifecycle, "running");
    assert.equal(readJudgeSessionState(paths(dir), () => false, () => undefined).lifecycle, "vanished");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle: a recorded pid that is gone is 'vanished' (crashed without recording an exit code)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242");
    assert.equal(readJudgeSessionState(paths(dir), () => false).lifecycle, "vanished");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle: exit-code WINS over a live pid (pid recycling must not resurrect a finished session)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242");
    writeFileSync(join(dir, "exit-code"), "0");
    // pidAlive says "yes" — the OS handed that number to someone else.
    const state = readJudgeSessionState(paths(dir), () => true);
    assert.equal(state.lifecycle, "finished");
    assert.equal(state.exitCode, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle: a non-zero exit code is preserved (crash diagnosis)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "exit-code"), "7");
    assert.equal(readJudgeSessionState(paths(dir), () => false).exitCode, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle: a garbled pid file degrades to 'unknown' instead of throwing", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "not-a-pid");
    assert.equal(readJudgeSessionState(paths(dir), () => true).lifecycle, "unknown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transcript: the newest TOP-LEVEL jsonl wins and subagent-artifacts/ is never descended into", () => {
  const dir = workdir();
  try {
    const sessions = join(dir, "sessions");
    mkdirSync(join(sessions, "subagent-artifacts"), { recursive: true });
    const older = join(sessions, "older.jsonl");
    const newer = join(sessions, "newer.jsonl");
    const nested = join(sessions, "subagent-artifacts", "child.jsonl");
    writeFileSync(older, assistantLine("old"));
    writeFileSync(newer, assistantLine("new"));
    // The nested one is the NEWEST on disk — a recursive search would take it.
    writeFileSync(nested, assistantLine("a subagent's transcript, not the judge's"));
    const past = new Date(Date.now() - 60_000);
    utimesSync(older, past, past);
    assert.equal(newestTranscript(sessions), newer);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("transcript: a missing sessions/ directory yields no transcript (never throws)", () => {
  const dir = workdir();
  try {
    assert.equal(newestTranscript(join(dir, "sessions")), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("conclusion: the VERDICT FENCE wins over the later sign-off (the measured trap)", () => {
  const dir = workdir();
  try {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), [
      assistantLine("先分析一下这个 commit range。"),
      assistantLine('```json\n{"gate":"READY","findings":[]}\n```\n\n- 无 P0/P1。'),
      // Real sign-off observed in this repo's own audits — "last message" here
      // returns THIS and drops the verdict entirely.
      assistantLine("Verdict 已输出并已向主会话发出完成信号。"),
    ].join("\n"));
    const got = readJudgeConclusion(sessions);
    assert.equal(got.hasVerdict, true);
    assert.match(got.text!, /"gate":"READY"/);
    assert.doesNotMatch(got.text!, /完成信号/, "the sign-off must not be what we hand back");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("conclusion: with no fence anywhere, the last non-empty text is returned and flagged as fence-less", () => {
  const dir = workdir();
  try {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), [
      assistantLine("正在读取 diff……"),
      assistantLine("还在分析。"),
    ].join("\n"));
    const got = readJudgeConclusion(sessions);
    assert.equal(got.hasVerdict, false);
    assert.equal(got.text, "还在分析。");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("conclusion: a half-written final line (the judge is still writing) is skipped, not fatal", () => {
  const dir = workdir();
  try {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), [
      assistantLine('```json\n{"gate":"BLOCKED","findings":[]}\n```'),
      '{"type":"message","message":{"role":"assis',
    ].join("\n"));
    const got = readJudgeConclusion(sessions);
    assert.equal(got.hasVerdict, true);
    assert.match(got.text!, /BLOCKED/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("conclusion: a transcript with no assistant output is reported as empty, not as a crash", () => {
  const dir = workdir();
  try {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } }));
    const got = readJudgeConclusion(sessions);
    assert.equal(got.text, undefined);
    assert.equal(got.hasVerdict, false);
    assert.ok(got.transcriptPath, "the transcript it looked at is still reported");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stderr: the tail is bounded, and a missing log is simply absent", () => {
  const dir = workdir();
  try {
    assert.equal(readStderrTail(join(dir, "stderr.log")), undefined);
    writeFileSync(join(dir, "stderr.log"), Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
    const tail = readStderrTail(join(dir, "stderr.log"), 5);
    assert.equal(tail, ["line 45", "line 46", "line 47", "line 48", "line 49"].join("\n"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: signals the process GROUP, not the bare pid (pi is the wrapper's child)", () => {
  const dir = workdir();
  try {
    const started = "Fri Aug 28 10:00:00 2026";
    writeFileSync(join(dir, "pid"), `4242 ${started}`);
    const seen: Array<{ target: number; signal: string }> = [];
    const res = terminateJudgeSession(paths(dir), (target, signal) => { seen.push({ target, signal }); }, () => started);
    assert.equal(res.signalled, true);
    assert.deepEqual(seen, [{ target: -4242, signal: "SIGTERM" }], "negative pid = the whole group");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: falls back to the bare pid when the group cannot be signalled", () => {
  const dir = workdir();
  try {
    const started = "Fri Aug 28 10:00:00 2026";
    writeFileSync(join(dir, "pid"), `4242 ${started}`);
    const seen: number[] = [];
    const res = terminateJudgeSession(paths(dir), (target) => {
      seen.push(target);
      if (target < 0) throw new Error("ESRCH: no such process group");
    }, () => started);
    assert.equal(res.signalled, true);
    assert.deepEqual(seen, [-4242, 4242]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * Round-2 P1 (reviewer, mutation-verified): the exit-code guard had NO
 * behavioural test — deleting it left the whole file green. This is the test
 * that fails when it is removed.
 *
 * The rule: a recorded exit code means the wrapper already returned, so that
 * pid is not ours any more. Signalling its GROUP after the OS recycled the
 * number would kill an unrelated process tree.
 */
test("terminate: a FINISHED session is never signalled, even with a pid on file (PID reuse)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242");
    writeFileSync(join(dir, "exit-code"), "0");
    let calls = 0;
    const res = terminateJudgeSession(paths(dir), () => { calls++; });
    assert.equal(calls, 0, "a finished session must not be signalled at all");
    assert.deepEqual(res, { signalled: false, reason: "finished" });
    // Same input, same answer as the lifecycle reader — the two must agree.
    assert.equal(readJudgeSessionState(paths(dir), () => true).lifecycle, "finished");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: a non-zero exit code is equally final (a crashed judge is not re-signalled)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242");
    writeFileSync(join(dir, "exit-code"), "7");
    let calls = 0;
    terminateJudgeSession(paths(dir), () => { calls++; });
    assert.equal(calls, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: an already-finished child is a successful no-op (review_close is idempotent)", () => {
  const dir = workdir();
  try {
    // No pid file at all.
    assert.deepEqual(
      terminateJudgeSession(paths(dir), () => { throw new Error("must not be called"); }),
      { signalled: false, reason: "no-pid" },
    );
    // A pid whose recorded process is gone: nothing of ours is running, so
    // nothing is signalled — and that is still a successful close.
    writeFileSync(join(dir, "pid"), "4242 Fri Aug 28 10:00:00 2026");
    const res = terminateJudgeSession(
      paths(dir),
      () => { throw new Error("must not be called"); },
      () => undefined,   // ps: no such process
    );
    assert.equal(res.signalled, false);
    assert.equal(res.reason, "not-ours");
    assert.equal(res.pid, 4242);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: pid 0 and 1 are never signalled (0 = our own group, 1 = init)", () => {
  const dir = workdir();
  try {
    for (const dangerous of ["0", "1"]) {
      writeFileSync(join(dir, "pid"), dangerous);
      assert.deepEqual(
        terminateJudgeSession(paths(dir), () => { throw new Error("must not be called"); }),
        { signalled: false, reason: "no-pid" },
        `pid ${dangerous} must never be signalled`,
      );
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/**
 * The claim under test is the one that decides whether `review_close` actually
 * closes anything: pi is the launcher's CHILD, so terminating only the recorded
 * pid would leave pi running as an orphan. This runs the real spawn path (the
 * launcher is `exec`ed, which is what makes it the pane's process-group leader)
 * and signals with the real `process.kill`.
 */
/**
 * The GENERATED launcher, running in a real pane (round-1 P1, reviewer: the
 * earlier tests exercised a hand-written stand-in, so nothing proved that what
 * `writeJudgeSpawnFiles` actually writes behaves this way).
 *
 * `pi` itself is replaced by a stub on PATH — the contract under test belongs
 * to the launcher, not to pi: does it record its pid, keep the pane's TTY
 * usable for an interactive child, tee stderr to disk while still showing it,
 * and record the exit code once the child returns?
 */
const launcherIntegration = test("tmux integration: the generated launcher records pid/exit-code/stderr and keeps the TTY interactive", { skip: !tmuxAvailable() }, async () => {
  const work = mkdtempSync(join(tmpdir(), "rg-launcher-"));
  const sess = `rg-launcher-${Date.now().toString(36)}`;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", sess, "-c", work, "sleep 300"], { encoding: "utf8" });

    // A `pi` stub: draws a screen (so capture-pane has something to find),
    // writes to stderr (so the tee is exercised), then READS A LINE from the
    // TTY and exits with a code derived from it.
    const binDir = join(work, "bin");
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, "pi");
    writeFileSync(stub, [
      "#!/bin/bash",
      'echo "PI-STUB-SCREEN"',
      'echo "pi-stub: a warning on stderr" >&2',
      "read -r line",
      'printf %s "$line" > "$PI_STUB_INPUT_FILE"',
      "exit 0",
    ].join("\n"));
    chmodSync(stub, 0o755);

    const files = writeJudgeSpawnFiles({
      repoRoot: work,
      role: "reviewer",
      agents: {},
      title: "launcher-probe",
      workDir: join(work, "rg-launcher-probe"),
    });

    const inputFile = join(work, "input.txt");
    // PATH is forced with `env`, NOT with tmux's `-e` (measured on this host):
    // the pane's default-shell is fish, which rebuilds PATH from its own config
    // at startup and drops whatever `-e PATH=` provided — the real `pi` ran
    // instead of the stub. Ordinary `-e` variables (the RG_* ones the launcher
    // reads) are unaffected, so they still travel that way. `env` also avoids
    // shell-specific assignment syntax entirely.
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries({ ...files.env, PI_STUB_INPUT_FILE: inputFile })) envArgs.push("-e", `${k}=${v}`);
    const paneSess = `${sess}-run`;
    const command = `/usr/bin/env PATH=${binDir}:/usr/bin:/bin /bin/bash ${files.launcherPath}`;
    execFileSync("tmux", ["new-session", "-d", "-s", paneSess, "-c", work, ...envArgs, command], { encoding: "utf8" });
    const pane = execFileSync("tmux", ["list-panes", "-t", paneSess, "-F", "#{pane_id}"], { encoding: "utf8" }).trim();
    assert.match(pane, /^%\d+$/, "a concrete pane id — never an empty target");

    // --- while the session RUNS ---
    for (let i = 0; i < 60 && !existsSync(files.pidPath); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(files.pidPath), "the launcher recorded its pid");
    const running = readJudgeSessionState(files);
    assert.equal(running.lifecycle, "running", "a live judge is 'running' from its artifacts alone");

    // Criterion 2: the TUI is NOT broken by the stderr redirection — the pane
    // still shows the child's screen.
    let screen = "";
    for (let i = 0; i < 60 && !screen.includes("PI-STUB-SCREEN"); i++) {
      screen = execFileSync("tmux", ["capture-pane", "-p", "-t", pane], { encoding: "utf8" });
      if (!screen.includes("PI-STUB-SCREEN")) await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(screen, /PI-STUB-SCREEN/, "capture-pane returns the child's live screen");
    assert.match(screen, /a warning on stderr/, "stderr is still VISIBLE in the pane (teed, not swallowed)");

    for (let i = 0; i < 60 && !existsSync(files.stderrPath); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(readFileSync(files.stderrPath, "utf8"), /a warning on stderr/, "and it also landed on disk");

    // Criterion 2: interactive input still reaches the child.
    execFileSync("tmux", ["send-keys", "-t", pane, "-l", "interactive-input-reaches-pi"], { encoding: "utf8" });
    execFileSync("tmux", ["send-keys", "-t", pane, "Enter"], { encoding: "utf8" });

    // --- after it ENDS ---
    // Wait for CONTENT, not merely for the file to appear: `printf` creates it
    // and fills it as two observable steps, and an empty exit-code reads as
    // "not recorded yet" (which it accurately is).
    const exitRecorded = (): boolean => {
      try { return readFileSync(files.exitCodePath, "utf8").trim() !== ""; } catch { return false; }
    };
    for (let i = 0; i < 80 && !exitRecorded(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(exitRecorded(), "the exit code was recorded after the child returned");
    assert.equal(readFileSync(inputFile, "utf8"), "interactive-input-reaches-pi", "the child received the keystrokes");
    const ended = readJudgeSessionState(files);
    assert.equal(ended.lifecycle, "finished");
    assert.equal(ended.exitCode, 0);

    // And the pane is gone on its own — the user's reported bug, end to end.
    for (let i = 0; i < 40 && paneAlive(pane); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(paneAlive(pane), false, "the finished judge left no pane behind");
  } finally {
    killSession(`${sess}-run`);
    killSession(sess);
    rmSync(work, { recursive: true, force: true });
  }
});

/**
 * Round-1 P1 (reviewer): a second spawn under the SAME title must not inherit
 * the previous run's exit-code — that classified a brand-new judge as finished
 * before it started.
 */
test("a same-title respawn gets a clean slate (no inherited exit-code or transcript)", () => {
  const root = workdir();
  try {
    const workDir = join(root, "rg-same-title");
    const first = writeJudgeSpawnFiles({ repoRoot: root, role: "reviewer", agents: {}, title: "same", workDir });
    // The first run finished with a verdict on disk.
    writeFileSync(first.exitCodePath, "0");
    mkdirSync(first.sessionDir, { recursive: true });
    writeFileSync(join(first.sessionDir, "s.jsonl"), assistantLine('```json\n{"gate":"READY","findings":[]}\n```'));
    assert.equal(readJudgeSessionState(first).lifecycle, "finished");

    const second = writeJudgeSpawnFiles({ repoRoot: root, role: "reviewer", agents: {}, title: "same", workDir });
    assert.notEqual(second.exitCodePath, first.exitCodePath, "the second run gets its own artifact paths");
    assert.equal(readJudgeSessionState(second).lifecycle, "unknown",
      "a fresh spawn must NOT be classified as finished by the previous run's exit-code");
    assert.equal(readJudgeConclusion(second.sessionDir).text, undefined,
      "and it must not hand back the previous run's verdict");
    // The finished run stays readable — nothing was destroyed to achieve this.
    assert.equal(readJudgeSessionState(first).lifecycle, "finished");
  } finally { rmSync(root, { recursive: true, force: true }); }
});


const terminateIntegration = test("tmux integration: termination reaches pi through the process GROUP (not via tmux tearing the pane down)", { skip: !tmuxAvailable() }, async () => {
  const work = mkdtempSync(join(tmpdir(), "rg-term-"));
  const sess = `rg-term-${Date.now().toString(36)}`;
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", sess, "-c", work, "sleep 300"], { encoding: "utf8" });
    // THE WRAPPER IGNORES SIGTERM — this is what makes the test able to FAIL
    // (round-2 P1, reviewer, mutation-verified). With a wrapper that dies on
    // TERM, killing only the wrapper collapses its pane, and tmux then reaps
    // the child anyway: the wrapper-only implementation the goal forbids would
    // pass. Trapping TERM in the wrapper removes tmux from the equation —
    // only a signal delivered to the GROUP can reach the child.
    const launcher = join(work, "start.sh");
    writeFileSync(launcher, [
      "#!/bin/bash",
      // A HANDLER, not `trap '' TERM`: an ignored signal (SIG_IGN) is
      // INHERITED across exec, so `sleep` would ignore TERM too and the test
      // could never observe the group delivery. A handler is reset to the
      // default in the child, so only the wrapper survives the signal.
      "trap ':' TERM",
      // Same pid record shape the real launcher writes: pid + start time.
      'printf \'%s %s\' "$$" "$(ps -o lstart= -p $$ | tr -d \'\\n\')" > "$RG_PID_FILE"',
      "sleep 120 &",
      'printf %s "$!" > "$RG_CHILD_PID_FILE"',
      'wait $!',
      // The handler makes `wait` return as soon as TERM arrives, so without
      // this the wrapper would fall off the end and exit — and the test could
      // not tell "the group was signalled" from "the wrapper died and tmux
      // reaped everything". Staying alive is what proves the child's death
      // came from the signal, not from the pane collapsing.
      "sleep 300",
    ].join("\n"));
    chmodSync(launcher, 0o755);

    const pidPath = join(work, "pid");
    const childPidPath = join(work, "child-pid");
    const spawned = spawnJudgePane({
      title: "term",
      cwd: work,
      command: 'exec /bin/bash "$RG_LAUNCHER"',
      env: { RG_LAUNCHER: launcher, RG_PID_FILE: pidPath, RG_CHILD_PID_FILE: childPidPath },
      target: sess,
    });
    assert.equal(spawned.ok, true, spawned.error ?? "spawn failed");

    for (let i = 0; i < 40 && !(existsSync(pidPath) && existsSync(childPidPath)); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // The pid record is `<pid> <start time>` — take the pid off the front.
    const pidRecord = readFileSync(pidPath, "utf8").trim();
    const wrapperPid = Number(pidRecord.split(" ")[0]);
    assert.match(pidRecord, /^\d+ \w/, "the launcher records a start time alongside the pid");
    const childPid = Number(readFileSync(childPidPath, "utf8").trim());
    assert.ok(wrapperPid > 1 && childPid > 1, "both pids were recorded");
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };
    assert.ok(alive(childPid), "the stand-in for pi is running before we terminate");

    // exitCodePath points at a file that does NOT exist here: this session is
    // still running, so the guard must let the signal through.
    const res = terminateJudgeSession({ pidPath, exitCodePath: join(work, "exit-code") });
    assert.equal(res.signalled, true);
    assert.equal(res.pid, wrapperPid);

    // THE DISCRIMINATING ASSERTION: the child must die. It can only have
    // received the signal through the process GROUP — the wrapper ignores
    // TERM and is still alive, so tmux never tore the pane (and its children)
    // down. `kill(pid)` instead of `kill(-pid)` leaves this child running.
    for (let i = 0; i < 60 && alive(childPid); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(alive(childPid), false, "pi (the wrapper's child) was terminated via the process GROUP");
    assert.equal(alive(wrapperPid), true,
      "and the wrapper — which ignores TERM — is still up, proving tmux did not do the cleanup for us");

    killPane(spawned.paneId!);
  } finally {
    killSession(sess);
    rmSync(work, { recursive: true, force: true });
  }
});

// Node's test runner needs the handle referenced (same idiom as the other
// integration tests in this repo).
void terminateIntegration;
void launcherIntegration;

