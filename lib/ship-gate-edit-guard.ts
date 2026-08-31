/**
 * The EDIT half of the L1 `tool_call` hook: everything the gate decides about
 * an `edit` / `write` / `NotebookEdit` call before its body runs.
 *
 * It lives here rather than in `extensions/review-gate.ts` for the reason this
 * repository has a rule about (AGENTS.md §"架构规范"): that file is ~7600
 * lines, and it got there one "just add it to the handler" at a time. The
 * tool families moved out first (lib/orchestrator-*-tools.ts,
 * lib/judge-session-tools.ts, lib/review-prepare-tools.ts,
 * lib/copilot-review-tools.ts, lib/user-interaction-tools.ts,
 * lib/goal-tools.ts, lib/gate-command-tools.ts); the HOOKS follow, starting
 * with the biggest one.
 *
 * THE BOUNDARY inside the L1 hook, which is why this is three modules and not
 * one: this module owns what happens to an EDIT (the sensitive-file security
 * floor, the gate-owned exemption, the L8 goal gate, the orchestrator write
 * restriction, the L6 label check); lib/ship-gate-bash.ts owns what happens to
 * a BASH command (the ship gate proper); lib/ship-gate-hook.ts owns the
 * dispatch between them plus the judge-role subagent refusal. Splitting that
 * way is also what keeps all three clear of the 600-line hard block on new
 * source files (lib/file-size-gate.ts).
 *
 * WHAT IS AND IS NOT INJECTED. The pure matchers are imported directly
 * (lib/constants.ts for the path coalescing and the sensitive patterns,
 * lib/sensitive-grant.ts for the normalization and the grant lookup,
 * lib/fingerprint.ts for the gate-owned scope, lib/orchestrator-gate.ts for
 * constraint 2): they are already testable on their own. What IS injected is
 * everything this module cannot own — the session cwd, the gate mode, the live
 * grants, the L8 helper and the L6 classification — so every branch here can
 * be exercised with a fake and no filesystem.
 *
 * BEHAVIOR IS FROZEN: this was moved verbatim out of the extension. The
 * ORDER of the checks is the contract, not an implementation detail — the
 * sensitive-file guard runs before the normal-mode early return because it is
 * a security floor, and the gate-owned exemption runs before the L8 goal gate
 * because otherwise the gate deadlocks on its own files. Both orderings are
 * pinned mechanically in test/extension-structure.test.ts.
 */

import { join as pathJoin, dirname as pathDirname } from "node:path";

import { coalesceToolPath, isSensitiveFile } from "./constants.ts";
import { findGrant, isGateIntegrityPath, normalizeSensitivePath, type SensitiveGrant } from "./sensitive-grant.ts";
import { isGateOwnedPath, mayBeGateOwned } from "./fingerprint.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import { orchestratorWriteBlock } from "./orchestrator-gate.ts";
import type { TaskMode } from "./task-mode.ts";

/** What a `tool_call` handler may answer: a refusal, or nothing at all. */
export type ToolCallBlock = { block: true; reason: string };

/**
 * Everything the edit arm needs from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every member is a thing a
 * test replaces with three lines.
 */
export interface EditGuardDeps {
  /**
   * The session cwd — a GETTER, not a captured string: the extension
   * re-resolves it at `session_start` (pi hands the real working directory
   * only then), so a value captured at registration would normalize paths
   * against the directory pi happened to be launched from.
   */
  cwd(): string;
  /** The session's own repo root — a getter, same reason. */
  primaryRepoRoot(): string;
  /**
   * This session's gate mode, read fresh on every call.
   *
   * `undefined` is the UNDECIDED state and is deliberately part of the type:
   * every branch below is an equality test against a named mode, so undecided
   * falls through to the enforced path (it behaves as loop) rather than
   * silently skipping a check.
   */
  taskMode(): TaskMode | undefined;
  /** A relay successor's handoff document, which an orchestrator may write. */
  relayHandoffPath(): string | undefined;
  /** The live one-time sensitive-file authorizations (never persisted). */
  sensitiveGrants(): readonly SensitiveGrant[];
  /** Has the USER already refused to authorize this exact path this session? */
  sensitiveDeclined(absPath: string): boolean;
  /** The closest ANCESTOR of `p` that exists — resolves a new path's repo. */
  nearestExistingDir(p: string): string;
  /** The L8 edit gate for one write target (explore short-circuit included). */
  loopGoalEditBlockFor(absPath: string | undefined): ToolCallBlock | undefined;
  /** L6: the refusal text for a non-English test label in this edit, if any. */
  checkTestLabels(path: string, input: Record<string, unknown>, ctx: unknown): Promise<string | undefined>;
  /** Record that THIS session has now landed an edit (mode-change consent). */
  markSessionEdited(): void;
}

