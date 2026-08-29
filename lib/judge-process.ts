/**
 * Judge child PROCESS substrate — the replacement for lib/tmux-session.ts.
 *
 * A judge child (reviewer / adviser / goal-auditor) is now a NON-INTERACTIVE
 * pi process: `pi -p --session-id <id>` starts, processes the prompt, and
 * exits. Its identity is the SESSION, addressed by a deterministic
 * `--session-id`, and its record is the `.jsonl` transcript pi writes under
 * `--session-dir`. "Resume" is just "spawn again with the same session id" —
 * pi appends to the same session file, so the child's context carries across
 * processes, across main-session restarts, and across days (verified
 * 2026-08-28: two independent processes shared one session's memory).
 *
 * WHAT THIS REMOVES (vs tmux):
 *  - no pane lifecycle, no split-window layout, no pane ids;
 *  - no `tmux wait-for` done/inbox channels — completion is the process
 *    EXIT event (OS-guaranteed), questions ride a `question` fence + resume;
 *  - no send-keys (multi-line TUI shredding) — the task text travels as an
 *    `@file` argv reference;
 *  - no pid-recycling ambiguity for liveness — we hold the ChildProcess
 *    object itself (child.exitCode === null ⇔ alive); the pid/exit-code
 *    files stay for CROSS-SESSION takeover (a later session finds an orphan
 *    by its pid file and start time, exactly as lib/judge-session.ts reads).
 *
 * FAIL-SOFT: every function returns undefined/false instead of throwing —
 * a host that cannot spawn pi degrades to "cannot run a judge" rather than
 * crashing the extension.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Prefix of every gate-owned session id, so orphans are identifiable. */
export const JUDGE_SESSION_PREFIX = "rg-";

/** Max length of a gate-owned session id (pi accepts arbitrary ids; keep sane). */
export const MAX_SESSION_ID = 80;

/**
 * Deterministic session id for one judge role in one repo.
 *
 * THE RESUME KEY: same role + same repo ⇒ same session id ⇒ the next spawn
 * continues the same pi session. Independent of the main session's own id,
 * so a restarted main session resumes a judge's context (the property
 * pi-subagents' resume lacks — it validates the run belongs to the CURRENT
 * main session, src/runs/background/async-resume.ts:431).
 */
export function judgeSessionIdFor(role: string, repoHash: string): string {
  const safeRole = role.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 20);
  const safeHash = repoHash.replace(/[^A-Za-z0-9]/g, "").slice(0, 24);
  const raw = `${JUDGE_SESSION_PREFIX}${safeRole}-${safeHash}`;
  return raw.slice(0, MAX_SESSION_ID);
}

/** A short repo discriminator for ids: first 10 hex chars of the root hash. */
export function shortRepoHash(repoRoot: string): string {
  let hash = 0;
  for (let i = 0; i < repoRoot.length; i++) {
    hash = (hash * 31 + repoRoot.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 10);
}

export interface JudgeProcessOptions {
  /** Role name: reviewer | adviser | goal-auditor. */
  role: string;
  /** Absolute repo root (the child's cwd). */
  repoRoot: string;
  /** The deterministic session id (judgeSessionIdFor). */
  sessionId: string;
  /** Absolute path of the written system-prompt file. */
  sysPromptPath: string;
  /** Model spec, e.g. "anthropic/claude-fable-5:max". */
  model: string;
  /** Directory pi stores its transcript jsonl in (stable per role). */
  sessionDir: string;
  /** The task text, written to a file and passed as an @file reference. */
  taskText: string;
  /** The SPAWNING session's id (RG_PARENT_SESSION, directed attention). */
  parentSessionId?: string;
  /**
   * Human-readable title for --name (diagnostics / session file naming).
   * Sanitized internally.
   */
  title?: string;
  /** Extra pi argv (e.g. --no-skills). Defaults keep judge isolation. */
  extraArgs?: string[];
}

export interface JudgeProcessResult {
  ok: boolean;
  /** The spawned ChildProcess when ok. */
  child?: ReturnType<typeof spawn>;
  /** Absolute path of the written task file (the argv @reference target). */
  taskPath?: string;
  /** The session id actually used. */
  sessionId?: string;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

/**
 * Spawn ONE judge round as a non-interactive pi process.
 *
 * The task text is written to a file and passed as an `@file` reference
 * (pi's argv message syntax, verified 2026-08-28): no TUI shredding, no
 * argv length problem for multi-KB task texts, and the file doubles as the
 * round's record on disk. stdout/stderr are piped; the caller decides what
 * to do with them (typically write to per-run logs).
 *
 * The process is NOT detached: it is a child of the extension process, and
 * its exit event is the completion signal. `spawn` with default stdio pipes;
 * the caller must consume stdout/stderr (or they buffer — set `stdio` via
 * extraArgs is not possible, so the caller passes stream writers).
 */
export function spawnJudgeProcess(opts: JudgeProcessOptions): JudgeProcessResult {
  try {
    const { role, repoRoot, sessionId, sysPromptPath, model, sessionDir, taskText } = opts;
    mkdirSync(sessionDir, { recursive: true });

    // The task file lives next to the transcript dir, one per spawn
    // (timestamped): it records exactly what THIS round asked.
    const taskPath = join(sessionDir, `task-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.md`);
    writeFileSync(taskPath, taskText, "utf8");

    const args = [
      "-p", // non-interactive: process the prompt, then exit
      "--no-extensions", // never load review-gate into the judge (no recursion)
      "--no-skills",
      "--exclude-tools", "edit,write", // read-only review contract (verified)
      "--system-prompt", sysPromptPath,
      "--model", model,
      "--session-dir", sessionDir,
      "--session-id", sessionId,
      ...(opts.parentSessionId ? ["--name", `rg-${safeTitle(opts.title ?? role)}`] : []),
      ...(opts.extraArgs ?? []),
      `@${taskPath}`,
    ];

    const child = spawn("pi", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(opts.parentSessionId ? { RG_PARENT_SESSION: opts.parentSessionId } : {}),
      },
    });

    return { ok: true, child, taskPath, sessionId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function safeTitle(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "") || "judge";
}

/**
 * Write the launcher artifacts a judge round leaves behind, mirroring
 * lib/judge-session.ts's expectations: pid + exit-code files under the run
 * dir, so a LATER session can take over an orphan (kill -0 + start-time
 * identity) even though the current session holds the ChildProcess itself.
 * Returns the run dir.
 */
export function writeJudgeRunArtifacts(workDir: string, child: { pid?: number }): string | undefined {
  try {
    const runDir = join(workDir, "runs", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`);
    mkdirSync(runDir, { recursive: true });
    if (child.pid) {
      // `<pid> <start time>` — same identity format lib/judge-session.ts reads.
      writeFileSync(join(runDir, "pid"), `${child.pid} ${new Date().toString()}`, "utf8");
    }
    return runDir;
  } catch {
    return undefined;
  }
}

/**
 * Is a judge process still alive? A ChildProcess's exitCode is null until
 * the process exits — no pid recycling ambiguity, no ps call. `undefined`
 * (never spawned / already reaped) is reported as NOT alive.
 */
export function judgeProcessAlive(child: { exitCode?: number | null } | undefined): boolean {
  return child !== undefined && (child.exitCode === null || child.exitCode === undefined);
}

/** Sanitize a session-id-like string for use as a filename component. */
export function safeSessionFilePart(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
}

/** Best-effort chmod of the task file (no-op on failure). */
export function ensureTaskReadable(taskPath: string): void {
  try { chmodSync(taskPath, 0o644); } catch { /* best-effort */ }
}
