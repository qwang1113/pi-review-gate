import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASYNC_PRECOMMIT_DETAIL_MAX,
  asyncPrecommitReportIsStale,
  buildAsyncPrecommitReport,
} from "../lib/async-precommit-report.ts";

const TREE_A = "d6d29d5a16e1aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TREE_B = "704dcd01e4d37e57db80fe51979564a582beaf54";
const DETAIL = 'review-gate: precommit for /repo: FAIL [lane full, tests: full] (1/4 checks failed). Failed: test.';

test("the content on disk unchanged: the notice stays loud and names the round", () => {
  const text = buildAsyncPrecommitReport({
    round: 3, verified: TREE_A, current: TREE_A, verdict: "FAIL", detail: DETAIL,
  });
  assert.match(text, /第 3 轮的后台 full precommit \*\*没过\*\*（FAIL）/);
  assert.match(text, /本轮不会产生可 ship 的 READY/);
  assert.match(text, /重新 `judge_submit\(\{role:"reviewer"\}\)`/);
  assert.match(text, /d6d29d5a16e1/); // identity, truncated
  assert.ok(text.includes(DETAIL)); // the run's own output travels verbatim
});

test("the content moved: downgraded — no current-round verdict, no re-verify instruction", () => {
  const text = buildAsyncPrecommitReport({
    round: 19, verified: TREE_A, current: TREE_B, verdict: "FAIL", detail: DETAIL,
  });
  assert.match(text, /第 19 轮/);
  assert.match(text, /它验证的是\*\*那一轮\*\*的内容（d6d29d5a16e1）/);
  assert.match(text, /工作区已经是 704dcd01e4d3/);
  assert.match(text, /不是当前这一轮的结论/);
  // The two claims that turned a stale notice into a contradiction are gone.
  assert.doesNotMatch(text, /本轮不会产生可 ship 的 READY/);
  assert.doesNotMatch(text, /重新 `judge_submit/);
  // …and the evidence is still there (downgraded, never suppressed).
  assert.ok(text.includes(DETAIL));
  assert.match(text, /precommit-last\.log 每次运行都覆盖/);
});

test("an unreadable fingerprint on either side never softens the notice", () => {
  for (const [verified, current] of [["", TREE_B], [TREE_A, ""], ["", ""]]) {
    assert.equal(asyncPrecommitReportIsStale({ verified, current }), false);
    const text = buildAsyncPrecommitReport({ round: 0, verified, current, verdict: "ERROR", detail: "" });
    assert.match(text, /本轮的后台 full precommit \*\*没过\*\*（ERROR）/);
    assert.match(text, /本轮不会产生可 ship 的 READY/);
  }
  // An unreadable VERIFIED side is said out loud rather than left blank, and
  // the loud form says WHY it is loud without claiming a match nobody measured.
  const unknown = buildAsyncPrecommitReport({ round: 0, verified: "", current: "", verdict: "ERROR", detail: "" });
  assert.match(unknown, /（未知）/);
  assert.match(unknown, /无法判断它是不是已被后续改动取代/);
  assert.doesNotMatch(unknown, /工作区仍是这次验证的那份内容/);
});

test("a non-FAIL verdict is reported by name, and a missing detail does not leave a dangling separator", () => {
  const text = buildAsyncPrecommitReport({
    round: 1, verified: TREE_A, current: TREE_A, verdict: "NO_CHECKS_RUN", detail: "",
  });
  assert.match(text, /（NO_CHECKS_RUN）/);
  assert.doesNotMatch(text, /\n\n$/);
});

test("the appended run output is bounded", () => {
  const text = buildAsyncPrecommitReport({
    round: 1, verified: TREE_A, current: TREE_B, verdict: "FAIL", detail: "x".repeat(9000),
  });
  assert.ok(text.endsWith("x".repeat(ASYNC_PRECOMMIT_DETAIL_MAX)));
  assert.ok(text.length < 9000);
});
