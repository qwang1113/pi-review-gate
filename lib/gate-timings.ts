/**
 * Gate observability log — `.pi/gate-timings.jsonl`.
 *
 * WHY. "precommit takes 4-5 minutes" is impossible to act on without knowing
 * WHICH step took them, whether the cache helped, and whether a lane ran full
 * or related tests. The receipt already measures every step, but it is a
 * per-run temp artifact: it disappears, so nothing can be compared across
 * rounds or across days. This appends one bounded JSON line per gate event so
 * the history survives and can be read with `grep`/`jq`.
 *
 * STRICTLY DIAGNOSTIC. Nothing here is read by any enforcement path. A failed
 * write, a corrupt line, an unwritable `.pi/` — all are swallowed: losing a
 * timing record must never cost a verdict. The file lives under `.pi/`, which
 * `GATE_EXCLUDE_PATHSPECS` keeps out of the worktree fingerprint, so writing
 * it cannot invalidate the binding of the very run it describes.
 *
 * REVIEW DURATIONS ARE APPROXIMATE, BY CONSTRUCTION. The reviewer is a
 * subagent the agent spawns; the extension only sees the `record_review` call
 * that follows. What is recorded is therefore the wall clock between the
 * previous gate event and that call — an upper bound that includes the
 * agent's own thinking. It is labelled `approximate: true` so a reader never
 * mistakes it for the reviewer's own runtime.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import type { StepTiming } from "./precommit-receipt.ts";

/** Repo-root-relative path of the log. Under `.pi/` — gate-owned. */
export const TIMINGS_RELPATH = ".pi/gate-timings.jsonl";

/**
 * How many records to keep. Enough to see a trend across a few weeks of loops,
 * small enough that the file stays greppable and the rewrite stays cheap.
 */
export const TIMINGS_MAX_RECORDS = 500;

/** Rewrite the file only once it has drifted meaningfully past the cap. */
const TIMINGS_TRIM_SLACK = 100;

export interface PrecommitTiming {
  kind: "precommit";
  at: string;
  repo: string;
  mode: string;
  testScope: string;
  verdict: string;
  /** Wall clock the runner measured for the whole run. */
  totalMs: number;
  steps: StepTiming[];
  /** First 12 chars of the worktree fingerprint this run was bound to. */
  fingerprint: string;
}

export interface ReviewTiming {
  kind: "review";
  at: string;
  repo: string;
  round: number;
  verdict: string;
  /** `full` or `incremental` — see lib/review-scope.ts. */
  scope: string;
  /** Files/lines in the increment this round had to judge. */
  changedFiles: number;
  changedLines: number;
  /** Wall clock since the previous gate event. ALWAYS an upper bound. */
  approxMs: number;
  approximate: true;
  fingerprint: string;
}


export type GateTiming = PrecommitTiming | ReviewTiming;
function timingsPath(repoRoot: string): string {
  return join(repoRoot, TIMINGS_RELPATH);
}

/**
 * Append one record, then trim the file back to the cap when it has grown past
 * it. Best effort throughout: any failure leaves the log as-is.
 */
export function appendTiming(repoRoot: string, record: GateTiming): void {
  const path = timingsPath(repoRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    return; // diagnostics only
  }
  try {
    trim(path);
  } catch {
    /* an untrimmed log is still a usable log */
  }
}

/**
 * Keep the last TIMINGS_MAX_RECORDS lines.
 *
 * Only rewrites once the file exceeds cap + slack, so the common append path
 * does not pay a full read+write every time.
 */
function trim(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  if (lines.length <= TIMINGS_MAX_RECORDS + TIMINGS_TRIM_SLACK) return;
  const kept = lines.slice(-TIMINGS_MAX_RECORDS);
  writeFileAtomic(path, `${kept.join("\n")}\n`);
}

/**
 * Read back the most recent records, newest last. Unparseable lines are
 * skipped rather than failing the read: this file is appended to by a running
 * process and a torn last line is normal.
 */
export function readTimings(repoRoot: string, limit = TIMINGS_MAX_RECORDS): GateTiming[] {
  let raw: string;
  try {
    raw = readFileSync(timingsPath(repoRoot), "utf8");
  } catch {
    return [];
  }
  const out: GateTiming[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && (parsed.kind === "precommit" || parsed.kind === "review")) out.push(parsed as GateTiming);
    } catch {
      /* torn or hand-edited line */
    }
  }
  return out.slice(-limit);
}

/** The most recent precommit record, or undefined. */
export function lastPrecommitTiming(repoRoot: string): PrecommitTiming | undefined {
  const all = readTimings(repoRoot);
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].kind === "precommit") return all[i] as PrecommitTiming;
  }
  return undefined;
}

/**
 * One-line-per-entry summary of the last precommit run: total wall clock and
 * the slowest steps. Steps that were cached are marked, because "0ms" is
 * otherwise indistinguishable from "did not run".
 */
export function formatPrecommitSummary(t: PrecommitTiming | undefined, slowest = 3): string[] {
  if (!t) return ["timings:   (no precommit recorded yet)"];
  const ran = t.steps.filter((s) => s.status !== "skip");
  const top = ran.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, slowest);
  const lines = [
    `timings:   last precommit ${t.mode}/${t.testScope} ${t.totalMs}ms (${t.verdict}, ${t.at})`,
  ];
  if (top.length) {
    lines.push(
      `  slowest: ${top.map((s) => `${s.name} ${s.durationMs}ms${s.cached ? " (cached)" : ""}`).join(", ")}`,
    );
  }
  const cached = ran.filter((s) => s.cached).length;
  if (cached) lines.push(`  cache:   ${cached}/${ran.length} step(s) reused a previous PASS`);
  return lines;
}
