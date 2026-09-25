import test from "node:test";
import assert from "node:assert/strict";
import { cancelledDuringBootText, createRoundCancelLedger } from "../lib/round-cancel-ledger.ts";

test("the ledger answers by role or by judge id, per repo, and a new dispatch forgets it", () => {
  const ledger = createRoundCancelLedger();
  ledger.note("/a", { role: "reviewer", judgeId: "rg-r", why: "lane FAIL" });
  assert.equal(ledger.read("/a", "reviewer", undefined)?.why, "lane FAIL");
  assert.equal(ledger.read("/a", undefined, "rg-r")?.role, "reviewer");
  assert.equal(ledger.read("/b", "reviewer", undefined), undefined, "another repo sees nothing");
  ledger.forget("/a", "reviewer");
  assert.equal(ledger.read("/a", "reviewer", undefined), undefined);
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
