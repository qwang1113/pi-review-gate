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
} from "./orchestrator-channel.ts";
import { resolveAnswer } from "./orchestrator-answer-tools.ts";
import {
  buildJudgePaneCommand,
  buildJudgeRecoverCommand,
  closeJudgePane,
  judgePaneAlive,
  openJudgePane,
  JUDGE_ID_ENV,
  JUDGE_OPENER_ENV,
  JUDGE_ROLE_ENV,
  type JudgePaneRunResult,
} from "./judge-pane.ts";
import {
  JUDGE_TASK_ENV,
  JUDGE_STREAM_ENV,
} from "./judge-side.ts";
import { judgeSessionIdFor, shortRepoHash } from "./judge-process.ts";

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
  /** Injectable clock. */
  now(): number;
  /** Which repo does this call target? Never guessed. */
  resolveRepo(requested: string | undefined): { ok: true; root: string } | { ok: false; error: string };
  /** Model + system prompt + transcript dir for one role in one repo. */
  launchConfig(root: string, role: string):
    | { ok: true; model: string; sysPromptPath: string; sessionDir: string }
    | { ok: false; error: string };
  /** Gate-internal audit tasks — the agent names the KIND, never assembles. ctx threads through from execute. */
  buildGoalAuditTask(draft: string, root: string, ctx: unknown):
    Promise<{ ok: true; task: string; streamPath?: string } | { ok: false; error: string }>;
  buildPlanAuditTask(root: string, ctx: unknown):
    Promise<{ ok: true; task: string; streamPath?: string } | { ok: false; error: string }>;
  /** Persist the round task next to the transcript dir; returns its path. */
  writeJudgeTaskFile(root: string, role: string, task: string):
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

/** Resolve a judge by explicit id, or deterministically by role+repo. */
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
  return { ok: true, judgeId: judgeSessionIdFor(role, shortRepoHash(repo.root)), root: repo.root };
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
  // one judge id per repo, and the gate keeps them apart by pending KIND:
  // a report is only ever recorded against the kind that is pending.
  const pending = deps.pendingAuditKind(root);
  if (pending !== undefined && pending !== kind) {
    return fail(`review-gate: 已有 ${pending === "goal" ? "目标" : "计划"}审计挂着——等它的标准报告送达后再开${kind === "goal" ? "目标" : "计划"}审计。两种审计共用一个 judge，串行才不会错绑结论。`);
  }
  const role = "goal-auditor";
  const earlyJudgeId = judgeSessionIdFor(role, shortRepoHash(root));
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
  const registered = registerJudge(deps.hierarchy(), {
    judgeId,
    openerId: caller,
    role,
    repoRoot: root,
    ...(streamPath === undefined ? {} : { streamPath }),
    createdAt: new Date(deps.now()).toISOString(),
  });
  if (!registered.ok) return fail(`review-gate: ${registered.reason}`);
  deps.saveHierarchy(registered.table);
  const rollback = () => {
    deps.saveHierarchy(removeJudge(deps.hierarchy(), judgeId));
    deps.forgetAudit(root);
  };

  const taskFile = deps.writeJudgeTaskFile(root, role, task);
  if (!taskFile.ok) {
    rollback();
    return fail(`review-gate: 任务文件落盘失败 —— ${taskFile.error}`);
  }
  const ownPane = deps.ownPane();
  if (!ownPane) {
    rollback();
    return fail("review-gate: 当前会话不在 tmux 里，开不出 review pane——在 tmux 中重开本会话后重试；门禁不会退回旧的进程壳子。");
  }
  const launch = deps.launchConfig(root, role);
  if (!launch.ok) {
    rollback();
    return fail(`review-gate: ${launch.error}`);
  }
  const opened = openJudgePane(deps.tmux, {
    ownPane,
    cwd: root,
    sessionId: judgeId,
    judgeId,
    role,
    command: buildJudgePaneCommand({
      sessionId: judgeId,
      taskPath: taskFile.path,
      sessionDir: launch.sessionDir,
      sysPromptPath: launch.sysPromptPath,
      model: launch.model,
    }),
    env: {
      [JUDGE_OPENER_ENV]: caller,
      [JUDGE_ID_ENV]: judgeId,
      [JUDGE_ROLE_ENV]: role,
      [JUDGE_TASK_ENV]: taskFile.path,
      ...(streamPath === undefined ? {} : { [JUDGE_STREAM_ENV]: streamPath }),
    },
  });
  if (!opened.ok) {
    rollback();
    return fail(opened.error);
  }
  const withPane = registerJudge(deps.hierarchy(), {
    judgeId,
    openerId: caller,
    role,
    repoRoot: root,
    paneId: opened.paneId,
    ...(streamPath === undefined ? {} : { streamPath }),
    createdAt: new Date(deps.now()).toISOString(),
  });
  if (withPane.ok) deps.saveHierarchy(withPane.table);
  // Register what was dispatched, or the report can never be recorded:
  // a goal verdict binds to its draft, a plan verdict to its hash.
  if (kind === "goal") {
    deps.rememberGoalAudit(root, draft);
  } else {
    const remembered = deps.rememberPlanAudit(root);
    if (!remembered.ok) {
      try { closeJudgePane(deps.tmux, opened.paneId); } catch { /* best effort */ }
      rollback();
      return fail(`review-gate: plan 备案失败 —— ${remembered.error}`);
    }
  }
  return reply(
    `review-gate: ${kind === "goal" ? "目标" : "计划"} review 已开在独立 pane（${opened.paneId}，judge ${judgeId}）。` +
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
  if (!entry.paneId) {
    return fail(`review-gate: review ${entry.judgeId} 没有登记 pane——它可能从未成功开出来，用 judge_spawn 重开。`);
  }
  const alive = judgePaneAlive(deps.tmux, ownPane, entry.paneId);
  if (alive === true) {
    return fail(`review-gate: pane ${entry.paneId} 还活着——重开一个活着的 review 会让两个进程写同一个会话，先用 judge_wait 看它在干什么。`);
  }
  if (alive === undefined) {
    return fail("review-gate: tmux 读不出来，无法确认它到底死没死——信息缺失时不重开。");
  }
  const opened = openJudgePane(deps.tmux, {
    ownPane,
    cwd: entry.repoRoot,
    sessionId: entry.judgeId,
    judgeId: entry.judgeId,
    role: entry.role,
    command: buildJudgeRecoverCommand(entry.judgeId),
    env: {
      [JUDGE_OPENER_ENV]: entry.openerId,
      [JUDGE_ID_ENV]: entry.judgeId,
      [JUDGE_ROLE_ENV]: entry.role,
    },
  });
  if (!opened.ok) return fail(opened.error);
  const updated = registerJudge(deps.hierarchy(), { ...entry, paneId: opened.paneId });
  if (updated.ok) deps.saveHierarchy(updated.table);
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

