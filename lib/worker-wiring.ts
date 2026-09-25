/**
 * WORKER TOOLS (2026-09-21) — the tmux-pane replacement for the pi-subagents
 * `Agent` tool, wired for THIS session. The tools and their rules live in
 * lib/worker-tools.ts and lib/worker-side.ts; this module only decides which
 * surface registers what and hands over the session's plumbing. Moved out of
 * `extensions/review-gate.ts` (t8, 2026-09-26, wave 4 of the split).
 *
 * SURFACE MATTERS, and it is the only guard these need: the four dispatch
 * tools go on the AGENT surface and never inside a judge or worker pane (a
 * judge is read-only by contract; a worker that could dispatch workers is a
 * recursion nobody asked for), while `worker_report` goes on the WORKER
 * surface alone, so a main session can never fabricate a worker's answer.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { effectiveAgentsConfig } from "./agents-config.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import type { ChannelIO } from "./channel-io.ts";
import { tmuxServerFrom } from "./hierarchy.ts";
import { readJsonIfExists } from "./json-file.ts";
import { judgePaneAlive } from "./judge-pane.ts";
import { readJudgeSideEnv } from "./judge-side.ts";
import { loadRegistry, validateSpec } from "./model-spec.ts";
import type { TmuxRunner } from "./orchestrator-tmux.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { SessionCells } from "./session-cells.ts";
import { closeSessionWindow, openSessionWindow } from "./session-factory.ts";
import type { TmuxScope } from "./session-tmux-scope.ts";
import type { ToolHost } from "./tool-host.ts";
import {
  parseWorkerRegistry,
  serializeWorkerRegistry,
  workerSessionDirName,
  WORKER_REGISTRY_RELPATH,
  WORKER_SESSION_ROOT,
} from "./worker-pane.ts";
import { readWorkerSideEnv, registerWorkerReportTool } from "./worker-side.ts";
import { registerWorkerTools } from "./worker-tools.ts";

export function registerWorkerSurface(
  host: ToolHost,
  cells: SessionCells,
  deps: {
    runTmux: TmuxRunner;
    tmuxScope: TmuxScope;
    channelIO: ChannelIO;
    paneOwnerIdentity(): string;
    freshProjectConfig(root: string): ProjectConfig;
    log(text: string): void;
  },
): void {
  if (!readJudgeSideEnv(process.env) && !readWorkerSideEnv(process.env)) {
    const repo = () => cells.activeRepoRoot.current;
    const workerRegistryPath = () => pathJoin(repo(), WORKER_REGISTRY_RELPATH);
    registerWorkerTools(host, {
      ownPane: () => process.env.TMUX_PANE?.trim() || undefined,
      paneAlive: (paneId) => {
        try {
          return judgePaneAlive(deps.runTmux, paneId) === true;
        } catch {
          // Unreadable tmux is missing INFORMATION: a worker whose liveness
          // cannot be read is treated as gone, and `worker_submit` opens the
          // window again under the SAME session id — which is the safe
          // direction (a resumed transcript beats a message nobody reads).
          return false;
        }
      },
      openPane: async (spec) => {
        const opened = await openSessionWindow(deps.runTmux, {
          scope: deps.tmuxScope,
          cwd: spec.cwd,
          layout: "own-session-window",
          role: spec.role,
          decor: spec.decor,
          command: spec.command,
          register: spec.register,
        });
        return opened.ok ? { ok: true, paneId: opened.paneId } : { ok: false, error: opened.error };
      },
      closeWindow: (coords) => {
        try {
          // The factory's own close: `kill-window -t <session>:<@id>`, so a
          // stale id can only reach a window of this session's own tmux
          // session. The ERROR travels with the failure (2026-09-25, quality
          // round P2): `worker_close` has to tell “it is already gone” from
          // “tmux refused”, and a boolean cannot carry that.
          const closed = closeSessionWindow(deps.runTmux, coords);
          return closed.ok ? { ok: true } : { ok: false, error: closed.error };
        } catch (error) {
          return { ok: false, error: (error as Error).message };
        }
      },
      // STABLE OPENER IDENTITY, not the pane (reviewer P1, 2026-09-21):
      // `TMUX_PANE` changes on every restart, re-attach and handover, and it is
      // half of every worker channel path. The session id survives all three.
      openerId: () => cells.state.sessionId?.trim() || "gate",
      paneOwner: () => deps.paneOwnerIdentity(),
      repoRoot: repo,
      channelIO: deps.channelIO,
      channelHome: () => undefined,
      workDirFor: (workerId) => pathJoin(repo(), ".pi", WORKER_SESSION_ROOT, workerId),
      // THE OTHER HALF OF THE RESUME KEY: the session id alone finds nothing
      // if the transcript directory is not the one it was written to.
      // NOT under `.pi/judge-sessions/` (reviewer P2, 2026-09-21): that root is
      // swept by the judge lifecycle, whose staleness rule would match a worker
      // id like `abc12345` and remove its transcript directory.
      sessionDirFor: (workerId) =>
        pathJoin(repo(), ".pi", WORKER_SESSION_ROOT, workerSessionDirName(workerId), "sessions"),
      writeFile: (path, content) => {
        try {
          mkdirSync(pathDirname(path), { recursive: true });
          writeFileSync(path, content, "utf8");
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
      // No file yet, or an unreadable one: both mean "no workers", and a
      // registry that cannot be read must never be repaired into a guess.
      readRegistry: () => parseWorkerRegistry(readJsonIfExists(workerRegistryPath())),
      saveRegistry: (registry) => {
        try {
          writeFileAtomic(workerRegistryPath(), serializeWorkerRegistry(registry));
        } catch (error) {
          deps.log(`worker registry write failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      agents: () => {
        const cfg = deps.freshProjectConfig(repo());
        return effectiveAgentsConfig(cfg.agentsGlobal, cfg.agentsProject).map;
      },
      // The registry check the renderer used to do for every role — worker
      // presets never reach `applyAgentConfigLayer` (it filters them), so this
      // is where their specs get validated instead of at pane-open time.
      validateModel: (spec) => {
        const verdict = validateSpec(loadRegistry(), spec);
        return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
      },
      tmuxServer: () => tmuxServerFrom(process.env),
      now: () => Date.now(),
      log: deps.log,
    });
  }
  if (readWorkerSideEnv(process.env)) {
    registerWorkerReportTool(host, {
      env: () => process.env,
      channelIO: () => deps.channelIO,
      now: () => Date.now(),
      cwd: () => cells.cwd,
    });
  }
}
