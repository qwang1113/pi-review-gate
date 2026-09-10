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
import { isDeliveryStation, type DeliveryStation } from "./delivery-station.ts";
import type { ModelEvent } from "./model-health.ts";


/** Directory (under the pi agent home) that holds every orchestration's channels. */
export const CHANNEL_ROOT_DIRNAME = "rg-channels";

/**
 * A serialized record whose UTF-8 length exceeds this spills its bulky field
 * to a side file.
 *
 * Deliberately well under `PIPE_BUF` (4096): the budget has to cover the
 * record's own envelope plus JSON escaping, and being wrong here means a torn
 * line, which is the one failure this whole scheme exists to prevent.
 *
 * MEASURED IN BYTES, and that is not a detail: `PIPE_BUF` is a byte limit,
 * while `String.length` counts UTF-16 units. Everything a judge writes here is
 * Simplified Chinese by directive (L4), and a CJK code point is 3 bytes — so a
 * 1500-CHARACTER record can be 4400 bytes and tear, which is exactly the case
 * this constant exists to prevent. (Found while adding the structured findings
 * array, 2026-09-04; the prose `summary` path had the same latent hole.)
 */
export const MAX_INLINE_RECORD_BYTES = 1500;

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

  /**
   * A MODEL OF THIS PANE FAILED (2026-09-10).
   *
   * Written by the judge side when its own provider keeps failing
   * (lib/judge-model-rotation.ts) — the one fact the opener cannot observe
   * for itself, because it is blocked in a wait and the provider error lands
   * in the pane's own pi process. `to` names the slot the pane moved to;
   * `exhausted` means nothing is left, which ENDS the round as a failure
   * rather than letting it hang forever.
   *
   * Rides on a `state` record deliberately: heartbeats already flow through
   * every reader, and an opener running an older build ignores the extra key
   * instead of failing to parse the record.
   */
  modelEvent?: ModelEvent;

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
   * user's behalf is constraint 8, and the draft the crosscheck judges is the
   * the `payload` of THIS record — written by the child itself, so a
   * hand-copied text can neither widen nor narrow what gets approved (R-7).
   *
   * `restatement` (2026-09-06) is the requirement restatement a child must get
   * confirmed BEFORE it negotiates a goal. It travels the same way, carrying
   * the full restatement as its `payload`, so a project manager answering for
   * the user judges the child's own words rather than a retyped summary.
   */
  topic?: "goal-approval" | "goal-reason" | "restatement" | "workspace" | "ask-user" | "plan-approval" | "scope-limit" | "sensitive-edit" | "other";
  title: string;
  /** The exact rows offered, in order. Empty for `input`. */
  options: string[];
  /** The full text behind the question (a goal draft, a plan) when there is one. */
  payload?: string;
  payloadRef?: ChannelPayloadRef;
  /**
   * WHERE THE ROUND THIS QUESTION IS ABOUT STOPS (2026-09-06) — the delivery
   * station the child is asking to have confirmed (`restatement`), or the one
   * recorded beside the goal it wants approved (`goal-approval`).
   *
   * A pure addition: an older gate ignores it, and a record without it leaves
   * the station comparison unmade (see {@link sanitizeDeliveryStation}).
   *
   * WHY A FIELD AND NOT A LINE IN `payload` (user decision, 2026-09-06). A
   * DECISION is made on this value — an orchestrator may not confirm a station
   * looser than the plan the user approved — and the alternative on the table
   * was "the gate appends a canonical line to the payload and parses it back".
   * That would invent a second, TEXTUAL wire format inside a field whose
   * content is written by the CHILD: the child could print a line of the same
   * shape in its own restatement, and the only defences are brittle
   * conventions like "take the last match". This channel exists because
   * reading a fact off a rendering is how the orchestration layer used to get
   * things wrong; `ChannelReportRecord.scope` (t6a) is the same shape for the
   * same reason.
   *
   * Untrusted like every wire value: read it through
   * {@link sanitizeDeliveryStation}, never by comparing strings.
   */
  station?: string;

  /**
   * WHICH BATCH OF QUESTIONS THIS ONE BELONGS TO (2026-09-06).
   *
   * An `ask_user` interview is 1–10 questions submitted in ONE call, and the
   * child used to write its request record only when it was about to render
   * that question's dialog. So a five-question interview reached the
   * orchestrator as five separate rounds of "here is one question" → "here is
   * one answer", each costing a full wait cycle (measured this round: t9c 5
   * round trips, t9e 4, t9h 3 — and t9h lost two questions when an instruct
   * dismissed the box it was still standing in front of). The whole batch is
   * now written BEFORE the first dialog opens, so every question is on the
   * orchestrator's first receipt and can be answered in one go.
   *
   * These three fields say nothing the answering side must obey — they make
   * the grouping LEGIBLE (which interview, which position, how many in all)
   * so a receipt can render "第 2/5 题" and a project manager knows whether
   * more of the same interview is coming.
   *
   * PURE ADDITIONS, and that is the point (user constraint, 2026-09-06): the
   * project manager holding this orchestration runs the build it started
   * with, so a record it cannot parse would cut off its own supervision. An
   * older reader ignores all three and still sees N ordinary open requests,
   * each answerable one at a time exactly as before — which is the identical
   * reasoning behind `ChannelReportRecord.inspection` and `.scope`.
   */
  batchId?: string;
  /** 0-based position of this question inside its batch. */
  batchIndex?: number;
  /** How many questions the batch holds in all. */
  batchTotal?: number;


}

