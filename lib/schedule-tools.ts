/**
 * THE SCHEDULED-TASK TOOL SURFACE — `schedule_task`, the ONE entry point.
 *
 * ── ONE TOOL, FOUR ACTIONS (哲学二) ──
 *
 * A pi session asks for the scheduled-task table with the SAME call it uses to
 * change it: `schedule_task({action})` — list / create / update / remove are
 * one lifecycle of one record, and "use A to create and B to update" is a
 * decision every round would have to re-make. The multi-stage half (a contract
 * change is a requirement restatement plus a goal audit plus a user approval)
 * happens INSIDE the call: the agent expresses the intent, the gate runs the
 * chain, and no intermediate state is exposed for anyone to sequence by hand.
 *
 * ── WHERE THE PIECES ARE ──
 *
 *   this module      the identity gate, the four actions' own rules, the
 *                    registration, the replies
 *   schedule-authoring.ts
 *                    the authoring chain itself (cheap validation → the two
 *                    dialogs → the goal audit → the contract), plus the one
 *                    case where the same approval also becomes the SESSION's
 *                    exit contract
 *   schedule-store.ts
 *                    the table, its version rule, and the write rule every
 *                    origin (panel / gate) goes through
 *   schedule-run-contract.ts
 *                    what a RUN of a task inherits at `session_start`
 *
 * The split between the first two is the 600-line hard block's, the same seam
 * lib/goal-tools.ts / lib/goal-prereview-tools.ts was split along: nothing
 * about the flow changed in the move.
 *
 * ── WHO MAY NOT AUTHOR (the identity gate) ──
 *
 * A judge pane, a worker pane and an orchestration child have no requirement
 * contract of their own to confirm — what they run on was settled above them
 * (lib/child-goal-flow.ts) — and a normal-mode session has no contract at all,
 * so a negotiation there would be ceremony over nothing. `create` / `update` /
 * `remove` are refused in those four contexts with the next step named.
 * `list` is a READ and stays available everywhere: refusing it would make
 * 「现在有哪些定时任务」 unanswerable from exactly the sessions most likely to
 * ask.
 *
 * ── THE WRITE RULE IS NOT HERE ──
 *
 * Every write goes through `lib/schedule-store.ts` with `from: "gate"`; the
 * authoring rule (which fields an origin may touch, and that a contract edit
 * must carry both hashes) lives in `applyScheduleEdit` and is called by the
 * store's own write path. This module never re-implements it — the authorization
 * half (who may write at all, and after which consents) is the two modules'.
 *
 * Registered once (`registerScheduleTools`), every effect injected, so each
 * branch below is testable without a terminal, a daemon or a judge process.
 */

import { Type } from "typebox";

import { describeCron } from "./cron-schedule.ts";
import { dueDecision } from "./daemon/scheduler.ts";
import { schedulesPath } from "./daemon/paths.ts";
import type { DeliveryStation } from "./delivery-station.ts";
import { buildRejection } from "./rejection-copy.ts";
import {
  negotiateContract,
  recordSessionContract,
  resolveAuthoringFields,
  type Negotiated,
  type ScheduleAuthoringDeps,
} from "./schedule-authoring.ts";
import {
  addScheduledTask,
  readScheduleRuns,
  readSchedules,
  removeScheduledTask,
  updateScheduledTask,
  type ScheduleEditPatch,
  type ScheduleRunRecord,
  type ScheduledTask,
} from "./schedule-store.ts";
import { toolFail, toolReply, type ToolHost, type ToolReply } from "./tool-host.ts";

/** Everything `schedule_task` needs: the authoring chain, plus WHO is asking. */
export interface ScheduleToolDeps extends ScheduleAuthoringDeps {
  /** The three identity facts the authoring gate refuses on. */
  isJudgePane(): boolean;
  isWorkerPane(): boolean;
  isOrchestrationChild(): boolean;
}

const ACTIONS = ["list", "create", "update", "remove"] as const;
type ScheduleAction = (typeof ACTIONS)[number];

