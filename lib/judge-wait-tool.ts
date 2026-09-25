/**
 * `judge_wait`'s implementation — `doWait`, the ONE waiting loop over a pane
 * judge, registered by lib/judge-session-tools.ts on both hosts and called
 * directly (with `gateSelf`) by the gate's own audit chains.
 *
 * Its own module so the registration file stays a registration file: the
 * criteria the loop polls are lib/judge-wait-criteria.ts, the addressing and
 * opener check it passes first are lib/judge-session-addressing.ts, and this
 * file owns only the loop, the cursors it advances and the reply it builds.
 */
import type { ToolReply } from "./tool-host.ts";
import { clampWaitTimeout } from "./judge-lifecycle.ts";
import { buildStandardReport } from "./judge-report.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { pollUntil } from "./poll-wait.ts";
import { ROUND_SILENT_MS, roundLooksUnstarted } from "./interrupt-delivery.ts";
import { addressJudge, checkOpener, waitFailDetails } from "./judge-session-addressing.ts";
import {
  paneJudgeStalled,
  probeJudgeWait,
  type JudgeWaitCursors,
  type PaneJudgeWaitObservation,
} from "./judge-wait-criteria.ts";
import type { JudgeSessionToolDeps } from "./judge-session-tools.ts";

// ---------- reply builders ----------

function reply(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
}

// ---------- judge_wait ----------

