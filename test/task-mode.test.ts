import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideTaskMode,
  normalizeTaskMode,
  suggestTaskMode,
  TASK_MODE_CHOICE_EXPLORE,
  TASK_MODE_CHOICE_LOOP,
  TASK_MODE_CHOICE_TITLE,
} from "../lib/task-mode.ts";

// ---------------------------------------------------------------------------
// Classifier: suggestTaskMode

test("implementation prompts confidently suggest loop workflow", () => {
  for (const prompt of [
    "fix the login bug",
    "please implement caching",
    "帮我修改这个扩展",
    "新增一个命令并重构状态管理",
  ]) {
    assert.deepEqual(suggestTaskMode(prompt), { mode: "loop", confident: true }, prompt);
  }
});

test("pure analysis prompts confidently suggest explore workflow", () => {
  for (const prompt of [
    "explain why this test fails",
    "review the architecture",
    "帮我分析一下这个仓库",
    "查看代码并总结风险",
    "帮我排查这个报错",
  ]) {
    assert.deepEqual(suggestTaskMode(prompt), { mode: "explore", confident: true }, prompt);
  }
});

test("write intent wins over analysis wording", () => {
  assert.deepEqual(suggestTaskMode("review this code and fix the bug"), { mode: "loop", confident: true });
  assert.deepEqual(suggestTaskMode("分析后帮我修改实现"), { mode: "loop", confident: true });
});

test("SECURITY: explore hint + mutation/ship verb must NOT auto-select explore", () => {
  // An auto-selected explore relaxes auto-continuation and declare_done; a
  // heuristic misfire on a prompt that actually wants shipping would let the
  // agent stop early. Any prompt mixing an analysis hint with a mutation/ship
  // verb outside LOOP_HINTS must ask the user (confident: false).
  for (const prompt of [
    "review this code and deploy it",
    "review the current changes and commit them",
    "how about merging this PR?",
    "review this and save the findings to a file",
    "explain the diff then push it",
    "analyze the config and apply it to prod",
    "review this and upload the artifact",
    "analyze this then submit the PR",
    "inspect this and open a pull request",
    "review this and copy the result into config.json",
    "explain this then sync it to production",
    "summarize the log and append it to notes.md",
    "review and move the file to src/",
    "审阅这些改动并提交",
    "分析一下然后部署上线",
    "查看结果并保存到文件",
    "总结变更后合并这个 PR",
    "分析后上传产物",
    "分析后同步到生产环境",
    "查看后追加到文件",
    "对比两个分支后复制配置",
  ]) {
    assert.deepEqual(suggestTaskMode(prompt), { mode: "loop", confident: false }, prompt);
  }
});

test("SECURITY: explore hint + verification intent must NOT auto-select explore", () => {
  // Explore could run tests (bash is available in that mode), but a prompt
  // asking to verify tests/lint/typecheck/build signals delivery-validation
  // intent that belongs to the enforced loop. Keep the conservative behavior:
  // fall through to the dialog (confident: false) — over-asking is safe.
  for (const prompt of [
    "review the current changes and verify the tests pass",
    "review this diff and make sure the tests still pass",
    "analyze the module and run the tests",
    "review and lint the codebase",
    "inspect the diff and typecheck it",
    "review the PR and rerun CI",
    "审阅这些改动并验证测试通过",
    "分析一下然后跑测试",
    "查看代码并编译验证",
  ]) {
    assert.deepEqual(suggestTaskMode(prompt), { mode: "loop", confident: false }, prompt);
  }
  // But a bare "test" noun in an analysis question stays confident explore.
  assert.deepEqual(
    suggestTaskMode("explain why this test fails"),
    { mode: "explore", confident: true },
  );
});

test("ambiguous prompts are not confident and fail closed to loop", () => {
  assert.deepEqual(suggestTaskMode("hello"), { mode: "loop", confident: false });
  assert.deepEqual(suggestTaskMode("你好"), { mode: "loop", confident: false });
});

// ---------------------------------------------------------------------------
// normalizeTaskMode — whitelist + forged values

test("normalizeTaskMode accepts only the canonical modes", () => {
  assert.equal(normalizeTaskMode("loop"), "loop");
  assert.equal(normalizeTaskMode("explore"), "explore");
});

test("normalizeTaskMode fails closed on unknown or non-string values", () => {
  for (const v of ["readonly", "free", "EXPLORE", "", 42, null, undefined, {}]) {
    assert.equal(normalizeTaskMode(v), undefined, String(v));
  }
});

// ---------------------------------------------------------------------------
// Decision flow: decideTaskMode (the extension's input handler delegates here)

function selectSpy(answer: string | undefined) {
  const calls: Array<{ title: string; options: string[] }> = [];
  return {
    calls,
    select: async (title: string, options: string[]) => {
      calls.push({ title, options });
      return answer;
    },
  };
}

