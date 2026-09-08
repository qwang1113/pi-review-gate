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
import type { ChannelDialogOutcome, ChannelDialogRequest } from "./orchestrator-child-channel.ts";
import type { SensitiveGrant } from "./sensitive-grant.ts";
import type { ChoiceSpec } from "./choice-dialog.ts";
import { registerConsentRequestTools } from "./consent-request-tools.ts";
import {
  validateQuestions,
  resumeFrom,
  buildNoDialogNotice,
  progressLabel,
  buildChoiceList,
  choiceSpecOf,
  resolveQuestion,

  formatAnswers,
  formatTranscriptSummary,
  needsUserReply,
  isGrantableScope,
  MAX_QUESTIONS,
  SKIP_REST_CHOICE,
  type AskAnswer,
  type AskQuestion,
  type InterviewStop,
} from "./ask-user.ts";
import { MAX_CHOICE_OPTIONS, renderChoice } from "./choice-dialog.ts";
// The batch id is minted with the same collision-resistant helper the channel
// uses for its own record ids — one generator, not a second convention.
import { newChannelId } from "./orchestrator-channel.ts";

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
  /**
   * Can THIS session route consent dialogs through an orchestration channel
   * (i.e. it is an orchestration child)? An orchestrator's OWN session
   * answers false — its `request_sensitive_edit` would otherwise render a
   * dialog only the human can close, deadlocking the project manager on a
   * box it is supposed to answer, not to ask (measured: onchain run,
   * 2026-08-31 — the PM called request_sensitive_edit to "authorize" a
   * child's .env edit and froze for 2h18m on its own dialog).
   */
  canChannelDialogs(): boolean;
  /**
   * Mint a proxy grant for `scope` (user said yes via ask_user). The gate
   * records it on the orchestration runtime; a no-op outside an
   * orchestration.
   */
  grantProxyScope(scope: string, via: "ask-user" | "gate-grant" | "first-answer"): void;
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
  | "state" | "persist" | "showToUser" | "askChoice" | "cwd"
  | "sessionEditedPaths" | "commitsAheadOfBase" | "scopeLimitDeclined"
  | "declineScopeLimit" | "sensitiveGrants" | "storeSensitiveGrants"
  | "sensitiveDeclinedPaths" | "log" | "askEitherSide" | "canChannelDialogs"
>;

// ---------- ask_user ----------

/**
 * The user-visible authorization notice a grantScope question carries.
 *
 * 2026-09-16 (reviewer P1): a grantScope invisible to the user let an agent
 * harvest the sensitive-edit proxy grant from an answer to an UNRELATED
 * question (substring match fired on "grant me a few minutes"). The scope
 * must be stated in the dialog and the transcript, so consent is explicit.
 */
function grantNotice(q: AskQuestion): string {
  if (!q.grantScope || !isGrantableScope(q.grantScope)) return "";
  return `\n\n⚠️ 回答此题即表示：你**明确授予项目经理「${q.grantScope}」代答权**（本 orchestration 内有效）。若不打算授权，请选拒绝/否。`;
}


