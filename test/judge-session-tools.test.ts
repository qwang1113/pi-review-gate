/**
 * Pane-judge tools: the opener operates its own reviews through the channel
 * (a report ends the round, a dead pane ends it as failed, a question or a
 * streamed finding ends the WAIT), a stranger is refused everywhere, and the
 * message-driven wait never hands the same message over twice.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  registerJudgeSessionTools,
  registerJudgeWaitTool,
  probeJudgeRound,
  probeJudgeWait,
  recentStreamFindings,
  type JudgeChildRecord,
  type JudgeSessionToolDeps,
} from "../lib/judge-session-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import { emptyHierarchy, type HierarchyTable } from "../lib/hierarchy.ts";
import {
  appendRecord,
  judgeChannelTarget,
  type ChannelIO,
} from "../lib/orchestrator-channel.ts";

const ROOT = "/repo";
const HOME = "/home/test";
const OPENER = "session-child-1";

interface Fake {
  deps: JudgeSessionToolDeps;
  tools: Map<string, (params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown) => Promise<ToolReply>>;
  schemas: Map<string, Record<string, unknown>>;
  order: string[];
  files: Map<string, string>;
  children: JudgeChildRecord[];
  calls: string[];
  repo: { ok: boolean; error: string };
  table: { current: HierarchyTable };
  caller: string | undefined;
  panes: string[];
  announced: Set<string>;
  recorded: Array<{ text: string; root: string; role: string }>;
}

function child(overrides: Partial<JudgeChildRecord> = {}): JudgeChildRecord {
  return {
    judgeId: "rg-reviewer-abc",
    role: "reviewer",
    repoRoot: ROOT,
    openerId: OPENER,
    paneId: "%7",
    sessionDir: "/sessions/reviewer",
    ...overrides,
  };
}

function fake(register: (host: ToolHost, deps: JudgeSessionToolDeps) => void = registerJudgeSessionTools): Fake {
  const state = {
    deps: undefined as unknown as JudgeSessionToolDeps,
    tools: new Map(),
    schemas: new Map(),
    order: [] as string[],
    files: new Map<string, string>(),
    children: [] as JudgeChildRecord[],
    calls: [] as string[],
    repo: { ok: true, error: "" },
    table: { current: emptyHierarchy() },
    caller: OPENER as string | undefined,
    panes: ["%1", "%7"],
    announced: new Set<string>(),
    recorded: [] as Array<{ text: string; root: string; role: string }>,
  };
  const io: ChannelIO = {
    ensureDir() {},
    appendLine(path, line) { state.files.set(path, (state.files.get(path) ?? "") + line); },
    readText(path) { return state.files.get(path); },
    writeText(path, text) { state.files.set(path, text); },
    now: () => 1_700_000_000_000,
  };
  state.deps = {
    resolveRepo: (requested) => {
      state.calls.push(`resolveRepo(${requested ?? "-"})`);
      return state.repo.ok ? { ok: true, root: ROOT } : { ok: false, error: state.repo.error };
    },
    callerId: () => state.caller,
    hierarchy: () => state.table.current,
    saveHierarchy: (next) => { state.table.current = next; },
    findChild: (root, role, judgeId) => {
      state.calls.push(`findChild(${root},${role ?? "-"},${judgeId ?? "-"})`);
      if (role) return state.children.find((c) => c.role === role);
      return state.children.find((c) => c.judgeId === judgeId);
    },
    channelIO: () => io,
    channelHome: () => HOME,
    tmux: (argv) => {
      if (argv[0] === "list-panes") return { ok: true, stdout: `${state.panes.join("\n")}\n`, stderr: "" };
      if (argv[0] === "kill-pane") {
        const pane = String(argv[argv.length - 1]);
        state.panes = state.panes.filter((p) => p !== pane);
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    ownPane: () => "%1",
    now: () => 1_700_000_000_000,
    readText: (path) => state.files.get(path),
    announcedQuestions: () => state.announced,
    markQuestionsAnnounced: (ids) => {
      state.calls.push(`markQuestionsAnnounced(${ids.join(",")})`);
      for (const id of ids) state.announced.add(id);
    },
    recordVerdict: async (concluded, root, role) => {
      state.calls.push(`recordVerdict(${role})`);
      const text = `recorded ${concluded.verdict} (${concluded.findings.length} findings)`;
      state.recorded.push({ text, root, role });
      return { text, hasVerdict: concluded.verdict !== "" };
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
        (params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown) =>
          definition.execute("id", params, signal, onUpdate, undefined),
      );
    },
  };
  register(host, state.deps);
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

/** Seed the registry the way a spawn would (opener + pane). */
function seed(f: Fake, over: Partial<JudgeChildRecord> = {}): JudgeChildRecord {
  const c = child(over);
  f.children.push(c);
  const now = new Date(1_700_000_000_000).toISOString();
  f.table.current = {
    ...f.table.current,
    [c.judgeId]: {
      judgeId: c.judgeId, openerId: c.openerId, role: c.role, repoRoot: c.repoRoot,
      ...(c.paneId === undefined ? {} : { paneId: c.paneId }),
      ...(c.streamPath === undefined ? {} : { streamPath: c.streamPath }),
      createdAt: now,
    },
  };
  return c;
}