test("confident classification auto-decides without showing the dialog", async () => {
  const loopSpy = selectSpy(TASK_MODE_CHOICE_EXPLORE); // would flip mode if consulted
  assert.deepEqual(
    await decideTaskMode({ prompt: "fix the login bug", hasUI: true, select: loopSpy.select }),
    { mode: "loop", via: "auto", source: "auto" },
  );
  assert.equal(loopSpy.calls.length, 0);

  const exploreSpy = selectSpy(TASK_MODE_CHOICE_LOOP);
  assert.deepEqual(
    await decideTaskMode({ prompt: "explain this architecture", hasUI: true, select: exploreSpy.select }),
    { mode: "explore", via: "auto", source: "auto" },
  );
  assert.equal(exploreSpy.calls.length, 0);
});

test("ambiguous prompt shows the dialog; only an explicit choice is source=user", async () => {
  const exploreSpy = selectSpy(TASK_MODE_CHOICE_EXPLORE);
  assert.deepEqual(
    await decideTaskMode({ prompt: "hello", hasUI: true, select: exploreSpy.select }),
    { mode: "explore", via: "dialog", source: "user" },
  );
  assert.equal(exploreSpy.calls.length, 1);
  assert.equal(exploreSpy.calls[0].title, TASK_MODE_CHOICE_TITLE);
  assert.deepEqual(exploreSpy.calls[0].options, [TASK_MODE_CHOICE_LOOP, TASK_MODE_CHOICE_EXPLORE]);

  const loopSpy = selectSpy(TASK_MODE_CHOICE_LOOP);
  assert.deepEqual(
    await decideTaskMode({ prompt: "hello", hasUI: true, select: loopSpy.select }),
    { mode: "loop", via: "dialog", source: "user" },
  );
});

test("cancelled dialog and unknown answers fail closed to loop (source=auto)", async () => {
  for (const answer of [undefined, "", "garbage"]) {
    const spy = selectSpy(answer);
    assert.deepEqual(
      await decideTaskMode({ prompt: "hello", hasUI: true, select: spy.select }),
      { mode: "loop", via: "dialog-cancelled", source: "auto" },
      String(answer),
    );
  }
});

test("no UI (print/JSON mode) fails closed to loop without consulting select", async () => {
  const spy = selectSpy(TASK_MODE_CHOICE_EXPLORE);
  assert.deepEqual(
    await decideTaskMode({ prompt: "explain this repo", hasUI: false, select: spy.select }),
    { mode: "loop", via: "no-ui", source: "auto" },
  );
  assert.equal(spy.calls.length, 0);
});

// ---------------------------------------------------------------------------
// LLM classifier integration (guard #1 — lib/llm-classify.ts wiring)

test("LLM verdict wins over the regex heuristic and keeps source=auto", async () => {
  const spy = selectSpy(TASK_MODE_CHOICE_LOOP);
  // Regex would confidently say loop ("fix"), but the prompt is actually a
  // question quoting a log line — the semantic classifier sees explore.
  assert.deepEqual(
    await decideTaskMode({
      prompt: 'why does the log say "fix applied" twice?',
      hasUI: true,
      select: spy.select,
      classify: async () => "explore",
    }),
    { mode: "explore", via: "llm", source: "auto" },
  );
  assert.equal(spy.calls.length, 0); // no dialog when the classifier answers

  assert.deepEqual(
    await decideTaskMode({
      prompt: "explain this repo", // regex would say explore
      hasUI: true,
      select: spy.select,
      classify: async () => "loop",
    }),
    { mode: "loop", via: "llm", source: "auto" },
  );
});

test("classifier failure falls back to the regex heuristic (fail-back)", async () => {
  const spy = selectSpy(TASK_MODE_CHOICE_EXPLORE);
  assert.deepEqual(
    await decideTaskMode({
      prompt: "fix the login bug",
      hasUI: true,
      select: spy.select,
      classify: async () => undefined,
    }),
    { mode: "loop", via: "auto", source: "auto" },
  );
  assert.equal(spy.calls.length, 0);
});

test("classifier failure on an ambiguous prompt still shows the dialog", async () => {
  const spy = selectSpy(TASK_MODE_CHOICE_EXPLORE);
  assert.deepEqual(
    await decideTaskMode({
      prompt: "hello",
      hasUI: true,
      select: spy.select,
      classify: async () => undefined,
    }),
    { mode: "explore", via: "dialog", source: "user" },
  );
  assert.equal(spy.calls.length, 1);
});

test("no-UI mode never consults the classifier (fail-closed loop)", async () => {
  let called = false;
  const spy = selectSpy(TASK_MODE_CHOICE_EXPLORE);
  assert.deepEqual(
    await decideTaskMode({
      prompt: "explain this repo",
      hasUI: false,
      select: spy.select,
      classify: async () => { called = true; return "explore"; },
    }),
    { mode: "loop", via: "no-ui", source: "auto" },
  );
  assert.equal(called, false);
});
