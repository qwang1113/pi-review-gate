/**
 * `judge_submit` — the ONE entry point for reviewer / adviser / goal-auditor.
 * The body moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split);
 * the receipts it hands back are lib/judge-submit-receipt.ts.
 *
 * SUBMITTING FOR REVIEW IS A CHAIN, and the gate runs all of it: the agent
 * describes its change, the gate proves it builds (precommit), freezes it
 * (checkpoint), computes the reviewed range (prepare) and only then
 * dispatches. Any step failing sends the round back with the reason —
 * nothing half-submitted, no manual four-step dance.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ROUND_NOTE_HINT } from "./agent-directives.ts";
import type { createAuditRoundHost } from "./audit-round-host.ts";
import type { GateState } from "./gate-state.ts";
import { SUBMITTABLE_JUDGE_ROLES } from "./judge-prompt.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import type { createJudgeRoundDispatch } from "./judge-round-dispatch.ts";
import type { LoopStage } from "./loop-stages.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { QUALITY_ROLE } from "./quality-round.ts";
import { buildRejection } from "./rejection-copy.ts";
import type { createReviewChain } from "./review-chain.ts";
import type { createReviewTargets } from "./review-target-host.ts";
import type { createRoundCancel } from "./round-cancel-host.ts";
import type { CallTool } from "./session-host.ts";
import type { SessionCells } from "./session-cells.ts";
import type { SessionRepos } from "./session-repos-host.ts";
import type { ToolHost } from "./tool-host.ts";
import { composeWithUntrustedData } from "./untrusted-data.ts";
import {
  acceptedReceipt,
  laneCancelledReviewerLine,
  noJudgesReceipt,
  type AcceptedJudge,
  type CheckpointFacts,
} from "./judge-submit-receipt.ts";
import type { RoundCancelLedger } from "./round-cancel-ledger.ts";

export interface JudgeSubmitToolDeps {
  resolveToolRepo: SessionRepos["resolveToolRepo"];
  stateForRepo(root: string): GateState;
  persistRepo(ctx: ExtensionContext, root: string): void;
  stageIsOn(stage: LoopStage, root?: string): boolean;
  callTool: CallTool;
  toolText(result: { content?: { type: string; text: string }[] }): string;
  extractTaskText(prepared: string): string;
  submitForReview: ReturnType<typeof createReviewChain>["submitForReview"];
  buildGoalAuditRound: ReturnType<typeof createAuditRoundHost>["buildGoalAuditRound"];
  dispatchJudgeRound: ReturnType<typeof createJudgeRoundDispatch>["dispatchJudgeRound"];
  cancelJudgeRound: ReturnType<typeof createRoundCancel>["cancelJudgeRound"];
  /** The tombstone a never-dispatched reviewer leaves for `judge_wait` (t8). */
  cancelLedger: Pick<RoundCancelLedger, "note">;
  noteQualityRoundDispatched: ReturnType<typeof createReviewTargets>["noteQualityRoundDispatched"];
  registry: Pick<JudgeRegistry, "pendingAudits" | "persistJudgeHierarchy">;
}

