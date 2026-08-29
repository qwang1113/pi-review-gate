import test from "node:test";
import assert from "node:assert/strict";

import {
  registerJudgeSessionTools,
  probeJudgeRound,
  readLogTail,
  recentStreamFindings,
  DEFAULT_STDOUT_HISTORY_LINES,
  type JudgeChildRecord,
  type JudgeSessionToolDeps,
} from "../lib/judge-session-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";

/**
 * These three tools used to live inside the 9000-line extension, where the
 * only way to exercise them was to spawn a real judge. They are now a lib/
 * module whose entire outside world arrives as `deps` — so every rule below
 * runs in microseconds against a fake, and a behavior change during the move
 * would have to survive an assertion instead of a reviewer's eyes.
 */

const ROOT = "/repo";

interface Fake {
  deps: JudgeSessionToolDeps;
  tools: Map<string, (params: Record<string, unknown>, signal?: { readonly aborted: boolean }, onUpdate?: unknown) => Promise<ToolReply>>;
  schemas: Map<string, Record<string, unknown>>;
  order: string[];
  files: Map<string, string>;
  children: JudgeChildRecord[];
  calls: string[];
  repo: { ok: boolean; error: string };
}

function child(overrides: Partial<JudgeChildRecord> = {}): JudgeChildRecord {
  return {
    sessionId: "rg-reviewer-abc",
    role: "reviewer",
    title: "reviewer-1200",
    sessionDir: "/sessions/reviewer",
    stdoutPath: "/logs/stdout.log",
    stderrPath: "/logs/stderr.log",
    exitCodePath: "/logs/exit-code",
    pidPath: "/logs/pid",
    ...overrides,
  };
}

/** A live process: `exitCode === null` is what `judgeProcessAlive` reads. */
function alive(kill: (signal?: string) => boolean = () => true) {
  return { exitCode: null as number | null, pid: 4242, kill };
}

function fake(): Fake {
  const state: Fake = {
    deps: undefined as unknown as JudgeSessionToolDeps,
    tools: new Map(),
    schemas: new Map(),
    order: [],
    files: new Map(),
    children: [],
    calls: [],
    repo: { ok: true, error: "" },
  };
  state.deps = {
    resolveRepo: (requested) => {
      state.calls.push(`resolveRepo(${requested ?? "-"})`);
      return state.repo.ok ? { ok: true, root: ROOT } : { ok: false, error: state.repo.error };
    },
    findChild: (root, role, sessionId) => {
      state.calls.push(`findChild(${root},${role ?? "-"},${sessionId ?? "-"})`);
      if (role) return state.children.find((c) => c.role === role);
      return state.children.find((c) => c.sessionId === sessionId);
    },
    sessionState: (c) => {
      state.calls.push(`sessionState(${c.sessionId})`);
      return { lifecycle: "finished", exitCode: 0 };
    },
    conclusion: (c) => {
      state.calls.push(`conclusion(${c.sessionId})`);
      return { text: "verdict text", hasVerdict: true, transcriptPath: "/sessions/reviewer/t.jsonl" };
    },
    stderrTail: (c) => {
      state.calls.push(`stderrTail(${c.sessionId})`);
      return "boom";
    },
    readText: (path) => state.files.get(path),
    fileExists: (path) => state.files.has(path),
    cancelWatch: (sessionId) => { state.calls.push(`cancelWatch(${sessionId})`); },
    dropChild: (sessionId) => {
      state.calls.push(`dropChild(${sessionId})`);
      state.children = state.children.filter((c) => c.sessionId !== sessionId);
    },
    dropPendingAudit: (root) => { state.calls.push(`dropPendingAudit(${root})`); },
    cancelWaitTimer: () => { state.calls.push("cancelWaitTimer"); },
  };
  const host: ToolHost = {
    registerTool: (definition) => {
      state.order.push(definition.name);
      state.schemas.set(definition.name, definition.parameters as unknown as Record<string, unknown>);
      state.tools.set(
        definition.name,
        (params, signal, onUpdate) => definition.execute("id", params, signal, onUpdate, undefined),
      );
    },
  };
  registerJudgeSessionTools(host, state.deps);
  return state;
}

