/**
 * WHILE THE GATE WAITS ON ITS OWN AUDITOR (2026-09-27).
 *
 * `propose_loop_goal` and `orchestrator_plan submit` block inside the gate
 * while a goal-auditor judges the draft. Measured (orch-f3eb4277, 2026-09-26
 * 15:21–15:26): the auditor's `judge_conclude` was refused, it asked its
 * opener what to do, and nobody could answer — the opener was the blocked
 * tool call itself. The question sat until the pane was reclaimed, the user
 * saw nothing but "Working", and the call ended with "等待未命中本轮 report".
 *
 * This module is what the wait does beside waiting:
 *  - a PROGRESS LINE that names where the auditor runs and how long it has
 *    been (`auditWaitProgressLine`);
 *  - every question the auditor raises is put to the USER through the gate's
 *    own dialog, and the answer is written back to the auditor's channel; a
 *    question answered in the auditor's own pane first takes the box down
 *    (`watchAuditRound`);
 *  - a round that ends without a verdict says WHY (`classifyAuditWaitFailure`).
 *
 * The decisions are pure functions; `watchAuditRound` reaches the world only
 * through its deps, so every branch runs with fakes.
 */

import type { ChannelRecord, ChannelRequestRecord } from "./channel-records.ts";
import { projectChannel } from "./channel-projection.ts";
import { looksLikeDeclineRow, RECOMMEND_MARKER, type ChoiceSpec } from "./choice-dialog.ts";
import { resolveAnswer } from "./orchestrator-answer-rules.ts";

/** Where the auditor lives, as the registry recorded it. */
export interface AuditLocation {
  role: string;
  tmuxSession?: string;
  windowId?: string;
  paneId?: string;
}

/** `goal-auditor 在 tmux rg-x:@3（pane %9）里跑，已等 75s`. */
export function auditWaitProgressLine(where: AuditLocation, elapsedMs: number, extra?: string): string {
  const place = where.tmuxSession && where.windowId
    ? `tmux ${where.tmuxSession}:${where.windowId}`
    : "tmux（位置未登记）";
  const pane = where.paneId ? `（pane ${where.paneId}）` : "";
  const line = `${where.role} 在 ${place}${pane}里跑，已等 ${Math.max(0, Math.round(elapsedMs / 1000))}s`;
  return extra ? `${line}\n${extra}` : line;
}

const ROW_LETTER = /^[A-Za-z]\.\s+/;

/**
 * The auditor's question as a gate dialog, or undefined when it cannot be
 * one (a free-text or multi-answer question, or fewer than two real options).
 * The rows arrive decorated (`A. text（推荐）`, plus the decline row); the
 * dialog adds its own letters, marker and decline row, so all three go.
 */
export function questionDialogSpec(request: ChannelRequestRecord): ChoiceSpec | undefined {
  if (request.dialogKind !== "select" || request.multiple === true) return undefined;
  let recommended: string | undefined;
  const options: string[] = [];
  for (const row of request.options) {
    if (looksLikeDeclineRow(row)) continue;
    let text = row.replace(ROW_LETTER, "");
    if (text.endsWith(RECOMMEND_MARKER)) {
      text = text.slice(0, -RECOMMEND_MARKER.length);
      recommended ??= text;
    }
    options.push(text);
  }
  if (options.length < 2) return undefined;
  return {
    title: `审计者在问（门禁在等它交卷，替它把问题转给你）：\n${request.title}`,
    options,
    recommended: recommended ?? options[0]!,
  };
}

/** Records written at or after `sinceIso` — this round's, not an earlier one's. */
function recordsSince(records: readonly ChannelRecord[], sinceIso: string): ChannelRecord[] {
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) return [...records];
  return records.filter((r) => {
    const at = Date.parse(r.at);
    return !Number.isFinite(at) || at >= since;
  });
}

export type AuditWaitFailureKind = "pane-dead" | "conclude-refused" | "question" | "no-report";

/**
 * WHY a round ended without a recorded verdict — read from the facts, never
 * guessed. Several can hold at once (the measured round had its conclusion
 * refused AND asked about it); all that hold are said, most basic first.
 */
