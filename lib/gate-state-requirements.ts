/**
 * The ship authority — `unmetRequirements`, the single answer to "may we ship?"
 * that the L1 gate and the L3 hooks share — plus the loop-convergence predicates
 * (strategic reset, oscillation, plateau).
 *
 * Split out of lib/gate-state.ts.
 */

import { stageOpen } from "./loop-stages.ts";
import { isContentFreeQualitySkip, isSkippedQualityRecord } from "./quality-round.ts";
import type { GateState } from "./gate-state.ts";
import type { GateVerdict, RoundRecord } from "./gate-state-records.ts";

/**
 * The single authority on "may we ship?".
 * Returns the list of unmet requirements (empty = ship allowed).
 *
 * THE USER'S STAGE SWITCHES ARE READ HERE (2026-09-22, lib/loop-stages.ts).
 * `review` off releases the review block (code and docs alike), `precommit`
 * off releases the precommit block; each block is skipped whole, and each is
 * read independently because the two switches are independent. The L3 git
 * hooks read the SAME record out of the SAME sidecar, so the L1 ship gate and
 * the commit hook can never disagree about a stage the user switched off.
 */
export function unmetRequirements(
  state: GateState | undefined,
  currentFingerprint: string,
  fingerprintUnavailable: boolean,
  opts?: {
    /**
     * Project knob `docSync` (default ON). When true, a code change additionally
     * requires the READY review to carry a docSync attestation
     * (UPDATED | NOT_NEEDED). The attestation is required on EVERY code
     * change — not only when no doc file was touched — so trivially touching
     * a .md file cannot satisfy the gate: the reviewer must always judge.
     */
    requireDocSync?: boolean;
    /**
     * Require a precommit run whose tests were NOT narrowed (`testScope`
     * `"full"`).
     *
     * The two lanes exist so a `git commit` does not have to re-run a whole
     * suite for a one-line fix: `fast` runs lint + typecheck + build + the
     * tests related to the changed files. That is a real check, but it is not
     * evidence the suite passes — so everything that PUBLISHES work
     * (`git push`, `gh pr create`/`edit`, and task completion) sets this and
     * demands a full run.
     *
     * Absent `testScope` on an older sidecar counts as NOT full: the
     * guarantee did not exist when it was written, so it cannot be claimed.
     */
    requireFullTests?: boolean;
    /**
     * Round-9 P1: trees of the commits between the last READY's reviewed
     * commit and HEAD that DIFFER from the reviewed tree. Non-empty ⇒
     * content no reviewer saw has entered the branch since the READY —
     * the reviewed tree still matches only if every later commit is a
     * no-content (squash) rewrite of the same tree. Computed by the caller
     * (this function is pure); absent ⇒ not checked (older callers).
     */
    unreviewedCommits?: string[];
  },
): string[] {
  if (!state) return ["gate state missing (fail-closed)"];
  // ANOTHER live session holds this worktree (lib/session-exclusivity.ts).
  // Checked before `bypass`, and it is the ONE requirement a bypass does not
  // clear: `/gate-bypass` is this session's authorization to ship its own
  // work, and the work here is not this session's to authorize — the sidecar,
  // the worktree and the review all belong to the session that holds it.
  if (state.exclusivityRefusal) return [state.exclusivityRefusal];
  if (state.bypass.active) return [];

  const problems: string[] = [];

  if (!state.hasCodeChange && !state.hasDocChange) {
    // Nothing tracked as changed this session. We still verify the review
    // if the worktree is dirty relative to what was reviewed — but with no
    // session changes at all, shipping pre-existing work is allowed.
    return [];
  }

  if (fingerprintUnavailable) {
    problems.push("worktree fingerprint unavailable (git unreadable) — cannot verify gate binding");
    return problems;
  }

  // THE USER'S STAGE SWITCHES, read once (lib/loop-stages.ts is the only place
  // that answers "is this stage on?"). An off stage releases its whole block
  // below: no review requirement, no precommit requirement. The two are read
  // independently because they are independent switches.
  const reviewOn = stageOpen(state.stages, "review");
  const precommitOn = stageOpen(state.stages, "precommit");
  const qualityOn = stageOpen(state.stages, "quality");

  // A QUALITY ROUND THAT SAID NO, WITH NO REVIEW ROUND TO CARRY IT (2026-09-22).
  //
  // With the review stage ON, a quality verdict gates the RECORD of the
  // functional READY (lib/quality-round.ts's `decideQualityHold`) and this
  // block would be a second reading of one rule. With the review stage OFF
  // there is no READY to hold, so the quality verdict would bind NOTHING: the
  // user kept the quality stage on, its judge ran and refused the code, and
  // the work would ship anyway. So here the quality verdict IS the review —
  // required, and bound to the content it judged exactly as `review` is
  // (quality round P2, 2026-09-22: checking only for a recorded BLOCKED left
  // a READY that any later edit walked away from).
  if (state.hasCodeChange && !reviewOn && qualityOn) {
    const quality = state.quality;
    // A SKIP STANDS FOR EXACTLY ONE REASON (2026-09-22, the P1 the plan's
    // last-round real-run 验收 found): the round had no code to judge, so no
    // quality judge was ever owed for it. That is why the record carries its
    // cause — the first cut of this rule refused EVERY skip, which made a
    // docs-only round unshippable in a session whose code had already been
    // judged (functional round P1, same day). A skip written because the stage
    // was OFF still does not stand once the stage is back on: the stricter
    // round the user asked for never ran, and reading only `verdict` let
    // 「quality 关 → 编辑 → judge_submit（写下跳过记录）→ 重开 quality」commit and
    // push with no quality judge ever having seen this code. Both brands are
    // read through quality-round.ts's predicates, so this reader cannot drift
    // from `qualityStandingFor`.
    const skipped = isSkippedQualityRecord(quality);
    const needReady =
      "(need READY) — the review stage is off, so this is the verdict " +
      "that stands between the code and a ship; submit a round (`judge_submit`) to run it";
    if (skipped && !isContentFreeQualitySkip(quality)) {
      problems.push(`quality round is SKIPPED ${needReady}`);
    } else if (quality?.verdict !== "READY") {
      problems.push(`quality round is ${quality?.verdict ?? "NOT_RUN"} ${needReady}`);
    } else if (quality.treeSha === undefined || quality.treeSha !== currentFingerprint) {
      problems.push("code was modified after the last quality READY (fingerprint mismatch)");
    }
  }

  if (state.hasCodeChange && reviewOn) {
    // Fail-closed: only an explicit READY bound to the current fingerprint passes.
    // (Any non-READY value — including an unknown/forged one — falls here.)
    if (state.review.verdict !== "READY") {
      problems.push(`code review gate is ${state.review.verdict} (need READY)`);
    } else if (state.review.fingerprint !== currentFingerprint) {
      problems.push("code was modified after the last READY review (fingerprint mismatch)");
    } else if (opts?.unreviewedCommits && opts.unreviewedCommits.length > 0) {
      // Round-9 P1: the tree matches but content-changing commits landed
      // after the reviewed commit (a checkpoint that was never re-reviewed,
      // or a rebase that moved the reviewed point). HEAD's tree alone cannot
      // see them — a change-and-revert still shipped unreviewed content.
      problems.push(
        `unreviewed commits since the last READY review (${opts.unreviewedCommits.length} commit(s) with content no reviewer saw) — ` +
        "checkpoint the new work and run the next review round before shipping",
      );
    } else if (opts?.requireDocSync && state.review.docSync === undefined) {
      // Fail-closed: enforcement is on and the READY review carries no
      // attestation (older review, or reviewer omitted the field) → unmet.
      problems.push(
        "docSync enforced: READY review lacks a code↔doc attestation — the reviewer verdict JSON " +
        'must include "docSync": "UPDATED" | "NOT_NEEDED"; re-run the independent review',
      );
    }
  }

  if (state.hasCodeChange && precommitOn) {
    // Fail-closed: only an explicit PASS bound to the current fingerprint is a
    // pass. Anything else — NOT_RUN, FAIL, NO_CHECKS_RUN, or an unknown/forged
    // verdict — blocks. The default branch guards against a value that somehow
    // bypassed the loader enum check.
    if (state.precommit.verdict === "PASS") {
      if (state.precommit.fingerprint !== currentFingerprint) {
        problems.push("code was modified after the last precommit PASS (fingerprint mismatch)");
      } else if (opts?.requireFullTests && state.precommit.testScope !== "full") {
        const covered = state.precommit.testScope ?? "unknown (sidecar predates the fast/full split)";
        problems.push(
          `this action requires a FULL precommit run (tests covered: ${covered}) — ` +
          "a fast run narrows the suite to the changed files, which is enough to commit but not to " +
          'publish; run the precommit runner again with mode "full"',
        );
      }
    } else if (state.precommit.verdict === "NOT_RUN") {
      problems.push("precommit has not run");
    } else if (state.precommit.verdict === "FAIL") {
      problems.push("precommit FAILED");
    } else if (state.precommit.verdict === "NO_CHECKS_RUN") {
      // PR #7 lesson 3: all-steps-skipped is NOT a pass.
      problems.push("precommit ran zero checks (NO_CHECKS_RUN ≠ PASS) — configure real checks or use /gate-bypass");
    } else {
      problems.push(`precommit verdict unrecognized (${String(state.precommit.verdict)}) — fail-closed`);
    }
  }

  if (state.hasDocChange && !state.hasCodeChange && reviewOn) {
    if (state.review.verdict !== "READY") {
      problems.push(`doc review gate is ${state.review.verdict} (need READY)`);
    } else if (state.review.fingerprint !== currentFingerprint) {
      problems.push("docs were modified after the last READY review (fingerprint mismatch)");
    }
  }

  return problems;
}

