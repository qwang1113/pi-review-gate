/**
 * RECORDING ONE REVIEWER ROUND'S VERDICT — moved out of
 * `extensions/review-gate.ts` (t7, wave 3 of the split). Every check the
 * opener owns still runs here and in this order: the STALE commit-target
 * check, the verification binding, the cwd consistency check, the hold (lane
 * or quality round), the tree binding, the round record, the timing and the
 * auto-loop disarms.
 *
 * Its siblings — the quality and acceptance recorders — are
 * lib/sibling-verdict-host.ts; the cancel matrix and the parked re-ask are
 * lib/round-cancel-host.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReportConclusion } from "./channel-projection.ts";
import { OSCILLATION_LIMIT, PLATEAU_ROUNDS } from "./constants.ts";
import { computeFingerprint } from "./fingerprint.ts";
import { gitText } from "./git-exec.ts";
import type { GateState } from "./gate-state.ts";
import { sanitizeRoundScope, type RoundScopeRecord } from "./gate-state-records.ts";
import { countOscillations, isOscillating, isPlateaued } from "./gate-state-requirements.ts";
import { appendTiming } from "./gate-timings.ts";
import type { LoopStage } from "./loop-stages.ts";
import { recordedFindingsFrom } from "./polish-gate.ts";
import { decideQualityHold, qualityStandingFor } from "./quality-round.ts";
import type { ToolRepoTarget } from "./repo-resolve.ts";
import { canonicalPath } from "./repo-facts.ts";
import {
  adjudicateReviewConclusion,
  classifyReadyWithholding,
  fileFindingsFrom,
  normalizeConcludedVerdict,
  readyLacksVerification,
  type ReviewFinding,
  type ScopeExemption,
} from "./review-adjudicate.ts";
import type { ReviewScopeDecision } from "./review-scope.ts";
import type { ReviewTarget } from "./review-target-host.ts";
import type { Ref, SessionHost } from "./session-host.ts";
import { reviewCoverageFiles } from "./worktree-changes.ts";

/**
 * The user's scope exemption, in the shape the adjudicator takes — or
 * `undefined` when no scope limit is in force, which is the ordinary case
 * and must stay byte-for-byte the old behaviour.
 *
 * BOTH RECORDERS CALL THIS (2026-09-19), and that is the point: the two
 * adjudications answer different questions — the quality half gates the
 * reviewer's dispatch, the review half gates shipping — but a quality round
 * that blocks on an EXEMPTED file still kills the reviewer's pane through the
 * cancel matrix. Fixing one and not the other leaves the same deadlock
 * standing at the other door.
 */
export function scopeExemptionOf(st: GateState): ScopeExemption | undefined {
  return st.scopeLimit === undefined ? undefined : { exemptFiles: st.scopeLimit.preexistingFiles };
}

