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

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  buildUserNotifyMessage,
  emptyNotifyHistory,
  normalizeNotifyHistory,
  notifyKey,
  sanitizeNotifyText,
  NOTIFY_BODY_MAX,
  NOTIFY_DEDUP_MS,
  NOTIFY_RATE_MAX,
  NOTIFY_RATE_WINDOW_MS,
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
  /**
   * The MACHINE-READABLE verdict, because `claimed:false` alone is ambiguous:
   *
   *   "claimed"   — you are the one; send it
   *   "duplicate" — this exact fact was already sent inside the dedup window
   *   "throttled" — too many notifications recently (a DIFFERENT limit)
   *
   * A caller that reads only the boolean cannot tell "somebody already told the
   * user" from "nobody did, but stop" — which is why the word is here and the
   * prose is only prose.
   */
  status: "claimed" | "duplicate" | "throttled";
  firstSeenAt: string;
  count: number;
  /** Present when the answer is `claimed: false`. */
  reason?: string;
}

export interface NotificationStore {
  claim(input: { key: string; kind: string; sessionId: string; name?: string | null; title: string; body: string }): NotificationClaim;
  list(opts?: { sinceMs?: number; limit?: number }): NotificationEntry[];
}

/**
 * The notification ledger as a DIRECTORY, not one JSON document.
 *
 *     <dir>/claims/<sha256(key)>.json   one file per key: who claimed it, when
 *     <dir>/history.jsonl               append-only: one line per SENT claim
 *
 * WHY IT IS NOT ONE FILE (quality round P2, 2026-10-01). A single document made
 * every claim a read-modify-write of the WHOLE ledger: two processes claiming
 * different keys each read the same snapshot and the later write dropped the
 * other's entry, and locking the whole document turned one key's claim into
 * another key's refusal — a notification nobody would ever send. Here the
 * per-key decision is `link(2)` on that key's own file (atomic and exclusive by
 * construction, no lock at all), and the history is an APPEND, which cannot lose
 * another writer's line.
 */
