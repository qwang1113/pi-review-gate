/**
 * Cross-session user-attention events (round-17 P0).
 *
 * A `tmux wait-for` signal is an UNADDRESSED GLOBAL BROADCAST with no payload:
 * the sender listens on the same channel, so it woke ITSELF in a loop while the
 * message claimed "another session needs you", and the macOS notification —
 * fired per event with no identity, no throttle and no environment guard —
 * piled up 10+ identical banners (both measured from user screenshots).
 *
 * The fix separates the BELL from the EVENT:
 *  - the tmux signal stays a content-free bell;
 *  - the event itself is written to a side-channel file (id, originating
 *    session/pane/window, repo, reason, timestamps);
 *  - the listener reads the payload and IGNORES its own events (no self-wake),
 *    events already handled, and events past their TTL;
 *  - the same (repo, reason) is published at most once per throttle window;
 *  - every external side effect (tmux signal + osascript) goes through
 *    `sideEffectsEnabled()`, so tests and non-interactive hosts stay silent.
 *
 * The state file is GLOBAL, not per-repo: the whole point is that a session in
 * ANOTHER repo can see the event, which a `<repo>/.pi/` file could not deliver.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic-write.ts";
import { homedir } from "node:os";

/** The well-known bell channel. Content-free by design — payload is in the file. */
export const ATTENTION_CHANNEL = "rg-user-attention";
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
  notify?: (title: string, body: string) => void;
  sideEffects?: () => boolean;
}

export type PublishStatus = "sent" | "throttled" | "disabled";

/**
 * One gate for every external side effect. Tests and non-interactive hosts
 * (headless `pi -p`, CI, a piped stdout) must never fire osascript or a tmux
 * signal: the P0 report measured real notifications escaping from test runs.
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
  if (!env.TMUX) return false;
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
    // The bell wakes every listener at once, so concurrent read-modify-writes
    // overlap; a torn file used to parse as empty and silently drop pending
    // events. (A duplicate wake remains possible — acceptable for a
    // convenience channel; losing events was not.)
    writeFileAtomic(deps.statePath ?? defaultStatePath(), raw);
  } catch {
    /* best-effort: attention is a convenience, never a gate */
  }
}

/** The wake/notification text — origin + repo + reason, so the user knows where to go. */
export function attentionText(e: AttentionEvent): string {
  const origin = e.fromWindow ?? e.fromPane ?? e.fromSessionId.slice(0, 8);
  const repo = e.repo.split("/").filter(Boolean).pop() ?? e.repo;
  return `${origin} ${repo}：${e.reason}`;
}

/**
 * Record an attention event and ring the bell. Returns what actually happened
 * so callers (and tests) can tell a throttled or disabled publish from a real
 * one. Never throws: attention must not break a dialog.
 */
export function publishAttention(input: AttentionInput, deps: AttentionDeps = {}): { status: PublishStatus; event?: AttentionEvent } {
  const now = deps.now ? deps.now() : Date.now();
  const enabled = deps.sideEffects ? deps.sideEffects() : sideEffectsEnabled();
  if (!enabled) return { status: "disabled" };

  const events = loadEvents(deps);
  const recent = events.find(
    (e) =>
      e.repo === input.repo &&
      e.reason === input.reason &&
      !e.handledAt &&
      now - Date.parse(e.createdAt) < ATTENTION_THROTTLE_MS,
  );
  if (recent) return { status: "throttled", event: recent };

  const event: AttentionEvent = {
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    fromSessionId: input.fromSessionId,
    fromPane: input.fromPane,
    fromWindow: input.fromWindow,
    repo: input.repo,
    reason: input.reason,
    createdAt: new Date(now).toISOString(),
  };
  saveEvents([...events, event], deps);

  const text = attentionText(event);
  try {
    (deps.signal ?? defaultSignal)(ATTENTION_CHANNEL);
  } catch { /* no listener is the normal case */ }
  try {
    (deps.notify ?? defaultNotify)(`review-gate · ${event.fromWindow ?? "pi"}`, text);
  } catch { /* non-macOS or no osascript */ }
  return { status: "sent", event };
}

/**
 * The listener side: the newest event that is NOT ours, NOT handled and NOT
 * expired — marked handled as it is returned (so it wakes exactly one session
 * once). `undefined` means "stay silent and re-arm": that is what kills the
 * self-wake loop the P0 report measured.
 */
export function consumeAttention(selfSessionId: string, deps: AttentionDeps = {}): AttentionEvent | undefined {
  const now = deps.now ? deps.now() : Date.now();
  const events = loadEvents(deps);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
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

function defaultSignal(channel: string): void {
  execFileSync("tmux", ["wait-for", "-S", channel], { stdio: "ignore", timeout: 5_000 });
}

function defaultNotify(title: string, body: string): void {
  const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
  execFileSync("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], {
    stdio: "ignore",
    timeout: 5_000,
  });
}
