/**
 * The three tools that open, answer and recover a pane judge —
 * `judge_spawn`, `judge_answer` and `judge_recover`.
 *
 * They live here rather than in `extensions/review-gate.ts` for the same
 * reason every other tool family moved out: the extension is the wiring,
 * and every rule below is unit-testable against a fake. Shape:
 * `registerJudgeSpawnTools(host, deps)`, effects through `deps` only.
 *
 * THE BOUNDARY. These three tools manage the pane LIFECYCLE. Dispatching a
 * checkpoint round (`judge_submit` and its precommit → checkpoint → prepare
 * chain) is a different job and stays where it is; it reaches these same
 * primitives through the gate-internal dispatch, never through these tools.
 * Agents express INTENT here (`goal` or `plan`), and the gate builds the
 * audit task — an agent-assembled review task would be the multi-step dance
 * philosophy one exists to remove.
 *
 * EVERY tool below passes `checkCaller` before doing anything else: a judge
 * belongs to its opener, and any other session's wait/answer/close/recover
 * on it is a cross-level call refused fail-closed, with no dialog.
 */
import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import {
  checkCaller,
  registerJudge,
  removeJudge,
  type HierarchyTable,
} from "./hierarchy.ts";
import {
  appendRecord,
  channelPathFor,
  judgeChannelTarget,
  projectChannel,
  readChannel,
  requestPayload,
  type ChannelIO,
  type ChannelRecord,
} from "./orchestrator-channel.ts";
import { resolveAnswer } from "./orchestrator-answer-tools.ts";
import {
  buildJudgePaneCommand,
  buildJudgeRecoverCommand,
  closeSessionPane,
  judgePaneDecor,
  openSessionPane,
  paneRecoverability,
} from "./session-factory.ts";
import {
  judgePaneAlive,
  type JudgePaneRunResult,
} from "./judge-pane.ts";
import { verifyJudgeBoot, channelRecordCount } from "./orchestrator-tool-kit.ts";
import { judgeSessionIdFor, shortRepoHash } from "./judge-process.ts";

import { nextRoundSeq } from "./judge-conclude.ts";
/** Goal and plan reviews are the only kinds an agent may open directly. */
const SPAWN_KIND_PARAM = Type.Enum({ goal: "goal", plan: "plan" });
const ROLE_PARAM = Type.Optional(Type.Enum({ reviewer: "reviewer", adviser: "adviser", "goal-auditor": "goal-auditor" }));
const JUDGE_ID_PARAM = Type.Optional(Type.String({ description: "Judge id returned by judge_spawn; prefer role" }));
const REPO_PARAM = Type.Optional(Type.String({
  description: "Absolute repo path (required once the session edited several repos)",
}));

/** Everything these tools need from the outside world. */
export interface JudgeSpawnToolDeps {
  /** Who is calling — the opener check runs on this, never on a parameter. */
  callerId(): string | undefined;
  /** Opener registry (extension-owned) and its persistence. */
  hierarchy(): HierarchyTable;
  saveHierarchy(next: HierarchyTable): void;
  /** Channel filesystem seam and its home override (tests point elsewhere). */
  channelIO(): ChannelIO;
  channelHome(): string | undefined;
  /** One tmux invocation (argv, never a shell string). */
  tmux(argv: readonly string[]): JudgePaneRunResult;
  /** This session's own pane — the new pane splits off it. */
  ownPane(): string | undefined;
  /**
   * The tmux server this process talks to (lib/hierarchy.ts `tmuxServerFrom`).
   *
   * Recorded WITH the pane id: an entry that has one without the other can
   * never be closed by it again (`paneClosable` refuses), which would strand
   * the pane instead of protecting it.
   */
  tmuxServer(): string | undefined;
  /** Injectable clock. */
  now(): number;
  /** Injectable sleep, so the spawn's delivery check is testable without waiting. */
  sleep(ms: number): Promise<void>;
  /** Which repo does this call target? Never guessed. */
  resolveRepo(requested: string | undefined): { ok: true; root: string } | { ok: false; error: string };
  /** Model + system prompt + transcript dir for one role in one repo. */
  launchConfig(root: string, role: string, opener: string):
    | { ok: true; model: string; sysPromptPath: string; sessionDir: string }
    | { ok: false; error: string };
  /** Gate-internal audit tasks — the agent names the KIND, never assembles. ctx threads through from execute. */
  buildGoalAuditTask(draft: string, root: string, ctx: unknown):
    Promise<{ ok: true; task: string; streamPath?: string } | { ok: false; error: string }>;
  buildPlanAuditTask(root: string, ctx: unknown):
    Promise<{ ok: true; task: string; streamPath?: string } | { ok: false; error: string }>;
  /** Persist the round task next to the transcript dir; returns its path. */
  writeJudgeTaskFile(root: string, role: string, opener: string, task: string):
    { ok: true; path: string } | { ok: false; error: string };
  /** Which audit kind is pending for one repo (a goal draft, a plan hash, or none). */
  pendingAuditKind(root: string): "goal" | "plan" | undefined;
  /** Remember what this spawn dispatched, so its report is recordable. */
  rememberGoalAudit(root: string, draft: string): void;
  rememberPlanAudit(root: string): { ok: true } | { ok: false; error: string };
  /** Forget both pendings (rollback, close, fresh-kill). */
  forgetAudit(root: string): void;
}

