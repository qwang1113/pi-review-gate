/**
 * WHEN A JUDGE'S TRANSCRIPT ENDS — the reuse unit, the release point, the cap.
 *
 * A judge session is REUSED across rounds on purpose: that is how a reviewer
 * keeps what it learned last round instead of re-deriving it at max thinking.
 * Reuse without a release point is a different thing entirely, and we measured
 * it: one transcript that absorbed every review of a whole project grew to
 * 2.8MB, $114 and 74.8% of its context window before anybody noticed. The
 * user's rule from that day (2026-09-05): a reuse policy MUST name its unit,
 * its release point and its cap, or it is slow poisoning.
 *
 * This module is those three answers, as pure functions:
 *
 *  - UNIT — one REVIEW OBJECT: the approved contract the rounds serve. A loop
 *    session's object is its approved loop goal; an orchestration's is its
 *    approved plan. Rounds under the same object share one transcript.
 *  - RELEASE POINT — the object id changed. Judged LAZILY, at the next
 *    dispatch: nothing has to fire an event when a goal is approved or a plan
 *    is re-signed, because the next round simply notices it is serving a
 *    different object and starts a new transcript.
 *  - CAP — {@link JUDGE_ROTATION_CONTEXT_PERCENT} of the judge's own context,
 *    or {@link JUDGE_ROTATION_MAX_ROUNDS} rounds under one object. Either one
 *    rotates the transcript: same object, next GENERATION, carrying a
 *    compressed hand-off instead of the history.
 *
 * Rotation is the GATE's decision. There is no switch, no config key and no
 * agent-facing knob — an agent never asks for it and never opts out.
 *
 * Pure: no filesystem, no clock, no process. Every fact (the approved hashes,
 * the previous lane's bookkeeping, the judge's last context reading) is
 * injected by the caller, which is what makes each rule unit-testable.
 */

import type { JudgeLane } from "./judge-process.ts";
import {
  buildReviewCarryover,
  SCOPE_BLOCK_HEADING,
  type ReviewDelta,
  type SettledConclusion,
} from "./review-carryover.ts";

/**
 * Context percentage at or above which the gate rotates the transcript.
 *
 * 60 is the USER's number (2026-09-05), not a tuning guess: it leaves a judge
 * enough room to finish the round it is asked to do next. Named, not inlined,
 * so a later reader cannot mistake it for a magic constant to adjust by feel.
 */
export const JUDGE_ROTATION_CONTEXT_PERCENT = 60;

/**
 * Rounds under ONE object after which the gate rotates regardless of context.
 *
 * 8 is the USER's number (2026-09-05). It is also the ONLY cap that still
 * works when the context reading is unavailable — see
 * {@link decideJudgeRotation}'s fail-open rule.
 */
export const JUDGE_ROTATION_MAX_ROUNDS = 8;

/**
 * The object id used when nothing is approved yet.
 *
 * A stable placeholder, deliberately NOT "no object": the rounds before a goal
 * is approved (the goal audits themselves, most of all) are a real object with
 * a real transcript, and they are subject to BOTH caps like any other. The
 * unapproved phase must never become a second unbounded bucket.
 */
export const NO_JUDGE_OBJECT = "none";

/** The approved contracts a session can be serving, as the gate observes them. */
export interface JudgeObjectFacts {
  /** Is this an ORCHESTRATION session (project manager)? Decides the priority. */
  orchestrator?: boolean;
  /** Content hash of the approved plan, when one is approved. */
  planHash?: string;
  /** Content hash of the approved loop goal, when one is approved. */
  goalHash?: string;
}

/**
 * WHICH contract this session's judges serve — a written-down priority, never
 * "whichever hash happened to be readable".
 *
 * An orchestrator takes its PLAN, everyone else takes their GOAL. Both can be
 * present at once (a project manager may also carry a goal record from a
 * previous life of the session), and letting read order decide would make the
 * object identity drift between two dispatches that observed the same facts.
 */
export function judgeObjectId(facts: JudgeObjectFacts): string {
  const plan = (facts.planHash ?? "").trim();
  const goal = (facts.goalHash ?? "").trim();
  if (facts.orchestrator) return plan || NO_JUDGE_OBJECT;
  return goal || NO_JUDGE_OBJECT;
}

/**
 * What the registry remembers about the lane a role is currently running in.
 *
 * Every field is optional because an entry written by an OLDER build has none
 * of them: this extension loads from source with no build step, so a running
 * opener and the panes it opens can hold different builds. A record with no
 * object is not an error — it is a lane that predates the policy, and it
 * degrades to "first round of this object" rather than throwing.
 */
export interface JudgeLaneRecord {
  /** The FULL object id (the lazy comparison is made against this, not the path prefix). */
  objectId?: string;
  /** Which generation of this object's transcript the lane is on. */
  generation?: number;
  /** Rounds DISPATCHED under this object so far — abandoned rounds included. */
  roundsInObject?: number;
  /** The judge's own context reading at the end of its last round, in percent. */
  contextPercent?: number;
}

