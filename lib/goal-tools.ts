/**
 * The GOAL tool family: `propose_loop_goal` (L8 — the user approves this
 * session's exit contract), and the L8b audit recorder it runs internally.
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8000 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts), then
 * the judge tools (lib/judge-session-tools.ts), the prepare family
 * (lib/review-prepare-tools.ts, lib/advisory-prepare-tools.ts), the L7 Copilot
 * pair (lib/copilot-review-tools.ts) and the user-interaction family
 * (lib/user-interaction-tools.ts). Same shape here:
 * `registerGoalTools(host, deps)`, with every effect the tools need arriving
 * through an injected `deps` object.
 *
 * ONE HOST, ONE ENTRY (philosophy two + three). The family registers exactly
 * one tool, on pi's registry: `propose_loop_goal`. Its audit recorder is a
 * plain function the gate calls itself (`recordGoalPrereview`), not a second
 * registration — so "an agent can never sequence the audit by hand" is a fact
 * about the tool surface rather than a convention about which host something
 * was registered on.
 *
 * THE BOUNDARY: this module owns the APPROVAL — when the audit runs, what the
 * user is shown, who may answer, and the file write that follows a yes. It
 * owns none of the audit's rules: the adjudication and the
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
import { REVISE_ROW, choiceRows, parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
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
  type GoalPrereviewDeps,
} from "./goal-prereview-tools.ts";
import {
  buildRestatementMissingRefusal,
  restatementConfirmed,
  restatementRequiredInMode,
} from "./restatement.ts";
import {
  DELIVERY_STATION_CHOICES,
  deliveryStationLine,
  isDeliveryStation,
  parseDeliveryStation,
  type DeliveryStation,
} from "./delivery-station.ts";

/** Just enough of pi's tool context for a dialog and a transcript notice. */
export interface GoalUiContext {
  hasUI?: boolean;
  ui?: {
    input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
  };
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
    signal?: AbortSignal | undefined;
  }): Promise<{ ok: true } | { ok: false; text: string }>;
  /** Put text in front of the user, in the transcript, right now. */
  showToUser(uiCtx: unknown, lead: string, body: string): boolean;
  /** Render the gate's one question template (lib/choice-dialog.ts), budget applied. */
  askChoice(
    uiCtx: unknown,
    spec: ChoiceSpec,
    opts?: { body?: string; pointer?: string; signal?: AbortSignal },
  ): Promise<string | undefined>;
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

// ---------- the goal audit recorder (L8b — NOT a tool) ----------
//
// `recordGoalPrereview` (lib/goal-prereview-tools.ts) is a plain function the
// gate calls when the goal-auditor's round lands. It used to be registered
// here as an `internalTool` named `record_goal_prereview` taking the auditor's
// raw output as text — a shape that existed only because the verdict had to be
// parsed back out of a synthesised fence. Nothing parses now, so the tool
// wrapper is gone (2026-09-04, philosophy two and three).


// ---------- propose_loop_goal (L8 — the user approves the contract) ----------

