import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS = join(ROOT, "agents");
const SKILL_MD = join(ROOT, "skills", "review-loop", "SKILL.md");
const AGENTS_MD = join(ROOT, "AGENTS.md");

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

test("L3 judges (reviewer/adviser/arbiter/module-reviewer) think at max — the verdict tier never degrades", () => {
  for (const f of ["reviewer.md", "adviser.md", "arbiter.md", "module-reviewer.md"]) {
    assert.match(frontmatter(f), /^thinking: max$/m, `${f}: L3 must think at max`);
  }
});

test("L1 triage is read-only, cheap-tier, low-thinking, and defined without verdict power", () => {
  const body = frontmatter("triage.md");
  assert.match(body, /^model: claude-haiku-4-5$/m, "L1 primary must be the cheap model");
  assert.match(body, /^fallbackModels: deepseek\/deepseek-v4-flash,\s*oc-sdk-go\/deepseek-v4-flash,\s*onekey\/deepseek-v4-flash$/m, "L1 fallback follows user priority: self deepseek > opencode go > onekey");
  assert.match(body, /^thinking: low$/m, "L1 must run at low/off thinking, never max");
  assert.doesNotMatch(body, /tools:.*\b(edit|write)\b/, "triage must be read-only");
});

test("L2 fixer is the execution tier: write-capable, mid-tier, max thinking, never a judge", () => {
  const body = frontmatter("fixer.md");
  assert.match(body, /^model: claude-sonnet-5$/m, "L2 primary must be the mid-tier model");
  assert.match(body, /^thinking: max$/m, "L2 executes at max thinking (user policy: max thinking for coding/orchestration)");
  assert.match(body, /tools:.*\b(edit|write)\b/, "fixer needs write tools");
  const src = readFileSync(join(AGENTS, "fixer.md"), "utf8");
  assert.match(src, /NOT a judge/i, "fixer must declare it never judges");
});

// The mid-tier chain is pinned EXACTLY (model + thinking + deepseek source
// priority self > opencode-go > onekey + family fallbacks) for every execution
// role — not just the family-span assertion below.
const MID_TIER_CHAIN =
  /^model: claude-sonnet-5$/m;
const MID_TIER_FALLBACK =
  /^fallbackModels: deepseek\/deepseek-v4-pro,\s*deepseek\/deepseek-v4-flash,\s*oc-sdk-go\/deepseek-v4-flash,\s*onekey\/deepseek-v4-flash,\s*onekey\/grok-4\.6,\s*onekey\/glm-5\.3,\s*claude-opus-5$/m;

test("L2 execution roles (worker/planner/fixer) pin the exact mid-tier chain at max thinking", () => {
  for (const f of ["worker.md", "planner.md", "fixer.md"]) {
    const body = frontmatter(f);
    assert.match(body, MID_TIER_CHAIN, `${f}: L2 primary must be claude-sonnet-5`);
    assert.match(body, /^thinking: max$/m, `${f}: L2 executes at max thinking`);
    assert.match(
      body,
      MID_TIER_FALLBACK,
      `${f}: fallback must follow deepseek source priority self > oc-sdk-go > onekey, then grok/glm/opus`,
    );
  }
});

test("L3 judge roles pin the exact strong-tier chain (model + fallbacks + max thinking)", () => {
  const STRONG_FALLBACK =
    /^fallbackModels: claude-opus-5,\s*onekey\/gpt-5\.6-sol,\s*onekey\/glm-5\.3,\s*onekey\/grok-4\.6$/m;
  for (const f of ["reviewer.md", "adviser.md", "module-reviewer.md", "arbiter.md"]) {
    const body = frontmatter(f);
    assert.match(body, /^model: claude-fable-5$/m, `${f}: L3 primary must be claude-fable-5`);
    assert.match(body, /^thinking: max$/m, `${f}: L3 must think at max`);
    assert.match(body, STRONG_FALLBACK, `${f}: fallback must be the cross-family strong chain`);
  }
});

