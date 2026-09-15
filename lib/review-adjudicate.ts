/**
 * Reviewer verdict adjudication over a STRUCTURED conclusion.
 *
 * WHY THIS MODULE EXISTS. A judge concludes through `judge_conclude` with
 * structured fields, and those fields now travel to the opener inside the
 * channel `report` record itself. Until 2026-09-04 the gate serialised them
 * into a ```json fence and parsed them back out (`lib/verdict-parse.ts`), so
 * the parser was the only thing that also OWNED the reviewer's adjudication
 * rules. Deleting the round trip (philosophy three — one implementation) would
 * have deleted those rules with it, so they moved HERE, verbatim in behaviour:
 *
 *  1. a READY carrying an unresolved P0/P1 finding is contradictory → BLOCKED;
 *  2. `findingsTotal` — how many findings the round reported;
 *  3. `findingFingerprints` — the deliberately COARSE per-finding key
 *     (`file # line÷10 # first 80 chars of issue`) that lets the same problem
 *     match itself ACROSS rounds while the reviewer rewords it or it drifts a
 *     few lines. `lib/gate-state.ts`'s `isPlateaued` consumes them.
 *
 * The shape mirrors `adjudicateGoalAudit` / `adjudicatePlanAudit`
 * (lib/judge-lifecycle.ts): a pure function from one round's reported facts to
 * the verdict the gate records. Everything the OPENER owns — the STALE check,
 * the tree binding, the cwd comparison — stays with the opener; this module
 * never reads a file and never decides who may ship.
 *
 * The exact per-finding identity the old fence parser also carried
 * (`findingIdentities`) is gone with the round trip: it existed only to
 * recognise the SAME finding repeated in two fences of one output, and one
 * structured conclude call cannot repeat itself.
 */

import type { DocSyncAttestation, GateVerdict } from "./gate-state.ts";
import { DOC_SYNC_ATTESTATIONS } from "./gate-state.ts";
import { isBlockingSeverity } from "./judge-lifecycle.ts";

/** One finding exactly as the judge concluded it — never a serialized string. */
export interface ReviewFinding {
  severity: string;
  file?: string | undefined;
  line?: number | undefined;
  issue: string;
  /**
   * Where to look. OPTIONAL on purpose (user decision D6, 2026-09-04): for many
   * findings the evidence IS `file:line`, and making it mandatory only forces
   * filler prose. The judge prompt asks for it when there is something to give;
   * nothing validates it.
   */
  evidence?: string | undefined;
}

/** What a judge round concluded, as the channel record carries it. */
export interface StructuredConclusion {
  verdict: Exclude<GateVerdict, "PENDING">;
  findings: readonly ReviewFinding[];
  /** The judge's own `pwd`, verbatim — self-reported, weighed by the opener. */
  cwd?: string | undefined;
  /** Code↔doc attestation; anything outside the whitelist is treated as absent. */
  docSync?: string | undefined;
}

/** The gate's own reading of one reviewer round. */
export interface AdjudicatedReview {
  verdict: Exclude<GateVerdict, "PENDING">;
  findingsTotal: number;
  findingFingerprints: string[];
  docSync?: DocSyncAttestation | undefined;
  cwd?: string | undefined;
}

/**
 * Normalize a verdict word off a channel report, or `undefined` when it is not
 * one the gate recognises.
 *
 * `judge_conclude` already constrains its own parameter, so this is the
 * FAIL-CLOSED edge for everything else: a report written by an older build, a
 * hand-edited channel file, a record whose verdict is missing. Nothing is
 * salvaged and nothing is guessed — an unrecognised verdict records nothing,
 * which leaves the gate PENDING rather than open.
 */
export function normalizeConcludedVerdict(raw: string | undefined): Exclude<GateVerdict, "PENDING"> | undefined {
  const up = (raw ?? "").trim().toUpperCase();
  if (up === "READY" || up === "BLOCKED" || up === "NEEDS_HUMAN") return up;
  return undefined;
}

