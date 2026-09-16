import test from "node:test";
import assert from "node:assert/strict";

import {
  QUALITY_ROLE,
  buildQualityAuditTask,
  decideQualityHold,
  isSourceFile,
  qualityPrecondition,
  qualityRoundSkip,
  qualityStandingFor,
  roundCancelParty,
  roundCancelPlan,
  skippedQualityRecord,
} from "../lib/quality-round.ts";
import { QUALITY_ROUND_SPEC, REVIEW_ROUND_SPEC } from "../lib/audit-round-specs.ts";

test("isSourceFile: unknown = code (fail-closed), only enumerated non-code is skipped", () => {
  // Languages this gate has never been told about are CODE. The gate installs
  // on Node, front-end, Rust, Shell, Python and midway repos alike, so the
  // only answer that stays correct in an unseen repo is the exclusion list.
  for (const f of ["lib/a.ts", "src/App.vue", "crates/x/src/main.rs", "scripts/setup.sh", "app/main.py", "src/a.proto", "Makefile", "Dockerfile"]) {
    assert.equal(isSourceFile(f), true, `${f} must count as code`);
  }
  for (const f of ["README.md", "docs/x.mdx", "package.json", "pnpm-lock.lock", "Cargo.lock", "a.yaml", "b.toml", "logo.svg", "LICENSE", "docs/CHANGELOG", ".gitignore"]) {
    assert.equal(isSourceFile(f), false, `${f} must count as non-code`);
  }
});

test("qualityRoundSkip: empty range and documentation-only rounds skip with a reason", () => {
  const empty = qualityRoundSkip([]);
  assert.equal(empty.skip, true);
  assert.match(empty.reason ?? "", /空范围轮/);

  const docsOnly = qualityRoundSkip(["README.md", "docs/a.md", "package.json"]);
  assert.equal(docsOnly.skip, true);
  assert.match(docsOnly.reason ?? "", /非代码文件/);

  assert.equal(qualityRoundSkip(["README.md", "lib/a.ts"]).skip, false);
});

test("qualityStandingFor: the reviewer is dispatched only on a pass bound to THIS head", () => {
  const head = "a".repeat(40);
  const files = ["lib/a.ts"];

  const missing = qualityStandingFor({ head, files, quality: undefined });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.reason, /还没有质量轮的结论/);

  const stale = qualityStandingFor({ head, files, quality: { verdict: "READY", commitSha: "b".repeat(40) } });
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? "" : stale.reason, /已经过期/);

  const blocked = qualityStandingFor({ head, files, quality: { verdict: "BLOCKED", commitSha: head } });
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? "" : blocked.reason, /BLOCKED/);

  const pass = qualityStandingFor({ head, files, quality: { verdict: "READY", commitSha: head } });
  assert.deepEqual(pass, { ok: true, basis: "pass" });
});

test("qualityStandingFor: a code-free round is permitted WITHOUT a quality record (recorded as skipped)", () => {
  const files = ["README.md", "docs/x.md"];
  const result = qualityStandingFor({ head: "c".repeat(40), files, quality: undefined });
  assert.deepEqual(result, { ok: true, basis: "skipped" });

  // …but a code round with a stale record is still refused, and that ordering
  // is the whole point: the skip must never launder a stale pass.
  const staleWithCode = qualityStandingFor({
    head: "d".repeat(40),
    files: [...files, "lib/a.ts"],
    quality: { verdict: "READY", commitSha: "c".repeat(40) },
  });
  assert.equal(staleWithCode.ok, false);
});

test("skippedQualityRecord: a skip is a READY bound to the head, marked as a skip", () => {
  const rec = skippedQualityRecord({ head: "e".repeat(40), tree: "f".repeat(40), reason: "本轮只改动了非代码文件", at: "2026-09-15T00:00:00.000Z" });
  assert.equal(rec.verdict, "READY");
  assert.equal(rec.skipped, true);
  assert.equal(rec.commitSha, "e".repeat(40));
  assert.match(rec.skipReason ?? "", /非代码文件/);
});

