/**
 * MAKING SOMETHING HAPPEN — send a message, start a session, offer places to
 * start one.
 *
 * ── SENDING A MESSAGE ──
 *
 * The daemon writes into `@名字`'s inbox, in the EXACT record shape
 * `lib/session-message-tools.ts` writes
 * (`kind: "session-message"` + messageId/from/fromSessionId/fromRepo/fromMode/
 * at/text|textRef, one JSON line, appended atomically, bulky bodies spilled to
 * a side file). That shape is a wire format — the recipient's own gate reads
 * it — so it is not re-invented here: the constants, the payload path rule and
 * the record type come from that module, and the same "spill before append"
 * order is repeated because the line that lands must never be torn.
 *
 * The sender is `@daemon`: the panel is not a pi session, so there is nobody to
 * reply TO. The recipient reads who wrote it and can answer its human, not a
 * phantom peer.
 *
 * ── STARTING A SESSION ──
 *
 * `tmux new-window` running an interactive `pi`, in the daemon's OWN dedicated
 * tmux session (lib/session-tmux-scope.ts — the same name derivation, marker
 * and ownership rule the gate uses for its children). The task text goes in as
 * pi's first message, so the new session starts with the work in hand instead
 * of an empty prompt; the gate mode and the delivery station ride the
 * environment (`RG_GATE_MODE`, `RG_STATION_CAP`), which is exactly how a child
 * session learns them.
 *
 * The daemon is not a session, so its "repo" for the scope name is recorded on
 * first use and reused for every later launch — otherwise the second task in a
 * second repository would mint a second tmux session and leave one behind.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic-write.ts";
import { MAX_INLINE_RECORD_BYTES, newChannelId } from "../channel-io.ts";
import { openScopeWindow, type TmuxScope, type TmuxScopeRecord } from "../session-tmux-scope.ts";
import { ownSessionName } from "../session-tmux-scope.ts";
import type { TmuxRunner } from "../orchestrator-tmux.ts";
import { runTmuxArgv, currentTmuxServer } from "../tmux-exec.ts";
import { liveSessionNames } from "../session-name-tools.ts";
import {
  SESSION_MESSAGE_KIND,
  inboxPayloadPath,
  normalizeRecipient,
  type SessionInboxRecord,
} from "../session-message-tools.ts";
import { sessionInboxPath, sessionNameProblem, sessionRegistryRoot } from "../session-registry.ts";
import { STATION_CAP_ENV } from "../repo-pr-policy.ts";
import type { DeliveryStation } from "../delivery-station.ts";
import { GATE_MODE_ENV } from "../task-mode.ts";
import { daemonHome, DAEMON_HOME_ENV, userHome } from "./paths.ts";
import { ensureDaemonIdentity } from "./state.ts";
import type { SessionObserver } from "./sessions.ts";

/**
 * THE DAEMON'S OWN TMUX RUNNER.
 *
 * Same safety door and the SAME EXEC WRAPPER as the gate's
 * ({@link runTmuxArgv}, lib/tmux-exec.ts — one copy, 2026-10-01), with a
 * deliberately narrower declaration: the daemon may address only the one
 * dedicated session it derives for itself.
 */
export function createDaemonTmuxRunner(): TmuxRunner {
  return (argv, env, ownSessions) => runTmuxArgv(argv, env ?? process.env, { ownSessions: [...(ownSessions ?? [])] });
}

export interface SendMessageOutcome {
  ok: boolean;
  problem?: string;
  messageId?: string;
  at?: string;
  inbox?: string;
  /** The address book a refusal hands back, so the next try can copy a name. */
  liveNames?: string[];
}

export interface ControlDeps {
  /** The daemon's OWN home: its identity, its tmux scope, its questions. */
  home: string;
  /**
   * THE USER HOME the GATE writes the `@名字` registry under
   * (`lib/daemon/paths.ts` `userHome()`), NOT the daemon's home — a session
   * launched with `RG_DAEMON_HOME` set still registers its name under `$HOME`,
   * because `sessionRegistryRoot()` reads `homedir()` and knows nothing about
   * the daemon. Read from the daemon's own home, an inbox was written next to a
   * registration nobody has, and the recipient never saw the message.
   * Defaults to `userHome()`.
   */
  userHome?: string;
  runTmux: TmuxRunner;
  now?: () => number;
}

