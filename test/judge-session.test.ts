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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readJudgeSessionState,
  newestTranscript,
  readJudgeConclusion,
  readStderrTail,
  lastActivityAt,
  terminateJudgeSession,
} from "../lib/judge-session.ts";
import { classifyChildren } from "../lib/child-watch.ts";
import { STALL_MOTION_MAX_AGE_SEC } from "../lib/loop-stall.ts";

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
 * IDENTITY, AND WHAT TO DO WHEN IT CANNOT BE ESTABLISHED.
 *
 * Two reviewer-reproduced failures shaped the tests below.
 *
 * (1) FAIL OPEN (round-1 P1): a `ps` stub that exits 0 printing nothing makes
 *     the launcher write `"30327 "` — indistinguishable from the old,
 *     timestamp-less format. Treating that as "probably ours" signalled
 *     `-30326`: the unrelated-process-group hazard, restored.
 *
 * (2) CONFLATING "GONE" WITH "CANNOT ASK" (round-2 P1): `ps` returns nothing
 *     both when the process is gone AND when the query fails. Treating the
 *     second as "not ours" declared a LIVE judge `vanished`, and the registry
 *     sweep closes vanished children — it would kill a working judge.
 *
 * Hence three states, liveness as the tie-breaker, and the two readers
 * deliberately disagreeing about "unverifiable": mis-reading liveness disrupts
 * a round, mis-directing a SIGTERM destroys somebody else's work.
 */
