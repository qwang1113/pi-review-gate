import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_AGENTS } from "../lib/model-config.ts";

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

test("agents/*.md exactly matches KNOWN_AGENTS (config/render see every agent)", () => {
  // If a new agent file is added without registering it in KNOWN_AGENTS, the
  // model-config layer, the renderer and the widget silently skip it. Keep the
  // two in lockstep — both directions.
  const files = readdirSync(AGENTS).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  const known = [...KNOWN_AGENTS].sort();
  assert.deepEqual(files, known, "shipped agents must equal KNOWN_AGENTS");
  assert.ok(files.length >= 12, `expected all 12 agents, found ${files.length}`);
});

test("L3 judges (reviewer/adviser/arbiter/module-reviewer/goal-auditor) think at max — the verdict tier never degrades", () => {
  for (const f of ["reviewer.md", "adviser.md", "arbiter.md", "module-reviewer.md", "goal-auditor.md"]) {
    assert.match(frontmatter(f), /^thinking: max$/m, `${f}: L3 must think at max`);
  }
});

test("goal-auditor is a strong-tier, READ-ONLY judge — the gate records its verdict", () => {
  // It gates every goal approval, so a silent downgrade to a cheap model (or a
  // write-capable tool list) would weaken the one judgement the user relies on
  // before granting the session's exit contract.
  const body = frontmatter("goal-auditor.md");
  assert.match(body, /^model: claude-fable-5$/m, "the goal auditor must stay on the strong judging chain");
  assert.match(body, /^fallbackModels: claude-opus-5, opencode-go\/deepseek-v4-flash$/m, "same fallback chain as the other judges");
  assert.doesNotMatch(body, /tools:.*\b(edit|write|bash)\b/, "the auditor audits text; it must not be able to write");
  const src = readFileSync(join(AGENTS, "goal-auditor.md"), "utf8");
  // Its output IS the gate record, so the two rules the parser depends on must
  // be stated: exactly one fence, and never a quoted example fence (the parser
  // keeps the WORST verdict across all fences).
  assert.match(src, /exactly ONE/i, "the prompt must demand a single fence");
  assert.match(src, /[Nn]ever quote an example verdict fence/, "a quoted BLOCKED example would poison a real PASS");
  assert.match(src, /Simplified Chinese/, "the goal-language rule lives in the auditor's checklist");
  // The file must itself OBEY the rule it teaches: `parseReviewOutput` scans
  // every fence and keeps the worst, and a system prompt is quoted back by
  // models, so an example fence here can poison a real PASS. Zero fences — the
  // verdict shape is shown unfenced ON PURPOSE.
  const fences = (src.match(/^```/gm) ?? []).length;
  assert.equal(fences, 0, `the auditor prompt must contain NO code fences, found ${fences}`);
});

test("L1 triage is read-only, cheap-tier, low-thinking, and defined without verdict power", () => {
  const body = frontmatter("triage.md");
  assert.match(body, /^model: claude-haiku-4-5$/m, "L1 primary must be the cheap model");
  assert.match(body, /^fallbackModels: opencode-go\/deepseek-v4-flash$/m, "L1 fallback is the one approved cheap fallback (opencode-go only runs flash)");
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
  /^fallbackModels: claude-opus-5,\s*opencode-go\/deepseek-v4-flash$/m;

test("L2 execution roles (worker/planner/fixer) pin the exact mid-tier chain at max thinking", () => {
  for (const f of ["worker.md", "worker-readonly.md", "planner.md", "fixer.md"]) {
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
    /^fallbackModels: claude-opus-5,\s*opencode-go\/deepseek-v4-flash$/m;
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
  assert.match(body, /^fallbackModels: opencode-go\/deepseek-v4-flash$/m, "recon fallback is the one approved cheap fallback (opencode-go only runs flash)");
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

test("SKILL.md and AGENTS.md document the MECHANICAL goal pre-review (goal-auditor)", () => {
  for (const file of [SKILL_MD, AGENTS_MD]) {
    const src = readFileSync(file, "utf8");
    // 2026-08-25: the pre-review is no longer protocol the agent could skip.
    // The docs must name the dedicated role, the recording tool and the
    // refusal — a doc that only says "consult someone first" would describe
    // the retired, skippable rule.
    assert.match(src, /goal-auditor/, `${file} must name the dedicated goal-auditor role`);
    assert.match(src, /record_goal_prereview/, `${file} must name the tool that records the audit`);
    assert.match(src, /propose_loop_goal/i, `${file} must reference propose_loop_goal`);
    // Scoped to the PRE-REVIEW passage, not the whole file: a file-wide match
    // for "refuses" or "Simplified Chinese" is satisfied by unrelated prose
    // elsewhere, so deleting the rule itself would leave these green (the same
    // "a bare match is vacuous" standard this file already applies below).
    // Anchored on the RECORDING TOOL — the token that only appears where the
    // mechanical rule is described ("goal-auditor" alone also names the role in
    // model-tier tables and role rosters). A file may mention the tool more
    // than once, so EVERY occurrence gets a window and the rule must hold in at
    // least one of them: that keeps the assertion honest (deleting the rule
    // fails it) without breaking when the tool is referenced elsewhere.
    const windows: string[] = [];
    for (let i = src.indexOf("record_goal_prereview"); i !== -1; i = src.indexOf("record_goal_prereview", i + 1)) {
      windows.push(src.slice(Math.max(0, i - 1500), i + 2000));
    }
    assert.ok(windows.length > 0, `${file} must contain the pre-review passage`);
    // Each rule is checked against the BEST window for that rule, so a failure
    // names the rule that is actually missing instead of blaming whichever one
    // the combined window happened to miss.
    assert.ok(
      windows.some((w) => /refuse|refuses|拒绝/i.test(w)),
      `${file} must state IN THE PRE-REVIEW PASSAGE that propose_loop_goal REFUSES without a matching PASS`,
    );
    // The language rule the user added (2026-08-25).
    assert.ok(
      windows.some((w) => /Simplified Chinese|简体中文/i.test(w)),
      `${file} must carry the Chinese goal-text rule where the pre-review is described`,
    );
    // The retired rules' EXECUTABLE wording must be gone: neither the old
    // cross-family pre-goal reviewer nor the adviser-authoritative merge may
    // still read as the operative instruction (a HISTORICAL mention is fine).
    assert.doesNotMatch(
      src,
      /(pre-review the draft goal \(single cross.family|draft goal through (ONE|one) cross[.\s-]*family\s+reviewer|must pass ONE\s+independent `?adviser)/i,
      `${file} must not keep a retired pre-goal rule as the operative instruction`,
    );
  }
});

