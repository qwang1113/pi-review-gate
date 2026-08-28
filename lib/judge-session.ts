/**
 * The judge SESSION as the managed entity — the tmux pane is only its screen.
 *
 * WHY THIS MODULE EXISTS (user ask, 2026-08-28). The gate used to manage judge
 * children through their tmux pane: `#{pane_dead}` was liveness, `capture-pane`
 * was the transcript, `kill-pane` was termination. That put the session's state
 * in its display shell, and it cost the user their own terminal: keeping a dead
 * pane readable requires `remain-on-exit`, which is a WINDOW option — so the
 * MAIN session's pane stopped closing on exit too ("Pane is dead (status 0)").
 *
 * The entity is the pi session. It records what it did on disk, under its own
 * work directory:
 *
 *   pid          the launcher's pid, written at startup (process-group leader)
 *   exit-code    pi's exit status, written after pi returns — its EXISTENCE is
 *                the authoritative "this session finished" fact
 *   stderr.log   pi's stderr, teed while it runs (crash diagnosis after the
 *                pane is gone)
 *   sessions/    pi's own transcript jsonl — where the verdict actually lives
 *
 * Every function here is pure over an injected filesystem view where it can be,
 * and fail-soft everywhere else: a judge that crashed before writing anything
 * must still produce a readable answer, never an exception.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Files a judge session writes about itself (all under its workDir). */
export interface JudgeSessionPaths {
  /** `--session-dir` recorded AT SPAWN TIME (never re-derived from a title). */
  sessionDir: string;
  pidPath: string;
  exitCodePath: string;
  stderrPath: string;
}

export type JudgeLifecycle =
  /** `exit-code` exists — the session finished and said how. */
  | "finished"
  /** No `exit-code`, but the recorded pid is gone — it died without recording. */
  | "vanished"
  /** The recorded pid is alive. */
  | "running"
  /** Nothing on disk yet (spawned microseconds ago, or the launcher failed). */
  | "unknown";

export interface JudgeSessionState {
  lifecycle: JudgeLifecycle;
  /** Parsed `exit-code`, when the session recorded one. */
  exitCode?: number;
  /** Parsed `pid`, when the launcher recorded one. */
  pid?: number;
}

/** `kill -0`: does this pid exist (regardless of ownership signalability)? */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process EXISTS but belongs to someone else — alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readTrimmed(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8").trim();
    return raw === "" ? undefined : raw;
  } catch {
    return undefined;
  }
}

/**
 * What is this judge session doing — decided from ITS OWN artifacts.
 *
 * ORDER MATTERS. `exit-code` is checked FIRST and wins outright: it is written
 * after pi returns, so its presence is a completed session even if the pid was
 * recycled by the OS in the meantime (a live pid that is no longer OUR process
 * would otherwise report "running" forever).
 */
export function readJudgeSessionState(
  paths: Pick<JudgeSessionPaths, "pidPath" | "exitCodePath">,
  pidAlive: (pid: number) => boolean = defaultPidAlive,
): JudgeSessionState {
  const rawExit = readTrimmed(paths.exitCodePath);
  const rawPid = readTrimmed(paths.pidPath);
  const pid = rawPid !== undefined && /^\d+$/.test(rawPid) ? Number(rawPid) : undefined;

  if (rawExit !== undefined) {
    const parsed = /^-?\d+$/.test(rawExit) ? Number(rawExit) : undefined;
    return { lifecycle: "finished", ...(parsed !== undefined ? { exitCode: parsed } : {}), ...(pid !== undefined ? { pid } : {}) };
  }
  if (pid === undefined) return { lifecycle: "unknown" };
  return { lifecycle: pidAlive(pid) ? "running" : "vanished", pid };
}

/**
 * The transcript file to read: the NEWEST jsonl directly inside `sessionDir`.
 *
 * NON-RECURSIVE ON PURPOSE. `sessions/` also holds `subagent-artifacts/` with
 * the transcripts of the judge's OWN subagents; a recursive search can return
 * one of those instead of the judge's transcript (the nested directory exists
 * in this repo — verified 2026-08-28).
 */
export function newestTranscript(sessionDir: string): string | undefined {
  let best: { path: string; mtimeMs: number } | undefined;
  try {
    for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(sessionDir, entry.name);
      try {
        const { mtimeMs } = statSync(path);
        if (!best || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
      } catch { /* raced away between readdir and stat */ }
    }
  } catch {
    return undefined; // no directory yet — the judge never got that far
  }
  return best?.path;
}

/** A fenced ```json block carrying a gate verdict. */
const VERDICT_FENCE = /```json\s*[\s\S]*?"gate"\s*:\s*"(?:READY|BLOCKED|NEEDS_HUMAN)"[\s\S]*?```/;

