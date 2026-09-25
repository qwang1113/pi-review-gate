/**
 * Model specs and the model registry: parse `provider/id:thinking`, load the
 * registry pi knows about, and validate a spec (or a slot chain) against it.
 *
 * Split out of lib/model-config.ts; pure apart from `loadRegistry` reading the
 * registry files.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonIfExists } from "./json-file.ts";

// ---------------------------------------------------------------------------
// Model spec parsing: `provider/id:thinking` | `id:thinking` | `provider/id` | `id`
// ---------------------------------------------------------------------------

export interface ModelSpec {
  provider: string | null;
  id: string;
  thinking: string | null;
  raw: string;
}

/**
 * The thinking levels pi understands. Single source in lib/: shared by
 * splitThinkingSuffix / parseModelSpec here — an ollama-style letter tag (`qwen3:latest`) is NOT a
 * level and is never stripped or carried (round-6 P2: two diverging copies
 * made the config layer and the renderer disagree about such ids).
 * Mirrors the level list the agent frontmatter accepts.
 */
export const KNOWN_THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "low", "medium", "high", "xhigh", "max", "minimal"]);

/**
 * Split a trailing `:level` off a spec — the level is a KNOWN thinking level
 * (off/low/…/max), never part of an id.
 */
export function splitThinkingSuffix(spec: string): { base: string; thinking: string | null } {
  const colonIdx = spec.lastIndexOf(":");
  if (colonIdx === -1) return { base: spec, thinking: null };
  const suffix = spec.slice(colonIdx + 1);
  if (!KNOWN_THINKING_LEVELS.has(suffix)) return { base: spec, thinking: null };
  return { base: spec.slice(0, colonIdx), thinking: suffix };
}

export function parseModelSpec(spec: string): ModelSpec {
  const raw = spec.trim();
  if (!raw) return { provider: null, id: "", thinking: null, raw };
  // CR/LF inside a spec is never legitimate — it would inject extra
  // frontmatter lines when the spec is rendered into an agent file
  // (round-11 P1: `p/m\ntools: bash`). Refuse at the parse boundary.
  if (/[\r\n]/.test(raw)) return { provider: null, id: "", thinking: null, raw };
  const { base, thinking } = splitThinkingSuffix(raw);
  // A LEADING slash (slash === 0) is malformed, not a provider split: it
  // must not silently drop the slash and pass as a provider-less id (that
  // accepted "/gpt-5.6-sol" wherever "gpt-5.6-sol" resolved). Keeping the
  // whole base as the id makes the registry lookup fail → validateSpec
  // refuses the write (fail-safe).
  const slash = base.indexOf("/");
  if (slash <= 0) return { provider: null, id: base.trim(), thinking, raw };
  return { provider: base.slice(0, slash).trim(), id: base.slice(slash + 1).trim(), thinking, raw };
}

/** Bare model id (no provider, no thinking). */
export function bareModelId(spec: string): string {
  return parseModelSpec(spec).id;
}

export function formatSpec(provider: string | null, id: string, thinking: string | null): string {
  const base = provider ? `${provider}/${id}` : id;
  return thinking ? `${base}:${thinking}` : base;
}

// ---------------------------------------------------------------------------
// Registry: what the launch layer can actually resolve.
// ---------------------------------------------------------------------------

export interface RegistryModelInfo {
  id: string;
  /** `false` means the provider exposes only the `off` thinking level. */
  reasoning?: boolean;
  /** thinking level → mapped level (null when the level is unsupported). */
  thinkingLevelMap: Record<string, string | null> | null | undefined;
}

export type ModelRegistry = Record<string, RegistryModelInfo[]>;

/** The last registry built, and the source stamps it was built from. */
let registryCache: { key: string; registry: ModelRegistry } | undefined;

/** mtime+size of each source file ("-" when absent): changes whenever either file is rewritten. */
function registryStamp(paths: readonly string[]): string {
  return paths.map((p) => {
    try {
      const st = statSync(p);
      return `${p}@${st.mtimeMs}:${st.size}`;
    } catch {
      return `${p}@-`;
    }
  }).join("|");
}

/**
 * Merge models.json (hand-written) and models-store.json (provider cache).
 *
 * Cached by the two files' mtime+size: models-store.json is ~1MB and the
 * session start path used to parse it on every turn. Every call gets its OWN
 * copy: callers merge runtime models into it in place, and a shared object
 * would carry those edits into every later registry.
 */
export function loadRegistry(home = homedir()): ModelRegistry {
  const sources = [join(home, ".pi", "agent", "models.json"), join(home, ".pi", "agent", "models-store.json")];
  const key = registryStamp(sources);
  if (registryCache?.key === key) return structuredClone(registryCache.registry);
  const registry: ModelRegistry = {};
  const ingest = (root: unknown) => {
    if (typeof root !== "object" || root === null) return;
    const providers = (root as Record<string, unknown>).providers ?? root;
    for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null) continue;
      const models = (value as Record<string, unknown>).models;
      if (!Array.isArray(models)) continue;
      const list = (registry[provider] ??= []);
      for (const m of models) {
        if (typeof m !== "object" || m === null) continue;
        const entry = m as Record<string, unknown>;
        const id = entry.id;
        if (typeof id !== "string" || !id) continue;
        const tlm = entry.thinkingLevelMap;
        const thinkingLevelMap =
          typeof tlm === "object" && tlm !== null && !Array.isArray(tlm)
            ? Object.fromEntries(
                Object.entries(tlm).filter(([, mapped]) => mapped === null || typeof mapped === "string"),
              ) as Record<string, string | null>
            : undefined;
        const reasoning = typeof entry.reasoning === "boolean" ? entry.reasoning : undefined;
        const existing = list.find((e) => e.id === id);
        if (existing) {
          // The FIRST source still wins the entry, but a later one may carry
          // metadata the first one lacked. Dropping it outright made a
          // metadata-less models.json entry SHADOW the store's map, and "no
          // map" means `:max` is refused — so the renderer rejected a level
          // the registry actually proves supported. Fill gaps only; never
          // overwrite what the higher-priority source already stated.
          if (existing.thinkingLevelMap === undefined && thinkingLevelMap !== undefined) {
            existing.thinkingLevelMap = thinkingLevelMap;
          }
          if (existing.reasoning === undefined && reasoning !== undefined) {
            existing.reasoning = reasoning;
          }
          continue;
        }
        list.push({ id, reasoning, thinkingLevelMap });
      }
    }
  };
  for (const path of sources) ingest(readJsonIfExists(path));
  registryCache = { key, registry: structuredClone(registry) };
  return registry;
}

