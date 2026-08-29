/**
 * The PLAN, STATUS and NOTIFY tools — the orchestration's own bookkeeping.
 *
 * The session tools (spawn / send / wait / close / relay) live in
 * lib/orchestrator-session-tools.ts; these three are the ones that do not
 * touch tmux at all. Split that way because they have genuinely different
 * failure modes: everything here is a decision about STATE, everything there
 * is a decision about somebody else's PROCESS.
 *
 * `orchestrator_plan` carries an `action` rather than being five tools,
 * because the plan is one object with one approval binding: splitting it
 * would invite an agent to mutate a task's status through one tool while the
 * approval hash was computed by another.
 */

import { Type } from "typebox";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";
import {
  applyTaskStatus,
  formatPlanSummary,
  parsePlan,
  planHash,
  type OrchestratorPlan,
  type TaskStatus,
} from "./orchestrator-plan.ts";
import {
  formatOrchestrationStatus,
  notifyAuthorization,
  orchestratorDoneProblems,
} from "./orchestrator-gate.ts";
import { formatChildren } from "./orchestrator-registry.ts";
import {
  decideNotify,
  notifyKey,
  prepareNotification,
  recordNotify,
} from "./orchestrator-notify.ts";
// Aliased to the short local names: inside a tool module `reply`/`fail` are
// unambiguous, while the EXPORTED names stay specific enough not to collide
// with ordinary prose elsewhere in the repo.
import {
  alivePanes,
  currentPlan,
  toolFail as fail,
  toolReply as reply,
  requireOrchestratorMode,
} from "./orchestrator-tool-kit.ts";
import { formatInheritanceBrief, readInheritance } from "./orchestrator-relay.ts";

const PLAN_ACTIONS = {
  read: "read",
  write: "write",
  submit: "submit",
  "set-status": "set-status",
  "add-decision": "add-decision",
  "resolve-decision": "resolve-decision",
} as const;

/** The dialog the USER approves a plan in (constraint 1). */
export const PLAN_CONFIRM_TITLE = "review-gate: 批准项目经理的任务计划（plan）？";

export function buildPlanConfirmMessage(plan: OrchestratorPlan): string {
  return (
    "批准后，项目经理才能按这份 plan 开子会话干活。批准的是**内容**：" +
    "任务、文件边界、依赖、并行度中任何一项被改动，批准即失效，需要重新批准。\n\n" +
    formatPlanSummary(plan)
  );
}

