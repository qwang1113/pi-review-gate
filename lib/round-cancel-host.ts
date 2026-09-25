/**
 * WHAT A CONCLUDED ROUND DOES TO ITS SIBLINGS — the cancel matrix's effects
 * and the parked conclusion's re-ask, moved out of
 * `extensions/review-gate.ts` (t7, wave 3 of the split).
 *
 * The TABLE is lib/quality-round.ts's (`roundCancelPlan`) and the parked
 * READY's fate is lib/review-adjudicate.ts's (`parkedReadyFate`); this module
 * only applies them: it kills a party for real, aborts the lane, and replays
 * or retires a parked READY.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildParkedReadyReplayNotice } from "./async-precommit-report.ts";
import type { ReportConclusion } from "./channel-projection.ts";
import type { GateState } from "./gate-state.ts";
import { paneIdUsable, removeJudge, tmuxServerFrom, type JudgeEntry } from "./hierarchy.ts";
import type { JudgeCloseCtx } from "./judge-lane-host.ts";
import { judgePaneAlive } from "./judge-pane.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import type { LoopStage } from "./loop-stages.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import {
  QUALITY_ROLE,
  qualityPrecondition,
  qualityStandingFor,
  roundCancelParty,
  roundCancelPlan,
  type RoundCancelPlan,
  type RoundLanding,
} from "./quality-round.ts";
import { parkedLaneHalf, parkedReadyFate } from "./review-adjudicate.ts";
import type { ReviewTarget } from "./review-target-host.ts";
import type { RoundCancelLedger } from "./round-cancel-ledger.ts";
import type { SessionHost } from "./session-host.ts";

export function createRoundCancel(
  host: SessionHost,
  deps: {
    pi: ExtensionAPI;
    registry: Pick<JudgeRegistry, "judgeHierarchy" | "setHierarchy" | "absorbJudgeModelEvents">;
    runTmux: TmuxRunner;
    /** lib/round-cancel-ledger.ts — what judge_submit / judge_wait read once the row is gone. */
    cancelLedger: RoundCancelLedger;
    reviewTargets: Map<string, ReviewTarget>;
    stageIsOn(stage: LoopStage, root?: string): boolean;
    laneVerificationWaived(root: string, st?: GateState): boolean;
    /** lib/judge-round-settle.ts */
    judgeChildByRole(root: string, role: string): JudgeEntry | undefined;
    /** lib/judge-lane-host.ts */
    closeJudgePaneOf(entry: JudgeEntry, ctx: JudgeCloseCtx): void;
    reapReviewScratch(sessionId: string): void;
    /** lib/precommit-lane.ts */
    precommitLaneRunning(root: string): boolean;
    abortPrecommitLane(root: string, why: string): boolean;
    /** lib/review-target-host.ts */
    qualityRoundInFlight(root: string): boolean;
    /** lib/verdict-host.ts */
    recordReviewVerdict(concluded: ReportConclusion, repo: string, ctx: unknown): Promise<string>;
  },
) {
  const { judgeHierarchy, setHierarchy, absorbJudgeModelEvents } = deps.registry;
  const {
    pi, runTmux, cancelLedger, reviewTargets, stageIsOn, laneVerificationWaived, judgeChildByRole,
    closeJudgePaneOf, reapReviewScratch, precommitLaneRunning, abortPrecommitLane,
    qualityRoundInFlight, recordReviewVerdict,
  } = deps;
  const { log } = host;
  const stateForRepo = (root: string) => host.stateFor(root);
  const persistRepo = (ctx: ExtensionContext, root: string) => host.persistRepo(ctx, root);

  /**
   * KILL ONE PARTY OF A ROUND — for real (2026-09-16).
   *
   * The cancel matrix says "the quality round failing STOPS the reviewer", and
   * this is what "stops" has to mean: the pane's PROCESS is terminated and its
   * registry row is dropped. Reading past its output instead would leave a
   * max-thinking judge burning minutes on content whose verdict can no longer
   * be recorded — the whole reason the matrix exists is the minutes, not the
   * output.
   *
   * DROPPING THE ROW IS ALSO WHAT KEEPS THE KILL SILENT TO THE RIGHT PARTIES:
   * the child watchdog (`classifyChildren`) and the settle sweep both iterate
   * the registry, so a cancelled round can no longer be announced as a judge
   * that DIED (which would send the agent to `judge_recover` a round that is
   * deliberately gone — and recovery refuses too, since it looks the entry up
   * in the same registry). What the agent gets instead is the note this returns,
   * carried by the sibling verdict's standard report.
   *
   * THE SCRATCH WORKTREES GO WITH IT (`reapReviewScratch`): a cancelled round
   * can never use them again, and they are the gate's to reclaim (who creates,
   * reclaims).
   *
   * LIVE-ONLY, deliberately: a cancellation is an action on a running process,
   * so it does not survive a restart — and neither does the state that decided
   * it (the round is over either way).
   */
  function cancelJudgeRound(root: string, role: string, why: string): string | undefined {
    const entry = judgeChildByRole(root, role);
    if (!entry) return undefined; // already concluded and gone: nothing to stop
    // BEFORE the row goes: what the pane reported about its OWN model is a fact
    // this round earned (a failed slot has to be cooled down, warned about and
    // skipped by the next dispatch — lib/judge-model-rotation.ts), and the
    // absorb reads its cursor off the entry that is about to be removed.
    absorbJudgeModelEvents(root, entry.judgeId);
    const ownPane = process.env.TMUX_PANE?.trim() || undefined;
    const tmuxServer = tmuxServerFrom(process.env);
    const run = (argv: readonly string[]) => runTmux(argv);
    const alive = entry.paneId && paneIdUsable(entry, tmuxServer)
      ? judgePaneAlive(run, entry.paneId)
      : undefined;
    if (alive === true) closeJudgePaneOf(entry, { ownPane, tmuxServer, run });
    setHierarchy(removeJudge(judgeHierarchy(), entry.judgeId));
    cancelLedger.note(root, { role, judgeId: entry.judgeId, why });
    reapReviewScratch(entry.judgeId);
    log(`review-gate: cancelled the ${role} round of ${root} — ${why}`);
    return `已终止 ${role} 的这一轮（${why}）。`;
  }

  /**
   * RE-ASK A PARKED CONCLUSION'S TWO PRECONDITIONS and act on the answer.
   *
   * A parked READY waits for up to TWO landings — the full lane that verifies
   * its content, and the quality round that must pass before it may be
   * recorded — and they arrive in either order. So the fate is computed from
   * the STATE OF BOTH HALVES (lib/review-adjudicate.ts's `parkedReadyFate`)
   * rather than from whichever event fired, and this function is called from
   * every one of them: the lane's landing, the quality round's settlement, and
   * the settle sweep.
   *
   * The sweep call is not a duplicate of the other two — it is the BACKSTOP.
   * A hold is only legitimate while somebody can still end it
   * (`decideQualityHold` refuses otherwise, exactly as `unverified-idle`
   * does); the quality pane can die AFTER the record was parked, and without a
   * periodic re-ask the conclusion would sit there forever while the reply told
   * the agent not to re-submit.
   *
   * `clear` and `replay` both retire the record; only `replay` wakes the agent,
   * because only it changes the gate's verdict (a dropped hold leaves `review`
   * PENDING, which the ordinary RESUME already speaks for).
   *
   * `landing` is how the LANE's own callback hands over what it just measured:
   * a verdict that is not PASS retires the parked record NOW, rather than at
   * the next settle. The recorded tree alone cannot say it — a FAIL of some
   * other tree leaves `lastFullPassTree` standing (lib/gate-state.ts), and a
   * PASS for another tree is equally unreadable from the record (round-2 P2:
   * nothing may be left behind after the lane it was waiting for has landed).
   */
  async function resumeParkedReady(
    root: string,
    ctx?: unknown,
    landing?: { laneVerdict: string; coveredTree: string | undefined },
  ): Promise<string[]> {
    const st = stateForRepo(root);
    const parked = st.pendingReady;
    if (!parked) return [];
    const target = reviewTargets.get(root);
    const fate = parkedReadyFate({
      parkedTree: parked.tree,
      lane: parkedLaneHalf({
        parkedTree: parked.tree,
        // The landing's args are passed through when there IS one; otherwise
        // the half is read from the record (`laneVerdict` absent).
        ...(landing?.laneVerdict === undefined ? {} : { laneVerdict: landing.laneVerdict }),
        coveredTree: landing?.coveredTree ?? st.precommit.lastFullPassTree,
        currentTargetTree: target?.tree,
        laneRunning: precommitLaneRunning(root),
        // BYPASS ARRIVES HERE TOO (quality round P1, 2026-09-16): a bypassed
        // session never gets a full lane (`submitForReview` skips it), so
        // "no lane, no tree covered" must not read as "disproven" — that is
        // exactly how a parked READY was cleared and re-submitted into the
        // identical park. The rule is shared with the recorder, not restated:
        // `laneVerificationWaived` is that ONE composition (and the precommit
        // stage switch joins the bypass in it, quality round P1 2026-09-22).
        bypassActive: laneVerificationWaived(root, st),
      }),
      quality: qualityPrecondition({
        standing: qualityStandingFor({ head: target?.head ?? "", files: target?.files, quality: st.quality, stageOn: stageIsOn("quality", root) }),
        qualityRoundInFlight: qualityRoundInFlight(root),
      }),
    });
    if (fate === "none" || fate === "hold") return [];
    // A LANDING NEEDS A CONTEXT TO WRITE WITH, AND WITHOUT ONE NOTHING MAY
    // CHANGE (quality round P1, 2026-09-16). This used to delete `pendingReady`
    // first and return when no ctx was in reach: the in-memory record was gone,
    // the delete never reached the sidecar, and the reply had already told the
    // agent not to re-submit — a round that could never be recorded. Now the
    // record is left exactly where it is and the next settle retries, which is
    // the same "stay parked until somebody can act" the old guard claimed.
    const liveCtx = ctx ?? host.ctx();
    if (!liveCtx) return [];
    delete st.pendingReady;
    persistRepo(liveCtx as unknown as ExtensionContext, root);
    if (fate === "clear") {
      log(
        `parked READY for ${root} dropped: its two preconditions can no longer both hold ` +
        `(round ${parked.round}, tree ${parked.tree.slice(0, 12)})`,
      );
      return [`本轮挂起的 READY 已作废（round ${parked.round}）：它的前提已不可能同时成立，重送一轮即可。`];
    }
    const recorded = await recordReviewVerdict(parked.conclusion as ReportConclusion, root, liveCtx);
    const note = buildParkedReadyReplayNotice({ round: parked.round, tree: parked.tree, recorded });
    try {
      // WAKE THE AGENT: this is a gate state change nobody else will report.
      // `steer`, exactly like the failure notice — a `followUp` would sit in the
      // queue behind a long turn, and the whole point is that the round is no
      // longer waiting on anything.
      pi.sendMessage(
        { customType: "review-gate", content: note, display: true },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } catch { /* headless — the recorded verdict is what matters */ }
    // NO NOTE BACK: the steer above IS the delivery, and a caller that also
    // prints the same sentence in its report would tell the agent the same
    // thing twice (one cause, one message).
    return [];
  }

  /**
   * APPLY ONE ROW OF THE CANCEL MATRIX — the ONLY place a party is stopped.
   *
   * Both the judges' settles and the lane's own landing come through here, so
   * the table's three rows share one effect implementation (quality round P1,
   * 2026-09-16: the lane's row was hand-written beside the table, which is
   * exactly the second implementation the table exists to prevent).
   *
   * The lane's remaining minutes verify a tree nobody will ship, and the NEXT
   * submission would wait for a quiet lane before starting the one that
   * matters (`waitForQuietLane`) — the abort buys back the wait, not just the
   * CPU.
   *
   * `why` is the landing's own reason when it has one: the lane's row is not
   * "a judge said non-READY", and the tombstone repeats this text to the agent.
   */
  function applyCancelPlan(plan: RoundCancelPlan, root: string, why?: string): string[] {
    const notes: string[] = [];
    if (plan.cancelReviewer) {
      const stopped = cancelJudgeRound(root, "reviewer", why ?? "这一轮已经判不过了 —— 内容要改，功能轮不必再过");
      if (stopped) notes.push(stopped);
    }
    if (plan.cancelQuality) {
      const stopped = cancelJudgeRound(root, QUALITY_ROLE, "这一轮已经判不过了 —— 内容要改，质量轮不必再审");
      if (stopped) notes.push(stopped);
    }
    if (plan.abortLane) {
      notes.push(
        abortPrecommitLane(root, "本轮有 judge 判了非 READY —— 内容要改，这轮验证不再有意义")
          ? "正在跑的全量 precommit 已终止，它的结论作废（改完重新送审时会重跑）。"
          : "",
      );
    }
    return notes.filter((n) => n !== "");
  }

  /**
   * DID THIS ROUND PARK ITS VERDICT? — i.e. did the recorder deliberately leave
   * `st.review` at PENDING because something is still owed (the full lane's
   * PASS, or the quality round's verdict)?
   *
   * WHY THE CANCEL MATRIX HAS TO ASK (quality round P0, 2026-09-16).
   * `recordReviewVerdict` returns BEFORE it writes `st.review` when it HOLDS a
   * READY, so the settle path still sees `review.verdict === "PENDING"` — and
   * feeding that to the matrix reads as "a non-READY reviewer" and cancels the
   * quality round and the lane. That is the exact opposite of the design: the
   * hold exists so the quality verdict can still arrive. A parked round cancels
   * NOTHING; every landing re-asks it (`resumeParkedReady`).
   *
   * The parked record is matched to the CURRENT round by its tree (the same
   * identity every other binding check uses), so a leftover record from an
   * earlier round cannot excuse a real non-READY verdict.
   */
  function reviewVerdictIsParked(root: string): boolean {
    const st = stateForRepo(root);
    const target = reviewTargets.get(root);
    return st.pendingReady !== undefined && target !== undefined && st.pendingReady.tree === target.tree;
  }

  /**
   * WHAT A CONCLUDED ROUND DOES TO ITS SIBLINGS — the cancel matrix, applied
   * for a JUDGE's settle (`lib/quality-round.ts` owns the other row, the
   * lane's, which the lane's own callback applies).
   *
   * ONE decision, TWO settle entry points. A round is recorded by whichever
   * path sees it first — the settle sweep (`recordJudgeConclusion`) or
   * `judge_wait`'s `settleRound` — and the other then only ever reads
   * `already-consumed`; wired into the sweep alone, a quality round closed by a
   * wait would never stop the reviewer it just blocked (reviewer P1,
   * 2026-09-15, learned on the serial design that had the same two paths).
   *
   * The verdict it acts on is the RECORDED one, not the word the judge wrote:
   * both recorders downgrade a READY that fails its own bindings (stale target,
   * cwd, verification), and cancelling a party off the raw word would end a
   * round the gate itself just refused. The one state that is NOT a verdict —
   * a PARKED conclusion — cancels nothing at all (see above).
   */
  async function applyRoundCancel(kind: string | undefined, root: string, ctx?: unknown): Promise<string | undefined> {
    const notes: string[] = [];
    // THE KIND IS TRANSLATED, NEVER COMPARED TO A ROLE (functional round P1,
    // 2026-09-16): a functional round settles as kind `"review"`, so comparing
    // it with the ROLE name (`reviewer`) was dead code — the matrix's second
    // row never ran, and a BLOCKED reviewer left the quality round and the lane
    // running. `roundCancelParty` owns that translation, and the test beside it
    // pins both directions.
    const party = roundCancelParty(kind);
    if (party !== undefined) {
      const st = stateForRepo(root);
      // THE PARKED FACT IS PART OF THE DECISION, not an `if` beside it: the
      // table answers "a hold cancels nothing" (quality round P0, 2026-09-16).
      const landing: RoundLanding =
        party === "quality"
          ? { party, verdict: st.quality?.verdict ?? "" }
          : { party, verdict: st.review.verdict, held: reviewVerdictIsParked(root) };
      notes.push(...applyCancelPlan(roundCancelPlan(landing), root));
    }
    // ALWAYS RE-ASK THE PARKED CONCLUSION: this landing may be the second of
    // its two preconditions (the quality verdict releasing a reviewer READY
    // that the lane already passed, or the reverse).
    notes.push(...(await resumeParkedReady(root, ctx)));
    const text = notes.filter((n) => n !== "").join(" ");
    return text === "" ? undefined : text;
  }

  return { cancelJudgeRound, resumeParkedReady, applyCancelPlan, applyRoundCancel };
}
