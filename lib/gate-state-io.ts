/**
 * Where the sidecar lives and how it is written: the per-session variant path,
 * the atomic save, and the concurrent-session merge every live write goes through.
 *
 * Split out of lib/gate-state.ts; reading lives in lib/gate-state-load.ts.
 */

import { join } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import type { GoalPrereviewRecord } from "./loop-goal.ts";
import type { GateState } from "./gate-state.ts";
import type { ProxyDecisionRecord } from "./gate-state-records.ts";
import { loadSidecar } from "./gate-state-load.ts";

/**
 * Environment variable that gives a session its OWN sidecar file (F4).
 *
 * THE MEASURED PROBLEM. The sidecar is one file per worktree, and `taskMode`
 * is a single-valued field in it. When an orchestrator supervises a child in
 * the same worktree, the two sessions write the same file: the orchestrator
 * records `taskMode: "orchestrator"`, the child records `taskMode: "loop"`,
 * each `ask_user` record overwrites the other's, and the orchestrator's own
 * prompt ends up quoting the CHILD's unmet gates ("code review gate PENDING")
 * as if they were its own. That is F4 and half of F13.
 *
 * WHY THE CHILD MOVES AND NOT THE ORCHESTRATOR. The obvious fix is to give
 * the orchestrator a special file, and it is the wrong way round. The L3 git
 * hook (`hooks/pre-commit`) resolves the sidecar by this same rule, and a
 * MISSING variable must fail toward the STRICTER file: with children on the
 * variant path, a hook that somehow runs without the variable falls back to
 * the default file — the orchestrator's, an enforced mode with no review —
 * and blocks. With it the other way round, the same accident would check a
 * child's commit against a file the child never wrote and let it through. The
 * fail-closed direction decides it.
 *
 * As a bonus this also separates SERIAL children from each other: two
 * children that run one after another in the same worktree no longer inherit
 * each other's verdicts.
 */
export const STATE_VARIANT_ENV = "RG_STATE_VARIANT";

/** Only these characters may reach a filename. Anything else is dropped. */
const STATE_VARIANT_SAFE = /[^A-Za-z0-9._-]/g;

/**
 * The sidecar variant this process runs under, sanitized, or `undefined` for
 * the default file. Never throws and never returns something that could
 * escape the `.pi/` directory.
 */
export function stateVariantFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[STATE_VARIANT_ENV]?.trim();
  if (!raw) return undefined;
  const safe = raw.replace(STATE_VARIANT_SAFE, "-").replace(/^[.-]+/, "").slice(0, 64);
  return safe.length > 0 ? safe : undefined;
}

export function sidecarPath(cwd: string, configDirName = ".pi", variant?: string): string {
  const safe = variant ? variant.replace(STATE_VARIANT_SAFE, "-").replace(/^[.-]+/, "").slice(0, 64) : "";
  const name = safe.length > 0 ? `review-gate-state.${safe}.json` : "review-gate-state.json";
  return join(cwd, configDirName, name);
}

export function saveSidecar(path: string, state: GateState): void {
  state.updatedAt = new Date().toISOString();
  // `exclusivityRefusal` is this session's own predicament, never a fact about
  // the file: writing it would tell the session that HOLDS this worktree that
  // its worktree is held by somebody else. The refused session is not supposed
  // to reach this function at all (its persist is skipped upstream) — this is
  // the second line of defence, where the bytes are actually produced.
  const { exclusivityRefusal: _refusal, ...persisted } = state;
  // Atomic write: temp + rename, so a crashed write can't leave a truncated
  // JSON that a fail-open parser might half-read (lib/atomic-write.ts).
  writeFileAtomic(path, JSON.stringify(persisted, null, 2) + "\n");
}

/**
 * The UNION of two sessions' proxy decisions, oldest first.
 *
 * NOT a winner-takes-it like the verdict blocks beside it, and the difference is
 * a fact about what this record IS. A verdict is a binding on shared content, so
 * two of them cannot both be the answer; a proxy decision is TESTIMONY about
 * what happened to one session, and dropping one side would tell the user "these
 * were all of them" about a list that was not — the one thing this record cannot
 * get wrong.
 *
 * Deduped by (time, question, choice): the same decision arriving twice (a
 * re-merge of the same side, a relay successor) is still one decision.
 */
