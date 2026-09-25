/**
 * pi-review-gate — per-agent model-chain configuration layer (agents section).
 *
 * WHY: the agent models used to be edited by hand in each `agents/*.md`
 * frontmatter. This module adds a config layer (`agents` section of
 * `.pi/review-gate.json` / `~/.pi/review-gate.json`, layered like precommit):
 *
 *   {
 *     "agents": {
 *       "reviewer": { "auto": false, "slots": ["onekey/gpt-5.6-sol:high", "claude-fable-5:max", "onekey/glm-5.3:high"] },
 *       "adviser":  { "auto": false, "slots": ["claude-fable-5:max"] }
 *     }
 *   }
 *
 * Semantics per configured agent:
 *   - NOT configured in this layer  → the renderer cleans up any generated
 *     copy this layer used to hold (back to the upstream default).
 *   - `auto: false` + slots          → `slots[0]` becomes the main model,
 *     `slots[1..]` the fallback chain, each entry keeping its own
 *     `:thinking` suffix (per-model thinking levels).
 *   - `auto: true` (explicit)        → the renderer writes a *default-chain
 *     overlay* (generated marker + the upstream default model chain). This
 *     lets a higher-precedence layer SHADOW a lower layer's slot render: with
 *     global `reviewer.auto:false` + slots, a project `reviewer.auto:true`
 *     must deploy the built-in default — not leave the global slots render in
 *     force (the deployed model would then contradict the effective config).
 *
 * Two layers, each rendered into its OWN agent directory (the gate's own loader
 * reads both, project overriding user-global):
 *   - project layer → <project>/.pi/agents/*.md
 *   - global  layer → ~/.pi/agent/agents/*.md
 *
 * The extension and the installer call `applyAgentConfigLayer`;
 * `install-package.mjs` applies ONLY the global layer after copying (its
 * cwd is not trustworthy).
 *
 * Fail-safe: a missing/corrupt section, an unresolvable spec or an
 * incompatible thinking level NEVER loosens the gate — validation fails the
 * write and keeps the previous file.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentsConfigMap } from "./agents-config.ts";
import { extractFrontmatterChain, isGeneratedAgentFile, replaceFrontmatterModels } from "./agent-frontmatter.ts";
import { validateSlots, type ModelRegistry } from "./model-spec.ts";

/** The 6 agent files the package ships. */
export const KNOWN_AGENTS: readonly string[] = Object.freeze([
  "reviewer",
  "quality-auditor",
  "adviser",
  "arbiter",
  "goal-auditor",
  "acceptance",
]);

/**
 * WORKER ROLE NAMES (2026-09-21) — the presets `worker_submit` may name.
 *
 * WHAT A WORKER IS. A read-only pane session the agent dispatches for a piece
 * of work it does not want to spend its own context on ("list every caller of
 * X", "read these twelve files and tell me which ones parse the config"). It
 * is the tmux-pane successor to the pi-subagents `Agent` tool, and the user
 * asked for the presets to live in the SAME place the judge roles' model
 * chains live — `~/.pi/review-gate.json` — rather than in a second config file
 * with a second loading rule.
 *
 * THE NAMING CONVENTION, and why it is a prefix rather than a list: the set of
 * presets is the user's to invent (a fast one for recon, a strong one for
 * analysis), so there is no fixed list to validate against. `worker` and
 * anything named `worker-*` are presets; every other name in the `agents`
 * section must be one of {@link KNOWN_AGENTS}, so a typo in a JUDGE name still
 * reports itself instead of quietly becoming an unreachable worker.
 *
 * NOT in {@link KNOWN_AGENTS}, deliberately: that list is what the session-start
 * check hard-fails on, and a session that never dispatches a worker must not
 * refuse to open because no worker preset is configured. The worker path fails
 * closed at CALL time instead.
 */
export const WORKER_ROLE_PREFIX = "worker";

/** Is `name` a worker preset (`worker`, `worker-recon`, …)? */
export function isWorkerRoleName(name: string): boolean {
  return name === WORKER_ROLE_PREFIX || name.startsWith(`${WORKER_ROLE_PREFIX}-`);
}

/**
 * Locate the `agents/` directory INSIDE this package.
 *
 * We PROBE the layouts the package really ships under instead of trusting one
 * relative path — the same lesson `resolveTrustedRunner` (lib/
 * precommit-runner.ts) had to learn: `<here>/../agents` resolves in the dev repo
 * but not in every install layout, and a self-heal riding an unresolvable
 * path fails SILENTLY, which is precisely how a bootstrap deadlock survives.
 *
 * Evaluated lazily at CALL time, never at module scope, and defensive about
 * `import.meta.url`: `scripts/install-package.mjs` stages this module into a
 * temporary directory and imports it by file URL (a `data:` URL has no base,
 * so a relative import such as `./atomic-write.ts` would not resolve there),
 * and `fileURLToPath` throws in any context where there is no file on disk. A
 * module-level evaluation would take the whole postinstall render down with
 * it; null lets each caller fall back to the sourceDir it already knows.
 *
 * `baseDir` exists so the PROBE ORDER itself is testable against temp dirs
 * (production callers pass nothing and get this module's own directory); it is
 * never a runtime override.
 */