export async function doWait(
  deps: JudgeSessionToolDeps,
  params: Record<string, unknown>,
  signal: { readonly aborted: boolean } | undefined,
  onUpdate: unknown,
  /**
   * GATE-SELF BYPASS (2026-09-08): true only on the gate's own direct calls.
   * Same shape as `doClose` — a function argument, never a params field.
   */
  gateSelf = false,
): Promise<ToolReply> {
  const addressed = addressJudge(deps, params, "judge_wait", gateSelf);
  if (!addressed.ok) return fail(addressed.text, waitFailDetails());
  const child = deps.findChild(addressed.root, addressed.role, addressed.judgeId);
  if (!child) {
    return fail(
      `review-gate: no judge on record for ${addressed.role ?? addressed.judgeId} — submit a round first (judge_submit).`,
      waitFailDetails(),
    );
  }
  const allowed = checkOpener(deps, child.judgeId);
  if (!allowed.ok) return fail(allowed.text, waitFailDetails());
  if (!child.paneId) {
    return fail(
      `review-gate: review ${child.judgeId} 没有登记 pane——它可能从未成功开出来。`,
      waitFailDetails(),
    );
  }
  const budgetMs = clampWaitTimeout(typeof params.timeoutMs === "number" ? params.timeoutMs : undefined);
  // The blackest box in the loop: a review round is minutes of silence.
  // Every probe tick republishes what the judge has written so far, so
  // waiting shows motion instead of a frozen call.
  const progress = createProgressReporter({
    title: `review-gate: 等 ${child.role} 的下一条消息`,
    onUpdate: onUpdate as ToolUpdate | undefined,
  });
  progress.step(`${child.role} 运行中`);
  // Anything the opener has ALREADY seen must not end this wait: the report id
  // and the finding count are persisted on the judge's registry entry, and the
  // announced question ids come from the session (shared with the settle path,
  // so one question is never delivered by both).
  const entryAtStart = deps.hierarchy()[child.judgeId];
  const cursors: JudgeWaitCursors = {
    reportId: entryAtStart?.lastReportId,
    findingCount: entryAtStart?.lastFindingCount ?? 0,
    announcedQuestions: deps.announcedQuestions(),
    modelEventCount: entryAtStart?.lastModelEventCount ?? 0,
  };
  // The LOOP is generic (lib/poll-wait.ts); only these criteria are this
  // tool's own, and they are MESSAGE-DRIVEN (2026-09-05): a new channel
  // report, a dead pane, a new question or a newly streamed finding each end
  // it. That is the whole point of the split, so the next waiter (different
  // criteria, same skeleton) reuses it instead of copying a subtly different
  // timeout.
  const waited = await pollUntil({
    probe: () => probeJudgeWait(deps, child, cursors),
    isDone: (o) => o.done,
    budgetMs,
    signal,
    onProbe: (o) => {
      const stalled = paneJudgeStalled(deps, child);
      progress.tail([
        o.seenFindingCount ? `findings: ${o.seenFindingCount} 条` : "findings 流暂无内容",
        stalled ? "心跳已停（stalled）——pane 还在但门禁不报数，先别打断" : "",
      ].filter(Boolean).join("\n"));
    },
  });
  // A budget that expires while the FIRST probe is still running leaves no
  // observation at all (lib/poll-wait.ts). That is not "finished", and it is
  // not an error either — it is "we could not measure anything in the time
  // you gave us", which the reply below states as such.
  const observation: PaneJudgeWaitObservation = waited.observation ?? { done: false, reason: "pending" };
  progress.done(observation.done ? observation.reason : "未结束");
  const waitedSeconds = Math.round(waited.waitedMs / 1000);
  // The finding cursor advances on EVERY outcome: whatever this reply carries
  // has been shown, so the next wait must not return it again.
  if (observation.seenFindingCount !== undefined) {
    rememberCursors(deps, child.judgeId, { lastFindingCount: observation.seenFindingCount });
  }
  // Same rule for the model events: whatever this reply shows has been acted
  // on, so the next wait must not re-announce it. "Acted on" is the OPENER's
  // job (cool the slot down, warn) and it happens HERE — before the cursor
  // moves, never after: an event the cursor skipped is one the pane will never
  // report again, and the cooldown would silently never be written.
  if (observation.seenModelEventCount !== undefined) {
    deps.absorbModelEvents?.(child.repoRoot, child.judgeId);
    rememberCursors(deps, child.judgeId, { lastModelEventCount: observation.seenModelEventCount });
  }
  // ONLY A STREAM THAT IS ACTUALLY THERE (2026-09-19). The path rode on every
  // reply because the judge HAD one registered, and the opener was then sent
  // to a file nobody ever wrote: a round whose findings are all carry-over
  // writes no new lines, so the file is never created (measured in prime: the
  // receipt named `review-mu8hnft7-review.jsonl` for exactly such a round).
  // "The gate lost the evidence" and "this round produced none" are different
  // facts and only one of them is worth a pointer.
  const liveStreamPath = child.streamPath !== undefined && deps.readText(child.streamPath) !== undefined
    ? child.streamPath
    : undefined;
  const base = {
    role: child.role,
    judgeId: child.judgeId,
    ...(liveStreamPath === undefined ? {} : { streamPath: liveStreamPath }),
    // WHICH MODEL RAN — the launch slot, plus every rotation the pane reported
    // (the events below). One without the other is half the story.
    ...(child.modelSpec === undefined ? {} : { modelSpec: child.modelSpec }),
    // Rides along on EVERY outcome that is not this round's report: whichever
    // wake-up the opener gets, it learns that a leftover report was set aside
    // and why. (The `report` outcome can never carry one — the probe only ends
    // a round on a report the recorder accepts.)
    ...(observation.notThisRound === undefined ? {} : { notThisRound: observation.notThisRound }),
  };
  if (observation.done && observation.reason === "pane-dead") {
    // A CANCELLED ROUND IS NOT A DEAD PANE (quality round P1, 2026-09-16).
    //
    // The cancel matrix ends a round by killing its pane AND dropping its
    // registry row (`cancelJudgeRound` in the extension) — and the row is
    // exactly what `judge_recover` needs. This wait captured its child record
    // at the top, so a round cancelled WHILE IT WAS IN FLIGHT looked
    // identical to a crash: the probe saw the pane vanish and the standard
    // report told the agent to `judge_recover` a round the gate had just
    // reclaimed, which is then refused because the row is gone (measured
    // dead end). The registry decides which of the two it is — the same fact
    // the recovery path reads, so the two halves cannot disagree.
    if (!deps.findChild(addressed.root, addressed.role, addressed.judgeId)) {
      return reply(
        buildStandardReport({ ...base, reason: "cancelled", waitedSeconds }),
        { done: true, reason: "cancelled", role: child.role, hasVerdict: false },
      );
    }
    return reply(
      buildStandardReport({ ...base, reason: "pane-dead", waitedSeconds }),
      { done: true, reason: "pane-dead", role: child.role, hasVerdict: false },
    );
  }
  // THE CHAIN IS OUT OF MODELS (criterion 4): the round cannot produce a
  // verdict, so it ENDS here as a failure with a reason — the alternative was
  // the measured behaviour, a round that hung for hours while the opener sat
  // inside a call it could not leave.
  if (observation.done && observation.reason === "model-exhausted") {
    return reply(
      buildStandardReport({
        ...base,
        reason: "model-exhausted",
        ...(observation.modelEvents === undefined ? {} : { modelEvents: observation.modelEvents }),
        waitedSeconds,
      }),
      { done: true, reason: "model-exhausted", role: child.role, hasVerdict: false },
    );
  }
  if (observation.done && observation.reason === "report" && observation.reportId) {
    // ONE call closes the round: the engine picks THIS round's report, routes
    // it to the kind's recorder and consumes the cursor itself. Reading the
    // channel here as well is exactly the second entry point that let the two
    // paths fail-close on different conditions.
    const settled = await deps.settleRound(child.judgeId, addressed.root);
    return reply(
      buildStandardReport({
        ...base,
        reason: "report",
        verdict: observation.verdict ?? settled.verdict ?? "",
        ...(observation.findingsCount === undefined ? {} : { findingsCount: observation.findingsCount }),
        // An adviser's whole deliverable IS its prose, and nothing records it
        // — so the wake-up carries it (the same field the settle path fills).
        ...(settled.advice === undefined ? {} : { conclusionExcerpt: settled.advice }),
        ...(settled.text === undefined ? { unrecorded: child.role !== "adviser" } : { recordedNote: settled.text }),
        // Its own line: the recorded note is printed first-line-only, so a
        // weaker binding announced INSIDE that note would never be read.
        ...(settled.bindingNote === undefined ? {} : { bindingNote: settled.bindingNote }),
        // The hand-off's own line — the recorded note above prints
        // first-line-only, so "I dispatched the reviewer" / "that dispatch
        // failed, re-submit" has to travel where the wake-up actually looks.
        ...(settled.handOffNote === undefined ? {} : { handOffNote: settled.handOffNote }),
        // What the round says it reviewed — the same line the settle sweep
        // prints, so which path woke the opener never changes what it learns.
        ...(settled.scope === undefined ? {} : { scope: settled.scope }),
        // What the round's model went through, on EVERY report: a verdict
        // reached after two rotations deserves to say so.
        ...(observation.modelEvents === undefined || observation.modelEvents.length === 0
          ? {}
          : { modelEvents: observation.modelEvents }),
        waitedSeconds,
      }),
      { done: true, reason: "report", role: child.role, hasVerdict: settled.hasVerdict },
    );
  }
  // NOTHING WAS GOING TO ARRIVE (2026-09-16): the round was concluded and
  // consumed already, and the pane is idle — so ending the wait here is the
  // truthful answer, and "keep waiting" is the answer that wastes a session.
  if (observation.done && observation.reason === "settled") {
    return reply(
      buildStandardReport({
        ...base,
        reason: "settled",
        ...(observation.stateLine === undefined ? {} : { stateLine: observation.stateLine }),
        waitedSeconds,
      }),
      { done: true, reason: "settled", role: child.role, hasVerdict: false },
    );
  }
  if (observation.done && observation.reason === "question") {
    const questions = observation.newQuestions ?? [];
    deps.markQuestionsAnnounced(questions.map((q) => q.requestId));
    return reply(
      buildStandardReport({ ...base, reason: "question", openQuestions: questions, waitedSeconds }),
      { done: true, reason: "question", role: child.role, hasVerdict: false },
    );
  }
  if (observation.done && observation.reason === "finding") {
    return reply(
      buildStandardReport({
        ...base,
        reason: "finding",
        newFindings: observation.newFindings ?? [],
        ...(observation.stateLine === undefined ? {} : { stateLine: observation.stateLine }),
        waitedSeconds,
      }),
      { done: true, reason: "finding", role: child.role, hasVerdict: false },
    );
  }
  // “DID THIS ROUND EVER START?” (goal 6(d), 2026-09-21).
  //
  // A heartbeat proves a PROCESS, not a round: the 552-second freeze
  // (01a0c22c) had two live panes whose gates were reporting happily while no
  // agent turn was running. The transcript is the one reading that moves only
  // when the agent works, so a round that dispatched a while ago, has produced
  // no report, and has not touched its transcript is reported as LOOKING
  // unstarted — with the action that resolves it, never by taking it.
  const silent = roundLooksUnstarted({
    ...(deps.roundDispatchedAt === undefined
      ? {}
      : { ...(() => {
            const at = deps.roundDispatchedAt!(child);
            return at === undefined ? {} : { dispatchedAtMs: at };
          })() }),
    ...(deps.transcriptActivityAt === undefined
      ? {}
      : { ...(() => {
            const at = deps.transcriptActivityAt!(child);
            return at === undefined ? {} : { transcriptActivityAtMs: at };
          })() }),
    nowMs: Date.now(),
    hasReport: false,
  });
  return reply(
    buildStandardReport({
      ...base,
      reason: "pending",
      ...(observation.stateLine === undefined ? {} : { stateLine: observation.stateLine }),
      waitedSeconds,
    }) +
      (silent
        // REPORT THE READING, NOT A VERDICT (quality round P1, 2026-09-21). The
        // code knows "no transcript write for N minutes"; it does NOT know "the
        // round never started" — a judge parked on its own ask_user dialog, or
        // one long tool call, produces exactly the same reading while being
        // perfectly healthy. The old wording accused the round of never having
        // run and paired the accusation with a destructive suggestion.
        ? `\n\n⚠️ 判断不了这一轮在不在跑：最近 ${Math.round(ROUND_SILENT_MS / 60_000)} 分钟里，这个 judge 的 transcript 没有任何写入。\n` +
          `pane ${child.paneId ?? "（无记录）"} 还活着，心跳也在响 —— 但心跳只能证明进程在，证明不了这一轮在跑。\n` +
          "可能是：它在跑一个很长的工具调用 / 它正卡在一个没人回答的对话框上 / 它真的没开跑。\n" +
          "先用 `judge_wait` 再等一等；确认它确实没动静，再 `judge_submit({ fresh: true })` 重开这一轮。"
        : ""),
    { done: false, reason: "pending", role: child.role, hasVerdict: false, unstarted: silent },
  );
}

/** Write back a wait's consumed cursors — a missing entry is simply skipped. */
function rememberCursors(
  deps: Pick<JudgeSessionToolDeps, "hierarchy" | "saveHierarchy">,
  judgeId: string,
  patch: { lastReportId?: string; lastFindingCount?: number; lastModelEventCount?: number },
): void {
  const next = deps.hierarchy();
  const entry = next[judgeId];
  if (!entry) return;
  deps.saveHierarchy({ ...next, [judgeId]: { ...entry, ...patch } });
}
