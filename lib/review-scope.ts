/**
 * Incremental review scoping.
 *
 * PROBLEM. Every edit invalidates the READY binding, so the next round asks
 * for a brand-new review — including the round where the only change was a
 * typo fix in a comment. The reviewer then re-reads the entire diff at max
 * thinking to re-derive a verdict it already gave, which is the single most
 * expensive step of a loop round.
 *
 * WHAT THIS DOES. The gate remembers the tree the last READY review was bound
 * to. When a new round starts it computes the INCREMENT since then and hands
 * the reviewer three explicit facts: what was already reviewed, what is new
 * this round, and which findings from last round must be re-checked one by
 * one. The reviewer still receives the complete diff as context — narrowing
 * happens in what it must DEEP-read, not in what it may look at.
 *
 * WHY THERE IS AN ESCALATION THRESHOLD. Incremental reading is only safe while
 * the increment is small enough that cross-file inconsistencies cannot hide in
 * it. Past that — or when the increment touches files the previous review
 * never looked at — the saving is not worth the blind spot, so the scope
 * escalates back to a full deep review. Both limits are deliberately low: this
 * is an optimization, and an optimization that has to be right must give up
 * early.
 *
 * FAIL-SAFE. Any missing input (no previous READY tree, unreadable git, an
 * unparseable diffstat) yields `full`. Incremental is never the default and is
 * never inferred — it is granted only when every precondition is present.
 */

/** Files in the increment beyond which the round is deep-reviewed in full. */
export const INCREMENT_MAX_FILES = 20;

/** Changed lines (added + deleted) beyond which the round escalates to full. */
export const INCREMENT_MAX_LINES = 500;

export type ReviewScopeKind = "full" | "incremental";

export interface ReviewScopeDecision {
  scope: ReviewScopeKind;
  /** Files changed since the last READY tree (empty when unknown). */
  changedFiles: string[];
  /** Added + deleted lines since the last READY tree. */
  changedLines: number;
  /**
   * Files in the increment that the previous review never saw. Non-empty
   * forces `full`: "already reviewed" cannot be claimed for them.
   */
  unreviewedFiles: string[];
  /** Files the previous approved review covered (empty when unknown). */
  reviewedFiles: string[];
  /** One human-readable sentence explaining the decision. */
  reason: string;
}

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

export interface IncrementInput {
  /** Tree OID the last READY review was bound to, if any. */
  baseTree?: string;
  /** Files + line counts between that tree and the current worktree. */
  changedFiles?: string[];
  changedLines?: number;
  /** Files the previous review's diff covered (its own scope). */
  previouslyReviewedFiles?: string[];
}

/**
 * Decide how much of this round the reviewer must deep-read.
 *
 * Pure so the escalation rules can be tested exhaustively — the gate calls it
 * with data it collected from git.
 */
export function decideReviewScope(input: IncrementInput): ReviewScopeDecision {
  const changedFiles = input.changedFiles ?? [];
  const changedLines = input.changedLines ?? 0;

  const reviewedFiles = input.previouslyReviewedFiles ?? [];

  const full = (reason: string): ReviewScopeDecision => {
    const seen = new Set(reviewedFiles);
    return {
      scope: "full",
      changedFiles,
      changedLines,
      unreviewedFiles: changedFiles.filter((f) => !seen.has(f)),
      reviewedFiles,
      reason,
    };
  };

  if (!input.baseTree) {
    return full("no previous READY review to build on — full deep review");
  }
  if (!input.changedFiles) {
    return full("the increment could not be computed (git unreadable) — full deep review");
  }
  if (changedFiles.length === 0) {
    return full("nothing changed since the last READY review — re-review the whole change");
  }
  if (changedFiles.length > INCREMENT_MAX_FILES) {
    return full(
      `increment spans ${changedFiles.length} files (> ${INCREMENT_MAX_FILES}) — full deep review`,
    );
  }
  if (changedLines > INCREMENT_MAX_LINES) {
    return full(
      `increment changes ${changedLines} lines (> ${INCREMENT_MAX_LINES}) — full deep review`,
    );
  }

  // A file the previous review never covered has no "already reviewed" status
  // to inherit, so the increment cannot stand on its own.
  const seen = new Set(reviewedFiles);
  const unreviewedFiles = changedFiles.filter((f) => !seen.has(f));
  if (unreviewedFiles.length > 0) {
    return {
      scope: "full",
      changedFiles,
      changedLines,
      unreviewedFiles,
      reviewedFiles,
      reason:
        `increment touches ${unreviewedFiles.length} file(s) the previous review never covered ` +
        `(${unreviewedFiles.slice(0, 5).join(", ")}${unreviewedFiles.length > 5 ? ", …" : ""}) — full deep review`,
    };
  }

  return {
    scope: "incremental",
    changedFiles,
    changedLines,
    unreviewedFiles: [],
    reviewedFiles,
    reason:
      `increment is ${changedFiles.length} file(s) / ${changedLines} line(s) inside already-reviewed files ` +
      `— deep-read the increment, re-check last round's findings, scan the rest for consistency`,
  };
}

