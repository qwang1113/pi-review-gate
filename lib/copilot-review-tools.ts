/**
 * The ONE L7 tool that drives the post-PR Copilot review loop —
 * `copilot_review` asks GitHub for the review when the cycle has none, reports
 * what an outstanding request is doing while it waits, and reads what the
 * review left open once it lands.
 *
 * WHY ONE TOOL AND NOT TWO (2026-09-14, user decision). Until then this file
 * registered `request_copilot_review` and `check_copilot_review`, and the agent
 * had to sequence them: request after every push, then check, then check
 * again, deciding each time which of the two it was supposed to be holding.
 * That is a multi-step flow the gate can own outright (AGENTS.md 哲学一/哲学二:
 * one job, one tool — a flow the agent has to remember is a flow it will get
 * wrong), and it was getting it wrong visibly: a measured round spent five
 * `check` calls and 16.5 minutes to discover a review posted at minute 13,
 * because each call could only ask again.
 *
 * WHAT REPLACED THE BLIND WAIT. The tool now reads the two GitHub states the
 * PR page already draws — the pending-reviewer dot (a request that is queued,
 * GraphQL `reviewRequests`) and the timeline's `copilot_work_started` /
 * `copilot_work_finished_failure` — through `lib/copilot-review.ts`
 * (`decideCopilotWait`) and `lib/copilot-watch.ts` (the blocking wait this tool
 * runs until the review lands). The measured request→review time
 * is a median of 15.8 minutes, so the old "poll 3 × 20 seconds and call back in
 * a minute" could essentially never hit; the honest answer is a bounded wait
 * with evidence, and that is what this tool gives.
 *
 * THE BOUNDARY: this module owns the TOOLS — the state machine transitions
 * they record, the requirement they release, and every word they say to the
 * agent. It owns no rule of its own: the cycle's transitions and the wait's
 * verdicts are the pure `lib/copilot-review.ts` functions, the wait's
 * cadence is `lib/copilot-watch.ts`, and the GitHub access is
 * `lib/copilot-gh.ts`, reached through the injected `gh` seam so that each
 * branch below (no PR, a refused request, a dropped request, an abort, an
 * unreadable payload, a released cycle, open threads) can be exercised with a
 * fake instead of a real pull request. That split is also what keeps both
 * files clear of the 600-line hard block on new source files. Its own parts
 * are split the same way: the request half is lib/copilot-request-phase.ts,
 * the queue probe lib/copilot-queue-probe.ts, and the replies (with the triage
 * interview) lib/copilot-review-replies.ts.
 *
 * TRUST: the agent can never report its own review outcome — the same trust
 * split as run_precommit. The tool accepts no status, no thread list and no
 * "I handled it" flag; the extension gathers the evidence itself.
 *
 * TRIAGE (round {@link COPILOT_TRIAGE_ASK_FROM_ROUND} on, 2026-09-14, user
 * decision): every actionable finding goes to the USER before the agent is
 * told what to do with it, and the reply groups the decisions. Rounds 1–3 keep
 * the earlier free-for-all wording. The rules live in lib/copilot-triage.ts;
 * the interview itself is `askFindings` in lib/copilot-review-replies.ts.
 */

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import type { ToolRepoTarget } from "./repo-resolve.ts";
import type { GateState } from "./gate-state.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import type { GhResult } from "./copilot-gh.ts";
import { type ChoiceSpec } from "./choice-dialog.ts";
import {
  COPILOT_TRIAGE_ASK_FROM_ROUND,
  summarizeTriage,
  triageAsksUser,
} from "./copilot-triage.ts";
import { analyzeCopilot, evaluateCopilot } from "./copilot-review.ts";
import { armCopilotReview, isCopilotOutstanding } from "./copilot-review-state.ts";
import type {
  CopilotPayload,
  CopilotProbe,
  CopilotSupport,
  CopilotTimeline,
  PrSummary,
} from "./copilot-probe-parse.ts";
// The WAIT's policy — the verdict an outstanding request gets, its grace
// window, and the words that describe it — belongs to the module that owns the
// wait.
import {
  awaitCopilotNews,
  watchRunsInMode,
  type CopilotWaitOutcome,
} from "./copilot-watch.ts";
import {
  actOnBreakage,
  diagnoseWaitRequest,
  observationOf,
  waitedMinutes,
  waitedSince,
} from "./copilot-queue-probe.ts";
import { doRequestPhase } from "./copilot-request-phase.ts";
import {
  askFindings,
  copilotUnhandledText,
  releasedReply,
  releaseReply,
  REPLY_THREAD_CMD,
  RESOLVE_THREAD_CMD,
  triageText,
} from "./copilot-review-replies.ts";