function reply(text: string): ToolReply {
  return { content: [{ type: "text", text }], details: undefined };
}

function fail(text: string): ToolReply {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

/** Resolve a judge by explicit id, or deterministically by role+repo+opener. */
function resolveJudgeId(
  deps: JudgeSpawnToolDeps,
  params: Record<string, unknown>,
): { ok: true; judgeId: string; root?: string } | { ok: false; text: string } {
  const direct = typeof params.judgeId === "string" ? params.judgeId.trim() : "";
  if (direct) return { ok: true, judgeId: direct };
  const role = typeof params.role === "string" ? params.role : undefined;
  if (!role) {
    return { ok: false, text: "review-gate: judge_spawn/judge_answer/judge_recover 需要 judgeId 或 role 之一来定位 review。" };
  }
  const repo = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!repo.ok) return { ok: false, text: `review-gate: 仓库解析失败 —— ${repo.error}` };
  const opener = deps.callerId();
  if (!opener) {
    return { ok: false, text: "review-gate: 无法确认调用者身份——身份不明时不能定位 review。" };
  }
  return { ok: true, judgeId: judgeSessionIdFor(role, shortRepoHash(repo.root), opener), root: repo.root };
}

/** First round number for a spawned review — above entry and channel history (see birthSeq). */
function nextSpawnRoundSeq(deps: JudgeSpawnToolDeps, opener: string, judgeId: string): number {
  let records: ChannelRecord[] = [];
  try {
    const io = deps.channelIO();
    const target = judgeChannelTarget(opener, judgeId, deps.channelHome());
    records = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records;
  } catch { /* the entry alone still numbers above */ }
  return nextRoundSeq(deps.hierarchy()[judgeId]?.roundSeq, records);
}

