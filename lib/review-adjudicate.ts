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

import type { DocSyncAttestation, GateVerdict } from "./gate-state-records.ts";
import { DOC_SYNC_ATTESTATIONS } from "./gate-state-records.ts";
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
  /**
   * How many P0/P1 findings this adjudication EXCLUDED because they landed on
   * files the user exempted (`ScopeExemption`). Zero in the ordinary case; a
   * non-zero count is what makes "this READY leaned on a scope limit" sayable
   * in the round's receipt instead of invisible.
   */
  exemptedBlocking: number;
}

/**
 * A user-granted scope exemption, as the round's chain has it.
 *
 * WHY THIS REACHES THE ADJUDICATOR AT ALL (2026-09-19). `request_scope_limit`
 * promises the USER that the gate "covers only this session's edits", and that
 * promise lived entirely in a sentence handed to the AGENT: the reviewer
 * received the unchanged `baseline..HEAD` plus its own standing rule "a P0/P1
 * blocks", so a round on a branch carrying someone else's 65-file diff came
 * back BLOCKED on findings the session could not legally fix. Measured in
 * prime: t2-auth-path-e2e AND t3-report-update both deadlocked on
 * `declare_done` that way — and t3's own reviewer wrote that the finding
 * "should not be a blocker under this round's scope limit" before concluding
 * BLOCKED anyway.
 *
 * The exemption changes WHICH findings Rule 1 counts. It never invents a
 * finding, never edits one, and cannot touch a file the session itself
 * changed: the edit handler moves every touched path back OUT of the exempt
 * snapshot (`extensions/review-gate.ts`), so "whoever changed it owns it"
 * needs no second rule here.
 */
export interface ScopeExemption {
  /**
   * Repo-relative paths the user exempted
   * (`GateState.scopeLimit.preexistingFiles`).
   */
  exemptFiles: readonly string[];
}

/**
 * Does this finding block the round, once the user's exemption is applied?
 *
 * TWO FAIL-CLOSED EDGES, and both matter more than the happy path: with no
 * exemption in force every P0/P1 blocks exactly as it always did, and a
 * finding whose `file` is missing or unreadable is treated as IN SCOPE — a
 * finding the reviewer could not locate is not a finding on a file the user
 * excused. Matching is exact: a path that does not match the snapshot byte for
 * byte stays blocking.
 */
function blocksTheRound(finding: ReviewFinding, exempt: ReadonlySet<string> | undefined): boolean {
  if (!isBlockingSeverity(finding.severity)) return false;
  if (exempt === undefined) return true;
  const file = typeof finding.file === "string" ? finding.file.trim() : "";
  if (file === "") return true;
  return !exempt.has(file);
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
  // The live binding still decides when there is one (`precommit: PASS` is the
  // pre-tree-record behaviour, kept as the fallback); everything else is the
  // shared rule below — never a second reading of bypass or of the trees.
  if (args.precommitVerdict === "PASS") return false;
  return !laneVerifiesTree({
    tree: args.reviewedTree,
    coveredTree: args.lastFullPassTree,
    bypassActive: args.bypassActive,
  });
}

/**
 * DID A FULL LANE VERIFY THIS TREE? — the ONE answer, shared by both halves of
 * the replay question.
 *
 * TWO WRITERS, ONE FACT (quality round P1, 2026-09-16). This question used to
 * be answered twice — once for the RECORDED round (`readyLacksVerification`)
 * and again for a PARKED one (`parkedLaneHalf`) — and two implementations of
 * one rule disagree the moment either learns something new. Measured: the
 * recorder was taught that a `/gate-bypass` session never gets a full lane (so
 * "no lane ran" cannot mean "unverified"), and the parked half was not — so a
 * bypassed round that parked its READY on a quality verdict came back through
 * the other rule as `veto`, was cleared with "re-submit", and re-submitted
 * into the identical park. The bypass branch and the tree comparison live HERE
 * now, and both callers read them.
 *
 * `bypassActive` IS “NO LANE IS OWED”, not “a bypass was granted” (quality
 * round P1, 2026-09-22): a round whose precommit stage the user switched OFF
 * gets no lane either, so the extension composes the two into this one flag
 * (`laneVerificationWaived`) and BOTH call sites read that composition. Feeding
 * them separately is the same failure the paragraph above describes: the
 * recorder would withhold every READY of that combination as `unverified-idle`
 * while the parked half disagreed.
 *
 * Fail-closed by construction: every unknown proves nothing.
 *  - a bypass means no lane is OWED at all, so nothing is missing;
 *  - an unknown tree on either side is never a match.
 */