/**
 * The COARSE cross-round key for one finding, or undefined when the finding
 * carries neither a file nor an issue (nothing to look it up by).
 *
 * Coarse on purpose: the line is bucketed by ten and the issue truncated at 80
 * characters, so a finding still matches itself next round after a reword or a
 * small drift. It is NOT an identity — two genuinely different findings can
 * collide, which is why nothing decides "same defect" on it.
 */
export function findingFingerprint(finding: ReviewFinding): string | undefined {
  const file = typeof finding.file === "string" ? finding.file : "";
  const issue = typeof finding.issue === "string" ? finding.issue : "";
  if (!file && !issue) return undefined;
  const line = typeof finding.line === "number" ? Math.floor(finding.line / 10) : "";
  return `${file}#${line}#${issue.slice(0, 80)}`;
}

/**
 * Adjudicate one reviewer round. Tighten-only: this can withhold a READY, it
 * can never grant one.
 */
/**
 * Does a READY still owe a full-lane verification? (B1, 2026-09-10)
 *
 * `judge_submit` starts the full precommit BESIDE the chain instead of in
 * front of it — the reviewer judges an immutable commit range, so only the
 * checkpoint has to precede the dispatch, and the agent gets back the 33s it
 * used to spend blocked. That means a checkpoint can land while its content is
 * still being verified, and this is the place that refuses a READY on content
 * which never passed it: without it, a round dispatched beside a failing suite
 * would record a verdict nothing can ship — while LOOKING verified.
 *
 * TIGHTEN-ONLY, like the stale-target and cwd checks beside it: this can
 * withhold a READY, never grant one. `/gate-bypass` is the user's own
 * authorization and outranks it, exactly as it does the checkpoint gate.
 *
 * THE TREE, NOT JUST THE VERDICT (2026-09-14). The verdict alone is a LIVE
 * binding, and the session's own edits invalidate it on purpose
 * (`invalidateBindings`: PASS → NOT_RUN) — so an agent doing the documented
 * thing (keep editing while the review runs) turned a genuine READY into
 * BLOCKED/UNVERIFIED, with a message telling it to fix a precommit that had
 * never failed. The question this function is really asking is "does THIS
 * round's content have a full-lane PASS", and that is answerable without the
 * live binding: `GateState.precommit.lastFullPassTree` keeps the tree a full
 * lane passed (a git tree OID is a content identity, so it does not expire),
 * and the round's own tree was registered at prepare time. Either source
 * answers yes ⇒ verified. Both unknown ⇒ the live verdict decides, exactly as
 * before.
 *
 * PURE, so the rule is pinned without building a session.
 */
export function readyLacksVerification(args: {
  precommitVerdict: string;
  /** `precommit.lastFullPassTree` — the tree a full lane passed, if one is on record. */
  lastFullPassTree?: string | undefined;
  /** The tree this round judged (the prepared review target's tree). */
  reviewedTree?: string | undefined;
  bypassActive: boolean;
}): boolean {
  if (args.bypassActive) return false;
  if (args.precommitVerdict === "PASS") return false;
  const recorded = args.lastFullPassTree;
  const reviewed = args.reviewedTree;
  // Both sides must be known: an unknown tree proves nothing, and the
  // direction is fail-closed (withhold).
  return !(recorded !== undefined && recorded !== "" && reviewed !== undefined && reviewed !== "" &&
    recorded === reviewed);
}

