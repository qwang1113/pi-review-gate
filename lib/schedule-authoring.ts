/**
 * AUTHORING ONE SCHEDULED TASK'S CONTRACT — the human-in-the-loop half of
 * `schedule_task` (lib/schedule-tools.ts is the tool surface itself).
 *
 * ── WHY THE SPLIT ──
 *
 * The same one lib/goal-tools.ts / lib/goal-prereview-tools.ts exists under:
 * one module owning the whole family went past the 600-line hard block on new
 * source files, and the seam is real — this half is "may a contract be written
 * at all, and what exactly did the user agree to", the tool half is "who may
 * address the table, and how does an action read". The flow did not change in
 * the move.
 *
 * ── WHAT IT REUSES, AND WHAT IT DOES NOT ──
 *
 * Nothing here is a second implementation. The restatement's content check,
 * dialog copy and hash are lib/restatement.ts's; the goal draft check is
 * lib/goal-prereview-tools.ts's; the audit (`runGoalAudit`) and its
 * adjudication ("only P0/P1 block") are the SAME ones `propose_loop_goal` runs,
 * and the goal hash is lib/loop-goal.ts's. The write rule — which fields an
 * origin may touch, and that a contract must carry hashes matching its own
 * texts — is lib/schedule-store.ts's (`applyScheduleEdit` /
 * `scheduleContractProblem`), reached through its `from: "gate"` write path.
 *
 * What is HERE is the ORDER and the consents: validate the cheap fields BEFORE
 * spending the user's time, ask for the restatement, audit the goal draft,
 * ask for the goal, and only then hand back a contract to write. And the one
 * place the approval may land twice: when the session has no approved loop
 * goal of its own and the task lives in its own repo, the SAME approval
 * becomes that session's exit contract.
 */

import { parseCron } from "./cron-schedule.ts";
import {
  DEFAULT_DELIVERY_STATION,
  deliveryStationLine,
  parseDeliveryStation,
  type DeliveryStation,
} from "./delivery-station.ts";
import { checkGoalDraft } from "./goal-prereview-tools.ts";
import {
  goalPrereviewPassed,
  goalTextHash,
  type GoalPrereviewRecord,
  type LoopGoalConfirmation,
} from "./loop-goal.ts";
import type { ChannelDialogOutcome, ChannelDialogRequest, DialogRenderer } from "./orchestrator-child-channel.ts";
import { REVISE_ROW, choiceRows, parseChoice, type AskChoiceOpts, type ChoiceSpec } from "./choice-dialog.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { buildRejection } from "./rejection-copy.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import {
  RESTATEMENT_APPROVE_LABEL,
  RESTATEMENT_CONFIRM_TITLE,
  RESTATEMENT_REJECT_LABEL,
  buildRestatementConfirmMessage,
  buildRestatementTranscriptMessage,
  checkRestatementText,
  restatementHash,
  restatementRequiredInMode,
  type RestatementRecord,
} from "./restatement.ts";
import {
  listScheduledTasks,
  scheduleNameProblem,
  scheduleRepoProblem,
  type ScheduleContract,
  type ScheduledTask,
} from "./schedule-store.ts";
import type { TaskMode } from "./task-mode.ts";

/** The gate-state slice an authoring run reads (goal audit) and may write. */
export interface ScheduleStateSlice {
  goalPrereview?: GoalPrereviewRecord;
  restatement?: RestatementRecord;
  loopGoal?: LoopGoalConfirmation;
}