export function registerJudgeSubmitTool(host: ToolHost, cells: SessionCells, deps: JudgeSubmitToolDeps): void {
  host.registerTool({
    name: "judge_submit",
    label: "Submit To Judge",
    description:
      "Submit one round of work to a judge role — the ONE entry point for reviewer / adviser / " +
      "goal-auditor. A reviewer submission runs the chain itself, and for a round that carries " +
      // ONE ENTRY POINT FOR BOTH JUDGES OF A ROUND (2026-09-16): a round that
      // carries code starts `quality-auditor`, `reviewer` and the full precommit
      // lane together, and the cancel matrix (lib/quality-round.ts) decides who
      // stops whom. A reviewer READY that lands before the quality verdict is
      // HELD until that verdict arrives (never recorded early, never re-run).
      "code that chain starts the QUALITY round (`quality-auditor`), the functional reviewer and " +
      "the full precommit lane TOGETHER — the three judge the same commit range, so a non-READY " +
      "quality verdict kills the reviewer's pane and the lane, a non-READY reviewer kills the " +
      "quality pane and the lane, and a FAILED lane kills only the reviewer. You never call this " +
      "twice for one round, and the quality judge is not a role you can name. " +
      "The gate owns everything procedural: the session id and its directory " +
      "(derived from role+repo, so the judge's context carries across rounds), pane open vs. channel-queued vs. " +
      "fresh kill, and the channel verdict. You pass WHO and WHAT; you never pass a session id, a " +
      "title or a directory. It returns as soon as the round is SUBMITTED, not when the judge is " +
      "done — the round ends when its channel report lands, and the gate wakes you with " +
      "the standard report (verdict, evidence pointer, record note, open questions). A living pane takes the round " +
      "through its channel (nothing is silently dropped): wait for it, or pass " +
      "fresh:true to kill the pane and start over.",
    parameters: Type.Object({
      // The SUBMITTABLE subset of the judge roles — `quality-auditor` is
      // routed to by the chain, never named by the agent (lib/judge-prompt.ts).
      role: Type.Enum(SUBMITTABLE_JUDGE_ROLES),
      task: Type.String({
        description:
          "reviewer: what you changed this round, in your words (the gate wraps it in the review " +
          "task it builds). " + ROUND_NOTE_HINT + " " +
          "adviser / goal-auditor: the question or the draft to judge.",
      }),
      message: Type.Optional(Type.String({
        description:
          "reviewer only: the checkpoint commit message (English, Conventional Commits — the gate " +
          "makes it a legal one if it is not). Omit it and the gate derives the message from your " +
          "task text — but only the parts of it that are ENGLISH: L5 accepts no non-Latin letter " +
          "in a commit message, so a Chinese round note yields the default subject and no body. " +
          "Write this field whenever you want the history to say something — that is the normal " +
          "case in this project.",
      })),
      reason: Type.Optional(Type.String({
        description:
          "reviewer only: why THIS round is worth a review when the polish gate is armed (two " +
          "consecutive READYs, or the same file polished for three rounds). The gate refuses the " +
          "round without it and tells you so.",
      })),
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
      fresh: Type.Optional(Type.Boolean({
        description: "Kill the role's RUNNING process and dispatch this round anyway. Its transcript (and therefore its context) survives — this abandons the round in flight, not the conversation.",
      })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const target = deps.resolveToolRepo(params.repo as string | undefined);
      if (!target.ok) {
        return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
      }
      const root = target.root;
      // NOTHING OF ITS OWN TO REVIEW, NOTHING TO DISPATCH (2026-09-19). Under a
      // user-granted scope limit with no edits of its own this session has
      // ALREADY been told the ship gate is disarmed — but `judge_submit` still
      // ran the whole chain, and the reviewer could only ever conclude
      // BLOCKED on the branch's pre-existing content. Measured in prime's
      // t3-report-update: minutes per round, then a deadlock on `declare_done`.
      if (params.role === "reviewer") {
        const scoped = deps.stateForRepo(root);
        if (scoped.scopeLimit !== undefined && !scoped.hasCodeChange && !scoped.hasDocChange) {
          return {
            content: [{
              type: "text",
              text: buildRejection({
                what: "judge_submit 被拒 —— 本会话没有任何自己的改动，且用户已批准缩小审查范围",
                why:
                  "门禁只覆盖本会话的改动（`request_scope_limit` 已生效），而本会话在这个仓库里零 edit：" +
                  "没有东西需要审。派出去的 reviewer 只能拿到分支上**别人**的 diff，然后判出这一轮修不了的 " +
                  "finding —— 这正是 prime 的 t3-report-update 卡死的那条路。",
                by: "agent",
                next:
                  "直接收尾（`declare_done`）—— ship 拦截已经解除。若确实要审本会话以外的内容，" +
                  "先让用户 `/gate-reset` 撤掉范围限制。",
              }),
            }],
            details: { refused: "no-session-edits-under-scope-limit" },
            isError: true,
          };
        }
      }
      // NON-GIT SHORT-CIRCUIT: the review chain (precommit → checkpoint →
      // baseline..HEAD) is meaningless outside a repository, and its git
      // steps would leak fatal to the terminal. Refuse up front.
      if (!cells.sessionInGit) {
        return {
          content: [{
            type: "text",
            text: buildRejection({
              what: "judge_submit 被拒 —— 当前不在 git 仓库里",
              why: "送审链条（precommit → checkpoint → baseline..HEAD）在仓库外没有意义，git 步骤会直接报致命错误。",
              by: "agent",
              next: "换到仓库目录里再送审；如果这一轮本来就不属于任何仓库（纯调研 / 临时脚本），用 `set_gate_mode(\"explore\")` 或 `normal` 收尾。",
            }),
          }],
          details: { submitted: false },
          isError: true,
        };
      }
      const role = String(params.role ?? "");
      // The SAME constant the parameter enum is built from: a second list here
      // is how the schema and this check drifted apart (reviewer P2,
      // 2026-09-15).
      if (!Object.hasOwn(SUBMITTABLE_JUDGE_ROLES, role)) {
        return {
          content: [{
            type: "text",
            text: buildRejection({
              what: `judge_submit 被拒 —— 未知的 role "${role}"`,
              why: `agent 能指定的 judge 角色只有 ${Object.keys(SUBMITTABLE_JUDGE_ROLES).join(" / ")} 这几个；` +
                "`quality-auditor` 由门禁自己按轮次路由，不是你能点名的角色。",
              by: "agent",
              next: "把 role 换成上面列出的一个再调用一次。",
            }),
          }],
          details: { submitted: false },
          isError: true,
        };
      }
      const task = String(params.task ?? "").trim();
      if (!task) {
        return {
          content: [{
            type: "text",
            text: buildRejection({
              what: "judge_submit 被拒 —— task 是空的",
              why: "task 就是这一轮的送审说明，是 reviewer 看到的全部改动上下文；没有它，审查只能靠猜。",
              by: "agent",
              next: "用一两句话说清这轮改了什么、为什么（改了哪些文件 / 哪个行为变了 / 为什么这么做），写进 task 再调用一次。",
            }),
          }],
          details: { submitted: false },
          isError: true,
        };
      }
      // THE GOAL STAGE RELEASES THE GOAL AUDIT TOO (2026-09-22, lib/loop-stages.ts):
      // `propose_loop_goal` short-circuits when it is off, and this is the other
      // entrance to the same judge.
      if (role === "goal-auditor" && !deps.stageIsOn("goal")) {
        return {
          content: [{
            type: "text",
            text: "review-gate: goal 环节已关闭（用户设定的环节开关）—— 本轮不跑 goal 审计，也不需要协商 goal。\n" +
              "直接按用户的要求干活即可；要恢复 goal 环节，让用户重开开关（再调一次 `choose_loop_stages`）。",
          }],
          details: { submitted: false, goalStageOff: true },
          isError: true,
        };
      }
      let reviewTask = task;
      /**
       * WHICH judge this submission actually dispatches — see `submitForReview`.
       * `null` = the user switched review AND quality off, so the chain froze
       * the round and dispatched nobody (the receipt says so).
       */
      let dispatchRole: string | null = role;
      /** Printed when the quality round was skipped (docs/data-only round). */
      let skipNote: string | undefined;
      /** Printed when the quality stage is ON and the head is already judged. */
      let qualityStandingNote: string | undefined;
      /** Where THIS round's findings stream lives (criterion 1: in the return). */
      let streamPath: string | undefined;
      /**
       * THE FUNCTIONAL BRIEF OF A PARALLEL ROUND (2026-09-16): present when the
       * chain routed this submission to the quality judge, in which case the
       * reviewer starts in the same breath (see the loop below).
       */
      let parallelReviewer: { taskText: string; streamPath?: string } | undefined;
      /** WHAT THE CHAIN FROZE, for the receipt (drill F4) — reviewer chain only. */
      let checkpointFacts: CheckpointFacts | undefined;
      /** THIS round's lane, once it landed non-PASS: why (t8). */
      let laneFailure: (() => string | undefined) | undefined;
      /** Set when that lane ruled the reviewer out — before or right after its dispatch. */
      let reviewerLaneCancelled: string | undefined;
      // Live progress for the whole submission: precommit → checkpoint →
      // prepare → dispatch, so a round that stalls shows WHERE it stalled.
      const progress = createProgressReporter({
        title: `review-gate: judge_submit(${role})`,
        onUpdate: onUpdate as ToolUpdate | undefined,
      });
      if (role === "reviewer") {
        const chain = await deps.submitForReview({
          root,
          note: task,
          message: params.message ? String(params.message) : undefined,
          reason: params.reason ? String(params.reason) : undefined,
          ctx,
          progress,
        });
        if (!chain.ok) {
          return {
            content: [{ type: "text", text: chain.text }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        reviewTask = chain.taskText;
        streamPath = chain.streamPath;
        // THE CHAIN DECIDES WHICH ROUND RUNS (2026-09-15): quality, functional
        // or both is the gate's routing rule — not a role the agent can name.
        dispatchRole = chain.role;
        skipNote = chain.skipNote;
        qualityStandingNote = chain.qualityStandingNote;
        parallelReviewer = chain.parallelReviewer;
        checkpointFacts = chain.checkpoint;
        laneFailure = chain.laneFailure;
      }

      // The other two roles are the same shape: the gate builds the task the
      // judge receives from what the agent SAID.
      if (role === "goal-auditor") {
        // A goal audit streams its findings too (criterion 2). The task and its
        // stream come from the ONE assembler.
        const built = await deps.buildGoalAuditRound(task, root, ctx);
        if (!built.ok) {
          return {
            content: [{ type: "text", text: "review-gate: 本轮未受理 — goal 审计任务无法生成。\n" + built.error }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        streamPath = built.streamPath;
        reviewTask = built.task;
        // (The draft is remembered only AFTER the dispatch is accepted —
        // recording it here would let a REFUSED submission overwrite the draft
        // a still-running audit is judging.)
      }
      if (role === "adviser") {
        const prepared = await deps.callTool("prepare_adviser", { repo: root }, ctx);
        if (prepared.isError) {
          return {
            content: [{ type: "text", text: "review-gate: 本轮未受理 — adviser brief 无法生成。\n" + deps.toolText(prepared) }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        // Same ordering rule as the reviewer note: the gate's brief first, the
        // main session's question after it as untrusted data (round 5,
        // 2026-09-05: an opening question steered an adviser into an 8s READY).
        reviewTask = composeWithUntrustedData(deps.extractTaskText(deps.toolText(prepared)), [
          { tag: "main_session_question", label: "你要回答的问题（来自主会话）：", text: task },
        ]);
      }
      // ---- THE TWO JUDGES OF ONE ROUND, STARTED TOGETHER (2026-09-16) ----
      //
      // They read the same immutable `baseline..HEAD`, so neither has anything
      // to wait for. WHO STOPS WHOM is `roundCancelPlan`'s (lib/quality-round.ts);
      // the only thing this loop owns is that a round never starts HALF.
      const judges = [
        ...(dispatchRole === null ? [] : [{ role: dispatchRole, task: reviewTask, streamPath }]),
        ...(parallelReviewer === undefined
          ? []
          : [{ role: "reviewer" as const, task: parallelReviewer.taskText, streamPath: parallelReviewer.streamPath }]),
      ];
      if (judges.length === 0) {
        return noJudgesReceipt({
          qualityStageOn: deps.stageIsOn("quality", root),
          qualityStandingNote,
          skipNote,
          checkpointFacts,
        });
      }
      const accepted: AcceptedJudge[] = [];
      for (const judge of judges) {
        // THE LANE CAN LAND FIRST (t8, 2026-09-27). A suite that fails in 0.2s
        // lands while the quality pane is still booting, and the matrix's lane
        // row finds no reviewer to kill — measured: the reviewer then ran ~40s
        // on content the gate already refuses. So it is not started at all,
        // and the tombstone tells `judge_wait` what the lane row would have.
        const laneWhy = judge.role === "reviewer" ? laneFailure?.() : undefined;
        if (laneWhy !== undefined) {
          deps.cancelLedger.note(root, { role: "reviewer", judgeId: "(未派发)", why: laneWhy });
          reviewerLaneCancelled = laneWhy;
          continue;
        }
        // The title is a DISPLAY label the gate derives itself (B5: it must not
        // reach the session's directory, or every round starts a new session).
        const title = `${judge.role}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`;
        progress.step(`spawn ${judge.role}`);
        const d = await deps.dispatchJudgeRound({
          root,
          role: judge.role,
          title,
          task: judge.task,
          fresh: params.fresh === true,
          ...(judge.streamPath === undefined ? {} : { streamPath: judge.streamPath }),
          // THE ONE PERMISSION TO DISPATCH A REVIEWER WITHOUT A STANDING: this
          // submission dispatched this round's quality judge a line above, and
          // the standing is now checked at RECORD time instead.
          ...(judge.role === "reviewer" && judges.length > 1 ? { qualityRoundDispatched: true } : {}),
        });
        if (!d.ok) {
          // A KEPT PANE IS A DISPATCHED ROUND (2026-09-05) — but only when the
          // task actually reached it (`delivered`): a boot-check timeout rode in
          // on the argv, a failed channel write into a REUSED pane delivered
          // nothing (quality round P2, 2026-09-16).
          if (d.delivered === true && role === "goal-auditor") {
            deps.registry.pendingAudits.set(root, { kind: "goal", draft: task, startedAt: new Date().toISOString() });
            deps.registry.persistJudgeHierarchy();
          }
          progress.fail("spawn 失败");
          // A ROUND NEVER STARTS HALF, IN EITHER DIRECTION (functional round P2,
          // 2026-09-16) — EXCEPT WHEN THE TASK ACTUALLY REACHED THE JUDGE
          // (functional round P1 / quality P2): cancelling the judges already
          // accepted would kill a healthy quality round while this pane runs on.
          if (d.delivered !== true) {
            for (const already of accepted) {
              deps.cancelJudgeRound(root, already.role, "本轮另一个 judge 的这一个轮次没投递出去 —— 这一轮整体作废");
            }
          }
          const lead = "review-gate: judge_submit 失败 — ";
          return {
            content: [{ type: "text", text: `${lead}${d.error ?? "review pane 未能开出来"}` }],
            details: { submitted: false, busy: false },
            isError: true,
          };
        }
        // …AND IT CAN LAND WHILE THE REVIEWER'S PANE WAS OPENING, before the row
        // existed: nothing was there to kill then, so it is killed now.
        const lateWhy = judge.role === "reviewer" ? laneFailure?.() : undefined;
        if (lateWhy !== undefined) {
          deps.cancelJudgeRound(root, "reviewer", lateWhy);
          reviewerLaneCancelled = lateWhy;
          progress.done("已取消（全量 precommit 没过）");
          continue;
        }
        // THE ROUND REMEMBERS ITS OWN QUALITY JUDGE, on the target it prepared
        // — what `qualityRoundInFlight` reads.
        if (judge.role === QUALITY_ROLE && d.judgeId) deps.noteQualityRoundDispatched(root, d.judgeId);
        // ONE ROUND SENT OUT (2026-09-17, user decision): the strip's `轮 N`,
        // counted where a reviewer dispatch reached the judge (a REFUSED
        // dispatch returned above), and persisted HERE so the strip moves the
        // moment the round is submitted.
        if (judge.role === "reviewer") {
          const sent = deps.stateForRepo(root);
          sent.sentReviewRounds = (sent.sentReviewRounds ?? 0) + 1;
          deps.persistRepo(ctx as unknown as ExtensionContext, root);
        }
        accepted.push({
          role: judge.role,
          judgeId: d.judgeId ?? "(pending)",
          paneId: d.paneId ?? "(pending)",
          sessionDir: d.sessionDir ?? "(pending)",
          reused: d.reused,
          ...(judge.streamPath === undefined ? {} : { streamPath: judge.streamPath }),
        });
        progress.done(d.reused ? "已受理（续接同一会话）" : "已受理（新会话）");
      }
      // The round is ACCEPTED — only now is the audited draft on record. A
      // refused submission must never replace the draft a running audit is
      // judging: its verdict would be recorded against text no auditor read.
      if (role === "goal-auditor") {
        deps.registry.pendingAudits.set(root, { kind: "goal", draft: task, startedAt: new Date().toISOString() });
        deps.registry.persistJudgeHierarchy();
      }
      if (accepted.length === 0 && reviewerLaneCancelled !== undefined) {
        // The reviewer was the round's only judge, and the lane ruled it out.
        return {
          content: [{
            type: "text",
            text: "review-gate: 本轮没有 judge 在跑 —— checkpoint 已冻结，但全量 precommit 先落地没过。\n" +
              laneCancelledReviewerLine(reviewerLaneCancelled),
          }],
          details: { submitted: true, judges: [], laneFailed: true },
        };
      }
      return acceptedReceipt({
        reviewerLaneCancelled,
        accepted,
        dispatchRole,
        parallelReviewerStarted: parallelReviewer !== undefined,
        skipNote,
        checkpointFacts,
        streamPath,
      });
    },
  });
}