test("SKILL.md hands the loop goal to subagents as TEXT, never as a file to read", () => {
  // An acceptance judge (reviewer / reviewer-readonly / module-reviewer /
  // arbiter) has no `.pi/loop-goal.md` in its defaultReads, and a review
  // snapshot deliberately carries no `.pi/` at all, so a subagent told to READ
  // the goal file silently ends up with no acceptance contract. The rule is
  // pinned in lib/loop-goal.ts (test/loop-goal.test.ts locks both injected
  // directives); this locks the SKILL.md copy, whose lack of a fence is exactly
  // why the stale wording survived several review rounds (PR #25).
  const src = readFileSync(SKILL_MD, "utf8");
  // Every place SKILL.md tells the agent to pass the goal on must say TEXT.
  const handovers = src.match(/[Pp]aste the (loop )?goal TEXT/g) ?? [];
  assert.ok(
    handovers.length >= 3,
    `SKILL.md must tell the agent to paste the goal TEXT at every handover ` +
      `(slicing, step 0, the reviewer step) — found ${handovers.length}`,
  );
  // …and the retired file-handover wording must not come back.
  assert.doesNotMatch(
    src,
    /hand (the goal file|this file)|[Hh]and the goal to every subagent/,
    "SKILL.md must not tell a subagent to read the goal FILE (a snapshot has no .pi/)",
  );
  assert.doesNotMatch(
    src,
    /the file path, or quote it/,
    "the dead 'file path' branch must not reappear in the reviewer step",
  );
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

test("REGRESSION: no agent names an extension tool, in its allowlist OR in its prose", () => {
  // `tools:` is a STRICT allowlist that does not load extension code, so an
  // extension-provided tool listed there fails the whole launch. Observed:
  // every reviewer run ended as `failed` with "requested unavailable child
  // tools: intercom" — the verdict text survived only because it had already
  // been written to the artifact file.
  //
  // The prose matters just as much: an agent told to "use `intercom` when
  // blocked" will try, fail, and stall on a capability that does not exist.
  // Frontmatter and body are therefore checked with ONE full-text assertion.
  const EXTENSION_TOOLS = ["intercom"];
  for (const file of readdirSync(AGENTS).filter((f) => f.endsWith(".md"))) {
    const src = readFileSync(join(AGENTS, file), "utf8");
    // Anchored on the FRONTMATTER (not any line that happens to start with
    // "tools:"), so a body line can never satisfy the existence check.
    assert.match(frontmatter(file), /^tools:/m, `${file} must declare tools:`);
    for (const tool of EXTENSION_TOOLS) {
      assert.doesNotMatch(
        src,
        // Case-insensitive: prose capitalizes ("Intercom") at sentence start.
        new RegExp(`\\b${tool}\\b`, "i"),
        `${file}: "${tool}" is an extension tool — a child agent cannot get it. ` +
          `Listing it under tools: fails the launch, and promising it in the prose ` +
          `makes the agent stall on a channel it does not have`,
      );
    }
  }
});

test("REGRESSION: the protocol forbids a SAME-family reviewer pair, in all four places", () => {
  // Observed: a host with exactly one judge-eligible family still spawned two
  // `claude-fable-5` reviewers and called it a cross-family double review.
  // The rule has to exist wherever the agent might read it.
  const REVIEWER_MD = join(AGENTS, "reviewer.md");
  for (const file of [SKILL_MD, AGENTS_MD, REVIEWER_MD]) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /same[- ]family/i,
      `${file} must rule out a same-family reviewer pair explicitly`,
    );
    assert.match(
      src,
      /review-fanout\.ts|planFanoutFromFacts/,
      `${file} must point at the module that COMPUTES the reviewer count`,
    );
  }
  // …and in the /review command prompt the extension actually sends.
  const commands = readFileSync(join(ROOT, "lib", "workflow-commands.ts"), "utf8");
  assert.match(commands, /same[- ]family/i, "/review prompt must state the rule");

  // Scope guard: for a LARGE diff the shard count is not the agent's choice.
  // (This used to assert "decided by the engine's sharding" — which then LOCKED
  // that sentence in place after review moved off the engine: the assertion was
  // protecting the stale doc. Assert the invariant, not the old mechanism.)
  const skill = readFileSync(SKILL_MD, "utf8");
  // Whitespace-tolerant: these files are hard-wrapped prose, so a rule may
  // legitimately straddle a line break.
  assert.match(skill, /shard\s+count\s+comes\s+from\s+`?prepare_review/i);
  assert.doesNotMatch(
    skill,
    /decided\s+by\s+the\s+engine's\s+sharding/i,
    "reviews no longer run on the engine — this claim must not come back",
  );
});

test("REGRESSION: every re-review must carry the previous round's conclusion", () => {
  // Without this, round N+1 re-derives what round N already settled — the
  // most expensive way to learn nothing new.
  for (const file of [SKILL_MD, AGENTS_MD]) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /carries\s+the\s+previous\s+round's\s+conclusion/i,
      `${file} must require re-reviews to carry the previous conclusion`,
    );
    // Specific enough to actually lock the AUDITOR's goal re-audit: a bare
    // /goal-auditor/ match is vacuous in files that name the role many times.
    assert.match(
      src,
      // `re-review` must not match inside "pre-reviewer" (a word both files use
      // for the ROLE), or the rule this locks could be deleted with the test
      // still green — hence the word boundary and the required "objection".
      // The span crosses sentence boundaries (the rule is a heading followed by
      // its explanation), so it is bounded by DISTANCE, not by `[^.]`.
      /goal re-(audit|review)\b[\s\S]{0,400}?objection|goal-auditor[\s\S]{0,400}?\bobjection/is,
      `${file} must require the goal-auditor's re-audit to carry its own objections`,
    );
    assert.match(
      src,
      /consistency\s+scan/i,
      `${file} must say settled material gets a scan, not a re-derivation`,
    );
  }
  // The reviewer must be told it may still reopen a settled conclusion:
  // an economy that silently removed authority would be a gate weakening.
  const reviewer = readFileSync(join(AGENTS, "reviewer.md"), "utf8");
  assert.match(reviewer, /re-litigate/i);
  assert.match(reviewer, /reopen it/i);
});

