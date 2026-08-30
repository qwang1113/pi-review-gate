/**
 * THE ORCHESTRATOR SIDE of supervision — read every channel, decide what is
 * news, and assemble the ONE receipt the project manager reads each round.
 *
 * ── WHAT THIS REPLACES ──
 *
 * `lib/orchestrator-probe.ts`, which polled `tmux capture-pane` for every
 * child, ran heuristics over the rendered text and manufactured events from
 * what it thought it saw. It is gone. Nothing here renders, parses or matches
 * a screen: a child's state comes from the records the child itself wrote
 * (lib/orchestrator-child-channel.ts), and the ONLY thing measured from
 * outside is whether its pane still exists.
 *
 * ── THE RECEIPT IS THE INTERFACE (task book §3.5) ──
 *
 * `orchestrator_wait` is the one call an orchestrator makes every round, so
 * everything it needs is PUSHED there rather than left for it to go and
 * fetch. {@link superviseChildren} produces all four blocks in one pass:
 *
 *   1. the health of every open child,
 *   2. the questions waiting for an answer, in full and structured,
 *   3. the children that died or went silent, with the assets that survived
 *      them and the action that recovers each one,
 *   4. (assembled by the caller, from lib/orchestrator-handoff-advice.ts) the
 *      orchestrator's own context budget and when to hand over.
 *
 * A supervisor that makes the manager ASK for block 3 is a supervisor that
 * will one day be asked too late — which is precisely the 725-second silence
 * that started this rewrite.
 *
 * ── WHY EVENTS STILL NEED A MEMORY ──
 *
 * A child that is waiting for an answer is waiting on every poll. Reporting
 * it every poll is noise; reporting it once and then never again is how a
 * request gets forgotten. So an unanswered thing rings on a backoff
 * (10s → 30s → 60s) and a completion rings at most twice — the rules live in
 * lib/orchestrator-child-state.ts, and the memory that applies them is
 * carried by the caller, never by a module-level variable.
 *
 * Pure module: channels are read through the injected {@link ChannelIO},
 * liveness is passed in as a set, and the clock is an argument.
 */

import {
  channelPathFor,
  projectChannel,
  readChannel,
  requestPayload,
  type ChannelIO,
  type ChannelProjection,
  type ChannelRequestRecord,
} from "./orchestrator-channel.ts";
import {
  childHealth,
  classifyChildState,
  describeChildState,
  describeChildStateDetailed,
  isNewsworthy,
  nextRewakeDelayMs,
  DONE_REPORT_LIMIT,
  DONE_REWAKE_MS,
  type ChildHealth,
  type ChildState,
} from "./orchestrator-child-state.ts";
import { paneColorFor } from "./orchestrator-pane-decor.ts";

import type { ChildSession } from "./orchestrator-registry.ts";

/** What survived a child that died — the reason a death is not a disaster. */
export interface ChildAssets {
  /** The work branch its commits are on, if it made one. */
  branch?: string;
  /** Its last checkpoint commit sha. */
  checkpoint?: string;
  /** Its last recorded review verdict. */
  reviewVerdict?: string;
  /** Whether its gate sidecar records a completed task. */
  completedAt?: string;
}

/** One question, exactly as the child asked it. No screen was involved. */
export interface PendingRequest {
  childId: string;
  requestId: string;
  dialogKind: ChannelRequestRecord["dialogKind"];
  /** Which gate dialog this is; `goal-approval` triggers constraint 8. */
  topic?: ChannelRequestRecord["topic"];
  title: string;
  options: string[];
  /** The full text behind the question, when the child attached one. */
  payload?: string;
  askedAt: string;
}

/** Everything known about one supervised child at one instant. */
export interface ChildSupervision {
  child: ChildSession;
  state: ChildState;
  health: ChildHealth;
  projection: ChannelProjection;
  assets?: ChildAssets;
}

