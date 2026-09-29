/**
 * THE AUDIT ROUND ENGINE — one implementation of "dispatch a judge, wait for
 * THIS round, pick its report, adjudicate it, record it".
 *
 * ── WHY THIS MODULE EXISTS (2026-09-05) ──
 *
 * That single round was written THREE times inside
 * `extensions/review-gate.ts`: once for the goal audit (`runGoalAudit`), once
 * for the plan audit (`auditPlanRound`), once for the code review's recording
 * half (`recordRoundOutput`). The three copies did not drift apart in some
 * harmless cosmetic way — the last three P0 fixes in this repository
 * (`8ea7eec`, `a150055`, and the round-binding fix before them) all landed on
 * the SAME defect in that chain, and each had to be applied to whichever copy
 * the bug was noticed in. A defect class that must be fixed three times is a
 * defect class that will be half-fixed.
 *
 * So: the ENGINE is shared, the WORDING is not (task book, philosophy two).
 * What differs per kind is a small `AuditRoundSpec` — the role it dispatches,
 * how its report is bound to a round, and the sentences the caller reads when
 * the round fails closed. What is shared is everything mechanical: which
 * report belongs to this round, the fail-closed rule, the pending bookkeeping.
 *
 * NOTHING HERE CLOSES A PANE (2026-09-27, user decision). A judge window
 * outlives its round — the user wants to read a finished audit, and a window
 * that lived 26 seconds was never seen — and the next round of the same role
 * reuses it through the channel. The one reclaim point is `declare_done`'s
 * cascade (and `closeOwnSession` on exit), for every judge alike.
 *
 * ── THE TWO HALVES, AND WHY THEY ARE TWO ──
 *
 * `runAuditRound` is the SYNCHRONOUS round: goal and plan audits block inside
 * `propose_loop_goal` / `orchestrator_plan({action:"submit"})` for minutes,
 * because the alternative is the multi-step dance an agent has to sequence by
 * hand. `settleAuditRound` is its CONCLUSION half — select, adjudicate,
 * record — and it is separate because a code review does NOT block: it is
 * dispatched by `judge_submit` and concluded later, when the settle path sees
 * its report land. Forcing a code review through the synchronous shape would
 * change a real behaviour, so it is not forced (user decision, 2026-09-05):
 * review enters the engine at the conclusion half only.
 *
 * ── WHAT THIS MODULE DOES NOT OWN ──
 *
 * The record WRITERS stay where they are: `recordGoalPrereview`
 * (lib/goal-prereview-tools.ts) and the extension's `recordReviewVerdict`.
 * They carry bindings this refactor must not touch — a review READY binds to
 * the reviewed commit's TREE and refuses a moved HEAD — so the engine calls
 * them through the spec's `record`, and their bodies are untouched. Only the
 * PLAN record is built here, because it existed twice and had nowhere else to
 * live.
 *
 * Everything the engine cannot own (channel reads, the opener registry,
 * dispatch, waiting, closing) arrives through injected deps, so all three
 * kinds are exercisable end-to-end with a fake channel and a fake hierarchy.
 *
 * ── WHERE THE PARTS LIVE ──
 *
 * This file keeps the SYNCHRONOUS round. The conclusion half
 * (`settleAuditRound`, and the plan record it builds) is
 * lib/audit-round-settle.ts; the one selector of "which report closes this
 * round" and its wording are lib/audit-round-report.ts.
 */

// The WORDING half of the round, and the two facts that select it. It lives in
// its own module because merging the mechanics was the point of this one and
// merging the sentences would have been a mistake.
import type { AuditRoundSpec, PendingAudit } from "./audit-round-specs.ts";
import { settleAuditRound, type SettleAuditRoundDeps } from "./audit-round-settle.ts";
import { existingStreamPath } from "./review-stream.ts";
import { raceAbort } from "./abort-race.ts";
import type { ReportConclusion } from "./channel-projection.ts";

/* ─────────────────────────── the synchronous round ───────────────────────── */

/** What `runVerdictRound` hands back: the report the judge concluded THIS round with. */
export type VerdictRoundOutcome =
  | { ok: true; concluded: ReportConclusion; notes: string }
  | { ok: false; text: string };