test("the read-only reviewer variant CANNOT write, and says why it exists", () => {
  // pi-subagents has no per-call tool denylist, so "please do not edit" is only
  // a request. A static agent whose allowlist lacks edit/write is the one
  // mechanical guard available for the no-isolation fallback.
  const file = "reviewer-readonly.md";
  const fm = frontmatter(file);
  const toolsLine = fm.split("\n").find((l) => l.startsWith("tools:"))!;
  assert.ok(toolsLine, "the variant must declare tools:");
  for (const forbidden of ["edit", "write"]) {
    assert.doesNotMatch(
      toolsLine,
      new RegExp(`\\b${forbidden}\\b`, "i"),
      `${file}: the point of this agent is that it cannot ${forbidden}`,
    );
  }
  // It still needs to READ and to inspect.
  for (const needed of ["read", "grep", "bash"]) {
    assert.match(toolsLine, new RegExp(`\\b${needed}\\b`), `${file} must keep ${needed}`);
  }
  const src = readFileSync(join(AGENTS, file), "utf8");
  assert.match(src, /read-only inspection/i);
  assert.match(src, /[Mm]utation analysis is NOT available/);
  assert.match(src, /no per-call tool denylist/i, "it must state WHY a separate agent is needed");
  // Same judge tier as the writable reviewer — the fallback must not be weaker.
  assert.match(fm, /^model: claude-fable-5$/m);
  assert.match(fm, /^thinking: max$/m);
  // The goal file must NOT be a defaultRead of any JUDGING agent: only a
  // USER-APPROVED goal may become an acceptance contract, and prepare_review
  // gates that injection on loopGoalConfirmed(). A defaultRead would hand the
  // judge the RAW file instead — an unapproved draft included (round-3 P2: the
  // removal was unlocked, so re-adding the entry broke no test). Two roles are
  // deliberately excluded: `adviser` consults on a draft goal, and
  // `goal-auditor` AUDITS the draft — reading the raw (possibly unapproved)
  // file is precisely their job, while an ACCEPTANCE judge must only ever see
  // the text the user approved, handed to it in the spawn task.
  for (const judge of ["reviewer.md", "reviewer-readonly.md", "module-reviewer.md", "arbiter.md"]) {
    const reads = frontmatter(judge).split("\n").find((l) => l.startsWith("defaultReads:")) ?? "";
    assert.doesNotMatch(
      reads,
      /loop-goal\.md/,
      `${judge}: the goal must arrive through the approval-gated task text, never as a raw defaultRead`,
    );
  }
});

