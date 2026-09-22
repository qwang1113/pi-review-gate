/**
 * THE FIVE STAGES — the loop's own on/off switches, owned by the USER.
 *
 * WHAT THIS IS. A loop session runs five things the gate used to consider
 * mandatory: negotiating the goal (with its requirement restatement), the
 * functional `reviewer`, the `quality-auditor`, the real `acceptance` round,
 * and the full precommit lane. This module turns them into a checklist the
 * gate itself shows the user — ONE fixed five-item dialog, all five ticked by
 * default, so "press Enter" is exactly today's behaviour.
 *
 * WHY IT IS A MODULE AND NOT FIVE FLAGS. The user's decision (2026-09-22) is
 * that the CHOICE is the gate's: the agent says only "ask them", and the box's
 * copy, its default, the record and the release are all decided here. A second
 * place that answers "is this stage on?" is how "the stage is off" and "the
 * stage still blocks" end up disagreeing, so {@link stageOpen} is the ONE
 * query — every checkpoint calls it, and nothing re-derives it.
 *
 * WHAT AN OFF STAGE MEANS: the gate releases every stop of that stage and does
 * not run its work — no goal audit / approval dialog / restatement requirement,
 * no reviewer dispatch (the review checkpoint counts as met), no quality
 * round, no acceptance round, no precommit lane or PASS prerequisite. The five
 * switches are INDEPENDENT: any combination is legal, and an empty submission
 * (every box cleared) is a legal "all five off", not a missing answer.
 *
 * WHERE IT IS NOT OFFERED: orchestrator mode and its child sessions. The
 * project manager supervises instead of building, and its children run the
 * complete loop — a child that could turn its own gates off would be deciding
 * its own supervision. `stagesOffered` is that rule, and both the tool and the
 * fallback dialog ask it.
 *
 * PURITY. Every effect — the state read, the dialog, the sidecar write —
 * arrives through {@link LoopStagesDeps}; the parsing and the release rule are
 * plain functions. That is what lets a test drive all five switches without a
 * terminal, and it is why the fallback dialog (below) is the same code path as
 * the tool rather than a second one.
 */

import { Type } from "typebox";

import { MULTI_UNAVAILABLE, parseMultiChoice, type MultiChoicePick } from "./multi-choice-dialog.ts";
import type { ChoiceSpec } from "./choice-dialog.ts";
import type { TaskMode } from "./task-mode.ts";
import type { ToolHost, ToolReply } from "./tool-host.ts";

/**
 * THE FIVE STAGES, in the order the dialog shows them — the same order the
 * loop itself walks them. This tuple is the vocabulary: a sixth stage added
 * here starts being offered, recorded, released and rendered without any
 * second list to update (the record's validator iterates it).
 */
export const LOOP_STAGES = ["goal", "review", "quality", "acceptance", "precommit"] as const;
export type LoopStage = (typeof LOOP_STAGES)[number];

/**
 * WHAT EACH ROW SAYS. One label per stage, and it is BOTH the row the user
 * reads and the wire value the answer carries — a second vocabulary for
 * "which stage" is how a ticked box lands on the wrong switch.
 *
 * None of them may contain `" / "`: that string separates two picked options,
 * so an option containing it would make the answer unreadable (the checklist
 * parser refuses it, lib/multi-choice-dialog.ts).
 */
export const STAGE_LABELS: Readonly<Record<LoopStage, string>> = Object.freeze({
  goal: "goal 协商与批准（含需求反述）",
  review: "功能审查 reviewer",
  quality: "代码质量审查 quality-auditor",
  acceptance: "真实验收 acceptance",
  precommit: "全量 precommit（typecheck+build+全量测试）",
});

/** The dialog's fixed title — the gate's copy, not the agent's. */
export const LOOP_STAGES_TITLE = "review-gate: 本轮运行哪些环节？";

/**
 * WHAT TURNING A STAGE OFF MEANS — the per-stage consequence sentence.
 *
 * TWO CONSUMERS, ONE SOURCE (2026-09-22): the user's dialog body
 * ({@link LOOP_STAGES_BODY}, which has to say what they are switching off) and
 * the prompt-side rendering ({@link buildStagesDirective}, which has to say it
 * to the AGENT). Those two are the pair this table is for — the other places
 * that mention a switched-off stage (the dedicated goal directive, the tool
 * replies in the extension) keep their own wording on purpose.
 */
