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
 * (`decideCopilotWait`) and `lib/copilot-watch.ts` (the background watcher that
 * wakes this session when the review lands). The measured request→review time
 * is a median of 15.8 minutes, so the old "poll 3 × 20 seconds and call back in
 * a minute" could essentially never hit; the honest answer is a bounded wait
 * with evidence, and that is what this tool gives.
 *
 * THE BOUNDARY: this module owns the TOOLS — the state machine transitions
 * they record, the requirement they release, and every word they say to the
 * agent. It owns no rule of its own: the cycle's transitions and the wait's
 * verdicts are the pure `lib/copilot-review.ts` functions, the watcher's
 * cadence is `lib/copilot-watch.ts`, and the GitHub access is
 * `lib/copilot-gh.ts`, reached through the injected `gh` seam so that each
 * branch below (no PR, a refused request, a dropped request, an abort, an
 * unreadable payload, a released cycle, open threads) can be exercised with a
 * fake instead of a real pull request. That split is also what keeps both
 * files clear of the 600-line hard block on new source files.
 *
 * TRUST: the agent can never report its own review outcome — the same trust
 * split as run_precommit. The tool accepts no status, no thread list and no
 * "I handled it" flag; the extension gathers the evidence itself.
 *
 * TRIAGE (round {@link COPILOT_TRIAGE_ASK_FROM_ROUND} on, 2026-09-14, user
 * decision): every actionable finding goes to the USER before the agent is
 * told what to do with it, and the reply groups the decisions. Rounds 1–3 keep
 * the earlier free-for-all wording. The rules live in lib/copilot-triage.ts;
 * the interview itself is `askFindings` below.
 */

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import type { ToolRepoTarget } from "./repo-resolve.ts";
import type { GateState } from "./gate-state.ts";
import { createProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import { ghError, type GhResult } from "./copilot-gh.ts";
import { type ChoiceSpec } from "./choice-dialog.ts";
// The interview's escape row, imported rather than re-spelled: "skip the rest"
// is one convention in this gate, and ask-user.ts owns the constant.
import { SKIP_REST_CHOICE } from "./ask-user.ts";
import {
  COPILOT_TRIAGE_ASK_FROM_ROUND,
  findingBody,
  findingChoiceSpec,
  findingKey,
  recordDecision,
  summarizeTriage,
  triageAskPlan,
  triageAsksUser,
  triagePickFrom,
  type CopilotTriageGroups,
  type CopilotTriageState,
} from "./copilot-triage.ts";
import {
  analyzeCopilot,
  armCopilotReview,
  COPILOT_AWAIT_TIMEOUT_MS,
  evaluateCopilot,
  isCopilotOutstanding,
  recordCopilotRequest,
  releaseCopilotReview,
  type CopilotPayload,
  type CopilotProbe,
  type CopilotQueueObservation,
  type CopilotReviewState,
  type CopilotSupport,
  type CopilotThread,
  type CopilotTimeline,
  type CopilotWaitState,
  type PrSummary,
} from "./copilot-review.ts";
// The WAIT's policy — the verdict an outstanding request gets, its grace
// window, and the words that describe it — belongs to the module that owns the
// wait.
import {
  COPILOT_LANDING_GRACE_MS,
  decideCopilotWait,
  type CopilotQueueEvidence,
  type CopilotWaitVerdict,
} from "./copilot-watch.ts";

/**
 * How the tool confirms that GitHub actually QUEUED the review request.
 *
 * This replaced a poll that could not work. The old in-tool poll waited
 * 3 × 20 seconds for the REVIEW to appear, against a measured median of 15.8
 * minutes (min 4.0 over 50 paired rounds on a 10k-line PR) — a 60-second window
 * that essentially never contains the answer. The queue flag is the part that
 * DOES arrive fast: `review_requested` landed within 63 seconds of every one of
 * the 51 measured requests (median 35s). So the wait is now spent on the
 * question that resolves in a minute — "did GitHub take it?" — and the review
 * itself is left to the background watcher.
 *
 * 6 × 15s = 90s = `COPILOT_LANDING_GRACE_MS`: the same window
 * `decideCopilotWait` uses to conclude that a request was dropped, so the tool
 * and the state machine cannot disagree about what "too late" means.
 */
export const COPILOT_CONFIRM_ATTEMPTS = 6;
export const COPILOT_CONFIRM_DELAY_MS = 15_000;
/** The retry after a dropped request gets a shorter window (see `confirmQueued`). */
export const COPILOT_CONFIRM_RETRY_ATTEMPTS = 3;

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
    opts: { body?: string; signal?: AbortSignal; extraRows?: string[] },
  ): Promise<string | undefined>;
  /**
   * Put text in front of the user, in the transcript, right now.
   *
   * The finding's full text goes here, before the box — a long Copilot comment
   * is easier to read in the transcript than in a box that scrolls, and
   * otherwise the user is asked to approve a finding they cannot see.
   * (Until 2026-09-16 this was also forced by the dialog row budget; that is
   * gone, the reason to print the full text here is not.) there is no UI to render
   * into.
   */
  showToUser(uiCtx: unknown, lead: string, body: string): boolean;
}

