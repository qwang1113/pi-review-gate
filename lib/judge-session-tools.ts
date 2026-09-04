/**
 * The three tools that act on an EXISTING pane judge — `judge_read`,
 * `judge_close` and `judge_wait`.
 *
 * A judge is an interactive pi in its own pane (one pane per review),
 * owned by the opener recorded in lib/hierarchy.ts. There is no process to
 * watch and no stdout log to tail: the round ends when a `report` record
 * lands in the judge's channel, the pane dies, or the heartbeat goes stale.
 * The transcript stays the long memory (conclusions are parsed from it);
 * the channel is the completion signal.
 *
 * EVERY tool below passes `checkCaller` before doing anything else (except
 * the adviser-only read, which still refuses other roles): a judge belongs
 * to its opener, and any other session's operation on it is a cross-level
 * call refused fail-closed, with no dialog.
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
  HEARTBEAT_STALE_MS,
  type ChannelIO,
  type ReportConclusion,
} from "./orchestrator-channel.ts";
import {
  closeJudgePane,
  judgePaneAlive,
  type JudgePaneRunResult,
} from "./judge-pane.ts";
import type { JudgeConclusion } from "./judge-session.ts";
import {
  clampWaitTimeout,
  JUDGE_WAIT_MAX_TIMEOUT_MS,
  WAIT_DISCIPLINE_HINT,
} from "./judge-lifecycle.ts";
import { normalizeConcludedVerdict } from "./review-adjudicate.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { pollUntil } from "./poll-wait.ts";
import { parseStream } from "./review-stream.ts";

/** Default tail lines for an adviser's transcript conclusion. */
export const DEFAULT_CONCLUSION_HISTORY_LINES = 200;

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
  /** The judge's most recent output text, read from the RECORDED session dir. */
  conclusion(child: JudgeChildRecord): JudgeConclusion;
  /** Run the gate's own verdict recording on the report's structured conclusion. */
  recordVerdict(concluded: ReportConclusion, root: string, role: string): Promise<{ text?: string; hasVerdict: boolean }>;
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
function readFailDetails(): Record<string, unknown> {
  return { found: false, alive: false, state: "unknown", hasReport: false, hasVerdict: false };
}

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
  reason: "report" | "pane-dead" | "pending";
  reportId?: string;
  verdict?: string;
  findingsCount?: number;
  stateLine?: string;
}