/**
 * Write one message into `@name`'s inbox — the same order the tool uses:
 * ensure the directory, spill the body if the line would be too long, append
 * one line, and remove a payload whose line never landed.
 */
export function sendSessionMessage(
  deps: ControlDeps,
  input: { to: string; text: string; from?: string },
): SendMessageOutcome {
  const now = deps.now ?? ((): number => Date.now());
  const name = normalizeRecipient(input.to);
  const body = typeof input.text === "string" ? input.text : "";
  if (name === "") return { ok: false, problem: "没写收件人 —— to 要填会话名（如 \"t2-registry\"）" };
  const nameProblem = sessionNameProblem(name);
  if (nameProblem !== undefined) return { ok: false, problem: `收件人名字不合法：${nameProblem}` };
  if (body.trim() === "") return { ok: false, problem: "消息正文是空的" };

  const root = sessionRegistryRoot(deps.userHome ?? userHome());
  // ONE probe, closed over: the server identity cannot change mid-call, and the
  // registry asks per entry.
  const server = currentTmuxServer(deps.runTmux);
  const listed = liveSessionNames({
    runTmux: deps.runTmux,
    now,
    root,
    tmuxServer: () => server,
  });
  const liveNames = listed.live.map((entry) => entry.name);
  const target = listed.live.find((entry) => entry.name === name);
  if (target === undefined) {
    const unknown = listed.unknown.some((entry) => entry.name === name);
    return {
      ok: false,
      problem: unknown
        ? `@${name} 的生死判不出来（心跳过期，但 tmux 或进程读不到）—— 按 fail-closed 不投递`
        : `@${name} 不在活会话里（没登记过这个名字，或已经死了）`,
      liveNames,
    };
  }

  const inbox = sessionInboxPath(root, target.name);
  const at = new Date(now()).toISOString();
  const messageId = newChannelId("msg", now());
  let record: SessionInboxRecord = {
    kind: SESSION_MESSAGE_KIND,
    messageId,
    from: (input.from ?? "daemon").trim() || "daemon",
    fromSessionId: "daemon",
    fromRepo: "",
    fromMode: "daemon",
    ...(target.sessionId === "" ? {} : { toSessionId: target.sessionId }),
    at,
    text: body,
  };
  try {
    mkdirSync(dirname(inbox), { recursive: true });
    if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_INLINE_RECORD_BYTES) {
      const path = inboxPayloadPath(inbox, messageId);
      writeFileAtomic(path, body);
      const { text: _spilled, ...rest } = record;
      record = { ...rest, textRef: { path, chars: body.length } };
    }
    appendFileSync(inbox, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    rmSync(inboxPayloadPath(inbox, messageId), { force: true });
    return { ok: false, problem: `消息没写进 @${name} 的 inbox：${error instanceof Error ? error.message : String(error)}`, inbox };
  }
  return { ok: true, messageId, at, inbox, liveNames };
}

// ---------------------------------------------------------------------------
// Starting a session
// ---------------------------------------------------------------------------

export interface LaunchTaskInput {
  repo: string;
  task: string;
  mode?: string;
  station?: string;
  name?: string;
  /**
   * The directory the session WORKS IN, when it is not the repo itself.
   *
   * A scheduled run passes its own isolated checkout here
   * (lib/schedule-worktree.ts, 2026-10-03): `repo` stays the anchor the
   * daemon's scope session is derived from, while the run's `cwd` — and
   * therefore everything the gate binds to — is the copy. Omitted ⇒ the repo.
   */
  workdir?: string;
  /**
   * Extra environment for the new session.
   *
   * The scheduler's run identity (`RG_SCHEDULE_ID` / `RG_SCHEDULE_RUN`) rides
   * this: it is the one channel a session's own prompt cannot forge, and the
   * two keys this module owns (`RG_GATE_MODE`, `RG_DAEMON_HOME`) are written
   * AFTER it, so a caller cannot claim to be a mode or a home it is not.
   */
  env?: Record<string, string>;
}

