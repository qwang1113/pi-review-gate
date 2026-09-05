/**
 * The two tools that act on an EXISTING pane judge — `judge_close` and
 * `judge_wait`.
 *
 * A judge is an interactive pi in its own pane (one pane per review),
 * owned by the opener recorded in lib/hierarchy.ts. There is no process to
 * watch and no stdout log to tail: the round ends when a `report` record
 * lands in the judge's channel, the pane dies, or the heartbeat goes stale.
 * The transcript stays the long memory; the channel is the signal — and the
 * wait is MESSAGE-driven over that channel plus the round's findings stream,
 * so it returns on the first thing that happened rather than at the end.
 *
 * EVERY tool below passes `checkCaller` before doing anything else: a judge
 * belongs to its opener, and any other session's operation on it is a
 * cross-level call refused fail-closed, with no dialog.

 *
 * Shape (unchanged): `registerJudgeSessionTools(host, deps)`, effects
 * through `deps` only. Pure decisions live in lib/hierarchy.ts,
 * lib/orchestrator-channel.ts and lib/judge-pane.ts and are imported
 * directly; what IS injected is everything the tools cannot own — identity,
 * the registries, tmux, the channel filesystem and the verdict recorder.
 */
import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import {
  checkCaller,
  removeJudge,
  type HierarchyTable,
} from "./hierarchy.ts";
import {
  channelPathFor,
  isStalled,
  judgeChannelTarget,
  projectChannel,
  readChannel,
  reportConclusion,
  reportText,
  HEARTBEAT_STALE_MS,
  type ChannelIO,
  type ReportConclusion,
} from "./orchestrator-channel.ts";
import {
  closeJudgePane,
  judgePaneAlive,
  type JudgePaneRunResult,
} from "./judge-pane.ts";
import {
  clampWaitTimeout,
  JUDGE_WAIT_MAX_TIMEOUT_MS,
} from "./judge-lifecycle.ts";
import { buildStandardReport, type OpenQuestionBrief } from "./judge-report.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { pollUntil } from "./poll-wait.ts";
import { parseStream } from "./review-stream.ts";


/**
 * The parts of a pane judge these tools address.
 *
 * A structural subset of the extension's own record on purpose: this module
 * must not become the second place that decides what a judge IS.
 */
export interface JudgeChildRecord {
  /** Judge id — also the pane's resume key and the channel file name. */
  judgeId: string;
  role: string;
  /** Repo root the review belongs to. */
  repoRoot: string;
  /** Who opened it — the only session that may operate it. */
  openerId: string;
  /** tmux pane id, once the pane exists. */
  paneId?: string;
  /** Directory pi writes its transcript jsonl into (stable per role). */
  sessionDir: string;
  /** This round's findings stream, when the role has one. */
  streamPath?: string;
}

/** Repo resolution, as `resolveToolRepoTarget` already reports it. */
export type JudgeRepoTarget = { ok: true; root: string } | { ok: false; error: string };

/**
 * Everything these tools need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every method is a thing a
 * test replaces with three lines.
 */
export interface JudgeSessionToolDeps {
  /** Which repo does this call target? Never guessed — see repo-resolve.ts. */
  resolveRepo(requested: string | undefined): JudgeRepoTarget;
  /** Who is calling — the opener check runs on this, never on a parameter. */
  callerId(): string | undefined;
  /** Opener registry (extension-owned) and its persistence. */
  hierarchy(): HierarchyTable;
  saveHierarchy(next: HierarchyTable): void;
  /** Locate a pane judge by ROLE (preferred) or by judge id. */
  findChild(root: string, role: string | undefined, judgeId: string | undefined): JudgeChildRecord | undefined;
  /** Channel filesystem seam and its home override. */
  channelIO(): ChannelIO;
  channelHome(): string | undefined;
  /** One tmux invocation (argv, never a shell string). */
  tmux(argv: readonly string[]): JudgePaneRunResult;
  /** This session's own pane — liveness is probed from its window. */
  ownPane(): string | undefined;
  /** Injectable clock. */
  now(): number;
  /** Whole file, or undefined when it is absent/unreadable. */
  readText(path: string): string | undefined;
  /**
   * Question ids the opener has already been shown, and the way to add to
   * them. Owned by the SESSION, not by this module: the settle path announces
   * questions too, and one question announced twice is the same wasted
   * iteration as a question never announced.
   */
  announcedQuestions(): ReadonlySet<string>;
  markQuestionsAnnounced(requestIds: readonly string[]): void;