async function doSpawn(
  deps: JudgeSpawnToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const caller = deps.callerId();
  if (!caller) {
    return fail("review-gate: 无法确认调用者身份——身份不明时不能开 review。");
  }
  const kind = params.kind === "plan" ? "plan" : "goal";
  const repo = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!repo.ok) return fail(`review-gate: 仓库解析失败 —— ${repo.error}`);
  const root = repo.root;
  // Goal and plan audits both run under the goal-auditor role (they judge a
  // contract before acting, and that is one role, not two) — so they share
  // one judge id per repo per opener, and the gate keeps them apart by pending KIND:
  // a report is only ever recorded against the kind that is pending.
  const pending = deps.pendingAuditKind(root);
  if (pending !== undefined && pending !== kind) {
    return fail(`review-gate: 已有 ${pending === "goal" ? "目标" : "计划"}审计挂着——等它的标准报告送达后再开${kind === "goal" ? "目标" : "计划"}审计。两种审计共用一个 judge，串行才不会错绑结论。`);
  }
  const role = "goal-auditor";
  const earlyJudgeId = judgeSessionIdFor(role, shortRepoHash(root), caller);
  // Spawn is birth: one pane per review object. A living pane takes its
  // rounds through judge_submit, a dead one goes through judge_recover —
  // spawning over either would strand a review or fork a transcript.
  const incumbent = deps.hierarchy()[earlyJudgeId];
  if (incumbent?.paneId) {
    const ownPane = deps.ownPane();
    const alive = ownPane ? judgePaneAlive(deps.tmux, ownPane, incumbent.paneId) : undefined;
    if (alive === true) {
      return fail(`review-gate: review ${earlyJudgeId} 的 pane（${incumbent.paneId}）还开着——新一轮走 judge_submit（pane 复用），不要重开。`);
    }
    if (alive === false) {
      return fail(`review-gate: review ${earlyJudgeId} 的 pane 已消失——用 judge_recover 同 id 重开续 transcript，不要重开。`);
    }
    return fail("review-gate: tmux 读不出来，无法确认旧 pane 生死——信息缺失时不开新 pane。");
  }
  let task: string;
  let streamPath: string | undefined;
  let draft = "";
  if (kind === "goal") {
    draft = typeof params.draft === "string" ? params.draft.trim() : "";
    if (!draft) return fail("review-gate: kind=goal 需要 draft（待审的目标全文）——门禁组装审计任务，但草稿本身得由你给。");
    const built = await deps.buildGoalAuditTask(draft, root, ctx);
    if (!built.ok) return fail(`review-gate: 审计任务组装失败 —— ${built.error}`);
    task = built.task;
    streamPath = built.streamPath;
  } else {
    const built = await deps.buildPlanAuditTask(root, ctx);
    if (!built.ok) return fail(`review-gate: 审计任务组装失败 —— ${built.error}`);
    task = built.task;
    streamPath = built.streamPath;
  }
  const judgeId = earlyJudgeId;
  // Number this review's first round above every report already in the channel:
  // a close→spawn keeps the old reports, and restarting at 1 would collide with them
  // (the judge refuses a round its channel already closed).
  const birthSeq = nextSpawnRoundSeq(deps, caller, earlyJudgeId);
  // The two checks that can refuse outright — no tmux, no resolvable model
  // chain — run BEFORE the id is claimed. They used to sit after it and undo
  // it, and the claim in between was the only reason `rollback` had to exist
  // for them at all.
  const ownPane = deps.ownPane();
  if (!ownPane) {
    return fail("review-gate: 当前会话不在 tmux 里，开不出 review pane——在 tmux 中重开本会话后重试；门禁不会退回旧的进程壳子。");
  }
  const launch = deps.launchConfig(root, role, caller);
  if (!launch.ok) {
    return fail(`review-gate: ${launch.error}`);
  }
  // A COMPLETE entry from the first write: this registration used to omit
  // `sessionDir`, and the extension's own dispatch kept that fact in its
  // separate Map instead — which is precisely why `judge_wait` could not find
  // a judge `judge_spawn` had just opened. One table, every field.
  const registered = registerJudge(deps.hierarchy(), {
    judgeId,
    openerId: caller,
    role,
    repoRoot: root, roundSeq: birthSeq,
    title: role,
    sessionDir: launch.sessionDir,
    ...(streamPath === undefined ? {} : { streamPath }),
    spawnedAt: new Date(deps.now()).toISOString(),
  });

  if (!registered.ok) return fail(`review-gate: ${registered.reason}`);
  deps.saveHierarchy(registered.table);
  const rollback = () => {
    deps.saveHierarchy(removeJudge(deps.hierarchy(), judgeId));
    deps.forgetAudit(root);
  };

  const taskFile = deps.writeJudgeTaskFile(root, role, caller, task);
  if (!taskFile.ok) {
    rollback();
    return fail(`review-gate: 任务文件落盘失败 —— ${taskFile.error}`);
  }
  // (`ownPane` and `launch` were resolved above, before the claim.)
  const target = judgeChannelTarget(caller, judgeId, deps.channelHome());
  const judgeChannelPath = channelPathFor(target.orchestrationId, target.childId, target.home);
  // A judge's channel OUTLIVES its panes — one file per role+repo, rounds
  // appended — so "there is a record" proves nothing about the pane opened
  // below. Only a record ABOVE this watermark does.
  const baseline = channelRecordCount(deps.channelIO(), judgeChannelPath);
  const opened = await openSessionPane(deps.tmux, {
    ownPane,
    cwd: root,
    layout: "child-column",
    role: {
      kind: "judge",
      openerId: caller,
      judgeId,
      role,
      taskPath: taskFile.path,
      ...(streamPath === undefined ? {} : { streamPath }),
    },
    command: buildJudgePaneCommand({
      sessionId: judgeId,
      taskPath: taskFile.path,
      sessionDir: launch.sessionDir,
      sysPromptPath: launch.sysPromptPath,
      model: launch.model,
    }),
    decor: judgePaneDecor(judgeId, role),
    // A COMPLETE entry from the first write, and it happens INSIDE the open:
    // this registration used to omit `sessionDir`, which is precisely why
    // `judge_wait` could not find a judge `judge_spawn` had just opened.
    register: (paneId) => {
      const withPane = registerJudge(deps.hierarchy(), {
        judgeId,
        openerId: caller,
        role,
        repoRoot: root, roundSeq: birthSeq,
        title: role,
        sessionDir: launch.sessionDir,
        paneId,
        ...(deps.tmuxServer() === undefined ? {} : { tmuxServer: deps.tmuxServer()! }),
        ...(streamPath === undefined ? {} : { streamPath }),
        spawnedAt: new Date(deps.now()).toISOString(),
      });
      if (withPane.ok) deps.saveHierarchy(withPane.table);
    },
    // EARN the receipt for a judge too (it used to be an orchestration-only
    // courtesy): a judge that never boots leaves its opener waiting forever,
    // which is the one silence nobody else can break.
    verify: () => verifyJudgeBoot(deps, {
      channelPath: judgeChannelPath,
      baselineRecordCount: baseline,
    }),
  });
  if (!opened.ok && !opened.deliveryFailed) {
    rollback();
    return fail(`review-gate: ${opened.error}`);
  }
  const paneId = opened.paneId;
  if (paneId === undefined) {
    rollback();
    return fail("review-gate: 开出的 review pane 没有回报 pane id —— 已回滚。");
  }
  // Register what was dispatched, or the report can never be recorded:
  // a goal verdict binds to its draft, a plan verdict to its hash. This runs
  // even when the boot check failed, because the pane is KEPT: a slow judge
  // that reports late must still be recordable.
  if (kind === "goal") {
    deps.rememberGoalAudit(root, draft);
  } else {
    const remembered = deps.rememberPlanAudit(root);
    if (!remembered.ok) {
      try { closeSessionPane(deps.tmux, paneId); } catch { /* best effort */ }
      rollback();
      return fail(`review-gate: plan 备案失败 —— ${remembered.error}`);
    }
  }
  if (!opened.ok) {
    return fail(
      `review-gate: review pane 开出来了（${paneId}，judge ${judgeId}），但它一直没在自己的通道上报状态 —— ${opened.error}\n` +
      "pane 与登记都**保留**着（不误杀一个可能只是起得慢的 review）：先 `judge_wait({role})` 看它有没有动静；" +
      "确认它真的没起来，再 `judge_close` 后重开。",
    );
  }
  return reply(
    `review-gate: ${kind === "goal" ? "目标" : "计划"} review 已开在独立 pane（${paneId}，judge ${judgeId}）。` +
    `启动已核实：${opened.deliveryNote ?? "（本次没有核实项）"}。` +
    `用 judge_wait 等结论（状态、findings 计数、verdict 由门禁推给你），不要自己去读 pane。` +
    (opened.decorWarning ? `\n${opened.decorWarning}` : ""),
  );
}

