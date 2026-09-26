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

import type { ChannelRequestRecord } from "./channel-records.ts";
import type { ChildState } from "./orchestrator-child-state.ts";

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
