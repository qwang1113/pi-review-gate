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
 *      throttling (`decideNotify` / `notifyKey` / `NOTIFY_DEDUP_MS` /
 *      `NOTIFY_RATE_WINDOW_MS`, lib/user-notify.ts) is called — this module only
 *      supplies the history that rule reads (this key's claim file plus the
 *      recent sends) and records the outcome per key, so the terminal notifier
 *      and the menu-bar app still make the same decision from the same key.
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
import { appendFileSync, chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  buildUserNotifyMessage,
  decideNotify,
  notifyKey,
  sanitizeNotifyText,
  NOTIFY_BODY_MAX,
  NOTIFY_DEDUP_MS,
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

/** How long the store keeps a claim around for `GET /api/notifications`. */
export const NOTIFICATION_HISTORY_MS = 24 * 60 * 60 * 1_000;

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
  /** Why the answer is what it is — present on every non-trivial verdict, including a fail-open `claimed: true`. */
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

  /** The timestamps of the notifications sent inside the gate's rate window. */
  function recentSends(at: number): number[] {
    let text: string;
    try {
      text = readFileSync(historyPath, "utf8");
    } catch {
      return [];
    }
    const stamps: number[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const stamp = (JSON.parse(line) as { at?: unknown }).at;
        if (typeof stamp === "string") {
          const ms = Date.parse(stamp);
          if (Number.isFinite(ms) && at - ms < NOTIFY_RATE_WINDOW_MS) stamps.push(ms);
        }
      } catch { /* a torn line is one lost count, never a failed read */ }
    }
    return stamps;
  }

  return {
    claim(input) {
      const at = now();
      const existing = readClaim(input.key);
      const firstSeenAt = existing?.firstSeenAt ?? new Date(at).toISOString();
      // THE RULE IS THE GATE'S OWN (lib/user-notify.ts `decideNotify`): this
      // store only supplies the history it reads — this key's last claim plus
      // the recent send times — so the dedup window and the rate limit can
      // never drift from what the terminal notifier applies.
      const history: NotifyHistory = {
        sentAt: recentSends(at),
        lastByKey: existing === undefined ? {} : { [input.key]: Date.parse(existing.at) },
      };
      const decision = decideNotify({ history, key: input.key, now: at });
      if (!decision.send) {
        const inDedupWindow = existing !== undefined && at - Date.parse(existing.at) < NOTIFY_DEDUP_MS;
        return {
          claimed: false,
          status: inDedupWindow ? "duplicate" : "throttled",
          firstSeenAt,
          count: existing?.count ?? 0,
          reason: decision.reason,
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
      // (temp + `link(2)`), and EEXIST means somebody beat us to it in this same
      // instant — they are sending it, so it is a duplicate.
      //
      // ANY OTHER FAILURE IS FAIL-OPEN (reviewer P1, 2026-10-01): a ledger that
      // cannot be written (a read-only home, ENOSPC) must not answer
      // `duplicate`, because the contract for that word is "do not send" — the
      // notification would vanish and nobody would ever hear about it. Reporting
      // the claim as won costs at most a duplicate banner on the next retry,
      // which is the direction this module promises.
      let won = false;
      let lostToWriter = false;
      try {
        mkdirSync(claimsDir, { recursive: true });
        const tmp = `${claimPathFor(input.key)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
        writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { flag: "wx", mode: 0o600 });
        try {
          if (existing !== undefined) {
            // A STALE CLAIM IS REPLACED, not linked over: `link` would answer
            // EEXIST against the key's OWN old file and the fact could never be
            // sent again after the dedup window. A rename is atomic, and the
            // only loser of a concurrent re-claim is one duplicate banner on a
            // fact that was already old enough to repeat.
            renameSync(tmp, claimPathFor(input.key));
            won = true;
          } else {
            linkSync(tmp, claimPathFor(input.key));
            won = true;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") lostToWriter = true;
          else throw error;
        } finally {
          rmSync(tmp, { force: true });
        }
      } catch { /* fail-open below: a ledger write failure never silences */ }
      if (lostToWriter) {
        const winner = readClaim(input.key);
        return {
          claimed: false,
          status: "duplicate",
          firstSeenAt: winner?.firstSeenAt ?? firstSeenAt,
          count: winner?.count ?? 0,
          reason: "这条通知刚被另一个调用方在同一瞬间声明 —— 由它来发",
        };
      }
      if (!won) {
        // Say it plainly: this caller is the one that must send it.
        return {
          claimed: true,
          status: "claimed",
          firstSeenAt,
          count: entry.count,
          reason: "通知台账写不进去（只读 home / 磁盘满）—— 按 fail-open 处理：本条由你来发",
        };
      }
      try {
        mkdirSync(dir, { recursive: true });
        // 0600 at CREATION, and `prune` re-asserts it: each line here is a
        // notification key, which is the rendered title+body (session names,
        // task names) — not something for every user on the machine (reviewer
        // P2, 2026-10-01).
        appendFileSync(historyPath, `${JSON.stringify({ at: entry.at, key: input.key })}\n`, { mode: 0o600 });
        chmodSync(historyPath, 0o600);
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
        if (notifiable) {
          const kind = previous.state !== session.state ? notificationKindFor(session.state) : undefined;
          if (kind !== undefined) {
            const where = session.name === null ? session.sessionId : `@${session.name}`;
            notify(session, kind, kind === "needs-user" ? `${where} 正在等你回答。` : `${where} 已完成。`);
          } else if (previous.alive && !session.alive && previous.state !== "done") {
            // AN EXIT IS ITS OWN TRANSITION (review round 1, 2026-10-01). The
            // state word and liveness flip on DIFFERENT polls: `working → idle`
            // is not news, and `alive` only goes true → false on a LATER tick —
            // which carries no state change to speak for it. With this branch
            // nested under the state guard, the contract's own `exited` event
            // (docs/daemon/api.md §8.2) was unreachable on the ordinary path
            // (measured: zero notifications while the session died in place).
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
