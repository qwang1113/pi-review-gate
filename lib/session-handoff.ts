/**
 * WHEN A SESSION HANDS OVER, WHAT ITS SUCCESSOR READS, AND HOW THE GATE KNOWS
 * THE SUCCESSION TOOK — the one policy every session kind shares.
 *
 * WHY ONE MODULE AND NOT THREE (2026-09-14, user decision). "My context is
 * nearly full" used to be answered three different ways:
 *
 *  - the orchestrator had a hand-written handoff document plus two percentage
 *    thresholds nobody acted on (lib/orchestrator-handoff-advice.ts, 80/90);
 *  - a judge had its own transcript rotation at 60% (lib/judge-rotation.ts);
 *  - a plain loop session had NOTHING.
 *
 * The measured cost of leaving it that way is the user's own report: an
 * orchestrator that reached its handoff did open a successor pane, but the
 * pane was a bare `pi` with no first message — nothing told it to read the
 * handoff document, nothing told it to attach, and nothing ever closed the
 * predecessor. Two sessions sat staring at each other. The chain has one
 * owner now: the gate measures, writes the document skeleton, opens the pane
 * with a first message, and closes the predecessor once the successor has
 * demonstrably taken over.
 *
 * WHAT THE AGENT STILL OWNS, AND WHY (user decision, same day). The gate
 * does NOT hand over by itself: reaching the threshold produces a REMINDER
 * plus the document skeleton, and the agent calls `session_handoff()` when it
 * is ready — it is the only party that knows the work is at a stopping point.
 * What it no longer owns is any step after that call: which pane opens, what
 * the successor is told, and when the old session dies are mechanical.
 *
 * Pure: no clock, no filesystem, no process. Every fact arrives as an
 * argument, which is what makes each rule unit-testable.
 */

import { buildRejection } from "./rejection-copy.ts";

/**
 * Context percentage at which a session is told to hand over.
 *
 * 70 is the USER's number (2026-09-14): 700k of a 1M window, stated as a
 * ratio so it survives a model with a different window. It replaces the
 * orchestrator's 80/90 pair and the judge's 60 — one threshold for every kind
 * of session, because "which number is my session on" is exactly the sort of
 * thing nobody looks up in time.
 */
export const HANDOFF_PERCENT = 70;

/** The heading the agent writes its own paragraph under. */
export const HANDOFF_FILL_HEADING = "## 前任补充（意图、坑、下一步）";

/** A successor that read the document writes nothing here — the gate says so. */
export const HANDOFF_FILL_PLACEHOLDER =
  "（还没写。交付前把「为什么做、踩过哪些坑、下一步是什么」写在这里 —— 继任者只有这段是你的视角。）";

/**
 * THE FULL READOUT — what the host reported, as numbers.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE PERCENTAGE (2026-09-14, user
 * requirement): a session could not answer "how full is my context" without
 * guessing, and guessing is what it did — measured that same day, a session
 * spent a whole work round convinced it was about to run out while the status
 * bar read 35.8%. The gate measures this number anyway; `context_status`
 * (lib/session-handoff-tools.ts) hands it to the session that owns it.
 *
 * Every field is optional and absence means UNKNOWN, never zero.
 */
export interface ContextReadout {
  tokens?: number;
  contextWindow?: number;
  percent?: number;
}

export function readContext(usage: unknown): ContextReadout {
  if (typeof usage !== "object" || usage === null) return {};
  const value = usage as { tokens?: unknown; contextWindow?: unknown; percent?: unknown };
  const tokens =
    typeof value.tokens === "number" && Number.isFinite(value.tokens) ? value.tokens : undefined;
  const contextWindow =
    typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow) && value.contextWindow > 0
      ? value.contextWindow
      : undefined;
  const percent = typeof value.percent === "number" && Number.isFinite(value.percent)
    ? value.percent
    : tokens !== undefined && contextWindow !== undefined
      ? (tokens / contextWindow) * 100
      : undefined;
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(percent === undefined ? {} : { percent }),
  };
}