/**
 * The SECURITY FLOOR, as a pure decision: the refusal an edit gets when it
 * targets a path matching a sensitive-file pattern with no live grant.
 *
 * Extracted from the handler so the one rule that must never regress is
 * testable without a session: the hint it carries depends on whether the path
 * is even ASKABLE (a `.git/` internal or the gate's own verdict files never
 * are, and neither is a path the user already declined).
 */
export function sensitiveEditBlock(input: {
  /** The path as the AGENT spelled it — that is what the message quotes. */
  rawPath: string;
  /** Is the path authorizable at all (not a gate-integrity path, not declined)? */
  askable: boolean;
}): ToolCallBlock {
  return {
    block: true,
    reason:
      `review-gate: "${input.rawPath}" matches a sensitive-file pattern (.env/keys/credentials). ` +
      (input.askable
        ? "Ask the user to edit it themselves, or call request_sensitive_edit to ask them " +
          "for one-time authorization for this exact path."
        : "Ask the user to edit it themselves — this path cannot be authorized from here."),
  };
}

/**
 * The edit arm of the L1 `tool_call` hook.
 *
 * Returns a refusal, or `undefined` to let the edit run. The check order is
 * the contract — see the module docblock.
 */
export async function evaluateEditCall(
  deps: EditGuardDeps,
  input: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolCallBlock | undefined> {
  const cwd = deps.cwd();
  const primaryRepoRoot = deps.primaryRepoRoot();
  const taskMode = deps.taskMode();
  const path = coalesceToolPath(input);
  // FAIL-CLOSED on a pathless edit call (reviewer P1, 2026-08-31):
  // pi-hashline's replace/insert declare `path` OPTIONAL and auto-resolve it
  // from the anchors INTERNALLY — but the gate sees the raw call, where an
  // omitted path would silently skip the sensitive-file floor, the
  // gate-owned exemption check, the orchestrator write restriction and the
  // per-repo L8 binding below (every one of them keys on `path`/`absPath`).
  // The tool itself requires a non-empty path to do anything, so refusing
  // here costs nothing legitimate: the model re-sends with the path spelled
  // out, and the gate then runs every check it is supposed to run.
  if (!path) {
    return {
      block: true,
      reason:
        "review-gate: edit tool call without a `path` — the gate cannot attribute it to a repo, " +
        "so every path-based check (sensitive files, gate-owned paths, the L8 goal, the " +
        "orchestrator write restriction) would be skipped. Re-send the edit with the " +
        "`path` parameter explicitly named; the gate needs it to run its checks.",
    };
  }
  // Match on the NORMALIZED path, not the raw one. `resolve` collapses `.`
  // and `..`, so `.pi/./precommit-cache.json` and `a/../.env` cannot slip
  // past a pattern that anchors on path segments. (The grant lookup below
  // already keyed on the normalized form; matching the raw string here was
  // the inconsistency.)
  const absPath = path ? normalizeSensitivePath(path, cwd) : undefined;
  if (path && absPath && isSensitiveFile(absPath)) {
    // A live grant means the USER already approved this exact path in a
    // dialog (request_sensitive_edit). It is consumed on the successful
    // tool_result, so the pass here is for one landing edit only.
    // `cwd` (the session cwd), not ctx.cwd: the grant is keyed at
    // request time with the same base, and a mismatched base would make a
    // relative path miss its own grant.
    if (!findGrant(deps.sensitiveGrants(), absPath, Date.now())) {
      // absPath in both checks, so the hint matches what the tool would do.
      const askable = !isGateIntegrityPath(absPath) && !deps.sensitiveDeclined(absPath);
      return sensitiveEditBlock({ rawPath: path, askable });
    }
  }
  // Normal mode (“as if not installed” — consent-free first classification,
  // /tmp clamp, no-UI session_start, or later user consent): the L6 label check
  // (and its LLM call) is skipped. The sensitive-file guard ABOVE runs in
  // every mode: it is a security floor, not workflow enforcement.
  if (taskMode === "normal") return undefined;
  // Explore mode does NOT block edits: the system prompt asks the agent to
  // prefer read-only work, but small edits during an investigation are
  // allowed. Sensitive-file and L6 label checks above/below stay active.
  //
  // USER REQUIREMENT: a passed edit counts as THIS session's work — from
  // here on, any mode change (including the first classification) goes
  // through the normal consent rules. Blocked edits (sensitive file / L6 /
  // L8 goal) and normal-mode edits do not set it: they change nothing.
  //
  // Gate-owned writes (.pi/, .pi-subagents/) are excluded for the same
  // reason tool_result skips them: everything under those dirs is invisible
  // to a review (excluded from the fingerprint AND from changedFiles), so
  // no edit there is session WORK — the gate's own sidecar, a loop goal, a
  // subagent artifact and the project config alike. Counting them would
  // suppress the "changes pre-date this session" hint and force consent for
  // a mode change the agent never earned. mayBeGateOwned pre-filters on
  // the raw path, so ordinary edits pay no filesystem cost here. The
  // exemption comes BEFORE the L8 goal gate on purpose: without it the
  // gate would deadlock on its own files (the goal file itself, the
  // sidecar, the project config) before a goal can even be approved.
  if (path) {
    const abs = path.startsWith("/") ? path : pathJoin(cwd, path);
    // nearestExistingDir: a write creating a NEW nested gate-owned path
    // (e.g. .pi/plan/state.json) must still resolve its repo instead of
    // losing the exemption to the primary-repo fallback (round P2).
    if (mayBeGateOwned(abs) && isGateOwnedPath(abs, gitRootOfDir(deps.nearestExistingDir(pathDirname(abs))) ?? primaryRepoRoot)) {
      return undefined;
    }
  }
  // L8 edit gate (HARD): in loop mode (or undecided, which behaves as
  // loop) an edit/write call requires a loop goal the USER approved — for
  // THE REPO THE WRITE LANDS IN. The goal must be negotiated BEFORE the
  // work starts: blocking at ship time only is theatre, because by then
  // the agent has already written its own exit contract. Each repo is
  // checked against its own sidecar confirmation, so one repo's approved
  // goal never opens another repo's write surface. Path-less edit calls
  // cannot be attributed to a repo, so they fail closed against the
  // primary repo.
  // (Reaching this line means the write is a normal edit: the sensitive
  // floor passed above and the gate-owned exemption already returned.)
  const goalBlock = deps.loopGoalEditBlockFor(absPath);
  if (goalBlock) return goalBlock;
  // CONSTRAINT 2 — an orchestrator does not write code. Only its plan
  // (already exempt above, it lives under `.pi/`) and its handoff /
  // report documents pass; everything else is delegated work. Placed
  // after the L8 goal gate so the two never disagree about which refusal
  // the author sees first.
  if (taskMode === "orchestrator" && path) {
    // F2 — a write OUTSIDE the repository is allowed. `absPath` is what
    // decides it: only a path that resolves inside the repo root is
    // judged against the in-repo whitelist. A path the resolver could not
    // make absolute stays fail-closed (treated as in-repo), because
    // "unknown location" must never buy the wider permission.
    const insideRepo = !absPath || absPath.startsWith(primaryRepoRoot + "/");
    const rel = absPath && insideRepo ? absPath.slice(primaryRepoRoot.length + 1) : path;
    const orchestratorBlock = orchestratorWriteBlock({
      relPath: rel,
      taskMode,
      relayHandoffPath: deps.relayHandoffPath(),
      outsideRepo: !insideRepo,
    });

    if (orchestratorBlock) return { block: true, reason: orchestratorBlock };
  }
  // L6 label check. NOTE the ordering: it runs AFTER the gate-owned
  // exemption and the L8 goal gate on purpose — a gate-owned write (.pi/
  // test files included) or a goal-blocked write pays neither the L6
  // classification nor its LLM call.
  if (path) {
    const labelProblem = await deps.checkTestLabels(path, input, ctx);
    if (labelProblem) return { block: true, reason: labelProblem };
  }
  deps.markSessionEdited();
  return undefined;
}