/**
 * The two gh commands a thread needs. Kept as constants so the pre-round-4
 * text and the triaged text teach the SAME commands — one wording, not two.
 */
const RESOLVE_THREAD_CMD =
  "gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t})" +
  "{thread{isResolved}}}' -F t=<threadId>";
const REPLY_THREAD_CMD =
  "gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply" +
  "(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' -F t=<threadId> -F b='<why>'";

/**
 * Put every finding that still owes the user a question in front of them, and
 * fold the answers into the triage state.
 *
 * ONE DIALOG AT A TIME, in the order the findings came back, with the escape
 * row an interview has. The `ask_user` interview hands its whole batch to the
 * channel up front so a project manager can answer everything at once
 * (lib/user-interaction-tools.ts); this loop deliberately does NOT — a Copilot
 * round is a handful of questions, and a second batching convention is a
 * second thing to keep right. ponytail: sequential; batch the channel
 * requests here if a supervised child with 10 findings ever shows the cost.
 *
 * A STOP (the escape row, or an abort) does not undo anything: the answers
 * already given are kept and persisted with the rest of the state, and the
 * findings that were never asked are simply still unanswered — which asks
 * them again on the next call instead of inventing a decision.
 */
async function askFindings(
  deps: CopilotReviewToolDeps,
  ctx: unknown,
  signal: AbortSignal | undefined,
  findings: readonly CopilotThread[],
  current: CopilotTriageState | undefined,
): Promise<{ triage: CopilotTriageState | undefined; notes: Map<string, string>; deferred: number; asked: number }> {
  const plan = triageAskPlan(findings, current);
  /** What the user said when they picked NONE of the three answers. */
  const notes = new Map<string, string>();
  let triage = current;
  let stopped = false;
  for (const [index, thread] of plan.ask.entries()) {
    if (stopped || signal?.aborted) break;
    const spec = findingChoiceSpec(thread, index, plan.ask.length);
    const body = findingBody(thread);
    // THE TRANSCRIPT COPY GOES UP BEFORE THE BOX. It used to matter twice:
    // the dialog's body was fitted to a row budget, so the tail of a long
    // comment did not fit and a pointer told the user where the rest was. The
    // budget is gone (2026-09-16) and the dialog now shows the body whole —
    // but the transcript copy stays, because an approval screen that hides
    // part of the finding is how the user approves something they never read,
    // and the comment is long enough to scroll past in a dialog.
    deps.showToUser(ctx, `───── ${spec.title} ─────`, body);
    const picked = await deps.askFinding(ctx, spec, {
      body,
      extraRows: [SKIP_REST_CHOICE],
      ...(signal ? { signal } : {}),
    });
    const outcome = triagePickFrom(picked, spec);
    if (outcome.kind === "skip-rest") {
      stopped = true;
      continue;
    }
    if (outcome.kind === "unanswered") {
      if (outcome.reason) notes.set(findingKey(thread), outcome.reason);
      continue;
    }
    triage = recordDecision(triage, thread, outcome.decision, new Date().toISOString(), outcome.reason);
  }
  return { triage, notes, deferred: plan.deferred, asked: plan.ask.length };
}

