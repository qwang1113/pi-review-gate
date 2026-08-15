import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CRITERIA_THRESHOLD,
  DIRECTORY_THRESHOLD,
  MODULE_BUCKETS,
  assessRequirementSize,
  buildDecomposeSuggestion,
  countExitCriteria,
  detectTouchedDirs,
} from "../lib/requirement-size.ts";
import { classifyRequirementSize, type LlmClassifier } from "../lib/llm-classify.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIRS = ["lib", "test", "docs", "agents", "skills", "hooks", "extensions", "scripts"];

function fakeClassifier(reply: string | undefined): LlmClassifier {
  return {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    timeoutMs: 8000,
    exec: async () => reply,
  };
}

test("no signal fires on an ordinary request", () => {
  const verdict = assessRequirementSize({
    criteriaCount: 3,
    touchedDirs: ["lib", "test"],
    moduleBucket: "2",
  });
  assert.equal(verdict.oversized, false);
  assert.equal(verdict.degraded, false);
  assert.deepEqual(verdict.reasons, []);
});

test("each threshold fires on its own and names the evidence that fired", () => {
  const byCriteria = assessRequirementSize({ criteriaCount: CRITERIA_THRESHOLD });
  assert.equal(byCriteria.oversized, true);
  assert.equal(byCriteria.reasons.length, 1);
  assert.match(byCriteria.reasons[0], /exit criteria/);

  const byDirs = assessRequirementSize({ touchedDirs: ["lib", "test", "docs"] });
  assert.equal(byDirs.oversized, true);
  assert.match(byDirs.reasons[0], /3 top-level directories \(lib, test, docs/);

  const byModel = assessRequirementSize({ moduleBucket: "3-5" });
  assert.equal(byModel.oversized, true);
  assert.match(byModel.reasons[0], /classifier estimates 3-5 modules/);

  // Just below each threshold: nothing fires.
  assert.equal(assessRequirementSize({ criteriaCount: CRITERIA_THRESHOLD - 1 }).oversized, false);
  assert.equal(assessRequirementSize({ touchedDirs: ["lib", "test"] }).oversized, false);
  assert.equal(assessRequirementSize({ moduleBucket: "2" }).oversized, false);
});

test("duplicate directories cannot inflate the breadth signal", () => {
  const verdict = assessRequirementSize({ touchedDirs: ["lib", "lib", "lib", "lib"] });
  assert.equal(verdict.oversized, false, "one directory named four times is still one directory");
});

test("every threshold that fires contributes its own reason", () => {
  const verdict = assessRequirementSize({
    criteriaCount: 7,
    touchedDirs: ["lib", "test", "docs", "agents"],
    moduleBucket: "6+",
  });
  assert.equal(verdict.reasons.length, 3);
});

test("an unavailable classifier is reported as degraded, never as 'not big'", () => {
  const verdict = assessRequirementSize({ criteriaCount: 2, classifierUnavailable: true });
  assert.equal(verdict.oversized, false);
  assert.equal(verdict.degraded, true, "the caller must be able to tell 'small' from 'unknown'");

  const text = buildDecomposeSuggestion(verdict, "first-message");
  assert.match(text, /DEGRADED SIGNAL/);
  assert.match(text, /classifier was unavailable/);
  assert.match(text, /nothing was actually measured/, "with no reasons it must say so plainly");
  assert.match(text, /do not present it as a judgement the gate made/);
});

test("structural thresholds still fire while the classifier is down, and the text says so", () => {
  const verdict = assessRequirementSize({ criteriaCount: 6, classifierUnavailable: true });
  assert.equal(verdict.oversized, true, "structural rules do not depend on the model");
  const text = buildDecomposeSuggestion(verdict, "loop-goal");
  assert.match(text, /6 exit criteria/);
  assert.match(text, /DEGRADED SIGNAL/);
  assert.doesNotMatch(text, /nothing was actually measured/, "a real threshold DID fire");
});

test("the suggestion demands a proposal and a stop, and never decides for the user", () => {
  const text = buildDecomposeSuggestion(assessRequirementSize({ criteriaCount: 9 }), "first-message");
  assert.match(text, /`\/decompose`/);
  assert.match(text, /open your very next reply/i);
  assert.match(text, /STOP and let the user decide/);
  assert.match(text, /do not silently skip this/i);
  assert.match(text, /If the user declines, carry on normally/);
  assert.doesNotMatch(text, /\bI will (now )?(start|begin|run)\b/i, "the gate proposes; it does not start");
});

test("exit criteria are counted only under their own heading", () => {
  const goal = [
    "# Some goal",
    "",
    "**Intent**: do a thing.",
    "",
    "## Exit criteria",
    "",
    "1. first",
    "2. second",
    "   continued on another line, not a new item",
    "3. third",
    "",
    "## Non-goals",
    "",
    "1. not this",
    "2. nor this",
    "3. nor that",
    "4. definitely not",
    "",
    "**Date**: 2026-08-12",
  ].join("\n");
  assert.equal(countExitCriteria(goal), 3, "non-goals and continuation lines must not count");
  assert.equal(countExitCriteria("# no criteria here\n\n1. a list in prose\n"), 0);
  assert.equal(countExitCriteria(""), 0);
});

test("a real-shaped loop goal is counted correctly", () => {
  // Shaped exactly like the goals propose_loop_goal writes (heading levels,
  // bold Intent/Date lines, a numbered Non-goals list, multi-line criteria).
  // Inlined rather than read from `.pi/loop-goal.md`: that file is git-ignored
  // session state, so a live fixture would fail on a fresh clone and would
  // couple the suite to whatever goal happens to be approved at the time.
  const goal = [
    "# 大需求自动识别与 /decompose 提议",
    "",
    "**Intent**: 让门禁在两个检查点自动判断需求是否超大。",
    "",
    "## Exit criteria",
    "",
    "1. 新增 `classifyRequirementSize`（复用现有分类器基建），返回判定依据；",
    "   模型不可用时返回明确的 unavailable。",
    "2. 结构化阈值判定不依赖模型且有单测。",
    "3. 两个检查点接入。",
    "4. 抑制与降级。",
    "5. 现有门禁不变量零改动。",
    "6. 交付为一个 PR。",
    "",
    "## Non-goals",
    "",
    "1. 自动进入 orchestration 流程",
    "2. 运行时中途转入拆分",
    "3. 每条用户消息都判定",
    "",
    "**Date**: 2026-08-12",
  ].join("\n");
  assert.equal(countExitCriteria(goal), 6, "six criteria: non-goals and continuation lines excluded");
});

test("directories are detected as paths, not as words that happen to match", () => {
  assert.deepEqual(detectTouchedDirs("rework lib/ and test/ and docs/", REPO_DIRS), ["lib", "test", "docs"]);
  assert.deepEqual(detectTouchedDirs("touch ./lib/plan-state.ts", REPO_DIRS), ["lib"]);
  assert.deepEqual(
    detectTouchedDirs("let me test that, and check the docs, then run the hooks", REPO_DIRS),
    [],
    "bare words are not directories",
  );
  assert.deepEqual(
    detectTouchedDirs("see https://example.com/docs/guide", REPO_DIRS),
    [],
    "a URL path segment is not a repo directory",
  );
  assert.deepEqual(detectTouchedDirs("mylib/thing.ts", REPO_DIRS), [], "a suffix match is not a directory");
});

test("the classifier accepts only its own single-key verdict", async () => {
  for (const bucket of MODULE_BUCKETS) {
    assert.equal(await classifyRequirementSize(fakeClassifier(`{"modules":"${bucket}"}`), "do a thing"), bucket);
  }
  for (const bad of [
    undefined,
    "",
    "3-5",
    '{"mode":"loop"}',
    '{"modules":"7"}',
    '{"modules":"3-5","extra":1}',
    'The answer is {"modules":"6+"}',
  ]) {
    assert.equal(
      await classifyRequirementSize(fakeClassifier(bad), "do a thing"),
      undefined,
      `must reject ${JSON.stringify(bad)}`,
    );
  }
});

test("the classifier is not consulted about an empty request", async () => {
  let called = false;
  const spy: LlmClassifier = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    timeoutMs: 8000,
    exec: async () => {
      called = true;
      return '{"modules":"6+"}';
    },
  };
  assert.equal(await classifyRequirementSize(spy, "   "), undefined);
  assert.equal(await classifyRequirementSize(spy, undefined), undefined);
  assert.equal(called, false, "no first message means no model call to make");
});

