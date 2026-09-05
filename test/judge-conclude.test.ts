/**
 * Judge-side self-conclusion: one structured call ends a round.
 *
 * Pins: validation never consumes the round's single conclusion; the
 * structured fields land on the channel report VERBATIM (no fence is built and
 * none is parsed); the signature is ROLE-SHAPED, so a reviewer / goal-auditor
 * that passes `notes` is refused without spending its one conclusion; a second
 * call for the same round is refused while older rounds' reports never block.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  countStreamFindings,
  decideConclude,
  maxSelfReportRound,
  nextRoundSeq,
  registerJudgeConcludeTool,
  roleAcceptsNotes,
  validateConcludeParams,
  type JudgeConcludeToolDeps,
} from "../lib/judge-conclude.ts";
import type { ToolHost } from "../lib/tool-host.ts";
import {
  judgeChannelTarget,
  channelPathFor,
  projectChannel,
  readChannel,
  reportConclusion,
  type ChannelIO,
  type ChannelRecord,
} from "../lib/orchestrator-channel.ts";
import { JUDGE_ID_ENV, JUDGE_OPENER_ENV, JUDGE_ROLE_ENV } from "../lib/judge-pane.ts";
import type { InspectionEvidence } from "../lib/judge-inspection.ts";
import type { InspectionBlock, InspectionPass } from "../lib/inspection-appeal.ts";
import type { ReviewScopeStamp } from "../lib/orchestrator-channel.ts";

const NOW = 1_700_000_000_000;
const OPENER = "session-child-1";
const JUDGE = "rg-reviewer-abc12345-opener12";
const HOME = "/home/test";

function report(round: number, reportId = `rep-${round}`): ChannelRecord {
  return {
    reportId, kind: "report", from: "child", at: new Date(NOW).toISOString(),
    round, verdict: "READY", summary: "old",
  } as ChannelRecord;
}

test("validate: a full input passes, verdict normalises case", () => {
  const r = validateConcludeParams({
    verdict: "ready",
    findings: [{ severity: "P1", file: "a.ts", line: 3.7, issue: "x", evidence: "npm test" }],
    cwd: "/repo",
    docSync: "updated",
  }, "reviewer");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.input.verdict, "READY");
  assert.equal(r.input.findings[0]?.line, 3);
  assert.equal(r.input.findings[0]?.evidence, "npm test");
  assert.equal(r.input.docSync, "UPDATED");
  assert.equal(r.input.notes, undefined, "a reviewer's input carries no prose field at all");
});

test("validate: verdict/cwd/findings/docSync failures each explain themselves", () => {
  assert.match((validateConcludeParams({ verdict: "MAYBE", cwd: "/r" }, "reviewer") as { reason: string }).reason, /verdict/);
  assert.match((validateConcludeParams({ verdict: "READY", cwd: "  " }, "reviewer") as { reason: string }).reason, /cwd/);
  assert.match((validateConcludeParams({ verdict: "READY", cwd: "/r", findings: "x" }, "reviewer") as { reason: string }).reason, /findings 必须是数组/);
  assert.match(
    (validateConcludeParams({ verdict: "READY", cwd: "/r", findings: [{ severity: "P1" }] }, "reviewer") as { reason: string }).reason,
    /findings\[0\]/,
  );
  assert.match(
    (validateConcludeParams({ verdict: "READY", cwd: "/r", docSync: "LATER" }, "reviewer") as { reason: string }).reason,
    /docSync/,
  );
});

test("validate: `evidence` is OPTIONAL and never validated (D6)", () => {
  const r = validateConcludeParams({
    verdict: "BLOCKED",
    findings: [{ severity: "P1", file: "a.ts", line: 1, issue: "the evidence IS file:line" }],
    cwd: "/repo",
  }, "reviewer");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal("evidence" in r.input.findings[0]!, false, "an absent evidence stays absent, not empty-string");
});

// ---- the role-shaped signature ----

test("only the adviser's conclusion is prose", () => {
  assert.equal(roleAcceptsNotes("adviser"), true);
  assert.equal(roleAcceptsNotes(" ADVISER "), true);
  assert.equal(roleAcceptsNotes("reviewer"), false);
  assert.equal(roleAcceptsNotes("goal-auditor"), false);
});

test("validate: a reviewer / goal-auditor that passes `notes` is REFUSED with the fix", () => {
  for (const role of ["reviewer", "goal-auditor"]) {
    const r = validateConcludeParams({ verdict: "READY", cwd: "/r", notes: "散文" }, role);
    assert.equal(r.ok, false, role);
    if (r.ok) return;
    assert.match(r.reason, /本角色不接受 notes/);
    assert.match(r.reason, /findings/, "the refusal says where the conclusion belongs");
  }
  // Even an empty string is a refusal: the point is that the parameter does
  // not exist for this role, not that its content was judged.
  assert.equal(validateConcludeParams({ verdict: "READY", cwd: "/r", notes: "" }, "reviewer").ok, false);
});

test("validate: the adviser keeps `notes`, and code fences in it are fine", () => {
  const r = validateConcludeParams({
    verdict: "NEEDS_HUMAN",
    cwd: "/repo",
    // Nothing parses this text, so a fence inside it is just text now.
    notes: "建议：\n```ts\nconst x = 1;\n```",
  }, "adviser");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.input.notes!, /```ts/);
});

// ---- rounds ----

test("rounds: max/next derive from entry and channel together", () => {
  assert.equal(maxSelfReportRound([]), 0);
  assert.equal(maxSelfReportRound([report(2), report(5)]), 5);
  // Pre-tool reports carry no round and count as 0, never as blocking.
  assert.equal(maxSelfReportRound([{ reportId: "x", kind: "report", from: "child", at: "", verdict: "READY" } as ChannelRecord]), 0);
  // A close→spawn keeps old reports: the entry alone would restart at 1.
  assert.equal(nextRoundSeq(undefined, [report(1), report(3)]), 4);
  assert.equal(nextRoundSeq(1, [report(1), report(3)]), 4);
  assert.equal(nextRoundSeq(5, []), 6);
});

test("decide: only this round's own report blocks", () => {
  assert.deepEqual(decideConclude([], 1), { ok: true });
  assert.deepEqual(decideConclude([report(1)], 2), { ok: true });
  const dup = decideConclude([report(1, "rep-aaa"), report(2)], 1);
  assert.equal(dup.ok, false);
  if (dup.ok) return;
  assert.equal(dup.reportId, "rep-aaa");
});

test("stream count is gate-counted with a findings-length fallback", () => {
  const read = (p: string) => (p === "/s.jsonl" ? "[P1] a\n\n[P2] b\n" : undefined);
  assert.equal(countStreamFindings(read, "/s.jsonl", 9), 2);
  assert.equal(countStreamFindings(read, undefined, 9), 9);
  assert.equal(countStreamFindings(read, "/missing.jsonl", 9), 9);
});

type Exec = (params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;

function setup(over: Partial<{
  env: NodeJS.ProcessEnv;
  hierarchy: string | undefined;
  stream: string | undefined;
  role: string;
  /** What the gate observed this round (default: a round that inspected). */
  inspection: InspectionEvidence;
  /** A granted appeal's pass, when the test wants one live. */
  pass: InspectionPass;
  /** The round's scope stamp; `null` = a round that has none at all. */
  scope: ReviewScopeStamp | null;
}> = {}): {
  exec: Exec;
  ioFiles: Map<string, string>;
  params: Record<string, unknown>;
  refusals: InspectionBlock[];
  concluded: boolean[];
} {
  const refusals: InspectionBlock[] = [];
  const concluded: boolean[] = [];
  const ioFiles = new Map<string, string>();
  const io: ChannelIO = {
    ensureDir() {},
    appendLine(path, line) { ioFiles.set(path, (ioFiles.get(path) ?? "") + line); },
    readText(path) { return ioFiles.get(path); },
    writeText(path, text) { ioFiles.set(path, text); },
    now: () => NOW,
  };
  const files = new Map<string, string>();
  if (over.hierarchy !== undefined) files.set("/repo/.pi/judge-hierarchy.json", over.hierarchy);
  if (over.stream !== undefined) files.set("/stream.jsonl", over.stream);
  let exec: Exec = async () => { throw new Error("tool not registered"); };
  let params: Record<string, unknown> = {};
  const host: ToolHost = {
    registerTool(def) {
      params = (def.parameters as { properties?: Record<string, unknown> }).properties ?? {};
      exec = (p) =>
        def.execute("id", p, undefined, undefined, undefined).then((r) => ({
          content: r.content as Array<{ type: string; text: string }>,
          ...(r.isError === true ? { isError: true as const } : {}),
        }));
    },
  };
  const deps: JudgeConcludeToolDeps = {
    env: () => over.env ?? {
      [JUDGE_OPENER_ENV]: OPENER,
      [JUDGE_ID_ENV]: JUDGE,
      [JUDGE_ROLE_ENV]: over.role ?? "reviewer",
      RG_JUDGE_STREAM: "/stream.jsonl",
    },
    repoRoot: () => "/repo",
    hierarchyPath: (root) => `${root}/.pi/judge-hierarchy.json`,
    readText: (p) => files.get(p),
    channelIO: () => io,
    channelHome: () => HOME,
    now: () => NOW,
    // Default: a round the gate DID observe inspecting, so every pre-existing
    // expectation still describes a normal round.
    inspection: () => over.inspection ?? { actions: 2, kinds: ["diff", "file-read"], rangeSeen: true },
    // The round's audit stamp. `null` in the overrides means "this round has
    // no scope at all" (a goal audit) — `undefined` takes the default, which
    // is the ordinary reviewer round every other expectation describes.
    reviewScope: () => (over.scope === null ? undefined : over.scope ?? { range: "aaaaaaa..bbbbbbb", kind: "incremental" }),
    inspectionPass: () => over.pass,
    noteInspectionRefusal: (block) => { refusals.push(block); },
    noteConcluded: (usedPass) => { concluded.push(usedPass); },
  };
  registerJudgeConcludeTool(host, deps);
  return { exec, ioFiles, params, refusals, concluded };
}

