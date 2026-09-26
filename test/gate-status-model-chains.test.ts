import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelDiagnosisLines } from "../lib/gate-diagnosis-commands.ts";

test("/gate-status model chains list only the judge roles and configured worker presets", () => {
  const home = mkdtempSync(join(tmpdir(), "gate-status-chains-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const agents = join(home, ".pi", "agent", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "reviewer.md"), "---\nname: reviewer\nmodel: anthropic/claude-fable-5\n---\n");
    // A leftover that is not a gate role: it must not appear at all.
    writeFileSync(join(agents, "fable.md"), "---\nname: fable\nmodel: gone/nothing\n---\n");
    writeFileSync(
      join(home, ".pi", "review-gate.json"),
      JSON.stringify({ agents: { worker: { auto: false, slots: ["deepseek/deepseek-flash:max"] }, "worker-empty": { prompt: "x" }, "worker-auto": { auto: true, slots: ["deepseek/deepseek-flash:max"] } } }),
    );
    const repo = join(home, "repo");
    mkdirSync(repo);
    const registry = {
      getAll: () => [
        { provider: "anthropic", id: "claude-fable-5" },
        { provider: "deepseek", id: "deepseek-flash", thinkingLevelMap: { max: "max" } },
      ],
    };
    const text = modelDiagnosisLines(
      { primaryRepoRoot: () => repo, cwd: repo, packageRoot: repo, findProjectAgentText: () => undefined },
      registry,
    ).join("\n");
    assert.match(text, /reviewer: → anthropic\/claude-fable-5/);
    assert.match(text, /worker: → deepseek\/deepseek-flash/);
    assert.doesNotMatch(text, /fable:/);
    // A declared preset with no slots refuses startup, so it must show as BLOCKED, not vanish.
    assert.match(text, /worker-empty: ⚠️ BLOCKED/);
    assert.match(text, /worker-auto: ⚠️ BLOCKED/);
    assert.equal(text.match(/BLOCKED/g)?.length, 2);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
