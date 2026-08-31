/**
 * The ORCHESTRATION CONSTRAINTS — the 14 hard rules of task book §7, as pure
 * decisions.
 *
 * They live here rather than inside the tools for the usual reason: a rule
 * embedded in a tool body is a rule that is tested by running the tool, which
 * means it is not really tested at all. Every function here takes facts and
 * returns a decision, so each constraint has a unit test that names it.
 *
 * WHERE EACH CONSTRAINT LIVES (the ones not in this file are not missing —
 * they are enforced where they can be enforced mechanically):
 *
 *   1 plan approved before spawn ........ {@link spawnAuthorization}
 *   2 orchestrator writes no code ....... {@link orchestratorWriteBlock}
 *   3 unfinished tasks block exit ....... {@link orchestratorDoneProblems}
 *   4 live children block exit .......... {@link orchestratorDoneProblems}
 *   5 tasks declare file boundaries ..... lib/orchestrator-plan.ts (parse)
 *   6 same-repo tasks never parallel ... lib/orchestrator-plan.ts (schedule)
 *   7 (retired 2026-09-07: no worktree isolation — cross-repo only)
 *   8 proxied goal stays in boundary .... {@link proxyGoalProblems}
 *   9 notification single entry+throttle. {@link notifyAuthorization} + notify.ts
 *  10 (retired 2026-09-07: work-branch landing is gone)
 *  11 unreported decisions block exit ... {@link orchestratorDoneProblems}
 *  12 relay preconditions ............... lib/orchestrator-relay.ts
 *  13 children come from the tool ....... lib/orchestrator-guard.ts + registry
 *  14 (retired 2026-09-07: humanOnlyDecision was dead code — the consent
 *      model lets the project manager answer sensitive-edit dialogs too)
 *
 * Pure module: no IO, no git, no tmux.
 */

import { pathsOutsideBoundaries } from "./orchestrator-boundaries.ts";
import {
  openDecisions,
  planHash,
  unfinishedTasks,
  unreportedDecisions,
  type OrchestratorPlan,
  type PlanTask,
  type TaskExecution,
} from "./orchestrator-plan.ts";
import { liveChildren, vanishedChildren, type OrchestratorRuntime } from "./orchestrator-registry.ts";
import type { TaskMode } from "./task-mode.ts";

// ---------------------------------------------------------------------------
// Constraint 1 — nothing starts before the user approved the plan
// ---------------------------------------------------------------------------

export type Authorization = { ok: true } | { ok: false; reason: string };

/**
 * May the orchestrator spawn anything at all?
 *
 * The approval binds to the plan's CONTENT hash, so editing the plan after
 * approval silently revokes it — the same content binding the loop goal uses,
 * and for the same reason: otherwise "approved" would mean "was approved once,
 * for something else".
 */
