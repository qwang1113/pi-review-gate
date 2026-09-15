import test from "node:test";
import assert from "node:assert/strict";

import {
  QUALITY_ROLE,
  buildQualityAuditTask,
  isSourceFile,
  qualityFollowUp,
  qualityRoundSkip,
  qualityStandingFor,
  skippedQualityRecord,
} from "../lib/quality-round.ts";

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
  const rec = skippedQualityRecord({ head: "e".repeat(40), tree: "f".repeat(40), reason: "本轮只改动了非代码文件", at: "2026-09-18T00:00:00.000Z" });
  assert.equal(rec.verdict, "READY");
  assert.equal(rec.skipped, true);
  assert.equal(rec.commitSha, "e".repeat(40));
  assert.match(rec.skipReason ?? "", /非代码文件/);
});

test("qualityFollowUp: READY releases the held round; anything else drops it AND stops the lane", () => {
  // A pass releases the functional round it was holding…
  assert.deepEqual(qualityFollowUp({ verdict: "READY", held: true }), {
    dropHeld: false, abortLane: false, dispatchReviewer: true,
  });
  // …and a pass with nothing held changes nothing (the re-submission path:
  // the router saw the standing pass and went straight to the reviewer).
  assert.deepEqual(qualityFollowUp({ verdict: "READY", held: false }), {
    dropHeld: false, abortLane: false, dispatchReviewer: false,
  });
  for (const verdict of ["BLOCKED", "NEEDS_HUMAN", undefined]) {
    // The content is about to change: the held brief is history, and the full
    // lane verifying that content has nothing left to prove.
    assert.deepEqual(qualityFollowUp({ verdict, held: true }), {
      dropHeld: true, abortLane: true, dispatchReviewer: false,
    }, `${verdict}: a held round is dropped and the lane stopped`);
    // The lane stop is INDEPENDENT of `held`: a blocking verdict on a round
    // nobody was holding still wastes the lane's remaining minutes, and the
    // next submission would wait for a quiet lane first.
    assert.deepEqual(qualityFollowUp({ verdict, held: false }), {
      dropHeld: false, abortLane: true, dispatchReviewer: false,
    }, `${verdict}: the lane stops even with nothing held`);
  }
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
