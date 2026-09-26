import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupAgentsCheck } from "../lib/agents-startup.ts";
import { formatAgentsStartupRefusal } from "../lib/agents-startup-copy.ts";
import type { ModelRegistry } from "../lib/model-spec.ts";

const REG: ModelRegistry = {
  anthropic: [{ id: "claude-fable-5", thinkingLevelMap: { max: "max" } }],
};
const OK = { auto: false, slots: ["anthropic/claude-fable-5:max"] };
const BAD = { auto: false, slots: ["nope/no-such-model"] };

function refusal(agentsGlobal: unknown, agentsProject: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "startup-copy-"));
  try {
    const globalPath = join(dir, "home", ".pi", "review-gate.json");
    const projectPath = join(dir, "repo", ".pi", "review-gate.json");
    const res = startupAgentsCheck({
      agentsGlobal,
      agentsProject,
      registry: REG,
      configPath: globalPath,
      projectConfigPath: projectPath,
      agentsDir: null,
      validNames: ["reviewer"],
    });
    const refused = formatAgentsStartupRefusal(res);
    return { refused, text: refused ?? "", res, globalPath, projectPath };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a broken PROJECT-layer worker preset names the project file, not the global one", () => {
  const { text, res, globalPath, projectPath } = refusal({ reviewer: OK }, { "worker-x": BAD });
  assert.deepEqual(res.fixFiles, [projectPath]);
  assert.ok(text.includes(`修复 ${projectPath} 后重开会话`), text);
  assert.ok(!text.includes(globalPath), text);
  assert.ok(!text.includes("~/.pi/review-gate.json"), text);
  assert.match(text, /^\n\n## REVIEW-GATE: 配置错误，会话无法启动\nreview-gate: /);
});

test("a broken GLOBAL-layer worker preset names the global file", () => {
  const { text, res, globalPath, projectPath } = refusal({ reviewer: OK, worker: BAD }, undefined);
  assert.deepEqual(res.fixFiles, [globalPath]);
  assert.ok(text.includes(`修复 ${globalPath} 后重开会话`), text);
  assert.ok(!text.includes(projectPath), text);
});

test("a project entry that shadows the global one names the project file", () => {
  const { res, projectPath } = refusal({ reviewer: OK, worker: OK }, { worker: BAD });
  assert.deepEqual(res.configFiles, { worker: projectPath });
});

test("an unconfigured judge the heal cannot fill names the global file and carries the heal's reason", () => {
  const { text, globalPath } = refusal(undefined, { worker: OK });
  assert.ok(text.includes(`（配置文件：${globalPath}）`), text);
  assert.match(text, /启动自愈也没能补上/);
  assert.equal(existsSync(globalPath), false);
});

test("everything valid ⇒ no refusal", () => {
  const { refused, res } = refusal({ reviewer: OK }, { worker: OK });
  assert.equal(refused, undefined);
  assert.deepEqual(res.fixFiles, []);
});
