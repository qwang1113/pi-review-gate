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
import { buildRejection } from "./rejection-copy.ts";
import type { AskChoiceOpts, ChoiceSpec } from "./choice-dialog.ts";
import { registerConsentRequestTools } from "./consent-request-tools.ts";
import {
  validateQuestions,
  resumeFrom,
  buildNoDialogNotice,
  progressLabel,
  choiceSpecOf,
  questionRows,
  resolveQuestion,
  stepInterview,

  formatAnswers,
  formatTranscriptSummary,
  needsUserReply,
  isGrantableScope,
  type AskAnswer,
  type AskQuestion,
  type QuestionResolution,
} from "./ask-user.ts";
import { choiceRows, MAX_CHOICE_OPTIONS } from "./choice-dialog.ts";
import { MULTI_UNAVAILABLE, multiSelectionLabel } from "./multi-choice-dialog.ts";
// The batch id is minted with the same collision-resistant helper the channel
// uses for its own record ids — one generator, not a second convention.
import { newChannelId } from "./channel-io.ts";

/** Just enough of pi's tool context for a dialog and a transcript notice. */
export interface UiContext {
  hasUI?: boolean;
  ui?: {
    select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
    editor?: (title: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
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
  /**
   * THE REPO THIS SESSION'S GATE STATE BELONGS TO — the git ROOT, already
   * resolved (review round 5 P1).
   *
   * `cwd` is where the session was STARTED, which can be a subdirectory of the
   * repository; `stateForRepo` and `persistRepo` key their sidecars off a repo
   * root, so a subdirectory reaching them reads and writes the wrong `.pi/`
   * file. Callers that need to name the repo their question is about ask for it
   * HERE instead of passing `cwd`.
   */
  repoRoot(): string;
  /** Persist it (sidecar write + status widget refresh). */
  persist(ctx: unknown): void;
  /** Arm or disarm auto-continuation — an unanswered question pauses it. */
  setLoopArmed(armed: boolean): void;
  /** Put text in front of the user, in the transcript, right now. */
  showToUser(uiCtx: unknown, lead: string, body: string): boolean;
  /**
   * Render the gate's one question template (lib/choice-dialog.ts). No fitting —
   * the box gets the whole text (lib/renderer-mode.ts says why).
   *
   * `back` draws the `← 返回上一题` row (multi-question interviews only); the
   * row comes back as `lib/choice-dialog.ts`'s `BACK_ROW`, which the interview
   * reads with `stepInterview`.
   */
  askChoice(
    uiCtx: unknown,
    spec: ChoiceSpec,
    opts?: AskChoiceOpts,
  ): Promise<string | undefined>;
  /**
   * THE CHECKBOX SHAPE (2026-09-22): the same dialog, drawn as a checklist the
   * user may answer with several ticks. Same contract as {@link askChoice} —
   * the returned line is the one `lib/multi-choice-dialog.ts` writes (and
   * `parseMultiChoice` reads), `undefined` is a dismissal — and the same
   * dialog machinery behind it: one queue, one banner, one proxy race.
   *
   * ONE EXTRA OUTCOME: {@link MULTI_UNAVAILABLE}, when the host cannot mount a
   * checkbox box at all (RPC runs no custom component). It is NOT a dismissal:
   * the caller must not record a question nobody was shown as closed.
   */
  askMultiChoice(
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
  /**
   * Take one back (the user walked back to the authorization question and
   * chose something else — 2026-09-19). Also a no-op outside an orchestration.
   */
  revokeProxyScope(scope: string): void;
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
  /** Did the user already decline tmux access this session? */
  tmuxAccessDeclined(): boolean;
  /** Record that they did — one decline locks the session. */
  declineTmuxAccess(): void;
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
  | "state" | "persist" | "showToUser" | "askChoice" | "cwd" | "repoRoot"
  | "sessionEditedPaths" | "commitsAheadOfBase" | "scopeLimitDeclined"
  | "declineScopeLimit" | "tmuxAccessDeclined" | "declineTmuxAccess"
  | "sensitiveGrants" | "storeSensitiveGrants"
  | "sensitiveDeclinedPaths" | "log" | "askEitherSide" | "canChannelDialogs"
>;

// ---------- ask_user ----------

/**
 * The box title for one question — the ONE place its order is decided.
 *
 * IT IS A BARE PROGRESS LABEL (user decision, 2026-09-17). It used to carry
 * the question's first line cut at 60 characters — a half-sentence sitting
 * directly above the whole question, which is what the user saw and asked to
 * be rid of: the body below says everything the stub did, and the stub only
 * ever said it worse. What the reason box needs to know about the question now
 * rides in ITS OWN title instead (lib/choice-dialog.ts's `reasonTitleOf` gets
 * the same head), so the 2026-09-14 blindness fix survives intact.
 *
 * ORDER STILL MATTERS: a ⚠️ authorization notice buried under a progress
 * label is easy to miss however long the box may be, and the notice
 * announcing that
 * 「推荐」 grants a proxy authority would be gone while picking that row still
 * minted the grant. Head-first makes "the notice is visible wherever the box
 * is shown at all" true by construction.
 */
function questionDialogTitle(q: AskQuestion, index: number, total: number): string {
  const notice = grantNotice(q).trim();
  const label = `问题 ${progressLabel(index, total)}`;
  return notice ? `${notice}\n${label}` : label;
}

/**
 * The user-visible authorization notice a grantScope question carries.
 *
 * 2026-09-16 (reviewer P1): a grantScope invisible to the user let an agent
 * harvest the sensitive-edit proxy grant from an answer to an UNRELATED
 * question (substring match fired on "grant me a few minutes"). The scope
 * must be stated in the dialog and the transcript, so consent is explicit —
 * and in the DIALOG it has to be stated where a tail cut cannot reach it
 * (2026-09-14), which is what questionDialogTitle arranges.
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
        text: buildRejection({
          what: `ask_user 被拒 —— ${checked.error}`,
          why: `门禁要求每题 2–${MAX_CHOICE_OPTIONS} 个选项 + 一个 recommended（推荐值须与其中一个选项完全相同），` +
            "缺任一项整批拒绝。",
          by: "agent",
          next: "把上面点名的题补上选项 / 推荐项，或删掉不成立的问题后重新调用 —— " +
            "这一次一个对话框都没有弹出，用户什么都没看到。",
        }),
      }],
      details: { asked: 0, answered: 0, pending: false },
      isError: true,
    };
  }
  const { questions, trimmedOptions } = checked;
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
    `\n   选项：${questionRows(q).join(" / ")}`).join("\n"));

  // An interview interrupted earlier (crash, restart, or the agent
  // re-submitting the same list) resumes where it stopped: the questions
  // the user already settled are not asked again.
  const answers: AskAnswer[] = resumeFrom(state.askUser, questions);
  const resumedCount = answers.length;
  /** Is the interview already stopped? Set when a box is closed unanswered. */
  let stopped = false;
  /**
   * Did a QUESTION reach the screen, or an answer come back?
   *
   * A no is what makes this a host with no dialogs at all — and the questions
   * then go back to the agent to carry in its reply. CLOSING A BOX COUNTS AS
   * REACHING IT (reviewer P1, 2026-09-17): closing is the way OUT of an
   * interview now, so counting answers instead would tell a user who closed the
   * first box that "this environment has no dialogs, not one question was
   * shown" — flatly false, and it costs the agent a whole iteration pasting
   * every question into its reply.
   */
  let anyDialog = false;
  /**
   * DID A CHECKLIST GET DROPPED FOR A REASON THE USER CANNOT SEE?
   *
   * A host with no custom components (RPC) can draw the radio list and NOT the
   * checkbox — so a batch can be half shown, and that half must not look like a
   * question the user chose to skip (reviewer P2, 2026-09-22). Tracked here and
   * said out loud in the reply.
   */
  let unrenderableChecklist = false;
  /**
   * WHICH QUESTIONS NO HOST COULD DRAW — kept HERE, not in a renderer's return
   * value (quality round P2, 2026-09-22): whatever a renderer returns is taken
   * as the human's answer by `askThroughChannel` and written into the
   * request-settled record, so returning the sentinel settled the question as
   * ANSWERED with a NUL-bearing string — and took it off the project manager's
   * receipt, which is the one place an answer could still have come from.
   */
  const unrenderable = new Set<number>();

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

  /**
   * ONE QUESTION SETTLES — the interview's only place for it.
   *
   * Both halves of the interview come through here: a question the dialogs
   * settled in order, and one the user walked BACK to and re-answered
   * (2026-09-19). One function is what makes the second indistinguishable from
   * the first everywhere it matters — the answer list, the proxy grant, and
   * the progress the sidecar persists after every single question.
   */
  function settleAnswer(
    index: number,
    q: AskQuestion,
    picked: string | undefined,
    opts: { interrupted?: boolean; unavailable?: boolean } = {},
  ): QuestionResolution {
    // NOT SHOWN IS UNANSWERED, AND STOPS NOTHING (quality round P2, 2026-09-22):
    // the same landing `resolveQuestion` gives an interrupted box, for the same
    // reason — nobody decided anything, and the rest of the batch must still be
    // asked. Reading it as a dismissed box instead took every question behind
    // it down on a host that could have drawn them.
    const resolution = opts.unavailable
      ? { answer: { question: q.text, kind: "unanswered" as const } }
      : resolveQuestion(q, picked, opts);
    answers[index] = resolution.answer;
    applyGrant(q, resolution.answer);
    // Persisted after EVERY question: an interview that dies here resumes at
    // the next one instead of asking the user everything again.
    state.askUser = { at: new Date().toISOString(), answers: [...answers] };
    deps.persist(ctx);
    return resolution;
  }

  /**
   * WHAT AN ANSWER DOES TO A PROXY AUTHORITY.
   *
   * GRANT DOOR 1/3 (2026-09-16, reviewer P1 fix): a question carrying a
   * grantScope mints the proxy grant ONLY when the user picked the exact
   * option the agent RECOMMENDED — the recommended option's own text is the
   * authorization the user saw and chose (the notice in grantNotice states
   * it). Substring matching is gone: an unrelated "grant me a few minutes"
   * can no longer harvest the scope.
   *
   * AND A NON-RECOMMENDED ANSWER TAKES IT BACK (user decision, 2026-09-19):
   * the authorization state of a scope follows the LATEST answer to the
   * question that asks about it — walking back to an authorization question and
   * choosing something else is the user changing their mind, and a grant that
   * outlived the answer that minted it would be authority nobody gave any more.
   * This holds for a FIRST answer too (a plain "no" now also revokes a scope
   * some other door granted): revoking is the tightening direction, and two
   * rules for one question would be one rule too many. An UNANSWERED question
   * changes nothing — a closed box (or "answer this in chat") is not a refusal
   * to authorize.
   */
  function applyGrant(q: AskQuestion, answer: AskAnswer): void {
    if (!q.grantScope || !isGrantableScope(q.grantScope)) return;
    if (answer.kind !== "answered") return;
    if (answer.option === q.recommended) deps.grantProxyScope(q.grantScope, "ask-user");
    else deps.revokeProxyScope(q.grantScope);
  }

  /**
   * RENDER ONE QUESTION — AND LET THE USER WALK BACK (user decision, 2026-09-19).
   *
   * The order of ROWS inside a question is fixed; the order of QUESTIONS is
   * not a one-way street any more. `← 返回上一题` re-opens an earlier question,
   * its new answer overwrites the old one, and the box returns to the question
   * the interview was actually waiting for. Which row does what is
   * `stepInterview` (lib/ask-user.ts); this is the dialogs and the answer
   * bookkeeping.
   *
   * THE QUESTION RIDES IN THE BODY (2026-09-14). The title is the short label
   * the reason box repeats; the question is the long half and belongs in the
   * body. (When a row budget existed this ALSO kept a 1200-character question
   * from sizing the box — the budget is gone, the placement is not.) The full
   * question is in the transcript printed before the first box, which is where
   * a long text is readable.
   *
   * THE GRANT NOTICE STAYS OUT OF THE BODY (reviewer P1, 2026-09-14). The body
   * was cut from its TAIL at the time, so appending the ⚠️ authorization
   * notice after the question let a long question eat it — while picking the
   * recommended row still minted the proxy grant. That is exactly the
   * invisible-authorization hole the notice was added to close (2026-09-16
   * P1), so the notice rides in the TITLE: it is the part of the box that is
   * read first and repeated back by the reason box, and a two-line notice is
   * never the long half. A long question goes in the body, whose full text is
   * in the transcript anyway.
   *
   * ONE SIGNAL FOR THE WHOLE WALK: it is the anchored question's own, so an
   * answer arriving through the channel — the project manager may settle THAT
   * question while the user is two questions back — ends the walk exactly as
   * it ends a single box: the next call finds a dead signal and returns
   * without drawing anything.
   *
   * THE USER OUTRANKS A PROXY ANSWER THAT IS ALREADY ON THE WIRE (by
   * construction, 2026-09-19). A question the project manager answered while
   * the user was elsewhere comes back to the screen when the user walks to it:
   * its box is no longer gated by the settled request, and what the user picks
   * OVERWRITES the manager's answer in the interview record. That is the
   * intended reading — the human is the authority the proxy stands in for —
   * and the channel keeps the manager's own `request-settled` record, because
   * inventing a second "corrected answer" record would give one dialog two
   * histories with no rule for which one wins.
   */
  async function askWithBacks(anchor: number, signal: AbortSignal): Promise<string | undefined> {
    let cursor = anchor;
    for (;;) {
      const q = questions[cursor]!;
      // ONE dialog per question, whichever of the two shapes it is: the box,
      // the queue, the banner and the proxy race are all behind these two
      // seams, and only the RENDERING differs (radio list vs checklist).
      const spec = { ...choiceSpecOf(q), title: questionDialogTitle(q, cursor, questions.length) };
      const opts = { body: q.text, signal, back: cursor > 0 };
      const picked = q.multiple
        ? await deps.askMultiChoice(uiCtx, spec, opts)
        : await deps.askChoice(uiCtx, spec, opts);
      // NOTHING WAS SHOWN (reviewer P2, 2026-09-22): neither an answer nor a
      // dismissal — the renderer above reads the sentinel and leaves
      // `anyDialog` alone, so the interview reports it the way it reports a
      // host with no dialogs at all.
      if (picked === MULTI_UNAVAILABLE) return picked;
      const step = stepInterview({ anchor, cursor }, picked);
      if (step.kind === "render") { cursor = step.cursor; continue; }
      if (step.kind === "answerCurrent") return step.picked;
      if (step.kind === "close") return undefined;
      // A question reached by walking back: overwrite it, then return to the
      // one the interview is waiting for.
      settleAnswer(step.index, questions[step.index]!, step.picked);
      cursor = anchor;
    }
  }

  const asks = remaining.map((q, offset) => {
    const index = firstIndex + offset;
    const prompt = `问题 ${progressLabel(index, questions.length)}\n${q.text}${grantNotice(q)}`;
    const choices = questionRows(q);
    // EITHER the user or the project manager may answer (when this session is
    // an orchestration child). The channel request carries the question and
    // every row VERBATIM, which is why the supervisor never had to read this
    // screen — and never mis-parsed it. A checklist also carries its shape and
    // the group its author recommends, so a manager answering for the user
    // knows that several answers are wanted and what a bare “approve” means.
    return deps.askEitherSide(
      {
        // Every question is a choice question now (2026-09-08): the template
        // rejects a batch without options before a dialog is ever built.
        dialogKind: "select",
        topic: "ask-user",
        title: prompt,
        options: choices,
        ...(q.multiple ? { multiple: true as const } : {}),
        payload: q.multiple
          ? `多选题（可以勾选多项）· 推荐勾选：${multiSelectionLabel(q.defaultChecked ?? [], q.options) || "（一项都不勾）"}`
          : `推荐答案：${q.recommended}`,
        ...(batchId === undefined
          ? {}
          : { batch: { id: batchId, index, total: questions.length } }),
      },
      uiCtx.hasUI === true,
      async (signal) => {
        await gates[offset]!.opened;
        // Already settled (the project manager answered it through the
        // channel), or the interview stopped: never put a dead box on screen.
        if (signal.aborted || stopped) return undefined;
        const answered = await askWithBacks(index, signal);
        // NOTHING WAS SHOWN STAYS HERE: the renderer answers with the same
        // `undefined` a closed box gives (so the channel settles it as
        // dismissed, never as an answer nobody gave), and the FACT that no host
        // could draw it is recorded in `unrenderable` for the loop below.
        if (answered === MULTI_UNAVAILABLE) {
          unrenderable.add(index);
          return undefined;
        }
        anyDialog = true;
        return answered;
      },
      // A broken dialog is silence, never an answer — and, now that these
      // calls outlive the statement that made them, never an unhandled
      // rejection either.
    ).catch((): ChannelDialogOutcome => ({ answer: undefined, by: "dismissed", requestId: "" }));
  });

  for (const [offset, q] of remaining.entries()) {
    const outcome = await asks[offset]!;
    // A CHECKLIST NO HOST COULD DRAW (quality round P2, 2026-09-22): the
    // question was never shown, so it settles as UNANSWERED — and, unlike a
    // closed box, it does NOT stop the rest of the interview. A host without
    // custom components can still ask every radio question behind it.
    const skipped = unrenderable.has(firstIndex + offset);
    if (skipped) unrenderableChecklist = true;
    else if (outcome.answer !== undefined) anyDialog = true;
    const resolution = settleAnswer(firstIndex + offset, q, skipped ? undefined : outcome.answer, {
      interrupted: outcome.by === "interrupted",
      ...(skipped ? { unavailable: true } : {}),
    });
    if (resolution.stop) stopped = true;
    // OPENING THE NEXT GATE IS ALSO HOW A STOPPED INTERVIEW SETTLES ITS
    // LEFTOVERS. Once `stopped` is set, the next renderer returns immediately,
    // which resolves that question through the same race as any other and
    // writes its `request-settled` record (`dismissed` for a box the user
    // closed; an instruct has already settled the whole batch as
    // `interrupted`). So a question nobody will ever see stops ringing on the
    // project manager's receipt instead of hanging there unanswerable.
    gates[offset + 1]?.open();
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
  // A UI existed but no dialog ever reached the screen (the host refused to
  // render them, or none was raised at all): the questions still reached
  // nobody, so the agent carries them itself. A box the USER closed is not
  // this case — it rendered, they chose to stop (see `anyDialog`).
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
        (trimmedOptions ? `（有 ${trimmedOptions} 个问题的选项超过 ${MAX_CHOICE_OPTIONS} 个，已截断到前 ${MAX_CHOICE_OPTIONS} 个。）\n` : "") +
        (unrenderableChecklist
          ? "（这个环境画不出复选清单：上面的多选题没有展示给用户，请把它们的选项写进你的回复、让用户自己勾选。）\n"
          : "") +
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
    // UNCAPPED in the number of questions — and since 2026-09-17 uncapped in
    // fact, not just in prose: the cap that DROPPED a long list's tail is gone.
    // This description is the ONE full statement of the rule — it is what the
    // model reads at the moment it decides whether to ask. `LOOP_GOAL_MISSING_DIRECTIVE`
    // (lib/loop-goal.ts) carries a one-line summary and points here; do not let
    // that grow back into a second wording, which is how the old "ask fewer
    // questions" copy survived in two places at once.

    description:
      "Ask the user something — the ONE entry point for every moment that needs a human: " +
      "requirement ambiguity, a product/design decision, scope trade-offs, how to handle a " +
      "conflict, the goal interview. CALLING IT PAUSES: the loop stops until the user has " +
      "answered, so ask instead of guessing, and never write a question into your reply and end " +
      "the turn (that costs a whole iteration and the user may not even read it as a question). " +
      "EVERY QUESTION FOLLOWS THE GATE'S ONE TEMPLATE: 2–4 options, exactly one of them named " +
      "in `recommended` (the dialog marks it （推荐）), and the gate appends its own row " +
      "「✎ 不选，我说明原因」 which opens a MULTI-LINE editor (pi's own: newlines, paste, " +
      "`ctrl+g` to write it in $EDITOR) — so the user can always answer with a " +
      "reason instead of picking anything. A SINGLE-ANSWER question with fewer than 2 options, no " +
      "`recommended`, or a recommendation that is not one of the options REJECTS THE WHOLE " +
      "BATCH with no dialog shown — rewrite it and call again (a MULTIPLE-CHOICE question " +
      "carries `defaultChecked` instead of `recommended`; see below). There is no free-text question " +
      "any more. The gate runs the interview: one question at a time with its N / M progress, " +
      "and closing a box stops the rest — they come back unanswered. Every answer comes back at " +
      "once. Write " +
      "questions that stand on their own. A MULTIPLE-CHOICE question sets `multiple: true` and " +
      "MUST then give `defaultChecked` — the boxes the checklist opens TICKED, i.e. the group you " +
      "recommend, and exactly what a user who presses Enter without touching anything submits " +
      "(`[]` recommends none of them). Such a question needs NO `recommended`, and an empty " +
      "checklist answer is a real answer, not a skip. " +
      "WRITE OPTION TEXTS WITHOUT THEIR OWN NUMBERING — the gate prefixes every row with `A. `, " +
      "`B. ` … itself, so an option written `A. 甲` would reach the user as `A. A. 甲`. " +
      "When later questions depend on the answer to an " +
      "earlier one (pick an architecture, then its details), call ask_user AGAIN for the " +
      "follow-up round instead of guessing the branch. ASK AS MANY AS THE REQUIREMENT IS " +
      `WORTH: the interview itself is optional (no doubts ⇒ no questions), and there is NO cap on ` +
      "how many you may ask — one call may carry the whole list, and a follow-up round is for the " +
      "questions that DEPEND on an earlier answer. Never trim a real doubt to keep the count down; " +
      "agreeing on the requirement is " +
      "cheaper than building the wrong one.",

    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          text: Type.String({ description: "The complete question, with the context the user needs to decide" }),
          options: Type.Array(Type.String(), {
            description: `The choices: ${MAX_CHOICE_OPTIONS} at most, 2 at least, each one short enough to read in a dialog row. Write the TEXT ONLY — the gate adds the \`A. / B. \` numbering itself.`,
          }),
          recommended: Type.Optional(Type.String({
            description: "Your own recommendation — MUST be exactly one of `options` on a radio question (the gate rejects the batch otherwise). Optional on a `multiple` question, where `defaultChecked` plays that role.",
          })),
          multiple: Type.Optional(Type.Boolean({
            description: "This question takes SEVERAL answers — a checkbox list. Requires `defaultChecked`.",
          })),
          defaultChecked: Type.Optional(Type.Array(Type.String(), {
            description: "REQUIRED when `multiple` is true: the options the checklist opens TICKED — the group you recommend, and what a plain Enter submits. `[]` recommends none of them.",
          })),
        }),
        { description: "The questions, asked in order" },
      ),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doAskUser(deps, params, ctx),
  });

  registerConsentRequestTools(host, deps);
}
