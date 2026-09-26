/**
 * THE PANE STATE the tmux sidebar reads (s1, 2026-09-27): the word, and when
 * it is written. A fake runner records every argv; nothing touches tmux.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { TmuxRunner } from "../lib/orchestrator-tmux.ts";
import {
  createPaneStateReporter,
  decidePaneState,
  PANE_STATE_REFRESH_MS,
  type PaneStateFacts,
} from "../lib/tmux-pane-state.ts";

const quiet: PaneStateFacts = { dialogOpen: false, judging: false, streaming: false, completed: false };

test("the word: dialog > judge > streaming > done > idle", () => {
  assert.equal(decidePaneState({ ...quiet, dialogOpen: true, judging: true, streaming: true }), "waiting-input");
  assert.equal(decidePaneState({ ...quiet, judging: true, streaming: true }), "waiting-judge");
  assert.equal(decidePaneState({ ...quiet, streaming: true, completed: true }), "working");
  assert.equal(decidePaneState({ ...quiet, completed: true }), "done");
  assert.equal(decidePaneState(quiet), "idle");
});

function harness(opts: { pane?: string; fail?: boolean } = {}) {
  const calls: string[][] = [];
  let now = 1_000_000;
  let facts = { ...quiet };
  const run: TmuxRunner = (argv) => {
    calls.push([...argv]);
    return { ok: !opts.fail, stdout: "", stderr: "" };
  };
  const reporter = createPaneStateReporter({
    run,
    pane: () => ("pane" in opts ? opts.pane : "%5"),
    identity: () => ({ sessionId: "sid-1", repo: "/w/repo", kind: "loop" }),
    facts: () => facts,
    now: () => now,
  });
  return {
    reporter,
    calls,
    advance: (ms: number) => { now += ms; },
    set: (next: Partial<PaneStateFacts>) => { facts = { ...quiet, ...next }; },
  };
}

test("identity once, the state on change or every 30s — pane-scoped, never global", () => {
  const h = harness();
  h.reporter.tick();
  const options = h.calls.map((argv) => argv[4]);
  assert.deepEqual(options, ["@rg_sid", "@rg_repo", "@rg_kind", "@rg_state", "@rg_state_at"]);
  assert.ok(h.calls.every((argv) => argv[0] === "set" && argv[1] === "-p" && argv[3] === "%5" && !argv.includes("-g")));
  assert.equal(h.calls[3][5], "idle");
  assert.equal(h.calls[4][5], "1000", "epoch SECONDS");

  h.calls.length = 0;
  h.advance(5_000);
  h.reporter.tick();
  assert.equal(h.calls.length, 0, "nothing changed, nothing written");

  h.set({ dialogOpen: true });
  h.reporter.tick();
  assert.deepEqual(h.calls.map((argv) => [argv[4], argv[5]]).slice(0, 1), [["@rg_state", "waiting-input"]]);
  assert.equal(h.calls.length, 2, "a change writes the word and the stamp, not the identity again");

  h.calls.length = 0;
  h.advance(PANE_STATE_REFRESH_MS);
  h.reporter.tick();
  assert.equal(h.calls.length, 2, "the 30s refresh keeps the stamp young");
});

test("outside tmux nothing is written; a failed write is retried next tick", () => {
  const outside = harness({ pane: undefined });
  outside.reporter.tick();
  assert.equal(outside.calls.length, 0);

  const failing = harness({ fail: true });
  failing.reporter.tick();
  const first = failing.calls.length;
  failing.reporter.tick();
  assert.ok(failing.calls.length > first, "not remembered as written");
});

test("clear takes every option back with set -pu", () => {
  const h = harness();
  h.reporter.tick();
  h.calls.length = 0;
  h.reporter.clear();
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every((argv) => argv[0] === "set" && argv[1] === "-pu" && argv[3] === "%5"));
});
