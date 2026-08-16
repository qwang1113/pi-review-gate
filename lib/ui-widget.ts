/**
 * pi-review-gate — TUI widget content builders (pure functions).
 *
 * The extension renders one widget via `ctx.ui.setWidget`:
 *   - belowEditor: the running/known sub-agents, scanned from the
 *     `.pi-subagents/artifacts/` directory (pi-subagents writes one
 *     `<runId>_<agent>[_<n>]_<kind>.<ext>` file set per child run).
 *
 *
 * Everything here is a pure function of plain strings / filesystem scans so it
 * can be unit-tested without a TUI. The extension owns the side effects
 * (reading goal files, calling setWidget) and the try/catch fallbacks.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";

export type AgentArtifactState = "running" | "done";

export interface AgentArtifactInfo {
  /** Agent role name, e.g. "reviewer", "adviser", "worker". */
  name: string;
  /** First non-empty line of the run's task (from meta or input file). */
  task: string;
  state: AgentArtifactState;
  /** Seconds since the run's newest artifact was touched. */
  ageSec: number;
}

/** Suffix → artifact kind, applied to the basename before parsing. */
const ARTIFACT_KINDS = ["_meta.json", "_output.md", "_input.md", "_transcript.jsonl"] as const;

export interface ScanAgentArtifactsOptions {
  /**
   * Drop runs whose NEWEST artifact is older than this many seconds and that
   * are already done — the widget wants "running agents", not the whole
   * artifact history (which accumulates across sessions). Running runs are
   * always kept. Undefined = keep everything.
   */
  maxAgeSec?: number;
}

/**
 * Scan the pi-subagents artifacts directory for child runs.
 *
 * File naming observed in the wild: `<runId>_<agent>_<kind>` (e.g.
 * `011bc09c_reviewer_meta.json`) and `<runId>_<agent>_<n>_<kind>` (with a
 * trailing shard index, e.g. `011bc09c_reviewer_0_meta.json`). The agent name
 * is the last underscore-delimited token (or the one before a trailing
 * all-digit shard index) before the kind suffix; the rest is the run id.
 *
 * A run is `done` when its `_meta.json` exists (pi-subagents writes it with
 * `exitCode` on completion); otherwise, if it has an input or transcript
 * artifact, it is `running`. Runs with neither are ignored.
 *
 * `now` is injected so tests are deterministic. Never throws: unreadable or
 * malformed artifacts are skipped, an unreadable directory yields [].
 */
export function scanAgentArtifacts(
  dir: string,
  now: number,
  opts: ScanAgentArtifactsOptions = {},
): AgentArtifactInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  interface PartialRun {
    id: string;
    name: string;
    state: AgentArtifactState;
    task: string;
    mtimeMs: number;
  }
  const runs = new Map<string, PartialRun>();

  for (const file of entries) {
    if (!file.includes("_")) continue;
    const kind = ARTIFACT_KINDS.find((k) => file.endsWith(k));
    if (!kind) continue;
    const base = file.slice(0, -kind.length); // e.g. "011bc09c_reviewer" or "011bc09c_reviewer_0"
    let lastUnderscore = base.lastIndexOf("_");
    if (lastUnderscore <= 0) continue;
    let id = base.slice(0, lastUnderscore);
    let name = base.slice(lastUnderscore + 1);
    // Real-world naming is `<runId>_<agent>_<n>_<kind>` (a shard index after
    // the agent name, e.g. `011bc09c_reviewer_0_meta.json`). A trailing
    // all-digit segment is that index, NOT the agent name — step back one more
    // segment when present.
    if (/^\d+$/.test(name) && lastUnderscore > 0) {
      const prev = base.lastIndexOf("_", lastUnderscore - 1);
      if (prev > 0) {
        name = base.slice(prev + 1, lastUnderscore);
        id = base.slice(0, prev);
      }
    }
    if (!id || !name) continue;
    const path = `${dir}/${file}`;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }

    let run = runs.get(id);
    if (!run) {
      run = { id, name, state: "running", task: "", mtimeMs };
      runs.set(id, run);
    } else {
      if (mtimeMs > run.mtimeMs) run.mtimeMs = mtimeMs;
    }

    if (kind === "_meta.json") {
      run.state = "done";
      try {
        const meta = JSON.parse(readFileSync(path, "utf8")) as { task?: unknown; exitCode?: unknown };
        if (typeof meta.task === "string" && meta.task.trim()) {
          run.task = firstLine(meta.task);
        }
        if (meta.exitCode !== undefined) run.state = "done";
      } catch {
        // malformed meta — the run is still "done" by presence, task unknown
      }
    } else if (!run.task && kind === "_input.md") {
      try {
        const text = readFileSync(path, "utf8");
        run.task = firstLine(text);
      } catch { /* keep empty */ }
    }
  }

  const out: AgentArtifactInfo[] = [];
  for (const run of runs.values()) {
    if (run.state === "running" && !run.task && run.mtimeMs === 0) continue;
    const ageSec = Math.max(0, Math.floor((now - run.mtimeMs) / 1000));
    // History filter: only prune COMPLETED runs older than the window — a
    // running run is always current, and an unreadable mtime (0) means we
    // cannot judge age, so keep it.
    if (
      opts.maxAgeSec !== undefined &&
      run.state === "done" &&
      run.mtimeMs > 0 &&
      ageSec > opts.maxAgeSec
    ) continue;
    out.push({
      name: run.name,
      task: run.task,
      state: run.state,
      ageSec,
    });
  }
  // Running first, then newest-mtime first (lowest age), stable by name.
  out.sort((a, b) => {
    if (a.state !== b.state) return a.state === "running" ? -1 : 1;
    if (a.ageSec !== b.ageSec) return a.ageSec - b.ageSec;
    return a.name.localeCompare(b.name);
  });
  return out;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return (line ?? "").slice(0, 120);
}

export interface AgentsWidgetOptions {
  /** Max lines rendered (default 8). */
  limit?: number;
}

/**
 * Build the belowEditor widget lines from scanned agent artifacts:
 * `▶ name | task | 12s` for running, `✓ name | task` for done.
 */
export function buildAgentsWidget(
  agents: AgentArtifactInfo[],
  opts: AgentsWidgetOptions = {},
): string[] {
  const limit = opts.limit ?? 8;
  if (agents.length === 0) return ["[no sub-agents this session]"];
  const lines = agents.slice(0, limit).map((a) => {
    const icon = a.state === "running" ? "▶" : "✓";
    const time = a.state === "running" ? ` | ${a.ageSec}s` : "";
    const task = a.task ? ` | ${a.task}` : "";
    return `${icon} ${a.name}${task}${time}`;
  });
  if (agents.length > limit) lines.push(`… and ${agents.length - limit} more`);
  return lines;
}
