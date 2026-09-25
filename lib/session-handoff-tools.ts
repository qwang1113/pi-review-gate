/**
 * THE ONE HANDOVER TOOL — `session_handoff()` on every kind of session.
 *
 * WHY ONE TOOL AND NOT FOUR (philosophy two, user decision 2026-09-14): a
 * session that has run out of room should not have to work out which of
 * several entry points applies to it. The gate knows what kind of session it
 * is running in, where its transcript is, what contract is in force and what
 * is still open — so the agent's whole contribution is the INTENT to hand
 * over, plus the one paragraph only it can write. Everything after the call
 * is mechanical and belongs here.
 *
 * WHAT THE TOOL DOES, IN ORDER, and why each step is not the caller's:
 *
 *  1. the handoff document — the gate writes the skeleton (contract,
 *     outstanding work, transcript pointer). The agent may have written its
 *     own paragraph into it already, and the receipt says whether it did:
 *     a successor with only the mechanical frame can still work, but only the
 *     predecessor knows why any of it was done.
 *  2. the successor pane — opened through lib/session-factory.ts with a FIRST
 *     MESSAGE (argv), which is the fix for the failure this replaces: a bare
 *     `pi` successor never learned there was a document to read, and two
 *     sessions sat waiting on each other.
 *  3. the predecessor's retirement — two phases, because the successor arms
 *     its gate in the SAME worktree and the exclusivity guard refuses a second
 *     claimant while our heartbeat is fresh. Phase one releases the claim
 *     BEFORE the pane opens; phase two goes silent AFTER the relay record is
 *     persisted. A handover that never happens must change NOTHING, so a failed
 *     open rolls phase one back — the session stays the holder.
 *  4. the closing — NOT here. The predecessor is closed by the GATE once the
 *     successor has demonstrably taken over (lib/session-handoff.ts owns what
 *     counts as proof), which is why nothing in the successor's brief asks it
 *     to close anything.
 *
 * A JUDGE hands ITSELF over — a pane beside its own, opened by the JUDGE
 * (see `requestSuccession`; the extension's `judgeSuccessionRequest` is the
 * implementation). The round is the judge's to finish, and waiting for the
 * opener's next dispatch would mean finishing a round that has already run
 * out of room: it opens the next generation, points it at the document it just
 * wrote, and updates the registry so the opener's next sweep reads the NEW
 * channel rather than a session that no longer exists.
 */

import { Type } from "typebox";
import type { ToolHost, ToolReply } from "./tool-host.ts";
import { STATE_VARIANT_ENV } from "./gate-state-io.ts";
import { ORCHESTRATION_ID_ENV } from "./orchestration-id.ts";
import { GATE_MODE_ENV } from "./task-mode.ts";
import { STATION_CAP_ENV } from "./repo-pr-policy.ts";
import { ACCEPTANCE_GATE_ENV } from "./acceptance-round.ts";
import {
  buildHandoffDoc,
  formatContextStatus,
  handoffDocFilled,
  HANDOFF_PERCENT,
  readContext,
  type HandoffSessionKind,
} from "./session-handoff.ts";
import { handoffGeneration, successorEnv, successorSessionId } from "./session-inheritance.ts";

/** The pane a successor is started in — built by the caller, opened by the caller. */
export interface SuccessorPaneSpec {
  env: Readonly<Record<string, string>>;
  command: readonly string[];
  cwd: string;
}

