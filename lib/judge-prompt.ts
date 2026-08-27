/**
 * Judge child-session prompt assembly — role definition + shared protocol.
 *
 * A judge child is a tmux pane running its OWN pi process (no review-gate
 * extension). The gate builds that process's SYSTEM PROMPT from two parts:
 *
 *   1. the role's definition body (agents/<role>.md minus frontmatter) —
 *      what the role IS, how it judges, its output contract, and
 *   2. the SHARED judge protocol — how every judge behaves as a tmux child:
 *      read-only discipline, convergence, one-class-of-issue-per-round, recon
 *      delegation, inbox questions, and the completion signal.
 *
 * ROUND-1 FINDINGS THIS FILE ABSORBS (all measured by the independent
 * reviewer during the tmux migration):
 *  - F3: role bodies are resolved from repoRoot/agents AND the package's own
 *    agents/ AND ~/.pi/agent/agents — never only the repo, which exists only
 *    in this repository;
 *  - F4: the role BODIES themselves were migrated away from the subagent era
 *    (no snapshot / contact_supervisor instructions) — see agents/*.md;
 *  - F5: the protocol text below is the single embedded copy; a test pins it
 *    against docs/judge-protocol.md so the two cannot silently diverge;
 *  - F7: judge children are launched with --exclude-tools edit,write — the
 *    accidental-edit surface is gone (the frontmatter tools: allowlist cannot
 *    travel: pi does not read agent files). bash stays enabled and is a write
 *    channel by protocol (wait-for signalling, findings/inbox appends), so
 *    the contract is "no EDIT tools", never "no write" — reviewers are told
 *    precisely that in their role bodies (round-2 P2: overstating the guard
 *    invites reasoning on a promise that does not hold);
 *  - F8: NO shell interpolation of unvalidated values. The launcher script
 *    reads every value from environment variables (tmux split-window -e
 *    KEY=VAL), so a config-supplied model spec or an apostrophe in a path can
 *    never become shell syntax;
 *  - F12/F13: model selection honors the config semantics (auto:false ⇒
 *    slots[0]; auto:true ⇒ the role's own frontmatter default) instead of a
 *    duplicated literal;
 *  - F14: only slots[0] can reach a child — a child is one pi process with
 *    one model; the fallback chain is a subagent-launch concept and is
 *    documented as such in docs/dev-flow.md.
 */

import { chmodSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentsConfigMap } from "./model-config.ts";
import { extractFrontmatterChain, resolvePackageAgentsDir } from "./model-config.ts";

/**
 * The shared judge protocol — THE embedded copy (see F5 above; test
 * test/judge-prompt.test.ts pins it against docs/judge-protocol.md).
 */
