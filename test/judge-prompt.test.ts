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
  doneChannelFor,
  inboxChannelFor,
  modelSpecFor,
  resolveRoleFile,
  writeJudgeSpawnFiles,
} from "../lib/judge-prompt.ts";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "rg-judge-prompt-"));
}

function writeRole(dir: string, role: string, body: string, model = "claude-fable-5"): string {
  const path = join(dir, `${role}.md`);
  writeFileSync(path, `---\nname: ${role}\nmodel: ${model}\nthinking: max\n---\n${body}`, "utf8");
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
    assert.ok(prompt.includes("tmux wait-for -S"));
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

test("modelSpecFor: explicit slots[0] wins; auto:true uses the frontmatter default", () => {
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
    assert.equal(modelSpecFor(map, "reviewer", repo, join(dir, "home")), "onekey/glm-5.3:max");
    // auto:true → frontmatter model + thinking; a provider-qualified model passes through
    assert.equal(modelSpecFor(map, "goal-auditor", repo, join(dir, "home")), "onekey/glm-5.3:max");
    // a BARE frontmatter id gets the package provider pinned (round-2 P2: this
    // branch had no real coverage — the duplicate assertion stood in for it)
    const bare = join(dir, "repo2");
    mkdirSync(join(bare, "agents"), { recursive: true });
    writeRole(join(bare, "agents"), "goal-auditor", "BODY", "claude-fable-5");
    assert.equal(modelSpecFor(map, "goal-auditor", bare, join(dir, "home")), "anthropic/claude-fable-5:max");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeJudgeSpawnFiles: env-based launcher, no interpolation, tools narrowed", () => {
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
    const launcher = readFileSync(files.launcherPath, "utf8");
    // F8: no caller data is interpolated into the launcher — every value is
    // read from RG_* environment variables at runtime.
    assert.ok(!launcher.includes(repo));
    assert.ok(launcher.includes("$RG_SP_FILE"));
    assert.ok(launcher.includes("$RG_MODEL"));
    assert.ok(launcher.includes("$RG_REPO_ROOT"));
    // F7: judges have no write surface in the shared live worktree.
    assert.ok(launcher.includes("--exclude-tools edit,write"));
    // the npm: prefix pitfall stays pinned
    assert.ok(launcher.includes("-e npm:pi-subagents"));
    // env carries the values
    assert.equal(files.env.RG_MODEL, "anthropic/claude-opus-5:max");
    assert.equal(files.env.RG_TITLE, "rg-test-role");
    // no path interpolation into the command (round-2 P2)
    assert.equal(files.command, 'exec /bin/bash "$RG_LAUNCHER"');
    assert.equal(files.env.RG_LAUNCHER, files.launcherPath);
    assert.equal(doneChannelFor("rg-test-role"), "rg-rg-test-role-done");
    assert.equal(inboxChannelFor("rg-test-role"), "rg-rg-test-role-inbox");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