export const STAGE_OFF_CONSEQUENCES: Readonly<Record<LoopStage, string>> = Object.freeze({
  goal: "不做需求反述、不跑 goal 审计、不弹批准框，编辑与 ship 不再因「无已批准 goal」被拦；" +
    "交付站点上限也随之消失（站点来自 goal，没有 goal 就没有它）",
  review: "不派 reviewer，ship 时代码审查视为满足",
  quality: "不派 quality-auditor（取消矩阵里不再有这一方）",
  acceptance: "declare_done 不再派验收轮",
  precommit: "不跑 lane，checkpoint 与 ship 都不再要求 precommit PASS",
});

/**
 * The box's body: what the checkboxes mean and what an unchecked one does.
 *
 * It is deliberately complete rather than terse — this is the ONE place the
 * user is told what they are switching off, and a dialog they have to guess
 * about is a dialog they answer by pressing Enter without reading. The same
 * text travels to an orchestrator's channel proxy, which is why it names the
 * consequences instead of pointing at documentation.
 */
export const LOOP_STAGES_BODY: string = [
  "默认五项全部勾选＝今天的行为。空格勾选 / 取消 · ↑↓ 移动 · 回车确认 · esc 关闭。",
  "不勾的环节，门禁在它**每一个卡点**处直接放行（不再询问、不再拦截）：",
  ...LOOP_STAGES.map((s) => `  · ${STAGE_LABELS[s]} 关 ⇒ ${STAGE_OFF_CONSEQUENCES[s]}；`),
  "五项互相独立，任意组合合法；一项都不勾（空勾提交）＝五个环节全部关闭。",
].join("\n");

/** The record's shape — what the sidecar keeps and {@link stageOpen} reads. */
export interface LoopStagesRecord {
  stages: Record<LoopStage, boolean>;
  at: string;
}

/** The all-on defaults, as a fresh object (never shared mutable state). */
export function allStagesOn(): Record<LoopStage, boolean> {
  const stages = {} as Record<LoopStage, boolean>;
  for (const stage of LOOP_STAGES) stages[stage] = true;
  return stages;
}

/**
 * Keep a record read off disk only when it is entirely usable.
 *
 * ALL-OR-NOTHING on purpose: a record missing one switch is DROPPED rather
 * than completed, and dropping it falls back to the defaults — every stage on.
 * That is the only safe direction for a corrupt record: "we could not read
 * your switches" must never release a gate, and re-asking is one dialog.
 */
export function sanitizeLoopStages(raw: unknown): LoopStagesRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as { stages?: unknown; at?: unknown };
  if (!r.stages || typeof r.stages !== "object" || Array.isArray(r.stages)) return undefined;
  if (typeof r.at !== "string") return undefined;
  const src = r.stages as Record<string, unknown>;
  const stages = {} as Record<LoopStage, boolean>;
  for (const stage of LOOP_STAGES) {
    const value = src[stage];
    if (typeof value !== "boolean") return undefined;
    stages[stage] = value;
  }
  return { stages, at: r.at };
}

/**
 * IS THIS STAGE ON? — the ONE query every checkpoint calls.
 *
 * No record is not "unknown": it is the defaults, and the defaults are all-on,
 * so an older sidecar and a brand-new session behave exactly as they did
 * before this switch existed.
 */
export function stageOpen(record: LoopStagesRecord | undefined, stage: LoopStage): boolean {
  return record?.stages[stage] !== false;
}

/**
 * THE SWITCHES THE USER THREW, said to the AGENT (2026-09-22, user requirement).
 *
 * A released stage is a fact the GATE owns, and without this line the agent can
 * only learn it by getting it wrong: the five checkpoints simply return to
 * their ordinary shapes, and the signs are tool replies that arrive after the
 * work was done — or not at all. Measured: with the acceptance stage off, a
 * session wrote a real-acceptance plan into its goal and started building the
 * scene for it, a round `stageIsOn` had already made unreachable, because no
 * text it could read ever said the switch was off. One line, injected wherever
 * the loop directives are injected, replaces "go dig
 * `.pi/review-gate-state.json` out of the repo".
 *
 * NO RECORD ⇒ THE EMPTY STRING: `stageOpen` already answers "all on" for a
 * session that never opened the box, and a five-row block in every such session
 * would be noise rather than information.
 */
