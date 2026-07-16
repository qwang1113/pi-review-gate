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
  assert.match(EXT, /import\s*\{[\s\S]*LANGUAGE_DIRECTIVE[\s\S]*\}\s*from\s*["']\.\/lib\/constants\.ts["']/);
  // No second declaration of the directive anywhere in the extension.
  assert.doesNotMatch(EXT, /const\s+LANGUAGE_DIRECTIVE\s*=/);
});

test("language gate is injected in before_agent_start", () => {
  assert.match(EXT, /before_agent_start/);
  assert.match(EXT, /event\.systemPrompt\s*\+\s*"\\n\\n"\s*\+\s*LANGUAGE_DIRECTIVE/);
});

test("language gate is UNCONDITIONAL — injected before the no-changes early return", () => {
  // Locate the handler body.
  const start = EXT.indexOf('pi.on("before_agent_start"');
  assert.ok(start >= 0, "handler must exist");
  const body = EXT.slice(start, start + 1200);
  const injectAt = body.indexOf("LANGUAGE_DIRECTIVE");
  const earlyReturnAt = body.search(/if\s*\(!state\.hasCodeChange\s*&&\s*!state\.hasDocChange\s*&&\s*problems\.length\s*===\s*0\)/);
  assert.ok(injectAt >= 0 && earlyReturnAt >= 0, "both the injection and the early return must be present");
  assert.ok(injectAt < earlyReturnAt,
    "LANGUAGE_DIRECTIVE must be injected BEFORE the early return, so it applies even with no pending changes");
});

test("the no-changes early return still returns the language systemPrompt (not undefined)", () => {
  const start = EXT.indexOf('pi.on("before_agent_start"');
  const body = EXT.slice(start, start + 1200);
  // The early-return branch must return the built systemPrompt object.
  assert.match(body, /problems\.length\s*===\s*0\)\s*\{\s*return\s*\{\s*systemPrompt\s*\}/);
});
