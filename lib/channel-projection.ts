/**
 * READING A CHANNEL BACK — parse, sanitize, project, judge staleness.
 *
 * The record schema is lib/channel-records.ts and the disk seam is
 * lib/channel-io.ts. Everything here is a pure function of records (plus one
 * read through the injected {@link ChannelIO}), so the protocol is testable
 * end to end with no tmux, no pi runtime and no filesystem.
 */

import { isDeliveryStation, type DeliveryStation } from "./delivery-station.ts";
import type { ModelEvent } from "./model-health.ts";
import { resolvePayload, type ChannelIO } from "./channel-io.ts";
import { isHandoffChainOf } from "./session-inheritance.ts";
import type {
  ChannelAnswerRecord,
  ChannelInstructRecord,
  ChannelRecord,
  ChannelReportRecord,
  ChannelRequestRecord,
  ChannelStateRecord,
  ReportFinding,
  ReviewScopeStamp,
} from "./channel-records.ts";

/**
 * No record for this long, while the pane is still alive, means `stalled` —
 * the extension died or the process wedged.
 *
 * WHAT THIS BUDGET IS ALLOWED TO MEAN (round-4 P0). It used to be measured
 * against a heartbeat driven by the child's AGENT events (`agent_settled`,
 * `turn_end`), and those stop for the entire length of a `judge_wait`, a full
 * precommit or any long tool call — all of which happen INSIDE one turn. So
 * the rule claimed to measure "is the extension alive" while actually
 * measuring "is the agent producing events", and a child quietly waiting for
 * its own reviewer was reported as lost twice in one run, for ~14 minutes,
 * with `interrupt` offered as the fix. The heartbeat is now sent by an
 * INDEPENDENT TIMER in the child's gate (see the extension's
 * `startChildHeartbeat`): it ticks while the agent is blocked, so silence for
 * this long once again means what it says — nobody is home.
 */
export const HEARTBEAT_STALE_MS = 180_000;

/** What a judge concluded, as DATA — the opener never parses a report's text. */
export interface ReportConclusion {
  verdict: string;
  findings: ReportFinding[];
  cwd?: string;
  docSync?: string;
  /**
   * The range and full/incremental flag the round reported for itself.
   * Present only when the report carried a usable one — see
   * {@link sanitizeScopeStamp}.
   */
  scope?: ReviewScopeStamp;
  /**
   * The judge's own context reading at the conclusion, in percent. Present
   * only when the report carried a usable one — see {@link sanitizeContextPercent}.
   */
  contextPercent?: number;
}

/**
 * Keep a report's scope stamp only where it says something.
 *
 * A record read off disk is untrusted input: it may come from another build,
 * a truncated write or a hand-edited file. A non-string range and an
 * unrecognised kind are DROPPED rather than passed on, and a stamp left with
 * nothing in it becomes `undefined` — an empty object on the conclusion would
 * read to every consumer as "the judge reported a scope" when it did not.
 */
export function sanitizeScopeStamp(raw: unknown): ReviewScopeStamp | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as { range?: unknown; kind?: unknown };
  const range = typeof value.range === "string" && value.range.trim() ? value.range.trim() : undefined;
  const kind = value.kind === "full" || value.kind === "incremental" ? value.kind : undefined;
  if (range === undefined && kind === undefined) return undefined;
  return { ...(range === undefined ? {} : { range }), ...(kind === undefined ? {} : { kind }) };
}

/**
 * Keep a report's context reading only when it is a usable percentage.
 *
 * Same untrusted-input rule as {@link sanitizeScopeStamp}, and the fail
 * direction matters here: an unusable reading must become `undefined` ("no
 * reading", which never rotates) rather than a number that could cross the
 * rotation threshold by accident. Out-of-range values are clamped instead of
 * dropped — a host reporting 140% is reporting "full", not "unknown".
 */
export function sanitizeContextPercent(raw: unknown): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return Math.min(100, Math.max(0, raw));
}