function hierarchyFile(roundSeq: number): string {
  return JSON.stringify({ version: 1, judges: { [JUDGE]: { judgeId: JUDGE, openerId: OPENER, role: "reviewer", repoRoot: "/repo", createdAt: "", roundSeq } } });
}

/** A read-only view of the fake channel filesystem (resolves spill files too). */
function readerIO(ioFiles: Map<string, string>): ChannelIO {
  return {
    ensureDir() {}, appendLine() {}, readText: (p) => ioFiles.get(p), writeText() {}, now: () => NOW,
  };
}

function lastReport(ioFiles: Map<string, string>) {
  const io = readerIO(ioFiles);
  const target = judgeChannelTarget(OPENER, JUDGE, HOME);
  return projectChannel(readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records).lastReport;
}

const FINDINGS = [
  { severity: "P1", file: "a.ts", line: 11, issue: "broken", evidence: "npm test -- a" },
  { severity: "P2", file: "b.ts", line: 4, issue: "polish" },
];
const GOOD = { verdict: "READY", findings: [], cwd: "/repo" };

test("the SCHEMA is role-shaped: a reviewer's tool has no `notes` parameter at all", () => {
  assert.equal("notes" in setup({ hierarchy: hierarchyFile(1) }).params, false);
  assert.equal("notes" in setup({ hierarchy: hierarchyFile(1), role: "goal-auditor" }).params, false);
  assert.equal("notes" in setup({ hierarchy: hierarchyFile(1), role: "adviser" }).params, true);
  // The rest of the shape is the same for every role.
  const reviewer = setup({ hierarchy: hierarchyFile(1) }).params;
  for (const field of ["verdict", "findings", "cwd", "docSync"]) {
    assert.ok(field in reviewer, field);
  }
});