test("lifecycle: a LIVE judge whose start time cannot be queried stays running (ps failure is not death)", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "42890 Fri Aug 28 10:00:00 2026");
    const state = readJudgeSessionState(
      paths(dir),
      () => true,        // the process IS alive
      () => undefined,   // but ps cannot say when it started
    );
    assert.equal(state.lifecycle, "running",
      "a working judge must not be declared dead just because ps failed — the sweep would kill it");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lifecycle: a GONE process with an unqueryable start time is still vanished", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "42890 Fri Aug 28 10:00:00 2026");
    const state = readJudgeSessionState(paths(dir), () => false, () => undefined);
    assert.equal(state.lifecycle, "vanished", "nothing holds the pid — our process really is gone");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: a live pid with an unqueryable start time is UNVERIFIABLE, never signalled", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "42890 Fri Aug 28 10:00:00 2026");
    let calls = 0;
    const res = terminateJudgeSession(paths(dir), () => { calls++; }, () => undefined, () => true);
    assert.equal(calls, 0);
    assert.equal(res.reason, "unverifiable", "cannot prove it is ours ⇒ do not signal its group");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: an UNVERIFIABLE identity is never signalled (ps produced no start time)", () => {
  const dir = workdir();
  try {
    // Exactly what the launcher writes when `ps` prints nothing.
    writeFileSync(join(dir, "pid"), "30327 ");
    let calls = 0;
    // pidAlive is injected too: with no recorded start time the answer is
    // `unverifiable` either way, and pinning it keeps the test independent of
    // whether pid 30327 happens to exist on the machine running it.
    const res = terminateJudgeSession(paths(dir), () => { calls++; }, () => undefined, () => false);
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

/**
 * Round-5 P1 (reviewer), and observed live: `lastActivityAt` was documented on
 * ChildSnapshot but never SUPPLIED, so classifyChildren timed every judge from
 * its spawn and declared any review longer than STALL_MOTION_MAX_AGE_SEC
 * "silent" — while it was still streaming findings.
 */
test("activity: the newest write among transcript, stderr and inbox is the sign of life", () => {
  const dir = workdir();
  try {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const old = new Date(Date.now() - 60 * 60 * 1000);

    writeFileSync(join(sessions, "s.jsonl"), assistantLine("working"));
    utimesSync(join(sessions, "s.jsonl"), old, old);
    const onlyTranscript = lastActivityAt({ sessionDir: sessions, stderrPath: join(dir, "stderr.log") });
    // Compare against the mtime the filesystem actually stored: utimesSync
    // rounds, so the source Date can differ by a millisecond.
    const storedMtime = new Date(statSync(join(sessions, "s.jsonl")).mtimeMs).toISOString();
    assert.equal(onlyTranscript, storedMtime, "the transcript alone is already evidence");

    // A newer write anywhere else wins — any of them proves the judge is alive.
    writeFileSync(join(dir, "stderr.log"), "still going");
    const withStderr = lastActivityAt({ sessionDir: sessions, stderrPath: join(dir, "stderr.log") });
    assert.ok(withStderr! > onlyTranscript!, "a newer stderr write moves the timestamp forward");

    const inbox = join(dir, "inbox.jsonl");
    writeFileSync(inbox, '{"type":"question"}');
    const withInbox = lastActivityAt({ sessionDir: sessions, stderrPath: join(dir, "stderr.log") }, [inbox]);
    assert.ok(withInbox! >= withStderr!, "extra watched paths count too");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("activity: a session that has written nothing yet reports no activity (caller falls back to spawnedAt)", () => {
  const dir = workdir();
  try {
    assert.equal(
      lastActivityAt({ sessionDir: join(dir, "sessions"), stderrPath: join(dir, "stderr.log") }),
      undefined,
      "no writes yet is not an error — a just-spawned child simply has no activity",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("activity: a long-running judge that is still writing is NOT classified as silent", () => {
  const dir = workdir();
  try {
    const sessions = join(dir, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), assistantLine("streaming a finding right now"));
    // Spawned far beyond the silence bound — exactly the case that misfired.
    const spawnedAt = new Date(Date.now() - (STALL_MOTION_MAX_AGE_SEC + 600) * 1000).toISOString();
    const child = {
      title: "reviewer-long",
      sessionId: "rg-reviewer-long",
      role: "reviewer",
      spawnedAt,
      alive: true,
      lastActivityAt: lastActivityAt({ sessionDir: sessions, stderrPath: join(dir, "stderr.log") }),
    };
    const verdict = classifyChildren([child], Date.now());
    assert.equal(verdict.terminated.length, 0, "a judge that just wrote must not be declared silent");
    assert.equal(verdict.inFlight.length, 1);

    // Without the activity stamp it WOULD be — that is the bug being pinned.
    const { lastActivityAt: _drop, ...noActivity } = child;
    assert.equal(classifyChildren([noActivity], Date.now()).terminated[0]?.reason, "silent-timeout");
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

test("terminate: an already-finished child is a successful no-op (judge_close is idempotent)", () => {
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
      () => undefined,   // ps: cannot answer
      () => false,       // and nothing holds the pid ⇒ the process really is gone
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
 * Round-1 P1 (reviewer): a second spawn under the SAME title must not inherit
 * the previous run's exit-code — that classified a brand-new judge as finished
 * before it started.
 */
test("a same-title respawn gets a clean slate (no inherited exit-code or transcript)", () => {
  const root = workdir();
  try {
    // Two run dirs under the same work dir (the extension mints a fresh run
    // dir per spawn — the first run's exit-code must not leak into the second).
    const workDir = join(root, "rg-same-title");
    const runA = join(workDir, "runs", "a");
    const runB = join(workDir, "runs", "b");
    mkdirSync(join(runA, "sessions"), { recursive: true });
    mkdirSync(join(runB, "sessions"), { recursive: true });
    const first = paths(runA);
    const second = paths(runB);
    // The first run finished with a verdict on disk.
    writeFileSync(first.exitCodePath, "0");
    writeFileSync(join(first.sessionDir, "s.jsonl"), assistantLine('```json\n{"gate":"READY","findings":[]}\n```'));
    assert.equal(readJudgeSessionState(first).lifecycle, "finished");

    assert.notEqual(second.exitCodePath, first.exitCodePath, "the second run gets its own artifact paths");
    assert.equal(readJudgeSessionState(second).lifecycle, "unknown",
      "a fresh spawn must NOT be classified as finished by the previous run's exit-code");
    assert.equal(readJudgeConclusion(second.sessionDir).text, undefined,
      "and it must not hand back the previous run's verdict");
    // The finished run stays readable — nothing was destroyed to achieve this.
    assert.equal(readJudgeSessionState(first).lifecycle, "finished");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

