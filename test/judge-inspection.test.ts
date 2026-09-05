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
  evidenceForRound,
  inspectionRecord,
  observeInspection,
  parseReviewRange,
  rangeMentioned,
  requiresInspectionEvidence,
  touchesGateOwnedPath,
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
  // A reviewer verifying in its own copy passes the checkout as a global flag;
  // reading the flag's operand as the subcommand would miss the whole round.
  assert.equal(classifyShellCommand("git -C /tmp/copy diff abc1234..HEAD"), "diff");
  assert.equal(classifyShellCommand("git -c core.pager=cat show HEAD"), "diff");
  assert.equal(classifyShellCommand("git -C /tmp/copy status"), undefined, "status is still not content");

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
  ev = observeInspection(ev, { toolName: "ls", input: { path: "/repo" } }, { range });
  assert.equal(ev.actions, 0, "a listing changes nothing");
  ev = observeInspection(ev, { toolName: "read", input: { path: "/repo/a.ts" } }, { range });
  ev = observeInspection(ev, { toolName: "read", input: { path: "/repo/b.ts" } }, { range });
  assert.equal(ev.actions, 2);
  assert.deepEqual(ev.kinds, ["file-read"], "kinds are distinct");
  assert.equal(ev.rangeSeen, false, "a file read says nothing about the range");
  ev = observeInspection(ev, { toolName: "bash", input: { command: "git diff a1b2c3d4..HEAD" } }, { range });
  assert.equal(ev.actions, 3);
  assert.deepEqual(ev.kinds, ["file-read", "diff"]);
  assert.equal(ev.rangeSeen, true);

  // The baseline endpoint alone counts (a reviewer often diffs against it).
  assert.equal(rangeMentioned("git show a1b2c3d4", range), true);
  assert.equal(rangeMentioned("git show deadbee", range), false);
  assert.equal(rangeMentioned("git diff", undefined), false);
});

test("THE PROBE, exactly: reading only its own task is not inspecting anything", () => {
  // The probe is "call judge_conclude with READY and do nothing else" — and a
  // judge reads its own task no matter what it is told. If that read counted,
  // the probe would clear this gate by doing precisely what the probe asked,
  // and the refusal would never fire once.
  const taskPath = "/repo/.pi/judge-sessions/reviewer-abc/sessions/task-2026-09-05T10-00-00-000Z-ab12cd.md";
  const streamPath = "/repo/.pi/review-stream/review-mtog9hsl-review.jsonl";
  const own = [taskPath, streamPath];

  let ev = emptyInspection();
  for (const call of [
    { toolName: "read", input: { path: taskPath } },
    { toolName: "Read", input: { file_path: taskPath } },
    { toolName: "bash", input: { command: `cat ${taskPath}` } },
    { toolName: "bash", input: { command: `tail -20 ${streamPath}` } },
    { toolName: "read", input: { path: streamPath } },
    // Even without the exact paths in hand, the gate's own directories are
    // recognised (a pane may be handed a differently-named task file).
    { toolName: "read", input: { path: "/repo/.pi/judge-sessions/reviewer-abc/sessions/other.md" } },
    { toolName: "bash", input: { command: "cat /repo/.pi/judge-hierarchy.json" } },
  ]) {
    ev = observeInspection(ev, call, { ownPaths: own });
  }
  assert.equal(ev.actions, 0, "the round's own paperwork is not the code under review");
  const probe = decideInspection({ role: "reviewer", verdict: "READY", evidence: ev });
  assert.equal(probe.ok, false, "so the probe is still refused");

  // One real read of the repository is what changes the answer.
  ev = observeInspection(ev, { toolName: "read", input: { path: "/repo/lib/judge-conclude.ts" } }, { ownPaths: own });
  assert.equal(ev.actions, 1);
  assert.equal(decideInspection({ role: "reviewer", verdict: "READY", evidence: ev }).ok, true);

  // Fail-closed direction: a command touching BOTH is dropped, never credited.
  const mixed = observeInspection(emptyInspection(), {
    toolName: "bash",
    input: { command: `cat ${taskPath} lib/judge-conclude.ts` },
  }, { ownPaths: own });
  assert.equal(mixed.actions, 0, "an under-count refuses an honest round; it never passes a probe");

  // A directory marker only helps while the directory is still in the command:
  // `cd <session dir> && cat task-….md` carries none, so the gate's own file
  // NAMES are matched too (they are minted by the gate, not guessed).
  const afterCd = observeInspection(emptyInspection(), {
    toolName: "bash",
    input: { command: "cat task-2026-09-05T10-00-00-000Z-ab12cd.md" },
  }, { ownPaths: own });
  assert.equal(afterCd.actions, 0, "the task file is the task file under any prefix");
  // An ordinary repository file with a similar-looking name still counts.
  const realRead = observeInspection(emptyInspection(), {
    toolName: "bash",
    input: { command: "cat lib/judge-inspection.ts" },
  }, { ownPaths: own });
  assert.equal(realRead.actions, 1);

  assert.equal(touchesGateOwnedPath({ toolName: "read", input: { path: "/repo/lib/a.ts" } }, own), false);
  assert.equal(touchesGateOwnedPath({ toolName: "read", input: { path: taskPath } }, own), true);
  assert.equal(touchesGateOwnedPath({ toolName: "bash", input: {} }, own), false, "no strings, nothing to match");
});