/**
 * Turn pi's `getContextUsage()` into a percentage — or nothing.
 *
 * `percent` is preferred when pi gives it; `tokens / contextWindow` is the
 * arithmetic fallback. Anything else — no usage object, a null token count, a
 * zero window — yields `undefined`, because a missing measurement must never
 * be rendered as room to spare (the direction lib/session-exclusivity.ts
 * takes about liveness, for the same reason).
 *
 * This function used to live in lib/orchestrator-handoff-advice.ts, where the
 * first version read `usage.used / usage.max` — fields pi does not have, so
 * the fallback that was supposed to cover "percent is null right after a
 * compaction" could never once have fired. One implementation (`readContext`),
 * one test per shape.
 */
export function contextPercentFromUsage(usage: unknown): number | undefined {
  return readContext(usage).percent;
}

/**
 * The same reading, taken straight off a host context. `getContextUsage` is a
 * host call that can throw (a replaced session's context asserts on access),
 * and a throw here is "no reading", never a crash of whoever asked.
 */
export function contextPercentOf(ctx: { getContextUsage?: () => unknown } | undefined): number | undefined {
  try {
    return contextPercentFromUsage(ctx?.getContextUsage?.());
  } catch {
    return undefined;
  }
}

/** A token count as a reader expects it: `358k`, `1.0M`, `950`. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

/**
 * The answer to "how full am I?", as the session itself reads it.
 *
 * Two facts, never one: the NUMBER (what the host measured) and the DECISION
 * (the one threshold every kind of session shares). A bare percentage invites
 * the mistake this whole module exists to remove — reasoning about the
 * plumbing instead of the work — so the line states what to do about it and
 * stops. `docPath` is rendered only when the threshold is actually passed.
 */
export function formatContextStatus(
  readout: ContextReadout,
  opts: { docPath?: string } = {},
): string {
  const { tokens, contextWindow, percent } = readout;
  if (percent === undefined) {
    return [
      "上下文：宿主没有提供读数（无法判断余量与交接时机）。",
      `交接阈值：${HANDOFF_PERCENT}% 窗口。`,
    ].join("\n");
  }
  const head =
    tokens !== undefined && contextWindow !== undefined
      ? `上下文：${formatTokens(tokens)} / ${formatTokens(contextWindow)}（${percent.toFixed(1)}%，宿主读数）`
      : `上下文：${percent.toFixed(1)}%（宿主读数，未报 token 数）`;
  const due = percent >= HANDOFF_PERCENT;
  if (!due) {
    const headroom = contextWindow === undefined
      ? ""
      : `（${formatTokens(contextWindow * (HANDOFF_PERCENT / 100))} 前不用交接）`;
    return [head, `交接阈值：${HANDOFF_PERCENT}%${headroom} —— 余量充足。`].join("\n");
  }
  return [
    head,
    `上下文：**已过交接阈值 ${HANDOFF_PERCENT}%**。`,
    "下一步：先把你自己的那一段（意图、坑、下一步）写进交接文档，再调 `session_handoff()`。" +
      (opts.docPath ? `文档在 \`${opts.docPath}\`。` : ""),
  ].join("\n");
}

/** What the gate knows about one session's context, right now. */
export interface HandoffDue {
  /** True ⇒ remind on every round; false ⇒ stay quiet. */
  due: boolean;
  /** Rounded percent, when the host reported one. */
  percent?: number;
}

/**
 * Is this session past the handover threshold?
 *
 * A reading the host could not supply is NOT a reason to remind: an unreadable
 * context is missing information, and a reminder that fires on missing
 * information trains its reader to ignore it.
 *
 * The comparison uses the RAW percentage and rounds only for display: 69.9% is
 * below the threshold, and rounding it to 70 first would fire the reminder a
 * little early on every session whose window is not exactly 1M tokens.
 */
export function handoffDue(usage: unknown): HandoffDue {
  const percent = contextPercentFromUsage(usage);
  if (percent === undefined || !Number.isFinite(percent)) return { due: false };
  return { due: percent >= HANDOFF_PERCENT, percent: Math.round(percent) };
}