export function laneVerifiesTree(args: {
  /** The tree whose verification is in question — the round's reviewed tree. */
  tree: string | undefined;
  /** `precommit.lastFullPassTree` — the tree a full lane passed, if one is on record. */
  coveredTree?: string | undefined;
  /** The user's own `/gate-bypass` grant — no lane is owed while it stands. */
  bypassActive: boolean;
}): boolean {
  // THE FLAG MEANS “NO LANE IS OWED” — the caller composes a bypass and the
  // switched-off precommit stage into it (extension's `laneVerificationWaived`),
  // so reading it as “a bypass was granted” here would be a second vocabulary.
  if (args.bypassActive) return true;
  const tree = args.tree;
  if (tree === undefined || tree === "") return false;
  return args.coveredTree === tree;
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
 *   - `none` — nothing is parked. (And ONLY that: a lane that has landed has
 *     nothing left to come back with, so a PARKED conclusion it did not replay
 *     is always retired — see `clear`.)
 *   - `clear` — the parked round is retired. Three ways to get here, and they
 *     share one reason: the lane has landed, so nothing is coming back for this
 *     conclusion any more.
 *       · the lane came back with anything but PASS — the content the reviewer
 *         approved just failed its full lane;
 *       · the PASS covered a DIFFERENT tree than the parked round judged (the
 *         lane captured the worktree before the round's checkpoint, or the
 *         session re-submitted in between) — the parked round is not the
 *         content that was verified;
 *       · the gate's current review target is another round — a newer prepare
 *         replaced it.
 *
 *     NOTE WHAT IS **NOT** ON THAT LIST: editing the worktree while the lane
 *     runs. It changes none of the three trees (the parked round's is the
 *     committed one, the lane's was captured before it started), so a hold
 *     survives it and still replays — a round-3 finding corrected an earlier
 *     version of this comment, which claimed the opposite and thereby told the
 *     agent to stop editing during a review, the one thing this gate wants it
 *     to keep doing.
 *
 *     Leaving a parked record behind in any of those cases is what round-2 P2
 *     caught: nothing would ever revisit it, while the reply had already told
 *     the agent not to re-submit.
 *   - `replay` — a PASS on exactly the parked tree, while the gate's CURRENT
 *     review target is still that same round. Only here does the parked
 *     conclusion become the verdict it always was.
 *
 * ALL THREE IDS MUST AGREE FOR `replay`, and an absent or empty one on ANY of
 * them is never a match: an unknown tree is not evidence that two trees are
 * the same, and replaying onto a round that has moved on would record a READY
 * nobody is looking at.
 *
 * TWO PRECONDITIONS, ONE DECISION (2026-09-16). A round whose two judges run
 * together can be parked for EITHER reason: the lane that verifies its content
 * has not landed, or the quality round owes a verdict. Those two land in
 * either order, and each landing must be able to release the conclusion — so
 * the outcome is computed from the STATE OF BOTH HALVES rather than from the
 * event that happened to fire:
 *
 *   - both `ok`  ⇒ `replay`
 *   - any `veto` ⇒ `clear` (the content or the round is disproven)
 *   - otherwise  ⇒ `hold`  (something is still owed)
 *
 * Both callers compute their halves and then ask this one function, so the two
 * landings cannot disagree about the outcome. `hold` is what keeps the record
 * alive for the other landing; nothing else may decide that.
 */
export type ParkedReadyFate = "none" | "hold" | "clear" | "replay";

/** One half of the replay question: satisfied, still owed, or disproven. */
export type ParkedHalf = "ok" | "pending" | "veto";

/**
 * THE LANE'S HALF — what the full precommit lane that verifies this content
 * has said so far.
 *
 *  - a NON-PASS landing is a `veto`: the content the reviewer approved just
 *    failed its full lane, so the parked conclusion describes content that is
 *    no longer shippable;
 *  - a PASS covering EXACTLY the parked tree — while the gate's current review
 *    target is still that same round — is `ok`;
 *  - otherwise the answer depends on whether ANYONE IS STILL COMING. With a
 *    lane running (or a fresh landing that was not a replay) the answer is
 *    `pending` only while that lane can still land on it; a lane that already
 *    landed on another tree, or a round the gate has moved past, will never
 *    revisit this conclusion — that is a `veto`, because a hold nobody can end
 *    parks the round forever (the `unverified-idle` rule, round-1 P1).
 */
export function parkedLaneHalf(args: {
  /** `pendingReady.tree`, when something is parked. */
  parkedTree: string | undefined;
  /** What the lane returned, when a lane JUST landed. Absent: no fresh landing. */
  laneVerdict?: string | undefined;
  /** `precommit.lastFullPassTree` — after the landing, or as recorded. */
  coveredTree: string | undefined;
  /** The tree the gate's current review target holds. */
  currentTargetTree: string | undefined;
  /** Is a full lane running for this repo right now? */
  laneRunning: boolean;
  /** The user's own `/gate-bypass` grant — see `laneVerifiesTree`. */
  bypassActive: boolean;
}): ParkedHalf {
  const parked = args.parkedTree;
  if (parked === undefined || parked === "") return "veto";
  // ONE rule for "was this tree verified", shared with the recorder — never a
  // second reading of bypass or of `lastFullPassTree` here.
  const verified = laneVerifiesTree({
    tree: parked,
    coveredTree: args.coveredTree,
    bypassActive: args.bypassActive,
  });
  if (args.laneVerdict !== undefined) {
    if (args.laneVerdict !== "PASS") return "veto";
    return verified && args.currentTargetTree === parked ? "ok" : "veto";
  }
  if (verified) return args.currentTargetTree === parked ? "ok" : "veto";
  return args.laneRunning ? "pending" : "veto";
}

/**
 * The combination — the ONLY thing the callers act on.
 *
 * `hold` is never a permanent state: the caller that holds a conclusion must
 * have established that BOTH halves can still move (a lane is running, or the
 * quality round can still conclude — `decideQualityHold` refuses otherwise),
 * and every landing re-asks this function.
 */
export function parkedReadyFate(args: {
  parkedTree: string | undefined;
  /** The lane's half — see `parkedLaneHalf`. */
  lane: ParkedHalf;
  /**
   * The quality round's half — computed from `qualityPrecondition`
   * (lib/quality-round.ts), so the parking rule and the recording rule are ONE
   * policy rather than two spellings of it.
   */
  quality: ParkedHalf;
}): ParkedReadyFate {
  const parked = args.parkedTree;
  if (parked === undefined || parked === "") return "none";
  if (args.lane === "veto" || args.quality === "veto") return "clear";
  if (args.lane === "ok" && args.quality === "ok") return "replay";
  return "hold";
}

export function adjudicateReviewConclusion(
  input: StructuredConclusion,
  exemption?: ScopeExemption,
): AdjudicatedReview {
  const findings = input.findings ?? [];
  // Rule 1 — a READY that ships with an open P0/P1 contradicts itself.
  //
  // SCOPE-AWARE (2026-09-19): with a user-granted scope limit in force, only
  // findings on files the gate still covers can contradict anything. A round
  // that concluded BLOCKED on an exempted file keeps that verdict — this is
  // not a machine that overrules a reviewer, it is the rule that stops one
  // from being enforced against work the user already excused.
  const exempt = exemption === undefined ? undefined : new Set(exemption.exemptFiles);
  const blocking = findings.filter((f) => blocksTheRound(f, exempt));
  const verdict = input.verdict === "READY" && blocking.length > 0 ? "BLOCKED" : input.verdict;
  const blockingTotal = findings.filter((f) => isBlockingSeverity(f.severity)).length;
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
    exemptedBlocking: blockingTotal - blocking.length,
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
