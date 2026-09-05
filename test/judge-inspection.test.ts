/**
 * The judge-side inspection observer and its one rule.
 *
 * Pins: the probe (zero observed actions + READY) is refused for a
 * verdict-bearing role and the refusal names the appeal route; a round that
 * inspected concludes normally; `adviser` is exempt; BLOCKED / NEEDS_HUMAN are
 * never gated; listing files is not inspecting them; a granted pass carries
 * exactly one zero-inspection READY.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyInspection,
  classifyShellCommand,
  decideInspection,
  emptyInspection,
  inspectionRecord,
  observeInspection,
  parseReviewRange,
  rangeMentioned,
  requiresInspectionEvidence,
} from "../lib/judge-inspection.ts";

test("content reads count; listing, testing and writing do not", () => {
  assert.equal(classifyShellCommand("git diff abc1234..HEAD"), "diff");
  assert.equal(classifyShellCommand("git show HEAD -- lib/a.ts | head -50"), "diff");
  assert.equal(classifyShellCommand("git log -p -3"), "diff");
  assert.equal(classifyShellCommand("git grep -n foo"), "search");
  assert.equal(classifyShellCommand("rg 'judge_conclude' lib/"), "search");
  assert.equal(classifyShellCommand("sed -n '1,80p' lib/a.ts"), "file-read");
  assert.equal(classifyShellCommand("cat lib/a.ts"), "file-read");
  assert.equal(classifyShellCommand("/usr/bin/head -5 a.txt"), "file-read");

  // NOT inspection: names only, running things, or changing them.
  assert.equal(classifyShellCommand("ls -la lib/"), undefined);
  assert.equal(classifyShellCommand("find . -name '*.ts'"), undefined);
  assert.equal(classifyShellCommand("git log --stat -3"), undefined, "a summary is not content");
  assert.equal(classifyShellCommand("npm test"), undefined);
  assert.equal(classifyShellCommand("sed -i 's/a/b/' lib/a.ts"), undefined, "editing is not reading");
  assert.equal(classifyShellCommand("  "), undefined);
});

test("the tool families the judge actually uses are classified", () => {
  assert.deepEqual(classifyInspection({ toolName: "read", input: { path: "/repo/a.ts" } }), { kind: "file-read", text: "" });
  assert.deepEqual(classifyInspection({ toolName: "grep", input: { pattern: "x" } }), { kind: "search", text: "" });
  assert.equal(classifyInspection({ toolName: "ls", input: { path: "/repo" } }), undefined);
  assert.equal(classifyInspection({ toolName: "write", input: { path: "/repo/a.ts" } }), undefined);
  const bash = classifyInspection({ toolName: "bash", input: { command: "git diff a1b2c3d..HEAD" } });
  assert.deepEqual(bash, { kind: "diff", text: "git diff a1b2c3d..HEAD" });
  assert.equal(classifyInspection({ toolName: "bash", input: {} }), undefined);
  assert.equal(classifyInspection({ toolName: "bash", input: undefined }), undefined);

  // Host-cased names must be recognised: a name this module fails to know
  // reads as "inspected nothing", which would refuse an honest round.
  assert.deepEqual(classifyInspection({ toolName: "Read", input: { path: "/a" } }), { kind: "file-read", text: "" });
  assert.deepEqual(classifyInspection({ toolName: "Grep", input: { pattern: "x" } }), { kind: "search", text: "" });
  assert.deepEqual(
    classifyInspection({ toolName: "Bash", input: { command: "git show HEAD" } }),
    { kind: "diff", text: "git show HEAD" },
  );
});

test("evidence folds, dedupes kinds and flags the reviewed range", () => {
  const range = parseReviewRange("审查范围：`a1b2c3d4..HEAD`（不可变）");
  assert.equal(range, "a1b2c3d4..HEAD");
  assert.equal(parseReviewRange("no range here"), undefined);
  assert.equal(parseReviewRange(undefined), undefined);

  let ev = emptyInspection();
  assert.equal(ev.actions, 0);
  ev = observeInspection(ev, { toolName: "ls", input: { path: "/repo" } }, range);
  assert.equal(ev.actions, 0, "a listing changes nothing");
  ev = observeInspection(ev, { toolName: "read", input: { path: "/repo/a.ts" } }, range);
  ev = observeInspection(ev, { toolName: "read", input: { path: "/repo/b.ts" } }, range);
  assert.equal(ev.actions, 2);
  assert.deepEqual(ev.kinds, ["file-read"], "kinds are distinct");
  assert.equal(ev.rangeSeen, false, "a file read says nothing about the range");
  ev = observeInspection(ev, { toolName: "bash", input: { command: "git diff a1b2c3d4..HEAD" } }, range);
  assert.equal(ev.actions, 3);
  assert.deepEqual(ev.kinds, ["file-read", "diff"]);
  assert.equal(ev.rangeSeen, true);

  // The baseline endpoint alone counts (a reviewer often diffs against it).
  assert.equal(rangeMentioned("git show a1b2c3d4", range), true);
  assert.equal(rangeMentioned("git show deadbee", range), false);
  assert.equal(rangeMentioned("git diff", undefined), false);
});

test("THE PROBE: a verdict-bearing role cannot conclude READY having read nothing", () => {
  const probe = decideInspection({ role: "reviewer", verdict: "READY", evidence: emptyInspection() });
  assert.equal(probe.ok, false);
  if (probe.ok) return;
  assert.match(probe.reason, /没有观测到任何审查动作/);
  assert.match(probe.reason, /request_arbitration/, "the refusal must name its own way out");

  // goal-auditor is verdict-bearing too, and so is a role this build never heard of.
  assert.equal(decideInspection({ role: "goal-auditor", verdict: "READY", evidence: emptyInspection() }).ok, false);
  assert.equal(decideInspection({ role: "future-judge", verdict: "READY", evidence: emptyInspection() }).ok, false);
  assert.equal(requiresInspectionEvidence("reviewer"), true);
  assert.equal(requiresInspectionEvidence("goal-auditor"), true);
});

test("a round that inspected concludes; adviser and non-READY verdicts are never gated", () => {
  const looked = observeInspection(emptyInspection(), { toolName: "read", input: { path: "/a" } });
  const ok = decideInspection({ role: "reviewer", verdict: "READY", evidence: looked });
  assert.deepEqual(ok, { ok: true, usedPass: false });

  // Hard-coded exemption: an adviser's conclusion reaches no recorder.
  assert.equal(requiresInspectionEvidence("adviser"), false);
  assert.equal(requiresInspectionEvidence("Adviser "), false);
  assert.deepEqual(
    decideInspection({ role: "adviser", verdict: "READY", evidence: emptyInspection() }),
    { ok: true, usedPass: false },
  );

  // BLOCKED / NEEDS_HUMAN grant nobody anything, so they are never refused.
  for (const verdict of ["BLOCKED", "NEEDS_HUMAN", "blocked"]) {
    assert.deepEqual(
      decideInspection({ role: "reviewer", verdict, evidence: emptyInspection() }),
      { ok: true, usedPass: false },
      verdict,
    );
  }
});

test("a granted pass carries the READY, and the caller is told to spend it", () => {
  const granted = decideInspection({
    role: "reviewer", verdict: "READY", evidence: emptyInspection(), passAuthorized: true,
  });
  assert.deepEqual(granted, { ok: true, usedPass: true });
  // A pass is not needed — and not spent — when the round did inspect.
  const looked = observeInspection(emptyInspection(), { toolName: "read", input: { path: "/a" } });
  assert.deepEqual(
    decideInspection({ role: "reviewer", verdict: "READY", evidence: looked, passAuthorized: true }),
    { ok: true, usedPass: false },
  );
});

test("the report field is additive and says what was observed", () => {
  assert.deepEqual(inspectionRecord(emptyInspection()), { actions: 0, kinds: [] });
  const ev = observeInspection(
    emptyInspection(),
    { toolName: "bash", input: { command: "git diff a1b2c3d4..HEAD" } },
    "a1b2c3d4..HEAD",
  );
  assert.deepEqual(inspectionRecord(ev), { actions: 1, kinds: ["diff"], rangeSeen: true });
  assert.deepEqual(inspectionRecord(emptyInspection(), true), { actions: 0, kinds: [], appeal: "granted" });
});