export interface SessionHandoffDeps {
  /** Which kind of session is running here. */
  kind(): HandoffSessionKind;
  /** This session's own id, when the host gave it one. */
  sessionId(): string | undefined;
  /** This session's own tmux pane. */
  ownPane(): string | undefined;
  repoRoot(): string;
  /** Absolute path of this session's transcript, for the successor's digging. */
  transcriptPath(): string | undefined;
  /** Where the handoff document lives — the gate decides, the agent never passes a path. */
  docPath(sessionId: string): string;
  /** The mechanical facts the document states (contract, outstanding work). */
  docFacts(): { contract?: string; outstanding?: string[] };
  writeText(path: string, text: string): void;
  readText(path: string): string | undefined;
  openSuccessor(spec: SuccessorPaneSpec): Promise<{ ok: true; paneId: string } | { ok: false; error: string }>;
  /** Retirement, two phases (see the module header). Absent ⇒ nothing to release. */
  retire?(): { committed(): void; rolledBack(): void } | undefined;
  /**
   * Record the handover on whatever the SESSION owns (an orchestration writes
   * its relay row here). Called once the successor's pane exists and BEFORE
   * `committed` — the record has to be on disk before the writer goes quiet.
   */
  recordHandoff?(paneId: string, docPath: string): void;
  /**
   * Judge side: open the next generation BESIDE this pane and register it.
   *
   * Named for the INTENT (a successive session takes over this round), not for
   * a mechanism, because which mechanism is the judge's own business — the
   * extension implements it, and it is the judge (not the opener) that opens
   * the pane: an exhausted round cannot wait for somebody else's next
   * dispatch. Async: opening a pane is.
   */
  requestSuccession?(
    docPath: string,
    pendingFill: boolean,
  ):
    | { ok: true; detail: string }
    | { ok: false; reason: string }
    | Promise<{ ok: true; detail: string } | { ok: false; reason: string }>;
  /** Every other variable the successor needs — mode, orchestration id, state variant, judge identity. */
  extraEnv?(): Readonly<Record<string, string>>;
  now(): number;
}

/** The successor's first action, per kind, rendered into both the document and its first message. */
export function firstActionFor(kind: HandoffSessionKind): string {
  switch (kind) {
    case "orchestrator":
      return "读完交接文档后立刻 `orchestrator_attach({orchestrationId})` 拿回现场（plan、子会话、待答请求），再继续推进。";
    case "judge":
      return "读完交接文档后接着这一轮审查继续做；未定论的部分以文档里写明的进度为准。";
    default:
      return "读完交接文档后接着它「未完成的工作」继续做，不要重新摸索已经做过的事。";
  }
}

/** The short first message the successor pane is opened with. */
export function successorOpeningMessage(docPath: string, kind: HandoffSessionKind): string {
  return [
    "你是接任者：上一个会话把工作交给了你（这次交接由门禁完成）。",
    `**第一件事**：读 \`${docPath}\`（交接文档），里面是当前契约、未完成的工作和前任的补充。`,
    firstActionFor(kind),
    "前任 pane 由门禁在你读到交接文档后自动关闭，你不需要做任何事。",
  ].join("\n");
}

/** The document's path is the gate's business; the id only has to be文件-safe. */
function safeDocName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
}

/**
 * The default doc path: beside the gate's own state, so it is never mistaken
 * for a repository artifact and never lands in a diff. Exported because the
 * caller owns the filesystem and the reminder needs the same path.
 */
export function handoffDocPath(repoRoot: string, sessionId: string): string {
  return `${repoRoot.replace(/\/+$/, "")}/.pi/handoff/${safeDocName(sessionId)}.md`;
}

/** Write the skeleton when the document is absent; leave an existing one alone. */
export function ensureHandoffDoc(deps: SessionHandoffDeps, sessionId: string, docPath: string): { created: boolean; pendingFill: boolean } {
  const existing = deps.readText(docPath);
  if (existing === undefined || existing.trim().length === 0) {
    const facts = deps.docFacts();
    deps.writeText(docPath, buildHandoffDoc({
      kind: deps.kind(),
      sessionId,
      repoRoot: deps.repoRoot(),
      ...(facts.contract === undefined ? {} : { contract: facts.contract }),
      ...(facts.outstanding === undefined ? {} : { outstanding: facts.outstanding }),
      ...(deps.transcriptPath() === undefined ? {} : { transcriptPath: deps.transcriptPath() }),
      firstAction: firstActionFor(deps.kind()),
      now: new Date(deps.now()).toISOString(),
    }));
    return { created: true, pendingFill: true };
  }
  return { created: false, pendingFill: !handoffDocFilled(existing) };
}

