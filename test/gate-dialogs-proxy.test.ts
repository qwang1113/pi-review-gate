import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createGateDialogs } from "../lib/gate-dialogs.ts";
import type { SessionHost } from "../lib/session-host.ts";
import { PROXY_ANSWER_TIMEOUT_MS } from "../lib/user-proxy.ts";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function dialogs(recorded: string[]) {
  const host = {
    repos: () => ({ active: "/repo", primary: "/repo" }),
    ctx: () => undefined,
  } as unknown as SessionHost;
  return createGateDialogs(host, {
    proxy: {
      answerFor: async (spec) => ({ choice: spec.options[0]!, rationale: "stand-in" }),
      record: (_spec, answer) => { recorded.push(answer); },
      all: () => [],
    },
    raiseBanner: () => undefined,
    lastUserInteractionAt: { current: undefined },
  });
}

// A box nobody answers: it only ever settles by being taken off the screen.
const absentUser = {
  select: (_title: string, _options: string[], opts?: { signal?: AbortSignal }) =>
    new Promise<string | undefined>((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
    }),
};

test("N6: an arbiter stand-in answer tells the caller through `onProxyAnswer`", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const recorded: string[] = [];
    let byArbiter = false;
    const asking = dialogs(recorded).askChoice(
      { ui: absentUser } as never,
      { title: "允许吗？", options: ["允许", "拒绝"], recommended: "拒绝" },
      { onProxyAnswer: () => { byArbiter = true; } },
    );
    await flush();
    mock.timers.tick(PROXY_ANSWER_TIMEOUT_MS);
    const answer = await asking;
    assert.equal(answer, "允许");
    assert.deepEqual(recorded, ["允许"]);
    assert.equal(byArbiter, true, "the caller learns the answer was the arbiter's");
  } finally {
    mock.timers.reset();
  }
});

test("N6: the user's own answer never calls `onProxyAnswer`", async () => {
  let byArbiter = false;
  const answer = await dialogs([]).askChoice(
    { ui: { select: async () => "A. 允许" } } as never,
    { title: "允许吗？", options: ["允许", "拒绝"], recommended: "拒绝" },
    { onProxyAnswer: () => { byArbiter = true; } },
  );
  assert.equal(answer, "A. 允许", "the row the user picked, as the host returned it");
  assert.equal(byArbiter, false);
});
