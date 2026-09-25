/**
 * The REQUEST half of `copilot_review` (lib/copilot-review-tools.ts): ask
 * GitHub for the Copilot review, then CONFIRM that it was queued.
 *
 * Split out of the tool module so the tool file keeps only the tool body and
 * its registration. The confirmation's window and probe live in
 * lib/copilot-queue-probe.ts.
 */

import type { ToolReply } from "./tool-host.ts";
import type { GateState } from "./gate-state.ts";
import { ghError } from "./copilot-gh.ts";
import { recordCopilotRequest } from "./copilot-review-state.ts";
import type { CopilotSupport, PrSummary } from "./copilot-probe-parse.ts";
import {
  COPILOT_LANDING_GRACE_MS,
  decideCopilotWait,
  type CopilotQueueEvidence,
} from "./copilot-watch.ts";
import {
  COPILOT_CONFIRM_ATTEMPTS,
  COPILOT_CONFIRM_RETRY_ATTEMPTS,
  confirmQueued,
  observationOf,
} from "./copilot-queue-probe.ts";
import { releaseReply } from "./copilot-review-replies.ts";
import type { CopilotReviewToolDeps } from "./copilot-review-tools.ts";

// ---------------------------------------------------------------------------
// The request phase: ask GitHub, then CONFIRM that it was queued
// ---------------------------------------------------------------------------

/**
 * Ask GitHub for a Copilot review of this PR, and prove that it landed.
 *
 * WHY IT CONFIRMS. A successful `gh pr edit --add-reviewer @copilot` exits 0
 * even on a repository where GitHub silently drops the request (measured, see
 * lib/copilot-review.ts), so the exit code alone decides nothing. The QUEUE
 * FLAG does: `reviewRequests` listing `copilot-pull-request-reviewer` is proof
 * that the request is live, and it arrives within ~63s (median 35s over 51
 * measured requests). A request that never shows up is sent once more and then
 * released — the alternative, discovered the hard way, is a 20-minute wait for
 * something that was never queued.
 *
 * The confirmation therefore costs the request path a bounded window
 * (`COPILOT_CONFIRM_ATTEMPTS` × 15s, usually cut short on the first probe),
 * and it buys the two things the old flow never had: an honest "queued /
 * Copilot is working" answer, and an early exit when the answer is "never".
 */
export async function doRequestPhase(args: {
  deps: CopilotReviewToolDeps;
  ctx: unknown;
  root: string;
  st: GateState;
  dir: string;
  slug: string;
  pr: PrSummary;
  support: { support: CopilotSupport; confirmed: boolean };
  signal: AbortSignal | undefined;
  progress: { step(message: string): void; done(message: string): void };
}): Promise<ToolReply> {
  const { deps, ctx, root, st, dir, slug, pr, support, signal, progress } = args;
  progress.step("请求 Copilot 审查");
  const requested = await deps.gh.requestCopilotReviewer(dir, pr, slug, signal);
  if (!requested.ok) {
    // An abort is the user pressing ESC, not GitHub refusing: it proves
    // nothing about Copilot, so it must not release the requirement.
    if (signal?.aborted) {
      return {
        content: [{
          type: "text",
          text: "review-gate: aborted before the Copilot review request completed — nothing " +
            "recorded; call copilot_review again.",
        }],
        details: { status: "ARMED", pr: pr.number },
      };
    }
    const why = ghError(requested, "the review request was refused");
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: `Copilot review could not be requested: ${why}`,
      text: `review-gate: Copilot code review is not available for PR #${pr.number} — ${why}. ` +
        "Requirement released (UNSUPPORTED).",
      details: { pr: pr.number },
      // The cycle binds to the head the request was made against.
      head: pr.head,
    });
  }
  const nowIso = new Date().toISOString();
  progress.step("确认 GitHub 是否已排队");
  let confirmed = await confirmQueued({
    deps, dir, slug, prNumber: pr.number, requestedAt: nowIso, signal, progress,
    attempts: COPILOT_CONFIRM_ATTEMPTS,
  });
  if (confirmed.queued === false && !confirmed.startedAt && !signal?.aborted) {
    // One retry: a request GitHub never registered is not evidence about
    // Copilot, and the measured fix for the dropped-request case is to send it
    // again, not to wait 30 minutes for it.
    progress.step("请求没有被记录 —— 再发一次");
    const again = await deps.gh.requestCopilotReviewer(dir, pr, slug, signal);
    if (again.ok) {
      confirmed = await confirmQueued({
        deps, dir, slug, prNumber: pr.number, requestedAt: nowIso, signal, progress,
        attempts: COPILOT_CONFIRM_RETRY_ATTEMPTS,
      });
    }
  }
  // Still nothing: before releasing, judge the timeline. A run that started and
  // failed is a different story from a request that vanished.
  const timeline = confirmed.timeline
    ?? (signal?.aborted ? undefined : await deps.gh.fetchCopilotTimeline(dir, slug, pr.number, signal));
  const evidence: CopilotQueueEvidence = {
    queued: confirmed.queued,
    workStartedAt: timeline?.workStartedAt ?? null,
    workFailedAt: timeline?.workFailedAt ?? null,
  };
  // The confirmation window IS `COPILOT_LANDING_GRACE_MS`, so it is judged as
  // a window that has already closed — one implementation of the rule, not a
  // second one that could disagree with the state machine.
  const verdict = decideCopilotWait({
    evidence,
    requestedAt: nowIso,
    now: Date.parse(nowIso) + COPILOT_LANDING_GRACE_MS,
  });
  if (verdict.state === "not-landed") {
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: "GitHub never queued the Copilot review request (retried once, no pending reviewer and " +
        "no copilot_work_started)",
      text: `review-gate: Copilot code review could not be started for PR #${pr.number} — GitHub ` +
        "never listed it as a pending reviewer, and no Copilot run started (the request was sent, " +
        "and re-sent once). Requirement released (UNSUPPORTED) — tell the user, since a review they " +
        "expect will not arrive.",
      details: { pr: pr.number },
      head: pr.head,
    });
  }
  // The request is queued (or Copilot is already working on it): record it with
  // the evidence; `runCopilotReview` blocks on it from here.
  st.copilot = recordCopilotRequest(st.copilot, {
    pr: pr.number,
    head: pr.head,
    nowIso,
    supportConfirmed: support.confirmed,
    queue: observationOf(verdict.state, evidence, new Date().toISOString()),
  });
  deps.persist(ctx, root);
  deps.armLoop();
  deps.log(`copilot review requested for PR #${pr.number} (round ${st.copilot.rounds}, ` +
    `availability ${support.support}, queue ${verdict.state})`);
  const waitNote = support.support === "UNKNOWN"
    ? "No Copilot review has ever appeared on this repository's recent PRs and its owner is not " +
      "on the allow-list, so if nothing comes back the requirement is released instead of " +
      "waiting."
    : "Measured on real PRs: the review lands in a median of ~16 minutes (p90 ~19, worst ~23).";
  progress.done(`PR #${pr.number} 已排队，等待落地`);
  return {
    content: [{
      type: "text",
      text: `review-gate: Copilot review requested for PR #${pr.number} (round ${st.copilot.rounds}) — ` +
        `${verdict.note}. ${waitNote}`,
    }],
    details: {
      status: "AWAITING",
      pr: pr.number,
      rounds: st.copilot.rounds,
      support: support.support,
      queue: verdict.state,
    },
  };
}