/** Where one finding is, as one line an agent can act on. */
function findingLine(thread: CopilotThread): string {
  return `${thread.id} ${thread.path ?? "(no file)"}${thread.line ? ":" + thread.line : ""}` +
    `${thread.isOutdated ? " [outdated — the code moved; if that already fixed it, resolve the thread]" : ""}`;
}

/**
 * The triaged alternative to the round-3-and-earlier text.
 *
 * Same opening line as before (the counts are useful either way), then the
 * user's decisions GROUPED, because "what may I change?" is the only question
 * this text has to answer. The commands appear only for the groups the agent
 * actually has to run, so the permission boundary is stated once per bucket
 * instead of buried in a shared paragraph.
 */
function triageText(args: {
  pr: number;
  rounds: number;
  groups: CopilotTriageGroups;
  notes: Map<string, string>;
  deferred: number;
  resolved: number;
  answered: number;
}): string {
  const { groups } = args;
  const plural = (n: number) => `${n} 条`;
  const out: string[] = [];
  out.push(
    `review-gate: PR #${args.pr} — ${groups.fix.length + groups.decline.length + groups.irrelevant.length + groups.unanswered.length} ` +
    `Copilot thread(s) waiting on you (${args.resolved} resolved, ${args.answered} answered). ` +
    `第 ${args.rounds} 轮（从第 ${COPILOT_TRIAGE_ASK_FROM_ROUND} 轮起）的每一条问题都要先经用户审批 —— 下面就是他的决定，只做他批过的事：`,
  );
  out.push(`  ✅ 修复（${plural(groups.fix.length)}）—— 只许改这些：`);
  for (const e of groups.fix) out.push(`    - ${findingLine(e.thread)} — ${e.thread.excerpt}`);
  out.push(
    `  🚫 不修，回复说明（${plural(groups.decline.length)}）—— 在 thread 里回一句说明，再 resolve：`,
  );
  for (const e of groups.decline) {
    out.push(
      `    - ${findingLine(e.thread)} — ` +
      (e.record?.reason
        ? `用户给的理由：「${e.record.reason}」`
        : "用户没给理由 —— 你写一句简短说明（不要声称他说过他没说过的话）"),
    );
  }
  out.push(`  ➖ 与我无关，直接 resolve（${plural(groups.irrelevant.length)}）—— resolve 掉，不要在 thread 里回复：`);
  for (const e of groups.irrelevant) out.push(`    - ${findingLine(e.thread)}`);
  out.push(`  ⏸ 未获批准（${plural(groups.unanswered.length)}）—— 这些代码不许改，只如实告诉他：`);
  for (const e of groups.unanswered) {
    const note = args.notes.get(findingKey(e.thread));
    out.push(
      `    - ${findingLine(e.thread)} —— ` +
      (note
        // The ✎ row: they picked none of the three and said why. That is NOT
        // consent to change code — but their own words already say what to do
        // with the thread, so the agent is told to use them, and to ask when
        // they do not answer the question at all.
        ? `用户没选任何选项，原话：「${note}」—— 这句话如果是「不修」的理由，就照它回复并 resolve；如果他要的是别的，用 ask_user 问清再动。`
        : "他没表态 —— 不许改、不许代他回复。"),
    );
  }
  if (groups.fix.length > 0) {
    out.push(
      `修完（或本来就已修好）的：resolve 掉 —— ${RESOLVE_THREAD_CMD}`,
    );
  }
  if (groups.decline.length > 0) {
    out.push(`回复：${REPLY_THREAD_CMD}；回完再 resolve（上面那条命令）。`);
  }
  if (groups.irrelevant.length > 0) {
    out.push(`「与我无关」的那几条：只 resolve —— ${RESOLVE_THREAD_CMD}`);
  }
  if (args.deferred > 0) {
    out.push(`（还有 ${args.deferred} 条没来得及问用户，下一次 copilot_review 会接着问。）`);
  }
  out.push("Then call copilot_review again.");
  return out.join("\n");
}

