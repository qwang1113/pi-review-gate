/**
 * WHAT THE DAEMON PUSHES, AND WHAT IT REMEMBERS ABOUT WHAT WAS PUSHED.
 *
 * Three things live here because they are one conversation:
 *
 *   1. THE SSE HUB — subscribers, each watching either one session or all of
 *      them. It is transport-agnostic on purpose (it hands a plain
 *      {@link DaemonEvent} to a writer); the HTTP half lives in lib/daemon/server.ts.
 *   2. THE WATCHER — one poll of the session observer per second, turned into
 *      `session` / `output` / `notification` events by comparing against the
 *      previous poll. Nothing is invented: a state word comes from the observer,
 *      output comes from the transcript, and a notification is a STATE
 *      TRANSITION (entering `waiting-input`, reaching `done`, or an exit).
 *   3. THE NOTIFICATION STORE — the ledger a consumer asks before it sends a
 *      banner. Its dedupe rule is NOT re-implemented here: the gate's own
 *      throttling (`decideNotify` / `recordNotify` / `notifyKey`,
 *      lib/user-notify.ts) is called, so the terminal notifier and the menu-bar
 *      app make the same decision from the same key.
 *
 * ── WHY THE TITLE AND THE KEY ARE BUILT HERE, WITH THE GATE'S OWN HELPERS ──
 *
 * The whole point of the ledger is that two senders agree on what "the same
 * fact" is. `buildUserNotifyMessage` + `notifyKey` are exactly what the
 * terminal side already uses, so a banner the menu-bar app sends is recognised
 * by the terminal side — and vice versa — instead of each side inventing its
 * own identity for one notification.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  buildUserNotifyMessage,
  decideNotify,
  emptyNotifyHistory,
  normalizeNotifyHistory,
  notifyKey,
  recordNotify,
  sanitizeNotifyText,
  NOTIFY_BODY_MAX,
  NOTIFY_TITLE_MAX,
  type NotifyHistory,
  type UserNotifyKind,
} from "../user-notify.ts";
import type { TaskMode } from "../task-mode.ts";
import { mayNotifyUser } from "../user-notify.ts";
import type { ChildState } from "../orchestrator-child-state.ts";
import { TranscriptTailer, type OutputEntry } from "./transcript.ts";
import type { DaemonSession, SessionObserver } from "./sessions.ts";

export type DaemonEventName = "hello" | "session" | "output" | "notification" | "ping";

export interface DaemonEvent {
  event: DaemonEventName;
  data: unknown;
}

/** How long the store keeps an entry around for `GET /api/notifications`. */
export const NOTIFICATION_HISTORY_MS = 24 * 60 * 60 * 1_000;
/** Most entries the store keeps, newest last. */
export const NOTIFICATION_HISTORY_MAX = 500;

// ---------------------------------------------------------------------------
// SSE hub
// ---------------------------------------------------------------------------

export interface SseHub {
  /** Register a writer. `sessionId === null` means "every session". Returns the unregister. */
  add(send: (event: DaemonEvent) => void, sessionId: string | null): () => void;
  /** Send to every subscriber, or only to those watching `sessionId`. */
  emit(event: DaemonEvent, sessionId?: string | null): void;
  /** Sessions somebody is watching; `null` when at least one watches everything. */
  watched(): Set<string> | null;
  readonly subscribers: number;
}

