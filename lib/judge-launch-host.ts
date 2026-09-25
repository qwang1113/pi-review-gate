/**
 * WHAT A JUDGE ROUND LAUNCHES ON — the fresh config read, the health-aware
 * slot pick and the stale session-dir reclaim a dispatch does first, moved out
 * of `extensions/review-gate.ts` (t6, wave 2 of the split) beside the registry
 * whose model health and table it reads (lib/judge-registry-host.ts).
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { effectiveAgentsConfig } from "./agents-config.ts";
import { writeJudgeSpawnFiles } from "./judge-prompt.ts";
import { describeCoolingSlot, modelKeyOf, selectHealthySlot, type ModelHealth, type SlotChoice } from "./model-health.ts";
import type { HierarchyTable } from "./hierarchy.ts";
import { laneOfEntry } from "./judge-rotation.ts";
import { shortRepoHash } from "./judge-process.ts";
import {
  judgeWorkDirBasename,
  legacyJudgeWorkDirBasename,
  selectStaleJudgeSessionDirs,
  JUDGE_SESSIONS_RELDIR,
} from "./judge-lifecycle.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { SessionHost } from "./session-host.ts";

/** What one judge round launches on: the chain, the pick, and why. */
export type JudgeLaunch =
  | { ok: true; sysPromptPath: string; spec: string; chain: string[]; choice: SlotChoice }
  | { ok: false; error: string };

export function createJudgeLaunch(
  host: SessionHost,
  deps: {
    /** The repo's config, re-read from disk. */
    freshProjectConfig(root: string): ProjectConfig;
    /** Re-render the model layers when the config changed (idempotent). */
    ensureModelLayersRendered(ctx: ExtensionContext, cfg: ProjectConfig, root: string): void;
    /** The live (pruned) model health of one repo (the registry's). */
    judgeModelHealth(root: string): ModelHealth;
    /** The current judge table (the registry's). */
    judgeHierarchy(): HierarchyTable;
  },
) {
  const { freshProjectConfig, ensureModelLayersRendered, judgeModelHealth } = deps;

  /**
   * Resolve what THIS round launches on — read fresh, picked by health.
   *
   * THREE THINGS HAPPEN HERE, and they are one function because a dispatch
   * that did only two of them is exactly the defect this fixes (2026-09-10):
   *   1. the agents config is re-READ from disk (a session that started before
   *      the user's edit used to keep launching the old chain for hours);
   *   2. the model layers are re-rendered when the config changed, so the
   *      `.pi/agents/*.md` chain on disk matches the model actually launched;
   *   3. the slot is picked from the WHOLE chain, skipping the ones cooling
   *      down (lib/model-health.ts), instead of always taking `slots[0]`.
   */
  function resolveJudgeLaunch(root: string, role: string, workDir: string, title: string, judgeId: string): JudgeLaunch {
    const cfg = freshProjectConfig(root);
    // Rendering writes files; it is idempotent and guarded by the config key,
    // so the dispatch-time call is a no-op until the config actually changes.
    const latestCtx = host.ctx();
    if (latestCtx) ensureModelLayersRendered(latestCtx, cfg, root);
    const { map: agents } = effectiveAgentsConfig(cfg.agentsGlobal, cfg.agentsProject);
    const files = writeJudgeSpawnFiles({ repoRoot: root, role, agents, workDir, title });
    if (files.chain.length === 0) {
      // NO BUILT-IN DEFAULT (user requirement 2026-08-30): a role with no
      // resolvable chain cannot be dispatched. Fail closed with the reason.
      return { ok: false, error: `角色 ${role} 没有可派发的模型链（agents 配置缺失或不可解析）——请修复 ~/.pi/review-gate.json 后重试` };
    }
    const choice = selectHealthySlot(files.chain, judgeModelHealth(root), Date.now());
    if (!choice) return { ok: false, error: `角色 ${role} 的模型链为空（不可达）` };
    announceSlotSkip(role, choice);
    return { ok: true, sysPromptPath: files.sysPromptPath, spec: choice.spec, chain: files.chain, choice };
  }

  /**
   * Say which slots the pick stepped over — a silent skip is the same
   * blindness as never skipping at all.
   */
  function announceSlotSkip(role: string, choice: SlotChoice): void {
    if (choice.skipped.length === 0) return;
    const now = Date.now();
    const skipped = choice.skipped.map((s) => describeCoolingSlot(s, now)).join("、");
    const head = choice.allCooling
      ? `review-gate: ${role} 的全部模型槽都在冷却期（${skipped}）——本轮仍按链头 ${modelKeyOf(choice.spec)} 派发，失败会立刻上报。`
      : `review-gate: ${role} 跳过冷却中的模型槽 ${skipped} → 本轮用 ${modelKeyOf(choice.spec)}。`;
    try { host.ctx()?.ui.notify(head, "warning"); } catch { /* headless */ }
  }

  /**
   * Best-effort reclaim of judge session dirs nobody owns. Registry-referenced
   * dirs (either format — a live peer's, whatever code it runs) are protected;
   * unreferenced legacy dirs go immediately, anything else past the TTL
   * (lib/judge-lifecycle.ts decides, this only lists and deletes).
   * Never throws: the sweep must not break a dispatch.
   */
  function sweepStaleJudgeSessionDirs(root: string): void {
    try {
      const base = pathJoin(root, JUDGE_SESSIONS_RELDIR);
      const known = new Set<string>();
      for (const e of Object.values(deps.judgeHierarchy())) {
        if (e.repoRoot !== root) continue;
        // A LIVE lane is protected by its identity, not by its mtime: an entry
        // that records a lane names a dir with the lane suffix, and that is the
        // dir this judge is writing into right now. Both shapes are added — an
        // entry written by an older build has no lane at all, and its dir is
        // the un-suffixed one.
        known.add(judgeWorkDirBasename(e.role, shortRepoHash(e.repoRoot), e.openerId, laneOfEntry(e)));
        known.add(judgeWorkDirBasename(e.role, shortRepoHash(e.repoRoot), e.openerId));
        known.add(legacyJudgeWorkDirBasename(e.role, shortRepoHash(e.repoRoot)));
      }
      const names = readdirSync(base, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      const entries = names.map((name) => {
        let mtimeMs = Number.NaN;
        try { mtimeMs = statSync(pathJoin(base, name)).mtimeMs; } catch { /* age unknown */ }
        return { name, mtimeMs };
      });
      for (const stale of selectStaleJudgeSessionDirs(entries, known, Date.now())) {
        try { rmSync(pathJoin(base, stale), { recursive: true, force: true }); } catch { /* best effort */ }
      }
    } catch { /* sweep never breaks the caller */ }
  }

  return { resolveJudgeLaunch, sweepStaleJudgeSessionDirs };
}
