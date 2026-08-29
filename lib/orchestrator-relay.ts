/**
 * SELF-RELAY — handing one orchestration to a successor session without a gap.
 *
 * An orchestration outlives a session's context window. The handover is the
 * moment everything can be lost, so the protocol (task book §8) is built
 * around one asymmetry: **only the SUCCESSOR may close the predecessor**
 * (constraint 12). That single rule is what makes the handover verifiable —
 * a session that can close the old one has necessarily started, read the
 * handoff and reached the point of running a tool, so "the successor is up"
 * is proven by the act itself rather than asserted by the session that is
 * about to disappear.
 *
 * THREE THINGS TRAVEL, and each answers a different failure:
 *
 *  - the ORCHESTRATION ID, so every child keeps reaching the current holder
 *    with no restart (lib/orchestration-id.ts);
 *  - the HANDOFF DOCUMENT plus the plan path — the predecessor's own account
 *    of where things stand;
 *  - the predecessor's TRANSCRIPT path — the RAW record. The handoff document
 *    is a self-report and can omit or flatter; when the plan later goes wrong,
 *    the successor needs the primary source. (Same move as `prepare_adviser`,
 *    which hands a transcript pointer rather than a summary.)
 *
 * Pure module: it decides and it builds an environment record. The extension
 * checks the filesystem and spawns the pane.
 */

import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";

/** Pane id of the orchestrator being replaced (injected into the successor). */
export const PREDECESSOR_PANE_ENV = "RG_ORCHESTRATOR_PREDECESSOR_PANE";
/** Path of the handoff document the successor must read first. */
export const HANDOFF_PATH_ENV = "RG_ORCHESTRATOR_HANDOFF";
/** Path of the predecessor's transcript — the raw record, for digging. */
export const PREDECESSOR_TRANSCRIPT_ENV = "RG_ORCHESTRATOR_PREDECESSOR_TRANSCRIPT";

/** A handoff document shorter than this is not a handoff. */
export const MIN_HANDOFF_CHARS = 200;

export interface RelayFacts {
  /** Is a plan on disk AND still approved (hash matches)? */
  planApproved: boolean;
  /** Repo-relative path of the handoff document the agent wrote. */
  handoffPath?: string;
  /** Size of that document in characters; undefined ⇒ it does not exist. */
  handoffChars?: number;
  /** The orchestrator's own pane — the successor is split off it. */
  ownPane?: string;
  /** Children still alive right now. */
  liveChildCount: number;
}

/**
 * Everything that must be true BEFORE a successor is started.
 *
 * The plan and the handoff must already be ON DISK: a successor that has to
 * ask what it inherited has not inherited anything. Live children are
 * explicitly ALLOWED to continue — carrying running work across the handover
 * is the whole point of addressing children by orchestration id — so they are
 * reported, not refused.
 */
export function relayPreconditions(facts: RelayFacts): string[] {
  const problems: string[] = [];
  if (!facts.planApproved) {
    problems.push(
      "plan 未落盘或批准已失效 —— 接力前必须有一份用户批准过的 plan，" +
      "否则新会话接手的是一份没人认可的任务清单（约束 12）",
    );
  }
  if (!facts.handoffPath) {
    problems.push(
      "没有交接文档 —— 先写 docs/orchestrator-*.md：新会话读它接手，" +
      "内容至少要说明当前进度、下一步、以及踩过的坑（约束 12）",
    );
  } else if (facts.handoffChars === undefined) {
    problems.push(`交接文档 "${facts.handoffPath}" 不存在（还没落盘）`);
  } else if (facts.handoffChars < MIN_HANDOFF_CHARS) {
    problems.push(
      `交接文档 "${facts.handoffPath}" 只有 ${facts.handoffChars} 字，` +
      `太短了（至少 ${MIN_HANDOFF_CHARS} 字）——新会话要靠它接手，不是靠猜`,
    );
  }
  if (!facts.ownPane) {
    problems.push("不知道自己所在的 tmux pane，无法在旁边开新会话 —— 请在 tmux window 内运行");
  }
  return problems;
}

/** The environment the successor is started with. */
export function successorEnv(opts: {
  orchestrationId: string;
  predecessorPane: string;
  handoffPath: string;
  predecessorTranscript?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    [ORCHESTRATION_ID_ENV]: opts.orchestrationId,
    [PREDECESSOR_PANE_ENV]: opts.predecessorPane,
    [HANDOFF_PATH_ENV]: opts.handoffPath,
  };
  if (opts.predecessorTranscript) env[PREDECESSOR_TRANSCRIPT_ENV] = opts.predecessorTranscript;
  return env;
}

/** What a successor session inherited, read back from its own environment. */
export interface Inheritance {
  predecessorPane?: string;
  handoffPath?: string;
  predecessorTranscript?: string;
}

export function readInheritance(env: NodeJS.ProcessEnv = process.env): Inheritance {
  const value = (key: string): string | undefined => {
    const raw = env[key]?.trim();
    return raw && raw.length > 0 ? raw : undefined;
  };
  return {
    predecessorPane: value(PREDECESSOR_PANE_ENV),
    handoffPath: value(HANDOFF_PATH_ENV),
    predecessorTranscript: value(PREDECESSOR_TRANSCRIPT_ENV),
  };
}

/**
 * CONSTRAINT 12, second half — may THIS session close that pane as a
 * predecessor?
 *
 * Only when its own environment says that pane is the one it replaced. The
 * predecessor cannot close itself (it has no such variable), which is exactly
 * the guarantee: the old session stays alive until something that is
 * demonstrably running takes over.
 */
export function predecessorCloseAuthorization(
  targetPane: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; reason: string } {
  const inherited = readInheritance(env);
  if (!inherited.predecessorPane) {
    return {
      ok: false,
      reason:
        "本会话不是任何人的接任者，不能以「接力」的名义关掉一个项目经理 pane。" +
        "接力的顺序是固定的：老会话写交接文档 → `orchestrator_relay` 开出新会话 → " +
        "由新会话关掉老会话（这天然证明新会话已经起来了，中间不断档）。",
    };
  }
  if (inherited.predecessorPane !== targetPane) {
    return {
      ok: false,
      reason:
        `本会话接替的是 ${inherited.predecessorPane}，不是 ${targetPane} —— ` +
        "只能关掉自己的前任。",
    };
  }
  return { ok: true };
}

/** The first thing a successor should be told, rendered from its inheritance. */
export function formatInheritanceBrief(inherited: Inheritance, orchestrationId?: string): string {
  if (!inherited.predecessorPane && !inherited.handoffPath) return "";
  const lines = [
    "## 你是接任的项目经理（自我接力）",
    inherited.handoffPath ? `- 交接文档：\`${inherited.handoffPath}\`（先读它）` : "",
    orchestrationId ? `- orchestration id：\`${orchestrationId}\`（子会话的通知会直接流向你，无需重启它们）` : "",
    inherited.predecessorTranscript
      ? `- 前任 transcript（原始记录，交接文档是自述、可能有遗漏）：\`${inherited.predecessorTranscript}\`——有疑点时自己去 grep`
      : "",
    inherited.predecessorPane
      ? `- 前任 pane：\`${inherited.predecessorPane}\`。确认接手无误后，由你调 \`orchestrator_close\` 关掉它。`
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}