/**
 * Hand over. Returns the receipt the agent sees; every failure is a receipt
 * too, because a half-started handover is the one state nobody may be left
 * guessing about.
 */
export async function runSessionHandoff(deps: SessionHandoffDeps): Promise<ToolReply> {
  const kind = deps.kind();
  const sessionId = deps.sessionId();
  if (!sessionId) {
    return fail("review-gate: 这个会话没有 session id，无法交接（宿主没有报告 id）。");
  }
  const docPath = deps.docPath(sessionId);
  let doc: { created: boolean; pendingFill: boolean };
  try {
    doc = ensureHandoffDoc(deps, sessionId, docPath);
  } catch (error) {
    return fail(`review-gate: 写交接文档失败 —— ${(error as Error).message}`);
  }

  if (kind === "judge") {
    if (!deps.requestSuccession) {
      return fail("review-gate: judge 会话的交接需要 opener 侧配合，但门禁没有接线（这是缺陷，请报告）。");
    }
    const asked = await deps.requestSuccession(docPath, doc.pendingFill);
    if (!asked.ok) return fail(`review-gate: 交接请求没能发出 —— ${asked.reason}`);
    return reply(
      `review-gate: 交接请求已发出（judge → opener）。\n` +
      `- 交接文档：\`${docPath}\`${doc.pendingFill ? "（你的补充段还没写）" : ""}\n` +
      `- ${asked.detail}\n` +
      "**接下来请停下**：opener 会开新一代会话接手这一轮，并由门禁关掉你这个 pane。",
      { docPath, kind, pendingFill: doc.pendingFill },
    );
  }

  const pane = deps.ownPane();
  if (!pane) {
    return fail("review-gate: 不知道自己所在的 tmux pane，无法开接任会话 —— 请在 tmux window 内运行。");
  }

  const generation = handoffGeneration(sessionId);
  const successorId = successorSessionId(sessionId, generation + 1);
  let retirement: { committed(): void; rolledBack(): void } | undefined;
  try {
    // Phase one FIRST: the successor arms its gate in this same worktree, and
    // the exclusivity guard refuses a second claimant while our heartbeat is
    // fresh. Measured 2026-09-10: retiring after the pane opened lost the race
    // and the successor exited with "这个 worktree 已被另一个会话占用".
    retirement = deps.retire?.();
    const opened = await deps.openSuccessor({
      env: successorEnv({
        kind,
        predecessorPane: pane,
        handoffDoc: docPath,
        predecessorSessionId: sessionId,
        ...(deps.transcriptPath() ? { predecessorTranscript: deps.transcriptPath() } : {}),
        // `extra`, NOT spread at the top level. `successorEnv` reads a FIXED set
        // of names, so spreading them here dropped every one of them in
        // silence: the mode, the orchestration id and the state variant all
        // vanished, and a child or project manager came up as a plain loop
        // session. Caught by the reviewer against eba8516 (2026-09-14, P1),
        // and pinned by a test that reads the env the pane was opened with.
        extra: deps.extraEnv?.() ?? {},
      }),
      command: ["pi", "--session-id", successorId, successorOpeningMessage(docPath, kind)],
      cwd: deps.repoRoot(),
    });
    if (!opened.ok) {
      retirement?.rolledBack();
      return fail(`review-gate: 开接任会话失败 —— ${opened.error}（接力中止，你仍然是持有者）。`);
    }
    // The record FIRST, then the silence: whatever this session persists goes
    // through the same write path a retired session refuses (an orchestration's
    // relay row most of all), so persisting afterwards would leave it
    // memory-only. Phase two never ran yet, so nothing else needs undoing.
    deps.recordHandoff?.(opened.paneId, docPath);
    retirement?.committed();
    return reply(
      `review-gate: 接任会话已在 pane ${opened.paneId} 启动（session ${successorId}）。\n` +
      `- 交接文档：\`${docPath}\`${doc.pendingFill ? `（**你的补充段还是占位** —— 现在补还来得及，补完继任者会再读一次）` : "（补充段已写）"}\n` +
      `- 继任者拿到的第一条消息已经指向这份文档，它会先读它再动手。\n` +
      "**接下来你进入只读静默**：不要再动手。门禁确认它接手后会自动关掉你这个 pane。",
      { paneId: opened.paneId, successorId, docPath, kind },
    );
  } catch (error) {
    retirement?.rolledBack();
    return fail(`review-gate: 开接任会话时出错 —— ${(error as Error).message}（接力中止，你仍然是持有者）。`);
  }
}