/**
 * Observe one pane judge round: a NEW channel report ends it, a dead pane
 * ends it as failed, anything else is still running. The end-of-round
 * criterion reads the channel (where the conclusion is structured data), never
 * a transcript scan — the transcript stays the long memory, not the signal.
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
  if (last && last.reportId !== consumedReportId) {
    return { done: true, reason: "report", reportId: last.reportId, verdict: last.verdict, findingsCount: last.findingsCount };
  }
  const ownPane = deps.ownPane();
  const paneAlive = child.paneId && ownPane ? judgePaneAlive(deps.tmux, ownPane, child.paneId) : undefined;
  if (paneAlive === false) {
    return { done: true, reason: "pane-dead" };
  }
  const state = projection.lastState?.state ?? "unknown";
  const since = projection.lastStateSince ?? projection.lastActivityAt ?? "—";
  return { done: false, reason: "pending", stateLine: `${state}（自 ${since}）` };
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
export function recentStreamFindings(deps: JudgeSessionToolDeps, streamPath: string | undefined): string[] {
  if (!streamPath) return [];
  const raw = deps.readText(streamPath);
  if (raw === undefined) return [];
  try {
    return parseStream(raw).findings
      .map((f) => `[${f.severity}] ${f.location ? `${f.location} — ` : ""}${f.issue}`.slice(0, 300));
  } catch { return []; }
}

// ---------- judge_read (adviser only) ----------

async function doRead(deps: JudgeSessionToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const addressed = addressJudge(deps, params, "judge_read");
  if (!addressed.ok) return fail(addressed.text, readFailDetails());
  if (addressed.role !== undefined && addressed.role !== "adviser") {
    return fail(
      `review-gate: judge_read 只读 adviser——reviewer / goal-auditor 走 judge_wait 与通道 report（状态、findings 计数、verdict），那才是结论通道。`,
      readFailDetails(),
    );
  }
  const child = deps.findChild(addressed.root, addressed.role ?? "adviser", addressed.judgeId);
  if (!child) {
    return fail(
      `review-gate: no judge on record for ${addressed.role ?? addressed.judgeId}.`,
      readFailDetails(),
    );
  }
  if (child.role !== "adviser") {
    return fail(
      `review-gate: judge_read 只读 adviser——${child.role} 走 judge_wait 与通道 report。`,
      readFailDetails(),
    );
  }
  const allowed = checkOpener(deps, child.judgeId);
  if (!allowed.ok) return fail(allowed.text, readFailDetails());
  const history = typeof params.history === "number" ? params.history : DEFAULT_CONCLUSION_HISTORY_LINES;
  const io = deps.channelIO();
  const home = deps.channelHome();
  const target = judgeChannelTarget(child.openerId, child.judgeId, home);
  const projection = projectChannel(
    readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records,
  );
  const ownPane = deps.ownPane();
  const alive = child.paneId && ownPane ? judgePaneAlive(deps.tmux, ownPane, child.paneId) : undefined;
  // The judge's most recent output, for a still-running round: a DIAGNOSTIC
  // read only. Whether the round CONCLUDED is answered by the channel report,
  // not by pattern-matching the transcript.
  const conclusion = deps.conclusion(child);
  let conclusionTail = conclusion.text;
  if (conclusionTail !== undefined) {
    const lines = conclusionTail.split("\n");
    conclusionTail = lines.length <= history ? conclusionTail : lines.slice(-history).join("\n");
  }
  const concluded = projection.lastReport ? reportConclusion(io, projection.lastReport) : undefined;
  const hasVerdict = concluded !== undefined && normalizeConcludedVerdict(concluded.verdict) !== undefined;
  const header = `review-gate: adviser ${child.judgeId} — ${projection.lastState?.state ?? "unknown"}` +
    (alive === undefined ? "（pane 情况不明）" : alive ? "（pane 存活）" : "（pane 已消失）");
  const body: string[] = [];
  for (const q of projection.openRequests) {
    body.push(`--- 未答问题：${q.title}（选项：${q.options.join(" / ") || "自由文本"}）---`);
  }
  if (hasVerdict) {
    body.push(`--- 已交卷：verdict=${concluded!.verdict}，findings ${concluded!.findings.length} 条 ---`);
  }
  if (conclusionTail) {
    body.push(
      hasVerdict
        ? `--- 交卷后的最近输出（${history} 行内）---\n${conclusionTail}`
        : `--- 最近输出（本轮尚未交卷，可能只是过程语）---\n${conclusionTail}`,
    );
  } else {
    body.push("--- 还没有可读的结论 ---");
  }
  return reply([header, ...body].join("\n"), {
    found: true,
    alive: alive ?? false,
    state: projection.lastState?.state ?? "unknown",
    hasReport: projection.lastReport !== undefined,
    hasVerdict,
  });
}

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
    title: `review-gate: 等待 ${child.role} 本轮结束`,
    onUpdate: onUpdate as ToolUpdate | undefined,
  });
  progress.step(`${child.role} 运行中`);
  // Reports already consumed before this wait must not end it: the opener
  // remembers the newest report it recorded per judge.
  const consumedAtStart = deps.hierarchy()[child.judgeId]?.lastReportId;
  // The LOOP is generic (lib/poll-wait.ts); only these criteria are this
  // tool's own — a NEW channel report ends the round, a dead pane ends it
  // as failed. That is the whole point of the split, so the next waiter
  // (different criteria, same skeleton) reuses it instead of copying a
  // subtly different timeout.
  const waited = await pollUntil({
    probe: () => probeJudgeRound(deps, child, consumedAtStart),
    isDone: (o) => o.done,
    budgetMs,
    signal,
    onProbe: () => {
      const findings = recentStreamFindings(deps, child.streamPath);
      const stalled = paneJudgeStalled(deps, child);
      progress.tail([
        findings.length ? `findings: ${findings.length} 条，最新 ${findings[findings.length - 1]}` : "findings 流暂无内容",
        stalled ? "心跳已停（stalled）——pane 还在但门禁不报数，先别打断，用 judge_read 看一眼" : "",
      ].filter(Boolean).join("\n"));
    },
  });
  // A budget that expires while the FIRST probe is still running leaves no
  // observation at all (lib/poll-wait.ts). That is not "finished", and it is
  // not an error either — it is "we could not measure anything in the time
  // you gave us", which the reply below states as such.
  const observation: PaneJudgeWaitObservation = waited.observation ?? { done: false, reason: "pending" };
  progress.done(observation.done ? observation.reason : "未结束");
  if (observation.done && observation.reason === "pane-dead") {
    return reply(
      `review-gate: ${child.role} 本轮已结束（判据：pane-dead）——pane 消失且 verdict 未落盘，本轮不算结束。` +
      `用 judge_recover 同 id 重开续 transcript 继续，或用 judge_close 放弃。`,
      { done: true, reason: "pane-dead", role: child.role, hasVerdict: false },
    );
  }
  if (observation.done && observation.reason === "report" && observation.reportId) {
    const io = deps.channelIO();
    const home = deps.channelHome();
    const target = judgeChannelTarget(child.openerId, child.judgeId, home);
    const projection = projectChannel(
      readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records,
    );
    // The conclusion is DATA on the report — no text is parsed to find it.
    const concluded: ReportConclusion = projection.lastReport
      ? reportConclusion(io, projection.lastReport)
      : { verdict: "", findings: [] };
    const recorded = await deps.recordVerdict(concluded, addressed.root, child.role);
    const next = deps.hierarchy();
    const entry = next[child.judgeId];
    if (entry) {
      deps.saveHierarchy({ ...next, [child.judgeId]: { ...entry, lastReportId: observation.reportId } });
    }
    const text = `review-gate: ${child.role} 本轮已结束（判据：report，verdict=${observation.verdict ?? "?"}` +
      `${observation.findingsCount === undefined ? "" : `，findings=${observation.findingsCount}`}）。\n` +
      (recorded.text
        ? `--- 记录情况（${recorded.hasVerdict ? "verdict 已识别" : "verdict 无法识别"}）---\n${recorded.text}`
        : "--- 该轮没有留下结论文本 ---");
    return reply(text, {
      done: true,
      reason: "report",
      role: child.role,
      hasVerdict: recorded.hasVerdict,
    });
  }
  const findings = recentStreamFindings(deps, child.streamPath);
  return reply(
    `review-gate: ${child.role} 仍在运行（等待 ${Math.round(waited.waitedMs / 1000)}s 未命中任一判据）。\n` +
    (findings.length
      ? `--- findings 最近 ${findings.length} 条 ---\n${findings.slice(-5).join("\n")}`
      : "--- findings 流暂无内容 ---") +
    `\n${WAIT_DISCIPLINE_HINT}`,
    { done: false, reason: "pending", role: child.role, hasVerdict: false },
  );
}

// ---------- registration ----------

/** Register `judge_read`, `judge_close` and `judge_wait`. */
export function registerJudgeSessionTools(host: ToolHost, deps: JudgeSessionToolDeps): void {
  host.registerTool({
    name: "judge_read",
    label: "Read Adviser",
    description:
      "Read YOUR OWN adviser by ROLE (a snapshot, never a wait): its channel state, open questions, and transcript " +
      "conclusion. Adviser-only: reviewer / goal-auditor go through judge_wait and the channel report. " +
      "Only the opener may read; anyone else is refused.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      sessionId: SESSION_ID_PARAM,
      repo: REPO_PARAM,
      history: Type.Optional(Type.Integer({
        description: `Tail lines of the transcript conclusion (default ${DEFAULT_CONCLUSION_HISTORY_LINES})`,
      })),
    }),
    execute: (_id, params) => doRead(deps, params),
  });

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

  host.registerTool({
    name: "judge_wait",
    label: "Wait For Judge",
    description:
      "Block until YOUR OWN judge's current round is over, then return what it produced. This is the FALLBACK, " +
      "not the normal path: call this only when there is genuinely nothing else to do. A NEW channel report ends " +
      "the wait (the gate records it), a dead pane ends it as failed. On timeout it returns the current state " +
      "instead of failing, so the decision stays yours. Only the opener may wait; anyone else is refused.",
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
