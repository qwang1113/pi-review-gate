/**
 * THE GLOBAL SESSION REGISTRY — one file per NAME, and the name is the only
 * handle there is.
 *
 *     ~/.pi/agent/rg-sessions/t2-registry.json
 *
 * ── WHAT IT IS FOR (2026-09-25, user decision) ──
 *
 * A pi session had no name anywhere: the tmux status line showed the directory
 * (`#{b:pane_current_path}`), two windows in one repo were indistinguishable,
 * and nothing on the machine could answer "which sessions are running". The
 * name is now the session's handle on screen (window title + the window option
 * the status line reads, lib/session-name-tools.ts) and the address another
 * session writes to (`@名字`, t3) — and this module is the one place that
 * answers "who holds this name, and is that holder still alive".
 *
 * ── WHY ONE FILE PER NAME ──
 *
 * Every running session renews its own entry on a timer, so the registry is
 * written concurrently by processes that know nothing about each other. One
 * file per name makes those writes land in DIFFERENT places: there is no
 * read-modify-write of a shared document, and a torn write of one name cannot
 * cost another name its entry. It also makes the uniqueness question the
 * filesystem's: the name IS a path.
 *
 * ── UNIQUENESS IS A HARD RULE, AND IT IS NEVER ENFORCED BY WINNING ──
 *
 * A name a LIVE session holds is refused, and the refusal names the occupant
 * (repo, state, when it registered) so the caller can pick another one. The
 * gate never adds a suffix, never overwrites the holder, and never evicts it.
 * Only an occupant that is provably gone releases a name — and "provably" is
 * three facts, not one:
 *
 *   1. its heartbeat is stale (SESSION_STALE_MS without a renewal), AND
 *   2. no process with its pid is running, AND
 *   3. its pane is not in tmux's own pane list.
 *
 * Anything unreadable makes the occupant UNKNOWN, and unknown never releases,
 * never takes over and never kills (fail-closed: a leaked name costs one
 * question, a stolen one costs somebody's session).
 *
 * ── AND A DEAD HOLDER IS RECLAIMED, NOT JUST ITS NAME ──
 *
 * A session that died without a `declare_done` leaves its dedicated tmux
 * session behind (lib/session-tmux-scope.ts lazy-creates it; `closeOwnSession`
 * only runs on the way out). The sweep that reclaims it — the tmux session, the
 * registration and the inbox, all gated on the dead session's OWN
 * `@rg_scope_owner` marker — is {@link ./session-orphan-sweep.ts}, kept apart
 * from this file because it acts on OTHER sessions' leftovers and its act is
 * destructive (and because this file is long enough as it is).
 *
 * Pure-ish: the file system enters through {@link RegistryIO}, tmux through an
 * injected runner and the pid through an injected check, so every branch —
 * including the races — runs in a test with no tmux and no processes.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isOwnSessionName } from "./orchestrator-tmux.ts";
import { listServerPanes } from "./judge-pane.ts";
import { writeFileAtomic } from "./atomic-write.ts";

/** Directory holding one JSON file per named session, under the agent home. */
export const SESSION_REGISTRY_DIRNAME = "rg-sessions";
/** Longest name the gate accepts. Long enough to read, short enough for a status line. */
export const SESSION_NAME_MAX = 32;
/** Shortest name: one character is unaddressable in practice (`@a` reads as a typo). */
export const SESSION_NAME_MIN = 2;
/** How often a named session renews its entry. */
export const SESSION_HEARTBEAT_MS = 30_000;
/**
 * How long an entry may go unrenewed before its holder is even a CANDIDATE for
 * dead: six missed beats, so a session blocked in a 20-minute precommit (whose
 * own timer still runs) is never mistaken for one that exited.
 */
export const SESSION_STALE_MS = 180_000;

/**
 * Where a name's file lives. The name is validated by {@link sessionNameProblem}
 * before it ever reaches here — `..` must not become a path.
 *
 * GLOBAL, not repo-local: a session may sit in a worktree or in another
 * repository entirely, and a name is how you reach it from anywhere (the same
 * reason lib/orchestrator-channel.ts's channels live under the agent home).
 */