/**
 * sd0x-dev-flow R10 "Think Harder" firing predicate (pure, unit-tested).
 * The one-shot [STRATEGIC_RESET] checklist fires only when ALL hold:
 *  - the project has thinkHarder enabled;
 *  - it has not fired for this state lifetime;
 *  - the review loop is actually stuck (verdict BLOCKED — not READY awaiting
 *    precommit, not PENDING before a first review, not NEEDS_HUMAN which
 *    already escalated);
 *  - the round count is within `offset` rounds of the cap.
 * The CALLER sets strategicResetFired and persists it when this returns true.
 */
export function shouldStrategicReset(
  state: GateState,
  thinkHarder: boolean,
  offset: number,
): boolean {
  if (!thinkHarder) return false;
  if (state.strategicResetFired) return false;
  if (state.review.verdict !== "BLOCKED") return false;
  const threshold = Math.max(1, state.maxRounds - offset);
  return state.rounds.length >= threshold;
}

/**
 * Oscillation detection (pure, unit-tested). Counts READY→BLOCKED transitions
 * across the recorded rounds: a round whose verdict is BLOCKED and whose
 * immediately preceding round with a known verdict was READY. When this count
 * reaches `limit` the review loop is thrashing (the reviewer keeps finding NEW
 * problems after signalling READY) rather than converging.
 *
 * Rounds with an absent verdict (older sidecars) are skipped when looking for
 * the preceding verdict, so a legacy tail never fabricates a transition.
 * Tighten-only: the caller uses a true result solely to DISARM the auto-loop
 * and escalate — it never permits a ship.
 */