/**
 * The GitHub reads and writes this tool needs — the whole surface, so a test
 * can drive every branch without a repository, a network or a `gh` binary.
 *
 * The extension wires each member to lib/copilot-gh.ts (and binds the
 * availability allow-list from its project config).
 */
export interface CopilotGhAccess {
  /** The PR for the repo's current branch, or the reason there is none. */
  resolveOpenPr(dir: string, signal?: AbortSignal): Promise<{ pr?: PrSummary; error?: string }>;
  /** owner/name for the repo, preferring gh's own answer over URL parsing. */
  resolveRepoSlug(dir: string, pr: PrSummary | undefined, signal?: AbortSignal): Promise<string | null>;
  /** Copilot's reviews + review threads for one PR, or undefined when unreadable. */
  fetchCopilotPayload(dir: string, slug: string, prNumber: number, signal?: AbortSignal): Promise<CopilotPayload | undefined>;
  /** The LIGHT read: is the answer in, and is the request still pending? */
  fetchCopilotProbe(dir: string, slug: string, prNumber: number, signal?: AbortSignal): Promise<CopilotProbe | undefined>;
  /** The REST timeline's Copilot events (started / failed). */
  fetchCopilotTimeline(dir: string, slug: string, prNumber: number, signal?: AbortSignal): Promise<CopilotTimeline | undefined>;
  /** Ask for the Copilot reviewer (CLI first, documented REST fallback). */
  requestCopilotReviewer(dir: string, pr: PrSummary, slug: string | null, signal?: AbortSignal): Promise<GhResult>;
  /** Availability for one repo, cheapest evidence first (see lib/copilot-gh.ts). */
  resolveCopilotSupport(
    dir: string,
    slug: string | null,
    supportConfirmed: boolean,
    opts?: { onPr?: boolean; signal?: AbortSignal },
  ): Promise<{ support: CopilotSupport; confirmed: boolean }>;
}

/**
 * Everything this tool needs from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every method is a thing a
 * test replaces with three lines.
 */
