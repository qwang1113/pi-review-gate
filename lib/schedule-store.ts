/**
 * THE SCHEDULED-TASK TABLE AND ITS RUN LEDGER — the machine-level half of the
 * scheduler kernel (`lib/cron-schedule.ts` is the pure half).
 *
 * ── TWO FILES, TWO KINDS OF TRUTH ──
 *   ~/.pi/agent/rg-daemon/schedules.json      0600  WHAT should run
 *   ~/.pi/agent/rg-daemon/schedule-runs.jsonl 0600  WHAT DID run (append-only)
 *
 * The table is one JSON document with a `version` that increments on every
 * write, and `update` / `remove` refuse an `expectedVersion` that does not
 * match what is on disk; a missing file is an empty table, an unreadable one is
 * a refusal. The ledger is append-only: the daemon's tick is its only writer,
 * and it never rewrites the file — so a gate session or the panel can read a
 * line while the next one is being appended, and a torn final line is skipped
 * rather than fatal. Every path comes from an
 * explicit `home` (the convention `lib/daemon/paths.ts` uses), so a test points
 * the whole store at a scratch directory.
 *
 * ── THE AUTHORING RULE ──
 *
 * A scheduled task carries a NEGOTIATED contract: a confirmed requirement
 * restatement and an approved loop goal, each bound to a hash. A panel text
 * field must not rewrite either — that is how a scheduled task would silently
 * become a different task than the one the user agreed to. `applyScheduleEdit`
 * is the ONE implementation of that rule: `from: "panel"` may touch `name` /
 * `cron` / `enabled`, and any patch touching `requirement` / `repo` / `contract`
 * is refused whole (the authoring path is named in the copy); `from: "gate"`
 * may carry the contract. `updateScheduledTask` routes through it too, so the
 * store's write path cannot be used to skip the rule.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import { parseCron } from "./cron-schedule.ts";
import { scheduleRunsPath, schedulesPath } from "./daemon/paths.ts";
import { isDeliveryStation, type DeliveryStation } from "./delivery-station.ts";
import { goalTextHash, normalizeGoalText } from "./loop-goal.ts";
import { buildRejection } from "./rejection-copy.ts";
import { restatementHash } from "./restatement.ts";

/** Shape version of `schedules.json`. */
export const SCHEDULES_SCHEMA = 1;

/**
 * Environment variables the two sides of a scheduled run share. They are
 * constants here, not string literals at each call site: the dispatcher (the
 * daemon) and the readers (the gate's own session-start / declare_done paths)
 * must agree on the exact names, and they are also listed in
 * `GATE_ENV_NAMES` (lib/orchestrator-tmux.ts) so a child session never
 * inherits them from its parent.
 */
export const SCHEDULE_ID_ENV = "RG_SCHEDULE_ID";
export const SCHEDULE_RUN_ENV = "RG_SCHEDULE_RUN";

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

/** The negotiated half of a task: what the user agreed to, bound to its hashes. */
export interface ScheduleContract {
  restatement: { text: string; hash: string; station: DeliveryStation; at: string };
  goal: { text: string; hash: string; at: string };
  approvedAt: string;
}

/** One scheduled task, as it sits in `schedules.json`. */
export interface ScheduledTask {
  /** `sch-<8 位 hex>`，由 store 生成。 */
  id: string;
  /** kebab-case 2–32，在本文件里唯一。 */
  name: string;
  /** 绝对路径，写入时必须是存在且是目录。 */
  repo: string;
  /** 5 段 cron；写入时必须过 `parseCron`。 */
  cron: string;
  /** 用户/面板写的那句需求（原始描述）。 */
  requirement: string;
  contract: ScheduleContract;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** The last slot the daemon dealt with (started, skipped, failed to start) — lib/daemon/scheduler.ts. */
  lastFiredAt: string | null;
}

/** The whole document. */
export interface SchedulesFile {
  schema: typeof SCHEDULES_SCHEMA;
  version: number;
  tasks: ScheduledTask[];
}

/** `readSchedules`'s two outcomes — a corrupt file is a refusal, never "no tasks". */
export type SchedulesRead = { ok: true; file: SchedulesFile } | { ok: false; problem: string };

/** What the write functions answer. */
export type ScheduleStoreResult<T> =
  | { ok: true; value: T; version: number }
  | { ok: false; problem: string };

/** Which side is editing — the authoring rule's only input. */
export type ScheduleEditOrigin = "panel" | "gate";

/** The fields an edit may carry. `id` / `createdAt` are store-managed. */
export interface ScheduleEditPatch {
  name?: string;
  cron?: string;
  enabled?: boolean;
  /**
   * Runtime bookkeeping, never authoring: the daemon stamps it every time it
   * DEALS with a slot — a run started, a skip recorded, a launch that failed.
   * The rule that reads it (what is due next) is lib/daemon/scheduler.ts.
   */
  lastFiredAt?: string | null;
  requirement?: string;
  repo?: string;
  contract?: ScheduleContract;
}