export function createNotificationStore(dir: string, deps: { now?: () => number } = {}): NotificationStore {
  const now = deps.now ?? ((): number => Date.now());
  const claimsDir = join(dir, "claims");
  const historyPath = join(dir, "history.jsonl");

  const claimPathFor = (key: string): string =>
    join(claimsDir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);

  /** This key's last claim, or undefined when it has none / is unreadable. */
  function readClaim(key: string): NotificationEntry | undefined {
    try {
      const raw = JSON.parse(readFileSync(claimPathFor(key), "utf8")) as NotificationEntry;
      return typeof raw?.at === "string" && typeof raw.key === "string" ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  /** How many notifications went out inside the gate's own rate window. */
  function recentSends(at: number): number {
    let text: string;
    try {
      text = readFileSync(historyPath, "utf8");
    } catch {
      return 0;
    }
    let count = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const stamp = (JSON.parse(line) as { at?: unknown }).at;
        if (typeof stamp === "string" && at - Date.parse(stamp) < NOTIFY_RATE_WINDOW_MS) count += 1;
      } catch { /* a torn line is one lost count, never a failed read */ }
    }
    return count;
  }

  return {
    claim(input) {
      const at = now();
      const existing = readClaim(input.key);
      const firstSeenAt = existing?.firstSeenAt ?? new Date(at).toISOString();
      if (existing !== undefined && at - Date.parse(existing.at) < NOTIFY_DEDUP_MS) {
        const waitS = Math.ceil((NOTIFY_DEDUP_MS - (at - Date.parse(existing.at))) / 1000);
        return {
          claimed: false,
          status: "duplicate",
          firstSeenAt,
          count: existing.count,
          reason: `同样的通知 ${Math.round(NOTIFY_DEDUP_MS / 60000)} 分钟内已发过，还需等待约 ${waitS}s`,
        };
      }
      if (recentSends(at) >= NOTIFY_RATE_MAX) {
        return {
          claimed: false,
          status: "throttled",
          firstSeenAt,
          count: existing?.count ?? 0,
          reason: `通知频率超限（${NOTIFY_RATE_WINDOW_MS / 60000} 分钟内最多 ${NOTIFY_RATE_MAX} 条）`,
        };
      }
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
      // ONE WINNER PER KEY WITHOUT A LOCK: the claim file appears atomically
      // (temp + `link(2)`), and a name that already exists means somebody beat
      // us to it in this same instant. Their own `at` cannot have been inside
      // this key's dedup window (the read above would have said so), so the
      // honest answer is "they are sending it" rather than "it was sent".
      let won = false;
      try {
        mkdirSync(claimsDir, { recursive: true });
        const tmp = `${claimPathFor(input.key)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
        writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { flag: "wx", mode: 0o600 });
        try {
          if (existing !== undefined) {
            // A STALE CLAIM IS REPLACED, not linked over: `link` would answer
            // EEXIST against the key's OWN old file and the fact could never be
            // sent again after the dedup window (the bug this branch exists
            // for). A rename is atomic, and the only loser of a concurrent
            // re-claim is one duplicate banner on a fact that was already old
            // enough to repeat.
            renameSync(tmp, claimPathFor(input.key));
            won = true;
          } else {
            linkSync(tmp, claimPathFor(input.key));
            won = true;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        } finally {
          rmSync(tmp, { force: true });
        }
      } catch { /* best effort: a failed write costs one duplicate banner */ }
      if (!won) {
        const winner = readClaim(input.key);
        return {
          claimed: false,
          status: "duplicate",
          firstSeenAt: winner?.firstSeenAt ?? firstSeenAt,
          count: winner?.count ?? 0,
          reason: "这条通知刚被另一个调用方在同一瞬间声明 —— 由它来发",
        };
      }
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(historyPath, `${JSON.stringify({ at: entry.at, key: input.key })}\n`, "utf8");
      } catch { /* the rate limit loses one count; the banner is already the caller's */ }
      prune(at);
      return { claimed: true, status: "claimed", firstSeenAt, count: entry.count };
    },

    list(opts = {}) {
      const at = now();
      const since = opts.sinceMs ?? at - NOTIFICATION_HISTORY_MS;
      const limit = opts.limit ?? 100;
      let files: string[];
      try {
        files = readdirSync(claimsDir);
      } catch {
        return [];
      }
      const entries: NotificationEntry[] = [];
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(readFileSync(join(claimsDir, file), "utf8")) as NotificationEntry;
          if (typeof raw?.at !== "string" || typeof raw.key !== "string") continue;
          if (Date.parse(raw.at) >= since) entries.push(raw);
        } catch { /* an unreadable claim is one missing row, never a failed read */ }
      }
      entries.sort((a, b) => a.at.localeCompare(b.at));
      return entries.slice(-limit);
    },
  };

  /**
   * Drop what no consumer can still ask about: claims older than the history
   * window (the ledger is read for that long) and history lines outside the rate
   * window (older ones can suppress nothing). Cheap, and it runs only on a
   * claim — a resident daemon must not grow one file per banner forever.
   */
  function prune(at: number): void {
    try {
      for (const file of readdirSync(claimsDir)) {
        if (!file.endsWith(".json")) continue;
        const path = join(claimsDir, file);
        try {
          const raw = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown };
          const stamp = typeof raw?.at === "string" ? Date.parse(raw.at) : Number.NaN;
          if (Number.isFinite(stamp) && at - stamp > NOTIFICATION_HISTORY_MS) rmSync(path, { force: true });
        } catch { /* leave an unreadable file alone rather than guessing */ }
      }
      const kept = readFileSync(historyPath, "utf8")
        .split("\n")
        .filter((line) => {
          if (line.trim() === "") return false;
          try {
            const stamp = (JSON.parse(line) as { at?: unknown }).at;
            return typeof stamp === "string" && at - Date.parse(stamp) < NOTIFY_RATE_WINDOW_MS;
          } catch {
            return false;
          }
        });
      writeFileSync(historyPath, kept.length === 0 ? "" : `${kept.join("\n")}\n`, { mode: 0o600 });
    } catch { /* pruning is housekeeping, never a reason to fail a claim */ }
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
