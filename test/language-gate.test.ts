import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { LANGUAGE_DIRECTIVE } from "../lib/constants.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = readFileSync(join(ROOT, "extensions", "review-gate.ts"), "utf8");

// ---------------------------------------------------------------------------
// The directive content itself.

test("LANGUAGE_DIRECTIVE demands strict Simplified Chinese output", () => {
  assert.match(LANGUAGE_DIRECTIVE, /简体中文/);
  assert.match(LANGUAGE_DIRECTIVE, /严格/);
  // Applies to user-facing output.
  assert.match(LANGUAGE_DIRECTIVE, /面向用户/);
});

test("LANGUAGE_DIRECTIVE asks thinking to be in Chinese too", () => {
  assert.match(LANGUAGE_DIRECTIVE, /thinking/);
  assert.match(LANGUAGE_DIRECTIVE, /思考过程/);
});

test("LANGUAGE_DIRECTIVE exempts protocol-fixed English tokens (fail-safe for the gate)", () => {
  // Must NOT force-translate the verdict enum, or record_review/precommit
  // parsing would break.
  assert.match(LANGUAGE_DIRECTIVE, /READY/);
  assert.match(LANGUAGE_DIRECTIVE, /BLOCKED/);
  assert.match(LANGUAGE_DIRECTIVE, /NEEDS_HUMAN/);
  // Code, paths, commands, commit messages are exempt.
  assert.match(LANGUAGE_DIRECTIVE, /代码/);
  assert.match(LANGUAGE_DIRECTIVE, /commit message/);
  assert.match(LANGUAGE_DIRECTIVE, /Overall/); // precommit sentinel exemption
});

// ---------------------------------------------------------------------------
// Wiring: the extension injects it UNCONDITIONALLY, from the single source.

test("extension imports the directive from lib/constants (single source of truth)", () => {
  assert.match(EXT, /LANGUAGE_DIRECTIVE/);
  // It must be a named import from constants, not an inline re-declaration.
  assert.match(EXT, /import\s*\{[\s\S]*LANGUAGE_DIRECTIVE[\s\S]*\}\s*from\s*["']\.\.\/lib\/constants\.ts["']/);
  // No second declaration of the directive anywhere in the extension.
  assert.doesNotMatch(EXT, /const\s+LANGUAGE_DIRECTIVE\s*=/);
});

test("language gate is injected in before_agent_start", () => {
  assert.match(EXT, /before_agent_start/);
  assert.match(EXT, /event\.systemPrompt\s*\+\s*"\\n\\n"\s*\+\s*LANGUAGE_DIRECTIVE/);
});

/**
 * The OLD unconditional "nothing changed" early return was REMOVED 2026-08-30:
 * the loop directives (goal + decision table) must reach the FIRST turn. A
 * narrower undecided-clean early return (taskMode undefined && clean) was
 * added in round 3 — it sits after the loop injection, so loop mode still
 * renders the full block every turn. The language directive's unconditional
 * status is preserved by sitting at the very top of the handler, before
 * every branch and every return.
 */

/**
 * How much of the handler to slice for the ordering assertions. Generous on
 * purpose: every prompt branch added ahead of the early return (explore
 * workflow, loop goal, the oversized-requirement checkpoints, …) pushes it
 * further down, and a window that only just fits turns an unrelated addition
 * into a false failure. Raised from 6000 when the oversized-requirement
 * checkpoints landed; the assertions themselves are unchanged — what is being
 * tested is the ORDER of the injection and the early return, not the distance
 * between them.
 */
const HANDLER_WINDOW = 9000;

test("language gate is UNCONDITIONAL — injected at the top of before_agent_start", () => {
  // Locate the handler body.
  const start = EXT.indexOf('pi.on("before_agent_start"');
  assert.ok(start >= 0, "handler must exist");
  const body = EXT.slice(start, start + HANDLER_WINDOW);
  const injectAt = body.indexOf("LANGUAGE_DIRECTIVE");
  // The language directive is the FIRST thing appended to the system prompt,
  // before the mode branches and before any return.
  const firstAppend = body.indexOf("let systemPrompt");
  assert.ok(injectAt >= 0 && firstAppend >= 0, "injection must exist");
  assert.ok(injectAt > firstAppend, "LANGUAGE_DIRECTIVE must be appended first");
  // The language directive is appended before ANY return in the handler —
  // explore, normal, orchestrator and the undecided-clean early return all
  // come after it, so it can never be skipped.
  const firstReturn = body.search(/return\s*\{/);
  assert.ok(firstReturn > 0, "a return must exist");
  assert.ok(injectAt < firstReturn,
    "LANGUAGE_DIRECTIVE is appended before the first return");
});

test("the handler always returns a systemPrompt (never undefined)", () => {
  const start = EXT.indexOf('pi.on("before_agent_start"');
  const body = EXT.slice(start, start + HANDLER_WINDOW);
  // The handler ends with a single `return { systemPrompt: ... }` — the
  // explore/orchestrator branches return early, but the fall-through path
  // (loop, child, unarmed) must always produce the full prompt object.
  assert.match(body, /return\s*\{\s*systemPrompt:/);
});
