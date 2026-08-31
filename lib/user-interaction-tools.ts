/**
 * `ask_user` — the ONE way the agent reaches the human — and the single
 * registration entry point of the whole user-interaction family (this tool
 * plus the two consent tools in lib/consent-request-tools.ts).
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8500 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts), then
 * the judge tools (lib/judge-session-tools.ts), the prepare family
 * (lib/review-prepare-tools.ts, lib/advisory-prepare-tools.ts) and the L7
 * Copilot pair (lib/copilot-review-tools.ts). Same shape here:
 * `registerUserInteractionTools(host, deps)`, with every effect the tools
 * need arriving through an injected `deps` object.
 *
 * ONE ENTRY (philosophy two): the extension calls this function exactly once
 * and gets all three tools; the consent module registers nothing on its own.
 *
 * THE BOUNDARY: this module owns the INTERVIEW — when a question pauses the
 * loop, what gets persisted between questions, and every word the tool says
 * to the agent. It owns none of the interview's rules: the question
 * normalization, the choice list, the escape sentinels and the answer
 * formatting are the pure lib/ask-user.ts functions. What is injected is
 * everything it cannot own — the gate state, its persistence, the loop arming,
 * the dialogs and the orchestration channel funnel — so every branch
 * (headless, dismissed, resumed, answered) is testable without a terminal.
 *
 * SHARED STATE, NOT A COPY: `deps.state()` is a getter, because the extension
 * REBINDS its state object (session_start reloads it) and clears
 * `state.pausedQuestion` from several other places. A captured reference
 * would leave this module writing into a dead object while the gate reads a
 * live one.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Tool names, schemas, reply texts, `details` fields and error branches are
 * the ones the agent-facing contract already documents; changing any of them
 * is a separate, deliberate change.
 */

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import type { GateState } from "./gate-state.ts";
import type { ChannelDialogRequest } from "./orchestrator-child-channel.ts";
import type { SensitiveGrant } from "./sensitive-grant.ts";
import { registerConsentRequestTools } from "./consent-request-tools.ts";
import {
  normalizeQuestions,
  resumeFrom,
  interpretFreeText,
  buildNoDialogNotice,
  FREE_TEXT_HINT,
  progressLabel,
  buildChoiceList,
  interpretChoice,
  formatAnswers,
  formatTranscriptSummary,
  needsUserReply,
  MAX_QUESTIONS,
  type AskAnswer,
} from "./ask-user.ts";

/** Just enough of pi's tool context for a dialog and a transcript notice. */
export interface UiContext {
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
    input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
}

/**
 * Everything the three tools need from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every member is a thing a
 * test replaces with three lines.
 */
export interface UserInteractionToolDeps {
  /** This session's gate state — a GETTER; see "SHARED STATE" above. */
  state(): GateState;
  /** Persist it (sidecar write + status widget refresh). */
  persist(ctx: unknown): void;
  /** Arm or disarm auto-continuation — an unanswered question pauses it. */
  setLoopArmed(armed: boolean): void;
  /** Put text in front of the user, in the transcript, right now. */
  showToUser(uiCtx: unknown, lead: string, body: string): boolean;
  /** `ui.confirm` with the dialog-height budget applied (never bypassed). */
  confirmBounded(uiCtx: unknown, title: string, message: string, pointer?: string, signal?: AbortSignal): Promise<boolean>;
  /**
   * Raise a dialog EITHER the human or the orchestrator may answer; whoever
   * answers first wins, and the other side's box comes off the screen.
   */
  askEitherSide(
    request: Omit<ChannelDialogRequest, "hasUI">,
    hasUI: boolean,
    render: (signal: AbortSignal) => Promise<string | undefined>,
  ): Promise<string | undefined>;
  /** The session's primary repo/worktree directory. */
  cwd: string;
  /** Repo-relative paths THIS session edited (the never-exempt set). */
  sessionEditedPaths(): string[];
  /** How far the branch is ahead of its base (pre-existing commits). */
  commitsAheadOfBase(): Promise<number>;
  /** Did the user already decline a scope limit this session? */
  scopeLimitDeclined(): boolean;
  /** Record that they did — one decline locks the session. */
  declineScopeLimit(): void;
  /** The live, never-persisted one-shot sensitive-write grants. */
  sensitiveGrants(): SensitiveGrant[];
  /** Replace them (the grant list is immutable — see lib/sensitive-grant.ts). */
  storeSensitiveGrants(next: SensitiveGrant[]): void;
  /** Sensitive paths the user declined — asking again is refused. */
  sensitiveDeclinedPaths: Set<string>;
  /** The gate's own log channel (diagnostics; never shown to the user). */
  log(message: string): void;
}