test("the parallel wave worker variant exists and is read-only by construction", () => {
  // With the pdw engine gone, a wave worker must be a static subagent whose
  // tools: allowlist simply cannot write — pi-subagents has no per-call tool
  // denylist, so the allowlist is the ONLY mechanical guard.
  const file = "worker-readonly.md";
  const fm = frontmatter(file);
  const toolsLine = fm.split("\n").find((l) => l.startsWith("tools:"))!;
  for (const allowed of ["read", "grep", "find", "ls"]) {
    assert.match(toolsLine, new RegExp(`\\b${allowed}\\b`), `${file} must keep ${allowed}`);
  }
  for (const forbidden of ["edit", "write", "bash"]) {
    assert.doesNotMatch(
      toolsLine,
      new RegExp(`\\b${forbidden}\\b`, "i"),
      `${file}: a parallel wave worker must never ${forbidden} — patch-first collapses otherwise`,
    );
  }
  const src = readFileSync(join(AGENTS, file), "utf8");
  assert.match(src, /no edit\/write\/bash|no `edit`,/i, "the file must name the exact forbidden tools");
  assert.match(src, /SERIAL single-writer|`worker` is the SERIAL/i, "the variant must distinguish itself from the serial worker");
  assert.match(src, /patch-first/i, "the patch-first contract must be in the variant");
  assert.match(src, /owned_paths/, "every diff must stay inside the module's owned paths");
  assert.match(src, /Never.{0,60}git commit/, "shipping stays with the main session");
  // Same execution tier as the writable worker — the parallel lane must not
  // be weaker than the serial one.
  assert.match(fm, /^model: claude-sonnet-5$/m);
  assert.match(fm, /^thinking: max$/m);
});

test("AGENTS.md and SKILL.md make subagents the only execution path", () => {
  for (const file of [AGENTS_MD, SKILL_MD]) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /subagents? is\/are the only execution path|Everything runs on plain subagents|No engine is involved anywhere/i,
      `${file} must declare that subagents are the only execution path`,
    );
  }
  // …and must not resurrect the engine as a dependency.
  const src = readFileSync(AGENTS_MD, "utf8");
  assert.doesNotMatch(src, /HARD dependency.*engine|engine.*HARD dep(?:endency)?/i);
});

