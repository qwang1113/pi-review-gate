/**
 * THE POINT-TO-POINT CHANNEL — one file per child, and nothing global.
 *
 * WHAT THIS REPLACES, and why it had to go. Supervision used to ride a single
 * GLOBAL queue (`~/.pi/agent/review-gate-attention.json`) that every session
 * appended to and every session read, with a `toSessionId` field as the only
 * thing keeping the traffic apart. Two defects followed from that shape alone:
 * a waiter could consume an event addressed to somebody else (R-16/F12), and
 * the recipient filter was a rule in code rather than a property of the
 * medium — so every new caller had to remember to apply it.
 *
 * Here the isolation is PHYSICAL. Child `c` of orchestration `o` has exactly
 * one file, `<root>/<o>/<c>.jsonl`, and nobody else writes to it or reads it.
 * There is no recipient field because there is nothing to disambiguate: a
 * record in that file is, by construction, traffic between that child and
 * whoever currently holds that orchestration.
 *
 * THE CHANNEL IS A PATH, NOT A PROCESS. This is what makes handover free. An
 * orchestrator that dies (or hands off deliberately) takes no channel state
 * with it: the successor opens the same paths and continues, and the child
 * never learns that anything happened — it keeps appending to the same file
 * it always did. The old design addressed a session, so replacing the session
 * silently retired the bell (measured: zero delivered events over a night).
 *
 * BOTH DIRECTIONS SHARE ONE FILE, and every record says who wrote it. A
 * second file per direction would double the paths to keep in sync for no
 * gain: readers already filter by `kind`, and one file makes "what happened
 * to this child, in order" a single read.
 *
 * WHY EVERY LINE IS SMALL (the spill rule). Two processes append to this file
 * concurrently. A POSIX `O_APPEND` write is atomic only below `PIPE_BUF`
 * (4 KiB), and the payloads that matter here — a loop-goal draft, a task
 * document — are exactly the ones that blow past it. So anything bulky is
 * SPILLED to a sibling file and the record carries a reference
 * ({@link ChannelPayloadRef}); the JSONL line itself stays far under the
 * limit and can never be torn. Readers resolve refs through the same IO seam,
 * so a test never touches a real disk.
 *
 * Pure-ish module: all IO goes through the injected {@link ChannelIO}, and
 * every decision ({@link projectChannel}, the staleness rule) is a pure
 * function of records. That is the point — the protocol is testable end to
 * end with no tmux, no pi runtime and no filesystem.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

/** Directory (under the pi agent home) that holds every orchestration's channels. */
export const CHANNEL_ROOT_DIRNAME = "rg-channels";

/**
 * A serialized record longer than this spills its bulky field to a side file.
 *
 * Deliberately well under `PIPE_BUF` (4096): the budget has to cover the
 * record's own envelope plus JSON escaping, and being wrong here means a torn
 * line, which is the one failure this whole scheme exists to prevent.
 */
export const MAX_INLINE_RECORD_CHARS = 1500;

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

/** Who wrote a record. There are only ever two writers. */
export type ChannelWriter = "child" | "orchestrator";

/**
 * What a child reports about itself. `dead` is NOT in here on purpose: a
 * corpse cannot file a report, so liveness is the one thing the orchestrator
 * measures from outside (pane existence).
 *
 * `waiting-judge` is the round-4 addition, and it exists because SILENCE and
 * WAITING FOR A KNOWN THING are not the same fact. The gate is the one that
 * dispatched the judge, so it knows precisely why the agent went quiet;
 * reporting that instead of letting the silence be interpreted is what keeps
 * a healthy review round from looking like a hang.
 */
export type ChildReportedState = "working" | "waiting-input" | "idle" | "done" | "waiting-judge" | "mode-changed";


/** A bulky field that lives in a side file next to the channel. */
export interface ChannelPayloadRef {
  /** Absolute path of the spilled file. */
  path: string;
  /** Length of the original text, so a reader can report it without loading. */
  chars: number;
}

/** Base fields every record carries. */
interface ChannelRecordBase {
  from: ChannelWriter;
  /** ISO timestamp the writer stamped. */
  at: string;
}

