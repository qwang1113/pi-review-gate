/**
 * Gate mode registry — the single place that says what each mode IS.
 *
 * A mode is three things, provided by the gate (never assembled by the
 * agent): the prompt section injected for it, the tools denied to it, and
 * the enforcement label describing how strictly the gate holds it. Session
 * modes (loop/explore/normal/orchestrator) keep their existing engine in
 * lib/task-mode.ts — this registry DESCRIBES them (labels must match the
 * guards; tests pin the alignment) and OWNS the static prompt sections the
 * per-turn injection used to inline. Internal modes (review/plan/goal) are
 * placed only by the gate onto spawned judge panes; an agent can never pick
 * them (set_gate_mode rejects them, and the judge deny-list below refuses
 * set_gate_mode itself, so a pane cannot reclassify either).
 *
 * Entries: the four session modes + undecided (a real prompt-bearing state —
 * the classification directive — whose enforcement behaves as loop) + the
 * three internal reporting-shell modes. plan/goal are the two task templates
 * of the goal-auditor role: they share the reporting-shell tool policy and
 * completion discipline and differ only in framing. review covers the
 * reviewer/adviser/arbiter roles, whose role-specific bodies stay in
 * agents/<role>.md — this entry owns only the shared shell discipline.
 */

import type { TaskMode } from "./task-mode.ts";
import { GATE_MODE_DECISION_DIRECTIVE } from "./task-mode.ts";
import { buildAgentDirectives } from "./agent-directives.ts";
import { ORCHESTRATOR_DIRECTIVE } from "./orchestrator-directives.ts";

/** Every mode the gate can place a session in. */
export type GateMode =
  | "undecided"
  | "loop"
  | "explore"
  | "normal"
  | "orchestrator"
  | "review"
  | "plan"
  | "goal";

/** How strictly the gate holds a mode. A label, not a switch: the guards
 *  (isEnforcedMode, L1/L8) keep their own implementation; tests assert the
 *  label matches the guard for every session mode. */
export type ModeEnforcement = "full" | "advisory" | "off";

export interface ModeSpec {
  /** Static prompt section for the mode; dynamic content (goal body, unmet
   *  list, orchestration state) is still assembled at the call site. */
  prompt: string;
  enforcement: ModeEnforcement;
  /** True ⇒ set_gate_mode refuses it; only the gate places it. */
  internalOnly: boolean;
  /** Tools denied in this mode (empty = no registry-level deny). */
  deniedTools: ReadonlySet<string>;
}

/**
 * Tools a reporting-shell session must never run. A judge reviews, it does
 * not open sub-reviews, manage orchestrations, negotiate goals, or finish
 * tasks. `ask_user` is deliberately ABSENT — questions are the one thing a
 * judge must ask, and they race through the channel.
 *
 * Every name here must be a tool that EXISTS somewhere (a deny entry for a
 * deleted tool is a claim about a surface nobody has) — `judge_read` left this
 * list when it left the codebase, 2026-09-05.
 *
 * `request_arbitration` IS ALLOWED, and it is the one entry that had to be
 * REMOVED from this list (2026-09-05). The judge-side inspection gate
 * (lib/judge-inspection.ts) refuses a zero-inspection READY on purpose-strict
 * terms, so it will sometimes refuse a legitimate round; denying the appeal
 * tool as well would leave that judge with no move except pretending to read
 * something. It grants a judge nothing else: the appeal can only authorize its
 * OWN round's conclusion (lib/inspection-appeal.ts), never a ship command.
 *
 * Single source: lib/judge-side.ts re-exports this set (no second copy).
 */
export const JUDGE_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "judge_submit", "judge_spawn", "judge_answer", "judge_recover", "judge_close", "judge_wait",

  "orchestrator_spawn", "orchestrator_instruct", "orchestrator_wait", "orchestrator_close",
  "orchestrator_handoff", "orchestrator_plan", "orchestrator_notify", "orchestrator_answer",
  "orchestrator_recover", "orchestrator_attach",
  // `propose_restatement` sits with `propose_loop_goal` for the same reason:
  // a reporting shell does not negotiate the requirement it was asked to
  // judge — it reviews a change against a contract somebody else agreed.
  "propose_loop_goal", "propose_restatement", "request_copilot_review", "check_copilot_review",
  "request_scope_limit", "request_sensitive_edit", "set_gate_mode", "declare_done",
]);

/** Why this tool is refused in a reporting-shell session, or undefined when allowed. */
export function judgeDeniedReason(toolName: string): string | undefined {
  if (!JUDGE_DENIED_TOOLS.has(toolName)) return undefined;
  return `review-gate: ${toolName} 在 review 会话里不可用——review 只负责评审（heartbeat 上报、答 opener 的问题、落 report），不开子 review、不管编排、不收尾任务。`;
}

/**
 * How a reporting shell finishes: conclude through the tool, then stop. No process exit
 * (the pane is reused for the next round); questions go through ask_user (human and
 * opener race, whoever answers first wins), never through prose the gate would have
 * to scrape back.
 */
export const JUDGE_COMPLETION_DISCIPLINE =
  "完成(必须):调 judge_conclude 交卷并停下即可——verdict/findings/cwd 一次给齐,一轮只能交一次," +
  "重复调用会被拒绝;不需要退出进程(pane 留给下一轮复用)。**交卷即停**:调完就结束本轮," +
  "不写复述、不写自评、不写过程说明——正文不被消费,结论只写正文等于没交卷。\n" +
  "提问:有疑问时调 ask_user,人和 opener 谁先答谁生效;等答案时停下,不要自行假定。";

