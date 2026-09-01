/**
 * The GOAL tool family: `propose_loop_goal` (L8 — the user approves this
 * session's exit contract) and the internal `record_goal_prereview` (L8b —
 * the goal-auditor's verdict), registered together from ONE entry point.
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8000 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts), then
 * the judge tools (lib/judge-session-tools.ts), the prepare family
 * (lib/review-prepare-tools.ts, lib/advisory-prepare-tools.ts), the L7 Copilot
 * pair (lib/copilot-review-tools.ts) and the user-interaction family
 * (lib/user-interaction-tools.ts). Same shape here:
 * `registerGoalTools(hosts, deps)`, with every effect the tools need arriving
 * through an injected `deps` object.
 *
 * TWO HOSTS, ONE ENTRY (philosophy two + three). The family registers on two
 * different hosts and that is the whole reason `hosts` is an object rather
 * than a single argument: `propose_loop_goal` is the agent's tool and goes to
 * `hosts.agent` (pi's registry), while `record_goal_prereview` is an internal
 * implementation the gate calls itself and goes to `hosts.internal` — the
 * capture-only host, which pi never learns a name from. Naming the two
 * explicitly is what makes "an agent can never sequence the audit by hand"
 * readable at the call site instead of hidden in a wiring convention.
 *
 * THE BOUNDARY: this module owns the APPROVAL — when the audit runs, what the
 * user is shown, who may answer, and the file write that follows a yes. It
 * owns none of the audit's rules: the fence parsing, the adjudication and the
 * record live in lib/goal-prereview-tools.ts, and the goal text's own
 * formatting (transcript message, dialog message, refusal, hash) is
 * lib/loop-goal.ts. What is injected is everything it cannot own — the gate
 * state, its persistence, the dialogs, the orchestration channel funnel, the
 * audit chain and the two filesystem writes — so every branch (no auditor
 * installed, audit blocked, rejected, unwritable file) is testable without a
 * terminal and without a judge process.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Tool names, schemas, reply texts, `details` fields and error branches are
 * the ones the agent-facing contract already documents; changing any of them
 * is a separate, deliberate change.
 */

import { homedir } from "node:os";
import { join as pathJoin } from "node:path";

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import type { ChannelDialogOutcome, ChannelDialogRequest } from "./orchestrator-child-channel.ts";
import {
  GOAL_CONFIRM_TITLE,
  buildGoalConfirmMessage,
  buildGoalPrereviewRefusal,
  buildGoalTranscriptMessage,
  goalPrereviewPassed,
  goalTextHash,
} from "./loop-goal.ts";
import { resolvePackageAgentsDir } from "./model-config.ts";
import { createProgressReporter, type ProgressReporter, type ToolUpdate } from "./progress-stream.ts";
import {
  checkGoalDraft,
  doRecordGoalPrereview,
  type GoalPrereviewDeps,
} from "./goal-prereview-tools.ts";

/** Just enough of pi's tool context for a dialog and a transcript notice. */
export interface GoalUiContext {
  hasUI?: boolean;
  ui?: {
    input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  };
}

/**
 * The two hosts this family registers on.
 *
 * `internal` is the capture-only host: an implementation registered there is
 * reachable by name for the gate's own chains and invisible to the agent.
 */
export interface GoalToolHosts {
  agent: ToolHost;
  internal: ToolHost;
}

/**
 * Everything `propose_loop_goal` needs from the outside world, on top of what
 * the pre-review record needs (lib/goal-prereview-tools.ts).
 *
 * Deliberately narrow and side-effect-explicit: every member is a thing a
 * test replaces with three lines.
 */
