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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readJudgeSessionState,
  newestTranscript,
  readJudgeConclusion,
  readStderrTail,
  terminateJudgeSession,
} from "../lib/judge-session.ts";

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
    writeFileSync(join(dir, "pid"), "4242");
    const seen: Array<{ target: number; signal: string }> = [];
    const res = terminateJudgeSession(paths(dir), (target, signal) => { seen.push({ target, signal }); });
    assert.equal(res.signalled, true);
    assert.deepEqual(seen, [{ target: -4242, signal: "SIGTERM" }], "negative pid = the whole group");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: falls back to the bare pid when the group cannot be signalled", () => {
  const dir = workdir();
  try {
    writeFileSync(join(dir, "pid"), "4242");
    const seen: number[] = [];
    const res = terminateJudgeSession(paths(dir), (target) => {
      seen.push(target);
      if (target < 0) throw new Error("ESRCH: no such process group");
    });
    assert.equal(res.signalled, true);
    assert.deepEqual(seen, [-4242, 4242]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("terminate: an already-finished child is a successful no-op (review_close is idempotent)", () => {
  const dir = workdir();
  try {
    // No pid file at all.
    assert.deepEqual(terminateJudgeSession(paths(dir), () => { throw new Error("must not be called"); }), { signalled: false });
    // A dead pid: both signals fail, and that is still not an error.
    writeFileSync(join(dir, "pid"), "4242");
    const res = terminateJudgeSession(paths(dir), () => { throw new Error("ESRCH"); });
    assert.equal(res.signalled, false);
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
        { signalled: false },
        `pid ${dangerous} must never be signalled`,
      );
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
