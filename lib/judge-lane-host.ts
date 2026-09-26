/**
 * WHICH LANE a judge round runs in, and how a lane the gate stopped using is
 * retired — moved out of `extensions/review-gate.ts` (t7, wave 3 of the
 * split) beside the dispatch that consumes it (lib/judge-round-dispatch.ts).
 *
 * The POLICY is lib/judge-rotation.ts's; this module supplies the session's
 * facts (the review object, the carryover) and owns the effects of a retire:
 * the window close, the scratch reclaim, the registry row.
 */

import { rmSync } from "node:fs";
import { gitOrNull, gitRaw, gitText } from "./git-exec.ts";
import type { GateState } from "./gate-state.ts";
import {
  findJudgeLane,
  paneIdUsable,
  removeJudge,
  tmuxServerFrom,
  windowClosable,
  type JudgeEntry,
} from "./hierarchy.ts";
import { judgePaneAlive } from "./judge-pane.ts";
import { judgeScratchDir, judgeSessionIdFor, reviewScratchWorktrees, shortRepoHash } from "./judge-process.ts";
import type { JudgeRegistry } from "./judge-registry-host.ts";
import { decideJudgeRotation, judgeObjectId, type JudgeRotationDecision } from "./judge-rotation.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import type { SettledConclusion } from "./review-carryover.ts";
import type { ReviewScopeDecision } from "./review-scope.ts";
import { closeSessionWindow } from "./session-factory.ts";
import type { SessionHost } from "./session-host.ts";

/**
 * What every judge-pane close needs to know about this session's tmux.
 *
 * `opener` used to be here too — the label-bar release compared it against
 * each entry's opener to count "my" panes. That judgement is deleted
 * (2026-09-17, user decision), and with it the parameter: what remains is
 * the pane id to close and the runner that closes it.
 */
export interface JudgeCloseCtx {
  ownPane: string | undefined;
  tmuxServer: string | undefined;
  run: TmuxRunner;
}

