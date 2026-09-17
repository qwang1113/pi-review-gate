import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASYNC_PRECOMMIT_DETAIL_MAX,
  asyncPrecommitReportIsStale,
  buildAsyncPrecommitPass,
  buildAsyncPrecommitReport,
  buildParkedReadyReplayNotice,
} from "../lib/async-precommit-report.ts";

const TREE_A = "d6d29d5a16e1aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TREE_B = "704dcd01e4d37e57db80fe51979564a582beaf54";
const DETAIL = 'review-gate: precommit for /repo: FAIL [lane full, tests: full] (1/4 checks failed). Failed: test.';

test("a PASS says it LANDED — the one event a session waiting on this lane has", () => {
  // 2026-09-16. Only failures used to reach this module, so a session told
  // 「正在等 precommit lane 落地（HELD）」 had nothing to wake on: `judge_wait`'s
  // event sources are the JUDGE's, and this was not one of them (measured:
  // 6m47s, notification session 2026-09-15).
  const same = buildAsyncPrecommitPass({ round: 2, verified: TREE_A, current: TREE_A });
  assert.match(same, /第 2 轮的后台 full precommit \*\*PASS\*\*/);
  assert.match(same, /不用再等它/, "the whole reason this notice exists");
  assert.match(same, /d6d29d5a16e1/, "identity of the content it verified");
  // It is NOT a failure notice: no verdict to act on, no run output to read.
  assert.doesNotMatch(same, /没过|FAIL|重新 `judge_submit/);

  // The content moved ⇒ the same downgrade the failure notice does, because
  // claiming this PASS covers what is on disk now would be the same lie.
  const stale = buildAsyncPrecommitPass({ round: 2, verified: TREE_A, current: TREE_B });
  assert.match(stale, /第 2 轮启动时\*\*那份内容（d6d29d5a16e1）/);
  assert.match(stale, /投递这一刻工作区是（704dcd01e4d3）/);
  assert.match(stale, /不用为它做任何事/);
  assert.doesNotMatch(stale, /这份内容（d6d29d5a16e1）通过了|本轮已经通过/);
});

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

test("the content moved: downgraded — no current-round verdict, but still actionable", () => {
  const text = buildAsyncPrecommitReport({
    round: 19, verified: TREE_A, current: TREE_B, verdict: "FAIL", detail: DETAIL,
  });
  assert.match(text, /第 19 轮/);
  assert.match(text, /那次验证的是 \*\*第 19 轮启动时\*\*那份内容（d6d29d5a16e1）/);
  assert.match(text, /投递这一刻工作区是（704dcd01e4d3），两者不同/);
  // The claim that turned a stale notice into a contradiction is gone…
  assert.doesNotMatch(text, /重新 `judge_submit/);
  assert.doesNotMatch(text, /本轮不会产生可 ship 的 READY/);
  assert.doesNotMatch(text, /这份内容（d6d29d5a16e1）没通过验证/);
  // …but a difference has TWO causes the tree cannot tell apart, so the
  // finding is never waved away as "old, ignore it" either.
  assert.match(text, /别把它当成与己无关/);
  assert.match(text, /你在这条 lane 跑的时候改的/);
  assert.match(text, /lane 自己的 lint:fix 改写的/);
  assert.doesNotMatch(text, /白做工|不必为这条/);
  // …and the same holds when the caller cannot name the round at all: round 0
  // renders the label "本轮", so a sentence that used the label here would BE
  // the forbidden current-round claim (round-2 P2).
  const unnamed = buildAsyncPrecommitReport({
    round: 0, verified: TREE_A, current: TREE_B, verdict: "FAIL", detail: DETAIL,
  });
  assert.match(unnamed, /那次验证所属的那一轮不会产生可 ship 的 READY/);
  assert.doesNotMatch(unnamed, /本轮不会产生可 ship 的 READY/);

  // The evidence is still there (downgraded, never suppressed).
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

// ---------------------------------------------------------------------------
// the REPLAY notice (2026-09-15) — the mirror image of the failure notice

test("the matrix's lane notes travel WITH the notice — the lane row has no sibling verdict", () => {
  // Quality round P2, 2026-09-16: a judge's cancel note rides its sibling
  // verdict's standard report; the lane's row has no sibling, so dropping the
  // return value here meant 「正在跑的全量 precommit 已终止」 reached nobody and
  // the agent saw only "precommit failed".
  const text = buildAsyncPrecommitReport({
    round: 2,
    verified: "f".repeat(40),
    current: "f".repeat(40),
    verdict: "FAIL",
    detail: "1 test failed",
    laneNotes: ["已终止 reviewer 的这一轮（内容要改）", "  "],
  });
  assert.match(text, /已终止 reviewer 的这一轮（内容要改）/);
  assert.ok(text.indexOf("已终止") < text.indexOf("1 test failed"),
    "the note comes before the raw output — it is the reason, not an appendix");
  assert.ok(!text.includes("\n  \n"), "blank notes are dropped, not printed as a dangling line");

  const without = buildAsyncPrecommitReport({
    round: 2, verified: "f".repeat(40), current: "f".repeat(40), verdict: "FAIL", detail: "x",
  });
  assert.ok(!without.includes("已终止"), "absent notes change nothing");
});

test("the replay notice names the round and the tree, and says nothing was wrong", () => {
  const notice = buildParkedReadyReplayNotice({
    round: 4,
    tree: TREE_A,
    recorded: "review-gate: recorded verdict READY for /repo (round 4/15, findings: 1). Next: run precommit for this same repo.",
  });
  assert.match(notice, /第 4 轮 READY 现在已重新记录/);
  // The tree identifies WHICH content was replayed, short-prefixed exactly like
  // the failure notice so the two read as a pair.
  assert.match(notice, /d6d29d5a16e1/);
  assert.ok(!notice.includes(TREE_A), "the full digest is noise here — the failure notice settled that");
  // WHY IT WAS HELD. Without this the reader sees an unexplained state flip,
  // which is the failure measured on 2026-09-12 (late notices arriving after
  // the records said PASS + READY cost two review rounds).
  assert.match(notice, /不是内容问题/);
  assert.match(notice, /验证还没跑完/);
  // And the recorder's own reply closes it: the verdict, the counts, the next
  // step.
  assert.match(notice, /recorded verdict READY/);
  assert.match(notice, /findings: 1/);
});
