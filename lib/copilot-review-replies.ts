/**
 * What `copilot_review` (lib/copilot-review-tools.ts) SAYS: the triage
 * interview that puts each finding to the user, the grouped text built from
 * their answers, and the replies for a released cycle — including the
 * abandoned-findings duty every release path carries.
 *
 * Split out of the tool module so the tool file keeps only the tool body and
 * its registration. The triage RULES are lib/copilot-triage.ts; this module
 * only asks and words.
 */

import type { ToolReply } from "./tool-host.ts";
import type { GateState } from "./gate-state.ts";
import {
  COPILOT_TRIAGE_ASK_FROM_ROUND,
  findingBody,
  findingChoiceSpec,
  findingKey,
  recordDecision,
  triageAskPlan,
  triagePickFrom,
  type CopilotTriageGroups,
  type CopilotTriageState,
} from "./copilot-triage.ts";
import { releaseCopilotReview, type CopilotReviewState } from "./copilot-review-state.ts";
import type { CopilotThread } from "./copilot-probe-parse.ts";
import type { CopilotReviewToolDeps } from "./copilot-review-tools.ts";

/**
 * The two gh commands a thread needs. Kept as constants so the pre-round-4
 * text and the triaged text teach the SAME commands — one wording, not two.
 */
export const RESOLVE_THREAD_CMD =
  "gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t})" +
  "{thread{isResolved}}}' -F t=<threadId>";
export const REPLY_THREAD_CMD =
  "gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply" +
  "(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}' -F t=<threadId> -F b='<why>'";

/**
 * Put every finding that still owes the user a question in front of them, and
 * fold the answers into the triage state.
 *
 * ONE DIALOG AT A TIME, in the order the findings came back, with the escape
 * row an interview has. The `ask_user` interview hands its whole batch to the
 * channel up front so a project manager can answer everything at once
 * (lib/ask-user-interview.ts); this loop deliberately does NOT — a Copilot
 * round is a handful of questions, and a second batching convention is a
 * second thing to keep right. ponytail: sequential; batch the channel
 * requests here if a supervised child with 10 findings ever shows the cost.
 *
 * A STOP (a closed box, or an abort) does not undo anything: the answers
 * already given are kept and persisted with the rest of the state, and the
 * findings that were never asked are simply still unanswered — which asks
 * them again on the next call instead of inventing a decision.
 */
export async function askFindings(
  deps: CopilotReviewToolDeps,
  ctx: unknown,
  signal: AbortSignal | undefined,
  findings: readonly CopilotThread[],
  current: CopilotTriageState | undefined,
): Promise<{ triage: CopilotTriageState | undefined; notes: Map<string, string>; asked: number }> {
  const pending = triageAskPlan(findings, current);
  /** What the user said when they picked NONE of the three answers. */
  const notes = new Map<string, string>();
  let triage = current;
  let stopped = false;
  for (const [index, thread] of pending.entries()) {
    if (stopped || signal?.aborted) break;
    const spec = findingChoiceSpec(thread, index, pending.length);
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
      ...(signal ? { signal } : {}),
    });
    const outcome = triagePickFrom(picked, spec);
    if (outcome.kind === "unanswered") {
      if (outcome.reason) notes.set(findingKey(thread), outcome.reason);
      // CLOSING THE BOX STOPS THE ROUND (2026-09-17): no box came back at all,
      // so the user is done answering for now. The findings left unasked hold
      // no record — which is exactly what puts them back in front of the user
      // on the next call.
      if (picked === undefined) stopped = true;
      continue;
    }
    triage = recordDecision(triage, thread, outcome.decision, new Date().toISOString(), outcome.reason);
  }
  return { triage, notes, asked: pending.length };
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
export function triageText(args: {
  pr: number;
  rounds: number;
  groups: CopilotTriageGroups;
  notes: Map<string, string>;
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

/** A released cycle is a decision, not a snapshot — say so and stop. */
export function releasedReply(state: CopilotReviewState): ToolReply {
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
export function releaseReply(args: {
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
