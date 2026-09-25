/**
 * The facts every worker tool (lib/worker-tools.ts, lib/worker-submit.ts)
 * reads before it acts: WHERE a worker's channel is and what it currently
 * says, whether a recorded pane is still ours, which id a new worker gets, and
 * which model + prompt a worker role launches with.
 *
 * Its own module so the four tools share one answer to each question — the
 * pane-ownership check in particular is asked in four places, and two copies
 * of it is how one drifts back to trusting a stranger's pane.
 */
import type { ChannelRecord, ChannelRequestRecord, ChannelReportRecord } from "./channel-records.ts";
import {
  channelPathFor,
  reportText,
  requestPayload,
  type ChannelIO,
  type ChannelTarget,
} from "./channel-io.ts";
import { readChannel } from "./channel-projection.ts";
import type { AgentsConfigMap } from "./agents-config.ts";
import type { WorkerEntry, WorkerRegistry } from "./worker-pane.ts";
import type { WorkerToolDeps } from "./worker-tools.ts";

/** Poll interval. The worker's channel is a file on the same machine. */
export const WORKER_WAIT_POLL_MS = 500;

/** The channel one worker talks on — opener + worker id, like a judge's. */
export function workerChannelTarget(openerId: string, workerId: string, home?: string): ChannelTarget {
  return { orchestrationId: openerId, childId: `worker-${workerId}`, ...(home === undefined ? {} : { home }) };
}

/**
 * WHERE AN EXISTING WORKER'S CHANNEL IS — read from its registry entry, never
 * re-derived from this session's environment (reviewer P1, 2026-09-21).
 *
 * The opener's pane id changes on every restart, re-attach and handover, so a
 * re-derived target points at a channel the worker never wrote to: its report
 * lands where nobody looks and the caller waits on an empty file forever. The
 * entry is the record of who opened it, so the entry is what answers.
 */
export function workerTargetFor(deps: WorkerToolDeps, registry: WorkerRegistry, workerId: string): ChannelTarget {
  const recorded = registry[workerId]?.openerId;
  return workerChannelTarget(recorded ?? deps.openerId(), workerId, deps.channelHome());
}

/** Everything a worker has said that the opener has not consumed yet. */
export interface WorkerProjection {
  /** The newest report on the channel, with the id used to dedupe it. */
  report?: { reportId: string; text: string; at: string };
  /** The oldest question still waiting for an answer. */
  question?: { requestId: string; title: string; options: string[]; payload?: string; at: string };
  /** How many records the channel holds — the boot watermark. */
  records: number;
}

/**
 * Project one worker channel into the two things a caller can act on.
 *
 * A question stays in the projection until an ANSWER for its requestId exists:
 * that is what makes `worker_wait` idempotent — polling it twice shows the same
 * question rather than losing it, and the caller's `worker_answer` is the only
 * thing that retires it.
 */
export function projectWorkerChannel(io: ChannelIO, records: readonly ChannelRecord[]): WorkerProjection {
  const answered = new Set<string>();
  for (const r of records) if (r.kind === "answer") answered.add(r.requestId);
  let report: WorkerProjection["report"];
  let question: WorkerProjection["question"];
  for (const r of records) {
    if (r.kind === "report") {
      const record = r as ChannelReportRecord;
      // THE REPORT IS NOT ALWAYS INLINE (P0, 2026-09-22). A report past the
      // inline budget is spilled to a side file and the record keeps only
      // `summaryRef` — reading `summary` alone made `worker_wait` answer
      // 「没有新消息」 forever for every long report (measured on a real one:
      // `{"kind":"report",…,"summaryRef":{…,"chars":19657}}`). `reportText`
      // is the ONE reader that knows both shapes; the request records below
      // already went through its twin (`requestPayload`).
      const text = reportText(io, record)?.trim();
      report = {
        reportId: record.reportId,
        // A SPILL NOBODY CAN READ IS REPORTED, NOT SWALLOWED: dropping it
        // silently is indistinguishable, to the caller, from a worker that
        // never reported at all.
        text: text || unreadableReport(record),
        at: r.at,
      };
      continue;
    }
    if (r.kind === "request") {
      const req = r as ChannelRequestRecord;
      if (answered.has(req.requestId)) continue;
      // OLDEST first: a worker blocked on question one must not be answered out
      // of order by a later one.
      if (!question) {
        const payload = requestPayload(io, req);
        question = {
          requestId: req.requestId,
          title: req.title,
          options: req.options ?? [],
          at: req.at,
          ...(payload === undefined ? {} : { payload }),
        };
      }
    }
  }
  return { ...(report === undefined ? {} : { report }), ...(question === undefined ? {} : { question }), records: records.length };
}

/**
 * WHAT A REPORT SAYS WHEN ITS TEXT CANNOT BE READ — a fact, not silence.
 *
 * Two shapes: a `summaryRef` that points at nothing readable (the side file
 * was pruned, the path is stale), and a record that carried neither an inline
 * summary nor a reference. Both used to vanish into “no new message”, which is
 * the one answer a caller can never act on.
 */
