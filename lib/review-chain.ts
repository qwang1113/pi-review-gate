/**
 * THE SUBMISSION CHAIN behind `judge_submit` and the gate's own audits, moved
 * out of `extensions/review-gate.ts` (t7, wave 3 of the split):
 * `submitForReview` (precommit lane → checkpoint → prepare → the routing rule
 * that decides which judge(s) start), and the two blocking audits
 * `runGoalAudit` / `runPlanAudit` that ride the audit-round engine.
 *
 * The lane itself is lib/precommit-lane.ts; the audit engine's deps are built
 * by lib/audit-round-host.ts. Every step still calls the TOOL's own
 * implementation through `callTool` — never a copy. The plan re-audit's
 * carryover follows the incremental contract, whose one source is
 * lib/review-carryover.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAuditRound, type RunAuditRoundDeps } from "./audit-round.ts";
import { GOAL_AUDIT_SPEC, PLAN_AUDIT_SPEC } from "./audit-round-specs.ts";
import { buildCheckpointMessage } from "./checkpoint-message.ts";
import type { LoopStage } from "./loop-stages.ts";
import type { LaneHandle } from "./precommit-lane.ts";
import { formatPlanSummary, type OrchestratorPlan } from "./orchestrator-plan.ts";
import { buildPlanAuditTask, formatPlanAuditCarryover, planAuditHash } from "./orchestrator-plan-audit.ts";
import type { ProgressReporter } from "./progress-stream.ts";
import { QUALITY_ROLE, qualityRoundSkip, qualityStandingFor, skippedQualityRecord } from "./quality-round.ts";
import type { ReviewTarget } from "./review-target-host.ts";
import { sessionDirForCwd } from "./session-dir.ts";
import type { CallTool, GateToolResult, SessionHost } from "./session-host.ts";
import { composeWithUntrustedData } from "./untrusted-data.ts";

export function createReviewChain(
  host: SessionHost,
  deps: {
    callTool: CallTool;
    toolText(result: GateToolResult): string;
    extractTaskText(prepared: string): string;
    stageIsOn(stage: LoopStage, root?: string): boolean;
    reviewTargets: Map<string, ReviewTarget>;
    /** The lane (lib/precommit-lane.ts). */
    waitForQuietLane(root: string): Promise<void>;
    startPrecommitBeside(root: string, ctx: unknown): LaneHandle;
    /** The goal-auditor's task for one draft (lib/audit-round-host.ts). */
    buildGoalAuditRound(draft: string, root: string, ctx: unknown):
      Promise<{ ok: true; task: string; streamPath: string } | { ok: false; error: string }>;
    /** The engine's deps for a synchronous round (lib/audit-round-host.ts). */
    auditRunDeps(
      ctx: unknown,
      progress: { step?: (t: string) => void; done?: (t: string) => void; fail?: (t: string) => void; tail?: (t: string) => void } | undefined,
      signal: AbortSignal | undefined,
    ): RunAuditRoundDeps;
  },
) {
  const {
    callTool, toolText, extractTaskText, stageIsOn, reviewTargets,
    waitForQuietLane, startPrecommitBeside, buildGoalAuditRound, auditRunDeps,
  } = deps;
  const stateForRepo = (root: string) => host.stateFor(root);
  const persistRepo = (ctx: ExtensionContext, root: string) => host.persistRepo(ctx, root);

  /**
   * Everything that has to happen BEFORE a reviewer can judge, run by the gate.
   *
   * The agent used to do this by hand — run_precommit, review_checkpoint,
   * prepare_review, review_spawn — four calls in a fixed order, each with its
   * own failure mode, none of them creative work. Now it says what it changed
   * and the gate does the rest, or sends the round back with the reason.
   *
   * Each step is the TOOL's own implementation (`callTool`), never a copy:
   * the mechanical checks (precommit receipt, English message, checkpoint
   * marker, baseline..HEAD) all still run exactly once, where they live.
   */
  async function submitForReview(input: {
    root: string;
    note: string;
    message?: string;
    reason?: string;
    ctx: unknown;
    /** Progress sink for the chain (each step publishes as it starts/ends). */
    progress?: ProgressReporter;
  }): Promise<
    | {
        ok: true;
        /**
         * WHICH role this chain dispatches after prepare (see the routing rule
         * below). `null` = NOTHING was dispatched: the user switched the review
         * and quality stages off, so the chain ran only what is on (the
         * precommit lane) and there is no judge to start.
         */
        role: "reviewer" | typeof QUALITY_ROLE | null;
        taskText: string;
        streamPath?: string;
        /** Present when the quality round was SKIPPED — printed to the agent. */
        skipNote?: string;
        /**
         * WHY NOTHING WAS DISPATCHED WITH THE QUALITY STAGE STILL ON (quality
         * round P2, 2026-09-22): the same `role: null` shape is also reached
         * when the current head ALREADY carries a bound quality READY, and the
         * receipt's generic “no judge was dispatched (the user's stage
         * switches)” then reads as if a stage were missing. Carrying the real
         * reason keeps the receipt honest without a second decision anywhere.
         */
        qualityStandingNote?: string;
        /**
         * THIS ROUND'S LANE, once it landed non-PASS: why (t8). Absent when no
         * lane was started (stage off / bypass). The caller reads it before
         * and after starting the reviewer — see `judge_submit`.
         */
        laneFailure?: () => string | undefined;
        /**
         * WHAT THIS CHAIN JUST FROZE (drill F4, 2026-09-20).
         *
         * `judge_submit` is the only surface the agent reads after a round is
         * submitted, and it used to name neither the commit nor the files in
         * it — so a checkpoint that swept something it should not have (F3:
         * the seeded `node_modules` symlink) left no trace anywhere the agent
         * or the user would look.
         */
        checkpoint?: { sha: string; files: string[]; leftOut: string[] };
        /**
         * THE FUNCTIONAL BRIEF OF A PARALLEL ROUND (2026-09-16). Present
         * exactly when `role` is the quality judge: the caller dispatches both
         * judges back to back, because they judge the SAME immutable range and
         * neither waits for the other. The cancel matrix
         * (`lib/quality-round.ts`'s `roundCancelPlan`) decides afterwards who
         * stops whom.
         */
        parallelReviewer?: { taskText: string; streamPath?: string };
      }
    | { ok: false; text: string }
  > {
    // 1. It has to build. A full lane, because a checkpoint that only ran the
    //    related tests cannot clear the ship gate later anyway.
    //
    //    UNLESS the user switched the precommit stage off (2026-09-22) — then
    //    there is nothing to run and nothing to wait for, and the whole lane
    //    (its spawn, its cache probe, its minutes) is skipped.
    //
    //    UNLESS the user issued a `/gate-bypass` (R-22). Then this step is
    //    SKIPPED rather than run-and-ignored: re-running a precommit that is
    //    failing for an environment reason costs minutes and changes nothing,
    //    and the whole point of the bypass is that the user already decided
    //    this round ships without it. The fact is recorded on the checkpoint
    //    and repeated to the reviewer.
    let laneField: { laneFailure?: () => string | undefined } = {};
    const precommitOn = stageIsOn("precommit", input.root);
    const bypassActive = stateForRepo(input.root).bypass.active;
    if (!precommitOn) {
      input.progress?.step("precommit（环节已关闭，跳过）");
      input.progress?.done("OFF");
    } else if (bypassActive) {
      input.progress?.step("precommit (被 /gate-bypass 覆盖，跳过)");
      input.progress?.done("BYPASSED");
    } else {
      // START IT, DO NOT AWAIT IT (B1). The freeze and the dispatch below are
      // quick, and the reviewer does not need this verdict to start judging an
      // immutable range — so the 33s lane runs BESIDE the chain instead of in
      // front of it, and the agent gets its turn back. A FAIL arrives as its
      // own follow-up message (`reportAsyncPrecommit`) and withholds the
      // round's READY; it can no longer be reported by returning early.
      //
      // …EXCEPT when an older lane is still running: then this round waits for
      // it (round-4 P2 — a joined lane would verify the WRONG content).
      input.progress?.step("precommit (full，与审查并行)");
      await waitForQuietLane(input.root);
      laneField = { laneFailure: startPrecommitBeside(input.root, input.ctx).failure };
    }

    // 2. Freeze it. The reviewed unit is a commit, and the message says so —
    //    a checkpoint must be recognizable as one in the history.
    //
    //    A CLEAN worktree is not a failure here: it means this round is
    //    already frozen (a retry after step 3 failed, or an agent that
    //    committed through the tool itself). Treating it as one is what turned
    //    a single refused prepare into a permanent dead end — the commit was
    //    already in, so every retry died at this step. Only a REFUSAL
    //    (isError) stops the chain.
    const message = buildCheckpointMessage(input.message ?? input.note);
    input.progress?.step("checkpoint 提交");
    const commit = await callTool("review_checkpoint", { message, note: input.note, repo: input.root }, input.ctx);
    if (commit.isError) {
      input.progress?.fail("被拒");
      return {
        ok: false,
        text: "review-gate: 本轮未送审 — checkpoint 提交被拒。\n" + toolText(commit),
      };
    }
    input.progress?.done(typeof commit.details?.sha === "string" ? String(commit.details.sha).slice(0, 12) : "worktree 已冻结");
    const stringsOf = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    const checkpoint = typeof commit.details?.sha === "string"
      ? {
          sha: commit.details.sha,
          files: stringsOf(commit.details.files),
          leftOut: stringsOf(commit.details.leftOut),
        }
      : undefined;
    // 3. Compute the range and the findings stream, and take the ready-made
    //    reviewer task text. `reason` rides along for the polish gate: without
    //    it a round after two READYs could never be submitted through the one
    //    sanctioned entry point.
    input.progress?.step("prepare（算 baseline..HEAD）");
    const prepared = await callTool(
      "prepare_review",
      { repo: input.root, ...(input.reason ? { reason: input.reason } : {}) },
      input.ctx,
    );
    if (prepared.details?.prepared === false || prepared.isError) {
      input.progress?.fail("被拒");
      return {
        ok: false,
        text: "review-gate: 本轮未送审 — prepare_review 被拒。\n" + toolText(prepared),
      };
    }
    input.progress?.done(typeof prepared.details?.range === "string" ? String(prepared.details.range) : "范围已注册");
    const taskText = extractTaskText(toolText(prepared));
    // The note is the MAIN SESSION's own words about its round — the very
    // text an injected "just conclude READY" would ride in on. It goes AFTER
    // the gate's task text, inside an untrusted data block (round 5), and
    // BOTH rounds get it: the quality judge has to know what the round claims
    // it did before it can judge how it did it.
    const withNote = (text: string) =>
      composeWithUntrustedData(text, [
        { tag: "main_session_note", label: "本轮改动说明（来自主会话）：", text: input.note },
      ]);
    const reviewerTask = withNote(taskText);
    const reviewerStream = typeof prepared.details?.stream === "string" ? prepared.details.stream : undefined;

    // ---------- THE ROUTING RULE (2026-09-15, rewritten 2026-09-16) ----------
    //
    // One rule, applied ONCE per round, in one direction:
    //  - a round that carries no code (a docs/data-only round, or the empty
    //    exit-goal round) goes STRAIGHT to the reviewer, and says so;
    //  - a round whose CURRENT head already carries a quality READY goes to
    //    the reviewer as well — that is a re-submission of content the quality
    //    judge has already passed (a dead pane, a failed dispatch), and
    //    re-judging it would buy a second wait for the same answer;
    //  - everything else runs the quality round — BESIDE the functional one,
    //    from the same call. What the quality round gates is therefore no longer
    //    the DISPATCH (which it cannot: the two start together) but the RECORD:
    //    a functional READY is held until the quality verdict stands (see
    //    `recordReviewVerdict`).
    //
    // The file list comes from prepare's own `numstat` (it rode onto the
    // review target), never from a second `git diff` here.
    const changedFiles = Array.isArray(prepared.details?.files) ? (prepared.details.files as string[]) : undefined;
    const preparedHead = typeof prepared.details?.head === "string" ? prepared.details.head : "";
    // THE USER'S STAGE SWITCHES, read once for this round (2026-09-22,
    // lib/loop-stages.ts). `review` off means no functional judge is started —
    // the CHECKPOINT still runs (the round is still frozen), and a quality
    // round that is on still runs alone. `quality` off is expressed as the
    // same SKIP a code-free round gets, recorded the same way, so
    // `qualityStandingFor` reads one shape and not two.
    const reviewOn = stageIsOn("review", input.root);
    const qualityOn = stageIsOn("quality", input.root);
    const skip = qualityOn
      ? qualityRoundSkip(changedFiles)
      : {
          skip: true as const,
          reason: "质量环节已关闭（用户设定的环节开关）—— 不派 quality-auditor",
        };
    const standing = qualityStandingFor({
      head: preparedHead,
      files: changedFiles,
      quality: stateForRepo(input.root).quality,
      // THE USER'S SWITCH travels with the record: a skip written while the
      // stage was off stops standing once it is back on (the rule itself is
      // lib/quality-round.ts's, read here as one input of the same judgement).
      stageOn: qualityOn,
    });
    if (!skip.skip && !standing.ok) {
      const qualityTaskText = typeof prepared.details?.qualityTask === "string" ? prepared.details.qualityTask : undefined;
      const qualityStream = typeof prepared.details?.qualityStream === "string" ? prepared.details.qualityStream : undefined;
      if (!qualityTaskText) {
        // prepare always builds it; a missing one means the tool and this
        // chain disagree about their own contract. Fail closed rather than
        // dispatching a judge with no brief.
        return { ok: false, text: "review-gate: 本轮未送审 — prepare 没有给出质量轮的任务文本（门禁内部不一致）。" };
      }
      return {
        ok: true,
        role: QUALITY_ROLE,
        taskText: withNote(qualityTaskText),
        ...laneField,
        ...(qualityStream === undefined ? {} : { streamPath: qualityStream }),
        ...(checkpoint === undefined ? {} : { checkpoint }),
        // The functional brief travels WITH it: the two judges are dispatched
        // in one breath (the caller owns the effects; this chain owns the
        // routing) — and only when the functional stage is ON: with that
        // switch off there is no second judge to start at all (user decision,
        // 2026-09-22).
        ...(reviewOn
          ? {
              parallelReviewer: {
                taskText: reviewerTask,
                ...(reviewerStream === undefined ? {} : { streamPath: reviewerStream }),
              },
            }
          : {}),
      };
    }
    if (skip.skip) {
      // Recorded, never silent: a skipped round and a judged round both end as
      // "quality is fine", and the difference must survive into the sidecar.
      const st = stateForRepo(input.root);
      const skipTarget = reviewTargets.get(input.root);
      st.quality = skippedQualityRecord({
        head: preparedHead,
        // THE SKIP CARRIES ITS TREE TOO (quality round P1, 2026-09-22): with the
        // review stage OFF the quality record IS the ship requirement, and a
        // record without a `treeSha` cannot be verified — so a docs-only SKIP
        // would have failed closed on a tree it never named. Same source the
        // verdict recorder reads (`reviewTargets`, registered by prepare).
        ...(skipTarget?.tree === undefined ? {} : { tree: skipTarget.tree }),
        // AND IT CARRIES WHY (functional round P1, 2026-09-22): the ship
        // readers accept a code-free skip and refuse a stage-off one, so the
        // cause is recorded here, where BOTH are known — `qualityOn` is false
        // exactly when the skip above was manufactured from the switch.
        cause: qualityOn ? "no-code" : "stage-off",
        reason: skip.reason ?? "",
        at: new Date().toISOString(),
      });
      persistRepo(input.ctx as unknown as ExtensionContext, input.root);
      input.progress?.done(qualityOn ? "质量轮跳过（无代码改动）" : "质量轮跳过（环节已关闭）");
    }
    if (!reviewOn) {
      // NOTHING LEFT TO DISPATCH: the functional stage is off, and a quality
      // round that was owed has already returned above. The chain still ran
      // the precommit lane and the checkpoint — those are their own switches —
      // so the round is frozen and the caller reports what it got.
      return {
        ok: true,
        role: null,
        taskText: "",
        ...laneField,
        ...(checkpoint === undefined ? {} : { checkpoint }),
        // REACHED TWO WAYS, AND THE RECEIPT MUST NOT CONFUSE THEM (quality
        // round P2, 2026-09-22): the quality stage is off (or the round is a
        // skip), OR it is ON and this head already carries a bound quality
        // READY — `standing.ok` above sent the other case to a quality
        // dispatch. The second one is not a missing stage: it is the same
        // content being judged once.
        ...(skip.skip
          ? { skipNote: skip.reason ?? "" }
          : {
              qualityStandingNote:
                "代码质量审查 quality-auditor：当前 head 已有绑定的质量结论（同一份内容不再重复派质量轮）。",
            }),
      };
    }
    return {
      ok: true,
      role: "reviewer",
      taskText: reviewerTask,
      ...laneField,
      ...(checkpoint === undefined ? {} : { checkpoint }),
      // The findings stream is the agent's half of the round: it fixes what
      // the judge confirms WHILE the judge works. Dropping the path here would
      // leave that channel written but unread.
      ...(reviewerStream === undefined ? {} : { streamPath: reviewerStream }),
      ...(skip.skip ? { skipNote: skip.reason ?? "" } : {}),
    };
  }

  /**
   * The GOAL AUDIT, run by the gate from inside `propose_loop_goal`.
   *
   * WHY THIS IS NOT A SEPARATE TOOL ANY MORE (philosophy two). The audit was
   * three calls in a fixed order — `judge_submit({role:"goal-auditor"})`,
   * wait for the process, then a recording call — and the agent had to
   * sequence them correctly every time, for a chain in which it makes no
   * decision at all. It now says only "here is the draft"; the gate builds
   * the auditor's task, runs the judge process, waits for it to exit, records
   * the verdict against the exact text it dispatched, and either continues to
   * the user's dialog or hands the objections back.
   *
   * IT BLOCKS, and that is deliberate. `propose_loop_goal` is a minutes-long
   * call now, because the alternative — return early and make the agent come
   * back — is exactly the multi-step dance this removes. The findings still
   * stream while it runs, so the draft can be fixed against real objections
   * rather than a summary at the end.
   *
   * The recording itself is unchanged and still mechanical: the verdict binds
   * to the sha256 of the audited text (only P0/P1 block), so a PASS can never
   * belong to a different draft than the one the user is about to see.
   */
  async function runGoalAudit(input: {
    root: string;
    goalText: string;
    ctx: unknown;
    progress?: ProgressReporter;
    /** The caller's abort signal — ESC must be able to stop the audit wait. */
    signal?: AbortSignal | undefined;
  }): Promise<{ ok: true } | { ok: false; text: string }> {
    const { root, goalText, ctx } = input;
    input.progress?.step("组装 goal 审计任务");
    const built = await buildGoalAuditRound(goalText, root, ctx);
    if (!built.ok) {
      input.progress?.fail("被拒");
      return { ok: false, text: "review-gate: goal 审计任务无法生成。\n" + built.error };
    }
    input.progress?.done("已生成");

    input.progress?.step("goal-auditor 审计中（这一步是分钟级的）");
    // Everything that used to be spelled out here — dispatch, remember the
    // draft only after the dispatch is accepted, wait for the ROUND (not its
    // first message), fail closed on anything else, record, close the pane the
    // gate opened itself — is `runAuditRound`. The plan audit below is the
    // same call with the other spec.
    const outcome = await runAuditRound(auditRunDeps(ctx, input.progress, input.signal), {
      spec: GOAL_AUDIT_SPEC,
      root,
      task: built.task,
      streamPath: built.streamPath,
      pending: { kind: "goal", draft: goalText, startedAt: new Date().toISOString() },
    });
    if (outcome.ok) {
      input.progress?.done("审计完成");
      return outcome;
    }
    input.progress?.fail("未通过");
    return outcome;
  }

  /**
   * THE PLAN AUDIT, run by the gate from inside `orchestrator_plan`'s submit.
   *
   * The goal audit's twin, deliberately identical in shape (philosophy two):
   * ONE call builds the auditor's task, runs the judge process, waits for it
   * to exit, reads THIS round's output, adjudicates it and records the verdict
   * against the plan's canonical hash. The orchestrator submits a plan and
   * gets back either the user's dialog or a list of objections — it never
   * sequences an audit by hand, and it never sees a half-finished one.
   *
   * WHY A PLAN NEEDS THIS AT ALL: a wrong plan is more expensive than a wrong
   * goal. It decides what several children may touch, in what order, and how
   * many run at once — a task sent to the wrong repo burns a whole round. The
   * user asked for the asymmetry (goal audited, plan not) to be closed.
   *
   * IT BLOCKS for minutes, for the same reason `propose_loop_goal` does.
   *
   * The ROLE is `goal-auditor` (user decision): the same judgement — "is this
   * contract checkable, and does it match the repository?" — so no fourth
   * role, no new agent file, no new model pin.
   */
  async function runPlanAudit(
    plan: OrchestratorPlan,
    onUpdate?: { step?: (t: string) => void; done?: (t: string) => void } | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<{ ok: true } | { ok: false; text: string }> {
    // FAIL-CLOSED AROUND THE WHOLE CHAIN. Anything unexpected in here — a
    // judge that could not be spawned, an IO error reading its output — must
    // become "the plan was not audited", never an exception that escapes into
    // the tool and leaves the orchestrator unable to tell whether a dialog is
    // about to appear.
    try {
      return await auditPlanRound(plan, onUpdate, signal);
    } catch (error) {
      return {
        ok: false,
        text:
          `review-gate: plan 审计过程本身出错了（${(error as Error).message}）——` +
          "什么都没有记录，plan **没有**被送到用户面前。直接再 `submit` 一次即可重跑。",
      };
    }
  }
  async function auditPlanRound(
    plan: OrchestratorPlan,
    onUpdate?: { step?: (t: string) => void; done?: (t: string) => void } | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<{ ok: true } | { ok: false; text: string }> {
    const root = host.repos().primary;
    const state = host.state();
    const hash = planAuditHash(plan);
    // A re-audit is handed the previous round's verdict and objections — the
    // same carryover contract the goal audit has: settled material gets a
    // consistency scan, not a re-derivation.
    const previous = state.planAudit;
    const carryover = previous && previous.hash !== hash
      ? formatPlanAuditCarryover(previous)
      : undefined;
    const task = buildPlanAuditTask(plan, {
      ...(carryover === undefined ? {} : { carryover }),
      ...(carryover !== undefined && previous?.planText ? { prevPlanText: previous.planText } : {}),
      repoRoot: root,
      ...(state.sessionId ? { sessionId: state.sessionId, sessionDir: sessionDirForCwd(host.repos().cwd) } : {}),
    });

    onUpdate?.step?.("派发 plan 审计（goal-auditor 独立 pane）");
    // The goal audit's twin, and now literally the same code: the plan differs
    // from the goal only in its spec (its wording, its title, and the fact
    // that its record binds to a canonical hash rather than a draft's text).
    return runAuditRound(auditRunDeps(host.ctx(), onUpdate, signal), {
      spec: PLAN_AUDIT_SPEC,
      root,
      task,
      pending: {
        kind: "plan",
        hash,
        planText: formatPlanSummary(plan),
        startedAt: new Date().toISOString(),
      },
    });
  }

  return { submitForReview, runGoalAudit, runPlanAudit };
}
