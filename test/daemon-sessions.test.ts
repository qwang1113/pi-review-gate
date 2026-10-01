/**
 * Session observation: the transcript reader (lib/daemon/transcript.ts) and the
 * three-source merge (lib/daemon/sessions.ts).
 *
 * The failures pinned here are the ones that would make the panel lie: a
 * truncated line must not invent output, a stale pane must not read as working,
 * an unreadable tmux must not read as "no sessions", and a session's cwd has to
 * come from its transcript (the directory name pi stores it under is lossy).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";

import {
  extractGateState,
  parseOutputLine,
  readFileHead,
  readRecentEntries,
  readRecentEntriesWithOffset,
  TranscriptTailer,
} from "../lib/daemon/transcript.ts";
import { createSessionObserver, SESSION_LIST_LIMIT } from "../lib/daemon/sessions.ts";
import { PANE_STATE_STALE_S } from "../lib/tmux-pane-state.ts";
import {
  assistantRecord,
  brokenRunner,
  gateStateRecord,
  paneLine,
  paneRunner,
  registryEntry,
  scratchHome,
  writeRegistry,
  writeTranscript,
} from "./daemon-helpers.ts";

test("parseOutputLine reads the shapes a transcript really carries", () => {
  const at = "2026-01-01T00:00:00.000Z";
  assert.deepEqual(parseOutputLine(JSON.stringify(assistantRecord("hello", at))), [
    { at, role: "assistant", kind: "text", text: "hello" },
  ]);
  assert.deepEqual(
    parseOutputLine(JSON.stringify({
      type: "message",
      timestamp: at,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "thinking…" },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        ],
      },
    })),
    [
      { at, role: "assistant", kind: "thinking", text: "thinking…" },
      { at, role: "assistant", kind: "tool", text: 'bash({"command":"ls"})' },
    ],
  );
  assert.deepEqual(
    parseOutputLine(JSON.stringify({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text: "hi" }] } })),
    [{ at, role: "user", kind: "text", text: "hi" }],
  );
  assert.deepEqual(
    parseOutputLine(JSON.stringify({ type: "message", timestamp: at, message: { role: "toolResult", content: [{ type: "text", text: "42" }] } })),
    [{ at, role: "tool", kind: "result", text: "42" }],
  );
  // A torn line, a non-message record and an empty payload are all "no output",
  // never a half-invented entry.
  assert.deepEqual(parseOutputLine("{ not json"), []);
  assert.deepEqual(parseOutputLine(JSON.stringify({ type: "session", cwd: "/x" })), []);
  assert.deepEqual(parseOutputLine(JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })), []);
  assert.deepEqual(parseOutputLine(""), []);
});

test("extractGateState keeps the LAST record a session wrote about itself", () => {
  const text = [
    JSON.stringify(gateStateRecord({ review: { verdict: "PENDING" } })),
    "not json at all",
    JSON.stringify(gateStateRecord({ review: { verdict: "READY" }, rounds: [{ verdict: "READY" }] })),
  ].join("\n");
  const state = extractGateState(text);
  assert.equal((state?.review as { verdict: string }).verdict, "READY");
  assert.equal((state?.rounds as unknown[]).length, 1);
  assert.equal(extractGateState("{}"), undefined);
});

test("readFileHead returns the first line only, and readRecentEntries the tail", () => {
  const home = scratchHome();
  const path = writeTranscript(home, {
    sessionId: "s1",
    cwd: "/Users/me/project",
    records: [assistantRecord("one"), assistantRecord("two"), assistantRecord("three")],
  });
  assert.equal(JSON.parse(readFileHead(path, 4_096)!).cwd, "/Users/me/project");
  const entries = readRecentEntries(path, 2);
  assert.deepEqual(entries.map((entry) => entry.text), ["two", "three"]);
  assert.equal(readRecentEntries(`${home}/nope.jsonl`, 5).length, 0);
});

test("the tailer follows the file from its END, and restarts when it shrinks", () => {
  const home = scratchHome();
  const path = writeTranscript(home, { sessionId: "s1", cwd: "/x", records: [assistantRecord("one")] });
  const tailer = new TranscriptTailer();
  // `tail -f` semantics: a watcher that has never seen this file starts at its
  // end. The subscription's initial replay is the SSE endpoint's job, not the
  // tailer's — otherwise every subscribe would dump a whole session.
  assert.deepEqual(tailer.read(path), []);
  assert.deepEqual(tailer.read(path), [], "nothing new is nothing");

  appendFileSync(path, `${JSON.stringify(assistantRecord("two"))}\n`);
  assert.deepEqual(tailer.read(path).map((entry) => entry.text), ["two"]);

  // A rewritten (rotated) file defeats the offset; the new content is read.
  writeFileSync(path, `${JSON.stringify({ type: "session", cwd: "/x" })}\n${JSON.stringify(assistantRecord("fresh"))}\n`);
  assert.deepEqual(tailer.read(path).map((entry) => entry.text), ["fresh"]);
});

test("prime bookmarks a file nobody follows, and never moves a cursor that exists", () => {
  const home = scratchHome();
  const path = writeTranscript(home, { sessionId: "s1", cwd: "/x", records: [assistantRecord("one")] });
  const tailer = new TranscriptTailer();
  tailer.prime(path);
  appendFileSync(path, `${JSON.stringify(assistantRecord("two"))}\n`);
  assert.deepEqual(tailer.read(path).map((entry) => entry.text), ["two"]);

  // A SECOND subscriber primes the same file: the shared cursor must not move,
  // or the first subscriber would lose the bytes in between.
  appendFileSync(path, `${JSON.stringify(assistantRecord("three"))}\n`);
  tailer.prime(path);
  assert.deepEqual(tailer.read(path).map((entry) => entry.text), ["three"]);
});

test("prime with an explicit offset resumes exactly where a replay stopped", () => {
  const home = scratchHome();
  const path = writeTranscript(home, { sessionId: "s1", cwd: "/x", records: [assistantRecord("seen")] });
  const { entries, offset } = readRecentEntriesWithOffset(path, 5);
  assert.deepEqual(entries.map((entry) => entry.text), ["seen"]);
  assert.equal(typeof offset, "number");

  const tailer = new TranscriptTailer();
  tailer.prime(path, offset);
  appendFileSync(path, `${JSON.stringify(assistantRecord("new"))}\n`);
  assert.deepEqual(tailer.read(path).map((entry) => entry.text), ["new"], "the replayed bytes are not sent twice");
});

test("without a gate-state record the reading is marked unknown, not 'nothing pending'", () => {
  const home = scratchHome();
  writeTranscript(home, { sessionId: "nogate", cwd: "/x", records: [assistantRecord("just output")] });
  const observer = createSessionObserver({ home, runTmux: paneRunner([]) });
  const session = observer.collect().sessions.find((candidate) => candidate.sessionId === "nogate");
  assert.ok(session);
  assert.equal(session.gateStateFound, false);
  assert.deepEqual(session.unmet, [], "no state means no findings, and the flag is what says so");
  assert.equal(session.rounds.sent, 0);
});

test("the tailer never bookmarks past an incomplete line, so a torn append is not lost", () => {
  const home = scratchHome();
  const path = writeTranscript(home, { sessionId: "s1", cwd: "/x", records: [assistantRecord("one")] });
  const tailer = new TranscriptTailer();
  tailer.prime(path);

  const full = `${JSON.stringify(assistantRecord("中文消息：多字节内容，用来验证偏移是按字节算的"))}\n`;
  const half = full.slice(0, Math.floor(full.length / 2));
  appendFileSync(path, half);
  assert.deepEqual(tailer.read(path), [], "a half-written line is not output");
  appendFileSync(path, full.slice(half.length));
  assert.deepEqual(
    tailer.read(path).map((entry) => entry.text),
    ["中文消息：多字节内容，用来验证偏移是按字节算的"],
    "the completed line still arrives",
  );
  // …and the bookmark is a BYTE offset that still lines up afterwards.
  appendFileSync(path, `${JSON.stringify(assistantRecord("after"))}\n`);
  assert.deepEqual(tailer.read(path).map((entry) => entry.text), ["after"]);
});

test("sessions merge the pane, the registry and the transcript", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({
    name: "t1-work",
    sessionId: "abc123",
    repo: "/Users/me/project",
    cwd: "/Users/me/project",
    mode: "loop",
    state: "working",
    tmux: { session: "rg-project-abc123", window: "@1", pane: "%7" },
  }));
  writeTranscript(home, {
    sessionId: "abc123",
    cwd: "/Users/me/project",
    records: [
      gateStateRecord({
        hasCodeChange: true,
        hasDocChange: false,
        review: { verdict: "READY", fingerprint: "tree-1" },
        precommit: { verdict: "PASS", fingerprint: "tree-1" },
        rounds: [{ verdict: "READY" }],
        // The field the gate ACTUALLY writes (lib/gate-state.ts `sentReviewRounds`):
        // the rounds sent out — not the same number as the rounds recorded, and a
        // fixture that invents its own name is how the P1 this pins got in.
        sentReviewRounds: 3,
      }),
      assistantRecord("working on it"),
    ],
  });
  const observer = createSessionObserver({
    home,
    runTmux: paneRunner([
      paneLine({
        session: "rg-project-abc123",
        windowId: "@1",
        paneId: "%7",
        sid: "abc123",
        repo: "/Users/me/project",
        kind: "loop",
        state: "working",
        stateAt: String(Math.floor(Date.now() / 1000)),
      }),
    ]),
  });
  const collection = observer.collect();
  assert.equal(collection.tmuxReadable, true);
  const session = collection.sessions.find((candidate) => candidate.sessionId === "abc123");
  assert.ok(session);
  assert.equal(session.name, "t1-work");
  assert.equal(session.kind, "loop");
  assert.equal(session.mode, "loop");
  assert.equal(session.state, "working");
  assert.equal(session.stateSource, "pane");
  assert.equal(session.repo, "/Users/me/project");
  assert.equal(session.tmux?.pane, "%7");
  assert.equal(session.rounds.sent, 3);
  assert.equal(session.rounds.recorded, 1);
  assert.equal(session.rounds.lastVerdict, "READY");
  assert.equal(session.gateStateFound, true, "the fixture's gate state was found in the transcript tail");
  assert.ok(session.transcript?.endsWith(".jsonl"));
  assert.ok(observer.outputFor("abc123", 5).some((entry) => entry.text === "working on it"));
});

test("a pane that stopped reporting is stalled, not working", () => {
  const home = scratchHome();
  const observer = createSessionObserver({
    home,
    runTmux: paneRunner([
      paneLine({
        sid: "stale1",
        repo: "/repo",
        state: "working",
        stateAt: String(Math.floor(Date.now() / 1000) - PANE_STATE_STALE_S - 60),
      }),
    ]),
  });
  const session = observer.collect().sessions.find((candidate) => candidate.sessionId === "stale1");
  assert.equal(session?.state, "stalled");
  assert.equal(session?.alive, true);
});

test("an unreadable tmux is missing information, never 'no sessions'", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "t1", sessionId: "reg1", repo: "/repo", cwd: "/repo" }));
  const observer = createSessionObserver({ home, runTmux: brokenRunner() });
  const collection = observer.collect();
  assert.equal(collection.tmuxReadable, false);
  assert.ok(collection.problems.length > 0);
  assert.ok(collection.sessions.some((session) => session.sessionId === "reg1"), "the registry still answers");
});

test("a recent session with no pane and no name is listed as dead, with its true cwd", () => {
  const home = scratchHome();
  writeTranscript(home, {
    sessionId: "old1",
    cwd: "/Users/me/legacy",
    records: [assistantRecord("done here")],
  });
  const observer = createSessionObserver({ home, runTmux: paneRunner([]) });
  const session = observer.collect().sessions.find((candidate) => candidate.sessionId === "old1");
  assert.ok(session, "a transcript from today is what 'recently ran' means");
  assert.equal(session.state, "dead");
  assert.equal(session.cwd, "/Users/me/legacy", "the cwd comes from the transcript, not the lossy directory name");
  assert.equal(session.alive, false);
});

test("the branch is looked up per cwd and cached; a failure is null, never a guess", () => {
  const home = scratchHome();
  writeRegistry(home, registryEntry({ name: "t1", sessionId: "b1", repo: "/repo", cwd: "/repo" }));
  let calls = 0;
  const observer = createSessionObserver({
    home,
    runTmux: paneRunner([]),
    branchOf: (cwd) => {
      calls += 1;
      if (cwd === "/broken") throw new Error("no git here");
      return cwd === "/repo" ? "feat/x" : null;
    },
  });
  assert.equal(observer.collect().sessions[0]?.branch, "feat/x");
  observer.collect();
  assert.equal(calls, 1, "the branch cache keeps a poll from shelling out to git every second");
});

test("the list is capped and says so instead of silently truncating", () => {
  const home = scratchHome();
  for (let index = 0; index < 5; index += 1) {
    writeRegistry(home, registryEntry({ name: `t${index}`, sessionId: `s${index}`, repo: "/repo", cwd: "/repo" }));
  }
  const observer = createSessionObserver({ home, runTmux: paneRunner([]) });
  const collection = observer.collect({ limit: 2 });
  assert.equal(collection.sessions.length, 2);
  assert.ok(collection.problems.some((problem) => problem.includes("只返回最近 2 条")));
});

test("SESSION_LIST_LIMIT is the documented default", () => {
  assert.equal(SESSION_LIST_LIMIT, 200);
});

test("the transcript index is refreshed, so a brand-new session is found without a restart", () => {
  const home = scratchHome();
  let at = 1_000_000;
  const observer = createSessionObserver({ home, runTmux: paneRunner([]), now: () => at });
  assert.equal(observer.transcriptFor("late1"), undefined);
  writeTranscript(home, { sessionId: "late1", cwd: "/repo", records: [assistantRecord("hi")] });
  at += 10_000;
  assert.ok(observer.transcriptFor("late1")?.endsWith("_late1.jsonl"));
});