function reply(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details?: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
}

/**
 * WHAT THE SUCCESSOR'S ENVIRONMENT ADDS — mode, orchestration address, gate
 * sidecar variant.
 *
 * PURE, AND IT LIVES HERE ON PURPOSE. The reviewer spent three consecutive
 * rounds on these same three lines in the extension (2026-09-14), one of which
 * reported success without changing the file: logic that keeps being wrong is
 * logic that needs a unit test, and logic inside the extension cannot have
 * one.
 *
 * THE ORCHESTRATION ID IS PASSED IN, never read here. The caller passes the id
 * the session actually HOLDS — `deps.runtime().orchestrationId`, the one rule
 * that answers "mine" only when the stored runtime agrees
 * (lib/orchestrator-wiring.ts, B1). Reading `state.orchestrator.orchestrationId`
 * directly was a second, contradicting copy of that rule: it would hand the
 * successor an address from a runtime this session never adopted.
 *
 * THE STATION CEILING IS PASSED IN FOR THE SAME REASON (2026-09-15). It lives
 * in the pane's environment, and a relay is a new process: a child whose plan
 * narrowed its repo to `commit` would come back with no upper bound and could
 * negotiate a goal at `pr`, opening exactly the second PR the user forbade
 * (lib/repo-pr-policy.ts). A judge or a standalone session passes none and
 * keeps its old behaviour.
 */
export function handoffExtraEnvFor(input: {
  kind: HandoffSessionKind;
  /** This session's mode — a successor keeps it (see the comment below). */
  taskMode?: string;
  /** The orchestration THIS session holds; omitted when it holds none. */
  orchestrationId?: string;
  /** This session's gate sidecar variant, when it has its own. */
  stateVariant?: string;
  /** This session's delivery-station ceiling, when it has one. */
  stationCap?: string;
  /**
   * This session's ACCEPTANCE-GATE value, when it has one (2026-09-22). A
   * RELAY IS A NEW PROCESS: a child whose flag lived only in the predecessor's
   * environment would come back with the variable absent — which reads as ON
   * — and an ordinary work task would suddenly owe a real-acceptance round.
   */
  acceptanceGate?: string;
}): Record<string, string> {
  // THE SUCCESSOR KEEPS THE PREDECESSOR'S MODE (2026-09-14, measured). The
  // first version hardcoded "loop" for everything that was not an orchestrator,
  // so an `explore` session handed its work to a successor that reclassified
  // itself as a delivery session — a mode change nobody asked for, decided by
  // the plumbing. A child is a loop session by construction
  // (lib/session-factory.ts), so the two agree there either way.
  const mode = input.kind === "orchestrator"
    ? "orchestrator"
    : input.taskMode === "explore" || input.taskMode === "normal" ? input.taskMode : "loop";
  const env: Record<string, string> = { [GATE_MODE_ENV]: mode };
  const variant = (input.stateVariant ?? "").trim();
  if (variant) env[STATE_VARIANT_ENV] = variant;
  const orchestration = (input.orchestrationId ?? "").trim();
  if (orchestration) env[ORCHESTRATION_ID_ENV] = orchestration;
  const stationCap = (input.stationCap ?? "").trim();
  if (stationCap) env[STATION_CAP_ENV] = stationCap;
  const acceptanceGate = (input.acceptanceGate ?? "").trim();
  if (acceptanceGate) env[ACCEPTANCE_GATE_ENV] = acceptanceGate;
  return env;
}