  /**
   * CLOSE THIS ROUND through the audit-round engine (lib/audit-round.ts).
   *
   * The wait does not pick the report, adjudicate it or move the cursor: the
   * engine does all three, for every kind, in one place. That is what makes
   * "one report is recorded once" structural — this path and the settle sweep
   * share the engine's single cursor write instead of each keeping their own.
   */
  settleRound(judgeId: string, root: string): Promise<{
    text?: string;
    /** The adviser's prose, when this round was one (never recorded). */
    advice?: string;
    /** The report's raw verdict, for the standard report's display. */
    verdict?: string;
    hasVerdict: boolean;
  }>;
  /** Cancel the gate-owned hosted-wait watchdog. */
  cancelWaitTimer(): void;
  /** Forget the goal draft a closed audit was judging. */
  dropPendingAudit(root: string): void;
}

// ---------- shared parameter schemas ----------
// One definition per parameter, shared by the tools: a role enum that
// drifts between two of them is exactly the kind of silent inconsistency this
// move is supposed to make impossible.
const ROLE_PARAM = Type.Optional(Type.Enum({ reviewer: "reviewer", adviser: "adviser", "goal-auditor": "goal-auditor" }));
const SESSION_ID_PARAM = Type.Optional(Type.String({ description: "Judge id (its session id); prefer role" }));
const REPO_PARAM = Type.Optional(Type.String({
  description: "Absolute repo path (required once the session edited several repos)",
}));

// ---------- reply builders ----------

function reply(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
}

/**
 * The failure shapes.
 *
 * Each one carries EVERY field its tool's success path reports, with the
 * neutral value: an agent (or a test) reading `details.hasVerdict` must never
 * find the key simply missing because the call failed early.
 */

function closeFailDetails(): Record<string, unknown> {
  return { closed: false, terminated: false, judgeId: undefined };
}

function waitFailDetails(): Record<string, unknown> {
  return { done: false, reason: undefined, role: undefined, hasVerdict: false };
}

// ---------- shared addressing ----------

type Addressed =
  | { ok: true; root: string; role: string | undefined; judgeId: string | undefined }
  | { ok: false; text: string };

/**
 * Who is being addressed, and in which repo.
 *
 * Both refusals are identical across the three tools, and both are
 * fail-closed: an unaddressed call names the roles it accepts, and an
 * ambiguous repo is never guessed — reading, closing or waiting on the wrong
 * repo's judge is a silently wrong answer about somebody else's change.
 */
function addressJudge(
  deps: JudgeSessionToolDeps,
  params: Record<string, unknown>,
  toolName: string,
): Addressed {
  const role = params.role ? String(params.role) : undefined;
  const judgeId = params.sessionId ? String(params.sessionId) : undefined;
  if (!role && !judgeId) {
    return { ok: false, text: `review-gate: ${toolName} needs a role (reviewer / adviser / goal-auditor).` };
  }
  const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!target.ok) return { ok: false, text: target.error };
  return { ok: true, root: target.root, role, judgeId };
}

/** Opener check shared by the three tools (read narrows the role first). */
function checkOpener(
  deps: JudgeSessionToolDeps,
  judgeId: string,
): { ok: true } | { ok: false; text: string } {
  const caller = deps.callerId();
  if (!caller) {
    return { ok: false, text: "review-gate: 无法确认调用者身份——身份不明时不能操作任何 review。" };
  }
  const allowed = checkCaller(deps.hierarchy(), judgeId, caller);
  if (!allowed.ok) return { ok: false, text: `review-gate: ${allowed.reason}` };
  return { ok: true };
}

// ---------- the wait criteria (this module's own) ----------

