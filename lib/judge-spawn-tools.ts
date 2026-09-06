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
  findJudgeLane,
  paneClosable,
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
  countDecoratedPanes,
  judgePaneDecor,
  openSessionPane,
  paneRecoverability,
  releasesWindowLabels,
} from "./session-factory.ts";
import {
  judgePaneAlive,
  listJudgePanes,
  type JudgePaneRunResult,
} from "./judge-pane.ts";
import { verifyJudgeBoot, channelRecordCount } from "./orchestrator-tool-kit.ts";
import { judgeSessionIdFor, shortRepoHash, type JudgeLane } from "./judge-process.ts";

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
  /**
   * Does someone else own this window's label bar (an orchestration this
   * session is only a guest in)? A guest never releases it — see
   * `releasesWindowLabels`. Only the rollback path here asks.
   */
  insideOrchestration(): boolean;
  /** Which repo does this call target? Never guessed. */
  resolveRepo(requested: string | undefined): { ok: true; root: string } | { ok: false; error: string };
  /**
   * THE LANE this spawn's judge belongs to (lib/judge-rotation.ts), decided by
   * the gate — retiring a lane it replaces is the resolver's own job.
   *
   * Resolved ONCE per spawn and passed to every derivation below (the judge
   * id, the launch config's session dir, the round's task file), because the
   * resolution ADVANCES bookkeeping: asking twice would count this spawn as
   * two rounds and could hand the second derivation a different lane than the
   * first. That mismatch is not cosmetic — a transcript id from one lane
   * beside a session dir from another is a judge writing where nobody reads.
   */
  lane(root: string, role: string, opener: string): {
    lane: JudgeLane;
    roundsInObject: number;
    /**
     * Close and forget the lane this spawn replaces. Called ONLY after the new
     * pane is up and registered: dropping the old row is irreversible, and a
     * spawn that fails afterwards would leave the next dispatch with no
     * previous lane — which decides "first" at generation 0 and resumes the
     * transcript that was just rotated away. Idempotent; a no-op when the lane
     * did not change.
     */
    retirePrevious(): void;
  };
  /** Model + system prompt + transcript dir for one role in one repo. */
  launchConfig(root: string, role: string, opener: string, lane: JudgeLane | undefined):
    | { ok: true; model: string; sysPromptPath: string; sessionDir: string }
    | { ok: false; error: string };
  /** Gate-internal audit tasks — the agent names the KIND, never assembles. ctx threads through from execute. */
  buildGoalAuditTask(draft: string, root: string, ctx: unknown):
    Promise<{ ok: true; task: string; streamPath?: string } | { ok: false; error: string }>;
  buildPlanAuditTask(root: string, ctx: unknown):
    Promise<{ ok: true; task: string; streamPath?: string } | { ok: false; error: string }>;
  /** Persist the round task next to the transcript dir; returns its path. */
  writeJudgeTaskFile(root: string, role: string, opener: string, task: string, lane: JudgeLane | undefined):
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
  // THE REGISTRY ANSWERS FIRST, and derivation is only the fallback. A judge
  // id carries its lane, so deriving one here would name the lane the NEXT
  // dispatch will use — not the lane the live judge this call means is running
  // in. `judge_answer` / `judge_recover` address something that already
  // exists, so the recorded id is the truthful answer whenever there is one.
  const existing = findJudgeLane(deps.hierarchy(), { role, repoRoot: repo.root, openerId: opener });
  if (existing) return { ok: true, judgeId: existing.judgeId, root: repo.root };
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
  // Spawn is birth: one pane per review object. A living pane takes its
  // rounds through judge_submit, a dead one goes through judge_recover —
  // spawning over either would strand a review or fork a transcript.
  //
  // The incumbent is looked UP, not derived: a judge id now carries its lane
  // (lib/judge-rotation.ts), and this spawn's lane may not be the one the live
  // pane is running in. Deriving an id would then find nothing and open a
  // SECOND pane for the same role beside the live one.
  const incumbent = findJudgeLane(deps.hierarchy(), { role, repoRoot: root, openerId: caller });
  if (incumbent?.paneId) {
    const ownPane = deps.ownPane();
    const alive = ownPane ? judgePaneAlive(deps.tmux, ownPane, incumbent.paneId) : undefined;
    if (alive === true) {
      return fail(`review-gate: review ${incumbent.judgeId} 的 pane（${incumbent.paneId}）还开着——新一轮走 judge_submit（pane 复用），不要重开。`);
    }
    if (alive === false) {
      return fail(`review-gate: review ${incumbent.judgeId} 的 pane 已消失——用 judge_recover 同 id 重开续 transcript，不要重开。`);
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
  // THE LANE, resolved once, now that nothing below can refuse on parameters
  // alone: the resolver may RETIRE the lane this spawn replaces, and that is
  // not a side effect to pay for a missing `draft`.
  const laneInfo = deps.lane(root, role, caller);
  const judgeId = judgeSessionIdFor(role, shortRepoHash(root), caller, laneInfo.lane);
  // Number this review's first round above every report already in the channel:
  // a close→spawn keeps the old reports, and restarting at 1 would collide with them
  // (the judge refuses a round its channel already closed).
  const birthSeq = nextSpawnRoundSeq(deps, caller, judgeId);
  // The two checks that can refuse outright — no tmux, no resolvable model
  // chain — run BEFORE the id is claimed. They used to sit after it and undo
  // it, and the claim in between was the only reason `rollback` had to exist
  // for them at all.
  const ownPane = deps.ownPane();
  if (!ownPane) {
    return fail("review-gate: 当前会话不在 tmux 里，开不出 review pane——在 tmux 中重开本会话后重试；门禁不会退回旧的进程壳子。");
  }
  const launch = deps.launchConfig(root, role, caller, laneInfo.lane);
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
    // The lane this birth belongs to, so the next dispatch can decide from the
    // registry alone whether the transcript keeps going.
    objectId: laneInfo.lane.objectId,
    generation: laneInfo.lane.generation,
    roundsInObject: laneInfo.roundsInObject,
    spawnedAt: new Date(deps.now()).toISOString(),
  });

  if (!registered.ok) return fail(`review-gate: ${registered.reason}`);
  deps.saveHierarchy(registered.table);
  const rollback = () => {
    deps.saveHierarchy(removeJudge(deps.hierarchy(), judgeId));
    deps.forgetAudit(root);
  };

  const taskFile = deps.writeJudgeTaskFile(root, role, caller, task, laneInfo.lane);
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
        // The SAME lane the id and the dirs above were rendered from — this
        // registration REPLACES the pre-open one, so leaving the bookkeeping
        // out here would erase it the moment the pane comes up.
        objectId: laneInfo.lane.objectId,
        generation: laneInfo.lane.generation,
        roundsInObject: laneInfo.roundsInObject,
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
  // (The lane this spawn replaces is retired further down — AFTER the last
  // path that can still roll this spawn back. See the comment there.)
  // Register what was dispatched, or the report can never be recorded:
  // a goal verdict binds to its draft, a plan verdict to its hash. This runs
  // even when the boot check failed, because the pane is KEPT: a slow judge
  // that reports late must still be recordable.
  if (kind === "goal") {
    deps.rememberGoalAudit(root, draft);
  } else {
    const remembered = deps.rememberPlanAudit(root);
    if (!remembered.ok) {
      // The pane we just opened turned the window's border line ON
      // (`decorateSessionPane`), so undoing the spawn has to undo that too —
      // unless a sibling judge is still on screen and needs it. Same judgement
      // as `judge_close`, addressed through OUR pane because the one being
      // killed is the id that may already be gone.
      const others = countDecoratedPanes(
        Object.values(deps.hierarchy())
          .filter((entry) =>
            entry.judgeId !== judgeId
            && entry.openerId === caller
            && Boolean(entry.paneId)
            // Same attribution rule as `judge_close`: an id minted by a tmux
            // server that has since restarted names a stranger's pane, not a
            // sibling of ours, and counting it would keep the bar up forever.
            && paneClosable(entry, deps.tmuxServer()))
          .map((entry) => entry.paneId!),
        listJudgePanes(deps.tmux, ownPane),
      );
      const releases = releasesWindowLabels({
        remainingDecoratedPanes: others,
        insideOrchestration: deps.insideOrchestration(),
      });
      const closeOpts = releases ? { hideLabelsVia: ownPane } : {};
      try { closeSessionPane(deps.tmux, paneId, closeOpts); } catch { /* best effort */ }
      rollback();
      return fail(`review-gate: plan 备案失败 —— ${remembered.error}`);
    }
  }
  // THE LAST ROLLBACK IS BEHIND US — only now is the lane this spawn replaces
  // safe to close and forget. Retiring any earlier (at resolution time, or
  // straight after the pane opened) hands the rollback paths above a registry
  // with NO lane for this role: the next dispatch would decide `first` at
  // generation 0 and resume the transcript that was just rotated away, with
  // its round count back at one. `rememberPlanAudit` failing is a real such
  // path — it closes the pane and drops this spawn's own row (reviewer P2,
  // 2026-09-05). This is the SAME resolution as above, never a second one:
  // asking twice would both advance the round count and answer from a registry
  // this spawn has already written to.
  laneInfo.retirePrevious();
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
  // WHICH question, when a judge has more than one open (2026-09-06). An
  // `ask_user` interview now puts its whole batch on the channel at once, and
  // a judge pane talks through this very same funnel — so "answer the oldest
  // one" stopped being unambiguous. Two answers sent before the judge's own
  // poll settled the first would both have landed on question 1, silently
  // leaving 2 and 3 unanswered while the opener believed it had answered
  // them. Same rule as `orchestrator_answer`: with several open, say which.
  const wantedId = String(params.requestId ?? "").trim();
  const first = wantedId
    ? open.find((r) => r.requestId === wantedId)
    : open.length === 1 ? open[0] : undefined;
  if (!first) {
    return fail(
      wantedId
        ? `review-gate: review ${entry.judgeId} 没有 requestId=${wantedId} 这个待答问题（可能已经答掉了）。` +
          `现在待答的是：${open.map((r) => r.requestId).join("、")}`
        : `review-gate: review ${entry.judgeId} 同时有 ${open.length} 个待答问题，必须指明 requestId：` +
          open.map((r) => `${r.requestId}（${r.title}）`).join("；"),
    );
  }

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
      "With more than one question open — an `ask_user` interview arrives as a batch — pass the `requestId` " +
      "the judge_wait receipt printed beside it; without one the answer is refused rather than aimed at a guess. " +
      "Only the opener may answer; anyone else is refused.",

    parameters: Type.Object({
      role: ROLE_PARAM,
      judgeId: JUDGE_ID_PARAM,
      answer: Type.String({ description: "选项原文、1 起序号或唯一子串" }),
      requestId: Type.Optional(Type.String({
        description: "同时有多个待答问题时必填（judge_wait 的回执在每个问题后面印了它）",
      })),
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