/** Everything the authoring chain needs from the outside world. */
export interface ScheduleAuthoringDeps {
  /** The user home the daemon's paths hang off (`RG_DAEMON_HOME ?? homedir()`). */
  home(): string;
  /** This session's own repo. */
  primaryRepoRoot(): string;
  /** What a relative `repo` resolves against. */
  cwd(): string;
  stateFor(root: string): ScheduleStateSlice;
  persist(ctx: unknown, root: string): void;
  log(message: string): void;
  showToUser(uiCtx: unknown, lead: string, body: string): boolean;
  askChoice(uiCtx: unknown, spec: ChoiceSpec, opts?: AskChoiceOpts): Promise<string | undefined>;
  askEitherSide(
    request: Omit<ChannelDialogRequest, "hasUI">,
    hasUI: boolean,
    render: DialogRenderer,
  ): Promise<ChannelDialogOutcome>;
  /** The goal audit chain — the SAME one `propose_loop_goal` runs. */
  runGoalAudit(input: {
    root: string;
    goalText: string;
    ctx: unknown;
    progress?: ReturnType<typeof createProgressReporter>;
    signal?: AbortSignal | undefined;
  }): Promise<{ ok: true } | { ok: false; text: string }>;
  loopGoalPath(root: string): string;
  loopGoalRelPath: string;
  /** Write the approved goal (creating its directory). Throws on failure. */
  writeGoalFile(path: string, text: string): void;
  taskMode(): TaskMode | undefined;
  /** Injected for tests; production passes lib/repo-resolve.ts's gitRootOfDir. */
  gitRoot?(dir: string): string | null;
  /** Injectable clock, so a recorded approval time is assertable. */
  now?(): Date;
}

const str = (raw: unknown): string => (typeof raw === "string" ? raw.trim() : "");
const has = (params: Record<string, unknown>, key: string): boolean => Object.hasOwn(params, key);

// ---------------------------------------------------------------------------
// the values an authoring write would carry, and the cheap checks on them
// ---------------------------------------------------------------------------

/** One task's field values, as the write would land them. */
export interface AuthoringFields {
  name: string;
  repo: string;
  cron: string;
  requirement: string;
  enabled: boolean;
}

/**
 * Resolve the patch's fields (what was passed, else what is there) and refuse
 * the ones that are already knowably bad.
 *
 * THE PRECHECKS COME FIRST for one reason: a bad cron or a taken name must not
 * cost the user two dialogs and a minutes-long audit before the store turns
 * the write down. The validators are the store's own — nothing is re-spelled.
 */
export function resolveAuthoringFields(
  deps: ScheduleAuthoringDeps,
  input: { kind: "create" | "update"; params: Record<string, unknown>; current?: ScheduledTask },
): { fields: AuthoringFields; problems: string[] } {
  const { params, current } = input;
  const create = input.kind === "create";
  const fields: AuthoringFields = {
    name: has(params, "name") ? str(params.name) : (current?.name ?? ""),
    repo: has(params, "repo") ? str(params.repo) : (current?.repo ?? ""),
    cron: has(params, "cron") ? str(params.cron) : (current?.cron ?? ""),
    requirement: has(params, "requirement") ? str(params.requirement) : (current?.requirement ?? ""),
    enabled: has(params, "enabled") ? params.enabled === true : (current?.enabled ?? true),
  };
  const taken = listScheduledTasks(deps.home())
    .filter((task) => task.id !== current?.id)
    .flatMap((task) => [task.id, task.name]);
  const cronCheck = parseCron(fields.cron);
  // The repo must be a GIT repo — the run works in a checkout and the contract
  // binds to a git root (`checkGoalDraft` resolves the same way).
  const repoIsGit = !(create || has(params, "repo")) || (deps.gitRoot ?? gitRootOfDir)(fields.repo) !== null;
  return {
    fields,
    problems: [
      create || has(params, "name") ? scheduleNameProblem(fields.name, taken) : undefined,
      create || has(params, "repo") ? scheduleRepoProblem(fields.repo) : undefined,
      !repoIsGit ? `repo 不在可读的 git 仓库里：${fields.repo}` : undefined,
      (create || has(params, "cron")) && !cronCheck.ok ? `cron 不合法：${cronCheck.problem}` : undefined,
      fields.requirement === "" ? "requirement 不能是空的" : undefined,
    ].filter((problem): problem is string => problem !== undefined),
  };
}

// ---------------------------------------------------------------------------
// dialogs — the gate's ONE question template, twice (restatement, goal)
// ---------------------------------------------------------------------------

interface Decision {
  approved: boolean;
  reason?: string;
  interrupted: boolean;
  dismissed: boolean;
}