/**
 * Keep a request's delivery station only when it is one of the three.
 *
 * Same untrusted-input rule as {@link sanitizeScopeStamp}: the value was
 * written by the CHILD, so an unknown, mistyped or hand-edited one is DROPPED
 * rather than passed on. It deliberately does NOT go through
 * `parseDeliveryStation`, whose job is the opposite — that one DEGRADES an
 * unreadable value to the strictest station so a contract that forgot to say
 * where it stops still blocks. Here there is no contract to protect: an
 * unreadable station is "the child said nothing", and inventing `precommit`
 * for it would show a project manager a station nobody asked for.
 *
 * The station VOCABULARY is still the one place that owns it
 * (`isDeliveryStation`, lib/delivery-station.ts) — this adds a rule about
 * missing data, never a second definition of what a station is.
 *
 * Dropping is also the safe direction for the only decision that reads it: no
 * station ⇒ no widening comparison ⇒ the proxy answer still has to carry a
 * crosscheck, and the ordinary approval rules apply unchanged.
 */
export function sanitizeDeliveryStation(raw: unknown): DeliveryStation | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  return isDeliveryStation(normalized) ? normalized : undefined;
}


/** One question's place in its interview, as a consumer gets to see it. */
export interface RequestBatchStamp {
  id: string;
  index: number;
  total: number;
}

/**
 * Keep a request's batch stamp only when all three halves agree.
 *
 * Same untrusted-input rule as {@link sanitizeScopeStamp}, applied to a value
 * whose only job is to be READ: the stamp exists so a receipt can say "第 2/5
 * 题", and a half-parsed one ("第 undefined/0 题") is worse than none at all.
 * So a missing id, a non-integer position, a total below one or a position
 * outside its total all drop the whole stamp — the request is still a
 * perfectly ordinary open question, which is exactly how an older reader sees
 * every one of them.
 */
export function sanitizeBatchStamp(id: unknown, index: unknown, total: unknown): RequestBatchStamp | undefined {
  if (typeof id !== "string" || id.trim() === "") return undefined;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return undefined;
  if (typeof total !== "number" || !Number.isInteger(total) || total < 1) return undefined;
  if (index >= total) return undefined;
  return { id: id.trim(), index, total };
}


/**
 * Read one report's structured conclusion, resolving a spilled findings array.
 *
 * Three fields are normalized. `findings`: a report written before the field
 * existed, one whose findings are not an array, or one whose spill file is
 * unreadable all read as NO findings rather than throwing — the verdict still
 * travels, and the recorder fails closed on an unrecognisable one. A spill
 * that cannot be read is the same case: the round is recorded with the
 * verdict it reported and no findings, never with a stale set from elsewhere.
 * `scope` goes through {@link sanitizeScopeStamp} for the same reason: a
 * stamp is auditing evidence, and evidence that cannot be recognised is
 * absent, not approximated. `contextPercent` is the same rule once more
 * ({@link sanitizeContextPercent}): an unusable reading is no reading, which
 * is the fail-open input the rotation policy expects.
 */
export function reportConclusion(io: ChannelIO, record: ChannelReportRecord): ReportConclusion {
  let raw: unknown = record.findings;
  if (raw === undefined && record.findingsRef) {
    const text = resolvePayload(io, record.findingsRef);
    if (text !== undefined) {
      try { raw = JSON.parse(text); } catch { raw = undefined; }
    }
  }
  const findings = Array.isArray(raw) ? raw.filter((f): f is ReportFinding => !!f && typeof f === "object") : [];
  const scope = sanitizeScopeStamp(record.scope);
  const contextPercent = sanitizeContextPercent(record.contextPercent);
  return {
    verdict: record.verdict,
    findings,
    ...(record.cwd === undefined ? {} : { cwd: record.cwd }),
    ...(record.docSync === undefined ? {} : { docSync: record.docSync }),
    ...(scope === undefined ? {} : { scope }),
    ...(contextPercent === undefined ? {} : { contextPercent }),
  };
}

/** What a read produced: the records, and the lines that could not be parsed. */
export interface ChannelRead {
  records: ChannelRecord[];
  /** Lines that failed to parse — reported, never silently dropped. */
  malformed: number;
  /** BYTE offset just past the last complete line consumed; pass it back to read on. */
  cursor: number;
}

/** The bytes from `offset` on, through the cheap path when the IO has one. */
function readTail(io: ChannelIO, path: string, offset: number): { text: string; size: number } | undefined {
  if (io.readFrom) return io.readFrom(path, offset);
  const raw = io.readText(path);
  if (raw === undefined) return undefined;
  const bytes = Buffer.from(raw, "utf8");
  return { text: offset < bytes.length ? bytes.subarray(offset).toString("utf8") : "", size: bytes.length };
}

