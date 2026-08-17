import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeInjectedWorkflowText } from "../lib/pdw-bridge.ts";


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

test("WAVE worklog text never trips the blocklist, even when the module brief is dirty", () => {
  // The review path no longer generates a workflow script (reviews run as plain
  // subagents), so the shard-script case is gone. Wave workers DO still run on
  // the engine, and their task text carries user prose — that is now the surface
  // this sanitizer protects.
  const dirty = "module brief mentions Date.now() and Math.random() and new Date()";
  const sanitized = sanitizeInjectedWorkflowText(dirty);
  assert.ok(!BLOCKLIST.test(sanitized), `sanitized text still trips the blocklist:\n${sanitized}`);
  // Embedding it in a script-shaped string must stay clean too.
  const script = `const brief = ${JSON.stringify(sanitized)}\nreturn brief`;
  assert.ok(!BLOCKLIST.test(script), `generated script trips the blocklist:\n${script}`);
});