export async function doProposeLoopGoal(
  deps: GoalToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
  onUpdate: unknown,
  signal?: AbortSignal | undefined,
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

  // L8a REQUIREMENT RESTATEMENT — fail-closed, and ahead of the audit
  // (2026-09-06, user ask). The step it enforces is "say the requirement back
  // and have the user confirm it BEFORE any contract is drafted", so checking
  // it after a minutes-long audit would enforce the wrong order and bill the
  // user for it. Like the audit below, the refusal renders NO dialog: a
  // session that skipped the step costs one refusal text.
  //
  // Scope, not an escape hatch: explore/normal sessions have no contract to
  // protect (lib/restatement.ts's restatementRequiredInMode). The mode is
  // read from the SESSION's own repo state — a goal may bind to a second
  // repo, but the gate mode is a property of the session, not of the repo it
  // is writing into.
  const sessionMode = deps.stateFor(deps.primaryRepoRoot()).taskMode;
  if (restatementRequiredInMode(sessionMode) && !restatementConfirmed(goalSt.restatement)) {
    return {
      content: [{ type: "text", text: buildRestatementMissingRefusal("propose_loop_goal") }],
      details: { approved: false, restated: false },
      isError: true,
    };
  }

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
      signal,
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
  // WHERE THIS ROUND STOPS (2026-09-06). Three sources, most specific first:
  // an explicit `station` parameter, then the station the user already agreed
  // to when they confirmed the restatement, then the strictest value. The
  // user is SHOWN it in both surfaces — a station nobody read is a contract
  // term nobody agreed to — and it is recorded beside the approval.
  const station: DeliveryStation = isDeliveryStation(String(params.station ?? "").trim().toLowerCase())
    ? parseDeliveryStation(params.station)
    : (goalSt.restatement?.station ?? parseDeliveryStation(undefined));
  // TWO RENDERINGS OF ONE DEFINITION: the dialog and the transcript block are
  // read by the USER ("由你自己 commit"), the tool reply by the AGENT, which
  // must not read itself as the committer (round-2 P2).
  const stationLine = deliveryStationLine(station);
  const stationLineForUser = deliveryStationLine(station, "user");
  // The goal approval is one of the two dialogs an ORCHESTRATOR may
  // answer on the user's behalf, so it goes through the channel funnel
  // below (`askEitherSide` with topic `goal-approval`) rather than
  // straight to the pane dialog: the request it writes carries the whole
  // draft, which is the text constraint 8 is judged on.

  deps.showToUser(
    uiCtx,
    GOAL_CONFIRM_TITLE,
    buildGoalTranscriptMessage(goalText) + "\n\n本次目标绑定的仓库: " + repoLine + "\n" +
      stationLineForUser + "\n" + prereviewLine,
  );
  // EITHER the user or (when this session is an orchestration child) the
  // project manager may answer. The channel request carries the FULL draft
  // as its payload, so the orchestrator sees the exact text it is being
  // asked to approve and constraint 8 is checked against that same text —
  // never against something the orchestrator retyped (R-7).
  const goalDialogTitle = GOAL_CONFIRM_TITLE;
  const goalApproveLabel = "认可，写入 .pi/loop-goal.md";
  const goalRejectLabel = "不认可，退回重谈";
  // The gate's ONE dialog template (2026-09-08). The decline row replaces the
  // separate "拒绝原因" box this tool used to raise afterwards: the reason now
  // arrives with the rejection, from the human or the orchestrator, in one
  // round trip.
  const spec: ChoiceSpec = {
    title: goalDialogTitle,
    options: [goalApproveLabel, goalRejectLabel],
    recommended: goalApproveLabel,
    declineRow: REVISE_ROW,
  };
  let approved = false;
  /** The decline reason, whichever side typed it (human box or channel). */
  let declineReason: string | undefined;
  /** True when an instruct interrupt dismissed the approval box: not a rejection. */
  let approvalInterrupted = false;
  try {
    const outcome = await deps.askEitherSide(
      {
        dialogKind: "select",
        topic: "goal-approval",
        title: goalDialogTitle,
        options: choiceRows(spec),
        payload: goalText,
        // The station travels as a STRUCTURED field beside the draft, for the
        // same reason the restatement's does: a project manager approving on
        // the user's behalf may not confirm one looser than the plan the user
        // approved, and that comparison is made on a field, never on prose
        // (lib/orchestrator-answer-tools.ts).
        station,

      },
      uiCtx.hasUI === true,
      async (signal) => deps.askChoice(uiCtx, spec, {
        body: buildGoalConfirmMessage(
          goalText,
          "绑定仓库(不可信数据): " + repoLine + "\n" + stationLineForUser + "\n" + prereviewLine,
        ),
        pointer: "（目标全文见上方消息）",
        signal,
      }),
    );
    const pick = parseChoice(outcome.answer, spec);
    approved = pick.kind === "chose" && pick.option === goalApproveLabel;
    // The USER's own typed reason wins over the orchestrator's: the goal is
    // theirs to judge, and the box they typed into is the one they saw.
    declineReason = pick.kind === "declined" && pick.reason ? pick.reason : outcome.reason;
    approvalInterrupted = outcome.by === "interrupted";
  } catch {
    approved = false;
  }

  // The decision may carry a REASON — but only on REJECTION: the user rejects
  // with the objection so the agent renegotiates against the real problem
  // instead of re-asking. Since 2026-09-08 that reason is typed into the SAME
  // dialog (the template's decline row), so there is no second box to raise
  // and no PM-invisible input for an instruct to wedge on (measured deadlock,
  // 2026-09-17).
  const reason: string | undefined = approved ? undefined : declineReason;
  if (!approved) {
    // An INTERRUPTED approval is not a rejection: the PM stopped the goal
    // dialog to say something else, so the child should re-submit when it
    // is ready — not read "the user said no".
    if (approvalInterrupted) {
      return {
        content: [{
          type: "text",
          text: "review-gate: 目标协商被中断（项目经理发来消息，目标确认框已被解除）。" +
            "重新提交协商后的目标即可；不是被拒绝。",
        }],
        details: { approved: false, interrupted: true },
      };
    }
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
  goalSt.loopGoal = {
    hash: goalTextHash(goalText),
    at: new Date().toISOString(),
    // Recorded from the SAME value both consent surfaces displayed, never
    // re-derived afterwards: the station the user saw is the station the
    // contract carries.
    station,
  };
  // This goal's negotiation is over, so its audit count ends with it: the
  // NEXT goal's first audit must announce round 1, not round N+1.
  delete goalSt.goalAuditRound;
  // The force-negotiate clock resets with the approval: the goal is now
  // confirmed, so un-goaled turns stop counting from here.
  delete goalSt.turnsWithoutGoal;
  deps.persist(ctx, goalRoot);
  deps.log(`loop goal approved by the user for ${goalRoot} (${goalText.length} chars)`);
  return {
    content: [{
      type: "text",
      text: `review-gate: goal approved and written to ${deps.loopGoalRelPath} (repo: ${goalRoot}). Work to it; if it has to ` +

        "change, renegotiate with the user and call propose_loop_goal again (editing the file " +
        "yourself drops the approval and blocks shipping).\n" +
        stationLine,
    }],
    details: { approved: true, station },
  };
}

/**
 * The family's SINGLE registration entry point.
 *
 * ONE tool now: `propose_loop_goal`. The audit recorder behind it is a plain
 * function (`recordGoalPrereview`), which the extension calls when the
 * auditor's round lands — it is not on any tool surface.
 */
export function registerGoalTools(host: ToolHost, deps: GoalToolDeps): void {
  host.registerTool({
    name: "propose_loop_goal",
    label: "Propose Loop Goal",
    description:
      "Submit the NEGOTIATED loop goal (this session's exit contract) for the user's approval. " +
      "REQUIRED BEFORE THIS, in loop / orchestrator mode: a restatement the user confirmed " +
      "(`propose_restatement`) — without one this tool refuses outright and shows NO dialog. " +
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
      "repo before editing there; one repo's approval never opens another's write surface. " +
      "`station` says where THIS round stops (" + DELIVERY_STATION_CHOICES + "); omit it and the " +
      "station the user confirmed with the restatement is carried over (nothing on record ⇒ " +
      "precommit, the strictest). It is shown to the user in the approval dialog.",
    parameters: Type.Object({
      goal: Type.String({ description: "The full goal text (Markdown) as agreed with the user" }),
      repo: Type.Optional(Type.String({
        description:
          "Absolute path of the repo this goal binds to (default: the session repo). Required to " +
          "unlock edit/write in a SECOND repo the session works in.",
      })),
      station: Type.Optional(Type.String({
        description:
          "Where this round stops: " + DELIVERY_STATION_CHOICES + ". Default: the restatement's " +
          "station, else precommit. Only pass it when the user agreed to a DIFFERENT station.",
      })),
    }),
    execute: (_id, params, signal, onUpdate, ctx) => doProposeLoopGoal(deps, params, ctx, onUpdate, signal),
  });
}