/** The whole picture, in one object. */
export interface SupervisionSnapshot {
  children: ChildSupervision[];
  health: ChildHealth[];
  /** Every unanswered question across every child, oldest first. */
  requests: PendingRequest[];
  /** Children that are `dead` or `stalled`. */
  troubled: ChildSupervision[];
  /** Channel lines that could not be parsed — surfaced, never swallowed. */
  malformed: number;
}

/** What the supervisor needs from the outside world. */
export interface SupervisionInput {
  orchestrationId: string;
  /** Open children from the registry (closed ones are not supervised). */
  children: readonly ChildSession[];
  /**
   * Panes that exist right now, from `list-panes`. `undefined` means tmux
   * could not be read at all — which is missing information, never a death.
   */
  livePanes: ReadonlySet<string> | undefined;
  io: ChannelIO;
  home?: string;
  at: number;
  staleMs?: number;
  /** Read a child's surviving assets; only called for troubled children. */
  assetsFor?: (child: ChildSession) => ChildAssets | undefined;
}

/** Read every channel once and classify every child. */
export function superviseChildren(input: SupervisionInput): SupervisionSnapshot {
  const children: ChildSupervision[] = [];
  const requests: PendingRequest[] = [];
  let malformed = 0;

  for (const child of input.children) {
    const path = channelPathFor(input.orchestrationId, child.id, input.home);
    let projection: ChannelProjection;
    try {
      const read = readChannel(input.io, path);
      malformed += read.malformed;
      projection = projectChannel(read.records);
    } catch {
      projection = { openRequests: [], pendingAnswers: [], pendingInstructs: [] };
    }
    const paneAlive = input.livePanes === undefined ? undefined : input.livePanes.has(child.paneId);
    const observation = {
      childId: child.id,
      paneAlive,
      projection,
      ...(child.lastAssignedAt === undefined
        ? {}
        : { lastAssignedAt: Date.parse(child.lastAssignedAt) }),
      at: input.at,
      ...(input.staleMs === undefined ? {} : { staleMs: input.staleMs }),
    };
    const state = classifyChildState(observation);
    const supervision: ChildSupervision = {
      child,
      state,
      health: childHealth(observation),
      projection,
    };
    if (state === "dead" || state === "stalled") {
      const assets = input.assetsFor?.(child);
      if (assets) supervision.assets = assets;
    }
    children.push(supervision);

    for (const open of projection.openRequests) {
      const payload = safePayload(input.io, open);
      requests.push({
        childId: child.id,
        requestId: open.requestId,
        dialogKind: open.dialogKind,
        ...(open.topic === undefined ? {} : { topic: open.topic }),
        title: open.title,
        options: open.options,
        ...(payload === undefined ? {} : { payload }),
        askedAt: open.at,
      });
    }
  }

  requests.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
  return {
    children,
    health: children.map((c) => c.health),
    requests,
    troubled: children.filter((c) => c.state === "dead" || c.state === "stalled"),
    malformed,
  };
}

function safePayload(io: ChannelIO, record: ChannelRequestRecord): string | undefined {
  try {
    return requestPayload(io, record);
  } catch {
    return undefined;
  }
}

/** Per-child memory of what has already been reported. Owned by the caller. */
export interface SupervisionMemory {
  [childId: string]: {
    lastState?: ChildState;
    /** Epoch ms of the last time this state was reported. */
    reportedAt?: number;
    /** How many times the CURRENT state has been reported. */
    reports: number;
  };
}

/** One thing worth waking the orchestrator for. */
export interface SupervisionEvent {
  childId: string;
  state: ChildState;
  /** One line the receipt can print as-is. */
  summary: string;
  /** Present when the event is an unanswered question. */
  requestId?: string;
}

/** Events plus the memory to carry into the next poll. */
export interface SupervisionEventDecision {
  events: SupervisionEvent[];
  memory: SupervisionMemory;
}

