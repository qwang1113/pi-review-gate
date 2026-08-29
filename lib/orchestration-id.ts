/**
 * The ORCHESTRATION ID — the stable address of an orchestration, not of the
 * session that happens to be running it.
 *
 * WHY IT EXISTS (measured failure, 2026-08-29). Directed attention
 * (lib/attention.ts) addresses a child's wake-up to `RG_PARENT_SESSION`, the
 * spawning session's id, stamped into the child's environment at spawn time.
 * That is correct for a judge child (it lives and dies inside one round) but
 * WRONG for an orchestrator's child session, which outlives its parent: when
 * the orchestrator hands over to a successor (the relay protocol), every child
 * keeps signalling the RETIRED session id. The measured result was a whole
 * night of orchestration in which `~/.pi/agent/review-gate-attention.json`
 * recorded zero delivered events and the user had to relay questions by hand.
 *
 * THE FIX is one level of indirection: children are addressed to an
 * ORCHESTRATION, and a session claims that orchestration. The id is minted
 * once, injected as `RG_ORCHESTRATION_ID`, and INHERITED by the successor
 * across a relay — so a child spawned by the first orchestrator still reaches
 * the third one, with no restart and nothing to re-stamp in its environment.
 *
 * Resolution order is the whole policy, and it lives in {@link attentionTargetId}:
 * an orchestration id wins over a parent session id, because a session running
 * under an orchestration must publish to the orchestration even when it also
 * knows who spawned it. A session with neither publishes nothing (the
 * standalone case attention.ts already handles).
 *
 * Pure string module: no filesystem, no environment mutation, no tmux.
 */

/** Environment variable carrying the orchestration id into a child session. */
export const ORCHESTRATION_ID_ENV = "RG_ORCHESTRATION_ID";

/** Every orchestration id starts with this, so an id is recognizable on sight. */
export const ORCHESTRATION_ID_PREFIX = "orch-";

/** Upper bound on a minted/accepted id (attention channels are file-name-ish). */
export const MAX_ORCHESTRATION_ID = 64;

/** Characters NOT allowed in the discriminating parts of an id.
 *  Deliberately NOT a /g regex: `.test()` on a global regex is stateful
 *  (lastIndex advances between calls), which would make validation depend on
 *  how many ids were checked before it. */
const UNSAFE_ID_PART = /[^A-Za-z0-9]/;

/**
 * A short, stable discriminator for a repo path. Deliberately the same cheap
 * hash shape lib/judge-process.ts uses for judge session ids: it only has to
 * separate repos in a human-readable id, never to be collision-proof.
 */
export function orchestrationRepoHash(repoRoot: string): string {
  let hash = 0;
  for (let i = 0; i < repoRoot.length; i++) {
    hash = (hash * 31 + repoRoot.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * Mint a new orchestration id: `orch-<repoHash>-<startTime base36>`.
 *
 * The start time is part of the id so two orchestrations of the SAME repo (a
 * finished one and a new one) never share a channel — a stale child of the
 * previous run cannot wake the new orchestrator.
 */
export function newOrchestrationId(repoRoot: string, now: number = Date.now()): string {
  const stamp = Math.floor(now).toString(36);
  return `${ORCHESTRATION_ID_PREFIX}${orchestrationRepoHash(repoRoot)}-${stamp}`.slice(0, MAX_ORCHESTRATION_ID);
}

/**
 * Accept an id only if it looks like one we minted. Fail-closed on purpose:
 * the id becomes an attention channel key and is inherited across relays, so
 * an arbitrary string from the environment (or from a tool argument) must not
 * become an address. Returns undefined for anything unrecognized.
 */
export function normalizeOrchestrationId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(ORCHESTRATION_ID_PREFIX)) return undefined;
  const body = trimmed.slice(ORCHESTRATION_ID_PREFIX.length);
  if (body.length === 0) return undefined;
  // The body is `<repoHash>-<stamp>`; only those two segments, both alnum.
  const parts = body.split("-");
  if (parts.length !== 2) return undefined;
  if (parts.some((p) => p.length === 0 || UNSAFE_ID_PART.test(p))) return undefined;
  if (trimmed.length > MAX_ORCHESTRATION_ID) return undefined;
  return trimmed;
}

/** The orchestration this process was started under, if any. */
export function orchestrationIdFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return normalizeOrchestrationId(env[ORCHESTRATION_ID_ENV]);
}

/**
 * WHO a session's attention events are addressed to.
 *
 * The orchestration id wins over the spawning session id: a child of an
 * orchestrator must reach whoever currently HOLDS the orchestration, not the
 * session that happened to spawn it (that session may have relayed away or
 * died). Only a child with no orchestration falls back to its parent session
 * — the judge-child case, which is exactly right there because a judge round
 * never outlives the session that dispatched it.
 *
 * Both inputs are PASSED IN rather than read from the environment here, so
 * this module stays free of attention.ts's own environment contract (and of
 * the import cycle that would create).
 */
export function attentionTargetId(opts: {
  orchestrationId?: string;
  parentSessionId?: string;
}): string | undefined {
  const orch = normalizeOrchestrationId(opts.orchestrationId);
  if (orch) return orch;
  const parent = opts.parentSessionId?.trim();
  return parent && parent.length > 0 ? parent : undefined;
}

/** True when this address is an orchestration rather than a session. */
export function isOrchestrationTarget(target: string | undefined): boolean {
  return normalizeOrchestrationId(target) !== undefined;
}
