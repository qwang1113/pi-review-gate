/**
 * THE GATE'S USER-VISIBLE OUTPUT CHANNELS — the transcript notice and the ONE
 * dialog renderer, moved out of `extensions/review-gate.ts` (t5, wave 1).
 *
 * Two rules, both learned the hard way (the measurements live in
 * lib/renderer-mode.ts now):
 *
 *  1. LONG TEXT GOES TO THE TRANSCRIPT. A tall dialog used to make pi's
 *     DEFAULT renderer clear the screen and the scrollback every frame
 *     (measured: 29 of 30 frames) — that is why the session on that renderer
 *     is told to switch, and why anything long belongs in the transcript
 *     anyway: it scrolls, and the box does not.
 *  2. A DIALOG ONLY CARRIES THE DECISION. Every dialog goes through askChoice,
 *     which renders the gate's one question template (lib/choice-dialog.ts) —
 *     whole, no fitting (2026-09-16).
 *
 * (There is deliberately NO cap on a transcript notice any more — see
 * showToUser below. The sensitive-path DIALOG cap lives in
 * lib/consent-request-tools.ts with the tool that echoes the path —
 * SENSITIVE_PATH_DIALOG_MAX_CHARS.)
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

import {
  createDialogQueue,
  dialogNotifyDetail,
  dialogSignal,
  renderChoice,
  type AskChoiceOpts,
  type ChoiceSpec,
  type ChoiceUi,
} from "./choice-dialog.ts";
import {
  buildMultiChoiceBox,
  defaultMultiChoiceKey,
  MULTI_UNAVAILABLE,
  renderMultiChoice,
  type MultiChoiceHost,
  type MultiChoiceKeyReader,
  type MultiChoiceTheme,
  type MultiSelectOutcome,
} from "./multi-choice-dialog.ts";
import { editorTextOf, hostEditorFallback, hostReasonEditor, REASON_EDITOR_BACK, type CustomDialogHost } from "./reason-editor.ts";
import { raceWithUserProxy } from "./user-proxy.ts";
import type { UserNotifyKind } from "./user-notify.ts";
import type { DialogProxy } from "./dialog-proxy.ts";
import type { DesktopDialogRender } from "./gate-host-desktop-dialogs.ts";
import type { Ref, SessionHost } from "./session-host.ts";

/** pi's editor component CLASS, as a type — see `loadEditorComponent`. */
type EditorComponentCtor = (typeof import("@earendil-works/pi-coding-agent"))["ExtensionEditorComponent"];

/** The options every dialog call site may pass — the one shared shape. */
export type AskOpts = AskChoiceOpts;

type UiCtx = { ui?: ChoiceUi; signal?: AbortSignal };

/**
 * Put text in front of the USER, in the transcript, RIGHT NOW.
 *
 * WHY notify AND NOT pi.sendMessage: inside a tool the session is streaming,
 * so `sendMessage` is queued rather than rendered — `deliverAs: "followUp"`
 * lands in the follow-up queue, which agent-loop.ts drains when the agent
 * would otherwise STOP, i.e. it silently buys another LLM turn (fatal for a
 * tool whose whole job is to pause the loop) and still shows nothing until
 * the turn ends. `ui.notify` is synchronous: interactive mode appends a Text
 * to the chat container and requests a render, so the user sees it before
 * the confirm dialog that follows.
 *
 * NO CHARACTER CAP (user decision, 2026-09-14). This used to cut every notice
 * at 4000 characters with a `…（已截断）` tail — including the restatement,
 * goal and plan the user is being asked to APPROVE, i.e. exactly the text
 * they have to read. The cap was there for a geometry fear that does not
 * apply to the transcript: the chat container scrolls, and appending 400
 * rows in one shot triggers 0 full clears on the real renderer (measured,
 * see lib/renderer-mode.ts). The dialog is the constrained
 * surface, and it already keeps only the decision — the full text belongs
 * here, whole.
 *
 * Returns false when there is no UI to render into (headless): callers must
 * report that honestly instead of claiming the user saw something.
 */
export function showToUser(
  uiCtx: { ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } },
  lead: string,
  body: string,
): boolean {
  try {
    const notify = uiCtx.ui?.notify;
    if (!notify) return false;
    notify(`${lead}\n${body}`, "warning");
    return true;
  } catch {
    return false; // headless / no UI
  }
}