/**
 * The thread list an agent must carry to the user when a cycle is released
 * with findings still open. Released ≠ handled: the gate stops blocking, the
 * agent still owes the user an explanation.
 */
export function copilotUnhandledText(threads: CopilotThread[]): string {
  if (threads.length === 0) return "";
  const lines = threads.slice(0, 20).map((t) =>
    `  - ${t.path ?? "(no file)"}${t.line ? ":" + t.line : ""} — ${t.excerpt}`);
  return `\n${threads.length} Copilot thread(s) are still unhandled — tell the user about them ` +
    `before you finish:\n${lines.join("\n")}`;
}

/**
 * The same duty, for the paths that release WITHOUT a readable payload.
 *
 * These are the ones that actually happen: the PR vanished, the slug cannot
 * be resolved, `gh` lost its credentials, the API refused. They release to
 * keep the task moving — and used to do it in total silence, even when the
 * previous check had recorded open Copilot findings. The count is the only
 * thing left (there is no payload to list from), so the count is what gets
 * reported.
 */
export function copilotAbandonedText(prev: CopilotReviewState | undefined): string {
  const open = prev?.openThreads ?? 0;
  if (open <= 0) return "";
  return `\n${open} Copilot thread(s) were still waiting on you at the last check and are now ` +
    "being abandoned unverified — tell the user about them before you finish" +
    `${prev?.pr ? ` (PR #${prev.pr})` : ""}.`;
}

// ---------------------------------------------------------------------------
// The queue probe: is this request queued, working, broken or not there at all?
// ---------------------------------------------------------------------------

/** Milliseconds since an ISO time, or null when it cannot be read. */
function waitedSince(iso: string | undefined, now: number): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.max(0, now - ms);
}

function minutes(ms: number | null): string {
  return ms === null ? "an unknown time" : `${(ms / 60_000).toFixed(1)} minutes`;
}

/**
 * The evidence the wait is judged on, assembled from every source that is
 * already in hand: the live `queued` answer from the light probe, and the
 * timeline facts remembered on the state (a `copilot_work_started` does not
 * un-happen, so an observation from an earlier call still describes this
 * cycle — until a new cycle re-arms and drops it).
 */
function waitEvidence(
  probe: CopilotProbe | undefined,
  timeline: CopilotTimeline | undefined,
  state: CopilotReviewState,
): CopilotQueueEvidence {
  const rememberedFailed = state.queue?.state === "failed";
  return {
    // A failed probe is "could not read", never "no".
    queued: probe ? probe.queued : null,
    workStartedAt: timeline?.workStartedAt ?? state.queue?.startedAt ?? null,
    workFailedAt: timeline?.workFailedAt ?? (rememberedFailed ? state.queue?.at ?? null : null),
  };
}

/** The observation to persist from a verdict + the evidence it was drawn from. */
function observationOf(
  state: CopilotWaitState,
  evidence: CopilotQueueEvidence,
  nowIso: string,
): CopilotQueueObservation {
  return {
    state,
    at: nowIso,
    ...(evidence.workStartedAt ? { startedAt: evidence.workStartedAt } : {}),
  };
}