async function handlePlanAction(
  deps: OrchestratorDeps,
  params: Record<string, unknown>,
): Promise<ToolReply> {
  const action = String(params.action ?? "read");
  const nowIso = new Date(deps.now()).toISOString();

  if (action === PLAN_ACTIONS.write) {
    const parsed = parsePlan(params.plan, nowIso);
    if (!parsed.ok || !parsed.plan) {
      return fail(
        "review-gate: plan 不合法，没有写入：\n" + parsed.problems.map((p) => `  - ${p}`).join("\n"),
        { problems: parsed.problems },
      );
    }
    deps.savePlan(parsed.plan);
    // Writing the plan REVOKES any previous approval whose content differs —
    // the same content binding the loop goal uses. Recomputing here (rather
    // than trusting the stored hash) is what makes "I edited it a bit" fail.
    const runtime = deps.runtime();
    const stillApproved = runtime.approvedPlanHash === planHash(parsed.plan);
    if (!stillApproved && runtime.approvedPlanHash) {
      deps.saveRuntime({ ...runtime, approvedPlanHash: undefined, approvedPlanAt: undefined });
    }
    return reply(
      "review-gate: plan 已写入 " + ".pi/orchestrator-plan.json" + "。\n" +
      formatPlanSummary(parsed.plan) +
      "\n\n" +
      (stillApproved
        ? "内容与已批准的版本一致，批准仍然有效。"
        : "尚未获得用户批准 —— 用 `orchestrator_plan({ action: \"submit\" })` 提交批准后才能 spawn。"),
      { approved: stillApproved },
    );
  }

  const { plan, problem } = currentPlan(deps);
  if (problem) return problem;

  if (action === PLAN_ACTIONS.submit) {
    if (!plan) return fail("review-gate: 还没有 plan 可提交 —— 先用 action:\"write\" 写一份。");
    const granted = await deps.confirm(PLAN_CONFIRM_TITLE, buildPlanConfirmMessage(plan));
    if (!granted) {
      return fail(
        "review-gate: 用户没有批准这份 plan。按他的意见改完再提交一次" +
        "（他的答复可能在聊天里，也可能要你用 `ask_user` 追问）。",
        { approved: false },
      );
    }
    deps.saveRuntime({
      ...deps.runtime(),
      approvedPlanHash: planHash(plan),
      approvedPlanAt: nowIso,
    });
    return reply("review-gate: plan 已获用户批准，可以开始 `orchestrator_spawn`。", { approved: true });
  }

  if (action === PLAN_ACTIONS["set-status"]) {
    if (!plan) return fail("review-gate: 还没有 plan。");
    const taskId = String(params.taskId ?? "");
    const status = String(params.status ?? "") as TaskStatus;
    const moved = applyTaskStatus(plan, taskId, status, {
      note: params.note === undefined ? undefined : String(params.note),
      now: nowIso,
    });
    if (!moved.ok) return fail("review-gate: " + moved.reason);
    deps.savePlan(moved.plan);
    return reply(`review-gate: 任务 ${taskId} → ${status}。\n` + formatPlanSummary(moved.plan));
  }

  if (action === PLAN_ACTIONS["add-decision"]) {
    if (!plan) return fail("review-gate: 还没有 plan。");
    const id = String(params.decisionId ?? "").trim();
    const question = String(params.question ?? "").trim();
    if (!id || !question) return fail("review-gate: add-decision 需要 decisionId 与 question。");
    if (plan.decisions.some((d) => d.id === id)) return fail(`review-gate: 决策项 "${id}" 已存在。`);
    const next = { ...plan, decisions: [...plan.decisions, { id, question }], updatedAt: nowIso };
    deps.savePlan(next);
    return reply(
      `review-gate: 已登记待用户决策 "${id}"。注意：**没通知过用户的决策项会拦住 declare_done**（约束 11）——` +
      "用 `orchestrator_notify` 告诉他。",
    );
  }

  if (action === PLAN_ACTIONS["resolve-decision"]) {
    if (!plan) return fail("review-gate: 还没有 plan。");
    const id = String(params.decisionId ?? "").trim();
    const answer = String(params.answer ?? "").trim();
    const target = plan.decisions.find((d) => d.id === id);
    if (!target) return fail(`review-gate: 没有决策项 "${id}"。`);
    const next = {
      ...plan,
      decisions: plan.decisions.map((d) => (d.id === id ? { ...d, resolvedAt: nowIso, answer } : d)),
      updatedAt: nowIso,
    };
    deps.savePlan(next);
    return reply(`review-gate: 决策项 "${id}" 已记为已解决。`);
  }

  // read (default)
  if (!plan) {
    return reply(
      "review-gate: 还没有 plan。用 `orchestrator_plan({ action: \"write\", plan: {...} })` 写一份 —— " +
      "每个任务都必须声明 fileBoundaries（文件边界），并行调度与代批 goal 都靠它。",
      { present: false },
    );
  }
  const runtime = deps.runtime();
  const approved = runtime.approvedPlanHash === planHash(plan);
  return reply(
    formatPlanSummary(plan) + "\n\n" + (approved ? "状态：已获用户批准。" : "状态：**未获批准**，不能 spawn。"),
    { present: true, approved },
  );
}