/**
 * A host context as the template's narrow `ui` seam.
 *
 * THE CAST IS LOAD-BEARING (2026-09-17): pi's `ExtensionContext.ui` no longer
 * SATISFIES `ChoiceUi` structurally, because the reason box's `editor` takes
 * a `signal` where pi's takes a prefill (see `reasonBoxUi` below for why).
 * Everything else on the seam is pi's own, unchanged. One named cast beats a
 * bare `as` at every call site, which is where it would drift.
 */
export function asChoiceHost(ctx: unknown): UiCtx {
  return ctx as UiCtx;
}

/**
 * pi's own multi-line editor component, resolved ON DEMAND.
 *
 * IT USED TO BE A MODULE-SCOPE VALUE IMPORT, and that broke the one case the
 * loader alias cannot cover: a host that loads this file OUTSIDE pi (the
 * install fixtures in test/, any tool that imports the extension to inspect
 * it) has no `@earendil-works/pi-coding-agent` to resolve, so a static import
 * fails at LOAD time — the whole extension refuses to load, to draw one
 * dialog. Resolved lazily it degrades instead: no component ⇒ the reason box
 * stays whatever the host's own `ui.editor` is (multi-line, no signal), and
 * nothing else changes.
 *
 * Inside pi the resolve always succeeds: the extension loader aliases this
 * specifier to pi's own entry (dist/core/extensions/loader.js `_aliases`,
 * `piCodingAgentEntry = packageIndex`), so no second copy is involved.
 */
let editorComponent: Promise<EditorComponentCtor | undefined> | undefined;
function loadEditorComponent(): Promise<EditorComponentCtor | undefined> {
  editorComponent ??= import("@earendil-works/pi-coding-agent")
    .then((pi) => pi.ExtensionEditorComponent)
    .catch(() => undefined);
  return editorComponent;
}

/**
 * The template's `ui` seam, with the reason box wired to pi's own editor.
 *
 * WHY NOT `ui.editor()` DIRECTLY (2026-09-17): pi's signature is
 * `editor(title, prefill?)` — no `signal`. This gate's dialog model rests on
 * a box being taken OFF THE SCREEN the moment the other side answers first
 * (lib/orchestrator-child-channel.ts), and a box that outlives its answer
 * collects typing nobody will ever read. The RULES for that — how the two
 * kinds of `undefined` are told apart, which host falls back to what, and how
 * the signal-less fallback still stops being waited on — live in
 * lib/reason-editor.ts; what is here is only the wiring.
 */
async function reasonBoxUi(host: ChoiceUi | undefined): Promise<(ChoiceUi & MultiChoiceHost) | undefined> {
  const pi = host as (ChoiceUi & {
    custom?: ExtensionUIContext["custom"];
    editor?: ExtensionUIContext["editor"];
  }) | undefined;
  // `hostEditorFallback` reads the signal ITSELF and never forwards our opts
  // into pi's prefill slot (lib/reason-editor.ts states the trap).
  const own = pi?.editor ? hostEditorFallback(pi.editor.bind(pi)) : undefined;
  const custom = pi?.custom;
  const Component = custom ? await loadEditorComponent() : undefined;
  // THE CHECKBOX SHAPE NEEDS NO PI COMPONENT CLASS (2026-09-22): it renders
  // its own lines and only borrows `ui.custom` to get on screen. So it is
  // wired off the SAME `custom` the reason box uses, before the branch below.
  const multiSelect: MultiChoiceHost["multiSelect"] = custom
    ? (title, spec, opts = {}) => mountMultiChoice(custom.bind(pi) as CustomDialogHost, title, spec, opts)
    : undefined;
  // No pi package to resolve, or no custom components on this host (RPC):
  // the host's own editor — ADAPTED, never handed our options.
  if (!custom || !Component) {
    const ui = own ? { ...host, editor: own } : host;
    return multiSelect ? { ...ui, multiSelect } : ui;
  }
  return {
    ...host,
    ...(multiSelect ? { multiSelect } : {}),
    editor: hostReasonEditor({
      custom: custom.bind(pi) as CustomDialogHost,
      ...(own ? { fallback: own } : {}),
      // THE BOX HAS TWO WAYS OUT (user decision, 2026-09-19): ESC hands the
      // question BACK to its own list — carrying whatever was typed so far,
      // so backing out costs nothing — while the LIST's ESC stays what it
      // always was, closing the question (and, in an interview, stopping the
      // rest). The component's own text is read defensively; see
      // `editorTextOf` (lib/reason-editor.ts).
      build: (tui, keybindings, title, done, prefill) => {
        const component = new Component(
          tui as ConstructorParameters<EditorComponentCtor>[0],
          keybindings as ConstructorParameters<EditorComponentCtor>[1],
          title,
          prefill,
          done,
          () => done(`${REASON_EDITOR_BACK}${editorTextOf(component)}`),
        );
        return component;
      },
    }),
  };
}

