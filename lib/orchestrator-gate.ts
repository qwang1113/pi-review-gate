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
 *   6 overlapping tasks never parallel .. lib/orchestrator-plan.ts (schedule)
 *   7 parallel ⇒ own worktree ........... {@link worktreeRequirement}
 *   8 proxied goal stays in boundary .... {@link proxyGoalProblems}
 *   9 notification single entry+throttle. {@link notifyAuthorization} + notify.ts
 *  10 work branch merged or waived ...... {@link orchestratorDoneProblems}
 *  11 unreported decisions block exit ... {@link orchestratorDoneProblems}
 *  12 relay preconditions ............... lib/orchestrator-relay.ts
 *  13 children come from the tool ....... lib/orchestrator-guard.ts + registry
 *  14 human-only decisions not proxied .. {@link humanOnlyDecision}
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
// Constraint 7 — parallel work needs its own worktree
// ---------------------------------------------------------------------------

/**
 * Does this child need an isolated worktree?
 *
 * Only a child that will run ALONGSIDE another: two agents editing one
 * worktree invalidate each other's review bindings and race on every file.
 *
 * WHY A SERIAL CHILD SHARING THE ORCHESTRATOR'S WORKTREE IS SAFE (F9/O-2,
 * settled with the user on 2026-08-29 — this is the argument that decision
 * rests on, so it is written down rather than assumed).
 *
 *  1. ONE WRITER AT A TIME. "Serial" is enforced upstream by the scheduler
 *     (constraint 6 + `maxParallel`), not merely intended: a second child is
 *     not spawned while the first one's pane is alive. Two writers never
 *     coexist in the shared worktree, so the file-level races and the
 *     review-binding invalidation that motivate constraint 7 cannot occur.
 *  2. THE SUPERVISOR IS NOT A WRITER. Constraint 2 refuses every code write
 *     from an orchestrator session ({@link orchestratorWriteBlock}), so the
 *     one process that is ALWAYS present alongside the child contributes no
 *     edits at all.
 *  3. THE ONE THING THEY DID SHARE IS NOW SPLIT. The remaining coupling was
 *     the gate sidecar — one file per worktree, with a single-valued
 *     `taskMode` and a single `askUser` record, which the two sessions
 *     overwrote for each other (F4). Since this round each child is started
 *     with its own `RG_STATE_VARIANT` and therefore its own
 *     `.pi/review-gate-state.<variant>.json` (lib/gate-state.ts), so there is
 *     no shared mutable state left between supervisor and worker — nor
 *     between two serial children.
 *
 * The alternative (a worktree per serial child) was considered and rejected
 * BY THE USER for a concrete reason: a child's `declare_done` merges its work
 * branch into the base, and git refuses to check out a branch that another
 * worktree already holds — so isolating serial children would break the exact
 * step they exist to reach.
 */

export function worktreeRequirement(execution: TaskExecution): { needed: boolean; reason: string } {
  return execution === "parallel"
    ? { needed: true, reason: "并行任务必须各自独立 worktree（约束 7）：同一 worktree 里两个写者会互相打断 review 绑定" }
    : { needed: false, reason: "串行任务在主 worktree 里跑即可" };
}

// ---------------------------------------------------------------------------
// Constraint 8 — a goal approved on the user's behalf stays inside the task
// ---------------------------------------------------------------------------

/**
 * File extensions that make a token unambiguously a PATH.
 *
 * Kept as a closed list rather than "anything after a dot", because the whole
 * problem R-6 documents is over-eager recognition: `v1.2`, `等等.` and
 * `README.` are not files.
 */
const PATH_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "yml", "yaml",
  "toml", "sh", "bash", "zsh", "py", "go", "rs", "java", "rb", "css", "scss",
  "html", "sql", "txt", "lock", "cjs", "env", "cfg", "ini", "xml", "svg",
]);

/**
 * Sentences that are declaring what will NOT be touched.
 *
 * A goal that spells out its non-goals is following this repository's own
 * advice, and R-6 measured exactly that being punished: "非目标：不修改
 * `extensions/` 与 `lib/`" made the proxy-approval FAIL for naming paths
 * outside the task — the very paths it promised not to touch.
 */
const NEGATION_LINE = /(非目标|不改|不碰|不修改|不动|不涉及|不新增|不删除|不要改|禁止修改|out of scope|non-?goals?)/i;

/**
 * Path-like tokens inside free text.
 *
 * THE BUG THIS REPLACES (R-6, three reproductions): the old extractor treated
 * ANY token containing a slash as a path, so a goal was refused for naming
 * `running/ended`, `slice/window` and `windowIn/windowOf` — three ordinary
 * English word pairs. The orchestrator's only way through was to rewrite the
 * child's goal text, which is how the hand-copied-text hole (R-7) came to be
 * used in the first place.
 *
 * So a token now counts as a path only when it is one of:
 *
 *  - a name with a known source extension (`lib/foo.ts`, `README.md`);
 *  - an explicit directory (`test/`, `lib/**`);
 *  - a path whose first segment is a root the TASK ITSELF declared — which is
 *    the only way to recognize an extension-less path without guessing.
 *
 * Lines that are declaring NON-GOALS are skipped entirely.
 */