/**
 * Decide what is NEWS in this snapshot.
 *
 * Three rules, in order:
 *
 *  1. a state that CHANGED is always news (that is the whole point of a
 *     supervisor — a transition nobody is told about is invisible);
 *  2. an unchanged newsworthy state re-rings on the backoff, so an unanswered
 *     question is not asked once and then forgotten;
 *  3. a completion rings at most {@link DONE_REPORT_LIMIT} times and then
 *     stays quiet — it is a terminal state, and repeating it forever would
 *     drown the states that still need action.
 */
export function decideSupervisionEvents(
  snapshot: SupervisionSnapshot,
  memory: SupervisionMemory,
  at: number,
): SupervisionEventDecision {
  const next: SupervisionMemory = {};
  const events: SupervisionEvent[] = [];

  for (const supervision of snapshot.children) {
    const id = supervision.child.id;
    const previous = memory[id];
    const state = supervision.state;
    const changed = previous?.lastState !== state;
    const reports = changed ? 0 : previous?.reports ?? 0;

    if (!isNewsworthy(state)) {
      next[id] = { lastState: state, reports: 0 };
      continue;
    }

    // `reports` counts what has ALREADY gone out, so the delay before the
    // next one is indexed from `reports - 1`: after the first report the wait
    // is the FIRST backoff step (10s), not the second. Indexing from
    // `reports` skipped a step and made the documented 10s→30s→60s actually
    // behave as 30s→60s→60s.
    const dueAt = changed
      ? at
      : (previous?.reportedAt ?? 0) +
        (state === "done" ? DONE_REWAKE_MS : nextRewakeDelayMs(reports - 1));

    const capped = state === "done" && reports >= DONE_REPORT_LIMIT;

    if (!capped && at >= dueAt) {
      const request = snapshot.requests.find((r) => r.childId === id);
      events.push({
        childId: id,
        state,
        summary: describeEvent(id, state, request),
        ...(request === undefined ? {} : { requestId: request.requestId }),
      });
      next[id] = { lastState: state, reportedAt: at, reports: reports + 1 };
      continue;
    }
    next[id] = {
      lastState: state,
      reports,
      ...(previous?.reportedAt === undefined ? {} : { reportedAt: previous.reportedAt }),
    };
  }

  return { events, memory: next };
}

/** The one line an event prints. */
function describeEvent(childId: string, state: ChildState, request?: PendingRequest): string {
  if (state === "waiting-input" && request) {
    return `${childId} 在等回答：「${request.title}」（${request.options.length} 个选项，requestId=${request.requestId}）`;
  }
  return `${childId}：${describeChildState(state)}`;
}

/** Render blocks 1–3 of the receipt. Block 4 is the handoff advice. */
export function formatSupervisionReceipt(snapshot: SupervisionSnapshot): string {
  const sections: string[] = [];

  sections.push("### 1. 子会话健康快照");
  sections.push(formatHealthLines(snapshot.health));

  sections.push("", "### 2. 待答请求");
  if (snapshot.requests.length === 0) {
    sections.push("（没有任何子会话在等回答）");
  } else {
    for (const request of snapshot.requests) {
      sections.push(
        `- **${request.childId}** · requestId=\`${request.requestId}\` · ${request.dialogKind} · ${request.askedAt}`,
        `  问题：${request.title}`,
        ...(request.options.length > 0
          ? request.options.map((option, index) => `    ${index + 1}. ${option}`)
          : ["    （自由文本，没有选项）"]),
        ...(request.payload ? [`  正文（${request.payload.length} 字）：`, indent(request.payload)] : []),
      );
    }
    sections.push(
      "",
      "回答用 `orchestrator_answer({childId, requestId, answer})` —— answer 传选项原文或序号；" +
      "它写进通道后子会话那边的框会自动撤下。",
    );
  }

  sections.push("", "### 3. 死亡与恢复");
  if (snapshot.troubled.length === 0) {
    sections.push("（没有 dead / stalled 的子会话）");
  } else {
    for (const troubled of snapshot.troubled) {
      sections.push(`- **${troubled.child.id}**（任务 ${troubled.child.taskId}）：${describeChildState(troubled.state)}`);
      sections.push(`  未丢失的资产：${formatAssets(troubled.assets)}`);
      sections.push(`  可执行动作：${recoveryAdvice(troubled)}`);
    }
  }

  if (snapshot.malformed > 0) {
    sections.push("", `> 通道里有 ${snapshot.malformed} 行无法解析（已跳过，不影响上面的判定）。`);
  }
  return sections.join("\n");
}