export interface LaunchTaskOutcome {
  ok: boolean;
  problem?: string;
  /**
   * `true` when NOTHING a retry could do will change the answer — the tmux the
   * daemon starts sessions with cannot run at all. The scheduler consumes the
   * slot for these and keeps it for every other failure (a server that is
   * coming up, a directory that is mid-rebuild).
   */
  permanent?: boolean;
  sessionId?: string;
  /** The pi session id the window runs with — deterministic, so it can be resumed. */
  scopeSession?: string;
  windowId?: string;
  paneId?: string;
  windowName?: string;
}

const MODES = new Set(["loop", "explore", "normal", "orchestrator"]);
const STATIONS = new Set<DeliveryStation>(["precommit", "commit", "pr"]);

/** A tmux window name: printable, short, and never something tmux would expand. */
export function safeWindowName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/#/g, "").slice(0, 32);
}

/**
 * The daemon's own tmux scope.
 *
 * `repoRoot()` is READ FROM DISK, not from the task being launched: the scope
 * session is the daemon's, and deriving its name from whichever repository
 * happened to be first would mint a second session for the second repo. The
 * first launch records the anchor; every later one reuses it.
 */
export function daemonTmuxScope(opts: {
  home: string;
  identity: string;
  runTmux: TmuxRunner;
  /** The repo to anchor the scope name to, used only when nothing is recorded yet. */
  anchorRepo: string;
}): TmuxScope {
  const recordPath = join(daemonHome(opts.home), "scope.json");
  const repoPath = join(daemonHome(opts.home), "scope-repo");

  const readRecord = (): TmuxScopeRecord | undefined => {
    try {
      const raw = JSON.parse(readFileSync(recordPath, "utf8")) as TmuxScopeRecord;
      return typeof raw?.name === "string" ? raw : undefined;
    } catch {
      return undefined;
    }
  };
  const readAnchor = (): string => {
    try {
      const value = readFileSync(repoPath, "utf8").trim();
      if (value !== "") return value;
    } catch { /* first launch */ }
    try {
      mkdirSync(daemonHome(opts.home), { recursive: true });
      // 0600 AT CREATION, like every other file the daemon keeps here: the
      // contract's §11 file table says so for both of these
      // (docs/daemon/api.md), and a mode is the one thing a later reader can
      // check — not leaving it to the process umask.
      writeFileAtomic(repoPath, `${opts.anchorRepo}\n`, { mode: 0o600 });
    } catch { /* best effort: a missing anchor only costs a second scope session */ }
    return opts.anchorRepo;
  };

  return {
    sessionId: () => opts.identity,
    repoRoot: readAnchor,
    role: () => "daemon",
    read: readRecord,
    write: (record) => {
      try {
        mkdirSync(daemonHome(opts.home), { recursive: true });
        writeFileAtomic(recordPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      } catch { /* the marker in tmux is what makes reuse work; the record is a shortcut */ }
    },
    now: () => new Date().toISOString(),
    // The daemon has no pane of its own: it may run detached, and borrowing the
    // pane it happens to have inherited would be wrong. A session without the
    // pane fact is one nobody but this process ever reclaims, which is correct.
    ownerProcess: () => ({ pid: process.pid, pane: undefined }),
  };
}

/**
 * Open a window running a fresh pi session on this task.
 *
 * Everything that can be checked BEFORE tmux is touched is checked first — a
 * missing directory, a bad mode, a taken name — because a half-started session
 * is worse than a refusal.
 */
export function launchTask(deps: ControlDeps, input: LaunchTaskInput): LaunchTaskOutcome {
  const repo = (input.repo ?? "").trim();
  if (repo === "" || !existsSync(repo) || !statSync(repo).isDirectory()) {
    return { ok: false, problem: `repo 不是存在的目录：${JSON.stringify(repo)}` };
  }
  const taskText = (input.task ?? "").trim();
  if (taskText === "") return { ok: false, problem: "任务描述是空的" };
  const mode = (input.mode ?? "loop").trim();
  if (!MODES.has(mode)) return { ok: false, problem: `门禁模式只能是 loop/explore/normal/orchestrator（收到 ${JSON.stringify(mode)}）` };
  const station = (input.station ?? "").trim();
  if (station !== "" && !STATIONS.has(station as DeliveryStation)) {
    return { ok: false, problem: `交付站点只能是 precommit/commit/pr（收到 ${JSON.stringify(station)}）` };
  }
  const name = (input.name ?? "").trim();
  if (name !== "") {
    const problem = sessionNameProblem(name);
    if (problem !== undefined) return { ok: false, problem: `会话名不合法：${problem}` };
    const server = currentTmuxServer(deps.runTmux);
    const live = liveSessionNames({
      runTmux: deps.runTmux,
      now: deps.now ?? ((): number => Date.now()),
      root: sessionRegistryRoot(deps.userHome ?? userHome()),
      tmuxServer: () => server,
    });
    if (live.live.some((entry) => entry.name === name) || live.unknown.some((entry) => entry.name === name)) {
      return { ok: false, problem: `会话名 ${name} 已被占用（活会话或生死不明的登记）—— 换一个名字` };
    }
  }

  const daemonId = ensureDaemonIdentity(deps.home);
  // WHERE THE SESSION WORKS — the run's own checkout when it was given one.
  const workdir = (input.workdir ?? repo).trim() === "" ? repo : (input.workdir ?? repo).trim();
  const scope = daemonTmuxScope({ home: deps.home, identity: daemonId, runTmux: deps.runTmux, anchorRepo: repo });
  const sessionId = randomUUID();
  const opening = [taskText];
  if (name !== "") {
    opening.push("", `本会话的名字定为 \`${name}\`：请先调用 name_session({name:"${name}"}) 把它登记上，再开始干活。`);
  }
  const command = [
    "pi",
    "--session-id",
    sessionId,
    ...(name === "" ? [] : ["--name", name]),
    "--",
    opening.join("\n"),
  ];
  const scopeName = ownSessionName(scope);
  // THE DAEMON MAY ADDRESS EXACTLY ONE SESSION: the one it just derived for
  // itself. Everything else tmux could name belongs to somebody else.
  const run: TmuxRunner = (argv, env, extra) =>
    deps.runTmux(argv, env, [...(scopeName === undefined ? [] : [scopeName]), ...(extra ?? [])]);
  // THE SESSION READS THE SAME HOME THE DAEMON DOES (quality round P2,
  // 2026-10-01). `envCommand` STRIPS every gate variable not passed here
  // (`RG_DAEMON_HOME` is in `GATE_ENV_NAMES`, orchestrator-tmux.ts), so a
  // session started from the panel would answer its dialogs into `$HOME` while
  // this daemon looks under the override: the question would be invisible in
  // the panel, and the session's own notification-suppression probe would look
  // in the wrong home too. The daemon knows where it lives - it says so.
  const env: Record<string, string> = { ...input.env, [GATE_MODE_ENV]: mode, [DAEMON_HOME_ENV]: deps.home };
  if (station !== "") env[STATION_CAP_ENV] = station;
  const opened = openScopeWindow(run, scope, {
    cwd: workdir,
    env,
    command,
    ...(name === "" ? {} : { windowName: safeWindowName(name) }),
  });
  if (!opened.ok) {
    return { ok: false, problem: opened.error, ...(opened.permanent === true ? { permanent: true } : {}) };
  }
  return {
    ok: true,
    sessionId,
    scopeSession: opened.sessionName,
    windowId: opened.windowId,
    paneId: opened.paneId,
    ...(name === "" ? {} : { windowName: safeWindowName(name) }),
  };
}

/**
 * ONE WINDOW, ADDRESSED — which session it must sit in, and which window it is.
 *
 * `repo` is only the anchor the daemon's scope name is derived from; the target
 * is not trusted, it is CHECKED against that derivation (below).
 */
export interface RunWindowTarget {
  repo: string;
  session: string;
  window: string;
}

/**
 * CLOSE A RUN'S WINDOW — the daemon's own window, and only that.
 *
 * A run is an ORDINARY loop session, and an ordinary session holds its worktree
 * until its PROCESS exits: the presence heartbeat is released on session
 * shutdown, NOT on `declare_done` (lib/session-lifecycle.ts releases it in
 * `onSessionShutdown`). The daemon starts these sessions, so the daemon is what
 * must reclaim them — a settled run whose window stays open keeps the checkout
 * "occupied" forever, and every later run of that repo would be skipped
 * (quality round P1, 2026-10-02).
 *
 * THE TARGET ARRIVES FROM ONE OF TWO PLACES, and both are needed:
 *
 *   - the OBSERVER's pane coordinates, for a session that is in the listing;
 *   - the LAUNCH RECEIPT (`launchTask` returns `scopeSession` + `windowId`, and
 *     the scheduler records them with the run), for a session whose pane lost
 *     `@rg_sid` — the observer has no coordinates for it at all, and without
 *     this second address that window could not be reclaimed while its process
 *     lived, so the checkout stayed occupied until the user closed it by hand.
 *
 * AND IT IS CHECKED, NOT TRUSTED: it must name the daemon's OWN scope session
 * for that repo (`ownSessionName` of the scope the daemon derives), which is
 * also the only session the safety door lets this call address. Anything else
 * is left alone — the user's own windows are not the daemon's to close.
 */
export function closeRunWindowAt(deps: ControlDeps, target: RunWindowTarget): boolean {
  const scope = daemonTmuxScope({
    home: deps.home,
    identity: ensureDaemonIdentity(deps.home),
    runTmux: deps.runTmux,
    anchorRepo: target.repo,
  });
  const scopeName = ownSessionName(scope);
  if (scopeName === undefined || target.session !== scopeName) return false;
  const run: TmuxRunner = (argv, env, extra) =>
    deps.runTmux(argv, env, [scopeName, ...(extra ?? [])]);
  // `-t <session>:<@window>`: the window ID (not its index, which moves), and
  // the session half is what the safety door compares against the declaration.
  return run(["kill-window", "-t", `${scopeName}:${target.window}`]).ok;
}

// ---------------------------------------------------------------------------
// Where could a task start?
// ---------------------------------------------------------------------------

export interface RepoCandidate {
  path: string;
  name: string;
  source: "session" | "history" | "root";
  lastSeenAt?: string;
}

/** A directory that is a git repository (worktree included: `.git` may be a file). */
export function isRepoRoot(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * The places a task could start, because a browser cannot scan a filesystem.
 *
 * Three sources, deduplicated by path: the repos running sessions sit in, the
 * cwds of recent transcripts (their first line is the only place a session's
 * true cwd is written — the directory name pi stores them under is lossy), and
 * the workspace roots the daemon was started with, expanded one level into the
 * git repos inside them.
 */
export function listCandidateRepos(opts: {
  observer: SessionObserver;
  workspaceRoots: readonly string[];
}): RepoCandidate[] {
  const byPath = new Map<string, RepoCandidate>();
  // "Running now" beats "seen recently" beats "sits under a workspace root":
  // the panel groups by this word, so one path must carry its STRONGEST reason.
  const RANK: Record<RepoCandidate["source"], number> = { session: 2, history: 1, root: 0 };
  const add = (path: string, source: RepoCandidate["source"], lastSeenAt?: string): void => {
    const clean = path.trim();
    if (clean === "" || !existsSync(clean)) return;
    const existing = byPath.get(clean);
    if (existing !== undefined) {
      if (RANK[source] > RANK[existing.source]) byPath.set(clean, { ...existing, source, ...(lastSeenAt === undefined ? {} : { lastSeenAt }) });
      return;
    }
    byPath.set(clean, { path: clean, name: basename(clean), source, ...(lastSeenAt === undefined ? {} : { lastSeenAt }) });
  };

  for (const session of opts.observer.collect({ includeRecentMs: 7 * 24 * 60 * 60 * 1_000 }).sessions) {
    const where = session.repo !== "" && isRepoRoot(session.repo)
      ? session.repo
      : session.cwd !== "" && isRepoRoot(session.cwd) ? session.cwd : "";
    if (where === "") continue;
    // A session whose pane is gone is HISTORY, not a running one — the contract
    // (§5.6) declares both words and the panel renders one group per word, so a
    // finished session listed as 「正在运行」 is the lie that distinction exists
    // to prevent.
    add(where, session.alive ? "session" : "history", session.lastActivityAt ?? undefined);
  }
  for (const root of opts.workspaceRoots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(root, entry);
      try {
        if (statSync(path).isDirectory() && isRepoRoot(path)) add(path, "root");
      } catch { /* an unreadable entry is simply not a candidate */ }
    }
  }
  return [...byPath.values()].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
}