export function mergeProxyDecisions(
  mine: readonly ProxyDecisionRecord[] | undefined,
  theirs: readonly ProxyDecisionRecord[] | undefined,
): ProxyDecisionRecord[] {
  const out: ProxyDecisionRecord[] = [];
  const seen = new Set<string>();
  for (const record of [...(mine ?? []), ...(theirs ?? [])]) {
    const key = `${record.at}|${record.question}|${record.choice}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Keep a CONCURRENT session's still-valid bindings alive in the sidecar.
 *
 * The sidecar holds exactly one `sessionId`, and every writer replaces the
 * whole file (atomically, but last-writer-wins). So when two Pi sessions run
 * in the same repo, session B's write erases the READY + PASS that session A
 * had just earned — and since the L3 git hooks read ONLY this file, A's next
 * commit is rejected for a review it actually passed. (A's own in-memory
 * state is untouched, which is exactly why that failure looks so arbitrary:
 * the extension says READY, the hook says PENDING.)
 *
 * This returns the object to WRITE (never mutating `mine`): a foreign
 * READY/PASS is carried over only where this session has NO verdict of its own
 * yet (PENDING / NOT_RUN) and that binding still describes the CURRENT
 * worktree. A verdict of our own always wins — including a bad one. Worst
 * verdict wins is the rule everywhere else in this gate, and two sessions
 * reaching opposite conclusions about one tree is exactly when it matters:
 * a foreign READY must never overwrite our own BLOCKED (nor a foreign PASS
 * our own FAIL) in the file the git hooks trust.
 *
 * Why this is not a fail-open. A carried-over verdict keeps the FINGERPRINT it
 * was earned with, and it is carried over only after that fingerprint is
 * compared against the worktree as it stands right now — so it can authorize
 * a commit only when the tree being committed is byte-for-byte the tree the
 * other session got reviewed. The fingerprint is content-addressed and
 * carries no session identity, so "who ran the review" is irrelevant to what
 * it proves. Any edit by either session changes the digest, and the stale
 * binding is dropped on the very next write.
 *
 * `currentDigest` is a THUNK because the digest costs a full worktree hash and
 * the only case that needs it — a foreign sidecar holding a verdict we lack —
 * cannot occur in a single-session repo, i.e. in almost every repo. A null or
 * empty digest (fingerprint unavailable) drops the binding: a carry-over that
 * cannot be verified must not be written.
 *
 * The carry-over is also short-lived: normally it is gone by this session's
 * next write, because the file then carries our own sessionId and the foreign
 * verdict is indistinguishable from a stale one of ours. Not recognizing it
 * at that point is deliberate — otherwise a binding this session deliberately
 * invalidated could climb back out of the file on a tree that never changed.
 * (Two edges do outlive one write: a re-read of a still-foreign sidecar, and a
 * session restored FROM the sidecar, which inherits it as its own. Both remain
 * fingerprint-bound, so they can still only describe a tree that was reviewed.)
 * Sharing one worktree between sessions therefore stays unreliable by design;
 * this only removes the gratuitous loss of a verdict that is provably valid.
 *
 * Scope is deliberately narrow: only the two verdict blocks and the
 * incremental-review baseline (`lastReviewedTree`). `bypass`,
 * `taskMode`, change flags, scope limits and rounds always stay this
 * session's own — a foreign bypass or advisory mode must never leak in.
 */

export function mergeConcurrentBindings(
  mine: GateState,
  disk: GateState | undefined,
  currentDigest: () => string | null,
): GateState {
  if (!disk) return mine;
  // Round-8/9 P1: auxiliary diagnostic state merges INDEPENDENTLY of any
  // review/precommit candidate — a concurrent session's goal audits and
  // adviser baselines must survive this session's next persist even when
  // neither side carries a READY/PASS to inherit. When nothing aux is at
  // stake, keep the caller's own object (identity-stable: no copy needed).
  const hasAux =
    (disk.goalPrereview && (!mine.goalPrereview || disk.goalPrereview.at > mine.goalPrereview.at)) ||
    !!disk.goalPrereviewHistory?.length ||
    (disk.adviserBaselines && Object.keys(disk.adviserBaselines).length > 0);
  let merged = mine;
  if (hasAux) {
    merged = { ...mine };
    if (disk.goalPrereview && (!mine.goalPrereview || disk.goalPrereview.at > mine.goalPrereview.at)) {
      merged.goalPrereview = disk.goalPrereview;
    }
    if (disk.goalPrereviewHistory?.length) {
      merged.goalPrereviewHistory = mergeGoalPrereviewHistories(mine.goalPrereviewHistory, disk.goalPrereviewHistory);
    }
      if (disk.adviserBaselines && Object.keys(disk.adviserBaselines).length) {
        merged.adviserBaselines = mergeAdviserBaselines(mine.adviserBaselines, disk.adviserBaselines);
    }
  }
  // THE TESTIMONY MERGES FIRST, AND UNCONDITIONALLY (review round 7 P1).
  //
  // A proxy decision is not a binding to inherit — it is a record of what
  // happened to one session, and the three early returns below (two sessions
  // that reached no verdict, a fingerprint that moved on, a same-session
  // re-write) have nothing to say about it. Merging it at the END of this
  // function meant each of those returns threw the other side's record away,
  // and the user's completion report then claimed the surviving list was all of
  // them.
  //
  // IT IS WRITTEN BACK to `mine` as well (same finding): the caller's own
  // object is what the NEXT persist writes from, so a union that lives only in
  // the returned copy is undone by the very next save.
  const proxyUnion = mergeProxyDecisions(mine.proxyDecisions, disk.proxyDecisions);
  if (proxyUnion.length > 0) {
    mine.proxyDecisions = proxyUnion;
    merged = { ...merged, proxyDecisions: proxyUnion };
  }

  // Same session (or an unidentifiable file): our own last write — replace it.
  if (!disk.sessionId || disk.sessionId === mine.sessionId) return merged;

  const candidateReview =
    // PENDING = "no verdict yet". BLOCKED / NEEDS_HUMAN are verdicts, and a
    // concurrent session's READY does not overrule them.
    mine.review.verdict === "PENDING" &&
    disk.review.verdict === "READY" &&
    typeof disk.review.fingerprint === "string" &&
    disk.review.fingerprint.length > 0;
  const candidatePrecommit =
    // Likewise NOT_RUN only: FAIL and NO_CHECKS_RUN are results, not gaps.
    mine.precommit.verdict === "NOT_RUN" &&
    disk.precommit.verdict === "PASS" &&
    typeof disk.precommit.fingerprint === "string" &&
    disk.precommit.fingerprint.length > 0;
  if (!candidateReview && !candidatePrecommit) return merged;

  const digest = currentDigest();
  if (!digest) return merged;
  const keepReview = candidateReview && disk.review.fingerprint === digest;
  const keepPrecommit = candidatePrecommit && disk.precommit.fingerprint === digest;
  if (!keepReview && !keepPrecommit) return merged;

  return {
    ...merged,
    review: keepReview ? { ...disk.review } : mine.review,
    precommit: keepPrecommit ? { ...disk.precommit } : mine.precommit,
    // The incremental-review baseline must survive the carry-over too,
    // otherwise the next round is forced into a full review even though
    // the tree it describes was already reviewed.
    ...(keepReview && disk.lastReviewedTree ? { lastReviewedTree: disk.lastReviewedTree } : {}),
  };
}

/**
 * Union of two audit histories, deduped by (hash, verdict, at), oldest
 * first. A concurrent session's audits must not be erased by this session's
 * persist (round-8 P1).
 */
function mergeGoalPrereviewHistories(
  a: GoalPrereviewRecord[] | undefined,
  b: GoalPrereviewRecord[] | undefined,
): GoalPrereviewRecord[] {
  const seen = new Set<string>();
  const out: GoalPrereviewRecord[] = [];
  for (const rec of [...(a ?? []), ...(b ?? [])]) {
    const key = `${rec.hash}|${rec.verdict}|${rec.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

/**
 * Per-goal adviser baselines, merged key-by-key. `confirmed` counts VALID
 * conclusions and only grows, so the baseline with the higher count is the
 * newer one — a concurrent disk write must never overwrite a baseline THIS
 * session just advanced (round-10 P1: plain spread made the disk copy win
 * even when it was older).
 */
function mergeAdviserBaselines(
  a: Record<string, { tree: string; prevTree: string | null; confirmed: number }> | undefined,
  b: Record<string, { tree: string; prevTree: string | null; confirmed: number }> | undefined,
): Record<string, { tree: string; prevTree: string | null; confirmed: number }> {
  const out = { ...(a ?? {}), ...(b ?? {}) };
  for (const [key, mineVal] of Object.entries(a ?? {})) {
    const diskVal = b?.[key];
    if (diskVal && diskVal.confirmed < mineVal.confirmed) out[key] = mineVal;
  }
  return out;
}

/**
 * saveSidecar + mergeConcurrentBindings: the write path every live session
 * uses. Kept separate from saveSidecar so tests (and any caller that means
 * "persist exactly this") still have a verbatim write.
 *
 * A failed/corrupt read yields `undefined` from loadSidecar and therefore a
 * plain overwrite — identical to the behavior before this existed.
 */
export function saveSidecarPreservingConcurrent(
  path: string,
  state: GateState,
  currentDigest: () => string | null,
): void {
  saveSidecar(path, mergeConcurrentBindings(state, loadSidecar(path), currentDigest));
  // The caller's own object must still show a fresh timestamp: when the merge
  // returned a copy, saveSidecar stamped the copy, not `state`.
  state.updatedAt = new Date().toISOString();
}
