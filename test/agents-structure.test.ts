import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(ROOT, "agents");

function frontmatter(file: string): string {
  const src = readFileSync(join(AGENTS, file), "utf8");
  const fm = src.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, `${file}: frontmatter missing`);
  return fm![1];
}

test("every agent frontmatter carries the required fields", () => {
  const files = readdirSync(AGENTS).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 5, `expected at least 5 agents, found ${files.length}`);
  for (const f of files) {
    const body = frontmatter(f);
    for (const key of ["name", "description", "model", "fallbackModels", "thinking", "systemPromptMode", "tools"]) {
      assert.match(body, new RegExp(`^${key}:`, "m"), `${f}: missing ${key}`);
    }
  }
});

test("L3 judges (reviewer/adviser/arbiter) think at max — the verdict tier never degrades", () => {
  for (const f of ["reviewer.md", "adviser.md", "arbiter.md"]) {
    assert.match(frontmatter(f), /^thinking: max$/m, `${f}: L3 must think at max`);
  }
});

test("L1 triage is read-only, cheap-tier, and defined without verdict power", () => {
  const body = frontmatter("triage.md");
  assert.match(body, /^model: claude-haiku-4-5$/m, "L1 primary must be the cheap model");
  assert.match(body, /^fallbackModels: deepseek-v4-flash$/m);
  assert.doesNotMatch(body, /tools:.*\b(edit|write)\b/, "triage must be read-only");
});

test("L2 fixer is the execution tier: write-capable, mid-tier, never a judge", () => {
  const body = frontmatter("fixer.md");
  assert.match(body, /^model: claude-sonnet-5$/m, "L2 primary must be the mid-tier model");
  assert.match(body, /^thinking: medium$/m);
  assert.match(body, /tools:.*\b(edit|write)\b/, "fixer needs write tools");
  const src = readFileSync(join(AGENTS, "fixer.md"), "utf8");
  assert.match(src, /NOT a judge/i, "fixer must declare it never judges");
});