function channelOf(c: JudgeChildRecord) {
  return judgeChannelTarget(c.openerId, c.judgeId, HOME);
}

function channelWriter(f: Fake): ChannelIO {
  return {
    ensureDir() {},
    appendLine: (p, l) => f.files.set(p, (f.files.get(p) ?? "") + l),
    readText: (p) => f.files.get(p),
    writeText: (p, t) => f.files.set(p, t),
    now: () => 1_700_000_000_000,
  };
}

function writeReport(f: Fake, c: JudgeChildRecord, verdict: string, reportId = "rep-1"): void {
  appendRecord(
    channelWriter(f),
    channelOf(c),
    { kind: "report", from: "child", at: new Date(1_700_000_000_000).toISOString(), reportId, verdict, findingsCount: 0, summary: `{"gate":"${verdict}","findings":[]}` },
  );
}

function writeQuestion(f: Fake, c: JudgeChildRecord, requestId: string, title: string, options: string[]): void {
  appendRecord(
    channelWriter(f),
    channelOf(c),
    { kind: "request", from: "child", at: new Date(1_700_000_000_000).toISOString(), requestId, dialogKind: "select", title, options },
  );
}

test("the module registers exactly the two session tools", () => {
  const f = fake();
  assert.deepEqual(f.order, ["judge_close", "judge_wait"]);
});

test("judge_wait is registerable ALONE — that is how the agent surface gets it", () => {
  const f = fake(registerJudgeWaitTool);
  assert.deepEqual(f.order, ["judge_wait"], "the agent host gets the wait and nothing else of the family");
});