test("tool: one call concludes the round, findings land on the record VERBATIM", async () => {
  const { exec, ioFiles } = setup({ hierarchy: hierarchyFile(2), stream: "[P1] a\n" });
  const r = await exec({ verdict: "BLOCKED", findings: FINDINGS, cwd: "/repo", docSync: "UPDATED" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0]!.text, /已交卷/);
  const last = lastReport(ioFiles);
  assert.equal(last?.verdict, "BLOCKED");
  assert.equal((last as { round?: unknown })?.round, 2);
  assert.equal(last?.findingsCount, 1, "the count is gate-counted from the stream, not the params");
  // THE criterion: what the opener reads is what the judge concluded, field
  // for field — no serialization, no parsing, nothing lost or added.
  const concluded = reportConclusion(readerIO(ioFiles), last!);
  assert.deepEqual(concluded.findings, FINDINGS);
  assert.equal(concluded.cwd, "/repo");
  assert.equal(concluded.docSync, "UPDATED");
});

test("tool: a big findings array SPILLS instead of writing an unatomic channel line", async () => {
  // The channel's whole record format exists to keep one append below
  // PIPE_BUF (4096 bytes), because a longer line can interleave with a
  // concurrent writer and tear. Findings are unbounded BY DESIGN (no cap, no
  // truncation), so they must spill exactly like an oversized prose summary —
  // a reviewer measured 12 ordinary findings at 4342 bytes on the version
  // that only spilled `summary`.
  const { exec, ioFiles } = setup({ hierarchy: hierarchyFile(1) });
  const many = Array.from({ length: 20 }, (_, i) => ({
    severity: "P2",
    file: `src/module-${i}.ts`,
    line: i * 7,
    issue: `第 ${i} 条发现：这里的判断在边界上会读到未定义的值，需要显式处理。`,
    evidence: `npm test -- module-${i}`,
  }));
  const r = await exec({ verdict: "BLOCKED", findings: many, cwd: "/repo" });
  assert.equal(r.isError, undefined);

  // The LINE is what has to stay small — that is the invariant, not the record.
  const target = judgeChannelTarget(OPENER, JUDGE, HOME);
  const line = ioFiles.get(channelPathFor(target.orchestrationId, target.childId, target.home))!;
  assert.ok(Buffer.byteLength(line, "utf8") < 4096,
    `the appended line must stay under PIPE_BUF, got ${Buffer.byteLength(line, "utf8")} bytes`);

  const last = lastReport(ioFiles)! as { findings?: unknown; findingsRef?: { path: string } };
  assert.equal(last.findings, undefined, "the array moved out of the record");
  assert.ok(last.findingsRef?.path, "…into a side file the record points at");
  // And it comes back VERBATIM: the spill must be invisible to the opener.
  assert.deepEqual(reportConclusion(readerIO(ioFiles), last as never).findings, many);
});