export function buildStagesDirective(record: LoopStagesRecord | undefined): string {
  if (!record) return "";
  const state = LOOP_STAGES.map((s) => `${s} ${stageOpen(record, s) ? "开" : "**关**"}`).join(" · ");
  const off = LOOP_STAGES.filter((s) => !stageOpen(record, s));
  if (off.length === 0) return `## 环节开关（用户设定）：${state}`;
  return [
    "## 环节开关（用户设定）",
    state,
    "关掉的环节在它每一个卡点直接放行 —— 它的工作不跑、它的拦截也不成立：",
    // `goal` is the ONE exception: its switched-off behaviour already has a
    // paragraph of its own in this same prompt (`buildGoalStageOffDirective`,
    // lib/loop-goal.ts), and saying it twice is how two texts start drifting.
    ...off
      .filter((s) => s !== "goal")
      .map((s) => `- ${STAGE_LABELS[s]} ⇒ ${STAGE_OFF_CONSEQUENCES[s]}；`),
    ...(off.includes("goal") ? ["- goal 关掉后的行为见上面那段 goal 指令（它专门说过了）。"] : []),
    "不要为关掉的环节做任何准备：不写它的方案、不搭它的现场、不提前替它跑一遍。" +
      // The goal skeleton asks for a 「真实验收方案」 section in EVERY session,
      // so a session whose acceptance stage is off owes that section's
      // REPLACEMENT, not its content — otherwise the next goal audit reads the
      // missing section as a P1, or worse, the agent builds a scene for a round
      // that will never be dispatched.
      (off.includes("acceptance")
        ? "验收已关：goal 里按「本轮无真实验收（用户关闭了验收环节）」写即可，不要写验收方案。"
        : "") +
      "要恢复某个环节，让用户重开开关（再调一次 `choose_loop_stages`）。",
  ].join("\n");
}

/** The stages the user switched OFF, in dialog order. */
export function stagesOff(record: LoopStagesRecord | undefined): LoopStage[] {
  return LOOP_STAGES.filter((stage) => !stageOpen(record, stage));
}

/**
 * ONE line naming what is off — the readout `/gate-status` and the widget
 * share, so the two surfaces cannot disagree about the session's switches.
 */
export function stagesSummary(record: LoopStagesRecord | undefined): string {
  const off = stagesOff(record);
  if (off.length === 0) return "全部开启（默认）";
  return `已关闭 ${off.join("、")}`;
}

/**
 * THE ONE DIALOG. Five rows, `defaultChecked` carrying the recommendation —
 * which is what makes Enter mean "the defaults" (the checklist shape's own
 * promise, lib/multi-choice-dialog.ts).
 *
 * THE TICKS ARE THE CURRENT RECORD when there is one (2026-09-22): re-opening
 * the box to change one stage must not silently offer to turn the other four
 * back on — a session that has already answered opens with ITS answer ticked,
 * and a session that has not opens with all five (the defaults).
 *
 * `recommended` is empty and never matches a row: a `（推荐）` marker belongs
 * to a single-answer question, and marking one of five checkboxes would say
 * the other four are not recommended. The default GROUP is the recommendation
 * here, and it is carried by what is already ticked.
 */
export function loopStagesSpec(current?: LoopStagesRecord): ChoiceSpec {
  const stages = LOOP_STAGES;
  const options = stages.map((stage) => STAGE_LABELS[stage]);
  return {
    title: LOOP_STAGES_TITLE,
    options,
    recommended: "",
    defaultChecked: stages.filter((stage) => stageOpen(current, stage)).map((stage) => STAGE_LABELS[stage]),
  };
}

/** The label → stage map, derived from the one vocabulary above. */
function stageOfLabel(label: string): LoopStage | undefined {
  return LOOP_STAGES.find((stage) => STAGE_LABELS[stage] === label);
}

/** The ticked rows as a record. Rows the dialog itself offered, so all map. */
function recordOf(options: readonly string[], at: string): LoopStagesRecord {
  const ticked = new Set(options.map(stageOfLabel));
  const stages = {} as Record<LoopStage, boolean>;
  for (const stage of LOOP_STAGES) stages[stage] = ticked.has(stage);
  return { stages, at };
}

/** Whether the stages switch is OFFERED here, or the refusal to show instead. */
export interface StagesOfferFacts {
  /** The session's gate mode (`state.taskMode`). */
  mode?: TaskMode | undefined;
  /** True in a judge pane — a reporting shell runs no loop of its own. */
  judge?: boolean;
  /** True when this process was spawned under an orchestration. */
  orchestrated?: boolean;
}

