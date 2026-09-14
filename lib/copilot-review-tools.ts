/**
 * The two L7 tools that drive the post-PR Copilot review loop —
 * `request_copilot_review` (ask GitHub for the review, stamp the
 * authoritative request time) and `check_copilot_review` (read what the
 * review left open, and decide whether the requirement still blocks
 * completion).
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository now has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8900 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts), then
 * the judge tools (lib/judge-session-tools.ts, lib/judge-relay-tools.ts), then
 * the prepare family (lib/review-prepare-tools.ts,
 * lib/advisory-prepare-tools.ts). Same shape here:
 * `register<Family>Tools(host, deps)`, with every effect the tools need
 * arriving through an injected `deps` object.
 *
 * THE BOUNDARY: this module owns the TOOLS — the state machine transitions
 * they record, the requirement they release, and every word they say to the
 * agent. It owns no rule of its own: the cycle's transitions are the pure
 * lib/copilot-review.ts functions, and the GitHub access is
 * lib/copilot-gh.ts, reached through the injected `gh` seam so that each
 * branch below (no PR, a refused request, an abort, an unreadable payload, a
 * released cycle, open threads) can be exercised with a fake instead of a
 * real pull request. That split is also what keeps both files clear of the
 * 600-line hard block on new source files.
 *
 * TRUST: the agent can never report its own review outcome — the same trust
 * split as run_precommit. Neither tool accepts a status, a thread list or an
 * "I handled it" flag; the extension gathers the evidence itself.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Tool names, schemas, reply texts, `details` fields, log lines and error
 * branches are the ones the agent-facing contract already documents; changing
 * any of them is a separate, deliberate change.
 *
 * ONE such change has landed since (2026-09-14, user decision): from Copilot
 * round {@link COPILOT_TRIAGE_ASK_FROM_ROUND} on, `check_copilot_review`
 * puts every actionable finding to the USER before the agent is told what to
 * do with it, and answers with the decisions grouped. Rounds 1–3 — and every
 * other branch in this file — keep the frozen wording. The rules live in
 * lib/copilot-triage.ts; the interview itself is `askFindings` below.
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
  evaluateCopilot,
  isCopilotOutstanding,
  recordCopilotRequest,
  releaseCopilotReview,
  type CopilotPayload,
  type CopilotReviewState,
  type CopilotSupport,
  type CopilotThread,
  type PrSummary,
} from "./copilot-review.ts";

/**
 * Optimistic poll inside check_copilot_review: a few quick retries catch the
 * common "Copilot answered while we were talking" case without turning the
 * tool into a long block. Anything slower is handled by the persistent
 * AWAITING state and the next continuation.
 *
 * Sized against measurements, not folklore: GitHub documents "usually less
 * than 30 seconds", and an observed real review took 2m43s. 3 x 20s covers
 * the documented case in a single tool call without pretending to cover the
 * slow tail.
 */
export const COPILOT_CHECK_ATTEMPTS = 3;
export const COPILOT_CHECK_DELAY_MS = 20000;