/**
 * WHAT EVERY SESSION KIND HANDS OVER — the values, not the prose.
 *
 * `contract` is the running agreement this session serves (a loop goal, an
 * approved plan, this round's review task); `outstanding` is the list of
 * things a successor must not have to rediscover (unfinished plan tasks,
 * unanswered questions, uncommitted work, an unreviewed diff). Both arrive
 * pre-rendered: the gate assembles them from its own state, this module owns
 * only how they are written down.
 */
export interface HandoffDocFacts {
  /** Which kind of session is handing over — the successor's identity depends on it. */
  kind: HandoffSessionKind;
  /** The handing-over session's own id. */
  sessionId: string;
  repoRoot: string;
  /** The contract in force, already rendered (may be empty). */
  contract?: string;
  /** What is still open, one line each. */
  outstanding?: string[];
  /** Path of the transcript the successor may dig through. */
  transcriptPath?: string;
  /** The successor's first action, in one sentence. */
  firstAction?: string;
  /** ISO timestamp, injected (this module has no clock). */
  now?: string;
  /** The predecessor's last user messages, verbatim (see `lastUserMessages`); absent = unreadable. */
  recentUserMessages?: string[];
}

/** The four kinds of session that can hand over. */
export type HandoffSessionKind = "loop" | "orchestrator" | "child" | "judge";

/** Human-readable names, so a document never says "child" to a reader. */
const KIND_LABEL: Record<HandoffSessionKind, string> = {
  loop: "普通 loop 会话",
  orchestrator: "项目经理（orchestrator）",
  child: "编排子会话",
  judge: "审核会话（judge）",
};

/**
 * The document a successor reads first.
 *
 * DELIBERATELY MECHANICAL. Every fact it states is one the gate observed, so
 * the successor can trust the frame even when the agent's paragraph is thin or
 * missing: the contract is what is on disk, the outstanding list is what the
 * gate's own state says, the transcript path is where the whole history lives.
 * The agent's own paragraph is the ONE section a human voice adds, and it is
 * clearly marked so a reader knows which half is testimony.
 */
export function buildHandoffDoc(facts: HandoffDocFacts): string {
  const lines: string[] = [
    `# 会话交接：${KIND_LABEL[facts.kind]}`,
    "",
    `- 交接时间：${facts.now ?? "(未记录)"}`,
    `- 仓库：\`${facts.repoRoot}\``,
    `- 前任 session：\`${facts.sessionId}\``,
    ...(facts.transcriptPath
      ? [`- 前任 transcript（原始记录，有问题自己 grep）：\`${facts.transcriptPath}\``]
      : []),
    ...(facts.firstAction ? ["", "## 接手后第一件事", "", facts.firstAction] : []),
    "",
    "## 当前契约",
    "",
    facts.contract?.trim() ? facts.contract.trim() : "（门禁没有记录到生效的契约）",
    "",
    "## 未完成的工作",
    "",
    ...(facts.outstanding?.length ? facts.outstanding.map((line) => `- ${line}`) : ["- （门禁没有记录到未完成项）"]),
    "",
    RECENT_USER_HEADING,
    "",
    recentUserBlock(facts.recentUserMessages),
    "",
    HANDOFF_FILL_HEADING,
    "",
    HANDOFF_FILL_PLACEHOLDER,
    "",
  ];
  return lines.join("\n");
}

/**
 * DID THE AGENT WRITE ITS PARAGRAPH?
 *
 * The placeholder is the marker, so the test is on the placeholder's absence
 * rather than on any guess about length. A successor that finds it still there
 * knows the mechanical frame is all there is — which is a fact worth being
 * able to read, not an error.
 */
export function handoffDocFilled(doc: string): boolean {
  return !String(doc ?? "").includes(HANDOFF_FILL_PLACEHOLDER);
}

/**
 * THE USER'S OWN WORDS, carried across the handover (2026-09-26, measured).
 *
 * A project manager handed over without writing its paragraph; the document
 * held only an old plan with every task done, and the requirement the user had
 * JUST given never reached the successor, which read "plan done ⇒ declare_done"
 * and stopped. The contract and outstanding list are what the gate recorded —
 * a requirement spoken a minute ago is in neither. The last user messages are.
 */
export const RECENT_USER_HEADING = "## 前任最后的用户消息（原文）";