test("a report whose spilled findings cannot be read records NO findings, not stale ones", () => {
  // Fail-closed: an unreadable side file must not resurrect another round's
  // findings, and must not throw — the verdict still has to travel so the
  // recorder can apply its own rules to it.
  const orphan = {
    reportId: "rep-x", kind: "report", from: "child", at: "", round: 1,
    verdict: "BLOCKED", findingsRef: { path: "/gone.json", chars: 99 },
  } as never;
  const conclusion = reportConclusion(readerIO(new Map()), orphan);
  assert.equal(conclusion.verdict, "BLOCKED");
  assert.deepEqual(conclusion.findings, []);
  // A corrupt spill is the same case, not a crash.
  const corrupt = reportConclusion(readerIO(new Map([["/half.json", "[{\"severity\":"]])), {
    ...(orphan as object), findingsRef: { path: "/half.json", chars: 12 },
  } as never);
  assert.deepEqual(corrupt.findings, []);
});


test("tool: a reviewer's report carries NO prose — a judge's text cannot reach the opener", async () => {
  const { exec, ioFiles } = setup({ hierarchy: hierarchyFile(1) });
  await exec({ verdict: "READY", findings: [], cwd: "/repo" });
  const last = lastReport(ioFiles)! as { summary?: string; summaryRef?: unknown };
  assert.equal(last.summary, undefined);
  assert.equal(last.summaryRef, undefined);
});

