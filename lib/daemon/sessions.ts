/**
 * WHICH PI SESSIONS EXIST ON THIS MACHINE, AND WHAT THEY ARE DOING — one
 * reading, assembled from three sources that each know a different part.
 *
 *   1. `~/.pi/agent/rg-sessions/*.json`  the NAMED sessions: name, repo, cwd,
 *      mode, pid, heartbeat (lib/session-registry.ts owns the format and the
 *      liveness rule; this module never re-implements either).
 *   2. `tmux list-panes -a`              every pane on the server with the
 *      `@rg_*` options a gate session writes about itself
 *      (lib/tmux-pane-state.ts) — this is where a judge or a worker shows up,
 *      and where the current state word comes from.
 *   3. `sessions/<encoded>/<ts>_<id>.jsonl`  the transcript: the session's cwd,
 *      its recent output, and the gate state it recorded about itself.
 *
 * ── THE STATE WORD IS REUSED, NOT REINVENTED ──
 *
 * {@link CHILD_STATES} is the vocabulary (`working`, `waiting-input`, `done`,
 * `dead`, …) and the precedence below is the same one the orchestration layer
 * reads: an open dialog forces `waiting-input`, a pane that stopped reporting
 * is `stalled`, and a pane that is gone with no live process is `dead`. A second
 * state vocabulary would drift from the one the sidebar, the receipts and the
 * orchestrator already speak.
 *
 * ── WHAT THIS MODULE DOES NOT DO ──
 *
 * It never kills, never writes, and never decides that a session is gone from
 * anything but the two facts the gate itself uses (pane list, pid). An
 * unreadable tmux is missing INFORMATION: it leaves whatever the registry and
 * the transcript say in place and never turns into "dead" (lib/session-registry.ts
 * fail-closed rule, unchanged here).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  classifyEntry,
  listEntries,
  nodeRegistryIO,
  pidAlive,
  sessionRegistryRoot,
  type SessionRegistryEntry,
} from "../session-registry.ts";
import { buildListAllPanesArgv, parsePaneRows } from "../tmux-sidebar-collect.ts";
import { PANE_STATE_STALE_S } from "../tmux-pane-state.ts";
import { CHILD_STATES, type ChildState } from "../orchestrator-child-state.ts";
import type { TmuxRunner } from "../orchestrator-tmux.ts";
import { gitRawOrNull } from "../git-exec.ts";
import { unmetRequirements } from "../gate-state-requirements.ts";
import type { GateState } from "../gate-state.ts";
import { extractGateState, readFileHead, readFileTail, readRecentEntries, transcriptSize, type OutputEntry } from "./transcript.ts";
import { currentTmuxServer } from "../tmux-exec.ts";
import { daemonAgentHome } from "./paths.ts";

const STATE_WORDS: ReadonlySet<string> = new Set(CHILD_STATES);
const isStateWord = (value: string): value is ChildState => STATE_WORDS.has(value);

/** How long the pane's own state word stays believable (lib/tmux-pane-state.ts). */
const PANE_STATE_STALE_MS = PANE_STATE_STALE_S * 1_000;
/** A transcript written to this recently is the weakest evidence of "still working". */
const TRANSCRIPT_ACTIVE_MS = 120_000;
/** How long the transcript index and the branch cache are reused. */
const INDEX_TTL_MS = 5_000;
const BRANCH_TTL_MS = 30_000;
/** Default window for listing sessions that have neither a pane nor a name. */
export const RECENT_SESSION_MS = 24 * 60 * 60 * 1_000;
export const SESSION_LIST_LIMIT = 200;

/** One session, as the HTTP API reports it (field-for-field, docs/daemon/api.md). */
export interface DaemonSession {
  sessionId: string;
  /** The `@名字` handle, when the session registered one. */
  name: string | null;
  /** `loop` | `orchestrator` | `child` | `judge` | `worker` … from `@rg_kind`. */
  kind: string | null;
  repo: string;
  cwd: string;
  branch: string | null;
  mode: string;
  state: ChildState;
  /** ISO of the pane's last state write, when there is one. */
  stateAt: string | null;
  /** Which source produced `state` — so a consumer can weigh it. */
  stateSource: "pane" | "registry" | "transcript" | "process";
  alive: boolean;
  tmux: { session: string; window: string; pane: string } | null;
  pid: number | null;
  transcript: string | null;
  lastActivityAt: string | null;
  rounds: { sent: number; recorded: number; lastVerdict: string | null };
  /**
   * Did the transcript tail carry a gate-state record at all?
   *
   * FALSE means the daemon could not read what this session's gate last said
   * about itself (`rounds` and `unmet` are then placeholder values, not
   * findings) — a consumer must render that as unknown, because an empty
   * `unmet` would otherwise read as "nothing is pending".
   */
  gateStateFound: boolean;
  unmet: string[];
  registeredAt: string | null;
  heartbeatAt: string | null;
}

