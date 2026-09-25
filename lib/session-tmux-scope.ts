/**
 * MY OWN TMUX SESSION — the name, the lazy creation, the ownership, the death.
 *
 * ── WHAT THIS IS (2026-09-25, user decision) ──
 *
 * Every session the gate runs in used to open its children by splitting its own
 * window, so a judge, a worker or a project manager's child landed as a pane
 * next to whatever the human was doing. Now the opener keeps its pane and the
 * children live as WINDOWS of one session that belongs to it alone:
 *
 *     rg-pi-review-gate-a270ed              ← created on the FIRST child, never before
 *     ├─ @0  reviewer@self    (a judge window)
 *     ├─ @1  probe@self       (a worker window)
 *     └─ @2  t3@pm            (a child session's window)
 *
 * The opener's own window is not touched at all: no split, no resize, no new
 * pane — nothing the gate does may move the user's screen.
 *
 * ── THE THREE THINGS THIS MODULE OWNS ──
 *
 * 1. THE NAME. `rg-<repo slug>-<id fragment>`, derived from the session's own
 *    identity and nothing a caller passes in. The fragment is the TAIL of the
 *    session id, not its head, and that is not cosmetic: pi's ids are UUIDv7,
 *    whose leading bits are a MILLISECOND TIMESTAMP — every session started
 *    within the same ~65 seconds shares its first eight characters (measured
 *    from the ids on this machine), so a head-based name would collide exactly
 *    among the sessions most likely to run at once. The tail is the random
 *    part.
 * 2. THE LAZY CREATION. Nothing is created until a child is actually needed
 *    (`openScopeWindow`), and the child's own command is the session's first
 *    window, so there is never a stray shell window to clean up. A round with
 *    no children creates no session at all.
 * 3. THE DEATH, `closeOwnSession`: the one session this process created, by
 *    name READ FROM ITS OWN SIDECAR. There is no parameter to pass one in.
 *
 * ── WHY "MINE" IS A FACT AND NOT A GUESS ──
 *
 * The name looks like the gate's, which is not the same as being the gate's:
 * a leftover from a run that died between creating the session and recording
 * it, or two sessions whose id tails collide, both wear a name this module
 * would derive. So the session carries a marker (`@rg_scope_owner`, a tmux
 * session user option) written once at creation, and every reuse AND the kill
 * compare it with the owner recorded in the sidecar. A mismatch is refused —
 * never inherited, never killed — and the refusal names both owners so a human
 * can settle it.
 *
 * Failure direction throughout: an unreadable tmux (`list-sessions` failed) is
 * "I do not know", and nothing is created or killed on an unknown.
 *
 * Pure-ish: tmux enters through {@link ScopeRunner} and the sidecar through
 * {@link TmuxScope}, so every branch runs with fakes.
 */

import {
  buildKillSessionArgv,
  buildListSessionsArgv,
  buildNewSessionArgv,
  buildNewWindowArgv,
  buildReadSessionOwnerArgv,
  buildSetSessionOwnerArgv,
  isOwnSessionName,
  parseSessionNames,
  parseSpawnedWindow,
  SESSION_OWNER_OPTION,
  type SessionWindowCoords,
} from "./orchestrator-tmux.ts";

/** One tmux invocation through the injected runner. */
export interface ScopeRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run one tmux argv; never a shell string. */
export type ScopeRunner = (argv: readonly string[]) => ScopeRunResult;

/**
 * What the sidecar remembers about the session this process created.
 *
 * All three fields are needed to kill safely later: `name` is the target,
 * `owner` is what the marker must say, and `createdAt` is for the human reading
 * the sidecar.
 */
export interface TmuxScopeRecord {
  name: string;
  owner: string;
  createdAt: string;
}

/**
 * Everything this module needs from the running session — the identity it
 * derives a name from, and the sidecar it records into.
 *
 * The extension builds one of these from its own state; nothing here reads
 * `process.env` or a file, which is what lets the whole flow run against a
 * throwaway tmux server in a test.
 */
export interface TmuxScope {
  /** This session's own pi session id — absent ⇒ no name can be derived. */
  sessionId(): string | undefined;
  /** The directory the name's repo slug comes from (the session's own repo). */
  repoRoot(): string;
  /** The record persisted for THIS session, parsed fail-closed. */
  read(): TmuxScopeRecord | undefined;
  /** Persist it — called only when the session was really created. */
  write(record: TmuxScopeRecord): void;
  /** One timestamp, so the record's shape is testable. */
  now(): string;
}