/** How many user messages the document carries, and how long each may be. */
export const RECENT_USER_COUNT = 3;
export const RECENT_USER_MAX_CHARS = 2000;

const NO_RECENT_USER = "（没有记录到用户消息）";
/** Missing reading ≠ no messages (the direction `handoffDue` takes too). */
const UNREAD_RECENT_USER = "（门禁读不到会话记录 —— 最后的用户消息去前任 transcript 里看）";

/**
 * The section is fenced by line-start markers, NOT found by its heading: the
 * contract above it is free text (a loop goal can quote this very heading), so
 * a heading search could land in the contract and overwrite it (reviewer P1,
 * 2026-09-26). The gate's section is always the LAST fence in the document.
 */
const RECENT_USER_START = "<!-- rg:recent-user-messages -->";
const RECENT_USER_END = "<!-- /rg:recent-user-messages -->";

/**
 * The last `n` user messages in a session's entries, oldest first, as text.
 *
 * Entries are pi's session entries (`{type:"message", message:{role, content}}`,
 * content a string or a block array). Non-text blocks are skipped; a message
 * with no text at all is not counted. Over `RECENT_USER_MAX_CHARS` characters
 * the text is cut and says so — the transcript keeps the rest.
 */
export function lastUserMessages(entries: readonly unknown[], n: number): string[] {
  const texts: string[] = [];
  for (const entry of entries ?? []) {
    const message = (entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null);
    if (message?.type !== "message" || message.message?.role !== "user") continue;
    const content = message.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n")
        : "";
    if (text.trim()) texts.push(text);
  }
  return texts.slice(Math.max(0, texts.length - n)).map((text) => {
    const chars = [...text];
    return chars.length <= RECENT_USER_MAX_CHARS
      ? text
      : chars.slice(0, RECENT_USER_MAX_CHARS).join("") + `\n（已截断，原文 ${chars.length} 字，全文见 transcript）`;
  });
}

/**
 * The fenced body. Every message line is quoted (`> `), so a message can never
 * put a marker at the start of a line and end the fence early.
 */
function recentUserBlock(messages: readonly string[] | undefined): string {
  const body = messages === undefined
    ? UNREAD_RECENT_USER
    : messages.length === 0
    ? NO_RECENT_USER
    : messages
      .map((text, i) => [`### ${i + 1} / ${messages.length}`, "", ...text.split("\n").map((line) => `> ${line}`)].join("\n"))
      .join("\n\n");
  return `${RECENT_USER_START}\n\n${body}\n\n${RECENT_USER_END}`;
}

/** Where the gate's fence sits: [start of the start marker, end of the end marker). */
function recentUserFence(doc: string): { start: number; end: number } | undefined {
  const at = `\n${doc}`.lastIndexOf(`\n${RECENT_USER_START}\n`);
  if (at < 0) return undefined;
  const close = `\n${doc}`.indexOf(`\n${RECENT_USER_END}`, at + 1);
  if (close < 0) return undefined;
  return { start: at, end: close + RECENT_USER_END.length };
}

/** The section's body, or undefined when the document has none. */
export function recentUserSection(doc: string): string | undefined {
  const fence = recentUserFence(doc);
  if (!fence) return undefined;
  return doc.slice(fence.start + RECENT_USER_START.length, fence.end - RECENT_USER_END.length).trim();
}

/**
 * Refresh the section in an EXISTING document without touching anything else.
 *
 * The skeleton is often written at the 70% reminder, well before the call —
 * and the incident's requirement arrived in between. A document without the
 * section gets it inserted before the agent's paragraph.
 */
export function withRecentUserMessages(doc: string, messages: readonly string[]): string {
  const fence = recentUserFence(doc);
  if (fence) return doc.slice(0, fence.start) + recentUserBlock(messages) + doc.slice(fence.end);
  const section = `${RECENT_USER_HEADING}\n\n${recentUserBlock(messages)}\n`;
  // No fence yet: before the agent's paragraph — the LAST line-start heading,
  // since the contract above it may quote the heading too.
  const fill = `\n${doc}`.lastIndexOf(`\n${HANDOFF_FILL_HEADING}`);
  return fill < 0 ? `${doc.trimEnd()}\n\n${section}` : doc.slice(0, fill) + section + "\n" + doc.slice(fill);
}

