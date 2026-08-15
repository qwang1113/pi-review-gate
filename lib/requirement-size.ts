/**
 * Oversized-requirement detection — decide whether a session's work should be
 * proposed for `/decompose` (design doc: this repo's
 * `docs/requirement-orchestration.md`; the runtime contract is self-contained
 * in the command prompts and `lib/plan-state.ts`).
 *
 * WHY: the failure this catches is silent. A requirement too big for one
 * session does not announce itself; it degrades — context fills with stale
 * reasoning, scope quietly shrinks, and by the time that is obvious the cheap
 * moment to split has passed. Two checkpoints are cheap and early: the first
 * user message, and the moment the loop goal is approved.
 *
 * DESIGN CONSTRAINTS:
 *  - JUDGEMENT IS THE GATE'S, THE DECISION IS THE USER'S. Nothing here starts
 *    a decomposition. It renders a suggestion the main agent must put to the
 *    user, who answers in one word. A false positive therefore costs a
 *    sentence, not a workflow.
 *  - STRUCTURAL SIGNALS DO NOT DEPEND ON THE MODEL. Exit-criteria count and
 *    touched top-level directories are counted deterministically, so the
 *    feature still works when the classifier is unavailable — that degraded
 *    state is LABELLED, never dressed up as a verdict.
 *  - EVERY SUGGESTION SHOWS ITS EVIDENCE. The injected text names which
 *    threshold fired, so the user can see what the gate is reasoning from
 *    instead of being told "the model thinks this is big".
 *  - ONE ASK PER CHECKPOINT, AND NONE AFTER A NO. Being asked twice about the
 *    same requirement is noise, and noise is how a default-on feature gets
 *    switched off.
 */

/** Exit criteria at or above this count in an approved loop goal ⇒ oversized. */
export const CRITERIA_THRESHOLD = 5;
/** Distinct top-level directories at or above this count ⇒ oversized. */
export const DIRECTORY_THRESHOLD = 3;

/**
 * The model's estimate, as a bucket. A bucket rather than a number because the
 * shared classifier accepts exactly one key with a value from a fixed set
 * (`parseClassifierJson`), and because a model's "7 modules" is false
 * precision anyway.
 */
export const MODULE_BUCKETS = Object.freeze(["1", "2", "3-5", "6+"] as const);
export type ModuleBucket = (typeof MODULE_BUCKETS)[number];

/** Buckets that mean "three or more modules" — the model-side threshold. */
const OVERSIZED_BUCKETS: readonly ModuleBucket[] = Object.freeze(["3-5", "6+"]);

export interface SizeSignals {
  /** Number of exit criteria in the approved loop goal, when there is one. */
  criteriaCount?: number;
  /** Distinct repo top-level directories the requirement names. */
  touchedDirs?: string[];
  /** The classifier's bucket, or undefined when it could not answer. */
  moduleBucket?: ModuleBucket;
  /**
   * True when the classifier WAS consulted and gave no usable answer.
   * Deliberately false when it was never consulted at all (an explicitly set
   * gate mode, a headless run, a resumed session): claiming "unavailable" for
   * a call that was never made would be the same dishonesty this flag exists
   * to prevent.
   */
  classifierUnavailable?: boolean;
}

export interface SizeVerdict {
  /** At least one threshold fired. */
  oversized: boolean;
  /**
   * The model was asked and could not answer, so this verdict rests on
   * structural rules alone (or on nothing at all). Callers MUST surface this —
   * a degraded suggestion that reads like a confident judgement is a lie. A
   * verdict where the classifier was never consulted is NOT degraded: no claim
   * about the model is being made.
   */
  degraded: boolean;
  /** Human-readable evidence, one entry per threshold that fired. */
  reasons: string[];
}

/**
 * Apply the thresholds. Any single one firing is enough: they measure
 * different things (breadth of the contract, breadth of the codebase, depth of
 * the work) and a requirement only has to be big in one dimension to be worth
 * splitting.
 */