/**
 * Poll until GitHub shows the request as QUEUED (the pending-reviewer dot), up
 * to `attempts` × {@link COPILOT_CONFIRM_DELAY_MS}.
 *
 * Returns as soon as the flag appears — that is the median-35-second case — so
 * the common path costs a couple of light queries, not the whole window. A
 * timeline probe is spent once, when the queue flag first shows up, to answer
 * the question the flag cannot: has Copilot STARTED (the spinner state) or is
 * it merely queued?
 */
async function confirmQueued(args: {
  deps: CopilotReviewToolDeps;
  dir: string;
  slug: string;
  prNumber: number;
  requestedAt: string;
  signal: AbortSignal | undefined;
  progress: { step(message: string): void };
  attempts: number;
}): Promise<{ queued: boolean | null; timeline: CopilotTimeline | undefined; startedAt: string | null }> {
  const { deps, dir, slug, prNumber, signal } = args;
  /** Did the LAST probe actually answer? A probe that never ran is not "no". */
  let readable = false;
  for (let attempt = 0; attempt < args.attempts; attempt++) {
    if (signal?.aborted) break;
    const probe = await deps.gh.fetchCopilotProbe(dir, slug, prNumber, signal);
    if (probe !== undefined) readable = true;
    if (probe?.queued === true) {
      args.progress.step("已排队 —— 读时间线确认 Copilot 是否已开工");
      const timeline = signal?.aborted
        ? undefined
        : await deps.gh.fetchCopilotTimeline(dir, slug, prNumber, signal);
      return { queued: true, timeline, startedAt: timeline?.workStartedAt ?? null };
    }
    if (attempt < args.attempts - 1) {
      args.progress.step(`等待 GitHub 记录这次请求（第 ${attempt + 1}/${args.attempts} 次）`);
      await deps.delay(COPILOT_CONFIRM_DELAY_MS);
    }
  }
  // Never saw the flag. Read the timeline once before concluding "dropped": a
  // run that started and failed shows there and nowhere else.
  const timeline = signal?.aborted
    ? undefined
    : await deps.gh.fetchCopilotTimeline(dir, slug, prNumber, signal);
  return { queued: readable ? false : null, timeline, startedAt: timeline?.workStartedAt ?? null };
}

/**
 * What an unanswered request demands, from the verdict GitHub's evidence
 * produced: a retry (once per cycle), a release, or nothing at all — in which
 * case the caller records the observation and reports the wait.
 *
 * THE RETRY IS THE POINT: a run that FAILED and a request that was never
 * QUEUED are both things waiting cannot fix, and the measured cost of not
 * knowing the difference was a full 20-minute budget spent to learn nothing.
 * One recovery per cycle, then the requirement is released with the reason —
 * a repository whose Copilot review is broken must not hold a task forever.
 */