export function sessionRegistryRoot(home: string = homedir()): string {
  return join(home, ".pi", "agent", SESSION_REGISTRY_DIRNAME);
}

/** The one path a name owns. */
export function sessionEntryPath(root: string, name: string): string {
  return join(root, `${name}.json`);
}

/**
 * A name's inbox — the file another session writes `@名字` messages into (t3).
 *
 * IT IS DEFINED HERE because the name owns the directory: whoever deletes a
 * registration (this module's sweep, a release) has to know what else belongs
 * to that name, and t3 writing to a path this module does not know about is
 * exactly how a reaped session's inbox would survive it.
 */
export function sessionInboxPath(root: string, name: string): string {
  return join(root, `${name}.inbox.jsonl`);
}

/**
 * Where a name's inbox sits WHILE IT IS BEING CONSUMED: `<inbox>.taken`.
 *
 * Here, beside the inbox itself, because it is the same path rule rather than
 * t3's private convention: whoever removes a name's inbox has to remove this
 * with it, and there are two such places (the release below, and the orphan
 * sweep). t3 only PARK the file under this name — how a message is consumed is
 * lib/session-message-tools.ts's business.
 */
export function sessionInboxTakenPath(root: string, name: string): string {
  return `${sessionInboxPath(root, name)}.taken`;
}

/**
 * Remove everything a name owns BESIDES its registration: the inbox, the parked
 * copy, and the side files a spilled body lives in.
 *
 * ONE PLACE, because there are two moments that owe it — the release below, and
 * the orphan sweep in its own module — and because "what belongs to a name" is
 * this module's question to answer. The inbox files are found by PREFIX rather
 * than by name, which is what covers the spilled `<inbox>.<messageId>.payload`
 * files that no caller could enumerate (the id is the sender's). Returns whether
 * the inbox itself was there; a leftover that could not be removed is reported
 * by the caller's own log/report, never silently assumed gone.
 */
export function removeNameMail(deps: Pick<RegistryDeps, "root" | "io">, name: string): boolean {
  const inbox = sessionInboxPath(deps.root, name);
  const removed = deps.io.remove(inbox);
  const prefix = `${name}.inbox.jsonl.`;
  for (const file of deps.io.listFiles() ?? []) {
    if (file.startsWith(prefix)) deps.io.remove(join(deps.root, file));
  }
  return removed;
}

/**
 * Kebab-case, 2–32 characters: lowercase letters, digits and single dashes,
 * starting and ending with a letter or a digit. `undefined` means legal.
 */
export function sessionNameProblem(value: unknown): string | undefined {
  const raw = typeof value === "string" ? value : "";
  if (raw.length === 0) return "名字不能为空";
  if (raw.length > SESSION_NAME_MAX) return `名字最长 ${SESSION_NAME_MAX} 个字符（当前 ${raw.length}）`;
  if (raw.length < SESSION_NAME_MIN) return `名字最短 ${SESSION_NAME_MIN} 个字符`;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(raw)) {
    return "名字必须是 kebab-case：小写字母/数字/中划线，且以字母或数字开头和结尾（如 t2-registry）";
  }
  return undefined;
}

/** True for a name the registry will accept. */
export function isSessionName(value: unknown): value is string {
  return sessionNameProblem(value) === undefined;
}

/** The tmux coordinates a session reports about ITSELF. */
export interface SessionTmuxCoords {
  /** The tmux session the pane sits in. */
  session: string;
  /** Its window id (`@12`). */
  window: string;
  /** Its pane id (`%3`). */
  pane: string;
}