async function doAnswer(
  deps: JudgeSpawnToolDeps,
  params: Record<string, unknown>,
): Promise<ToolReply> {
  const caller = deps.callerId();
  if (!caller) {
    return fail("review-gate: 无法确认调用者身份——身份不明时不能代答。");
  }
  const resolved = resolveJudgeId(deps, params);
  if (!resolved.ok) return fail(resolved.text);
  const table = deps.hierarchy();
  const allowed = checkCaller(table, resolved.judgeId, caller);
  if (!allowed.ok) return fail(`review-gate: ${allowed.reason}`);
  const entry = table[resolved.judgeId]!;
  const raw = typeof params.answer === "string" ? params.answer : "";
  const io = deps.channelIO();
  const home = deps.channelHome();
  const target = judgeChannelTarget(entry.openerId, entry.judgeId, home);
  const read = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home));
  const open = projectChannel(read.records).openRequests;
  if (open.length === 0) {
    return reply(`review-gate: review ${entry.judgeId} 当前没有未答的问题——可能人已经在 pane 里答了，或它还没提问。`);
  }
  const first = open[0]!;
  const matched = resolveAnswer(
    {
      childId: entry.judgeId,
      requestId: first.requestId,
      dialogKind: first.dialogKind,
      topic: first.topic,
      title: first.title,
      options: first.options,
      payload: requestPayload(io, first),
      askedAt: first.at,
    },
    raw,
  );
  if (!matched.ok) return fail(`review-gate: ${matched.reason}`);
  appendRecord(io, target, {
    kind: "answer",
    // `from` names the OPENER side of the file (a child session answering
    // its own judge writes here too) — planes differ by key, not by writer.
    from: "orchestrator",
    at: new Date(deps.now()).toISOString(),
    requestId: first.requestId,
    answer: matched.answer,
  });
  return reply(`review-gate: 已代答 review ${entry.judgeId} 的问题「${first.title}」→ ${matched.answer}。`);
}

