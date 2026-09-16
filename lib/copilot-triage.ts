/**
 * L7 — the USER's per-finding triage of a Copilot review, and the round
 * threshold that decides whether there is anything to ask at all.
 *
 * WHY THIS EXISTS (user decision, 2026-09-14). The first three Copilot rounds
 * are cheap: Copilot usually names something the agent agrees with, and the
 * agent fixes it. By round four the conversation has a history — a finding the
 * agent already argued about, one that is out of scope, one that was declined
 * one round ago — and letting the agent keep deciding alone is how the same
 * disagreement gets re-litigated. So from `COPILOT_TRIAGE_ASK_FROM_ROUND` on,
 * EVERY actionable finding is put to the user first, one dialog each, and only
 * the ones they mark `fix` may be changed.
 *
 * WHAT LIVES HERE. The rules, and nothing else: what a decision is, what
 * identifies a finding (its thread AND its last comment — Copilot speaking
 * again on the same thread is a NEW question), which findings still need one,
 * how decisions are folded into the sidecar, and how they group for the text
 * the agent reads. The dialogs themselves are `lib/copilot-review-tools.ts`'s
 * (through an injected `askFinding`), the words are its too.
 *
 * PURITY. No IO, no clock, no host objects, no throwing: `nowIso` is injected,
 * every function returns a new value, and a payload it does not recognize is
 * "no decision recorded" — never a guess in either direction. That is what
 * makes the round threshold and the re-ask rules testable without a terminal,
 * a `gh` or a session.
 */