/**
 * `context_status()` — THE SESSION'S OWN READING, handed to the session.
 *
 * WHY IT IS A TOOL AND NOT A SENTENCE SOMEWHERE (user requirement, 2026-09-14;
 * philosophy one). The gate measures this number on every round; the session
 * that would act on it could only GUESS, and it guessed wrong the same day — a
 * work round spent budgeting against a context that was 35.8% full. An agent
 * told to "ask the host, through an API it cannot reach" reasons from feel
 * instead, so the reading arrives as a tool with no parameters: one call, two
 * facts (the number, and what the one threshold says to do about it).
 *
 * It is available in EVERY kind of session, judges included — a judge running
 * out of context is exactly the case a handover exists for, and it is the one
 * session that cannot be re-asked later.
 */
export function registerContextStatusTool(host: ToolHost, deps: ContextStatusDeps): void {
  host.registerTool({
    name: "context_status",
    label: "Read My Context Usage",
    description:
      "Report THIS session's own context usage: tokens, the model's window, the " +
      "percentage in use, and whether it has passed the handover threshold (70%). Call it " +
      "whenever you need to know how much room is left — before starting a large read, when a " +
      "task looks long, or when you are unsure whether to hand over. The gate measures this " +
      "number on every round anyway; this tool exists so you never have to estimate it from " +
      "feel. Takes no parameters. A missing reading is reported as missing, never as room to " +
      "spare.",
    parameters: Type.Object({}),
    execute: async () => {
      let usage: unknown;
      try {
        usage = deps.usage();
      } catch {
        usage = undefined;
      }
      const readout = readContext(usage);
      const docPath = deps.docPath?.();
      return reply(
        formatContextStatus(readout, { ...(docPath === undefined ? {} : { docPath }) }),
        {
          ...(readout.tokens === undefined ? {} : { tokens: readout.tokens }),
          ...(readout.contextWindow === undefined ? {} : { contextWindow: readout.contextWindow }),
          ...(readout.percent === undefined ? {} : { percent: Math.round(readout.percent * 10) / 10 }),
          handoffPercent: HANDOFF_PERCENT,
          handoffDue: readout.percent !== undefined && readout.percent >= HANDOFF_PERCENT,
        },
      );
    },
  });
}

/** What `context_status` reads: the host's own measurement, and where to write. */
export interface ContextStatusDeps {
  /** pi's `ctx.getContextUsage()`, called fresh on every invocation. */
  usage(): unknown;
  /** The handoff document path, named only when the threshold is passed. */
  docPath?(): string | undefined;
}

/** One entry point: `session_handoff()`. No parameters — the gate knows the rest. */
export function registerSessionHandoffTool(host: ToolHost, deps: SessionHandoffDeps): void {
  host.registerTool({
    name: "session_handoff",
    label: "Hand Over To A Successor Session",
    description:
      "Hand this session's work over to a fresh session before the context runs out, and let the gate " +
      "do the rest. Call it when the context reminder says so (70% of the window) and after you have " +
      "written your own paragraph into the handoff document the gate prepared for you — the gate " +
      "writes the mechanical half (contract, outstanding work, transcript pointer) into " +
      "`.pi/handoff/<session>.md`; your half is under 「前任补充（意图、坑、下一步）」. " +
      "After the call the gate opens the successor pane, hands it a first message that points at the " +
      "document, and closes THIS session once the successor has demonstrably taken over — you never " +
      "open a pane, never close anything, and never pass a path or an id. If the pane cannot be " +
      "opened the handover is rolled back and this session stays the holder. Takes no parameters.",
    parameters: Type.Object({}),
    execute: async () => runSessionHandoff(deps),
  });
}
