/**
 * The two tools that act on an EXISTING pane judge — `judge_close` and
 * `judge_wait`.
 *
 * A judge is an interactive pi in its own pane (one pane per review),
 * owned by the opener recorded in lib/hierarchy.ts. There is no process to
 * watch and no stdout log to tail: the round ends when a `report` record
 * lands in the judge's channel, the pane dies, or the heartbeat goes stale.
 * The transcript stays the long memory; the channel is the signal — and the
 * wait is MESSAGE-driven over that channel plus the round's findings stream,
 * so it returns on the first thing that happened rather than at the end.
 *
 * EVERY tool below passes `checkCaller` before doing anything else: a judge
 * belongs to its opener, and any other session's operation on it is a
 * cross-level call refused fail-closed, with no dialog.
 *
 * THE GATE'S OWN CHAINS BYPASS THE REPO CHECK, NOTHING ELSE (2026-09-08).
 * `doWait` / `doClose` are exported so the gate's self-dispatched audits
 * (`propose_loop_goal` / `orchestrator_plan` chains in extensions/review-gate.ts)
 * can wait on and reclaim their own auditor without passing `addressJudge`'s
 * "has this session edited that repo" gate — the chain already holds the
 * judgeId from its own dispatch, and re-resolving the repo would refuse a
 * legitimate self-audit of a repo the session has not edited yet (measured:
 * five consecutive "等待未命中本轮 report"). The bypass is keyed on an explicit
 * `gateSelf` FUNCTION ARGUMENT on `doWait` / `doClose` (not a field of `params`
 * — tools receive `params` from the agent verbatim, so a marker living there
 * would be agent-settable); the opener check (`checkOpener`) still runs inside
 * both functions for both paths. Agent-facing `judge_wait` / `judge_close`
 * always take the full check.

 *
 * Shape (unchanged): `registerJudgeSessionTools(host, deps)`, effects
 * through `deps` only. Pure decisions live in lib/hierarchy.ts,
 * lib/orchestrator-channel.ts and lib/judge-pane.ts and are imported
 * directly; what IS injected is everything the tools cannot own — identity,
 * the registries, tmux, the channel filesystem and the verdict recorder.
 *
 * WHERE THE PARTS LIVE. This file keeps the deps, the parameter schemas,
 * `judge_close` and the registration. `judge_wait`'s loop is
 * lib/judge-wait-tool.ts, the criteria it polls lib/judge-wait-criteria.ts,
 * and the addressing + opener check both tools pass
 * lib/judge-session-addressing.ts.
 */
import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import {
  removeJudge,
  windowClosable,
  type HierarchyTable,
} from "./hierarchy.ts";
import type { ChannelIO, ReviewScopeStamp } from "./orchestrator-channel.ts";
import type { JudgePaneRunResult } from "./judge-pane.ts";
import { closeSessionWindow } from "./session-factory.ts";
import { JUDGE_WAIT_MAX_TIMEOUT_MS } from "./judge-lifecycle.ts";
import type { RoundBinding } from "./audit-round-report.ts";
import {
  ADDRESSABLE_JUDGE_ROLES,
  addressJudge,
  checkOpener,
  closeFailDetails,
} from "./judge-session-addressing.ts";
import { doWait } from "./judge-wait-tool.ts";


/**
 * The parts of a pane judge these tools address.
 *
 * A structural subset of the extension's own record on purpose: this module
 * must not become the second place that decides what a judge IS.
 */
