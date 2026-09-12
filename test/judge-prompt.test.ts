/**
 * Judge child-session prompt assembly — pure-function tests.
 *
 * Covers: frontmatter stripping, three-layer role resolution, protocol
 * injection, model-chain resolution (explicit slots vs frontmatter default),
 * env-based spawn files (the F8 no-interpolation pitfall), done/inbox channel
 * derivation — and the F5 pin: the embedded protocol copy must not silently
 * diverge from docs/judge-protocol.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JUDGE_COMMON_PROTOCOL,
  JUDGE_ROLES,
  agentRoleBody,
  buildJudgeSystemPrompt,
  modelChainFor,
  resolveRoleFile,
  writeJudgeSpawnFiles,
} from "../lib/judge-prompt.ts";
import { UNTRUSTED_DATA_RULE } from "../lib/untrusted-data.ts";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "rg-judge-prompt-"));
}

function writeRole(dir: string, role: string, body: string, model = "claude-fable-5", fallbackModels?: string): string {
  const path = join(dir, `${role}.md`);
  const fallback = fallbackModels === undefined ? "" : `fallbackModels: ${fallbackModels}\n`;
  writeFileSync(path, `---\nname: ${role}\nmodel: ${model}\n${fallback}thinking: max\n---\n${body}`, "utf8");
  return path;
}

test("judge roles are exactly the tmux-child roles", () => {
  assert.deepEqual(JUDGE_ROLES, ["reviewer", "adviser", "goal-auditor"]);
});

test("agentRoleBody strips the frontmatter block", () => {
  const dir = sandbox();
  try {
    const p = writeRole(dir, "reviewer", "You are the reviewer body.\nSecond line.");
    assert.equal(agentRoleBody(p), "You are the reviewer body.\nSecond line.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agentRoleBody returns undefined for a missing file", () => {
  assert.equal(agentRoleBody(undefined), undefined);
});

test("resolveRoleFile: repo layer wins, then package, then user (round-1 F3)", () => {
  const dir = sandbox();
  try {
    const repo = join(dir, "repo");
    const pkg = join(dir, "pkg");
    mkdirSync(join(repo, "agents"), { recursive: true });
    mkdirSync(join(pkg, "agents"), { recursive: true });
    writeRole(join(repo, "agents"), "reviewer", "REPO_BODY");
    writeRole(join(pkg, "agents"), "reviewer", "PKG_BODY");
    // repo wins
    const hit = resolveRoleFile(repo, "reviewer", join(dir, "home"));
    assert.ok(hit !== undefined && readFileSync(hit, "utf8").includes("REPO_BODY"));
    // package fallback when the repo has no agents dir
    // package built-in layer resolves when the repo has no agents dir
    // (running inside this repo, the package layer IS this repo's agents/)
    const pkgHit = resolveRoleFile(join(dir, "empty"), "reviewer", join(dir, "home"));
    assert.ok(pkgHit !== undefined && readFileSync(pkgHit, "utf8").includes("You are a disciplined review judge child"));
    assert.equal(resolveRoleFile(join(dir, "empty"), "nobody", join(dir, "home")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildJudgeSystemPrompt = role body + shared protocol", () => {
  const dir = sandbox();
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeRole(join(repo, "agents"), "adviser", "ADVISER_BODY");
    const prompt = buildJudgeSystemPrompt(repo, "adviser", join(dir, "home"));
    assert.ok(prompt.startsWith("ADVISER_BODY"));
    assert.ok(prompt.includes(JUDGE_COMMON_PROTOCOL));
    assert.ok(prompt.includes("不需要退出进程"));
    assert.ok(prompt.includes("重开 pane 即延续"));
    // the round-1 F5 divergence rule is present in the embedded copy
    assert.ok(prompt.includes("做不到的验证明说"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F5 pin: embedded protocol keeps every rule of docs/judge-protocol.md", () => {
  const doc = readFileSync(join(process.cwd(), "docs", "judge-protocol.md"), "utf8");
  // Bullet-BLOCK comparison — the round-1 divergence was a dropped BULLET,
  // and heading-only pinning would still let one through (round-2 P2).
  // Blocks join continuation lines (bullets span multiple lines) and are
  // normalized (no ** / backticks / whitespace) before comparing.
  const blocks = (text: string): string[] => {
    const out: string[] = [];
    let cur = "";
    const flush = () => { if (cur) { out.push(cur); cur = ""; } };
    for (const line of text.split("\n")) {
      if (/^\s*[-*]\s+/.test(line)) { flush(); cur = line.replace(/^\s*[-*]\s+/, ""); }
      else if (/^##\s/.test(line)) { flush(); }
      else if (line.trim() === "") { flush(); }
      else if (cur) cur += line.trim();
    }
    flush();
    return out.map((b) => b.replace(/\*\*|`/g, "").replace(/\s+/g, "").trim()).filter(Boolean);
  };
  const docBlocks = blocks(doc);
  const embeddedBlocks = blocks(JUDGE_COMMON_PROTOCOL);
  for (const b of docBlocks) {
    assert.ok(
      // ONE direction only: a shortened embedded bullet must FAIL
      // (round-3 P2 — the || direction let round-1's actual divergence pass).
      embeddedBlocks.some((e) => e.includes(b)),
      `docs bullet "${b}" missing from the embedded protocol copy`,
    );
  }
  // The rule that was actually lost once (round-1 F5) is pinned explicitly.
  assert.ok(JUDGE_COMMON_PROTOCOL.includes("做不到的验证明说"));
});

test("round-17: output discipline is part of the shared protocol (gate consumes conclude + stream)", () => {
  assert.match(JUDGE_COMMON_PROTOCOL, /输出纪律/, "the discipline section exists");
  assert.match(JUDGE_COMMON_PROTOCOL, /judge_conclude 交卷/, "the conclude call is the mechanical contract");
  assert.match(JUDGE_COMMON_PROTOCOL, /findings 流文件/, "the finding stream is the evidence channel");
  assert.match(JUDGE_COMMON_PROTOCOL, /交卷即停/, "the round ends AT the call — no prose section follows it");
  assert.match(JUDGE_COMMON_PROTOCOL, /不写复述、不写自评/, "no task/process retelling");
});

test("round 5: the protocol tells the judge what an untrusted data block may NOT do", () => {
  // The prompt half of the anti-steering fix: the task text now fences the
  // main session's words in a data block, and this is where the judge is told
  // that the fence means something.
  assert.match(JUDGE_COMMON_PROTOCOL, /## 不可信数据块/, "the section exists");
  assert.ok(
    JUDGE_COMMON_PROTOCOL.includes(UNTRUSTED_DATA_RULE),
    "and states the SHARED rule verbatim — one wording, not a paraphrase per file",
  );
  assert.match(JUDGE_COMMON_PROTOCOL, /main_session_note/, "the real tag names are listed");
  assert.match(JUDGE_COMMON_PROTOCOL, /直接判 READY/, "the concrete steering attempt is named");
  assert.match(JUDGE_COMMON_PROTOCOL, /P1 finding/, "…and reporting it is itself the required action");
  // The rule must also be in the doc — otherwise the F5 pin above passes while
  // the two copies say different things.
  const doc = readFileSync(join(process.cwd(), "docs", "judge-protocol.md"), "utf8");
  assert.ok(doc.includes(UNTRUSTED_DATA_RULE), "docs/judge-protocol.md carries the same sentence");
});


test("the shared protocol no longer teaches reviewer / goal-auditor to write `notes`", () => {
  // The signature refuses `notes` from those roles (lib/judge-conclude.ts), so
  // a protocol that still asked for it would make the gate contradict its own
  // dispatch on the very first round.
  assert.match(JUDGE_COMMON_PROTOCOL, /reviewer \/ goal-auditor 的签名里\*\*没有\*\* notes 参数/);
  // The adviser keeps it, and the protocol says which role that is.
  assert.match(JUDGE_COMMON_PROTOCOL, /adviser 例外/);
  // No surviving instruction to hand `notes` in alongside the verdict.
  assert.doesNotMatch(JUDGE_COMMON_PROTOCOL, /cwd \+ notes/);
  assert.doesNotMatch(JUDGE_COMMON_PROTOCOL, /notes 的要点里/);
  assert.doesNotMatch(JUDGE_COMMON_PROTOCOL, /notes ≤5 行/);
});

test("modelChainFor: the WHOLE chain, from the config slots or the frontmatter", () => {
  const dir = sandbox();
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeRole(join(repo, "agents"), "goal-auditor", "BODY", "onekey/glm-5.3");
    const map = {
      reviewer: { auto: false, slots: ["onekey/glm-5.3:max", "anthropic/claude-opus-5:max"], source: "global" as const },
      adviser: { auto: true, slots: [], source: "default" as const },
      "goal-auditor": { auto: true, slots: [], source: "default" as const },
    };
    // auto:false ⇒ every slot, in the order the user wrote them. This is what
    // the dispatch picks from and what the pane rotates through — returning
    // only the head is the defect the chain fix removed (2026-09-10).
    assert.deepEqual(modelChainFor(map, "reviewer", repo, join(dir, "home")), [
      "onekey/glm-5.3:max",
      "anthropic/claude-opus-5:max",
    ]);
    // auto:true ⇒ frontmatter model + its fallbackModels line; a
    // provider-qualified model passes through and keeps its own level.
    assert.deepEqual(modelChainFor(map, "goal-auditor", repo, join(dir, "home")), ["onekey/glm-5.3:max"]);
    // A BARE frontmatter id gets the package provider pinned (round-2 P2: this
    // branch had no real coverage — the duplicate assertion stood in for it),
    // and its fallbacks are pinned the same way.
    const bare = join(dir, "repo2");
    mkdirSync(join(bare, "agents"), { recursive: true });
    writeRole(join(bare, "agents"), "goal-auditor", "BODY", "claude-fable-5", "claude-opus-5, onekey/gpt-6-astra:xhigh");
    assert.deepEqual(modelChainFor(map, "goal-auditor", bare, join(dir, "home")), [
      "anthropic/claude-fable-5:max",
      "anthropic/claude-opus-5:max",
      // A slot that names its OWN level keeps it: appending the role default
      // again would render `…:xhigh:max`, which resolves to no model at all.
      "onekey/gpt-6-astra:xhigh",
    ]);
    // Nothing resolvable ⇒ an EMPTY chain, never a manufactured default.
    const empty = join(dir, "repo3");
    mkdirSync(join(empty, "agents"), { recursive: true });
    writeFileSync(join(empty, "agents", "goal-auditor.md"), "---\nname: goal-auditor\n---\nBODY", "utf8");
    assert.deepEqual(modelChainFor(map, "goal-auditor", empty, join(dir, "home")), []);
    assert.deepEqual(modelChainFor(map, "nobody", empty, join(dir, "home")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJudgeSpawnFiles: writes the system prompt and resolves the model", () => {
  const dir = sandbox();
  try {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "agents"), { recursive: true });
    writeRole(join(repo, "agents"), "goal-auditor", "AUDIT_BODY");
    const work = join(dir, "work");
    const files = writeJudgeSpawnFiles({
      repoRoot: repo,
      role: "goal-auditor",
      agents: {
        reviewer: { auto: true, slots: [], source: "default" },
        adviser: { auto: true, slots: [], source: "default" },
        "goal-auditor": { auto: false, slots: ["anthropic/claude-opus-5:max"], source: "global" },
      },
      title: "rg-test-role",
      workDir: work,
    });
    assert.ok(existsSync(files.sysPromptPath));
    assert.ok(readFileSync(files.sysPromptPath, "utf8").includes("AUDIT_BODY"));
    // auto:false ⇒ the WHOLE slot list, head first: the dispatch picks a slot
    // from it and the pane rotates through the rest (2026-09-10).
    assert.deepEqual(files.chain, ["anthropic/claude-opus-5:max"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