async function doRecover(
  deps: JudgeSpawnToolDeps,
  params: Record<string, unknown>,
): Promise<ToolReply> {
  const caller = deps.callerId();
  if (!caller) {
    return fail("review-gate: 无法确认调用者身份——身份不明时不能恢复 review。");
  }
  const resolved = resolveJudgeId(deps, params);
  if (!resolved.ok) return fail(resolved.text);
  const allowed = checkCaller(deps.hierarchy(), resolved.judgeId, caller);
  if (!allowed.ok) return fail(`review-gate: ${allowed.reason}`);
  const entry = deps.hierarchy()[resolved.judgeId]!;
  const ownPane = deps.ownPane();
  if (!ownPane) {
    return fail("review-gate: 当前会话不在 tmux 里，无法确认 pane 生死——信息缺失时不重开（两个进程写一个 worktree 比卡住更糟）。");
  }
  // ONE recovery judgement, shared with `orchestrator_recover`
  // (lib/session-factory.ts): refuse a live pane, refuse a handle that never
  // had one, refuse when liveness is unreadable. Only the WORDING is local.
  const verdict = paneRecoverability({
    registered: true,
    ...(entry.paneId === undefined ? {} : { paneId: entry.paneId }),
    paneAlive: entry.paneId ? judgePaneAlive(deps.tmux, ownPane, entry.paneId) : undefined,
  });
  if (verdict === "no-pane") {
    return fail(`review-gate: review ${entry.judgeId} 没有登记 pane——它可能从未成功开出来，用 judge_spawn 重开。`);
  }
  if (verdict === "alive") {
    return fail(`review-gate: pane ${entry.paneId} 还活着——重开一个活着的 review 会让两个进程写同一个会话，先用 judge_wait 看它在干什么。`);
  }
  if (verdict !== "recoverable") {
    return fail("review-gate: tmux 读不出来，无法确认它到底死没死——信息缺失时不重开。");
  }
  const opened = await openSessionPane(deps.tmux, {
    ownPane,
    cwd: entry.repoRoot,
    layout: "child-column",
    role: {
      kind: "judge",
      openerId: entry.openerId,
      judgeId: entry.judgeId,
      role: entry.role,
    },
    command: buildJudgeRecoverCommand(entry.judgeId),
    decor: judgePaneDecor(entry.judgeId, entry.role),
    // The recovered pane is a NEW pane from THIS server — recording the server
    // with it is what keeps the entry closable later.
    register: (paneId) => {
      const recoveredServer = deps.tmuxServer();
      const updated = registerJudge(deps.hierarchy(), {
        ...entry,
        paneId,
        ...(recoveredServer === undefined ? {} : { tmuxServer: recoveredServer }),
      });
      if (updated.ok) deps.saveHierarchy(updated.table);
    },
  });
  if (!opened.ok) return fail(`review-gate: ${opened.error}`);
  return reply(
    `review-gate: review ${entry.judgeId} 已在新 pane（${opened.paneId}）里用同一 session id 重开，transcript 续接，本轮继续。` +
    (opened.decorWarning ? `\n${opened.decorWarning}` : ""),
  );
}

/** The pane-judge lifecycle tools. Registration only — decisions are above. */
export function registerJudgeSpawnTools(host: ToolHost, deps: JudgeSpawnToolDeps): void {
  host.registerTool({
    name: "judge_spawn",
    label: "Spawn Judge Pane",
    description:
      "Open a goal/plan review in its own pane. The gate builds the audit task and records you as the opener — " +
      "only goal/plan reviews open here (checkpoint reviews go through judge_submit's chain). " +
      "Non-opener wait/answer/close/recover on it is refused.",
    parameters: Type.Object({
      kind: SPAWN_KIND_PARAM,
      draft: Type.Optional(Type.String({ description: "Goal draft text (required for kind=goal)" })),
      repo: REPO_PARAM,
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => doSpawn(deps, params, ctx),
  });
  host.registerTool({
    name: "judge_answer",
    label: "Answer Own Judge",
    description:
      "Answer your own review's open question on its behalf (exact text, 1-based number, or unambiguous substring). " +
      "Only the opener may answer; anyone else is refused.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      judgeId: JUDGE_ID_PARAM,
      answer: Type.String({ description: "选项原文、1 起序号或唯一子串" }),
      repo: REPO_PARAM,
    }),
    execute: async (_id, params) => doAnswer(deps, params),
  });
  host.registerTool({
    name: "judge_recover",
    label: "Recover Own Judge",
    description:
      "Re-open your own review's dead pane under the same session id (transcript continues, the round goes on). " +
      "Refuses when the pane is still alive or tmux is unreadable; only the opener may recover.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      judgeId: JUDGE_ID_PARAM,
      repo: REPO_PARAM,
    }),
    execute: async (_id, params) => doRecover(deps, params),
  });
}

