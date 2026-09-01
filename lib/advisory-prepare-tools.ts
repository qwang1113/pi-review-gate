/**
 * The two ADVISORY preparations — `prepare_adviser` (the brief for a
 * consultation on the current loop goal) and `prepare_goal_audit` (the task
 * for an audit of a DRAFT loop goal).
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository now has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8900 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts), then
 * the judge tools (lib/judge-session-tools.ts, lib/judge-relay-tools.ts).
 * Same shape here: `register<Family>Tools(host, deps)`, with every effect the
 * tools need arriving through an injected `deps` object.
 *
 * THE BOUNDARY: these two prepare a task for a judge that reasons about the
 * GOAL — what to build, and whether the contract itself holds. Neither one
 * computes a commit range and neither registers a review target, because
 * neither produces a verdict that binds to a tree. Preparing the round a
 * REVIEWER judges is lib/review-prepare-tools.ts. That split is also what
 * keeps both files clear of the 600-line hard block on new source files.
 *
 * WHAT IS AND IS NOT INJECTED. The pure builders are imported directly
 * (lib/adviser-brief.ts for the brief and its conclusion parser,
 * lib/loop-goal.ts for the audit task, the carryover and the goal hash):
 * they are already testable on their own, and hiding them behind deps would
 * only make the wiring longer. What IS injected is everything the tools
 * cannot own — the repo resolution, gate state and its persistence, the
 * loop-goal readers, the session-dir lookup, the filesystem and the one git
 * read — so every branch in this file can be exercised with a fake.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Tool names, schemas, reply texts, `details` fields and error branches are
 * the ones the agent-facing contract already documents; changing any of them
 * is a separate, deliberate change.
 */

import { dirname as pathDirname, join as pathJoin, resolve as pathResolve } from "node:path";

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import type { ToolRepoTarget } from "./repo-resolve.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import type { GateState } from "./gate-state.ts";
import {
  buildAdviserBrief,
  countAdviserConclusions,
  parseAdviserConclusions,
  type AdviserConclusion,
} from "./adviser-brief.ts";
import {
  buildGoalAuditTask,
  formatGoalPrereviewCarryover,
  goalTextHash,
  normalizeGoalText,
} from "./loop-goal.ts";
import { TASK_TEXT_MARKER } from "./constants.ts";

/**
 * Resolve the repo a GOAL audit targets — deliberately NOT `resolveToolRepo`.
 *
 * `resolveToolRepo` requires the repo to be one this session has already EDITED
 * (its gate state must exist to bind a verdict). A goal, though, is recorded
 * BEFORE the first edit lands (the L8 edit gate blocks every edit until the
 * goal is approved), so a second repo's goal could never be audited — a dead
 * end with no way out (the same warning lib/goal-prereview-tools.ts:94-95
 * gives for `checkGoalDraft`). The goal binding is `gitRootOfDir`-based there;
 * the audit must resolve the same way or a goal for an unedited repo can never
 * pass its own audit. `resolveToolRepo` stays for review/precommit records,
 * whose verdicts DO bind to an edited repo's worktree.
 */
export function resolveGoalRepo(requested: string | undefined, cwd: string): ToolRepoTarget {
  // No explicit repo: the goal binds to the SESSION repo (its primary root).
  // `cwd` is the session's primary repo/worktree — the same default
  // `checkGoalDraft` uses when `repo` is omitted.
  const abs = pathResolve(cwd, requested ?? cwd);
  const root = gitRootOfDir(abs);
  if (!root) {
    return {
      ok: false,
      error: `review-gate: goal 审计的 repo "${requested ?? cwd}" (resolved ${abs}) is not inside a readable git repository — a goal audit can only target a real repo.`
    };
  }
  return { ok: true, root };
}


/**
 * Everything these tools need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every method is a thing a
 * test replaces with three lines.
 */
export interface AdvisoryPrepareToolDeps {
  /** Which repo does this call target? Never guessed — see repo-resolve.ts. */
  resolveRepo(requested: string | undefined): ToolRepoTarget;
  /** The gate state of one repo (the primary repo's state IS the extension's). */
  stateFor(root: string): GateState;
  /** Persist one repo's state (sidecar + blocked-marker handling). */
  persist(ctx: unknown, root: string): void;
  /** The session's primary repo/worktree directory (goal audit resolves repo against it). */
  cwd: string;
  /** The session dir pi is ACTUALLY using, for the judge's transcript pointer. */
  sessionDir(ctx: unknown): string;
  /** Has the USER approved this repo's loop goal? */
  goalConfirmed(root: string, st: GateState): boolean;
  /** Goal text handed to spawned judges (capped, with a file pointer when truncated). */
  goalTextForReviewers(root: string): { text: string; truncated: boolean } | undefined;
  /** Absolute path of THIS session's loop-goal file. */
  loopGoalPath(root: string): string;
  /** Read a UTF-8 file, or undefined when it does not exist / cannot be read. */
  readText(path: string): string | undefined;
  /** Create a directory (and its parents). Best-effort: failures are ignored. */
  ensureDir(path: string): void;
  /** Files changed since `tree`, or undefined when the increment is unknowable. */
  incrementSinceTree(root: string, tree: string): { files: string[] } | undefined;
  /** HEAD commit tree OID, or "" when it cannot be read. */
  headCommitTree(root: string): string;
}