/** Raise one approval box (human or channel — whoever answers first) and read it. */
async function askApproval(
  deps: ScheduleAuthoringDeps,
  uiCtx: { hasUI?: boolean },
  request: Omit<ChannelDialogRequest, "hasUI">,
  spec: ChoiceSpec,
  approveLabel: string,
  body: string,
): Promise<Decision> {
  try {
    const outcome = await deps.askEitherSide(request, uiCtx.hasUI === true, async (dialog) =>
      deps.askChoice(uiCtx, spec, { ...dialog, body }));
    const pick = parseChoice(outcome.answer, spec);
    const declined = pick.kind === "declined" && pick.reason ? pick.reason : undefined;
    return {
      approved: pick.kind === "chose" && pick.option === approveLabel,
      ...(declined !== undefined ? { reason: declined } : outcome.reason ? { reason: outcome.reason } : {}),
      interrupted: outcome.by === "interrupted",
      dismissed: pick.kind === "dismissed",
    };
  } catch {
    return { approved: false, interrupted: false, dismissed: true };
  }
}

/** What a closed/unanswered/refused box means — never reported as an objection it is not. */
function notApproved(label: string, stage: string, d: Decision): string {
  if (d.interrupted) {
    return `review-gate: 定时任务 ${label} 的${stage}被中断（对话框被消息打断）—— 这不是被否掉；` +
      "处理完那条消息后重新调用 schedule_task 即可。";
  }
  if (d.dismissed) {
    return `review-gate: 用户没有作答定时任务 ${label} 的${stage}（框被关掉，或他在框外说了别的事）—— **这不是被否掉**。\n` +
      "下一步：先把他刚说的事处理掉，然后用 `ask_user` 问一句「关于这个定时任务，还有别的要补充或要改的吗？" +
      "没有了我就重新提交」，得到「没有了」之后再调 `schedule_task`。";
  }
  return buildRejection({
    what: `定时任务 ${label} 的${stage}被用户否掉（一个字节都没写）`,
    why: "用户不认可被问的那份内容。",
    by: "agent",
    next: (d.reason ? `针对他给的原因改：${d.reason}——` : "先用 `ask_user` 问清楚哪里不对，") +
      "改完重新调用 schedule_task（整条链会重走）。",
  });
}

// ---------------------------------------------------------------------------
// one negotiation: restatement → goal draft → audit → goal approval
// ---------------------------------------------------------------------------

/** A contract the user approved, plus what that approval does to this session. */
export interface Negotiated {
  ok: true;
  contract: ScheduleContract;
  /** The git root the contract binds to (what the schedule record stores). */
  root: string;
  /** What happens to the SESSION records — the reply says it out loud. */
  sessionNote: string;
}
export type NegotiateResult = Negotiated | { ok: false; text: string };

