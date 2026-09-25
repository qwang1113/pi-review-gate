/**
 * THE MODEL-CONFIG LAYERS, as this session renders and reads them — the
 * dispatch-time config read and the per-session render of both agent layers.
 * Moved out of `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { effectiveAgentsConfig } from "./agents-config.ts";
import {
  applyAgentConfigLayer,
  ensureAgentFilesPresent,
  KNOWN_AGENTS,
  resolvePackageAgentsDir,
} from "./model-config.ts";
import { loadRegistry, type ModelRegistry, type RegistryModelInfo } from "./model-spec.ts";
import { loadProjectConfig, type ProjectConfig } from "./project-config.ts";
import type { SessionCells } from "./session-cells.ts";

/** Disk registry merged with the SESSION's runtime registry. The runtime
 *  view is authoritative (built-in anthropic catalogs never reach
 *  models-store.json): validating against the disk alone would let a stale
 *  render be deployed (round-2 P1). */
function modelConfigRegistry(ctx: ExtensionContext): ModelRegistry {
  const merged = loadRegistry();
  try {
    const reg = (ctx as { modelRegistry?: unknown }).modelRegistry as { getAll?: () => unknown[] } | undefined;
    const all = typeof reg?.getAll === "function" ? reg.getAll() : [];
    for (const m of all) {
      const obj = m as { provider?: unknown; id?: unknown; reasoning?: unknown; thinkingLevelMap?: unknown };
      if (typeof obj.provider !== "string" || typeof obj.id !== "string") continue;
      const list = (merged[obj.provider] ??= [] as RegistryModelInfo[]);
      // The runtime entry REPLACES any same-id disk entry — the runtime view
      // is authoritative, and keeping the disk metadata could preserve a
      // stale thinkingLevelMap that refuses levels the live registry
      // supports (round-3 P1).
      const tlm = obj.thinkingLevelMap;
      const info: RegistryModelInfo = {
        id: obj.id,
        ...(typeof obj.reasoning === "boolean" ? { reasoning: obj.reasoning } : {}),
        // Filter the map the same way loadRegistry / factsFromRegistry do:
        // a bare cast let a malformed value (a number, an object) through as
        // if it were a valid mapping, and validateSpec then ACCEPTED a level
        // the filtered semantics refuse (deployed ≠ validated).
        thinkingLevelMap: typeof tlm === "object" && tlm !== null && !Array.isArray(tlm)
          ? Object.fromEntries(
              Object.entries(tlm).filter(([, mapped]) => mapped === null || typeof mapped === "string"),
            ) as Record<string, string | null>
          : undefined,
      };
      const idx = list.findIndex((e) => e.id === obj.id);
      if (idx >= 0) list[idx] = info;
      else list.push(info);
    }
  } catch { /* runtime registry unusable — the disk view stands */ }
  return merged;
}

/**
 * The agents-layer key of one config snapshot, for the change guard below.
 *
 * Whatever the JSON is, the RENDERED files depend on exactly these values:
 * the two agents sections and the two corrupt flags (a corrupt layer keeps
 * the last render instead of sweeping it).
 */
function agentsLayerKey(cfg: ProjectConfig): string {
  return JSON.stringify([cfg.agentsGlobal ?? null, cfg.agentsProject ?? null, cfg.agentsGlobalCorrupt ?? false, cfg.agentsProjectCorrupt ?? false]);
}

