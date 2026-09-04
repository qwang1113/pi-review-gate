/**
 * Judge-side self-conclusion (t1, part 2): one structured call ends a round.
 *
 * Pins: validation never consumes the round's single conclusion; the
 * synthesised fence round-trips through the opener's parser; a second call
 * for the same round is refused while older rounds' reports never block.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConcludeFence,
  buildConcludeSummary,
  countStreamFindings,
  decideConclude,
  maxSelfReportRound,
  nextRoundSeq,
  registerJudgeConcludeTool,
  validateConcludeParams,
  type JudgeConcludeToolDeps,
} from "../lib/judge-conclude.ts";
import type { ToolHost } from "../lib/tool-host.ts";
import {
  judgeChannelTarget,
  channelPathFor,
  projectChannel,
  readChannel,
  type ChannelIO,
  type ChannelRecord,
} from "../lib/orchestrator-channel.ts";
import { JUDGE_ID_ENV, JUDGE_OPENER_ENV, JUDGE_ROLE_ENV } from "../lib/judge-pane.ts";
import { parseReviewOutput } from "../lib/verdict-parse.ts";

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
    findings: [{ severity: "P1", file: "a.ts", line: 3.7, issue: "x" }],
    cwd: "/repo",
    docSync: "updated",
    notes: "要点",
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.input.verdict, "READY");
  assert.equal(r.input.findings[0]?.line, 3);
  assert.equal(r.input.docSync, "UPDATED");
});

test("validate: verdict/cwd/findings/docSync/notes failures each explain themselves", () => {
  assert.match((validateConcludeParams({ verdict: "MAYBE", cwd: "/r" }) as { reason: string }).reason, /verdict/);
  assert.match((validateConcludeParams({ verdict: "READY", cwd: "  " }) as { reason: string }).reason, /cwd/);
  assert.match((validateConcludeParams({ verdict: "READY", cwd: "/r", findings: "x" }) as { reason: string }).reason, /findings 必须是数组/);
  assert.match(
    (validateConcludeParams({ verdict: "READY", cwd: "/r", findings: [{ severity: "P1" }] }) as { reason: string }).reason,
    /findings\[0\]/,
  );
  assert.match(
    (validateConcludeParams({ verdict: "READY", cwd: "/r", docSync: "LATER" }) as { reason: string }).reason,
    /docSync/,
  );
  assert.match(
    (validateConcludeParams({ verdict: "READY", cwd: "/r", notes: "a ```b" }) as { reason: string }).reason,
    /```/,
  );
});

test("fence: the synthesised fence round-trips through the opener's parser", () => {
  const v = validateConcludeParams({
    verdict: "BLOCKED",
    findings: [{ severity: "P1", file: "a.ts", line: 11, issue: "broken" }],
    cwd: "/repo",
  });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  const fence = buildConcludeFence(v.input);
  const parsed = parseReviewOutput(fence);
  assert.equal(parsed?.verdict, "BLOCKED");
  assert.equal(parsed?.cwd, "/repo");
  assert.equal(parsed?.findingsTotal, 1);
});

test("fence: READY with an open P1 still downgrades at the record side", () => {
  const v = validateConcludeParams({
    verdict: "READY",
    findings: [{ severity: "P1", issue: "open" }],
    cwd: "/repo",
  });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  // The tool does not second-guess the judge; the recorder fails closed.
  assert.equal(parseReviewOutput(buildConcludeFence(v.input))?.verdict, "BLOCKED");
});

test("fence: the canonical shape gains no extra top-level key", () => {
  const v = validateConcludeParams({
    verdict: "READY",
    findings: [{ severity: "P2", file: "a.ts", line: 5, issue: "polish" }],
    cwd: "/repo",
    docSync: "NOT_NEEDED",
  });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  const body = buildConcludeFence(v.input)
    .replace(/^```json\n/, "")
    .replace(/\n```$/, "");
  const obj = JSON.parse(body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(obj).sort(), ["cwd", "docSync", "findings", "gate"]);
  const finding = (obj.findings as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(Object.keys(finding).sort(), ["file", "issue", "line", "severity"]);
});

test("summary: fence first, notes after, fence alone when noteless", () => {
  assert.equal(buildConcludeSummary("F", ""), "F");
  assert.equal(buildConcludeSummary("F", "  "), "F");
  assert.equal(buildConcludeSummary("F", "要点"), "F\n\n要点");
});

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
}> = {}): { exec: Exec; ioFiles: Map<string, string> } {
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
  const host: ToolHost = {
    registerTool(def) {
      exec = (params) =>
        def.execute("id", params, undefined, undefined, undefined).then((r) => ({
          content: r.content as Array<{ type: string; text: string }>,
          ...(r.isError === true ? { isError: true as const } : {}),
        }));
    },
  };
  const deps: JudgeConcludeToolDeps = {
    env: () => over.env ?? {
      [JUDGE_OPENER_ENV]: OPENER,
      [JUDGE_ID_ENV]: JUDGE,
      [JUDGE_ROLE_ENV]: "reviewer",
      RG_JUDGE_STREAM: "/stream.jsonl",
    },
    repoRoot: () => "/repo",
    hierarchyPath: (root) => `${root}/.pi/judge-hierarchy.json`,
    readText: (p) => files.get(p),
    channelIO: () => io,
    channelHome: () => HOME,
    now: () => NOW,
  };
  registerJudgeConcludeTool(host, deps);
  return { exec, ioFiles };
}

function hierarchyFile(roundSeq: number): string {
  return JSON.stringify({ version: 1, judges: { [JUDGE]: { judgeId: JUDGE, openerId: OPENER, role: "reviewer", repoRoot: "/repo", createdAt: "", roundSeq } } });
}

function lastReport(ioFiles: Map<string, string>) {
  const io: ChannelIO = {
    ensureDir() {}, appendLine() {}, readText: (p) => ioFiles.get(p), writeText() {}, now: () => NOW,
  };
  const target = judgeChannelTarget(OPENER, JUDGE, HOME);
  return projectChannel(readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records).lastReport;
}

const GOOD = { verdict: "READY", findings: [], cwd: "/repo", notes: "全绿" };

test("tool: one call concludes the round with a parseable fence report", async () => {
  const { exec, ioFiles } = setup({ hierarchy: hierarchyFile(2), stream: "[P1] a\n" });
  const r = await exec(GOOD);
  assert.equal(r.isError, undefined);
  assert.match(r.content[0]!.text, /已交卷/);
  const last = lastReport(ioFiles);
  assert.equal(last?.verdict, "READY");
  assert.equal((last as { round?: unknown })?.round, 2);
  assert.equal(last?.findingsCount, 1, "the count is gate-counted from the stream, not the params");
  assert.ok(parseReviewOutput(last?.summary ?? ""), "the summary carries the canonical fence");
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