/**
 * ONE SYNCHRONOUS ROUND WHOSE CONCLUSION BELONGS TO THE CALLER (2026-09-29).
 *
 * The arbiter's questions (an appeal, a stand-in answer, a semantic guard) are
 * the same round as a goal audit — dispatch, wait for THIS round's report —
 * minus the record: the verdict is an input to the tool call blocked on it, not
 * a fact of the gate's state. So it rides the same dispatch, the same wait and
 * the same conclusion half (`settleAuditRound`, the one place a report is
 * selected), and moves the cursor itself once it has the answer. Fail-closed:
 * any outcome without THIS round's report is `ok: false` with the reason.
 */
export async function runVerdictRound(
  deps: SettleAuditRoundDeps & Pick<RunAuditRoundDeps, "dispatch" | "judgeIdOf"> & {
    awaitRoundEnd(root: string, role: string, budgetMs: number): Promise<{ ok: boolean; detail: string }>;
  },
  input: { spec: AuditRoundSpec; root: string; task: string; budgetMs: number },
): Promise<VerdictRoundOutcome> {
  const { spec, root } = input;
  const dispatched = await deps.dispatch({
    root,
    role: spec.role,
    title: `${spec.titlePrefix}-${deps.nowIso().slice(11, 19).replace(/:/g, "")}`,
    task: input.task,
  });
  if (!dispatched.ok) return { ok: false, text: spec.notDispatched(dispatched.error ?? "pane 未能开出来") };
  const judgeId = deps.judgeIdOf(root, spec.role);
  if (!judgeId) return { ok: false, text: spec.unaddressable() };
  const waited = await deps.awaitRoundEnd(root, spec.role, input.budgetMs);
  if (!waited.ok) return { ok: false, text: spec.unfinished(waited.detail) };
  const settled = await settleAuditRound(deps, { judgeId, root });
  if (settled.status !== "arbiter") {
    return { ok: false, text: settled.status === "miss" && settled.text ? settled.text : spec.unfinished("没有本轮的 report") };
  }
  deps.advanceCursor(judgeId, settled.reportId);
  return { ok: true, concluded: settled.concluded, notes: settled.notes };
}

/**
 * Run `fn` one call at a time: a call starts only after every earlier one has
 * settled (a rejection does not stall the queue).
 */
export function oneAtATime<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let chain: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const turn = chain.then(() => fn(...args));
    chain = turn.catch(() => undefined);
    return turn;
  };
}

/**
 * THE ARBITER QUEUE (2026-09-29): one round at a time (`oneAtATime`), and a
 * caller's budget and abort signal count from the moment it JOINS the queue —
 * a caller that gave up (ESC, the user answered the box) leaves at once and is
 * never dispatched, and one that waited out its budget in line is not either.
 */
export function arbiterQueue<A extends unknown[]>(
  run: (budgetMs: number, signal: AbortSignal | undefined, ...args: A) => Promise<VerdictRoundOutcome>,
  now: () => number = Date.now,
): (budgetMs: number, signal: AbortSignal | undefined, ...args: A) => Promise<VerdictRoundOutcome> {
  const queued = oneAtATime((deadline: number, signal: AbortSignal | undefined, ...args: A) => {
    if (signal?.aborted) return Promise.resolve<VerdictRoundOutcome>({ ok: false, text: "排队时已被取消，没有派出" });
    const left = deadline - now();
    if (left <= 0) return Promise.resolve<VerdictRoundOutcome>({ ok: false, text: "排队等满了预算，没有派出" });
    return run(left, signal, ...args);
  });
  return (budgetMs, signal, ...args) => {
    const turn = queued(now() + budgetMs, signal, ...args);
    return signal === undefined ? turn : raceAbort(turn, signal, { ok: false, text: "已取消" });
  };
}

