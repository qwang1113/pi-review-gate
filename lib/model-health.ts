/**
 * WHEN A MODEL SLOT IS BAD — the memory the next dispatch reads.
 *
 * A judge pane runs ONE model (one pi process, one `--model`). The role's
 * chain in `agents.<role>.slots` was rendered into the agent frontmatter and
 * then forgotten at dispatch time: `slots[0]` went out, and when that
 * provider answered 503 for hours nothing moved to `slots[1]` (measured
 * 2026-09-10 in rebate: 25 failing requests, an audit round that could not
 * end, and a user hand-switching the model in the pane).
 *
 * TWO HALVES FIX THAT, and this module is the second one:
 *   - the PANE rotates in-round (lib/judge-model-rotation.ts), because it is
 *     the only place that sees its own provider errors;
 *   - the OPENER remembers which spec failed (HERE) and dispatches the next
 *     round on the first slot that is not cooling down. Without this half the
 *     rotation would be undone at the next dispatch, which always starts the
 *     pane on the chain head.
 *
 * Keyed by `provider/id` WITHOUT the thinking suffix: `onekey/gpt-6-astra:xhigh`
 * and `onekey/gpt-6-astra:high` are the same model failing the same way, and a
 * key that changes when a user edits a slot's thinking level would forget what
 * it learned.
 *
 * Pure: no clock, no filesystem — every fact is injected, which is what makes
 * the cooldown rule testable.
 */

import { splitThinkingSuffix } from "./model-config.ts";

/** How long a failed model stays out of the dispatch's first choice. */
export const MODEL_FAILURE_TTL_MS = 10 * 60 * 1000;

/** Cap on remembered failures — a config full of dead ids must not grow without bound. */
export const MAX_MODEL_HEALTH_ENTRIES = 32;

/** One model's last failure, as the opener recorded it. */
export interface ModelFailure {
  /** Epoch ms of the failure that was REPORTED (never a local clock reading). */
  at: number;
  /** Short reason, for the receipt. */
  error?: string;
}

/** provider/id → its last failure. */
export type ModelHealth = Record<string, ModelFailure>;

/** The health key of one slot spec: provider/id, thinking suffix dropped. */
export function modelKeyOf(spec: string): string {
  return splitThinkingSuffix(spec.trim()).base;
}

/**
 * Drop failures older than the TTL — and, if the cap is still exceeded, the
 * oldest entries first. Called on every write, so the file cannot rot.
 */
export function pruneModelHealth(
  health: ModelHealth,
  now: number,
  ttlMs: number = MODEL_FAILURE_TTL_MS,
): ModelHealth {
  const live = Object.entries(health).filter(([, f]) => now - f.at < ttlMs);
  if (live.length <= MAX_MODEL_HEALTH_ENTRIES) return Object.fromEntries(live);
  live.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(live.slice(0, MAX_MODEL_HEALTH_ENTRIES));
}

/** Record one failure and prune. Returns a NEW map (never mutates the input). */
export function recordModelFailure(
  health: ModelHealth,
  spec: string,
  now: number,
  error?: string,
  ttlMs: number = MODEL_FAILURE_TTL_MS,
): ModelHealth {
  const next: ModelHealth = { ...pruneModelHealth(health, now, ttlMs) };
  next[modelKeyOf(spec)] = { at: now, ...(error ? { error } : {}) };
  return pruneModelHealth(next, now, ttlMs);
}

/**
 * Forget one model's failure — it just worked again.
 *
 * A rotation that SUCCEEDED is proof the new slot is reachable, so it must not
 * stay benched by an older failure: a stale entry would keep the dispatch off
 * a working model for the rest of the TTL.
 */
export function clearModelFailure(
  health: ModelHealth,
  spec: string,
  now: number,
  ttlMs: number = MODEL_FAILURE_TTL_MS,
): ModelHealth {
  const next = { ...pruneModelHealth(health, now, ttlMs) };
  delete next[modelKeyOf(spec)];
  return next;
}

