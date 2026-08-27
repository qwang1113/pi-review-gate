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
  assert.ok(files.length >= 7, `expected all 7 agents, found ${files.length}`);
});

test("L3 judges (reviewer/adviser/arbiter/goal-auditor) think at max — the verdict tier never degrades", () => {
  for (const f of ["reviewer.md", "adviser.md", "arbiter.md", "goal-auditor.md"]) {
    assert.match(frontmatter(f), /^thinking: max$/m, `${f}: L3 must think at max`);
  }
});

test("incremental-review roles run context: fresh — nothing forks the main session (goal criterion 4)", () => {
  // The three review roles no longer inherit a fork of the whole main
  // conversation: their task text carries the goal, the scope, and the
  // transcript location to read ON DEMAND. A regression to fork would
  // silently re-add the token/time cost the incremental contract removes.
  for (const f of ["reviewer.md", "adviser.md", "goal-auditor.md"]) {
    assert.match(frontmatter(f), /^defaultContext: fresh$/m, `${f}: must default to fresh context`);
  }
  // The judging roles that stay fork-based do so deliberately (arbiter needs
  // the block context; recon inherits cheaply).
  assert.doesNotMatch(frontmatter("arbiter.md"), /^defaultContext: fresh$/m);
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

test("L2 execution role (fixer) pins the exact mid-tier chain at max thinking", () => {
  for (const f of ["fixer.md"]) {
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
  for (const f of ["reviewer.md", "adviser.md", "arbiter.md"]) {
    const body = frontmatter(f);
    assert.match(body, /^model: claude-fable-5$/m, `${f}: L3 primary must be claude-fable-5`);
    assert.match(body, /^thinking: max$/m, `${f}: L3 must think at max`);
    assert.match(body, STRONG_FALLBACK, `${f}: fallback must be the cross-family strong chain`);
  }
});


// ── Wave daily: SKILL.md + AGENTS.md carry the protocol ───────────────────

test("SKILL.md states read-only exploration rules and NO wave protocol", () => {
  assert.ok(existsSync(SKILL_MD), "SKILL.md must exist");
  const src = readFileSync(SKILL_MD, "utf8");
  // Read-only exploration parallel rules.
  assert.match(src, /read-only.*parallel|parallel.*read-only/i, "SKILL.md must state read-only subagents can run in parallel");
  // Wave daily was removed with the decompose module loop (2026-08-26).
  assert.doesNotMatch(src, /prepare_wave|run_wave_workflow|apply_wave_patches/i, "no wave protocol may remain");
});

test("AGENTS.md states read-only parallel exploration and NO wave protocol", () => {
  assert.ok(existsSync(AGENTS_MD), "AGENTS.md must exist");
  const src = readFileSync(AGENTS_MD, "utf8");
  // Read-only parallel exploration.
  assert.match(src, /read-only.*parallel|parallel.*read-only/i, "AGENTS.md must state read-only subagents can run in parallel");
  // The mention is only allowed in the REMOVED context: the doc must say the
  // machinery is gone, not prescribe it.
  assert.doesNotMatch(src, /(use|call|run|dispatch)\s+`?prepare_wave|prepare_wave tool|run_wave_workflow tool/i, "no wave protocol may remain as an instruction");
  assert.match(src, /removed on 2026-08-26|were removed|no wave/i, "AGENTS.md must state the wave machinery is removed");
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
  for (const f of ["reviewer.md", "adviser.md", "arbiter.md"]) {
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
  for (const f of ["fixer.md"]) {
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

// ── Review protocol: goal pre-review + single-reviewer final ───────────────

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
  const handovers = src.match(/(?:[Pp]aste|[Hh]and) the (loop )?goal (TEXT|text)/g) ?? [];
  assert.ok(
    handovers.length >= 1,
    `SKILL.md must tell the agent to pass the goal as TEXT at the handover ` +
      `(step 0, the reviewer step) — found ${handovers.length}`,
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

test("REGRESSION: the single-review protocol states ONE reviewer per round", () => {
  for (const file of [SKILL_MD, AGENTS_MD]) {
    const src = readFileSync(file, "utf8");
    assert.match(
      src,
      /one reviewer|ONE independent reviewer|single reviewer/i,
      `${file} must state that each review round is ONE reviewer`,
    );
  }
  // …and the same must hold in the /review command prompt the extension sends.
  const commands = readFileSync(join(ROOT, "lib", "workflow-commands.ts"), "utf8");
  assert.match(commands, /(ONE|one) (independent )?reviewer per round/i, "/review prompt must state the single-review protocol");
  // No sharding anywhere: the reviewer count is never computed from families.
  const skill = readFileSync(SKILL_MD, "utf8");
  assert.doesNotMatch(skill, /planFanoutFromFacts|review-fanout\.ts|two reviewer/i, "no fan-out language may remain");
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
  for (const judge of ["reviewer.md", "reviewer-readonly.md", "arbiter.md"]) {
    const reads = frontmatter(judge).split("\n").find((l) => l.startsWith("defaultReads:")) ?? "";
    assert.doesNotMatch(
      reads,
      /loop-goal\.md/,
      `${judge}: the goal must arrive through the approval-gated task text, never as a raw defaultRead`,
    );
  }
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

test("REGRESSION: the snapshot contract is stated everywhere a reviewer reads it", () => {
  // Unbanning reviewer writes is only safe because of two paired promises:
  // "you are in a disposable copy" and "restore before you finish". A file
  // that carries one without the other invites exactly the damage the
  // isolation exists to prevent.
  // Only agents that RUN INSIDE a disposable snapshot must make the paired
  // restoration promises; the read-only variant (reviewer-readonly) has no
  // snapshot and is covered by its own CANNOT-write test.
  // Only agents that RUN INSIDE a disposable snapshot must make the paired
  // restoration promises; the read-only variant (reviewer-readonly) has no
  // snapshot and is covered by its own CANNOT-write test.
  const file = join(AGENTS, "reviewer.md");
  const src = readFileSync(file, "utf8");
  assert.match(src, /disposable snapshot|snapshot cwd|throwaway git worktree/i, `${file}: must say where it runs`);
  assert.match(src, /mutation analysis/i, `${file}: must permit verification by doing`);
  assert.match(src, /[Rr]estore every mutation/, `${file}: must demand restoration`);
  assert.match(src, /\$TMPDIR/, `${file}: must send scratch files outside the snapshot`);
  assert.match(src, /READY from (you|it) is NOT accepted/i, `${file}: must state the consequence`);
  assert.match(src, /never\W{0,4}run\s+`?git commit/i, `${file}: shipping stays with the main session`);
  assert.match(src, /node_modules/, `${file}: must name the node_modules symlink as shared`);
  assert.match(src, /`?\.git`?\b/, `${file}: must name .git as shared (linked worktree)`);
  assert.match(
    src,
    /never run an installer|never run any installer/i,
    `${file}: must forbid installers — they write through the shared .git`,
  );
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