export interface JudgeChildRecord {
  /** Judge id — also the pane's resume key and the channel file name. */
  judgeId: string;
  role: string;
  /** Repo root the review belongs to. */
  repoRoot: string;
  /** Who opened it — the only session that may operate it. */
  openerId: string;
  /** tmux pane id, once the pane exists. */
  paneId?: string;
  /**
   * The WINDOW the judge runs in, and the session that owns it (2026-09-25).
   *
   * Same pair, same reason as lib/hierarchy.ts `JudgeEntry`: a judge is a window
   * of its opener's own session, `judge_close` addresses it
   * `<tmuxSession>:<windowId>`, and an entry missing either half is never
   * closed by a guess.
   */
  windowId?: string;
  tmuxSession?: string;
  /**
   * Which tmux server minted `paneId` — carried so `judge_close` can tell
   * whether it may kill by it.
   *
   * It matters HERE because the registry is persisted: a record restored after
   * a tmux server restart carries an id that has since been reassigned, and
   * closing by it would kill whatever now holds that number.
   */
  tmuxServer?: string;
  /** Directory pi writes its transcript jsonl into (stable per role). */
  sessionDir: string;
  /** This round's findings stream, when the role has one. */
  streamPath?: string;
  /** The model this judge was launched on (lib/model-health.ts picked the slot). */
  modelSpec?: string;
}

/** Repo resolution, as `resolveToolRepoTarget` already reports it. */
export type JudgeRepoTarget = { ok: true; root: string } | { ok: false; error: string };

/**
 * Everything these tools need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every method is a thing a
 * test replaces with three lines.
 */
export interface JudgeSessionToolDeps {
  /** Which repo does this call target? Never guessed — see repo-resolve.ts. */
  resolveRepo(requested: string | undefined): JudgeRepoTarget;
  /** Who is calling — the opener check runs on this, never on a parameter. */
  callerId(): string | undefined;
  /**
   * EVERY identity whose judges this session may act on, when that is more
   * than one.
   *
   * A HANDOVER'S SUCCESSOR owns two (2026-09-14, measured on the loop path):
   * its own identity, and the session it replaced. A judge's channel is keyed
   * by `<openerId>/<judgeId>`, so without this a successor would be refused on
   * `judge_wait`/`judge_close` for the very reviewer its predecessor had
   * dispatched — the round's verdict would land in a channel nobody reads and
   * the successor would wait forever. Omitted ⇒ just `callerId()`, which is
   * every ordinary session.
   */
  callerIds?(): string[];
  /** Opener registry (extension-owned) and its persistence. */
  hierarchy(): HierarchyTable;
  saveHierarchy(next: HierarchyTable): void;
  /**
   * When this judge's transcript was last written, in ms — the ONE reading
   * that moves only when the agent actually works (`roundLooksUnstarted`,
   * goal 6(d), 2026-09-21). Undefined when unreadable ⇒ fail-open: a missing
   * reading is information missing, never evidence of silence.
   */
  transcriptActivityAt?(child: JudgeChildRecord): number | undefined;
  /**
   * When THIS round was dispatched, in ms — the FLOOR under the transcript
   * reading (goal 6(d), reviewer P1, 2026-09-21).
   *
   * Without it a judge whose transcript was last written before this round
   * (which is every fresh dispatch on a reused lane) looks silent from the
   * start of time and gets reported as "never started" the instant it is
   * asked. The reading is the newest `instruct` on the judge's channel — the
   * record that actually carried this round. Undefined ⇒ fail-open.
   */
  roundDispatchedAt?(child: JudgeChildRecord): number | undefined;
  /** Locate a pane judge by ROLE (preferred) or by judge id. */
  findChild(root: string, role: string | undefined, judgeId: string | undefined): JudgeChildRecord | undefined;
  /**
   * Locate a pane judge by ID ALONE, across all repos (2026-09-08).
   *
   * Reached only through the `gateSelf` function argument (see `addressJudge`):
   * the gate's self-audit chains hold the judgeId from their own dispatch and
   * must not re-resolve the repo. The opener check still runs in `doWait` /
   * `doClose` for both paths.
   */
  findChildById?(judgeId: string): JudgeChildRecord | undefined;
  /** Channel filesystem seam and its home override. */
  channelIO(): ChannelIO;
  channelHome(): string | undefined;
  /** One tmux invocation (argv, never a shell string). */
  tmux(argv: readonly string[]): JudgePaneRunResult;
  /**
   * WHO THIS SESSION IS on a border — the `@<owner>` half of every judge pane
   * it opens (lib/orchestrator-pane-decor.ts `selfPaneOwner`). Derived from the
   * session's own environment, never a parameter: a caller that could pass it
   * could pass the wrong one and nothing downstream could tell.
   */
  paneOwner(): string;
  /** The tmux server this process talks to (lib/hierarchy.ts `tmuxServerFrom`). */
  tmuxServer(): string | undefined;
  /** Injectable clock. */
  now(): number;
  /** Whole file, or undefined when it is absent/unreadable. */
  readText(path: string): string | undefined;
  /**
   * Question ids the opener has already been shown, and the way to add to
   * them. Owned by the SESSION, not by this module: the settle path announces
   * questions too, and one question announced twice is the same wasted
   * iteration as a question never announced.
   */
  announcedQuestions(): ReadonlySet<string>;
  markQuestionsAnnounced(requestIds: readonly string[]): void;