/** One slot the dispatch refused to spend a round on. */
export interface SkippedSlot {
  spec: string;
  /** Epoch ms of the failure that put it in cooldown. */
  at: number;
  error?: string;
}

export interface SlotChoice {
  /** The model spec this round should run on. */
  spec: string;
  /** Index in the chain the spec was taken from. */
  index: number;
  /** Slots skipped because they are cooling down, in chain order. */
  skipped: SkippedSlot[];
  /**
   * Every slot is cooling down, so `spec` is the chain head anyway.
   *
   * Fail-OPEN on purpose: a round that never starts cannot even report that
   * it could not start, and the pane rotates in-round once its model answers
   * with an error. The caller must say so rather than pass this off as a
   * healthy pick.
   */
  allCooling: boolean;
}

/**
 * The first slot of `chain` that is not cooling down.
 *
 * `undefined` for an EMPTY chain — the caller fails closed exactly as it did
 * before the chain existed, and this module never invents a default model
 * (no built-in default: a role without a resolvable chain is a config error).
 */
export function selectHealthySlot(
  chain: readonly string[],
  health: ModelHealth,
  now: number,
  ttlMs: number = MODEL_FAILURE_TTL_MS,
): SlotChoice | undefined {
  if (chain.length === 0) return undefined;
  const live = pruneModelHealth(health, now, ttlMs);
  const skipped: SkippedSlot[] = [];
  for (let index = 0; index < chain.length; index++) {
    const spec = chain[index]!;
    const failure = live[modelKeyOf(spec)];
    if (!failure) {
      return { spec, index, skipped, allCooling: false };
    }
    skipped.push({ spec, at: failure.at, ...(failure.error ? { error: failure.error } : {}) });
  }
  // Every slot is bad: hand back the head and let the round fail loudly
  // (criterion 4 — an exhausted chain reports itself, never hangs).
  return { spec: chain[0]!, index: 0, skipped, allCooling: true };
}

/**
 * The next slot after `current` that this round has not already spent.
 *
 * `attempted` holds the specs already tried THIS round (the pane's own
 * memory): a chain whose slots repeat the same provider must not make the
 * pane try it twice. Returns undefined when nothing is left — the terminal
 * state the pane reports as an exhausted chain.
 */
export function nextSlotAfter(
  chain: readonly string[],
  current: string,
  attempted: readonly string[],
): { spec: string; index: number } | undefined {
  const tried = new Set(attempted.map(modelKeyOf));
  const currentKey = modelKeyOf(current);
  const start = chain.findIndex((s) => modelKeyOf(s) === currentKey);
  for (let i = (start === -1 ? 0 : start + 1); i < chain.length; i++) {
    const spec = chain[i]!;
    if (!tried.has(modelKeyOf(spec))) return { spec, index: i };
  }
  return undefined;
}

/** One line describing a cooling-down slot, for a receipt or a notification. */
export function describeCoolingSlot(slot: SkippedSlot, now: number): string {
  const minutes = Math.max(1, Math.round((now - slot.at) / 60000));
  return `${modelKeyOf(slot.spec)}（${minutes} 分钟前失败${slot.error ? `：${slot.error}` : ""}）`;
}

/**
 * WHAT HAPPENED TO ONE MODEL — the vocabulary the pane and the opener share.
 *
 * The pane is the only witness (it sees its own provider errors) and the
 * opener is the only one allowed to write repo state, so the fact travels the
 * channel in this shape: the opener reads it to cool the slot down, to warn
 * the user, and to say in the round's receipt which model actually ran.
 */
export interface ModelEvent {
  /** The spec that failed (provider/id + its thinking level). */
  spec: string;
  /** Short reason, taken from the provider's own error text. */
  error?: string;
  /** The spec the pane moved to. Absent when nothing was left to try. */
  to?: string;
  /** TRUE when the chain is exhausted — no slot left, the round cannot go on. */
  exhausted?: boolean;
  /** How many specs this round has spent, including this one. */
  attempts?: number;
}

/** How much of a provider error is worth carrying (a receipt is not a log). */
export function summarizeModelError(raw: string | undefined): string | undefined {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}
