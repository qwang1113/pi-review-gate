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
 * a refusal. The ledger is append-only: three processes (the daemon's tick, a
 * gate session, the panel) can add a line without reading the others', and a
 * torn final line is skipped rather than fatal. Every path comes from an
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
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import { nextRunAfter, parseCron } from "./cron-schedule.ts";
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
  /** Runtime bookkeeping (the daemon stamps it when a run starts), not authoring. */
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

export interface ScheduleRunStarted { kind: "run-started"; runId: string; taskId: string; sessionId: string; at: string }
export interface ScheduleRunSettled {
  kind: "run-settled"; runId: string; taskId: string; at: string;
  outcome: ScheduleRunOutcome; verdict: string | null; unmet: string[];
}
export interface ScheduleRunSkipped { kind: "run-skipped"; taskId: string; at: string; reason: string }

export type ScheduleRunRecord = ScheduleRunStarted | ScheduleRunSettled | ScheduleRunSkipped;

const RUN_KINDS: readonly string[] = Object.freeze(["run-started", "run-settled", "run-skipped"]);

// ---------------------------------------------------------------------------
// reading and writing the table
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * A timestamp `new Date(...)` can read. The gate ACTS on `lastFiredAt` (what
 * `nextRunAtFor` counts from) and on `approvedAt` (what makes a re-negotiation
 * one), so both are validated on BOTH sides: the write side refuses them, the
 * read side refuses to hand them on.
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
/** Everything an edit may name at all. */
const EDITABLE_FIELDS: readonly string[] = Object.freeze(["name", "cron", "enabled", "lastFiredAt", ...AUTHORED_FIELDS]);

/** The refusal a panel edit gets when it reaches for an authored field. */
export function scheduleAuthoringRefusal(problem: string): string {
  return buildRejection({
    what: `调度任务的修改被拒：${problem}`,
    why: "需求/repo/契约的修改必须走 authoring 会话或 `schedule_task` 工具（需求反述 + goal 批准）—— " +
      "面板是一张文本表单，它改得动的那三个字段（name / cron / enabled）都不改变这份任务「是什么」。",
    by: "agent",
    next: "面板只改 name / cron / enabled；要改需求、repo 或契约，请用一个 loop 会话走 `schedule_task` 重新协商" +
      "（需求反述 → goal 批准 → 写入契约）。",
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
  const unknown = Object.keys(patch).filter((key) => !EDITABLE_FIELDS.includes(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      problem: `不认识的字段 ${unknown.join("、")} —— 能改的只有 ${EDITABLE_FIELDS.join(" / ")}`,
    };
  }
  if (from === "panel") {
    const touched = AUTHORED_FIELDS.filter((field) => Object.hasOwn(patch, field));
    if (touched.length > 0) {
      return { ok: false, problem: scheduleAuthoringRefusal(`panel 来源的 patch 碰到了 ${touched.join("、")}`) };
    }
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
}

/**
 * When this task fires next — from `lastFiredAt` if it has fired (a run that
 * already happened is not a candidate again, so after a pause this can land in
 * the past), else from `now`. A disabled task, an illegal cron and an
 * impossible date all answer `null` rather than throwing.
 */
export function nextRunAtFor(task: ScheduledTask, now: Date): Date | null {
  if (!task || task.enabled !== true) return null;
  const base = task.lastFiredAt ? new Date(task.lastFiredAt) : now;
  if (!(base instanceof Date) || Number.isNaN(base.getTime())) return null;
  return nextRunAfter(task.cron, base);
}

// ---------------------------------------------------------------------------
// the run ledger
// ---------------------------------------------------------------------------

/**
 * Append one line to `schedule-runs.jsonl` (0600). Append-only on purpose: the
 * file three processes write and nobody rewrites, so there is no
 * read-modify-write window to lose an entry in. It throws on an unreadable
 * home or an unknown record kind — both are call-site bugs, not states.
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
