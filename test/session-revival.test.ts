import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideRevival,
  buildRevivalMessage,
  REVIVAL_INTERVAL_MS,
  type RevivalInputs,
} from "../lib/session-revival.ts";

const now = 1_000_000_000_000;

function inputs(over: Partial<RevivalInputs> = {}): RevivalInputs {
  return {
    mode: "loop",
    exitProblems: () => ["code review gate is PENDING"],
    idle: true,
    humanStop: { aborted: false, awaitingAnswer: false, bypassed: false, arbitrationPaused: false },
    handedOff: false,
    now,
    intervalMs: REVIVAL_INTERVAL_MS,
    ...over,
  };
}

describe("decideRevival — identity", () => {
  it("revives a loop session whose contract is unmet", () => {
    const d = decideRevival(inputs());
    assert.equal(d.revive, true);
    assert.match(d.reason, /还差 1 项/);
  });

  it("revives an orchestrator session whose contract is unmet", () => {
    const d = decideRevival(inputs({ mode: "orchestrator", exitProblems: () => ["task t3 is running"] }));
    assert.equal(d.revive, true);
  });

  it("does not revive explore — ending is its whole point", () => {
    const d = decideRevival(inputs({ mode: "explore", exitProblems: () => ["anything"] }));
    assert.equal(d.revive, false);
    assert.match(d.reason, /没有退出契约/);
  });

  it("does not revive normal", () => {
    assert.equal(decideRevival(inputs({ mode: "normal" })).revive, false);
  });
});

describe("decideRevival — consent (human stops outrank the invariant)", () => {
  it("honours ESC — silence until the user's next message", () => {
    const d = decideRevival(inputs({ humanStop: { ...inputs().humanStop, aborted: true } }));
    assert.equal(d.revive, false);
    assert.match(d.reason, /ESC/);
  });

  it("honours a pending ask_user answer", () => {
    const d = decideRevival(
      inputs({ humanStop: { ...inputs().humanStop, awaitingAnswer: true } }),
    );
    assert.equal(d.revive, false);
    assert.match(d.reason, /ask_user/);
  });

  it("honours /gate-bypass", () => {
    const d = decideRevival(inputs({ humanStop: { ...inputs().humanStop, bypassed: true } }));
    assert.equal(d.revive, false);
    assert.match(d.reason, /bypass/);
  });

  it("honours an arbitration pause", () => {
    const d = decideRevival(
      inputs({ humanStop: { ...inputs().humanStop, arbitrationPaused: true } }),
    );
    assert.equal(d.revive, false);
    assert.match(d.reason, /仲裁/);
  });

  it("checks consent BEFORE the problem list — a paused session is not described as revived", () => {
    const d = decideRevival(
      inputs({ humanStop: { ...inputs().humanStop, aborted: true }, exitProblems: () => [] }),
    );
    assert.equal(d.revive, false);
  });
});

describe("decideRevival — need and timing", () => {
  it("does not revive a session that has satisfied its contract", () => {
    const d = decideRevival(inputs({ exitProblems: () => [] }));
    assert.equal(d.revive, false);
    assert.match(d.reason, /已满足/);
  });

  it("does not revive a working session", () => {
    const d = decideRevival(inputs({ idle: false }));
    assert.equal(d.revive, false);
    assert.match(d.reason, /工作中/);
  });

  it("does not revive inside the throttle window", () => {
    const d = decideRevival(inputs({ lastRevivalAt: now - 10_000 }));
    assert.equal(d.revive, false);
    assert.match(d.reason, /节流/);
  });

  it("revives once the throttle window has elapsed", () => {
    const d = decideRevival(inputs({ lastRevivalAt: now - REVIVAL_INTERVAL_MS - 1 }));
    assert.equal(d.revive, true);
  });

  it("revives immediately when it has never been revived before", () => {
    assert.equal(decideRevival(inputs({ lastRevivalAt: undefined })).revive, true);
  });

  it("is lazy — the expensive problems thunk is not called when a cheap guard stops it", () => {
    let calls = 0;
    const d = decideRevival(inputs({
      idle: false, // cheap guard fires before the thunk
      exitProblems: () => { calls += 1; return ["x"]; },
    }));
    assert.equal(d.revive, false);
    assert.equal(calls, 0, "the fingerprint-costing thunk must not run for a working session");
  });
});

describe("decideRevival — handoff", () => {
  it("does not revive a session that handed its orchestration over", () => {
    const d = decideRevival(inputs({ mode: "orchestrator", handedOff: true }));
    assert.equal(d.revive, false);
    assert.match(d.reason, /交接/);
  });
});

describe("buildRevivalMessage", () => {
  it("lists what is missing and what to do, per mode", () => {
    const loop = buildRevivalMessage("loop", ["a", "b"]);
    assert.match(loop, /\[REVIEW_GATE_REVIVE\]/);
    assert.match(loop, /judge_submit/);
    const orch = buildRevivalMessage("orchestrator", ["c"]);
    assert.match(orch, /orchestrator_wait/);
    assert.match(orch, /declare_done/);
  });

  it("never mentions a round number — this path spends no budget", () => {
    const msg = buildRevivalMessage("loop", ["x"]);
    assert.doesNotMatch(msg, /continuation \d+/);
    assert.doesNotMatch(msg, /\/\d+\)/);
  });
});