import type { CopilotThread } from "./copilot-review.ts";
import { parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
// The interview's own escape row and its typed twin, imported rather than
// re-spelled: "skip the rest" is one convention in this gate, and a second
// constant would be a second thing to keep in sync.
import { ANSWER_IN_CHAT_INPUT, SKIP_REST_CHOICE, SKIP_REST_INPUT } from "./ask-user.ts";

/**
 * From this round on, every finding needs the user's approval before it may be
 * fixed. Rounds 1..3 keep the old behaviour (the agent triages alone): the
 * threshold exists because that is where the cheap agreement ends, not because
 * the first three rounds matter less.
 */
export const COPILOT_TRIAGE_ASK_FROM_ROUND = 4;

/**
 * How many findings ONE tool call may put in front of the user.
 *
 * Sibling of `ask_user`'s own per-call cap, for the same reason: an interview
 * is a conversation, not a wall. Findings past the cap are reported as
 * "not asked yet" and picked up by the next `copilot_review` — the tool
 * tells the agent to call it again, so they are never silently dropped.
 */
export const COPILOT_TRIAGE_MAX_QUESTIONS = 10;

/** The three answers a finding can get, as the user sees them. */
export const FIX_CHOICE = "修复";
export const DECLINE_CHOICE = "不修，回复说明为什么";
export const IRRELEVANT_CHOICE = "与我无关，直接 resolve 不提";

/** What the user told the agent to do with one finding. */
export type CopilotDecision = "fix" | "decline" | "irrelevant";

const DECISIONS: ReadonlySet<string> = new Set<CopilotDecision>(["fix", "decline", "irrelevant"]);

/** One decision, bound to the exact finding it was made about. */
export interface CopilotTriageRecord {
  /** `ReviewThread` id from GraphQL. */
  threadId: string;
  /**
   * Id of the thread's LAST comment when the user decided. A decision is about
   * a piece of text, not about a thread id: Copilot commenting again on the
   * same thread makes this different, and the finding is asked about again.
   */
  commentId: string;
  decision: CopilotDecision;
  /** The user's own words (the ✎ box), when they typed any. */
  reason?: string;
  /** ISO time the decision was recorded. */
  at: string;
}

/** Every decision of the CURRENT cycle is kept; one per finding key. */
export interface CopilotTriageState {
  at: string;
  records: CopilotTriageRecord[];
}

/**
 * Bound on the persisted record list — the only unbounded growth this state
 * has (a long conversation over a big PR). Oldest records are dropped first,
 * and a dropped record is not a wrong answer: that finding is simply asked
 * about again.
 */
export const COPILOT_TRIAGE_MAX_RECORDS = 200;

/** Does this round need the user's per-finding approval? */
export function triageAsksUser(rounds: number): boolean {
  return Number.isFinite(rounds) && rounds >= COPILOT_TRIAGE_ASK_FROM_ROUND;
}

/** What identifies the QUESTION. Both halves matter: the thread says which
 * piece of the PR, the last comment says which version of the complaint.
 */
export function findingKey(finding: { id: string; lastCommentId: string | null }): string {
  return `${finding.id}@${finding.lastCommentId ?? ""}`;
}

/** The same key for a RECORD, which spells the two halves its own way. */
function recordKey(record: { threadId: string; commentId: string }): string {
  return `${record.threadId}@${record.commentId}`;
}

/** The decision already recorded for this finding, if any. */
export function decisionFor(
  triage: CopilotTriageState | undefined,
  finding: { id: string; lastCommentId: string | null },
): CopilotTriageRecord | undefined {
  const key = findingKey(finding);
  return triage?.records.find((r) => recordKey(r) === key);
}

/** Is this finding still owing the user a question? */
export function needsQuestion(
  triage: CopilotTriageState | undefined,
  finding: { id: string; lastCommentId: string | null },
): boolean {
  return decisionFor(triage, finding) === undefined;
}

/**
 * Fold one answer in. Idempotent per finding key: answering the same question
 * again REPLACES the old record instead of stacking a second one (a re-ask can
 * happen when a payload arrives without a decision, and two records for one
 * finding would make the summary contradict itself).
 */
export function recordDecision(
  triage: CopilotTriageState | undefined,
  finding: { id: string; lastCommentId: string | null },
  decision: CopilotDecision,
  nowIso: string,
  reason?: string,
): CopilotTriageState {
  const key = findingKey(finding);
  const trimmed = reason?.trim();
  const record: CopilotTriageRecord = {
    threadId: finding.id,
    commentId: finding.lastCommentId ?? "",
    decision,
    ...(trimmed ? { reason: trimmed } : {}),
    at: nowIso,
  };
  const kept = (triage?.records ?? []).filter((r) => recordKey(r) !== key);
  const records = [...kept, record].slice(-COPILOT_TRIAGE_MAX_RECORDS);
  return { at: nowIso, records };
}

/** What one dialog's answer MEANS. `skip-rest` stops the remaining questions. */
export type CopilotTriagePick =
  | { kind: "decided"; decision: CopilotDecision; reason?: string }
  | { kind: "unanswered"; reason?: string }
  | { kind: "skip-rest" };

/** Everything the agent reads about one finding. */
export interface CopilotTriageEntry {
  thread: CopilotThread;
  /** Absent for a finding the user never answered. */
  record?: CopilotTriageRecord;
}

export interface CopilotTriageGroups {
  /** Change these, and only these. */
  fix: CopilotTriageEntry[];
  /** Reply in the thread with the reason (theirs, or one the agent writes) and resolve it. */
  decline: CopilotTriageEntry[];
  /** Resolve the thread without a reply. */
  irrelevant: CopilotTriageEntry[];
  /** Nobody said what to do: leave them alone and report them. */
  unanswered: CopilotTriageEntry[];
}

/**
 * Split the actionable findings by what the user decided.
 *
 * Order is preserved in every group, so the agent's list reads in the same
 * order the user saw the questions.
 */
export function summarizeTriage(
  threads: readonly CopilotThread[],
  triage: CopilotTriageState | undefined,
): CopilotTriageGroups {
  const groups: CopilotTriageGroups = { fix: [], decline: [], irrelevant: [], unanswered: [] };
  for (const thread of threads) {
    const record = decisionFor(triage, thread);
    if (!record) groups.unanswered.push({ thread });
    else if (record.decision === "fix") groups.fix.push({ thread, record });
    else if (record.decision === "decline") groups.decline.push({ thread, record });
    else groups.irrelevant.push({ thread, record });
  }
  return groups;
}

/**
 * What the ✎ box offers for a FINDING.
 *
 * The template's default hint advertises `!chat`, which means nothing here
 * (there is no interview to defer to the chat) — so this hint advertises only
 * what is honoured, and `triagePickFrom` honours both escapes it names.
 */
export const FINDING_REASON_PLACEHOLDER =
  "直接写你的理由（留空＝只说「不选」）；!skip＝跳过后续问题";

/**
 * Retired 2026-09-16 with the row budget (kept as a note, not as code): the
 * dialog no longer truncates a finding's body, so there is no cut for a
 * pointer to explain. The TRANSCRIPT copy it described is still printed before
 * every finding dialog opens — see the call site in `copilot-review-tools.ts` —
 * because approving a finding you cannot read is a bug whoever caused it.
 */

export function findingChoiceSpec(thread: CopilotThread, index: number, total: number): ChoiceSpec {
  const where = `${thread.path ?? "(no file)"}${thread.line ? ":" + thread.line : ""}`;
  return {
    title: `Copilot 评审问题 ${index + 1} / ${total}：${where}`,
    options: [FIX_CHOICE, DECLINE_CHOICE, IRRELEVANT_CHOICE],
    recommended: FIX_CHOICE,
    reasonPlaceholder: FINDING_REASON_PLACEHOLDER,
  };
}

/**
 * The long half of the dialog (and the transcript copy): which code, and what
 * Copilot actually said.
 *
 * The full comment, not the agent's 200-character excerpt, because the user is
 * being asked to DECIDE. When the thread's LATEST comment differs from its
 * first one, the latest is what is shown first: that comment is the reason the
 * question is being asked again at all (a decision is keyed to the comment it
 * was made about), so showing the old text would ask the user to approve
 * something they have already read.
 */
export function findingBody(thread: CopilotThread): string {
  const lines = [
    `文件：${thread.path ?? "(no file)"}${thread.line ? ":" + thread.line : ""}`,
  ];
  if (thread.isOutdated) lines.push("（GitHub 标记这段代码已移动，问题可能已经不存在）");
  const first = (thread.body || thread.excerpt).trim();
  const latest = thread.latestBody.trim();
  if (latest && latest !== first) {
    lines.push(
      "",
      "Copilot 最新的一条评论（这次重新确认的就是它）：",
      latest,
      "",
      `（这条 thread 最早那条评论是：「${first}」）`,
    );
  } else {
    lines.push("", "Copilot 的评论：", first);
  }
  return lines.join("\n");
}

/**
 * What the line the user picked MEANS.
 *
 * `undefined` and every unrecognized line are `unanswered` — never `fix`. That
 * is the whole point of the feature: an unanswered finding stays the user's to
 * decide, and the conservative direction is the one that does not touch their
 * code.
 */
export function triagePickFrom(picked: string | undefined, spec: ChoiceSpec): CopilotTriagePick {
  const parsed = parseChoice(picked, spec);
  if (parsed.kind === "dismissed") return { kind: "unanswered" };
  if (parsed.kind === "declined") {
    // The `✎ 不选，我说明原因` row: they picked none of the three. What they
    // typed is carried to the agent verbatim, but it is NOT a decision.
    const typed = parsed.reason.trim().toLowerCase();
    // …unless it is one of the escapes the box's own hint advertises.
    if (typed === SKIP_REST_INPUT) return { kind: "skip-rest" };
    if (typed === ANSWER_IN_CHAT_INPUT) return { kind: "unanswered", reason: "（他想改在聊天里说）" };
    return parsed.reason ? { kind: "unanswered", reason: parsed.reason } : { kind: "unanswered" };
  }
  if (parsed.option === SKIP_REST_CHOICE) return { kind: "skip-rest" };
  if (parsed.option === FIX_CHOICE) return { kind: "decided", decision: "fix" };
  if (parsed.option === DECLINE_CHOICE) return { kind: "decided", decision: "decline" };
  if (parsed.option === IRRELEVANT_CHOICE) return { kind: "decided", decision: "irrelevant" };
  // A line none of the rows produced — an orchestrator answering with free
  // text of its own. Carried to the agent as words, never read as consent.
  return { kind: "unanswered", reason: parsed.option };
}

/** The findings this call will ask about, and how many it must defer. */
export function triageAskPlan(
  threads: readonly CopilotThread[],
  triage: CopilotTriageState | undefined,
  max = COPILOT_TRIAGE_MAX_QUESTIONS,
): { ask: CopilotThread[]; deferred: number } {
  const pending = threads.filter((t) => needsQuestion(triage, t));
  return { ask: pending.slice(0, Math.max(0, max)), deferred: Math.max(0, pending.length - max) };
}

/**
 * Sidecar validation for the triage block.
 *
 * Direction of failure is the same one the rest of the Copilot state uses:
 * a record nobody can verify is DROPPED, which puts that finding back in front
 * of the user. Dropping is the safe direction — inventing a decision is how the
 * gate would fix something the user never approved.
 */
export function sanitizeCopilotTriage(raw: unknown): CopilotTriageState | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const rawRecords = Array.isArray(obj.records) ? obj.records : [];
  const records: CopilotTriageRecord[] = [];
  for (const item of rawRecords) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.threadId !== "string" || rec.threadId.length === 0) continue;
    if (typeof rec.decision !== "string" || !DECISIONS.has(rec.decision)) continue;
    records.push({
      threadId: rec.threadId,
      commentId: typeof rec.commentId === "string" ? rec.commentId : "",
      decision: rec.decision as CopilotDecision,
      ...(typeof rec.reason === "string" && rec.reason.trim()
        ? { reason: rec.reason.trim().slice(0, 500) }
        : {}),
      at: typeof rec.at === "string" ? rec.at : "",
    });
  }
  if (records.length === 0) return undefined;
  return {
    at: typeof obj.at === "string" ? obj.at : "",
    records: records.slice(-COPILOT_TRIAGE_MAX_RECORDS),
  };
}