export interface CopilotReviewToolDeps {
  /** Which repo does this call target? Never guessed — see repo-resolve.ts. */
  resolveRepo(requested: string | undefined): ToolRepoTarget;
  /** The gate state of one repo (the primary repo's state IS the extension's). */
  stateFor(root: string): GateState;
  /** Persist one repo's state (sidecar + blocked-marker handling). */
  persist(ctx: unknown, root: string): void;
  /** The directory `gh` should run in for a given repo root. */
  repoDir(root: string): string;
  /** Is the L7 loop active for this repo's state? (mode + project config) */
  copilotEnabled(st: GateState): boolean;
  /** Re-arm the auto-continuation loop: there is Copilot work left to do. */
  armLoop(): void;
  /** The gate's own log channel (diagnostics; never shown to the user). */
  log(message: string): void;
  /** The GitHub surface, wired to lib/copilot-gh.ts. */
  gh: CopilotGhAccess;
  /** The poll's wait between attempts (injected so tests do not sleep). */
  delay(ms: number): Promise<void>;
  /**
   * This SESSION's gate mode. Not `stateFor(root).taskMode`: the mode is a
   * session fact kept on the primary state only, and a second repo's state
   * carries none — reading it there would never block in that repo.
   */
  sessionMode(): string | undefined;
  /** The clock the blocking wait reads (injected so tests can age a wait). */
  now?: () => number;
  /**
   * The call started (`true`) or stopped (`false`) blocking on Copilot — the
   * extension reports it on the child heartbeat as a gate-owned wait, so a
   * supervising project manager is not woken by it.
   */
  onWaiting?(active: boolean): void;
  /**
   * Put ONE Copilot finding to the user — or to an orchestrator supervising
   * this session, whoever answers first (the same race every other gate dialog
   * runs; the extension owns it, this module only asks).
   *
   * Returns the row that was picked, or `undefined` when nobody answered
   * (ESC, a dismissed box, an interrupting instruct, no UI at all). This
   * module never guesses what a missing answer means: `undefined` is "the user
   * did not decide", which is the ONE reading that cannot change code nobody
   * approved.
   */
  askFinding(
    uiCtx: unknown,
    spec: ChoiceSpec,
    opts: { body?: string; signal?: AbortSignal },
  ): Promise<string | undefined>;
  /**
   * Put text in front of the user, in the transcript, right now. False when
   * there is no UI to render into.
   *
   * The finding's full text goes here, before the box — a long Copilot comment
   * is easier to read in the transcript than in a box that scrolls, and
   * otherwise the user is asked to approve a finding they cannot see. (Until
   * 2026-09-16 the dialog row budget also forced it; that is gone, the reason
   * to print the full text here is not.)
   */
  showToUser(uiCtx: unknown, lead: string, body: string): boolean;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

async function doCopilotReview(
  deps: CopilotReviewToolDeps,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: unknown,
): Promise<ToolReply> {
  const progress = createProgressReporter({
    title: "review-gate: copilot_review",
    onUpdate: onUpdate as ToolUpdate | undefined,
  });
  const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
  if (!target.ok) {
    return { content: [{ type: "text", text: target.error }], details: {}, isError: true };
  }
  const root = target.root;
  const st = deps.stateFor(root);
  if (!deps.copilotEnabled(st)) {
    return {
      content: [{ type: "text", text: "review-gate: the Copilot review loop is off for this repo/mode — nothing to do." }],
      details: { status: "DISABLED" },
    };
  }
  const settled = st.copilot;
  if (settled && !isCopilotOutstanding(settled)) {
    return releasedReply(settled);
  }
  const dir = deps.repoDir(root);
  progress.step("解析当前分支的 PR");
  const resolved = await deps.gh.resolveOpenPr(dir, signal);
  if (!resolved.pr) {
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: `no Copilot review possible: ${resolved.error}`,
      text: `review-gate: no Copilot review for this repo — ${resolved.error}. Requirement released ` +
        "(UNSUPPORTED); it is not blocking completion.",
      details: {},
    });
  }
  const pr = resolved.pr;
  const slug = await deps.gh.resolveRepoSlug(dir, pr, signal);
  if (!slug) {
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: "could not determine the GitHub owner/repo for this PR",
      text: "review-gate: could not determine owner/repo for this PR. Requirement released (UNSUPPORTED).",
      details: {},
    });
  }
  progress.step("查 Copilot 支持情况");
  const support = await deps.gh.resolveCopilotSupport(dir, slug, st.copilot?.supportConfirmed === true, { signal });

  progress.step("读取 PR 的 Copilot review 与 threads");
  const payload = await deps.gh.fetchCopilotPayload(dir, slug, pr.number, signal);
  if (!payload) {
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: "the Copilot review query failed (gh missing, unauthenticated, or API refusal)",
      text: "review-gate: could not read the PR's review threads (gh missing, unauthenticated, " +
        "or API refusal). Requirement released (UNSUPPORTED).",
      details: {},
    });
  }
  let next = st.copilot ?? armCopilotReview(undefined, new Date().toISOString());
  const analysis = analyzeCopilot(payload, { anchorAt: next.requestedAt ?? next.armedAt });
  const headMoved = Boolean(next.head && payload.head && next.head !== payload.head);
  // "Nothing is outstanding for this cycle" — either no request was ever made,
  // the head moved out from under the last one, or a state predates the field.
  // NEVER while findings are already waiting: those are the agent's business
  // ahead of asking Copilot again (the same priority `evaluateCopilot` uses).
  const needsRequest = (next.status === "ARMED" || headMoved || !next.requestedAt) &&
    analysis.actionable.length === 0;

  // ── the request half ──
  //
  // It runs BEFORE the state machine's release branches on purpose: a repo
  // whose availability is UNKNOWN (no Copilot review has ever been seen there)
  // must still get the request. `evaluateCopilot` would release it as
  // UNSUPPORTED "instead of waiting", which is right for a request already in
  // flight and wrong for one that was never sent — the request is exactly how
  // a repository proves it can do this at all.
  if (needsRequest) {
    return await doRequestPhase({ deps, ctx, root, st, dir, slug, pr, support, signal, progress });
  }

  // ── an outstanding request, and nothing came back: ask GitHub WHY ──
  //
  // Before `evaluateCopilot` gets to turn "no answer" into "budget spent ⇒
  // released", the request gets one honest diagnosis.
  if (next.requestedAt && !analysis.reviewed && analysis.actionable.length === 0) {
    const { verdict, evidence } = await diagnoseWaitRequest({
      deps, dir, slug, prNumber: pr.number, state: next, signal, progress,
    });
    const acted = await actOnBreakage({
      deps, ctx, root, st, dir, slug, pr, state: next, signal, verdict, progress,
    });
    if (acted) return acted;
    next = { ...next, queue: observationOf(verdict.state, evidence, new Date().toISOString()) };
  }

  next = {
    ...evaluateCopilot(next, analysis, { nowIso: new Date().toISOString(), now: Date.now(), support: support.support }),
    pr: pr.number,
  };

  // ── findings (or a released cycle): the reading half of the old check ──
  //
  // Asked BEFORE the state is written, so the answers and the cycle land in
  // the sidecar together: a crash between the dialog and the write would
  // otherwise lose an approval the user already gave, and re-asking is the
  // cheap error here, losing it is not. Runs only when there IS something to
  // decide — an AWAITING or SATISFIED round never raises a box.
  const triageRun = triageAsksUser(next.rounds) && analysis.actionable.length > 0
    ? await askFindings(deps, ctx, signal, analysis.actionable, next.triage)
    : undefined;
  if (triageRun?.triage && triageRun.triage !== next.triage) {
    next = { ...next, triage: triageRun.triage };
  }

  st.copilot = next;
  deps.persist(ctx, root);
  if (isCopilotOutstanding(next)) deps.armLoop();
  deps.log(`copilot review for PR #${pr.number}: ${next.status} (availability ${support}` +
    `${next.note ? `, ${next.note}` : ""})` +
    `${triageRun ? `, triage asked ${triageRun.asked}` : ""}`);

  const lines = analysis.actionable.slice(0, 20).map((t) =>
    `  - ${t.id} ${t.path ?? "(no file)"}${t.line ? ":" + t.line : ""}` +
    `${t.isOutdated ? " [outdated — the code moved; if that fixed it, resolve the thread]" : ""}\n      ${t.excerpt}`);
  // The triaged round gets the by-decision text instead of the free-for-all
  // one: what the agent may touch is the whole point of having asked.
  const groups = triageRun ? summarizeTriage(analysis.actionable, next.triage) : undefined;
  const waiting = next.status === "AWAITING";
  const text = groups && triageRun
    ? triageText({
      pr: pr.number,
      rounds: next.rounds,
      groups,
      notes: triageRun.notes,
      resolved: analysis.resolved,
      answered: analysis.answered,
    })
    : next.status === "OPEN"
      ? `review-gate: PR #${pr.number} — ${analysis.actionable.length} Copilot thread(s) waiting on you ` +
        `(${analysis.resolved} resolved, ${analysis.answered} answered):\n${lines.join("\n")}\n` +
        "For each: fix it and resolve the thread, or reply in the thread with the reason it will " +
        `not be fixed. Resolve: ${RESOLVE_THREAD_CMD}. Reply: ${REPLY_THREAD_CMD}. ` +
        "Then call copilot_review again."
      : waiting
        // The wait's own text: what GitHub says and how long it has been. The
        // wait itself is `runCopilotReview`'s — this text is only shown when
        // that wait is cut short.
        ? `review-gate: Copilot has not posted its review of PR #${pr.number} yet — ` +
          `${next.queue?.state ?? "unknown"} after ${waitedMinutes(waitedSince(next.firstRequestedAt ?? next.requestedAt, Date.now()))}` +
          `${next.queue?.startedAt ? ` (Copilot started at ${next.queue.startedAt})` : ""}.`
        // Released with a readable payload. `evaluateCopilot` puts actionable
        // threads ahead of every release, so this list is normally empty — it
        // is kept as the belt to the sidecar-count braces used by the fail-safe
        // paths above, and it costs one call on data that is already in hand.
        : `review-gate: Copilot review of PR #${pr.number} — ${next.note ?? next.status}.` +
          copilotUnhandledText(analysis.actionable);
  return {
    content: [{ type: "text", text }],
    details: {
      status: next.status,
      pr: pr.number,
      actionable: analysis.actionable.length,
      resolved: analysis.resolved,
      answered: analysis.answered,
      support: support.support,
      ...(next.queue ? { queue: next.queue.state } : {}),
      ...(groups === undefined || triageRun === undefined
        ? {}
        : {
          triage: {
            fix: groups.fix.length,
            decline: groups.decline.length,
            irrelevant: groups.irrelevant.length,
            unanswered: groups.unanswered.length,
          },
        }),
    },
  };
}