export async function negotiateContract(
  deps: ScheduleAuthoringDeps,
  input: {
    /** 任务名 —— 两个对话框都用它说明「问的是哪一份任务」。 */
    label: string;
    repo: string;
    restatement: unknown;
    goal: unknown;
    station: unknown;
    /** The station to carry over when the caller did not ask for one (update). */
    fallbackStation?: DeliveryStation;
    ctx: unknown;
    onUpdate: unknown;
    signal?: AbortSignal | undefined;
  },
): Promise<NegotiateResult> {
  const missing = [
    str(input.restatement) === "" ? "restatement" : "",
    str(input.goal) === "" ? "goal" : "",
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      ok: false,
      text: buildRejection({
        what: `schedule_task 被拒 —— 改契约（需求/repo/goal）必须带 ${missing.join(" 与 ")}`,
        why: "契约的修改要重新走一遍需求反述与 goal 批准，缺了正文就没有可协商的东西。",
        by: "agent",
        next: "把需求反述与 goal 草稿写好一起传（两者都是全文，goal 照 `propose_loop_goal` 的骨架写）；" +
          "只想改 cron / enabled / name 就不要带这些字段，那样的修改直接生效、不协商。",
      }),
    };
  }
  // 1. THE RESTATEMENT'S CONTENT CHECK — the same one propose_restatement runs.
  const restCheck = checkRestatementText(input.restatement);
  if (!restCheck.ok) return { ok: false, text: restCheck.text };
  const restatementText = restCheck.text;
  const requestedStation = str(input.station);
  const station: DeliveryStation = requestedStation !== ""
    ? parseDeliveryStation(requestedStation)
    : (input.fallbackStation ?? DEFAULT_DELIVERY_STATION);
  const uiCtx = input.ctx as { hasUI?: boolean };

  // 2. THE RESTATEMENT DIALOG — the gate's one template, with the test case
  // said out loud: this is a SCHEDULED TASK's requirement, not a look-alike
  // confirmation of whatever the session itself is doing.
  const restSpec: ChoiceSpec = {
    title: RESTATEMENT_CONFIRM_TITLE,
    options: [RESTATEMENT_APPROVE_LABEL, RESTATEMENT_REJECT_LABEL],
    recommended: RESTATEMENT_APPROVE_LABEL,
    declineRow: REVISE_ROW,
  };
  deps.showToUser(
    uiCtx,
    RESTATEMENT_CONFIRM_TITLE,
    `定时任务 ${input.label} 的需求反述：\n` + buildRestatementTranscriptMessage(restatementText, station),
  );
  const restDecision = await askApproval(
    deps, uiCtx,
    {
      dialogKind: "select", topic: "restatement", title: RESTATEMENT_CONFIRM_TITLE,
      options: choiceRows(restSpec), payload: restatementText, station,
    },
    restSpec, RESTATEMENT_APPROVE_LABEL,
    `这是定时任务 ${input.label} 的需求反述。\n` + buildRestatementConfirmMessage(station),
  );
  if (!restDecision.approved) return { ok: false, text: notApproved(input.label, "需求反述", restDecision) };

  // 3. THE GOAL DRAFT CHECK — the same three checks propose_loop_goal runs,
  // and the repo resolution that names the audit's root.
  const draft = checkGoalDraft({
    tool: "schedule_task",
    rawGoal: input.goal,
    rawRepo: input.repo,
    cwd: deps.cwd(),
    primaryRepoRoot: deps.primaryRepoRoot(),
    gitRoot: deps.gitRoot ?? gitRootOfDir,
  });
  if (!draft.ok) return { ok: false, text: draft.text };

  // 4. THE GOAL AUDIT — identical chain and identical adjudication as
  // `propose_loop_goal` (only P0/P1 block, recorded against the draft's hash).
  // A PASS already bound to this exact text is reused: re-auditing identical
  // text would burn minutes to reach the same verdict.
  const sessionState = deps.stateFor(draft.root);
  if (!goalPrereviewPassed(sessionState.goalPrereview, draft.goalText)) {
    const audit = await deps.runGoalAudit({
      root: draft.root,
      goalText: draft.goalText,
      ctx: input.ctx,
      progress: createProgressReporter({
        title: "review-gate: schedule_task（goal 审计）",
        onUpdate: input.onUpdate as ToolUpdate | undefined,
      }),
      signal: input.signal,
    });
    if (!audit.ok) return { ok: false, text: audit.text };
  }

  // 5. THE GOAL APPROVAL — one decision, and the box says which records it
  // lands in BEFORE it is asked for. `sessionContractPlan` is the SAME
  // decision the write takes, so the box cannot promise a record the write
  // then skips (or vice versa).
  const plan = sessionContractPlan(deps, draft.root);
  const prereviewLine = `goal-auditor 预审: ${
    sessionState.goalPrereview?.verdict === "PASS" ? "PASS @ " + sessionState.goalPrereview.at : "本次 PASS（刚记下）"
  }`;
  const goalApproveLabel = "认可，写入调度任务";
  const goalRejectLabel = "不认可，退回重谈";
  const goalSpec: ChoiceSpec = {
    title: `review-gate: AI 提交了定时任务 ${input.label} 的目标 —— 是否认可？`,
    options: [goalApproveLabel, goalRejectLabel],
    recommended: goalApproveLabel,
    declineRow: REVISE_ROW,
  };
  deps.showToUser(
    uiCtx,
    goalSpec.title,
    `定时任务 ${input.label} 的 goal（不可信数据）——获批后它成为这份调度任务的契约，每次运行都按它干活：\n` +
      "─────\n" + draft.goalText + "\n─────\n" +
      `运行仓库: ${draft.root}\n` + deliveryStationLine(station, "user") + "\n" + prereviewLine + "\n" + plan.note,
  );
  const goalDecision = await askApproval(
    deps, uiCtx,
    {
      dialogKind: "select", topic: "goal-approval", title: goalSpec.title,
      options: choiceRows(goalSpec), payload: draft.goalText, station,
    },
    goalSpec, goalApproveLabel,
    [
      `这是定时任务 ${input.label} 的目标批准（goal 全文在上方消息里）。`,
      `运行仓库(不可信数据): ${draft.root}`,
      deliveryStationLine(station, "user"),
      prereviewLine,
      plan.note,
      "认可后：这份 goal 与需求反述一起写进调度记录，成为每次运行的契约。",
      "不认可就拒绝并说明哪里不对；工具会重新确认后再提交。",
    ].join("\n"),
  );
  if (!goalDecision.approved) return { ok: false, text: notApproved(input.label, "goal 批准", goalDecision) };

  const approvedAt = (deps.now?.() ?? new Date()).toISOString();
  return {
    ok: true,
    contract: {
      restatement: { text: restatementText, hash: restatementHash(restatementText), station, at: approvedAt },
      goal: { text: draft.goalText, hash: goalTextHash(draft.goalText), at: approvedAt },
      approvedAt,
    },
    root: draft.root,
    sessionNote: plan.record ? "" : plan.note,
  };
}

