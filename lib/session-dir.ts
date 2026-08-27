/**
 * The pi-subagents session-dir convention: `~/.pi/agent/sessions/--<encoded>--`
 * where the encoding is pi's own. The fresh-context review roles (reviewer,
 * adviser, goal-auditor) get this directory in their task text and read the
 * main session's transcript from it ON DEMAND — so the encoding must match
 * pi's session manager byte for byte, or the pointer lands in a directory
 * that does not exist and the transcript is never found.
 *
 * Round-5 P1 (correcting round-4): pi's session-manager resolves the cwd
 * with `resolvePath` = path normalization/absolutization (`path.resolve`),
 * NOT filesystem symlink dereferencing. A session launched through a
 * symlinked path is therefore stored under the LOGICAL path's encoding, and
 * a realpathSync here would point the transcript lookup at a directory that
 * does not exist.
 */
import { join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Pi's normalizePath semantics, reduced to what the session-dir encoding
 * needs (round-10 P1): expand `~`/`~/` on EVERY platform, and on Windows
 * normalize Git-Bash/Cygwin/WSL shell paths (`/mnt/c/x`, `/cygdrive/c/x`)
 * to drive paths before resolution. Without this, a custom session dir or
 * cwd spelled with `~` or a shell path encodes to a directory that does
 * not exist.
 */
function normalizeSessionPath(input: string, home: string): string {
  const p = input.trim();
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (p.startsWith("~\\")) return join(home, p.slice(2)); // Windows spelling (round-11 P1)
  if (process.platform === "win32") {
    const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) return `${m[1]!.toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  return p;
}

export function sessionDirForCwd(
  dir: string,
  home: string = homedir(),
  sessionDirOverride?: string,
): string {
  // pi's session-manager calls resolvePath(cwd) UNCONDITIONALLY — normalize
  // (~ + Windows shell paths) then absolutize, symlinks kept (round-7 P1).
  const resolved = resolve(normalizeSessionPath(dir, home));
  // Round-10 P1: the AUTHORITATIVE source is the live session manager's
  // getSessionDir() (covers --session-dir CLI, env and settings.json); the
  // env fallback below is only for contexts where the manager is absent.
  if (sessionDirOverride) return resolve(normalizeSessionPath(sessionDirOverride, home));
  // pi's main.js picks the session dir from (1) --session-dir CLI, (2)
  // PI_CODING_AGENT_SESSION_DIR / TAU_CODING_AGENT_SESSION_DIR env, (3)
  // settings.json getSessionDir(), (4) join(agentDir, "sessions", enc). The
  // env override IS the final session dir (session-manager lists .jsonl
  // directly inside it — no encoded subdir), so it is used verbatim after
  // normalization (round-9/10 P1: pi expands ~ and shell paths first).
  const envSessionDir =
    process.env.PI_CODING_AGENT_SESSION_DIR ??
    process.env.TAU_CODING_AGENT_SESSION_DIR;
  if (envSessionDir) return resolve(normalizeSessionPath(envSessionDir, home));
  const agentDir =
    normalizeSessionPath(process.env.PI_CODING_AGENT_DIR ?? "", home) ||
    normalizeSessionPath(process.env.TAU_CODING_AGENT_DIR ?? "", home) ||
    join(home, ".pi", "agent");
  const enc = "--" + resolved.replace(/^[/\\\\]/, "").replace(/[/\\\\:]/g, "-") + "--";
  return join(agentDir, "sessions", enc);
}
