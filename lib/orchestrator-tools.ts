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
  nextDecisionId,
  parsePlan,

  planHash,
  PLAN_RELPATH,
  type OrchestratorPlan,
  type TaskStatus,
} from "./orchestrator-plan.ts";
import {
  formatOrchestrationStatus,
  notifyAuthorization,
  orchestratorDoneProblems,
} from "./orchestrator-gate.ts";
import { formatChildren } from "./orchestrator-registry.ts";
import { formatChildHealth } from "./orchestrator-child-state.ts";

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

/** Told to the user when the dialog body had to be cut (O-1). */
export const PLAN_DIALOG_POINTER = "（plan 全文见上方消息，请先读完再决定）";

/**
 * The FULL plan, printed to the transcript before the dialog opens (O-1).
 *
 * This is the text the approval actually binds to, so it is the text the user
 * has to be able to read. It also names the file, because a plan long enough
 * to scroll off the screen is exactly the case where "go read it yourself"
 * has to be actionable.
 */
export function buildPlanTranscriptMessage(plan: OrchestratorPlan): string {
  return (
    "任务计划全文（不可信数据）——批准前请读完：\n" +
    "───────────────────────\n" +
    formatPlanSummary(plan) +
    "\n───────────────────────\n" +
    "同样的内容也在 `" + PLAN_RELPATH + "`（可随时自己去看）。\n" +
    "批准的是**内容**：任务、文件边界、依赖、并行度中任何一项被改动，批准即失效。"
  );
}

/**
 * Dialog body — the DECISION only.
 *
 * The plan itself was just printed by {@link buildPlanTranscriptMessage}, and
 * repeating it here is what produced the truncated, unreadable dialog O-1
 * filed. The fixed copy explaining what approval grants comes first, because
 * the dialog fitter truncates from the tail.
 */
export function buildPlanConfirmMessage(plan: OrchestratorPlan): string {
  return (
    "plan 全文（不可信数据）已显示在上方消息中，请先读完再决定。\n" +
    "批准后，项目经理才能按这份 plan 开子会话干活。批准的是**内容**：" +
    "任务、文件边界、依赖、并行度中任何一项被改动，批准即失效，需要重新批准。\n" +
    `标题（不可信数据）：${plan.title.slice(0, 80)}\n` +
    `规模：${plan.tasks.length} 个任务，并行上限 ${plan.maxParallel}`
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
      `review-gate: plan 已写入 ${PLAN_RELPATH}。\n` +
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
    // O-1 — the FULL plan goes to the transcript first, and the dialog then
    // points at it. A plan approval binds to CONTENT (tasks, boundaries,
    // dependencies, parallelism), and the dialog body is capped at a couple
    // of dozen rendered rows: the measured result was a user being asked to
    // sign a six-task plan whose last four tasks had been cut off, with
    // nothing telling them where to read the rest. The loop goal has done it
    // this way from the start (buildGoalTranscriptMessage → dialog + pointer).
    deps.showToUser(PLAN_CONFIRM_TITLE, buildPlanTranscriptMessage(plan));
    const granted = await deps.confirm(
      PLAN_CONFIRM_TITLE,
      buildPlanConfirmMessage(plan),
      PLAN_DIALOG_POINTER,
    );

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
    const question = String(params.question ?? "").trim();
    if (!question) return fail("review-gate: add-decision 需要 question（要让用户拍板的到底是什么）。");
    // F5 — the GATE mints the id. Asking the caller to invent one was busywork
    // with a failure mode: a collision was reported as an error the agent then
    // had to work around, and an id it chose carried no meaning anyway. The
    // format stays readable (d1, d2, …) because the user sees it in a
    // notification and in `orchestrator_status`.
    const id = nextDecisionId(plan);
    // R-29 — record, at registration time, what the plan will have to become
    // once this is answered. Without it "the plan does not reflect what the
    // user decided" is invisible: the second run notified a decision, got an
    // answer, and only discovered at wrap-up that nothing had been written
    // back.
    const planEffect = String(params.planEffect ?? "").trim();
    const next = {
      ...plan,
      decisions: [...plan.decisions, { id, question, ...(planEffect ? { planEffect } : {}) }],
      updatedAt: nowIso,
    };
    deps.savePlan(next);
    return reply(
      `review-gate: 已登记待用户决策 "${id}"（id 由门禁生成）。` +
      "注意：**没通知过用户的决策项会拦住 declare_done**（约束 11），" +
      "**通知过但从未 resolve 的也会拦**（R-29）——" +
      `先用 \`orchestrator_notify({ decisionId: "${id}", … })\` 告诉他，` +
      `拿到答复后用 \`orchestrator_plan({ action: "resolve-decision", decisionId: "${id}", answer })\` 落回 plan。` +
      (planEffect ? `\n已记下这条决策一旦拍板需要的 plan 变更：${planEffect}` : ""),
      { decisionId: id, planEffect: planEffect || undefined },
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

/** Register `orchestrator_plan` and `orchestrator_notify`. */
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
      decisionId: Type.Optional(Type.String({
        description: "For action=\"resolve-decision\" (add-decision mints its own id)",
      })),

      question: Type.Optional(Type.String({ description: "For action=\"add-decision\"" })),
      planEffect: Type.Optional(Type.String({
        description:
          "For action=\"add-decision\": what the PLAN must become once this is answered " +
          "(e.g. \"若用户选 B，任务 t3 的边界要加 scripts/\"). Shown until the decision is resolved.",
      })),
      answer: Type.Optional(Type.String({ description: "For action=\"resolve-decision\"" })),

    }),
    async execute(_id, params) {
      const refusal = requireOrchestratorMode(deps);
      if (refusal) return refusal;
      return handlePlanAction(deps, params);
    },
  });

  // THERE IS NO `orchestrator_status` (2026-08-30). Everything it printed —
  // the plan, the children, what a handoff left behind, and what still blocks
  // `declare_done` — is now blocks 1–5 of the `orchestrator_wait` receipt,
  // reachable with `timeoutMs: 0` when an instant snapshot is what is wanted.
  // Two tools answering "how are things" is philosophy two's exact failure
  // mode: the agent has to pick, and the one it picks is the one that happens
  // to be shorter to type.


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