// ---------------------------------------------------------------------------
// the session record an approved contract may also become
// ---------------------------------------------------------------------------

/**
 * WILL the session records be written as well? The plan every surface reads:
 * the approval box asks it BEFORE the user answers, `recordSessionContract`
 * takes the same decision again when it writes.
 */
export function sessionContractPlan(
  deps: ScheduleAuthoringDeps,
  root: string,
): { record: boolean; note: string } {
  const primary = deps.primaryRepoRoot();
  if (str(root) !== str(primary)) {
    return { record: false, note: `本会话的主仓库是 ${primary}，这次任务在 ${root} —— 只写调度记录，不动本会话的契约记录。` };
  }
  if (!restatementRequiredInMode(deps.taskMode())) {
    return { record: false, note: "本会话不在 loop/orchestrator 模式 —— 这次批准只写调度记录，不动本会话的契约记录。" };
  }
  if (deps.stateFor(primary).loopGoal !== undefined) {
    return { record: false, note: "本会话已有获批 loop goal —— 这次批准只写这份调度任务的契约，不改动它。" };
  }
  return {
    record: true,
    note: `本会话还没有 loop goal —— 批准后这份契约同时作为本会话的退出契约记录（${deps.loopGoalRelPath} + sidecar）。`,
  };
}

/**
 * The session half of an approved contract: when this session has no approved
 * loop goal and the schedule lives in its own repo, the SAME approval becomes
 * its exit contract — file first, records second, so a write that fails leaves
 * nothing half-recorded. An existing goal is never touched. Returns the note
 * the reply shows.
 */
export function recordSessionContract(
  deps: ScheduleAuthoringDeps,
  ctx: unknown,
  input: { contract: ScheduleContract; root: string },
): string {
  const plan = sessionContractPlan(deps, input.root);
  if (!plan.record) return plan.note;
  const primary = deps.primaryRepoRoot();
  deps.writeGoalFile(deps.loopGoalPath(primary), input.contract.goal.text + "\n");
  const st = deps.stateFor(primary);
  st.restatement = {
    text: input.contract.restatement.text,
    hash: input.contract.restatement.hash,
    at: input.contract.approvedAt,
    station: input.contract.restatement.station,
  };
  st.loopGoal = {
    hash: input.contract.goal.hash,
    at: input.contract.approvedAt,
    station: input.contract.restatement.station,
  };
  deps.persist(ctx, primary);
  deps.log(`schedule_task: 本会话（${primary}）还没有 loop goal，批准的契约同时记为其退出契约`);
  return plan.note;
}