/**
 * The LAST conclusion an adviser appended for this goal, if any. Lines are
 * JSON; malformed ones are skipped and only a conclusion for THIS goal
 * (the artifact is named per goal, so this is belt-and-braces) counts.
 */
function readLastAdviserConclusion(
  deps: AdvisoryPrepareToolDeps,
  artifactPath: string,
  goalHash: string,
): AdviserConclusion | undefined {
  try {
    const raw = deps.readText(artifactPath);
    if (raw !== undefined) return parseAdviserConclusions(raw, goalHash);
  } catch { /* no artifact yet */ }
  return undefined;
}

// ---------- prepare_adviser (incremental advisory — goal criterion 3) ----------

async function doPrepareAdviser(
  deps: AdvisoryPrepareToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!target.ok) {
    return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
  }
  const st = deps.stateFor(target.root);
  // goalText (display) may be capped for the prompt; the ARTIFACT identity
  // must hash the FULL approved text, or distinct long goals would share
  // one conclusion file (round-4 P1).
  const confirmed = deps.goalConfirmed(target.root, st);
  // Identity hashes the RAW FILE content, never the capped display text:
  // readLoopGoal() truncates past LOOP_GOAL_MAX_CHARS, and two distinct
  // long goals must not share one conclusion artifact (round-5 P1).
  const fullGoalRaw = deps.readText(deps.loopGoalPath(target.root));

  const goalForReview = confirmed ? deps.goalTextForReviewers(target.root) : undefined;
  const goalText = goalForReview?.text;
  const goalHash = confirmed && fullGoalRaw
    ? goalTextHash(fullGoalRaw)
    // No approved goal: a STABLE per-session identity (sessionId is set at
    // session start; "anon" is the defensive fallback) so repeated
    // consultations within one session reuse each other's conclusions —
    // a fresh random id every call would defeat the incremental contract.
    : `no-goal-${st.sessionId ?? "anon"}`;
  const artifactPath = pathJoin(target.root, ".pi", "review-stream", `adviser-${goalHash}.jsonl`);
  // The artifact must be writable on the FIRST consultation too:
  // `prepare_review` creates this directory for its finding stream, but an
  // adviser consult can precede any review.
  deps.ensureDir(pathDirname(artifactPath));
  const previous = readLastAdviserConclusion(deps, artifactPath, goalHash);
  // Baseline advance is CONFIRMATION-BASED (round-3 P1): the baseline must
  // never advance past a consultation that appended no conclusion — its
  // examined changes would silently vanish from the next brief while an
  // older conclusion is carried forward. The gate cannot observe the
  // adviser's write, so it counts VALID conclusions in the artifact:
  //   - count > baseline.confirmed ⇒ the last consultation SUCCEEDED ⇒
  //     changed files are computed against baseline.tree (that consult's
  //     START) and the baseline advances;
  //   - count ≤ baseline.confirmed ⇒ the last consultation ABORTED ⇒
  //     compute against baseline.prevTree (the last CONFIRMED start) so
  //     its changes are re-listed, and do NOT advance. prevTree null ⇒
  //     nothing is confirmed yet (cross-session first advance) ⇒ full
  //     re-check (round-4 P1).
  const artifactRaw = deps.readText(artifactPath) ?? "";
  const confirmedCount = countAdviserConclusions(artifactRaw, goalHash);
  const baseline = st.adviserBaselines?.[goalHash];
  const baseTree = baseline
    ? confirmedCount > baseline.confirmed ? baseline.tree : baseline.prevTree
    : undefined;
  let changedFiles: string[] | null = null;
  if (!baseTree) {
    // No baseline for this goal in this state. An OLDER conclusion may
    // still exist (cross-session artifact): the increment vs it cannot be
    // computed, so demand a full re-check (null) — never pretend "no
    // changes" against a conclusion this session never saw.
    changedFiles = previous ? null : [];
  } else {
    const inc = deps.incrementSinceTree(target.root, baseTree);
    if (inc) changedFiles = inc.files;
    // else: stays null → brief demands a full check
  }
  // Advance ONLY on confirmed success (a conclusion beyond the last
  // count). prevTree = the start the just-confirmed consultation read
  // (baseline.tree), so an aborted NEXT consultation rolls back to
  // exactly this confirmed point instead of hiding its changes.
  if (!baseline || confirmedCount > baseline.confirmed) {
    try {
      const treeNow = deps.headCommitTree(target.root);
      st.adviserBaselines = {
        ...(st.adviserBaselines ?? {}),
        [goalHash]: { tree: treeNow, prevTree: baseline ? baseline.tree : null, confirmed: confirmedCount },
      };
    } catch { /* keep the old baseline */ }
  }
  deps.persist(ctx, target.root);
  const brief = buildAdviserBrief({
    goalHash,
    sessionDir: deps.sessionDir(ctx),
    sessionId: st.sessionId ?? "unknown",
    artifactPath,
    ...(previous ? { previous } : {}),
    changedFiles,
    ...(goalText ? { goalText } : {}),
  });
  const adviserTitle = `adviser-${goalHash.slice(0, 6)}`;
  const goalTruncated = goalForReview?.truncated === true;
  return {
    content: [{ type: "text", text:
      `adviser brief ready (${previous ? "incremental" : "full"}):\n` +
      "- 正常路径是 `judge_submit({role:\"adviser\", task:<你的问题>})`——它内部就调这个工具并派出 adviser。" +
      "单独调本工具只在你要自己拿 brief 时才需要。\n" +
      (goalTruncated ? `- 注意:brief 中的 loop goal 因长度被截断;需要全文时读 ${deps.loopGoalPath(target.root)}。\n` : "") +

      `${TASK_TEXT_MARKER}\n${brief}` }],
    details: { incremental: !!previous, artifactPath, changedFiles, title: adviserTitle },
  };
}