test("the step-2 handoff document exists with its required sections", () => {
  // A handoff that is prose nobody can accept is worthless; the sections are
  // the checkable part.
  const doc = readFileSync(join(ROOT, "docs", "handoff-remove-pdw.md"), "utf8");
  for (const heading of [
    "## Motivation",
    "## Evidence",
    "## Validated pattern",
    "## Remaining work",
    "## Risks & verification",
    "## New readonly worker variant",
  ]) {
    assert.ok(doc.includes(heading), `handoff must carry the section ${heading}`);
  }
  // The evidence must be the concrete engine finding, not a vague claim.
  assert.match(doc, /runCwd/, "the cwd-discarding evidence must be quoted");
  assert.match(doc, /worktree add -b/, "the HEAD-checkout evidence must be quoted");
  // Remaining work has to point at real files, or it cannot be executed.
  for (const path of ["lib/plan-parallel.ts", "lib/pdw-bridge.ts", "lib/pdw-progress.ts", "scripts/install-package.mjs"]) {
    assert.ok(doc.includes(path), `remaining work must name ${path}`);
  }
  // The one thing that must NOT be deleted with the bridge.
  assert.match(doc, /isModelAllowed` must survive|isModelAllowed\*\* must survive/);
  // Step 2 is done: the handoff records completion and the sections survived.
  assert.match(doc, /STATUS: COMPLETE/, "the handoff must record that step 2 shipped");
});
test("REGRESSION: the snapshot contract is stated everywhere a reviewer reads it", () => {
  // Unbanning reviewer writes is only safe because of two paired promises:
  // "you are in a disposable copy" and "restore before you finish". A file
  // that carries one without the other invites exactly the damage the
  // isolation exists to prevent.
  for (const file of [join(AGENTS, "reviewer.md"), join(AGENTS, "module-reviewer.md")]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /disposable snapshot|snapshot cwd|throwaway git worktree/i, `${file}: must say where it runs`);
    assert.match(src, /mutation analysis/i, `${file}: must permit verification by doing`);
    assert.match(src, /[Rr]estore every mutation/, `${file}: must demand restoration`);
    assert.match(src, /\$TMPDIR/, `${file}: must send scratch files outside the snapshot`);
    assert.match(src, /READY from (you|it) is NOT accepted/i, `${file}: must state the consequence`);
    // Tolerates Markdown emphasis around the words (`**Never** run …`).
    assert.match(src, /never\W{0,4}run\s+`?git commit/i, `${file}: shipping stays with the main session`);
    // BOTH shared paths must be named, with the installer ban. Isolation covers
    // the worktree, not `.git`: a reviewer that ran an installer inside its
    // snapshot repointed the REAL repo's hooks at a directory that was then
    // deleted, and every later commit died. Naming only `node_modules` would
    // leave the worse escape undocumented.
    assert.match(src, /node_modules/, `${file}: must name the node_modules symlink as shared`);
    assert.match(src, /`?\.git`?\b/, `${file}: must name .git as shared (linked worktree)`);
    assert.match(
      src,
      /never run an installer|never run any installer/i,
      `${file}: must forbid installers — they write through the shared .git`,
    );
  }
  // A reviewer must never present a repair as its own contribution.
  const reviewer = readFileSync(join(AGENTS, "reviewer.md"), "utf8");
  assert.doesNotMatch(
    reviewer,
    /if you applied a fix/i,
    "the output format must not invite the reviewer to fix the code it judges",
  );
});

test("REGRESSION: isolation + streaming are documented in every protocol surface", () => {
  for (const file of [SKILL_MD, AGENTS_MD]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /prepare_review/, `${file} must name the tool that hands out snapshots`);
    assert.match(src, /stream/i, `${file} must describe streamed findings`);
    assert.match(
      src,
      /evidence/i,
      `${file} must state the evidence bar for acting on a streamed finding`,
    );
  }
  // The /review prompt the extension actually sends carries it too.
  const commands = readFileSync(join(ROOT, "lib", "workflow-commands.ts"), "utf8");
  assert.match(commands, /prepare_review/);
  assert.match(commands, /never poll in a tight loop/i);
  // And the design record no longer contradicts the implementation.
  const plan = readFileSync(join(ROOT, "docs", "parallel-execution-plan.md"), "utf8");
  assert.match(plan, /MAIN WORKTREE has exactly one writer/i);
  assert.match(plan, /own disposable snapshot worktree/i);
});