/**
 * MAY THIS SESSION CHOOSE ITS STAGES?
 *
 * `undefined` = yes. Anything else is the refusal text, and BOTH entry points
 * (the tool and the fallback dialog) ask this one function — the rule is
 * "orchestrator mode and its children only", so a child cannot switch off the
 * gates its supervisor planned for it.
 *
 * explore/normal are refused for the opposite reason: their gates are already
 * advisory/off, and offering five switches for a gate that is not enforcing
 * anything would be noise.
 *
 * AN UNDECIDED SESSION (`mode === undefined`) IS OFFERED, deliberately
 * (reviewer Nit, 2026-09-22): the switches are the SESSION's setting and the
 * answer is recorded the moment it is given, so a box shown before
 * `set_gate_mode` answers is not a consumed chance — the mode/goal gate that
 * may then block the FIRST EDIT is a different question asked by a different
 * mechanism, and refusing this one early would only move the same dialog
 * later. Only a mode that already answers the question is refused.
 */
export function stagesOffered(facts: StagesOfferFacts): string | undefined {
  if (facts.mode === "orchestrator") {
    return "review-gate: 编排模式不提供环节开关 —— 项目经理负责统筹，五个环节一律完整运行。";
  }
  if (facts.orchestrated) {
    return "review-gate: 编排子会话不提供环节开关 —— 你这一轮按 plan 完整跑完五个环节；" +
      "要收窄范围就跟项目经理说。";
  }
  if (facts.judge) {
    return "review-gate: judge 会话不持有门禁 —— 环节开关是给 loop 主会话用的。";
  }
  if (facts.mode !== undefined && facts.mode !== "loop") {
    return `review-gate: 当前模式是 ${facts.mode}，环节开关只对 loop 模式生效。`;
  }
  return undefined;
}

/** What one visit to the dialog produced. */
export type LoopStagesOutcome =
  | { kind: "recorded"; record: LoopStagesRecord }
  /** The box was closed (or answered by nobody): nothing recorded. */
  | { kind: "dismissed" }
  /** No host could draw the checklist: nothing recorded, defaults apply. */
  | { kind: "unavailable" }
  /** The ✎ row: the user declined the whole list, with (or without) a reason. */
  | { kind: "declined"; reason: string }
  /** A line nobody could read: nothing recorded, defaults apply. */
  | { kind: "unreadable"; text: string }
  /** This session may not choose — the text is `stagesOffered`'s. */
  | { kind: "refused"; text: string };

/** Everything the dialog needs from the outside world. */
export interface LoopStagesDeps {
  /** The session's own gate-state slice (its `stages` record is the read). */
  state(): { stages?: LoopStagesRecord };
  /** The refusal to show, or `undefined` when this session may choose. */
  refusal(): string | undefined;
  /** The checkbox dialog (lib/multi-choice-dialog.ts's line shape). */
  /**
   * The checkbox dialog (lib/multi-choice-dialog.ts's line shape).
   *
   * THE HOST MUST NOT LET A PROXY ANSWER IT (quality round P1, 2026-09-22):
   * this dialog is a checklist, so a stand-in that names only SOME rows would
   * silently switch the unnamed stages OFF — a machine turning gates off in
   * the user's name. The extension wires `proxy: false` for this call; a host
   * that proxies it anyway is breaking this contract.
   */
  askMulti(uiCtx: unknown, spec: ChoiceSpec, opts?: { body?: string; signal?: AbortSignal }): Promise<string | undefined>;
  /** Write the record where the five checkpoints read it. */
  persist(record: LoopStagesRecord, ctx: unknown): void;
  /** The gate's own log channel. */
  log?(message: string): void;
  /** Injectable clock, so the recorded time is assertable. */
  now?(): Date;
}

/** Read one returned line into an outcome. The ONE parser, human or proxy. */
function outcomeOf(line: string | undefined, spec: ChoiceSpec, at: string): LoopStagesOutcome {
  if (line === MULTI_UNAVAILABLE) return { kind: "unavailable" };
  const pick: MultiChoicePick = parseMultiChoice(line, spec);
  if (pick.kind === "dismissed") return { kind: "dismissed" };
  if (pick.kind === "declined") return { kind: "declined", reason: pick.reason };
  if (pick.kind === "unreadable") return { kind: "unreadable", text: pick.text };
  return { kind: "recorded", record: recordOf(pick.options, at) };
}