/**
 * A SUCCESSOR'S FIRST `declare_done` IS REFUSED ONCE (2026-09-26).
 *
 * The refusal IS the check: it pastes the predecessor's last user messages
 * back and asks for each to be confirmed handled. Counting tool calls would
 * not have caught the incident — that successor had read the document and
 * attached before it stopped. `checked` is the caller's once-flag.
 */
export function successorDoneRefusal(input: {
  isSuccessor: boolean;
  checked: boolean;
  docPath?: string;
  doc?: string;
}): string | undefined {
  if (!input.isSuccessor || input.checked) return undefined;
  const section = input.doc === undefined ? undefined : recentUserSection(input.doc);
  const where = input.docPath ? ` \`${input.docPath}\`` : "";
  return buildRejection({
    what: "declare_done 被拒一次 —— 你是接任会话，收工前先核对前任最后的用户消息",
    why: section
      ? `交接文档${where}里记录的最后几条用户消息（原文）：\n\n${section}\n`
      : `交接文档${where}里读不到「前任最后的用户消息」段 —— 去前任 transcript 里找最后几条用户消息。`,
    by: "agent",
    next: "逐条确认每条里的要求都已做完（或已进 plan、已派出），没有被旧契约漏掉；" +
      "没做完就接着做，都处理了再调一次 `declare_done`（这条核对只拦一次）。",
  });
}

/**
 * WHAT COUNTS AS A SUCCESSFUL TAKEOVER — BOTH facts, and the conjunction is
 * the user's own wording (asked and answered 2026-09-14: "新会话读完交接文档
 * 并成功跑完第一次接手动作（attach/读现场）后，门禁自动杀掉老 pane").
 *
 * IT WAS AN `OR`, AND THAT WAS WRONG (goal audit, same day). The OR made the
 * weaker half sufficient — a successor that ran any bash command successfully
 * would close its predecessor WITHOUT ever opening the handoff document, which
 * is exactly the failure the user reported: a handover that completes while
 * the context it was supposed to carry is still unread. The conjunction can
 * only ever refuse to close too early, and a predecessor that stays alive is
 * the harmless direction — it is retired, silent, and still holding its own
 * transcript.
 *
 * In the ordinary path the two facts arrive TOGETHER: the successor's first
 * tool call is the `read` of the document its opening message points at.
 */
export function handoffAccepted(facts: {
  readHandoffDoc: boolean;
  firstToolSucceeded: boolean;
}): boolean {
  return facts.readHandoffDoc === true && facts.firstToolSucceeded === true;
}

/**
 * The reminder the gate injects every round once the threshold is passed.
 *
 * It names the document path and the ONE tool to call, because a reminder that
 * says "consider handing over" and stops there is the 80%-advice failure again
 * — a fact the agent has to translate into a sequence. `pendingFill` is true
 * while the agent's own paragraph is still the placeholder, so the reminder
 * can ask for the writing and the call in the order they have to happen.
 */
export function handoffReminder(input: {
  kind: HandoffSessionKind;
  percent: number;
  docPath: string;
  pendingFill: boolean;
}): string {
  const who = KIND_LABEL[input.kind];
  return [
    `## 会话交接（门禁提醒 · ${who}）`,
    "",
    `本会话上下文已用 ${input.percent}%（阈值 ${HANDOFF_PERCENT}%）。`,
    "门禁已经把交接文档的机械骨架写在 `" + input.docPath + "` 了：契约与未完成项是真值，不需要你复述。",
    ...(input.pendingFill
      ? ["", `先把你自己的那一段写进 \`${HANDOFF_FILL_HEADING}\`（为什么这么做、踩过哪些坑、下一步），再调 \`session_handoff()\`。`]
      : ["", "你已经补过交接段落了，随时可以调 `session_handoff()`。"]),
    "",
    "调用之后门禁会自己完成剩下的一切：开新 pane、给继任者第一条消息、确认它接手后关掉本会话。" +
      "**不要**自己开 pane、不要自己关会话、不要手写整份文档。",
  ].join("\n");
}
