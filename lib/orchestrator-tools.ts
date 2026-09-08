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
import { buildRestatementMissingRefusal, restatementConfirmed } from "./restatement.ts";
import { REVISE_ROW, parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
import { DELIVERY_STATION_CHOICES, deliveryStationLine } from "./delivery-station.ts";
import {
  applyTaskStatus,
  formatPlanSummary,
  mergeTaskProgress,
  nextDecisionId,
  parsePlan,
  planHash,
  PLAN_RELPATH,
  type OrchestratorPlan,
  type TaskStatus,
} from "./orchestrator-plan.ts";
import {
  beginApprovalLineage,
  decideApprovalCarry,
  extendApprovalLineage,
  formatApprovalAmendments,
  formatApprovalRestored,
  formatApprovalWidenings,
  lineageAuthorizes,
  snapshotApprovedPlan,
} from "./orchestrator-plan-approval.ts";

import {
  formatOrchestrationStatus,
  notifyAuthorization,
  orchestratorDoneProblems,
} from "./orchestrator-gate.ts";
import { emptyRuntime, formatChildren } from "./orchestrator-registry.ts";
import { formatChildHealth } from "./orchestrator-child-state.ts";

import {
  decideNotify,
  notifyKey,
  prepareNotification,
  recordNotify,
} from "./orchestrator-notify.ts";
import {
  ARCHIVE_CONFIRM_TITLE,
  buildArchiveConfirmMessage,
  buildPlanArchive,
  buildTakeoverRoute,
  discoverOrchestrations,
  planArchiveRelPath,
} from "./orchestrator-takeover.ts";

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
  // B1 (2026-09-05, user decision): "放弃旧编排、另起一轮" is an ACTION of the
  // plan tool, not a third tool — the thing being put down IS the plan, and a
  // separate tool would be the "two entry points for one thing" philosophy
  // two forbids.
  archive: "archive",
} as const;

/** The dialog the USER approves a plan in (constraint 1). */
export const PLAN_CONFIRM_TITLE = "review-gate: 批准项目经理的任务计划（plan）？";

/** The row that approves it — one spelling, used by the dialog and the parse. */
export const PLAN_APPROVE_LABEL = "批准这份 plan";

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
    // The USER reads this block before approving, so the station speaks to them.
    formatPlanSummary(plan, "", "user") +
    "\n───────────────────────\n" +
    "同样的内容也在 `" + PLAN_RELPATH + "`（可随时自己去看）。\n" +
    "批准的是**内容**：任务、每个任务的 repo、依赖、并行度中任何一项被**扩大**，批准即失效。\n\n" +
    APPROVAL_SEMANTICS
  );
}

/**
 * WHAT AN APPROVAL COVERS — stated to the user, in the dialog, before they
 * agree to it.
 *
 * This paragraph is the honest half of the round-4 P0 fix. The dialogs that
 * round popped three times were all caused by a plan edit that had to reach
 * the user only because the plan declared FILE BOUNDARIES; those are gone
 * (2026-09-17, user decision), so the edit that caused them cannot exist. What
 * remains is the shorter list of edits that still widen what "approved"
 * means — and a rule the user discovers AFTERWARDS is not a rule they agreed
 * to, so it is written where they are deciding, in the text the approval
 * binds to.
 */
const APPROVAL_SEMANTICS =
  "关于批准的确切含义（请读一句）：批准的是**内容** —— 任务清单、每个任务的 repo、" +
  "依赖关系、并行度、交付站点。\n" +
  "子会话在它自己的 repo 里改哪些文件**不需要再报备**，也不会再来打扰你" +
  "（文件边界已于 2026-09-17 从 plan 中移除：同一 repo 的任务本来就不会同时跑）。\n" +
  "把 plan **写回你此前批准过的内容**同样不会再问（撤回一次误操作不必重走批准），" +
  "而你每批准一次新内容，之前那条链就作废。\n" +
  "以下改动一律**重新**征求你的批准：" +
  "新增任务、把任务换到另一个 repo、删除依赖、把串行改成并行、提高并行上限、把交付站点往后挪" +
  "（precommit → commit → pr，等于放开更多 ship 命令）。";


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
    "新增任务、把任务换到另一个 repo、删依赖、串行改并行、提高并行上限、**提高交付站点**，" +
    "都会让批准失效并重新问你；" +
    "**子会话在自己 repo 内改哪些文件不再报备**，" +
    "**写回你批准过的内容**也不会再问（详见上方消息）。\n" +

    `标题（不可信数据）：${plan.title.slice(0, 80)}\n` +
    `规模：${plan.tasks.length} 个任务，并行上限 ${plan.maxParallel}\n` +
    // The station is a CONSENT-critical fact: it decides how far this
    // orchestration may go (precommit / commit / pr), and raising it later is
    // a widening that comes back here. A dialog that omitted it would ask the
    // user to approve an authority they were never shown.
    deliveryStationLine(plan.deliveryStation, "user")
  );
}