test("every tool takes the same role / sessionId / repo parameters", () => {
  const f = fake();
  for (const tool of ["judge_close", "judge_wait"]) {
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
  for (const tool of ["judge_close", "judge_wait"]) {
    const f = fake();
    const reply = await call(f, tool, {});
    assert.equal(reply.isError, true);
    assert.match(textOf(reply), new RegExp(`${tool} needs a role`));
    assert.deepEqual(f.calls, [], "no repo resolution, no registry lookup");
  }
});

test("an ambiguous repo is reported, never guessed", async () => {
  for (const tool of ["judge_close", "judge_wait"]) {
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
  const close = await call(f, "judge_close", { role: "reviewer" });
  assert.deepEqual(close.details, { closed: false, terminated: false, judgeId: undefined });
  const wait = await call(f, "judge_wait", { role: "reviewer" });
  assert.deepEqual(wait.details, { done: false, reason: undefined, role: undefined, hasVerdict: false });
});

test("judge_close: closing nothing is a SUCCESS (idempotent sweep)", async () => {
  const f = fake();
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.notEqual(reply.isError, true);
  assert.match(textOf(reply), /nothing to close/);
  assert.deepEqual(reply.details, { closed: true, terminated: false, judgeId: undefined });
});

test("judge_close: the opener's pane is killed and the registry entry goes", async () => {
  const f = fake();
  seed(f);
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.equal(reply.isError, undefined, textOf(reply));
  assert.deepEqual(f.panes, ["%1"], "the pane is killed");
  assert.deepEqual(f.table.current, {}, "the registry entry goes with it");
  assert.ok(f.calls.includes("cancelWaitTimer"), "the hosted-wait watchdog is cancelled");
  assert.match(textOf(reply), /pane %7 已关/);
  assert.deepEqual(reply.details, { closed: true, terminated: true, judgeId: "rg-reviewer-abc" });
});

test("judge_close: a stranger cannot close another opener's pane", async () => {
  const f = fake();
  seed(f);
  f.caller = "session-intruder";
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /跨级/);
  assert.deepEqual(f.panes, ["%1", "%7"], "the pane survives");
});

test("judge_close: only a goal-auditor takes its pending draft with it", async () => {
  const f = fake();
  seed(f);
  await call(f, "judge_close", { role: "reviewer" });
  assert.ok(!f.calls.some((c) => c.startsWith("dropPendingAudit")), "a reviewer close leaves the draft alone");

  const g = fake();
  seed(g, { role: "goal-auditor", judgeId: "rg-goal-1" });
  await call(g, "judge_close", { role: "goal-auditor" });
  assert.ok(g.calls.includes(`dropPendingAudit(${ROOT})`), "a closed audit's draft is forgotten with it");
});

test("judge_wait: with no child on record it says how to start one", async () => {
  const f = fake();
  const reply = await call(f, "judge_wait", { role: "adviser" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /submit a round first \(judge_submit\)/);
});

test("judge_wait: a new channel report ends the round, records it, and consumes it", async () => {
  const f = fake();
  const c = seed(f);
  writeReport(f, c, "READY");
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  assert.equal(reply.isError, undefined, textOf(reply));
  // The SAME builder the settle path uses — one report format, two wake-ups.
  assert.match(textOf(reply), /\[REVIEW_GATE_REPORT\] reviewer（rg-reviewer-abc）本轮已有 channel report/);
  assert.match(textOf(reply), /结论：READY/);
  assert.match(textOf(reply), /记录：recorded READY/);
  assert.equal(f.recorded.length, 1, "the reported bytes go through the gate's recorder once");
  assert.equal(f.recorded[0]!.role, "reviewer");
  assert.deepEqual(reply.details, { done: true, reason: "report", role: "reviewer", hasVerdict: true });

  const again = await call(f, "judge_wait", { role: "reviewer", timeoutMs: 1 });
  assert.equal((again.details as { done: boolean }).done, false, "the consumed report does not end a second wait");
});

test("judge_wait: a dead pane ends the round as failed, with the next step", async () => {
  const f = fake();
  seed(f);
  f.panes = ["%1"];
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  assert.equal(reply.isError, undefined, textOf(reply));
  assert.match(textOf(reply), /pane 消失且 verdict 未落盘/);
  assert.match(textOf(reply), /judge_recover/);
  assert.equal(f.recorded.length, 0, "nothing is recorded for a round that produced nothing");
});

test("judge_wait: a newly streamed finding ends the wait, WITH the finding itself", async () => {
  const f = fake();
  seed(f, { streamPath: "/logs/stream.jsonl" });
  f.files.set("/logs/stream.jsonl", JSON.stringify({ severity: "P1", file: "lib/a.ts", line: 12, issue: "leaks" }));
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  assert.equal((reply.details as { reason: string }).reason, "finding");
  // The BODY travels: an opener that still has to open the stream file has
  // not been woken, it has been paged.
  assert.match(textOf(reply), /新 findings（1 条）/);
  assert.match(textOf(reply), /\[P1\] lib\/a\.ts:12 — leaks/);
  assert.equal(f.recorded.length, 0, "a finding is not a verdict");

  // The cursor: the same finding must not end the NEXT wait, or the loop
  // never advances.
  const again = await call(f, "judge_wait", { role: "reviewer", timeoutMs: 1 });
  assert.equal((again.details as { done: boolean }).done, false, "a seen finding does not end a second wait");
  assert.equal(f.table.current["rg-reviewer-abc"]!.lastFindingCount, 1, "the cursor is persisted on the entry");

  // A NEW finding does end the next one, and only the new one travels.
  f.files.set(
    "/logs/stream.jsonl",
    f.files.get("/logs/stream.jsonl") + "\n" + JSON.stringify({ severity: "P0", file: "lib/b.ts", issue: "unsafe" }),
  );
  const third = await call(f, "judge_wait", { role: "reviewer" });
  assert.equal((third.details as { reason: string }).reason, "finding");
  assert.match(textOf(third), /新 findings（1 条）/);
  assert.match(textOf(third), /\[P0\] lib\/b\.ts — unsafe/);
  assert.doesNotMatch(textOf(third), /leaks/, "the finding already shown is not repeated");
});

test("judge_wait: a judge's question ends the wait, with its options and how to answer", async () => {
  const f = fake();
  const c = seed(f);
  writeQuestion(f, c, "q1", "选一个", ["甲", "乙"]);
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  assert.equal((reply.details as { reason: string }).reason, "question");
  assert.match(textOf(reply), /待答问题：选一个（选项：甲 \/ 乙）/);
  assert.match(textOf(reply), /judge_answer/);
  assert.ok(f.calls.includes("markQuestionsAnnounced(q1)"), "the question is marked announced for the settle path too");

  const again = await call(f, "judge_wait", { role: "reviewer", timeoutMs: 1 });
  assert.equal((again.details as { done: boolean }).done, false, "an announced question does not end a second wait");
});

test("judge_wait: a finished round outranks a question that landed with it", async () => {
  const f = fake();
  const c = seed(f);
  writeQuestion(f, c, "q9", "还要不要继续", ["要", "不要"]);
  writeReport(f, c, "BLOCKED", "rep-2");
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  assert.equal((reply.details as { reason: string }).reason, "report", "the strongest message wins the round");
  assert.match(textOf(reply), /结论：BLOCKED/);
});

test("judge_wait: a timeout returns the state so far, the discipline, and no verdict", async () => {
  const f = fake();
  seed(f);
  const reply = await call(f, "judge_wait", { role: "reviewer", timeoutMs: 1 });
  assert.notEqual(reply.isError, true, "an unfinished round is a report, not a failure");
  assert.match(textOf(reply), /本轮仍在运行，这段时间没有新消息/);
  assert.match(textOf(reply), /等待纪律/);
  assert.equal((reply.details as { done: boolean }).done, false);
  assert.equal(f.recorded.length, 0, "no verdict is claimed for a round still running");
});

test("judge_wait: a stranger cannot wait on another opener's round", async () => {
  const f = fake();
  seed(f);
  f.caller = "session-intruder";
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /跨级/);
});

test("the round probe: a new report ends it, a dead pane fails it, silence pends it", () => {
  const f = fake();
  const c = seed(f);
  assert.deepEqual(probeJudgeRound(f.deps, c, undefined), {
    done: false, reason: "pending", stateLine: "unknown（自 —）", openQuestions: [],
  });
  writeReport(f, c, "BLOCKED", "rep-9");
  assert.deepEqual(probeJudgeRound(f.deps, c, undefined), {
    done: true, reason: "report", reportId: "rep-9", verdict: "BLOCKED", findingsCount: 0, openQuestions: [],
  });
  assert.deepEqual(probeJudgeRound(f.deps, c, "rep-9").done, false, "a consumed report does not re-end the probe");
  f.panes = ["%1"];
  const dead = { ...c };
  assert.deepEqual(probeJudgeRound(f.deps, dead, "rep-9"), { done: true, reason: "pane-dead", openQuestions: [] });
});

test("the wait probe: the round's criteria first, then question, then finding", () => {
  const f = fake();
  const c = seed(f, { streamPath: "/logs/stream.jsonl" });
  const cursors = { reportId: undefined, findingCount: 0, announcedQuestions: new Set<string>() };
  assert.equal(probeJudgeWait(f.deps, c, cursors).done, false, "silence is not a message");

  f.files.set("/logs/stream.jsonl", JSON.stringify({ severity: "P2", issue: "naming" }));
  const onFinding = probeJudgeWait(f.deps, c, cursors);
  assert.equal(onFinding.reason, "finding");
  assert.deepEqual(onFinding.newFindings, ["[P2] naming"]);
  assert.equal(onFinding.seenFindingCount, 1);
  assert.equal(
    probeJudgeWait(f.deps, c, { ...cursors, findingCount: 1 }).done,
    false,
    "a finding behind the cursor is not a message",
  );

  writeQuestion(f, c, "q2", "问题", []);
  assert.equal(probeJudgeWait(f.deps, c, cursors).reason, "question", "a question outranks a finding");
  assert.equal(
    probeJudgeWait(f.deps, c, { ...cursors, announcedQuestions: new Set(["q2"]) }).reason,
    "finding",
    "an announced question falls through to the finding",
  );

  writeReport(f, c, "READY", "rep-3");
  assert.equal(probeJudgeWait(f.deps, c, cursors).reason, "report", "a finished round outranks both");
});

test("stream findings still arrive newest-last, malformed lines dropped", () => {
  const f = fake();
  assert.deepEqual(recentStreamFindings(f.deps, undefined), []);
  assert.deepEqual(recentStreamFindings(f.deps, "/nope"), []);
  f.files.set("/logs/stream.jsonl", "not json\n" + JSON.stringify({ severity: "P2", issue: "naming" }));
  assert.deepEqual(recentStreamFindings(f.deps, "/logs/stream.jsonl"), ["[P2] naming"]);
});
