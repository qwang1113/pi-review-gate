import { test } from "node:test";
import assert from "node:assert/strict";

import { hostReasonEditor, raceReasonEditor, type CustomDialogHost } from "../lib/reason-editor.ts";
import { resolveQuestion } from "../lib/ask-user.ts";

// ---- the runtime import the extension now depends on ----

test("the value import the extension relies on resolves at runtime", async () => {
  // extensions/review-gate.ts imports `ExtensionEditorComponent` as a VALUE —
  // the repository's first runtime import from the pi package (everything else
  // is `import type`, which the compiler erases). A resolution failure there
  // breaks extension LOADING, which no grep-shaped test can see.
  const pi = await import("@earendil-works/pi-coding-agent");
  assert.equal(typeof pi.ExtensionEditorComponent, "function");
});

// ---- the box itself ----

/** A host harness: `interactive` runs the factory like pi's TUI does, `rpc`
 *  never calls it at all (pi dist/modes/rpc/rpc-mode.js). */
function harness(mode: "interactive" | "rpc" | "no-custom") {
  let componentDone: ((value: string | undefined) => void) | undefined;
  const calls: { built: string[]; fellBack: string[]; fallbackArgs: number[] } =
    { built: [], fellBack: [], fallbackArgs: [] };

  const custom: CustomDialogHost = async <T,>(
    factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown,
  ): Promise<T> => {
    if (mode === "rpc") return undefined as T;
    return await new Promise<T>((resolve) => {
      factory("tui", "theme", "keybindings", (value: T) => resolve(value));
    });
  };

  const editor = hostReasonEditor({
    ...(mode === "no-custom" ? {} : { custom }),
    // `arguments.length` is the point: pi's `ui.editor` takes a PREFILL in
    // second position, so a second argument here would land in the user's box.
    fallback: async function (title: string) {
      calls.fellBack.push(title);
      calls.fallbackArgs.push(arguments.length);
      return "理由写在宿主自己的框里";
    },
    build: (_tui, _keybindings, title, done) => {
      calls.built.push(title);
      componentDone = done;
      return "component";
    },
  });

  return {
    editor,
    calls,
    /** What the person does in the box: type and submit, or close it. */
    submit: (value: string | undefined) => componentDone?.(value),
  };
}

test("what the person submits is what comes back", async () => {
  const h = harness("interactive");
  const pending = h.editor("问题 1 / 3\n（不选的原因）");
  assert.deepEqual(h.calls.built, ["问题 1 / 3\n（不选的原因）"]);
  h.submit("第一行\n第二行");
  assert.equal(await pending, "第一行\n第二行", "multiple lines survive verbatim");
});

test("an abort takes the box down instead of waiting for the person", async () => {
  const h = harness("interactive");
  const controller = new AbortController();
  const pending = h.editor("head", { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, undefined);
});

test("an already-aborted signal settles without a human's answer", async () => {
  const h = harness("interactive");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await h.editor("head", { signal: controller.signal }), undefined);
});

test("the first settle wins — a late answer cannot resurrect a closed box", async () => {
  const h = harness("interactive");
  const controller = new AbortController();
  const pending = h.editor("head", { signal: controller.signal });
  h.submit("太晚了");
  controller.abort();
  assert.equal(await pending, "太晚了");
});

// ---- the two kinds of `undefined` (the P1 distinction) ----

test("a host that never runs the factory is NOT a person closing the box", async () => {
  // RPC mode: `ui.custom()` resolves undefined without calling the factory. Read
  // as a dismissal it would STOP the whole interview (lib/ask-user.ts
  // `resolveQuestion`), so it falls back to the host's own editor instead.
  const h = harness("rpc");
  assert.equal(await h.editor("head"), "理由写在宿主自己的框里");
  assert.deepEqual(h.calls.built, [], "no component was ever built");
  assert.deepEqual(h.calls.fellBack, ["head"]);
});

test("a person closing the box IS a dismissal — the fallback must not fire", async () => {
  const h = harness("interactive");
  const pending = h.editor("head");
  h.submit(undefined);
  assert.equal(await pending, undefined);
  assert.deepEqual(h.calls.built, ["head"]);
  assert.deepEqual(h.calls.fellBack, [], "the host rendered it — nobody gets a second box");
});

test("the fallback gets the TITLE ONLY — pi's second parameter is a prefill", async () => {
  // pi's signature is `editor(title, prefill)`: handing it our `{ signal }`
  // options object opens the user's box with `[object Object]` already typed
  // into it, and the fallback is exactly the path that does it (reviewer P2,
  // 2026-09-17). The seam's type says so; this pins it at runtime too.
  const h = harness("no-custom");
  const controller = new AbortController();
  assert.equal(await h.editor("head", { signal: controller.signal }), "理由写在宿主自己的框里");
  assert.deepEqual(h.calls.fallbackArgs, [1]);
});

test("a fallback answer is an ORDINARY answer — the interview is not stopped", async () => {
  // The other half of exit criterion 5: the whole point of telling "this host
  // never ran the factory" apart from "the user closed the box" is that the
  // first must not stop anything. `resolveQuestion` reads ONLY `undefined` as a
  // closed box (lib/ask-user.ts), so the contract is one assertion away.
  const h = harness("rpc");
  const picked = await h.editor("head");
  assert.equal(picked, "理由写在宿主自己的框里");
  const resolution = resolveQuestion({ text: "head", options: ["A", "B"], recommended: "A" }, picked);
  assert.equal(resolution.stop, undefined, "no closed box ⇒ no stop");
  assert.equal(resolution.answer.kind, "answered");
});

test("a host with no custom at all goes straight to its own editor", async () => {
  const h = harness("no-custom");
  assert.equal(await h.editor("head"), "理由写在宿主自己的框里");
  assert.deepEqual(h.calls.built, []);
});

// ---- the fallback's half of the abort (reviewer P1, 2026-09-18) ----

test("the fallback box cannot be taken down — but nothing keeps WAITING on it", async () => {
  // pi's `ui.editor(title, prefill)` takes no signal, so on this path the box
  // itself stays until the host closes it. The half the gate owns is that an
  // abort ENDS THE WAIT: without it an ESC left the tool parked on that box for
  // good — the same hang, one layer down.
  let answerLater: (value: string | undefined) => void = () => {};
  const box = new Promise<string | undefined>((resolve) => { answerLater = resolve; });
  const aborter = new AbortController();
  const raced = raceReasonEditor(box, aborter.signal);
  aborter.abort();
  assert.equal(await raced, undefined, "the wait ends at the abort, not at the host's box");
  answerLater("typed after the gate gave up");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("raceReasonEditor: the box wins when it answers, and a dead signal never waits", async () => {
  const live = new AbortController();
  assert.equal(await raceReasonEditor(Promise.resolve("写完了"), live.signal), "写完了");

  const same = Promise.resolve("x");
  assert.equal(raceReasonEditor(same, undefined), same, "no signal ⇒ the host's promise, untouched");

  const dead = new AbortController();
  dead.abort();
  assert.equal(await raceReasonEditor(Promise.resolve("x"), dead.signal), undefined,
    "an already-aborted signal resolves without waiting for anything");
});