/**
 * WHY A READY IS BEING WITHHELD — and the reason decides whether the gate
 * REFUSES the round or merely HOLDS it (2026-09-15).
 *
 * Tighten-only either way: a withheld READY is never recorded as READY. What
 * the reason changes is what the AGENT is told to do next.
 *
 *   - `blocking-finding`, `stale` and `cwd-mismatch` are facts about the WORK.
 *     Waiting changes nothing, so the round is refused (BLOCKED) and the agent
 *     fixes it, re-bases, or re-reports.
 *   - `unverified` is a fact about TIME. `judge_submit` runs the full precommit
 *     BESIDE the review (B1, 2026-09-10), so a fast reviewer can conclude
 *     before the lane lands — measured on this repository (PR #62, round 4):
 *     a three-line incremental round concluded in 16s against a 34s lane,
 *     seven seconds short. Refusing there told the agent to "fix ALL findings"
 *     on a round that had none, and its only way forward was a whole extra
 *     review of byte-identical content; the lane PASSed seven seconds later
 *     with nobody to revisit it. So this ONE reason holds the conclusion
 *     instead of refusing it (lib/gate-state.ts, `PendingReadyReview`), and the
 *     lane's own landing replays it through the normal recorder.
 *   - `unverified-idle` is the SAME fact with nobody left to act on it: the
 *     content has no full-lane PASS and NO lane is running that could land on
 *     it. Holding here would park the round forever — the only thing that
 *     clears or replays a parked conclusion is that lane's own landing — and
 *     the reply would tell the agent not to re-submit while nothing was ever
 *     going to arrive. So it is REFUSED like the other three (round-1 P1,
 *     2026-09-15).
 *
 * ORDER IS THE CONTRACT. A round that is BOTH stale and unverified is refused,
 * not held: the checkpoint it judged is no longer HEAD, so a PASS on its tree
 * would bind a READY to content nobody is looking at any more. Same for a
 * READY that contradicts itself by carrying an open P0/P1.
 */
export type ReadyWithholding =
  | "none"
  | "unverified"
  | "unverified-idle"
  | "stale"
  | "cwd-mismatch"
  | "blocking-finding";

export function classifyReadyWithholding(input: {
  /** The verdict the judge concluded, BEFORE adjudication. */
  concluded: string;
  /**
   * The ADJUDICATOR's own reading: a READY carrying an open P0/P1 is
   * contradictory, so adjudication turns it BLOCKED.
   *
   * A boolean and not the adjudicated verdict WORD, because the recorder
   * overwrites that word with the three binding checks below — passing it here
   * would make every one of those refusals look like a contradiction on the
   * findings, which is exactly the misclassification this signature prevents
   * (caught by test/verdict-recording.test.ts while this was being written).
   */
  blockingFinding: boolean;
  /** HEAD moved past the commit this round was prepared for. */
  staleTarget: boolean;
  /** The round's content has no full-lane PASS on record. */
  lacksVerification: boolean;
  /**
   * Is a full lane running RIGHT NOW for this repo — i.e. is there something
   * whose landing could still replay (or clear) a parked conclusion?
   *
   * This is what keeps a hold from becoming a dead end (round-1 P1): the ONLY
   * things that revive a parked READY are the lane's own completion callback
   * and the next round's prepare, so holding when neither is coming parks the
   * round forever — while the reply tells the agent not to re-submit.
   */
  laneStillRunning: boolean;
  /** The verdict's `cwd` is not the repo this round was prepared for. */
  cwdMismatch: boolean;
}): ReadyWithholding {
  if (input.concluded !== "READY") return "none";
  if (input.blockingFinding) return "blocking-finding";
  if (input.staleTarget) return "stale";
  if (input.lacksVerification) return input.laneStillRunning ? "unverified" : "unverified-idle";
  if (input.cwdMismatch) return "cwd-mismatch";
  return "none";
}

/**
 * WHAT THE LANE'S OWN LANDING DOES TO A PARKED CONCLUSION (2026-09-15).
 *
 * Three outcomes, and each one is a fact about TREES rather than about the
 * passage of time:
 *
 *   - `none` — nothing is parked, or a PASS covered different content than the
 *     parked round judged (the session edited while the lane ran). The parked
 *     conclusion stays where it is: its content is still unverified, and the
 *     next lane is the one that will settle it.
 *   - `clear` — the lane came back with anything but PASS. The content the
 *     reviewer approved just failed its full lane, so there is nothing left to
 *     replay, and the failure channel is already telling the agent why — in the
 *     language of verification, not of findings.
 *   - `replay` — a PASS on exactly the parked tree, while the gate's CURRENT
 *     review target is still that same round. Only here does the parked
 *     conclusion become the verdict it always was.
 *
 * ALL THREE IDS MUST AGREE FOR `replay`, and an absent or empty one on ANY of
 * them is never a match: an unknown tree is not evidence that two trees are
 * the same, and replaying onto a round that has moved on would record a READY
 * nobody is looking at.
 */