test("tool: an adviser's report DOES carry its prose — that is its product", async () => {
  const { exec, ioFiles } = setup({ hierarchy: hierarchyFile(1), role: "adviser" });
  const r = await exec({ verdict: "NEEDS_HUMAN", findings: [], cwd: "/repo", notes: "建议走 B 方案。" });
  assert.equal(r.isError, undefined);
  assert.equal((lastReport(ioFiles) as { summary?: string }).summary, "建议走 B 方案。");
});

test("tool: a reviewer passing `notes` is refused and does NOT spend its conclusion", async () => {
  const { exec, ioFiles } = setup({ hierarchy: hierarchyFile(3) });
  const refused = await exec({ verdict: "READY", findings: [], cwd: "/repo", notes: "小结" });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text, /本角色不接受 notes/);
  assert.match(refused.content[0]!.text, /不占交卷额度/);
  assert.equal(lastReport(ioFiles), undefined, "nothing was written");
  // …so calling again immediately, without notes, works.
  const good = await exec(GOOD);
  assert.equal(good.isError, undefined);
  assert.equal((lastReport(ioFiles) as { round?: unknown })?.round, 3);
});

test("tool: a second call for the same round is refused, an older round never blocks", async () => {
  const { exec } = setup({ hierarchy: hierarchyFile(2) });
  await exec(GOOD);
  const dup = await exec(GOOD);
  assert.equal(dup.isError, true);
  assert.match(dup.content[0]!.text, /已交过卷/);
});

test("tool: a validation refusal does not consume the conclusion", async () => {
  const { exec, ioFiles } = setup({ hierarchy: hierarchyFile(1) });
  const bad = await exec({ verdict: "READY", findings: [], cwd: "" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]!.text, /不占交卷额度/);
  const good = await exec(GOOD);
  assert.equal(good.isError, undefined);
  assert.equal((lastReport(ioFiles) as { round?: unknown })?.round, 1);
});

test("tool: outside a review session, and with an unreadable registry, it refuses", async () => {
  const { exec } = setup({ env: {}, hierarchy: hierarchyFile(1) });
  const r = await exec(GOOD);
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /只在 review 会话里可用/);
  const missing = setup({ hierarchy: undefined });
  const r2 = await missing.exec(GOOD);
  assert.equal(r2.isError, true);
  assert.match(r2.content[0]!.text, /不占交卷额度/);
});

test("tool: THE PROBE — zero inspection + READY is refused, and costs no conclusion", async () => {
  const { exec, ioFiles, refusals, concluded } = setup({
    hierarchy: hierarchyFile(1),
    inspection: { actions: 0, kinds: [], rangeSeen: false },
  });
  const probe = await exec(GOOD);
  assert.equal(probe.isError, true);
  assert.match(probe.content[0]!.text, /未观测到任何审查动作/);
  assert.match(probe.content[0]!.text, /不占交卷额度/);
  assert.match(probe.content[0]!.text, /request_arbitration/, "the way out is named in the refusal");
  assert.equal(lastReport(ioFiles), undefined, "NOTHING was written: this is not a recorded verdict");
  assert.deepEqual(concluded, [], "a refused round did not end");
  assert.equal(refusals.length, 1, "the refusal is recorded for the appeal route");
  assert.equal(refusals[0]!.round, 1);
  assert.equal(refusals[0]!.role, "reviewer");
  assert.equal(refusals[0]!.judgeId, JUDGE);

  // BLOCKED from the same zero-inspection round goes through untouched.
  const blocked = await exec({ ...GOOD, verdict: "BLOCKED" });
  assert.equal(blocked.isError, undefined);
  assert.equal((lastReport(ioFiles) as { verdict?: unknown })?.verdict, "BLOCKED");
});

test("tool: a round that inspected concludes, and the report carries the evidence", async () => {
  const { exec, ioFiles, concluded } = setup({
    hierarchy: hierarchyFile(2),
    inspection: { actions: 3, kinds: ["diff", "file-read"], rangeSeen: true },
  });
  const ok = await exec(GOOD);
  assert.equal(ok.isError, undefined);
  const report = lastReport(ioFiles) as { verdict?: unknown; inspection?: Record<string, unknown> };
  assert.equal(report.verdict, "READY");
  assert.deepEqual(report.inspection, { actions: 3, kinds: ["diff", "file-read"], rangeSeen: true });
  assert.deepEqual(concluded, [false], "the round ended without spending a pass");
});

