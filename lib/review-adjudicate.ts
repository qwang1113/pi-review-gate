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