export function classifyAuditWaitFailure(input: {
  paneAlive: boolean | undefined;
  records: readonly ChannelRecord[];
  /** When this round was dispatched (ISO). */
  since: string;
}): { kinds: AuditWaitFailureKind[]; text: string } {
  const mine = recordsSince(input.records, input.since);
  const kinds: AuditWaitFailureKind[] = [];
  const parts: string[] = [];
  if (input.paneAlive === false) {
    kinds.push("pane-dead");
    parts.push("审计者的进程已经不在了（pane 消失）");
  }
  const reported = mine.some((r) => r.kind === "report");
  const concluded = mine.some((r) => r.kind === "state" && /^judge_conclude\(/.test((r as { activity?: string }).activity ?? ""));
  if (concluded && !reported) {
    kinds.push("conclude-refused");
    parts.push("审计者调过 judge_conclude，但没有落下 report —— 交卷被门禁拒了");
  }
  const open = projectChannel(mine).openRequests;
  if (open.length > 0) {
    kinds.push("question");
    parts.push(`审计者在提问、没人作答：${open.map((r) => `「${r.title.split("\n").pop()}」`).join("；")}`);
  }
  if (kinds.length === 0) {
    kinds.push("no-report");
    const last = projectChannel(mine).lastState;
    parts.push(`审计者没有交卷${last ? `（最后状态：${last.state}，${last.at}）` : "（本轮没有任何状态记录）"}`);
  }
  return { kinds, text: parts.join("；") };
}

export interface WatchAuditDeps {
  /** The auditor's whole channel, read fresh. */
  readRecords(): ChannelRecord[];
  /** Put a question to the user; resolves undefined when dismissed or aborted. */
  ask(spec: ChoiceSpec, signal: AbortSignal): Promise<string | undefined>;
  /** Write the answer onto the auditor's channel. */
  writeAnswer(requestId: string, answer: string): void;
  /** Publish the progress line. */
  progress(line: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Run beside the wait until `stop` resolves: refresh the progress line every
 * tick, forward each new question once, and take a forwarded box down the
 * moment the question is settled on the channel by anybody else.
 */
export async function watchAuditRound(
  deps: WatchAuditDeps,
  opts: { where: AuditLocation; since: string; startedAtMs: number; stop: Promise<unknown>; tickMs?: number },
): Promise<void> {
  let stopped = false;
  void opts.stop.then(() => { stopped = true; }, () => { stopped = true; });
  const forwarded = new Map<string, AbortController>();
  const tickMs = opts.tickMs ?? 2_000;
  while (!stopped) {
    let records: ChannelRecord[] = [];
    try { records = recordsSince(deps.readRecords(), opts.since); } catch { /* unreadable ⇒ nothing new */ }
    const open = projectChannel(records).openRequests;
    const openIds = new Set(open.map((r) => r.requestId));
    for (const [id, ctl] of forwarded) if (!openIds.has(id)) ctl.abort();
    const unasked: string[] = [];
    for (const request of open) {
      if (forwarded.has(request.requestId)) continue;
      const spec = questionDialogSpec(request);
      if (!spec) { unasked.push(request.title.split("\n").pop() ?? request.title); continue; }
      const ctl = new AbortController();
      forwarded.set(request.requestId, ctl);
      void deps.ask(spec, ctl.signal).then((answer) => {
        if (answer === undefined || ctl.signal.aborted) return;
        const resolved = resolveAnswer(
          { childId: "", requestId: request.requestId, dialogKind: request.dialogKind, title: request.title, options: request.options, askedAt: request.at },
          answer,
        );
        try { deps.writeAnswer(request.requestId, resolved.ok ? resolved.answer : answer); } catch { /* the pane's own box is still up */ }
      }, () => { /* a failed dialog leaves the pane's own box up */ });
    }
    const asking = open.length === 0
      ? undefined
      : unasked.length > 0
        ? `审计者在问一个门禁转不了的问题，去它的窗口里答：${unasked.map((t) => `「${t}」`).join("；")}`
        : `审计者在提问 —— 已转到你的对话框（在它的窗口里答也行）`;
    deps.progress(auditWaitProgressLine(opts.where, deps.now() - opts.startedAtMs, asking));
    await Promise.race([deps.sleep(tickMs), opts.stop.catch(() => undefined)]);
  }
  for (const ctl of forwarded.values()) ctl.abort();
}