/**
 * Read a channel from `cursor` bytes in.
 *
 * INCREMENTAL, because the readers poll: a child waiting for an answer
 * re-reads its channel every tick, and re-reading the whole history each time
 * made every poll cost the length of the file. The cursor is the byte offset
 * just past the last COMPLETE line consumed, so a line still being appended
 * (no trailing newline yet) is left for the next read rather than counted as
 * malformed and skipped for good.
 *
 * A file SHORTER than the cursor was truncated or rewritten, and a byte offset
 * into it means nothing any more: the read falls back to the whole file.
 * ponytail: a rewrite that grows past the old offset before the next read goes
 * unnoticed — channels are append-only, so nothing in the gate does that.
 */
export function readChannel(io: ChannelIO, path: string, cursor = 0): ChannelRead {
  let base = cursor;
  let tail = readTail(io, path, base);
  if (tail === undefined) return { records: [], malformed: 0, cursor };
  if (tail.size < base) {
    base = 0;
    tail = readTail(io, path, 0);
    if (tail === undefined) return { records: [], malformed: 0, cursor: 0 };
  }
  const complete = tail.text.slice(0, tail.text.lastIndexOf("\n") + 1);
  const records: ChannelRecord[] = [];
  let malformed = 0;
  for (const line of complete.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = parseRecord(line);
    if (parsed) records.push(parsed);
    else malformed += 1;
  }
  return { records, malformed, cursor: base + Buffer.byteLength(complete, "utf8") };
}