/**
 * MOUNT THE CHECKBOX BOX onto pi's `ui.custom` — the same abort discipline
 * the reason box has (lib/reason-editor.ts), for the same reason: this
 * gate's dialogs are raced against a project manager's answer, and a box
 * that cannot be taken down collects ticks nobody will ever read.
 *
 * A HOST THAT CANNOT MOUNT IT SAYS SO (RPC resolves `undefined` WITHOUT
 * running the factory). That `undefined` is then the caller's own “nothing
 * was shown”, never an invented empty answer.
 */
function mountMultiChoice(
  custom: CustomDialogHost,
  title: string,
  spec: ChoiceSpec,
  opts: { signal?: AbortSignal; back?: boolean } = {},
): Promise<MultiSelectOutcome | undefined> {
  if (opts.signal?.aborted) return Promise.resolve({ kind: "dismissed" });
  let ran = false;
  return custom<MultiSelectOutcome | undefined>((tui, theme, keybindings, done) => {
    ran = true;
    let settled = false;
    const finish = (value: MultiSelectOutcome | undefined) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    opts.signal?.addEventListener("abort", () => finish({ kind: "dismissed" }), { once: true });
    if (opts.signal?.aborted) queueMicrotask(() => finish({ kind: "dismissed" }));
    return buildMultiChoiceBox({
      title,
      spec,
      ...(opts.back ? { back: true } : {}),
      theme: theme as unknown as MultiChoiceTheme,
      readKey: multiChoiceKeyReader(keybindings),
      done: finish,
      requestRender: () => (tui as { requestRender?: () => void } | undefined)?.requestRender?.(),
    });
  }).then((outcome) =>
    // THE FACTORY NEVER RUNNING IS NOT A CLOSED BOX (reviewer P2, 2026-09-22):
    // RPC resolves `undefined` WITHOUT mounting anything, and reading that as
    // "the user dismissed it" stopped the whole interview over a question
    // nobody was ever shown.
    (ran ? outcome : { kind: "unavailable" as const }));
}

/**
 * THE HOST'S OWN KEY READER — pi's keybindings, so the checkbox box follows
 * whatever protocol the terminal negotiated and whatever the user rebound
 * `tui.select.*` to (reviewer P1, 2026-09-22: a terminal on the Kitty
 * keyboard protocol sends ESC as `\u001b[27u`, which a raw-byte table missed
 * entirely — the box could not be closed at all). Space is not one of pi's
 * select keybindings, so it falls through to the shape's own reader.
 */
function multiChoiceKeyReader(keybindings: unknown): MultiChoiceKeyReader {
  const kb = keybindings as { matches?: (data: string, keybinding: string) => boolean } | undefined;
  return (data) => {
    if (kb?.matches) {
      if (kb.matches(data, "tui.select.up")) return "up";
      if (kb.matches(data, "tui.select.down")) return "down";
      if (kb.matches(data, "tui.select.confirm")) return "enter";
      if (kb.matches(data, "tui.select.cancel")) return "escape";
    }
    return defaultMultiChoiceKey(data);
  };
}

/** What the dialog renderer needs from the session beyond the shared host. */
export interface GateDialogDeps {
  /** The timed-out stand-in (lib/dialog-proxy.ts). */
  proxy: DialogProxy;
  /** The banner that tells an absent user a box is waiting (lib/user-notify.ts). */
  raiseBanner(opts: { kind: UserNotifyKind; detail: string; blocking?: boolean }): unknown;
  /** WHEN THE GATE LAST GOT AN ANSWER OUT OF THE USER — the stall breaker reads it. */
  lastUserInteractionAt: Ref<string | undefined>;
  /** How long a box waits for the user before the stand-in (`userProxy.waitMinutes`). */
  proxyWaitMs(): number;
  /**
   * THE DESKTOP HOST'S PRESENTATION (lib/gate-host-desktop-dialogs.ts), present
   * iff the session runs under it. It replaces only the drawing below; the
   * queue, the banner, the proxy race and the record stay this function's.
   */
  desktopDialogs?: DesktopDialogRender;
}