/** One name's registration, as it is stored. */
export interface SessionRegistryEntry {
  schema: 1;
  name: string;
  /** The pi session id — the identity a release and a takeover are bound to. */
  sessionId: string;
  /** The pi process, for the pid half of the liveness question. */
  pid: number;
  /** Repo root (what a human means by "which project"). */
  repo: string;
  /** Working directory the session runs in. */
  cwd: string;
  /** loop | explore | normal | orchestrator | child | judge | worker. */
  mode: string;
  /** working | idle — a coarse reading, refreshed with the heartbeat. */
  state: string;
  /** Absent when the session runs outside tmux (it can still be addressed). */
  tmux?: SessionTmuxCoords;
  /**
   * The dedicated tmux session this session CREATED for its children
   * (lib/session-tmux-scope.ts), once it has one. The sweep reclaims it after
   * the marker check.
   */
  scopeSession?: string;
  /** ISO timestamps. */
  registeredAt: string;
  heartbeatAt: string;
}

/** Parse a stored entry. Undefined on any doubt — the caller then treats the name as unreadable. */
export function parseRegistryEntry(raw: unknown): SessionRegistryEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (!isSessionName(value.name)) return undefined;
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (sessionId.length === 0) return undefined;
  const pid = typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
  if (pid === undefined) return undefined;
  const mode = typeof value.mode === "string" ? value.mode.trim() : "";
  const state = typeof value.state === "string" ? value.state.trim() : "";
  const registeredAt = typeof value.registeredAt === "string" ? value.registeredAt.trim() : "";
  const heartbeatAt = typeof value.heartbeatAt === "string" ? value.heartbeatAt.trim() : "";
  if (!mode || !state || !registeredAt || !heartbeatAt) return undefined;
  const tmux = value.tmux;
  let coords: SessionTmuxCoords | undefined;
  if (tmux && typeof tmux === "object") {
    const t = tmux as Record<string, unknown>;
    const session = typeof t.session === "string" ? t.session.trim() : "";
    const window = typeof t.window === "string" ? t.window.trim() : "";
    const pane = typeof t.pane === "string" ? t.pane.trim() : "";
    if (session && window && pane) coords = { session, window, pane };
  }
  const scopeSession = isOwnSessionName(value.scopeSession) ? value.scopeSession : undefined;
  const repo = typeof value.repo === "string" ? value.repo.trim() : "";
  const cwd = typeof value.cwd === "string" ? value.cwd.trim() : "";
  return {
    schema: 1,
    name: value.name,
    sessionId,
    pid,
    repo,
    cwd,
    mode,
    state,
    ...(coords === undefined ? {} : { tmux: coords }),
    ...(scopeSession === undefined ? {} : { scopeSession }),
    registeredAt,
    heartbeatAt,
  };
}

/** The bytes stored for an entry — stable key order, so two renewals differ only by their stamps. */
export function serializeRegistryEntry(entry: SessionRegistryEntry): string {
  return JSON.stringify(entry, null, 2) + "\n";
}

/** Everything this module touches on disk. Injected, so the races are testable. */
export interface RegistryIO {
  /** The file's bytes, or undefined when it is absent OR unreadable. */
  readText(path: string): string | undefined;
  /** Atomic replace. False when it could not be written. */
  writeText(path: string, text: string): boolean;
  /** O_EXCL create. True ONLY for the caller that created it. */
  createExclusive(path: string, text: string): boolean;
  /** `rename(2)`: false when the source is gone (which is how a takeover is won). */
  rename(from: string, to: string): boolean;
  remove(path: string): boolean;
  /** Entry file basenames. Undefined when the directory cannot be read. */
  listFiles(): string[] | undefined;
}

/**
 * The real file system: every failure is reported as a value, never thrown at
 * the caller. The root is BOUND here, so listing and addressing cannot end up
 * looking at two different directories.
 */
export function nodeRegistryIO(root: string = sessionRegistryRoot()): RegistryIO {
  return {
    readText(path) {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
    writeText(path, text) {
      try { writeFileAtomic(path, text); return true; } catch { return false; }
    },
    createExclusive(path, text) {
      try {
        // THE DIRECTORY FIRST (measured 2026-09-25 on a machine where
        // `rg-sessions/` had never existed): `writeFileSync({flag:"wx"})` fails
        // with ENOENT when the parent is missing, and a caller that reads
        // "false" as "somebody created it first" then reports the FIRST EVER
        // name as taken by an unreadable occupant. `writeText` has always
        // mkdir-ed (lib/atomic-write.ts); this path has to do the same.
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, { flag: "wx" });
        return true;
      } catch {
        return false;
      }
    },
    rename(from, to) {
      try { renameSync(from, to); return true; } catch { return false; }
    },
    remove(path) {
      try { rmSync(path, { force: true }); return true; } catch { return false; }
    },
    listFiles() {
      try { return readdirSync(root).map(String); } catch { return undefined; }
    },
  };
}