export const JUDGE_COMMON_PROTOCOL = `## 运行形态（tmux 子会话）
- 你是 tmux 子会话里的独立 pi 会话：不带 review-gate 门禁，与主会话同一
  工作区、同一分支，cwd 为仓库根目录。
- 你的上下文跨多轮复用：从本轮任务到产出结论，主会话会把后续消息
  （澄清、修复后的复审）发进同一会话；你记得自己说过什么、查过什么。
- 你可以派廉价的只读探查 subagent（recon）并行查代码、查文档、做调研——
  需要覆盖面时派出去，不要自己逐文件慢慢读。

## 客观与公正
- 独立判断：不顺着主会话的叙述走，也不顺着自己上一轮的结论走。
- 一类问题一次列全：同一问题的变种、同一函数的不同输入边界，尽量在一轮内
  固定下来，不挤牙膏、不来回拉扯。
- 已定论且本轮未动的部分：可跳过或浅验；把精力放在本轮改动与上一轮遗漏上。
- 以证据为准：每条发现都要有可引用的观察（文件、行号、命令输出）。
  做不到的验证明说，不把"没验证"包装成"接受了"。

## 收敛范围（重要）
- 聚焦主流程与常规旁路分支；不在特别小众、特别偏门的边界上死磕——小众
  边界可列为 Note，不升级为阻塞。
- 例外：安全相关、对外暴露相关的边界必须覆盖（如输入校验、权限、数据
  一致性、破坏性操作）。本项目为单用户本地优先项目，这一优先级成立。
- 目标是又快又好地收敛，不是证明你找的问题最多。

## 与主会话的通信
- 你没有 contact_supervisor 之类的即时通道；要向主会话提问（需要决策、需要
  澄清任务），把问题写入 inbox 文件（一行 JSON）：
  {"type":"question","text":"……"}，追加到任务文本里给出的 inbox 路径，然后
  运行 tmux wait-for -S <channel>-inbox（channel 由任务文本给出）唤醒主会话。
  提问后继续等待回复，不要自行假定答案。
- 完成信号（必须）：当你完成本轮任务、输出最终结论（verdict / 建议 /
  结论）之后，运行 tmux wait-for -S <channel>（channel 由任务文本给出，
  通过 bash 执行，无任何附加说明）。这是主会话得知你完成的方式——它
  不会轮询你的屏幕。
- 你的最终输出（verdict / 建议 / 结论）就是你的回复正文；需要流式发布
  findings 时按任务文本指示追加到 findings 文件。

## 通用输出要求
- 结构清晰：先结论后论证；标注文件路径与行号。
- 严重度分级：P0 破坏性 / 安全 / 数据问题；P1 应修；P2 值得修；Nit 风格。
- 遵守 docs/coding-standards.md：你审核的代码、你给出的建议，都以它为准绳
  （深模块、KISS/DRY/YAGNI、卫语句、命名自解释、不写聪明代码……）。`;

/** Judge roles that run as tmux child sessions (not subagents). */
export const JUDGE_ROLES: readonly string[] = Object.freeze([
  "reviewer",
  "adviser",
  "goal-auditor",
]);

/** The package's own agents/ directory (the built-in role definitions). */
export function packageAgentsDir(): string | undefined {
  // Reuses the model-config resolver: it probes the package root AND the
  // nested-install layouts, and is defensive about import.meta.url being a
  // base64 data URL (round-2 P2). The fallback must NOT re-call
  // fileURLToPath — it returns null precisely because that call throws
  // (round-3 P2: the ?? branch inverted the guard); undefined lets the
  // caller skip the package layer instead of crashing.
  return resolvePackageAgentsDir() ?? undefined;
}

/** The user-level agent directory (postinstall copies definitions there). */
export function userAgentsDir(home: string = homedir()): string {
  return join(home, ".pi", "agent", "agents");
}

/**
 * Resolve the role definition file across the three layers that can hold it.
 * Order: the repo's own agents/ (a project that ships custom definitions),
 * the package's built-in agents/, the user's ~/.pi/agent/agents/ (postinstall
 * copy). First hit wins; undefined when none exists (fail soft — the caller
 * falls back to protocol-only).
 */
export function resolveRoleFile(
  repoRoot: string,
  role: string,
  home: string = homedir(),
): string | undefined {
  const pkgDir = packageAgentsDir();
  const candidates = [
    join(repoRoot, "agents", `${role}.md`),
    ...(pkgDir ? [join(pkgDir, `${role}.md`)] : []),
    join(userAgentsDir(home), `${role}.md`),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch { /* keep looking */ }
  }
  return undefined;
}

/**
 * Body of a role definition file: everything after the frontmatter block.
 * Returns undefined when the file is missing or has no body.
 */
