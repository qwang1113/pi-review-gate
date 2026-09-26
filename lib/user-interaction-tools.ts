/**
 * The user-interaction family's deps contract and its single registration
 * entry point: `ask_user` — the ONE way the agent reaches the human — plus
 * the two consent tools in lib/consent-request-tools.ts.
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
 * WHERE THE INTERVIEW LIVES: `ask_user`'s execution side (`doAskUser` —
 * pausing the loop, persisting between questions, the either-side race) is
 * lib/ask-user-interview.ts. This module keeps the contract every member of
 * the family is written against and the tool's agent-facing surface (its
 * name, description and schema).
 *
 * SHARED STATE, NOT A COPY: `deps.state()` is a getter, because the extension
 * REBINDS its state object (session_start reloads it) and clears
 * `state.pausedQuestion` from several other places. A captured reference
 * would leave these modules writing into a dead object while the gate reads a
 * live one.
 *
 * BEHAVIOR IS FROZEN: these modules were moved verbatim out of the extension.
 * Tool names, schemas, reply texts, `details` fields and error branches are
 * the ones the agent-facing contract already documents; changing any of them
 * is a separate, deliberate change.
 */

import { Type } from "typebox";

import type { ToolHost } from "./tool-host.ts";
import type { GateState } from "./gate-state.ts";
import type { ChannelDialogOutcome, ChannelDialogRequest } from "./orchestrator-child-channel.ts";
import type { SensitiveGrant } from "./sensitive-grant.ts";
import type { AskChoiceOpts, ChoiceSpec } from "./choice-dialog.ts";
import { registerConsentRequestTools } from "./consent-request-tools.ts";
import { doAskUser } from "./ask-user-interview.ts";
import { MAX_CHOICE_OPTIONS } from "./choice-dialog.ts";
import type { MULTI_UNAVAILABLE } from "./multi-choice-dialog.ts";

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