test("the orchestration roles keep the serial contract: one writer, read-only reviewers", () => {
  const planner = frontmatter("planner.md");
  assert.doesNotMatch(planner, /tools:.*\bbash\b/, "the planner sequences; it never executes");
  assert.doesNotMatch(planner, /tools:.*\bedit\b/, "the planner writes state, not source");
  const plannerSrc = readFileSync(join(AGENTS, "planner.md"), "utf8");
  assert.match(plannerSrc, /SHORT-LIVED/i, "the planner must know it is disposable");
  assert.match(plannerSrc, /Do not dispatch\s+subagents/i, "only the main session dispatches");

  const worker = frontmatter("worker.md");
  assert.match(worker, /tools:.*\bedit\b/, "the worker is the only writer");
  const workerSrc = readFileSync(join(AGENTS, "worker.md"), "utf8");
  assert.match(workerSrc, /owned_paths/, "the worker must be scoped to its module");
  assert.match(workerSrc, /Do not start subagents/i);
  assert.match(workerSrc, /git commit/, "the worker must be told shipping is not its job");

  const reviewer = frontmatter("module-reviewer.md");
  assert.doesNotMatch(reviewer, /tools:.*\b(edit|write)\b/, "a shard reviewer must be read-only");
  assert.match(reviewer, /^thinking: max$/m, "verdict power stays on the L3 tier");
});

test("the shard reviewer is forbidden from emitting docSync — the two-phase protocol depends on it", () => {
  const src = readFileSync(join(AGENTS, "module-reviewer.md"), "utf8");
  assert.match(src, /Never include a `docSync` field/i, "the prohibition must be in the role, not the task text");
  assert.match(src, /integration reviewer/i, "and it must say where the single attestation comes from");
});

// ── Wave daily: SKILL.md + AGENTS.md carry the protocol ───────────────────

test("SKILL.md documents wave daily trigger conditions and parallel exploration", () => {
  assert.ok(existsSync(SKILL_MD), "SKILL.md must exist");
  const src = readFileSync(SKILL_MD, "utf8");
  // Wave daily (not just decompose) — the trigger conditions and decision rules.
  assert.match(src, /[Ww]ave daily/, "SKILL.md must document wave daily trigger conditions");
  assert.match(src, /patch-first/, "SKILL.md must describe the patch-first protocol");
  assert.match(src, /≤4/, "SKILL.md must state the ≤4 module cap");
  // Read-only exploration parallel rules.
  assert.match(src, /read-only.*parallel|parallel.*read-only/i, "SKILL.md must state read-only subagents can run in parallel");
  // Decision rules: when to wave vs serial.
  assert.match(src, /when (not )?to wave|wave.*decision|decide.*wave|wave vs/i, "SKILL.md must have wave vs serial decision guidance");
});

test("AGENTS.md documents wave daily and parallel exploration", () => {
  assert.ok(existsSync(AGENTS_MD), "AGENTS.md must exist");
  const src = readFileSync(AGENTS_MD, "utf8");
  // Wave daily: the parallel loop is not just for decompose.
  assert.match(src, /[Ww]ave daily/, "AGENTS.md must document wave daily");
  assert.match(src, /patch-first/, "AGENTS.md must describe the patch-first protocol");
  // Read-only parallel exploration.
  assert.match(src, /read-only.*parallel|parallel.*read-only/i, "AGENTS.md must state read-only subagents can run in parallel");
});