  /**
   * THIS round's report binding — the role's kind, the round this dispatch
   * registered, and the content the round judges — built by the engine's own
   * derivation (`roundBindingFor`, lib/audit-round.ts).
   *
   * The wait has to answer "did this round end?" with the SAME rule the
   * recorder uses for "may this report be recorded?". While they differed, the
   * wait announced a READY that the recorder refused, and the agent acted on
   * the announcement (2026-09-05).
   */
  roundBinding(child: Pick<JudgeChildRecord, "judgeId" | "role" | "repoRoot">): RoundBinding;

  /**
   * CLOSE THIS ROUND through the audit-round engine (lib/audit-round.ts).
   *
   * The wait does not pick the report, adjudicate it or move the cursor: the
   * engine does all three, for every kind, in one place. That is what makes
   * "one report is recorded once" structural — this path and the settle sweep
   * share the engine's single cursor write instead of each keeping their own.
   */
  settleRound(judgeId: string, root: string): Promise<{
    text?: string;
    /** The adviser's prose, when this round was one (never recorded). */
    advice?: string;
    /** The report's raw verdict, for the standard report's display. */
    verdict?: string;
    /** The round ran under a weaker binding — surfaced, never buried. */
    bindingNote?: string;
    /**
     * What the gate did because the round ended (the round's siblings, by the
     * cancel matrix: a killed judge, a stopped precommit lane, a parked READY
     * replayed or retired).
     *
     * Its own field, and its own line in the report: the recorded note is
     * shown first-line-only, so a sentence appended to its tail is invisible
     * (reviewer P1, 2026-09-15).
     */
    handOffNote?: string;
    /**
     * The scope the round stamped on its own report (range + full/incremental).
     *
     * Carried here for the same reason `bindingNote` is: BOTH wake-up paths
     * speak through one builder, and a fact only the settle sweep passed would
     * be invisible to every opener that reached the same round by blocking on
     * `judge_wait` — the more common path of the two.
     */
    scope?: ReviewScopeStamp;
    hasVerdict: boolean;
  }>;
  /** Cancel the gate-owned hosted-wait watchdog. */
  cancelWaitTimer(): void;
  /** Forget the goal draft a closed audit was judging. */
  dropPendingAudit(root: string): void;
  /**
   * ACT ON the model failures this judge reported (2026-09-10).
   *
   * The pane is the only witness of its own provider errors and the opener is
   * the only side allowed to write repo state, so the two are different
   * processes: this hook is where the opener turns the channel's `modelEvent`
   * records into a cooldown, a warning and whatever else it owes the user.
   *
   * It MUST run before the wait advances its `lastModelEventCount` cursor —
   * a cursor that moves past an unread event drops it forever (the pane will
   * not report it again), which is exactly what makes the cooldown silent.
   * Optional so a test fixture can drive the wait without a gate state.
   */
  absorbModelEvents?(root: string, judgeId: string): void;
}