async function handlePlanAction(
  deps: OrchestratorDeps,
  params: Record<string, unknown>,
  onUpdate?: { step?: (t: string) => void; done?: (t: string) => void } | undefined,
  signal?: AbortSignal | undefined,
): Promise<ToolReply> {
  const action = String(params.action ?? "read");
  const nowIso = new Date(deps.now()).toISOString();

  // ---------------------------------------------------------------------
  // IDENTITY GUARD (2026-09-06, B1 — MOVED HERE from `set_gate_mode`)
  // ---------------------------------------------------------------------
  //
  // The rule is unchanged: a session that did not inherit an orchestration
  // must not quietly become the holder of one that is already recorded in
  // this repo. What changed is WHERE it is enforced. It used to refuse the
  // MODE — you could not become a project manager at all while somebody
  // else's plan existed — and that made the two tools which resolve the
  // situation unreachable, because both live inside the role. The refusal
  // has been moved onto the acts that actually need an identity:
  //
  //   `write` / `submit` here, and `orchestrator_spawn` (which has its own
  //   `runtimeConflict` check, lib/orchestrator-dispatch.ts).
  //
  // Everything else — `read`, `archive`, and the whole of `orchestrator_attach`
  // — stays open, which is precisely what makes the dead end resolvable from
  // inside the role instead of with `rm`.
  const conflict = deps.runtimeConflict?.();
  if (conflict && (action === PLAN_ACTIONS.write || action === PLAN_ACTIONS.submit)) {
    const candidates = discoverOrchestrations({
      repoRoot: deps.repoRoot,
      recorded: conflict,
      channelDirNames: () => deps.channelDirNames(),
    });
    return fail(
      `review-gate: 本仓库记录的是另一个编排（${conflict}），本会话持有的是 ` +
      `${deps.runtime().orchestrationId}。在把这件事定下来之前，不能改写或提交 plan——` +
      "否则会出现两个项目经理对着同一份 plan 派活。\n\n" +
      buildTakeoverRoute({ candidates, attempting: `plan 的 ${action}` }),
      { approved: false, identityConflict: conflict },
    );
  }

  if (action === PLAN_ACTIONS.write) {
    // strictRepo: WRITING a plan requires every task to declare `repo` (the
    // child's cwd). The READ path (readPlanFile) stays lenient so legacy
    // plans without the field keep loading.
    const parsed = parsePlan(params.plan, nowIso, true);
    if (!parsed.ok || !parsed.plan) {
      return fail(
        "review-gate: plan 不合法，没有写入：\n" + parsed.problems.map((p) => `  - ${p}`).join("\n"),
        { problems: parsed.problems },
      );
    }
    // ROUND-4 P1 — the execution record survives the rewrite. `write` replaces
    // the approved CONTENT; it has no business resetting statuses that
    // `set-status` produced (twice measured: two merged tasks reported as
    // never started).
    const previous = deps.readPlan().plan;
    const next = mergeTaskProgress(previous, parsed.plan);
    deps.savePlan(next);

    // ROUND-4 P0 — DOES THIS EDIT NEED THE USER AT ALL? Recomputing the hash
    // (rather than trusting a stored one) is what makes "I edited it a bit"
    // fail. But an edit that GRANTS NOTHING NEW is not the thing the approval
    // protects against, and treating it as one is what woke a human up for
    // every task dispatched. So: identical content keeps the approval,
    // narrowing content keeps it and records why, and only a genuine widening
    // revokes it.
    const runtime = deps.runtime();
    const nextHash = planHash(next);
    if (runtime.approvedPlanHash === nextHash) {
      return reply(
        `review-gate: plan 已写入 ${PLAN_RELPATH}。\n` + formatPlanSummary(next) +
        "\n\n内容与已批准的版本一致，批准仍然有效。",
        { approved: true },
      );
    }
    // UNDOING A WIDENING IS NOT A NEW GRANT (round-8). This content was
    // already authorized under the live approval — the user signed it, or a
    // carry that granted nothing new moved onto it — so writing it back
    // restores the approval instead of costing a goal-auditor round plus a
    // dialog for a keystroke somebody took back. It runs BEFORE the
    // widening analysis on purpose: the analysis compares against whatever
    // the approval currently holds, which after a revocation is nothing at
    // all, and it has no way to see that these exact bytes were signed.
    if (lineageAuthorizes(runtime.approvedPlanHistory, nextHash)) {
      const restored = formatApprovalRestored(nextHash);
      // The SNAPSHOT and the timestamp come back with the hash. A hash alone
      // would leave the next plan edit facing "the gate has no authorizing
      // snapshot" and asking the user again — the very dialog this path
      // exists to save.
      deps.saveRuntime({
        ...runtime,
        approvedPlanHash: nextHash,
        approvedPlanAt: nowIso,
        approvedPlan: snapshotApprovedPlan(next, nextHash, nowIso),
        approvedPlanHistory: extendApprovalLineage(runtime.approvedPlanHistory, nextHash),
        approvalAmendments: [
          ...(runtime.approvalAmendments ?? []),
          { at: nowIso, changes: [restored] },
        ],
      });
      deps.log(`orchestrator plan approval RESTORED to ${nextHash} (content was already authorized)`);
      return reply(
        `review-gate: plan 已写入 ${PLAN_RELPATH}。\n` + formatPlanSummary(next) + "\n\n" +
        formatApprovalAmendments([restored]),
        { approved: true, amended: true, restored: true, amendments: [restored] },
      );
    }
    if (!runtime.approvedPlanHash) {
      return reply(
        `review-gate: plan 已写入 ${PLAN_RELPATH}。\n` + formatPlanSummary(next) +
        "\n\n尚未获得用户批准 —— 用 `orchestrator_plan({ action: \"submit\" })` 提交批准后才能 spawn。",
        { approved: false },
      );
    }
    const carry = runtime.approvedPlan
      ? decideApprovalCarry(runtime.approvedPlan, next)
      : { carries: false, widenings: ["门禁没有已批准 plan 的授权快照（记录不可读或来自更早的版本），无法证明这次改动没有扩权"], amendments: [] };
    if (carry.carries) {
      // The approval MOVES to the new content: the hash is what every later
      // check compares against, so leaving it on the old text would refuse
      // the very plan that was just judged harmless.
      deps.saveRuntime({
        ...runtime,
        approvedPlanHash: nextHash,
        approvedPlan: snapshotApprovedPlan(next, nextHash, runtime.approvedPlan?.at ?? nowIso),
        // The content the approval just moved onto joins its lineage, so
        // taking a LATER edit back lands here rather than at the user.
        approvedPlanHistory: extendApprovalLineage(runtime.approvedPlanHistory, nextHash),
        approvalAmendments: [
          ...(runtime.approvalAmendments ?? []),
          { at: nowIso, changes: carry.amendments },
        ],
      });
      // B2 — carrying an approval across an edit is a decision the gate makes
      // ON THE USER'S BEHALF. `approvalAmendments` records it in the sidecar,
      // which the next session to open this repo wipes; the audit log is the
      // copy that outlives it, and it names WHICH content the approval moved to.
      deps.log(
        `orchestrator plan approval carried to ${nextHash} (from ${runtime.approvedPlanHash}): ` +
        carry.amendments.join(" / "),
      );
      return reply(
        `review-gate: plan 已写入 ${PLAN_RELPATH}。\n` + formatPlanSummary(next) + "\n\n" +
        formatApprovalAmendments(carry.amendments) +
        "\n（这条迁移已记进 runtime 的 approvalAmendments，用户随时可以查为什么没被问。）",
        { approved: true, amended: true, amendments: carry.amendments },
      );
    }
    // The three approval fields go; `approvedPlanHistory` deliberately STAYS
    // (it is what lets the next write take this widening back without a
    // dialog, and every content in it was authorized before this edit).
    deps.saveRuntime({ ...runtime, approvedPlanHash: undefined, approvedPlanAt: undefined, approvedPlan: undefined });
    // B2 — a REVOCATION is the other half of the same story: the plan on disk
    // now grants more than the user agreed to, and until they are asked again
    // nothing may spawn. Logged with the reasons, so "why did it stop being
    // approved" survives the sidecar.
    deps.log(
      `orchestrator plan approval REVOKED (widening ${runtime.approvedPlanHash} -> ${nextHash}): ` +
      carry.widenings.join(" / "),
    );
    return reply(
      `review-gate: plan 已写入 ${PLAN_RELPATH}。\n` + formatPlanSummary(next) + "\n\n" +
      formatApprovalWidenings(carry.widenings),
      { approved: false, widenings: carry.widenings },
    );
  }

  // -------------------------------------------------------------------------
  // ARCHIVE — "this orchestration is over, I am starting a new one" (B1)
  // -------------------------------------------------------------------------
  //
  // The alternative that existed before this action was a project manager
  // typing `rm .pi/orchestrator-plan.json`, because entering the role was
  // refused while somebody else's plan was in the repo and nothing could put
  // that plan away. Three sessions did exactly that, one of them the
  // supervisor. So: the gate does it, it ARCHIVES rather than deletes, and it
  // asks the user first — the plan being put away is one they approved.
  //
  // IT RUNS BEFORE THE PLAN HAS TO PARSE, and that placement is load-bearing.
  // Below this point an unreadable plan file returns "the plan file does not
  // validate" and nothing else happens. Put the archive down there and a
  // repo with a CORRUPT plan plus another orchestration's runtime would be
  // sealed shut again: `write` is refused by the identity guard above,
  // `archive` would be refused by the parser, and `rm` would be the only move
  // left — the exact dead end this whole action exists to remove. Nothing is
  // lost by not parsing: `archivePlanFile` renames the original file beside
  // the record, so the bytes survive even when their meaning did not.
  if (action === PLAN_ACTIONS.archive) {
    // WHAT IS THERE TO PUT DOWN? The plan and the registry die separately —
    // a repo left over from the `rm` era has a registry and no plan — so
    // either half is enough to have work to do here, and neither is a
    // precondition for the other.
    // ONE read of the file, not two: the second one could see a different
    // file (the plan is an ordinary file another session may be writing), and
    // then "is there a plan" and "what is the plan" would disagree.
    const read = deps.readPlan();
    const existing = read.plan;
    const recorded = deps.recordedRuntime();
    // An UNPARSEABLE plan file is still a plan file to be put away — that is
    // the whole reason this action runs before the validation gate.
    const planFilePresent = existing !== undefined || read.problems.length > 0;
    if (!planFilePresent && !recorded) {
      return fail(
        "review-gate: 本仓库没有什么可归档的 —— 既没有 `.pi/orchestrator-plan.json`，" +
        "门禁记录里也没有上一轮编排的登记表。直接 `orchestrator_plan({action:\"write\"})` " +
        "写这一轮自己的 plan 就行。",
        { archived: false },
      );
    }
    // LIVE CHILDREN VETO. The registry on DISK is the one that matters here:
    // it belongs to the orchestration being put down, not to this session
    // (which may hold a different id entirely). A pane that is still alive
    // means somebody is still working under that plan — archiving it would
    // strand them, and the honest move is a takeover instead.
    const panes = alivePanes(deps);
    const openChildren = (recorded?.children ?? []).filter((child) => !child.closedAt);
    const stillAlive = panes.ok
      ? openChildren.filter((child) => panes.panes.includes(child.paneId))
      : [];
    if (stillAlive.length > 0) {
      return fail(
        `review-gate: 这一轮编排还有 ${stillAlive.length} 个子会话活着` +
        `（${stillAlive.map((c) => `${c.id}@${c.paneId}`).join("、")}）—— 不归档。\n` +
        "它们正在这份 plan 下干活，归档会把它们晾在没有主管的状态。要接手它们，用 " +
        `\`orchestrator_attach({ orchestrationId: "${recorded?.orchestrationId ?? ""}" })\`；` +
        "确实要放弃，先 `orchestrator_close` 掉它们再归档。",
        { archived: false, liveChildren: stillAlive.length },
      );
    }

    const archivePath = planArchiveRelPath(nowIso);
    // THE USER DECIDES (2026-09-06, their answer to the design question).
    // The gate's one dialog template (2026-09-08) makes that literal: no UI
    // means no row is picked, which reads as "not archived", and the decline
    // row lets the user say WHY they are keeping it.
    const archiveSpec: ChoiceSpec = {
      title: ARCHIVE_CONFIRM_TITLE,
      options: ["归档", "不归档"],
      recommended: "不归档",
    };
    const archivePick = parseChoice(
      await deps.askChoice(archiveSpec, {
        body: buildArchiveConfirmMessage({
          ...(existing ? { plan: existing } : {}),
          archivePath,
          liveChildren: openChildren.length,
        }),
      }),
      archiveSpec,
    );
    if (!(archivePick.kind === "chose" && archivePick.option === "归档")) {
      return fail(
        "review-gate: 用户没有同意归档（或当前环境没有可用的对话框）——什么都没有动，plan 还在原处。" +
        (archivePick.kind === "declined" && archivePick.reason
          ? `\n他的意见：${archivePick.reason}`
          : "") +
        "\n另一条路仍然可用：`orchestrator_attach` 接管这份 plan 所属的编排。",
        { archived: false },
      );
    }

    const written = deps.archivePlan(
      archivePath,
      buildPlanArchive({
        ...(existing ? { plan: existing } : {}),
        ...(recorded ? { runtime: { orchestrationId: recorded.orchestrationId, children: recorded.children } } : {}),
        at: nowIso,
        by: deps.runtime().orchestrationId,
      }),
    );
    if (!written.ok) {
      return fail(
        `review-gate: 归档写不出来（${written.error}）—— plan 原封不动留在 ${PLAN_RELPATH}。`,
        { archived: false },
      );
    }
    // THE RUNTIME GOES WITH IT. Leaving the old registry in the sidecar would
    // leave `runtimeConflict` refusing every spawn of the NEW orchestration
    // forever — the session would have tidied itself into a corner it cannot
    // leave. It is not lost: the archive file above holds a copy.
    deps.saveRuntime(emptyRuntime(deps.runtime().orchestrationId));
    deps.log(
      `orchestrator plan archived to ${written.path} ` +
      `(plan hash ${existing ? planHash(existing) : "none"}, previous orchestration ${recorded?.orchestrationId ?? "none"})`,
    );
    // SAYS ONLY WHAT HAPPENED (reviewer P2, round 2). The two halves are
    // archivable separately, so a reply that always claims a plan was moved
    // and a file renamed is wrong on the registry-only path — the one a repo
    // from the `rm` era is actually in.
    const moved = [
      ...(planFilePresent ? ["plan"] : []),
      ...(recorded ? ["编排登记表"] : []),
    ].join(" + ");
    return reply(
      `review-gate: 已归档 ${moved} → ${written.path}（**没有删除任何东西**` +
      (planFilePresent ? `，原 ${PLAN_RELPATH} 已改名留在归档旁边` : "") +
      ")。\n" +
      (planFilePresent
        ? `${PLAN_RELPATH} 已让出来了 —— 现在可以 \`orchestrator_plan({action:"write"})\` 写这一轮自己的 plan，`
        : "本仓库本来就没有 plan 文件；现在门禁记录也干净了 —— `orchestrator_plan({action:\"write\"})` 写这一轮自己的 plan，") +
      "再 `submit` 请用户批准。",
      { archived: true, path: written.path, archivedPlan: planFilePresent, archivedRuntime: Boolean(recorded) },
    );
  }

  const { plan, problem } = currentPlan(deps);
  if (problem) return problem;

  if (action === PLAN_ACTIONS.submit) {
    if (!plan) return fail("review-gate: 还没有 plan 可提交 —— 先用 action:\"write\" 写一份。");

    // THE REQUIREMENT RESTATEMENT COMES FIRST (2026-09-06, user ask) — even
    // before the audit, because it is the earlier step in the same story: the
    // project manager says the requirement back, the user confirms it, and
    // only then is a plan worth auditing. Checking it after a minutes-long
    // audit would bill the user for a plan built on an unverified reading.
    // No dialog is rendered — same shape as a failed audit.
    if (!restatementConfirmed(deps.restatement())) {
      return fail(buildRestatementMissingRefusal("orchestrator_plan"), { approved: false, restated: false });
    }

    // THE AUDIT RUNS INSIDE SUBMIT, and it runs FIRST (user requirement,
    // 2026-08-30). The asymmetry it closes: a loop goal could not reach the
    // user without a `goal-auditor` PASS, while a plan — which decides what
    // several children may touch and how many run at once — went straight to
    // the human. The shape is copied from `propose_loop_goal` deliberately
    // (philosophy two): ONE call builds the task, dispatches the judge, waits,
    // adjudicates and records. A failed audit hands the objections back and
    // NO DIALOG IS SHOWN — the user is never asked to sign something an
    // independent reader has already objected to.
    onUpdate?.step?.("plan 审计中（goal-auditor 独立进程，分钟级）");
    const audit = await deps.auditPlan(plan, undefined, signal);
    onUpdate?.done?.(audit.ok ? "plan 审计通过" : "plan 审计未过");
    if (!audit.ok) {
      return fail(audit.text, { approved: false, audited: false });
    }

    // O-1 — the FULL plan goes to the transcript first, and the dialog then
    // points at it. A plan approval binds to CONTENT (tasks, repos,
    // dependencies, parallelism), and the dialog body is capped at a couple
    // of dozen rendered rows: the measured result was a user being asked to
    // sign a six-task plan whose last four tasks had been cut off, with
    // nothing telling them where to read the rest. The loop goal has done it
    // this way from the start (buildGoalTranscriptMessage → dialog + pointer).
    deps.showToUser(PLAN_CONFIRM_TITLE, buildPlanTranscriptMessage(plan));
    const planSpec: ChoiceSpec = {
      title: PLAN_CONFIRM_TITLE,
      options: [PLAN_APPROVE_LABEL, "不批准，退回重写"],
      recommended: PLAN_APPROVE_LABEL,
      declineRow: REVISE_ROW,
    };
    const planPick = parseChoice(
      await deps.askChoice(planSpec, {
        body: buildPlanConfirmMessage(plan),
        pointer: PLAN_DIALOG_POINTER,
      }),
      planSpec,
    );
    const granted = planPick.kind === "chose" && planPick.option === PLAN_APPROVE_LABEL;

    if (!granted) {
      return fail(
        "review-gate: 用户没有批准这份 plan。" +
        (planPick.kind === "declined" && planPick.reason
          ? `他的意见：${planPick.reason}。`
          : "") +
        "按他的意见改完再提交一次（他的答复可能在聊天里，也可能要你用 `ask_user` 追问）。",
        { approved: false },
      );
    }
    const hash = planHash(plan);
    deps.saveRuntime({
      ...deps.runtime(),
      approvedPlanHash: hash,
      approvedPlanAt: nowIso,
      // WHAT was approved, not just its fingerprint — this is what later lets
      // a narrowing edit skip the dialog instead of waking the user again.
      approvedPlan: snapshotApprovedPlan(plan, hash, nowIso),
      approvalAmendments: [],
      // A FRESH DECISION REPLACES EVERY EARLIER ONE. The lineage restarts at
      // this content, so a plan the user just NARROWED can never be written
      // back to a wider version that an earlier approval had carried to.
      approvedPlanHistory: beginApprovalLineage(hash),
    });
    // B2 — WHO / WHEN / against WHICH content, in the log the two sibling
    // approvals already write to. The sidecar holds the same facts but does
    // not survive the next session opening this repo.
    deps.log(
      `orchestrator plan approved by the user (hash ${hash}, ${plan.tasks.length} tasks, ` +
      `station ${plan.deliveryStation ?? "precommit"})`,
    );
    return reply("review-gate: plan 已获用户批准，可以开始 `orchestrator_spawn`。", { approved: true });
  }


  // (The ARCHIVE action is handled ABOVE, before the plan file has to parse.)


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
      "每个任务都必须声明 repo（该任务工作的仓库绝对路径），子会话的 cwd 与串行调度都靠它。",
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
      "\"read\" (default), \"write\" (replace the plan; every task MUST declare repo), " +
      "\"submit\" (the gate AUDITS the plan with a judge process first — minutes-long — and only " +
      "asks the USER to approve it if the audit passes; a failed audit comes back as findings " +
      "with no dialog shown, so fix them and submit again), \"set-status\" (move one task through " +
      "the state machine — `write` never changes a status), \"add-decision\" / \"resolve-decision\" " +
      "(questions only the human can settle), \"archive\" (a PREVIOUS orchestration's plan is in " +
      "this repo and you are starting a new round: the gate moves it aside — plan AND child " +
      "registry — into a timestamped file in `.pi/`, asks the user first, and NEVER deletes " +
      "anything; it refuses while a registered child pane is still alive and points you at " +
      "`orchestrator_attach` instead). WHAT `write` DOES TO THE APPROVAL: it keeps it for " +
      "edits that grant nothing new — a dropped task, an added dependency, " +
      "parallel→serial, a lower maxParallel, a lowered deliveryStation — and records why. " +
      "It REVOKES it for a new task, a change of a task's repo, a removed dependency, " +
      "serial→parallel, a higher maxParallel or a raised deliveryStation. " +
      "So refine the task list freely as you learn where the work lands; only real widening costs " +
      "the user a dialog. " +
      "REQUIRED BEFORE `submit`: a restatement the USER confirmed (`propose_restatement`) — " +
      "without one submit refuses outright and shows no dialog. `deliveryStation` says where the " +
      "whole orchestration stops (" + DELIVERY_STATION_CHOICES + ", default precommit); raising " +
      "it is a widening like any other.",

    parameters: Type.Object({
      action: Type.Optional(Type.Enum(PLAN_ACTIONS)),
      plan: Type.Optional(Type.Object({
        title: Type.String({ description: "Plan title (required for write)" }),
        intent: Type.String({ description: "One-line intent (required for write)" }),
        maxParallel: Type.Optional(Type.Number({ description: "Parallelism cap (default 2)" })),
        deliveryStation: Type.Optional(Type.String({
          description:
            "Where this orchestration stops: " + DELIVERY_STATION_CHOICES +
            " (default precommit — the user commits). Ask the user; do not pick for them.",
        })),
        tasks: Type.Array(Type.Object({
          id: Type.String({ description: "Task id, [A-Za-z0-9._-] 1-64 chars" }),
          title: Type.String({ description: "Task title" }),
          repo: Type.String({ description: "ABSOLUTE path of the repo this task works in (the child's cwd) — REQUIRED since 2026-09-02; a missing repo silently lands the child in the orchestrator's own repo" }),
          dependsOn: Type.Optional(Type.Array(Type.String())),
          execution: Type.Optional(Type.Union([Type.Literal("serial"), Type.Literal("parallel")])),
          status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("blocked")])),
          note: Type.Optional(Type.String()),
        })),
        decisions: Type.Optional(Type.Array(Type.Object({
          id: Type.String(),
          question: Type.String(),
          planEffect: Type.Optional(Type.String()),
        }))),
      }, {
        description:
          "For action=\"write\": { title, intent, maxParallel?, tasks: [{ id, title, " +
          "repo: \"/abs/path/to/repo\", dependsOn?: [], execution?: \"serial\"|\"parallel\" }] }. " +
          "Do NOT send `status`: existing tasks keep the status execution gave them (use " +
          "\"set-status\"), and only a genuinely new task starts at `pending`. " +
          "Pass the plan as a plain OBJECT — never a JSON string or a nested wrapper.",
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
    async execute(_id, params, signal, onUpdate) {
      const refusal = requireOrchestratorMode(deps);
      if (refusal) return refusal;
      return handlePlanAction(deps, params, onUpdate as { step?: (t: string) => void; done?: (t: string) => void } | undefined, signal as AbortSignal | undefined);
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
