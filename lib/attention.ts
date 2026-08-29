/**
 * DIRECTED parent attention — a child session wakes the session that STARTED it.
 *
 * WHY NOT A BROADCAST (user requirement, round-18). The previous design signalled
 * one well-known channel (`rg-user-attention`) that EVERY session listened on, so
 * an unrelated session's goal dialog interrupted whoever happened to be working —
 * measured: `nvim(@1) onchain：等待回答提问` landing in a session that had no
 * relationship to it whatsoever. A wake-up is only ever meaningful for the ONE
 * session that is responsible for the waiting child, so addressing is now
 * explicit:
 *
 *  - the parent stamps its own session id into the child's environment
 *    (`RG_PARENT_SESSION`) when it spawns it;
 *  - the child publishes to `rg-attention-<parentSessionId>` and nowhere else;
 *  - every session listens on ITS OWN channel only;
 *  - a session with no parent publishes NOTHING (status "no-parent") — a
 *    standalone session can never wake anybody.
 *
 * NO SYSTEM NOTIFICATIONS. macOS `osascript` banners are gone entirely (user
 * requirement): the wake message in the parent's transcript is the whole channel.
 *
 * The payload still rides a side-channel FILE because a tmux signal carries no
 * data. The file is global (`~/.pi/agent/…`) so a parent in another repo can read
 * an event addressed to it, and every event names both endpoints, so a consumer
 * takes only what is addressed to itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { homedir } from "node:os";

/** Environment variable carrying the SPAWNING session's id into a child. */
export const PARENT_SESSION_ENV = "RG_PARENT_SESSION";

/**
 * The channel a session listens on / a child signals. Derived from the TARGET
 * session id, so two sessions can never share one bell.
 */
export function attentionChannelFor(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return `rg-attention-${safe}`;
}

/** The parent session id this process was started by, if any. */
export function parentSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[PARENT_SESSION_ENV]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/**
 * An UNHANDLED (repo, reason) is published at most once per window. Once a
 * listener has consumed the event, a new publish is allowed immediately — by
 * design: the spam this throttle exists to stop is the same unanswered request
 * ringing over and over, and a consumed event means somebody was already told.
 */
export const ATTENTION_THROTTLE_MS = 60_000;
/** An unhandled event stops waking anybody after this long. */
export const ATTENTION_TTL_MS = 10 * 60_000;
/** Only the newest events are kept in the state file. */
export const ATTENTION_KEEP = 20;

export interface AttentionEvent {
  id: string;
  fromSessionId: string;
  /** The session this event is ADDRESSED to (the parent). */
  toSessionId: string;
  fromPane?: string;
  /** Human-facing origin label, e.g. `tmax(@365)`. */
  fromWindow?: string;
  repo: string;
  reason: string;
  createdAt: string;
  handledAt?: string;
}

export interface AttentionInput {
  fromSessionId: string;
  /** Parent session id; absent ⇒ nothing is published. */
  toSessionId?: string;
  fromPane?: string;
  fromWindow?: string;
  repo: string;
  reason: string;
}

export interface AttentionDeps {
  now?: () => number;
  statePath?: string;
  readState?: () => string | undefined;
  writeState?: (raw: string) => void;
  signal?: (channel: string) => void;
  sideEffects?: () => boolean;
}

export type PublishStatus = "sent" | "throttled" | "disabled" | "no-parent";

/**
 * One gate for every external side effect. Tests and non-interactive hosts
 * (headless `pi -p`, CI, a piped stdout) must never fire a tmux signal: the P0
 * report measured real side effects escaping from test runs.
 */
export function sideEffectsEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean | undefined = process.stdout.isTTY,
): boolean {
  if (env.RG_NO_SIDE_EFFECTS === "1") return false;
  if (env.NODE_ENV === "test") return false;
  // Round-17 P2 (reviewer, measured): `node --test` does NOT set NODE_ENV — it
  // sets NODE_TEST_CONTEXT ("child-v8"/"top-level"), so the NODE_ENV branch
  // alone left test silence resting on the incidental isTTY check.
  if (env.NODE_TEST_CONTEXT) return false;
  if (env.CI) return false;
  return isTTY === true;
}

/** Global (cross-repo) state file. */
export function defaultStatePath(): string {
  return join(homedir(), ".pi", "agent", "review-gate-attention.json");
}