/** `applyScheduleEdit`'s two outcomes. */
export type ScheduleEdit = { ok: true; patch: ScheduleEditPatch } | { ok: false; problem: string };

/** What `addScheduledTask` takes. `contract` is required: creation is authoring. */
export interface NewScheduledTask extends ScheduleEditPatch {
  name: string;
  repo: string;
  cron: string;
  requirement: string;
  contract: ScheduleContract;
  enabled?: boolean;
  /** Defaults to `"panel"` when absent, so a caller that forgets is refused. */
  from?: ScheduleEditOrigin;
  /** Optional optimistic check against the version the caller read. */
  expectedVersion?: number;
}

// ---------------------------------------------------------------------------
// the run ledger's records
// ---------------------------------------------------------------------------

export type ScheduleRunOutcome = "passed" | "blocked" | "failed" | "gone";

/**
 * ONE RUN STARTED — and, when the launch returned them, THE COORDINATES OF THE
 * WINDOW IT RUNS IN.
 *
 * The coordinates are the LAUNCH RECEIPT (`lib/daemon/control.ts`
 * `LaunchTaskOutcome`), kept here because they cannot be recovered later: the
 * observer reads a run's window off its PANE, and a session whose pane lost
 * `@rg_sid` has none — so a settlement could not close that window, and the
 * live process kept the checkout "occupied" for as long as the user left it
 * open. Both optional: an older record (or a launch that reported neither) has
 * them missing, and a settlement with no window to name simply has nothing to
 * close.
 */
export interface ScheduleRunStarted {
  kind: "run-started";
  runId: string;
  taskId: string;
  sessionId: string;
  at: string;
  /**
   * THE RUN'S OWN CHECKOUT (2026-10-03, lib/schedule-worktree.ts): where it
   * worked, the branch its output lives on, and the commit that branch was cut
   * from. All three optional — a record written before isolated checkouts has
   * none, and such a run's output is settled by nothing.
   */
  worktree?: string;
  branch?: string;
  base?: string;
  /**
   * The task's repository — the anchor its settlement needs, kept HERE because
   * the table may no longer have the task (deleted while the run was in flight)
   * and the observer may not have the session (reviewer P1, 2026-10-03).
   */
  repo?: string;
  /**
   * The daemon's own tmux session the window was opened in.
   *
   * SUPERSEDED BY {@link ScheduleRunWindow} (2026-10-03), and kept because
   * records that already carry them are still out there: since the `run-started`
   * line must exist BEFORE the session starts (contract adoption reads it), the
   * coordinates — which only exist once the launch has returned — no longer fit
   * in the same line. New runs write a `run-window` record instead.
   */
  scopeSession?: string;
  /** The tmux window id (`@N`) `launchTask` created for this run. */
  windowId?: string;
}

/**
 * WHERE THE RUN'S WINDOW IS — the line that cannot be written until a moment
 * AFTER `run-started` (2026-10-03).
 *
 * The daemon starts these sessions, so the daemon is what must close their
 * windows: an ordinary session holds its checkout until its PROCESS exits, and
 * a settled run whose window stays open keeps a live process in that checkout
 * (`lib/daemon/control.ts` `closeRunWindowAt`). The pane usually answers where
 * the window is — but a session whose pane lost `@rg_sid` has no coordinates to
 * read anywhere else, which is why they are recorded at all (t7, 2026-10-02).
 *
 * ONE LINE PER RUN, written best-effort: a launch that reported no coordinates
 * writes none, and a run with neither this record nor a pane is closed the only
 * remaining way — tmux reclaims the window when its process exits.
 */
export interface ScheduleRunWindow {
  kind: "run-window";
  runId: string;
  taskId: string;
  sessionId: string;
  at: string;
  /** The daemon's own tmux session the window was opened in. */
  scopeSession: string;
  /** The tmux window id (`@N`) `launchTask` created for this run. */
  windowId: string;
  /**
   * WHICH SERVER MINTED THAT ID (`<socket>,<pid>`, the registry's own spelling).
   * A window id means something only on the server that handed it out, and after
   * a `kill-server` or a reboot the next server reuses the same small numbers —
   * so a close aimed by a stale id could take a stranger's window with it
   * (reviewer P1, 2026-10-03). Undefined for records written before this field
   * existed: those are simply not retried.
   */
  server?: string;
}
export interface ScheduleRunSettled {
  kind: "run-settled"; runId: string; taskId: string; at: string;
  outcome: ScheduleRunOutcome; verdict: string | null; unmet: string[];
  /**
   * WHERE THE RUN'S OUTPUT WENT, when it produced any: the branch that holds it
   * and one line naming what happened to it (merged staged into the repo, kept
   * for a human, shipped as a PR). Written by the settlement — the panel and
   * `schedule_task({action:"list"})` render both, so "the run did something and
   * you cannot see where it went" does not happen.
   */
  branch?: string;
  landing?: string;
}
/**
 * THE RUN IS ARMED — the line that lets a session inherit its contract, written
 * BEFORE anything is launched (2026-10-03, reviewer P1).
 *
 * WHY IT IS NOT A `run-started`: a launch that fails must leave NO trace of a
 * run behind — the slot stays owed and the ledger stays honest — while the
 * contract adoption needs a durable line to read, because it runs inside the
 * session and can only see files (lib/schedule-run-contract.ts). Arming is
 * exactly that line: it says "a run of this task, with this session id, was
 * authorised to start here", and everything that counts RUNS ignores it —
 * `openRuns`, the panel's history, the task list, `lastRuns`.
 *
 * A run that really starts writes its `run-started` a moment later, in
 * addition; an arming whose launch never happened is inert forever, and costs
 * nothing but a line.
 */