// ---------------------------------------------------------------------------
// THE CANCEL MATRIX (2026-09-16): all three parties start together, so the
// question is no longer "who runs first" but "who stops whom". Every pair gets
// an assertion — a matrix tested only on its READY row is not tested at all.
// ---------------------------------------------------------------------------

test("roundCancelPlan: a non-READY QUALITY round stops the reviewer AND the lane", () => {
  for (const verdict of ["BLOCKED", "NEEDS_HUMAN", ""]) {
    assert.deepEqual(roundCancelPlan({ party: "quality", verdict }), {
      cancelQuality: false, cancelReviewer: true, abortLane: true,
    }, `${verdict}: the reviewer's pane dies and the lane is aborted`);
  }
  // A READY cancels nothing: the functional round is exactly what the gate is
  // still waiting for.
  assert.deepEqual(roundCancelPlan({ party: "quality", verdict: "READY" }), {
    cancelQuality: false, cancelReviewer: false, abortLane: false,
  });
});

test("roundCancelPlan: a non-READY REVIEWER stops the quality round AND the lane", () => {
  for (const verdict of ["BLOCKED", "NEEDS_HUMAN"]) {
    assert.deepEqual(roundCancelPlan({ party: "reviewer", verdict }), {
      cancelQuality: true, cancelReviewer: false, abortLane: true,
    }, `${verdict}: the quality pane dies and the lane is aborted`);
  }
  assert.deepEqual(roundCancelPlan({ party: "reviewer", verdict: "READY" }), {
    cancelQuality: false, cancelReviewer: false, abortLane: false,
  });
});

test("roundCancelPlan: the FAILED LANE stops only the reviewer — the quality round carries on", () => {
  // The asymmetry is the user's requirement: the quality judge reads code, and
  // a failing test suite says nothing about the code's quality. `abortLane` is
  // false because the lane has already landed — there is nothing left to abort.
  assert.deepEqual(roundCancelPlan({ party: "lane", verdict: "FAIL" }), {
    cancelQuality: false, cancelReviewer: true, abortLane: false,
  });
  // A PASSING lane cancels nothing, and ONLY that exact word does — an
  // unreadable verdict is never PASS (the same fail-closed direction the
  // judges' rows take on a missing READY).
  assert.deepEqual(roundCancelPlan({ party: "lane", verdict: "PASS" }), {
    cancelQuality: false, cancelReviewer: false, abortLane: false,
  });
  for (const verdict of ["", "no verdict", "ERROR"]) {
    assert.deepEqual(roundCancelPlan({ party: "lane", verdict }), {
      cancelQuality: false, cancelReviewer: true, abortLane: false,
    }, `${verdict}: an unreadable lane verdict is not PASS`);
  }
});

test("roundCancelParty: the audit KIND is translated to the matrix's party — `review` is the reviewer's round", () => {
  // THE P1 THIS PINS (functional round, 2026-09-16): the extension compared the
  // settle's kind against `"reviewer"`, but a functional round settles as kind
  // `"review"`, so the matrix's second row was unreachable — a BLOCKED reviewer
  // neither stopped the quality round nor aborted the lane, while the receipt
  // told the agent it had.
  assert.equal(roundCancelParty(QUALITY_ROUND_SPEC.kind), "quality");
  assert.equal(roundCancelParty(REVIEW_ROUND_SPEC.kind), "reviewer");
  assert.equal(REVIEW_ROUND_SPEC.kind, "review", "the kind and the role are DIFFERENT words — that is the whole bug");
  for (const other of ["goal", "plan", "advice", undefined, ""]) {
    assert.equal(roundCancelParty(other as string | undefined), undefined, `${String(other)} cancels nothing`);
  }
});