function loadEvents(deps: AttentionDeps): AttentionEvent[] {
  try {
    const raw = deps.readState
      ? deps.readState()
      : existsSync(deps.statePath ?? defaultStatePath())
      ? readFileSync(deps.statePath ?? defaultStatePath(), "utf8")
      : undefined;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { events?: AttentionEvent[] };
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

function saveEvents(events: AttentionEvent[], deps: AttentionDeps): void {
  const raw = JSON.stringify({ events: events.slice(-ATTENTION_KEEP) }, null, 2);
  try {
    if (deps.writeState) {
      deps.writeState(raw);
      return;
    }
    // Round-17 Nit (reviewer): write ATOMICALLY, through the shared helper.
    // Concurrent read-modify-writes overlap; a torn file used to parse as empty
    // and silently drop pending events.
    writeFileAtomic(deps.statePath ?? defaultStatePath(), raw);
  } catch {
    /* best-effort: attention is a convenience, never a gate */
  }
}

/** The wake text — origin + repo + reason, so the user knows where to go. */
export function attentionText(e: AttentionEvent): string {
  const origin = e.fromWindow ?? e.fromPane ?? e.fromSessionId.slice(0, 8);
  const repo = e.repo.split("/").filter(Boolean).pop() ?? e.repo;
  return `${origin} ${repo}：${e.reason}`;
}

/**
 * Record an attention event and ring the PARENT's bell. Returns what actually
 * happened so callers (and tests) can tell a throttled, disabled or
 * parent-less publish from a real one. Never throws: attention must not break
 * a dialog, and it is never a gate condition.
 */
export function publishAttention(input: AttentionInput, deps: AttentionDeps = {}): { status: PublishStatus; event?: AttentionEvent } {
  // No parent ⇒ nobody to tell. A standalone session stays silent instead of
  // waking unrelated sessions (the whole point of the directed rewrite).
  const parent = input.toSessionId?.trim();
  if (!parent) return { status: "no-parent" };
  const now = deps.now ? deps.now() : Date.now();
  const enabled = deps.sideEffects ? deps.sideEffects() : sideEffectsEnabled();
  if (!enabled) return { status: "disabled" };

  const events = loadEvents(deps);
  const recent = events.find(
    (e) =>
      e.repo === input.repo &&
      e.reason === input.reason &&
      e.toSessionId === parent &&
      !e.handledAt &&
      now - Date.parse(e.createdAt) < ATTENTION_THROTTLE_MS,
  );
  if (recent) return { status: "throttled", event: recent };

  const event: AttentionEvent = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    fromSessionId: input.fromSessionId,
    toSessionId: parent,
    fromPane: input.fromPane,
    fromWindow: input.fromWindow,
    repo: input.repo,
    reason: input.reason,
    createdAt: new Date(now).toISOString(),
  };
  saveEvents([...events, event], deps);

  try {
    (deps.signal ?? defaultSignal)(attentionChannelFor(parent));
  } catch { /* no listener is the normal case */ }
  return { status: "sent", event };
}

/**
 * The listener side: the newest event ADDRESSED TO US that is not ours, not
 * handled and not expired — marked handled as it is returned (so it wakes
 * exactly one session once). `undefined` means "stay silent and re-arm".
 */
export function consumeAttention(selfSessionId: string, deps: AttentionDeps = {}): AttentionEvent | undefined {
  const now = deps.now ? deps.now() : Date.now();
  const events = loadEvents(deps);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    // Directed delivery: an event addressed to somebody else is invisible.
    if (e.toSessionId !== selfSessionId) continue;
    if (e.fromSessionId === selfSessionId) continue;
    if (e.handledAt) continue;
    if (now - Date.parse(e.createdAt) > ATTENTION_TTL_MS) continue;
    const handled: AttentionEvent = { ...e, handledAt: new Date(now).toISOString() };
    events[i] = handled;
    saveEvents(events, deps);
    return handled;
  }
  return undefined;
}

function defaultSignal(_channel: string): void {
  // tmux wait-for is gone (2026-08-28, process-based judges). The event FILE
  // is the delivery: a parent session reads it on its own turn boundaries /
  // polling (consumeAttention). No signal, no wake — attention stays a
  // convenience, never a gate.
}