/** Child → orchestrator: that request is over, and this is who ended it. */
export interface ChannelSettledRecord extends ChannelRecordBase {
  kind: "request-settled";
  from: "child";
  requestId: string;
  /** `human` = answered in the pane, `orchestrator` = answered via the channel. */
  by: "human" | "orchestrator" | "dismissed" | "interrupted";
  answer?: string;
}

/** Orchestrator → child: the answer to an open request. */
export interface ChannelAnswerRecord extends ChannelRecordBase {
  kind: "answer";
  from: "orchestrator";
  requestId: string;
  answer: string;
  /** Why the orchestrator declined (goal rejection) — carried back to the child's renegotiation. */
  reason?: string;
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


/** One finding on a report, exactly as the judge concluded it. */
export interface ReportFinding {
  severity: string;
  file?: string;
  line?: number;
  issue: string;
  evidence?: string;
}

/**
 * The scope a round ran under, as a WIRE value.
 *
 * Spelled out here rather than imported from the review modules on purpose:
 * this is the channel's own schema, and a record read off disk may have been
 * written by a different build. Both halves are optional and both are
 * validated on read (`reportConclusion`) — an unrecognised `kind` is dropped,
 * never carried through as if it meant something.
 */
export interface ReviewScopeStamp {
  /** The round's commit range, e.g. `abc123def456..789abc012def`. */
  range?: string;
  /** How much of the change the round was told to deep-read. */
  kind?: "full" | "incremental";
}



/**
 * Judge → opener: this round is over, here is the conclusion.
 *
 * The THIRD item of the listener triple (state, findings count, verdict):
 * the judge side writes THIS so the opener learns the round is over through
 * its own `wait` receipt instead of polling a transcript. A child session
 * reports its judges upward the same way — one `report` per finished round,
 * never the raw stdout (bulky summaries spill exactly like request payloads).
 *
 * THE CONCLUSION TRAVELS STRUCTURED (2026-09-04). `verdict`, `findings`, `cwd`
 * and `docSync` are the judge's own `judge_conclude` arguments, carried
 * verbatim. Before that the gate serialised them into a ```json fence and the
 * opener parsed them back out — one implementation writing a format for
 * another implementation to undo, with the judge's prose riding along. The
 * fence is gone; `summary` is now ONLY an adviser's prose, the one role whose
 * product IS the text.
 */
export interface ChannelReportRecord extends ChannelRecordBase {
  kind: "report";
  from: "child";
  reportId: string;
  /** Which round of this judge this report closes. */
  round?: number;
  /** The recorded verdict, e.g. READY or BLOCKED. */
  verdict: string;
  /** Findings the round published (stream line count), not their content. */
  findingsCount?: number;
  /**
   * The round's findings, exactly as the judge concluded them. The opener
   * consumes these directly — there is no text to parse. Spilled to
   * `findingsRef` when the line would otherwise exceed the inline budget: a
   * findings array is unbounded by design (no cap, no truncation), and an
   * over-long line is the one failure this whole record format exists to
   * prevent.
   */
  findings?: ReportFinding[];
  findingsRef?: ChannelPayloadRef;
  /** The judge's own `pwd`, verbatim (the opener checks it against the repo). */
  cwd?: string;
  /** Code↔doc attestation, when the round covered code changes. */
  docSync?: string;
  /**
   * An ADVISER's prose conclusion — the only role whose output is the text
   * itself. Spilled to `summaryRef` when oversized. A reviewer or goal-auditor
   * report carries no prose at all: its conclusion is `verdict` + `findings`.
   */
  summary?: string;
  summaryRef?: ChannelPayloadRef;
  /**
   * What the JUDGE-SIDE gate observed the round actually inspect
   * (lib/judge-inspection.ts) — action count, kinds, and whether anything
   * touched the reviewed range. ADDED as an optional field on purpose: this
   * extension loads from source with no build step, so a running opener holds
   * the build it started with while the panes it opens hold the newest one. A
   * new field an old reader ignores keeps that pair compatible; changing what
   * an existing field MEANS would not.
   */
  inspection?: { actions: number; kinds: string[]; rangeSeen?: boolean; appeal?: string };
  /**
   * HOW FULL THE JUDGE'S OWN CONTEXT WAS when it concluded this round, in
   * percent — the reading only the judge's own process can take.
   *
   * The gate's rotation policy (lib/judge-rotation.ts) needs it, and the
   * opener cannot measure it: this is the one channel it can travel on. It is
   * read at the CONCLUSION, so the decision it feeds is one round stale by
   * construction — the alternative (asking a judge mid-round) does not exist.
   * Optional for the same reason `inspection` is: a report written by an older
   * build simply carries none, and "no reading" is the fail-open case
   * (rotation then rests on the round cap alone), never a rotation.
   */
  contextPercent?: number;
  /**
   * WHICH SCOPE THIS ROUND RAN UNDER, in the judge's own words: the commit
   * range and the full/incremental decision, both read back from the round's
   * task text (lib/judge-inspection.ts).
   *
   * It is a SELF-REPORT, and only that. It makes a finished round legible
   * after the fact — which range, which depth — and the gate keeps it beside
   * what it registered when it dispatched the round (`RoundRecord.scope`,
   * lib/gate-state.ts). Since both halves come from the same gate-written
   * text, agreement proves nothing about how the round was read; a
   * DISAGREEMENT is the informative case (a task text from another round, a
   * pane on another build). Nothing acts on either: it is recorded so a human
   * can look. Whether the round inspected anything at all is a different
   * record — `inspection`, above.
   *
   * A NEW OPTIONAL field, for the same reason `inspection` is one: an opener
   * running an older build ignores it and consumes the report exactly as
   * before, which is what keeps an old opener and a new judge pane compatible.
   */
  scope?: ReviewScopeStamp;

}
export type ChannelRecord =
  | ChannelStateRecord
  | ChannelRequestRecord
  | ChannelSettledRecord
  | ChannelAnswerRecord
  | ChannelInstructRecord
  | ChannelInstructAckRecord
  | ChannelReportRecord;

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
 * A judge channel target: `<opener-id>/<judge-id>.jsonl` under the same root.
 *
 * Deliberately the SAME file shape as an orchestration channel (not a
 * second channel module): the opener may be a session id rather than an
 * orchestration id, but the record/spill/cursor primitives do not care —
 * planes differ by key naming only.
 */
export function judgeChannelTarget(openerId: string, judgeId: string, home?: string): ChannelTarget {
  return { orchestrationId: openerId, childId: judgeId, ...(home === undefined ? {} : { home }) };
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

/** The UTF-8 size of a record once serialized — what `PIPE_BUF` actually bounds. */
function recordBytes(record: ChannelRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

/** Move `payload` / `text` / `findings` into a side file when the line would be too long. */
function spillIfLarge(io: ChannelIO, target: ChannelTarget, record: ChannelRecord): ChannelRecord {
  if (recordBytes(record) <= MAX_INLINE_RECORD_BYTES) return record;
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
  if (record.kind === "report") {
    // A report carries TWO bulky things and either alone can blow the budget:
    // an adviser's prose (`summary`) and — since the conclusion travels
    // structured — the `findings` array. Spill both, biggest first, and stop
    // as soon as the line fits: a round with one huge finding must not also
    // lose its prose to a side file, and a round with twenty ordinary
    // findings must not stay inline just because it has no prose.
    let out: ChannelRecord = record;
    const path = payloadPathFor(target.orchestrationId, target.childId, record.reportId, target.home);
    const findingsSize = record.findings === undefined ? 0 : Buffer.byteLength(JSON.stringify(record.findings), "utf8");
    const summarySize = record.summary === undefined ? 0 : Buffer.byteLength(record.summary, "utf8");
    const spillFindings = () => {
      const r = out as ChannelReportRecord;
      // An empty array is not what blew the budget — moving it out would cost
      // a side file and save two characters.
      if (r.findings === undefined || r.findings.length === 0) return;
      const text = JSON.stringify(r.findings);
      io.writeText(`${path}.findings`, text);
      const { findings, ...rest } = r;
      out = { ...rest, findingsRef: { path: `${path}.findings`, chars: text.length } };
    };
    const spillSummary = () => {
      const r = out as ChannelReportRecord;
      if (r.summary === undefined) return;
      io.writeText(path, r.summary);
      const { summary, ...rest } = r;
      out = { ...rest, summaryRef: { path, chars: summary.length } };
    };
    const [first, second] = findingsSize >= summarySize
      ? [spillFindings, spillSummary]
      : [spillSummary, spillFindings];
    first();
    if (recordBytes(out) > MAX_INLINE_RECORD_BYTES) second();
    return out;
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

/** The full report summary, whether it was inlined or spilled. */
export function reportText(io: ChannelIO, record: ChannelReportRecord): string | undefined {
  return record.summary ?? resolvePayload(io, record.summaryRef);
}

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
    : records.filter((r) => r.kind !== "state" || r.sessionId === undefined || r.sessionId === owner);
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