/** Run the dialog and record what it produced. The ONE implementation. */
export async function chooseLoopStages(
  deps: LoopStagesDeps,
  ctx: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<LoopStagesOutcome> {
  const refusal = deps.refusal();
  if (refusal !== undefined) return { kind: "refused", text: refusal };
  const spec = loopStagesSpec(deps.state().stages);
  let line: string | undefined;
  try {
    line = await deps.askMulti(ctx, spec, {
      body: LOOP_STAGES_BODY,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch {
    // A dialog that could not be shown at all (a host failure, not a closed
    // box) lands exactly where a host with no checklists lands — nothing is
    // recorded, and the defaults keep running. Reporting it as `dismissed`
    // would say the USER closed a box that never appeared.
    line = MULTI_UNAVAILABLE;
  }
  const outcome = outcomeOf(line, spec, (deps.now?.() ?? new Date()).toISOString());
  if (outcome.kind === "recorded") {
    deps.persist(outcome.record, ctx);
    deps.log?.(`loop stages: ${stagesSummary(outcome.record)}`);
  }
  return outcome;
}

/**
 * THE FALLBACK: no record yet, and the session is about to do something the
 * stages decide — `propose_restatement`, or the first edit. Show the SAME box,
 * through the SAME function.
 *
 * A record already on file means the user has answered this session's only
 * question, and a dismissed/unavailable box is NOT a reason to ask again in
 * the same breath (the caller owns the once-per-session guard); both of those
 * return `undefined` and the caller carries on with the defaults.
 */
export async function ensureLoopStages(
  deps: LoopStagesDeps,
  ctx: unknown,
): Promise<LoopStagesOutcome | undefined> {
  if (deps.state().stages !== undefined) return undefined;
  return chooseLoopStages(deps, ctx);
}

/** The reply one outcome produces — gate-owned copy, never parsed by an agent. */
export function formatStagesOutcome(outcome: LoopStagesOutcome, current: LoopStagesRecord | undefined): string {
  switch (outcome.kind) {
    case "recorded":
      return `review-gate: 环节选择已记录 —— ${stagesSummary(outcome.record)}。` +
        (stagesOff(outcome.record).length === 0
          ? "（五个环节全开＝今天的行为）"
          : "门禁在这些环节的每一个卡点处直接放行；要改就再调一次 choose_loop_stages。");
    case "dismissed":
      return `review-gate: 没有记录任何选择（复选框被关掉）—— 当前生效的仍是「${stagesSummary(current)}」。` +
        "要设置就再调一次 choose_loop_stages。";
    case "unavailable":
      return "review-gate: 这个 host 画不出复选框（没有可用的自定义组件）—— 没有记录任何选择，" +
        `当前生效的仍是「${stagesSummary(current)}」。`;
    case "declined":
      return "review-gate: 用户没有选择任何一组，而是选了「不选，我说明原因」" +
        (outcome.reason ? `：${outcome.reason}` : "。") +
        "没有记录任何选择 —— 先把他说的处理掉，再决定要不要重新弹出这个框。";
    case "unreadable":
      return `review-gate: 复选框收到的答案无法解析（${JSON.stringify(outcome.text.slice(0, 120))}）——` +
        `没有记录任何选择，当前生效的仍是「${stagesSummary(current)}」。`;
    case "refused":
      return outcome.text;
  }
}

/** `choose_loop_stages`: one call, the gate's own box, nothing to compose. */
export async function doChooseLoopStages(
  deps: LoopStagesDeps,
  ctx: unknown,
): Promise<ToolReply> {
  const outcome = await chooseLoopStages(deps, ctx);
  const refused = outcome.kind === "refused";
  return {
    content: [{ type: "text", text: formatStagesOutcome(outcome, deps.state().stages) }],
    details: {
      chosen: outcome.kind === "recorded",
      ...(outcome.kind === "recorded" ? { stages: outcome.record.stages } : {}),
    },
    ...(refused ? { isError: true } : {}),
  };
}

/**
 * THE FAMILY'S ONE REGISTRATION. The tool takes NO parameters — the agent asks
 * the question, the gate asks the user; a model that could pass "stages" would
 * be choosing its own gates.
 */
export function registerLoopStageTools(host: ToolHost, deps: LoopStagesDeps): void {
  host.registerTool({
    name: "choose_loop_stages",
    label: "Choose Loop Stages",
    description:
      "Open the gate's OWN five-item checklist (goal / review / quality / acceptance / precommit, " +
      "all ticked by default) and let the USER decide which stages this session runs. NO parameters: " +
      "the gate owns the copy, the defaults, the record and the release — call it when the user asks " +
      "to skip something, or when the first edit or `propose_restatement` already raised it for you. " +
      "A stage that is not ticked is RELEASED at every one of its checkpoints (its work does not run, " +
      "its blocks do not apply). Ticking nothing is legal and means all five are off. Orchestrator " +
      "mode and its child sessions are refused: they always run the full loop. If this session has " +
      "not chosen yet, the gate itself opens the same box before `propose_restatement` and before the " +
      "first edit, so you never have to anticipate it.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => doChooseLoopStages(deps, ctx),
  });
}