/**
 * How many read → wait passes one call may take. A landed review ends it on
 * the next pass; a dropped request costs one retry pass and one release pass;
 * a timeout costs one diagnosis pass. Four is that worst path plus one.
 */
export const COPILOT_MAX_WAIT_PASSES = 4;

/**
 * The tool body: read / request, and while the answer is still AWAITING,
 * BLOCK on it instead of handing the wait back to the agent.
 *
 * WHY IT BLOCKS (2026-09-23). The reply used to say "end the turn — you will be
 * called", and a background timer woke the session when Copilot answered. An
 * orchestration child that ended its turn reported `idle` for the whole wait,
 * and its manager's `orchestrator_wait` rang every minute for fifteen minutes.
 * No session ends its turn before `declare_done` (AGENTS.md 总则), so the wait
 * lives here: {@link awaitCopilotNews} polls the light query, and on news the
 * next pass reads the review (or diagnoses, retries, releases) in this same
 * call. While it blocks, `onWaiting` lets the child heartbeat say so.
 */
async function runCopilotReview(
  deps: CopilotReviewToolDeps,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: unknown,
): Promise<ToolReply> {
  for (let pass = 1; ; pass++) {
    const reply = await doCopilotReview(deps, params, signal, onUpdate, ctx);
    if (reply.details?.status !== "AWAITING" || pass >= COPILOT_MAX_WAIT_PASSES) return reply;
    const target = deps.resolveRepo(typeof params.repo === "string" ? params.repo : undefined);
    if (!target.ok || !watchRunsInMode(deps.sessionMode())) return reply;
    const outcome = await waitForCopilot(deps, target.root, signal, onUpdate);
    if (outcome.ended) continue;
    return cutShortReply(reply, outcome);
  }
}