/**
 * The subset the two CONSENT tools use.
 *
 * A `Pick` rather than the whole object, so lib/consent-request-tools.ts
 * cannot quietly start depending on the interview's own seams.
 */
export type ConsentToolDeps = Pick<
  UserInteractionToolDeps,
  | "state" | "persist" | "showToUser" | "confirmBounded" | "cwd"
  | "sessionEditedPaths" | "commitsAheadOfBase" | "scopeLimitDeclined"
  | "declineScopeLimit" | "sensitiveGrants" | "storeSensitiveGrants"
  | "sensitiveDeclinedPaths" | "log" | "askEitherSide"
>;

// ---------- ask_user ----------

export async function doAskUser(
  deps: UserInteractionToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const state = deps.state();
  const questions = normalizeQuestions(params.questions);
  // Over the cap the extra questions are DROPPED — say so, or the agent
  // waits for answers to questions nobody was ever asked.
  const droppedQuestions = Math.max(0, (Array.isArray(params.questions) ? params.questions.length : 0) - questions.length);
  if (!questions.length) {
    return {
      content: [{ type: "text", text: "review-gate: ask_user rejected — no question in the list. Write the actual question (options + your recommendation) and call again." }],
      details: { asked: 0, answered: 0, pending: false },
      isError: true,
    };
  }
  const uiCtx = ctx as UiContext;
  // NO UI AT ALL (print / json / headless RPC): pi hands extensions a
  // no-op UI whose dialogs resolve to undefined and whose notify does
  // nothing — so "did notify exist?" is not the question, `hasUI` is
  // (the same discriminator request_scope_limit uses). Asking there and
  // reporting a finished interview is how a headless session ends up
  // paused, waiting for answers to questions nobody was ever shown.
  if (uiCtx.hasUI !== true) {
    state.pausedQuestion = {
      question: questions.map((q) => q.text).join("\n").slice(0, 2000),
      at: new Date().toISOString(),
    };
    deps.setLoopArmed(false);
    deps.persist(ctx);
    return {
      content: [{ type: "text", text: buildNoDialogNotice(questions) }],
      details: { asked: questions.length, answered: 0, pending: true },
      isError: true,
    };
  }
  // The user must SEE the questions even when no dialog can be rendered
  // (headless), and the transcript is where the Q&A stays readable after
  // the dialogs close.
  deps.showToUser(uiCtx, "───── AI 有问题要问你 ─────", questions.map((q, i) =>
    `${progressLabel(i, questions.length)} ${q.text}` +
    (q.options?.length ? `\n   选项：${q.options.join(" / ")}` : "") +
    (q.recommended ? `\n   推荐：${q.recommended}` : "")).join("\n"));

  // An interview interrupted earlier (crash, restart, or the agent
  // re-submitting the same list) resumes where it stopped: the questions
  // the user already settled are not asked again.
  const answers: AskAnswer[] = resumeFrom(state.askUser, questions);
  const resumedCount = answers.length;
  let skipRest = false;
  /** Did ANY dialog actually render? A no is what makes this headless. */
  let anyDialog = false;
  for (const [index, q] of questions.entries()) {
    if (index < answers.length) continue; // already settled before the interruption
    if (skipRest) {
      answers.push({ question: q.text, kind: "skipped" });
      continue;
    }
    const title = `问题 ${progressLabel(index, questions.length)}`;
    const choices = buildChoiceList(q);
    let picked: string | undefined;
    try {
      // EITHER the user or the project manager may answer (when this
      // session is an orchestration child). The channel request carries
      // the question and every row VERBATIM, which is why the supervisor
      // never had to read this screen — and never mis-parsed it.
      picked = await deps.askEitherSide(
        {
          dialogKind: choices.length ? "select" : "input",
          topic: "ask-user",
          title: `${title}\n${q.text}`,
          options: choices,
          ...(q.recommended ? { payload: `推荐答案：${q.recommended}` } : {}),
        },
        uiCtx.hasUI === true,
        (signal) => (choices.length
          ? uiCtx.ui!.select!(`${title}\n${q.text}`, choices, { signal })
          : uiCtx.ui!.input!(`${title}\n${q.text}\n${FREE_TEXT_HINT}`, q.recommended ?? "", { signal })),
      );
    } catch {
      picked = undefined; // a broken dialog is silence, never an answer
    }

    if (picked !== undefined) anyDialog = true;
    // Free text carries its escapes as typed sentinels; a choice list
    // carries them as rows. Both must exist, or the escapes would only
    // apply to half the questions.
    const meaning = choices.length ? interpretChoice(picked, q) : interpretFreeText(picked);
    if (meaning.kind === "skip-rest") {
      skipRest = true;
      answers.push({ question: q.text, kind: "skipped" });
    } else if (meaning.kind === "answered") {
      answers.push({ question: q.text, kind: "answered", answer: meaning.answer });
    } else if (meaning.kind === "deferred-to-chat") {
      answers.push({ question: q.text, kind: "deferred-to-chat" });
    } else {
      // Dismissed (ESC) or no dialog at all: NOT a request to answer in
      // chat — the user asked for nothing, and the reply must say so.
      answers.push({ question: q.text, kind: "unanswered" });
    }
    // Persisted after EVERY question: an interview that dies here resumes
    // at the next one instead of asking the user everything again.
    state.askUser = { at: new Date().toISOString(), answers: [...answers] };
    deps.persist(ctx);
  }

  state.askUser = { at: new Date().toISOString(), answers };
  const pending = needsUserReply(answers);
  if (pending) {
    // Anything unanswered ⇒ the loop stops and waits for the user's next
    // message — the same pause the loop has always honoured.
    state.pausedQuestion = {
      question: answers.filter((a) => a.kind !== "answered").map((a) => a.question).join("\n").slice(0, 2000),
      at: new Date().toISOString(),
    };
    deps.setLoopArmed(false);
  } else {
    // Every question answered: nothing is waiting on the user, so the
    // loop is armed again (leaving it off would strand the session on a
    // question that no longer exists).
    delete state.pausedQuestion;
    deps.setLoopArmed(true);
  }
  deps.persist(ctx);
  // A UI existed but every dialog came back empty (they were all
  // dismissed, or the host refused to render them): the questions still
  // reached nobody, so the agent carries them itself.
  if (!anyDialog) {
    return {
      content: [{ type: "text", text: buildNoDialogNotice(questions) }],
      details: { asked: questions.length, answered: 0, pending: true },
      isError: true,
    };
  }
  deps.showToUser(uiCtx, "───── 采访结束 ─────", formatTranscriptSummary(answers));
  return {
    content: [{
      type: "text",
      text: `review-gate: ask_user 采访完成（${formatTranscriptSummary(answers)}）。\n${formatAnswers(answers)}\n` +
        (resumedCount ? `（前 ${resumedCount} 题沿用了上次中断前的回答，没有重复问用户。）\n` : "") +
        (droppedQuestions ? `（提交了 ${questions.length + droppedQuestions} 个问题，只问了前 ${MAX_QUESTIONS} 个；其余请下一轮再问。）\n` : "") +
        (pending
          ? "有问题没得到回答 — 循环已暂停，等用户的下一条消息；不要替他决定。"
          : "全部已答 — 按答案继续。"),
    }],
    details: { asked: questions.length, answered: answers.filter((a) => a.kind === "answered").length, pending },
  };
}