test("recon is the cheap read-only tier: cheap model, low/off thinking, no write tools", () => {
  assert.ok(existsSync(join(AGENTS, "recon.md")), "agents/recon.md must exist");
  const body = frontmatter("recon.md");
  assert.match(body, /^model: claude-haiku-4-5$/m, "recon primary must be the cheap model");
  assert.match(body, /^fallbackModels: deepseek\/deepseek-v4-flash,\s*oc-sdk-go\/deepseek-v4-flash,\s*onekey\/deepseek-v4-flash$/m, "recon fallback follows user priority: self deepseek > opencode go > onekey");
  const thinking = body.match(/^thinking: (\S+)/m)?.[1];
  assert.ok(thinking && ["off", "low"].includes(thinking), `recon thinking '${thinking}' must be off or low`);
  assert.doesNotMatch(body, /tools:.*\b(edit|write|bash)\b/, "recon must be strictly read-only (no edit/write/bash)");
  const src = readFileSync(join(AGENTS, "recon.md"), "utf8");
  assert.match(src, /never (writes|edits|judges)|not.*(judge|reviewer)/i, "recon must declare it never judges");
});

// ── Model tiers: strong judges, mid execution, cheap recon ────────────────

test("L3 judge fallback chains span at least two model families (cross-family fallback)", () => {
  for (const f of ["reviewer.md", "adviser.md", "module-reviewer.md", "arbiter.md"]) {
    const body = frontmatter(f);
    const fb = body.match(/^fallbackModels: (.+)$/m)?.[1];
    assert.ok(fb, `${f}: fallbackModels required`);
    const ids = fb.split(/\s*,\s*/);
    assert.ok(ids.length >= 2, `${f}: at least 2 fallbacks`);
    // Families: anthropic (claude), openai (gpt), zhipu (glm), xai (grok)
    const families = new Set<string>();
    for (const id of ids) {
      if (/claude/.test(id)) families.add("anthropic");
      else if (/gpt/.test(id)) families.add("openai");
      else if (/glm/.test(id)) families.add("zhipu");
      else if (/grok/.test(id)) families.add("xai");
      else families.add("other");
    }
    assert.ok(families.size >= 2, `${f}: fallbacks must span ≥2 model families (got ${[...families].join(",")})`);
  }
});

test("L2 execution fallbacks span families and include the cheap-but-strong flash", () => {
  for (const f of ["worker.md", "planner.md", "fixer.md"]) {
    const body = frontmatter(f);
    const fb = body.match(/^fallbackModels: (.+)$/m)?.[1];
    assert.ok(fb, `${f}: fallbackModels required`);
    const ids = fb.split(/\s*,\s*/);
    assert.ok(ids.length >= 2, `${f}: at least 2 fallbacks`);
    const families = new Set<string>();
    for (const id of ids) {
      if (/deepseek/.test(id)) families.add("deepseek");
      else if (/grok/.test(id)) families.add("xai");
      else if (/glm/.test(id)) families.add("zhipu");
      else if (/claude/.test(id)) families.add("anthropic");
      else families.add("other");
    }
    assert.ok(families.size >= 2, `${f}: execution fallbacks must span ≥2 model families (got ${[...families].join(",")})`);
  }
});

// ── Cross-review protocol: goal pre-review + default two-reviewer final ────

test("SKILL.md and AGENTS.md document the pre-goal single cross-family reviewer pass", () => {
  for (const file of [SKILL_MD, AGENTS_MD]) {
    const src = readFileSync(file, "utf8");
    // The protocol text must mention both halves: a cross-family reviewer for
    // the draft goal, and propose_loop_goal as the submission point.
    assert.match(
      src,
      /(one|single).{0,80}(cross.family|independent).{0,80}(reviewer|critique)/i,
      `${file} must document the single cross-family reviewer pass`,
    );
    assert.match(src, /propose_loop_goal/i, `${file} must reference propose_loop_goal`);
  }
});

test("SKILL.md and AGENTS.md default the final review to TWO cross-family reviewers", () => {
  for (const file of [SKILL_MD, AGENTS_MD]) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /two.{0,40}(reviewers|independent).{0,80}(cross.family|different.{0,25}families)/i,
      `${file} must default the final review to two cross-family reviewers`,
    );
    assert.match(src, /worst(-| )wins/i, `${file} must keep worst-wins for multiple verdicts`);
  }
});
