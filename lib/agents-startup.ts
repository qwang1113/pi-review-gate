/**
 * Startup agent checks — the session-start HARD CHECK that every judging role
 * has a resolvable model chain, and the self-heal that fills a role no layer
 * configures with the package default before refusing.
 *
 * Split out of lib/model-config.ts (the config layer itself).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { isWorkerRoleName, KNOWN_AGENTS } from "./model-config.ts";
import { collectWorkerRoleNames, effectiveAgentsConfig, lacksExplicitChain, type AgentsConfigMap } from "./agents-config.ts";
import { extractFrontmatterChain } from "./agent-frontmatter.ts";
import { splitThinkingSuffix, validateSlots, validateSpec, type ModelRegistry } from "./model-spec.ts";

// ---------------------------------------------------------------------------
// Startup validation — every role must have a RESOLVABLE model chain.
// ---------------------------------------------------------------------------

/**
 * One role's startup-readiness verdict.
 */
export interface AgentStartupCheck {
  ok: boolean;
  /** Human-readable reason, present exactly when !ok. */
  reason?: string;
}

/**
 * Validate that EVERY role (not just judges) has a chain the gate can actually
 * dispatch. This is the hard check the session start runs (standard 2): a
 * missing/corrupt config, an empty slot list, an unresolvable spec or a model
 * the registry does not know must STOP the session with the reason — never
 * silently fall back to a built-in default that may not exist or may not be
 * what the user pinned.
 *
 * A role with NO entry in ANY layer is the one case a caller may fill first —
 * `startupAgentsCheck` runs `healMissingAgentSlots`, which MERGES the package
 * default into the user's own config (visible, editable), and only then comes
 * back here. That is materializing a default once, not dispatching one
 * silently: the chain still has to resolve HERE before anything launches.
 *
 * Pure over injected facts: the caller decides what "config" means (the
 * effective map), what the registry holds, and which roles matter.
 */