export function assessRequirementSize(signals: SizeSignals): SizeVerdict {
  const reasons: string[] = [];

  if (signals.criteriaCount !== undefined && signals.criteriaCount >= CRITERIA_THRESHOLD) {
    reasons.push(
      `the approved loop goal has ${signals.criteriaCount} exit criteria (threshold: ${CRITERIA_THRESHOLD})`,
    );
  }

  const dirs = dedupe(signals.touchedDirs ?? []);
  if (dirs.length >= DIRECTORY_THRESHOLD) {
    reasons.push(
      `the requirement spans ${dirs.length} top-level directories (${dirs.join(", ")}; threshold: ${DIRECTORY_THRESHOLD})`,
    );
  }

  if (signals.moduleBucket && OVERSIZED_BUCKETS.includes(signals.moduleBucket)) {
    reasons.push(`the classifier estimates ${signals.moduleBucket} modules of work (threshold: 3)`);
  }

  return {
    oversized: reasons.length > 0,
    degraded: Boolean(signals.classifierUnavailable),
    reasons,
  };
}

/**
 * Count the exit criteria of a loop goal. Counts only the ordered-list items
 * directly under an "Exit criteria" heading, so a numbered list living in
 * "Non-goals" or in prose cannot inflate the count. Continuation lines of a
 * multi-line criterion are not items and are not counted.
 */
export function countExitCriteria(goalText: string): number {
  const lines = goalText.split(/\r?\n/);
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      inSection = /exit\s+criteria/i.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    if (/^\s{0,3}\d+[.)]\s+\S/.test(line)) count += 1;
  }
  return count;
}

/**
 * Which of the repo's top-level directories does this text actually name?
 *
 * Matching is anchored on the repo's real directory list rather than on a
 * "looks like a path" regex: prose is full of slashes ("and/or", URLs) and of
 * words that happen to be directory names. A directory counts when the text
 * mentions it as a path segment (`lib/`, `./lib`, `lib/foo.ts`) — a bare word
 * does not, or "test" in "let me test that" would count as a directory.
 */
export function detectTouchedDirs(text: string, repoTopLevelDirs: readonly string[]): string[] {
  const found: string[] = [];
  for (const dir of repoTopLevelDirs) {
    const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Preceded by a boundary that is not another path segment, followed by a slash.
    if (new RegExp(`(^|[^\\w/.-])\\.?/?${escaped}/`, "m").test(text)) found.push(dir);
  }
  return found;
}

/** Where the assessment happened — the two checkpoints have different framing. */
export type Checkpoint = "first-message" | "loop-goal";

/**
 * Render the directive injected into the agent's prompt.
 *
 * It is written as an instruction to the agent rather than as a message to the
 * user because the agent is the one who must act: raise it FIRST, then stop.
 * The alternative — the gate talking past the agent straight to the user —
 * leaves the agent free to keep working while the question hangs.
 */
export function buildDecomposeSuggestion(verdict: SizeVerdict, checkpoint: Checkpoint): string {
  const head =
    checkpoint === "first-message"
      ? "## Oversized requirement? (raise this BEFORE starting work)"
      : "## Oversized requirement? (raise this before the first edit)";

  const evidence = verdict.reasons.length
    ? verdict.reasons.map((r) => `- ${r}`).join("\n")
    : "- no structural threshold fired, and the classifier could not be consulted";

  const degradedNote = verdict.degraded
    ? "\n\nDEGRADED SIGNAL: the size classifier was unavailable (timeout or no model), so this " +
      "rests on the structural rules alone" +
      (verdict.reasons.length ? "." : " — which did not fire either, so nothing was actually measured.") +
      " Say so when you raise it; do not present it as a judgement the gate made."
    : "";

  return (
    `${head}\n` +
    "This session's work looks large enough that one session is likely to degrade on it " +
    "(context rot, silent scope reduction, nothing verifiable per piece). Evidence:\n" +
    `${evidence}${degradedNote}\n\n` +
    "REQUIRED: open your very next reply by proposing to start `/decompose` — state the evidence above " +
    "and your own estimate of the module count — then STOP and let the user decide. Do not " +
    "start the work, and do not silently skip this. If the user declines, carry on normally " +
    "and never raise it again this session. (Independently of this suggestion, you may also " +
    "initiate /decompose yourself whenever you detect a complex task — mid-task included — " +
    "always presenting the evidence and waiting for the user's explicit consent first.)"
  );
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