export interface GoalToolDeps extends GoalPrereviewDeps {
  /**
   * Run the goal audit end to end (dispatch the `goal-auditor`, wait for its
   * process, record the verdict against the exact text dispatched). A failed
   * audit comes back as text, never as an exception.
   */
  runGoalAudit(input: {
    root: string;
    goalText: string;
    ctx: unknown;
    progress?: ProgressReporter;
  }): Promise<{ ok: true } | { ok: false; text: string }>;
  /** Put text in front of the user, in the transcript, right now. */
  showToUser(uiCtx: unknown, lead: string, body: string): boolean;
  /** `ui.confirm` with the dialog-height budget applied (never bypassed). */
  confirmBounded(
    uiCtx: unknown,
    title: string,
    message: string,
    pointer?: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /**
   * Raise a dialog EITHER the human or the orchestrator may answer; whoever
   * answers first wins, and the other side's box comes off the screen.
   */
  askEitherSide(
    request: Omit<ChannelDialogRequest, "hasUI">,
    hasUI: boolean,
    render: (signal: AbortSignal) => Promise<string | undefined>,
  ): Promise<ChannelDialogOutcome>;
  /** Absolute path of THIS session's loop-goal file in one repo. */
  loopGoalPath(root: string): string;
  /** Its repo-relative path, for the messages that name it. */
  loopGoalRelPath: string;
  /** The project-layer agent file that shadows `name`, if any. */
  findProjectAgent(dir: string, name: string): string | undefined;
  /** Write the approved goal (creating its directory). Throws on failure. */
  writeGoalFile(path: string, text: string): void;
}

// ---------- record_goal_prereview (L8b — the goal-auditor's verdict) ----------

/**
 * INTERNAL, not registered with pi: `propose_loop_goal` runs the audit itself
 * and records the verdict through this implementation.
 */
function registerRecordGoalPrereview(host: ToolHost, deps: GoalToolDeps): void {
  host.registerTool({
    name: "record_goal_prereview",
    label: "Record Goal Pre-review",
    description:
      "ADVANCED / internal: the gate records a goal audit ITSELF when the auditor's process exits, " +
      "against the draft it dispatched — the normal flow is " +
      "`judge_submit({role:\"goal-auditor\", task:<draft>})` → propose_loop_goal. Call this directly " +
      "only when you have an auditor output the gate could not read. " +
      "Records the audit of a DRAFT loop goal; propose_loop_goal " +
      "refuses to show the user's approval dialog until a PASS is recorded for the IDENTICAL text. " +
      "The EXTENSION parses the auditor's JSON fence " +
      "itself (PASS ⇔ a READY verdict with no unresolved P0/P1) and hashes the draft itself — there " +
      "is no `passed` parameter you could set, and a " +
      "hand-written verdict is not a review. A failed audit means: fix the objections and submit the " +
      "revised text (its hash differs, so it needs its own PASS).",
    parameters: Type.Object({
      goal: Type.String({ description: "The FULL draft goal text that was audited (the exact text you will submit)" }),
      auditor_output: Type.String({ description: "Complete raw output from the goal-auditor judge child" }),
      repo: Type.Optional(Type.String({
        description:
          "Absolute path of the repo this goal binds to (default: the session repo) — must match the " +
          "repo you pass to propose_loop_goal.",
      })),
      auditStartedAt: Type.Optional(Type.String({
        description:
          "ISO timestamp of when you DISPATCHED the goal-auditor (the wall-clock start of this audit). " +
          "Goal criterion 6 records first-vs-re-audit durations, and the gate cannot see the dispatch " +
          "— the tool only records verdicts. Omit on re-records of the same audit.",
      })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doRecordGoalPrereview(deps, params, ctx),
  });
}

// ---------- propose_loop_goal (L8 — the user approves the contract) ----------

export async function doProposeLoopGoal(
  deps: GoalToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
  onUpdate: unknown,
): Promise<ToolReply> {
  // Empty draft, the write cap, and the repo the goal binds to — the same
  // three checks the audit record runs, in the same order (lib/goal-prereview-tools.ts).
  const checked = checkGoalDraft({
    tool: "propose_loop_goal",
    rawGoal: params.goal,
    rawRepo: params.repo,
    cwd: deps.cwd(),
    primaryRepoRoot: deps.primaryRepoRoot(),
  });
  if (!checked.ok) {
    return {
      content: [{ type: "text", text: checked.text }],
      details: { approved: false },
      isError: true,
    };
  }
  const { goalText, root: goalRoot } = checked;
  const goalSt = deps.stateFor(goalRoot);

  // L8b GOAL PRE-REVIEW — fail-closed, and BEFORE any user-facing surface.
  // The user is only ever asked about a draft a dedicated auditor already
  // judged, and the gate RUNS that audit itself (philosophy two): the
  // agent submits a draft, not a three-call sequence. Placed ahead of
  // showToUser/confirm so a failed audit costs the user nothing — no
  // transcript spam, no dialog, no file write.
  //
  // A PASS already on record for this exact text skips the audit: the
  // record binds to the sha256 of the draft, so re-auditing identical
  // text would burn minutes to reach the same verdict.
  if (!goalPrereviewPassed(goalSt.goalPrereview, goalText)) {
    // The auditor has to be installed for any of this to work. Checked
    // FIRST, because a missing agent is a setup problem with a concrete
    // fix, not an audit that failed. Dispatchability is what matters, not
    // a filename: pi-subagents keys agents by their frontmatter `name`,
    // so a copy called custom.md that declares `name: goal-auditor` IS
    // dispatchable and must not be reported as missing. EVERY layer is
    // resolved that way — the same rule gate-doctor applies — so the two
    // never disagree.
    const packageAgentsDir = resolvePackageAgentsDir();
    const auditorInstalled =
      deps.findProjectAgent(pathJoin(homedir(), ".pi", "agent", "agents"), "goal-auditor") !== undefined ||
      // Both project layers are consulted: pi-subagents loads them from the
      // SESSION's project root, while a multi-repo goal binds to goalRoot —
      // checking only one of them would look in the wrong directory.
      [pathJoin(goalRoot, ".pi", "agents"), pathJoin(deps.primaryRepoRoot(), ".pi", "agents")]
        .some((dir) => deps.findProjectAgent(dir, "goal-auditor") !== undefined);
    if (!auditorInstalled) {
      return {
        content: [{
          type: "text",
          text: buildGoalPrereviewRefusal({
            ...(goalSt.goalPrereview ? { record: goalSt.goalPrereview } : {}),
            goalText,
            auditorInstalled,
            repoRoot: goalRoot,
            packageAgentsDir,
          }),
        }],
        details: { approved: false, prereview: goalSt.goalPrereview?.verdict ?? "NONE" },
        isError: true,
      };
    }
    const audit = await deps.runGoalAudit({
      root: goalRoot,
      goalText,
      ctx,
      progress: createProgressReporter({
        title: "review-gate: propose_loop_goal（goal 审计）",
        onUpdate: onUpdate as ToolUpdate | undefined,
      }),
    });
    if (!audit.ok) {
      return {
        content: [{ type: "text", text: audit.text }],
        details: { approved: false, prereview: "BLOCKED" },
        isError: true,
      };
    }
  }

  // The goal text goes to the TRANSCRIPT; the binding repo must be shown
  // at CONSENT time (both surfaces), so a repo-scoped approval is never
  // given for a repo the user was not shown.
  const repoLine = goalRoot === deps.primaryRepoRoot()
    ? "本仓库 (" + deps.primaryRepoRoot() + ")"
    : goalRoot;

  // Consent comes from a dialog the EXTENSION renders — there is no
  // parameter the model could set to claim it. No UI ⇒ no approval; a
  // session without a UI is forced to normal mode at session_start, so
  // reaching this branch means the UI disappeared, not a headless run.
  const uiCtx = ctx as GoalUiContext;
  // The goal itself is shown in the TRANSCRIPT first: it is the thing the
  // user has to read, and it is far too tall for a dialog (that is what
  // made the terminal flicker). ui.notify renders synchronously, so it is
  // on screen BEFORE the dialog below asks about it; the dialog that
  // follows carries only the decision.
  // The pre-review fact is shown to the USER too: the approval is more
  // informed when it is visible that an independent auditor already passed
  // THIS text. It goes AFTER the repo line on purpose — the dialog budget
  // truncates from the tail, and the repo binding is the consent-critical
  // fact that must never be the thing that gets cut.
  // The record is guaranteed to exist here: goalPrereviewPassed() above
  // already required a PASS bound to this text, so this reads it directly
  // rather than advertising a fallback state that cannot occur.
  const prereviewLine = "goal-auditor 预审: PASS @ " + goalSt.goalPrereview!.at;
  // The goal approval is one of the two dialogs an ORCHESTRATOR may
  // answer on the user's behalf, so it goes through the channel funnel
  // below (`askEitherSide` with topic `goal-approval`) rather than
  // straight to `ui.confirm`: the request it writes carries the whole
  // draft, which is the text constraint 8 is judged on.

  deps.showToUser(
    uiCtx,
    GOAL_CONFIRM_TITLE,
    buildGoalTranscriptMessage(goalText) + "\n\n本次目标绑定的仓库: " + repoLine + "\n" + prereviewLine,
  );
  // EITHER the user or (when this session is an orchestration child) the
  // project manager may answer. The channel request carries the FULL draft
  // as its payload, so the orchestrator sees the exact text it is being
  // asked to approve and constraint 8 is checked against that same text —
  // never against something the orchestrator retyped (R-7).
  const goalDialogTitle = GOAL_CONFIRM_TITLE;
  const goalApproveLabel = "认可，写入 .pi/loop-goal.md";
  const goalRejectLabel = "不认可，退回重谈";
  let approved = false;
  /** The orchestrator's decline reason, when the PM answered with one. */
  let channelReason: string | undefined;
  try {
    const outcome = await deps.askEitherSide(
      {
        dialogKind: "confirm",
        topic: "goal-approval",
        title: goalDialogTitle,
        options: [goalApproveLabel, goalRejectLabel],
        payload: goalText,
      },
      uiCtx.hasUI === true,
      async (signal) => {
        const ok = await deps.confirmBounded(
          uiCtx,
          goalDialogTitle,
          buildGoalConfirmMessage(goalText, "绑定仓库(不可信数据): " + repoLine + "\n" + prereviewLine),
          "（目标全文见上方消息）",
          signal,
        );
        return ok ? goalApproveLabel : goalRejectLabel;
      },
    );
    approved = outcome.answer === goalApproveLabel;
    // The ORCHESTRATOR's decline reason (if it answered with one) becomes
    // the rejection reason — the child renegotiates against it instead of
    // waiting on the (PM-invisible) local input box.
    channelReason = outcome.reason;
  } catch {
    approved = false;
  }

  // The decision may carry a REASON — but only on REJECTION: the user
  // rejects with the objection so the agent renegotiates against the real
  // problem instead of re-asking. The CONFIRM path no longer asks for a
  // reason (the approval is the whole signal; a per-approval input box was
  // friction with nothing to act on). Reason input is best-effort — a
  // headless/no-input environment simply yields no reason.
  let reason: string | undefined;
  if (!approved) {
    // The PM's decline reason (via channel) wins — the child renegotiates
    // against the REAL objection. The local input box is only the fallback
    // when nobody answered through the channel.
    if (channelReason) {
      reason = channelReason;
    } else {
      try {
        const typed = await uiCtx.ui?.input?.(
          "拒绝原因(将转达给 AI 供重新协商;留空则退回通用提示)",
          "必填:哪里不合适",
        );
        reason = (typed ?? "").trim() || undefined;
      } catch {
        reason = undefined;
      }
    }
  }
  if (!approved) {
    return {
      content: [{
        type: "text",
        text: "review-gate: the user did NOT approve this goal." +
          (reason
            ? ` Reason: ${reason}. Renegotiate against THAT objection and submit the corrected goal again — `
            : " Ask what is wrong with it, renegotiate, and submit the corrected goal again — ") +
          "do not start shipping work in the meantime.",
      }],
      details: { approved: false, reason: reason ?? null },
    };
  }

  // The EXTENSION writes the file: an approval must describe the text the
  // user saw, not text the agent might swap in afterwards. The path lives
  // in the gate-owned .pi/ scope, so this write never moves the worktree
  // fingerprint and cannot invalidate a READY review or a precommit PASS.
  const goalPath = deps.loopGoalPath(goalRoot);

  try {
    deps.writeGoalFile(goalPath, goalText + "\n");
  } catch (e) {
    return {
      content: [{
        type: "text",
        text: `review-gate: could not write ${deps.loopGoalRelPath} (${e instanceof Error ? e.message : String(e)}). ` +

          "The approval was NOT recorded.",
      }],
      details: { approved: false },
      isError: true,
    };
  }
  goalSt.loopGoal = { hash: goalTextHash(goalText), at: new Date().toISOString(), ...(reason ? { reason } : {}) };
  // This goal's negotiation is over, so its audit count ends with it: the
  // NEXT goal's first audit must announce round 1, not round N+1.
  delete goalSt.goalAuditRound;
  deps.persist(ctx, goalRoot);
  deps.log(`loop goal approved by the user for ${goalRoot} (${goalText.length} chars${reason ? `, reason: ${reason}` : ""})`);
  return {
    content: [{
      type: "text",
      text: `review-gate: goal approved and written to ${deps.loopGoalRelPath} (repo: ${goalRoot}). Work to it; if it has to ` +

        "change, renegotiate with the user and call propose_loop_goal again (editing the file " +
        "yourself drops the approval and blocks shipping)." +
        (reason ? `\nUser's note on approval: ${reason}` : ""),
    }],
    details: { approved: true, reason: reason ?? null },
  };
}

/**
 * The family's SINGLE registration entry point: both goal tools, each on the
 * host that may see it.
 */
export function registerGoalTools(hosts: GoalToolHosts, deps: GoalToolDeps): void {
  registerRecordGoalPrereview(hosts.internal, deps);

  hosts.agent.registerTool({
    name: "propose_loop_goal",
    label: "Propose Loop Goal",
    description:
      "Submit the NEGOTIATED loop goal (this session's exit contract) for the user's approval. " +
      "Interview the user first — ONE question per turn, labeled \"N of M\", each with your " +
      "recommended answer (all at once only when the user asks for it) — and only " +
      "submit what they actually agreed to. Write the goal in SIMPLIFIED CHINESE (technical " +
      "identifiers, paths and code tokens stay English). REQUIRED FIRST: the draft must pass a " +
      "dedicated `goal-auditor` audit — and THIS TOOL RUNS IT ITSELF: it dispatches the auditor, " +
      "waits for it, adjudicates (only P0/P1 block) and records the verdict. A failed audit comes " +
      "back with the objections and NO dialog is shown; fix them and call this again. That makes " +
      "it a MINUTES-LONG call. " +
      "Once it passes, the extension shows the text in a confirmation " +
      "dialog and, if the user approves, writes .pi/loop-goal.md itself and records the approval. " +
      "Writing that file yourself grants nothing: in loop mode an unapproved goal blocks " +
      "commit/push/PR and its body is withheld from your prompt. Shape: task title, one-line " +
      "intent, 3–7 checkable exit criteria, non-goals, ISO date. `repo` selects WHICH repo the " +
      "goal binds to (default: this session's repo) — a multi-repo session approves a goal per " +
      "repo before editing there; one repo's approval never opens another's write surface.",
    parameters: Type.Object({
      goal: Type.String({ description: "The full goal text (Markdown) as agreed with the user" }),
      repo: Type.Optional(Type.String({
        description:
          "Absolute path of the repo this goal binds to (default: the session repo). Required to " +
          "unlock edit/write in a SECOND repo the session works in.",
      })),
    }),
    execute: (_id, params, _signal, onUpdate, ctx) => doProposeLoopGoal(deps, params, ctx, onUpdate),
  });
}
