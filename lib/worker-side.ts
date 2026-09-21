/**
 * THE WORKER PANE'S OWN SIDE — identity, prompt, task book, and how it speaks
 * back.
 *
 * ── WHAT A WORKER IS (user decision, 2026-09-21) ──
 *
 * A READ-ONLY pane session the agent dispatches for work it does not want to
 * spend its own context on. It replaces the pi-subagents `Agent` tool, and it
 * is deliberately shaped like a judge pane rather than like a background
 * process: same tmux pane, same channel file, same deterministic session id,
 * so it can be watched, answered, closed, and RESUMED with its context intact.
 *
 * ── WHY READ-ONLY IS THE WHOLE DESIGN ──
 *
 * "Only the main agent writes to the worktree" is not a style preference: a
 * second writer invalidates every review verdict already recorded against that
 * content (the approval binds to a tree), and it is why orchestration children
 * in one repo each get their own checkout. A worker that could edit would put
 * an unsupervised writer in the middle of that contract. So the pane is opened
 * with `--exclude-tools edit,write,bash` — the tool surface itself, not a rule
 * the worker is asked to obey — and `bash` is in that list because it writes
 * too (`echo > f`, `sed -i`): leaving it in would have made "read-only" a
 * nominal promise. See `buildWorkerPaneCommand` for what that costs.
 *
 * ── HOW IT SPEAKS ──
 *
 * TWO ways, and both already exist for orchestration children: `ask_user`
 * (routed through the pane's channel by the same dialog race, so the opener
 * answers it) and `worker_report`, which appends one report record and ends
 * the turn. There is no third way and no background notification: a worker
 * that ends without reporting is a worker whose result nobody has.
 *
 * PURE: env parsing, prompt text and record construction. The pane, the clock
 * and the file system belong to the caller.
 */

import { Type } from "typebox";
import type { ChannelIO, ChannelTarget } from "./orchestrator-channel.ts";
import { appendRecord, newChannelId } from "./orchestrator-channel.ts";
import type { ToolHost } from "./tool-host.ts";
import type { ToolReply } from "./tool-host.ts";

/** The opener that dispatched this worker (also its channel owner). */
export const WORKER_OPENER_ENV = "RG_WORKER_OPENER";
/** This worker's own stable handle — the pane's resume key. */
export const WORKER_ID_ENV = "RG_WORKER_ID";
/** Which configured preset it was launched as (`worker`, `worker-recon`, …). */
export const WORKER_ROLE_ENV = "RG_WORKER_ROLE";

export interface WorkerSideConfig {
  openerId: string;
  workerId: string;
  role: string;
}

/**
 * Read this pane's worker identity, or `undefined` when this is not a worker
 * pane. All three parts are required: a half-configured pane must NOT bind
 * somebody's channel, because a worker that reports into the wrong file is
 * worse than one that cannot report at all.
 */
export function readWorkerSideEnv(env: NodeJS.ProcessEnv): WorkerSideConfig | undefined {
  const openerId = env[WORKER_OPENER_ENV]?.trim();
  const workerId = env[WORKER_ID_ENV]?.trim();
  const role = env[WORKER_ROLE_ENV]?.trim();
  if (!openerId || !workerId || !role) return undefined;
  return { openerId, workerId, role };
}

/**
 * The system prompt a worker pane runs with.
 *
 * A configured preset may carry its own `prompt` (the user's words win, and
 * they are the reason presets exist); what follows it — or stands alone — is
 * the part that is NOT negotiable, because it is what makes the result usable
 * rather than merely present: read-only, self-contained, evidence-backed, and
 * reported exactly once.
 */
export function buildWorkerSystemPrompt(opts: {
  repoRoot: string;
  role: string;
  /** The preset's own prompt, when it has one. */
  prompt?: string;
}): string {
  const head = opts.prompt?.trim();
  return [
    ...(head ? [head, ""] : []),
    `你是 worker「${opts.role}」—— 一个**只读**的调查会话，在 tmux pane 里为开你的会话干活。`,
    `工作仓库：${opts.repoRoot}`,
    "",
    "## 工作方式",
    "- 你**只能读**：`read` / `grep` / `find` / `ls` 是你全部的工具 —— `edit`、`write`、`bash` 都不在。",
    "- 需要跑命令（测试、git 历史）才能确定的事：把「需要跑什么、为什么」写进结论，让上级去跑；**不要猜**。",
    "- **一条消息里并行发多个读取** —— pi 会把同一条消息里的工具调用并行执行，一个工具调用就是一个完整来回。",
    "- 找证据，不要凭印象：每句「在哪里」都要能指到具体文件与行号。",
    "- 不确定就写清楚不确定在哪、你需要什么才能确定；**不要编**。",
    "- 不要做任务书之外的事，包括顺手看看别的地方。",
    "",
    "## 交卷",
    "- 干完就用 `worker_report({result})` 交一次，然后停下。上级只看到这段 `result`，看不到你的思考过程，所以它必须自包含。",
    "- 需要上级拍板才能继续时，用 `ask_user` 提问（上级会答）；自己能查清楚的不要问。",
    "- 交卷文本写结论与证据，不要复述任务书、不要写过程说明。",
    "",
  ].join("\n");
}

