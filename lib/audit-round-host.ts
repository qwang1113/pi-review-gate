/**
 * WHAT THE AUDIT-ROUND ENGINE NEEDS FROM THIS SESSION, moved out of
 * `extensions/review-gate.ts` (t7, wave 3 of the split): the conclusion
 * half (`auditRoundDeps` — the channel read, the cursor, the recorders, the
 * round-end pane reclaim) and the synchronous half (`auditRunDeps` —
 * dispatch, the gate's own wait, the O-6 close, the content-bound "did it
 * pass?"), plus the goal-auditor's task builder and the one close path for a
 * judge this session opened.
 *
 * The DECISIONS are lib/audit-round.ts's; this module only supplies facts and
 * effects. The recorders themselves are lib/verdict-host.ts's.
 */

import { mkdirSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunAuditRoundDeps } from "./audit-round.ts";
import type { SettleAuditRoundDeps } from "./audit-round-settle.ts";
import { appendRecord, channelPathFor, judgeChannelTarget, reportText, type ChannelIO } from "./channel-io.ts";
import { classifyAuditWaitFailure, watchAuditRound } from "./audit-wait-watch.ts";
import type { ChoiceSpec } from "./choice-dialog.ts";
import { readChannel, reportConclusion, sanitizeContextPercent, type ReportConclusion } from "./channel-projection.ts";
import type { ChannelRecord, ChannelReportRecord } from "./channel-records.ts";
import { recordGoalPrereview, type GoalPrereviewDeps } from "./goal-prereview-tools.ts";
import { registerJudge, type JudgeEntry } from "./hierarchy.ts";
import { JUDGE_PANE_RECLAIM, reclaimAuditLine, type JudgePaneReclaimOutcome } from "./judge-pane-policy.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import type { JudgeDispatch } from "./judge-round-dispatch.ts";
import { doClose, type JudgeSessionToolDeps } from "./judge-session-tools.ts";
import { goalPrereviewPassed, goalTextHash } from "./loop-goal.ts";
import { formatPlanAuditRefusal } from "./orchestrator-plan-audit.ts";
import type { ToolUpdate } from "./progress-stream.ts";
import { buildStreamDirective } from "./review-stream.ts";
import type { CallTool, GateToolResult, Ref, SessionHost } from "./session-host.ts";

/** The coordinates a human can find the judge by. */
function judgePlace(judge: JudgeEntry): { tmuxSession?: string; windowId?: string; paneId?: string } {
  return {
    ...(judge.tmuxSession === undefined ? {} : { tmuxSession: judge.tmuxSession }),
    ...(judge.windowId === undefined ? {} : { windowId: judge.windowId }),
    ...(judge.paneId === undefined ? {} : { paneId: judge.paneId }),
  };
}

type Progress = { step?: (t: string) => void; done?: (t: string) => void; fail?: (t: string) => void; tail?: (t: string) => void };