/**
 * All `provider/id:level` entries the registry proves supported for `spec`.
 * Missing metadata follows the same defaults the renderer uses: every level
 * except `max` is allowed, while mapped null and unlisted `xhigh`/`max` are refused.
 */
export function supportedThinkingOptions(reg: ModelRegistry, spec: string): string[] {
  const { provider, id } = parseModelSpec(spec);
  const cands: Array<{ provider: string; info: RegistryModelInfo }> = [];
  if (provider) {
    for (const info of reg[provider] ?? []) if (info.id === id) cands.push({ provider, info });
  } else {
    for (const [p, models] of Object.entries(reg))
      for (const info of models) if (info.id === id) cands.push({ provider: p, info });
  }
  if (cands.length === 0) return [];
  const out = new Set<string>();
  for (const c of cands) {
    const tlm = c.info.thinkingLevelMap;
    if (c.info.reasoning === false) {
      out.add(`${c.provider}/${c.info.id}:off`);
      continue;
    }
    for (const level of KNOWN_THINKING_LEVELS) {
      const mapped = tlm?.[level];
      if (mapped === null || (mapped === undefined && level === "max")) continue;
      if (mapped === undefined && level === "xhigh" && tlm) continue;
      out.add(`${c.provider}/${c.info.id}:${level}`);
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SpecValidation {
  ok: boolean;
  /** Hard failure reason (write is refused). */
  reason?: string;
  /** Soft warning (write proceeds). */
  warning?: string;
}

/**
 * Validate one slot spec against the registry.
 * Ambiguous provider-less ids and reasoning:false models are rejected for
 * unsupported thinking levels.
 */
export function validateSpec(reg: ModelRegistry, spec: string): SpecValidation {
  const parsed = parseModelSpec(spec);
  if (!parsed.id) return { ok: false, reason: `empty spec: "${spec}"` };

  const candidates: Array<{ provider: string; info: RegistryModelInfo }> = [];
  if (parsed.provider) {
    if (!reg[parsed.provider]) return { ok: false, reason: `provider not in the registry: "${parsed.provider}" (spec "${spec}")` };
    for (const info of reg[parsed.provider]) if (info.id === parsed.id) candidates.push({ provider: parsed.provider, info });
  } else {
    for (const [provider, models] of Object.entries(reg))
      for (const info of models) if (info.id === parsed.id) candidates.push({ provider, info });
    if (new Set(candidates.map((c) => c.provider)).size > 1) {
      return { ok: false, reason: `ambiguous model spec: "${spec}" exists under several providers — write it as provider/id` };
    }
  }
  if (candidates.length === 0) return { ok: false, reason: `model cannot be resolved: "${spec}" (absent from the registry)` };


  if (parsed.thinking) {
    const level = parsed.thinking;
    const supports = (info: RegistryModelInfo): boolean => {
      if (info.reasoning === false) return level === "off";
      const map = info.thinkingLevelMap;
      if (!map) return level !== "max";
      const mapped = map[level];
      if (mapped === null) return false;
      if ((level === "xhigh" || level === "max") && mapped === undefined) return false;
      return true;
    };
    if (!candidates.some(({ info }) => supports(info))) {
      const mapped = candidates
        .flatMap(({ info }) => Object.entries(info.thinkingLevelMap ?? {}))
        .filter(([, m]) => m !== null && m !== undefined)
        .map(([name]) => name)
        .sort();
      // A reasoning:false model DOES support one level — `off` — and nothing
      // else, but it carries no thinkingLevelMap, so the generic branch said
      // "supported: no metadata" and left the user with no idea what to pin.
      const allNonReasoning = candidates.every(({ info }) => info.reasoning === false);
      const supported = mapped.length > 0 ? mapped.join("/") : allNonReasoning ? "off" : "no metadata";
      return {
        ok: false,
        reason: `model ${parsed.provider ? parsed.provider + "/" : ""}${parsed.id} does not support thinking level "${level}" (supported: ${supported})`,
      };
    }
    if (candidates.every(({ info }) => !info.thinkingLevelMap && info.reasoning !== false)) {
      return { ok: true, warning: `model ${parsed.id} has no thinking-level metadata; level "${level}" is unverified (allowed)` };
    }
    return { ok: true };
  }
  return { ok: true };
}

/** Validate a whole slot list; first failure wins. */
export function validateSlots(reg: ModelRegistry, slots: readonly string[]): SpecValidation {
  for (const s of slots) {
    const v = validateSpec(reg, s);
    if (!v.ok) return v;
  }
  return { ok: true };
}