test("the extension wires both checkpoints and suggests at most once per session", () => {
  const src = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");
  assert.match(src, /classifyRequirementSize\(classifier\(\), firstUserInput\)/, "checkpoint 1: the first message");
  assert.match(src, /countExitCriteria\(goal\.text\)/, "checkpoint 2: the approved loop goal");
  assert.match(
    src,
    /decomposeSuggestedAt === null/,
    "the suggestion must be guarded by the session-level marker",
  );
  assert.match(
    src,
    /if \(assessment\.oversized\) \{/,
    "an evidence-backed suggestion spends the session's one ask",
  );
  assert.match(
    src,
    /else if \(assessment\.degraded && !degradedNoticeShown\)/,
    "a degraded run still speaks up once, on its OWN budget: an evidence-free " +
      "notice must not silence the later loop-goal checkpoint",
  );
  assert.doesNotMatch(
    src,
    /degradedNoticeShown = true;\s*\n\s*decomposeSuggestedAt/,
    "the two budgets must stay independent",
  );
  assert.match(
    src,
    /await classifyRequirementSize\(classifier\(\), firstUserInput\)/,
    "the size hint reads the user's real first message, captured cache-only",
  );
  assert.match(
    src,
    /criteriaCount: atLoopGoal \? countExitCriteria\(goal\.text\) : undefined/,
    "only an APPROVED goal contributes its criteria count",
  );
});

test("the honesty rule: never consulted is not the same as consulted and failed", () => {
  // A headless or explicitly-moded session never calls the classifier. Claiming
  // "unavailable" there would be a fabricated excuse, so `degraded` must stay
  // false and the suggestion text must carry no degradation notice.
  const neverConsulted = assessRequirementSize({ criteriaCount: 6 });
  assert.equal(neverConsulted.degraded, false);
  assert.equal(neverConsulted.oversized, true, "structural signals work without the model");
  assert.doesNotMatch(buildDecomposeSuggestion(neverConsulted, "loop-goal"), /DEGRADED/);

  const consultedAndFailed = assessRequirementSize({ criteriaCount: 6, classifierUnavailable: true });
  assert.equal(consultedAndFailed.degraded, true);
  assert.match(buildDecomposeSuggestion(consultedAndFailed, "loop-goal"), /DEGRADED/);
});

test("detection is advisory only: it must not touch any enforcement path", () => {
  const src = readFileSync(join(ROOT, "lib", "requirement-size.ts"), "utf8");
  for (const forbidden of ["record_review", "run_precommit", "declare_done", "fingerprint", "unmetRequirements"]) {
    assert.doesNotMatch(
      src,
      new RegExp(forbidden),
      `${forbidden} has no business in a prompt-only suggestion module`,
    );
  }
  assert.equal(
    /import\s/.test(src),
    false,
    "the module must stay dependency-free so its thresholds are trivially testable",
  );
  assert.equal(CRITERIA_THRESHOLD, 5);
  assert.equal(DIRECTORY_THRESHOLD, 3);
});