export function extractPathLikeTokens(text: string, knownRoots: readonly string[] = []): string[] {
  const roots = new Set(
    knownRoots
      .map((b) => String(b ?? "").replace(/^\.\//, "").split("/")[0])
      .filter((r): r is string => Boolean(r) && r !== "."),
  );
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (NEGATION_LINE.test(line)) continue;
    const tokens = line.split(/[\s,;:()[\]{}"'`、，。；：]+/).filter(Boolean);
    for (const raw of tokens) {
      const token = raw.replace(/^[<(]+|[>).,]+$/g, "");
      if (!token) continue;
      if (/^[a-z]+:\/\//i.test(token)) continue;      // URL
      if (token.startsWith("-")) continue;            // a flag
      if (token.startsWith("/")) continue;            // absolute: not a repo path
      if (!/^[A-Za-z0-9._*/-]+$/.test(token)) continue;
      const cleaned = token.replace(/\/\*\*?$/, "/");
      const last = cleaned.split("/").filter(Boolean).pop() ?? "";
      const dot = last.lastIndexOf(".");
      const extension = dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
      const hasKnownExtension = PATH_EXTENSIONS.has(extension);
      const isExplicitDirectory = cleaned.endsWith("/");
      const firstSegment = cleaned.split("/")[0] ?? "";
      const startsAtDeclaredRoot = cleaned.includes("/") && roots.has(firstSegment);
      if (!hasKnownExtension && !isExplicitDirectory && !startsAtDeclaredRoot) continue;
      const normalized = cleaned.replace(/\/$/, "");
      if (normalized) out.push(normalized);
    }
  }
  return [...new Set(out)];
}

export interface ProxyGoalVerdict {
  ok: boolean;
  /** Paths named by the goal that fall outside the task's declared boundary. */
  outside: string[];
  reason?: string;
}

/**
 * CONSTRAINT 8 — the orchestrator may approve a child's loop goal on the
 * user's behalf, but only while that goal stays inside the task it spawned
 * the child for. A goal that reaches outside is not a judgement call the
 * orchestrator is allowed to make: it is a scope change, and scope belongs to
 * the human.
 *
 * `goalText` is the draft read from the CHILD'S OWN SIDECAR, never a text the
 * caller typed — see `approveChildGoal` in lib/orchestrator-dispatch.ts for
 * why that distinction is the whole guarantee (R-7).
 */
export function proxyGoalProblems(goalText: string, task: PlanTask): ProxyGoalVerdict {
  const named = extractPathLikeTokens(goalText, task.fileBoundaries);
  const outside = pathsOutsideBoundaries(named, task.fileBoundaries);
  if (outside.length === 0) return { ok: true, outside: [] };
  return {
    ok: false,
    outside,
    reason:
      `代批被拒（约束 8）：子会话的 goal 提到了任务 "${task.id}" 边界之外的路径 —— ` +
      `${outside.slice(0, 8).join(", ")}。任务边界是 ${task.fileBoundaries.join(", ")}。` +
      "这是范围变更，不是技术取舍：用 `orchestrator_notify` 通知用户，由他决定是扩边界还是缩 goal。" +
      "（注意：门禁比对的是子会话 sidecar 里的真实草稿，改写你手上的副本没有任何作用。）",
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
// Constraint 14 — some decisions may never be answered on the user's behalf
// ---------------------------------------------------------------------------

export type HumanOnlyDecision = "discard-worktree" | "sensitive-file" | "merge-waiver";

const HUMAN_ONLY_REASONS: Readonly<Record<HumanOnlyDecision, string>> = Object.freeze({
  "discard-worktree":
    "丢弃工作区是不可逆的（别人的改动可能就此消失），必须真人确认 —— 项目经理不得代答。",
  "sensitive-file":
    "敏感文件（.env / 私钥 / 凭据）授权必须真人确认 —— 项目经理不得代答。",
  "merge-waiver":
    "「本次不合并工作分支」要留档给真人确认 —— 项目经理不得代答。",
});

/**
 * The decisions an orchestrator must escalate rather than answer.
 *
 * The boundary the user drew: technical trade-offs, `/gate-bypass` and
 * proxy-approving a child's goal (inside its task boundary) are the
 * orchestrator's to make, on the record. Anything IRREVERSIBLE or
 * security-relevant is the human's, full stop.
 */
export function humanOnlyDecision(kind: string): string | undefined {
  return HUMAN_ONLY_REASONS[kind as HumanOnlyDecision];
}

// ---------------------------------------------------------------------------
// Constraints 3, 4, 10, 11 — what an orchestration must settle before it ends
// ---------------------------------------------------------------------------

export interface OrchestratorDoneFacts {
  plan?: OrchestratorPlan;
  runtime: OrchestratorRuntime;
  /** Pane ids that exist RIGHT NOW (observed, never assumed). */
  alivePaneIds: readonly string[];
  /** Work branch state, from the gate's own branch log. */
  workBranch?: string;
  baseBranch?: string;
  /**
   * The work branch's landing is SETTLED: a base branch is on record and no
   * merge conflict is outstanding, so `declare_done`'s own merge step will
   * run it home.
   *
   * Deliberately not "already merged": the gate merges INSIDE declare_done,
   * after these checks, so demanding a completed merge here could never be
   * satisfied — it would deadlock the exit it is meant to guard.
   */
  mergeSettled: boolean;
  /** The user waived the merge on the record. */
  mergeWaived: boolean;
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


  // Constraint 10 — the work has to land somewhere, or the decision not to
  // land it has to be on the record.
  if (facts.workBranch && !facts.mergeSettled && !facts.mergeWaived) {
    problems.push(
      `工作分支 ${facts.workBranch} 的归宿没有落定（基准分支未记录，或有未解决的合并冲突：` +
      `${facts.baseBranch ?? "基准未记录"}）—— 解决冲突或补上基准，` +
      "或者用 declare_done({ waiveMerge: \"<理由>\" }) 让用户确认本次不合并（约束 10）",
    );
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