/** The task file a worker pane opens with. */
export function buildWorkerTaskDocument(opts: { workerId: string; role: string; task: string }): string {
  return [
    `# worker ${opts.workerId}（${opts.role}）`,
    "",
    opts.task.trim(),
    "",
    "干完用 `worker_report({result})` 交一次，然后停下。",
    "",
  ].join("\n");
}

/**
 * The report a worker writes back — ONE record, and it is the whole result.
 *
 * `kind: "report"` is what the opener's `worker_wait` waits for. A judge's
 * report is a VERDICT for the opener to record; a worker is asked a QUESTION
 * and answers it in prose, so the text rides in `summary` — the field that
 * already exists for the one role whose product IS the text (an adviser), and
 * which `appendRecord` spills to a side file when it would blow the line
 * budget. One record type, one channel, one reader and one cursor serve
 * judges, children and workers alike; a worker-specific record kind would be
 * a second reader for the same file.
 *
 * `verdict: "READY"` is not a claim about quality — there is no gate to be
 * ready for. It is the field's only honest value here: the worker finished the
 * work it was given, and `summary` carries what it found.
 */
export function appendWorkerReport(
  io: ChannelIO,
  target: ChannelTarget,
  opts: { result: string; cwd?: string },
): void {
  appendRecord(io, target, {
    kind: "report",
    from: "child",
    at: new Date(io.now()).toISOString(),
    reportId: newChannelId("wr", io.now()),
    verdict: "READY",
    summary: opts.result.trim(),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
  });
}

// ---------------------------------------------------------------------------
// the tool the worker side owns
// ---------------------------------------------------------------------------

/**
 * WHY THIS TOOL IS GUARDED BY ITS REGISTRATION, like `judge_conclude`.
 *
 * `worker_report` answers the opener's `worker_wait` by writing a report onto
 * the pane's channel. A MAIN session must never have it: it would let the
 * agent fabricate a worker's answer — and the opener's wait would accept it,
 * because a report on that file is exactly what a real worker produces. The
 * guard is the surface (registered only when the env says this IS a worker
 * pane), not a secret, which is the same anti-forgery rule the judge side
 * uses.
 */
export interface WorkerReportToolDeps {
  env(): NodeJS.ProcessEnv;
  channelIO(): ChannelIO;
  now(): number;
  /** The worker's own working directory, reported so the opener can check it. */
  cwd(): string;
}

export function registerWorkerReportTool(host: ToolHost, deps: WorkerReportToolDeps): void {
  host.registerTool({
    name: "worker_report",
    label: "Report Result",
    description:
      "交活：把这次调查的结论交回给开你的会话，然后停下。**只交一次**，`result` 必须自包含 —— " +
      "上级只看到这段文本，看不到你的思考过程。写结论与证据（文件、行号、命令输出），不要复述任务书。" +
      "需要上级拍板才能继续时，用 `ask_user` 提问，不要用这个工具问。",
    parameters: Type.Object({
      result: Type.String({ description: "这次调查的结论与证据（自包含）" }),
    }),
    execute: async (_id, params): Promise<ToolReply> => {
      const side = readWorkerSideEnv(deps.env());
      if (!side) {
        return {
          content: [{ type: "text", text: "review-gate: 这个会话不是 worker pane，没有可交的活。" }],
          details: undefined,
          isError: true,
        };
      }
      const result = String(params.result ?? "").trim();
      if (!result) {
        return {
          content: [{ type: "text", text: "review-gate: `result` 不能为空 —— 上级等的是结论，不是「干完了」。" }],
          details: undefined,
          isError: true,
        };
      }
      const io = deps.channelIO();
      appendWorkerReport(io, { orchestrationId: side.openerId, childId: `worker-${side.workerId}` }, {
        result,
        cwd: deps.cwd(),
      });
      return {
        content: [{
          type: "text",
          text: `review-gate: 已交活给 ${side.openerId}（${result.length} 字符）。这一轮到此为止，停下即可。`,
        }],
        details: { workerId: side.workerId, openerId: side.openerId },
      };
    },
  });
}
