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
 * THE MODULE SPLIT. This file is the WIRE SCHEMA — the record types and
 * nothing else. The filesystem seam, the paths and the spill rule live in
 * lib/channel-io.ts; reading a channel back and folding it into a picture
 * ({@link ChannelRecord} → projection, staleness) lives in
 * lib/channel-projection.ts. Every decision there is a pure function of
 * records, so the protocol is testable end to end with no tmux, no pi runtime
 * and no filesystem.
 */

import type { ModelEvent } from "./model-health.ts";

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
   * WHAT IT IS DOING, in one line — the tool call it made most recently, as
   * rendered by `describeToolActivity` (e.g. `bash(grep -rn PrimeUsers src/)`).
   *
   * WHY (2026-09-17, user decision). A manager reading only `working · 自上次推进
   * 3200s` cannot tell "reading a large tree" from "spinning on the same
   * search for the third time" — and the plan's next step depends on that
   * difference. The state word says WHETHER the child moves; this says WHAT it
   * is moving on. It is a READING for the receipt: never a wake reason (the
   * supervisor's newsworthiness does not consult it), and never allowed to
   * fail a report — an unreadable input degrades to the bare tool name.
   */
  activity?: string;
  /**
   * ISO time this child's LAST TURN ENDED, present ONLY while nothing has run
   * since — a tool call clears it (2026-09-10, user decision).
   *
   * WHY THIS EXISTS. `idle` used to be believed only after
   * `IDLE_PROGRESS_GRACE_MS` (120s) of confirmed silence, because
   * `ctx.isIdle()` is ALSO true between two tool calls: a child stepping
   * bash → read → bash reports `idle` at almost every tick, and the measured
   * cost was four "停下了" reports in a row on a child whose transcript was
   * growing. 120s was the confirmation that separated the two cases.
   *
   * This field separates them STRUCTURALLY instead. "The agent settled and has
   * run nothing since" cannot be true in the middle of an investigation — the
   * tool call that would follow clears the stamp — so a supervisor may act on
   * it at once. A child that cannot report it (an older build, a session that
   * has not settled yet) leaves it absent and keeps the 120s rule as the
   * fallback: the structural evidence is preferred, never required.
   */
  settledSince?: string;

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
  topic?: "goal-approval" | "goal-reason" | "restatement" | "workspace" | "ask-user" | "plan-approval" | "scope-limit" | "sensitive-edit" | "tmux-access" | "other";
  title: string;
  /** The exact rows offered, in order. Empty for `input`. */
  options: string[];
  /**
   * THIS QUESTION TAKES SEVERAL ANSWERS (2026-09-22) — a checkbox list, not a
   * radio one. The rows look the same (`A. text`), so without this flag a
   * project manager would answer a multiple-choice question with exactly one
   * row and believe that was all it took; with it, `orchestrator_answer`
   * accepts a LIST and normalizes it to the shape the child parses.
   *
   * Optional, so a record written by an older child simply reads as a radio
   * question — which is what it was.
   */
  multiple?: boolean;
  /** The full text behind the question (a goal draft, a plan) when there is one. */
  payload?: string;
  payloadRef?: ChannelPayloadRef;
  /**
   * WHERE THE ROUND THIS QUESTION IS ABOUT STOPS (2026-09-06) — the delivery
   * station the child is asking to have confirmed (`restatement`), or the one
   * recorded beside the goal it wants approved (`goal-approval`).
   *
   * A pure addition: an older gate ignores it, and a record without it leaves
   * the station comparison unmade (see `sanitizeDeliveryStation`,
   * lib/channel-projection.ts).
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
   * `sanitizeDeliveryStation`, never by comparing strings.
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
  /**
   * WHICH ROUND this instruction is, for the lanes that number them (a judge
   * pane's rounds). Sent WITH the task, and that is the point (2026-09-16):
   * the opener's table is numbered at DISPATCH, so a judge still finishing its
   * previous round would read the NEXT number off it, stamp the old verdict
   * with it, and have its real conclusion refused as a duplicate. The task is
   * the one place that says which round it belongs to.
   *
   * Absent for every non-judge lane and for an instruction that carries no
   * round at all; the reader then falls back to the table by itself.
   */
  roundSeq?: number;
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