/** Child → orchestrator: what I am doing right now. */
export interface ChannelStateRecord extends ChannelRecordBase {
  kind: "state";
  from: "child";
  state: ChildReportedState;
  /** The child's own pi session id, so a recovery can re-open it. */
  sessionId?: string;
  /** Percent of the context window used, when the host reports it. */
  contextPercent?: number;
  /** Title of the dialog currently open (only when `waiting-input`). */
  dialogTitle?: string;
  /** Free-form progress note; never a criterion. */
  note?: string;
  /**
   * WHAT it is blocked on, when `state` is `waiting-judge` (`reviewer`,
   * `precommit`, …). Written by the gate that started that work, never
   * inferred: "waiting" with no object is just silence with a label.
   */
  waitingFor?: string;
  /**
   * ISO time of the child's last FORWARD PROGRESS — a tool call or a turn
   * boundary, NOT a heartbeat tick (round-5 E). The heartbeat re-reports the
   * same `working` every 10s, so `lastActivityAt` cannot tell a child that is
   * turning the crank from one wedged in place. This stamp only advances on a
   * real agent event, so `working` gets a progress dimension: "60 minutes of
   * `working` with no checkpoint" stops looking identical to a hang. It is a
   * READING for the receipt, never a wake reason.
   */
  lastProgressAt?: string;

}

/** Child → orchestrator: a dialog is open, here is the whole question. */
export interface ChannelRequestRecord extends ChannelRecordBase {
  kind: "request";
  from: "child";
  requestId: string;
  dialogKind: "select" | "confirm" | "input";
  /**
   * WHICH gate dialog this is — set by the gate that raised it, so the
   * orchestrator side never has to recognize a question by its wording.
   *
   * `goal-approval` is the one that carries a rule: answering it on the
   * user's behalf is constraint 8, and the draft the boundary check judges is
   * the `payload` of THIS record — written by the child itself, so a
   * hand-copied text can neither widen nor narrow what gets approved (R-7).
   */
  topic?: "goal-approval" | "workspace" | "ask-user" | "plan-approval" | "scope-limit" | "sensitive-edit" | "protected-branch" | "other";
  title: string;
  /** The exact rows offered, in order. Empty for `input`. */
  options: string[];
  /** The full text behind the question (a goal draft, a plan) when there is one. */
  payload?: string;
  payloadRef?: ChannelPayloadRef;
}

/** Child → orchestrator: that request is over, and this is who ended it. */
export interface ChannelSettledRecord extends ChannelRecordBase {
  kind: "request-settled";
  from: "child";
  requestId: string;
  /** `human` = answered in the pane, `orchestrator` = answered via the channel. */
  by: "human" | "orchestrator" | "dismissed";
  answer?: string;
}

/** Orchestrator → child: the answer to an open request. */
export interface ChannelAnswerRecord extends ChannelRecordBase {
  kind: "answer";
  from: "orchestrator";
  requestId: string;
  answer: string;
}

/**
 * Orchestrator → child: say this to the agent.
 *
 * `steer` / `followUp` map straight onto `pi.sendUserMessage`'s own
 * `deliverAs`; `interrupt` is `ctx.abort()` and carries no text.
 */
export interface ChannelInstructRecord extends ChannelRecordBase {
  kind: "instruct";
  from: "orchestrator";
  instructId: string;
  mode: "steer" | "followUp" | "interrupt";
  text?: string;
  textRef?: ChannelPayloadRef;
}

/**
 * Child → orchestrator: I have that instruction — and later, I applied it.
 *
 * TWO STAGES, BECAUSE `followUp` MEANS "LATER" (round-4 P1). The old record
 * had one meaning ("injected"), so the only way to acknowledge a `followUp`
 * was to have already delivered it. But `followUp` is DEFINED as "finish what
 * you are doing, then read this": a busy child cannot inject it yet, the
 * orchestrator's tool therefore judged the send a failure, and the message it
 * had already written was silently orphaned in the channel. Measured: one
 * authorization lost, worked around by smuggling the text into an answer
 * option.
 *
 * So a child now says `received` the moment the instruction is in its hands
 * (which is what proves the gate is alive and listening) and `injected` when
 * pi has actually taken it. `steer` and `interrupt` still require `injected`
 * — they promise to act on the CURRENT turn, and a queued one has not.
 */
