import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const { buildAdviserBrief, countAdviserConclusions, parseAdviserConclusions, shellSingleQuote } = await import(
  new URL("../lib/adviser-brief.ts", import.meta.url).pathname
);

const base = {
  goalHash: "abc123",
  sessionDir: "/home/u/.pi/agent/sessions/--repo--",
  sessionId: "sess-9",
  artifactPath: "/repo/.pi/review-stream/adviser-abc123.jsonl",
  changedFiles: [],
};

test("first consultation: full brief with transcript pointer + artifact path", () => {
  const text = buildAdviserBrief(base);
  // Fresh-context contract: session dir + id for ON-DEMAND reads. Pinned as the
  // FACT (no inherited conversation), not as the subagent parameter it used to
  // be phrased in — the adviser is a tmux judge child, which has no such knob.
  assert.match(text, /conversation is NOT inherited/);
  assert.doesNotMatch(text, /context:\s*"fresh"/,
    "no subagent-only parameter may be prescribed to a judge child");
  assert.match(text, /--repo--/);
  assert.match(text, /sess-9/);
  // The conclusion artifact is named and the write is explicit.
  assert.match(text, /adviser-abc123\.jsonl/);
  assert.match(text, /append your conclusion as ONE JSON line/);
  assert.match(text, /No previous consultation exists/);
  // Nothing about a previous round is claimed.
  assert.doesNotMatch(text, /PREVIOUS consultation/);
  assert.doesNotMatch(text, /完成信号/); // no channel → no signal instruction
});

test("round-16 P1: the done channel is embedded at the end of the brief", () => {
  const text = buildAdviserBrief({ ...base, doneChannel: "rg-adviser-abc123-done" });
  assert.match(text, /完成信号/);
  assert.match(text, /tmux wait-for -S rg-adviser-abc123-done/);
  // The instruction is at the END (after the artifact/output contract).
  assert.ok(text.indexOf("tmux wait-for -S rg-adviser-abc123-done") > text.indexOf("artifact:"));

test("round-16 P2: the inbox question channel is embedded at the end of the brief when provided", () => {
  const text = buildAdviserBrief({
    ...base,
    doneChannel: "rg-adviser-abc123-done",
    inboxPath: "/repo/.pi/tmux-sessions/rg-adviser-abc123/inbox.jsonl",
    inboxChannel: "rg-adviser-abc123-inbox",
  });
  assert.match(text, /提问通道/);
  assert.match(text, /rg-adviser-abc123\/inbox\.jsonl/);
  assert.match(text, /tmux wait-for -S rg-adviser-abc123-inbox/);
  assert.doesNotMatch(text, /wait-for -S <channel>-inbox/);
  const plain = buildAdviserBrief(base);
  // Round-17: output discipline is part of the brief.
  assert.match(text, /输出纪律:结论 \+ 要点列表/, "the discipline is pinned in the brief");
  assert.doesNotMatch(plain, /提问通道/);
});
});

test("later consultation: previous verdict + points injected, changed files called out", () => {
  const previous = {
    at: "2026-08-27T00:00:00.000Z",
    goalHash: "abc123",
    verdict: "OBJECTS" as const,
    points: [
      { severity: "P1", issue: "incremental must not narrow authority" },
      { severity: "P2", issue: "missing test lock" },
    ],
  };
  const text = buildAdviserBrief({
    ...base,
    previous,
    changedFiles: ["lib/review-scope.ts", "test/review-scope.test.ts"],
  });
  assert.match(text, /PREVIOUS consultation of this goal concluded OBJECTS/);
  assert.match(text, /P1: incremental must not narrow authority/);
  assert.match(text, /P2: missing test lock/);
  assert.match(text, /Changed since that consultation \(2 file\(s\)\)/);
  assert.match(text, /lib\/review-scope\.ts/);
  assert.match(text, /stays settled/);
  assert.match(text, /do not re-argue it from zero/);
});

test("later consultation with no changes says the settled points are confirmed, not re-derived", () => {
  const text = buildAdviserBrief({
    ...base,
    previous: {
      at: "2026-08-27T00:00:00.000Z",
      goalHash: "abc123",
      verdict: "SUPPORTS" as const,
      points: [],
    },
  });
  assert.match(text, /No changed files detected/);
  assert.match(text, /confirm the settled points still hold/);
});