/** One tmux invocation, as this module uses it. */
export interface RegistryTmuxResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** What this module needs from the outside world. */
export interface RegistryDeps {
  /** `sessionRegistryRoot()` in production. */
  root: string;
  io: RegistryIO;
  /** Runs one tmux argv (the extension's own declared runner). `ownSessions`
   * carries session names the CALLER has just proven are gate sessions — a dead
   * session's own dedicated session, which no live process can declare. */
  runTmux(argv: readonly string[], ownSessions?: readonly string[]): RegistryTmuxResult;
  /** Is a process with this pid running? */
  alive(pid: number): boolean;
  /** Epoch ms. */
  now(): number;
}

/** The default pid check: a signal of 0 asks "may I signal it", and EPERM means it exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Read one name's entry, or undefined when it is absent, unreadable or malformed. */
export function readEntry(deps: RegistryDeps, name: string): SessionRegistryEntry | undefined {
  if (!isSessionName(name)) return undefined;
  return parseEntryText(deps.io.readText(sessionEntryPath(deps.root, name)));
}

/** Parse stored bytes. Exported for the tests that pin the shape rules. */
export function parseEntryText(text: string | undefined): SessionRegistryEntry | undefined {
  if (text === undefined) return undefined;
  try {
    return parseRegistryEntry(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Every registration on this machine whose file parses, plus the ones that do not. */
export function listEntries(deps: RegistryDeps): {
  entries: SessionRegistryEntry[];
  unreadable: string[];
  error?: string;
} {
  const files = deps.io.listFiles();
  if (files === undefined) return { entries: [], unreadable: [], error: "读不到注册表目录" };
  const entries: SessionRegistryEntry[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".")) continue;
    const name = file.slice(0, -".json".length);
    const entry = readEntry(deps, name);
    if (entry) entries.push(entry);
    else unreadable.push(name);
  }
  return { entries, unreadable };
}

/** The entry this session id owns, if any (a restart re-adopts its own name through this). */
export function findEntryBySessionId(deps: RegistryDeps, sessionId: string): SessionRegistryEntry | undefined {
  const id = String(sessionId ?? "").trim();
  if (id.length === 0) return undefined;
  return listEntries(deps).entries.find((entry) => entry.sessionId === id);
}

/** How long ago an entry renewed, or undefined when its stamp is unreadable. */
export function heartbeatAgeMs(entry: SessionRegistryEntry, now: number): number | undefined {
  const at = Date.parse(entry.heartbeatAt);
  return Number.isFinite(at) ? now - at : undefined;
}

/**
 * Is the holder of this entry alive, gone, or unreadable?
 *
 * THREE READS, ONE ANSWER, and the direction of each failure is the same:
 * anything that cannot be read makes the answer `unknown`, which releases
 * nothing and kills nothing.
 */
export type Occupancy = "live" | "dead" | "unknown";

export function classifyEntry(deps: RegistryDeps, entry: SessionRegistryEntry): Occupancy {
  const age = heartbeatAgeMs(entry, deps.now());
  if (age === undefined) return "unknown";
  if (age < SESSION_STALE_MS) return "live";
  // Stale — now ask the two questions that separate "blocked" from "gone".
  // The pane list comes from the ONE reader of it (lib/judge-pane.ts), so this
  // classification and the judge probe cannot disagree about what an
  // unreadable list means (2026-09-25, quality round P2).
  const panes = listServerPanes((argv) => deps.runTmux(argv));
  if (panes === undefined) return "unknown";
  // A heartbeat that stopped while the pane lives is a session that is stuck or
  // suspended, not one that exited: it keeps its name.
  if (entry.tmux?.pane !== undefined && panes.includes(entry.tmux.pane)) return "live";
  try {
    if (deps.alive(entry.pid)) return "live";
  } catch {
    return "unknown";
  }
  return "dead";
}

/** How a claim ended. */
export type ClaimOutcome =
  | { ok: true; outcome: "claimed" | "renewed" | "reclaimed"; note: string }
  | { ok: false; error: string };

/** A one-line description of who holds a name, for the refusal a human reads. */
export function describeOccupant(entry: SessionRegistryEntry, now: number): string {
  const age = heartbeatAgeMs(entry, now);
  const seen = age === undefined ? "未知" : age < 60_000 ? `${Math.round(age / 1000)} 秒前` : `${Math.round(age / 60_000)} 分钟前`;
  return [
    `repo=${entry.repo || "(未知)"}`,
    `状态=${entry.state}`,
    `模式=${entry.mode}`,
    `登记时间=${entry.registeredAt}`,
    `最近心跳=${seen}`,
    `session=${entry.sessionId}`,
    `pid=${entry.pid}`,
  ].join("、");
}

/**
 * CLAIM a name: take it if it is free, keep it if it is already ours, take it
 * over only when its holder is provably gone, refuse otherwise.
 *
 * THE EXCLUSIVE CREATE IS THE RACE BREAKER on the free path: two sessions that
 * both see "no file" cannot both win, because `O_EXCL` lets exactly one of them
 * create it. The loser then RE-READS and finds the winner's entry — deciding
 * against the `undefined` it saw a moment earlier would report a registration
 * as unreadable that it had simply not looked at yet (reviewer P1, round 1).
 *
 * THE TAKEOVER USES rename(2) for the same reason. Moving the DEAD entry out of
 * the way is atomic, and it fails when the source is already gone — so two
 * sessions reclaiming one dead name cannot both proceed: one moves the file,
 * the other's rename fails and it re-reads (finding the winner's fresh, live
 * entry). A plain overwrite would have let both believe they won, and the
 * silent loser would have discovered it only at its next renewal.
 */
export function claimName(deps: RegistryDeps, entry: SessionRegistryEntry): ClaimOutcome {
  const path = sessionEntryPath(deps.root, entry.name);
  const text = serializeRegistryEntry(entry);
  const first = deps.io.readText(path);
  if (first === undefined && deps.io.createExclusive(path, text)) {
    return { ok: true, outcome: "claimed", note: `名字 ${entry.name} 已登记` };
  }
  // THE OCCUPANT IS READ AGAIN when the create lost the race (reviewer P1,
  // round 1): `first` is `undefined` in exactly that branch, and deciding
  // against it would answer "its registration file cannot be read" about a file
  // we never opened — refusing a claim that the winner's entry may well allow
  // (it could be ours, already renewed, from a previous process).
  const existing = parseEntryText(first !== undefined ? first : deps.io.readText(path));
  if (existing === undefined) {
    return {
      ok: false,
      error:
        `名字 ${entry.name} 占不下来：登记文件读不出来（${path}）。` +
        "按 fail-closed 处理：不接管、不覆盖。请另选一个名字，或人工检查那个文件。",
    };
  }
  if (existing.sessionId === entry.sessionId) {
    if (!deps.io.writeText(path, text)) return { ok: false, error: `名字 ${entry.name} 的登记续期写入失败（${path}）` };
    return { ok: true, outcome: "renewed", note: `名字 ${entry.name} 仍归本会话，已续期` };
  }
  const occupancy = classifyEntry(deps, existing);
  if (occupancy === "live") {
    return {
      ok: false,
      error: `名字 ${entry.name} 已被别的活会话占用：${describeOccupant(existing, deps.now())}。请另选一个名字。`,
    };
  }
  if (occupancy === "unknown") {
    return {
      ok: false,
      error:
        `名字 ${entry.name} 的占用者判不出来（心跳已过期，但 tmux 或进程读不到）：` +
        `${describeOccupant(existing, deps.now())}。按 fail-closed 处理：不接管。请另选一个名字，或稍后重试。`,
    };
  }
  // dead — move it aside first, which only one claimant can do.
  const aside = `${path}.reclaim-${entry.pid}`;
  if (!deps.io.rename(path, aside)) {
    const reread = parseEntryText(deps.io.readText(path));
    if (reread !== undefined && reread.sessionId === entry.sessionId) {
      if (!deps.io.writeText(path, text)) return { ok: false, error: `名字 ${entry.name} 的接管写入失败（${path}）` };
      return { ok: true, outcome: "renewed", note: `名字 ${entry.name} 仍归本会话，已接管` };
    }
    return {
      ok: false,
      error: `名字 ${entry.name} 正被另一个进程接管（或已被重新登记），本次未占用。请重试或另选一个名字。`,
    };
  }
  if (!deps.io.writeText(path, text)) {
    deps.io.rename(aside, path); // put the evidence back; a failed claim must not erase it
    return { ok: false, error: `名字 ${entry.name} 的接管写入失败（${path}）` };
  }
  deps.io.remove(aside);
  return {
    ok: true,
    outcome: "reclaimed",
    note: `接管了死会话（${existing.sessionId}）留下的名字 ${entry.name}`,
  };
}

/** What a renewal did. */
export type RenewOutcome =
  | { ok: true }
  | { ok: false; error: string; lost?: boolean };

/**
 * RENEW an entry this session already holds — the heartbeat's whole job.
 *
 * A missing file means the name was swept or taken; a file with another session
 * id means somebody else holds the name now. Both are reported as `lost` and
 * NEVER written over: a renewal is not a way to take a name back, and the
 * session that finds itself nameless is told rather than silently duplicating.
 */
export function renewName(deps: RegistryDeps, entry: SessionRegistryEntry): RenewOutcome {
  const path = sessionEntryPath(deps.root, entry.name);
  const existing = parseEntryText(deps.io.readText(path));
  if (existing === undefined) {
    return { ok: false, lost: true, error: `名字 ${entry.name} 的登记已不存在（被回收或被删除）` };
  }
  if (existing.sessionId !== entry.sessionId) {
    return {
      ok: false,
      lost: true,
      error: `名字 ${entry.name} 现在归另一个会话（${existing.sessionId}）—— 本会话不再持有它`,
    };
  }
  if (!deps.io.writeText(path, serializeRegistryEntry(entry))) {
    return { ok: false, error: `名字 ${entry.name} 的心跳写入失败（${path}）` };
  }
  return { ok: true };
}

/** Give the name back. Only ever OUR entry, and a missing one is success (idempotent). */
export function releaseName(
  deps: RegistryDeps,
  name: string,
  sessionId: string,
): { ok: boolean; released: boolean; error?: string } {
  const path = sessionEntryPath(deps.root, name);
  const existing = parseEntryText(deps.io.readText(path));
  if (existing === undefined) return { ok: true, released: false };
  if (existing.sessionId !== sessionId) {
    return { ok: false, released: false, error: `名字 ${name} 已不归本会话（${existing.sessionId}），拒绝删除` };
  }
  if (!deps.io.remove(path)) return { ok: false, released: false, error: `名字 ${name} 的登记删除失败（${path}）` };
  // THE MAIL IS NOT TOUCHED HERE (reviewer P1, 2026-09-25 — this used to call
  // `removeNameMail`, and that was a cross-session message killer).
  //
  // Removing the registration frees the name ATOMICALLY, and a fresh session
  // can claim it — and be SENT a message — before any cleanup this function
  // could run. That cleanup would then delete the NEW holder's mail. The
  // opposite error is the cheaper one: the sender-side rule is “the recipient
  // has to be alive”, so a name nobody holds cannot accumulate new mail at all,
  // and whatever is left behind can only be read by whoever takes the name
  // next — a name is an address, and taking it means inheriting what was
  // mailed to it. (A DEAD holder's leftovers are still reclaimed, by the orphan
  // sweep, and only after re-reading that nobody has claimed the name — see
  // lib/session-orphan-sweep.ts.)
  return { ok: true, released: true };
}