export function createSseHub(): SseHub {
  const clients = new Map<number, { send: (event: DaemonEvent) => void; sessionId: string | null }>();
  let next = 1;
  return {
    add(send, sessionId) {
      const id = next++;
      clients.set(id, { send, sessionId });
      return () => { clients.delete(id); };
    },
    emit(event, sessionId) {
      for (const client of clients.values()) {
        if (sessionId !== undefined && sessionId !== null && client.sessionId !== null && client.sessionId !== sessionId) {
          continue;
        }
        try {
          client.send(event);
        } catch {
          // A dead socket closes itself on the next write attempt; a throwing
          // writer must not take the other subscribers (or the poll) with it.
        }
      }
    },
    watched() {
      const ids = new Set<string>();
      for (const client of clients.values()) {
        if (client.sessionId === null) return null;
        ids.add(client.sessionId);
      }
      return ids;
    },
    get subscribers() {
      return clients.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Notification store
// ---------------------------------------------------------------------------

export interface NotificationEntry {
  key: string;
  kind: string;
  sessionId: string;
  name: string | null;
  title: string;
  body: string;
  /** ISO of the most recent claim. */
  at: string;
  /** ISO of the first time this key was claimed. */
  firstSeenAt: string;
  count: number;
}

export interface NotificationClaim {
  claimed: boolean;
  firstSeenAt: string;
  count: number;
  /** Present when the answer is `claimed: false`. */
  reason?: string;
}

export interface NotificationStore {
  claim(input: { key: string; kind: string; sessionId: string; name?: string | null; title: string; body: string }): NotificationClaim;
  list(opts?: { sinceMs?: number; limit?: number }): NotificationEntry[];
}

interface StoreFile {
  schema: 1;
  history: NotifyHistory;
  entries: NotificationEntry[];
}

export function createNotificationStore(path: string, deps: { now?: () => number } = {}): NotificationStore {
  const now = deps.now ?? ((): number => Date.now());
  const claimDirs = join(dirname(path), "notification-claims");
  let loaded: StoreFile | undefined;
  let loadedAt = 0;

  /**
   * The ledger, re-read from disk when it may have moved on.
   *
   * `fresh` is REQUIRED for a claim (reviewer P1, 2026-10-01): the store is a
   * file that more than one process can write, and a claim decided against a
   * snapshot taken hours ago would drop every entry another writer appended in
   * between — the per-key lock serialises the write, but only a fresh read sees
   * what the last writer left. Readers (`list`) keep a short cache instead:
   * a menu-bar poll that is seconds behind is not a correctness problem.
   */
  function read(fresh = false): StoreFile {
    const at = now();
    if (!fresh && loaded !== undefined && at - loadedAt < LIST_TTL_MS) return loaded;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const entries = Array.isArray(raw.entries)
        ? raw.entries.filter((entry): entry is NotificationEntry =>
            !!entry && typeof entry === "object" && typeof (entry as NotificationEntry).key === "string")
        : [];
      loaded = { schema: 1, history: normalizeNotifyHistory(raw.history), entries };
    } catch {
      // An unreadable ledger means "no record of anything sent" — the direction
      // that can only ever produce one extra banner, never silence.
      loaded = { schema: 1, history: emptyNotifyHistory(), entries: [] };
    }
    loadedAt = at;
    return loaded;
  }

  function persist(file: StoreFile): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch {
      // The ledger is best effort: losing it costs one duplicate banner.
    }
    loaded = file;
    loadedAt = now();
  }

  return {
    claim(input) {
      // ONE LEDGER WRITER AT A TIME, ACROSS PROCESSES (reviewer P1/P2,
      // 2026-10-01). The claim is a read-modify-write of ONE file, so the lock
      // has to cover the WHOLE ledger, not one key: two processes claiming
      // different keys would otherwise each read the same snapshot and the
      // later write would drop the other's entry. Claims are rare, so
      // serialising all of them costs nothing.
      const guard = claimGuard(join(claimDirs, "ledger.lock"), now());
      if (guard.kind === "busy") {
        return { claimed: false, firstSeenAt: new Date(now()).toISOString(), count: 0, reason: guard.reason };
      }
      try {
        return decideAndRecord(input);
      } finally {
        guard.release();
      }
    },

    list(opts = {}) {
      const file = read();
      const since = opts.sinceMs ?? now() - NOTIFICATION_HISTORY_MS;
      const limit = opts.limit ?? 100;
      const entries = file.entries
        .filter((entry) => {
          const at = Date.parse(entry.at);
          return Number.isFinite(at) && at >= since;
        })
        .slice(-limit);
      return entries;
    },
  };

  /** The claim itself, under the per-key lock. */
  function decideAndRecord(input: {
    key: string;
    kind: string;
    sessionId: string;
    name?: string | null;
    title: string;
    body: string;
  }): NotificationClaim {
    const at = now();
    const file = read(true);
    const decision = decideNotify({ history: file.history, key: input.key, now: at });
    const existing = file.entries.find((entry) => entry.key === input.key);
    const firstSeenAt = existing?.firstSeenAt ?? new Date(at).toISOString();
    if (!decision.send) {
      return { claimed: false, firstSeenAt, count: existing?.count ?? 0, reason: decision.reason };
    }
    const history = recordNotify(file.history, input.key, at);
    const entry: NotificationEntry = {
      key: input.key,
      kind: input.kind,
      sessionId: input.sessionId,
      name: input.name ?? null,
      title: sanitizeNotifyText(input.title, NOTIFY_TITLE_MAX),
      body: sanitizeNotifyText(input.body, NOTIFY_BODY_MAX),
      at: new Date(at).toISOString(),
      firstSeenAt,
      count: (existing?.count ?? 0) + 1,
    };
    const entries = [...file.entries.filter((candidate) => candidate.key !== input.key), entry]
      .filter((candidate) => at - Date.parse(candidate.at) < NOTIFICATION_HISTORY_MS)
      .slice(-NOTIFICATION_HISTORY_MAX);
    persist({ schema: 1, history, entries });
    return { claimed: true, firstSeenAt, count: entry.count };
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

/**
 * MAY A TRANSITION IN THIS SESSION RAISE A BANNER AT ALL?
 *
 * One reading of one rule (`mayNotifyUser`, lib/user-notify.ts): a child asks
 * its manager, and a judge or a worker is nobody's news. It lives here as a
 * function because THREE transitions ask it — entering `waiting-input`, reaching
 * `done`, and the session disappearing — and a second, hand-rolled reading for
 * the last one would be a second answer to "who may notify the human"
 * (2026-10-01, quality round).
 */
function notifiableFor(session: { mode: string; kind: string | null }): boolean {
  return mayNotifyUser({
    taskMode: session.mode as TaskMode,
    stateVariant: session.kind === "child" ? "child" : undefined,
  });
}

/** How long a READ of the ledger may be reused (a claim always re-reads). */
const LIST_TTL_MS = 5_000;

/** How long a claim lock may live before anyone may take it over. */
export const CLAIM_LOCK_STALE_MS = 30_000;

type ClaimGuard = { kind: "held"; release: () => void } | { kind: "busy"; reason: string };

/**
 * The lock a claim runs under: an `O_EXCL` file, removed in a `finally`.
 *
 * A lock left behind by a crash is TAKEN OVER once it is older than
 * {@link CLAIM_LOCK_STALE_MS} — otherwise one killed process would refuse every
 * claim forever, and a notification nobody could ever send is worse than one
 * sent twice.
 */
function claimGuard(lockPath: string, at: number): ClaimGuard {
  const take = (): boolean => {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, `${at}`, { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  if (take()) return { kind: "held", release: () => { rmSync(lockPath, { force: true }); } };

  let heldAt = Number.NaN;
  try {
    heldAt = Number(readFileSync(lockPath, "utf8"));
  } catch {
    heldAt = Number.NaN; // it vanished between the create and the read
  }
  if (Number.isFinite(heldAt) && at - heldAt < CLAIM_LOCK_STALE_MS) {
    return { kind: "busy", reason: "通知台账正被另一个调用方写入 —— 同一条通知同时只能有一个赢家，请重试" };
  }
  try {
    rmSync(lockPath, { force: true });
  } catch { /* the loser of the takeover race reports busy below */ }
  if (take()) return { kind: "held", release: () => { rmSync(lockPath, { force: true }); } };
  return { kind: "busy", reason: "通知台账正被另一个调用方写入 —— 同一条通知同时只能有一个赢家，请重试" };
}

/** The event kind a state transition deserves, or none. */
export function notificationKindFor(state: ChildState): UserNotifyKind | undefined {
  if (state === "waiting-input") return "needs-user";
  if (state === "done") return "finished";
  return undefined;
}

export interface SessionWatcherOptions {
  observer: SessionObserver;
  hub: SseHub;
  intervalMs?: number;
  now?: () => number;
  onError?: (message: string) => void;
}

export interface SessionWatcher {
  tick(): void;
  start(): void;
  stop(): void;
  /**
   * Start following a session's transcript, if nobody is following it yet.
   *
   * Called by the SSE endpoint for EVERY subscription — `replay=0` means "do not
   * send me the past", not "do not bookmark anything": without a bookmark, an
   * append landing between the subscription and the watcher's next tick was read
   * by nobody (2026-10-01, quality round). `offset` is where the subscriber's own
   * replay stopped, so the tail resumes exactly there.
   */
  prime(sessionId: string, offset?: number): void;
}

/** The transient facts the next poll compares against. */
interface Known {
  state: ChildState;
  name: string | null;
  alive: boolean;
  repo: string;
  mode: string;
  kind: string | null;
}

export function createSessionWatcher(opts: SessionWatcherOptions): SessionWatcher {
  const intervalMs = opts.intervalMs ?? 1_000;
  const seen = new Map<string, Known>();
  const tailer = new TranscriptTailer();
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  function notify(
    target: { sessionId: string; name: string | null; repo: string },
    kind: UserNotifyKind,
    detail: string,
  ): void {
    const { title, body } = buildUserNotifyMessage({
      kind,
      repoName: basename(target.repo || ""),
      detail,
    });
    opts.hub.emit({
      event: "notification",
      data: {
        key: notifyKey(title, body),
        kind: kind === "needs-user" ? "waiting-input" : kind === "finished" ? "done" : "exited",
        sessionId: target.sessionId,
        name: target.name,
        repo: target.repo,
        title,
        body,
        at: new Date(opts.now?.() ?? Date.now()).toISOString(),
      },
    }, target.sessionId);
  }

  function tick(): void {
    let collection;
    try {
      collection = opts.observer.collect();
    } catch (error) {
      opts.onError?.(`采集会话失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const watched = opts.hub.watched();
    const present = new Set<string>();
    for (const session of collection.sessions) {
      present.add(session.sessionId);
      const previous = seen.get(session.sessionId);
      const known: Known = {
        state: session.state,
        name: session.name,
        alive: session.alive,
        repo: session.repo,
        mode: session.mode,
        kind: session.kind,
      };
      // A notification only ever follows a TRANSITION, and only for sessions the
      // gate itself would raise a banner for: a child, a judge or a worker asks
      // its manager, not the human (lib/user-notify.ts `mayNotifyUser` — the
      // same predicate, not a second reading of it).
      const notifiable = notifiableFor(session);
      if (previous === undefined) {
        seen.set(session.sessionId, known);
        if (session.alive) opts.hub.emit({ event: "session", data: { kind: "added", session } }, session.sessionId);
      } else if (previous.state !== session.state || previous.name !== session.name || previous.alive !== session.alive) {
        seen.set(session.sessionId, known);
        opts.hub.emit({ event: "session", data: { kind: "updated", session } }, session.sessionId);
        if (notifiable && previous.state !== session.state) {
          const kind = notificationKindFor(session.state);
          if (kind !== undefined) {
            const where = session.name === null ? session.sessionId : `@${session.name}`;
            notify(session, kind, kind === "needs-user" ? `${where} 正在等你回答。` : `${where} 已完成。`);
          } else if (previous.alive && !session.alive && previous.state !== "done") {
            notify(session, "failed", `${session.name === null ? session.sessionId : `@${session.name}`} 异常结束。`);
          }
        }
      }
      if (watched === null || watched.has(session.sessionId)) {
        const path = opts.observer.transcriptFor(session.sessionId);
        if (path !== undefined) {
          const entries: OutputEntry[] = tailer.read(path);
          if (entries.length > 0) {
            opts.hub.emit({ event: "output", data: { sessionId: session.sessionId, entries } }, session.sessionId);
          }
        }
      }
    }
    for (const [sessionId, previous] of seen) {
      if (present.has(sessionId)) continue;
      seen.delete(sessionId);
      opts.hub.emit({ event: "session", data: { kind: "removed", sessionId } }, sessionId);
      if (previous.alive && previous.state !== "done" && notifiableFor(previous)) {
        notify(
          { sessionId, name: previous.name, repo: previous.repo },
          "failed",
          `${previous.name === null ? sessionId : `@${previous.name}`} 异常结束。`,
        );
      }
    }
  }

  return {
    tick,
    prime(sessionId: string, offset?: number) {
      const path = opts.observer.transcriptFor(sessionId);
      if (path !== undefined) tailer.prime(path, offset);
    },
    start() {
      if (timer !== undefined) return;
      tick();
      timer = setInterval(() => {
        if (running) return;
        running = true;
        try {
          tick();
        } finally {
          running = false;
        }
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
