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
import { execFileSync } from "node:child_process";
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
 * The pid file's content: the launcher's pid AND the moment that process
 * started, separated by one space (`12345 Fri Aug 28 16:50:21 2026`).
 *
 * WHY THE TIMESTAMP (round-1 P1, reviewer, reproduced). A pid alone is not an
 * identity. A wrapper that is killed BEFORE it can record an exit code leaves
 * a pid file behind and nothing else; once the OS hands that number to an
 * unrelated process, "the pid is alive" reads as "our judge is running" and
 * `review_close` would signal that stranger's whole process GROUP. The start
 * time is what makes the pid an identity: a recycled pid always has a
 * different one.
 */
interface PidRecord {
  pid: number;
  /** Absent for a pid file written before this format (degrade, never crash). */
  startedAt?: string;
}

function readPidRecord(pidPath: string): PidRecord | undefined {
  const raw = readTrimmed(pidPath);
  if (raw === undefined) return undefined;
  const space = raw.indexOf(" ");
  const pidPart = space === -1 ? raw : raw.slice(0, space);
  if (!/^\d+$/.test(pidPart)) return undefined;
  const startedAt = space === -1 ? undefined : raw.slice(space + 1).trim();
  return { pid: Number(pidPart), ...(startedAt ? { startedAt } : {}) };
}

/** When did this pid start? `undefined` when it does not exist any more. */
function defaultProcessStart(pid: number): string | undefined {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined; // no such process (or ps unavailable)
  }
}

/**
 * Is this pid STILL the process the launcher recorded?
 *
 * With a recorded start time this is exact. Without one (an older pid file) it
 * degrades to plain existence — the pre-existing behaviour, no worse than it
 * was, and the launcher writes the timestamp from now on.
 */
function isRecordedProcess(
  record: PidRecord,
  pidAlive: (pid: number) => boolean,
  processStart: (pid: number) => string | undefined,
): boolean {
  if (record.startedAt === undefined) return pidAlive(record.pid);
  const current = processStart(record.pid);
  return current !== undefined && current === record.startedAt;
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
  processStart: (pid: number) => string | undefined = defaultProcessStart,
): JudgeSessionState {
  const rawExit = readTrimmed(paths.exitCodePath);
  const record = readPidRecord(paths.pidPath);

  if (rawExit !== undefined) {
    const parsed = /^-?\d+$/.test(rawExit) ? Number(rawExit) : undefined;
    return {
      lifecycle: "finished",
      ...(parsed !== undefined ? { exitCode: parsed } : {}),
      ...(record ? { pid: record.pid } : {}),
    };
  }
  if (record === undefined) return { lifecycle: "unknown" };
  // "running" means OUR recorded process is still there — not merely that
  // something holds that pid number now (round-1 P1: a crashed wrapper leaves
  // a pid file, and a recycled pid would read as a live judge forever).
  return {
    lifecycle: isRecordedProcess(record, pidAlive, processStart) ? "running" : "vanished",
    pid: record.pid,
  };
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
 * THE PID MUST STILL BE OURS. Two independent ways it can stop being ours,
 * and BOTH must be checked before a group signal (round-1 P1, both reproduced
 * by reviewers):
 *
 *   - `exit-code` exists: the wrapper already returned, so the number is free
 *     for the OS to reassign;
 *   - no `exit-code`, but the recorded start time no longer matches: the
 *     wrapper was killed BEFORE it could record anything, and something else
 *     now holds that pid. This is the crash path, and it is exactly the case
 *     a naive "is the pid alive?" test gets wrong.
 *
 * Signalling in either case would SIGTERM a stranger's entire process group.
 * `readJudgeSessionState` applies the same two rules — the pair must agree.
 *
 * Best-effort by contract: an already-finished session (recorded exit code,
 * no pid file, a pid that is not ours any more, unsignalable group) is a
 * SUCCESSFUL no-op — closing a judge twice must not fail (idempotence is what
 * `review_close` promises).
 */
export function terminateJudgeSession(
  // BOTH paths are REQUIRED (round-2 P2): with an optional exitCodePath a
  // caller could silently opt out of the never-signal-a-finished-session rule,
  // which is the whole protection against signalling a recycled pid. The type
  // enforces it instead of the documentation asking for it.
  paths: Pick<JudgeSessionPaths, "pidPath" | "exitCodePath">,
  kill: (target: number, signal: NodeJS.Signals) => void = (t, s) => process.kill(t, s),
  pidAlive: (pid: number) => boolean = defaultPidAlive,
  processStart: (pid: number) => string | undefined = defaultProcessStart,
): { signalled: boolean; pid?: number } {
  // Finished ⇒ nothing of ours is left running; the pid is not ours to signal.
  if (readTrimmed(paths.exitCodePath) !== undefined) {
    return { signalled: false };
  }
  const record = readPidRecord(paths.pidPath);
  if (record === undefined) return { signalled: false };
  if (record.pid <= 1) return { signalled: false }; // never signal pid 0/1 (own group / init)
  // The crash path: a pid file with no exit code, whose process is gone or has
  // been recycled. Nothing of ours is running, so there is nothing to signal.
  if (!isRecordedProcess(record, pidAlive, processStart)) return { signalled: false, pid: record.pid };
  const pid = record.pid;
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