/**
 * Register `ask_user` — and, with it, the two consent tools.
 *
 * The family has ONE registration call on purpose: an extension that could
 * wire half of it is an extension that eventually does.
 */
export function registerUserInteractionTools(host: ToolHost, deps: UserInteractionToolDeps): void {
  host.registerTool({
    name: "ask_user",
    label: "Ask The User",
    description:
      "Ask the user something — the ONE entry point for every moment that needs a human: " +
      "requirement ambiguity, a product/design decision, scope trade-offs, how to handle a " +
      "conflict, the goal interview. CALLING IT PAUSES: the loop stops until the user has " +
      "answered, so ask instead of guessing, and never write a question into your reply and end " +
      "the turn (that costs a whole iteration and the user may not even read it as a question). " +
      "The gate runs the interview: one question at a time with its N / M progress, choices when " +
      "you give options, free text otherwise, plus 'answer in chat' and 'skip the rest' for the " +
      "user. Every answer comes back at once, unanswered ones marked. Write questions that stand " +
      "on their own, with the options AND your recommendation. When later questions depend on the " +
      "answer to an earlier one (pick an architecture, then its details), call ask_user AGAIN for " +
      "the follow-up round instead of guessing the branch.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          text: Type.String({ description: "The complete question, with the context the user needs to decide" }),
          options: Type.Optional(Type.Array(Type.String(), {
            description: "The choices, when this is a pick rather than free text",
          })),
          recommended: Type.Optional(Type.String({
            description: "Your own recommendation (one of `options` when you give options)",
          })),
        }),
        { description: `1-${MAX_QUESTIONS} questions, asked in order` },
      ),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doAskUser(deps, params, ctx),
  });

  registerConsentRequestTools(host, deps);
}
