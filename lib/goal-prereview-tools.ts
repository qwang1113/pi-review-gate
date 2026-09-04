/**
 * The GOAL PRE-REVIEW half of the goal tool family: how a `goal-auditor`
 * verdict becomes a RECORD, plus the two checks both goal tools run on a
 * submitted draft (the length cap and the repo the goal binds to).
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8000 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts), then
 * the judge tools (lib/judge-session-tools.ts), the prepare family
 * (lib/review-prepare-tools.ts, lib/advisory-prepare-tools.ts), the L7 Copilot
 * pair (lib/copilot-review-tools.ts) and the user-interaction family
 * (lib/user-interaction-tools.ts). Same shape here.
 *
 * THE BOUNDARY between this module and lib/goal-tools.ts: this one owns the
 * AUDIT — reading the auditor's structured conclusion, adjudicating it, and
 * writing the record a later approval binds to. lib/goal-tools.ts owns the
 * APPROVAL — running the audit when no PASS is on record, then the user's
 * dialog and the file write.
 * The split is also what keeps both files clear of the 600-line hard block on
 * new source files. `propose_loop_goal` — the family's ONE registered tool —
 * is registered in lib/goal-tools.ts (philosophy two: one entry point for the
 * family), which is why this module exports handlers rather than a registrar.
 *
 * WHAT IS AND IS NOT INJECTED. The pure pieces are imported directly
 * (lib/loop-goal.ts for the normalization, the hash and the carryover,
 * lib/review-adjudicate.ts for the conclusion's verdict and findings,
 * lib/judge-lifecycle.ts for the adjudication, lib/repo-resolve.ts for the git
 * root): they are already
 * testable on their own. What IS injected is everything the handler cannot
 * own — the repo roots, gate state, its persistence and the log channel — so
 * every branch here can be exercised with a fake.
 */

import { resolve as pathResolve } from "node:path";

import type { GateState } from "./gate-state.ts";
import {
  LOOP_GOAL_MAX_WRITE_CHARS,
  formatGoalPrereviewCarryover,
  goalTextHash,
  normalizeGoalText,
  type GoalPrereviewRecord,
} from "./loop-goal.ts";
import { normalizeConcludedVerdict, severityFindingsFrom } from "./review-adjudicate.ts";
import type { ReportConclusion } from "./orchestrator-channel.ts";
import { adjudicateGoalAudit } from "./judge-lifecycle.ts";
import { gitRootOfDir } from "./repo-resolve.ts";

/**
 * Everything the goal tools need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every member is a thing a
 * test replaces with three lines.
 */
export interface GoalPrereviewDeps {
  /**
   * The session's own repo — the goal's default binding.
   *
   * A GETTER, not a captured string: the extension re-resolves both this and
   * `cwd` at `session_start` (pi hands the real working directory only then),
   * so a value captured at registration would bind a goal to the directory pi
   * happened to be launched from and record it in a state object nobody reads.
   */
  primaryRepoRoot(): string;
  /** What a relative `repo` parameter resolves against — a getter, same reason. */
  cwd(): string;
  /** One repo's gate state (the primary repo's state IS the extension's). */
  stateFor(root: string): GateState;
  /** Persist one repo's state (sidecar write + blocked-marker handling). */
  persist(ctx: unknown, root: string): void;
  /** The gate's own log channel (diagnostics; never shown to the user). */
  log(message: string): void;
}


/** A submitted draft that passed the shared checks, or the refusal text. */
export type GoalDraftCheck =
  | { ok: true; goalText: string; root: string }
  | { ok: false; text: string };

/**
 * The three things a goal submission must satisfy, in one pure decision: a
 * non-empty draft, a draft under the write cap, and a repo the goal can
 * actually bind to.
 *
 * ONE caller shape, deliberately: `propose_loop_goal` is the only goal tool
 * there is, and the audit recorder behind it (`recordGoalPrereview`) runs the
 * same three checks on the same draft, so both speak with its voice.
 *
 * The repo resolution is deliberately NOT `resolveToolRepo`: that helper
 * requires a repo the session already EDITED, but a goal (and therefore its
 * audit) is recorded before the first edit lands. Using it here would make a
 * second repo's goal impossible to record — a dead end with no way out.
 *
 * `gitRoot` is a parameter rather than an import so the decision stays
 * testable without a filesystem; every caller passes lib/repo-resolve.ts's
 * `gitRootOfDir`.
 */