/**
 * Every assistant text of a transcript, oldest first. Fail-soft per line: a
 * half-written final line (the judge is still running) is skipped, never fatal.
 */
export function assistantTexts(transcriptPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const message = (parsed as { message?: { role?: unknown; content?: unknown } })?.message;
      if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const chunk of message.content as Array<{ type?: unknown; text?: unknown }>) {
        if (chunk?.type === "text" && typeof chunk.text === "string" && chunk.text.trim() !== "") {
          out.push(chunk.text);
        }
      }
    } catch { /* half-written or not a message line */ }
  }
  return out;
}

export interface JudgeConclusion {
  /** The text to hand back, or undefined when the transcript yielded nothing. */
  text?: string;
  /** True when the text was selected because it carries a verdict fence. */
  hasVerdict: boolean;
  /** The transcript the text came from. */
  transcriptPath?: string;
}

/**
 * The judge's conclusion, read from its transcript.
 *
 * SELECTION RULE (measured, not assumed): take the last assistant text that
 * CARRIES A VERDICT FENCE, not simply the last one. A judge routinely signs off
 * after its verdict ("verdict 已输出，完成信号已发出"), so "last message" reliably
 * returns the sign-off and drops the very thing the caller needs. With no fence
 * anywhere, fall back to the last non-empty text so a crashed or still-running
 * judge remains diagnosable.
 */
export function readJudgeConclusion(sessionDir: string): JudgeConclusion {
  const transcriptPath = newestTranscript(sessionDir);
  if (!transcriptPath) return { hasVerdict: false };
  const texts = assistantTexts(transcriptPath);
  if (texts.length === 0) return { hasVerdict: false, transcriptPath };
  for (let i = texts.length - 1; i >= 0; i--) {
    if (VERDICT_FENCE.test(texts[i]!)) return { text: texts[i]!, hasVerdict: true, transcriptPath };
  }
  return { text: texts[texts.length - 1]!, hasVerdict: false, transcriptPath };
}

/** Tail of the judge's stderr log — crash context once the pane is gone. */
export function readStderrTail(stderrPath: string, maxLines = 20): string | undefined {
  const raw = readTrimmed(stderrPath);
  if (raw === undefined) return undefined;
  const lines = raw.split("\n");
  return lines.length <= maxLines ? raw : lines.slice(-maxLines).join("\n");
}

/**
 * Terminate a judge session by its recorded pid.
 *
 * THE PROCESS GROUP, NOT THE PID. The launcher is the pane's process-group
 * leader and pi runs as its CHILD, so signalling the pid alone kills the
 * wrapper and leaves pi orphaned. Negative pid = the whole group.
 *
 * A FINISHED SESSION IS NEVER SIGNALLED (round-1 P1, reviewer). `exit-code`
 * means the wrapper already returned, so that pid no longer belongs to us —
 * and the OS may well have handed it to somebody else. Signalling its group
 * then kills an unrelated process tree. This is the same rule
 * `readJudgeSessionState` follows (exit-code wins over a live pid); applying
 * it in only one of the two places is what made the pair unsound.
 *
 * Best-effort by contract: an already-finished session (recorded exit code,
 * no pid file, dead pid, unsignalable group) is a SUCCESSFUL no-op — closing
 * a judge twice must not fail (idempotence is what `review_close` promises).
 */
export function terminateJudgeSession(
  paths: Pick<JudgeSessionPaths, "pidPath"> & Partial<Pick<JudgeSessionPaths, "exitCodePath">>,
  kill: (target: number, signal: NodeJS.Signals) => void = (t, s) => process.kill(t, s),
): { signalled: boolean; pid?: number } {
  // Finished ⇒ nothing of ours is left running; the pid is not ours to signal.
  if (paths.exitCodePath !== undefined && readTrimmed(paths.exitCodePath) !== undefined) {
    return { signalled: false };
  }
  const rawPid = readTrimmed(paths.pidPath);
  if (rawPid === undefined || !/^\d+$/.test(rawPid)) return { signalled: false };
  const pid = Number(rawPid);
  if (pid <= 1) return { signalled: false }; // never signal pid 0/1 (whole-session / init)
  try {
    kill(-pid, "SIGTERM");
    return { signalled: true, pid };
  } catch {
    // The group may already be gone, or be unsignalable — try the bare pid so
    // a wrapper that is NOT a group leader still gets terminated.
    try {
      kill(pid, "SIGTERM");
      return { signalled: true, pid };
    } catch {
      return { signalled: false, pid };
    }
  }
}