const NO_DENY: ReadonlySet<string> = Object.freeze(new Set<string>());

const LOOP_FLOW_TAIL = "改完一个单元就 `judge_submit`，别攒到最后；全绿了还有 copilot 周期和 `declare_done` 收尾。";

const EXPLORE_WORKFLOW =
  "## Explore 工作流（调查/排查）\n" +
  "这是调查/排查任务，不是交付循环：优先只读工作 —— 查看、运行诊断/只读命令、推理；" +
  "除非调查确实需要，否则避免改文件（例如临时探针）。" +
  "本模式下门禁（review/precommit）为 advisory（建议性），自动续跑已禁用，" +
  "任务满意完成即可自行 `declare_done` —— 由你判断何时算完成。" +
  "ship 命令（git commit/push、gh pr）仍被完全拦截；" +
  "若任务变成交付性工作，先 `set_gate_mode(\"loop\")` 升级到完整门禁循环（立即生效），再开始改代码。";

const NORMAL_STATEMENT =
  "## Normal 模式（门禁关闭）\n" +
  "本会话门禁不生效：无流程注入、无 review 循环、无自动续跑，ship 命令不拦截。" +
  "输出语言要求与敏感文件保护仍在（用户政策与安全底线，非工作流）。";

const REVIEW_SHELL_FRAME =
  "## Reporting-shell 纪律（review 模式：reviewer / adviser / arbiter 共用）\n" +
  "你是只读评审壳：评审当前轮的材料、边确认边把 findings 写入 findings 流、" +
  "调 judge_conclude 交卷。角色专属口径见你的任务文本；下面是所有评审共用的完成纪律。";

const GOAL_AUDIT_FRAME =
  "## Reporting-shell 纪律（goal 模式：goal-auditor 的 goal 审计任务模板）\n" +
  "你审计的是 loop goal 草稿：只有 P0/P1 能阻塞，其余 findings 只记不拦。" +
  "审计结论只认 judge_conclude 交卷；草稿正文的问题以交卷结论 + findings 为准。";

const PLAN_AUDIT_FRAME =
  "## Reporting-shell 纪律（plan 模式：goal-auditor 的 plan 审计任务模板）\n" +
  "你审计的是编排 plan：只有 P0/P1 能阻塞。plan 与 goal 的审计结论互不通用，" +
  "各轮结论带上轮 carryover（门禁在任务文本里给出），只审增量、不重推已结算项。";

export const MODE_REGISTRY: Readonly<Record<GateMode, ModeSpec>> = Object.freeze({
  undecided: {
    prompt: GATE_MODE_DECISION_DIRECTIVE,
    enforcement: "full",
    internalOnly: true,
    deniedTools: NO_DENY,
  },
  loop: {
    prompt: `${buildAgentDirectives()}\n${LOOP_FLOW_TAIL}`,
    enforcement: "full",
    internalOnly: false,
    deniedTools: NO_DENY,
  },
  explore: {
    prompt: `${EXPLORE_WORKFLOW}\n\n${buildAgentDirectives("explore")}`,
    enforcement: "advisory",
    internalOnly: false,
    deniedTools: NO_DENY,
  },
  normal: {
    prompt: NORMAL_STATEMENT,
    enforcement: "off",
    internalOnly: false,
    deniedTools: NO_DENY,
  },
  orchestrator: {
    prompt: ORCHESTRATOR_DIRECTIVE,
    enforcement: "full",
    internalOnly: false,
    deniedTools: NO_DENY,
  },
  review: {
    prompt: `${REVIEW_SHELL_FRAME}\n${JUDGE_COMPLETION_DISCIPLINE}`,
    enforcement: "full",
    internalOnly: true,
    deniedTools: JUDGE_DENIED_TOOLS,
  },
  plan: {
    prompt: `${PLAN_AUDIT_FRAME}\n${JUDGE_COMPLETION_DISCIPLINE}`,
    enforcement: "full",
    internalOnly: true,
    deniedTools: JUDGE_DENIED_TOOLS,
  },
  goal: {
    prompt: `${GOAL_AUDIT_FRAME}\n${JUDGE_COMPLETION_DISCIPLINE}`,
    enforcement: "full",
    internalOnly: true,
    deniedTools: JUDGE_DENIED_TOOLS,
  },
});

/** All eight registry keys, for iteration and tests. */
export const GATE_MODES: ReadonlyArray<GateMode> = Object.freeze(
  ["undecided", "loop", "explore", "normal", "orchestrator", "review", "plan", "goal"] as const,
);

export type JudgeKind = "goal" | "plan";

/**
 * Derive the registry key from the two facts the gate already stores: the
 * judge role (stamped into a spawned pane's env) and the session task mode.
 * Unknown judge roles fall back to loop (fail-closed, same rule as
 * normalizeTaskMode). `kind` selects the goal-auditor's task template and is
 * known only opener-side at dispatch; a pane resolving without it lands on
 * goal, whose tool policy and completion discipline are identical to plan's.
 */
export function resolveGateMode(input: {
  taskMode?: TaskMode | undefined;
  judgeRole?: string | undefined;
  kind?: JudgeKind | undefined;
}): GateMode {
  const role = (input.judgeRole ?? "").trim().toLowerCase();
  if (role === "reviewer" || role === "adviser" || role === "arbiter") return "review";
  if (role === "goal-auditor") return input.kind === "plan" ? "plan" : "goal";
  if (role !== "") return "loop";
  return input.taskMode ?? "undecided";
}