/** The fields whose presence re-opens the contract (everything else is a plain setting). */
const CONTRACT_FIELDS = ["requirement", "repo", "restatement", "goal", "station"] as const;

const str = (raw: unknown): string => (typeof raw === "string" ? raw.trim() : "");
const has = (params: Record<string, unknown>, key: string): boolean => Object.hasOwn(params, key);

// ---------------------------------------------------------------------------
// the identity gate (list passes; authoring does not)
// ---------------------------------------------------------------------------

function authoringRefusal(deps: ScheduleToolDeps): string | undefined {
  if (deps.isJudgePane()) {
    return buildRejection({
      what: "schedule_task 被拒 —— judge 窗口不能新增/修改/删除定时任务",
      why: "一份定时任务的契约要跟用户协商（需求反述 + goal 批准），而 judge 窗口没有可协商的本会话契约，也不该有用户对话框。",
      by: "agent",
      next: "把这件事交回打开这个 judge 的 loop 会话去做；`schedule_task({action:\"list\"})` 在 judge 窗口仍可用（只读）。",
    });
  }
  if (deps.isWorkerPane()) {
    return buildRejection({
      what: "schedule_task 被拒 —— worker 窗口不能新增/修改/删除定时任务",
      why: "worker 是只读的探查窗口（prompt 与工具面都是只读），契约协商属于打开它的 loop 会话。",
      by: "agent",
      next: "把结论报告回打开这个 worker 的会话，由它调 schedule_task。",
    });
  }
  if (deps.isOrchestrationChild()) {
    return buildRejection({
      what: "schedule_task 被拒 —— 编排子会话不能新增/修改/删除定时任务",
      why: "子会话跑的是 plan 里一个任务，它的契约由项目经理审核（不做需求反述、不跑 goal 审计），没有可以拿来当调度契约的会话契约。",
      by: "agent",
      next: "把这件事报给项目经理（`ask_user` 或通道），由它或用户自己的 loop 会话来创建；`schedule_task({action:\"list\"})` 在这里仍可用（只读）。",
    });
  }
  if (deps.taskMode() === "normal") {
    return buildRejection({
      what: "schedule_task 被拒 —— normal 模式（门禁完全关闭）不协商契约",
      why: "新增/修改一份调度任务要先做需求反述与 goal 批准、要记住交付站点；normal 模式既没有契约可记，也没有这些对话框的语义。",
      by: "user",
      next: "让用户把本会话切到 loop 模式（他自己用 `/gate-mode`，或让你用 `set_gate_mode({mode:\"loop\"})` 提出来由他批准），" +
        "再调 `schedule_task`；只想看现有任务就用 `schedule_task({action:\"list\"})`，它不受模式限制。",
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// list / remove (no negotiation)
// ---------------------------------------------------------------------------

/** One task's `list` view: the flat record the reply renders and returns. */
interface TaskView {
  id: string;
  name: string;
  repo: string;
  cron: string;
  describe: string;
  enabled: boolean;
  nextRunAt: string | null;
  /**
   * The slot this task is counting towards has already arrived: the daemon owes
   * it a run. Late is not lost (2026-10-03) — the owed slot keeps its identity
   * until a run consumes it, and `nextRunAt` names THAT slot.
   */
  overdue: boolean;
  station: DeliveryStation;
  /** The newest run of this task, or null when it never ran. */
  lastRun: {
    at: string;
    outcome: string;
    verdict: string | null;
    runId: string;
    /** The branch holding this run's output, when its settlement kept one. */
    branch?: string;
    /** What the settlement did with that output, in one line. */
    landing?: string;
  } | null;
}

function describeTask(task: ScheduledTask, runs: readonly ScheduleRunRecord[], now: Date): TaskView {
  // THE SAME FACTS THE DAEMON RUNS ON (and the panel shows): `dueDecision`
  // counts the next slot from `lastFiredAt ?? createdAt`, so an overdue task
  // reads as overdue instead of as "one period away". The `openRun` half is
  // derived from the LEDGER — append-only and in order, so the newest
  // `run-started`/`run-settled` line is the newest truth about this task —
  // because the answer has to be what the scheduler will DO: a task with an
  // unsettled run is not dealt with until that run settles, so promising
  // 「下一个 tick 就会跑」 would be a lie for exactly that case.
  //
  // ONE LINE IS ENOUGH, unlike the daemon's own `openRuns()` (a started-minus-
  // settled set difference): a task can never have two runs in flight —
  // `dueDecision` refuses to start one while `openRun` is true — so "the newest
  // line is a `run-started`" and "this task has an unsettled run" cannot
  // diverge. `run-skipped` lines carry no run, so they are not part of the answer.
  // `run-window` is a SUPPLEMENT to a run, not a run: only these two kinds are
  // one, and only a `run-started` can be "the newest thing that happened".
  const lastRun = runs.filter((r) => r.kind === "run-started" || r.kind === "run-settled").at(-1);
  const openRun = lastRun?.kind === "run-started";
  const decision = dueDecision({ task, now, openRun });
  const slot = decision.scheduledAt;
  return {
    id: task.id,
    name: task.name,
    repo: task.repo,
    cron: task.cron,
    describe: describeCron(task.cron),
    enabled: task.enabled,
    nextRunAt: slot ? slot.toISOString() : null,
    overdue: slot !== null && slot.getTime() <= now.getTime(),
    station: task.contract.restatement.station,
    lastRun: lastRun === undefined
      ? null
      : lastRun.kind === "run-settled"
        ? {
            at: lastRun.at,
            outcome: lastRun.outcome,
            verdict: lastRun.verdict,
            runId: lastRun.runId,
            ...(lastRun.branch === undefined ? {} : { branch: lastRun.branch }),
            ...(lastRun.landing === undefined ? {} : { landing: lastRun.landing }),
          }
        : { at: lastRun.at, outcome: "open", verdict: null, runId: lastRun.runId },
  };
}

/**
 * The table, as the agent reads it. `version` goes out too: `expectedVersion`
 * on a later write is an optimistic check against EXACTLY this number, and a
 * value the caller cannot obtain is a parameter nobody can use.
 */
function listReply(home: string, tasks: readonly ScheduledTask[], version: number, deps: ScheduleToolDeps): ToolReply {
  const runs = readScheduleRuns(home);
  const now = deps.now?.() ?? new Date();
  const described = tasks.map((task) => describeTask(task, runs.filter((r) => r.taskId === task.id), now));
  if (described.length === 0) {
    return toolReply(
      `review-gate: 当前没有任何定时任务（调度表：${schedulesPath(home)}，version ${version}，空）。\n` +
      "要新增，用 `schedule_task({action:\"create\", name, repo, cron, requirement, restatement, goal, station})`——" +
      "它会依次问你需求反述与 goal 批准。",
      { version, tasks: [] },
    );
  }
  const lines = described.map((t) => [
    `- ${t.name}（${t.id}）${t.enabled ? "" : " [已停用]"}`,
    `  repo: ${t.repo}`,
    `  cron: ${t.cron}（${t.describe}）`,
    `  下次运行: ${t.nextRunAt === null
      ? "（停用或 cron 无解，不再跑）"
      : t.nextRunAt + (t.overdue
        ? (t.lastRun?.outcome === "open"
          ? "（已过期：本任务还有一次运行没结算；它一结算，这一槽立刻跑）"
          : "（已到点还没跑：daemon 的下一次 tick 会处理；暂时起不来时这一槽会留着，不会被丢掉）")
        : "")}`,
    `  交付站点: ${t.station}`,
    `  最近一次运行: ${t.lastRun === null ? "从未运行" : `${t.lastRun.at} → ${t.lastRun.outcome}${t.lastRun.verdict ? `（${t.lastRun.verdict}）` : ""}${t.lastRun.branch ? `\n  产出留在: ${t.lastRun.branch}${t.lastRun.landing ? `（${t.lastRun.landing}）` : ""}` : ""}`}`,
  ].join("\n"));
  return toolReply(
    `review-gate: 定时任务 ${described.length} 条（调度表 version ${version}）：\n` + lines.join("\n"),
    { version, tasks: described },
  );
}

function removeReply(home: string, params: Record<string, unknown>): ToolReply {
  const id = str(params.id);
  if (id === "") {
    return toolFail("review-gate: schedule_task(remove) 被拒 —— 缺 `id`（remove 只按 id 精确命中，不按名字猜）。");
  }
  const removed = removeScheduledTask(home, id, {
    ...(typeof params.expectedVersion === "number" ? { expectedVersion: params.expectedVersion } : {}),
  });
  if (!removed.ok) {
    return toolFail(buildRejection({
      what: `schedule_task(remove) 被拒 —— 没有删掉任何东西：${removed.problem}`,
      why: "remove 只认精确的 id；按名字或模糊匹配删任务会删错那一份契约。",
      by: "agent",
      next: `用 \`schedule_task({action:"list"})\` 抄下确切的 id（形如 sch-xxxxxxxx）再调一次。`,
    }));
  }
  return toolReply(
    `review-gate: 已删除定时任务 ${removed.value.name}（${removed.value.id}，repo ${removed.value.repo}，cron ${removed.value.cron}）。\n` +
    "台账（schedule-runs.jsonl）不动：它记的是真跑过什么。",
    { removed: { id: removed.value.id, name: removed.value.name, repo: removed.value.repo, cron: removed.value.cron } },
  );
}

// ---------------------------------------------------------------------------
// create / update (with or without a contract)
// ---------------------------------------------------------------------------

interface Authored {
  kind: "create" | "update";
  current?: ScheduledTask;
  params: Record<string, unknown>;
  ctx: unknown;
  onUpdate: unknown;
  signal?: AbortSignal | undefined;
}

/** The tuple every write ends in: the record, the session note, the reply. */
function authoredReply(kind: "create" | "update", task: ScheduledTask, sessionNote: string): ToolReply {
  return toolReply(
    [
      `review-gate: 定时任务 ${task.name}（${task.id}）已${kind === "create" ? "创建" : "更新"}。`,
      `repo: ${task.repo}｜cron: ${task.cron}（${describeCron(task.cron)}）｜${task.enabled ? "启用" : "停用"}`,
      `交付站点: ${task.contract.restatement.station}｜契约批准于 ${task.contract.approvedAt}`,
      sessionNote,
      "到点由 daemon 起一个 loop 会话执行（它会在 session_start 继承这份契约）；运行结果记在台账里。",
    ].filter(Boolean).join("\n"),
    { task: { id: task.id, name: task.name, repo: task.repo, cron: task.cron, station: task.contract.restatement.station } },
  );
}

/** The refusal a write that the store turned down gets — one shape, one place. */
function writeProblem(kind: "create" | "update", problem: string): ToolReply {
  return toolFail(buildRejection({
    what: `schedule_task(${kind}) 被拒 —— 调度记录没写成：${problem}`,
    why: "写入走 lib/schedule-store.ts 的 `from:\"gate\"` 路径（作者规则、hash 校验、version 检查都在那里），它拒绝了这次写入。",
    by: "agent",
    next: "version 冲突就重读一遍 `schedule_task({action:\"list\"})` 再重试；字段不合法就按上面的说明改；" +
      "契约要重新协商时，整条链会重走一遍（这是有意的：批准绑定的是内容）。",
  }));
}

async function doAuthored(deps: ScheduleToolDeps, input: Authored): Promise<ToolReply> {
  const { params, current } = input;
  const home = deps.home();
  const create = input.kind === "create";
  const { fields, problems } = resolveAuthoringFields(deps, {
    kind: input.kind, params, ...(current ? { current } : {}),
  });
  if (problems.length > 0) {
    return toolFail(buildRejection({
      what: `schedule_task(${input.kind}) 被拒 —— 入参不合法：${problems.join("；")}`,
      why: "这些字段在协商之前就能判：让用户先答两个对话框、再花几分钟审计一份注定写不进去的契约，是把昂贵的一步排在便宜的一步前面。",
      by: "agent",
      next: "按上面的说明改好字段再调；字段含义见工具的 description（cron 是 5 段：分 时 日 月 周）。",
    }));
  }

  const patch: ScheduleEditPatch = {};
  if (has(params, "name")) patch.name = fields.name;
  if (has(params, "cron")) patch.cron = fields.cron;
  if (has(params, "enabled")) patch.enabled = fields.enabled;
  if (has(params, "requirement")) patch.requirement = fields.requirement;
  if (has(params, "repo")) patch.repo = fields.repo;

  // A create always carries a contract; an update carries one exactly when it
  // reaches for an authored field. Everything else is a plain setting.
  let negotiated: Negotiated | undefined;
  if (create || CONTRACT_FIELDS.some((field) => has(params, field))) {
    const outcome = await negotiateContract(deps, {
      label: fields.name,
      repo: fields.repo,
      restatement: params.restatement,
      goal: params.goal,
      station: params.station,
      ...(current ? { fallbackStation: current.contract.restatement.station } : {}),
      ctx: input.ctx,
      onUpdate: input.onUpdate,
      signal: input.signal,
    });
    if (!outcome.ok) return toolFail(outcome.text);
    negotiated = outcome;
    patch.contract = outcome.contract;
    // The contract binds to the REPO'S GIT ROOT — that is what a run session's
    // own repo resolves to, and what `adoptScheduledRunContract` compares.
    patch.repo = outcome.root;
  }
  if (create && negotiated === undefined) {
    // Unreachable: `create` always negotiates above. The guard is here so the
    // compiler knows a create cannot reach the store without a contract.
    return toolFail("review-gate: schedule_task(create) 被拒 —— 新建必须带契约（restatement + goal + station）。");
  }

  const expected = typeof params.expectedVersion === "number" ? { expectedVersion: params.expectedVersion } : {};
  // THE WRITE ITSELF: `from: "gate"` is what routes it through
  // `applyScheduleEdit` — the store's one implementation of the authoring rule.
  const result = create
    ? addScheduledTask(home, {
      name: fields.name,
      repo: negotiated!.root,
      cron: fields.cron,
      requirement: fields.requirement,
      contract: negotiated!.contract,
      enabled: fields.enabled,
      from: "gate",
      ...expected,
    })
    : updateScheduledTask(home, current!.id, patch, { from: "gate", ...expected });
  if (!result.ok) return writeProblem(input.kind, result.problem);
  const task = result.value;

  let sessionNote = "这次只改了 name / cron / enabled —— 契约未动，不重走协商。";
  if (negotiated !== undefined) {
    try {
      sessionNote = recordSessionContract(deps, input.ctx, { contract: negotiated.contract, root: negotiated.root });
    } catch (error) {
      sessionNote = `调度记录已写入，但本会话的契约没能记上（${error instanceof Error ? error.message : String(error)}）——` +
        "调度任务本身不受影响；本会话的 edit/ship 仍按它原来的契约（可能还没有）判定。";
    }
  }
  deps.log(`schedule_task: ${input.kind} ${task.id}（${task.name}）→ ${task.repo}`);
  return authoredReply(input.kind, task, sessionNote);
}

// ---------------------------------------------------------------------------
// the tool
// ---------------------------------------------------------------------------

export async function doScheduleTask(
  deps: ScheduleToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
  onUpdate: unknown,
  signal?: AbortSignal | undefined,
): Promise<ToolReply> {
  const action = str(params.action) as ScheduleAction;
  if (!ACTIONS.includes(action)) {
    return toolFail(`review-gate: schedule_task 的 action 只能是 ${ACTIONS.join(" / ")}（收到 ${JSON.stringify(params.action)}）。`);
  }
  if (action !== "list") {
    const refusal = authoringRefusal(deps);
    if (refusal) return toolFail(refusal);
  }
  const home = deps.home();
  const table = readSchedules(home);
  if (!table.ok) {
    return toolFail(buildRejection({
      what: "schedule_task 被拒 —— 调度表读不出来，什么都没做",
      why: table.problem,
      by: "user",
      next: "让人工修好那个文件（工具从不把读不出来的表当成空表——那会让下一笔写入覆盖掉盘上的任务），再重试。",
    }));
  }
  if (action === "list") return listReply(home, table.file.tasks, table.file.version, deps);
  if (action === "remove") return removeReply(home, params);

  if (action === "update") {
    const id = str(params.id);
    if (id === "") {
      return toolFail("review-gate: schedule_task(update) 被拒 —— 缺 `id`（update 按 id 寻址，name 是要改成的新名字）。");
    }
    const current = table.file.tasks.find((task) => task.id === id);
    if (current === undefined) {
      return toolFail(buildRejection({
        what: `schedule_task(update) 被拒 —— 找不到 id ${id}`,
        why: "id 不会被改写，update 也不按名字或前缀猜。",
        by: "agent",
        next: "用 `schedule_task({action:\"list\"})` 抄下确切的 id 再调。",
      }));
    }
    return doAuthored(deps, { kind: "update", current, params, ctx, onUpdate, signal });
  }
  return doAuthored(deps, { kind: "create", params, ctx, onUpdate, signal });
}

/** The family's single registration entry point — ONE tool. */
export function registerScheduleTools(host: ToolHost, deps: ScheduleToolDeps): void {
  host.registerTool({
    name: "schedule_task",
    label: "Schedule Task",
    description:
      "The ONE tool for scheduled tasks. action=\"list\" answers what exists (id / name / repo / cron / " +
      "enabled / next run / contract station / the last run and its verdict). action=\"create\" and an " +
      "action=\"update\" that touches requirement / repo / restatement / goal / station run the WHOLE " +
      "contract chain inside this call: the requirement restatement is shown to the user for confirmation, " +
      "the goal draft is audited by `goal-auditor` (only P0/P1 block — the same chain and adjudication as " +
      "`propose_loop_goal`), and the goal is then approved in a dialog. Any step refused ⇒ nothing is " +
      "written and the reply names the next step. When the session has no approved loop goal yet and the " +
      "task lives in its own repo, the approved contract is ALSO recorded as that session's exit contract. " +
      "An update that only carries cron / enabled / name does NOT renegotiate. action=\"remove\" deletes by " +
      "exact id and returns the removed record. Refused in a judge pane, a worker pane, an orchestration " +
      "child and normal mode (list still works there).",
    parameters: Type.Object({
      action: Type.Union(ACTIONS.map((value) => Type.Literal(value)), {
        description: "\"list\" | \"create\" | \"update\" | \"remove\"",
      }),
      id: Type.Optional(Type.String({
        description: "Exact task id (sch-xxxxxxxx) — required for update and remove.",
      })),
      name: Type.Optional(Type.String({ description: "kebab-case, 2–32, unique. Required on create." })),
      repo: Type.Optional(Type.String({
        description: "Absolute path of the repo the runs work in (its git root is what gets stored). Required on create.",
      })),
      cron: Type.Optional(Type.String({ description: "5-field cron: minute hour day month weekday. Required on create." })),
      requirement: Type.Optional(Type.String({ description: "The user's own sentence(s) describing the task. Required on create." })),
      enabled: Type.Optional(Type.Boolean({ description: "Whether the schedule fires. Default: true." })),
      restatement: Type.Optional(Type.String({
        description: "The requirement restatement (Simplified Chinese, MUST carry a before/after contrast). A contract write without it is refused.",
      })),
      goal: Type.Optional(Type.String({
        description: "The task's loop goal text (the contract each run works to; same shape as propose_loop_goal's). A contract write without it is refused.",
      })),
      station: Type.Optional(Type.String({
        description: "Delivery station for the runs: precommit | commit | pr. Missing ⇒ the task's current one, else the strictest (precommit).",
      })),
      expectedVersion: Type.Optional(Type.Number({
        description: "Optional optimistic check against the version you read from a previous list.",
      })),
    }),
    execute: (_id, params, signal, onUpdate, ctx) => doScheduleTask(deps, params, ctx, onUpdate, signal),
  });
}