export function agentRoleBody(roleFile: string | undefined): string | undefined {
  if (!roleFile) return undefined;
  try {
    const text = readFileSync(roleFile, "utf8");
    const fence = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
    const body = fence.test(text) ? text.replace(fence, "") : text;
    return body.trim().length > 0 ? body.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The full system prompt for one judge role. */
export function buildJudgeSystemPrompt(repoRoot: string, role: string, home?: string): string {
  const body = agentRoleBody(resolveRoleFile(repoRoot, role, home));
  return [
    ...(body ? [body] : [`(agent definition for ${role} missing — follow the protocol below)`]),
    JUDGE_COMMON_PROTOCOL,
  ].join("\n\n");
}

/**
 * Model spec for a role, honoring the config semantics exactly:
 *  - auto:false (explicit slots) ⇒ slots[0] — the chain head;
 *  - auto:true or unconfigured ⇒ the role's OWN frontmatter `model:` (with a
 *    `:thinking` suffix from the frontmatter when present) — the built-in
 *    default, single-sourced from the agent file (round-1 F13: no duplicated
 *    literal).
 * Falls back to "anthropic/claude-fable-5:max" when nothing resolves.
 */
export function modelSpecFor(agents: AgentsConfigMap, role: string, repoRoot: string, home?: string): string {
  const entry = agents[role];
  if (entry && !entry.auto && entry.slots.length > 0) return entry.slots[0]!;
  const roleFile = resolveRoleFile(repoRoot, role, home);
  if (roleFile) {
    try {
      const chain = extractFrontmatterChain(readFileSync(roleFile, "utf8"));
      if (chain?.model) {
        // Frontmatter models are bare ids ("claude-fable-5"); pi --model
        // resolves bare ids only when unique, so pin the package's own
        // provider family when none is written.
        const base = chain.model.includes("/") ? chain.model : `anthropic/${chain.model}`;
        return `${base}:${defaultThinking(roleFile)}`;
      }
    } catch { /* fall through */ }
  }
  return "anthropic/claude-fable-5:max";
}

function defaultThinking(roleFile: string): string {
  try {
    const text = readFileSync(roleFile, "utf8");
    // Scoped to the frontmatter block — a body line "thinking: …" must not
    // match (round-2 Nit).
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    const m = /^thinking:\s*(\S+)\s*$/m.exec(fm ?? "");
    return m?.[1] ?? "max";
  } catch {
    return "max";
  }
}

export interface JudgeSpawnInput {
  /** Absolute repo root (the child's cwd). */
  repoRoot: string;
  /** Role name: reviewer | adviser | goal-auditor. */
  role: string;
  /** Effective per-agent model config (from review-gate.json layers). */
  agents: AgentsConfigMap;
  /** tmux pane title label for the child (done channel derives from it). */
  title: string;
  /** Directory that will hold the system prompt and task files. */
  workDir: string;
}

export interface JudgeSpawnFiles {
  /** Absolute path of the written system-prompt file. */
  sysPromptPath: string;
  /** Absolute path of the written launcher script. */
  launcherPath: string;
  /**
   * Environment pairs to pass to the pane via `tmux split-window -e` /
   * `new-session -e` (values reach the launcher WITHOUT shell interpolation).
   */
  env: Record<string, string>;
  /** The shell command the pane runs (the launcher path, no interpolation). */
  command: string;
}

/** Done-channel name for a judge child (task texts quote this). */
export function doneChannelFor(title: string): string {
  return `rg-${safeChannel(title)}-done`;
}

/** Inbox-channel name for a judge child (questions wake the main session). */
export function inboxChannelFor(title: string): string {
  return `rg-${safeChannel(title)}-inbox`;
}

/** One sanitizer for names and channels (round-2: the old per-function regexes diverged). */
function safeChannel(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
}

/**
 * Write the launcher + system prompt for one judge child and return the
 * spawn inputs. Every dynamic value travels via ENVIRONMENT (split-window -e
 * / new-session -e), never shell interpolation (round-1 F8): the launcher
 * contains no '$(' substitution of caller data and no inlined paths.
 */
export function writeJudgeSpawnFiles(input: JudgeSpawnInput): JudgeSpawnFiles {
  const { repoRoot, role, agents, title, workDir } = input;
  mkdirSync(workDir, { recursive: true });

  const sysPromptPath = join(workDir, "sysprompt.md");
  writeFileSync(sysPromptPath, buildJudgeSystemPrompt(repoRoot, role), "utf8");

  const model = modelSpecFor(agents, role, repoRoot);
  const launcherPath = join(workDir, "start.sh");
  const launcher = [
    "#!/bin/bash",
    '# Every value arrives via environment (RG_*), never via string interpolation:',
    '# a config-supplied value can not become shell syntax (round-1 F8).',
    'SP="$(cat "$RG_SP_FILE")"',
    'cd "$RG_REPO_ROOT"',
    "exec pi --no-extensions --no-skills -e npm:pi-subagents \\",
    '  --system-prompt "$SP" \\',
    '  --model "$RG_MODEL" \\',
    "  --exclude-tools edit,write \\",
    '  --name "$RG_TITLE" \\',
    '  --session-dir "$RG_SESS_DIR"',
  ].join("\n");
  writeFileSync(launcherPath, launcher, "utf8");
  try { chmodSync(launcherPath, 0o755); } catch { /* best-effort */ }

  const env: Record<string, string> = {
    RG_SP_FILE: sysPromptPath,
    RG_REPO_ROOT: repoRoot,
    RG_MODEL: model,
    RG_TITLE: title,
    RG_SESS_DIR: join(workDir, "sessions"),
    RG_LAUNCHER: launcherPath,
  };

  return {
    sysPromptPath,
    launcherPath,
    env,
    // Fixed string — the launcher path travels as RG_LAUNCHER, so an
    // apostrophe in a path can never become shell syntax (round-2 P2).
    command: 'exec /bin/bash "$RG_LAUNCHER"',
  };
}

// ---------------------------------------------------------------------------
// Judge-role dispatch detection (moved from lib/reviewer-spawn-guard.ts when
// the snapshot guard retired 2026-08-27 — the subagent BLOCK still needs the
// detector: a judge role named inside a workflowScript string would bypass a
// top-level-only input.agent check).
// ---------------------------------------------------------------------------

/** Agents whose subagent dispatch is HARD-blocked (judge roles). */
export const JUDGE_AGENT_NAMES: readonly string[] = Object.freeze([
  "reviewer",
  "reviewer-readonly", // retired role; blocking the name still costs nothing
  "adviser",
  "goal-auditor",
]);

/** Tool name that dispatches subagents (pi-subagents registers exactly this). */
export function normalizeToolName(raw: string): string {
  const tail = raw.split(/__|\//).pop() ?? raw;
  return tail.trim().toLowerCase();
}

/**
 * Normalize an agent reference to its bare name: `agents/reviewer.md`,
 * `./reviewer`, `Reviewer` all mean the same agent to pi-subagents, which
 * resolves by name.
 */
export function normalizeAgentName(raw: string): string {
  const tail = raw.trim().split(/[\\/]/).pop() ?? raw;
  return tail.replace(/\.md$/i, "").trim().toLowerCase();
}

/** Is this agent reference one of the judge roles? */
export function isJudgeAgentName(raw: string): boolean {
  return JUDGE_AGENT_NAMES.includes(normalizeAgentName(raw));
}

/**
 * Which judge role a workflow script dispatches, if any.
 *
 * TWO-STEP ON PURPOSE. A workflow that spawns children always names them in an
 * `agent:` field (`runs.run("a", { agent: "reviewer", … })`), so reading those
 * VALUES is both precise and immune to prose: a task string that merely says
 * "hand this to the reviewer" is not a dispatch and must not be blocked.
 *
 * Only when a script carries no `agent:` field at all do we fall back to a
 * word-boundary scan of the whole text. `\breviewer\b` does not match
 * "reviewers" (a plural in prose) but does match inside "reviewer-readonly"
 * (`-` is a word boundary) — which is another judge role, so that direction of
 * over-matching costs nothing.
 */
export function judgeRoleInScript(script: string): string | undefined {
  // Quoted OR bare values: `agent: "reviewer"` and `agent: reviewer` (a bare
  // identifier — common in generated/short scripts) must both be caught, or a
  // workflow could dispatch a judge role without the gate ever seeing it.
  const fieldRe = /\bagent\s*:\s*["'`]?([A-Za-z0-9_.\-/]+)["'`]?/g;
  let m: RegExpExecArray | null;
  let sawField = false;
  while ((m = fieldRe.exec(script)) !== null) {
    sawField = true;
    if (isJudgeAgentName(m[1])) return normalizeAgentName(m[1]);
  }
  if (sawField) return undefined;
  for (const name of JUDGE_AGENT_NAMES) {
    if (new RegExp(`\\b${name}\\b`).test(script)) return name;
  }
  return undefined;
}
