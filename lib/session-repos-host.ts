/**
 * THE SESSION'S REPOS — the per-repo gate state, how a repo is named in a
 * message, which repo a tool targets, and the review-scope facts of each.
 * Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split).
 *
 * The gate's sidecar + fingerprint bind to the SESSION repo (cwd's git root).
 * When the agent edits or ships from ANOTHER git repository (sibling checkout,
 * submodule, …), that repo gets its OWN sidecar + fingerprint
 * (lib/repo-resolve.ts). The primary repo's state IS `cells.state`; every other
 * repo's is loaded lazily into `cells.repoStateCache`.
 */

import { join as pathJoin, resolve as pathResolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acceptanceStatusLine } from "./acceptance-round.ts";
import { blockedMarkerPath, recordBlockedMarker, reconcileBlockedMarker } from "./blocked-marker.ts";
import { copilotProblems } from "./copilot-review-state.ts";
import { armingFromFacts } from "./gate-arming.ts";
import { emptyState, type GateState } from "./gate-state.ts";
import { saveSidecarPreservingConcurrent } from "./gate-state-io.ts";
import { loadSidecar } from "./gate-state-load.ts";
import { unmetRequirements } from "./gate-state-requirements.ts";
import { inheritGoalContract } from "./gate-state-transitions.ts";
import type { createJudgeLanes } from "./judge-lane-host.ts";
import { judgeWorkDirFor } from "./judge-lifecycle.ts";
import { shortRepoHash } from "./judge-process.ts";
import { hasTranscript } from "./judge-round-dispatch.ts";
import { judgeRemembersPreviousRound } from "./judge-rotation.ts";
import { sessionSidecarPath } from "./loop-goal-host.ts";
import { commitsAheadOfBase, digestForMerge, headCommitTree, unreviewedTreesSince } from "./repo-facts.ts";
import { gitRootOfDir, resolveToolRepoTarget } from "./repo-resolve.ts";
import type { SettledConclusion } from "./review-carryover.ts";
import { decideReviewScope, type ReviewScopeDecision } from "./review-scope.ts";
import type { SessionCells } from "./session-cells.ts";
import { stateOwnership } from "./session-inheritance.ts";
import { changedFiles, incrementSinceTree } from "./worktree-changes.ts";

export interface SessionReposDeps {
  persist(ctx?: ExtensionContext): void;
  /** A judge / worker / refused session writes no gate state (and records why). */
  noteGateStatePersistSkip(ctx?: ExtensionContext): boolean;
  callerIdentity(): string | undefined;
  resolveJudgeLane: ReturnType<typeof createJudgeLanes>["resolveJudgeLane"];
}

