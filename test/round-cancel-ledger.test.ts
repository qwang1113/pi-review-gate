import test from "node:test";
import assert from "node:assert/strict";
import { cancelledDuringBootText, createRoundCancelLedger, dispatchFailureDetail } from "../lib/round-cancel-ledger.ts";

test("the ledger answers by role or by judge id, per repo, and a new dispatch forgets it", () => {
  const ledger = createRoundCancelLedger();
  ledger.note("/a", { role: "reviewer", judgeId: "rg-r", why: "lane FAIL" });
  assert.equal(ledger.read("/a", "reviewer", undefined)?.why, "lane FAIL");
  assert.equal(ledger.read("/a", undefined, "rg-r")?.role, "reviewer");
  assert.equal(ledger.read("/b", "reviewer", undefined), undefined, "another repo sees nothing");
  ledger.forget("/a", "reviewer");
  assert.equal(ledger.read("/a", "reviewer", undefined), undefined);
});

test("dispatch failure copy: cancelled during boot vs. a genuinely silent pane vs. no pane at all", () => {
  // The measured sequence: the dispatch forgets the role, the pane opens, the
  // lane fails and cancels the reviewer (note), the boot check times out.
  const ledger = createRoundCancelLedger();
  ledger.note("/a", { role: "reviewer", judgeId: "rg-old", why: "stale" });
  ledger.forget("/a", "reviewer"); // dispatch start
  const bootTimeout = { deliveryFailed: true, paneId: "%84", error: "boot timeout" };
  const silent = dispatchFailureDetail(ledger, "/a", "reviewer", bootTimeout) ?? "";
  assert.match(silent, /保留着/, "no cancellation during boot ⇒ the pane really is kept");
  assert.doesNotMatch(silent, /stale/, "the previous round's tombstone was forgotten");
  ledger.note("/a", { role: "reviewer", judgeId: "rg-new", why: "全量 precommit 没过（NO_CHECKS_RUN）" });
  const cancelled = dispatchFailureDetail(ledger, "/a", "reviewer", bootTimeout) ?? "";
  assert.match(cancelled, /被门禁取消/);
  assert.match(cancelled, /NO_CHECKS_RUN/);
  assert.doesNotMatch(cancelled, /保留着/);
  assert.equal(dispatchFailureDetail(ledger, "/a", "reviewer", { error: "no tmux" }), "no tmux",
    "a pane that never opened keeps its own error");
});

test("a round cancelled while booting is reported as cancelled, never as a kept pane to wait on", () => {
  const text = cancelledDuringBootText("%84", "全量 precommit 没过（NO_CHECKS_RUN）");
  assert.match(text, /%84/);
  assert.match(text, /被门禁取消/);
  assert.match(text, /NO_CHECKS_RUN/);
  assert.match(text, /已收回/);
  assert.match(text, /下一步：/);
  assert.doesNotMatch(text, /保留着/);
});
