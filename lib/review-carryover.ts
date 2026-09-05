/**
 * THE INCREMENTAL REVIEW CONTRACT — the one place its wording lives.
 *
 * WHAT THIS IS. Round 1 of a review is full; every later round is handed the
 * previous round's conclusion instead of re-deriving it. That hand-off has a
 * fixed shape, and this module renders it:
 *
 *   1. the DECISION (full or incremental, and why),
 *   2. what the previous round SETTLED,
 *   3. the previous round's findings that must be RE-CHECKED one by one,
 *   4. the DELTA since the settled content, computed mechanically,
 *   5. the consistency-scan and reopen clauses that bound 2–4.
 *
 * WHY IT IS ITS OWN MODULE. The same contract used to be restated in five
 * other places (the reviewer role body, the review-loop skill, the `/review`
 * command prompt, the reviewer's task preamble, the judge protocol). Five
 * copies of a rule are five things to keep true, and the copies had already
 * drifted — one of them still said settled material could be "skipped or
 * shallow-checked", which is not what this contract says. They now carry a
 * summary and a pointer HERE (philosophy three: one authoritative source).
 *
 * TWO ENTRY POINTS, ONE TEXT. `buildReviewCarryover` takes the four facts as
 * EXPLICIT arguments, so any caller holding a verdict + open findings + a
 * delta can render the contract — a transcript-rotation hand-off, for
 * instance, which has no `ReviewScopeDecision` at all.
 * `formatReviewScopeDirective` is the thin adapter for the caller that DOES
 * hold one (the gate's own scoping path). The adapter maps and delegates; it
 * never renders a second copy of the text.
 *
 * BOUNDARY — why this is not merged with the other three carryovers.
 * `lib/loop-goal.ts` (goal pre-audit), `lib/orchestrator-plan-audit.ts` (plan
 * audit) and `lib/adviser-brief.ts` (adviser brief) also carry a previous
 * round forward, and they are NOT the same thing: their input is an audit
 * role's verdict on a DRAFT (a goal, a plan, a question) and their reader is
 * that same auditor deciding whether the draft improved. This module's input
 * is a review round over COMMITTED CODE — a settled tree, a mechanical file
 * delta, findings bound to file:line — and its reader is the reviewer of the
 * next round. Different inputs, different readers; merging them would produce
 * one function with two disjoint halves, not one contract.
 */

import type { ReviewScopeDecision, ReviewScopeKind } from "./review-scope.ts";

/**
 * The two lines that state the decision.
 *
 * They are also the WIRE FORMAT of the full/incremental flag: the judge pane
 * recovers the round's scope by reading them back out of its task text
 * (`parseReviewScopeKind`, lib/judge-inspection.ts), which is the same
 * best-effort channel the commit range already travels on. Exported so the
 * renderer and the parser cannot drift; changing their text is a wire change,
 * not a wording change.
 */
export const SCOPE_MARKER_INCREMENTAL = "- INCREMENTAL.";
export const SCOPE_MARKER_FULL = "- FULL deep review.";

/** The block's first line — how a reader (and a test) recognises the block. */
export const SCOPE_BLOCK_HEADING = "Review scope for this round:";

/**
 * What the PREVIOUS round already concluded, so a re-review can build on it
 * instead of re-deriving it. Carrying the settled conclusion forward is the
 * whole point of an incremental round: without it the reviewer re-litigates
 * questions it already answered, at max thinking, every round.
 */
export interface SettledConclusion {
  /** The verdict that was recorded ("READY" for the tree we build on). */
  verdict: string;
  /** ISO timestamp of that verdict, when known. */
  at?: string;
  /**
   * Review rounds recorded SO FAR — a running count, not the round that
   * produced the verdict (rounds recorded after it are included).
   */
  rounds?: number;
}

/** Who the block is written for. */
export type ScopeAudience = "agent" | "reviewer";

/** The mechanically computed increment since the settled content. */
export interface ReviewDelta {
  /** Files that changed since the settled content. */
  files: string[];
  /** Added + deleted lines across those files, when counted. */
  lines?: number;
  /** Files the settled review itself covered (named in the SETTLED line). */
  reviewedFiles?: string[];
}

/**
 * The four facts the contract is made of, as explicit inputs.
 *
 * Deliberately NOT a `ReviewScopeDecision`: a caller that only has a verdict,
 * a findings list and a delta (a hand-off built when a judge's transcript is
 * rotated, for example) must be able to render this contract without
 * inventing a decision object it does not have.
 */
export interface ReviewCarryoverInput {
  /** ① Full or incremental — the decision this round runs under. */
  kind: ReviewScopeKind;
  /** ① One sentence saying why the decision came out that way. */
  reason: string;
  /** ② What the previous round settled (absent ⇒ nothing is settled yet). */
  settled?: SettledConclusion;
  /** ③ Previous-round findings that must be re-checked one by one. */
  openFindings?: string[];
  /** ④ The increment since the settled content (absent ⇒ not computed). */
  delta?: ReviewDelta;
  /** Whose voice the two addressed sentences are written in. */
  audience?: ScopeAudience;
}

/** How many reviewed files the SETTLED line names before it elides. */
const SETTLED_FILE_LIST_MAX = 20;