test("tool: an adviser concludes READY having inspected nothing — hard-coded exemption", async () => {
  const { exec, ioFiles, refusals } = setup({
    hierarchy: hierarchyFile(1),
    role: "adviser",
    inspection: { actions: 0, kinds: [], rangeSeen: false },
  });
  const r = await exec({ ...GOOD, notes: "my advice" });
  assert.equal(r.isError, undefined);
  assert.equal((lastReport(ioFiles) as { verdict?: unknown })?.verdict, "READY");
  assert.deepEqual(refusals, []);
});

test("tool: a granted pass carries ONE zero-inspection READY and is reported as such", async () => {
  const pass = { judgeId: JUDGE, round: 5, issuedAt: NOW };
  const wrongRound = setup({
    hierarchy: hierarchyFile(4),
    inspection: { actions: 0, kinds: [], rangeSeen: false },
    pass,
  });
  const stale = await wrongRound.exec(GOOD);
  assert.equal(stale.isError, true, "a pass earned for round 5 cannot carry round 4");

  const { exec, ioFiles, concluded } = setup({
    hierarchy: hierarchyFile(5),
    inspection: { actions: 0, kinds: [], rangeSeen: false },
    pass,
  });
  const ok = await exec(GOOD);
  assert.equal(ok.isError, undefined);
  const report = lastReport(ioFiles) as { inspection?: Record<string, unknown> };
  assert.deepEqual(report.inspection, { actions: 0, kinds: [], appeal: "granted" });
  assert.deepEqual(concluded, [true], "the caller is told to spend the pass");
});

test("tool: evidence stamped with ANOTHER round is not this round's evidence", async () => {
  // The pane is reused and a round can be abandoned (the opener dispatches the
  // next one into a pane that never concluded). Round 7's conclusion must not
  // be carried by the reading done for round 6.
  const { exec, ioFiles, refusals } = setup({
    hierarchy: hierarchyFile(7),
    inspection: { actions: 4, kinds: ["diff"], rangeSeen: true, round: 6 },
  });
  const stale = await exec(GOOD);
  assert.equal(stale.isError, true);
  assert.match(stale.content[0]!.text, /未观测到任何审查动作/);
  assert.equal(lastReport(ioFiles), undefined);
  assert.equal(refusals[0]!.evidence.actions, 0, "the refusal records what THIS round observed");

  // The same evidence stamped with the round being concluded goes through.
  const current = setup({
    hierarchy: hierarchyFile(7),
    inspection: { actions: 4, kinds: ["diff"], rangeSeen: true, round: 7 },
  });
  const ok = await current.exec(GOOD);
  assert.equal(ok.isError, undefined);
  const report = lastReport(current.ioFiles) as { inspection?: Record<string, unknown> };
  assert.deepEqual(report.inspection, { actions: 4, kinds: ["diff"], rangeSeen: true });
});

test("tool: the report is stamped with the scope THIS round ran under", async () => {
  // Auditability (t6a): the opener records this beside the scope it
  // dispatched, so a finished round can be checked for both laziness and
  // duplicated work long after the pane is gone.
  const { exec, ioFiles } = setup({
    hierarchy: hierarchyFile(2),
    scope: { range: "1234567..89abcde", kind: "incremental" },
  });
  const ok = await exec(GOOD);
  assert.equal(ok.isError, undefined);
  const report = lastReport(ioFiles) as { scope?: Record<string, unknown> };
  assert.deepEqual(report.scope, { range: "1234567..89abcde", kind: "incremental" });
});

test("tool: a round with no scope at all stamps nothing (a goal audit has no range)", async () => {
  // An empty object here would read to every consumer as "the judge reported
  // a scope" — the one thing the stamp must never claim falsely.
  const { exec, ioFiles } = setup({ hierarchy: hierarchyFile(2), scope: null });
  const ok = await exec(GOOD);
  assert.equal(ok.isError, undefined);
  const report = lastReport(ioFiles) as unknown as Record<string, unknown>;
  assert.ok(!("scope" in report), "the field is omitted, not emitted empty");
});