export function createJudgeLanes(
  host: SessionHost,
  deps: {
    registry: Pick<JudgeRegistry, "judgeHierarchy" | "setHierarchy" | "dropAudits">;
    runTmux: TmuxRunner;
    loopGoalConfirmed(root: string, st: GateState): boolean;
    reviewScopeFor(root: string, st: GateState): ReviewScopeDecision;
    settledConclusion(st: GateState): SettledConclusion | undefined;
    previousRoundFindings(st: GateState): string[];
  },
) {
  const { judgeHierarchy, setHierarchy, dropAudits } = deps.registry;
  const { runTmux, loopGoalConfirmed, reviewScopeFor, settledConclusion, previousRoundFindings } = deps;
  const stateForRepo = (root: string) => host.stateFor(root);

  /**
   * WHICH review object this repo's judges are serving right now.
   *
   * The priority is lib/judge-rotation.ts's, not this call site's: an
   * orchestration serves its approved PLAN, every other session its approved
   * GOAL. The goal hash counts only while the goal file still carries the
   * user's approval — an edited goal is a different contract, and reusing the
   * transcript of the one it replaced is precisely what the release point
   * exists to stop.
   */
  function judgeObjectIdFor(root: string): string {
    const state = host.state();
    const st = root === host.repos().primary ? state : stateForRepo(root);
    return judgeObjectId({
      orchestrator: state.taskMode === "orchestrator",
      ...(state.orchestrator?.approvedPlanHash ? { planHash: state.orchestrator.approvedPlanHash } : {}),
      ...(loopGoalConfirmed(root, st) && st.loopGoal ? { goalHash: st.loopGoal.hash } : {}),
    });
  }

  /**
   * THE lane resolution — the ONE entry point every judge-starting path calls,
   * exactly once, before it derives anything.
   *
   * It reads the lane the role is currently in (a scan of the registry, since
   * a judge id now CONTAINS its lane and therefore cannot be derived before
   * the decision is made), asks the policy what this round's lane is, and hands
   * back the one action that finishes the move: `retirePrevious`, which closes
   * and forgets the lane this round replaces. Retiring belongs here rather than
   * in each caller for the reason the whole module map exists: the paths that
   * start a judge (`dispatchJudgeRound`, `judge_spawn`'s launch config and task
   * file) must not each reimplement "and close the pane we just stopped using",
   * and one of them would forget.
   *
   * WHY THE RETIRE IS NOT DONE HERE. Dropping the old row is irreversible, and
   * a dispatch can still fail after this call (no tmux, no model chain). The
   * next dispatch would then find NO previous lane, decide `first` at
   * generation 0 — and resume the very transcript that was just rotated away,
   * with the round count back at one and the context reading gone. So the
   * caller calls `retirePrevious()` once the replacement lane is registered.
   * It is idempotent, and a no-op when the lane did not actually change.
   */
  function resolveJudgeLane(root: string, role: string, opener: string): {
    decision: JudgeRotationDecision;
    previous?: JudgeEntry;
    retirePrevious(): void;
  } {
    const previous = findJudgeLane(judgeHierarchy(), { role, repoRoot: root, openerId: opener });
    const decision = decideJudgeRotation({
      objectId: judgeObjectIdFor(root),
      ...(previous === undefined ? {} : { previous }),
    });
    // THE TEST IS THE ID, NOT THE VERDICT. A lane the gate stops using leaves a
    // whole judge behind — its registry row and its live pane — and nothing
    // downstream would ever look at either again, because the registry is
    // keyed by judge id and this round's id is a different one. That happens
    // on a rotation, and it ALSO happens on a decision the policy calls
    // `first`: an entry written by a pre-rotation build carries no lane, so
    // the policy has nothing to compare and says "first" while the derived id
    // still grows a lane suffix. Gating on `rotated` there left the old row in
    // place, and `judgeChildByRole` returns the FIRST match — so `judge_wait`
    // / `judge_close` would address the stale judge instead of the round just
    // dispatched (reviewer P1, 2026-09-05).
    const nextId = judgeSessionIdFor(role, shortRepoHash(root), opener, decision.lane);
    let retired = false;
    const retirePrevious = (): void => {
      if (retired || !previous || previous.judgeId === nextId) return;
      retired = true;
      retireJudgeLane(previous, {
        root,
        ownPane: process.env.TMUX_PANE?.trim() || undefined,
        tmuxServer: tmuxServerFrom(process.env),
        run: (argv: readonly string[]) => runTmux(argv),
      });
    };
    return { decision, ...(previous === undefined ? {} : { previous }), retirePrevious };
  }

  /**
   * The facts a rotated REVIEWER round hands over, gathered from this repo's
   * gate state. Empty for every other case — an unrotated round needs nothing,
   * and another role's hand-off is built by that role's own module.
   */
  function rotationCarryoverFacts(root: string, role: string, decision: JudgeRotationDecision): {
    settled?: SettledConclusion;
    openFindings?: string[];
    delta?: { files: string[]; lines?: number; reviewedFiles?: string[] };
  } {
    if (!decision.rotated || role !== "reviewer") return {};
    const st = root === host.repos().primary ? host.state() : stateForRepo(root);
    const settled = settledConclusion(st);
    const openFindings = previousRoundFindings(st);
    let delta: { files: string[]; lines?: number; reviewedFiles?: string[] } | undefined;
    try {
      const scope = reviewScopeFor(root, st);
      delta = { files: scope.changedFiles, lines: scope.changedLines, reviewedFiles: scope.reviewedFiles };
    } catch {
      // A git read can fail (a repo mid-rebase, a missing tree). The hand-off
      // is still worth sending without its delta; inventing one is not.
      delta = undefined;
    }
    return {
      ...(settled === undefined ? {} : { settled }),
      openFindings,
      ...(delta === undefined ? {} : { delta }),
    };
  }

  /**
   * Close ONE judge's WINDOW.
   *
   * ONE copy, two callers (the `fresh` kill and the lane retire). It was two
   * copies for exactly one round — they sat 150 lines apart and differed only
   * in which variable held the entry, which is how a rule with six copies gets
   * its seventh (reviewer P2, 2026-09-05). Those two copies also each carried
   * a copy of the label-bar release; that whole judgement is gone
   * (2026-09-17), so what is left is the close itself.
   *
   * A WINDOW since 2026-09-25, addressed `<tmuxSession>:<windowId>` from the
   * entry itself, and only when `windowClosable` accepts both halves — a judge
   * from an older build (no window recorded) is not closed by a guess, which
   * is the same fail-closed rule its own `judge_close` applies.
   */
  function closeJudgePaneOf(entry: JudgeEntry, ctx: JudgeCloseCtx): void {
    if (!windowClosable(entry, ctx.tmuxServer)) return;
    try {
      closeSessionWindow(ctx.run, { ownSession: entry.tmuxSession, windowId: entry.windowId });
    } catch { /* best effort */ }
  }

  /**
   * Retire a lane the gate has stopped using: close its pane, forget its
   * row, and let its session dir age out where it stands.
   *
   * The dir is deliberately NOT deleted. "Archived in place" is the user's own
   * shape (2026-09-05): the transcript stays readable, and the existing TTL
   * sweep reclaims it once nothing in the registry points at it — which is
   * true the moment this function returns.
   *
   * CALL IT ONLY ONCE THE REPLACEMENT LANE IS REGISTERED. Dropping the row is
   * what makes the retirement irreversible: a dispatch that fails AFTER this
   * (no tmux, no model chain) would leave the next one with no previous lane
   * at all, and "no previous lane" decides `first` at generation 0 — which
   * resumes the very transcript that was just rotated away, with the round
   * count back at one (reviewer P2, 2026-09-05).
   */
  function retireJudgeLane(
    entry: JudgeEntry,
    ctx: JudgeCloseCtx & { root: string },
  ): void {
    const usable = paneIdUsable(entry, ctx.tmuxServer);
    const alive = usable && entry.paneId
      ? judgePaneAlive(ctx.run, entry.paneId)
      : undefined;
    if (alive === true) closeJudgePaneOf(entry, ctx);
    // The retired lane's scratch worktrees can never be used again — whether
    // its pane was closed here or had already died.
    reapReviewScratch(entry.judgeId);
    setHierarchy(removeJudge(judgeHierarchy(), entry.judgeId));
    // An audit pending against the retired lane dies with it: a report from
    // the NEW lane must never be recorded against a draft it never judged.
    if (entry.role === "goal-auditor") dropAudits(ctx.root);
  }

  /**
   * Reclaim the review worktrees a finished judge left behind (D — "whoever
   * creates it clears it"). A reviewer verifies by doing (`git worktree add
   * <tmp> HEAD` under its gate-owned $TMPDIR); the gate set that $TMPDIR to a
   * per-session dir, so on the judge's exit it can remove exactly those
   * worktrees — never a concurrent lane's live one. Best-effort and idempotent.
   */
  function reapReviewScratch(sessionId: string): void {
    const primaryRepoRoot = host.repos().primary;
    const scratch = judgeScratchDir(sessionId);
    try {
      const list = gitRaw(primaryRepoRoot, ["worktree", "list", "--porcelain"]);
      for (const wt of reviewScratchWorktrees(list, scratch)) {
        try { gitText(primaryRepoRoot, ["worktree", "remove", "--force", wt], { timeout: 0 }); }
        catch { /* already gone / not a registered worktree — the prune below still runs */ }
      }
      gitOrNull(primaryRepoRoot, ["worktree", "prune"]); // best effort
    } catch { /* worktree list unreadable — leave the dir for a later reap */ }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return { resolveJudgeLane, rotationCarryoverFacts, closeJudgePaneOf, reapReviewScratch };
}