/** Register `orchestrator_plan`, `orchestrator_status` and `orchestrator_notify`. */
export function registerOrchestratorStateTools(host: ToolHost, deps: OrchestratorDeps): void {
  host.registerTool({
    name: "orchestrator_plan",
    label: "Orchestrator Plan",
    description:
      "Read or change the orchestration PLAN — the task list that is this orchestration's exit " +
      "contract, and the only thing that authorizes spawning a child session. Actions: " +
      "\"read\" (default), \"write\" (replace the plan; every task MUST declare fileBoundaries), " +
      "\"submit\" (ask the USER to approve it — the gate renders the dialog; writing the file " +
      "yourself grants nothing), \"set-status\" (move one task through the state machine), " +
      "\"add-decision\" / \"resolve-decision\" (questions only the human can settle). Changing " +
      "tasks, boundaries, dependencies or maxParallel REVOKES the approval: it binds to content.",
    parameters: Type.Object({
      action: Type.Optional(Type.Enum(PLAN_ACTIONS)),
      plan: Type.Optional(Type.Any({
        description:
          "For action=\"write\": { title, intent, maxParallel?, tasks: [{ id, title, " +
          "fileBoundaries: [\"lib/\", ...], dependsOn?: [], execution?: \"serial\"|\"parallel\" }] }",
      })),
      taskId: Type.Optional(Type.String({ description: "For action=\"set-status\"" })),
      status: Type.Optional(Type.Enum({ pending: "pending", running: "running", done: "done", blocked: "blocked" })),
      note: Type.Optional(Type.String({ description: "Why — recorded on the task" })),
      decisionId: Type.Optional(Type.String()),
      question: Type.Optional(Type.String({ description: "For action=\"add-decision\"" })),
      answer: Type.Optional(Type.String({ description: "For action=\"resolve-decision\"" })),
    }),
    async execute(_id, params) {
      const refusal = requireOrchestratorMode(deps);
      if (refusal) return refusal;
      return handlePlanAction(deps, params);
    },
  });

  host.registerTool({
    name: "orchestrator_status",
    label: "Orchestrator Status",
    description:
      "Read back the WHOLE orchestration in one call: the plan and its task states, every child " +
      "session with its live/dead pane, what a relay handed you, and exactly what still blocks " +
      "declare_done. This is how a successor orchestrator picks up where the previous one stopped.",
    parameters: Type.Object({}),
    async execute() {
      const refusal = requireOrchestratorMode(deps);
      if (refusal) return refusal;
      const { plan, problem } = currentPlan(deps);
      if (problem) return problem;
      const runtime = deps.runtime();
      const panes = alivePanes(deps);
      const branch = deps.branchFacts();
      const facts = {
        plan,
        runtime,
        alivePaneIds: panes.panes,
        workBranch: branch.workBranch,
        baseBranch: branch.baseBranch,
        mergeSettled: branch.mergeSettled,
        mergeWaived: branch.mergeWaived,
      };
      const problems = orchestratorDoneProblems(facts);
      const inheritance = formatInheritanceBrief(readInheritance(deps.env()), runtime.orchestrationId);
      const text = [
        "## 编排状态",
        formatOrchestrationStatus(facts),
        panes.ok ? "" : "（读不到 tmux pane 列表：子会话存活状态不可信，先确认还在 tmux 里）",
        "",
        "### plan",
        plan ? formatPlanSummary(plan) : "（还没有 plan）",
        "",
        "### 子会话",
        formatChildren(runtime, panes.panes),
        inheritance ? "\n" + inheritance : "",
        "",
        "### 还差什么才能 declare_done",
        problems.length ? problems.map((p) => `- ${p}`).join("\n") : "- 没有了，可以 declare_done",
      ].filter((line) => line !== "").join("\n");
      return reply(text, { problems, childCount: runtime.children.length });
    },
  });

  host.registerTool({
    name: "orchestrator_notify",
    label: "Notify The User",
    description:
      "Send a DESKTOP notification to the human (the only channel that reaches somebody who is " +
      "not watching the terminal). ONLY an orchestrator may call it, and it is throttled: " +
      "identical text is not repeated within 10 minutes and at most 5 notifications go out per " +
      "5 minutes. Use it for what actually needs a person — an irreversible decision, a blocked " +
      "plan, the run being finished — not for progress.",
    parameters: Type.Object({
      title: Type.String({ description: "Short subject line" }),
      body: Type.String({ description: "One or two sentences: what happened and what you need" }),
      decisionId: Type.Optional(Type.String({
        description: "Plan decision this notification reports — marks it as reported (constraint 11)",
      })),
    }),
    async execute(_id, params) {
      const auth = notifyAuthorization(deps.taskMode());
      if (!auth.ok) return fail("review-gate: " + auth.reason);
      const payload = prepareNotification({
        title: String(params.title ?? ""),
        body: String(params.body ?? ""),
        env: deps.env(),
      });
      const runtime = deps.runtime();
      const key = notifyKey(payload.title, payload.body);
      const now = deps.now();
      const decision = decideNotify({ history: runtime.notify, key, now });
      if (!decision.send) {
        return fail("review-gate: 通知被节流 —— " + decision.reason, { sent: false });
      }
      // The ONE side effect, and it is injected: a test run (or any
      // non-interactive host) must never put an escape sequence on a real
      // terminal. A suppressed send is NOT recorded against the throttle —
      // otherwise the first real notification would be deduplicated away.
      const emitted = deps.emitNotification(payload.sequence);
      if (!emitted) {
        return fail(
          "review-gate: 通知没有发出去 —— 当前环境不接受终端副作用（无 TTY / CI / 测试进程）。" +
          "如果确实需要用户知道，改用 `ask_user`。",
          { sent: false, protocol: payload.protocol },
        );
      }
      deps.saveRuntime({ ...runtime, notify: recordNotify(runtime.notify, key, now) });

      // Reporting a decision is what un-blocks the exit for it (constraint 11):
      // the user now HAS the question, even if they have not answered it.
      const decisionId = String(params.decisionId ?? "").trim();
      let decisionNote = "";
      if (decisionId) {
        const { plan } = currentPlan(deps);
        const target = plan?.decisions.find((d) => d.id === decisionId);
        if (plan && target) {
          deps.savePlan({
            ...plan,
            decisions: plan.decisions.map((d) =>
              d.id === decisionId ? { ...d, notifiedAt: new Date(now).toISOString() } : d,
            ),
            updatedAt: new Date(now).toISOString(),
          });
          decisionNote = `\n决策项 "${decisionId}" 已标记为「已通知用户」，不再拦 declare_done。`;
        } else {
          decisionNote = `\n注意：plan 里没有决策项 "${decisionId}"，没有标记任何东西。`;
        }
      }
      return reply(
        `review-gate: 已通过 ${payload.protocol} 向用户发出系统通知。${decisionNote}`,
        { sent: true, protocol: payload.protocol },
      );
    },
  });
}