export function resolvePackageAgentsDir(baseDir?: string): string | null {
  let here: string;
  if (baseDir !== undefined) here = baseDir;
  else {
    try { here = dirname(fileURLToPath(import.meta.url)); } catch { return null; }
  }
  const candidates = [
    join(here, "agents"),             // package root layout
    join(here, "..", "agents"),       // lib/ sibling (repo + published package)
    join(here, "..", "..", "agents"), // nested install layout
  ];
  for (const c of candidates) {
    // IDENTITY, not just existence: the third candidate reaches two levels up,
    // where an unrelated `agents/` directory can easily live (a monorepo
    // sibling, a user's own folder). Adopting one would feed foreign files to
    // BOTH the chain renderer and the self-heal copy, so a candidate only
    // counts when it actually holds this package's roles.
    try {
      if (existsSync(c) && statSync(c).isDirectory() && existsSync(join(c, "reviewer.md"))) return c;
    } catch { /* keep probing */ }
  }
  return null;
}

export interface EnsureAgentFilesResult {
  /** Agent names whose missing file was restored by this call. */
  copied: string[];
  /** Human-readable problems (never thrown — a session must not die on this). */
  problems: string[];
}

/**
 * Bootstrap self-heal: restore any KNOWN_AGENTS file that is MISSING from the
 * user's agents dir.
 *
 * Without it a newly shipped role only appears after the postinstall runs
 * again, and a role the gate REQUIRES (goal-auditor) would be undispatchable
 * until then — no audit, no goal approval, and in loop mode not even an edit:
 * a deadlock whose only exit is turning the gate off. Healing at session start
 * kills that class for every future role.
 *
 * Deliberately narrow: it only fills GAPS. An existing file (hand-written,
 * rendered, or user-edited) is never touched, so this cannot clobber a
 * configured chain — it just re-establishes the same ownership AGENTS.md
 * already declares for the installed copies.
 */
