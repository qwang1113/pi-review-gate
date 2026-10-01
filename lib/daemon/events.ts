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

import { basename, dirname } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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
  let loaded: StoreFile | undefined;

  function read(): StoreFile {
    if (loaded !== undefined) return loaded;
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
  }

  return {
    claim(input) {
      const at = now();
      const file = read();
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
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

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
   * Start following a session's transcript from ITS CURRENT END.
   *
   * Called by the SSE endpoint just before it registers a subscriber, so the
   * tail picks up exactly what the subscriber's own replay did not — without
   * it, an append landing between "subscribe" and the watcher's next tick was
   * read by nobody (the tailer's first sight of a file bookmarks it at its
   * end, which is by then already past the new bytes).
   */
  prime(sessionId: string): void;
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
      const notifiable = mayNotifyUser({
        taskMode: session.mode as TaskMode,
        stateVariant: session.kind === "child" ? "child" : undefined,
      });
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
      if (previous.alive && previous.state !== "done") {
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
    prime(sessionId: string) {
      const path = opts.observer.transcriptFor(sessionId);
      if (path !== undefined) tailer.prime(path);
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