export interface PaneJudgeWaitObservation {
  done: boolean;
  reason: "report" | "pane-dead" | "question" | "finding" | "pending";
  reportId?: string;
  verdict?: string;
  findingsCount?: number;
  stateLine?: string;
  /** Every question the judge has open, cursor-independent (the wait filters). */
  openQuestions?: OpenQuestionBrief[];
  /** Findings streamed since the caller's cursor, one formatted line each. */
  newFindings?: string[];
  /** Total findings visible in the stream — the cursor value to store next. */
  seenFindingCount?: number;
  /** Questions the opener has not been shown yet. */
  newQuestions?: OpenQuestionBrief[];
}

/**
 * What the opener has ALREADY been shown — the wait's de-duplication cursors.
 *
 * Without them a message-driven wait is unusable: the finding that ended the
 * previous wait would end the next one too, immediately, forever. Each cursor
 * is owned by the side that persists it (the report id and the finding count
 * on the judge's registry entry, the announced question ids by the session, so
 * a question a settle wake-up already delivered is not delivered twice).
 */
export interface JudgeWaitCursors {
  /** Newest report already recorded. */
  reportId: string | undefined;
  /** How many streamed findings the opener has already seen. */
  findingCount: number;
  /** Question ids already announced — by a wait OR by the settle path. */
  announcedQuestions: ReadonlySet<string>;
}

/**
 * Observe one pane judge round: a NEW channel report ends it, a dead pane
 * ends it as failed, anything else is still running. The end-of-round
 * criterion reads the channel (where the conclusion is structured data), never
 * a transcript scan — the transcript stays the long memory, not the signal.
 *
 * It also reports the judge's OPEN QUESTIONS, without judging whether they are
 * new: the settle path and the wait keep different cursors over them, and a
 * probe that applied one of those cursors would be the wrong observation for
 * the other caller.
 */
export function probeJudgeRound(
  deps: Pick<JudgeSessionToolDeps, "channelIO" | "channelHome" | "tmux" | "ownPane">,
  child: Pick<JudgeChildRecord, "openerId" | "judgeId" | "paneId">,
  consumedReportId: string | undefined,
): PaneJudgeWaitObservation {
  const io = deps.channelIO();
  const home = deps.channelHome();
  const target = judgeChannelTarget(child.openerId, child.judgeId, home);
  const read = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home));
  const projection = projectChannel(read.records);
  const last = projection.lastReport;
  const openQuestions: OpenQuestionBrief[] = (projection.openRequests ?? []).map((q) => ({
    title: q.title,
    options: q.options,
    requestId: q.requestId,
  }));
  if (last && last.reportId !== consumedReportId) {
    return { done: true, reason: "report", reportId: last.reportId, verdict: last.verdict, findingsCount: last.findingsCount, openQuestions };
  }
  const ownPane = deps.ownPane();
  const paneAlive = child.paneId && ownPane ? judgePaneAlive(deps.tmux, ownPane, child.paneId) : undefined;
  if (paneAlive === false) {
    return { done: true, reason: "pane-dead", openQuestions };
  }
  const state = projection.lastState?.state ?? "unknown";
  const since = projection.lastStateSince ?? projection.lastActivityAt ?? "—";
  return { done: false, reason: "pending", stateLine: `${state}（自 ${since}）`, openQuestions };
}

/**
 * The MESSAGE-DRIVEN criterion (2026-09-05, user decision): the wait ends on
 * the first thing that happened, not at the end of the round.
 *
 * Order is deliberate — a finished round outranks a question, which outranks a
 * finding — because when several land in the same probe the opener should act
 * on the strongest one. Both new criteria read the SAME sources the gate
 * already writes (the round's stream file, the channel's open requests): the
 * judge-side record format is untouched, so a judge running the newest code
 * still reports to an opener running the oldest.
 */
export function probeJudgeWait(
  deps: Pick<JudgeSessionToolDeps, "channelIO" | "channelHome" | "tmux" | "ownPane" | "readText">,
  child: Pick<JudgeChildRecord, "openerId" | "judgeId" | "paneId" | "streamPath">,
  cursors: JudgeWaitCursors,
): PaneJudgeWaitObservation {
  const round = probeJudgeRound(deps, child, cursors.reportId);
  const findings = recentStreamFindings(deps, child.streamPath);
  const seenFindingCount = findings.length;
  if (round.done) return { ...round, seenFindingCount };
  const newQuestions = (round.openQuestions ?? []).filter((q) => !cursors.announcedQuestions.has(q.requestId));
  if (newQuestions.length > 0) {
    return { ...round, done: true, reason: "question", newQuestions, seenFindingCount };
  }
  if (seenFindingCount > cursors.findingCount) {
    return {
      ...round,
      done: true,
      reason: "finding",
      newFindings: findings.slice(cursors.findingCount),
      seenFindingCount,
    };
  }
  return { ...round, seenFindingCount };
}