/** One blocking wait on this repo's outstanding request. */
async function waitForCopilot(
  deps: CopilotReviewToolDeps,
  root: string,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
): Promise<CopilotWaitOutcome> {
  const dir = deps.repoDir(root);
  const pr = deps.stateFor(root).copilot?.pr ?? null;
  const slug = pr === null ? null : await deps.gh.resolveRepoSlug(dir, {
    number: pr,
    head: deps.stateFor(root).copilot?.head ?? null,
    url: null,
    state: null,
  }, signal);
  createProgressReporter({ title: "review-gate: copilot_review", onUpdate: onUpdate as ToolUpdate | undefined })
    .step(`等 Copilot 交卷（PR #${pr ?? "?"}，中位 ~16 分钟；ESC 或输入消息可打断）`);
  deps.onWaiting?.(true);
  try {
    return await awaitCopilotNews({
      state: () => deps.stateFor(root).copilot,
      probe: async (state) =>
        slug && state.pr !== null ? await deps.gh.fetchCopilotProbe(dir, slug, state.pr, signal) : undefined,
      ...(signal ? { signal } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      sleep: (ms) => deps.delay(ms),
    });
  } finally {
    deps.onWaiting?.(false);
  }
}

/** The AWAITING reply, plus why the wait stopped and how to resume it. */
function cutShortReply(reply: ToolReply, outcome: CopilotWaitOutcome): ToolReply {
  const seconds = Math.round(outcome.waitedMs / 1000);
  const why = outcome.interrupted === "user-input"
    ? `The wait was interrupted after ${seconds}s because somebody is talking to you — handle that message first.`
    : outcome.interrupted === "signal"
      ? `The wait was cancelled (ESC) after ${seconds}s.`
      : `The wait gave up after ${seconds}s without news.`;
  const first = reply.content[0];
  const text = first && first.type === "text" ? first.text : "review-gate: Copilot review still outstanding.";
  return {
    ...reply,
    content: [{
      type: "text",
      text: `${text}\n${why} The request stays queued on GitHub; call copilot_review again to keep ` +
        "waiting (it resumes the same request, it does not re-send). Do not end the turn to wait for it.",
    }],
    details: { ...reply.details, waited: "cut-short", ...(outcome.interrupted ? { interrupted: outcome.interrupted } : {}) },
  };
}

/**
 * Register `copilot_review` — the L7 loop's only tool.
 *
 * One entry point on purpose: "request" and "read" are phases of ONE job
 * (getting the Copilot review of the current head worked off), and a two-tool
 * API made the agent sequence them by hand after every push.
 */
export function registerCopilotReviewTools(host: ToolHost, deps: CopilotReviewToolDeps): void {
  host.registerTool({
    name: "copilot_review",
    label: "Copilot Review",
    description:
      "Drive the post-PR Copilot review loop: ONE call, and the gate decides which half is due. " +
      "When the current head has no review requested yet, it asks GitHub for one and confirms that " +
      "it was queued (the request is measured to be registered within ~60s; a request GitHub never " +
      "queued is re-sent once, then released as UNSUPPORTED). While a request is outstanding it " +
      "diagnoses what GitHub says the request is doing — queued / Copilot working / its run failed / " +
      "never landed — and then BLOCKS in this same call until the review lands (measured: median " +
      "~16 minutes, p90 ~19, worst ~23), the request turns out dropped or broken, or the 30-minute " +
      "budget ends, and carries straight on with the result. ESC or typing a message interrupts the " +
      "wait; calling it again resumes it. Never end the turn to wait for Copilot. When the " +
      "review has landed it lists the threads that are still waiting on you, and from round " +
      `${COPILOT_TRIAGE_ASK_FROM_ROUND} on it asks the USER about each finding before you may touch ` +
      "it, answering with the decisions grouped (fix / won't-fix-with-a-reply / not-related-resolve-it " +
      "/ not-answered). Only the first group is yours to change; a finding nobody answered is NOT " +
      "approval. The extension gathers all of this evidence itself — you cannot report a review " +
      "outcome. If there is no PR, no `gh`, or the repo cannot do Copilot code review, the " +
      "requirement is released as UNSUPPORTED and stops blocking completion.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Absolute path of the repository (required once the session edited several repos)" })),
    }),
    execute: (_id, params, signal, onUpdate, ctx) =>
      runCopilotReview(deps, params, signal as AbortSignal | undefined, onUpdate, ctx),
  });
}
