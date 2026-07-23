/**
 * Fast, deterministic task-mode decision for the first prompt in a session.
 *
 * When the prompt carries a clear signal the extension auto-selects the mode
 * and only notifies the user (who can override with /gate-mode). Every other
 * case asks the user; a cancelled or unavailable choice falls back to the
 * safer loop workflow.
 *
 * MODES
 *  - "loop":    the full enforced workflow — review READY + precommit PASS
 *               gate every ship, and auto-continuation keeps the agent in the
 *               fix→review loop until gates pass.
 *  - "explore": investigation/troubleshooting workflow. The ONLY essential
 *               difference from loop: the agent may end the task on its own
 *               judgment (declare_done always accepted, no auto-continuation).
 *               Edits and bash stay available — the system prompt merely asks
 *               the agent to prefer read-only work — and agent-initiated ship
 *               commands (git commit/push, gh pr) remain FULLY gated by L1.
 *
 * SECURITY — two independent layers keep a heuristic misfire from weakening
 * the gate:
 *  1. The explore branch is strictly conservative: an analysis hint alone is
 *     NOT enough — the prompt must also be free of every known mutation/ship
 *     verb (MUTATION_GUARDS). Any doubt falls back to asking the user, and
 *     the loop workflow remains the fail-closed default.
 *  2. No verb list can be complete, so an AUTO-selected explore never
 *     downgrades the git pre-commit hook: the sidecar records
 *     taskModeSource, and hooks/pre-commit treats explore as advisory only
 *     when the USER explicitly chose it (dialog or /gate-mode). In-session,
 *     explore never weakens the L1 ship gate at all (any source), so an
 *     auto-misfire only relaxes auto-continuation — the safe direction.
 */

export type TaskMode = "loop" | "explore";

/** Normalize a persisted task-mode value; undefined for unknown/forged input. */
export function normalizeTaskMode(value: unknown): TaskMode | undefined {
  if (value === "loop" || value === "explore") return value;
  return undefined;
}

/** Who decided the mode. Only "user" may downgrade the git hook to advisory. */
export type TaskModeSource = "auto" | "user";

export interface TaskModeSuggestion {
  mode: TaskMode;
  /** true → auto-decide without asking; false → ask the user. */
  confident: boolean;
}

const LOOP_HINTS: readonly RegExp[] = Object.freeze([
  /\b(fix|implement|add|change|update|refactor|migrate|upgrade|remove|rename|build|create|write|patch|debug)\b/i,
  /(修复|实现|新增|添加|修改|更新|重构|迁移|升级|删除|移除|改名|创建|编写|开发|调试|解决)/,
]);

const EXPLORE_HINTS: readonly RegExp[] = Object.freeze([
  /\b(explain|analy[sz]e|inspect|investigate|review|audit|summari[sz]e|compare|find|search|read|understand|why|what|how)\b/i,
  /(解释|分析|查看|检查|调查|审阅|评审|总结|比较|对比|查找|搜索|阅读|理解|排查|为什么|是什么|怎么|如何)/,
]);

/**
 * Mutation/ship verbs that are NOT in LOOP_HINTS but still rule out a
 * confident explore auto-selection ("review this and commit it" must not
 * silently downgrade the gate). Matching one of these without a loop hint
 * yields an unconfident suggestion — the user decides.
 */
const MUTATION_GUARDS: readonly RegExp[] = Object.freeze([
  // Stem-matched (\w* suffix) so inflections like "merging"/"committed" are
  // caught. Over-matching is safe here: a guard hit only demotes confidence to
  // "ask the user", never auto-selects a mode. This list is best-effort by
  // design — the taskModeSource layer (see header) covers whatever it misses.
  /\b(commit|push|merg|deploy|releas|publish|ship|submit|upload|sav|stor|sync|copy|copi|mov|append|open|appl|revert|rebas|cherry-?pick|stag|install|uninstall|execut|run|launch|restart|generat|configur|edit|modif|delet)\w*/i,
  /(提交|推送|合并|部署|发布|上线|上传|同步|追加|复制|拷贝|移动|保存|写入|落盘|应用|回滚|重置|安装|卸载|执行|运行|启动|重启|生成|配置)/,
  // Verification verbs/phrases: explore COULD run tests (bash is available),
  // but "review the changes and verify the tests pass" signals delivery-
  // validation intent that belongs to the enforced loop, so we conservatively
  // keep asking the user rather than auto-selecting explore. Nouns like a
  // bare "test" stay unguarded so "explain why this test fails" remains a
  // confident explore. A hit only demotes confidence to "ask the user" —
  // over-asking is the safe direction.
  // ("run"/"execute" stems are already guarded by the pattern above.)
  /\b(verif|lint|typecheck|type-check|compil|benchmark|retest|rerun|re-run)\w*/i,
  /\btests?\s+(still\s+)?pass\b/i,
  /(验证|校验|跑测试|运行测试|测试通过|编译|构建)/,
]);