export function createAuditRoundHost(
  host: SessionHost,
  deps: {
    registry: Pick<JudgeRegistry, "judgeHierarchy" | "setHierarchy" | "dropAudits" | "pendingAudits" | "persistJudgeHierarchy">;
    channelIO: ChannelIO;
    lastUiCtx: Ref<ExtensionContext | undefined>;
    callTool: CallTool;
    toolText(result: GateToolResult): string;
    extractTaskText(prepared: string): string;
    goalPrereviewDeps: GoalPrereviewDeps;
    /** lib/judge-round-settle.ts */
    judgeChildByRole(root: string, role: string): JudgeEntry | undefined;
    checkpointAtFor(root: string): string | undefined;
    /** lib/judge-round-dispatch.ts */
    dispatchJudgeRound(opts: { root: string; role: string; title: string; task: string; fresh?: boolean; streamPath?: string }): Promise<JudgeDispatch>;
    /** lib/verdict-host.ts */
    recordReviewVerdict(concluded: ReportConclusion, repo: string, ctx: unknown): Promise<string>;
    recordQualityVerdict(concluded: ReportConclusion, repo: string, ctx: unknown): Promise<string | undefined>;
    recordAcceptanceVerdict(concluded: ReportConclusion, repo: string, ctx: unknown): Promise<string | undefined>;
    /** The gate's own wait and close (the extension's judge-session wiring). */
    selfAuditWait(root: string, ctx: unknown, onUpdate: ToolUpdate | undefined, signal: AbortSignal | undefined): Promise<GateToolResult>;
    forwardWaitUpdates(progress: { tail?(text: string): void; step?(t: string): void } | undefined): ToolUpdate | undefined;
    selfSessionDeps(): JudgeSessionToolDeps;
    /** The gate's own dialog — how an auditor's question reaches the user while the gate waits. */
    askUser(spec: ChoiceSpec, signal: AbortSignal): Promise<string | undefined>;
  },
) {
  const { judgeHierarchy, setHierarchy, dropAudits, pendingAudits, persistJudgeHierarchy } = deps.registry;
  const {
    channelIO, lastUiCtx, callTool, toolText, extractTaskText, goalPrereviewDeps,
    judgeChildByRole, checkpointAtFor, dispatchJudgeRound,
    recordReviewVerdict, recordQualityVerdict, recordAcceptanceVerdict,
    selfAuditWait, forwardWaitUpdates, selfSessionDeps, askUser,
  } = deps;
  const { log } = host;
  const stateForRepo = (root: string) => host.stateFor(root);
  /** `state` for the primary repo, the repo's own state otherwise — read fresh. */
  const stateOf = (root: string) => (root === host.repos().primary ? host.state() : stateForRepo(root));

  /** Advance the consumed cursor so a surfaced-but-unrecorded report is not re-announced. */
  function advanceReportCursor(sessionId: string, reportId: string): void {
    const entry = judgeHierarchy()[sessionId];
    if (!entry || entry.lastReportId === reportId) return;
    const reg = registerJudge(judgeHierarchy(), { ...entry, lastReportId: reportId });
    if (reg.ok) setHierarchy(reg.table);
  }

  /**
   * Record what a judge last said about its OWN context usage.
   *
   * The reading only exists inside the judge's process, so it rides its report
   * (lib/channel-records.ts) and lands here — the opener's registry —
   * where the next dispatch's rotation policy reads it. Taken from the NEWEST
   * report that carries one: a report from an older build carries none, and
   * "none" must leave the previous reading alone rather than erase it.
   */
  function noteJudgeContextFrom(judgeId: string, records: readonly ChannelRecord[]): void {
    const entry = judgeHierarchy()[judgeId];
    if (!entry) return;
    let percent: number | undefined;
    for (const record of records) {
      if (record.kind !== "report") continue;
      const reading = sanitizeContextPercent((record as ChannelReportRecord).contextPercent);
      if (reading !== undefined) percent = reading;
    }
    if (percent === undefined || percent === entry.contextPercent) return;
    const reg = registerJudge(judgeHierarchy(), { ...entry, contextPercent: percent });
    if (reg.ok) setHierarchy(reg.table);
  }

  /**
   * WHAT THE AUDIT-ROUND ENGINE NEEDS FROM THIS SESSION.
   *
   * The engine (lib/audit-round.ts) owns the DECISIONS — which report closes
   * this round, whether anything may be recorded, which kind's binding
   * applies, when the cursor advances. This object owns only the things it
   * cannot: the channel, the opener registry, gate state and the two record
   * writers whose bodies this refactor deliberately left alone
   * (`recordGoalPrereview` and `recordReviewVerdict` — the review one carries
   * the HEAD/TREE bindings a READY hangs on).
   *
   * `ctx` is the live tool context when there is one; without it the writers
   * fall back to the last UI context, and with neither they record NOTHING and
   * say so, which the engine turns into "stay armed, retry next settle".
   */
  /**
   * THE ONE CLOSE PATH for a judge THIS session opened.
   *
   * Two callers, one implementation (2026-09-21): the gate's synchronous
   * chains (`auditRunDeps.closeJudge`) and the round-end reclaim that now
   * frees an AGENT-dispatched review pane too
   * (`auditRoundDeps.reclaimJudgePane`). They are one function on purpose —
   * "read hadPane BEFORE the close, close by judgeId, map the reply's outcome"
   * is exactly the sequence whose two copies drift, and a reclaim that reports
   * the wrong outcome is a leftover pane nobody can find again (`judge_close`
   * drops the registry row even when the kill fails).
   *
   * SAME BYPASS AS THE WAIT (2026-09-08): the gate reclaims a judge it opened
   * itself — `callTool("judge_close", { repo: root })` would refuse on an
   * unedited repo and leak the pane (measured: five "judge pane 回收失败…is not
   * one of the repositories" in the audit log). `doClose` by judgeId keeps the
   * opener check and skips only the repo-addressing.
   */
  async function closeOwnedJudge(
    root: string,
    judgeId: string | undefined,
    role: string,
  ): Promise<JudgePaneReclaimOutcome> {
    // `hadPane` is read HERE, before the close, because it is the only moment
    // it is still knowable.
    const hadPane = judgeChildByRole(root, role)?.paneId !== undefined;
    if (judgeId === undefined) {
      return { ok: true, hadPane: false, terminated: false, note: "no judge on record — nothing to close." };
    }
    const closed = await doClose(selfSessionDeps(), { role, sessionId: judgeId }, true); // gateSelf: this session opened it
    return {
      ok: closed.isError !== true && (closed.details as { closed?: unknown } | undefined)?.closed === true,
      hadPane,
      terminated: (closed.details as { terminated?: unknown } | undefined)?.terminated === true,
      note: toolText(closed as { content: { type: string; text: string }[] }).split("\n")[0]?.trim() || undefined,
    };
  }

  function auditRoundDeps(ctx?: unknown): SettleAuditRoundDeps {
    return {
      judgeEntry: (judgeId) => {
        const e = judgeHierarchy()[judgeId];
        if (!e) return undefined;
        return {
          judgeId: e.judgeId,
          openerId: e.openerId,
          role: e.role,
          ...(e.roundSeq === undefined ? {} : { roundSeq: e.roundSeq }),
          ...(e.lastReportId === undefined ? {} : { lastReportId: e.lastReportId }),
        };
      },
      readRoundRecords: (entry) => {
        try {
          const target = judgeChannelTarget(entry.openerId, entry.judgeId);
          const records = readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home)).records;
          // The same read that finds this round's report also carries the
          // judge's own context reading — the one fact the opener cannot
          // measure and the rotation policy needs before the NEXT dispatch.
          noteJudgeContextFrom(entry.judgeId, records);
          return records;
        } catch {
          return []; // an unreadable channel is "no report", never a verdict
        }
      },
      conclusionOf: (report) => reportConclusion(channelIO, report),
      proseOf: (report) => reportText(channelIO, report),
      advanceCursor: (judgeId, reportId) => advanceReportCursor(judgeId, reportId),
      // ROUND END FREES THE PANE (2026-09-21, user decision): a review pane no
      // longer waits for declare_done. The verdict is already on record — what
      // the judge produced is the opener's — so the pane is screen space, and
      // closing it costs no context: the next `judge_submit` for this role
      // finds a dead pane and re-opens the SAME session id, transcript and all.
      reclaimJudgePane: async (root, judgeId, role) => {
        const outcome = await closeOwnedJudge(root, judgeId, role);
        // SILENCE IS THE NORMAL CASE (lib/judge-pane-policy.ts): a reclaim that
        // did what the policy promises is not news, and a log that records every
        // success is a log nobody greps. A line appears only when the pane's fate
        // is NOT what the policy promises — which is the one moment the leftover
        // pane would otherwise become unfindable (the registry row is dropped
        // even when the kill failed).
        const line = reclaimAuditLine({ role, policy: JUDGE_PANE_RECLAIM, outcome });
        if (line !== undefined) log(line);
        return outcome;
      },
      pendingAudit: (root) => pendingAudits.get(root),
      forgetPending: (root) => dropAudits(root),
      nowIso: () => new Date().toISOString(),
      checkpointAt: (root) => checkpointAtFor(root),
      savePlanAudit: (root, record) => {
        const st = stateOf(root);
        st.planAudit = record;
        // (The audit VERDICT is written to `.pi/review-gate-audit.log` by
        // lib/audit-round.ts itself, through the `log` binding below — the
        // record and its trail are decided in one place, not two.)
        try {
          const persistCtx = host.ctx() ?? lastUiCtx.current;
          if (persistCtx) host.persistRepo(persistCtx, root); else host.persist(undefined);
        } catch { /* best effort */ }
      },
      log: (message) => { log(message); },
      recordGoal: async ({ root, pending, concluded }) => {
        const recordCtx = ctx ?? lastUiCtx.current;
        if (!recordCtx) return undefined;
        return recordGoalPrereview(goalPrereviewDeps, {
          goal: pending.draft,
          conclusion: concluded,
          auditStartedAt: pending.startedAt,
          repo: root,
        }, recordCtx);
      },
      // The repo is named explicitly: a multi-repo session refuses an
      // unqualified record, and a verdict must never depend on which repo was
      // edited last.
      recordReview: async ({ root, concluded }) => {
        const recordCtx = ctx ?? lastUiCtx.current;
        if (!recordCtx) return undefined;
        return recordReviewVerdict(concluded, root, recordCtx);
      },
      recordQuality: async ({ root, concluded }) => {
        const recordCtx = ctx ?? lastUiCtx.current;
        if (!recordCtx) return undefined;
        return recordQualityVerdict(concluded, root, recordCtx);
      },
      // The acceptance round's recorder — the sixth, wired exactly like the
      // quality one: the round ENDS when its report lands, and what the report
      // says is adjudicated here, never by the agent.
      recordAcceptance: async ({ root, concluded }) => {
        const recordCtx = ctx ?? lastUiCtx.current;
        if (!recordCtx) return undefined;
        return recordAcceptanceVerdict(concluded, root, recordCtx);
      },
    };
  }

  /**
   * THE goal-auditor's task for one draft — assembled in ONE place.
   *
   * It used to be assembled three times, verbatim: in `runGoalAudit`, in
   * `judge_submit`'s goal-auditor branch, and in `judge_spawn`'s dep. Each
   * copy derived the same stream path, made the same directory and appended
   * the same stream directive, which is three chances to drift on where a
   * round's findings are written.
   */
  async function buildGoalAuditRound(draft: string, root: string, ctx: unknown):
    Promise<{ ok: true; task: string; streamPath: string } | { ok: false; error: string }> {
    const prepared = await callTool("prepare_goal_audit", { goal: draft, repo: root }, ctx);
    if (prepared.isError) return { ok: false, error: toolText(prepared) };
    const streamPath = pathJoin(root, ".pi", "review-stream", `goal-${goalTextHash(draft).slice(0, 12)}.jsonl`);
    try { mkdirSync(pathJoin(streamPath, ".."), { recursive: true }); } catch { /* the stream is optional */ }
    return {
      ok: true,
      task: `${extractTaskText(toolText(prepared))}\n\n${buildStreamDirective(streamPath)}`,
      streamPath,
    };
  }

  /**
   * The engine's deps for a SYNCHRONOUS round (goal / plan): the conclusion
   * half above, plus the four things only a blocking round needs — dispatch,
   * the wait, the O-6 close, and the content-bound "did it pass?".
   */
  function auditRunDeps(
    ctx: unknown,
    progress: Progress | undefined,
    signal: AbortSignal | undefined,
  ): RunAuditRoundDeps {
    const waitCtx = ctx ?? host.ctx();
    return {
      ...auditRoundDeps(ctx),
      dispatch: async ({ root, role, title, task, streamPath }) => {
        const dispatched = await dispatchJudgeRound({
          root,
          role,
          title,
          task,
          fresh: true,
          ...(streamPath === undefined ? {} : { streamPath }),
        });
        if (!dispatched.ok) {
          return { ok: false, ...(dispatched.error === undefined ? {} : { error: dispatched.error }) };
        }
        return { ok: true, judgeId: dispatched.judgeId ?? "" };
      },
      judgeIdOf: (root, role) => judgeChildByRole(root, role)?.judgeId,
      rememberPending: (root, pending) => {
        pendingAudits.set(root, pending);
        persistJudgeHierarchy();
      },
      // Wait through the SAME implementation `judge_wait` uses, but for the
      // END of the round: a streamed finding or a question — which every
      // auditor produces before it concludes — must not read as an unfinished
      // audit. Wait motion is forwarded into the chain's own progress, else a
      // minutes-long audit shows no motion at all.
      awaitRoundEnd: async (root) => {
        // THE GATE WAITS ON ITSELF (2026-09-08): this chain dispatched the
        // auditor itself and holds its judgeId, so it waits through `doWait`
        // DIRECTLY — routing through `callTool("judge_wait", { repo: root })`
        // would re-run `addressJudge`'s "has this session edited that repo"
        // check and refuse a legitimate self-audit of an unedited repo
        // (measured: five consecutive "等待未命中本轮 report"). The opener
        // check still runs inside `doWait`; only the repo-addressing is
        // bypassed. Waiting semantics are untouched: same round-end rule via
        // `awaitRoundReport` — see `selfAuditWait`.
        //
        // BESIDE THE WAIT (2026-09-27): the auditor's questions go to the user
        // and the progress line says where it runs and for how long — see
        // lib/audit-wait-watch.ts for the incident this answers.
        const judge = judgeChildByRole(root, "goal-auditor");
        const since = pendingAudits.get(root)?.startedAt ?? judge?.spawnedAt ?? new Date().toISOString();
        const target = judge ? judgeChannelTarget(judge.openerId, judge.judgeId) : undefined;
        const readRecords = () => target
          ? readChannel(channelIO, channelPathFor(target.orchestrationId, target.childId, target.home)).records
          : [];
        // The watcher owns the tail; the inner wait's own text rides under it.
        let innerText = "";
        let watchLine = "";
        const publish = () => progress?.tail?.([watchLine, innerText].filter(Boolean).join("\n"));
        const inner = forwardWaitUpdates(progress?.tail ? { tail: (t) => { innerText = t; publish(); } } : progress);
        const waiting = selfAuditWait(root, waitCtx, inner, signal);
        const watching = judge && target
          ? watchAuditRound({
              readRecords,
              ask: (spec, askSignal) => askUser(spec, askSignal),
              writeAnswer: (requestId, answer) => {
                appendRecord(channelIO, target, { kind: "answer", from: "orchestrator", at: new Date().toISOString(), requestId, answer });
              },
              progress: (line) => {
                if (progress?.tail) { watchLine = line; publish(); } else progress?.step?.(line.split("\n")[0]!);
              },
              now: () => Date.now(),
              sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            }, {
              where: { role: judge.role, ...judgePlace(judge) },
              since,
              startedAtMs: Date.now(),
              stop: waiting,
            })
          : Promise.resolve();
        const waited = await waiting;
        await watching;
        const details = (waited.details ?? {}) as { done?: unknown; reason?: unknown };
        if (!waited.isError && details.done === true && details.reason === "report") {
          return { ok: true, detail: "" };
        }
        if (details.reason === "cancelled") {
          return { ok: false, detail: "本轮已被门禁终止（没有 pane 可重开，按 findings 修完重送）" };
        }
        let records: ChannelRecord[] = [];
        try { records = readRecords(); } catch { /* unreadable ⇒ classified as no report */ }
        const why = classifyAuditWaitFailure({
          paneAlive: details.reason === "pane-dead" ? false : undefined,
          records,
          since,
        });
        const where = judge ? `（${judge.role} 在 ${judgePlace(judge).tmuxSession ?? "?"}:${judgePlace(judge).windowId ?? "?"}）` : "";
        return { ok: false, detail: `${why.text}${where}` };
      },
      // THE RECLAIM, AND WHAT IT ACHIEVED. The reply used to be awaited and
      // thrown away, which is where a half-done reclaim went to die:
      // `judge_close` drops the registry row even when the kill FAILS, so
      // after that reply is discarded the leftover pane is unreachable — the
      // row it would be found by no longer exists. `hadPane` is read HERE,
      // before the close, because it is the only moment it is still knowable.
      closeJudge: async (root, role) => closeOwnedJudge(root, judgeChildByRole(root, role)?.judgeId, role),
      auditPassed: (root, pending) => {
        const st = stateOf(root);
        if (pending.kind === "goal") return goalPrereviewPassed(st.goalPrereview, pending.draft);
        // The same content binding `planAuditPassed` applies, stated against
        // the hash this round dispatched: a plan edited between the audit and
        // the dialog cannot ride in on someone else's PASS.
        return st.planAudit?.verdict === "PASS" && st.planAudit.hash === pending.hash;
      },
      // THE EVIDENCE THE RECLAIM CANNOT ERASE (2026-09-21). Same content
      // binding as `auditPassed`, but blind to the VERDICT — a recorded FAIL
      // closes the round just as much as a PASS does, and reading it as "not
      // recorded" is what threw the auditor's findings away and sent the
      // caller a fail-closed notice instead. The timestamp is what keeps an
      // earlier round's record for identical content from closing this one.
      recordedThisRound: (root, pending) => {
        const st = stateOf(root);
        const record = pending.kind === "goal"
          ? (st.goalPrereview?.hash === goalTextHash(pending.draft) ? st.goalPrereview : undefined)
          : (st.planAudit?.hash === pending.hash ? st.planAudit : undefined);
        return record !== undefined && record.at >= pending.startedAt;
      },
      // Rebuilt from the RECORD, so a round the wait settled still hands the
      // caller its findings instead of a bare "审计记录：FAIL". The plan can:
      // `formatPlanAuditRefusal` is a pure function of the record it just
      // wrote, and the hash check keeps it bound to THIS round's content. The
      // goal cannot, and does not need to — its spec appends the findings
      // stream path, which is where a goal round's objections live.
      recordedRefusal: (root, pending) => {
        if (pending.kind !== "plan") return undefined;
        const st = stateOf(root);
        const record = st.planAudit;
        if (!record || record.hash !== pending.hash) return undefined;
        return formatPlanAuditRefusal(record);
      },
      verdictLabel: (root, pending) => {
        const st = stateOf(root);
        return (pending.kind === "goal" ? st.goalPrereview?.verdict : st.planAudit?.verdict) ?? "NONE";
      },
    };
  }

  return { auditRoundDeps, auditRunDeps, buildGoalAuditRound, closeOwnedJudge };
}
