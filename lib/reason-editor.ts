/**
 * The gate's MULTI-LINE reason box — pi's own editor, with the abort wired in.
 *
 * WHY THIS EXISTS (user decision, 2026-09-17: "我希望和 pi 本身的输入框行为保持
 * 一致 —— 可以多行，可以用 vim 控制"). The box behind `✎ 不选，我说明原因` used
 * to be pi's single-line `ui.input`: fine for a word, useless for an
 * explanation, and no place to write one in.
 *
 * WHY IT IS BUILT HERE INSTEAD OF `ui.editor(title, prefill?)`: that signature
 * takes no `signal`, and this gate's whole dialog model rests on a box being
 * taken OFF THE SCREEN the moment the other side answers
 * (lib/orchestrator-child-channel.ts — the human-vs-orchestrator race, and an
 * instruct interrupting a running turn). A box that outlives its answer
 * collects typing nobody will ever read, while the person typing believes it
 * counted. pi's own `ExtensionEditorComponent` IS that same box — newlines,
 * paste, `ctrl+g` into $EDITOR — it just lets the caller own the abort.
 *
 * THE FALLBACK IS A HOST FACT, NOT A NICETY. RPC mode's `ui.custom()` resolves
 * `undefined` WITHOUT ever running the factory (pi
 * dist/modes/rpc/rpc-mode.js), while `ui.editor()` there IS forwarded to the
 * host. Reading that `undefined` as "the user closed the box" would STOP the
 * whole interview (lib/ask-user.ts `resolveQuestion` treats a closed box as
 * the way out), so the two cases are told apart by one fact — did the factory
 * run:
 *
 *   ran        ⇒ a `undefined` comes from a PERSON (ESC).
 *   never ran  ⇒ this host cannot render a custom component at all.
 *
 * THE FALLBACK HOST CANNOT BE TAKEN DOWN, ONLY ABANDONED (2026-09-18): its box
 * is pi's signal-less `ui.editor`, so {@link raceReasonEditor} ends the GATE's
 * wait on an abort while the box itself stays until the host closes it. The
 * difference between the two halves is deliberate and stated where it matters.
 *
 * Everything here is pure: the component arrives as `build`, and the host's two
 * calls arrive as `custom` / `fallback`. `extensions/review-gate.ts` supplies
 * all three and owns nothing of the rule; this file owns the rule and needs no
 * pi import to state it.
 */

/** pi's `ui.custom`, narrowed to what this module needs. */
export type CustomDialogHost = <T>(
  factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown,
) => Promise<T>;

