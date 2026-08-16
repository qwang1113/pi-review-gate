import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeInjectedWorkflowText } from "../lib/pdw-bridge.ts";
import { generateShardReviewScript } from "../lib/parallel-review.ts";

/**
 * pdw's workflow-script validator (parseWorkflowScript) rejects a script whose
 * SOURCE TEXT matches /Date\.now|Math\.random|new Date\(\)/ — a plain regex
 * that does not understand string literals. Diff/goal text injected into the
 * script that merely MENTIONS those tokens therefore fails SCRIPT_VALIDATION
 * even though no script code uses them. These tests pin the injection-side
 * sanitizer that keeps generated scripts valid.
 */
const BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

test("sanitizeInjectedWorkflowText neutralizes the determinism blocklist tokens", () => {
  const dirty = "call Date.now() or Math.random() or new Date() in code";
  const clean = sanitizeInjectedWorkflowText(dirty);
  assert.ok(!BLOCKLIST.test(clean), `sanitized text still matches blocklist: ${clean}`);
  // Zero-width spaces keep the text human/LLM-readable.
  assert.match(clean, /Date\u200b\.now/);
  assert.match(clean, /Math\u200b\.random/);
  assert.match(clean, /new Date\u200b\(\)/);
});

test("sanitize is idempotent", () => {
  const once = sanitizeInjectedWorkflowText("Date.now");
  assert.equal(sanitizeInjectedWorkflowText(once), once);
});

test("sanitize leaves unrelated text untouched", () => {
  assert.equal(sanitizeInjectedWorkflowText("plain diff text"), "plain diff text");
  // new Date(now - ageMs) with ARGUMENTS is not a blocklist token — untouched.
  assert.equal(sanitizeInjectedWorkflowText("new Date(now - ageMs)"), "new Date(now - ageMs)");
});

test("generateShardReviewScript output never trips the blocklist, even with dirty goal/diff", () => {
  const dirtyGoal = "goal mentions Date.now() and Math.random() and new Date()";
  const shards = [
    {
      id: "s1",
      label: "shard-1",
      files: ["extensions/review-gate.ts"],
      description: "diff includes Date.now() call sites",
      lineCount: 100,
      note: "",
    },
  ];
  const script = generateShardReviewScript({ shards, goalText: dirtyGoal, model: "claude-fable-5" });
  assert.ok(!BLOCKLIST.test(script), `generated script trips the blocklist:\n${script}`);
});