// ---------- shared parameter schemas ----------
// One definition per parameter, shared by the tools: a role enum that
// drifts between two of them is exactly the kind of silent inconsistency this
// move is supposed to make impossible.
// `quality-auditor` IS addressable here on purpose: the agent never ASKS for
// that round (judge_submit's role enum deliberately omits it — the chain
// dispatches it), but the round can ask the agent a question, and waiting on
// or answering a judge you cannot name would be a dead end.
//
// EXPORTED (2026-09-17) so `lib/judge-spawn-tools.ts` — the other module that
// registers role-addressed tools (`judge_answer` / `judge_recover`) — imports
// this one instead of keeping a second copy. It kept one, the copy omitted
// `quality-auditor`, and the consequence was measured: the gate's own report
// said "use judge_answer" while that tool's schema refused the role of the
// very judge that had asked.
// `judge_spawn` deliberately does NOT use it: it only opens goal/plan reviews.
//
// `acceptance` is a gate-dispatched round like `quality-auditor`: the agent
// never ASKS for it, but the round can ask a question, and a judge that asked
// a question must be answerable / recoverable / waitable.
//
// The role list itself (`ADDRESSABLE_JUDGE_ROLES`) lives beside the "needs a
// role" refusal that names the same roles (lib/judge-session-addressing.ts).
export const ROLE_PARAM = Type.Optional(Type.Enum(ADDRESSABLE_JUDGE_ROLES));
const SESSION_ID_PARAM = Type.Optional(Type.String({ description: "Judge id (its session id); prefer role" }));
const REPO_PARAM = Type.Optional(Type.String({
  description: "Absolute repo path (required once the session edited several repos)",
}));

// ---------- reply builders ----------

function reply(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

function fail(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details, isError: true };
}


// (`judge_read` is GONE, implementation and all — 2026-09-05, user decision
// D4. It was a zero-caller path: never on the agent surface and never called
// by any of the gate's own chains, so what it actually did was give the
// injected texts a tool name to point at that nobody could reach. What it read
// — state, open questions, the conclusion — is what `judge_wait` now returns
// on its own, message-driven, from the same channel.)


// ---------- judge_close ----------

export async function doClose(
  deps: JudgeSessionToolDeps,
  params: Record<string, unknown>,
  /**
   * GATE-SELF BYPASS (2026-09-08): true only on the gate's own direct calls.
   * A plain function argument — NOT a field of `params`, so no agent tool call
   * can ever set it (`params` arrives from the agent verbatim; unknown keys
   * are stripped nowhere). `addressJudge` skips the edited-repo check only
   * under it; the opener check still runs for both paths.
   */
  gateSelf = false,
): Promise<ToolReply> {
  const addressed = addressJudge(deps, params, "judge_close", gateSelf);
  if (!addressed.ok) return fail(addressed.text, closeFailDetails());
  const child = deps.findChild(addressed.root, addressed.role, addressed.judgeId);
  if (!child) {
    // Idempotent: nothing to close is a SUCCESS, so a task-completion sweep
    // never has to know whether a round is still on record.
    return reply(
      `review-gate: no judge on record for ${addressed.role ?? addressed.judgeId} — nothing to close.`,
      { closed: true, terminated: false, judgeId: undefined },
    );
  }
  const judgeId = child.judgeId;
  const allowed = checkOpener(deps, judgeId);
  if (!allowed.ok) return fail(allowed.text, closeFailDetails());
  // Cancel the hosted wait so no wake fires for a close we initiated.
  deps.cancelWaitTimer();
  let terminated = false;
  let killNote = "没有登记 window，无需动手";
  // `windowClosable`, not merely "there is a window id": the registry is
  // persisted, so a record restored after a tmux server restart carries ids
  // that server has since handed to somebody else. The target is built as
  // `<session>:<@window>` from the SAME record, so a wrong id can only reach a
  // window of the gate's own session — and an entry missing either half is
  // left alone entirely (reviewer P1, 2026-09-05).
  if (!windowClosable(child, deps.tmuxServer())) {
    if (child.windowId) {
      killNote = `window ${child.windowId} 不能按记录关（是另一个 tmux server 铸造的 id，或记录里缺 session/window 坐标），只清登记`;
    }
  } else {
    // THE LABEL BAR IS NOT TOUCHED HERE (2026-09-17, user decision). It used
    // to be taken down when the caller judged this the last decorated pane,
    // and that judgement was wrong across sessions besides resizing every pane
    // in the window on both edges. Under the window topology the bar belongs to
    // the CHILD's window and disappears with it.
    const killed = closeSessionWindow(deps.tmux, { ownSession: child.tmuxSession, windowId: child.windowId });
    terminated = killed.ok;
    killNote = killed.ok ? `window ${child.windowId} 已关` : `关 window 失败（${killed.error}），登记照样清除`;
  }
  deps.saveHierarchy(removeJudge(deps.hierarchy(), judgeId));
  // A closed audit takes its draft with it — same reason as fresh:true.
  if (child.role === "goal-auditor") deps.dropPendingAudit(addressed.root);
  return reply(
    `review-gate: ${child.role}（${judgeId}）已关闭：${killNote}；transcript 保留，同 id 重开即续接。`,
    { closed: true, terminated, judgeId },
  );
}


