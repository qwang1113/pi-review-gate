import { test } from "node:test";
import assert from "node:assert/strict";

import { hostEditorFallback, hostReasonEditor, raceReasonEditor, type CustomDialogHost } from "../lib/reason-editor.ts";
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
    // `fallbackArgs` is the point: the fallback is handed OUR opts (it has to
    // be — that is the only way it can honor an abort, reviewer P1 2026-09-18),
    // and it is `hostEditorFallback`'s job, not the fallback's, to keep them
    // out of pi's PREFILL slot. `calls.fallbackArgs` pins which side of that
    // line this call is on.
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
  assert.deepEqual(h.calls.fallbackArgs, [2],
    "the fallback is handed our opts so it can honor an abort — the prefill slot is protected by hostEditorFallback instead");
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

test("hostEditorFallback: pi's prefill slot stays EMPTY, and the abort still lands", async () => {
  // Two rules, one adapter (reviewer P1, 2026-09-18): pi's `ui.editor` takes a
  // PREFILL second, so our opts must never reach it — and the signal it does
  // read must end the wait, which is all this signal-less box allows.
  const seen: { titles: string[]; prefill: (string | undefined)[] } = { titles: [], prefill: [] };
  const hostEditor = (title: string, prefill?: string) => {
    seen.titles.push(title);
    seen.prefill.push(prefill);
    return new Promise<string | undefined>(() => {});
  };
  const box = hostEditorFallback(hostEditor);

  const live = new AbortController();
  const pending = box("理由", { signal: live.signal });
  live.abort();
  assert.equal(await pending, undefined, "the wait ends at the abort");
  assert.deepEqual(seen.titles, ["理由"]);
  assert.deepEqual(seen.prefill, [undefined],
    "our opts must never land in pi's prefill position — the box would open with `[object Object]`");

  const dead = new AbortController();
  dead.abort();
  assert.equal(await box("理由", { signal: dead.signal }), undefined);
  assert.deepEqual(seen.titles, ["理由"], "an already-aborted signal does not open the box at all");
});

test("an already-aborted signal must not BUILD the component either (reviewer P1, 2026-09-18)", async () => {
  // The custom path is the one that MOUNTS a component: finishing it a tick
  // later still puts a box on the user's screen that nobody is waiting for.
  const h = harness("interactive");
  const dead = new AbortController();
  dead.abort();
  assert.equal(await h.editor("head", { signal: dead.signal }), undefined);
  assert.deepEqual(h.calls.built, [], "the host was never asked to build anything");
});

test("the RPC path hands the abort through to the host's own box (reviewer P1, 2026-09-18)", async () => {
  // THE COMBINATION THAT WAS BROKEN: `hostReasonEditor` called its fallback with
  // the title ALONE, so the RPC path (custom present, factory never run) reached
  // a fallback that had no signal — and every abort landed as a promise nobody
  // could settle. Fixing `raceReasonEditor` alone left this path broken.
  let opened = 0;
  const editor = hostReasonEditor({
    custom: async <T,>() => undefined as T,
    fallback: hostEditorFallback(() => {
      opened += 1;
      return new Promise<string | undefined>(() => {});
    }),
    // Never reached on this path: the factory above does not run.
    build: () => "component",
  });

  const aborter = new AbortController();
  const pending = editor("head", { signal: aborter.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  aborter.abort();
  assert.equal(await pending, undefined, "the wait ends at the abort, on this path too");
  assert.equal(opened, 1, "…and it was the host's own box that was pending");
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
  const raced = raceReasonEditor(() => box, aborter.signal);
  aborter.abort();
  assert.equal(await raced, undefined, "the wait ends at the abort, not at the host's box");
  answerLater("typed after the gate gave up");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("an aborted signal must not OPEN the box at all (reviewer P1, 2026-09-18)", async () => {
  // Taking a promise told the caller to create the box first, so an ESC that had
  // already been pressed popped a text box nothing would ever read. The box is
  // opened by a thunk precisely so this branch can decline to open it.
  const dead = new AbortController();
  dead.abort();
  let opened = 0;
  assert.equal(
    await raceReasonEditor(() => { opened += 1; return Promise.resolve("x"); }, dead.signal),
    undefined,
  );
  assert.equal(opened, 0, "nothing is rendered for a dialog nobody is waiting for");
});

test("raceReasonEditor: the box wins when it answers, and a dead signal never waits", async () => {
  const live = new AbortController();
  assert.equal(await raceReasonEditor(() => Promise.resolve("写完了"), live.signal), "写完了");

  const same = Promise.resolve("x");
  assert.equal(raceReasonEditor(() => same, undefined), same, "no signal ⇒ the host's promise, untouched");

  const dead = new AbortController();
  dead.abort();
  assert.equal(await raceReasonEditor(() => Promise.resolve("x"), dead.signal), undefined,
    "an already-aborted signal resolves without waiting for anything");
});