/** Is this pane judge's silence a stall? Missing pane info is never a stall. */
export function paneJudgeStalled(
  deps: JudgeSessionToolDeps,
  child: JudgeChildRecord,
): boolean {
  const io = deps.channelIO();
  const home = deps.channelHome();
  const target = judgeChannelTarget(child.openerId, child.judgeId, home);
  const read = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home));
  const projection = projectChannel(read.records);
  const ownPane = deps.ownPane();
  const paneAlive = child.paneId && ownPane ? judgePaneAlive(deps.tmux, ownPane, child.paneId) : undefined;
  return isStalled(projection, paneAlive, deps.now(), HEARTBEAT_STALE_MS);
}

/**
 * The findings a judge has streamed so far, newest last, one line each.
 *
 * Evidence only: the stream never carries a verdict (parseStream rejects
 * verdict-shaped lines), so showing it while a round is still open cannot
 * leak a conclusion the gate has not recorded.
 */
export function recentStreamFindings(
  deps: Pick<JudgeSessionToolDeps, "readText">,
  streamPath: string | undefined,
): string[] {
  if (!streamPath) return [];
  const raw = deps.readText(streamPath);
  if (raw === undefined) return [];
  try {
    return parseStream(raw).findings
      .map((f) => `[${f.severity}] ${f.location ? `${f.location} — ` : ""}${f.issue}`.slice(0, 300));
  } catch { return []; }
}


// (`judge_read` is GONE, implementation and all — 2026-09-05, user decision
// D4. It was a zero-caller path: never on the agent surface and never called
// by any of the gate's own chains, so what it actually did was give the
// injected texts a tool name to point at that nobody could reach. What it read
// — state, open questions, the conclusion — is what `judge_wait` now returns
// on its own, message-driven, from the same channel.)


// ---------- judge_close ----------

async function doClose(deps: JudgeSessionToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const addressed = addressJudge(deps, params, "judge_close");
  if (!addressed.ok) return fail(addressed.text, closeFailDetails());
  const child = deps.findChild(addressed.root, addressed.role, addressed.judgeId);
  if (!child) {
    // Idempotent: nothing to close is a SUCCESS, so a task-completion sweep
    // never has to know whether a round is still on record.
    return reply(
      `review-gate: no judge on record for ${addressed.role ?? addressed.judgeId} — nothing to close.`,
      { closed: true, terminated: false, judgeId: undefined },
    );
  }
  const judgeId = child.judgeId;
  const allowed = checkOpener(deps, judgeId);
  if (!allowed.ok) return fail(allowed.text, closeFailDetails());
  // Cancel the hosted wait so no wake fires for a close we initiated.
  deps.cancelWaitTimer();
  const ownPane = deps.ownPane();
  let terminated = false;
  let killNote = "没有登记 pane，无需动手";
  if (child.paneId && ownPane) {
    const killed = closeJudgePane(deps.tmux, child.paneId);
    terminated = killed.ok;
    killNote = killed.ok ? `pane ${child.paneId} 已关` : `关 pane 失败（${killed.error}），登记照样清除`;
  }
  deps.saveHierarchy(removeJudge(deps.hierarchy(), judgeId));
  // A closed audit takes its draft with it — same reason as fresh:true.
  if (child.role === "goal-auditor") deps.dropPendingAudit(addressed.root);
  return reply(
    `review-gate: ${child.role}（${judgeId}）已关闭：${killNote}；transcript 保留，同 id 重开即续接。`,
    { closed: true, terminated, judgeId },
  );
}

// ---------- judge_wait ----------