/** The dispatch half's seams — only the goal and plan audits use them. */
export interface RunAuditRoundDeps extends SettleAuditRoundDeps {
  /**
   * Open (or re-use) the judge pane for this round. `fresh` is the engine's
   * decision, not the caller's: a previous audit still running is judging
   * DIFFERENT content (this one has no PASS yet), so it cannot answer the
   * question being asked now.
   */
  dispatch(input: { root: string; role: string; title: string; task: string; streamPath?: string }):
    { ok: true; judgeId: string } | { ok: false; error?: string }
    | Promise<{ ok: true; judgeId: string } | { ok: false; error?: string }>;
  /** The judge id this repo's role is addressable by, once dispatched. */
  judgeIdOf(root: string, role: string): string | undefined;
  /** Remember what was dispatched — a verdict binds to it. */
  rememberPending(root: string, pending: PendingAudit): void;
  /** Wait for the END of the round (a report), not for its first message. */
  awaitRoundEnd(root: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * Did the recorded verdict actually pass — for the CONTENT this round
   * judged? The pending entry is passed in rather than re-read, because the
   * record is content-bound (a goal to its draft, a plan to its hash) and the
   * pending entry is forgotten the moment the record lands.
   */
  auditPassed(root: string, pending: PendingAudit): boolean;
  /**
   * DID A RECORD FOR **THIS** ROUND LAND — evidence that survives a lost row.
   *
   * The pair of writes a record makes (pending forgotten, cursor advanced) is
   * the older evidence, and half of it lives in the JUDGE REGISTRY — which a
   * close deletes (the since-deleted `judge_close` dropped the row even when the kill failed; the
   * 2026-09-21 round-end reclaim did exactly that until 2026-09-27). So from 2026-09-21 a round the WAIT recorded came back to this
   * chain looking like a round nobody recorded: three consecutive plan audits
   * PASSed, were written to the gate's state and its audit log, and were each
   * reported to the project manager as `fail-closed` with no approval dialog
   * and no way to converge (measured in prime, `.pi/review-gate-audit.log`
   * 186-188; the same round swallowed a goal audit's findings whole).
   *
   * This asks the RECORD instead of the registry: is there a verdict bound to
   * the content this round dispatched, stamped at or after this round started?
   * Both halves are required — the content binding keeps another draft's
   * record out, and the timestamp keeps an EARLIER round's record for
   * IDENTICAL content (a resubmitted draft, which is the common case) from
   * closing a round that has not reported yet.
   */
  recordedThisRound(root: string, pending: PendingAudit): boolean;
  /**
   * The refusal text rebuilt FROM THE RECORD, for a round the wait settled.
   *
   * The recorded note only exists where the record was made, and under the
   * observer-records shape that is usually inside the wait — so a chain that
   * only had its own note would hand back "审计记录：FAIL" and drop every
   * finding the auditor wrote (reviewer P1, 2026-09-05). The record itself
   * still holds them, so the kind that can rebuild its refusal from the record
   * does; one that cannot returns undefined and the label is the fallback.
   */
  recordedRefusal(root: string, pending: PendingAudit): string | undefined;
  /** The verdict label for the refusal text when nothing better exists. */
  verdictLabel(root: string, pending: PendingAudit): string;
}

/**
 * DID THE WAIT ALREADY CLOSE THIS ROUND?
 *
 * `awaitRoundEnd` waits through `judge_wait`, and that tool closes the round
 * through this same engine — so by the time the synchronous chain gets control
 * back, THIS round is usually already recorded. That is the normal path, not a
 * stale verdict: an audit dispatched asynchronously (judge_submit /
 * judge_spawn) is settled by the wait or the settle sweep alone, so settling
 * must work without this chain, and this chain must tolerate being beaten to it.
 *
 * The evidence is the pair of writes `settleAuditRound` makes, and ONLY makes,
 * once a record has actually landed: it forgets the pending audit and it
 * advances the cursor. Requiring BOTH is what keeps this fail-closed —
 * a pending entry that is still armed, or a cursor that never moved, means no
 * record landed, and the chain then settles the round itself (and fails closed
 * if that does not work either).
 *
 * Asking `settleAuditRound` a second time cannot answer this question: the
 * pending entry it needs to pick a kind is exactly what a successful record
 * consumes, so a settled round comes back as `unknown` — indistinguishable
 * from "nothing was ever dispatched" (reviewer P0, 2026-09-05).
 *
 * AND THE CURSOR MAY NOT BE THERE TO READ (2026-09-21): a close — the round-end
 * reclaim then, a user or a `fresh` dispatch now — drops the registry row the
 * cursor lives in, so a round the wait recorded can arrive here with no entry,
 * and the cursor half answers "nothing was recorded" for the one case it was
 * written to detect. `recordedThisRound` is the same question asked of the
 * RECORD, which no reclaim touches; the cursor stays as the cheaper check for
 * the rounds whose entry is still alive, and neither may pass on its own
 * without the pending entry having been consumed.
 */
function roundClosedDuringWait(
  deps: RunAuditRoundDeps,
  input: { judgeId: string; root: string; cursorBefore: string | undefined; pending: PendingAudit },
): boolean {
  if (deps.pendingAudit(input.root) !== undefined) return false;
  if (deps.recordedThisRound(input.root, input.pending)) return true;
  const cursorNow = deps.judgeEntry(input.judgeId)?.lastReportId;
  return cursorNow !== undefined && cursorNow !== input.cursorBefore;
}


/**
 * ONE SYNCHRONOUS AUDIT ROUND — dispatch, wait, conclude.
 *
 * The goal and plan audits are this function, twice, differing only in their
 * spec. It blocks for minutes on purpose: the alternative is handing the agent
 * a half-finished sequence to drive by hand, which is the multi-step dance
 * philosophy one exists to delete.
 *
 * FAIL-CLOSED IS WRITTEN ONCE, HERE. Any outcome that is not "this round's
 * report was recorded and it passed" records nothing and says so — a wait that
 * timed out, a pane that died, a report from another round, a verdict that
 * could not be parsed. No path closes the pane: it stays for the user to read
 * and for the next round of this role to reuse (`declare_done` reclaims it).
 */
export async function runAuditRound(
  deps: RunAuditRoundDeps,
  input: {
    spec: AuditRoundSpec;
    root: string;
    task: string;
    pending: PendingAudit;
    streamPath?: string;
  },
): Promise<{ ok: true } | { ok: false; text: string }> {
  const { spec, root } = input;
  // `await`: a dispatch now EARNS its receipt (it watches the judge's channel
  // for proof the pane came up), so it is allowed to be asynchronous. A
  // synchronous implementation still satisfies the type and is awaited as-is.
  const dispatched = await deps.dispatch({
    root,
    role: spec.role,
    // A display label the ENGINE derives — never the caller's, and never part
    // of the session directory (that is role+repo, so the transcript carries
    // across rounds).
    title: `${spec.titlePrefix}-${deps.nowIso().slice(11, 19).replace(/:/g, "")}`,
    task: input.task,
    ...(input.streamPath === undefined ? {} : { streamPath: input.streamPath }),
  });
  if (!dispatched.ok) {
    return { ok: false, text: spec.notDispatched(dispatched.error ?? "review pane 未能开出来") };
  }
  // The dispatch was ACCEPTED — only now is what it judges on record. A
  // refused submission must never replace the draft a running audit is
  // judging: its verdict would be recorded against text no auditor ever read.
  deps.rememberPending(root, input.pending);
  const judgeId = deps.judgeIdOf(root, spec.role);
  if (!judgeId) return { ok: false, text: spec.unaddressable() };
  // The cursor BEFORE the wait. It is half the evidence that tells "the wait
  // already closed this round" from "nothing was recorded at all" — see
  // `roundClosedDuringWait`.
  const cursorBefore = deps.judgeEntry(judgeId)?.lastReportId;
  const waited = await deps.awaitRoundEnd(root);
  if (!waited.ok) return { ok: false, text: spec.unfinished(waited.detail) };
  // Only a round recorded HERE carries its note; one the wait recorded left
  // its verdict in the gate's state, which `auditPassed` / `verdictLabel`
  // read. (That was already true before this engine existed: the goal chain
  // recorded inside its wait and always fell back to the label.)
  let note: string | undefined;
  if (!roundClosedDuringWait(deps, { judgeId, root, cursorBefore, pending: input.pending })) {
    const settled = await settleAuditRound(deps, { judgeId, root });
    if (settled.status !== "recorded") {
      // A miss already carries the kind's own fail-closed sentence, naming
      // the round it actually saw — re-deriving it here would lose that.
      const text = settled.status === "miss" && settled.text
        ? settled.text
        : spec.unfinished("本轮裁决没能记录下来");
      return { ok: false, text };
    }
    note = settled.text;
  }
  if (deps.auditPassed(root, input.pending)) return { ok: true };
  // WHAT THE CALLER IS TOLD TO FIX. Preference order, and the order matters:
  // this round's own note if it recorded here, else the refusal rebuilt from
  // the RECORD (which still holds the findings even when the wait did the
  // recording), else the bare verdict label.
  // A note that does not already carry the record's refusal gets it appended
  // (D13): the goal recorder's own reply names the verdict, not the findings.
  const fromRecord = deps.recordedRefusal(root, input.pending);
  const refusal = note === undefined || !fromRecord || note.includes(fromRecord)
    ? (note ?? fromRecord)
    : `${note}\n\n${fromRecord}`;
  // A stream path is only worth printing when the auditor actually streamed.
  const streamPath = existingStreamPath(input.streamPath);
  return {
    ok: false,
    text: spec.rejected(refusal || `审计记录：${deps.verdictLabel(root, input.pending)}`, {
      ...(streamPath === undefined ? {} : { streamPath }),
    }),
  };
}
