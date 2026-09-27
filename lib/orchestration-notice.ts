/**
 * THE ORCHESTRATION NOTICE — what the background supervisor injects into the
 * project manager (「[ORCHESTRATION] 子会话需要你」), and how every surface
 * names a child and a question. Pure: no clock, no channel, no host.
 *
 * ── WHY A NOTICE IS RE-CHECKED ON DELIVERY (2026-09-27, measured) ──
 *
 * The notice travels as a pi `steer`. Pi drains steers only after the tool
 * batch in flight finishes, and — `steeringMode` defaults to one-at-a-time —
 * ONE per model call. The supervisor used to enqueue a fresh notice on every
 * tick that had news, so a manager blocked in a long tool came back to a
 * backlog that then leaked out one stale line per turn: a tmux request
 * answered and settled at 14:41, from a pane already closed, was injected a
 * dozen more times. So the host keeps at most one notice in flight, carries
 * the events it announced in the message's `details`, and at `message_end` —
 * the moment the notice actually enters the context — {@link freshNoticeEvents}
 * drops whatever stopped being true while it waited.
 *
 * ── WHY NAMES ARE WRITTEN HERE ──
 *
 * `h1-muih4hsa` and `req-muih4hsa-h8kctz` are handles, not names. The task id
 * and the kind of dialog are what a manager recognises, so every line leads
 * with those and keeps the handles after them for the tool calls.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ChannelRequestRecord } from "./channel-records.ts";
import type { ChildState } from "./orchestrator-child-state.ts";
import type { SupervisionSnapshot } from "./orchestrator-supervisor.ts";
import { displayWidth } from "./tmux-sidebar-render.ts";

/** `details.kind` of an injected notice — how `message_end` recognises one. */
export const NOTICE_KIND = "orchestration-notice";

/** One announced event, as carried in the notice's `details`. */
export interface NoticeEvent {
  childId: string;
  state: ChildState;
  requestId?: string;
  /** The line printed for it. */
  summary: string;
}

/** What the delivery check reads: the children still open, right now. */
export interface NoticeFacts {
  children: ReadonlyArray<{ childId: string; taskId: string; state: ChildState }>;
  openRequestIds: ReadonlySet<string>;
  doneTaskIds: ReadonlySet<string>;
}

const TOPIC_LABELS: Record<NonNullable<ChannelRequestRecord["topic"]>, string> = {
  "goal-approval": "goal 确认",
  "goal-reason": "goal 否决理由",
  restatement: "需求反述确认",
  workspace: "工作区确认",
  "ask-user": "提问",
  "plan-approval": "plan 批准",
  "scope-limit": "审查范围收窄请求",
  "sensitive-edit": "敏感文件编辑授权请求",
  "tmux-access": "tmux 授权请求",
  other: "提问",
};

/** 「h1（childId=h1-muih4hsa）」 — a child by its task, the handle kept for tool calls. */
export function childLabel(taskId: string, childId: string): string {
  return taskId === childId ? childId : `${taskId}（childId=${childId}）`;
}

/** 「h1 的 tmux 授权请求」 */
export function requestLabel(taskId: string, topic: ChannelRequestRecord["topic"]): string {
  return `${taskId} 的 ${TOPIC_LABELS[topic ?? "other"] ?? "提问"}`;
}

/** THE one line a waiting question prints, in the notice and in the wait receipt. */
export function describePendingRequest(request: {
  taskId: string;
  childId: string;
  requestId: string;
  topic?: ChannelRequestRecord["topic"];
  title: string;
  options: readonly string[];
}): string {
  return (
    `${requestLabel(request.taskId, request.topic)}在等回答：「${request.title}」` +
    `（${request.options.length} 个选项；childId=${request.childId}，requestId=${request.requestId}）`
  );
}

/**
 * The events still worth delivering. An event is dropped when its child is no
 * longer open (closed ⇒ not supervised ⇒ absent from `facts.children`), its
 * plan task is done, its state moved on (the new state is its own news), or —
 * for a question — the request was settled.
 */