async function doWait(
  deps: JudgeSessionToolDeps,
  params: Record<string, unknown>,
  signal: { readonly aborted: boolean } | undefined,
  onUpdate: unknown,
): Promise<ToolReply> {
  const addressed = addressJudge(deps, params, "judge_wait");
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
  const base = {
    role: child.role,
    judgeId: child.judgeId,
    ...(child.streamPath === undefined ? {} : { streamPath: child.streamPath }),
  };
  if (observation.done && observation.reason === "pane-dead") {
    return reply(
      buildStandardReport({ ...base, reason: "pane-dead", waitedSeconds }),
      { done: true, reason: "pane-dead", role: child.role, hasVerdict: false },
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
        waitedSeconds,
      }),
      { done: true, reason: "report", role: child.role, hasVerdict: settled.hasVerdict },
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
  return reply(
    buildStandardReport({
      ...base,
      reason: "pending",
      ...(observation.stateLine === undefined ? {} : { stateLine: observation.stateLine }),
      waitedSeconds,
    }),
    { done: false, reason: "pending", role: child.role, hasVerdict: false },
  );
}

/** Write back a wait's consumed cursors — a missing entry is simply skipped. */
function rememberCursors(
  deps: Pick<JudgeSessionToolDeps, "hierarchy" | "saveHierarchy">,
  judgeId: string,
  patch: { lastReportId?: string; lastFindingCount?: number },
): void {
  const next = deps.hierarchy();
  const entry = next[judgeId];
  if (!entry) return;
  deps.saveHierarchy({ ...next, [judgeId]: { ...entry, ...patch } });
}


// ---------- registration ----------

/**
 * Register the judge-session tools on ONE host.
 *
 * `judge_close` is gate-internal (its only callers are the gate's own audit
 * chains, which close the auditor they opened); `judge_wait` goes on BOTH
 * hosts — the same implementation, registered twice, never a second copy of
 * the waiting logic (2026-09-05, user decision D1).
 */
export function registerJudgeSessionTools(host: ToolHost, deps: JudgeSessionToolDeps): void {
  host.registerTool({
    name: "judge_close",
    label: "Close Own Judge",
    description:
      "Close YOUR OWN judge pane (its transcript stays on disk, so the same id re-opens the same conversation) " +
      "and drop it from the registry. Use it at task completion (declare_done cascade-closes the rest) or to stop " +
      "a round that has gone off the rails. Idempotent. Only the opener may close; anyone else is refused.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      sessionId: SESSION_ID_PARAM,
      repo: REPO_PARAM,
    }),
    execute: (_id, params) => doClose(deps, params),
  });

  registerJudgeWaitTool(host, deps);
}

/**
 * `judge_wait` on its own — the ONE waiting tool, and the reason it is a
 * separate export.
 *
 * The agent surface needs exactly this tool and nothing else of the family:
 * a session that has genuinely run out of deterministic work must be able to
 * wait for its judge's next message, and the alternative it was left with
 * (a hand-written `sleep` loop inside one bash call) locked a measured nine
 * minutes out of a session — the turn never ended, so nothing ever settled,
 * so a report that had already landed stayed unrecorded. Registering the SAME
 * implementation on the internal host and on the agent host keeps one set of
 * criteria (哲学三: never two implementations).
 */
export function registerJudgeWaitTool(host: ToolHost, deps: JudgeSessionToolDeps): void {
  host.registerTool({
    name: "judge_wait",
    label: "Wait For Judge",
    description:
      "Wait for YOUR OWN judge's next MESSAGE and return it. It is message-driven, not a poll-until-finished: " +
      "a newly streamed finding, a question the judge asked, the round's channel report (the gate records it) or " +
      "a dead pane each return immediately, with the content itself — you never read a stream or transcript file. " +
      "Call it when you have genuinely run out of deterministic work; do the work first when you have some. " +
      "On timeout it returns the current state instead of failing, so the decision stays yours. " +
      "Only the opener may wait; anyone else is refused.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      sessionId: SESSION_ID_PARAM,
      repo: REPO_PARAM,
      timeoutMs: Type.Optional(Type.Integer({
        description: `Blocking window in ms (default 300000, hard cap ${JUDGE_WAIT_MAX_TIMEOUT_MS})`,
      })),
    }),
    execute: (_id, params, signal, onUpdate) => doWait(deps, params, signal, onUpdate),
  });
}