/**
 * The GitHub reads and writes these tools need — the whole surface, so a test
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
 * Everything these tools need from the outside world.
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
 * them again on the next check instead of inventing a decision.
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
    const picked = await deps.askFinding(ctx, spec, {
      body: findingBody(thread),
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
    out.push(`（还有 ${args.deferred} 条没来得及问用户，下一次 check_copilot_review 会接着问。）`);
  }
  out.push("Then call check_copilot_review again.");
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

// ---------- request_copilot_review ----------

async function doRequestCopilotReview(
  deps: CopilotReviewToolDeps,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: unknown,
): Promise<ToolReply> {
  // resolveToolRepo takes only `requested`; a second "tool name" argument
  // was being passed and silently dropped (TS2554, now caught by
  // `npm run typecheck`). The resolver's error already lists every
  // candidate repo, so the tool name added nothing to it.
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
  const nowIso = new Date().toISOString();
  const dir = deps.repoDir(root);
  // No round budget any more. The old pre-flight check released the cycle
  // as EXHAUSTED once `rounds` hit the cap — i.e. it stopped asking about
  // Copilot's comments because the conversation had gone on a while. The
  // only bound left is the wait timeout, which fires when there is no
  // feedback to lose.

  // Network minutes, one gh call after another: show which one is in
  // flight instead of a silent tool call.
  const progress = createProgressReporter({
    title: "review-gate: request_copilot_review",
    onUpdate: onUpdate as ToolUpdate | undefined,
  });
  progress.step("解析当前分支的 PR");
  const resolved = await deps.gh.resolveOpenPr(dir, signal);
  if (!resolved.pr) {
    progress.fail("没有可用的 PR");
    const abandoned = copilotAbandonedText(st.copilot);
    st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
      `no Copilot review possible: ${resolved.error}`, nowIso);
    deps.persist(ctx, root);
    deps.log(`copilot cycle released UNSUPPORTED on request: ${resolved.error}`);
    return {
      content: [{
        type: "text",
        text: `review-gate: no Copilot review for this repo — ${resolved.error}. Requirement released ` +
          "(UNSUPPORTED); it is not blocking completion." + abandoned,
      }],
      details: { status: "UNSUPPORTED" },
    };
  }
  const pr = resolved.pr;
  const slug = await deps.gh.resolveRepoSlug(dir, pr, signal);
  // Availability, from evidence, BEFORE spending a round. Not a veto: the
  // request goes out either way (it is cheap, and a repo nobody has asked
  // yet can only start producing evidence once someone asks). It decides
  // how long a silent Copilot is worth waiting for.
  progress.step("查 Copilot 支持情况");
  const support = await deps.gh.resolveCopilotSupport(dir, slug, st.copilot?.supportConfirmed === true, { signal });
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
            "recorded; call request_copilot_review again.",
        }],
        details: { ...(st.copilot ? { status: st.copilot.status } : {}), pr: pr.number },
      };
    }
    const why = ghError(requested, "the review request was refused");
    const abandoned = copilotAbandonedText(st.copilot);
    st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
      `Copilot review could not be requested: ${why}`, nowIso, pr.head);
    deps.persist(ctx, root);
    deps.log(`copilot cycle released UNSUPPORTED on request for PR #${pr.number}: ${why}`);
    return {
      content: [{
        type: "text",
        text: `review-gate: Copilot code review is not available for PR #${pr.number} — ${why}. ` +
          "Requirement released (UNSUPPORTED)." + abandoned,
      }],
      details: { status: "UNSUPPORTED", pr: pr.number },
    };
  }
  // NOTE: no read-back here on purpose. Measured on a repository where
  // GitHub drops the request: `gh pr edit --add-reviewer @copilot` exits
  // 0, REST POST answers 200, and `reviewRequests` stays empty on all
  // three surfaces with no ReviewRequestedEvent in the timeline. A
  // read-back therefore cannot distinguish "dropped" from "not visible
  // yet", and using it as a veto declared healthy repos unsupported.
  // Availability is judged by evidence (above) and by whether a review
  // actually shows up (check_copilot_review).
  progress.done(`PR #${pr.number} 已请求`);
  st.copilot = recordCopilotRequest(st.copilot, {
    pr: pr.number,
    head: pr.head,
    nowIso,
    supportConfirmed: support.confirmed,
  });
  deps.persist(ctx, root);
  deps.armLoop();
  deps.log(`copilot review requested for PR #${pr.number} (round ${st.copilot.rounds}, ` +
    `availability ${support.support})`);
  const waitNote = support.support === "UNKNOWN"
    ? "No Copilot review has ever appeared on this repository's recent PRs and its owner is not " +
      "on the allow-list, so if nothing comes back the requirement is released instead of " +
      "waiting."
    : "Copilot usually answers within a minute.";
  return {
    content: [{
      type: "text",
      text: `review-gate: Copilot review requested for PR #${pr.number} (round ${st.copilot.rounds}). ` +
        `${waitNote} Call check_copilot_review to see whether it answered, and what it left open.`,
    }],
    details: {
      status: "AWAITING",
      pr: pr.number,
      rounds: st.copilot.rounds,
      support: support.support,
    },
  };
}

// ---------- check_copilot_review ----------

async function doCheckCopilotReview(
  deps: CopilotReviewToolDeps,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  ctx: unknown,
): Promise<ToolReply> {
  // Copilot answers in "usually less than 30 seconds" — but the poll can
  // run through several attempts, so each one announces itself.
  const progress = createProgressReporter({
    title: "review-gate: check_copilot_review",
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
      content: [{ type: "text", text: "review-gate: the Copilot review loop is off for this repo/mode — nothing to check." }],
      details: { status: "DISABLED" },
    };
  }
  // Already released: SATISFIED / UNSUPPORTED / EXHAUSTED are decisions,
  // not snapshots. Re-running the checks here would spend gh calls to
  // re-derive a state the gate has already let go — and, before the state
  // machine grew its terminal short-circuit, could resurrect it and block
  // `declare_done` on a requirement that was finished.
  const settled = st.copilot;
  if (settled && !isCopilotOutstanding(settled)) {
    return {
      content: [{
        type: "text",
        text: `review-gate: the Copilot requirement is already released (${settled.status})` +
          `${settled.note ? ` — ${settled.note}` : ""}. It is not blocking completion; checking ` +
          "again changes nothing. A fresh round starts only on a new push / PR update, or if you " +
          "deliberately call request_copilot_review again." +
          // A cycle can be released with findings still open (any of the
          // fail-safe paths below). Repeating the reminder here means the
          // duty survives a re-check instead of scrolling away.
          copilotAbandonedText(settled),
      }],
      details: {
        status: settled.status,
        ...(settled.pr === null ? {} : { pr: settled.pr }),
        ...(settled.openThreads ? { unhandled: settled.openThreads } : {}),
      },
    };
  }
  const dir = deps.repoDir(root);
  progress.step("解析当前分支的 PR");
  const resolved = await deps.gh.resolveOpenPr(dir, signal);
  if (!resolved.pr) {
    const abandoned = copilotAbandonedText(st.copilot);
    st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
      `no Copilot review possible: ${resolved.error}`, new Date().toISOString());
    deps.persist(ctx, root);
    deps.log(`copilot cycle released UNSUPPORTED on check: ${resolved.error}`);
    return {
      content: [{
        type: "text",
        text: `review-gate: no pull request to check — ${resolved.error}. Requirement released ` +
          "(UNSUPPORTED)." + abandoned,
      }],
      details: { status: "UNSUPPORTED" },
    };
  }
  const pr = resolved.pr;
  const slug = await deps.gh.resolveRepoSlug(dir, pr, signal);
  if (!slug) {
    const abandoned = copilotAbandonedText(st.copilot);
    st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
      "could not determine the GitHub owner/repo for this PR", new Date().toISOString());
    deps.persist(ctx, root);
    deps.log(`copilot cycle released UNSUPPORTED on check: no owner/repo for PR #${pr.number}`);
    return {
      content: [{
        type: "text",
        text: "review-gate: could not determine owner/repo for this PR. Requirement released " +
          "(UNSUPPORTED)." + abandoned,
      }],
      details: { status: "UNSUPPORTED" },
    };
  }

  // Short optimistic poll for the fast path (GitHub documents "usually
  // less than 30 seconds"). The REAL waiting mechanism is the persistent
  // AWAITING state plus the L2 continuation: blocking a tool call for
  // minutes would burn the turn and ignore an ESC in the meantime.
  let payload: CopilotPayload | undefined;
  let next = st.copilot ?? armCopilotReview(undefined, new Date().toISOString());
  let support: CopilotSupport = "CONFIRMED";
  let supportResolved = false;
  for (let attempt = 0; attempt < COPILOT_CHECK_ATTEMPTS; attempt++) {
    progress.step(`轮询 PR #${pr.number} 的 Copilot 回复（第 ${attempt + 1}/${COPILOT_CHECK_ATTEMPTS} 次）`);
    if (signal?.aborted) break;
    payload = await deps.gh.fetchCopilotPayload(dir, slug, pr.number, signal);
    if (payload) {
      const analysis = analyzeCopilot(payload, { anchorAt: next.requestedAt ?? next.armedAt });
      // Availability is only worth a query when the PR itself shows
      // nothing yet, and only once per call. Copilot on THIS PR is the
      // strongest evidence there is, and it costs no API call at all.
      if (!supportResolved || analysis.present) {
        const decided = await deps.gh.resolveCopilotSupport(dir, slug, st.copilot?.supportConfirmed === true, {
          onPr: analysis.present,
          signal,
        });
        support = decided.support;
        supportResolved = true;
        if (decided.confirmed) next = { ...next, supportConfirmed: true };
      }
      next = evaluateCopilot(
        next,
        analysis,
        {
          nowIso: new Date().toISOString(),
          now: Date.now(),
          support,
        },
      );
      next = { ...next, pr: pr.number };
      if (next.status !== "AWAITING") break;
    }
    if (attempt < COPILOT_CHECK_ATTEMPTS - 1) {
      await deps.delay(COPILOT_CHECK_DELAY_MS);
    }
  }

  progress.done(payload ? String(next.status) : "查询失败");
  if (!payload) {
    // The GraphQL query failed outright (no gh, no permission, API down).
    // Releasing is the fail-SAFE direction here: this requirement must
    // never strand a task over an unreachable API. What it must NOT do is
    // go quiet about findings an earlier check already found.
    const abandoned = copilotAbandonedText(st.copilot);
    st.copilot = releaseCopilotReview(st.copilot, "UNSUPPORTED",
      "the Copilot review query failed (gh missing, unauthenticated, or API refusal)", new Date().toISOString());
    deps.persist(ctx, root);
    deps.log(`copilot cycle released UNSUPPORTED on check: thread query failed for PR #${pr.number}`);
    return {
      content: [{
        type: "text",
        text: "review-gate: could not read the PR's review threads (gh missing, unauthenticated, " +
          "or API refusal). Requirement released (UNSUPPORTED)." + abandoned,
      }],
      details: { status: "UNSUPPORTED" },
    };
  }

  const analysis = analyzeCopilot(payload, { anchorAt: next.requestedAt ?? next.armedAt });
  // ---- the user's per-finding approval (round COPILOT_TRIAGE_ASK_FROM_ROUND on) ----
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
  deps.log(`copilot check for PR #${pr.number}: ${next.status} (availability ${support}` +
    `${next.note ? `, ${next.note}` : ""})` +
    `${triageRun ? `, triage asked ${triageRun.asked}` : ""}`);

  const lines = analysis.actionable.slice(0, 20).map((t) =>
    `  - ${t.id} ${t.path ?? "(no file)"}${t.line ? ":" + t.line : ""}` +
    `${t.isOutdated ? " [outdated — the code moved; if that fixed it, resolve the thread]" : ""}\n      ${t.excerpt}`);
  // The triaged round gets the by-decision text instead of the free-for-all
  // one: what the agent may touch is the whole point of having asked.
  const groups = triageRun ? summarizeTriage(analysis.actionable, next.triage) : undefined;
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
        "Then call check_copilot_review again."
      : next.status === "AWAITING"
        ? `review-gate: Copilot has not posted its review of PR #${pr.number} yet. Do something useful and ` +
          "call check_copilot_review again in a minute."
        // Released with a readable payload. `evaluateCopilot` puts
        // actionable threads ahead of every release, so this list is
        // normally empty — it is kept as the belt to the sidecar-count
        // braces used by the fail-safe paths above, and it costs one call
        // on data that is already in hand.
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
      support,
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

/** Register `request_copilot_review` and `check_copilot_review`. */
export function registerCopilotReviewTools(host: ToolHost, deps: CopilotReviewToolDeps): void {
  host.registerTool({
    name: "request_copilot_review",
    label: "Request Copilot Review",
    description:
      "Ask GitHub Copilot to review the current branch's pull request. Call this after a PR was " +
      "created or updated (the gate arms the requirement on a successful gh pr create / gh pr " +
      "edit / git push). The extension resolves the PR, requests the review itself, and stamps " +
      "the authoritative request time. If the repo or account cannot do Copilot code review (no " +
      "gh, no GitHub remote, no PR, API refusal) the requirement is released as UNSUPPORTED.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Absolute path of the repository (required once the session edited several repos)" })),
    }),
    execute: (_id, params, signal, onUpdate, ctx) =>
      doRequestCopilotReview(deps, params, signal as AbortSignal | undefined, onUpdate, ctx),
  });

  host.registerTool({
    name: "check_copilot_review",
    label: "Check Copilot Review",
    description:
      "Check what GitHub Copilot's review of the current PR left open. The extension queries the " +
      "reviews and review threads itself — you cannot report this outcome yourself. A thread " +
      "counts as handled when it is resolved OR when the last comment in it is yours (the " +
      "explanation of why it will not be fixed). Returns AWAITING (Copilot has not answered yet), " +
      `OPEN (threads still waiting on you, listed with their IDs) or SATISFIED. FROM ROUND ${COPILOT_TRIAGE_ASK_FROM_ROUND} ON the gate also asks the USER about every ` +
      "open finding, one dialog at a time, before you may touch it: the reply groups the threads " +
      "by their decision (fix / won't-fix-with-a-reply / not-related-resolve-it / not-answered), " +
      "and only the first group is yours to change. A finding nobody answered is NOT approval — " +
      "leave it alone and report it.",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({ description: "Absolute path of the repository (required once the session edited several repos)" })),
    }),
    execute: (_id, params, signal, onUpdate, ctx) =>
      doCheckCopilotReview(deps, params, signal as AbortSignal | undefined, onUpdate, ctx),
  });
}
