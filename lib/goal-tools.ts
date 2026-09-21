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
import { REVISE_ROW, choiceRows, parseChoice, type AskChoiceOpts, type ChoiceSpec } from "./choice-dialog.ts";
import type { ChannelDialogOutcome, ChannelDialogRequest } from "./orchestrator-child-channel.ts";
import {
  GOAL_CONFIRM_TITLE,
  LOOP_GOAL_SKELETON,
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
import { capStationAt } from "./repo-pr-policy.ts";

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
  /** Render the gate's one question template (lib/choice-dialog.ts). No fitting —
   *  the box gets the whole text (lib/renderer-mode.ts says why). */
  askChoice(
    uiCtx: unknown,
    spec: ChoiceSpec,
    opts?: AskChoiceOpts,
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
  /**
   * HOW FAR THIS SESSION MAY SHIP (2026-09-15) — the plan's ceiling for an
   * orchestration child, read from the environment the dispatcher set
   * (`STATION_CAP_ENV`). `undefined` means no ceiling beyond the user's own
   * answer, which is the case for every standalone loop session.
   *
   * Injected rather than read from `process.env` here, for the reason every
   * other environment fact in this module is: the rule is what has to be
   * testable, and a test should not have to set process-wide state to ask.
   */
  stationCap?(): DeliveryStation | undefined;
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
    // a filename: the loader keys agents by their frontmatter `name`,
    // so a copy called custom.md that declares `name: goal-auditor` IS
    // dispatchable and must not be reported as missing. EVERY layer is
    // resolved that way — the same rule gate-doctor applies — so the two
    // never disagree.
    const packageAgentsDir = resolvePackageAgentsDir();
    const auditorInstalled =
      deps.findProjectAgent(pathJoin(homedir(), ".pi", "agent", "agents"), "goal-auditor") !== undefined ||
      // Both project layers are consulted: the loader reads them from the
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
  // THE UNTRUSTED VALUE IS CAPPED HERE, NOT AS A BLOCK (2026-09-16). The
  // dialog builder used to slice the whole "repo + station + pre-review"
  // clause at 200 characters, so a long path ate the two lines BELOW it: the
  // station line broke mid-sentence and `goal-auditor 预审: PASS` vanished,
  // while the dialog went on asking for approval. Capping the value keeps every
  // line that matters whole — and the full path is in the transcript anyway.
  const repoLine = capUntrustedLine(
    goalRoot === deps.primaryRepoRoot() ? "本仓库 (" + deps.primaryRepoRoot() + ")" : goalRoot,
  );

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
  // THIS text. It goes AFTER the repo line on purpose — the box is read
  // top-down, and the repo binding is the fact the user is confirming first.
  // (Until 2026-09-16 the order also decided what survived a tail cut; nothing
  // is cut any more, the reading order is why it stays.)
  // The record is guaranteed to exist here: goalPrereviewPassed() above
  // already required a PASS bound to this text, so this reads it directly
  // rather than advertising a fallback state that cannot occur.
  const prereviewLine = "goal-auditor 预审: PASS @ " + goalSt.goalPrereview!.at;
  // WHERE THIS ROUND STOPS (2026-09-06). Three sources, most specific first:
  // an explicit `station` parameter, then the station the user already agreed
  // to when they confirmed the restatement, then the strictest value. The
  // user is SHOWN it in both surfaces — a station nobody read is a contract
  // term nobody agreed to — and it is recorded beside the approval.
  const requestedStation: DeliveryStation = isDeliveryStation(String(params.station ?? "").trim().toLowerCase())
    ? parseDeliveryStation(params.station)
    : (goalSt.restatement?.station ?? parseDeliveryStation(undefined));
  // AND ONE CEILING OVER ALL OF THEM (2026-09-15, user decision). An
  // orchestration child's round stops where its TASK stops, and the plan may
  // have narrowed this repo to one PR (lib/repo-pr-policy.ts). The ceiling is
  // an environment fact the dispatcher wrote — never something a prompt could
  // supply — and a request beyond it is CLAMPED rather than refused, because
  // the value shown to the user has to be the value that gets recorded: a
  // dialog asking about `pr` while the gate silently writes `commit` would be
  // the gate lying to the person it is asking.
  const stationCap = deps.stationCap?.();
  const station: DeliveryStation = capStationAt(requestedStation, stationCap);
  // CLAMPED, NOT MERELY CAPPED (round-1 P1, 2026-09-15). The notice used to
  // fire whenever `stationCap !== requestedStation` — including the case where
  // the request was STRICTER than the ceiling (a restatement at `precommit`
  // under a `commit` cap), where nothing was narrowed at all. That told the
  // user a fact that was not true about their own contract. `station` is the
  // post-clamp value, so it differs from the request exactly when the gate
  // actually moved it.
  const capNote = stationCap !== undefined && station !== requestedStation
    ? `⚠️ 交付站点上界 ${stationCap}（不是 ${requestedStation}）：本编排的 plan 收窄了该 repo —— ` +
      "同一 repo 的一个需求只出一个 PR，子会话提交完就停，由 plan 的收尾任务汇合后统一开一个 PR。" +
      "要分多个 PR，需要在 plan 里声明 allowMultiplePrs 并重新批准。"
    : undefined;
  // THE DIALOG GETS THE SHORT FORM (measured, and it survived the end of the
  // row budget): the first version of this notice ended with
  // "declare allowMultiplePrs" — the one fact the reader can act on — and that
  // is precisely what got cut. The transcript block above carries the full
  // sentence; the box carries the decision.
  const capNoteShort = stationCap !== undefined && station !== requestedStation
    ? `⚠️ 要分多个 PR 就在 plan 里写 allowMultiplePrs；否则本 repo 站点上界 ${stationCap}（非 ${requestedStation}）`
    : undefined;
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
      stationLineForUser + "\n" + prereviewLine + (capNote ? "\n" + capNote : ""),
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
  /** The box closed with no answer at all — not a rejection either. */
  let approvalDismissed = false;
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
          "绑定仓库(不可信数据): " + repoLine + "\n" + stationLineForUser + "\n" + prereviewLine +
            (capNoteShort ? "\n" + capNoteShort : ""),
        ),
        signal,
        // THE REPO THIS GOAL BINDS TO (review round 4 P1): a multi-repo session
        // approves a goal per repo, and the one being approved here need not be
        // the one currently active. The proxy's context and the recorded
        // decision both hang off this.
        repo: goalRoot,
      }),
    );
    const pick = parseChoice(outcome.answer, spec);
    approved = pick.kind === "chose" && pick.option === goalApproveLabel;
    // The USER's own typed reason wins over the orchestrator's: the goal is
    // theirs to judge, and the box they typed into is the one they saw.
    declineReason = pick.kind === "declined" && pick.reason ? pick.reason : outcome.reason;
    approvalInterrupted = outcome.by === "interrupted";
    approvalDismissed = pick.kind === "dismissed";
  } catch {
    approved = false;
    approvalDismissed = true;
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
    // THE BOX WAS DISMISSED, NOT REJECTED (user report, 2026-09-14). Closing
    // the dialog without choosing means the user did not answer — usually
    // because they were saying something else. This used to fall through to
    // "the user did NOT approve this goal", which reads as an objection to a
    // goal nobody objected to, and the agent answers it by re-submitting the
    // same text into another box. Same wording as propose_restatement and the
    // plan submit: handle what they said, ASK, then submit.
    if (approvalDismissed) {
      return {
        content: [{
          type: "text",
          text: "review-gate: 用户没有作答这次目标协商（确认框被关掉，或他在框外说了别的事）—— " +
            "**这不是被否掉**，他很可能还有话要说。\n" +
            "下一步：先把他刚说的事处理掉，然后用 `ask_user` 问一句「关于这个目标，还有别的要补充或要改的吗？" +
            "没有了我就重新提交」，得到「没有了」之后才重新调用 propose_loop_goal。",
        }],
        details: { approved: false, dismissed: true },
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

/** How much of ONE untrusted value a dialog line may carry. */
export const UNTRUSTED_LINE_MAX_CHARS = 120;

/**
 * Cap ONE untrusted value (a path, a repo slug) so it cannot dominate a dialog.
 *
 * PER VALUE, never per BLOCK. Capping a BLOCK of lines by character count is
 * how the consent-critical lines that FOLLOW it got cut off (2026-09-16): the
 * slice happens before any wrapping, so it was invisible to the row budget that
 * existed then, and a long path silently took the station line and the
 * `goal-auditor 预审: PASS`
 * line with it while the dialog went on asking for approval.
 *
 * HEAD **AND TAIL**, because a path carries different facts at its two ends:
 * where it lives (the start) and WHAT it is (the end). A prefix-only cap
 * truncates inside whatever directory the caller happens to live under, so two
 * repos side by side (`…/rg-lg-AAAA/repo` and `…/rg-lg-BBBB/repo`) come out
 * identical — the value stops identifying anything exactly where the cap bites,
 * and a consent check that matches on it becomes vacuous (round-1 review P2,
 * 2026-09-16).
 */
export function capUntrustedLine(value: string, max = UNTRUSTED_LINE_MAX_CHARS): string {
  if (value.length <= max) return value;
  // One cell goes to the ellipsis, the rest splits as evenly as the parity allows.
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return value.slice(0, head) + "…" + value.slice(value.length - tail);
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
      "precommit, the strictest). It is shown to the user in the approval dialog. " +
      // THE TEMPLATE TRAVELS WITH THE TOOL (user ask, 2026-09-17): the agent
      // reads this description BEFORE it drafts anything, which is the only
      // moment a template can still save the round. The same constant is what
      // the refusal hands back when an audit rejects the draft — one skeleton,
      // two moments.
      "填写模板（把 `<…>` 换成你的事实）：\n" + LOOP_GOAL_SKELETON,
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