function textOf(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

async function call(f: Fake, tool: string, params: Record<string, unknown>): Promise<ToolReply> {
  const run = f.tools.get(tool);
  assert.ok(run, `${tool} must be registered`);
  return run(params);
}

test("the module registers exactly the three session tools", () => {
  const f = fake();
  assert.deepEqual(f.order, ["judge_read", "judge_close", "judge_wait"]);
});

test("every tool takes the same role / sessionId / repo parameters", () => {
  const f = fake();
  for (const tool of ["judge_read", "judge_close", "judge_wait"]) {
    const schema = f.schemas.get(tool) as { properties?: Record<string, unknown> } | undefined;
    const properties = schema?.properties ?? {};
    assert.deepEqual(
      Object.keys(properties).slice(0, 3),
      ["role", "sessionId", "repo"],
      `${tool} shares the addressing parameters`,
    );
    const role = properties.role as { enum?: unknown[] };
    assert.deepEqual(role.enum, ["reviewer", "adviser", "goal-auditor"], `${tool} accepts the three judge roles`);
  }
});

test("an unaddressed call is refused before the repo is even resolved", async () => {
  for (const tool of ["judge_read", "judge_close", "judge_wait"]) {
    const f = fake();
    const reply = await call(f, tool, {});
    assert.equal(reply.isError, true);
    assert.match(textOf(reply), new RegExp(`${tool} needs a role`));
    assert.deepEqual(f.calls, [], "no repo resolution, no registry lookup");
  }
});

test("an ambiguous repo is reported, never guessed", async () => {
  for (const tool of ["judge_read", "judge_close", "judge_wait"]) {
    const f = fake();
    f.repo = { ok: false, error: "review-gate: this session has edited more than one repository" };
    const reply = await call(f, tool, { role: "reviewer" });
    assert.equal(reply.isError, true);
    assert.match(textOf(reply), /more than one repository/);
    assert.ok(!f.calls.some((c) => c.startsWith("findChild")), `${tool} must not look a child up in a guessed repo`);
  }
});

test("the failure details carry every field the success path reports", async () => {
  const f = fake();
  f.repo = { ok: false, error: "nope" };
  const read = await call(f, "judge_read", { role: "reviewer" });
  assert.deepEqual(Object.keys(read.details ?? {}).sort(), ["alive", "exitCode", "found", "hasVerdict", "lifecycle"]);
  const close = await call(f, "judge_close", { role: "reviewer" });
  assert.deepEqual(close.details, { closed: false, terminated: false, sessionId: undefined });
  const wait = await call(f, "judge_wait", { role: "reviewer" });
  assert.deepEqual(wait.details, { done: false, reason: undefined, role: undefined, hasVerdict: false });
});

test("judge_read: an unknown role is an error, a known one is read by role", async () => {
  const f = fake();
  const missing = await call(f, "judge_read", { role: "adviser" });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /no judge child on record for adviser\./);

  f.children.push(child());
  f.files.set("/logs/stdout.log", "a\nb\nc");
  const reply = await call(f, "judge_read", { role: "reviewer" });
  assert.equal(reply.isError, undefined);
  assert.match(textOf(reply), /judge session reviewer-1200 \(reviewer\) — finished \(exit 0\) \[session rg-reviewer-abc\]/);
  assert.match(textOf(reply), /--- stdout \(tail 200\) ---\na\nb\nc/);
  assert.deepEqual(reply.details, {
    found: true, alive: false, lifecycle: "finished", exitCode: 0, hasVerdict: true,
  });
});

