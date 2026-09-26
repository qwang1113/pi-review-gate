/**
 * THE DEPS OF THE THREE INTERNAL PREPARE STEPS — `prepare_review` (the
 * reviewer's round: an immutable `baseline..HEAD`, the polish gate, the
 * findings stream, the review target) and the two advisory builders
 * (`prepare_adviser`, `prepare_goal_audit`). Their rules live in
 * lib/review-prepare-tools.ts and lib/advisory-prepare-tools.ts; this is only
 * what they need from this session, moved out of `extensions/review-gate.ts`
 * (t8, 2026-09-26, wave 4 of the split).
 */

import { mkdirSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdvisoryPrepareToolDeps } from "./advisory-prepare-tools.ts";
import type { GateState } from "./gate-state.ts";
import { gitOrNull, gitText } from "./git-exec.ts";
import { headCommitTree } from "./repo-facts.ts";
import { branchBaseBaseline, squashPointBaseline } from "./review-baseline.ts";
import type { ReviewPrepareToolDeps } from "./review-prepare-tools.ts";
import type { createReviewTargets } from "./review-target-host.ts";
import type { SessionCells } from "./session-cells.ts";
import { sessionDirFromContext } from "./session-dir.ts";
import type { SessionRepos } from "./session-repos-host.ts";
import { incrementSinceTree } from "./worktree-changes.ts";

export interface PrepareWiringDeps {
  repos: Pick<
    SessionRepos,
    "resolveToolRepo" | "stateForRepo" | "persistRepo" | "reviewScopeFor" | "previousRoundFindings" | "settledConclusion"
  >;
  loopGoalConfirmed(root: string, st: GateState): boolean;
  goalTextForReviewers(root: string): { text: string; truncated: boolean } | undefined;
  loopGoalPath(root: string): string;
  reviewTargets: ReturnType<typeof createReviewTargets>["reviewTargets"];
}

const readText = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
};

export function buildReviewPrepareDeps(cells: SessionCells, deps: PrepareWiringDeps): ReviewPrepareToolDeps {
  const { repos } = deps;
  return {
    resolveRepo: (requested) => repos.resolveToolRepo(requested),
    stateFor: (root) => repos.stateForRepo(root),
    persist: (ctx, root) => repos.persistRepo(ctx as unknown as ExtensionContext, root),
    sessionDir: (ctx) => sessionDirFromContext(ctx, cells.cwd),
    goalConfirmed: (root, st) => deps.loopGoalConfirmed(root, st),
    goalTextForReviewers: (root) => deps.goalTextForReviewers(root),
    loopGoalPath: (root) => deps.loopGoalPath(root),
    reviewScope: (root, st) => repos.reviewScopeFor(root, st),
    previousRoundFindings: (st) => repos.previousRoundFindings(st),
    settledConclusion: (st) => repos.settledConclusion(st),
    registerReviewTarget: (root, target, ctx) => {
      deps.reviewTargets.set(root, target);
      // A PARKED READY DOES NOT SURVIVE ITS ROUND (2026-09-15). A new target
      // means a new round was dispatched, so the parked one is history: if the
      // lane that follows ever PASSed on that old tree, replaying it would
      // record a READY the session has already moved past. Clearing it here is
      // what keeps the sidecar from carrying a parked conclusion nobody is
      // waiting on any more.
      const st = repos.stateForRepo(root);
      if (st.pendingReady) {
        delete st.pendingReady;
        repos.persistRepo(ctx as ExtensionContext, root);
      }
    },
    git: {
      // `stdio: "ignore"` on purpose: a rewritten chain is an expected outcome
      // here, and git's "fatal: Not a valid object name" must not reach the
      // USER's stderr.
      isAncestor: (root, maybeAncestor, branch) =>
        gitOrNull(root, ["merge-base", "--is-ancestor", maybeAncestor, branch]) !== null,
      revParse: (root, rev) => gitText(root, ["rev-parse", rev]),
      // The FALLBACK read, with the same two flags as the numstat probe so the
      // two can never disagree about which files moved.
      changedFilesInRange: (root, baseline, head) =>
        gitText(root, ["-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", `${baseline}..${head}`])
          .split("\n").filter(Boolean),
      // The reviewer's read plan is built from this (lib/parallel-review.ts's
      // formatChangeIndex): one call gives both the file list and the sizes.
      //
      // TWO FLAGS THAT ARE SECURITY, NOT TASTE (round-2 P1):
      //  - `--no-renames`: a detected rename prints as the pseudo-path
      //    `old => new`, which the reviewer is told to paste into a shell,
      //    where `>` is a REDIRECT.
      //  - `core.quotePath=false`, so a non-ASCII path is emitted as the bytes
      //    git will accept back rather than as an escaped C string.
      //
      // Binary files report `-` for both counts, read as 0 so a binary file
      // still appears in the index.
      numstatInRange: (root, baseline, head) =>
        gitText(root, ["-c", "core.quotePath=false", "diff", "--numstat", "--no-renames", `${baseline}..${head}`])
          .split("\n").filter(Boolean)
          .map((line) => {
            const [added, deleted, ...rest] = line.split("\t");
            return {
              file: rest.join("\t"),
              added: added === "-" ? 0 : Number(added) || 0,
              deleted: deleted === "-" ? 0 : Number(deleted) || 0,
            };
          })
          .filter((row) => row.file !== ""),
      // The two history probes the baseline resolution consults — decisions OF
      // the prepare module, so both go through its seam.
      branchBaseBaseline: (root) => branchBaseBaseline(root),
      squashPointBaseline: (root, reviewedTree, startSha) =>
        squashPointBaseline(root, reviewedTree, startSha),
      worktreeClean: (root) =>
        gitText(root, ["status", "--porcelain"]) === "",
    },
    readText,
  };
}

/**
 * The two ADVISORY preparations. Neither computes a commit range nor registers
 * a review target, which is exactly why they are a separate module.
 *
 * `cwd` is the value at REGISTRATION time, as it always was — the per-call
 * readers (`sessionDir`) read the live one.
 */
export function buildAdvisoryPrepareDeps(cells: SessionCells, deps: PrepareWiringDeps): AdvisoryPrepareToolDeps {
  const { repos } = deps;
  return {
    resolveRepo: (requested) => repos.resolveToolRepo(requested),
    cwd: cells.cwd,
    stateFor: (root) => repos.stateForRepo(root),
    persist: (ctx, root) => repos.persistRepo(ctx as unknown as ExtensionContext, root),
    sessionDir: (ctx) => sessionDirFromContext(ctx, cells.cwd),
    goalConfirmed: (root, st) => deps.loopGoalConfirmed(root, st),
    goalTextForReviewers: (root) => deps.goalTextForReviewers(root),
    loopGoalPath: (root) => deps.loopGoalPath(root),
    readText,
    ensureDir: (path) => {
      try { mkdirSync(path, { recursive: true }); } catch { /* best-effort */ }
    },
    incrementSinceTree: (root, tree) => incrementSinceTree(root, tree),
    headCommitTree: (root) => headCommitTree(root),
  };
}
