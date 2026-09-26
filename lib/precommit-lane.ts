/**
 * THE FULL PRECOMMIT LANE that runs BESIDE a review round, moved out of
 * `extensions/review-gate.ts` (t7, wave 3 of the split): the one in-flight
 * lane, its kill switch, the wait for a quiet lane, the launch and its
 * landing, and the `steer` notices that report the landing to the agent.
 *
 * The cancel matrix row the lane's landing applies and the parked conclusion
 * it re-asks live in lib/verdict-host.ts; they arrive here as deps.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildAsyncPrecommitReport,
  buildAsyncPrecommitPass,
  type AsyncPrecommitPass,
  type AsyncPrecommitReport,
} from "./async-precommit-report.ts";
import { nextFullPassTree } from "./gate-state-transitions.ts";
import { roundCancelPlan, type RoundCancelPlan } from "./quality-round.ts";
import { worktreeTree } from "./repo-facts.ts";
import type { CallTool, GateToolResult, SessionHost } from "./session-host.ts";

/** One started lane: its landing, and — once it landed non-PASS — why. */
export interface LaneHandle {
  settled: Promise<void>;
  failure(): string | undefined;
}

export function createPrecommitLane(
  host: SessionHost,
  deps: {
    pi: ExtensionAPI;
    callTool: CallTool;
    toolText(result: GateToolResult): string;
    /** The cancel matrix's applier (lib/verdict-host.ts). */
    applyCancelPlan(plan: RoundCancelPlan, root: string, why?: string): string[];
    /** Re-ask a parked conclusion (lib/verdict-host.ts). */
    resumeParkedReady(
      root: string,
      ctx?: unknown,
      landing?: { laneVerdict: string; coveredTree: string | undefined },
    ): Promise<string[]>;
  },
) {
  const { pi, callTool, toolText, applyCancelPlan, resumeParkedReady } = deps;
  const { log } = host;
  const stateForRepo = (root: string) => host.stateFor(root);
  const persistRepo = (ctx: ExtensionContext, root: string) => host.persistRepo(ctx, root);

  /**
   * THE IN-FLIGHT FULL PRECOMMIT (B1, 2026-09-10).
   *
   * The chain used to be strictly serial: 33s of full precommit, THEN freeze,
   * THEN dispatch — and the agent was blocked for every one of those 33s,
   * because `judge_submit` does not return until the reviewer is dispatched.
   * The precommit does not have to come first: the reviewer judges an
   * IMMUTABLE COMMIT RANGE, so the only thing that must precede the dispatch
   * is the checkpoint. The long pole starts first and the chain runs beside
   * it.
   *
   * WHAT THE CHECKPOINT GATE ACCEPTS WHILE THIS IS SET: content being verified
   * RIGHT NOW, by this session, in this repo. The receipt is the PROMISE, not
   * a file — a restart loses it, and a checkpoint with no live verification is
   * refused exactly as before (fail-closed).
   *
   * WHAT IS NOT WEAKENED: the ship side is untouched. A precommit PASS covers
   * the TREE it ran on, a READY covers the tree of the commit it judged, and a
   * round whose content moved while its precommit ran fails to ship on the
   * REVIEW side — which is exactly where that mismatch is visible.
   */
  let inFlightPrecommit: { root: string; settled: Promise<void>; abort: (why: string) => void } | undefined;

  /**
   * Is a full lane running for this repo RIGHT NOW? — the one read of
   * `inFlightPrecommit` the rest of the gate needs (the checkpoint gate, the
   * verdict recorder's hold, the parked re-ask). `inFlightPrecommit` is
   * cleared in a microtask AFTER the lane's own callback has run, so a lane
   * that is still listed here is one whose callback has not finished.
   */
  function precommitLaneRunning(root: string): boolean {
    return inFlightPrecommit?.root === root;
  }

  /**
   * STOP A LANE WHOSE CONTENT IS ABOUT TO CHANGE (2026-09-15, user requirement).
   *
   * The full lane runs BESIDE the review on purpose, and that is right while
   * the round still stands. When the QUALITY round blocks, it no longer does:
   * the agent is going to edit this content, so the minutes the lane has left
   * verify a tree nobody will ship — and the next submission would wait for a
   * quiet lane (`waitForQuietLane`) before starting the one that matters. So
   * the abort is the whole point: it buys back the wait, not just the CPU.
   *
   * WHAT IT DOES NOT DO: touch the ship bindings. The lane's own landing path
   * treats an aborted run as "no verdict" (it never writes the pass-coverage
   * record and never reports a failure), so nothing is granted and no false
   * FAIL is blamed on a change that never ran.
   */
  function abortPrecommitLane(root: string, why: string): boolean {
    const lane = inFlightPrecommit;
    if (!lane || lane.root !== root) return false;
    lane.abort(why);
    return true;
  }

  /**
   * ONE LANE AT A TIME, AND IT MUST BE THIS ROUND'S (round-4 P2).
   *
   * The first version JOINED a running lane: same repo, so "this repo is being
   * verified" — which is true and also not enough. The running lane is
   * verifying an EARLIER content, and a PASS it writes when it finishes would
   * satisfy `readyLacksVerification` for a round whose checkpoint holds
   * something else. The ship gate's fingerprint match is still the real
   * backstop there, but this layer's own claim — "a READY without a full-lane
   * PASS is withheld" — would be false in exactly that sequence.
   *
   * So a round that finds a lane already running WAITS for it to finish and
   * then starts its own. The wait is bounded by one lane (and it only happens
   * when the agent submitted twice inside a single run of it); what it buys is
   * that the verdict on record always belongs to the content under review.
   */
  async function waitForQuietLane(root: string): Promise<void> {
    while (inFlightPrecommit?.root === root) {
      const running = inFlightPrecommit;
      await running.settled;
      if (inFlightPrecommit === running) return;
    }
  }

  /**
   * Start the full lane in the BACKGROUND and return immediately.
   *
   * ONE PER REPO: a second round submitted while the first is still verifying
   * would run two full suites side by side, fighting for the same cores and
   * the same cache file. The second round JOINS the first — that promise is
   * the same "this repo is being verified right now" receipt either way.
   *
   * `failure()` is THIS lane's own landing, read by the round that started it
   * (t8, 2026-09-27): the matrix's lane row can only kill a reviewer that is
   * already registered, and a lane that fails in 0.2s lands while the quality
   * pane is still booting — so the dispatch asks before (and right after)
   * starting the reviewer. Bound to this lane, so no earlier round leaks in.
   */
  function startPrecommitBeside(root: string, ctx: unknown): LaneHandle {
    let failedWhy: string | undefined;
    // The lane's kill switch (see `abortPrecommitLane`). ONE controller per
    // lane, held with the promise so a blocking quality verdict can reach it.
    const controller = new AbortController();
    // No joining: the caller waits for a quiet lane first (see
    // `waitForQuietLane`), so this is always THIS round's verification.
    //
    // THIS ROUND'S VERIFICATION HAS NO VERDICT YET, and saying so is what makes
    // the checkpoint gate's test exact. `inFlightPrecommit` is cleared in a
    // microtask after the promise settles, so for an instant a FINISHED — and
    // possibly FAILED — lane still looks in-flight. Resetting the record first
    // means the gate reads the VERDICT, which the runner writes the moment it
    // has one: once there is a verdict, the content is no longer pending.
    //
    // (A previous round's PASS is discarded by this reset. That is the
    // fail-closed direction: the only thing it can cost is a re-run.)
    stateForRepo(root).precommit = {
      verdict: "NOT_RUN",
      fingerprint: null,
      at: new Date().toISOString(),
      mode: "full",
    };
    // WHAT THIS LANE IS VERIFYING, READ BEFORE IT STARTS. Read here and not off
    // the run's own outcome, because the outcome's fingerprint is recomputed
    // AFTER the runner (lint:fix may have edited files) — i.e. it can already be
    // the NEXT round's content. This one is the frozen content this lane was
    // launched against, and it is what the notice names.
    const round = stateForRepo(root).rounds.length + 1;
    const settled = (async () => {
      let verdict = "no verdict";
      let detail = "";
      const verified = worktreeTree(root) ?? "";
      try {
        const pre = await callTool("run_precommit", { mode: "full", repo: root }, ctx, undefined, controller.signal);
        verdict = String(pre.details?.verdict ?? "no verdict");
        detail = toolText(pre);
      } catch (error) {
        detail = (error as Error).message;
      }
      // AN ABORTED LANE IS NOT A RESULT (user requirement, 2026-09-15: "质量
      // 审核失败，precommit 应该结束掉"). The content is about to change, so
      // this run's remaining minutes were spent on a tree nobody will ship:
      // it reports nothing, revokes nothing, and — the one fact that has to
      // survive — leaves NO PASS standing for content it never finished.
      if (controller.signal.aborted) {
        const st = stateForRepo(root);
        // REPLACED WHOLESALE, which is what revokes the coverage record: the
        // fresh object simply has no `lastFullPassTree`, `testScope` or PASS
        // fingerprint. (An earlier version also ran `delete
        // st.precommit.lastFullPassTree` right after this — dead code against
        // the object it had just built, and it made the revocation look like
        // the delete's doing. reviewer Nit, 2026-09-15.)
        st.precommit = { verdict: "NOT_RUN", fingerprint: null, at: new Date().toISOString(), mode: "full" };
        persistRepo(ctx as unknown as ExtensionContext, root);
        log(`precommit lane for ${root} aborted — nothing recorded for the content it was verifying`);
        return;
      }
      // THE PASS-COVERAGE RECORD (2026-09-14). `st.precommit` is a LIVE binding
      // that the session's own next edit invalidates on purpose — so the tree
      // THIS lane verified is written down separately, and `verified` is the
      // tree captured BEFORE the run: the runner's own fingerprint is
      // recomputed after it (lint:fix may have edited files) and can already
      // belong to the next round's content, which would record a tree no lane
      // ever ran on. The rule itself is `nextFullPassTree` (pure, in
      // lib/gate-state.ts); only the effect lives here.
      //
      // WHAT THE LANE COVERED COMES FROM THE GATE'S OWN RECORD, not from the
      // tool's reply. The reply's `details` never carried `testScope` (only
      // verdict/checksRun/repo/logPath/failedSteps), so an earlier version of
      // this call read `undefined`, never matched the PASS branch, and never
      // wrote anything — silently, with every test green (reviewer P1,
      // 2026-09-14). `st.precommit.testScope` is written by that same run and
      // is read by the SHIP gate, so it cannot go missing unnoticed the way a
      // field only this caller read could.
      const laneState = stateForRepo(root);
      const coveredTree = nextFullPassTree({
        current: laneState.precommit.lastFullPassTree,
        verdict,
        mode: "full",
        testScope: laneState.precommit.testScope,
        startedTree: verified,
      });
      if (coveredTree !== laneState.precommit.lastFullPassTree) {
        if (coveredTree === undefined) delete laneState.precommit.lastFullPassTree;
        else laneState.precommit.lastFullPassTree = coveredTree;
        persistRepo(ctx as unknown as ExtensionContext, root);
      }
      // WHAT THE LANE'S LANDING DOES TO THE ROUND (2026-09-16).
      //
      // FIRST, the cancel matrix's lane row: a FAILED lane ends the functional
      // round (its judge would spend minutes judging content the gate already
      // refuses to ship), while the QUALITY round carries on — it reads code,
      // and a failing suite says nothing about the code's quality. The abort is
      // already in effect for this lane: it is the lane itself landing.
      // THE LANE'S OWN ROW OF THE MATRIX, through the same table and the same
      // applier the judges' rows use — INCLUDING the PASS case, which the table
      // answers with "nothing" (a caller-side `if` would be the second copy of
      // that row the quality round caught on 2026-09-16).
      //
      // WHAT IT RETURNED IS DELIVERED, NOT DROPPED (quality round P2,
      // 2026-09-16): a judge's row has a sibling verdict whose standard report
      // carries its notes, and the lane's row has none — dropped here, 「本轮有
      // judge 判了非 READY，正在跑的全量 precommit 已终止」 reached nobody, and
      // the agent only saw "precommit failed" with no trace of why. The FAIL
      // notice below IS this row's delivery.
      const laneWhy = `全量 precommit 没过（${verdict}）—— 这份内容 ship 不了，功能轮不必再审`;
      if (verdict !== "PASS") failedWhy = laneWhy;
      const laneCancelNotes = applyCancelPlan(roundCancelPlan({ party: "lane", verdict }), root, laneWhy);
      // THEN the parked conclusion, re-asked from BOTH halves (`resumeParkedReady`
      // consults the trees, what THIS landing measured and the quality standing):
      // a non-PASS lane retires the parked round, a PASS on exactly that tree
      // WITH the quality verdict in hand replays it, and anything still owed
      // leaves it parked for the landing that is owed.
      await resumeParkedReady(root, ctx, { laneVerdict: verdict, coveredTree });
      // THE LANE'S LANDING IS AN EVENT EITHER WAY (2026-09-16). A PASS used to
      // be silent, and that silence is exactly what stranded a session in a
      // `judge_wait` it could not end: the report it had received said
      // 「正在等 precommit lane 落地（HELD）」, and nothing ever came to say it
      // had (measured: 6m47s, notification session 2026-09-15). FAIL keeps its
      // loud form; PASS gets the short one — there is nothing to do about it.
      if (verdict === "PASS") {
        reportAsyncPrecommitPass({ round, verified, current: worktreeTree(root) ?? "" });
      } else {
        // TELL THE AGENT (B1). The content the reviewer approved did not pass
        // its verification, so this round cannot produce a shippable READY —
        // and the failure channel names THAT reason, not "findings".
        reportAsyncPrecommit({
          round,
          verified,
          current: worktreeTree(root) ?? "",
          verdict,
          detail,
          ...(laneCancelNotes.length === 0 ? {} : { laneNotes: laneCancelNotes }),
        });
      }
    })();
    inFlightPrecommit = {
      root,
      settled,
      abort: (why: string) => {
        if (controller.signal.aborted) return;
        log(`precommit lane for ${root} aborting: ${why}`);
        controller.abort();
      },
    };
    void settled.finally(() => {
      if (inFlightPrecommit?.settled === settled) inFlightPrecommit = undefined;
    });
    return { settled, failure: () => failedWhy };
  }

  /**
   * TELL THE AGENT (B1). The round was dispatched before this verdict existed,
   * so nothing else will: a silent FAIL would leave a round that looks
   * dispatched and verified sitting inside a gate that will not ship it.
   *
   * `steer`, NOT `followUp` (2026-09-12). pi drains a follow-up message only
   * when the agent has no more tool calls — and this gate's own standing rule
   * forbids the agent to stop while a gate is unmet, so a follow-up here is
   * drained hours later, or never. Measured: three of these sat in the queue
   * behind a single 2.5-hour turn and were delivered at 05:14/05:21/05:24 for
   * failures from 03:01/03:15/03:23, long after the gate's own records said
   * PASS + READY, so the agent read them as the gate contradicting itself.
   * `steer` delivers at the next tool-batch boundary — the agent cannot be busy
   * for long without a tool call, and this message is the thing it must know
   * before its next one. The bound is therefore ONE TOOL CALL rather than the
   * whole turn (a long `judge_wait` is the worst case, minutes; before this it
   * was hours, or the end of the session).
   *
   * The wording rules (round identity, and downgrading when the content under
   * review has moved on) live in lib/async-precommit-report.ts.
   */
  function reportAsyncPrecommit(input: AsyncPrecommitReport): void {
    deliverPrecommitNotice(buildAsyncPrecommitReport(input));
  }

  /**
   * A PASS lands too — and this is the ONLY thing that says so
   * (2026-09-16): a session told it is 「等 precommit lane 落地」 has no other
   * event to wake on, so a silent PASS is indistinguishable from a lane that
   * never ran. Same delivery as the failure notice, on purpose: `steer`
   * reaches the agent at its next tool-call boundary, and the whole point is
   * that it stops waiting NOW.
   */
  function reportAsyncPrecommitPass(input: AsyncPrecommitPass): void {
    deliverPrecommitNotice(buildAsyncPrecommitPass(input));
  }

  function deliverPrecommitNotice(message: string): void {
    try {
      pi.sendMessage(
        { customType: "review-gate", content: message, display: true },
        { triggerTurn: true, deliverAs: "steer" },
      );
    } catch {
      try { host.ctx()?.ui.notify(message.slice(0, 400), "error"); } catch { /* headless */ }
    }
  }

  return { precommitLaneRunning, abortPrecommitLane, waitForQuietLane, startPrecommitBeside };
}