test("judge_read: the stdout tail keeps the LAST `history` lines", async () => {
  const f = fake();
  f.children.push(child());
  f.files.set("/logs/stdout.log", ["1", "2", "3", "4", "5"].join("\n"));
  const reply = await call(f, "judge_read", { role: "reviewer", history: 2 });
  assert.match(textOf(reply), /--- stdout \(tail 2\) ---\n4\n5\n/);
  assert.doesNotMatch(textOf(reply), /\n1\n/, "the older lines are dropped, not the newer ones");
  assert.equal(DEFAULT_STDOUT_HISTORY_LINES, 200, "the documented default is the one the schema advertises");
});

test("judge_read: a RUNNING judge is read from its stdout only", async () => {
  // Its transcript and stderr belong to a round that is not over: reading a
  // conclusion out of them would report a verdict nobody reached.
  const f = fake();
  f.children.push(child({ child: alive() }));
  const reply = await call(f, "judge_read", { role: "reviewer" });
  assert.match(textOf(reply), /— running/);
  assert.match(textOf(reply), /nothing to read yet/);
  assert.equal((reply.details as { alive: boolean }).alive, true);
  assert.ok(!f.calls.includes("conclusion(rg-reviewer-abc)"), "no conclusion is read while the process lives");
  assert.ok(!f.calls.includes("stderrTail(rg-reviewer-abc)"), "no stderr is read while the process lives");
});

test("judge_read: a finished judge hands back its conclusion and stderr", async () => {
  const f = fake();
  f.children.push(child());
  const reply = await call(f, "judge_read", { role: "reviewer" });
  const text = textOf(reply);
  assert.match(text, /--- conclusion \(verdict fence, from \/sessions\/reviewer\/t\.jsonl\) ---\nverdict text/);
  assert.match(text, /--- stderr \(tail\) ---\nboom/);
});

test("judge_close: closing nothing is a SUCCESS (idempotent sweep)", async () => {
  const f = fake();
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.notEqual(reply.isError, true);
  assert.match(textOf(reply), /nothing to close/);
  assert.deepEqual(reply.details, { closed: true, terminated: false, sessionId: undefined });
});

test("judge_close: a live judge is SIGTERMed, unwatched and dropped — in that order", async () => {
  const f = fake();
  const signals: string[] = [];
  f.children.push(child({ child: alive((s) => { signals.push(String(s)); return true; }) }));
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.deepEqual(signals, ["SIGTERM"]);
  // The watcher is cancelled BEFORE the kill: a wake fired by a close we
  // initiated would restart the session for a round nobody is waiting on.
  const watch = f.calls.indexOf("cancelWatch(rg-reviewer-abc)");
  const drop = f.calls.indexOf("dropChild(rg-reviewer-abc)");
  assert.ok(watch >= 0 && drop > watch, "unwatch first, then drop from the registry");
  assert.ok(f.calls.includes("cancelWaitTimer"), "the hosted-wait watchdog is cancelled");
  assert.deepEqual(f.children, [], "the child leaves the registry");
  assert.match(textOf(reply), /reviewer session terminated \(SIGTERM\); transcript and logs stay at \/sessions\/reviewer\./);
  assert.deepEqual(reply.details, { closed: true, terminated: true, sessionId: "rg-reviewer-abc" });
});

test("judge_close: an already-exited judge is closed without a signal", async () => {
  const f = fake();
  const signals: string[] = [];
  f.children.push(child({ child: { exitCode: 0, kill: (s) => { signals.push(String(s)); return true; } } }));
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.deepEqual(signals, [], "a dead process is not signalled");
  assert.match(textOf(reply), /had already exited/);
  assert.equal((reply.details as { terminated: boolean }).terminated, false);
});

test("judge_close: a kill that throws still closes the session", async () => {
  const f = fake();
  f.children.push(child({ child: alive(() => { throw new Error("ESRCH"); }) }));
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.notEqual(reply.isError, true);
  assert.deepEqual(f.children, []);
});

test("judge_close: only a goal-auditor takes its pending draft with it", async () => {
  const f = fake();
  f.children.push(child());
  await call(f, "judge_close", { role: "reviewer" });
  assert.ok(!f.calls.some((c) => c.startsWith("dropPendingAudit")), "a reviewer close leaves the draft alone");

  const g = fake();
  g.children.push(child({ role: "goal-auditor", sessionId: "rg-goal-1" }));
  await call(g, "judge_close", { role: "goal-auditor" });
  assert.ok(g.calls.includes(`dropPendingAudit(${ROOT})`), "a closed audit's draft is forgotten with it");
});