/** Tolerant parse: a record the reader does not understand is not a record. */
function parseRecord(line: string): ChannelRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<ChannelRecord>;
    if (typeof value !== "object" || value === null) return undefined;
    if (typeof value.kind !== "string" || typeof value.from !== "string") return undefined;
    if (typeof value.at !== "string") return undefined;
    switch (value.kind) {
      case "state":
      case "request":
      case "request-settled":
      case "answer":
      case "instruct":
      case "instruct-ack":
      case "report":
        return value as ChannelRecord;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** The current picture of one channel, derived from its whole history. */
export interface ChannelProjection {
  /** Most recent self-report, if the child ever made one. */
  lastState?: ChannelStateRecord;
  /**
   * When the child ENTERED the state it is in now — the first report of an
   * unbroken run of the same state, not the newest one.
   *
   * It answers "how long has this been going on", which is the number that
   * makes a state readable: `waiting-judge 220s` is a healthy review round,
   * `waiting-input 900s` is a question nobody is coming to answer. The
   * heartbeat rewrites the same state every minute, so the NEWEST record
   * cannot answer it.
   */
  lastStateSince?: string;

  /** Requests that have neither been settled nor answered yet. */
  openRequests: ChannelRequestRecord[];
  /**
   * Answers the orchestrator wrote for a request the child has not settled
   * yet — the child side's inbox.
   */
  pendingAnswers: ChannelAnswerRecord[];
  /** Instructions with no acknowledgement — the child side's other inbox. */
  pendingInstructs: ChannelInstructRecord[];
  /** ISO time of the newest record of any kind. */
  lastActivityAt?: string;
  /** Newest round report, when any round has closed. */
  lastReport?: ChannelReportRecord;
  /**
   * Every model failure this channel ever saw, oldest first — the pane's own
   * account of why a round was slow (lib/judge-model-rotation.ts).
   *
   * Kept as a LIST, not a last-value: the opener records one cooled-down slot
   * per event, and two failures in one round are two different broken models.
   */
  modelEvents: ModelEvent[];
}

/**
 * Fold a channel's whole history into what is still OUTSTANDING.
 *
 * "Outstanding" is decided by the child's own settle record, never by the
 * orchestrator's answer: an answer that was written but never consumed (the
 * child crashed between the two) must stay pending, or a recovery would drop
 * it. The settle record is the child saying "this is over", and it is the
 * only thing that closes a request.
 *
 * STATE RECORDS ARE FILTERED TO THE CHANNEL'S OWNER first (2026-09-09). A
 * channel file is one child's conversation with its orchestrator, but a
 * process the child spawned — a background subagent via the Agent tool —
 * INHERITS the orchestration env vars, so its own gate binds to the same
 * channel and appends its own state heartbeats. The first state record that
 * carries a session id names the channel's owner; every other session's
 * records are foreign and ignored. Without the filter a finished subagent's
 * idle heartbeat overwrote the owner's working report and the project
 * manager read "停下了（没有 declare_done）" for a child that was streaming
 * (measured: 12 of 363 channels polluted; one PM session received the false
 * report 115 times).
 */
export function projectChannel(records: readonly ChannelRecord[]): ChannelProjection {
  const owner = channelOwnerId(records);
  const own = owner === undefined
    // No state record ever named an owner (an older build, or a channel that
    // only ever saw requests) ⇒ nothing to filter: every record is treated
    // as the owner's, exactly as before the filter existed.
    ? records
    // The owner's own records, records that never named a session (the
    // owner's own early heartbeats, written before its sidecar carried the
    // session id), and every non-state record (requests, answers,
    // instructs… never carry a session id) — but never a record from a
    // DIFFERENT named session (the pollution this filter exists to drop:
    // a spawned subagent inherits the env vars, binds the same channel and
    // appends its own idle heartbeats over the owner's reports).
    // A `session_handoff` successor of the owner is the owner (2026-09-26).
    : records.filter((r) => r.kind !== "state" || r.sessionId === undefined || isHandoffChainOf(owner, r.sessionId));
  return projectOwnedRecords(own);
}

/**
 * THE CHANNEL'S OWNER — the session id of the first state record that has
 * one. `undefined` when no state record ever named a session.
 *
 * "First" is safe by construction: a child writes its first state report
 * when it boots, and a subagent is spawned BY that child later, so the
 * owner's record always precedes any foreign one.
 */
export function channelOwnerId(records: readonly ChannelRecord[]): string | undefined {
  for (const record of records) {
    if (record.kind === "state" && record.sessionId !== undefined && record.sessionId !== "") {
      return record.sessionId;
    }
  }
  return undefined;
}

function projectOwnedRecords(records: readonly ChannelRecord[]): ChannelProjection {
  const settled = new Set<string>();
  const injected = new Set<string>();
  for (const record of records) {
    if (record.kind === "request-settled") settled.add(record.requestId);
    // Only an INJECTED acknowledgement takes an instruction out of the child's
    // inbox. A `received` ack proves the gate has it — which is what the
    // orchestrator's receipt is allowed to rely on — but the child still has
    // to deliver it, and dropping it here would lose exactly the `followUp`
    // messages this two-stage handshake exists to stop losing.
    if (record.kind === "instruct-ack" && (record.stage ?? "injected") === "injected") {
      injected.add(record.instructId);
    }
  }
  let lastState: ChannelStateRecord | undefined;
  let lastStateSince: string | undefined;
  const openRequests: ChannelRequestRecord[] = [];
  const pendingAnswers: ChannelAnswerRecord[] = [];
  const pendingInstructs: ChannelInstructRecord[] = [];
  let lastActivityAt: string | undefined;
  let lastReport: ChannelReportRecord | undefined;
  const modelEvents: ModelEvent[] = [];
  for (const record of records) {
    if (!lastActivityAt || record.at > lastActivityAt) lastActivityAt = record.at;
    switch (record.kind) {
      case "state":
        // A run of identical states keeps its FIRST timestamp: the heartbeat
        // re-reports the same state on a timer, so "since" would otherwise
        // reset every tick and every wait would look freshly started.
        if (!lastState || lastState.state !== record.state) lastStateSince = record.at;
        lastState = record;
        if (record.modelEvent) modelEvents.push(record.modelEvent);
        break;
      case "request":
        if (!settled.has(record.requestId)) openRequests.push(record);
        break;
      case "answer":
        if (!settled.has(record.requestId)) pendingAnswers.push(record);
        break;
      case "instruct":
        if (!injected.has(record.instructId)) pendingInstructs.push(record);
        break;
      case "report":
        lastReport = record;
        break;
      default:
        break;
    }
  }

  return {
    lastState,
    ...(lastStateSince === undefined ? {} : { lastStateSince }),
    openRequests,
    pendingAnswers,
    pendingInstructs,
    lastActivityAt,
    ...(lastReport === undefined ? {} : { lastReport }),
    modelEvents,
  };

}

/**
 * Has this child gone quiet while its pane is still there?
 *
 * `paneAlive === undefined` deliberately never yields `stalled`: an
 * unreadable pane list is missing information, and reporting a healthy child
 * as broken ends its supervision just as surely as missing a real stall.
 */
export function isStalled(
  projection: ChannelProjection,
  paneAlive: boolean | undefined,
  now: number,
  staleMs: number = HEARTBEAT_STALE_MS,
): boolean {
  if (paneAlive !== true) return false;
  const last = projection.lastActivityAt;
  if (!last) return false;
  const at = Date.parse(last);
  if (!Number.isFinite(at)) return false;
  return now - at > staleMs;
}
