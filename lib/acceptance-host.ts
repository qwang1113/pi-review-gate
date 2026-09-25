/**
 * L9: THE ACCEPTANCE ROUND, ARMED AT COMPLETION — moved out of
 * `extensions/review-gate.ts` (t7, wave 3 of the split). `declare_done`
 * calls `armAcceptanceRound`; everything it decides per repo is
 * `acceptanceStepForRepo`, and the decision itself is
 * lib/acceptance-round.ts's (`acceptanceDecision`). The round rides the one
 * dispatch engine (lib/judge-round-dispatch.ts); its verdict is recorded by
 * lib/sibling-verdict-host.ts.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  acceptanceDecision,
  acceptanceGateOpen,
  acceptanceProblems,
  buildAcceptanceTask,
  extractAcceptancePlan,
  parseNoAcceptanceDeclaration,
  type AcceptanceDecision,
} from "./acceptance-round.ts";
import { computeFingerprint } from "./fingerprint.ts";
import type { GateState } from "./gate-state.ts";
import { paneIdUsable, tmuxServerFrom, type JudgeEntry } from "./hierarchy.ts";
import { judgePaneAlive } from "./judge-pane.ts";
import type { JudgeDispatch } from "./judge-round-dispatch.ts";
import type { LoopGoal } from "./loop-goal.ts";
import type { LoopStage } from "./loop-stages.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import { buildRejection } from "./rejection-copy.ts";
import { buildStreamDirective } from "./review-stream.ts";
import type { ReviewTarget } from "./review-target-host.ts";
import type { SessionHost } from "./session-host.ts";

export function createAcceptanceHost(
  host: SessionHost,
  deps: {
    reviewTargets: Map<string, ReviewTarget>;
    runTmux: TmuxRunner;
    stageIsOn(stage: LoopStage, root?: string): boolean;
    repoLabel(root: string): string;
    loopGoalConfirmed(root: string, st: GateState): boolean;
    readSessionLoopGoal(root: string): LoopGoal;
    loopGoalPathIn(root: string): string;
    /** lib/judge-round-settle.ts */
    judgeChildByRole(root: string, role: string): JudgeEntry | undefined;
    /** lib/judge-round-dispatch.ts */
    dispatchJudgeRound(opts: { root: string; role: string; title: string; task: string; streamPath?: string }): Promise<JudgeDispatch>;
  },
) {
  const {
    reviewTargets, runTmux, stageIsOn, repoLabel, loopGoalConfirmed, readSessionLoopGoal,
    loopGoalPathIn, judgeChildByRole, dispatchJudgeRound,
  } = deps;
  const stateForRepo = (root: string) => host.stateFor(root);
  const persistRepo = (ctx: ExtensionContext, root: string) => host.persistRepo(ctx, root);

  /**
   * THE GOAL THAT GOVERNS THE ACCEPTANCE ROUND — the ONE read of it.
   *
   * BOTH halves of the round read THIS: the “no real acceptance this round”
   * declaration and the acceptance plan handed to the judge. A goal that is
   * not IN FORCE is not this round's contract — a leftover `.pi/loop-goal.md`
   * from an earlier task, or an unapproved draft, could otherwise EXEMPT the
   * round from real acceptance or hand the judge a checklist nobody agreed to,
   * and with the goal stage switched OFF there is no approval requirement left
   * to notice such a file (`lib/loop-goal.ts`'s stage-off directive says out
   * loud that such a file is not this session's contract). `undefined` = no
   * contract for this round, and then there is no plan to work either.
   */
  function acceptanceGoalText(root: string, st: GateState): string | undefined {
    const goal = readSessionLoopGoal(root);
    if (!goal.present || !loopGoalConfirmed(root, st)) return undefined;
    // THE RAW FILE, NOT THE PROMPT COPY (real-session P1, 2026-09-22).
    // `goal.text` is capped at `LOOP_GOAL_MAX_CHARS` for prompt injection, and
    // the acceptance plan is the LAST section of the skeleton — measured on the
    // round that found this: a 3130-character goal with「真实验收方案」at offset
    // 2164, so the capped copy ends before it, `extractAcceptancePlan` answers
    // undefined, `hasPlan` is false and the acceptance round is SILENTLY
    // SKIPPED as “no approved plan” — the stricter gate released by a size
    // limit. The approval above already proved this file readable, so read it
    // whole; unreadable stays unapproved, the same fail-closed rule.
    try {
      return readFileSync(loopGoalPathIn(root), "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * IS THE DISPATCHED ACCEPTANCE ROUND'S PANE STILL THERE?
   *
   * `false` is what lets `acceptanceDecision` re-dispatch instead of waiting
   * for a report nobody will write. `undefined` (no own pane, an unverifiable
   * pane id) is NOT "dead": killing or replacing a pane on a guess is worse
   * than waiting, and `judge_recover` remains the explicit way out.
   */
  function acceptanceRoundAlive(root: string): boolean | undefined {
    const entry = judgeChildByRole(root, "acceptance");
    if (!entry) return false;
    const tmuxServer = tmuxServerFrom(process.env);
    if (!entry.paneId || !paneIdUsable(entry, tmuxServer)) return undefined;
    return judgePaneAlive((argv) => runTmux(argv), entry.paneId) === true;
  }

  /**
   * DISPATCH THE ACCEPTANCE ROUND — the gate's own, from completion.
   *
   * The round rides the EXISTING engine (`dispatchJudgeRound`): it gets the
   * same session-id derivation, the same pane, the same channel and the same
   * `settleAuditRound` closing path every other judge has, which is why this
   * function is a task builder and a bookkeeping write and nothing else. The
   * AWAITING record is written BEFORE anything can ask again: it is what makes
   * the second `declare_done` wait rather than dispatch beside a judge that is
   * already working.
   */
  async function dispatchAcceptanceRound(
    ctx: unknown,
    /** The repo this round runs in — one round per repo the session edited. */
    root: string,
    fingerprint: string,
    goalText: string,
  ): Promise<{ ok: true; judgeId: string } | { ok: false; error: string }> {
    const target = reviewTargets.get(root);
    const stamp = fingerprint !== "" ? fingerprint.slice(0, 12) : String(Date.now());
    const streamPath = pathJoin(root, ".pi", "review-stream", `acceptance-${stamp}.jsonl`);
    try { mkdirSync(pathJoin(streamPath, ".."), { recursive: true }); } catch { /* the stream is optional */ }
    const task = `${buildAcceptanceTask({
      repoRoot: root,
      goalText,
      ...(target === undefined
        ? {}
        : { range: `${target.baseline.slice(0, 12)}..${target.head.slice(0, 12)}` }),
      ...(target?.files === undefined ? {} : { files: target.files }),
    })}\n\n${buildStreamDirective(streamPath)}`;
    const d = await dispatchJudgeRound({
      root,
      role: "acceptance",
      title: `acceptance-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`,
      task,
      streamPath,
    });
    if (!d.ok) return { ok: false, error: d.error ?? "dispatch failed" };
    const judgeId = d.judgeId ?? d.sessionId;
    // A successful dispatch without an id would leave the round unaddressable —
    // a gate defect, reported instead of written down as a promise.
    if (judgeId === undefined) return { ok: false, error: "dispatch 没有返回 judge id（门禁自身的缺陷）" };
    const st = stateForRepo(root);
    st.acceptance = {
      status: "AWAITING",
      at: new Date().toISOString(),
      judgeId,
      ...(fingerprint === "" ? {} : { fingerprint }),
      reason: "验收轮已派出",
    };
    persistRepo(ctx as unknown as ExtensionContext, root);
    return { ok: true, judgeId };
  }

  /**
   * THE COMPLETION-TIME ACCEPTANCE STEP.
   *
   * Returns a tool reply when completion must NOT be accepted — a round was
   * just dispatched, a verdict blocks, or the dispatch itself failed — and
   * `undefined` when the acceptance question does not stand in the way.
   *
   * DELIBERATELY NOT IN `unmetRequirements` (lib/gate-state.ts). That function
   * is the SHIP authority the git hooks read, and an acceptance requirement
   * there would block its own remedy: fixing an acceptance finding needs a
   * commit, and the commit would still be waiting on acceptance. The Copilot
   * cycle (lib/copilot-review.ts) is held the same way, on completion only.
   */
  async function armAcceptanceRound(
    ctx: unknown,
    progress: { step?: (t: string) => void; fail?: (t: string) => void },
    /** Skip reasons worth telling the human — see the skip branch below. */
    notes: string[] = [],
  ) {
    const sessionRepos = host.repos().all;
    // EVERY REPO THIS SESSION EDITED, each judged on its own facts
    // (2026-09-22). The record was always per-repo (`stateForRepo(root)`), and
    // so are the goal, the fingerprint and the code-change flag — reading only
    // the primary's `hasCodeChange` recorded 「SKIPPED —— 本轮没有代码改动」, a
    // reason that was simply not true, for a session whose code lived in a
    // secondary repo. One refusal is returned for all of them, each problem
    // labelled with its repo when there is more than one.
    const results: Array<{ root: string; problems: string[]; armed: boolean; judgeId?: string }> = [];
    for (const root of [...sessionRepos]) {
      const outcome = await acceptanceStepForRepo(ctx, root, progress, notes);
      if (outcome !== undefined) results.push({ root, ...outcome });
    }
    if (results.length === 0) return undefined;
    const problems = results.flatMap((r) => r.problems);
    const armedRows = results.filter((r) => r.armed);
    const armed = armedRows.length > 0;
    const judgeId = results.find((r) => r.judgeId !== undefined)?.judgeId;
    // WHICH REPO THE AGENT MUST NAME WHEN IT WAITS (reviewer P2 + quality round
    // P2, 2026-09-22): `judge_wait` REFUSES to guess once a session has edited
    // more than one repo (lib/repo-resolve.ts), so a copy line that says
    // `judge_wait({role:"acceptance"})` is a dead end in exactly the sessions
    // this per-repo aggregation is for. And an armed repo beside a blocking one
    // means BOTH have to be dealt with — the acceptance READY does not clear
    // the other repo's problem.
    const waitLine = (rows: typeof armedRows): string => {
      if (rows.length === 1 && sessionRepos.size === 1) {
        return "用 `judge_wait({role:\"acceptance\"})` 等它的结论（report 落盘后门禁会用标准报告唤醒你）";
      }
      const named = rows.map((r) => `\`judge_wait({role:"acceptance", repo:${JSON.stringify(r.root)}})\``);
      return named.length === 1
        ? `验收轮已派出（${repoLabel(rows[0]!.root)}）：用 ${named[0]} 等它的结论（多 repo 会话必须显式给 repo）`
        : `验收轮已在 ${rows.map((r) => repoLabel(r.root)).join("、")} 派出：逐个用 ` +
          "`judge_wait({role:\"acceptance\", repo:\"<该 repo 路径>\"})` 等它们的结论（多 repo 会话必须显式给 repo）";
    };
    // The tool call is ENDING without completing, so the progress line is
    // closed the same way every other refusal in `declare_done` closes it.
    progress.fail?.(armed ? "真实验收轮已派出" : "真实验收未过");
    return {
      content: [{
        type: "text" as const,
        text: buildRejection({
          what: armed
            ? "declare_done 暂不能完成 —— 真实验收轮已派出"
            : `declare_done 被拒 —— ${problems.length} 项门禁未满足`,
          why: problems.length > 0
            ? "下面是门禁**重新核对**出的未满足项（服务端复检，不看你的 summary）：\n" +
              problems.map((p) => `  - ${p}`).join("\n")
            : "门禁自己派出了 acceptance 轮，在它交卷之前这一轮不能算完成。",
          by: "agent",
          next: armed
            ? waitLine(armedRows) +
              (problems.length > 0
                ? "；**另外**上面列出的未满足项不会因为验收 READY 而消失 —— 两件事都处理干净再 declare_done。"
                : "；验收 READY 且内容没有变化时，再调一次 `declare_done` 就会完成。")
            : "按验收 findings 修 → 走一遍审查循环（`judge_submit({role:\"reviewer\"})`）→ 再 `declare_done`；" +
              "内容一改，旧的验收结论自动失效并重新验收。",
        }),
      }],
      details: {
        accepted: false,
        problems,
        ...(armed ? { acceptanceArmed: true } : {}),
        ...(judgeId === undefined ? {} : { judgeId }),
      },
      isError: true,
    };
  }

  /**
   * ONE REPO'S ACCEPTANCE STEP — the decision, its record writes and its
   * dispatch, for a SINGLE repo root.
   *
   * Extracted from `armAcceptanceRound` (2026-09-22) so that the round is
   * decided per repo: the goal, the fingerprint, the code-change flag and the
   * `acceptance` record are all per-repo facts, and a session whose code lived
   * in a secondary repo used to get a false 「本轮没有代码改动」 skip.
   *
   * Returns `undefined` when this repo owes nothing (pass or skip — the skip is
   * recorded here, with its reason), else the shape `armAcceptanceRound`
   * aggregates into one refusal.
   */
  async function acceptanceStepForRepo(
    ctx: unknown,
    root: string,
    /** Only `step` is used here: a skip the user has to act on must show up in the progress line. */
    progress: { step?: (t: string) => void },
    notes: string[],
  ): Promise<{ problems: string[]; armed: boolean; judgeId?: string } | undefined> {
    const st = stateForRepo(root);
    /** Names the repo in every problem, for the sessions that have more than one. */
    const label = host.repos().all.size > 1 ? `[${repoLabel(root)}] ` : "";
    // ONE READ FOR BOTH HALVES (quality round P2, 2026-09-22): the declaration
    // and the plan handed to the judge come from the SAME goal — and only from
    // one that is IN FORCE. `parseNoAcceptanceDeclaration` only reads TEXT, so
    // an unapproved draft or a leftover `.pi/loop-goal.md` could exempt this
    // round; read the other way, the same file could hand the judge a checklist
    // that was never approved for this round. See `acceptanceGoalText`.
    const goalText = acceptanceGoalText(root, st);
    const declared = goalText === undefined ? undefined : parseNoAcceptanceDeclaration(goalText);
    const plan = goalText === undefined ? undefined : extractAcceptancePlan(goalText);
    const fp = computeFingerprint(root);
    const fingerprint = fp.unavailable ? "" : fp.digest;
    const decision: AcceptanceDecision = acceptanceDecision({
      hasCodeChange: st.hasCodeChange,
      // TWO WAYS THIS ROUND CAN BE OFF, composed into the ONE `gateOpen` the
      // t2 module owns (2026-09-22): the dispatcher's environment value (an
      // orchestration child that is not the plan's acceptance task) and the
      // USER's stage switch. The internal semantics — DISABLED, the record, the
      // re-dispatch rules — stay lib/acceptance-round.ts's, unchanged.
      gateOpen: acceptanceGateOpen(process.env) && stageIsOn("acceptance", root),
      ...(declared === undefined ? {} : { goalSkipsAcceptance: declared.reason }),
      // NO PLAN ⇒ SKIP, never a dispatch with nothing to work from (quality
      // round P2, 2026-09-22): a judge told to work a checklist it does not
      // have can only answer BLOCKED, and no action of the agent could resolve
      // that. The module's reason names both ways out.
      ...(plan === undefined ? { hasPlan: false } : {}),
      fingerprint,
      ...(st.acceptance === undefined ? {} : { record: st.acceptance }),
      roundAlive: acceptanceRoundAlive(root),
    });
    if (decision.action === "pass") return undefined;
    if (decision.action === "skip") {
      // RECORDED, never silent — the same rule the quality round's SKIP
      // follows. Written only when it actually changes: a completion call must
      // not rewrite the sidecar on every try.
      //
      // THE REASON NAMES THE RELEVANT CAUSE (reviewer P2, 2026-09-22).
      // `acceptanceDecision` writes DISABLED for BOTH ways the gate can be off,
      // and its copy names the orchestration rule — which is the wrong story in
      // a standalone session whose USER switched the acceptance stage off. The
      // STATUS stays the module's (semantics untouched); only the recorded
      // reason is composed here, where the switch is known.
      const skippedReason = !stageIsOn("acceptance", root)
        ? "验收环节已关闭（用户设定的环节开关）—— 跳过真实验收。"
        : decision.reason;
      if (st.acceptance?.status !== decision.status || st.acceptance.reason !== skippedReason) {
        st.acceptance = {
          status: decision.status,
          at: new Date().toISOString(),
          reason: skippedReason,
        };
        persistRepo(ctx as unknown as ExtensionContext, root);
      }
      // RECORDED IS NOT ENOUGH FOR THIS ONE (quality round P2, 2026-09-22): the
      // sidecar is a file nobody reads, and a skip has to say so where the
      // outcome is read. The two STEADY-STATE skips never enter here — “no
      // code” and “the stage switched off” are excluded by the condition below
      // — so what is left is the class a user has to act on: an acceptance gate
      // he left ON, a round WITH code, released anyway (no approved plan, the
      // goal's own exemption, or a dispatcher-marked session). The note carries
      // `skippedReason`, the module's word for THIS skip.
      if (stageIsOn("acceptance", root) && st.hasCodeChange) {
        notes.push(skippedReason);
        // THE LINE STAYS GENERIC, THE REASON RIDES THE NOTE (reviewer Nit,
        // 2026-09-22): this branch is reached by THREE skips — no plan, the
        // goal's own exemption, and a dispatcher-marked session — so naming one
        // of them here would be wrong two times out of three. The reply below
        // carries `skippedReason`, which is the module's word for THIS skip.
        progress.step?.("真实验收（跳过）");
      }
      return undefined;
    }
    if (decision.action === "wait" || decision.action === "block") {
      // The projection, not a second reading of the decision: what declares
      // itself blocking is what lands in the completion problem list.
      return { problems: acceptanceProblems(decision).map((p) => label + p), armed: false };
    }
    // THE MODULE NEVER SAYS "dispatch" WITHOUT A USABLE FINGERPRINT: it blocks
    // instead (see `acceptanceDecision`'s no-fingerprint rule, lib/acceptance-round.ts),
    // so this call is only reachable with one. A second judgement here would be
    // the drift that rule exists to prevent.
    const dispatched = await dispatchAcceptanceRound(ctx, root, fingerprint, goalText ?? "");
    if (!dispatched.ok) {
      return {
        problems: [`${label}验收轮派不出去（${dispatched.error}）—— 门禁不会静默跳过它；修好之后再 declare_done。`],
        armed: false,
      };
    }
    return { problems: [], armed: true, judgeId: dispatched.judgeId };
  }

  return { armAcceptanceRound };
}