/**
 * `rg-<repo slug>-<session id tail>`, or undefined when the id carries too
 * little entropy to name anything after.
 *
 * The slug is the repo directory's basename, lowercased and stripped to
 * `[a-z0-9-]`: tmux session names may not contain `:` or `.` (the two
 * characters tmux itself uses to address windows and panes — a name carrying
 * one would make every later target ambiguous), and the rest of the class is
 * what {@link isOwnSessionName} validates before any argv is built.
 */
export function deriveSessionName(dir: string, sessionId: string): string | undefined {
  const slug = String(dir ?? "")
    .replace(/\/+$/, "")
    .split("/")
    .pop() ?? "";
  const clean = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const frag = String(sessionId ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(-10);
  // Ten characters of the id's random end: enough that two sessions in one
  // repo cannot land on the same name, short enough to read in `tmux ls`.
  if (frag.length < 6) return undefined;
  return `rg-${clean || "repo"}-${frag}`;
}

/** The record as it must be before it is trusted: fail-closed on any doubt. */
export function sanitizeScopeRecord(raw: unknown): TmuxScopeRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name : "";
  const owner = typeof value.owner === "string" ? value.owner.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt.trim() : "";
  if (!isOwnSessionName(name) || owner.length === 0 || createdAt.length === 0) return undefined;
  return { name, owner, createdAt };
}

/** Every session on the server, or undefined when tmux could not be read. */
function listSessions(run: ScopeRunner): string[] | undefined {
  try {
    const result = run(buildListSessionsArgv());
    if (!result.ok) return undefined;
    return parseSessionNames(result.stdout);
  } catch {
    return undefined;
  }
}

/**
 * What the marker on a session says. An unset option prints nothing and exits
 * 0, so an empty reading is a real answer ("nobody claimed it") while a failed
 * call is not.
 */
