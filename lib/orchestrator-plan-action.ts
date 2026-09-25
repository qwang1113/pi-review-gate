/**
 * WHAT EACH `orchestrator_plan` ACTION DOES — read / write / submit /
 * set-status / add-decision / resolve-decision / archive.
 *
 * The tool's registration (schema + description) is lib/orchestrator-tools.ts
 * and the approval copy the user reads is lib/orchestrator-plan-messages.ts;
 * this module is the state machine between them.
 */

import type { OrchestratorDeps, ToolReply } from "./orchestrator-deps.ts";
import { buildRestatementMissingRefusal, restatementConfirmed } from "./restatement.ts";
import { REVISE_ROW, parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
import {
  PLAN_APPROVE_LABEL,
  PLAN_CONFIRM_TITLE,
  buildPlanConfirmMessage,
  buildPlanTranscriptMessage,
} from "./orchestrator-plan-messages.ts";
import {
  applyTaskStatus,
  formatPlanSummary,
  mergeTaskProgress,
  nextDecisionId,
  parsePlan,
  planHash,
  PLAN_RELPATH,
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
import { emptyRuntime } from "./orchestrator-registry.ts";
import { describeNotifyOutcome } from "./user-notify.ts";
import {
  ARCHIVE_CONFIRM_TITLE,
  archiveNeedsConfirm,
  buildArchiveConfirmMessage,
  buildPlanArchive,
  buildTakeoverRoute,
  discoverOrchestrations,
  planArchiveRelPath,
} from "./orchestrator-takeover.ts";
// Aliased to the short local names: inside a tool module `reply`/`fail` are
// unambiguous, while the EXPORTED names stay specific enough not to collide
// with ordinary prose elsewhere in the repo.
import { alivePanes, currentPlan } from "./orchestrator-tool-kit.ts";
import { toolFail as fail, toolReply as reply } from "./tool-host.ts";

/** The actions the tool's `action` enum accepts — one spelling for schema and dispatch. */
export const PLAN_ACTIONS = {
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

/** Run one `orchestrator_plan` action (mode already checked by the caller). */
export async function handlePlanAction(
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
      ? decideApprovalCarry(runtime.approvedPlan, next, deps.repoRoot)
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
    // THE USER DECIDES — but only while some of the plan is UNFINISHED
    // (2026-09-06 for the dialog, 2026-09-22 for the exemption). A plan whose
    // every task is done strands nobody, so the box could only be answered
    // one way.
    const needsConfirm = archiveNeedsConfirm({ ...(existing ? { plan: existing } : {}), planFilePresent });
    if (needsConfirm) {
      // The gate's one dialog template (2026-09-08): no UI means no row is
      // picked, which reads as "not archived", and the decline row lets the
      // user say WHY they are keeping it.
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
      // Nobody was asked, so the receipt has to say WHAT went away: the plan
      // the user approved, by name and size.
      (!needsConfirm && existing
        ? `没有问你：《${existing.title}》的 ${existing.tasks.length} 个任务全部 done，也没有活着的子会话。\n`
        : "") +
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
        body: buildPlanConfirmMessage(plan, deps.repoRoot),
      }),
      planSpec,
    );
    const granted = planPick.kind === "chose" && planPick.option === PLAN_APPROVE_LABEL;

    // A DISMISSED box is not a rejection (user report, 2026-09-14) — same
    // reading as propose_restatement and propose_loop_goal: closing the dialog
    // without choosing means the user did not answer, usually because they were
    // saying something else. Reported as "not approved" it reads as an
    // objection, and the answer to an objection is to rewrite the plan into
    // another box.
    if (planPick.kind === "dismissed") {
      return fail(
        "review-gate: 用户没有作答这份 plan（确认框被关掉，或他在框外说了别的事）—— " +
        "**这不是被否掉**，他很可能还有话要说。\n" +
        "下一步：先把他刚说的事处理掉，然后用 `ask_user` 问一句「关于这份 plan，还有别的要改或要问的吗？" +
        "没有了我就重新提交」，得到「没有了」之后才重新 submit。",
        { approved: false, dismissed: true },
      );
    }

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
    // NO `note` LANDS ON THE TASK (2026-09-21). `set-status` used to carry one
    // and `applyTaskStatus` writes it straight onto the task — and since
    // 2026-09-17 that field IS the task book (`plan.tasks[].note`, the text a
    // child session is handed as its assignment), so a status change silently
    // OVERWROTE the instructions the plan was audited and approved for. The
    // plan has exactly one free-text field per task and the task book owns it;
    // a status reason is a log line, not a rewrite of the assignment.
    const reason = String(params.note ?? "").trim();
    const moved = applyTaskStatus(plan, taskId, status, { now: nowIso });
    if (!moved.ok) return fail("review-gate: " + moved.reason);
    deps.savePlan(moved.plan);
    if (reason) deps.log(`orchestrator task ${taskId} → ${status}: ${reason}`);
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
    // ADDING A DECISION IS ITSELF THE NOTIFICATION (user decision, 2026-09-17).
    // A decision is by definition something only the human can settle, so the
    // gate tells them NOW and marks it reported in the same breath — the two
    // used to be separate steps the manager had to perform (constraint 11),
    // which meant a decision registered but never announced blocked the exit
    // for a reason nobody could see.
    const notified = deps.notifyUser({ kind: "needs-user", detail: question });
    if (notified.status === "sent") {
      // The stamp rides the SAME write as the decision: two saves would leave
      // a window where an announced decision is not yet marked as such.
      next.decisions = next.decisions.map((d) =>
        d.id === id ? { ...d, notifiedAt: nowIso } : d,
      );
    }
    deps.savePlan(next);
    return reply(
      `review-gate: 已登记待用户决策 "${id}"（id 由门禁生成）。${describeNotifyOutcome(notified)}` +
      (notified.status === "sent" ? "" :
        "\n注意：**没通知过用户的决策项会拦住 declare_done**（约束 11），" +
        "现在这条就是没通知出去的 —— 把通知通道修好（见上面的原因），" +
        "或者用 `ask_user` 当面问他。") +
      `拿到答复后用 \`orchestrator_plan({ action: "resolve-decision", decisionId: "${id}", answer })\` 落回 plan。` +
      (planEffect ? `\n已记下这条决策一旦拍板需要的 plan 变更：${planEffect}` : ""),
      { decisionId: id, planEffect: planEffect || undefined, notified: notified.status },
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