test("the approved goal text rides the brief when given", () => {
  const text = buildAdviserBrief({ ...base, goalText: "# 目标\n\n退出标准: 一条。" });
  assert.match(text, /The approved loop goal this consultation argues against:/);
  assert.match(text, /# 目标/);
  const without = buildAdviserBrief(base);
  assert.doesNotMatch(without, /approved loop goal/);
});

test("parseAdviserConclusions: last valid line for the goal wins, malformed lines skipped", () => {
  const raw = [
    "{broken",
    '{"at":"2026-08-27T00:00:00.000Z","goalHash":"abc","verdict":"OBJECTS","points":[]}',
    '{"at":"2026-08-27T01:00:00.000Z","goalHash":"other","verdict":"SUPPORTS","points":[]}',
    '{"at":"2026-08-27T02:00:00.000Z","goalHash":"abc","verdict":"NEUTRAL","points":[{"severity":"P2","issue":"x"}]}',
  ].join("\n");
  const got = parseAdviserConclusions(raw, "abc");
  assert.ok(got);
  assert.equal(got.verdict, "NEUTRAL");
  assert.equal(got.points.length, 1);
  assert.equal(parseAdviserConclusions(raw, "missing"), undefined);
  assert.equal(parseAdviserConclusions("", "abc"), undefined);
});

test("parseAdviserConclusions: verdict whitelist and point shapes are enforced (round-3 P2)", () => {
  // A corrupted or adversarial artifact line must NOT be injected as the
  // previous round's conclusion — whitelist the verdict, shape-check points.
  const baseLine =
    '{"at":"2026-08-27T00:00:00.000Z","goalHash":"abc","verdict":"SUPPORTS","points":[]}';
  assert.ok(parseAdviserConclusions(baseLine, "abc"));
  const rejected = [
    baseLine.replace('"SUPPORTS"', '"INJECT"'),
    baseLine.replace('"points":[]', '"points":[{}]'),
    baseLine.replace('"points":[]', '"points":[{"severity":"P1"}]'),
    baseLine.replace('"points":[]', '"points":"many"'),
  ];
  for (const line of rejected) {
    assert.equal(parseAdviserConclusions(line, "abc"), undefined, line);
  }
});

test("countAdviserConclusions: valid lines per goal counted, malformed/other-goal skipped (round-3 P1)", () => {
  const valid = (at: string) =>
    `{"at":"${at}","goalHash":"abc","verdict":"SUPPORTS","points":[]}`;
  const raw = [
    "{broken", // malformed: skipped
    valid("2026-08-27T00:00:00.000Z"),
    `{"at":"2026-08-27T00:00:00.000Z","goalHash":"other","verdict":"OBJECTS","points":[]}`, // other goal
    valid("2026-08-27T01:00:00.000Z"),
    valid("2026-08-27T02:00:00.000Z"),
  ].join("\n");
  assert.equal(countAdviserConclusions(raw, "abc"), 3);
  assert.equal(countAdviserConclusions(raw, "other"), 1);
  assert.equal(countAdviserConclusions("", "abc"), 0);
  assert.equal(countAdviserConclusions("{broken\n\n", "abc"), 0);
  // The count feeds the baseline advance: a consultation that appended a
  // conclusion increments it; an aborted one does not.
  assert.equal(countAdviserConclusions(valid("2026-08-27T03:00:00.000Z"), "abc"), 1);
});

test("shellSingleQuote survives a REAL shell round-trip as one argument (round-3 P1)", () => {
  const path = "/repo/it's/here";
  const q = shellSingleQuote(path);
  assert.equal(q, "'/repo/it'\\''s/here'");
  // A real round trip: the shell must receive the path as ONE argument and
  // print it back byte-for-byte. `sh -c 'printf "%s" "$1"' _ <quoted>` —
  // the quoted string is spliced into the SCRIPT (the whole point of the
  // escaping), not passed as a separate argument.
  const script = `printf '%s' ${q}`;
  const out = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  assert.equal(out, path, "the shell must round-trip the quoted path unchanged");
});

test("changedFiles null: the settled points are NOT treated as confirmed (round-10 P1)", () => {
  const text = buildAdviserBrief({
    ...base,
    previous: {
      at: "2026-08-27T00:00:00.000Z",
      goalHash: "abc123",
      verdict: "SUPPORTS" as const,
      points: [],
    },
    changedFiles: null,
  });
  assert.match(text, /could NOT be computed/);
  assert.match(text, /do NOT treat/);
  assert.match(text, /the settled points as confirmed/);
  assert.match(text, /re-check them against the current state/);
});