function unreadableReport(record: ChannelReportRecord): string {
  const ref = record.summaryRef;
  return ref
    ? `（报告读不到：${ref.path} 不存在或为空；记录声明 ${ref.chars} 字符）`
    : "（报告没有内容：既没有内联 summary 也没有 summaryRef）";
}

/** Read one worker's channel, tolerating a channel that does not exist yet. */
export function readWorkerChannel(deps: WorkerToolDeps, registry: WorkerRegistry, workerId: string): WorkerProjection {
  try {
    const path = channelPathFor(...targetParts(deps, registry, workerId));
    return projectWorkerChannel(deps.channelIO, readChannel(deps.channelIO, path).records);
  } catch {
    return { records: 0 };
  }
}

export function targetParts(
  deps: WorkerToolDeps,
  registry: WorkerRegistry,
  workerId: string,
): [string, string, string | undefined] {
  const target = workerTargetFor(deps, registry, workerId);
  return [target.orchestrationId, target.childId, target.home];
}

/**
 * May we treat this pane id as OURS?
 *
 * ONE implementation, because FOUR places ask the same question (reviewer P1,
 * 2026-09-21): `worker_close` before it kills, and submit / wait / the
 * default-worker pick before they trust liveness. Two copies of "the recorded
 * server must match, and a recorded server we cannot RE-READ is not a match"
 * is exactly how one of them drifts back to trusting a stranger's pane — the
 * pane id a tmux server mints can be re-issued to somebody else after a
 * restart.
 *
 * An entry with NO recorded server (written before the field existed) skips
 * the check: there is nothing to disagree with.
 */
export function paneIsOurs(entry: WorkerEntry | undefined, currentServer: string | undefined): boolean {
  if (!entry || entry.paneId === undefined) return false;
  return entry.tmuxServer === undefined || entry.tmuxServer === currentServer;
}

/**
 * Is this worker's pane still alive AND ours? — the liveness question, asked
 * by submit / wait / the default-worker pick; `paneIsOurs` is shared with the
 * kill path so all four give the same answer.
 */
export function ownedPaneAlive(deps: WorkerToolDeps, entry: WorkerEntry | undefined): boolean {
  if (!paneIsOurs(entry, deps.tmuxServer?.())) return false;
  return deps.paneAlive(entry!.paneId!);
}

/** Mint the next free worker id (`worker-1`, `worker-2`, …). */
export function nextWorkerId(registry: WorkerRegistry): string {
  for (let i = 1; ; i += 1) {
    const candidate = `worker-${i}`;
    if (!registry[candidate]) return candidate;
  }
}

/** The role's resolved launch: the model to run and the prompt it carries. */
export function resolveWorkerRole(
  agents: AgentsConfigMap,
  role: string,
  overrideModel?: string,
  /**
   * Registry check for the spec, injected (quality round P2, 2026-09-21).
   *
   * A worker preset's chain is read straight from the config section, so it
   * never passes through `applyAgentConfigLayer` — which is where every OTHER
   * role's slots get validated. Without this, a typo (`agents.worker.slots[0]
   * = "onekey/gpt-6-astr:max"`) is discovered only when pi refuses to start the
   * pane. Fail-closed like the missing-preset case: an unresolvable spec is a
   * configuration error, not something to paper over.
   */
  validate?: (spec: string) => { ok: boolean; reason?: string },
): { ok: true; model: string; prompt?: string } | { ok: false; reason: string } {
  const entry = agents[role];
  if (!entry || entry.source === "default") {
    return {
      ok: false,
      reason:
        `worker 角色 \`${role}\` 没有配置 —— 在 ~/.pi/review-gate.json 的 agents 段里加上它` +
        `（\`{ "auto": false, "slots": ["<provider>/<model>:<thinking>"], "prompt": "…" }\`）。` +
        "没有配置就派活等于用一个没人选过的模型跑，所以这里直接拒绝。",
    };
  }
  if (entry.malformed) return { ok: false, reason: `worker 角色 \`${role}\` 的配置字段非法（malformed）` };
  const override = overrideModel?.trim();
  const model = override || entry.slots[0];
  if (!model) {
    return { ok: false, reason: `worker 角色 \`${role}\` 的 slots 是空的 —— 没有可派发的模型` };
  }
  const checked = validate?.(model);
  if (checked && !checked.ok) {
    return {
      ok: false,
      reason:
        `worker 角色 \`${role}\` 的模型 spec \`${model}\` 不可解析（${checked.reason ?? "原因未知"}）—— ` +
        `改 ~/.pi/review-gate.json 里的 agents.${role}.slots${override ? "，或换掉本次的 model 覆盖" : ""}；` +
        "派一个起不来的 pane 等于把任务丢进黑洞。",
    };
  }
  return { ok: true, model, ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }) };
}