export interface ScheduleRunArmed {
  kind: "run-armed";
  runId: string;
  taskId: string;
  sessionId: string;
  at: string;
  /**
   * THE RUN'S OWN CHECKOUT, here as well as on `run-started` (2026-10-03,
   * quality round P2): a daemon that dies between the launch and the
   * `run-started` write leaves ONLY this line, and a real session that holds a
   * real checkout must still be settlable. `lib/daemon/scheduler.ts` is what
   * turns such an orphaned arming back into a run.
   */
  worktree?: string;
  branch?: string;
  base?: string;
  /**
   * The task's repository — the anchor a settlement needs. Without it a task
   * deleted while its run was in flight would leave the checkout stranded, since
   * the table (the other source of that fact) no longer has the task at all
   * (reviewer P1, 2026-10-03).
   */
  repo?: string;
  /**
   * WHICH SLOT THIS ARMING CONSUMED, and the stamp it replaced: a daemon killed
   * after the stamp but before the launch leaves a consumed slot with no run at
   * all, and the cleanup pass puts that stamp back from these two fields
   * (reviewer P1, 2026-10-03).
   */
  slot?: string;
  previousFiredAt?: string | null;
}

export interface ScheduleRunSkipped { kind: "run-skipped"; taskId: string; at: string; reason: string }

export type ScheduleRunRecord =
  | ScheduleRunStarted
  | ScheduleRunArmed
  | ScheduleRunSettled
  | ScheduleRunSkipped
  | ScheduleRunWindow;

const RUN_KINDS: readonly string[] = Object.freeze([
  "run-started",
  "run-armed",
  "run-settled",
  "run-skipped",
  "run-window",
]);

// ---------------------------------------------------------------------------
// reading and writing the table
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * A timestamp `new Date(...)` can read. The gate ACTS on `lastFiredAt` (the
 * slot the scheduler counts from, lib/daemon/scheduler.ts's `dueDecision`)
 * and on `approvedAt` (what makes a re-negotiation one), so both are validated
 * on BOTH sides: the write side refuses them, the read side refuses to hand
 * them on.
 */
const isTimestamp = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value));

/**
 * Enough of a shape check that a hand-edited entry cannot reach a caller as
 * `undefined` or as a value the gate reads but cannot act on: the fields a RULE
 * consumes (`cron` / `enabled` / `lastFiredAt` / `approvedAt`) get their
 * write-side validation run here too. The display-only `at` fields are only
 * required to be non-empty — nothing acts on them.
 */
function isStoredTask(value: unknown): value is ScheduledTask {
  if (!isRecord(value)) return false;
  const contract = value.contract;
  if (!isRecord(contract) || !isRecord(contract.restatement) || !isRecord(contract.goal)) return false;
  const { restatement, goal } = contract;
  return (
    isText(value.id) && isText(value.name) && isText(value.repo) && isText(value.cron) &&
    parseCron(value.cron).ok &&
    isText(value.requirement) && typeof value.enabled === "boolean" &&
    isText(value.createdAt) && isText(value.updatedAt) &&
    (value.lastFiredAt === null || isTimestamp(value.lastFiredAt)) &&
    isText(restatement.text) && isText(restatement.hash) && isText(restatement.at) &&
    isDeliveryStation(restatement.station) &&
    isText(goal.text) && isText(goal.hash) && isText(goal.at) && isTimestamp(contract.approvedAt)
  );
}

/**
 * Read `schedules.json`. A MISSING file is an empty table (version 0); an
 * unreadable, malformed or wrong-shaped one is `{ ok: false }` — NOT an empty
 * table, which the next write would happily overwrite.
 */