export function spawnAuthorization(
  runtime: OrchestratorRuntime,
  plan: OrchestratorPlan | undefined,
): Authorization {
  if (!plan) {
    return {
      ok: false,
      reason:
        "还没有 plan —— 编排层的开工条件是「用户批准过的 plan」。先用 `orchestrator_plan` 写出任务清单" +
        "（每个任务都要声明文件边界），再提交给用户批准。",
    };
  }
  if (!runtime.approvedPlanHash) {
    return {
      ok: false,
      reason:
        "plan 尚未获得用户批准 —— 自己写 plan 文件不算数（与 loop goal 同一机制）。" +
        "提交批准后才能开子会话。",
    };
  }
  const current = planHash(plan);
  if (current !== runtime.approvedPlanHash) {
    return {
      ok: false,
      reason:
        "plan 在获批之后被改过（任务、边界、依赖或并行度变了），批准已失效。" +
        "把改动后的 plan 重新提交给用户批准。",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Constraint 2 — the orchestrator does not write code
// ---------------------------------------------------------------------------

/**
 * The ONLY paths an orchestrator session may write, besides the gate-owned
 * `.pi/` scope its plan lives in: its own handoff / report documents.
 *
 * Everything else — code, tests, project docs — is delegated work, because
 * the whole point of the role is that context spent editing is context not
 * spent supervising. The refusal names the alternative (spawn a child), so it
 * reads as a redirect rather than a wall.
 */
export const ORCHESTRATOR_DOC_PATTERN = /^docs\/orchestrator-[A-Za-z0-9._-]+\.md$/;

export function orchestratorWriteBlock(opts: {
  /** Repo-relative path of the write, or the absolute path when outside. */
  relPath: string;
  taskMode: TaskMode | undefined;
  /** The handoff document a relay in progress registered, if any. */
  relayHandoffPath?: string;
  /**
   * The write lands OUTSIDE the repository (F2).
   *
   * Allowed, and deliberately so. The old whitelist was hard-bound to two
   * in-repo locations, which collided head-on with the standing practice that
   * orchestration artifacts must NOT sit in the worktree — a child's
   * `git add -A` sweeps whatever is there into its checkpoint. A user who
   * asks for the run report in `/tmp` was refused for following the rule.
   *
   * The safety argument is that this permission is narrower than it looks:
   * an out-of-repo write cannot pollute the worktree, cannot enter a
   * checkpoint, and cannot reach a tracked file. Sensitive paths (.env,
   * private keys, credentials) are refused by the gate's own sensitive-file
   * floor, which runs BEFORE this check and is not weakened by it.
   */
  outsideRepo?: boolean;
}): string | undefined {
  if (opts.taskMode !== "orchestrator") return undefined;
  if (opts.outsideRepo) return undefined;
  const rel = opts.relPath.replace(/^\.\//, "");
  // The gate-owned scope (the plan itself) is exempt upstream, but repeat it
  // here so this function is honest on its own.
  if (rel.startsWith(".pi/")) return undefined;
  if (ORCHESTRATOR_DOC_PATTERN.test(rel)) return undefined;
  if (opts.relayHandoffPath && rel === opts.relayHandoffPath.replace(/^\.\//, "")) return undefined;
  return (
    `review-gate: 项目经理不写代码 —— "${rel}" 不在可写范围内。` +
    "编排会话在**仓库内**只允许写 plan（.pi/ 下）与交接/汇报文档（docs/orchestrator-*.md）；" +
    "仓库**外**的绝对路径（比如 /tmp 下的交付物）不受此限，反而是推荐做法 —— " +
    "编排产物留在工作区会被子会话的 `git add -A` 卷进 checkpoint。" +
    "改代码、解冲突、查历史这类耗上下文的活，用 `orchestrator_spawn` 开子会话去做。"
  );
}


// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constraint 8 — a goal approved on the user's behalf stays inside the task
// ---------------------------------------------------------------------------

export interface ProxyGoalVerdict {
  ok: boolean;
  /** Files the child ALREADY edited that fall outside the task's boundary. */
  outside: string[];
  reason?: string;
}

/**
 * CONSTRAINT 8, judged against the FILES THE CHILD ACTUALLY EDITED (R3-1).
 *
 * TWO PATCHES AND A THIRD FAILURE. The check used to read the goal TEXT and
 * treat every path-like token in it as "a file this task will touch". Run 2
 * refused a goal for naming `running/ended` and `slice/window` (ordinary word
 * pairs); the patch was to recognize only real-looking paths. Run 2 also
 * refused a goal for its NON-GOALS section — the paths it promised NOT to
 * touch; the patch was to skip negated lines. Run 3 then refused a
 * documentation task whose exit criteria said "可逐条对照
 * `lib/orchestrator-probe.ts`", while its non-goals swore off editing code
 * entirely. Two proxy approvals had to bypass the mechanical check.
 *
 * Every one of those is the same root cause: PROSE IS NOT A PLAN. A goal
 * mentions files for a dozen reasons — to quote them, to compare against
 * them, to promise not to touch them — and no amount of grammar tells the
 * difference from "will edit".
 *
 * So the comparison moved to the one thing that is not prose: the child's own
 * gate sidecar lists the files this session has EDITED (`sessionEditedFiles`).
 * A goal that quotes a hundred modules is fine; a child that writes into one
 * file outside its boundary is not, and the probe keeps checking this on
 * every round rather than once at approval time — which is a STRONGER
 * guarantee than the old text scan, not a weaker one: it cannot be talked
 * around by rewording, and it does not stop watching after the approval.
 */
export function proxyApprovalProblems(
  editedFiles: readonly string[],
  task: PlanTask,
): ProxyGoalVerdict {
  const edited = editedFiles.map((f) => String(f ?? "").trim()).filter(Boolean);
  const outside = pathsOutsideBoundaries(edited, task.fileBoundaries);
  if (outside.length === 0) return { ok: true, outside: [] };
  return {
    ok: false,
    outside,
    reason:
      `代批被拒（约束 8）：子会话**已经改到**了任务 "${task.id}" 边界之外的文件 —— ` +
      `${outside.slice(0, 8).join(", ")}${outside.length > 8 ? " 等" : ""}。任务边界是 ${task.fileBoundaries.join(", ")}。` +
      "这是范围变更，不是技术取舍：用 `orchestrator_notify` 通知用户，由他决定是扩边界还是让子会话回滚这些改动。" +
      "（判定依据是它 sidecar 里的实际落点 sessionEditedFiles，不是 goal 正文里出现过哪些路径 —— " +
      "改写 goal 文本不会让这条通过。）",
  };
}


// ---------------------------------------------------------------------------
// Constraint 9 — only an orchestrator may notify the human
// ---------------------------------------------------------------------------

export function notifyAuthorization(taskMode: TaskMode | undefined): Authorization {
  if (taskMode === "orchestrator") return { ok: true };
  return {
    ok: false,
    reason:
      "系统通知只有项目经理（orchestrator 模式）能发 —— 这是单一入口的全部意义：" +
      "过去任何会话都能弹横幅，结果是所有人都被打断。子会话要找人，用 `ask_user`；" +
      "要找项目经理，attention 会自动送达。",
  };
}


// ---------------------------------------------------------------------------
// Constraints 3, 4, 10, 11 — what an orchestration must settle before it ends
// ---------------------------------------------------------------------------

export interface OrchestratorDoneFacts {
  plan?: OrchestratorPlan;
  runtime: OrchestratorRuntime;
  /** Pane ids that exist RIGHT NOW (observed, never assumed). */
  alivePaneIds: readonly string[];
}

/**
 * Everything that still stands between this orchestration and `declare_done`.
 *
 * This is the ORCHESTRATION's exit contract, not a single session's: the
 * question is "is the whole job finished", which is why an unfinished plan
 * task blocks it even though this session may have done everything it
 * personally promised.
 */
export function orchestratorDoneProblems(facts: OrchestratorDoneFacts): string[] {
  const problems: string[] = [];

  // Constraint 3 — the plan is the definition of "finished".
  if (!facts.plan) {
    problems.push("没有 plan：编排会话的完成判据就是 plan 全部做完，先建立 plan（并让用户批准）");
  } else {
    const open = unfinishedTasks(facts.plan);
    if (open.length > 0) {
      problems.push(
        `plan 还有 ${open.length} 个任务未完成：` +
        open.map((t) => `${t.id}(${t.status})`).join(", ") +
        " —— 编排层的完成判据是整体任务，不是单个会话的 goal（约束 3）",
      );
    }
  }

  // Constraint 4 — a live child may still be working, or waiting on a dialog.
  const live = liveChildren(facts.runtime, facts.alivePaneIds).filter((c) => !c.doneAt);
  if (live.length > 0) {
    problems.push(
      `还有 ${live.length} 个子会话活着：` +
      live.map((c) => `${c.id}@${c.paneId}`).join(", ") +
      " —— 先等它们结束（orchestrator_wait）或关掉（orchestrator_close），再退出（约束 4）",
    );
  }
  // Not a blocker, but the orchestrator must be told: a pane that vanished on
  // its own means a child died, and its task is almost certainly not done.
  const vanished = vanishedChildren(facts.runtime, facts.alivePaneIds).filter((c) => !c.doneAt);
  if (vanished.length > 0) {
    problems.push(
      `有 ${vanished.length} 个子会话的 pane 已经消失但从未报告完成：` +
      vanished.map((c) => `${c.id}(task=${c.taskId})`).join(", ") +
      " —— 确认它们的任务状态，必要时把任务改回 pending 重开",
    );
  }

  // Constraint 11 — a question the user was never told about would vanish.
  if (facts.plan) {
    const silent = unreportedDecisions(facts.plan);
    if (silent.length > 0) {
      problems.push(
        `有 ${silent.length} 个待用户决策从未通知过用户：` +
        silent.map((d) => d.id).join(", ") +
        " —— 用 `orchestrator_notify` 告诉他，再退出（约束 11）",
      );
    }
    // R-29 — "the user was TOLD" is not "the question was SETTLED". A decision
    // that was notified and never resolved sailed all the way to wrap-up in
    // the second run, and nothing ever checked whether the answer had been
    // written back into the plan. Both halves are named here.
    const dangling = openDecisions(facts.plan).filter((d) => d.notifiedAt);
    if (dangling.length > 0) {
      problems.push(
        `有 ${dangling.length} 个决策通知过用户、但从未落定：` +
        dangling
          .map((d) => `${d.id}${d.planEffect ? `（一旦拍板需要改 plan：${d.planEffect}）` : ""}`)
          .join(", ") +
        " —— 用 `orchestrator_plan({ action: \"resolve-decision\", decisionId, answer })` 把答案写回 plan，" +
        "如果答案要求改 plan（扩边界、加任务），先改 plan 并重新获批（R-29）",
      );
    }
  }


  return problems;
}

/** Short status line for the orchestrator's own prompt / status tool. */
export function formatOrchestrationStatus(facts: OrchestratorDoneFacts): string {
  const plan = facts.plan;
  const live = liveChildren(facts.runtime, facts.alivePaneIds);
  const parts = [
    `orchestration=${facts.runtime.orchestrationId}`,
    plan
      ? `任务 ${plan.tasks.filter((t) => t.status === "done").length}/${plan.tasks.length} 完成`
      : "尚无 plan",
    `活着的子会话 ${live.filter((c) => !c.doneAt).length}`,
    plan ? `待决策 ${openDecisions(plan).length}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}
