/**
 * MINIMALISM (ponytail) — the only substantive copy of the minimal-code
 * doctrine in this repo (2026-09-08, user decision).
 *
 * WHAT THIS IS. The four checks below are ponytail's ladder compressed into
 * the shape this gate can enforce: YAGNI, reuse-before-invent,
 * delete-before-add, and justify-every-new-dependency. They are the SINGLE
 * source: every other surface (`agents/reviewer.md`, `agents/goal-auditor.md`,
 * the goal-audit task in `lib/loop-goal.ts`, the plan-audit task in
 * `lib/orchestrator-plan-audit.ts`, the standing agent reminder in
 * `lib/agent-directives.ts`) carries a summary plus the section anchor, never
 * a second copy of the rules themselves. A second copy WILL drift — the copy
 * map (§七) is the record of how often that has happened.
 *
 * WHAT THIS IS NOT. A mechanical gate. Three of the four checks need
 * judgement (is this code really deletable? does that helper really cover
 * it?), and judgement belongs to the judges, not to a scanner. The ONE
 * mechanical half — a new dependency with no written justification — lives
 * in `lib/dependency-justification.ts`, next to the other mechanical rule
 * (`lib/file-size-gate.ts`), not here.
 */

/**
 * Section anchor — the pointer every other surface cites. A surface that
 * quotes the rules instead of citing this anchor is a second copy.
 */
export const MINIMALISM_SECTION = "docs/coding-standards.md §5";

/** The four minimalism checks, in ladder order (highest rung first). */
export const MINIMALISM_CHECKS: readonly string[] = Object.freeze([
  "YAGNI — 不存在必要就不写：推测性需求直接跳过，并用一句话说明跳过了什么。",
  "复用优先 — 先找后写：本仓库已有 helper/util/类型/模式、标准库、平台原生能力、已装依赖能覆盖的，一律复用，不重写、不新增依赖。",
  "能删就删 — 先删后加：可删的代码、可合的行、可替的抽象先处理，再写新代码；修 bug 先找根因，不在症状上叠补丁。",
  "新依赖须论证 — 每新增一个依赖都要有书面论证（为什么现有代码/已装依赖做不到），论证随改动走（送审说明或提交说明正文），缺论证的依赖在 checkpoint 被机械打回。",
]);

/**
 * The severity map each enforcement point renders for itself — the mapping
 * is part of the doctrine, the P0/P1/P2 ADJUDICATION stays with each judge
 * (goal/plan audit: only P0/P1 block; reviewer: P1 ships-not).
 */
export const MINIMALISM_SEVERITY =
  "严重度映射：写代码时只是习惯提醒（不阻塞）；审目标/审计划时，范围外工作与过度设计可出 P1；" +
  "审代码 diff 时，可删代码、新增依赖无论证、重复实现可出 P1，其余最小化意见为 P2。";