export function readSchedules(home: string): SchedulesRead {
  const path = schedulesPath(home);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, file: { schema: SCHEDULES_SCHEMA, version: 0, tasks: [] } };
    }
    return { ok: false, problem: `读不到 ${path}：${(error as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, problem: `${path} 不是合法 JSON —— 拒绝当成「没有任务」（否则下一次写入会覆盖掉它），请先人工修复` };
  }
  if (!isRecord(parsed) || parsed.schema !== SCHEDULES_SCHEMA || !Number.isInteger(parsed.version) ||
    (parsed.version as number) < 0 || !Array.isArray(parsed.tasks) || !parsed.tasks.every(isStoredTask)) {
    return { ok: false, problem: `${path} 的形状不是 {schema:1, version, tasks[]}（或某个任务缺字段）—— 同上，不覆盖它` };
  }
  const tasks = parsed.tasks as ScheduledTask[];
  // CHECK BOTH KEYS BEFORE ADDING EITHER — the order carries the meaning. A
  // task may legitimately carry its own id as its name (that is a legal
  // `updateScheduledTask` rename and it reads back fine); moving the two
  // `taken.set` calls above the check would turn that state into a "duplicate"
  // and make the whole table unreadable (the round-8 P1 class).
  const taken = new Map<string, ScheduledTask>();
  for (const task of tasks) {
    const holder = taken.get(task.id) ?? taken.get(task.name);
    if (holder !== undefined) {
      return {
        ok: false,
        problem: `${path} 里有重复的 id / name：任务 ${task.id}（name ${task.name}）与任务 ${holder.id}（name ${holder.name}）` +
          " 共用了同一个键 —— id 与 name 共用一个命名空间（id 是 update / remove 的寻址键、name 是 findScheduledTask 的键），" +
          "重复会让两者都不确定。请人工修复这一行（读侧从不改写文件，不会替你猜哪一条是对的）",
      };
    }
    taken.set(task.id, task);
    taken.set(task.name, task);
  }
  return {
    ok: true,
    file: { schema: SCHEDULES_SCHEMA, version: parsed.version as number, tasks },
  };
}
/** Every task, or `[]` when the table cannot be read (a listing never throws). */
export function listScheduledTasks(home: string): ScheduledTask[] {
  const read = readSchedules(home);
  return read.ok ? read.file.tasks : [];
}

/** One task by id or by name, or `undefined`. */
export function findScheduledTask(home: string, idOrName: string): ScheduledTask | undefined {
  const wanted = String(idOrName ?? "");
  return listScheduledTasks(home).find((task) => task.id === wanted || task.name === wanted);
}

/**
 * THE TABLE'S WRITE LOCK — what makes read-check-write ATOMIC (2026-10-03,
 * reviewer P1).
 *
 * `updateScheduledTask` reads the table, compares `expectedVersion` and writes.
 * Two writers that read the SAME version both pass that comparison and both
 * `writeFileAtomic`, so the later one silently replaces the earlier one's edit —
 * the version check refuses a writer that reads AFTER somebody else wrote, but
 * it cannot make the window itself atomic. This lock is that missing half.
 *
 * It is a file created with `O_EXCL` beside the table: whoever creates it holds
 * it, everyone else waits — THERE IS NO "GIVE UP AND WRITE ANYWAY" EXIT, because
 * that exit is exactly what would make the lock decorative again (reviewer P1,
 * 2026-10-03). Waiting is safe here: the holder is a synchronous read-and-write
 * a few milliseconds long, and the only way it does not release the lock is a
 * CRASH — whose lock file stops being touched and can then be taken by whoever
 * notices, after {@link LOCK_STALE_MS}.
 */
const LOCK_STALE_MS = 10_000;

function withTableLock<T>(home: string, fn: () => T): T {
  const lock = `${schedulesPath(home)}.lock`;
  for (;;) {
    try {
      // THE TABLE'S HOME MAY NOT EXIST YET (a fresh daemon home): the lock is the
      // first thing to touch it, and `O_EXCL` on a missing directory is ENOENT,
      // not "somebody holds it".
      mkdirSync(dirname(lock), { recursive: true });
      const fd = openSync(lock, "wx");
      try {
        return fn();
      } finally {
        closeSync(fd);
        try { rmSync(lock, { force: true }); } catch { /* the stale sweep gets it */ }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { force: true });
          continue;
        }
      } catch { /* the holder just released it */ }
      sleepSync(20);
    }
  }
}

/** A synchronous sleep: every caller of this module is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeSchedules(home: string, file: SchedulesFile): void {
  // 0600 + atomic: the same private-file rule the daemon's own state and token
  // follow, and a reader never sees a half-written document.
  writeFileAtomic(schedulesPath(home), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

function versionProblem(expected: unknown, actual: number): string | undefined {
  if (expected === undefined) return undefined;
  if (expected !== actual) {
    return `version 不匹配：你读到的是 ${String(expected)}，文件里是 ${actual} —— 有人同时改过，请重读`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the authoring rule
// ---------------------------------------------------------------------------

/** Fields only the authoring flow may write. */
const AUTHORED_FIELDS: readonly string[] = Object.freeze(["requirement", "repo", "contract"]);
/**
 * What a PANEL edit may touch — the three fields a text form can change
 * without changing what the task IS.
 *
 * EXPORTED because it is a rule, not a copy: the daemon's `PUT` handler used to
 * carry its own second list (`PANEL_SCHEDULE_FIELDS`), and the two had already
 * drifted — the store accepted `lastFiredAt` (the scheduler's slot stamp, never
 * an authored field) while the endpoint refused it, so which fields a panel
 * could REALLY write depended on which door the call came through (quality
 * round P1, 2026-10-02). One list, asked by both sides.
 */
export const PANEL_EDITABLE_FIELDS: readonly string[] = Object.freeze(["name", "cron", "enabled"]);
/** Everything an edit may name at all (the gate keeps the union: it stamps `lastFiredAt`). */
const EDITABLE_FIELDS: readonly string[] = Object.freeze([...PANEL_EDITABLE_FIELDS, "lastFiredAt", ...AUTHORED_FIELDS]);

/** The refusal a panel edit gets when it reaches for an authored field. */
export function scheduleAuthoringRefusal(problem: string): string {
  return buildRejection({
    what: `调度任务的修改被拒：${problem}`,
    why: "需求/repo/契约的修改必须走 authoring 会话或 `schedule_task` 工具（需求反述 + goal 批准）—— " +
      "面板是一张文本表单，它改得动的那三个字段（name / cron / enabled）都不改变这份任务「是什么」。",
    by: "agent",
    next: "面板只改 name / cron / enabled；要改需求、repo 或契约的入口有两个，都走重新协商" +
      "（需求反述 → goal 批准 → 写入契约）：面板用 `POST /api/schedules/author`，会话用 `schedule_task` 工具。",
  });
}

/**
 * The write-qualification rule — ONE implementation, called by the tool side
 * (via `updateScheduledTask`) and the panel side alike. It judges the ORIGIN
 * and the FIELD NAMES only; value validation is the store's (`patchProblem`),
 * so exactly one place knows "a panel may not touch a contract".
 */
export function applyScheduleEdit(request: { from: ScheduleEditOrigin; patch: ScheduleEditPatch }): ScheduleEdit {
  const from = request?.from;
  const patch: ScheduleEditPatch = request?.patch ?? {};
  if (from !== "panel" && from !== "gate") {
    return { ok: false, problem: `未知的编辑来源 ${JSON.stringify(from)}：只接受 "panel" 或 "gate"` };
  }
  if (from === "panel") {
    const touched = AUTHORED_FIELDS.filter((field) => Object.hasOwn(patch, field));
    if (touched.length > 0) {
      return { ok: false, problem: scheduleAuthoringRefusal(`panel 来源的 patch 碰到了 ${touched.join("、")}`) };
    }
    // THE PANEL'S OWN LIST, before the union check below: a panel caller that
    // names `lastFiredAt` must be told which three fields it MAY write, not
    // shown the gate's wider vocabulary (that message is what let the two
    // lists drift apart in the first place).
    const notPanel = Object.keys(patch).filter((key) => !PANEL_EDITABLE_FIELDS.includes(key));
    if (notPanel.length > 0) {
      return {
        ok: false,
        problem: `面板只能改 ${PANEL_EDITABLE_FIELDS.join(" / ")}（收到 ${notPanel.join("、")}）——` +
          " 需求、repo 与契约请走 POST /api/schedules/author",
      };
    }
  }
  const unknown = Object.keys(patch).filter((key) => !EDITABLE_FIELDS.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      problem: `不认识的字段 ${unknown.join("、")} —— 能改的只有 ${EDITABLE_FIELDS.join(" / ")}`,
    };
  }
  return { ok: true, patch };
}

// ---------------------------------------------------------------------------
// value validation
// ---------------------------------------------------------------------------

/** A name a scheduled task can carry: kebab-case, 2–32, unique in the table. */
export function scheduleNameProblem(raw: unknown, taken: readonly string[] = []): string | undefined {
  const name = typeof raw === "string" ? raw : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return `name 必须是 kebab-case（小写字母、数字、单连字符，如 "daily-audit"）：${JSON.stringify(raw)}`;
  }
  if (name.length < 2 || name.length > 32) {
    return `name 长度必须在 2–32 之间（现在是 ${name.length}）：${name}`;
  }
  if (taken.includes(name)) return `name "${name}" 已经被另一个调度任务用了（全局唯一）`;
  return undefined;
}

/** `repo` must be an existing directory named by an absolute path. */
export function scheduleRepoProblem(raw: unknown): string | undefined {
  const repo = typeof raw === "string" ? raw : "";
  if (!isAbsolute(repo)) return `repo 必须是绝对路径：${JSON.stringify(raw)}`;
  try {
    if (!statSync(repo).isDirectory()) return `repo 不是目录：${repo}`;
  } catch {
    return `repo 不存在或读不到：${repo}`;
  }
  return undefined;
}

/** The contract's hashes must be the hashes of its own texts. */
export function scheduleContractProblem(contract: unknown): string | undefined {
  if (!isRecord(contract)) return "contract 必须是对象 {restatement, goal, approvedAt}";
  const restatement = contract.restatement;
  const goal = contract.goal;
  if (!isRecord(restatement) || !isText(restatement.text) || !isText(restatement.hash) || !isText(restatement.at)) {
    return "contract.restatement 必须是 {text, hash, station, at}";
  }
  if (!isRecord(goal) || !isText(goal.text) || !isText(goal.hash) || !isText(goal.at)) {
    return "contract.goal 必须是 {text, hash, at}";
  }
  if (!isTimestamp(contract.approvedAt)) {
    return `contract.approvedAt 必须是能被 Date 解析的时间字符串：${JSON.stringify(contract.approvedAt)}`;
  }
  if (!isDeliveryStation(restatement.station)) {
    return `contract.restatement.station 不是交付站点（precommit / commit / pr）：${JSON.stringify(restatement.station)}`;
  }
  // The two rules are REUSED, never re-implemented: a second copy of a hash
  // rule is a second answer to "is this the text the user agreed to".
  if (restatement.hash !== restatementHash(restatement.text)) {
    return "contract.restatement.hash 与 restatement.text 不符（应为 restatementHash(text)，见 lib/restatement.ts）";
  }
  if (goal.hash !== goalTextHash(normalizeGoalText(goal.text))) {
    return "contract.goal.hash 与 goal.text 不符（应为 goalTextHash(normalizeGoalText(text))，见 lib/loop-goal.ts）";
  }
  return undefined;
}

/** `Object.hasOwn`, named: a key present with an explicit `undefined` is still a key. */
const has = (patch: ScheduleEditPatch, key: keyof ScheduleEditPatch): boolean => Object.hasOwn(patch, key);

/**
 * The ADDRESSABLE namespace: every id and every name in the table, as one set.
 *
 * `findScheduledTask(idOrName)` answers to either, so a name colliding with
 * another task's id is exactly as ambiguous as a duplicated id — which is why
 * the write-side uniqueness check and the id generator must avoid the SAME set.
 * It is one function because the two copies it replaces drifted once already
 * (round-8 P1: the read side refused a table the write side had just written).
 * The read-side loop does NOT use it, on purpose: that one checks both keys
 * before recording either, which is what lets a task carry its own id as its
 * name.
 *
 * `exceptId` drops one task — the one being edited, which may legitimately
 * carry its own id as its name (the read side tolerates that too, see
 * `readSchedules`).
 */
function namespaceOf(tasks: readonly ScheduledTask[], exceptId?: string): Set<string> {
  const taken = new Set<string>();
  for (const task of tasks) {
    if (task.id === exceptId) continue;
    taken.add(task.id);
    taken.add(task.name);
  }
  return taken;
}

/**
 * Value-level validation of a patch, given the table it would land in.
 *
 * Asked by PRESENCE, not by `!== undefined`: `{ name: undefined }` is a patch
 * that means to write the name, and writing `undefined` into the table would
 * make the whole document unreadable on the next load.
 */
function patchProblem(file: SchedulesFile, patch: ScheduleEditPatch, current?: ScheduledTask): string | undefined {
  // id AND name, one namespace — see `namespaceOf` for why they share it.
  const taken = [...namespaceOf(file.tasks, current?.id)];
  if (has(patch, "name")) {
    const problem = scheduleNameProblem(patch.name, taken);
    if (problem) return problem;
  }
  if (has(patch, "repo")) {
    const problem = scheduleRepoProblem(patch.repo);
    if (problem) return problem;
  }
  if (has(patch, "cron")) {
    if (!isText(patch.cron)) return `cron 必须是 5 段表达式字符串：${JSON.stringify(patch.cron)}`;
    const parsed = parseCron(patch.cron);
    if (!parsed.ok) return `cron 不合法：${parsed.problem}`;
  }
  if (has(patch, "enabled") && typeof patch.enabled !== "boolean") {
    return `enabled 必须是布尔值：${JSON.stringify(patch.enabled)}`;
  }
  if (has(patch, "lastFiredAt") && patch.lastFiredAt !== null && !isTimestamp(patch.lastFiredAt)) {
    return `lastFiredAt 必须是可解析的 ISO 时间字符串或 null：${JSON.stringify(patch.lastFiredAt)}`;
  }
  if (has(patch, "requirement") && !isText(patch.requirement)) return "requirement 不能是空的";
  if (has(patch, "contract")) {
    const problem = scheduleContractProblem(patch.contract);
    if (problem) return problem;
  }
  // `repo` is authoring-only AND no hash binds it: moving a task to another
  // checkout would silently re-point a task the user agreed to in one
  // repository. So a move must carry a NEW contract in the same patch —
  // compared against the CURRENT repo (an unchanged resubmit is not a move)
  // and by hashes (re-sending the old contract is not a re-negotiation).
  if (has(patch, "repo") && patch.repo !== current?.repo) {
    if (!has(patch, "contract")) {
      return "改 repo 必须和一份新的 contract 一起提交（需求反述 + goal 批准）：契约的两个 hash 绑不住 repo";
    }
    // The identity of an approval is WHEN it was given, not what it says: an
    // honest re-negotiation of the same requirement produces the same text
    // (judging the text would refuse it while a one-word edit passed), and a
    // re-submitted old contract carries its old timestamp.
    if (current !== undefined) {
      const before = Date.parse(current.contract.approvedAt);
      const after = Date.parse(patch.contract?.approvedAt ?? "");
      if (!(Number.isFinite(before) && Number.isFinite(after) && after > before)) {
        return "换 repo 带回的 contract 的 approvedAt 不比现值新 —— 这不算重新协商：" +
          "换仓库要在新仓库上重新反述需求、重新批准 goal，并落一份新的批准时间";
      }
    }
  }
  return undefined;
}

function newScheduleId(taken: ReadonlySet<string>): string {
  let id = `sch-${randomBytes(4).toString("hex")}`;
  while (taken.has(id)) id = `sch-${randomBytes(4).toString("hex")}`;
  return id;
}

// ---------------------------------------------------------------------------
// the write API
// ---------------------------------------------------------------------------

/**
 * Create one scheduled task. The task is created WITH a contract, so this is
 * an authoring act: `from` defaults to `"panel"` and a panel call is refused
 * with the authoring path named.
 */
export function addScheduledTask(home: string, input: NewScheduledTask): ScheduleStoreResult<ScheduledTask> {
  return withTableLock(home, () => {
    const read = readSchedules(home);
    if (!read.ok) return read;
    const file = read.file;
    const conflict = versionProblem(input.expectedVersion, file.version);
    if (conflict) return { ok: false, problem: conflict };
    const patch: ScheduleEditPatch = {
      name: input.name,
      repo: input.repo,
      cron: input.cron,
      requirement: input.requirement,
      contract: input.contract,
      // `enabled` is in the patch EVEN when the caller left it out: value
      // validation only looks at keys that are present, and a non-boolean one
      // reaching the table is exactly what makes the whole file unreadable on
      // the next load (round-1 reviewer P2).
      enabled: input.enabled ?? true,
    };
    const qualification = applyScheduleEdit({ from: input.from ?? "panel", patch });
    if (!qualification.ok) return qualification;
    const problem = patchProblem(file, patch);
    if (problem) return { ok: false, problem: problem };
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      id: newScheduleId(namespaceOf(file.tasks)),
      name: input.name,
      repo: input.repo,
      cron: input.cron,
      requirement: input.requirement,
      contract: input.contract,
      enabled: patch.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      lastFiredAt: null,
    };
    const next: SchedulesFile = { schema: SCHEDULES_SCHEMA, version: file.version + 1, tasks: [...file.tasks, task] };
    writeSchedules(home, next);
    return { ok: true, value: task, version: next.version };
  });
}

/**
 * Patch one task in place. Both origins go through {@link applyScheduleEdit}
 * first — a store call without `from` is read as a PANEL call, so a caller that
 * forgets to say it is the gate cannot write a contract by accident.
 */
export function updateScheduledTask(
  home: string,
  id: string,
  patch: ScheduleEditPatch,
  options: { expectedVersion?: number; from?: ScheduleEditOrigin } = {},
): ScheduleStoreResult<ScheduledTask> {
  return withTableLock(home, () => {
    const read = readSchedules(home);
    if (!read.ok) return read;
    const file = read.file;
    const conflict = versionProblem(options.expectedVersion, file.version);
    if (conflict) return { ok: false, problem: conflict };
    const qualification = applyScheduleEdit({ from: options.from ?? "panel", patch });
    if (!qualification.ok) return qualification;
    const index = file.tasks.findIndex((task) => task.id === id);
    if (index < 0) return { ok: false, problem: `找不到调度任务 ${id}（id 不会被改写；按名字找请用 findScheduledTask）` };
    const current = file.tasks[index]!;
    const problem = patchProblem(file, patch, current);
    if (problem) return { ok: false, problem: problem };
    const updated: ScheduledTask = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
    const tasks = [...file.tasks];
    tasks[index] = updated;
    const next: SchedulesFile = { schema: SCHEDULES_SCHEMA, version: file.version + 1, tasks };
    writeSchedules(home, next);
    return { ok: true, value: updated, version: next.version };
  });
}

/**
 * Delete one task. Removal publishes nothing and rewrites no contract, so the
 * panel side may do it too; the version check is the guard.
 */
export function removeScheduledTask(
  home: string,
  id: string,
  options: { expectedVersion?: number } = {},
): ScheduleStoreResult<ScheduledTask> {
  return withTableLock(home, () => {
    const read = readSchedules(home);
    if (!read.ok) return read;
    const file = read.file;
    const conflict = versionProblem(options.expectedVersion, file.version);
    if (conflict) return { ok: false, problem: conflict };
    const index = file.tasks.findIndex((task) => task.id === id);
    if (index < 0) return { ok: false, problem: `找不到调度任务 ${id}` };
    const removed = file.tasks[index]!;
    const next: SchedulesFile = {
      schema: SCHEDULES_SCHEMA,
      version: file.version + 1,
      tasks: file.tasks.filter((task) => task.id !== id),
    };
    writeSchedules(home, next);
    return { ok: true, value: removed, version: next.version };
  });
}

// ---------------------------------------------------------------------------
// the run ledger
// ---------------------------------------------------------------------------

/**
 * Append one line to `schedule-runs.jsonl` (0600). Append-only on purpose:
 * only the daemon's tick writes this file and nothing ever rewrites it, so a
 * session (or the panel) reading the ledger cannot lose an entry to a
 * read-modify-write, and there is no window in which the file is half-rewritten.
 * It throws on an unreadable home or an unknown record kind — both are
 * call-site bugs, not states.
 */
export function appendScheduleRun(home: string, record: ScheduleRunRecord): void {
  if (!isRecord(record) || !RUN_KINDS.includes(String(record.kind))) {
    throw new Error(`未知的调度台账记录（只接受 ${RUN_KINDS.join(" / ")}）：${JSON.stringify(record)}`);
  }
  const path = scheduleRunsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  // `mode` only applies when the file is CREATED; an older, looser file keeps
  // its bits through the append, so the private mode is re-asserted here.
  chmodSync(path, 0o600);
}

/** `readScheduleRuns` options: newest `limit` entries of one task, or all. */
export interface ReadScheduleRunsOptions {
  taskId?: string;
  /** Keep only the newest N (after filtering); the result stays in file order. */
  limit?: number;
}

/**
 * The ledger, oldest first. A malformed line (a torn append, a foreign line) is
 * skipped instead of failing the read: an unreadable ledger must not stop the
 * scheduler from settling a run, and the records around it are still true.
 */
export function readScheduleRuns(home: string, options: ReadScheduleRunsOptions = {}): ScheduleRunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(scheduleRunsPath(home), "utf8");
  } catch {
    return [];
  }
  const records: ScheduleRunRecord[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && RUN_KINDS.includes(String(parsed.kind)) && isText(parsed.taskId)) {
        records.push(parsed as unknown as ScheduleRunRecord);
      }
    } catch {
      /* skipped, never fatal */
    }
  }
  const filtered = options.taskId === undefined ? records : records.filter((record) => record.taskId === options.taskId);
  const limit = options.limit;
  if (limit === undefined || !Number.isFinite(limit) || limit < 0 || filtered.length <= limit) return filtered;
  return filtered.slice(filtered.length - Math.floor(limit));
}

/**
 * ONE PAGE OF A TASK'S HISTORY, WALKED FROM THE NEWEST RECORD BACKWARDS.
 *
 * WHY THE CURSOR IS AN INDEX FROM THE FRONT, NOT A DISTANCE FROM THE END
 * (2026-10-03, reviewer P1): the ledger grows WHILE a reader pages through it —
 * a run starts, a run settles — and "the 25 newest records after skipping 25"
 * means something different after each append, so the reader sees records twice
 * and (once a limit is in play) can miss some entirely. An index counted from
 * the FIRST record of the task is stable under appends, which is the one thing
 * the ledger guarantees: it is append-only and nothing is ever removed from it.
 *
 * `nextOffset` comes back with every page — callers do not compute it, and a
 * reader that stops when it reaches 0 has seen every record exactly once. A
 * first page (no `offset`) starts at the newest record and names the cursor for
 * everything older; `total` rides along so a caller can say how much history
 * there is.
 */
export function readScheduleRunPage(
  home: string,
  options: { taskId: string; limit: number; offset?: number },
): { runs: ScheduleRunRecord[]; total: number; nextOffset: number } {
  const all = readScheduleRuns(home, { taskId: options.taskId });
  const total = all.length;
  const limit = Math.max(0, Math.floor(options.limit));
  // A CURSOR PAST THE END IS AN EMPTY PAGE, not a repeat of the newest records:
  // it can only be stale (the ledger was trimmed by hand, a caller kept one from
  // another task), and answering it with records the reader already saw is
  // exactly the failure this cursor exists to prevent.
  const requested = options.offset === undefined ? undefined : Math.max(0, Math.floor(options.offset));
  if (requested !== undefined && requested > total) {
    return { runs: [], total, nextOffset: 0 };
  }
  const end = requested ?? total;
  const start = Math.max(0, end - limit);
  return { runs: all.slice(start, end), total, nextOffset: start };
}