async function actOnBreakage(args: {
  deps: CopilotReviewToolDeps;
  ctx: unknown;
  root: string;
  st: GateState;
  dir: string;
  slug: string;
  pr: PrSummary;
  state: CopilotReviewState;
  signal: AbortSignal | undefined;
  verdict: CopilotWaitVerdict;
  progress: { step(message: string): void };
}): Promise<ToolReply | undefined> {
  const { deps, ctx, root, st, dir, slug, pr, state, signal, verdict, progress } = args;
  if (verdict.state !== "failed" && verdict.state !== "not-landed") return undefined;
  const why = verdict.state === "failed"
    ? `Copilot's review run failed (copilot_work_finished_failure) after ${minutes(verdict.waitedMs)}`
    : `GitHub never queued the review request (no pending reviewer, no copilot_work_started) after ${minutes(verdict.waitedMs)}`;
  if (state.breakageRetried) {
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: `${why}, and the cycle's retry was already spent`,
      text: `review-gate: ${why}, and the one retry this cycle gets was already spent. ` +
        "Requirement released (UNSUPPORTED) — tell the user: Copilot code review is not working " +
        "for this PR, and the findings (if any) were never produced.",
      details: { pr: pr.number },
    });
  }
  progress.step("重发请求");
  const again = await deps.gh.requestCopilotReviewer(dir, pr, slug, signal);
  if (!again.ok) {
    // An abort is the user pressing ESC, not GitHub refusing. Leave the state
    // exactly as it was: the wait continues, and the next call diagnoses again.
    if (signal?.aborted) {
      return {
        content: [{
          type: "text",
          text: "review-gate: aborted before the retry completed — nothing changed; call " +
            "copilot_review again.",
        }],
        details: { status: state.status, pr: pr.number },
      };
    }
    return releaseReply({
      deps, ctx, root, st,
      status: "UNSUPPORTED",
      note: `${why}, and the retry was refused: ${ghError(again, "the review request was refused")}`,
      text: `review-gate: ${why}, and the retry was refused — ${ghError(again, "the review request was refused")}. ` +
        "Requirement released (UNSUPPORTED).",
      details: { pr: pr.number },
    });
  }
  st.copilot = recordCopilotRequest(state, {
    pr: pr.number,
    head: pr.head,
    nowIso: new Date().toISOString(),
    queue: { state: "unknown", at: new Date().toISOString() },
    afterBreakage: verdict.state,
    note: `${why} — a fresh request was sent`,
  });
  deps.persist(ctx, root);
  deps.armLoop();
  deps.log(`copilot retry for PR #${pr.number} (round ${st.copilot.rounds}): ${why}`);
  return {
    content: [{
      type: "text",
      text: `review-gate: ${why}. A fresh request was sent (round ${st.copilot.rounds}) — ` +
        "the gate watches it in the background and wakes you when the review lands; do not poll.",
    }],
    details: { status: "AWAITING", pr: pr.number, rounds: st.copilot.rounds, retry: verdict.state },
  };
}

/** A wait that has gone on long enough to need an explanation. */
interface WaitDiagnosis {
  /** What the wait is doing, for the state and the reply. */
  verdict: { state: CopilotWaitState; waitedMs: number | null; note: string };
  evidence: CopilotQueueEvidence;
}

/**
 * Diagnose an outstanding request by asking GitHub what actually happened to
 * it, and act — the whole point of the merge.
 *
 * The three questions, in the order they are cheap to answer:
 *
 *  1. Is the request pending at all (light query)? No pending flag plus no
 *     `copilot_work_started` past the grace window means GitHub never took it,
 *     and the honest response is to SEND IT AGAIN rather than to wait out a
 *     budget for something that was never queued.
 *  2. Did Copilot's run FAIL (timeline)? `copilot_work_finished_failure` means
 *     no review is coming from this run, so waiting is pointless — re-request
 *     once (the cycle's single retry) instead of discovering it 10 minutes
 *     later.
 *  3. Otherwise it is queued or working, and the answer is genuinely "wait".
 *
 * The timeline probe (two REST round trips) is spent deliberately rarely:
 * on the request path, when the queue flag is missing, when nothing started
 * yet, and when the budget runs out. The ~25-second poll in
 * lib/copilot-watch.ts uses the light query only.
 */