/** Why this dispatch got the lane it got. */
export type JudgeRotationReason =
  /** No usable previous lane — this object's first transcript. */
  | "first"
  /** The session moved to a different approved goal/plan. */
  | "object-changed"
  /** The judge's own context passed the threshold. */
  | "context"
  /** The round cap under one object was reached. */
  | "rounds"
  /** Nothing fired: the round continues the same transcript. */
  | "reuse";

/** The dispatch's lane, and the bookkeeping to write back with it. */
export interface JudgeRotationDecision {
  /** Identity of the transcript this round belongs to. */
  lane: JudgeLane;
  /** True ⇒ a NEW transcript: the round needs a compressed hand-off, and the previous lane is finished. */
  rotated: boolean;
  reason: JudgeRotationReason;
  /**
   * Rounds under this object INCLUDING the one being dispatched.
   *
   * Counted at DISPATCH, which is what makes an abandoned round count: a round
   * that is thrown away (`fresh: true`, a killed pane, a report that never
   * lands) still consumed the transcript it was sent into. Counting at the
   * conclusion instead would let a judge that is reopened over and over sit
   * under the cap forever.
   */
  roundsInObject: number;
}

/** Non-negative integer, or 0 — untrusted persisted numbers never reach arithmetic. */
function count(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * A trimmed object id, or `""` — untrusted persisted values never reach string
 * methods either.
 *
 * The registry passes unknown fields through when it parses a snapshot (that
 * is what lets a new field survive an older build), so a hand-edited or
 * truncated file can put a number where this string belongs. `""` means "no
 * object recorded", which the policy already handles as a first lane.
 */
function objectIdOf(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Decide THIS dispatch's lane.
 *
 * Order of the rules, and why:
 *
 *  1. no previous lane / no recorded object ⇒ `first` (generation 0). A lane
 *     from an older build lands here rather than being guessed at.
 *  2. the object changed ⇒ a new object, generation back to 0. This is the
 *     RELEASE POINT, and it is checked before the caps because the caps are
 *     about a transcript this round no longer belongs to.
 *  3. context at or above the threshold ⇒ rotate. Reported by the judge itself
 *     at the end of its last round, so it is one round stale by construction.
 *  4. round cap reached ⇒ rotate.
 *  5. otherwise reuse, and count one more round.
 *
 * FAIL-OPEN on a missing reading (rule 3): an unknown context percentage does
 * NOT rotate. The alternative was measured to be worse — rotating whenever the
 * host cannot report usage turns every round into a fresh transcript, which is
 * reuse cancelled rather than reuse bounded. The round cap still bounds it.
 */
export function decideJudgeRotation(input: {
  objectId: string;
  previous?: JudgeLaneRecord;
}): JudgeRotationDecision {
  const objectId = objectIdOf(input.objectId) || NO_JUDGE_OBJECT;
  const previous = input.previous;
  const previousObject = objectIdOf(previous?.objectId);

  if (!previous || !previousObject) {
    return { lane: { objectId, generation: 0 }, rotated: false, reason: "first", roundsInObject: 1 };
  }
  if (previousObject !== objectId) {
    return { lane: { objectId, generation: 0 }, rotated: true, reason: "object-changed", roundsInObject: 1 };
  }

  const generation = count(previous.generation);
  const percent = typeof previous.contextPercent === "number" && Number.isFinite(previous.contextPercent)
    ? previous.contextPercent
    : undefined;
  const rounds = count(previous.roundsInObject);

  if (percent !== undefined && percent >= JUDGE_ROTATION_CONTEXT_PERCENT) {
    return { lane: { objectId, generation: generation + 1 }, rotated: true, reason: "context", roundsInObject: 1 };
  }
  if (rounds >= JUDGE_ROTATION_MAX_ROUNDS) {
    return { lane: { objectId, generation: generation + 1 }, rotated: true, reason: "rounds", roundsInObject: 1 };
  }
  return { lane: { objectId, generation }, rotated: false, reason: "reuse", roundsInObject: rounds + 1 };
}

/**
 * The lane a registry entry records — or `undefined` when it records none.
 *
 * The one place that reads a lane back out of persisted bookkeeping, so every
 * consumer (the id derivation, the dir name, the reclaim sweep's known set)
 * agrees on what a lane-less entry means: no lane, hence the un-suffixed
 * shape, never a guessed `none-g0`.
 */
export function laneOfEntry(entry: JudgeLaneRecord | undefined): JudgeLane | undefined {
  const objectId = objectIdOf(entry?.objectId);
  if (!objectId) return undefined;
  return { objectId, generation: count(entry?.generation) };
}

/**
 * DOES THE JUDGE TAKING THIS ROUND STILL HOLD THE PREVIOUS ROUND'S REASONING?
 *
 * An INCREMENTAL review round is a promise its reader has to be able to keep:
 * "what the last round settled stays settled — spend this round on the
 * increment". A judge whose transcript CONTINUES can keep it: it derived that
 * conclusion itself and still remembers why. A judge starting a FRESH
 * transcript cannot. The carryover hands it the previous verdict, the covered
 * file list and the open findings — but not the reasoning behind any of them,
 * so "carry it forward" degrades into "take it on trust", which is the one
 * thing an independent review must never do.
 *
 * Rotation made that case routine rather than theoretical: the gate itself
 * mints a new transcript mid-task, at {@link JUDGE_ROTATION_CONTEXT_PERCENT}
 * or {@link JUDGE_ROTATION_MAX_ROUNDS}, and the content-side scoping rule
 * (lib/review-scope.ts) had no way to see it happen.
 *
 * TWO FACTS, BOTH REQUIRED:
 *
 *  - the policy REUSED the lane (`reason === "reuse"`). Every other outcome
 *    means a different transcript — `first` included, deliberately: a lane the
 *    registry has no record of is one whose history the gate cannot vouch for,
 *    so a directory that happens to survive under that name does not make it
 *    continuous.
 *  - that lane's transcript actually EXISTS. A reused lane whose previous
 *    round was dispatched and abandoned has nothing to resume.
 *
 * FAIL-SAFE BY CONSTRUCTION: every unknown resolves to `false`, and `false`
 * only ever costs a deeper review. Pure, like everything else here — the
 * caller observes the transcript, this decides what it means.
 */
export function judgeRemembersPreviousRound(input: {
  decision: JudgeRotationDecision;
  /** Does a transcript for THIS round's lane already exist? */
  transcriptExists: boolean;
}): boolean {
  return input.decision.reason === "reuse" && input.transcriptExists === true;
}


/**
 * The sentence a fresh transcript's first round opens with.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY (user, 2026-09-05). It names no mechanism:
 * not why this round starts where it does, not what the gate measured, not
 * that anything was ever carried differently. A judge told it is being managed
 * starts reasoning about the management — budgeting its own reading, hedging a
 * verdict "because context is short", asking for more room — and every one of
 * those is a worse review. What it needs is the one operational fact, which is
 * true of EVERY round and merely load-bearing here: the task text in front of
 * it is the whole of what it can rely on, and anything else has to be read.
 */
const FRESH_CONTEXT_PREAMBLE =
  "你手上的任务书与交接，就是这一轮的全部上下文：下面给出的结论、findings 与增量是权威依据，"
  + "别的事实需要就现在去读代码、git 与文件，不要凭印象补。";

/** The facts a rotated round hands over, when the caller holds them. */
export interface RotationHandoffInput {
  /** Which role the round is for — only a reviewer gets a review carryover. */
  role: string;
  /** The round's task text, as the dispatching path built it. */
  task: string;
  decision: JudgeRotationDecision;
  /** The previous round's recorded verdict, when there is one. */
  settled?: SettledConclusion;
  /** Findings from the previous round that are not closed yet. */
  openFindings?: string[];
  /** The mechanical delta since the settled content. */
  delta?: ReviewDelta;
}

/**
 * The task text a ROTATED round is sent with: {@link FRESH_CONTEXT_PREAMBLE},
 * plus the compressed hand-off that stands in for what the fresh transcript
 * cannot remember. Neither of them names the rotation — see that constant.
 *
 * The hand-off is rendered by `buildReviewCarryover` — never by a second
 * renderer here. Two consequences, both deliberate:
 *
 *  - A task that ALREADY carries the contract block (every reviewer round the
 *    gate prepares does: `formatReviewScopeDirective` renders the same
 *    function) gets the sentence only. A second block would not just duplicate
 *    text — the judge pane reads its round's scope back OUT of this text, and
 *    two blocks would make that read ambiguous.
 *  - A non-reviewer role gets the sentence only, too. An adviser's brief and a
 *    goal audit's carryover are that role's own hand-off, built by their own
 *    modules; a review contract about commits and findings would be the wrong
 *    document handed to the wrong reader.
 *
 * An unrotated round is returned untouched — this is a no-op on the normal path.
 */
export function rotationHandoffTask(input: RotationHandoffInput): string {
  if (!input.decision.rotated) return input.task;
  const carryable = input.role === "reviewer"
    && !input.task.includes(SCOPE_BLOCK_HEADING)
    && (input.settled !== undefined || (input.openFindings?.length ?? 0) > 0);
  if (!carryable) return `${FRESH_CONTEXT_PREAMBLE}\n\n${input.task}`;
  const carryover = buildReviewCarryover({
    kind: "incremental",
    // The reason a reviewer reads is about the WORK, never about the plumbing:
    // this block carries the previous round forward, which is all it needs to
    // know to use it (see FRESH_CONTEXT_PREAMBLE).
    reason: "本轮承接上一轮的结论，下面这块就是交接",
    ...(input.settled === undefined ? {} : { settled: input.settled }),
    openFindings: input.openFindings ?? [],
    ...(input.delta === undefined ? {} : { delta: input.delta }),
    audience: "reviewer",
  });
  return `${FRESH_CONTEXT_PREAMBLE}\n\n${carryover}\n\n${input.task}`;
}