export function checkGoalDraft(input: {
  tool: "propose_loop_goal";
  rawGoal: unknown;
  rawRepo: unknown;
  cwd: string;
  primaryRepoRoot: string;
  gitRoot?: (dir: string) => string | null;
}): GoalDraftCheck {
  const goalText = normalizeGoalText(String(input.rawGoal ?? ""));
  if (goalText.length === 0) {
    return { ok: false, text: `review-gate: ${input.tool} rejected — the goal text is empty.` };
  }
  // Same cap for both: auditing a draft the approval tool can never accept
  // would burn a full audit round to produce a PASS that is structurally
  // unusable.
  if (goalText.length > LOOP_GOAL_MAX_WRITE_CHARS) {
    return {
      ok: false,
      text: `review-gate: propose_loop_goal rejected — the goal is ${goalText.length} chars, over the ` +
        `${LOOP_GOAL_MAX_WRITE_CHARS} limit. An exit contract is 3–7 checkable criteria, not a design doc.`,
    };
  }
  // Per-repo binding: the goal belongs to the repo the WRITES land in.
  // Default is the session repo; a multi-repo session passes `repo` so each
  // repo gets its own contract (the L8 edit gate checks each repo's own goal
  // + sidecar confirmation, so without this a second repo could never be
  // unlocked — the block message would point at a dead end).
  const rawRepo = String(input.rawRepo ?? "").trim();
  if (!rawRepo) return { ok: true, goalText, root: input.primaryRepoRoot };
  const abs = pathResolve(input.cwd, rawRepo);
  // A goal bound to a NON-repo path could never satisfy the edit gate (it
  // checks gitRootOfDir of the target write) — that would be a dead approval,
  // and writing .pi/ into an arbitrary directory is worse. Refuse instead of
  // silently recording it.
  const root = (input.gitRoot ?? gitRootOfDir)(abs);
  if (!root) {
    return {
      ok: false,
      text: `review-gate: repo "${rawRepo}" (resolved ${abs}) is not inside a readable git repository — ` +
        "a loop goal can only bind to a real repo.",
    };
  }
  return { ok: true, goalText, root };
}

/**
 * The sentence the agent reads after an audit was recorded.
 *
 * B2 ("whack-a-mole"): the gate states the verdict AND its consequence. The
 * measured failure was an agent that read a READY carrying P2 findings as
 * "not done yet" and volunteered another audit round — so the rule is spelled
 * out mechanically: only P0/P1 block, non-blocking findings never buy a
 * re-audit.
 */
export function buildGoalRecordReply(input: {
  /** The adjudication's own one-line summary (round number included). */
  message: string;
  passed: boolean;
  hash: string;
  /** The raw verdict, named on a FAIL so the agent sees what was read. */
  verdict: string;
  durationMs?: number | undefined;
  auditGapMin?: number | null;
  /** Is this a re-audit (a previous record for a DIFFERENT draft existed)? */
  reaudit: boolean;
}): string {
  return `review-gate: ${input.message}\n` +
    (input.passed
      ? `记录：PASS（${input.hash.slice(0, 12)}…）。用 IDENTICAL 文本调 propose_loop_goal——改一个字就要重审。`
      : `记录：FAIL（verdict ${input.verdict}）。propose_loop_goal 保持阻塞。`) +
    (input.durationMs !== undefined
      ? `\n本轮审计耗时 ${Math.round(input.durationMs / 1000)}s。`
      : "") +
    (input.auditGapMin !== null && input.auditGapMin !== undefined
      ? `\n距上一轮审计 ${input.auditGapMin} min。`
      : "") +
    (input.reaudit
      ? "\n重审时把修订稿直接交给 `propose_loop_goal` 即可：它建的审计任务会自动带上本轮结论与草稿差异。"
      : "");
}

/** What one goal audit round hands the recorder. */
export interface GoalPrereviewInput {
  /** The FULL draft that was audited — the record binds to its hash. */
  goal: unknown;
  /** The auditor's own structured conclusion, off its channel report. */
  conclusion: ReportConclusion;
  /** Repo the goal binds to (default: the session repo). */
  repo?: unknown;
  /** ISO timestamp of the dispatch, for the audit's wall-clock duration. */
  auditStartedAt?: unknown;
}

/**
 * Record ONE goal audit.
 *
 * NOT A TOOL, on any surface (2026-09-04, user decision D4 extended to this
 * recorder by the user). It used to be an `internalTool` taking
 * `auditor_output: string`, and that shape existed for one reason only: the
 * verdict had to be parsed back out of a fence the gate had itself
 * synthesised. The conclusion is structured now, so the wrapper carried
 * nothing but a second way to sequence the step by hand (philosophy two,
 * philosophy three). `propose_loop_goal` runs the audit and the gate calls
 * this directly when the round's report lands.
 *
 * Returns the text the caller shows; a refusal records NOTHING (fail-closed).
 */