export type InstructAckStage = "received" | "injected";

export interface ChannelInstructAckRecord extends ChannelRecordBase {
  kind: "instruct-ack";
  from: "child";
  instructId: string;
  /** True once the instruction was actually applied (`injected`). */
  delivered: boolean;
  /**
   * Which half of the handshake this is. Absent ⇒ `injected`: records written
   * before this field existed only ever reported completed injections.
   */
  stage?: InstructAckStage;
  detail?: string;
}


export type ChannelRecord =
  | ChannelStateRecord
  | ChannelRequestRecord
  | ChannelSettledRecord
  | ChannelAnswerRecord
  | ChannelInstructRecord
  | ChannelInstructAckRecord;

/**
 * Every filesystem touch the channel makes, as one injectable seam.
 *
 * Four methods, all trivially fakeable — which is what lets the protocol
 * tests drive the REAL implementation with an in-memory map instead of
 * asserting against a mock of it.
 */
export interface ChannelIO {
  ensureDir(dir: string): void;
  /** Append one line. MUST be a single append write (atomicity is the contract). */
  appendLine(path: string, line: string): void;
  /** Whole file, or `undefined` when it does not exist. */
  readText(path: string): string | undefined;
  /** Replace a file's contents (spilled payloads only, never the JSONL). */
  writeText(path: string, text: string): void;
  now(): number;
}

