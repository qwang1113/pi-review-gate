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
import type { RoundBinding } from "../lib/audit-round.ts";

const ROOT = "/repo";
const HOME = "/home/test";
const OPENER = "session-child-1";
/** A minute before the reports below — the checkpoint THIS round reviews. */
const CHECKPOINT_AT = new Date(1_700_000_000_000 - 60_000).toISOString();

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
  /** The tmux server this fake session talks to — records are minted by it. */
  tmuxServer: string | undefined;
  /** Does an orchestration own this window's label bar? */
  insideOrchestration: boolean;
  panes: string[];
  /** Every tmux argv this fake was asked to run, in order. */
  tmuxCalls: string[][];
  announced: Set<string>;
  recorded: Array<{ text: string; root: string; role: string }>;
  /** The newest report written into the fake channel — what the engine consumes. */
  lastReportId: string | undefined;
  /**
   * THIS round's binding, exactly as the extension derives it for a reviewer:
   * round 1, and a checkpoint stamped a minute BEFORE the reports below.
   *
   * The default is faithful on purpose — a wait that probed with a laxer rule
   * than the recorder is the defect these tests exist for.
   */
  binding: RoundBinding;
  /** What the engine reports about a weaker binding, when there is one. */
  bindingNote: string | undefined;
}

function child(overrides: Partial<JudgeChildRecord> = {}): JudgeChildRecord {
  return {
    judgeId: "rg-reviewer-abc",
    role: "reviewer",
    repoRoot: ROOT,
    openerId: OPENER,
    paneId: "%7",
    // Minted by the same server the fake session runs on, like a real spawn.
    tmuxServer: "sock,1",
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
    tmuxServer: "sock,1" as string | undefined,
    // A plain loop session by default: it owns its window's label bar, so its
    // last judge close takes it down (inside an orchestration the manager does).
    insideOrchestration: false,
    panes: ["%1", "%7"],
    tmuxCalls: [] as string[][],
    announced: new Set<string>(),
    recorded: [] as Array<{ text: string; root: string; role: string }>,
    lastReportId: undefined as string | undefined,
    binding: {
      binding: "round-and-content",
      expectedRound: 1,
      contentAt: CHECKPOINT_AT,
    } as RoundBinding,
    bindingNote: undefined as string | undefined,
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
      state.tmuxCalls.push([...argv]);
      if (argv[0] === "list-panes") return { ok: true, stdout: `${state.panes.join("\n")}\n`, stderr: "" };
      if (argv[0] === "kill-pane") {
        const pane = String(argv[argv.length - 1]);
        state.panes = state.panes.filter((p) => p !== pane);
        return { ok: true, stdout: "", stderr: "" };
      }
      return { ok: true, stdout: "", stderr: "" };
    },
    ownPane: () => "%1",
    // Faithful to the real wiring: the seeded records below are minted by this
    // same server, so the ordinary paths behave exactly as they did.
    tmuxServer: () => state.tmuxServer,
    insideOrchestration: () => state.insideOrchestration,
    now: () => 1_700_000_000_000,
    readText: (path) => state.files.get(path),
    announcedQuestions: () => state.announced,
    roundBinding: () => state.binding,
    markQuestionsAnnounced: (ids) => {
      state.calls.push(`markQuestionsAnnounced(${ids.join(",")})`);
      for (const id of ids) state.announced.add(id);
    },
    // The wait no longer picks the report or moves the cursor: it hands the
    // round to the engine (lib/audit-round.ts) and reports what came back.
    settleRound: async (judgeId, root) => {
      state.calls.push(`settleRound(${judgeId})`);
      const text = `recorded round of ${judgeId}`;
      state.recorded.push({ text, root, role: judgeId });
      // The real engine CONSUMES the report it just recorded — one cursor
      // write, in one place. The fake does the same, so "a consumed report
      // does not end a second wait" stays observable from this side.
      const entry = state.table.current[judgeId];
      if (entry && state.lastReportId) {
        state.table.current = {
          ...state.table.current,
          [judgeId]: { ...entry, lastReportId: state.lastReportId },
        };
      }
      return {
        text,
        verdict: "READY",
        hasVerdict: true,
        ...(state.bindingNote === undefined ? {} : { bindingNote: state.bindingNote }),
      };
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
      title: c.role, sessionDir: c.sessionDir,
      ...(c.paneId === undefined ? {} : { paneId: c.paneId }),
      ...(c.streamPath === undefined ? {} : { streamPath: c.streamPath }),
      // A real spawn records the server that minted the pane id ALONGSIDE it
      // (`registerJudge`), and every judgement about that pane — kill it,
      // repaint it, count it as a sibling — refuses an id it cannot attribute.
      // A fixture that omitted it made all three look like "no pane at all".
      ...(c.tmuxServer === undefined ? {} : { tmuxServer: c.tmuxServer }),
      spawnedAt: now,
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

function writeReport(
  f: Fake,
  c: JudgeChildRecord,
  verdict: string,
  reportId = "rep-1",
  over: { round?: number; at?: string } = {},
): void {
  appendRecord(
    channelWriter(f),
    channelOf(c),
    {
      kind: "report",
      from: "child",
      at: over.at ?? new Date(1_700_000_000_000).toISOString(),
      reportId,
      // A real judge stamps the round it read from the registry at conclude
      // time; the default here is THIS round, so the healthy path stays the
      // default and a stale one has to be asked for explicitly.
      round: over.round ?? 1,
      verdict,
      findingsCount: 0,
      summary: `{"gate":"${verdict}","findings":[]}`,
    },
  );
  f.lastReportId = reportId;
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

test("judge_close: the LAST judge takes the window's label bar down with it", async () => {
  // Judge panes turn the window-level border line ON (that is the C1 fix), so
  // something has to turn it back off — otherwise the gate leaves a permanent
  // mark on a window it was only visiting.
  const f = fake();
  seed(f);
  await call(f, "judge_close", { role: "reviewer" });
  const flat = f.tmuxCalls.map((a) => a.join(" "));
  const unset = flat.filter((s) => s.startsWith("setw") && s.includes("-u"));
  assert.equal(unset.length, 2, "both window options are restored to the user's own config");
  assert.ok(
    flat.indexOf(unset[0]!) < flat.findIndex((s) => s.startsWith("kill-pane")),
    "…and BEFORE the pane dies: after kill-pane that id is no longer a setw target",
  );
});

test("judge_close: inside an orchestration the label bar is left alone", async () => {
  // There the PROJECT MANAGER owns that bar and its other children still need
  // it; a child session releasing it would blank its siblings' borders.
  const f = fake();
  f.insideOrchestration = true;
  seed(f);
  await call(f, "judge_close", { role: "reviewer" });
  const flat = f.tmuxCalls.map((a) => a.join(" "));
  assert.equal(flat.filter((s) => s.startsWith("setw")).length, 0, "no window option is touched");
  assert.ok(flat.some((s) => s.startsWith("kill-pane")), "the pane itself is still closed");
});

test("judge_close: a sibling judge still open keeps the label bar up", async () => {
  const f = fake();
  seed(f);
  // A second judge of the same opener, with its own pane — and that pane is ON
  // SCREEN, which is what makes it a sibling worth keeping the bar for.
  f.panes = ["%1", "%7", "%9"];
  f.table.current = {
    ...f.table.current,
    "rg-adviser-xyz": {
      ...f.table.current["rg-reviewer-abc"]!,
      judgeId: "rg-adviser-xyz",
      role: "adviser",
      paneId: "%9",
    },
  };
  await call(f, "judge_close", { role: "reviewer" });
  const flat = f.tmuxCalls.map((a) => a.join(" "));
  assert.equal(flat.filter((s) => s.startsWith("setw")).length, 0,
    "the bar stays up while a decorated sibling is still on screen");
});

test("judge_close: a sibling that is only a REGISTRY ROW does not keep the bar up", async () => {
  // The registry outlives panes: one closed by hand, or one minted by a tmux
  // server that has since restarted, is a row and nothing else. Counting rows
  // would leave the border line switched on in the user's window forever —
  // which is the exact litter this release exists to prevent.
  const f = fake();
  seed(f);
  f.table.current = {
    ...f.table.current,
    "rg-adviser-gone": {
      ...f.table.current["rg-reviewer-abc"]!,
      judgeId: "rg-adviser-gone",
      role: "adviser",
      paneId: "%9", // never in f.panes: the pane is gone
    },
    "rg-adviser-stranger": {
      ...f.table.current["rg-reviewer-abc"]!,
      judgeId: "rg-adviser-stranger",
      role: "adviser",
      paneId: "%1",
      tmuxServer: "other-server,9", // an id this server did not mint
    },
  };
  await call(f, "judge_close", { role: "reviewer" });
  const flat = f.tmuxCalls.map((a) => a.join(" "));
  assert.equal(flat.filter((s) => s.startsWith("setw") && s.includes("-u")).length, 2,
    "neither row is a pane on screen, so this close is the last one");
});


test("judge_close: a pane id from ANOTHER tmux server is never killed", async () => {
  // The registry is persisted now, so a record can outlive the tmux server
  // that minted its pane id — and tmux hands ids out from %0 again after a
  // restart. Reachable from a plain judge_close({role}) in a resumed session,
  // which would then kill whatever now holds %7 (reviewer P1, 2026-09-05).
  const f = fake();
  seed(f, { tmuxServer: "sock,OLD-SERVER" });
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.equal(reply.isError, undefined, textOf(reply));
  assert.deepEqual(f.panes, ["%1", "%7"], "the stranger's pane is left alone");
  assert.equal((reply.details as { terminated: boolean }).terminated, false);
  assert.match(textOf(reply), /另一个 tmux server/, "…and the reply says why it did not");
  // The registry still has to be cleaned up: the entry is the thing this
  // session owns, and leaving it would strand the round forever.
  assert.deepEqual(f.table.current, {}, "the entry goes either way");
});

test("judge_close: an entry with no recorded server is not killed by its id either", async () => {
  const f = fake();
  seed(f, { tmuxServer: undefined });
  const reply = await call(f, "judge_close", { role: "reviewer" });
  assert.equal(reply.isError, undefined, textOf(reply));
  assert.deepEqual(f.panes, ["%1", "%7"], "unverifiable ⇒ do not act");
  assert.deepEqual(f.table.current, {});
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
  assert.match(textOf(reply), /记录：recorded round of/);
  assert.equal(f.recorded.length, 1, "the reported bytes go through the gate's recorder once");
  // The wait addresses the round by JUDGE ID now — the engine resolves the
  // role (and therefore the kind) from the registry itself.
  assert.equal(f.recorded[0]!.role, "rg-reviewer-abc");
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

// A WEAKER BINDING IS ANNOUNCED IN THE WAKE-UP ITSELF (project manager,
// 2026-09-05). The engine hands it over as its own field precisely because the
// recorded note is printed first-line-only — appending the sentence to that
// note would record it and never show it.
test("judge_wait: a round bound without a content stamp says so in the reply", async () => {
  const f = fake();
  const c = seed(f);
  writeReport(f, c, "READY", "rep-2");
  f.bindingNote = "本轮绑定说明：本仓库还没有任何 checkpoint，这是 exit-goal 空范围轮 —— 内容时间判据**不适用**。";
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  const text = textOf(reply);
  assert.match(text, /绑定说明：/, "the weaker binding is its own line in the wake-up");
  assert.match(text, /exit-goal/, "…and it names the round it applied to");
});

test("judge_wait: an ordinary round carries no binding note", async () => {
  const f = fake();
  const c = seed(f);
  writeReport(f, c, "READY", "rep-2");
  const reply = await call(f, "judge_wait", { role: "reviewer" });
  assert.doesNotMatch(textOf(reply), /绑定说明：/, "a line shown every round would say nothing");
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
  assert.deepEqual(probeJudgeRound(f.deps, c, undefined, f.binding), {
    done: false, reason: "pending", stateLine: "unknown（自 —）", openQuestions: [],
  });
  writeReport(f, c, "BLOCKED", "rep-9");
  assert.deepEqual(probeJudgeRound(f.deps, c, undefined, f.binding), {
    done: true, reason: "report", reportId: "rep-9", verdict: "BLOCKED", findingsCount: 0, openQuestions: [],
  });
  assert.deepEqual(probeJudgeRound(f.deps, c, "rep-9", f.binding).done, false, "a consumed report does not re-end the probe");
  f.panes = ["%1"];
  const dead = { ...c };
  assert.deepEqual(probeJudgeRound(f.deps, dead, "rep-9", f.binding), { done: true, reason: "pane-dead", openQuestions: [] });
});

test("the round probe repaints the border — but never through a stranger's pane id", () => {
  // C2: pi overwrites the pane title after boot, so the border is repainted
  // from every reading of the judge's state. The id it writes through is only
  // usable while it was minted by the tmux server this process talks to: the
  // registry is persisted, and after a server restart %7 belongs to somebody
  // else's pane (the same rule the kill path obeys).
  const f = fake();
  // A pane id of its own: the repaint remembers what it last wrote per pane
  // (that is the throttle), so two tests sharing `%7` would see each other's
  // paint suppressed and prove nothing.
  f.panes = ["%1", "%71"];
  const c = seed(f, { paneId: "%71" });
  // A state on the channel is what there is to paint: before the judge has said
  // anything the border keeps whatever it had (nothing to report is not "idle").
  appendRecord(channelWriter(f), channelOf(c), {
    kind: "state",
    from: "child",
    at: new Date(1_700_000_000_000).toISOString(),
    state: "working",
  });
  probeJudgeRound(f.deps, c, undefined, f.binding);
  const painted = f.tmuxCalls.filter((a) => a[0] === "select-pane" && a.includes("-T"));
  assert.equal(painted.length, 1, "one repaint per reading");
  assert.match(painted[0]!.join(" "), /@review-reviewer/, "…labelled by the judge's role");

  const g = fake();
  g.panes = ["%1", "%72"];
  const stranger = seed(g, { paneId: "%72", tmuxServer: "other-server,9" });
  appendRecord(channelWriter(g), channelOf(stranger), {
    kind: "state",
    from: "child",
    at: new Date(1_700_000_000_000).toISOString(),
    state: "working",
  });
  probeJudgeRound(g.deps, stranger, undefined, g.binding);
  assert.equal(
    g.tmuxCalls.filter((a) => a[0] === "select-pane").length,
    0,
    "an id from another tmux server is never written through",
  );
});


// THE PROBE AND THE RECORDER ANSWER THE SAME QUESTION (2026-09-05). While they
// did not, a leftover reviewer report ended the round HERE — the wait printed
// "本轮已有 channel report：结论 READY" — and the recorder then bound that
// verdict to a commit the reviewer never saw.
test("the round probe: a report older than this round's checkpoint does NOT end it", () => {
  const f = fake();
  const c = seed(f);
  writeReport(f, c, "READY", "rep-stale", { at: new Date(1_700_000_000_000 - 120_000).toISOString() });
  const obs = probeJudgeRound(f.deps, c, undefined, f.binding);
  assert.equal(obs.done, false, "the round is still open — the recorder would refuse this report");
  assert.equal(obs.notThisRound?.reportId, "rep-stale");
  assert.match(obs.notThisRound?.detail ?? "", /早|不晚于/, "and the reason travels with it");
});

test("the round probe: a report from an earlier round does NOT end it either", () => {
  const f = fake();
  const c = seed(f);
  writeReport(f, c, "READY", "rep-prev", { round: 0 });
  const obs = probeJudgeRound(f.deps, c, undefined, f.binding);
  assert.equal(obs.done, false);
  assert.equal(obs.notThisRound?.reportId, "rep-prev");
  assert.match(obs.notThisRound?.detail ?? "", /不是本轮/);
});

// …BUT THE ALREADY-RECORDED ONE IS NOT "SET ASIDE" (reviewer P2, 2026-09-05).
// The selector checks the round before the cursor, so from round 2 on the
// previous round's report — recorded, cursor advanced — comes back as
// `round-mismatch`. Reporting it would tell the opener that a verdict which WAS
// adopted had been discarded, on every single wait.
test("the round probe: the previous round's RECORDED report is not announced as set aside", () => {
  const f = fake();
  const c = seed(f);
  writeReport(f, c, "READY", "rep-done", { round: 1 });
  f.binding = { binding: "round-and-content", expectedRound: 2, contentAt: CHECKPOINT_AT };
  const obs = probeJudgeRound(f.deps, c, "rep-done", f.binding);
  assert.equal(obs.done, false, "it is not this round's report");
  assert.equal(obs.notThisRound, undefined, "…and it is not news either — it was recorded");
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

// ITEM 2 OF THE ROUND-4 TASK, pinned as its own case. The ordering inside
// `probeJudgeWait` already put a finished round ahead of a finding — this test
// exists so a refactor cannot quietly invert it: an opener told "2 new
// findings" while its verdict is already on disk goes back to fixing code and
// walks straight into the next submission.
test("the wait probe: this round's conclusion outranks findings that arrived with it", () => {
  const f = fake();
  const c = seed(f, { streamPath: "/logs/stream.jsonl" });
  const cursors = { reportId: undefined, findingCount: 0, announcedQuestions: new Set<string>() };
  f.files.set(
    "/logs/stream.jsonl",
    JSON.stringify({ severity: "P2", issue: "naming" }) + "\n" + JSON.stringify({ severity: "P2", issue: "wording" }),
  );
  writeReport(f, c, "READY", "rep-7");
  const obs = probeJudgeWait(f.deps, c, cursors);
  assert.equal(obs.reason, "report", "a finished round is the strongest message in one probe");
  assert.equal(obs.verdict, "READY");
  assert.equal(obs.seenFindingCount, 2, "the findings are still counted — the cursor must advance past them");
});

test("judge_wait: a leftover report keeps the round open and is named in the reply", async () => {
  const f = fake();
  const c = seed(f);
  writeReport(f, c, "READY", "rep-stale", { at: new Date(1_700_000_000_000 - 120_000).toISOString() });
  const reply = await call(f, "judge_wait", { role: "reviewer", timeoutMs: 1 });
  const text = textOf(reply);
  assert.match(text, /未采纳的 report：rep-stale/, "the wake-up names what it set aside");
  assert.match(text, /仍在等/, "…and says the round is still open");
  assert.doesNotMatch(text, /结论：READY/, "a verdict nobody recorded is never displayed as this round's");
  assert.equal(f.calls.some((c2) => c2.startsWith("settleRound")), false, "and nothing is recorded");
  assert.deepEqual(reply.details, { done: false, reason: "pending", role: "reviewer", hasVerdict: false });
});


test("stream findings still arrive newest-last, malformed lines dropped", () => {
  const f = fake();
  assert.deepEqual(recentStreamFindings(f.deps, undefined), []);
  assert.deepEqual(recentStreamFindings(f.deps, "/nope"), []);
  f.files.set("/logs/stream.jsonl", "not json\n" + JSON.stringify({ severity: "P2", issue: "naming" }));
  assert.deepEqual(recentStreamFindings(f.deps, "/logs/stream.jsonl"), ["[P2] naming"]);
});