export async function doAskUser(
  deps: UserInteractionToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const state = deps.state();
  // THE TEMPLATE IS A HARD REQUIREMENT (user decision, 2026-09-08): a batch
  // that does not follow it is refused OUTRIGHT — no dialog is shown, and
  // the error names the offending question. Tolerating a malformed one is
  // how a yes/no-shaped or option-less question reached the user in the
  // first place.
  const checked = validateQuestions(params.questions);
  if (!checked.ok) {
    return {
      content: [{
        type: "text",
        text: `review-gate: ask_user rejected — ${checked.error}。` +
          `每题必须是 ${MAX_CHOICE_OPTIONS} 个以内的选项（至少 2 个）+ 一个 recommended，` +
          "改完重新调用；这一次一个对话框都没有弹出。",
      }],
      details: { asked: 0, answered: 0, pending: false },
      isError: true,
    };
  }
  const { questions, dropped: droppedQuestions, trimmedOptions } = checked;
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
    `${progressLabel(i, questions.length)} ${q.text}${grantNotice(q)}` +
    `\n   选项：${buildChoiceList(q).join(" / ")}`).join("\n"));

  // An interview interrupted earlier (crash, restart, or the agent
  // re-submitting the same list) resumes where it stopped: the questions
  // the user already settled are not asked again.
  const answers: AskAnswer[] = resumeFrom(state.askUser, questions);
  const resumedCount = answers.length;
  /** Why the questions still unshown will never be shown. */
  let stopped: InterviewStop | undefined;
  /** Did ANY dialog actually render? A no is what makes this headless. */
  let anyDialog = false;

  // ── THE WHOLE INTERVIEW GOES UP FIRST (2026-09-06) ──
  //
  // Every question still to ask is handed to `askEitherSide` NOW, in one
  // synchronous burst, before any dialog is raised. Each call writes its
  // channel request record before it awaits anything, so a project manager
  // sees the ENTIRE interview on its very first receipt and can answer all of
  // it at once — where a five-question interview used to reach it as five
  // separate ask → wait → answer round trips (measured this round: t9c 5,
  // t9e 4, t9h 3, and t9h additionally lost two questions when an instruct
  // dismissed the one box that was up). The narrower window also shrinks that
  // failure: one instruct now interrupts one batch, not one question of it.
  //
  // WHAT KEEPS THE USER'S OWN WINDOW ONE AT A TIME: the renderers are GATED.
  // Question i's box is not raised until question i-1 has settled, so the
  // human still sees exactly one dialog and can step in at any point.
  // Batching changed WHO LEARNS THE QUESTIONS WHEN; it changed nothing about
  // what the person in the pane sees, and nothing about who wins the race.
  const firstIndex = answers.length;
  const remaining = questions.slice(firstIndex);
  /** One-shot gates, in question order: renderer i waits for gate i to open. */
  const gates = remaining.map(() => {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { opened, open };
  });
  gates[0]?.open();
  // A single question is not an interview: it goes on the wire exactly as it
  // always did, with no stamp for a reader to make sense of.
  const batchId = remaining.length > 1 ? newChannelId("ask", Date.now()) : undefined;
  const asks = remaining.map((q, offset) => {
    const index = firstIndex + offset;
    const prompt = `问题 ${progressLabel(index, questions.length)}\n${q.text}${grantNotice(q)}`;
    const choices = buildChoiceList(q);
    // EITHER the user or the project manager may answer (when this session is
    // an orchestration child). The channel request carries the question and
    // every row VERBATIM, which is why the supervisor never had to read this
    // screen — and never mis-parsed it.
    return deps.askEitherSide(
      {
        // Every question is a choice question now (2026-09-08): the template
        // rejects a batch without options before a dialog is ever built.
        dialogKind: "select",
        topic: "ask-user",
        title: prompt,
        options: choices,
        payload: `推荐答案：${q.recommended}`,
        ...(batchId === undefined
          ? {}
          : { batch: { id: batchId, index, total: questions.length } }),
      },
      uiCtx.hasUI === true,
      async (signal) => {
        await gates[offset]!.opened;
        // Already settled (the project manager answered it through the
        // channel), or the interview stopped: never put a dead box on screen.
        if (signal.aborted || stopped !== undefined) return undefined;
        // ONE renderer for every dialog in the gate, plus the interview's
        // own escape row — which is not part of the template because only an
        // interview has later questions to skip.
        return renderChoice(
          uiCtx.ui,
          { ...choiceSpecOf(q), title: prompt },
          { signal, extraRows: [SKIP_REST_CHOICE] },
        );
      },
      // A broken dialog is silence, never an answer — and, now that these
      // calls outlive the statement that made them, never an unhandled
      // rejection either.
    ).catch((): ChannelDialogOutcome => ({ answer: undefined, by: "dismissed", requestId: "" }));
  });

  for (const [offset, q] of remaining.entries()) {
    const outcome = await asks[offset]!;
    if (outcome.answer !== undefined) anyDialog = true;
    const resolution = resolveQuestion(q, outcome.answer, {
      interrupted: outcome.by === "interrupted",
      ...(stopped === undefined ? {} : { stopped }),
    });
    answers.push(resolution.answer);
    if (resolution.stop !== undefined) stopped ??= resolution.stop;
    if (resolution.answer.kind === "answered") {
      // GRANT DOOR 1/3 (2026-09-16, reviewer P1 fix): a question carrying a
      // grantScope mints the proxy grant ONLY when the user picked the exact
      // option the agent RECOMMENDED — the recommended option's own text is
      // the authorization the user saw and chose (the notice in grantNotice
      // states it). Substring matching is gone: an unrelated "grant me a few
      // minutes" can no longer harvest the scope.
      if (q.grantScope && isGrantableScope(q.grantScope) && resolution.answer.answer === q.recommended) {
        deps.grantProxyScope(q.grantScope, "ask-user");
      }
    }
    // OPENING THE NEXT GATE IS ALSO HOW A CUT-SHORT INTERVIEW SETTLES ITS
    // LEFTOVERS. Once `stopped` is set, the next renderer returns immediately,
    // which resolves that question through the same race as any other and
    // writes its `request-settled` record (`dismissed` for a skip; an
    // instruct has already settled the whole batch as `interrupted`). So a
    // question nobody will ever see stops ringing on the project manager's
    // receipt instead of hanging there unanswerable.
    gates[offset + 1]?.open();
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
        (trimmedOptions ? `（有 ${trimmedOptions} 个问题的选项超过 ${MAX_CHOICE_OPTIONS} 个，已截断到前 ${MAX_CHOICE_OPTIONS} 个。）\n` : "") +
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
    // THE INTERVIEW RULE LIVES HERE (user decision, 2026-09-06): optional, and
    // uncapped in the number of questions. This description is the ONE full
    // statement of it — it is what the model reads at the moment it decides
    // whether to ask, and it is the only place that can quote the real
    // per-call cap. `LOOP_GOAL_MISSING_DIRECTIVE` (lib/loop-goal.ts) carries a
    // one-line summary and points here; do not let that grow back into a
    // second wording, which is how the old "ask fewer questions" copy survived
    // in two places at once.

    description:
      "Ask the user something — the ONE entry point for every moment that needs a human: " +
      "requirement ambiguity, a product/design decision, scope trade-offs, how to handle a " +
      "conflict, the goal interview. CALLING IT PAUSES: the loop stops until the user has " +
      "answered, so ask instead of guessing, and never write a question into your reply and end " +
      "the turn (that costs a whole iteration and the user may not even read it as a question). " +
      "EVERY QUESTION FOLLOWS THE GATE'S ONE TEMPLATE: 2–4 options, exactly one of them named " +
      "in `recommended` (the dialog marks it （推荐）), and the gate appends its own row " +
      "「✎ 不选，我说明原因」 which opens a text box — so the user can always answer with a " +
      "reason instead of picking anything. A question with fewer than 2 options, no " +
      "`recommended`, or a recommendation that is not one of the options REJECTS THE WHOLE " +
      "BATCH with no dialog shown — rewrite it and call again. There is no free-text question " +
      "any more. The gate runs the interview: one question at a time with its N / M progress, " +
      "plus 「⏭ 跳过后续问题」. Every answer comes back at once, unanswered ones marked. Write " +
      "questions that stand on their own. When later questions depend on the answer to an " +
      "earlier one (pick an architecture, then its details), call ask_user AGAIN for the " +
      "follow-up round instead of guessing the branch. ASK AS MANY AS THE REQUIREMENT IS " +
      `WORTH: the interview itself is optional (no doubts ⇒ no questions), but there is no cap on ` +
      `how many you may ask — up to ${MAX_QUESTIONS} per call and another round whenever you need ` +
      "more. Never trim a real doubt to keep the count down; agreeing on the requirement is " +
      "cheaper than building the wrong one.",

    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          text: Type.String({ description: "The complete question, with the context the user needs to decide" }),
          options: Type.Array(Type.String(), {
            description: `The choices: ${MAX_CHOICE_OPTIONS} at most, 2 at least, each one short enough to read in a dialog row`,
          }),
          recommended: Type.String({
            description: "Your own recommendation — MUST be exactly one of `options` (the gate rejects the batch otherwise)",
          }),
        }),
        { description: `1-${MAX_QUESTIONS} questions, asked in order` },
      ),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doAskUser(deps, params, ctx),
  });

  registerConsentRequestTools(host, deps);
}