export function createModelLayers(cells: SessionCells, deps: { log(text: string): void }) {
  let lastLayerNotifyText = "";
  /**
   * The agents-layer key of the config the model layers were last rendered
   * from (null = nothing rendered yet this session). `ensureModelLayersRendered`
   * is called at session start AND before every judge dispatch, and the
   * renderer writes unconditionally — this is what keeps the dispatch-time
   * call a no-op until the config actually changes on disk.
   */
  let lastRenderedAgentsKey: string | null = null;

  /**
   * The agents layer AS IT IS ON DISK RIGHT NOW (the dispatch-time read).
   *
   * WHY THIS EXISTS (2026-09-10, measured in rebate): `projectConfig` is
   * loaded ONCE per session start, and the judge dispatch read its model chain
   * from that in-memory snapshot. A user who edited `~/.pi/review-gate.json`
   * mid-session kept getting the OLD chain launched — while the judge pane's
   * own session start re-rendered `.pi/agents/*.md` from the NEW one, so the
   * file on disk and the model actually running contradicted each other.
   *
   * A corrupt layer keeps the snapshot's value (corrupt ≠ absent: treating it
   * as "unconfigured" would sweep a valid chain back to the built-in default).
   */
  function freshProjectConfig(root: string): ProjectConfig {
    const fresh = loadProjectConfig(root);
    const projectConfig = cells.projectConfig;
    return {
      ...fresh,
      agentsGlobal: fresh.agentsGlobalCorrupt ? projectConfig.agentsGlobal : fresh.agentsGlobal,
      agentsProject: fresh.agentsProjectCorrupt ? projectConfig.agentsProject : fresh.agentsProject,
      agentsGlobalCorrupt: fresh.agentsGlobalCorrupt ?? projectConfig.agentsGlobalCorrupt,
      agentsProjectCorrupt: fresh.agentsProjectCorrupt ?? projectConfig.agentsProjectCorrupt,
    };
  }

  /**
   * Re-apply BOTH model-config layers once per session start: global
   * (~/.pi/agent/agents) AND the current repo's project layer
   * (<primaryRepoRoot>/.pi/agents, which outranks global).
   *
   * `scripts/install-package.mjs` imports lib/model-config.ts through a
   * stripped data URL (which works under node_modules), so the postinstall DOES
   * render the global layer on a published install — but only the extension
   * ever renders the PROJECT layer, and only the extension re-renders after the
   * config changes between installs.
   *
   * It also sweeps stale generated overrides when the `agents` section is gone:
   * every agent then defaults to auto:true, whose renderer deletes generated
   * products in that layer. Hand-written / upstream copies are never touched
   * (no marker). Idempotent (the same slots re-render the same overlay) and
   * fail-soft (a render failure never blocks a session); a corrupt layer keeps
   * the last good render instead of sweeping it.
   */
  function ensureModelLayersRendered(
    ctx: ExtensionContext,
    cfg: ProjectConfig = cells.projectConfig,
    root: string = cells.primaryRepoRoot,
  ): void {
    // CHANGE GUARD (2026-09-10): the renderer writes unconditionally, so the
    // dispatch-time call below must not re-write four agent files per judge
    // round. The same config renders the same files — one key is enough.
    // `null` means "nothing rendered yet this session", so the first call
    // (session start) always renders.
    const cfgKey = agentsLayerKey(cfg);
    if (lastRenderedAgentsKey === cfgKey) return;
    lastRenderedAgentsKey = cfgKey;
    const problems: string[] = [];
    try {
      // lib/ and extensions/ are siblings in every install layout, so the
      // package root is this module's parent's parent either way.
      const packageRoot = pathDirname(fileURLToPath(import.meta.url));
      // The package's own agents/ directory, found by PROBING the install
      // layouts (resolvePackageAgentsDir) rather than trusting one relative
      // path: `<packageRoot>/../agents` is only correct in some layouts, and a
      // source that silently fails to resolve turns both the render and the
      // self-heal below into no-ops. Resolved ONCE and shared, so the renderer
      // and the heal can never disagree about where the defaults live — the
      // legacy relative path stays as a last-resort fallback for both.
      const probedAgentsDir = resolvePackageAgentsDir();
      const packageAgentsDir = probedAgentsDir ?? pathJoin(packageRoot, "..", "agents");
      const globalAgentsDir = pathJoin(homedir(), ".pi", "agent", "agents");
      // BOOTSTRAP SELF-HEAL (before any rendering): a role the gate REQUIRES —
      // goal-auditor gates every goal approval — must be dispatchable, or the
      // session deadlocks with no exit but switching the gate off. Filling only
      // the GAPS is idempotent and never clobbers a configured chain.
      const healed = ensureAgentFilesPresent({
        sourceDir: existsSync(packageAgentsDir) ? packageAgentsDir : null,
        targetDir: globalAgentsDir,
        agents: KNOWN_AGENTS,
      });
      if (healed.copied.length > 0) deps.log(`self-healed missing agent files: ${healed.copied.join(", ")}`);
      problems.push(...healed.problems);
      // Global layer. A CORRUPT config file keeps the last good render:
      // treating it as "no agents section" would sweep every generated chain
      // back to the upstream default and clobber the last valid render
      // (corrupt ≠ absent for the renderer).
      if (cfg.agentsGlobalCorrupt) {
        problems.push("global: ~/.pi/review-gate.json is corrupt or its agents section is invalid — keeping the last rendered model chains (fail-safe)");
      } else {
        const { map, diagnostics } = effectiveAgentsConfig(cfg.agentsGlobal ?? undefined, undefined);
        problems.push(...diagnostics);
        problems.push(...cfg.agentsDiagnostics.filter((d) => d.startsWith("global:")));
        const res = applyAgentConfigLayer({
          agents: map,
          targetDir: globalAgentsDir,
          // Infrastructure layer: restore the upstream default on cleanup.
          restoreDefault: true,
          sourceDir: packageAgentsDir,
          registry: modelConfigRegistry(ctx),
        });
        problems.push(...res.errors, ...res.warnings);
      }
      // Project layer of the CURRENT repo (project outranks global) — same
      // fail-safe: a corrupt project file keeps the last project render.
      if (cfg.agentsProjectCorrupt) {
        problems.push("project: .pi/review-gate.json is corrupt or its agents section is invalid — keeping the last rendered model chains (fail-safe)");
      } else {
        const { map, diagnostics } = effectiveAgentsConfig(undefined, cfg.agentsProject ?? undefined);
        problems.push(...diagnostics);
        problems.push(...cfg.agentsDiagnostics.filter((d) => d.startsWith("project:")));
        const res = applyAgentConfigLayer({
          agents: map,
          targetDir: pathJoin(root, ".pi", "agents"),
          // Project-layer base is the BUILT-IN default (package agents dir),
          // NEVER the already-rendered global layer — a global auto:false slot
          // render must not leak into a project auto:true shadow (round-7 P1).
          sourceDir: packageAgentsDir,
          registry: modelConfigRegistry(ctx),
        });
        problems.push(...res.errors, ...res.warnings);
      }
    } catch (e) {
      problems.push(`model config layer render failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // A rejected slot chain must never be silent: the renderer reads the
    // same config, so the user has to see that the DEPLOYED chain and the
    // PLANNED chain diverged (round-1 P2). The same problem set is NOT
    // re-notified on every session start (round-2 Nit).
    if (problems.length > 0) {
      const text = `review-gate: model config layer problems (${problems.length}):\n${problems.slice(0, 5).join("\n")}`;
      if (text !== lastLayerNotifyText) {
        lastLayerNotifyText = text;
        try {
          ctx.ui.notify(text, "warning");
        } catch { /* headless — no UI to notify */ }
      }
    }
  }

  return { freshProjectConfig, ensureModelLayersRendered };
}
