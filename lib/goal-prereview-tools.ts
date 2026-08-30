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
 * AUDIT — reading the auditor's fence, adjudicating it, and writing the record
 * a later approval binds to. lib/goal-tools.ts owns the APPROVAL — running the
 * audit when no PASS is on record, then the user's dialog and the file write.
 * The split is also what keeps both files clear of the 600-line hard block on
 * new source files. Registration of BOTH tools happens in lib/goal-tools.ts
 * (philosophy two: one entry point for the family), which is why this module
 * exports a handler rather than a registrar — it registers nothing itself.
 *
 * WHAT IS AND IS NOT INJECTED. The pure pieces are imported directly
 * (lib/loop-goal.ts for the normalization, the hash and the carryover,
 * lib/verdict-parse.ts for the fence, lib/judge-lifecycle.ts for the
 * adjudication, lib/repo-resolve.ts for the git root): they are already
 * testable on their own. What IS injected is everything the handler cannot
 * own — the repo roots, gate state, its persistence and the log channel — so
 * every branch here can be exercised with a fake.
 *
 * BEHAVIOR IS FROZEN: this was moved verbatim out of the extension. Tool
 * names, schemas, reply texts, `details` fields and error branches are the
 * ones the agent-facing contract already documents; changing any of them is a
 * separate, deliberate change.
 */

import { resolve as pathResolve } from "node:path";

import type { ToolReply } from "./tool-host.ts";
import type { GateState } from "./gate-state.ts";
import {
  LOOP_GOAL_MAX_WRITE_CHARS,
  formatGoalPrereviewCarryover,
  goalTextHash,
  normalizeGoalText,
  type GoalPrereviewRecord,
} from "./loop-goal.ts";
import { parseReviewOutput, parseFenceFindings } from "./verdict-parse.ts";
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

/** Which of the two goal tools a shared check is speaking for. */
export type GoalToolName = "record_goal_prereview" | "propose_loop_goal";

/** A submitted draft that passed the shared checks, or the refusal text. */
export type GoalDraftCheck =
  | { ok: true; goalText: string; root: string }
  | { ok: false; text: string };

/**
 * The three things BOTH goal tools demand of a submission, in one pure
 * decision: a non-empty draft, a draft under the write cap, and a repo the
 * goal can actually bind to.
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
  tool: GoalToolName;
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
      text: input.tool === "record_goal_prereview"
        ? `review-gate: record_goal_prereview rejected — the goal is ${goalText.length} chars, over the ` +
          `${LOOP_GOAL_MAX_WRITE_CHARS} limit propose_loop_goal enforces. Shorten it BEFORE auditing: an ` +
          "exit contract is 3–7 checkable criteria, not a design doc."
        : `review-gate: propose_loop_goal rejected — the goal is ${goalText.length} chars, over the ` +
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
        (input.tool === "record_goal_prereview"
          ? "a goal pre-review can only bind to a real repo."
          : "a loop goal can only bind to a real repo."),
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

/**
 * `record_goal_prereview` — the gate's own recording of a goal audit.
 *
 * INTERNAL (registered on the internal host in lib/goal-tools.ts):
 * `propose_loop_goal` runs the audit itself and records the verdict through
 * this implementation.
 */
export async function doRecordGoalPrereview(
  deps: GoalPrereviewDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const checked = checkGoalDraft({
    tool: "record_goal_prereview",
    rawGoal: params.goal,
    rawRepo: params.repo,
    cwd: deps.cwd(),
    primaryRepoRoot: deps.primaryRepoRoot(),
  });
  if (!checked.ok) {
    return {
      content: [{ type: "text", text: checked.text }],
      details: { recorded: false },
      isError: true,
    };
  }
  const { goalText, root: goalRoot } = checked;
  const goalSt = deps.stateFor(goalRoot);

  // The EXTENSION reads the verdict; the agent only carries the output.
  // parseReviewOutput already encodes the two rules that matter here: a
  // READY carrying unresolved P0/P1 is contradictory and becomes BLOCKED,
  // and a fence we could not fully parse can never come back READY.
  const auditorOutput = typeof params.auditor_output === "string" ? params.auditor_output : "";
  const parsed = parseReviewOutput(auditorOutput);
  if (!parsed) {
    return {
      content: [{
        type: "text",
        text: "review-gate: no recognizable verdict in the goal-auditor's output — NOTHING was recorded " +
          "(fail-closed). The auditor must end its reply with exactly ONE fenced JSON verdict, e.g.\n" +
          `\`\`\`json\n{"gate":"READY"|"BLOCKED","findings":[{"severity":"P1","issue":"…"}]}\n\`\`\`\n` +
          "Common causes: the reply was pure prose with no fence, it was truncated before the fence, " +
          "or an unescaped straight quote inside a string broke the JSON. Re-run the audit — do not " +
          "hand-write the verdict.",
      }],
      details: { recorded: false },
      isError: true,
    };
  }
  const newHash = goalTextHash(goalText);
  const findings = parseFenceFindings(auditorOutput);
  // ONE adjudication for the record, the reply and the gate (B2): a READY
  // without P0/P1 is a PASS no matter how many P2/Nit findings ride along.
  // The audit ROUND counts audits of the GOAL being negotiated now — the
  // gate counts, so the agent never has to (and cannot miscount). It is
  // not the length of goalPrereviewHistory: that is append-only across
  // every goal this repo ever had.
  goalSt.goalAuditRound = (goalSt.goalAuditRound ?? 0) + 1;
  const adjudication = adjudicateGoalAudit({
    verdict: parsed.verdict,
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
    findingsTotal: parsed.findingsTotal,
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
  deps.log(`goal pre-review recorded for ${goalRoot}: ${record.verdict} (${goalText.length} chars, findings: ${parsed.findingsTotal ?? "unparseable"})`);
  // Wall-clock since the previous audit — the incremental-economy datum
  // (goal criterion 6, (a)): re-audits of a revised draft should be
  // measurably cheaper than first audits. Diagnostic only.
  const prevAt = prev?.at ? Date.parse(prev.at) : NaN;
  const auditGapMin = Number.isFinite(prevAt)
    ? Math.round((Date.now() - prevAt) / 60000)
    : null;
  return {
    content: [{
      type: "text",
      text: buildGoalRecordReply({
        message: adjudication.message,
        passed,
        hash: record.hash,
        verdict: parsed.verdict,
        durationMs,
        auditGapMin,
        reaudit: !!carryover,
      }),
    }],
    details: { recorded: true, verdict: record.verdict, findingsTotal: parsed.findingsTotal ?? null, reaudit: !!carryover, auditGapMin, durationMs: durationMs ?? null },
  };
}
