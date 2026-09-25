/**
 * WHERE A JUDGE ROUND ENDS — moved out of `extensions/review-gate.ts` (t7,
 * wave 3 of the split): locating this session's own judge of a role, the
 * round binding the probe and the recorder share, recording one finished
 * round (`recordJudgeConclusion`) and the settle sweep that wakes the agent
 * with the standard report (`settleFinishedRounds`).
 *
 * The engine is lib/audit-round-settle.ts; its session deps are built by
 * lib/audit-round-host.ts, and the cancel matrix a recorded round applies is
 * lib/verdict-host.ts's.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { roundBindingFor, type RoundBinding } from "./audit-round-report.ts";
import { settleAuditRound, type SettleAuditRoundDeps } from "./audit-round-settle.ts";
import { channelPathFor, judgeChannelTarget, type ChannelIO } from "./channel-io.ts";
import { projectChannel, readChannel } from "./channel-projection.ts";
import type { ScopeStampRecord } from "./gate-state-records.ts";
import { judgeChildRecordOf, tmuxServerFrom, type JudgeEntry } from "./hierarchy.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import { buildStandardReport } from "./judge-report.ts";
import { probeJudgeRound } from "./judge-wait-criteria.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import type { SessionHost } from "./session-host.ts";

export function createJudgeRoundSettle(
  host: SessionHost,
  deps: {
    pi: ExtensionAPI;
    registry: Pick<
      JudgeRegistry,
      | "judgeHierarchy"
      | "pendingAudits"
      | "ownJudges"
      | "absorbJudgeModelEvents"
      | "reloadJudgeHierarchy"
      | "callerIdentities"
      | "paneOwnerIdentity"
    >;
    channelIO: ChannelIO;
    runTmux: TmuxRunner;
    /** The questions a settle already announced (never re-announced). */
    announcedRequestIds(): Set<string>;
    /** lib/audit-round-host.ts */
    auditRoundDeps(ctx?: unknown): SettleAuditRoundDeps;
    /** lib/verdict-host.ts */
    applyRoundCancel(kind: string | undefined, root: string, ctx?: unknown): Promise<string | undefined>;
    resumeParkedReady(root: string, ctx?: unknown): Promise<string[]>;
  },
) {
  const {
    judgeHierarchy, pendingAudits, ownJudges, absorbJudgeModelEvents,
    reloadJudgeHierarchy, callerIdentities, paneOwnerIdentity,
  } = deps.registry;
  const { pi, channelIO, runTmux, auditRoundDeps, applyRoundCancel, resumeParkedReady } = deps;
  const announcedQuestions = deps.announcedRequestIds;

  /** The judge of one role in one repo THIS session owns, if the registry still holds it. */
  function judgeChildByRole(root: string, role: string): JudgeEntry | undefined {
    return ownJudges().find((e) => e.repoRoot === root && e.role === role);
  }

  /**
   * Locate a judge by ROLE (the agent's vocabulary) or by judge id (the
   * internal key). Role wins when both are given: the agent addresses
   * roles, and a stale id it copied from an old round would silently read the
   * wrong session.
   *
   * Own judges only, in BOTH branches. The id lookup used to run against a Map
   * that could only ever hold this session's own children; against the shared
   * table a bare `judgeHierarchy[id]` would hand back a peer's review, and the
   * caller (judge_wait's `findChild`) treats what it gets as its own.
   */
  function findJudgeChild(root: string, role?: string, judgeId?: string): JudgeEntry | undefined {
    if (role) return judgeChildByRole(root, role);
    if (judgeId) return ownJudges().find((e) => e.judgeId === judgeId);
    return undefined;
  }

  /** `checkpoint.at` of one repo — the content stamp a review verdict binds to. */
  function checkpointAtFor(root: string): string | undefined {
    const st = root === host.repos().primary ? host.state() : host.stateFor(root);
    return st.checkpoint?.at;
  }

  /**
   * THIS round's report binding, derived ONCE and handed to both readers.
   *
   * The recorder (`settleAuditRound`) and the probe (`judge_wait`, the settle
   * sweep) have to agree on "is this report this round's?", and while they did
   * not, a leftover reviewer report ended the wait as a READY that the recorder
   * then bound to a commit the reviewer never saw (four reproductions,
   * 2026-09-05). The RULE lives in lib/audit-round.ts; this only supplies the
   * three facts it needs from THIS session — the pending audit kind, the round
   * this dispatch registered, and the repo's checkpoint stamp.
   */
  function roundBindingOf(judge: { judgeId: string; role: string; repoRoot: string }): RoundBinding {
    const roundSeq = judgeHierarchy()[judge.judgeId]?.roundSeq;
    const pendingKind = pendingAudits.get(judge.repoRoot)?.kind;
    const checkpointAt = checkpointAtFor(judge.repoRoot);
    return roundBindingFor({
      role: judge.role,
      ...(pendingKind === undefined ? {} : { pendingKind }),
      ...(roundSeq === undefined ? {} : { roundSeq }),
      ...(checkpointAt === undefined ? {} : { checkpointAt }),
    });
  }

  /**
   * Read a finished judge's conclusion and RECORD it — the gate's job, not
   * the agent's.
   *
   * The agent used to copy the reviewer's output into a recording tool by
   * hand: a transcription step with nothing creative in it, which could
   * silently carry the wrong round's text. The recorders keep every mechanical
   * check they had (no-prepare refusal, STALE detection, cwd
   * match, tree binding) — this only removes the copying.
   *
   * Returns the recorded summary, or undefined when there was nothing to
   * record (no report for this round yet, an adviser, an unknown child) — the
   * caller then simply tells the agent to read the child.
   */
  /**
   * Close one judge's round — the SETTLE path's entry into the engine.
   *
   * Everything that used to live here (pick this round's report, keep the
   * adviser's prose out of the record, route a verdict to the right recorder,
   * advance the cursor exactly once) is now `settleAuditRound` in
   * lib/audit-round.ts, shared with `judge_wait` and with the synchronous
   * audits. This function only translates the outcome into the shape the two
   * callers here already speak.
   */
  async function recordJudgeConclusion(sessionId: string, ctx?: unknown): Promise<{ text?: string; recorded: boolean; bindingNote?: string; handOffNote?: string; scope?: ScopeStampRecord } | undefined> {
    try {
      const entry = judgeHierarchy()[sessionId];
      if (!entry?.role) return undefined;
      const childRoot = entry.repoRoot || host.repos().primary;
      // The pane's own model report is a fact about the round that is ending
      // here: cool the bad slot down, warn, advance the cursor. This sweep (a
      // session that was NOT blocked in a wait) is a second settle entry point
      // and must read it the same way the wait does — the absorb is idempotent.
      absorbJudgeModelEvents(childRoot, sessionId);
      const settled = await settleAuditRound(auditRoundDeps(ctx), { judgeId: sessionId, root: childRoot });
      switch (settled.status) {
        case "recorded": {
          // A quality round OWNS the functional round that is waiting on it:
          // releasing it (or killing it) is part of the record landing, not a
          // follow-up the agent has to remember (philosophy one).
          const handOffNote = await applyRoundCancel(settled.kind, childRoot, ctx);
          return {
            text: settled.text,
            recorded: true,
            // Its OWN field, not a second line of `text`: the standard report
            // prints the recorded note first-line-only, so a hand-off appended
            // there would never be read (reviewer P1, 2026-09-15).
            ...(handOffNote === undefined ? {} : { handOffNote }),
            // Travels separately: the wake-up prints the record's first line
            // only, and a weaker binding nobody reads about is a silent one.
            ...(settled.bindingNote === undefined ? {} : { bindingNote: settled.bindingNote }),
            // The scope the round stamped on itself, for the same reason: the
            // wake-up is where the opener finds out WHAT was reviewed, and a
            // range recorded somewhere nobody prints is a range nobody checks.
            ...(settled.scope === undefined ? {} : { scope: settled.scope }),
          };
        }
        case "advice":
          return { text: settled.text, recorded: false };
        case "miss":
          // A consumed report on a cursor-bound round says nothing (it is
          // already recorded); every other miss carries its fail-closed text.
          return settled.text === undefined ? undefined : { text: settled.text, recorded: false };
        case "unrecorded":
          return { recorded: false }; // no ctx: stay armed, retry next settle
        default:
          return undefined;
      }
    } catch {
      return undefined; // recording is best-effort
    }
  }

  /**
   * Wake on finished rounds (criterion 4): for every judge THIS session opened,
   * probe the SAME criterion judge_wait used (a new channel report ends the
   * round) and deliver the gate-built standard report — verdict, evidence
   * pointer, record note, open questions — via followUp. Pane-dead rounds stay
   * with the watchdog below (no second waiter). Returns true when it woke.
   */
  async function settleFinishedRounds(ctx: ExtensionContext): Promise<boolean> {
    const primaryRepoRoot = host.repos().primary;
    const announcedRequestIds = announcedQuestions();
    // A PARKED CONCLUSION IS RE-ASKED HERE, ONCE PER SETTLE (2026-09-16).
    //
    // The two landings that can release a hold (the precommit lane, the quality
    // round) both call it themselves; this call is the BACKSTOP for the case
    // where the second one will never come — a quality pane that died after the
    // record was parked, a lane that was aborted by the USER. Without it the
    // record would sit in the sidecar forever while the reply had already told
    // the agent not to re-submit, which is the one failure mode a hold may not
    // have (`decideQualityHold` refuses rather than holds whenever nobody can
    // end it; this covers the pane dying afterwards).
    for (const root of host.repos().all) await resumeParkedReady(root, ctx);
    // A judge may have handed its round to a successor since the last sweep:
    // the new session has a new id, hence a new channel, and this merge is what
    // makes the opener look there.
    reloadJudgeHierarchy(primaryRepoRoot);
    // A handover does not orphan the predecessor's judges: this session is
    // responsible for its own identity AND the one it replaced.
    const mine = new Set(callerIdentities());
    if (mine.size === 0) return false;
    const deps = {
      channelIO: () => channelIO,
      channelHome: () => undefined,
      tmux: (argv: readonly string[]) => runTmux(argv),
      now: () => Date.now(),
      tmuxServer: () => tmuxServerFrom(process.env),
      paneOwner: () => paneOwnerIdentity(),
    };
    const notices: string[] = [];
    for (const [judgeId, entry] of Object.entries(judgeHierarchy())) {
      if (!mine.has(entry.openerId)) continue;
      const target = judgeChannelTarget(entry.openerId, judgeId);
      const read = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home));
      const projection = projectChannel(read.records);
      const freshQuestions = (projection.openRequests ?? []).filter((q) => !announcedRequestIds.has(q.requestId));
      // The sweep probes with the SAME binding the recorder will apply, so it
      // can no longer wake the agent about a round the recorder refuses to
      // close (2026-09-05).
      const obs = probeJudgeRound(
        deps,
        judgeChildRecordOf(entry, entry.repoRoot ?? primaryRepoRoot),
        entry.lastReportId,
        roundBindingOf({ judgeId, role: entry.role, repoRoot: entry.repoRoot ?? primaryRepoRoot }),
      );
      if (!obs.done || obs.reason !== "report") {
        // No new report: announce only brand-new questions (once each) — and,
        // when one goes out, say which leftover report was set aside with it.
        for (const q of freshQuestions) {
          announcedRequestIds.add(q.requestId);
          notices.push(buildStandardReport({
            role: entry.role,
            judgeId,
            ...(entry.modelSpec === undefined ? {} : { modelSpec: entry.modelSpec }),
            openQuestions: [{ title: q.title, options: q.options, requestId: q.requestId }],
            ...(obs.notThisRound === undefined ? {} : { notThisRound: obs.notThisRound }),
          }));
        }
        continue;
      }
      const conclusion = await recordJudgeConclusion(judgeId, ctx);
      if (!conclusion) continue; // consumed elsewhere between probe and record
      for (const q of freshQuestions) announcedRequestIds.add(q.requestId);
      notices.push(buildStandardReport({
        role: entry.role,
        judgeId,
        ...(entry.modelSpec === undefined ? {} : { modelSpec: entry.modelSpec }),
        verdict: obs.verdict,
        findingsCount: obs.findingsCount,
        conclusionExcerpt: entry.role === "adviser" ? conclusion.text : undefined,
        streamPath: entry.streamPath,
        recordedNote: conclusion.recorded ? conclusion.text : undefined,
        bindingNote: conclusion.bindingNote,
        // The hand-off reported on ITS own line: folded into the recorded note
        // it would be invisible (that line prints first-line-only), and the
        // agent would wait for a reviewer the gate failed to start.
        handOffNote: conclusion.handOffNote,
        scope: conclusion.scope,
        unrecorded: !conclusion.recorded && entry.role !== "adviser" ? true : undefined,
        openQuestions: freshQuestions.map((q) => ({ title: q.title, options: q.options, requestId: q.requestId })),
      }));
    }
    if (notices.length === 0) return false;
    pi.sendUserMessage(
      notices.join("\n\n") + "\n\nContinue: drive the loop forward from the report(s) above. Do not summarize; execute.",
      { deliverAs: "followUp" },
    );
    return true;
  }

  return { judgeChildByRole, findJudgeChild, checkpointAtFor, roundBindingOf, recordJudgeConclusion, settleFinishedRounds };
}