export function freshNoticeEvents(events: readonly NoticeEvent[], facts: NoticeFacts): NoticeEvent[] {
  return events.filter((event) => {
    const child = facts.children.find((c) => c.childId === event.childId);
    if (!child || facts.doneTaskIds.has(child.taskId) || child.state !== event.state) return false;
    return event.requestId === undefined || facts.openRequestIds.has(event.requestId);
  });
}

/** What a notice is checked against: the open children, their questions, the done tasks. */
export function noticeFactsFrom(
  snapshot: SupervisionSnapshot | undefined,
  tasks: ReadonlyArray<{ id: string; status: string }>,
): NoticeFacts {
  return {
    children: (snapshot?.children ?? []).map((c) => ({ childId: c.child.id, taskId: c.child.taskId, state: c.state })),
    openRequestIds: new Set((snapshot?.requests ?? []).map((r) => r.requestId)),
    doneTaskIds: new Set(tasks.filter((t) => t.status === "done").map((t) => t.id)),
  };
}

/**
 * THE SCREEN HALF OF THE DELIVERY CHECK (D43, 2026-09-27). pi draws a custom
 * message at `message_start`, from the text it was QUEUED with; the
 * `message_end` rewrite then replaces the message object in place, which fixes
 * the context but not the pixels — the manager's pane kept showing the stale
 * 「子会话需要你」. So the notice renders through this: every frame re-reads
 * the message's CURRENT content and rebuilds the inner view when it changed.
 */
export function liveNoticeComponent(
  message: { content: unknown },
  build: (text: string) => Component,
): Component {
  let shown: string | undefined;
  let inner: Component | undefined;
  const current = (): Component => {
    const text = messageText(message.content);
    if (inner === undefined || text !== shown) {
      shown = text;
      inner = build(text);
    }
    return inner;
  };
  return {
    render: (width) => current().render(width),
    invalidate: () => { inner = undefined; },
  };
}

/**
 * pi's default custom-message look (padded box, bold label, blank line, text)
 * drawn without pi-tui: a VALUE import of a pi package makes this module
 * unloadable where lib/ is installed without them (the install-copy tests).
 * Plain text, wrapped by display width — the notice carries no markdown.
 */
export function noticeBoxLines(
  text: string,
  width: number,
  paint: { bg(s: string): string; label(s: string): string; text(s: string): string },
): string[] {
  const inner = Math.max(1, width - 2);
  const row = (s: string, styled: string) => paint.bg(` ${styled}${" ".repeat(Math.max(0, inner - displayWidth(s)))} `);
  const wrapped: string[] = [];
  for (const line of text.split("\n")) {
    let cur = "";
    for (const ch of line) {
      if (displayWidth(cur + ch) > inner) { wrapped.push(cur); cur = ""; }
      cur += ch;
    }
    wrapped.push(cur);
  }
  const label = "[review-gate]";
  // No leading blank: pi's CustomMessageComponent adds that spacer itself.
  return [
    row("", ""),
    row(label, paint.label(label)),
    row("", ""),
    ...wrapped.map((l) => row(l, paint.text(l))),
    row("", ""),
  ];
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

/** The notice body. With nothing left it says so in one line instead. */
export function noticeText(events: readonly NoticeEvent[]): string {
  if (events.length === 0) {
    return "[ORCHESTRATION] 排队期间的子会话通知在送达前已全部过期（请求已答复 / 子会话已关闭 / 任务已完成），已丢弃，无需处理。";
  }
  return (
    "[ORCHESTRATION] 子会话需要你：\n" +
    events.map((e) => `- ${e.summary}`).join("\n") +
    "\n调 `orchestrator_wait({ timeoutMs: 0 })` 拿完整回执（问题正文与选项都在里面），" +
    "再用 `orchestrator_answer` 回；别让它就这么等着。" +
    "\n（这条会打断你手上的事：子会话在等回答，优先级高于你正在做的其他事。）"
  );
}
