# Incremental review — wall-clock measurements

Goal criterion 6 of the incremental-review change (2026-08-27): measure and
record the wall-clock cost of FIRST vs. INCREMENTAL rounds for the three
review roles. The target (≥50% faster incremental rounds) is a soft metric —
model/network variance does not block, but the data must be recorded and any
missed target must be attributed.

## Method

Rounds were timed with the subagent runner's own `Started` / `Updated`
timestamps (`subagent status`), i.e. wall-clock dispatch-to-completion. Token
counts are the runner's reported usage where available. The incremental
rounds below were driven by hand-written "review only these N items" task
texts (the protocol's carryover + increment block, assembled manually) because
the extension process loads at session start and the mechanically injected
scope block only takes effect from the next session — see Attribution.

## Goal-auditor (first audit → re-audit of a revised draft)

| Round | Scope | Wall clock | Notes |
|---|---|---|---|
| First audit (full) | whole draft | 3m26s (206s) | baseline; 0 findings |
| Re-audit 1 (incremental) | 4 revised criteria only | 1m01s (61s) | **−70%** vs first |
| Re-audit 2 (incremental) | 1 revised criterion only | 54s | **−74%** vs first |

The carryover block (`formatGoalPrereviewCarryover` + `buildGoalAuditTask`)
now mechanizes exactly the "here is what the previous audit found, judge the
delta" instruction those two incremental rounds were given by hand.

## Reviewer (round 1 → round 2/3)

| Round | Scope | Wall clock | Notes |
|---|---|---|---|
| Round 1 (full) | whole change, 18 files | 10m10s | baseline; 9 P1 found |
| Round 2 (incremental) | re-check 9 fixed findings | 8m57s | −12%; still re-read the diff |
| Round 3 (incremental) | re-check 4 fixed findings | 9m31s | −6%; model/network variance |

**Missed the ≥50% target — attribution.** The rounds themselves show why:
the review scope of round 2/3 still asked the reviewer to audit the WHOLE
change (the task text's opening contract), with the fixed-findings list as
the only focus hint; the reviewer re-derived the full diff regardless.
That is exactly the gap the mechanical injection closes — with the scope
block (`formatReviewScopeDirective`, audience `reviewer`) embedded in the
task text, the reviewer is told that everything outside the increment is
already settled and gets a consistency scan, not a re-derivation. The
mechanical injection is covered by unit tests
(`test/review-scope.test.ts`, `test/parallel-review.test.ts`) but its
wall-clock effect is only observable from the next session, when the
extension loads the new task-text builder.

Also relevant: the incremental goal-auditor rounds prove the economy is real
(−70/−74%) when the focus instruction actually reaches the role. The
adviser's first-vs-later timing is not recorded here: no second consultation
of the same goal happened in this session, and `prepare_adviser` only loaded
into the extension from the next session — its incremental brief is unit-
tested (`test/adviser-brief.test.ts`) and pending a two-consultation
measurement.

## Mechanical-path verification status

The measurements above were taken on the MANUAL incremental path (hand-written
carryover + focus instructions) because the extension process loads at session
start. The MECHANICAL path — the gate-generated task text with the scope
block / carryover / draft delta — is verified as follows:

- **Content is unit-locked**: `test/review-scope.test.ts` (reviewer audience
  wording), `test/parallel-review.test.ts` (scope + session injection),
  `test/loop-goal.test.ts` (carryover with zero findings, draft delta
  injection), `test/adviser-brief.test.ts` (incremental brief + artifact
  round-trip).
- **Wall-clock effect on the mechanical path** is pending the next session
  (extension reload); the goal-auditor numbers above (−70/−74%) already prove
  the economy on the identical instruction shape.
- **Reviewer round 2/3 attribution**: −12%/−6% only, because the round 2/3
  task text still opened with the whole-change audit contract; the mechanical
  scope block ("everything outside the increment is settled — consistency
  scan, not re-derivation") is the next-session change that targets exactly
  that cost.

Token counts were not reported by the runner for these rounds; wall-clock is
the recorded metric per the goal's emphasis. The reviewer's focus
instruction is the next-session change.

## Handoff-session measurements (2026-08-27, mechanical path, new extension load)

The handoff session (this one) loaded the new extension, so the gate-generated
task texts carried the mechanical scope/carryover injection. Rounds 1–2 of this
session were still FULL (no READY baseline exists — the state was reset between
sessions), but they are the first MECHANICAL-path wall-clock records:

| Role | Round | Scope | Wall clock | Notes |
|---|---|---|---|---|
| reviewer | Round 1 (full) | whole change, 30 files | ~9m | BLOCKED: 4 findings (1 dependency-lock P1, 1 criterion-6 P1, 2 P2) |
| reviewer | Round 2 (full) | whole change, 30 files | ~6m | BLOCKED: 3 findings (scope-wording P1, criterion-6 P1, Windows-encoder P1) |
| adviser | Consultation 1 (full) | whole goal | 11m15s (675s) | SUPPORTS; 2 P2 residuals |
| adviser | Consultation 2 (incremental) | 3 changed files + carryover | 8m28s (508s) | **−25%** vs first; OBJECTS on a real predicate bug the first consult missed |

**Adviser −25% attribution (missed the ≥50% soft target):** consultation 2's
question was a NEW review of three fresh fixes (scope-aware opening, Windows
encoder, comment direction), not a re-check of settled material — the increment
it judged was genuinely new code, so the economy comes from context reuse
(injected previous conclusion + changed-files list), not from less to verify.
The same model (grok-4.6, max thinking) ran both. The incremental brief was
mechanically injected (prepare_adviser carryover: previous SUPPORTS + its 2
points + the 3 changed files), which is criterion 3's injection working end to
end; it caught a production-path bug (opening-line predicate) that the first
consultation could not see.

**Reviewer rounds are full because the state reset:** rounds 1–2 had no READY
baseline, so `decideReviewScope` correctly resolved to FULL. The criterion-6 (b)
READY → small change → round 2 measurement is completed below when the first
READY lands.

## Criterion 6(b) — READY baseline → small change → incremental round (2026-08-27, THIS session)

The first READY verdict of the session landed at round 14 (06:08:20Z → 06:26:02Z,
**17m42s**). The small change below is the increment this round measures against:
measurement-document data + the round-14 P2/Nit cleanups (dead `reviewerRef`,
symlink-containment regression test, spawn-guard copyable example, doc wording).

| Round | Scope | Wall clock | Notes |
|---|---|---|---|
| Round 14 (full) | whole change, 39 files | 17m42s | **READY baseline**; 5 mutations verified; 2 P2 + 4 Nit |
| Round 15 (FULL-esc) | increment = doc data + P2/Nit cleanups, but the increment touched 1 previously-unreviewed file (`lib/reviewer-spawn-guard.ts` — the `context: "fresh"` copyable shape) so `decideReviewScope` escalated to FULL | 11m06s | READY; all six round-14 findings verified fixed; escalation is the unreviewed-file fail-safe working as designed |
| Round 16 (incremental) | 2 files / 12 lines, all inside already-reviewed files | 5m38s | **READY; first true MECHANICAL incremental round — −68% vs the round-14 baseline** (17m42s → 5m38s), comfortably past the ≥50% soft target; mutation-verified drift guards |



## Exit-criterion 6 status (as recorded at ship time)

- **(a) goal-auditor first vs re-audit — MET**: measured 206s → 61s → 54s
  (−70%/−74%) on the manual incremental path; the mechanical carryover task
  (prepare_goal_audit) is unit-locked and produces the same instruction shape.
- **(b) reviewer READY → small change → round 2 — MEASURED (2026-08-27, THIS session)**: round 14 (READY baseline, full) **17m42s** → round 16 (incremental, 2 files/12 lines) **5m38s**, **−68%** — past the ≥50% soft target. Round 15 ran FULL by legitimate escalation (its increment touched a previously-unreviewed file, `lib/reviewer-spawn-guard.ts` — the unreviewed-file fail-safe working as designed, 11m06s) and is excluded from the comparison. The incremental round's task text carried the mechanically injected SETTLED block + increment list + consistency-scan instruction.
- **(c) adviser first vs later consultation — MEASURED (handoff session)**: 11m15s → 8m28s, **−25%**, mechanical incremental brief (carryover + changed files). Attribution (missed ≥50%): the second consultation judged genuinely new code (three fresh fixes), so the saving is context reuse, not reduced scope. Same model (grok-4.6, max thinking) both times.
- The goal's soft-metric clause is honored: all three (a)/(b)/(c) wall-clock
  comparisons are recorded above with honest attribution wherever a miss
  occurred; token counts were not reported by the runner (wall-clock is the
  metric of record).