export function countOscillations(rounds: RoundRecord[]): number {
  let count = 0;
  let prevKnown: Exclude<GateVerdict, "PENDING"> | undefined;
  for (const r of rounds) {
    if (r.verdict === undefined) continue; // legacy round: cannot judge
    if (r.verdict === "BLOCKED" && prevKnown === "READY") count++;
    prevKnown = r.verdict;
  }
  return count;
}

export function isOscillating(rounds: RoundRecord[], limit: number): boolean {
  return countOscillations(rounds) >= limit;
}

/** Plateau detection: same findings recurring across N rounds without shrinking. */
export function isPlateaued(rounds: RoundRecord[], windowSize: number): boolean {
  if (rounds.length < windowSize) return false;
  const window = rounds.slice(-windowSize);
  // total must be non-decreasing across the window
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1].findingsTotal;
    const cur = window[i].findingsTotal;
    if (prev === null || cur === null) return false; // unparseable → rely on hard cap
    if (cur < prev) return false;
  }
  // fingerprint overlap >= 50% between consecutive rounds
  for (let i = 1; i < window.length; i++) {
    const a = new Set(window[i - 1].fingerprints);
    const b = window[i].fingerprints;
    if (a.size === 0 || b.length === 0) return false;
    const overlap = b.filter((f) => a.has(f)).length / b.length;
    if (overlap < 0.5) return false;
  }
  return true;
}
