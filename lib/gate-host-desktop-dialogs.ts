/**
 * THE GATE'S DIALOGS ON THE DESKTOP HOST — `dialog.open` / `dialog.close`
 * (docs/desktop/host-protocol.md §7).
 *
 * ONLY THE PRESENTATION CHANGES. Under tmux the question template is drawn by
 * pi's TUI (`renderChoice` / `renderMultiChoice`); here the same `ChoiceSpec`
 * travels to the desktop client as structured fields and the client draws it
 * (letters, the （推荐） marker, the ✎ row and its reason editor, the back row).
 * What comes back is turned into EXACTLY the line the TUI path returns, so
 * everything downstream — `parseChoice`, `parseMultiChoice`, the interview, the
 * proxy race, the channel — sees one shape and cannot tell the hosts apart.
 * No rule of the template is restated here: the rows, the decline line and the
 * multi label all come from lib/choice-dialog.ts and lib/multi-choice-dialog.ts.
 *
 * WHO ANSWERS FIRST STILL WINS ON THE GATE'S SIDE (§7.3). The caller's signal
 * aborts when the other side settled the question (project manager, arbiter,
 * ESC); this module then sends `dialog.close` so the client takes the card
 * down, and returns `undefined` — the same thing an aborted TUI box returns.
 * The client's late answer (`aborted`, or even a `picked` that crossed the
 * close on the wire) is dropped.
 *
 * FAIL-CLOSED (§8). A reply that is not an answer the box OFFERED
 * (`checkDialogOutcome`), `unavailable`, or a lost connection is NOT the user
 * closing the box: a checklist returns `MULTI_UNAVAILABLE` (the question goes
 * back to the agent, the same landing a TUI host without custom components
 * has), and a radio question stays UNANSWERED on the human side until the
 * race ends it — the project manager and the stand-in can still answer, and
 * the gate never invents an answer for the user.
 */

import { BACK_ROW, declineReason, declineRowOf, optionRow, type ChoiceSpec } from "./choice-dialog.ts";
import { checkDialogOutcome, type Params, type Result } from "./desktop-host-protocol.ts";
import type { DesktopClient } from "./desktop-host-client.ts";
import { defaultCheckedOf, MULTI_UNAVAILABLE, multiSelectionLabel } from "./multi-choice-dialog.ts";

export interface DesktopDialogOpts {
  signal?: AbortSignal;
  body?: string;
  back?: boolean;
  /** Draw the checkbox shape (the spec carries `defaultChecked`). */
  checkbox?: boolean;
}

/** Same contract as `renderChoice` / `renderMultiChoice`: the line, or `undefined`. */
export type DesktopDialogRender = (spec: ChoiceSpec, opts?: DesktopDialogOpts) => Promise<string | undefined>;

/** The wire request for one question. */
export function dialogParamsOf(dialogId: string, spec: ChoiceSpec, opts: DesktopDialogOpts = {}): Params<"dialog.open"> {
  const common = {
    dialogId,
    title: spec.title,
    ...(opts.body === undefined ? {} : { body: opts.body }),
    options: [...spec.options],
    declineRow: declineRowOf(spec),
    back: opts.back === true,
  };
  return opts.checkbox
    ? { shape: "multi", ...common, defaultChecked: defaultCheckedOf(spec) }
    : { shape: "choice", ...common, ...(spec.recommended === undefined ? {} : { recommended: spec.recommended }) };
}

/** Nothing the human side can be held to — see the module note. */
const UNANSWERED = Symbol("unanswered");

/** The client's answer as the line the TUI would have returned. */
async function lineOf(
  params: Params<"dialog.open">,
  spec: ChoiceSpec,
  outcome: Result<"dialog.open">,
): Promise<string | undefined | typeof UNANSWERED> {
  if (checkDialogOutcome(params, outcome) !== undefined) return UNANSWERED;
  switch (outcome.kind) {
    case "picked":
      return optionRow(outcome.option, spec.recommended, spec.options.indexOf(outcome.option));
    case "checked":
      return multiSelectionLabel(outcome.options, spec.options);
    case "decline": {
      // The reason box already ran on the client; its text goes through the
      // template's own decline step, so the line is written in one place.
      const step = await declineReason({ editor: async () => outcome.reason }, spec);
      return step.kind === "answer" ? step.picked : UNANSWERED;
    }
    case "back":
      return BACK_ROW;
    case "dismissed":
    case "aborted":
      return undefined;
    case "unavailable":
      return UNANSWERED;
  }
}

export function createDesktopDialogs(deps: { client: Pick<DesktopClient, "dialog" | "request"> }): DesktopDialogRender {
  let seq = 0;
  return async function render(spec, opts = {}) {
    const { signal } = opts;
    if (signal?.aborted) return undefined;
    seq += 1;
    const params = dialogParamsOf(`dlg-${seq}`, spec, opts);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const first = await Promise.race([deps.client.dialog(params), aborted]);
      if (first === "aborted") {
        // Idempotent on the client: a card already answered is still `ok`.
        deps.client.request("dialog.close", { dialogId: params.dialogId });
        return undefined;
      }
      const line = first.ok ? await lineOf(params, spec, first.result) : UNANSWERED;
      if (line !== UNANSWERED) return line;
      if (opts.checkbox) return MULTI_UNAVAILABLE;
      // A radio question nobody could answer here: leave it to the race.
      if (signal) await aborted;
      return undefined;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
}