function readOwner(run: ScopeRunner, session: string): { ok: true; owner: string } | { ok: false; error: string } {
  try {
    const result = run(buildReadSessionOwnerArgv(session));
    if (!result.ok) return { ok: false, error: result.stderr || `tmux show-options ${SESSION_OWNER_OPTION} 失败` };
    return { ok: true, owner: result.stdout.trim() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Which session a call is about, and who owns it. */
type ResolvedScope =
  | { ok: true; name: string; owner: string }
  | { ok: false; error: string };

/**
 * Resolve the session this process owns: the recorded one when there is a
 * record, otherwise one derived from this session's own identity.
 *
 * A record wins over derivation because it is the only place a name that was
 * already created can be found again — and because a session whose id changed
 * under it (a resume, a relay) must not start a second session beside the first.
 */
function resolveScope(scope: TmuxScope): ResolvedScope {
  const recorded = sanitizeScopeRecord(scope.read());
  if (recorded) return { ok: true, name: recorded.name, owner: recorded.owner };
  const sessionId = scope.sessionId()?.trim();
  if (!sessionId) {
    return { ok: false, error: "本会话没有 session id（pi 没给出），无法派生专属 tmux session 名" };
  }
  const name = deriveSessionName(scope.repoRoot(), sessionId);
  if (!name) {
    return { ok: false, error: `无法从 session id 派生专属 tmux session 名：${sessionId}` };
  }
  return { ok: true, name, owner: sessionId };
}

/** What a child window needs from its opener. */
export interface OpenScopeWindowOptions {
  /** Working directory for the new window (the child's repo or worktree). */
  cwd: string;
  env?: Readonly<Record<string, string>>;
  command?: readonly string[];
  /** Window name — the gate's label, so `tmux ls` says who is who. */
  windowName?: string;
}

export type OpenScopeWindowResult =
  | ({ ok: true; sessionName: string; created: boolean } & SessionWindowCoords)
  | { ok: false; error: string };

/**
 * Open ONE window for a child: the first one creates the session, every later
 * one joins it.
 *
 * The session is created with the child's own command rather than empty and
 * filled afterwards, so the lazy creation costs exactly what the eager one did
 * and leaves nothing behind.
 */
export function openScopeWindow(
  run: ScopeRunner,
  scope: TmuxScope,
  opts: OpenScopeWindowOptions,
): OpenScopeWindowResult {
  const resolved = resolveScope(scope);
  if (!resolved.ok) return resolved;
  const { name, owner } = resolved;
  const sessions = listSessions(run);
  if (sessions === undefined) {
    return { ok: false, error: "读不到 tmux server（list-sessions 失败）——不在此刻建 session" };
  }
  const exists = sessions.includes(name);
  if (exists) {
    const marker = readOwner(run, name);
    if (!marker.ok) {
      return { ok: false, error: `${name} 已存在，但读不到它的归属标记：${marker.error}` };
    }
    if (marker.owner !== owner) {
      return {
        ok: false,
        error:
          `${name} 已存在，但归属标记是 ${marker.owner || "(空)"}，不是本会话（${owner}）建的 —— ` +
          "拒绝复用、拒绝改它；确认它的归属后人工处理（`tmux kill-session -t " + name + "`）",
      };
    }
  }
  const spec = {
    ownSession: name,
    cwd: opts.cwd,
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.command === undefined ? {} : { command: opts.command }),
    ...(opts.windowName === undefined ? {} : { windowName: opts.windowName }),
  };
  const argv = exists ? buildNewWindowArgv(spec) : buildNewSessionArgv(spec);
  let result: ScopeRunResult;
  try {
    result = run(argv);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (!result.ok) {
    return { ok: false, error: result.stderr || `tmux ${exists ? "new-window" : "new-session"} 失败` };
  }
  const coords = parseSpawnedWindow(result.stdout);
  if (!coords) {
    return { ok: false, error: "tmux 没有返回新 window/pane id" };
  }
  if (!exists) {
    // The marker is what makes the NEXT reuse of this name safe, so it is
    // written the moment the session is ours. Both writes are best effort: by
    // now the child is already running, and a cosmetic-record failure must not
    // turn a working spawn into an error. A marker that did not land costs a
    // REUSE, not correctness — `openScopeWindow` refuses a name it cannot
    // prove it owns, and nothing is ever killed on a name it did not write.
    try { run(buildSetSessionOwnerArgv(name, owner)); } catch { /* see above */ }
    try { scope.write({ name, owner, createdAt: scope.now() }); } catch { /* see above */ }
  }
  return { ok: true, sessionName: name, created: !exists, ...coords };
}

export type CloseOwnSessionResult =
  | { ok: true; killed: boolean; note: string }
  | { ok: false; error: string };

/**
 * Close the ONE session this process created, with every window still in it.
 *
 * Idempotent and silent when there is nothing to do: never having opened a
 * child means never having created a session, and a session whose last window
 * was closed has already been reclaimed by tmux itself (`kill-window` on the
 * last one destroys the session — measured). Both are normal ends, not errors.
 *
 * The name comes from the SIDECAR
 * ({@link TmuxScope.read}), never from a parameter, and the session is only
 * killed after its marker matched the recorded owner — so a collision or a
 * stranger's session wearing our name is left completely alone.
 */
export function closeOwnSession(run: ScopeRunner, scope: TmuxScope): CloseOwnSessionResult {
  const record = sanitizeScopeRecord(scope.read());
  if (!record) {
    return { ok: true, killed: false, note: "本会话没有专属 tmux session（从未派过子会话）" };
  }
  const sessions = listSessions(run);
  if (sessions === undefined) {
    return { ok: false, error: `读不到 tmux server，未能确认专属 session ${record.name} 是否还在` };
  }
  if (!sessions.includes(record.name)) {
    return { ok: true, killed: false, note: `专属 session ${record.name} 已不在（tmux 在它的最后一个 window 关掉时自己回收了）` };
  }
  const marker = readOwner(run, record.name);
  if (!marker.ok) {
    return { ok: false, error: `读不到 ${record.name} 的归属标记：${marker.error}` };
  }
  if (marker.owner !== record.owner) {
    return {
      ok: false,
      error: `${record.name} 的归属标记是 ${marker.owner || "(空)"}，不是本会话（${record.owner}）的 —— 拒绝 kill`,
    };
  }
  try {
    const result = run(buildKillSessionArgv(record.name));
    if (!result.ok) return { ok: false, error: result.stderr || "tmux kill-session 失败" };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  return { ok: true, killed: true, note: `已关掉专属 session ${record.name}` };
}