/** Who the scope block is written for. */
export type ScopeAudience = "agent" | "reviewer";

/**
 * The scope block that says exactly what this round may lean on.
 *
 * TWO AUDIENCES, ONE SOURCE. The gate cannot address a subagent directly, so
 * this block was originally written as an instruction to the AGENT (the
 * turn-end status text, which the agent then passes on). It is now also
 * injected verbatim into the reviewer's OWN task text by `prepare_review`,
 * where second-person phrasing about "the reviewer" would read as an
 * instruction about somebody else. `audience` switches only those sentences —
 * the decision, the increment and the findings list stay identical, because a
 * second copy of this text is exactly how the two surfaces would drift apart.
 *
 * It never says "skip" anything: the reader keeps the whole diff and the same
 * verdict authority, it is only told where the new risk is.
 */
export function formatReviewScopeDirective(
  decision: ReviewScopeDecision,
  openFindings: string[],
  settled?: SettledConclusion,
  audience: ScopeAudience = "agent",
): string {
  const lines: string[] = ["Review scope for this round:"];
  // Direct addresses, worded for whoever reads the block. The agent passes it
  // on ("Hand the reviewer…"); the reviewer reads it as instructions to
  // itself ("You…"). Everything else is shared verbatim.
  // The one sentence that MUST switch: it names the reader as a THIRD person
  // for the agent and a SECOND person for the reviewer. Everything else reads
  // correctly for both — "your authority" is the reader's own either way.
  if (decision.scope === "incremental") {
    lines.push(
      `- INCREMENTAL. ${decision.reason}.`,
      `- Already reviewed and unchanged since the last READY verdict: everything outside the increment. ` +
        `Give it a consistency scan, not a re-derivation.`,
      `- This round's increment (deep-review these): ${decision.changedFiles.join(", ")}.`,
      `- ${audience === "reviewer" ? "You still have the FULL diff as context" : "Hand the reviewer the FULL diff as context anyway"} — an incremental round narrows what must be ` +
        `re-derived, never what may be looked at.`,
    );
    // The settled conclusion is what makes a re-review cheap: state plainly
    // that it stands, so the reviewer builds on it instead of re-arguing it.
    if (settled) {
      const covered = decision.reviewedFiles.length
        ? `${decision.reviewedFiles.length} file(s): ${decision.reviewedFiles.slice(0, 20).join(", ")}` +
          (decision.reviewedFiles.length > 20 ? ", …" : "")
        : "the change as it stood then";
      lines.push(
        `- SETTLED last round — verdict ${settled.verdict}` +
          (settled.rounds ? `, ${settled.rounds} round(s) recorded so far` : "") +
          (settled.at ? ` (${settled.at})` : "") +
          `, covering ${covered}.`,
        `- Carry that conclusion forward: what it settled and the increment did not touch stays settled. ` +
          `Do not re-derive or re-litigate it — report it as MET/unchanged and spend the round on the increment ` +
          `and on the previous findings listed below. If you find real evidence the settled conclusion was WRONG, ` +
          `say so and reopen it: carrying it forward is an economy, not a bar on your authority.`,
      );
    }
  } else {
    lines.push(`- FULL deep review. ${decision.reason}.`);
  }
  if (openFindings.length) {
    lines.push(
      `- Findings from the previous round that MUST be re-checked one by one (do not take the fix on trust): ` +
        openFindings.map((f) => `"${f}"`).join("; "),
    );
  }
  return lines.join("\n");
}
