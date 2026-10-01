/**
 * THE APPROVAL LADDER — one box, one reading, every family that asks for a
 * signature.
 *
 * ── WHAT WAS WRONG BEFORE THIS MODULE (quality round, 2026-10-02) ──
 *
 * Three families raise an approval box the same way: `propose_restatement`
 * (lib/restatement.ts), `propose_loop_goal` (lib/goal-tools.ts) and
 * `schedule_task` (lib/schedule-authoring.ts). Each built its own
 * `ChoiceSpec`, its own channel request and its own rendering — that part is
 * genuinely different, and it stays at the call sites. What was IDENTICAL, line
 * for line, is the reading: race both sides (`askEitherSide`), parse the answer
 * into `parseChoice`'s vocabulary, and turn it into four facts — approved,
 * the reason, interrupted, dismissed. Written three times, that reading is
 * three places to fix when a fifth state is ever added, and two of them would
 * be missed (the exact failure this repository keeps a rule about).
 *
 * ── WHAT THIS MODULE OWNS, AND WHAT IT DOES NOT ──
 *
 * It owns the READING only. Not the question (the spec, the payload, the
 * station, the repo), not the wording of a refusal, and not what an approval
 * means — those differ per family on purpose, and the load-bearing comments
 * about them stay where the question is built.
 *
 * THE THREE STATES AFTER "NO ARE NOT ONE STATE". `interrupted` (an instruct
 * dismissed the box), `dismissed` (nobody answered) and a plain rejection are
 * three different facts, and every caller answers them with three different
 * next steps. A `throw` out of the funnel — no box was rendered at all — is
 * the same fact as a dismissed box, never an objection.
 */

import { parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
import type { ChannelDialogOutcome, ChannelDialogRequest, DialogRenderer } from "./orchestrator-child-channel.ts";

/** What one approval box came back as — the four facts every caller branches on. */
export interface ApprovalDecision {
  approved: boolean;
  /** The objection: the human's decline row, else the channel answer's reason. */
  reason?: string;
  /** An instruct interrupt dismissed the box — NOT a rejection. */
  interrupted: boolean;
  /** The box closed with no answer at all — NOT a rejection either. */
  dismissed: boolean;
}

/** One approval box, fully described by its caller. */
export interface ApprovalAsk {
  /** The either-side funnel: the human's box races the orchestration channel. */
  askEitherSide(
    request: Omit<ChannelDialogRequest, "hasUI">,
    hasUI: boolean,
    render: DialogRenderer,
  ): Promise<ChannelDialogOutcome>;
  /** The request the channel sees (the title, the rows, the payload, the station). */
  request: Omit<ChannelDialogRequest, "hasUI">;
  hasUI: boolean;
  spec: ChoiceSpec;
  /** The label that means "yes" — every other answer is a refusal. */
  approveLabel: string;
  /** Renders the human's box (the caller's own body, repo hints, …). */
  render: DialogRenderer;
}

/** Raise the box, wait for whichever side answers, and read the outcome. */
export async function awaitApproval(ask: ApprovalAsk): Promise<ApprovalDecision> {
  try {
    const outcome = await ask.askEitherSide(ask.request, ask.hasUI, ask.render);
    const pick = parseChoice(outcome.answer, ask.spec);
    // The USER's own typed reason wins over the orchestrator's: the box they
    // typed into is the one they saw, and the content is theirs to judge.
    const reason = pick.kind === "declined" && pick.reason ? pick.reason : outcome.reason;
    return {
      approved: pick.kind === "chose" && pick.option === ask.approveLabel,
      ...(reason !== undefined ? { reason } : {}),
      interrupted: outcome.by === "interrupted",
      dismissed: pick.kind === "dismissed",
    };
  } catch {
    // No box was rendered at all: the same fact as a box nobody answered.
    return { approved: false, interrupted: false, dismissed: true };
  }
}
