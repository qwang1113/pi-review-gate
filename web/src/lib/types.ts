/**
 * THE CONTRACT, TYPED — one file mirroring `docs/daemon/api.md`.
 *
 * Nothing here is inferred from an implementation read: every field name and
 * every union comes from that document, which is the single authority. When
 * the daemon and this file disagree, the daemon has a bug (or this file does)
 * — the panel never "normalises" around a missing field on its own.
 */

export const SESSION_STATES = [
  "working",
  "waiting-input",
  "waiting-judge",
  "done",
  "idle",
  "mode-changed",
  "dead",
  "stalled",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export interface DaemonSession {
  sessionId: string;
  name: string | null;
  kind: string | null;
  repo: string;
  cwd: string;
  branch: string | null;
  mode: string;
  state: SessionState;
  stateAt: string | null;
  stateSource: "pane" | "registry" | "transcript";
  alive: boolean;
  tmux: { session: string; window: string; pane: string } | null;
  pid: number | null;
  transcript: string | null;
  lastActivityAt: string | null;
  rounds: { sent: number; recorded: number; lastVerdict: string | null };
  /** false ⇒ `rounds`/`unmet` are placeholders — render "未知", never "无未满足项". */
  gateStateFound: boolean;
  unmet: string[];
  registeredAt: string | null;
  heartbeatAt: string | null;
}

export interface SessionsResponse {
  schema: number;
  now: string;
  tmuxReadable: boolean;
  problems: string[];
  sessions: DaemonSession[];
}

export interface OutputEntry {
  at: string;
  role: "user" | "assistant" | "system" | "tool";
  kind: "text" | "thinking" | "tool" | "result";
  text: string;
}

export interface OutputResponse {
  sessionId: string;
  transcript: string | null;
  entries: OutputEntry[];
}

export interface DaemonQuestion {
  schema: number;
  requestId: string;
  sessionId: string;
  sessionName: string | null;
  topic: string;
  title: string;
  options: string[];
  multiple: boolean;
  recommended: string | null;
  defaultChecked: string[];
  payload: string | null;
  payloadRef: { path: string; chars: number } | null;
  batchId: string | null;
  batchIndex: number | null;
  batchTotal: number | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface QuestionsResponse {
  questions: DaemonQuestion[];
  problems: string[];
}

export interface RepoCandidate {
  path: string;
  name: string;
  source: "session" | "history" | "root";
  lastSeenAt: string;
}

export interface ReposResponse {
  repos: RepoCandidate[];
}

export interface ConfigField {
  path: string;
  kind: "string" | "boolean" | "number" | "string[]" | "json";
  sensitive: boolean;
  editable: boolean;
  current?: unknown;
  note?: string;
}

export interface ConfigView {
  target: ConfigTarget;
  path: string;
  exists: boolean;
  value: unknown;
  fields: ConfigField[];
  backups: string[];
  problems: string[];
}

export interface ConfigWriteResult {
  ok: boolean;
  path?: string;
  backup?: string;
  value?: unknown;
}
export type ConfigTarget = "settings" | "models" | "gate-global" | "gate-project";

/**
 * One row of `GET /api/notifications` (§8.3).
 *
 * NOTE: there is no `repo` here even though the SSE `notification` frame has
 * one (§8.2) — an entry built from the ledger alone crashed the history page
 * until `lib/format.ts` learned to render a missing path as「—」.
 */
export interface NotificationEntry {
  key: string;
  kind: "waiting-input" | "done" | "exited";
  sessionId: string;
  name: string | null;
  title: string;
  body: string;
  at: string;
  firstSeenAt: string;
  count: number;
}

export interface NotificationsResponse {
  schema: number;
  entries: NotificationEntry[];
}export interface TaskRequest {
  repo: string;
  task: string;
  mode?: "loop" | "explore" | "normal" | "orchestrator";
  station?: "precommit" | "commit" | "pr";
  name?: string;
}

export interface TaskResponse {
  ok: boolean;
  sessionId: string;
  scopeSession: string;
  windowId: string;
  paneId: string;
  windowName: string;
}

/** SSE frame payloads (`docs/daemon/api.md` §9). */
export type SessionEvent =
  | { kind: "added" | "updated"; session: DaemonSession }
  /** A session the daemon stopped seeing: the frame carries the id ALONE (§9). */
  | { kind: "removed"; sessionId: string };
export type OutputEvent = { sessionId: string; entries: OutputEntry[]; replay?: boolean };

/** Labels the panel renders for the daemon's vocabulary. Unknown words pass through. */
export const STATE_LABELS: Record<string, string> = {
  working: "工作中",
  "waiting-input": "等你回答",
  "waiting-judge": "等审查",
  done: "已完成",
  idle: "空闲",
  "mode-changed": "模式变化",
  dead: "已消失",
  stalled: "失联",
};

export const MODE_LABELS: Record<string, string> = {
  loop: "loop",
  orchestrator: "编排",
  explore: "探索",
  normal: "普通",
};

/**
 * 定时任务（`docs/daemon/api.md` §13）—— 与会话类型同一份契约来源。
 *
 * `ScheduledTask` 既有存储字段也有三个**派生**字段：daemon 在
 * `GET /api/schedules` 里把它们算好一起给（§13.1），所以面板不需要、也不应该
 * 自己解析 cron。
 */
export type DeliveryStation = "precommit" | "commit" | "pr";

/** 用户实际批准过的契约：两段文本各绑自己的 hash（§13.1）。 */
export interface ScheduleContract {
  restatement: { text: string; hash: string; station: DeliveryStation; at: string };
  goal: { text: string; hash: string; at: string };
  approvedAt: string;
}

/** 台账里的一条运行记录（§13.6）。`run-started` 不是「结果」，不在 `lastRuns` 里。 */
export type ScheduledTaskRun =
  | {
      kind: "run-started";
      runId: string;
      taskId: string;
      sessionId: string;
      at: string;
      /** 这次运行自己的隔离 checkout、它所在的分支，以及切出来的那个 commit（§13.6）。 */
      worktree?: string;
      branch?: string;
      base?: string;
    }
  | {
      kind: "run-settled";
      runId: string;
      taskId: string;
      at: string;
      outcome: "passed" | "blocked" | "failed" | "gone";
      verdict: string | null;
      unmet: string[];
      /** 产出留在哪个分支上（没产出 / 已合并回收时没有）。 */
      branch?: string;
      /** 结算把产出怎么处理了，一行话。 */
      landing?: string;
    }
  | { kind: "run-skipped"; taskId: string; at: string; reason: string }
  /** 这次运行已登记（契约继承的凭证，§13.6）—— 是补充信息，不是一次运行。 */
  | { kind: "run-armed"; runId: string; taskId: string; sessionId: string; at: string }
  /** 这次运行的 tmux 窗口坐标（§13.6）—— 是补充信息，不是一次运行。 */
  | {
      kind: "run-window";
      runId: string;
      taskId: string;
      sessionId: string;
      at: string;
      scopeSession: string;
      windowId: string;
    };

/** `GET /api/schedules/:id/runs` 的一页（§13.6）。 */
export interface ScheduleRunsResponse {
  schema: number;
  taskId: string;
  /** 这个任务的台账总条数。 */
  total: number;
  /**
   * 下一页要带的 `offset`（游标），**0 表示已经到最早一条**。它是对追加稳定的
   * 索引（从最早一条数），所以翻页期间台账新增记录不会让遍历重复或漏掉。
   */
  nextOffset: number;
  runs: ScheduledTaskRun[];
}

/** 一行定时任务：存储字段 + §13.1 的三个派生字段。 */
export interface ScheduledTask {
  id: string;
  name: string;
  repo: string;
  cron: string;
  requirement: string;
  contract: ScheduleContract;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** 调度器上一次**处理**这个任务的时间（跑了、跳过、起不来都算）。 */
  lastFiredAt: string | null;
  /**
   * 派生：这个任务下一个要处理的 cron 时刻 —— 到点时没跑成的槽会**留着**
   * （不丢弃），所以它可能落在刚过去的一段时间里（面板会把那种情况标成「已到点
   * 还没跑」）；`enabled:false` 或 cron 非法时是 `null`。
   */
  nextRunAt: string | null;
  /** 派生：`describeCron` 的一行人话，如「每天 09:00」。 */
  describe: string;
  /** 派生：最近 5 条**结果**（`run-settled` / `run-skipped`，旧→新）。 */
  lastRuns: ScheduledTaskRun[];
}

export interface SchedulesResponse {
  schema: number;
  now: string;
  tasks: ScheduledTask[];
}

/** `POST /api/schedules/author` 的回执（§13.3）—— 与启动任务同形，指向 authoring 会话。 */
export interface ScheduleAuthorResponse {
  ok: boolean;
  sessionId: string;
  scopeSession: string;
  windowId: string;
  paneId: string;
}

/**
 * `PUT /api/schedules/:id` 与 `DELETE /api/schedules/:id` 的回执（§13.4 / §13.5 —— 两者同形）。
 */
export interface ScheduleTaskWriteResponse {
  ok: boolean;
  task: ScheduledTask;
  version: number;
}