export function createReviewVerdictRecorder(
  host: SessionHost,
  deps: {
    reviewTargets: Map<string, ReviewTarget>;
    resolveToolRepo(requested?: string): ToolRepoTarget;
    reviewScopeFor(root: string, st: GateState): ReviewScopeDecision;
    stageIsOn(stage: LoopStage, root?: string): boolean;
    laneVerificationWaived(root: string, st?: GateState): boolean;
    /** lib/precommit-lane.ts */
    precommitLaneRunning(root: string): boolean;
    /** lib/review-target-host.ts */
    qualityRoundInFlight(root: string): boolean;
    clearBypassToken(): void;
    setLoopArmed(armed: boolean): void;
    maybeStrategicReset(st?: GateState): string;
    /** When the previous gate event happened (the timing's approximate duration). */
    lastGateEventAt: Ref<number>;
  },
) {
  const {
    reviewTargets, resolveToolRepo, reviewScopeFor, stageIsOn, laneVerificationWaived,
    precommitLaneRunning, qualityRoundInFlight, clearBypassToken, setLoopArmed, maybeStrategicReset,
    lastGateEventAt,
  } = deps;
  const stateForRepo = (root: string) => host.stateFor(root);
  const persistRepo = (ctx: ExtensionContext, root: string) => host.persistRepo(ctx, root);

  /**
   * Record ONE reviewer round's verdict.
   *
   * NOT A TOOL, on any surface (2026-09-04, user decision D4). It used to be
   * an `internalTool` taking `reviewer_output: string`, and the only reason
   * that shape existed was that the verdict had to be PARSED back out of text
   * the gate had itself serialised. The conclusion arrives structured now, so
   * the tool wrapper carried nothing but a second way to sequence the same
   * step by hand (philosophy two, philosophy three).
   *
   * Everything the OPENER owns still happens here and in this order: the STALE
   * commit-target check, the cwd consistency check, the tree binding, the round
   * record, the timing, and the auto-loop disarms.
   */
  async function recordReviewVerdict(
    concluded: ReportConclusion,
    repo: string,
    ctx: unknown,
  ): Promise<string> {
    const verdictRaw = normalizeConcludedVerdict(concluded.verdict);
    if (!verdictRaw) {
      return "review-gate: 本轮 report 里没有可识别的 verdict —— 什么都没有记录，门禁保持 PENDING（fail-closed）。" +
        "reviewer 必须通过 judge_conclude 交卷（verdict + findings + cwd）；散文不记录任何东西。" +
        "用 judge_submit({role:\"reviewer\"}) 重跑本轮。";
    }
    // The agent is running the loop again — a standing ask_user
    // pause is moot (liveness: a stale pause would silently swallow the
    // next auto-continuation after a BLOCKED verdict).
    // P-multi: the verdict binds to ONE repo — the repo the round was
    // dispatched for, named explicitly (a multi-repo session must never
    // depend on which repo was edited last). stateForRepo(primary) IS
    // `state`, so the local `st` writes land on the right object and
    // persistRepo persists to the right sidecar — no global state swap.
    const target = resolveToolRepo(repo);
    if (!target.ok) {
      return target.error;
    }
    const targetRoot = target.root;
    // NON-GIT SHORT-CIRCUIT (defense): judge_submit refuses outside a
    // repository, so this step should never be reached there;
    // fail closed anyway rather than bind a verdict to a non-repo.
    if (!host.repos().inGit) {
      return "review-gate: 非 git 目录 —— 无法记录裁决（无仓库可绑定）。";
    }

    const st = stateForRepo(targetRoot);
    delete st.pausedQuestion;
    // ONE adjudication for the record: a READY carrying an open P0/P1 is
    // contradictory and becomes BLOCKED, and the round's findings become the
    // count and the coarse cross-round fingerprints (lib/review-adjudicate.ts).
    //
    // SCOPE-AWARE since 2026-09-19 (`ScopeExemption`): a P0/P1 on a file the
    // USER exempted no longer contradicts a READY. It needs `st`, so it runs
    // after the repo is resolved — the pure adjudication is unchanged.
    const parsed = adjudicateReviewConclusion({
      verdict: verdictRaw,
      findings: concluded.findings as ReviewFinding[],
      ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
      ...(concluded.docSync === undefined ? {} : { docSync: concluded.docSync }),
    }, scopeExemptionOf(st));
    // THE ADJUDICATOR'S OWN VERDICT, captured before the three binding checks
    // below overwrite it (2026-09-15). Only THIS one answers "does the round
    // contradict itself on its findings?" — stale, unverified and the cwd check
    // each relabel `parsed.verdict` too, and feeding the relabelled word into
    // `classifyReadyWithholding` made every one of them look like a finding
    // conflict.
    const adjudicatedVerdict = parsed.verdict;
    const fp = computeFingerprint(targetRoot);
    // Scope THIS round was judged under — computed BEFORE the new verdict
    // overwrites the baseline, or it would always read as "nothing new".
    const scopeNow = reviewScopeFor(targetRoot, st);
    // COMMIT TARGET INTEGRITY — mechanical, not honour-based (2026-08-27
    // execution model). prepare_review registered the reviewed range
    // (baseline..HEAD) in reviewTargets; a verdict binds to THAT target:
    //  - no target registered ⇒ the round was never prepared ⇒ a READY has
    //    nothing to bind to ⇒ withhold (BLOCKED);
    //  - HEAD moved past the registered head (a new checkpoint landed after
    //    prepare) ⇒ STALE ⇒ BLOCKED: the reviewer judged an older commit
    //    and the change under review has since grown;
    //  - READY binds to the reviewed commit's TREE (content binding:
    //    squash preserves it). Tighten-only — this can withhold a READY,
    //    never grant one.
    let staleTarget = false;
    /**
     * WHY A READY WAS REFUSED FOR THE QUALITY ROUND (2026-09-16) — set only by
     * the `refuse` outcome of `decideQualityHold`, and printed in the recorded
     * note so the agent does not read it as a finding against its code.
     */
    let qualityRefusal: string | undefined;
    // THE VERIFICATION BINDING (B1, 2026-09-10). The checkpoint gate accepts
    // content whose full lane is STILL RUNNING (that is what makes the lane run
    // beside the chain instead of in front of it), so this is the place that
    // refuses a READY on content which never passed it. Without it a round
    // dispatched beside a failing suite would record a verdict nothing can
    // ship, and it would LOOK verified while it was not. Tighten-only, exactly
    // like the stale check above — and it reads the sidecar, so a session that
    // restarted mid-round is judged by what was actually written down.
    let unverified = false;
    if (parsed.verdict === "READY") {
      const target_ = reviewTargets.get(targetRoot);
      if (!target_) {
        staleTarget = true;
      } else {
        try {
          const headNow = gitText(targetRoot, ["rev-parse", "HEAD"]);
          staleTarget = headNow !== target_.head;
        } catch { staleTarget = true; }
      }
      if (
        !staleTarget &&
        readyLacksVerification({
          precommitVerdict: st.precommit.verdict,
          // The round's own tree, registered by prepare against the checkpoint
          // it dispatched, and the tree a full lane passed if one is on
          // record: either answers "this content was verified" without
          // depending on the live binding the next round's edits reset.
          lastFullPassTree: st.precommit.lastFullPassTree,
          reviewedTree: reviewTargets.get(targetRoot)?.tree,
          // A bypass AND a switched-off precommit stage both mean "this round
          // owes no lane" — one composition, shared with the parked re-ask
          // (`laneVerificationWaived`).
          bypassActive: laneVerificationWaived(targetRoot, st),
        })
      ) {
        unverified = true;
        parsed.verdict = "BLOCKED";
      }
      if (staleTarget || unverified) parsed.verdict = "BLOCKED";
    }
    // THE cwd CHECK (round-9 P1, reviewer-reproduced). The schema and the
    // task text have always demanded a real `pwd` and said the gate checks
    // it — but nothing did, so a verdict claiming `/evil/elsewhere` produced
    // exactly the same READY. A stated check that does not run is worse than
    // no check, because it is believed.
    //
    // WHAT IT IS (round-11 P1): a consistency check on a SELF-REPORTED
    // value. It rejects a report that does not match the repo this round was
    // prepared for — a review run against the wrong repo. It proves nothing
    // about who produced the verdict: any value equal to the root passes.
    // Reading `paneCurrentPath` would not change that either, since a
    // finished judge's pane is gone by the time its verdict is recorded.
    //
    // The judge pane is spawned with `cwd: root`, so the expected answer is
    // this repo's root. Compared through realpath, because /var vs /private/var
    // (macOS) would otherwise fail a perfectly honest reviewer.
    let cwdMismatch: string | undefined;
    if (parsed.verdict === "READY") {
      const claimed = parsed.cwd;
      if (claimed === undefined || claimed.trim() === "") {
        cwdMismatch = "the verdict carries no `cwd` (a required field: run `pwd` and report it)";
      } else {
        // canonicalPath exists for exactly this: /var vs /private/var would
        // otherwise withhold an honest reviewer's READY.
        if (canonicalPath(claimed) !== canonicalPath(targetRoot)) {
          cwdMismatch = `the verdict's cwd ${JSON.stringify(claimed)} is not the repo this round was prepared for (${targetRoot})`;
        }
      }
      if (cwdMismatch) parsed.verdict = "BLOCKED";
    }

    const bindTree = parsed.verdict === "READY" ? reviewTargets.get(targetRoot)?.tree ?? null : null;
    // HOLD, DON'T REFUSE, WHEN THE ONLY THING MISSING IS TIME (2026-09-15).
    // This function used to write `unverified` straight to BLOCKED and be done
    // with it — permanently, while the lane that would have cleared it landed
    // seconds later. The agent read "fix ALL findings and re-review" on a round
    // whose only finding was a Nit saying nothing had changed, and its only way
    // forward was re-reviewing byte-identical content. Measured on this repo:
    // 16s of review against a 34s full lane, seven seconds short.
    const withholding = classifyReadyWithholding({
      concluded: verdictRaw,
      blockingFinding: adjudicatedVerdict !== "READY",
      staleTarget,
      lacksVerification: unverified,
      // A HOLD NEEDS SOMEONE TO COME BACK FOR IT (round-1 P1, 2026-09-15). The
      // only two things that revive a parked conclusion are this lane's own
      // completion callback and the next round's prepare; when the lane has
      // ALREADY landed (or never started), holding would park the round forever
      // while telling the agent not to re-submit. `inFlightPrecommit` is
      // cleared in a microtask AFTER the lane's own callback has run, so a lane
      // that is still listed here is one whose callback has not finished.
      laneStillRunning: precommitLaneRunning(targetRoot),
      cwdMismatch: cwdMismatch !== undefined,
    });
    // THE QUALITY PRECONDITION AT THE RECORDING END (2026-09-16). The two
    // judges of a round start together, so this is where "the quality round has
    // not passed yet" is enforced now: a READY recorded here would ship a round
    // no quality judge ever passed.
    //
    // IT COMES AFTER the three binding checks on purpose — including the
    // promotion to BLOCKED from a finding conflict. Each of those is a fact
    // ABOUT THE WORK, which waiting cannot change; this one is a fact about
    // TIME, and only a conclusion that is otherwise recordable may be held.
    //
    // …AND A SKIP RECORD ONLY STANDS WHILE THE STAGE IS OFF (2026-09-22), so
    // the user's switch is read ONCE here and handed to both readers below
    // (this hold, and the baseline decision) — the rule itself lives in
    // `lib/quality-round.ts`'s `qualityStandingFor`.
    const qualityStageOn = stageIsOn("quality", targetRoot);
    const qualityHold =
      parsed.verdict === "READY" && !staleTarget && withholding === "none"
        ? decideQualityHold({
            standing: qualityStandingFor({
              head: reviewTargets.get(targetRoot)?.head ?? "",
              files: reviewTargets.get(targetRoot)?.files,
              quality: st.quality,
              stageOn: qualityStageOn,
            }),
            qualityRoundInFlight: qualityRoundInFlight(targetRoot),
          })
        : "record";
    // NOBODY IS COMING BACK WITH A QUALITY VERDICT (the quality pane died, or
    // this round never dispatched one): fail closed, exactly like
    // `unverified-idle`. A hold with nothing to end it parks the round forever.
    if (qualityHold === "refuse") {
      parsed.verdict = "BLOCKED";
      qualityRefusal = "质量轮在本轮没有留下任何有效结论（judge 未派出或已死亡）—— 本轮没有可 ship 的 READY。";
    }
    if (withholding === "unverified" || qualityHold === "hold") {
      const parkedTarget = reviewTargets.get(targetRoot);
      // No target ⇒ the stale check above already fired and this is a refusal,
      // not a hold: a parked conclusion with nothing to bind to could never be
      // replayed into a real verdict.
      if (parkedTarget) {
        st.pendingReady = {
          conclusion: {
            verdict: "READY",
            findings: (concluded.findings ?? []) as unknown[],
            ...(concluded.cwd === undefined ? {} : { cwd: concluded.cwd }),
            ...(concluded.docSync === undefined ? {} : { docSync: concluded.docSync }),
            // The judge's OWN scope travels too: the recorder pairs it with the
            // dispatched half (round-1 P2), and a replay that lost it would
            // write a different audit pair than a straight record of the same
            // round.
            ...(concluded.scope === undefined ? {} : { scope: concluded.scope }),
          },
          tree: parkedTarget.tree,
          head: parkedTarget.head,
          round: st.rounds.length + 1,
          at: new Date().toISOString(),
        };
        persistRepo(ctx as unknown as ExtensionContext, targetRoot);
        // TWO REASONS TO HOLD, TWO SENTENCES — and the quality one also says
        // where to look: a quality judge is allowed to ask the USER a scope
        // question (`ask_user`), and an agent told only "do not re-submit"
        // would wait on a box nobody had told it about.
        if (qualityHold === "hold") {
          return `review-gate: this round's READY is being HELD, not refused — for ${targetRoot} ` +
            `(round ${st.rounds.length + 1}, tree ${parkedTarget.tree.slice(0, 12)}).\n` +
            "这一轮的内容**没有问题**：质量轮（`quality-auditor`）还在审同一段 commit range。" +
            "门禁把功能轮结论**原样扣下**了，`review` 仍是 PENDING ——\n" +
            "  - 质量轮落 READY ⇒ 门禁**自动补记 READY** 并唤醒你，可以继续收尾；\n" +
            "  - 质量轮落非 READY ⇒ 挂起作废，按它的 findings 修完重新送审；\n" +
            "  - 质量轮 pane 死掉（永远不会再有结论）⇒ 挂起作废，重送一轮即可。\n" +
            "**不要重跑审查**：重送的同一份内容不会更快拿到结果，只会白烧一轮。" +
            "若质量轮在问你问题（`judge_wait` / `judge_answer` 会显示），先把它答掉。";
        }
        return `review-gate: this round's READY is being HELD, not refused — for ${targetRoot} ` +
          `(round ${st.rounds.length + 1}, tree ${parkedTarget.tree.slice(0, 12)}).\n` +
          "这一轮的内容**没有任何问题**：只是全量 precommit 还没跑完（B1 让它与审查并行跑，" +
          "所以 reviewer 可以先交卷）。门禁把结论**原样扣下**了，`review` 仍是 PENDING ——\n" +
          "  - lane 落 PASS 且 tree 相同 ⇒ 门禁**自动补记 READY** 并唤醒你，可以继续收尾；\n" +
          "  - lane 落 FAIL ⇒ 挂起被清掉，并按失败通道告诉你原因；\n" +
          "  - lane 落 PASS 但覆盖的不是这一棵，或门禁已经走到下一轮（你又送了一轮）⇒ 挂起**作废**：" +
          "那一轮判的内容已经不是当前这一轮了，按常规继续即可。\n" +
          "**在 lane 跑期间照常编辑工作区**：那不会作废挂起 —— 挂起判的是已提交的那一棵，" +
          "编辑作废的是 ship 绑定（这是故意的）。\n" +
          "**不要重跑审查**：重送的同一份内容不会更快拿到结果，只会白烧一轮。";
      }
    }
    // WHICH COMMIT THE BASELINE STOPS AT. The field means "the commit of the
    // last round that CONCLUDED", and a round whose QUALITY half never
    // concluded did not conclude one — the content in its range then entered no
    // quality round at all, and a later READY whose quality judge read only the
    // increment would ship it. Recording THIS round's head there is what moved
    // the next prepare's baseline onto that content.
    //
    // THE TEST IS THE STANDING, NOT A LIST OF CASES (quality round P1,
    // 2026-09-17). It used to special-case ONE way of having no quality
    // conclusion — the recorder's own `refuse` — while a non-READY functional
    // verdict reached the same state by another door: the cancel matrix kills
    // the quality round when the functional one concludes non-READY, so THAT
    // round's content was quality-unaudited too and the special case did not
    // cover it. `qualityStandingFor` already answers "does a quality conclusion
    // stand for this head" (a recorded READY bound to it, or a round with no
    // code to judge) for the dispatch and for the hold, so it answers this one
    // as well: standing ⇒ this round's head, anything else ⇒ the previous
    // value. `refuse` needs no branch of its own; it is one way to fail it.
    //
    // …AND OMITTING THE FIELD IS NOT THE SAME FIX: `st.review` is REPLACED
    // wholesale, so an absent `commitSha` also erases the LAST REAL conclusion
    // and drops the next baseline to the BRANCH BASE (a full-branch re-review),
    // or — in a repo with no main/master/origin — back onto this round's own
    // head, reopening the very hole this guards. Carrying the previous value
    // forward states the fact exactly: this round concluded nothing, the
    // earlier ones still did.
    //
    // THERE IS A SECOND WAY TO HAVE NO HEAD TO RECORD (reviewer P2,
    // 2026-09-18): a round whose target is not registered in THIS process —
    // `reviewTargets` is in-memory, so a verdict landing after a restart is
    // exactly that shape. Its standing is unanswerable, `qualityStandingFor`
    // fails closed, and it falls through to the previous value like the rest.
    const qualityHalfConcluded = qualityStandingFor({
      head: reviewTargets.get(targetRoot)?.head ?? "",
      files: reviewTargets.get(targetRoot)?.files,
      quality: st.quality,
      stageOn: qualityStageOn,
    }).ok;
    const concludedCommit = (qualityHalfConcluded ? reviewTargets.get(targetRoot)?.head : undefined)
      ?? st.review.commitSha;
    st.review = {
      verdict: parsed.verdict,
      fingerprint: bindTree,
      // Round-9 P1: the reviewed COMMIT sha rides the verdict so the next
      // prepare can baseline from it (covering every later checkpoint).
      //
      // EVERY CONCLUDED VERDICT CARRIES IT (2026-09-16), not just READY. The
      // baseline rule is「从最后一个**有结论**的轮次起算」, and while only READY
      // was recorded, a round that produced NO conclusion — a re-submit that
      // interrupted it, a precommit FAIL, a crash — left the next prepare to
      // guess, and the guess was the newest checkpoint's parent. Measured that
      // day: a whole round's changes (d28714e..a70f2a1) dropped out of every
      // later range while the gate went on believing the chain was reviewed.
      //
      // …AND `refuse` IS NOT A CONCLUSION (quality round P1, 2026-09-18). The
      // rule above is about verdicts that CONCLUDED something; `refuse` is the
      // recorder reporting that the quality judge never left one (its pane
      // died, or this round dispatched none). Recording the head here moved the
      // NEXT round's baseline onto it (lib/review-prepare-tools.ts), so this
      // round's own content entered no quality round's range at all — one pane
      // death was enough to walk unreviewed code past the quality gate, which
      // is exactly what 「a round without a conclusion must never let the
      // baseline step past its content」 forbids. Carrying the previous value
      // keeps the baseline at the last round that truly concluded, so this
      // round's content stays inside the next round's range.
      ...(concludedCommit === undefined ? {} : { commitSha: concludedCommit }),
      at: new Date().toISOString(),
      // Code↔doc attestation travels with the verdict it came from; absent
      // stays absent (blocks under the docSync knob — fail-closed).
      ...(parsed.docSync !== undefined ? { docSync: parsed.docSync } : {}),
    };
    // EVERY CONCLUDED VERDICT MOVES THE INCREMENTAL BASELINE (2026-09-19), not
    // just a READY. See `GateState.lastReviewedTree` for the measurement (three
    // full deep reviews over one diff) and for why the verdict rides along:
    // `reviewScopeFor` asks what was READ, while `settledConclusion` asks what
    // was CONFIRMED — and only a READY answers the second, so this write does
    // not let a BLOCKED tree be handed on as settled.
    //
    // Only a round that actually got RECORDED reaches this point: a verdict
    // refused by a binding check, or a round the cancel matrix terminated, is
    // not a conclusion and must leave the baseline where it was.
    {
      const treeOid = reviewTargets.get(targetRoot)?.tree;
      if (treeOid) {
        // What this review ACTUALLY covered. Under a user-granted scope
        // limit that is only the session's own files — recording the whole
        // branch diff would later let the increment scoper call
        // never-reviewed, exempted files "already reviewed and unchanged"
        // and skip the escalation to a full round.
        const files = st.scopeLimit
          ? st.scopeLimit.sessionFiles.slice()
          : reviewCoverageFiles(targetRoot);
        st.lastReviewedTree = {
          treeOid,
          at: new Date().toISOString(),
          verdict: parsed.verdict,
          ...(files ? { files } : {}),
        };
      }
    }
    // Round-18 polish gate: record which files carried P2/Nit vs P0/P1
    // findings this round (severity + file straight off the judge's own
    // findings, never line counts). The next prepare_review derives the file
    // streak from these.
    const recorded = recordedFindingsFrom(fileFindingsFrom(concluded.findings as ReviewFinding[]));
    // THE AUDIT PAIR (t6a): what the gate dispatched this round to review, and
    // what the judge reported for itself. Recorded side by side so a finished
    // round says, on the record, WHICH range and WHICH depth it ran under —
    // the fact every after-the-fact question about this round starts from
    // ("was this round incremental, and over what?").
    //
    // WHAT THE PAIR DOES NOT PROVE. Both halves trace back to the same text
    // the gate wrote, so agreement is the normal case and says nothing about
    // how carefully the round was read — whether anything was actually read is
    // a different record, `inspection` (lib/judge-inspection.ts), and how well
    // is the reviewer's own verdict. What a DISAGREEMENT catches is the pair's
    // real value: a judge whose task text was not this round's, a pane running
    // a different build, or a scope kind carried over from an earlier round.
    // Nothing refuses a verdict over it — a divergence can be legitimate, and
    // the gate cannot tell which, so it records instead of guessing.
    const roundScope: RoundScopeRecord | undefined = sanitizeRoundScope({
      dispatched: reviewTargets.get(targetRoot)?.scope,
      reported: concluded.scope,
    });
    st.rounds.push({
      round: st.rounds.length + 1,
      findingsTotal: parsed.findingsTotal,
      fingerprints: parsed.findingFingerprints,
      verdict: parsed.verdict,
      at: new Date().toISOString(),
      ...(recorded.polishFiles.length > 0 ? { polishFiles: recorded.polishFiles } : {}),
      ...(recorded.blockingFiles.length > 0 ? { blockingFiles: recorded.blockingFiles } : {}),
      ...(roundScope === undefined ? {} : { scope: roundScope }),
    });
    // Observability: what this round cost and how much of the change it had
    // to judge. The duration is an UPPER BOUND — the reviewer is its own pi
    // process in a pane, which the extension does not watch turn by turn,
    // so all it can measure is the wall clock
    // since the previous gate event (see lib/gate-timings.ts).
    appendTiming(targetRoot, {
      kind: "review",
      at: new Date().toISOString(),
      repo: targetRoot,
      round: st.rounds.length,
      verdict: parsed.verdict,
      scope: scopeNow.scope,
      changedFiles: scopeNow.changedFiles.length,
      changedLines: scopeNow.changedLines,
      approxMs: Math.max(0, Date.now() - lastGateEventAt.current),
      approximate: true,
      fingerprint: fp.unavailable ? "" : fp.digest.slice(0, 12),
    });
    lastGateEventAt.current = Date.now();
    // A new review round changes the token's bound round; drop any standing
    // token explicitly too (defense in depth — tokenAuthorizes already
    // checks round).
    clearBypassToken();

    let note = "";
    if (parsed.verdict === "NEEDS_HUMAN") {
      setLoopArmed(false);
      note = " Auto-loop disarmed — waiting for a human decision.";
    } else if (st.rounds.length >= st.maxRounds) {
      setLoopArmed(false);
      note = ` Max rounds (${st.maxRounds}) reached — escalate to the user.`;
    } else if (isOscillating(st.rounds, OSCILLATION_LIMIT)) {
      // The reviewer keeps flipping READY→BLOCKED with fresh findings instead
      // of converging. Disarm the auto-loop and escalate (tighten-only: this
      // never permits a ship, it only stops the churn so a human/adviser can
      // break the tie). Plateau below stays for the stuck-on-same-finding case.
      setLoopArmed(false);
      note = ` Oscillation detected (${countOscillations(st.rounds)} READY→BLOCKED flips) — ` +
        "the review is not converging. Escalate to the user or consult the adviser (a judge child process) " +
        "instead of burning more rounds.";
    } else if (isPlateaued(st.rounds, PLATEAU_ROUNDS)) {
      setLoopArmed(false);
      note = " Plateau detected — escalate to the user.";
    } else if (parsed.verdict === "BLOCKED") {
      // R10: still blocked and approaching the cap → one-shot rethink nudge.
      note = maybeStrategicReset(st);
    }

    persistRepo(ctx as unknown as ExtensionContext, targetRoot);
    // The repo is named in the TEXT, not just in a details field: a session
    // that could not see which repo its verdicts landed on kept recording
    // READY for the wrong one and read the resulting block as sabotage.
    return `review-gate: recorded verdict ${parsed.verdict} for ${targetRoot} ` +
      `(round ${st.rounds.length}/${st.maxRounds}, findings: ${parsed.findingsTotal}).${note}` +
      (staleTarget
        ? "\nSTALE TARGET: the reviewer approved a commit that is no longer HEAD — a new " +
          "checkpoint landed after prepare_review, so the READY cannot bind to the change now " +
          "in place and is recorded as BLOCKED. This is the expected outcome of fixing while the " +
          "review runs: those fixes are already in, so the next round is short. Re-review the " +
          "current head with ONE call: judge_submit({role:\"reviewer\", task:<what you changed>})."
        : "") +
      (unverified
        ? "\nUNVERIFIED: the READY lands on content that has no full-lane precommit PASS — the round " +
          "was dispatched while its verification was still running (that is how the lane runs beside the " +
          "review instead of blocking it), and that verification did not pass. The verdict is recorded " +
          "as BLOCKED: nothing here is shippable. Fix what precommit reported and submit the round again; " +
          "if it failed for an environment reason unrelated to this change, that is the user's call — " +
          "`/gate-bypass <reason>` covers it and leaves a trace." +
          // TWO WAYS TO GET HERE, AND THEY TELL THE AGENT OPPOSITE THINGS. A lane
          // that is still running will record this very conclusion the moment it
          // passes on this tree (that is the hold's whole point), so re-submitting
          // buys nothing. With NO lane running there is nothing left to wait for
          // and nothing that could replay it — the round concluded after its own
          // verification had already landed without covering this content — so
          // saying "did not pass" would send the agent looking for a failure that
          // does not exist (round-7 finding, and the reason the second case is a
          // refusal at all rather than a hold).
          (withholding === "unverified-idle"
            ? " NOTE: no precommit lane is running for this content — nothing is coming back to verify it, " +
              "so there is nothing to wait for and nothing to replay. Re-submit once you have fixed what " +
              "precommit reported."
            : " A full lane IS still running for this content: if it passes on this same tree, this verdict " +
              "is recorded automatically and you are woken — do NOT re-submit byte-identical content.")
        : "") +
      (cwdMismatch
        ? `\nCWD CHECK FAILED: ${cwdMismatch}. The conclusion requires the judge's own \`pwd\`, ` +
          "and the gate compares it with the repo this round was prepared for — a READY reporting a " +
          "different directory is recorded as BLOCKED. If the reviewer ended inside its throwaway " +
          "worktree, have it `cd` back to the repo root and report that instead."
        : "") +
      // THE QUALITY REFUSAL (2026-09-16): the round's own quality judge never
      // delivered, so this READY was refused rather than held — and the agent
      // must not read it as a finding against its code.
      (qualityRefusal === undefined ? "" : `\nQUALITY PRECONDITION: ${qualityRefusal}`) +
      (parsed.verdict === "READY" ? " Next: run precommit for this same repo." : parsed.verdict === "BLOCKED" ? " Next: fix ALL findings and re-review." : "");
  }

  return { recordReviewVerdict };
}