export function createSessionRepos(cells: SessionCells, deps: SessionReposDeps) {
  /** State for a repo. The primary repo IS `state`; every other repo gets a
   *  lazily loaded/cached independent state. A sidecar left over from a
   *  DIFFERENT session is not trusted: we start fresh but preserve the fact
   *  that the worktree holds changes (fail-closed — pre-existing uncommitted
   *  work must still arm the gate). */
  function stateForRepo(root: string): GateState {
    const state = cells.state;
    if (root === cells.primaryRepoRoot) return state;
    let s = cells.repoStateCache.get(root);
    if (!s) {
      const existing = loadSidecar(sessionSidecarPath(root));
      const owner = stateOwnership(process.env, state.sessionId, existing?.sessionId);
      if (owner === "mine" && existing) {
        s = existing;
      } else {
        s = emptyState(state.sessionId ?? null, cells.projectConfig.maxRounds);
        const files = changedFiles(root);
        // SAME RULE as every other arming site (`lib/gate-arming.ts`, 2026-09-20),
        // and BOTH facts — the branch-ahead half included (review round 1 P1):
        // a secondary repo whose only work is already committed would otherwise
        // read as "nothing to review" to that repo's ship gate, which is the
        // fail-open F1 closed for the primary repo. The sync helper exists for
        // this call site (it is a synchronous state factory).
        const armed = armingFromFacts({ files: files ?? [], commitsAhead: commitsAheadOfBase(root) });
        if (armed.hasCodeChange || armed.hasDocChange) {
          s.hasCodeChange = armed.hasCodeChange;
          s.hasDocChange = armed.hasDocChange;
          s.review.verdict = "PENDING";
          s.precommit.verdict = "NOT_RUN";
        }
        // A relay successor continues the same work in EVERY repo it touched,
        // so a SECONDARY repo's sidecar is inherited on the same terms as the
        // primary one — one rule, one function (`lib/session-inheritance.ts`'s
        // `stateOwnership`), no second copy of it here. Without it, the moment
        // the successor touched its second repo the gate would ask it to
        // negotiate a goal it already has (reviewer P2, round 1).
        if (owner === "inherited" && existing) s = inheritGoalContract(s, existing);
      }
      // THE STAGE SWITCHES ARE A SESSION FACT, carried into every repo this
      // session writes (2026-09-22, lib/loop-stages.ts): the box is answered
      // once for the session, so a second repo must not read "no record" as
      // "all five on" — the L3 hooks read the repo-local sidecar, and they
      // would otherwise keep blocking on a stage the user switched off. A
      // repo that carries its own record keeps it.
      if (s.stages === undefined && state.stages !== undefined) s.stages = state.stages;
      cells.repoStateCache.set(root, s);
    }
    return s;
  }

  /** Persist a repo's state: the primary repo goes through persist() (session
   *  entry + widget + .blocked handling); other repos write their own sidecar
   *  (the same fail-closed .blocked marker on write failure). Each repo's
   *  marker is reclaimed strictly against its OWN path — one repo's successful
   *  write says nothing about another repo's failed one. */
  function persistRepo(ctx: ExtensionContext, root: string) {
    // The primary repo goes through persist() — which arms the L7 watcher for
    // it (as it does for every other persist).
    if (root === cells.primaryRepoRoot) { deps.persist(ctx); return; }
    // The SECOND repo's sidecar is gate state too — a judge is barred from it
    // for exactly the same reason, and this path does not go through persist().
    if (deps.noteGateStatePersistSkip(ctx)) return;
    const s = stateForRepo(root);
    try {
      saveSidecarPreservingConcurrent(sessionSidecarPath(root), s, () => digestForMerge(root));
      reconcileBlockedMarker(blockedMarkerPath(sessionSidecarPath(root)), { sessionId: s.sessionId });
    } catch {
      recordBlockedMarker(blockedMarkerPath(sessionSidecarPath(root)), { sessionId: s.sessionId });
    }
  }

  /** Human label for a repo in messages. The primary repo has no distinctive
   *  name of its own in a single-repo session, but in a MULTI-repo session an
   *  unlabelled problem line is exactly what made a real session unfixable:
   *  the agent read "code review gate is PENDING" as being about the repo it
   *  had just reviewed (a different one) and looped forever. So label by
   *  directory name whenever more than one repo is in play — falling back to
   *  the full path when two checkouts share a basename (two `api` clones
   *  labelled `[api]` would recreate the very ambiguity this removes). */
  function repoLabel(root: string): string {
    const multi = cells.sessionRepos.size > 1;
    if (root === cells.primaryRepoRoot && !multi) return "session repo";
    const name = root.split("/").pop() || root;
    const collides = knownRepoRoots().some((r) => r !== root && (r.split("/").pop() || r) === name);
    return collides ? root : name;
  }

  /** Every repo this session is accountable for, primary first. */
  function knownRepoRoots(): string[] {
    const roots = [...cells.sessionRepos];
    if (!roots.includes(cells.primaryRepoRoot)) roots.unshift(cells.primaryRepoRoot);
    return roots;
  }

  /**
   * Say WHERE the last READY actually landed when a ship is blocked.
   *
   * In the session that motivated this, every round's READY was recorded
   * against the last-edited repo while the commit ran in another one; the
   * block message named neither, so the agent concluded the sidecar was being
   * reset by a stray process and retried the same futile loop seven times.
   * Naming both ends turns that dead end into an actionable next step.
   *
   * Deliberately worded as a diagnosis, never as permission: the verdict
   * quoted here belongs to a different repo and authorizes nothing.
   */
  function crossRepoVerdictHint(blockedRoots: string[]): string {
    if (blockedRoots.length === 0) return "";
    const elsewhere = knownRepoRoots().filter(
      (r) => !blockedRoots.includes(r) && enforcementStateFor(r)?.review.verdict === "READY",
    );
    if (elsewhere.length === 0) return "";
    return (
      `\nnote: a READY review is recorded on ${elsewhere.join(", ")} — not on ${blockedRoots.join(", ")}. ` +
      "A verdict counts only for the repo it was recorded against, so it does not unblock this one: " +
      'run the loop for the blocked repo: `judge_submit({role:"reviewer", repo:"<that repo path>", task:<what you changed there>})` ' +
      "— the gate runs that repo's own precommit, checkpoint and review, and records the verdict against it."
    );
  }

  /**
   * Gate summary for every repo BESIDES the session repo, for /gate-status.
   *
   * /gate-status used to report the session repo only, so a session working
   * across several repos saw "ship gate: OPEN" while the repo it was about to
   * commit was still PENDING — the status readout actively confirmed the
   * wrong mental model. Each repo is now listed with its own verdicts and its
   * own unmet requirements.
   *
   * This hashes each repo's worktree (~0.5s on a large repo), which is why it
   * lives in the user-invoked command and not on any hot path.
   */
  function otherRepoStatus(): { lines: string[]; blocked: boolean } {
    const others = knownRepoRoots().filter((r) => r !== cells.primaryRepoRoot);
    if (others.length === 0) return { lines: [], blocked: false };
    const lines = ["", `other repos edited this session (${others.length}):`];
    let blocked = false;
    for (const root of others) {
      const st = enforcementStateFor(root);
      if (!st) {
        // Sidecar missing or owned by a different session: nothing verifiable.
        // Reported explicitly rather than skipped — a skipped repo reads as a
        // green one. Mirror the ship gate's own rule for this case (see the
        // `else` branch of the ship check): only DIRTY or unverifiable repos
        // actually block, so a clean one is not escalated to a warning.
        const files = changedFiles(root);
        const dirty = files === undefined || files.length > 0;
        if (dirty) blocked = true;
        lines.push(
          `  ${root}: no usable gate state — ` +
          (files === undefined
            ? "worktree unverifiable, ships from it are refused"
            : files.length > 0
              ? `${files.length} uncommitted change(s), so ships from it are blocked`
              : "clean, so it blocks nothing"),
        );
        continue;
      }
      const unmet = unmetRequirements(st, headCommitTree(root), false, {
        requireDocSync: cells.projectConfig.docSync,
        unreviewedCommits: unreviewedTreesSince(root, st.review),
      });
      if (unmet.length) blocked = true;
      lines.push(
        `  ${root}: review=${st.review.verdict} precommit=${st.precommit.verdict} ` +
        `changes=${st.hasCodeChange ? "code" : st.hasDocChange ? "docs" : "none"} — ` +
        (unmet.length ? `BLOCKED: ${unmet.join("; ")}` : "OPEN"),
      );
      // THE ACCEPTANCE RECORD RIDES ALONG (quality round P2, 2026-09-22): the
      // round is decided PER REPO since this same day, so a secondary repo's
      // READY / SKIPPED (with its reason) / BLOCKED would otherwise exist only
      // in a sidecar nobody reads — the same "recorded is not enough" rule the
      // primary's own line above obeys. Rendered only when there is one.
      const acceptanceLine = acceptanceStatusLine(st.acceptance);
      if (acceptanceLine !== undefined) lines.push(`    ${acceptanceLine}`);
    }
    return { lines, blocked };
  }

  /**
   * Resolve the repo the verdict recorder / `run_precommit` targets.
   *
   * Before this existed both steps wrote to `activeRepoRoot`, which only an
   * edit-tool call could move: a session whose last edit was in repo B could
   * never record a verdict for repo A again, so A's commit stayed blocked no
   * matter how many review rounds ran. Resolution (and the multi-repo
   * "be explicit" rule) lives in resolveToolRepoTarget; see its docstring for
   * why auto-retargeting was rejected as fail-open.
   */
  function resolveToolRepo(requested?: string) {
    return resolveToolRepoTarget({
      requested,
      sessionRepos: knownRepoRoots(),
      activeRepo: cells.activeRepoRoot.current,
      primaryRepo: cells.primaryRepoRoot,
      resolveAbsolute: (p) => pathResolve(cells.cwd, p),
      // Same normalization sessionRepos/repoStateCache keys use: a symlinked
      // or subdirectory path must never mint a SECOND state for one repo
      // (two states for one root is the one way this could fail open).
      resolveRoot: (dir) => gitRootOfDir(dir) ?? null,
    });
  }

  /** State used for ENFORCEMENT checks (ship gate, declare_done): the
   *  primary's live state, or a sidecar THIS session may rely on — its own, or
   *  the predecessor's this handoff continued. A sidecar from anybody else is
   *  NOT trusted here (same rule as stateForRepo, from the same function): it
   *  falls through to undefined so the caller's fail-closed "no gate state"
   *  handling applies (a never-edited repo with uncommitted work blocks
   *  shipping from it). */
  function enforcementStateFor(root: string): GateState | undefined {
    if (root === cells.primaryRepoRoot) return cells.state;
    // THE CACHE IS NOT A SOURCE OF OWNERSHIP (quality round P1, 2026-09-16).
    // This used to be `repoStateCache.get(root) ?? …`, and `stateForRepo`
    // fills that cache for any repo this session merely READ — `settleFinishedRounds`
    // alone walks `sessionRepos` on every settle. So whether a repo counted as
    // this session's own came down to who looked first: a cold cache failed a
    // never-recorded repo closed, a warm one waved it through
    // `unmetRequirements` with nothing unmet. Same repo, two answers, on the
    // path that decides whether work may ship.
    //
    // ONE LOADER, ONE ANSWER (same round, after the reviewer measured the
    // first fix): ownership is read from the DISK through the rule
    // `stateForRepo` also uses, and — that answered — the state itself comes
    // from that SAME loader, so both readers return one object. A repo of ours
    // is adopted as it stands; the predecessor's is carried exactly the way the
    // primary repo is (a fresh state with the user's contracts on it, never the
    // predecessor's verdicts — which is why the raw sidecar must never be
    // handed out here).
    const onDisk = loadSidecar(sessionSidecarPath(root));
    if (stateOwnership(process.env, cells.state.sessionId, onDisk?.sessionId) === "foreign") return undefined;
    return stateForRepo(root);
  }

  /**
   * The path as the REPOSITORY sees it — the form `git status`, `git ls-files`
   * and a reviewer's findings all use (changedFiles() emits the same form; edit
   * tools may pass absolute).
   *
   * ROOT-RELATIVE, NOT `cwd`-RELATIVE (review round 1 P1, drill F3). A session
   * launched inside a subdirectory used to record `x.ts` for `<root>/sub/x.ts`:
   * that matched nothing downstream. The checkpoint's "did this session write
   * it" test compares against git's root-relative paths, so the session's own
   * new file was left out of its own commit; and a file inside the repo but
   * outside that `cwd` was recorded as an ABSOLUTE path, which
   * `lib/out-of-repo-paths.ts` reads as "this child wrote outside the repo".
   * A path genuinely outside the repository still comes back absolute — that is
   * the signal that module needs.
   */
  function repoRelative(p: string): string {
    const abs = p.startsWith("/") ? p : pathJoin(cells.cwd, p);
    const root = cells.primaryRepoRoot;
    return abs.startsWith(root + "/") ? abs.slice(root.length + 1) : abs;
  }

  /**
   * How much of this round the reviewer must deep-read.
   *
   * Collects the git facts (increment since the last approved tree, what that
   * review covered) PLUS the one fact that is not about the code — whether the
   * judge taking the round still holds the previous round's reasoning — and
   * hands them all to the pure decision function. Every missing fact resolves
   * to a FULL review; see lib/review-scope.ts.
   *
   * The reader-side fact is gathered HERE rather than at each call site so all
   * three consumers (the reviewer's task text, the turn-end directive, the
   * timing record) describe the same round the same way.
   */
  function reviewScopeFor(root: string, st: GateState): ReviewScopeDecision {
    // WHAT THIS SESSION HAS READ — any concluded round, BLOCKED included.
    // `settledConclusion` below asks the narrower question (what was
    // CONFIRMED) and still demands a READY.
    const base = st.lastReviewedTree;
    // No settled tree ⇒ full anyway. Returning before the lane probe keeps a
    // session that has never had a READY free of a registry scan and a
    // directory read on every turn.
    if (!base) return decideReviewScope({});
    const increment = incrementSinceTree(root, base.treeOid);
    return decideReviewScope({
      baseTree: base.treeOid,
      changedFiles: increment?.files,
      changedLines: increment?.lines,
      previouslyReviewedFiles: base.files,
      judgeRemembersPreviousRound: reviewerRemembersPreviousRound(root),
    });
  }

  /**
   * WILL THIS REPO'S NEXT REVIEWER STILL REMEMBER THE ROUND THAT SETTLED?
   *
   * The lane judgement is `resolveJudgeLane`'s, not a second copy of it: the
   * dispatch that actually opens the reviewer asks the same function, so the
   * scope this decides and the transcript that round lands in cannot disagree.
   * Reading it here is free of consequence — the returned `retirePrevious` is
   * a closure, and nothing but a caller that invokes it retires anything.
   *
   * FAIL-SAFE AT EVERY UNKNOWN: no caller identity, no transcript, or a lane
   * the policy did not call `reuse` all come back `false`, and `false` only
   * ever buys a deeper review.
   */
  function reviewerRemembersPreviousRound(root: string): boolean {
    const opener = deps.callerIdentity();
    if (!opener) return false;
    const { decision } = deps.resolveJudgeLane(root, "reviewer", opener);
    const workDir = pathJoin(root, judgeWorkDirFor("reviewer", shortRepoHash(root), opener, decision.lane));
    return judgeRemembersPreviousRound({
      decision,
      transcriptExists: hasTranscript(pathJoin(workDir, "sessions")),
    });
  }

  /** Findings the previous round left on the table, for the next reviewer. */
  function previousRoundFindings(st: GateState): string[] {
    const last = st.rounds[st.rounds.length - 1];
    if (!last || last.verdict === "READY") return [];
    // Only the fingerprints are persisted (the issue prose is not), which is
    // enough to make the reviewer look each one up and re-check it.
    return last.fingerprints.slice(0, 20);
  }

  /**
   * The conclusion the previous round already reached, so the next reviewer
   * builds on it instead of re-deriving it. Only the READY verdict the
   * increment is measured against qualifies: an unapproved tree has settled
   * nothing. Undefined when there is no such review (⇒ a full round anyway).
   */
  function settledConclusion(st: GateState): SettledConclusion | undefined {
    const base = st.lastReviewedTree;
    // ONLY A READY SETTLES ANYTHING (2026-09-19). A BLOCKED tree is one the
    // previous round READ — which is why `reviewScopeFor` uses it — but nothing
    // about it was approved, and handing it to the next reviewer as settled
    // would tell it to skip exactly the content the previous round refused.
    if (!base || base.verdict !== "READY") return undefined;
    // `rounds` is the recorded-round COUNT at directive time, not the round
    // that produced the verdict (rounds recorded after it are included) — the
    // directive words it that way too.
    return { verdict: "READY", at: base.at, rounds: st.rounds.length };
  }

  /** Is the L7 loop active for this repo's state? (mode + project config) */
  function copilotEnabled(st: GateState): boolean {
    return cells.projectConfig.copilotReview.enabled && st.taskMode !== "normal";
  }

  /**
   * Copilot problems for one repo — a COMPLETION-only requirement.
   * Never consulted by the ship gate (see lib/copilot-review.ts header).
   *
   * The AWAITING line stays in the revival nudge too: the wait itself is
   * `copilot_review`'s blocking call, so a session whose turn ended mid-wait is
   * told to call it again — never to sit idle until something wakes it
   * (AGENTS.md 总则: no turn ends before declare_done).
   */
  function copilotProblemsFor(st: GateState | undefined): string[] {
    if (!st || !copilotEnabled(st)) return [];
    return copilotProblems(st.copilot);
  }

  /** The directory `gh` should run in for a given repo root. */
  function repoDirFor(root: string): string {
    return root === cells.primaryRepoRoot ? cells.cwd : root;
  }

  /**
   * The same fact, labelled per repo, for every repo this session tracks —
   * the completion-only Copilot list both `declare_done` and the L2 loop read.
   */
  function copilotProblemsAcrossRepos(): string[] {
    const out: string[] = [];
    for (const root of cells.sessionRepos) {
      const st = root === cells.primaryRepoRoot ? cells.state : stateForRepo(root);
      for (const p of copilotProblemsFor(st)) {
        out.push(root === cells.primaryRepoRoot ? p : `[${repoLabel(root)}] ${p}`);
      }
    }
    return out;
  }

  return {
    stateForRepo,
    persistRepo,
    repoLabel,
    knownRepoRoots,
    crossRepoVerdictHint,
    otherRepoStatus,
    resolveToolRepo,
    enforcementStateFor,
    repoRelative,
    reviewScopeFor,
    previousRoundFindings,
    settledConclusion,
    copilotEnabled,
    copilotProblemsFor,
    copilotProblemsAcrossRepos,
    repoDirFor,
  };
}

export type SessionRepos = ReturnType<typeof createSessionRepos>;
