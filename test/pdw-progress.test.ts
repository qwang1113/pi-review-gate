import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  createProgressSink,
  newPdwRunId,
  engineLogFileFor,
  type PdwProgressEvent,
  resolveProgressRoot,
} from "../lib/pdw-progress.ts";

test("newPdwRunId mints file-safe run ids", () => {
  const a = newPdwRunId();
  const b = newPdwRunId();
  assert.match(a, /^run-[a-z0-9]+-[a-z0-9]+$/);
  assert.notEqual(a, b, "two mints must differ");
});

test("engineLogFileFor mirrors the engine project layout", () => {
  const cwd = join(tmpdir(), "Pdw Progress Test!"); // slug-normalized + hashed
  const file = engineLogFileFor(cwd, "run-abc");
  assert.ok(file.includes(join(".pi", "workflows", "projects")));
  assert.ok(file.endsWith(join("runs", "run-abc.log")));
  // The project key is basename-slug + sha256 prefix, exactly like the engine.
  assert.match(file, /pdw-progress-test-[0-9a-f]{12}\/runs\/run-abc\.log$/);
});

test("createProgressSink anchors to the GIT ROOT so the gate fingerprint excludes it", () => {
  // A repo with a subdirectory cwd: the ndjson must land at the git root's
  // .pi (GATE_EXCLUDE_PATHSPECS `:/.pi`), NOT the subdir's own .pi.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pdw-gitroot-")));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t"], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { stdio: "ignore" });
  const subdir = join(repo, "sub");
  mkdirSync(subdir, { recursive: true });

  const sink = createProgressSink(subdir, newPdwRunId());
  assert.ok(sink.progressFile.startsWith(join(repo, ".pi")), "must anchor to the git root");
  assert.equal(sink.progressFile, join(repo, ".pi", "pdw-progress", `${sink.runId}.ndjson`));
  assert.ok(existsSync(sink.progressFile));
});

test("createProgressSink writes ndjson events and tracks counts in summary", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-sink-"));
  const runId = newPdwRunId();
  const sink = createProgressSink(cwd, runId);

  assert.equal(sink.progressFile, join(cwd, ".pi", "pdw-progress", `${runId}.ndjson`));
  assert.ok(existsSync(sink.progressFile), "progress file is created eagerly (tail -f ready)");

  sink.setTotal(2);
  assert.match(sink.summary(), /0\/2 agents/);

  sink.callbacks.onPhase("Shard reviews");
  sink.callbacks.onAgentStart({ label: "shard-1", phase: "Shard reviews", model: "gpt-x" });
  sink.callbacks.onAgentStart({ label: "shard-2", phase: "Shard reviews" });
  assert.match(sink.summary(), /active: shard-1, shard-2/);

  sink.callbacks.onAgentEnd({ label: "shard-1", phase: "Shard reviews", model: "gpt-x", tokens: 1234 });
  assert.match(sink.summary(), /1\/2 agents/);
  // model + wall-clock duration are in the live summary (goal exit criterion 1).
  assert.match(sink.summary(), /shard-1 done \(\[gpt-x\] .*s?, 1234 tok\)/);

  sink.callbacks.onAgentEnd({ label: "shard-2", error: "AGENT_EMPTY_OUTPUT", errorCode: "AGENT_EMPTY_OUTPUT" });
  assert.match(sink.summary(), /2\/2 agents/);
  assert.match(sink.summary(), /shard-2 FAILED/);

  sink.done();

  const lines = readFileSync(sink.progressFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as PdwProgressEvent);

  assert.deepEqual(
    lines.map((e) => e.type),
    ["phase", "agent-start", "agent-start", "agent-end", "agent-fail", "run-end"],
  );
  const fail = lines[4];
  assert.equal(fail.type, "agent-fail");
  if (fail.type === "agent-fail") {
    assert.equal(fail.label, "shard-2");
    assert.equal(fail.errorCode, "AGENT_EMPTY_OUTPUT");
    assert.equal(fail.recoverable, undefined);
  }
  const end = lines[3];
  assert.equal(end.type, "agent-end");
  if (end.type === "agent-end") {
    assert.equal(end.label, "shard-1");
    assert.equal(end.tokens, 1234);
  }
  assert.equal(lines[lines.length - 1].type, "run-end");
  // durationMs is computed by the sink (engine events carry no duration).
  assert.equal(fail.type, "agent-fail");
  if (fail.type === "agent-fail") {
    assert.equal(typeof fail.durationMs, "number");
  }
  assert.equal(end.type, "agent-end");
  if (end.type === "agent-end") {
    assert.equal(typeof end.durationMs, "number");
  }
});

test("sink tolerates write failures and callback garbage", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-sink-robust-"));
  const sink = createProgressSink(cwd, newPdwRunId());
  // Malformed engine events must not throw (defensive String()/slice everywhere).
  sink.callbacks.onLog(undefined as unknown as string);
  sink.callbacks.onAgentStart({} as { label: string });
  sink.callbacks.onAgentEnd({ label: null } as unknown as { label: string });
  sink.callbacks.onRuntimeEvent({ circular: undefined });
  // The exact path fixed in review: JSON.stringify(undefined) returns
  // undefined (not a throw), which used to crash detail.slice.
  sink.callbacks.onRuntimeEvent(undefined);
  sink.done();
  const lines = readFileSync(sink.progressFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), "every line must stay valid JSON");
  }
});

test("sink survives a real append failure (EISDIR) without throwing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pdw-sink-eisdir-"));
  const sink = createProgressSink(cwd, newPdwRunId());
  // Replace the ndjson file with a DIRECTORY of the same name: every
  // appendFileSync now fails with EISDIR — the sink must degrade silently
  // and keep in-memory events for the summary.
  rmSync(sink.progressFile, { force: true });
  mkdirSync(sink.progressFile, { recursive: true });

  sink.setTotal(1);
  sink.callbacks.onAgentStart({ label: "shard-1", model: "gpt-x" });
  sink.callbacks.onAgentEnd({ label: "shard-1", model: "gpt-x", tokens: 7 });
  assert.doesNotThrow(() => sink.done());
  assert.match(sink.summary(), /1\/1 agents/);
  assert.match(sink.summary(), /shard-1 done/);
  assert.equal(sink.events.length, 3, "in-memory events survive the write failure");
  assert.equal(sink.events[sink.events.length - 1].type, "run-end");
});

test("sink creation never throws when the progress dir cannot be created", () => {
  // `.pi` exists as a REGULAR FILE → mkdir .pi/pdw-progress fails (ENOTDIR).
  const cwd = mkdtempSync(join(tmpdir(), "pdw-sink-enotdir-"));
  writeFileSync(join(cwd, ".pi"), "not a directory", "utf8");

  const sink = createProgressSink(cwd, newPdwRunId());
  assert.equal(existsSync(sink.progressFile), false, "no file could be created");
  // The sink still works in-memory and must not throw on events or done().
  sink.setTotal(1);
  sink.callbacks.onAgentStart({ label: "shard-1" });
  sink.callbacks.onAgentEnd({ label: "shard-1" });
  assert.doesNotThrow(() => sink.done());
  assert.match(sink.summary(), /1\/1 agents/);
});