/** The real filesystem. */
export function nodeChannelIO(): ChannelIO {
  return {
    ensureDir(dir) {
      mkdirSync(dir, { recursive: true });
    },
    appendLine(path, line) {
      appendFileSync(path, line, "utf8");
    },
    readText(path) {
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    writeText(path, text) {
      writeFileAtomic(path, text);
    },
    now: () => Date.now(),
  };
}

/**
 * Root of every channel. Global (pi's agent home) rather than repo-local
 * because a child may run in a worktree, or in another repository entirely,
 * and the orchestrator still has to reach it.
 */
export function channelRoot(home: string = homedir()): string {
  return join(home, ".pi", "agent", CHANNEL_ROOT_DIRNAME);
}

/**
 * Only the characters that are safe in a path segment survive.
 *
 * A DOT is excluded along with everything else non-alphanumeric, and that is
 * the whole security property: with dots allowed, `..` survives sanitizing
 * and a crafted id stops being a NAME and becomes a PATH. Both real inputs
 * (an orchestration id, a registry child id) are alphanumeric-with-dashes
 * already, so nothing legitimate is lost.
 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "unnamed";
}


/** Directory holding one orchestration's channels. */
export function channelDir(orchestrationId: string, home?: string): string {
  return join(channelRoot(home), safeSegment(orchestrationId));
}

/** The one file this child and this orchestration talk through. */
export function channelPathFor(orchestrationId: string, childId: string, home?: string): string {
  return join(channelDir(orchestrationId, home), `${safeSegment(childId)}.jsonl`);
}

/** Side file for a spilled payload; named after the record it belongs to. */
export function payloadPathFor(
  orchestrationId: string,
  childId: string,
  recordId: string,
  home?: string,
): string {
  return join(channelDir(orchestrationId, home), `${safeSegment(childId)}.${safeSegment(recordId)}.payload`);
}

/** A collision-resistant id for a request or an instruction. */
export function newChannelId(prefix: string, now: number, entropy = Math.random()): string {
  return `${prefix}-${Math.floor(now).toString(36)}-${entropy.toString(36).slice(2, 8)}`;
}

/** Where a record is written, and which id names its spill file. */
export interface ChannelTarget {
  orchestrationId: string;
  childId: string;
  home?: string;
}

/**
 * Append one record, spilling an oversized payload first.
 *
 * Returns the record as it was actually written (with `payloadRef` in place
 * of `payload` when it spilled) so a caller can report the truth rather than
 * what it intended.
 */
export function appendRecord(io: ChannelIO, target: ChannelTarget, record: ChannelRecord): ChannelRecord {
  const dir = channelDir(target.orchestrationId, target.home);
  io.ensureDir(dir);
  const stored = spillIfLarge(io, target, record);
  io.appendLine(channelPathFor(target.orchestrationId, target.childId, target.home), `${JSON.stringify(stored)}\n`);
  return stored;
}

/** Move `payload` / `text` into a side file when the line would be too long. */
function spillIfLarge(io: ChannelIO, target: ChannelTarget, record: ChannelRecord): ChannelRecord {
  if (JSON.stringify(record).length <= MAX_INLINE_RECORD_CHARS) return record;
  if (record.kind === "request" && record.payload !== undefined) {
    const path = payloadPathFor(target.orchestrationId, target.childId, record.requestId, target.home);
    io.writeText(path, record.payload);
    const { payload, ...rest } = record;
    return { ...rest, payloadRef: { path, chars: payload.length } };
  }
  if (record.kind === "instruct" && record.text !== undefined) {
    const path = payloadPathFor(target.orchestrationId, target.childId, record.instructId, target.home);
    io.writeText(path, record.text);
    const { text, ...rest } = record;
    return { ...rest, textRef: { path, chars: text.length } };
  }
  // Nothing bulky to move (a huge dialog title, say). Truncation would lose
  // the very content the orchestrator needs, and an over-long line only risks
  // interleaving — never silent data loss — so it is written as it is.
  return record;
}

/** Resolve a spilled payload back into text. `undefined` when unreadable. */
export function resolvePayload(io: ChannelIO, ref: ChannelPayloadRef | undefined): string | undefined {
  if (!ref) return undefined;
  return io.readText(ref.path);
}

/** The full request text, whether it was inlined or spilled. */
export function requestPayload(io: ChannelIO, record: ChannelRequestRecord): string | undefined {
  return record.payload ?? resolvePayload(io, record.payloadRef);
}

/** The full instruction text, whether it was inlined or spilled. */
export function instructText(io: ChannelIO, record: ChannelInstructRecord): string | undefined {
  return record.text ?? resolvePayload(io, record.textRef);
}

/** What a read produced: the records, and the lines that could not be parsed. */
export interface ChannelRead {
  records: ChannelRecord[];
  /** Lines that failed to parse — reported, never silently dropped. */
  malformed: number;
  /** Byte-independent cursor: how many LINES have been consumed. */
  cursor: number;
}

/**
 * Read a channel from `cursor` lines in.
 *
 * The cursor counts LINES rather than bytes deliberately: a byte offset into
 * a file another process is appending to is only correct if nothing was ever
 * rewritten, and one truncation would silently replay or skip history. Lines
 * are cheap to count and the files are bounded by the life of one child.
 */
export function readChannel(io: ChannelIO, path: string, cursor = 0): ChannelRead {
  const raw = io.readText(path);
  if (raw === undefined) return { records: [], malformed: 0, cursor };
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const records: ChannelRecord[] = [];
  let malformed = 0;
  for (const line of lines.slice(cursor)) {
    const parsed = parseRecord(line);
    if (parsed) records.push(parsed);
    else malformed += 1;
  }
  return { records, malformed, cursor: lines.length };
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
}

/**
 * Fold a channel's whole history into what is still OUTSTANDING.
 *
 * "Outstanding" is decided by the child's own settle record, never by the
 * orchestrator's answer: an answer that was written but never consumed (the
 * child crashed between the two) must stay pending, or a recovery would drop
 * it. The settle record is the child saying "this is over", and it is the
 * only thing that closes a request.
 */
export function projectChannel(records: readonly ChannelRecord[]): ChannelProjection {
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
  for (const record of records) {
    if (!lastActivityAt || record.at > lastActivityAt) lastActivityAt = record.at;
    switch (record.kind) {
      case "state":
        // A run of identical states keeps its FIRST timestamp: the heartbeat
        // re-reports the same state on a timer, so "since" would otherwise
        // reset every tick and every wait would look freshly started.
        if (!lastState || lastState.state !== record.state) lastStateSince = record.at;
        lastState = record;
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