async function diagnoseWaitRequest(args: {
  deps: CopilotReviewToolDeps;
  dir: string;
  slug: string;
  prNumber: number;
  state: CopilotReviewState;
  signal: AbortSignal | undefined;
  progress: { step(message: string): void };
}): Promise<WaitDiagnosis> {
  const { deps, dir, slug, prNumber, state, signal } = args;
  const now = Date.now();
  const requestedAt = state.firstRequestedAt ?? state.requestedAt;
  const waitedMs = waitedSince(requestedAt, now);
  args.progress.step("确认排队状态（reviewRequests）");
  const probe = await deps.gh.fetchCopilotProbe(dir, slug, prNumber, signal);
  const budgetSpent = waitedMs !== null && waitedMs >= COPILOT_AWAIT_TIMEOUT_MS;
  // Spend the timeline probe when the light answer is not enough to decide:
  // nothing queued (dropped? broken?), nothing started yet (working?), or the
  // budget is up (which of the two ways did this end?).
  const startedKnown = Boolean(state.queue?.startedAt);
  const needsTimeline = probe !== undefined && (
    probe.queued !== true || !startedKnown || budgetSpent
  );
  const timeline = needsTimeline && !signal?.aborted
    ? await (async () => {
      args.progress.step("读时间线事件（copilot_work_started / 失败）");
      return await deps.gh.fetchCopilotTimeline(dir, slug, prNumber, signal);
    })()
    : undefined;
  const evidence = waitEvidence(probe, timeline, state);
  return { verdict: decideCopilotWait({ evidence, requestedAt, now }), evidence };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** A released cycle is a decision, not a snapshot — say so and stop. */
function releasedReply(state: CopilotReviewState): ToolReply {
  return {
    content: [{
      type: "text",
      text: `review-gate: the Copilot requirement for this repo is already released (${state.status})` +
        `${state.note ? ` — ${state.note}` : ""}. It is not blocking completion, and calling this tool ` +
        "again changes nothing: a fresh cycle starts on the next push or PR update (the ship gate " +
        "re-arms it), not by asking twice." +
        // A cycle can be released with findings still open (any of the fail-safe
        // paths below). Repeating the reminder here means the duty survives a
        // re-call instead of scrolling away.
        copilotAbandonedText(state),
    }],
    details: {
      status: state.status,
      ...(state.pr === null ? {} : { pr: state.pr }),
      ...(state.openThreads ? { unhandled: state.openThreads } : {}),
    },
  };
}

/** Release the requirement and say why — with the abandoned-findings duty. */
function releaseReply(args: {
  deps: CopilotReviewToolDeps;
  ctx: unknown;
  root: string;
  st: GateState;
  status: "UNSUPPORTED" | "EXHAUSTED";
  note: string;
  text: string;
  details: Record<string, unknown>;
  /** PR head the cycle was bound to, when the release happened at request time. */
  head?: string | null;
}): ToolReply {
  const abandoned = copilotAbandonedText(args.st.copilot);
  args.st.copilot = releaseCopilotReview(
    args.st.copilot, args.status, args.note, new Date().toISOString(), args.head ?? null,
  );
  args.deps.persist(args.ctx, args.root);
  args.deps.log(`copilot cycle released ${args.status} on copilot_review: ${args.note}`);
  return {
    content: [{ type: "text", text: `${args.text}${abandoned}` }],
    details: { status: args.status, ...args.details },
  };
}

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
async function doRequestPhase(args: {
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
  // the evidence, and let the watcher own the wait from here.
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
    : "Measured on real PRs: the review lands in a median of ~16 minutes (p90 ~19, worst ~23). " +
      "This gate watches the PR in the background and wakes you when it lands — do NOT poll it.";
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
      deferred: triageRun.deferred,
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
        // The wait's own text: what GitHub says, how long it has been, and the
        // one instruction that matters — do not poll. The gate is watching.
        ? `review-gate: Copilot has not posted its review of PR #${pr.number} yet — ` +
          `${next.queue?.state ?? "unknown"} after ${minutes(waitedSince(next.firstRequestedAt ?? next.requestedAt, Date.now()))}` +
          `${next.queue?.startedAt ? ` (Copilot started at ${next.queue.startedAt})` : ""}. ` +
          "There is nothing to poll for: the gate watches the PR in the background and wakes you the " +
          "moment the review lands (median ~16 minutes, worst measured ~23). Do something useful, or " +
          "end the turn — you will be called."
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
            deferred: triageRun.deferred,
          },
        }),
    },
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
      "reports what GitHub says the request is doing — queued / Copilot working / its run failed / " +
      "never landed — and you should NOT poll it: the gate watches the PR in the background and " +
      "wakes you when the review lands (measured: median ~16 minutes, p90 ~19, worst ~23). When the " +
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
      doCopilotReview(deps, params, signal as AbortSignal | undefined, onUpdate, ctx),
  });
}
