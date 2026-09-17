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
   * TITLE ONLY — NEVER THESE OPTIONS (reviewer P2, 2026-09-17). pi's
   * `ui.editor(title, prefill?: string)` takes a PREFILL in its second
   * position, so passing our `{ signal }` through makes the user's box open
   * prefilled with `[object Object]` — and the fallback is exactly the path
   * that calls it. This box has no signal to pass anyway (that is the whole
   * reason `custom` is preferred); the signature says so instead of leaving a
   * trap for the next caller.
   */
  fallback?: (title: string) => Promise<string | undefined>;
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
    if (!custom) return fallback?.(title);
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
    return fallback?.(title);
  };
}