export function validateAgentsForStartup(
  map: AgentsConfigMap,
  registry: ModelRegistry,
  validNames: readonly string[] = KNOWN_AGENTS,
): Record<string, AgentStartupCheck> {
  const checks: Record<string, AgentStartupCheck> = {};
  for (const name of validNames) {
    const e = map[name];
    const who = isWorkerRoleName(name) ? `worker 预设 ${name}` : `角色 ${name}`;
    if (!e) {
      checks[name] = { ok: false, reason: `${who} 没有任何配置（不在 agents 配置层里）` };
      continue;
    }
    if (e.malformed) {
      checks[name] = { ok: false, reason: `${who} 的配置字段非法（malformed）` };
      continue;
    }
    if (lacksExplicitChain(e)) {
      // "auto:true" (or any state without an explicit slot list) means the
      // role would fall back to a built-in default. Per the no-defaults
      // requirement, an unconfigured role must STOP the session rather than
      // silently dispatch a default chain that may not exist or may not be
      // what the user pinned.
      checks[name] = {
        ok: false,
        reason:
          `${who} 未配置模型链（auto:${String(e.auto)}，slots 为空）——` +
          (isWorkerRoleName(name)
            ? `把它写成 auto:false + slots，或删掉这个预设（worker 预设没有包内默认链，不会自愈）`
            : `把它写成 auto:false + slots，或删掉该键让启动自愈补上包内默认链`),
      };
      continue;
    }
    const invalid = e.slots.find((s) => !validateSpec(registry, s).ok);
    if (invalid) {
      checks[name] = {
        ok: false,
        reason: `${who} 的 spec 非法或不可解析："${invalid}"（${validateSpec(registry, invalid).reason}）`,
      };
      continue;
    }
    checks[name] = { ok: true };
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Startup self-heal — a role NO layer configures gets the package default.
// ---------------------------------------------------------------------------

/** Frontmatter `thinking:` level of a role file, scoped to the frontmatter
 *  block (a body line `thinking: …` must not match); null when absent. */
export function frontmatterThinking(text: string): string | null {
  const fm = /^---[^\n]*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  return /^thinking:\s*(\S+)\s*$/m.exec(fm ?? "")?.[1] ?? null;
}

/** `bare-id` → `anthropic/bare-id:<level>`; a spec that already carries its own
 *  level keeps it — the level is per-model (a rendered chain writes `:xhigh` on
 *  one slot and `:max` on the next), and appending the default again would
 *  render `…:max:max`, which resolves to nothing. */
function pinSlotsSpec(spec: string, fallbackThinking: string): string {
  const trimmed = spec.trim();
  if (!trimmed) return "";
  const { base, thinking } = splitThinkingSuffix(trimmed);
  const pinned = base.includes("/") ? base : `anthropic/${base}`;
  return `${pinned}:${thinking ?? fallbackThinking}`;
}

/**
 * A role file's built-in default chain, as CONFIG SLOTS.
 *
 * This is the ONE place the package's built-in chain becomes slot syntax: the
 * renderer's `auto:true` path (`modelChainFor`, lib/judge-prompt.ts) and the
 * startup self-heal both come through here, so the chain a role deploys and
 * the chain the heal writes into the user's config can never disagree.
 *
 * Bare ids are provider-pinned for the same reason the renderer pins them: a
 * provider-less spec only resolves while the id is unique across providers
 * (`validateSpec` refuses an ambiguous one), and every role this package ships
 * pins an anthropic id.
 */
export function defaultSlotsFromRoleText(text: string): string[] | undefined {
  const chain = extractFrontmatterChain(text);
  if (!chain?.model) return undefined;
  const thinking = frontmatterThinking(text) ?? "max";
  const slots = [chain.model, ...chain.fallback].map((spec) => pinSlotsSpec(spec, thinking)).filter(Boolean);
  return slots.length > 0 ? slots : undefined;
}

/** Read one shipped role file's default chain. `undefined` when the file is
 *  unreadable or carries no parseable `model:` line (nothing to heal from). */
export function defaultSlotsForRole(agentsDir: string | null, role: string): string[] | undefined {
  if (!agentsDir) return undefined;
  try {
    return defaultSlotsFromRoleText(readFileSync(join(agentsDir, `${role}.md`), "utf8"));
  } catch {
    return undefined;
  }
}

export interface AgentSlotHealResult {
  /** Roles whose package-default chain was MERGED into the config file. */
  healed: string[];
  /** Why a missing role could not be healed — never thrown (a session must not
   *  die on a self-heal), but never silent either. */
  problems: string[];
  /** The file's `agents` section AFTER the write, so the caller can re-run the
   *  startup check without re-reading the file. `undefined` when the config
   *  could not be read (nothing was written). */
  agentsSection?: Record<string, unknown>;
}

/**
 * Startup self-heal: give a role that NO config layer declares the package's
 * own default chain, by MERGING it into `~/.pi/review-gate.json`.
 *
 * WHY it exists next to `ensureAgentFilesPresent`: adding a role to
 * {@link KNOWN_AGENTS} used to brick every session on a machine whose config
 * predates the role — the startup hard check refuses to run, so the session
 * cannot even come up to be told to run the installer. The heal writes the
 * default slots into the user's OWN config, where they stay visible and
 * editable: this is not a silent fallback at dispatch time (the startup check
 * still requires a resolvable chain), it is the ordinary "materialize the
 * default once, then treat the file as the truth" step.
 *
 * Deliberately narrow, in three ways: only GAPS (a role the file already names
 * is the user's pin, whatever it says), only chains the CURRENT registry can
 * resolve (writing an unresolvable chain would corrupt the user's config to no
 * purpose — the refusal below then reports the role as unconfigured), and
 * never over a file that does not parse (corrupt ≠ absent, here as everywhere
 * else in this module).
 *
 * Pure enough to test: it takes the paths, the role list and the registry, and
 * never throws.
 */
export function healMissingAgentSlots(opts: {
  configPath: string;
  agentsDir: string | null;
  roles: readonly string[];
  registry: ModelRegistry;
}): AgentSlotHealResult {
  const result: AgentSlotHealResult = { healed: [], problems: [] };
  const wanted = [...new Set(opts.roles)];
  if (wanted.length === 0) return result;

  let raw: Record<string, unknown>;
  try {
    if (existsSync(opts.configPath)) {
      const parsed: unknown = JSON.parse(readFileSync(opts.configPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        result.problems.push(`${opts.configPath}: 顶层不是 JSON 对象 —— 拒绝改写（配置损坏时绝不覆盖）`);
        return result;
      }
      raw = parsed as Record<string, unknown>;
    } else {
      raw = {};
    }
  } catch (e) {
    result.problems.push(
      `${opts.configPath}: 读取/解析失败（${e instanceof Error ? e.message : String(e)}）—— 拒绝改写`,
    );
    return result;
  }

  const existing = raw.agents;
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    result.problems.push(`${opts.configPath}: agents 段不是对象 —— 拒绝改写`);
    return result;
  }
  const agents: Record<string, unknown> = { ...(existing as Record<string, unknown> | undefined) };
  const added: string[] = [];
  // An EMPTY object is "not a config" — the parser makes the same equivalence
  // (`parseAgentsSection`: an empty object stays absent), so it must not count
  // as a pin here either. Without this, `"acceptance": {}` was a deadlock:
  // nothing healed it and the refusal pointed at the installer, which only
  // fills MISSING keys (quality-auditor P2, 2026-09-22).
  const isEmptyEntry = (v: unknown): boolean =>
    typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v as Record<string, unknown>).length === 0;
  for (const role of wanted) {
    // GAPS ONLY: a NON-empty entry is the user's declaration, whatever it says
    // — it is never overwritten, and the refusal tells them how to fix it.
    if (Object.hasOwn(agents, role) && !isEmptyEntry(agents[role])) continue;
    const slots = defaultSlotsForRole(opts.agentsDir, role);
    if (!slots) {
      result.problems.push(`角色 ${role} 缺位，但包内 agents/${role}.md 不可读或没有 model 行 —— 没有可补的默认 slots`);
      continue;
    }
    const invalid = validateSlots(opts.registry, slots);
    if (!invalid.ok) {
      result.problems.push(
        `角色 ${role} 的包内默认链在当前 registry 下不可解析（${invalid.reason}）—— 不写入，避免把用户配置写坏`,
      );
      continue;
    }
    agents[role] = { auto: false, slots };
    added.push(role);
  }

  if (added.length === 0) {
    // Nothing to write: never touch the file, so the no-op case stays byte-stable.
    result.agentsSection = existing as Record<string, unknown> | undefined;
    return result;
  }
  try {
    // ATOMIC REPLACEMENT, NOT A BARE WRITE (P1, cross-task fix picked up from
    // f544605 — see this round's commit message): every OTHER session and judge
    // pane on the machine reads this file while it is being written, and a
    // half-written `review-gate.json` reads as CORRUPT — after which the user's
    // own pinned chains are reported unresolvable and those sessions refuse to
    // start. lib/atomic-write.ts is the repository's one implementation of
    // temp-then-rename; nothing else about the heal changed.
    writeFileAtomic(opts.configPath, JSON.stringify({ ...raw, agents }, null, 2) + "\n");
  } catch (e) {
    result.problems.push(
      `${opts.configPath}: 写入失败（${e instanceof Error ? e.message : String(e)}）—— 缺角色没有补上`,
    );
    return result;
  }
  result.healed = added;
  result.agentsSection = agents;
  return result;
}

export interface StartupAgentsResult {
  /** One verdict per role, AFTER the self-heal ran (when one was needed). */
  checks: Record<string, AgentStartupCheck>;
  /** Roles the self-heal merged into the user's config — empty when nothing was missing. */
  healed: string[];
  /** Why a heal attempt could not fill a role — empty when none was needed or it succeeded. */
  healProblems: string[];
  /**
   * The config file's `agents` section as the heal left it (undefined when the
   * heal never ran or the file was unreadable). The CALLER should adopt it in
   * place of its in-memory snapshot: a session reads its config once, and
   * everything downstream of the startup check (`resolveArbiterModel`, layer
   * rendering, dispatch) would otherwise keep seeing the pre-heal state — a
   * session that passed the check while still configuring nothing.
   */
  agentsSection?: Record<string, unknown>;
  /** Failing role → the config file the user must fix for it: the layer that
   *  DECLARES it (project wins, as in the merge), else the global file the
   *  heal writes to. A refusal naming the global file for a project-layer
   *  preset sent users to a file that does not mention it. */
  configFiles: Record<string, string>;
  /** The distinct files in {@link configFiles}, in first-failure order. */
  fixFiles: string[];
}

/**
 * The session-start check as ONE decision: validate every role, self-heal the
 * roles NO layer declares, then validate again.
 *
 * It lives here rather than inline in the extension because the ORDER is the
 * substance — heal only what is unconfigured, heal before refusing, refuse
 * right after the healed map is checked — and an ordering rule buried in a
 * host entry point cannot be tested. The caller only decides where the config
 * lives (`configPath` / `agentsDir`) and what the registry holds.
 */
export function startupAgentsCheck(opts: {
  agentsGlobal: unknown;
  agentsProject: unknown;
  registry: ModelRegistry;
  configPath: string;
  /** The project layer's file — named in the refusal for a role it declares. */
  projectConfigPath: string;
  agentsDir: string | null;
  validNames?: readonly string[];
}): StartupAgentsResult {
  const judgeNames = opts.validNames ?? KNOWN_AGENTS;
  const { map } = effectiveAgentsConfig(opts.agentsGlobal, opts.agentsProject, judgeNames);
  // WORKER PRESETS a layer actually declares are checked too (2026-09-26): a
  // typo'd spec used to surface only at the first `worker_submit`. A key whose
  // value configures nothing (`worker: {}`) stays at source "default" and is
  // not a preset — no worker at all is never an error. Workers have no package
  // default, so they are never handed to the heal below (it keys on judges).
  const workers = collectWorkerRoleNames(opts.agentsGlobal, opts.agentsProject)
    .filter((name) => map[name]?.source !== "default");
  const validNames = [...judgeNames, ...workers];
  const failing = (checks: Record<string, AgentStartupCheck>): string[] =>
    Object.entries(checks).filter(([, c]) => c && !c.ok).map(([name]) => name);

  let checks = validateAgentsForStartup(map, opts.registry, validNames);
  let sources = map;
  const bad = failing(checks);
  const healProblems: string[] = [];
  let healed: string[] = [];
  let agentsSection: Record<string, unknown> | undefined;
  if (bad.length > 0) {
    // GAPS ONLY: a role no layer declares. One the user pinned (even badly) is
    // their config to fix — overwriting it would silently discard their choice.
    const unconfigured = bad.filter((name) => map[name]?.source === "default" && !isWorkerRoleName(name));
    const heal = healMissingAgentSlots({
      configPath: opts.configPath,
      agentsDir: opts.agentsDir,
      roles: unconfigured,
      registry: opts.registry,
    });
    healProblems.push(...heal.problems);
    healed = heal.healed;
    agentsSection = heal.agentsSection;
    // RE-VALIDATE AGAINST THE FILE, not against the caller's snapshot — and
    // not only when THIS call wrote something. `agentsGlobal` is read once per
    // session, so a role healed on an earlier turn lives in the file and
    // nowhere in memory; gating the re-check on `healed.length > 0` made every
    // later turn find the file already complete (nothing left to heal), skip
    // the re-check, and return the PRE-HEAL failure — a session that reports
    // "cannot start" on every turn while the config on disk is fine
    // (quality-auditor P1, 2026-09-22). `agentsSection` is the file's section
    // as the heal left it, written or not.
    if (heal.agentsSection !== undefined) {
      const merged = effectiveAgentsConfig(heal.agentsSection, opts.agentsProject, judgeNames);
      checks = validateAgentsForStartup(merged.map, opts.registry, validNames);
      sources = merged.map;
    }
  }
  const configFiles: Record<string, string> = {};
  for (const name of failing(checks)) {
    configFiles[name] = sources[name]?.source === "project" ? opts.projectConfigPath : opts.configPath;
  }
  const fixFiles = [...new Set(Object.values(configFiles))];
  return { checks, healed, healProblems, configFiles, fixFiles, ...(agentsSection === undefined ? {} : { agentsSection }) };
}