export interface SessionObserverDeps {
  home?: string;
  runTmux: TmuxRunner;
  now?: () => number;
  /** Injected so the HTTP layer and the tests can run without git. */
  branchOf?: (cwd: string) => string | null;
}

export interface CollectOptions {
  /** Include sessions with no pane and no name whose transcript moved in this window. */
  includeRecentMs?: number;
  limit?: number;
}

export interface SessionCollection {
  now: string;
  /** `false` when `tmux list-panes` could not be read — never reported as "no panes". */
  tmuxReadable: boolean;
  sessions: DaemonSession[];
  problems: string[];
}

export interface SessionObserver {
  collect(opts?: CollectOptions): SessionCollection;
  /** The most recent transcript path for a session id, if one exists. */
  transcriptFor(sessionId: string): string | undefined;
  /** Recent output entries, oldest first. */
  outputFor(sessionId: string, count: number): OutputEntry[];
}

interface TranscriptRef {
  path: string;
  mtimeMs: number;
}

function defaultBranchOf(cwd: string): string | null {
  if (cwd.trim() === "") return null;
  const raw = gitRawOrNull(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const value = raw === null ? "" : raw.trim();
  return value === "" || value === "HEAD" ? null : value;
}

/** Every `*.jsonl` under the sessions root, keyed by the session id in its name. */
function scanTranscripts(sessionsRoot: string): Map<string, TranscriptRef> {
  const found = new Map<string, TranscriptRef>();
  let dirs: string[];
  try {
    dirs = readdirSync(sessionsRoot);
  } catch {
    return found;
  }
  for (const dir of dirs) {
    const full = join(sessionsRoot, dir);
    let files: string[];
    try {
      if (!statSync(full).isDirectory()) continue;
      files = readdirSync(full);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const underscore = file.lastIndexOf("_");
      if (underscore < 0) continue;
      const sessionId = file.slice(underscore + 1, -".jsonl".length);
      if (sessionId === "") continue;
      const path = join(full, file);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      const previous = found.get(sessionId);
      if (previous === undefined || previous.mtimeMs < mtimeMs) found.set(sessionId, { path, mtimeMs });
    }
  }
  return found;
}

/**
 * How far back the last gate-state record is searched for.
 *
 * The record we want is the NEWEST one, so reading the tail is the right shape —
 * but the window is a real limit, and it is why {@link DaemonSession.gateStateFound}
 * exists: a single huge tool result can push the last record further back than
 * this, and "no record in the window" MUST NOT be readable as "nothing is
 * pending" (an empty `unmet` is the dangerous direction of that mistake).
 */
const GATE_STATE_WINDOW_BYTES = 256 * 1024;

/** The gate state a session recorded about itself, read from its transcript tail. */
function readGateState(path: string): Record<string, unknown> | undefined {
  const tail = readFileTail(path, GATE_STATE_WINDOW_BYTES);
  return tail === undefined ? undefined : extractGateState(tail.text);
}

function readRounds(state: Record<string, unknown> | undefined): DaemonSession["rounds"] {
  if (state === undefined) return { sent: 0, recorded: 0, lastVerdict: null };
  // `sentReviewRounds` is the field the gate actually writes (lib/gate-state.ts):
  // the rounds this session has SENT OUT, which is not the same number as the
  // rounds it has recorded — an in-flight round is sent and not yet recorded.
  const sent = typeof state.sentReviewRounds === "number" ? state.sentReviewRounds : undefined;
  const rounds = Array.isArray(state.rounds) ? state.rounds : [];
  let lastVerdict: string | null = null;
  const last = rounds[rounds.length - 1];
  if (last && typeof last === "object") {
    const verdict = (last as Record<string, unknown>).verdict;
    if (typeof verdict === "string") lastVerdict = verdict;
  }
  return { sent: sent ?? rounds.length, recorded: rounds.length, lastVerdict };
}

/**
 * The requirements the session's own gate would still list before a ship.
 *
 * NOT the daemon's verdict: it is computed by the gate's own authority
 * (`unmetRequirements`) from the sidecar half the session wrote into its
 * transcript. The worktree fingerprint is deliberately NOT recomputed — that
 * would mean hashing a worktree on every poll — so the last recorded
 * fingerprint stands in for it, and a state that cannot be read that way
 * reports the raw verdicts with an empty list rather than a guessed one.
 */
function readUnmet(state: Record<string, unknown> | undefined): string[] {
  if (state === undefined) return [];
  try {
    const review = state.review as { fingerprint?: unknown } | undefined;
    const fingerprint = typeof review?.fingerprint === "string" ? review.fingerprint : "";
    return unmetRequirements(state as unknown as GateState, fingerprint, false);
  } catch {
    return [];
  }
}

export function createSessionObserver(deps: SessionObserverDeps): SessionObserver {
  const home = deps.home;
  const now = deps.now ?? ((): number => Date.now());
  const branchOf = deps.branchOf ?? defaultBranchOf;
  const registryRoot = sessionRegistryRoot(home);
  const registryIO = nodeRegistryIO(registryRoot);
  const sessionsRootPath = join(daemonAgentHome(home), "sessions");

  let indexAt = 0;
  let index = new Map<string, TranscriptRef>();
  const branches = new Map<string, { at: number; value: string | null }>();
  // ONE gate-state read per transcript VERSION: the last record lives at the end
  // of the file, so a session that produced no new output since the last tick
  // would otherwise cost another 256 KiB read every second.
  //
  // BOTH MAPS ARE PRUNED AT THE END OF EVERY COLLECT (2026-10-01, quality round
  // P2): this is a resident process, and a cache keyed by "every transcript I
  // have ever seen" is an unbounded leak in a daemon that runs for weeks. Only
  // the keys this collect actually touched survive — the same walk that reads
  // them also says which ones are still live.
  const gateStates = new Map<string, { size: number; gate: Record<string, unknown> | undefined }>();
  // What THIS collect touched, so the two caches can be pruned to it (and the
  // sets themselves are as short-lived as the call that fills them).
  let touchedGateState = new Set<string>();
  let touchedBranches = new Set<string>();
  // ONE collection per second serves every reader (the watcher, an HTTP list,
  // an SSE subscription): the sources are the file system and tmux, and three
  // callers asking in the same tick must not cost three scans.
  let cached: { key: string; at: number; value: SessionCollection } | undefined;
  const CACHE_TTL_MS = 900;

  function transcripts(): Map<string, TranscriptRef> {
    const at = now();
    if (at - indexAt > INDEX_TTL_MS) {
      index = scanTranscripts(sessionsRootPath);
      indexAt = at;
    }
    return index;
  }

  function gateStateFor(path: string): Record<string, unknown> | undefined {
    touchedGateState.add(path);
    const size = transcriptSize(path);
    const cached = gateStates.get(path);
    if (cached !== undefined && size !== undefined && cached.size === size) return cached.gate;
    const gate = readGateState(path);
    gateStates.set(path, { size: size ?? -1, gate });
    return gate;
  }

  function branch(cwd: string): string | null {
    touchedBranches.add(cwd);
    const cached = branches.get(cwd);
    const at = now();
    if (cached !== undefined && at - cached.at < BRANCH_TTL_MS) return cached.value;
    let value: string | null = null;
    try {
      value = branchOf(cwd);
    } catch {
      value = null;
    }
    branches.set(cwd, { at, value });
    return value;
  }

  function resolveState(input: {
    paneState: string;
    paneStateAt: number | undefined;
    pane: boolean;
    registry: SessionRegistryEntry | undefined;
    transcriptMtimeMs: number | undefined;
    at: number;
  }): { state: ChildState; source: DaemonSession["stateSource"] } {
    const paneFresh = input.paneStateAt !== undefined && input.at - input.paneStateAt < PANE_STATE_STALE_MS;
    if (input.pane && isStateWord(input.paneState)) {
      return paneFresh ? { state: input.paneState, source: "pane" } : { state: "stalled", source: "pane" };
    }
    const registryWord = input.registry?.state ?? "";
    if (input.registry !== undefined && isStateWord(registryWord)) {
      // A named session renews its heartbeat every 30s; a stale one with no
      // pane to ask about is stalled, exactly as it is one layer up.
      const age = Date.parse(input.registry.heartbeatAt);
      if (Number.isFinite(age) && input.at - age < PANE_STATE_STALE_MS) return { state: registryWord, source: "registry" };
      if (input.pane) return { state: "stalled", source: "registry" };
    }
    const active = input.transcriptMtimeMs !== undefined && input.at - input.transcriptMtimeMs < TRANSCRIPT_ACTIVE_MS;
    return { state: active ? "working" : "idle", source: "transcript" };
  }

  return {
    collect(opts: CollectOptions = {}): SessionCollection {
      const at = now();
      const cacheKey = `${opts.includeRecentMs ?? RECENT_SESSION_MS}:${opts.limit ?? SESSION_LIST_LIMIT}`;
      if (cached !== undefined && cached.key === cacheKey && at - cached.at < CACHE_TTL_MS) return cached.value;
      touchedGateState = new Set<string>();
      touchedBranches = new Set<string>();
      const problems: string[] = [];
      const includeRecentMs = opts.includeRecentMs ?? RECENT_SESSION_MS;
      const limit = opts.limit ?? SESSION_LIST_LIMIT;
      const byId = new Map<string, DaemonSession>();

      const listed = listEntries({
        root: registryRoot,
        io: registryIO,
        runTmux: deps.runTmux,
        alive: pidAlive,
        now,
      });
      if (listed.error !== undefined) problems.push(listed.error);
      if (listed.unreadable.length > 0) problems.push(`读不出来的登记：${listed.unreadable.join("、")}`);

      const bySessionId = new Map<string, SessionRegistryEntry>();
      for (const entry of listed.entries) bySessionId.set(entry.sessionId, entry);

      let paneRows: ReturnType<typeof parsePaneRows> = [];
      let tmuxReadable = true;
      try {
        const result = deps.runTmux(buildListAllPanesArgv());
        if (result.ok) paneRows = parsePaneRows(result.stdout);
        else {
          tmuxReadable = false;
          problems.push(`tmux list-panes 失败：${result.stderr || "未知原因"}`);
        }
      } catch (error) {
        tmuxReadable = false;
        problems.push(`tmux 不可读：${error instanceof Error ? error.message : String(error)}`);
      }

      const transcriptsNow = transcripts();
      const ensure = (sessionId: string): DaemonSession => {
        const existing = byId.get(sessionId);
        if (existing !== undefined) return existing;
        const created: DaemonSession = {
          sessionId,
          name: null,
          kind: null,
          repo: "",
          cwd: "",
          branch: null,
          mode: "",
          state: "idle",
          stateAt: null,
          stateSource: "transcript",
          alive: false,
          tmux: null,
          pid: null,
          transcript: null,
          lastActivityAt: null,
          rounds: { sent: 0, recorded: 0, lastVerdict: null },
          gateStateFound: false,
          unmet: [],
          registeredAt: null,
          heartbeatAt: null,
        };
        byId.set(sessionId, created);
        return created;
      };

      for (const row of paneRows) {
        if (row.sid === "") continue;
        const session = ensure(row.sid);
        session.kind = row.kind || session.kind;
        session.repo = session.repo || row.repo;
        // THE PANE CARRIES THE MODE TOO, for a session that never registered a
        // name (a judge, a worker, a child of somebody else). The registry's
        // value wins where both exist — it is the gate mode, refreshed, while
        // `@rg_kind` is what the session calls itself.
        session.mode = session.mode || row.kind;
        session.tmux = { session: row.session, window: row.windowId, pane: row.paneId };
        session.alive = true;
        const stateAtMs = Number.parseInt(row.stateAt, 10);
        session.stateAt = Number.isFinite(stateAtMs) ? new Date(stateAtMs * 1_000).toISOString() : null;
        const resolved = resolveState({
          paneState: row.state,
          paneStateAt: Number.isFinite(stateAtMs) ? stateAtMs * 1_000 : undefined,
          pane: true,
          registry: bySessionId.get(row.sid),
          transcriptMtimeMs: transcriptsNow.get(row.sid)?.mtimeMs,
          at,
        });
        session.state = resolved.state;
        session.stateSource = resolved.source;
      }

      for (const entry of listed.entries) {
        const session = ensure(entry.sessionId);
        session.name = entry.name;
        session.repo = entry.repo || session.repo;
        session.cwd = session.cwd || entry.cwd;
        session.mode = entry.mode;
        session.pid = entry.pid;
        session.registeredAt = entry.registeredAt;
        session.heartbeatAt = entry.heartbeatAt;
        if (session.repo === "") session.repo = entry.cwd;
        const occupancy = classifyEntry({
          root: registryRoot,
          io: registryIO,
          runTmux: deps.runTmux,
          alive: pidAlive,
          now,
          // WHICH SERVER MINTED THE PANE ID MATTERS (reviewer P2, 2026-10-01):
          // without it a restarted server's reused `%3` makes a dead session
          // read as alive in this very list — the message path already passed
          // it, so the observation面 was the odd one out.
          currentServer: () => currentTmuxServer(deps.runTmux),
        }, entry);
        if (occupancy === "live") session.alive = true;
        // The registry's own word is the fallback the resolver already applied
        // for sessions without a pane; a pane reading always wins.
        if (session.tmux === null && session.stateSource !== "pane" && isStateWord(entry.state)) {
          const resolved = resolveState({
            paneState: "",
            paneStateAt: undefined,
            pane: false,
            registry: entry,
            transcriptMtimeMs: transcriptsNow.get(entry.sessionId)?.mtimeMs,
            at,
          });
          session.state = resolved.state;
          session.stateSource = resolved.source;
        }
      }

      for (const [sessionId, ref] of transcriptsNow) {
        const session = byId.get(sessionId);
        if (session === undefined) continue; // filled in by the recent-window pass below
        session.transcript = ref.path;
        session.lastActivityAt = new Date(ref.mtimeMs).toISOString();
        if (session.stateSource === "transcript") {
          const resolved = resolveState({
            paneState: "",
            paneStateAt: undefined,
            pane: session.alive,
            registry: bySessionId.get(sessionId),
            transcriptMtimeMs: ref.mtimeMs,
            at,
          });
          session.state = resolved.state;
          session.stateSource = resolved.source;
        }
      }

      // Sessions nobody is holding open any more, but whose transcript moved
      // inside the recent window — they are what "最近跑过什么" means, and
      // leaving them out makes the panel useless five minutes after a session
      // ends.
      for (const [sessionId, ref] of transcriptsNow) {
        if (byId.has(sessionId)) continue;
        if (at - ref.mtimeMs > includeRecentMs) continue;
        const session = ensure(sessionId);
        session.transcript = ref.path;
        session.lastActivityAt = new Date(ref.mtimeMs).toISOString();
        session.state = "dead";
        session.stateSource = "transcript";
      }

      const sessions: DaemonSession[] = [];
      for (const session of byId.values()) {
        if (!session.alive && session.name === null && session.transcript === null) continue;
        const path = session.transcript ?? transcriptsNow.get(session.sessionId)?.path;
        if (path !== undefined) {
          session.transcript = path;
          const gate = gateStateFor(path);
          session.rounds = readRounds(gate);
          session.gateStateFound = gate !== undefined;
          session.unmet = readUnmet(gate);
          if (session.cwd === "") {
            const head = readFileHead(path, 64 * 1024);
            if (head !== undefined) session.cwd = cwdFromHeadLine(head) ?? session.cwd;
          }
        }
        if (session.cwd === "" && session.repo !== "") session.cwd = session.repo;
        if (session.repo === "" && session.cwd !== "") session.repo = session.cwd;
        session.branch = session.cwd === "" ? null : branch(session.cwd);
        if (session.lastActivityAt !== null && session.heartbeatAt !== null && session.heartbeatAt > session.lastActivityAt) {
          session.lastActivityAt = session.heartbeatAt;
        }
        sessions.push(session);
      }

      sessions.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
      const trimmed = sessions.slice(0, limit);
      if (sessions.length > trimmed.length) problems.push(`会话多于 ${limit} 条，只返回最近 ${limit} 条`);
      // PRUNE TO WHAT THIS WALK TOUCHED (see the maps' declaration): a resident
      // daemon must not accumulate one entry per transcript it has ever seen.
      for (const key of gateStates.keys()) if (!touchedGateState.has(key)) gateStates.delete(key);
      for (const key of branches.keys()) if (!touchedBranches.has(key)) branches.delete(key);
      const value: SessionCollection = { now: new Date(at).toISOString(), tmuxReadable, sessions: trimmed, problems };
      cached = { key: cacheKey, at, value };
      return value;
    },

    transcriptFor(sessionId: string): string | undefined {
      return transcripts().get(sessionId)?.path;
    },

    outputFor(sessionId: string, count: number): OutputEntry[] {
      const path = this.transcriptFor(sessionId);
      return path === undefined ? [] : readRecentEntries(path, count);
    },
  };
}

/** The `cwd` a session was started in, from the FIRST line of its transcript. */
function cwdFromHeadLine(line: string): string | undefined {
  try {
    const record = JSON.parse(line) as { type?: unknown; cwd?: unknown };
    return record.type === "session" && typeof record.cwd === "string" && record.cwd !== "" ? record.cwd : undefined;
  } catch {
    return undefined;
  }
}