// ---------- registration ----------

/**
 * Register the judge-session tools on ONE host.
 *
 * `judge_close` is gate-internal (its only callers are the gate's own audit
 * chains, which close the auditor they opened); `judge_wait` goes on BOTH
 * hosts — the same implementation, registered twice, never a second copy of
 * the waiting logic (2026-09-05, user decision D1).
 */
export function registerJudgeSessionTools(host: ToolHost, deps: JudgeSessionToolDeps): void {
  host.registerTool({
    name: "judge_close",
    label: "Close Own Judge",
    description:
      "Close YOUR OWN judge pane (its transcript stays on disk, so the same id re-opens the same conversation) " +
      "and drop it from the registry. Use it at task completion (declare_done cascade-closes the rest) or to stop " +
      "a round that has gone off the rails. Idempotent. Only the opener may close; anyone else is refused.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      sessionId: SESSION_ID_PARAM,
      repo: REPO_PARAM,
    }),
    execute: (_id, params) => doClose(deps, params),
  });

  registerJudgeWaitTool(host, deps);
}

/**
 * `judge_wait` on its own — the ONE waiting tool, and the reason it is a
 * separate export.
 *
 * The agent surface needs exactly this tool and nothing else of the family:
 * a session that has genuinely run out of deterministic work must be able to
 * wait for its judge's next message, and the alternative it was left with
 * (a hand-written `sleep` loop inside one bash call) locked a measured nine
 * minutes out of a session — the turn never ended, so nothing ever settled,
 * so a report that had already landed stayed unrecorded. Registering the SAME
 * implementation on the internal host and on the agent host keeps one set of
 * criteria (哲学三: never two implementations).
 */
export function registerJudgeWaitTool(host: ToolHost, deps: JudgeSessionToolDeps): void {
  host.registerTool({
    name: "judge_wait",
    label: "Wait For Judge",
    description:
      "Wait for YOUR OWN judge's next MESSAGE and return it. It is message-driven, not a poll-until-finished: " +
      "a newly streamed finding, a question the judge asked, the round's channel report (the gate records it) or " +
      "a dead pane each return immediately, with the content itself — you never read a stream or transcript file. " +
      "Call it when you have genuinely run out of deterministic work; do the work first when you have some. " +
      "On timeout it returns the current state instead of failing, so the decision stays yours. " +
      "Only the opener may wait; anyone else is refused.",
    parameters: Type.Object({
      role: ROLE_PARAM,
      sessionId: SESSION_ID_PARAM,
      repo: REPO_PARAM,
      timeoutMs: Type.Optional(Type.Integer({
        description: `Blocking window in ms (default 300000, hard cap ${JUDGE_WAIT_MAX_TIMEOUT_MS})`,
      })),
    }),
    execute: (_id, params, signal, onUpdate) => doWait(deps, params, signal, onUpdate),
  });
}