test("roundCancelPlan: ONE table covers all three parties — no row is implemented twice", () => {
  // The quality round caught the lane's row living twice (2026-09-16): a hand-
  // written `if (verdict !== "PASS") cancel(...)` at the lane's landing beside
  // this table. The table is only worth something if every row goes through
  // it, so this pins the THREE-PARTY shape the extension relies on.
  const rows = ([
    { party: "quality", verdict: "BLOCKED" },
    { party: "reviewer", verdict: "BLOCKED" },
    { party: "lane", verdict: "FAIL" },
  ] as const).map((landing) => roundCancelPlan(landing));
  assert.deepEqual(rows.map((r) => r.cancelReviewer), [true, false, true]);
  assert.deepEqual(rows.map((r) => r.cancelQuality), [false, true, false]);
  assert.deepEqual(rows.map((r) => r.abortLane), [true, true, false]);
});

test("qualityPrecondition: satisfied / still owed / disproven — the one reading both rules share", () => {
  const pass = { ok: true as const, basis: "pass" as const };
  assert.equal(qualityPrecondition({ standing: pass, qualityRoundInFlight: false }), "ok");
  assert.equal(qualityPrecondition({ standing: pass, qualityRoundInFlight: true }), "ok", "a standing answer wins");
  const pending = { ok: false as const, reason: "还没有质量轮的结论" };
  assert.equal(qualityPrecondition({ standing: pending, qualityRoundInFlight: true }), "pending");
  // NOBODY IS COMING BACK with a verdict (the pane died, or this round never
  // dispatched one): fail closed rather than park the round forever.
  assert.equal(qualityPrecondition({ standing: pending, qualityRoundInFlight: false }), "veto");
});

test("decideQualityHold: record / hold / refuse — and it is the same reading the parking rule uses", () => {
  const pass = { ok: true as const, basis: "pass" as const };
  const pending = { ok: false as const, reason: "还没有质量轮的结论" };
  assert.equal(decideQualityHold({ standing: pass, qualityRoundInFlight: false }), "record");
  // THE HEADLINE CASE OF THE PARALLEL DESIGN: the reviewer concluded first, the
  // quality judge is still thinking — hold the conclusion, never record it yet.
  assert.equal(decideQualityHold({ standing: pending, qualityRoundInFlight: true }), "hold");
  // A standing recorded for ANOTHER head (the PREVIOUS round's BLOCKED) does
  // not answer THIS round's question: this round dispatched its own quality
  // judge, so the conclusion waits for that one instead of being refused on an
  // older record.
  assert.equal(
    decideQualityHold({ standing: { ok: false, reason: "质量轮上一轮判了 BLOCKED" }, qualityRoundInFlight: true }),
    "hold",
  );
  assert.equal(decideQualityHold({ standing: pending, qualityRoundInFlight: false }), "refuse");
});

test("buildQualityAuditTask: points at the checklist, carries the range and the stream — never the reviewer's brief", () => {
  const task = buildQualityAuditTask({
    range: "111111111111..222222222222",
    files: ["lib/a.ts", "lib/b.ts"],
    streamPath: "/repo/.pi/review-stream/x-quality.jsonl",
    rulesPath: "docs/code-quality-rules.md",
    changeIndex: "CHANGE INDEX (2 file(s) in 111111111111..222222222222):\n1. git diff 111111111111..222222222222 -- lib/a.ts",
  });

  assert.match(task, /quality auditor/);
  assert.match(task, /docs\/code-quality-rules\.md/);
  assert.match(task, /ask_user/);
  assert.match(task, /THE WHOLE REPOSITORY IS YOUR REFERENCE/);
  assert.match(task, /111111111111\.\.222222222222/);
  assert.match(task, /CHANGE INDEX/);
  assert.match(task, /x-quality\.jsonl/);
  // The functional brief belongs to the OTHER round: its "Review for:"
  // sentence would have this judge grading test coverage and doc sync.
  assert.doesNotMatch(task, /Review for: correctness/);
});

test("buildQualityAuditTask: without a change index it still lists the files", () => {
  const task = buildQualityAuditTask({
    range: "a..b",
    files: ["lib/a.ts"],
    streamPath: "/tmp/s.jsonl",
    rulesPath: "docs/code-quality-rules.md",
  });
  assert.match(task, /Changed files \(1\) in a\.\.b/);
  assert.match(task, /- lib\/a\.ts/);
});