export function suggestTaskMode(prompt: string): TaskModeSuggestion {
  const loop = LOOP_HINTS.some((pattern) => pattern.test(prompt));
  // Write intent wins even when mixed with analysis wording ("review and fix").
  if (loop) return { mode: "loop", confident: true };
  const explore = EXPLORE_HINTS.some((pattern) => pattern.test(prompt));
  const mutation = MUTATION_GUARDS.some((pattern) => pattern.test(prompt));
  // Confident explore requires an analysis hint AND zero mutation signals.
  if (explore && !mutation) return { mode: "explore", confident: true };
  // Mixed or no signal → ask the user; loop stays the safe default.
  return { mode: "loop", confident: false };
}

// ---------------------------------------------------------------------------
// Full first-prompt decision flow (pure, unit-testable — the extension injects
// the actual ctx.ui.select).

export type TaskModeDecisionVia = "auto" | "llm" | "dialog" | "dialog-cancelled" | "no-ui";

export interface TaskModeDecision {
  mode: TaskMode;
  via: TaskModeDecisionVia;
  /** "user" only for an explicit dialog choice; everything else is "auto". */
  source: TaskModeSource;
}

export const TASK_MODE_CHOICE_TITLE = "无法自动判断任务类型——这是循环任务吗？";
export const TASK_MODE_CHOICE_LOOP = "是 — 循环任务（多轮 review + precommit + gate）";
export const TASK_MODE_CHOICE_EXPLORE = "否 — 探查任务（gate 仅供参考，AI 可主动结束）";

export async function decideTaskMode(opts: {
  prompt: string;
  hasUI: boolean;
  select: (title: string, options: string[]) => Promise<string | undefined>;
  /**
   * Optional semantic classifier (DeepSeek V4 Flash — see lib/llm-classify.ts).
   * Consulted for EVERY prompt before the regex heuristic: it judges intent
   * semantically, so quoted logs/notifications don't pollute the decision the
   * way regex word-matching does. Returns undefined on timeout/parse failure.
   *
   * SECURITY: the LLM decision keeps source:"auto", so even an explore
   * misclassification (prompt-injected or organic) cannot downgrade the git
   * pre-commit hook — and in-session explore keeps the L1 ship gate fully
   * enforced, so a misfire only relaxes auto-continuation (the safe
   * direction). On classifier failure the flow falls back to the regex +
   * dialog path unchanged (fail-back).
   */
  classify?: (prompt: string) => Promise<"loop" | "explore" | undefined>;
}): Promise<TaskModeDecision> {
  if (!opts.hasUI) {
    // Print/JSON mode cannot display a choice. Fail closed into the loop
    // workflow rather than silently weakening the gate.
    return { mode: "loop", via: "no-ui", source: "auto" };
  }
  if (opts.classify) {
    const llmMode = await opts.classify(opts.prompt);
    if (llmMode !== undefined) return { mode: llmMode, via: "llm", source: "auto" };
    // fall through: classifier unavailable → regex heuristic + dialog
  }
  const suggested = suggestTaskMode(opts.prompt);
  if (suggested.confident) return { mode: suggested.mode, via: "auto", source: "auto" };
  const choice = await opts.select(TASK_MODE_CHOICE_TITLE, [
    TASK_MODE_CHOICE_LOOP,
    TASK_MODE_CHOICE_EXPLORE,
  ]);
  if (choice === TASK_MODE_CHOICE_EXPLORE) return { mode: "explore", via: "dialog", source: "user" };
  if (choice === TASK_MODE_CHOICE_LOOP) return { mode: "loop", via: "dialog", source: "user" };
  // Cancelling the dialog keeps the safer loop behavior.
  return { mode: "loop", via: "dialog-cancelled", source: "auto" };
}