/**
 * What to actually DO about a troubled child.
 *
 * ── WHY THIS IS NOT ONE SENTENCE ANY MORE (round-4 P0) ──
 *
 * It used to offer `recover` or `close` for both states, and `recover`'s own
 * refusal then suggested `orchestrator_instruct({mode:"interrupt"})` when the
 * pane turned out to be alive. That was the single worst line the gate has
 * ever printed: the two children it was printed about were `waiting-judge` in
 * everything but name — quietly waiting for their own reviewers — and an
 * orchestrator that followed the advice would have aborted a running review
 * round. It was the one measured case of "doing what the gate said makes
 * things worse", and a human had to intervene to prevent it.
 *
 * The heartbeat fix removes the false positives at the source, so `stalled`
 * now means the extension really is gone. This wording exists for the
 * remainder: a `stalled` child is still NOT interrupted, because interrupting
 * a process whose gate is not answering does nothing except destroy whatever
 * it was in the middle of. Recover it (the transcript survives) or close it
 * (the branch survives). Those are the only two moves.
 */
function recoveryAdvice(troubled: ChildSupervision): string {
  const id = troubled.child.id;
  if (troubled.state === "dead") {
    return (
      `\`orchestrator_recover({childId:"${id}"})\` 续开同一会话（transcript 接着上次），` +
      `或 \`orchestrator_close({childId:"${id}"})\` 放弃（任务回 pending，分支保留）。`
    );
  }
  return (
    `先确认它是不是真的没人了：心跳由子会话侧的独立定时器发，与 agent 忙不忙无关，` +
    `所以「在等 reviewer」现在会显示成 \`waiting-judge\` 而不是 stalled —— 走到这里说明心跳确实停了。\n` +
    `    \`orchestrator_recover({childId:"${id}"})\` 用同一 session id 重开（它拒绝重开活着的 pane），` +
    `或 \`orchestrator_close({childId:"${id}"})\` 放弃。\n` +
    `    **不要** \`orchestrator_instruct({mode:"interrupt"})\`：门禁不应答的进程不会因为被打断而恢复，` +
    `而它万一还在跑自己的 reviewer，打断就等于把那一轮审查腰斩。`
  );
}

function formatHealthLines(health: readonly ChildHealth[]): string {
  if (health.length === 0) return "（本编排目前没有存活的子会话）";
  return health
    .map((h) => {
      const quiet = h.quietForSeconds === undefined ? "未上报过" : `${h.quietForSeconds}s 前`;
      const dialog = h.dialogTitle ? `，框：${h.dialogTitle}` : "";
      const ctx = h.contextPercent === undefined ? "" : `，上下文 ${h.contextPercent}%`;
      // The colour is the same pure function the pane border uses, so the row
      // a supervisor reads and the rectangle a human sees are the same child.
      const color = paneColorFor(h.childId).name;
      return `- [${color}] ${h.childId}：${describeChildStateDetailed(h)}，最后活动 ${quiet}${dialog}${ctx}`;
    })
    .join("\n");
}

function formatAssets(assets: ChildAssets | undefined): string {
  if (!assets) return "未能读取（子会话的 sidecar 不可读）";
  const parts: string[] = [];
  if (assets.branch) parts.push(`分支 \`${assets.branch}\``);
  if (assets.checkpoint) parts.push(`checkpoint \`${assets.checkpoint.slice(0, 12)}\``);
  if (assets.reviewVerdict) parts.push(`review 裁决 ${assets.reviewVerdict}`);
  if (assets.completedAt) parts.push(`已 declare_done（${assets.completedAt}）`);
  return parts.length > 0 ? parts.join("、") : "没有提交过任何东西（分支上没有内容）";
}


function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