/**
 * Render the contract from the four facts.
 *
 * It never says "skip" anything: the reader keeps the whole diff and the same
 * verdict authority, it is only told where the new risk is — and it is told
 * explicitly that deciding what the increment AFFECTS is its own job, because
 * the gate cannot compute that and must not appear to have done so.
 */
export function buildReviewCarryover(input: ReviewCarryoverInput): string {
  const audience = input.audience ?? "agent";
  const incremental = input.kind === "incremental";
  const lines: string[] = [SCOPE_BLOCK_HEADING];

  // ① THE DECISION.
  lines.push(`${incremental ? SCOPE_MARKER_INCREMENTAL : SCOPE_MARKER_FULL} ${input.reason}.`);

  // ② WHAT THE PREVIOUS ROUND SETTLED. Stated plainly, and only on an
  // incremental round: on a full round nothing is being carried forward, so
  // announcing a settled conclusion there would invite exactly the economy
  // the escalation just refused.
  if (incremental && input.settled) {
    const settled = input.settled;
    const reviewedFiles = input.delta?.reviewedFiles ?? [];
    const covered = reviewedFiles.length
      ? `${reviewedFiles.length} file(s): ${reviewedFiles.slice(0, SETTLED_FILE_LIST_MAX).join(", ")}` +
        (reviewedFiles.length > SETTLED_FILE_LIST_MAX ? ", …" : "")
      : "the change as it stood then";
    lines.push(
      `- SETTLED last round — verdict ${settled.verdict}` +
        (settled.rounds ? `, ${settled.rounds} round(s) recorded so far` : "") +
        (settled.at ? ` (${settled.at})` : "") +
        `, covering ${covered}.`,
      `- Carry that conclusion forward: what it settled and this round's increment neither touched nor ` +
        `affected stays settled. Report it as MET/unchanged instead of re-deriving it, and spend the round ` +
        `on the increment and on the findings listed below.`,
    );
  }

  // ③ THE PREVIOUS ROUND'S FINDINGS, one by one.
  const openFindings = input.openFindings ?? [];
  if (openFindings.length) {
    lines.push(
      `- Findings from the previous round that MUST be re-checked one by one (do not take the fix on trust): ` +
        openFindings.map((f) => `"${f}"`).join("; "),
    );
  }

  // ④ THE MECHANICAL DELTA — stated as what it is (a computed diff against
  // the settled content), so nobody reads it as a reviewer's own judgement of
  // what matters this round.
  if (incremental && input.delta && input.delta.files.length) {
    const delta = input.delta;
    lines.push(
      `- This round's increment (deep-review these), computed mechanically as the diff between the content ` +
        `the settled verdict covered and what this round judges — ` +
        `${delta.files.length} file(s)${delta.lines === undefined ? "" : ` / ${delta.lines} line(s)`}: ` +
        `${delta.files.join(", ")}.`,
    );
  }

  // ⑤ THE CLAUSES THAT BOUND ②–④.
  if (incremental) {
    lines.push(
      `- Outside the increment: everything the increment neither TOUCHED nor AFFECTED gets a consistency ` +
        `scan, not a re-derivation — and not a skip either. Deciding what the increment affects is YOUR ` +
        `job: the gate computed the file list, it did not compute the blast radius and has drawn you no ` +
        `exemption. A renamed symbol, a changed invariant, a doc that now describes the old behaviour — ` +
        `each is a finding like any other, even when it sits in a file the increment never opened.`,
      `- Reopening is always allowed: if you find real evidence a settled conclusion was WRONG, say so and ` +
        `reopen it. Carrying it forward is an economy, not a bar on your authority — "the last round said ` +
        `so" is never a reason to look away from something you can see.`,
      `- ${audience === "reviewer" ? "You still have the FULL diff as context" : "Hand the reviewer the FULL diff as context anyway"} — an incremental round narrows what must be ` +
        `re-derived, never what may be looked at, and never what the verdict answers for.`,
      `- If this block looks wrong — it claims files were reviewed that ${audience === "reviewer" ? "you can" : "the reviewer can"} see were not, or the ` +
        `increment does not match the diff — ignore it, review the change in full, and say so in the verdict.`,
    );
  }
  return lines.join("\n");
}

/**
 * The adapter for the caller that holds a `ReviewScopeDecision`.
 *
 * TWO AUDIENCES, ONE SOURCE. The gate cannot address a subagent directly, so
 * this block was originally written as an instruction to the AGENT (the
 * turn-end status text, which the agent then passes on). It is also injected
 * verbatim into the reviewer's OWN task text by `prepare_review`, where
 * second-person phrasing about "the reviewer" would read as an instruction
 * about somebody else. `audience` switches only those sentences — the
 * decision, the increment and the findings list stay identical, because a
 * second copy of this text is exactly how the two surfaces would drift apart.
 */
export function formatReviewScopeDirective(
  decision: ReviewScopeDecision,
  openFindings: string[],
  settled?: SettledConclusion,
  audience: ScopeAudience = "agent",
): string {
  return buildReviewCarryover({
    kind: decision.scope,
    reason: decision.reason,
    ...(settled === undefined ? {} : { settled }),
    openFindings,
    delta: {
      files: decision.changedFiles,
      lines: decision.changedLines,
      reviewedFiles: decision.reviewedFiles,
    },
    audience,
  });
}