test("judge_wait: with no child on record it says how to start one", async () => {
  const f = fake();
  const reply = await call(f, "judge_wait", { role: "adviser" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /submit a round first \(judge_submit\)/);
});

test("judge_wait: an exit-code file ends the round and returns the conclusion", async () => {
  const f = fake();
  f.children.push(child({ child: alive() }));
  f.files.set("/logs/exit-code", "0");
  f.files.set("/logs/stdout.log", "reviewing…");
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  const text = textOf(reply);
  assert.match(text, /reviewer 本轮已结束（判据：exit-code）/);
  assert.match(text, /verdict text/, "the conclusion travels with the reply");
  assert.match(text, /reviewing…/, "…and so does this round's stdout tail");
  assert.deepEqual(reply.details, { done: true, reason: "exit-code", role: "reviewer", hasVerdict: true });
});

test("judge_wait: a timeout returns the progress so far, not an error", async () => {
  const f = fake();
  f.children.push(child({ child: alive(), streamPath: "/logs/stream.jsonl" }));
  f.files.set("/logs/stdout.log", "still thinking");
  f.files.set("/logs/stream.jsonl", JSON.stringify({ severity: "P1", file: "lib/a.ts", line: 12, issue: "leaks" }));
  // A 1ms budget makes the deadline expire after the first probe — the same
  // path a 5-minute wait takes, without the five minutes.
  const reply = await call(f, "judge_wait", { role: "reviewer", timeoutMs: 1 });
  assert.notEqual(reply.isError, true, "an unfinished round is a report, not a failure");
  const text = textOf(reply);
  assert.match(text, /reviewer 仍在运行/);
  assert.match(text, /still thinking/);
  assert.match(text, /\[P1\] lib\/a\.ts:12 — leaks/, "the newest streamed findings come back too");
  assert.equal((reply.details as { done: boolean }).done, false);
  assert.ok(!f.calls.includes("conclusion(rg-reviewer-abc)"), "no conclusion is claimed for a round still running");
});

test("the round criteria: exit-code, a gone process, or a fence in stdout", () => {
  const f = fake();
  const running = child({ child: alive() });
  assert.deepEqual(probeJudgeRound(f.deps, running), { done: false, reason: "pending" });

  f.files.set("/logs/stdout.log", 'here it is: {"gate": "READY"}');
  assert.deepEqual(probeJudgeRound(f.deps, running), { done: true, reason: "fence" },
    "a printed verdict ends the round even while the process tears down");

  f.files.clear();
  assert.deepEqual(probeJudgeRound(f.deps, child()), { done: true, reason: "process-gone" });

  f.files.set("/logs/exit-code", "");
  assert.deepEqual(probeJudgeRound(f.deps, running), { done: true, reason: "exit-code" },
    "an EMPTY exit-code file still means the session finished");
});

test("an unreadable log reads as empty, and a missing stream as no findings", () => {
  const f = fake();
  assert.equal(readLogTail(f.deps, "/nope"), "");
  assert.deepEqual(recentStreamFindings(f.deps, undefined), []);
  assert.deepEqual(recentStreamFindings(f.deps, "/nope"), []);
  f.files.set("/logs/stream.jsonl", "not json\n" + JSON.stringify({ severity: "P2", issue: "naming" }));
  assert.deepEqual(recentStreamFindings(f.deps, "/logs/stream.jsonl"), ["[P2] naming"],
    "a malformed line is dropped, the good ones still arrive");
});

test("the log tail is bounded by bytes, keeping the END of the file", () => {
  const f = fake();
  f.files.set("/logs/stdout.log", "x".repeat(20) + "TAIL");
  assert.equal(readLogTail(f.deps, "/logs/stdout.log", 4), "TAIL");
});