test("the followUp path: the NEXT round starts from zero in the same pane", () => {
  // Round N+1 arrives as a channel followUp injected into a LIVE pane (the
  // process is not restarted), so "reset on a successful conclude" is not
  // enough on its own — the opener bumps the round in the registry and every
  // action carries it, which is what makes the next round start blind.
  const own = ["/repo/.pi/judge-sessions/reviewer-abc/sessions/task-1.md"];
  let ev = emptyInspection();
  ev = observeInspection(ev, { toolName: "bash", input: { command: "git diff aaaaaaa..HEAD" } }, { round: 1, ownPaths: own });
  assert.equal(ev.actions, 1);

  // …the round is abandoned (no conclusion), the next task lands in the pane,
  // and the judge is told to conclude READY immediately. Its only action is
  // reading that task.
  ev = observeInspection(ev, { toolName: "read", input: { path: own[0]! } }, { round: 2, ownPaths: own });
  assert.equal(evidenceForRound(ev, 2).actions, 0, "round 1's diff is not round 2's evidence");
  assert.equal(decideInspection({ role: "reviewer", verdict: "READY", evidence: evidenceForRound(ev, 2) }).ok, false);
});


test("an ABANDONED round's reads do not carry into the next round", () => {
  // A pane outlives its rounds: the opener may dispatch round 4 into a pane
  // that never concluded round 3, so a reset that only happens on a successful
  // conclusion would hand round 4 the reading done for round 3.
  const round3 = observeInspection(emptyInspection(), { toolName: "read", input: { path: "/a" } }, { round: 3 });
  assert.equal(round3.actions, 1);
  assert.equal(round3.round, 3);

  // Concluding round 4 sees NOTHING of round 3's work.
  const forRound4 = evidenceForRound(round3, 4);
  assert.equal(forRound4.actions, 0);
  assert.equal(decideInspection({ role: "reviewer", verdict: "READY", evidence: forRound4 }).ok, false);
  // …and the round it WAS gathered for still counts.
  assert.equal(evidenceForRound(round3, 3).actions, 1);

  // The next round's first action starts the count over rather than adding.
  const round4 = observeInspection(round3, { toolName: "read", input: { path: "/b" } }, { round: 4 });
  assert.equal(round4.actions, 1, "not 2 — round 3's read is gone");
  assert.equal(round4.round, 4);

  // An unreadable round number never refuses on its own (missing information
  // is not evidence of a stale round).
  const unstamped = observeInspection(emptyInspection(), { toolName: "read", input: { path: "/a" } });
  assert.equal(unstamped.round, undefined);
  assert.equal(evidenceForRound(unstamped, 9).actions, 1);
  assert.equal(evidenceForRound(round3, undefined).actions, 1);
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
    { range: "a1b2c3d4..HEAD" },
  );
  assert.deepEqual(inspectionRecord(ev), { actions: 1, kinds: ["diff"], rangeSeen: true });
  assert.deepEqual(inspectionRecord(emptyInspection(), true), { actions: 0, kinds: [], appeal: "granted" });
});