export function createGateDialogs(host: SessionHost, deps: GateDialogDeps) {
  /**
   * ONE BOX AT A TIME, PER SESSION (2026-09-18).
   *
   * pi executes the tool calls of one assistant message in parallel, and the
   * host has one dialog slot: a second box REPLACES the first and the replaced
   * one's promise is never settled again — which hangs the first tool, the
   * batch, and the turn (lib/choice-dialog.ts `createDialogQueue` states the
   * measurement). Every dialog goes through `askChoice`, so the queue lives
   * here and covers all of them at once.
   */
  const scheduleDialog = createDialogQueue();

  /**
   * How many boxes are ON SCREEN right now — the one fact behind the pane's
   * `waiting-input` (lib/tmux-pane-state.ts): every dialog comes through here,
   * so no second detector is needed.
   */
  let dialogsOnScreen = 0;

  /**
   * THE one dialog renderer (user decision, 2026-09-08): the gate's question
   * template, whole. Every dialog in the extension — and
   * every dialog in the tool modules that inject this function — comes
   * through here, so exactly one shape ever reaches the screen: 2–4 options
   * (the recommended one marked), the `✎ 不选，我说明原因` row, and a text
   * box when that row is picked. A yes/no box is not a thing any more.
   *
   * NOTHING IS FITTED, NOTHING IS CUT (user decision, 2026-09-16). Both halves
   * used to be budgeted against the real terminal — a five-row dialog spends
   * rows the old two-row confirm never did — because an oversized dialog pushed
   * the animating spinner out of the viewport and made pi's DEFAULT renderer
   * clear the screen and the scrollback every frame (measured: 29 of 30 frames).
   * That cost landed on the lines the user is CONFIRMING, and the renderer the
   * user runs (fullscreen: the host owns the screen and scrolls) never had the
   * problem — so the budget is gone and a session that is NOT on it is told
   * once instead (lib/renderer-mode.ts).
   *
   * WHAT STILL MATTERS HERE IS ORDER. Callers put the facts being confirmed
   * BEFORE the agent's own text, because the box is read top-down and the
   * thing being approved should not come after the label of the thing it is
   * about (lib/loop-goal.ts states the policy for the goal dialog).
   *
   * `signal` is what lets an ORCHESTRATOR's answer take the box off the
   * user's screen: pi dismisses the dialog when it aborts, and the resolved
   * `undefined` is then read as "somebody else settled this", not as a
   * refusal (lib/orchestrator-child-channel.ts owns that distinction).
   */
  async function askDialog(
    uiCtx: UiCtx,
    spec: ChoiceSpec,
    opts: AskOpts = {},
    /**
     * WHICH OF THE TWO SHAPES IS DRAWN (2026-09-22). Everything else about a
     * dialog is shape-free — the queue, the banner, the timed-out proxy
     * race and the record all belong to the WORDS being asked, not to how the
     * rows are drawn — so the shape travels as this one flag rather than as a
     * second copy of a five-hundred-line function.
     */
    checkbox = false,
  ): Promise<string | undefined> {
    // THE HOST'S SIGNAL IS READ HERE, BEFORE QUEUEING: `ExtensionContext.signal`
    // is a getter that asserts the context is still alive, and a dialog can wait
    // a long time for its turn. Read once and captured, not read again inside.
    //
    // THE RACE'S OWN SIGNAL IS MERGED IN HERE (2026-09-19), not at the queue
    // call alone: the queue slot and the box on screen are the SAME dialog, and
    // both have to end when the race settles. A proxy answer that released the
    // queue wait while leaving `renderChoice` on screen would be a dialog the
    // user can still type into and nobody will ever read.
    const settledBy = new AbortController();
    const signal = dialogSignal(uiCtx.signal, opts.signal, settledBy.signal);
    // A BOX THAT IS ALREADY SETTLED IS NOT RAISED, AND NOT ANNOUNCED: the queue
    // drops a waiter whose signal aborts (before OR during its turn) without
    // raising anything or ringing a banner — telling the user to come answer
    // something nobody is asking any more is the same mistake.
    // THE WINDOW STARTS WHEN THE BOX DOES (2026-09-19). `askChoice` may be one
    // of several calls in a single assistant message, and the dialog queue shows
    // ONE box at a time — so a queued question could reach its window's end
    // before the user ever saw it (review round 1). `displayed` resolves inside
    // the queue work below, which is the moment this dialog owns the screen.
    let markDisplayed: (() => void) | undefined;
    const displayed = new Promise<void>((resolve) => { markDisplayed = resolve; });
    // WHICH REPO, BOUND WHEN THE BOX APPEARS (review round 3 P1). The answer
    // belongs to the work this session was doing when the user would have SEEN
    // the question — and the active repo follows the edits, so a dialog
    // queued behind another one, or a proxy wait, can move it. Bound on
    // the queue's own turn and never re-read: fixing the sidecar's repo while
    // the proxy reads a different one is the same defect from the other end.
    //
    // AN EXPLICIT `opts.repo` OUTRANKS IT AND NEVER DRIFTS (review round 4 P1):
    // callers that KNOW which repo their question is about (a goal, a
    // restatement) must say so — a secondary repo's question can be raised
    // without that repo ever having been the active one, and then the fallback
    // would file a stand-in's answer under the wrong sidecar AND point the proxy
    // at the wrong repository.
    const dialogRootNow = (): string => {
      const repos = host.repos();
      return opts.repo ?? repos.active ?? repos.primary;
    };
    let dialogRoot = dialogRootNow();
    const asked = scheduleDialog(async () => {
      markDisplayed?.();
      dialogRoot = dialogRootNow();
      // KIND THREE of three, and this is the whole wiring for it: EVERY dialog
      // any session shows comes through this function, so "the gate has stopped
      // and is waiting for the human" needs no second detector. The policy
      // decides who may be told (a child session's questions belong to its
      // manager, and the manager answers them) and the throttle keeps a
      // re-opened dialog from ringing again.
      //
      // WAITING, NOT ANSWERING: the banner goes out as the box appears, which
      // is the moment somebody who is NOT at the terminal needs to know. The
      // phrase being asked for rides along (body included) — a banner whose
      // whole text is "问题 1 / 4" tells the user nothing about what they are
      // being asked (user report, 2026-09-18).
      deps.raiseBanner({
        kind: "needs-user",
        detail: dialogNotifyDetail(spec, opts.body),
      });
      // NO BUDGET, NO TRUNCATION (user decision, 2026-09-16). This used to fit
      // the title and the body into a rendered-row budget, because a dialog tall
      // enough to push the spinner out of the viewport made pi's DEFAULT renderer
      // clear the screen and the scrollback every frame. That cost landed on the
      // lines the user is confirming — a long repo path could take the station
      // line and the audit line with it while the dialog went on asking for
      // approval — and the renderer the user runs (`fullscreen`, the host owns
      // the screen and scrolls) never had the problem. A session that is NOT on
      // it is told once instead: see lib/renderer-mode.ts.
      //
      // THE HOST'S ABORT SIGNAL TRAVELS WITH IT (2026-09-18): `uiCtx.signal` is
      // `ExtensionContext.signal`, which is what an ESC aborts. Passing only the
      // caller's own signal left a box on screen after the user cancelled the
      // run, and the tool waiting on it never came back.
      const drawOpts = {
        ...(opts.body === undefined ? {} : { body: opts.body }),
        ...(opts.back ? { back: true } : {}),
        ...(signal ? { signal } : {}),
      };
      const desktop = deps.desktopDialogs;
      const answerBox = desktop ? undefined : await reasonBoxUi(uiCtx.ui);
      dialogsOnScreen += 1;
      const answer = await (desktop
        ? desktop(spec, { ...drawOpts, checkbox })
        : checkbox
        ? renderMultiChoice(answerBox, spec, drawOpts)
        : renderChoice(answerBox, spec, drawOpts)).finally(() => { dialogsOnScreen -= 1; });
      // THE ONE PLACE A GATE↔USER EXCHANGE IS RECORDED (2026-09-16). Every
      // dialog the gate shows — ask_user's interview, the restatement / goal /
      // plan approvals, the consent boxes for sensitive edits and scope limits —
      // reaches the user through this function, so this is where "the user
      // answered" becomes a fact. Its one reader is the stall breaker
      // (`stallInMotion`): a live negotiation must not be mistaken for a session
      // that has stopped moving (measured: 80 minutes of goal negotiation
      // tripped the breaker and was reported as a provider failure).
      //
      // Only a REAL answer counts: a dismissed box (undefined) is not the user
      // engaging with the gate — and neither is the checklist sentinel, which
      // says the opposite of “the user did something”: NO host could draw that
      // question (quality round P2, 2026-09-22).
      if (answer !== undefined && answer !== MULTI_UNAVAILABLE) {
        deps.lastUserInteractionAt.current = new Date().toISOString();
      }
      return answer;
    }, signal);

    // THE HAND-OFF (2026-09-19, user decision; five minutes since 2026-09-29).
    // The box above is unchanged — not closed, and a user who answers first
    // wins outright. The end of `userProxy.waitMinutes` no longer means "nobody
    // will ever answer": `arbiter` reads this session's own context and takes the
    // user's place, and what it answers is recorded as a proxy decision (see
    // lib/dialog-proxy.ts) so the user can find it afterwards.
    //
    // THE RACE IS NOT WRITTEN HERE. Timing, the row check and the
    // human-always-wins rule live in lib/user-proxy.ts, the only arrangement
    // that makes them testable without waiting out the window — this function is
    // the single render point for all twelve dialogs and stays wiring.
    const decided = await raceWithUserProxy<string>({
      direct: asked,
      displayed,
      // EVERY BOX, NO EXCEPTIONS (2026-09-29, user decision): the stage
      // checklist, authorization questions and the relocation offer used to opt
      // out, and an unattended session then sat on them for good.
      options: spec.options,
      ...(spec.defaultChecked === undefined ? {} : { multiple: true }),
      startProxy: (signal) => deps.proxy.answerFor(spec, opts.body, dialogRoot, signal),
      timeoutMs: deps.proxyWaitMs(),
    });
    // Whatever settled it, the box is done — see `settledBy` above.
    settledBy.abort();
    if (decided.byProxy !== undefined && decided.answer !== undefined) {
      deps.proxy.record(spec, decided.answer, decided.byProxy, dialogRoot);
      try { opts.onProxyAnswer?.(); } catch { /* the caller's own bookkeeping */ }
    } else if (decided.proxyFailed === true) {
      // NOBODY DECIDED, AND THE USER IS NOT HERE. Say so: a dialog that times
      // out silently is indistinguishable, to the user, from one that was
      // answered — and this is the only moment the fact exists. The gate does
      // NOT invent an answer here; the conservative landing is the absence of
      // one, which every caller already reads correctly.
      //
      // THE CALLER IS TOLD TOO (review round 3 P1): `undefined` alone cannot
      // distinguish this from a dismissed box, and for a consent request those
      // two must not have the same consequence — a decline LOCKS the request
      // for the session, and a timeout is not a decline.
      try {
        host.ctx()?.ui.notify(
          `review-gate: 对话框「${spec.title}」等满设定时长无人作答，arbiter 也没能代答` +
            `（${decided.proxyFailure ?? "原因未知"}）—— 这一项**还没有任何决定**，等你回来处理。`,
          "warning",
        );
      } catch { /* headless */ }
      // The caller hears WHY too: the agent's reply must not read as "the gate
      // would not decide" when a model was out of quota (2026-09-29).
      try { opts.onUndecided?.(decided.proxyFailure); } catch { /* the caller's own bookkeeping */ }
    }
    return decided.answer;
  }

  /** The radio shape — one answer (lib/choice-dialog.ts). */
  async function askChoice(
    uiCtx: UiCtx,
    spec: ChoiceSpec,
    opts: AskOpts = {},
  ): Promise<string | undefined> {
    return askDialog(uiCtx, spec, opts, false);
  }

  /** The checkbox shape — several answers (lib/multi-choice-dialog.ts). */
  async function askMultiChoice(
    uiCtx: UiCtx,
    spec: ChoiceSpec,
    opts: AskOpts = {},
  ): Promise<string | undefined> {
    return askDialog(uiCtx, spec, opts, true);
  }

  return { askChoice, askMultiChoice, dialogsOnScreen: (): number => dialogsOnScreen };
}