/** What the template's `ChoiceUi.editor` is called with. */
export type ReasonEditor = (title: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;

export interface ReasonEditorHost {
  /** pi's `ui.custom`. Absent on a host that cannot render custom components. */
  custom?: CustomDialogHost;
  /**
   * The host's OWN box, for a host that cannot render `custom`
   * (lib/reason-editor.ts's module doc says which one that is).
   *
   * IT RECEIVES OUR `opts` — AND MUST NEVER FORWARD THEM TO PI (reviewer P1,
   * 2026-09-18). pi's `ui.editor(title, prefill?)` takes a PREFILL in second
   * position, so anything that lands there opens the user's box with
   * `[object Object]` already typed into it. The adapter below reads `signal`
   * out of `opts` and passes ONLY the title on; this parameter exists so the
   * fallback can end its own wait on an abort at all — a fallback called with
   * the title alone had no signal, and every abort from the user landed as a
   * promise nobody could settle.
   */
  fallback?: ReasonEditor;
  /**
   * Builds the component. The extension passes pi's own
   * `ExtensionEditorComponent`; a test passes anything that calls `done`.
   */
  build(
    tui: unknown,
    keybindings: unknown,
    title: string,
    done: (value: string | undefined) => void,
  ): unknown;
}

/**
 * pi's own `ui.editor`, as it really is: a title and an OPTIONAL PREFILL.
 *
 * Named so the one place that adapts it can say what it is adapting — and so
 * the trap above (our `opts` in the prefill position) has a type to break
 * against rather than a comment to trust.
 */
export type HostEditor = (title: string, prefill?: string) => Promise<string | undefined>;

/**
 * The one reason box every gate dialog uses.
 *
 * `done` is called EXACTLY ONCE, whichever side wins: the abort that takes the
 * box down (or an already-aborted signal), the user submitting, or the user
 * cancelling. A host that got the promise settled twice would resolve a dialog
 * that is already gone.
 */
export function hostReasonEditor(host: ReasonEditorHost): ReasonEditor {
  const { custom, fallback, build } = host;
  return async (title, opts) => {
    if (!custom) return fallback?.(title, opts);
    let ran = false;
    const answer = await custom<string | undefined>((tui, _theme, keybindings, done) => {
      ran = true;
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        done(value);
      };
      opts?.signal?.addEventListener("abort", () => finish(undefined), { once: true });
      // An ALREADY-aborted signal never fires that listener, and `done` is not
      // called from inside the factory itself — the host may not have mounted
      // the component yet.
      if (opts?.signal?.aborted) queueMicrotask(() => finish(undefined));
      return build(tui, keybindings, title, finish);
    });
    if (ran || answer !== undefined) return answer;
    // THE FACTORY NEVER RAN (RPC): the host's own box takes over — WITH our
    // opts, so the fallback can end its own wait (reviewer P1, 2026-09-18).
    return fallback?.(title, opts);
  };
}

/**
 * THE FALLBACK HOST'S EDITOR, ADAPTED: pi's box, and an abort we can honor.
 *
 * THE TRAP IS THE SECOND PARAMETER. pi's `ui.editor(title, prefill?)` takes a
 * PREFILL there, so handing it our `{ signal }` opens the user's box with
 * `[object Object]` already typed in (reviewer P2, 2026-09-17) — this function
 * passes the TITLE ALONE, always, and reads the signal itself.
 *
 * AND WHAT IT DOES WITH THAT SIGNAL is {@link raceReasonEditor}: the box stays
 * (it cannot be taken down), but nothing waits on it after an abort — the
 * defect the round-1 review found twice: first as a dropped signal
 * (extensions/review-gate.ts adapted the editor as `(title) => editor(title)`),
 * then as an eager side effect (the box was created before the race began, so
 * an already-cancelled dialog still popped a box on screen). A THUNK fixes the
 * second: a dead signal never opens anything at all.
 */
export function hostEditorFallback(editor: HostEditor): ReasonEditor {
  return (title, opts) => raceReasonEditor(() => editor(title), opts?.signal);
}

/**
 * THE FALLBACK'S HALF OF THE ABORT: stop WAITING on a box we cannot take down.
 *
 * The fallback path is pi's own `ui.editor(title, prefill)`, which takes NO
 * signal (the module doc says why `custom` is preferred) — so an abort cannot
 * remove that box from the screen. What the gate still owes the user is that
 * NOTHING WAITS ON IT: an ESC has to end the tool call, not park it on a box
 * the user has already cancelled (reviewer P1, 2026-09-18: the merged host
 * signal reached the renderer and died here).
 *
 * The abandoned box is not ours to dispose: if the user answers it later, it
 * settles a promise nobody is listening to, and the host closes it its own way.
 * That is the honest shape of a host limitation we cannot fix from here — the
 * important half (the gate stops waiting) is the one this function owns.
 *
 * THE BOX IS OPENED BY A THUNK, and that is load-bearing (reviewer P1,
 * 2026-09-18): taking a promise told the caller to CREATE the box first, so an
 * ESC that had already been pressed still popped a text box on screen — one
 * that nothing would ever read. A signal that is already aborted must not open
 * anything at all.
 */
export function raceReasonEditor(
  openBox: () => Promise<string | undefined>,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (!signal) return openBox();
  if (signal.aborted) return Promise.resolve(undefined);
  const box = openBox();
  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    void box.then(finish, () => finish(undefined));
  });
}