export type ParkedReadyFate = "none" | "clear" | "replay";

export function parkedReadyFate(args: {
  /** `pendingReady.tree`, when something is parked. */
  parkedTree: string | undefined;
  /** What the lane that just landed returned (`PASS`, `FAIL`, …). */
  laneVerdict: string;
  /** `precommit.lastFullPassTree` after this lane landed. */
  coveredTree: string | undefined;
  /** The tree the gate's current review target holds. */
  currentTargetTree: string | undefined;
}): ParkedReadyFate {
  const parked = args.parkedTree;
  if (parked === undefined || parked === "") return "none";
  if (args.laneVerdict !== "PASS") return "clear";
  return args.coveredTree === parked && args.currentTargetTree === parked ? "replay" : "none";
}

export function adjudicateReviewConclusion(input: StructuredConclusion): AdjudicatedReview {
  const findings = input.findings ?? [];
  // Rule 1 — a READY that ships with an open P0/P1 contradicts itself.
  const hasBlocking = findings.some((f) => isBlockingSeverity(f.severity));
  const verdict = input.verdict === "READY" && hasBlocking ? "BLOCKED" : input.verdict;
  // Rule 3 — one fingerprint per finding, in order, and NOT deduplicated.
  //
  // The old fence parser deduplicated only when it MERGED two fences of one
  // output (the same finding printed twice by a reviewer that repeated its
  // verdict); within a single fence it kept one entry per finding. A round is
  // one structured call now, so it is exactly that within-one-fence case —
  // deduplicating here would be a NEW behaviour, and one that reaches a real
  // decision: `isPlateaued` (lib/gate-state.ts) compares consecutive rounds'
  // fingerprint sets and their sizes, so silently collapsing two same-bucket
  // findings into one can flip a plateau verdict.
  const fingerprints: string[] = [];
  for (const f of findings) {
    const fp = findingFingerprint(f);
    if (fp !== undefined) fingerprints.push(fp);
  }
  const docSyncRaw = typeof input.docSync === "string" ? input.docSync.trim().toUpperCase() : "";
  const docSync = DOC_SYNC_ATTESTATIONS.has(docSyncRaw) ? (docSyncRaw as DocSyncAttestation) : undefined;
  const cwdRaw = typeof input.cwd === "string" ? input.cwd.trim() : "";
  return {
    verdict,
    // Rule 2 — the count is the array's length; there is no self-reported
    // total to sanitize anymore (the judge cannot claim a number it did not
    // also enumerate).
    findingsTotal: findings.length,
    findingFingerprints: fingerprints,
    ...(docSync === undefined ? {} : { docSync }),
    ...(cwdRaw === "" ? {} : { cwd: cwdRaw }),
  };
}

/**
 * The per-FILE view the polish gate counts (`lib/polish-gate.ts`): severity
 * plus a non-empty file. Findings with no file cannot feed a file streak and
 * are dropped, exactly as the old per-file fence parser dropped them.
 */
export function fileFindingsFrom(
  findings: readonly ReviewFinding[],
): Array<{ severity: string; file: string }> {
  const out: Array<{ severity: string; file: string }> = [];
  for (const f of findings) {
    const file = typeof f.file === "string" ? f.file.trim() : "";
    if (!file) continue;
    if (typeof f.severity !== "string" || f.severity.trim() === "") continue;
    out.push({ severity: f.severity, file });
  }
  return out;
}

/**
 * The severity+issue view the goal / plan audits record and carry over
 * (`adjudicateGoalAudit`, `adjudicatePlanAudit`): the objections verbatim, so
 * a re-audit can judge whether each was actually addressed.
 */
export function severityFindingsFrom(
  findings: readonly ReviewFinding[],
): Array<{ severity: string; issue: string }> {
  const out: Array<{ severity: string; issue: string }> = [];
  for (const f of findings) {
    if (typeof f.issue !== "string" || f.issue === "") continue;
    out.push({
      severity: typeof f.severity === "string" && f.severity !== "" ? f.severity : "P2",
      issue: f.issue,
    });
  }
  return out;
}