export async function recordGoalPrereview(
  deps: GoalPrereviewDeps,
  params: GoalPrereviewInput,
  ctx: unknown,
): Promise<string> {
  const checked = checkGoalDraft({
    tool: "propose_loop_goal",
    rawGoal: params.goal,
    rawRepo: params.repo,
    cwd: deps.cwd(),
    primaryRepoRoot: deps.primaryRepoRoot(),
  });
  if (!checked.ok) {
    return checked.text;
  }
  const { goalText, root: goalRoot } = checked;
  const goalSt = deps.stateFor(goalRoot);

  // The auditor concluded through judge_conclude, so its verdict and findings
  // arrive as DATA. An unrecognisable verdict records nothing — a round that
  // never concluded must never leave a PASS behind.
  const verdict = normalizeConcludedVerdict(params.conclusion.verdict);
  if (!verdict) {
    return "review-gate: no recognizable verdict in the goal-auditor's round — NOTHING was recorded " +
      "(fail-closed). The auditor must conclude through judge_conclude (verdict READY|BLOCKED plus " +
      "findings); prose alone records nothing. " +
      "Common causes: the round ended without a conclude call, or it was truncated before the call. " +
      "Re-run the audit — do not hand-write the verdict.";
  }
  const newHash = goalTextHash(goalText);
  const findings = severityFindingsFrom(params.conclusion.findings);
  // ONE adjudication for the record, the reply and the gate (B2): a READY
  // without P0/P1 is a PASS no matter how many P2/Nit findings ride along.
  // The audit ROUND counts audits of the GOAL being negotiated now — the
  // gate counts, so the agent never has to (and cannot miscount). It is
  // not the length of goalPrereviewHistory: that is append-only across
  // every goal this repo ever had.
  goalSt.goalAuditRound = (goalSt.goalAuditRound ?? 0) + 1;
  const adjudication = adjudicateGoalAudit({
    verdict,
    findings,
    round: goalSt.goalAuditRound,
  });
  const passed = adjudication.pass;
  // Wall-clock duration of THIS audit, when the agent reported when it
  // dispatched the auditor (goal criterion 6). Parsed leniently: a bogus
  // timestamp records no duration rather than failing the record.
  const startedAt = typeof params.auditStartedAt === "string" ? Date.parse(params.auditStartedAt) : NaN;
  // A future timestamp (clock skew, a typo) records NO duration rather
  // than a negative one that would poison the timing diagnostic.
  const now = Date.now();
  const durationMs = Number.isFinite(startedAt) && startedAt > 0 && startedAt <= now ? now - startedAt : undefined;
  const record: GoalPrereviewRecord = {
    hash: newHash,
    verdict: passed ? "PASS" : "FAIL",
    at: new Date().toISOString(),
    findingsTotal: params.conclusion.findings.length,
    ...(findings.length ? { findings } : {}),
    draft: normalizeGoalText(goalText),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  // Re-audit carryover (goal criterion 2): replacing a record for a
  // DIFFERENT draft means this audit is a re-audit — hand the previous
  // verdict and its findings back so the agent can put them in the
  // auditor's task text. Same-hash re-records (a PASS retried) carry
  // nothing: there is no revised draft to judge.
  const prev = goalSt.goalPrereview;
  const carryover = prev && prev.hash !== newHash ? formatGoalPrereviewCarryover(prev) : undefined;
  // Latest-only for the CHECK (propose_loop_goal matches the CURRENT
  // draft's PASS), but EVERY audit is persisted in the history (goal
  // criterion 2: PASS or FAIL, oldest first) so the re-audit chain and
  // its carryover data survive newer drafts.
  goalSt.goalPrereviewHistory = [...(goalSt.goalPrereviewHistory ?? []), record];
  goalSt.goalPrereview = record;

  deps.persist(ctx, goalRoot);
  deps.log(`goal pre-review recorded for ${goalRoot}: ${record.verdict} (${goalText.length} chars, findings: ${params.conclusion.findings.length})`);
  // Wall-clock since the previous audit — the incremental-economy datum
  // (goal criterion 6, (a)): re-audits of a revised draft should be
  // measurably cheaper than first audits. Diagnostic only.
  const prevAt = prev?.at ? Date.parse(prev.at) : NaN;
  const auditGapMin = Number.isFinite(prevAt)
    ? Math.round((Date.now() - prevAt) / 60000)
    : null;
  return buildGoalRecordReply({
    message: adjudication.message,
    passed,
    hash: record.hash,
    verdict,
    durationMs,
    auditGapMin,
    reaudit: !!carryover,
  });
}