// ---------- prepare_goal_audit (the auditor's ready-made task, PRE-dispatch) ----------

async function doPrepareGoalAudit(
  deps: AdvisoryPrepareToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const target = resolveGoalRepo(typeof params.repo === "string" ? params.repo : undefined, deps.cwd);
  if (!target.ok) {
    return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
  }
  const draft = normalizeGoalText(String(params.goal ?? ""));
  if (!draft) {
    return {
      content: [{ type: "text", text: "review-gate: prepare_goal_audit rejected — the goal text is empty." }],
      details: {},
      isError: true,
    };
  }
  const st = deps.stateFor(target.root);
  const newHash = goalTextHash(draft);
  const prev = st.goalPrereview;
  const carryover = prev && prev.hash !== newHash ? formatGoalPrereviewCarryover(prev) : undefined;
  const taskText = buildGoalAuditTask(draft, {
    ...(carryover ? { carryover } : {}),
    ...(prev?.draft ? { prevDraft: prev.draft } : {}),
    sessionDir: deps.sessionDir(ctx),
    sessionId: st.sessionId ?? "unknown",
  });
  const auditTitle = `goal-audit-${newHash.slice(0, 6)}`;
  return {
    content: [{ type: "text", text:
      `goal-auditor task ready (${carryover ? "re-audit with carryover" : "first audit"}):\n` +
      "- 正常路径是 `judge_submit({role:\"goal-auditor\", task:<草稿>})`——它内部就调这个工具，" +
      "自己派 auditor、解析并记录裁决。单独调本工具只在你要自己拿任务文本时才需要。\n" +
      `${TASK_TEXT_MARKER}\n${taskText}` }],
    details: { reaudit: !!carryover, hash: newHash.slice(0, 12), title: auditTitle },
  };
}

/** Register `prepare_adviser` and `prepare_goal_audit`. */
export function registerAdvisoryPrepareTools(host: ToolHost, deps: AdvisoryPrepareToolDeps): void {
  host.registerTool({
    name: "prepare_adviser",
    label: "Prepare Adviser Brief",
    description:
      "ADVANCED / internal: `judge_submit({role:\"adviser\", task:<your question>})` calls this itself " +
      "and dispatches the adviser — call it directly only to read the brief without consulting anyone. " +
      "Builds the brief for an `adviser` consultation on the CURRENT loop goal: (a) the main " +
      "session's transcript location for ON-DEMAND reading (as its own pi process the adviser does " +
      "not inherit this conversation), " +
      "(b) the artifact path where the adviser appends its conclusion, and (c) when a previous " +
      "consultation of this goal exists, that conclusion plus the files changed since, so the adviser " +
      "settles what already stands instead of re-arguing it from zero. First consultation of a goal is a full brief.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doPrepareAdviser(deps, params, ctx),
  });

  host.registerTool({
    name: "prepare_goal_audit",
    label: "Prepare Goal Audit Task",
    description:
      "ADVANCED / internal: `judge_submit({role:\"goal-auditor\", task:<draft>})` calls this itself, " +
      "dispatches the auditor, adjudicates and records the verdict — call it directly only to read " +
      "the audit task without dispatching anyone. " +
      "Builds the task for a `goal-auditor` audit of a DRAFT loop goal: the draft, the audit " +
      "criteria, the fresh-context transcript " +
      "pointer, and — when a previous audit of a DIFFERENT draft is on record — the carryover block (previous " +
      "verdict + findings + previous draft) and the mechanically computed draft delta, so a re-audit judges " +
      "the increment instead of re-deriving the whole contract.",
    parameters: Type.Object({
      goal: Type.String({ description: "The FULL draft goal text to be audited (the exact text you will submit)" }),
      repo: Type.Optional(Type.String({
        description: "Absolute repo path (required once the session edited several repos)",
      })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doPrepareGoalAudit(deps, params, ctx),
  });
}