export function ensureAgentFilesPresent(opts: {
  sourceDir: string | null;
  targetDir: string;
  agents: readonly string[];
}): EnsureAgentFilesResult {
  const copied: string[] = [];
  const problems: string[] = [];
  if (!opts.sourceDir) {
    problems.push(
      "cannot locate the package agents directory (包内 agents 目录无法定位) — missing agent roles " +
      "cannot self-heal; reinstall the package to restore them",
    );
    return { copied, problems };
  }
  for (const name of opts.agents) {
    const target = join(opts.targetDir, `${name}.md`);
    const source = join(opts.sourceDir, `${name}.md`);
    try {
      if (existsSync(target)) continue; // idempotent: gaps only, never an overwrite
      if (!existsSync(source)) continue; // nothing to heal from
      mkdirSync(opts.targetDir, { recursive: true });
      copyFileSync(source, target);
      copied.push(name);
    } catch (e) {
      problems.push(`${name}: could not restore the missing agent file (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { copied, problems };
}







// ---------------------------------------------------------------------------
// Layer application (write/restore generated agent files)
// ---------------------------------------------------------------------------

export interface ApplyAgentLayerOptions {
  /** Effective per-agent settings (all known agents present). */
  agents: AgentsConfigMap;
  /** Rendering target directory (project .pi/agents or global ~/.pi/agent/agents). */
  targetDir: string;
  /** Upstream directory to copy a base file from when targetDir has none. */
  sourceDir: string;
  registry: ModelRegistry;
  /** Skip validation (used only by tests that want raw rendering). */
  validate?: boolean;
  /**
   * INFRASTRUCTURE layers (global ~/.pi/agent/agents; the postinstall copies
   * the defaults there) must RESTORE the upstream default when a config is
   * lifted — deleting the generated copy would leave no user-level agent file
   * at all until the next install. Optional layers (project .pi/agents) delete
   * instead (default).
   */
  restoreDefault?: boolean;
}

export interface ApplyAgentLayerResult {
  written: string[];
  deleted: string[];
  errors: string[];
  warnings: string[];
}

/**
 * Apply the effective config to ONE layer:
 *  - agent NOT configured in this layer → delete any generated product it used
 *    to hold (fall back to upstream), restoring a prior `.bak` if one exists;
 *  - `auto: false` + non-empty slots → validate, then render the slot chain;
 *  - explicit `auto: true` → render a *default-chain overlay* (marker + the
 *    upstream default model chain) so this layer SHADOWS a lower layer's slot
 *    render — deployed model always equals the effective config.
 * Never throws; every failure lands in `errors`.
 */
export function applyAgentConfigLayer(opts: ApplyAgentLayerOptions): ApplyAgentLayerResult {
  const result: ApplyAgentLayerResult = { written: [], deleted: [], errors: [], warnings: [] };
  // WORKER PRESETS ARE NOT RENDERED (2026-09-21, reviewer P1). The render layer
  // exists so a role's MODEL CHAIN can be read back out of `agents/<role>.md`;
  // a worker's chain is read straight from the config section
  // (`lib/worker-channel.ts` `resolveWorkerRole`) and it has no prompt file to
  // render into. Passing one through here is not harmless: with an `agents.worker`
  // entry in the config (which the installer now writes for every user) the
  // renderer looked for `agents/worker.md`, which the package does not ship and
  // which the installer's retired-file sweep had already removed — an error per
  // session start for a file that should never have been expected. Filtered HERE
  // rather than at the call sites: there are three of them, and a rule copied
  // per caller is a rule that drifts.
  const names = Object.keys(opts.agents).filter((name) => !isWorkerRoleName(name));
  // NOTE: no unconditional mkdirSync — creating the target dir eagerly leaves
  // an empty all-default layer behind (extension session-start applied with no
  // `agents` section would otherwise materialize <repo>/.pi/agents for
  // nothing). The dir is created lazily below, only when a generated file is
  // actually written.

  const readBase = (targetPath: string, upstreamPath: string): string | undefined => {
    // Never throws (round-11 P1: an upstream path that is a DIRECTORY made
    // readFileSync throw EISDIR and aborted the whole layer render).
    const readText = (p: string): string | undefined => {
      try {
        if (existsSync(p) && statSync(p).isFile()) return readFileSync(p, "utf8");
      } catch { /* not readable — fall through */ }
      return undefined;
    };
    return readText(upstreamPath) ?? readText(targetPath);
  };
  const backupIfHandwritten = (name: string, targetPath: string, upstreamPath: string): boolean => {
    // Returns false when the adoption must NOT proceed (no working backup).
    if (!existsSync(targetPath)) return true;
    try {
      if (isGeneratedAgentFile(readFileSync(targetPath, "utf8"))) return true;
      let isUpstreamCopy = false;
      try {
        isUpstreamCopy =
          existsSync(upstreamPath) && readFileSync(targetPath, "utf8") === readFileSync(upstreamPath, "utf8");
      } catch { /* not comparable — treat as hand-written */ }
      if (isUpstreamCopy) return true;
      const bak = `${targetPath}.bak`;
      // Keep the .bak as the LATEST hand-written content: a stale backup
      // (v1) must not swallow a newer hand edit (v2) when the config is
      // lifted later — restore then brings back the newest user content
      // (round-11 P1: pre-existing .bak + newer hand-write lost v2).
      // A .bak path that is NOT a regular file (a directory, an unreadable
      // path) must not be silently skipped: taking over a hand-written
      // target without a working backup makes the adoption irreversible
      // (round-11 P1: .bak-as-directory lost the user's content).
      let bakOk = true;
      try {
        bakOk = !existsSync(bak) || statSync(bak).isFile();
      } catch { bakOk = false; }
      if (!bakOk) {
        result.errors.push(`${name}: the .bak path exists but is not a regular file — refusing to take over rendering (an unrecoverable overwrite)`);
        return false;
      }
      let bakStale = false;
      try {
        bakStale = existsSync(bak) && readFileSync(bak, "utf8") !== readFileSync(targetPath, "utf8");
      } catch { bakStale = false; }
      if (!existsSync(bak) || bakStale) {
        copyFileSync(targetPath, bak);
        result.warnings.push(`${name}: hand-written agent file detected; backed up as ${name}.md.bak before taking over rendering`);
      }
      return true;
    } catch {
      result.errors.push(`${name}: cannot read the target file to decide whether it is hand-written`);
      return false;
    }
  };

  for (const name of names) {
    const settings = opts.agents[name];
    const targetPath = join(opts.targetDir, `${name}.md`);
    const upstreamPath = join(opts.sourceDir, `${name}.md`);
    if (settings?.malformed) {
      // The entry named this agent but every field was invalid — keep the
      // last good render untouched (fail-safe; round-11 P1). Neither the
      // cleanup sweep nor a default-chain overlay may run over it.
      result.warnings.push(`${name}: invalid agents configuration; keeping the last render (fail-safe)`);
      continue;
    }
    const explicitlyConfigured = !!settings && settings.source !== "default";
    const wantsSlots = !!settings && settings.auto === false && settings.slots.length > 0;

    // (1) agent NOT configured in this layer → clean up any generated product
    // this layer used to hold (delete, or restore a prior backup).
    if (!explicitlyConfigured) {
      if (!existsSync(targetPath)) continue;
      try {
        if (isGeneratedAgentFile(readFileSync(targetPath, "utf8"))) {
          const bak = `${targetPath}.bak`;
          if (existsSync(bak)) {
            // The render erased a HAND-WRITTEN file earlier and backed it up
            // — restore it when the config is lifted, never leave the user's
            // content as an orphaned .bak.
            renameSync(bak, targetPath);
            result.warnings.push(`${name}: auto is on again; restoring the previously backed-up hand-written agent file`);
          } else if (opts.restoreDefault === true) {
            // Infrastructure layer (global): restore the upstream default file
            // instead of deleting — deleting would leave NO user-level agent
            // until the next install.
            if (existsSync(upstreamPath)) {
              copyFileSync(upstreamPath, targetPath);
              result.warnings.push(`${name}: configuration removed; restoring the upstream default agent file`);
            } else {
              // HARDENED: an unresolvable upstream used to fall through to the
              // delete branch, so "restore the default" silently became "remove
              // the only copy" — exactly the state that makes a required role
              // undispatchable. Keep the file and say why instead.
              result.warnings.push(`${name}: configuration removed but the upstream default is unresolvable (${upstreamPath}) — keeping the existing file rather than deleting the only copy`);
            }
          } else {
            rmSync(targetPath);
            result.deleted.push(name);
          }
        }
      } catch {
        result.errors.push(`${name}: cannot read/restore the rendered product`);
      }
      continue;
    }

    const base = readBase(targetPath, upstreamPath);
    if (base === undefined) {
      result.errors.push(`${name}: upstream file missing: ${upstreamPath}`);
      continue;
    }

    // (2) EXPLICIT auto:true → render the DEFAULT chain (marker + upstream
    // defaults) so this higher-precedence layer SHADOWS a lower layer's slot
    // render. Without this, project auto:true would leave the global auto:false
    // render in force, and the DEPLOYED model would contradict the effective
    // config (deployed != effective).
    if (!wantsSlots) {
      // The DEFAULT chain comes from the UPSTREAM file, never from a
      // hand-written target (round-5 P1: readBase's target fallback once
      // deployed the user's custom chain as if it were the built-in
      // default). No upstream copy ⇒ no trustworthy default: refuse rather
      // than fabricate one. The refusal comes BEFORE the backup — a failed
      // render must not strand an orphan .bak next to the untouched file
      // (round-7 P2).
      let chain: { model: string; fallback: string[] } | undefined;
      try {
        chain = extractFrontmatterChain(readFileSync(upstreamPath, "utf8"));
      } catch { chain = undefined; }
      if (!existsSync(upstreamPath) || chain === undefined) {
        result.errors.push(`${name}: the upstream default agent file is missing or unparseable — refusing to pass a hand-written chain off as the default chain`);
        continue;
      }
      if (!backupIfHandwritten(name, targetPath, upstreamPath)) continue;
      const rendered = replaceFrontmatterModels(base, { model: chain.model, fallbackModels: chain.fallback });
      if (rendered === undefined) {
        result.errors.push(`${name}: frontmatter parse failed (no --- block); not rewritten`);
        continue;
      }
      try {
        mkdirSync(opts.targetDir, { recursive: true });
        writeFileSync(targetPath, rendered, "utf8");
        result.written.push(name);
      } catch (e) {
        result.errors.push(`${name}: write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }

    // (3) auto:false + slots → validate, then render the slot chain.
    const slots = settings.slots;
    if (opts.validate !== false) {
      const v = validateSlots(opts.registry, slots);
      if (!v.ok) {
        result.errors.push(`${name}: ${v.reason}`);
        continue;
      }
      if (v.warning) result.warnings.push(`${name}: ${v.warning}`);
    }
    if (!backupIfHandwritten(name, targetPath, upstreamPath)) continue;
    const rendered = replaceFrontmatterModels(base, {
      model: slots[0]!,
      fallbackModels: slots.slice(1),
    });
    if (rendered === undefined) {
      result.errors.push(`${name}: frontmatter parse failed (no --- block); not rewritten`);
      continue;
    }
    try {
      mkdirSync(opts.targetDir, { recursive: true });
      writeFileSync(targetPath, rendered, "utf8");
      result.written.push(name);
    } catch (e) {
      result.errors.push(`${name}: write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
