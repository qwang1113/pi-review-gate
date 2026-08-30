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

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AgentsConfigMap } from "./model-config.ts";
import { extractFrontmatterChain, resolvePackageAgentsDir } from "./model-config.ts";
/**
 * The shared judge protocol — THE embedded copy (see F5 above; test
 * test/judge-prompt.test.ts pins it against docs/judge-protocol.md).
 */
export const JUDGE_COMMON_PROTOCOL = `## 运行形态（独立 pi 进程）
- 你是主会话 spawn 的独立 pi 进程（pi -p --session-id）：不带 review-gate 门禁，与主会话同一
  工作区、同一分支，cwd 为仓库根目录。
- 你的上下文跨多轮复用：每次主会话用同一个 session id 重新拉起你，都延续同一段
  对话——你记得自己说过什么、查过什么。本轮任务文本在启动时随 @file 传入。
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
  澄清任务），把问题作为**最后一个 fenced JSON 输出**并退出：
  一个 JSON 对象，含 question 与 context 字段。主会话读到 question
  fence 会带着答案用同一个 session id 重新拉起你——
  你的上下文原样延续，直接继续作答。提问后不要自行假定答案。
- 完成（必须）：完成本轮任务、输出最终结论（verdict / 建议 / 结论）后
  正常退出即可——进程退出即完成，主会话以你的输出和 session 记录为准，
  不需要（也没有）任何额外信号。
- 你的最终输出（verdict / 建议 / 结论）就是你的回复正文；需要流式发布
  findings 时按任务文本指示追加到 findings 文件。

## 通用输出要求
- 结构清晰：先结论后论证；标注文件路径与行号。
- 严重度分级：P0 破坏性 / 安全 / 数据问题；P1 应修；P2 值得修；Nit 风格。
- 遵守 docs/coding-standards.md：你审核的代码、你给出的建议，都以它为准绳
  （深模块、KISS/DRY/YAGNI、卫语句、命名自解释、不写聪明代码……）。

## 输出纪律（token 预算）
- 主会话机械消费的只有：verdict JSON fence（门禁在你的进程退出时自己解析并
  记录，主会话不转抄）与 findings 流文件（每行 JSON 证据）。fence 之外的
  prose 不被消费——写长 prose 是纯 token 浪费。
- **findings 只写阻塞项（P0/P1）**。不阻塞的意见（P2/Nit/可选优化）写进
  notes 的要点里，或者干脆不写。两条理由：裁决是机械的（无 P0/P1 即通过），
  非阻塞 findings 只会变成需要转交和解释的噪音；而且「用 P2 提一句」是逃避
  真正该说的 P1 的常见方式——该阻塞就标 P0/P1，不该阻塞就别占 findings 位。
- 最终输出格式固定：verdict fence 在最前；其后最多 5 行结论要点（每条一句）；
  findings 每条 ≤2 行（含 file/line/severity/issue）；notes ≤5 行，只写结论与
  关键证据。不复述任务、不复述代码、不写客套与过程叙事。详细证据放 findings
  流（evidence 字段），不要写进正文。
- goal-auditor：只输出 fence + ≤3 行要点；adviser：结论 + 要点列表，同样不写过程。`;
/** Judge roles that run as independent pi processes (not subagents). */
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
 * Returns undefined when NOTHING resolves — there is NO hard-coded fallback
 * (user requirement 2026-08-30); the caller fails closed.
 */
export function modelSpecFor(agents: AgentsConfigMap, role: string, repoRoot: string, home?: string): string | undefined {
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
  // NO BUILT-IN DEFAULT (user requirement 2026-08-30). A role without a
  // resolvable chain is a configuration error — the caller fails closed
  // (the startup hard check is what surfaces it to the user).
  return undefined;
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
  /**
   * The SPAWNING session's id, delivered as RG_PARENT_SESSION. A child that
   * loads this extension later publishes directed attention events only to
   * this parent (round-18: directed parent notify instead of a global
   * broadcast).
   */
  parentSessionId?: string;
}

export interface JudgeSpawnFiles {
  /** Absolute path of the written system-prompt file. */
  sysPromptPath: string;
  /** The effective model spec for the role (modelSpecFor); undefined = unconfigured. */
  model: string | undefined;
}

/**
 * Write the system prompt for one judge child and return the spawn inputs.
 * The PROCESS substrate (lib/judge-process.ts) builds the argv itself from
 * these values — no launcher script, no tmux pane, no env channel needed
 * (the child is a direct spawn of this extension process).
 */
export function writeJudgeSpawnFiles(input: JudgeSpawnInput): JudgeSpawnFiles {
  const { repoRoot, role, agents, workDir } = input;
  mkdirSync(workDir, { recursive: true });
  const sysPromptPath = join(workDir, "sysprompt.md");
  writeFileSync(sysPromptPath, buildJudgeSystemPrompt(repoRoot, role), "utf8");
  return {
    sysPromptPath,
    model: modelSpecFor(agents, role, repoRoot),
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
