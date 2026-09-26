/**
 * The `agents` section of review-gate.json — parsing one layer and merging the
 * layers into the effective per-role slot configuration.
 *
 * Split out of lib/model-config.ts (which renders that configuration into the
 * agent files).
 */

import { isWorkerRoleName, KNOWN_AGENTS } from "./model-config.ts";

/** Max slots an agent may configure; longer lists are truncated with a diagnostic. */
export const MAX_SLOTS = 4;

// ---------------------------------------------------------------------------
// agents config section parsing & layering
// ---------------------------------------------------------------------------

export interface AgentSlotSettings {
  auto: boolean;
  /** Effective slot chain (order = priority). Only honored when `auto` is false. */
  slots: string[];
  /**
   * The role's own system prompt, for roles that HAVE one in config (worker
   * presets, 2026-09-21). The judge roles do not use it: their system prompt
   * is built in code (`buildJudgeSystemPrompt`) because it has to name the
   * repo and the round's contract.
   */
  prompt?: string;
  /** Which layer provided the settings. */
  source: "project" | "global" | "default";
  /** The entry was EXPLICITLY present but every field was invalid — the
   * renderer must keep the last good render instead of sweeping it (fail-safe). */
  malformed?: boolean;
}

export type AgentsConfigMap = Record<string, AgentSlotSettings>;

/** No explicit chain (`auto` not false, or no slots) — the ONE test both the
 * startup check and `/gate-status` apply; two copies had already drifted once. */
export function lacksExplicitChain(e: AgentSlotSettings): boolean {
  return e.auto !== false || e.slots.length === 0;
}

export interface ParseAgentsResult {
  /** Only the agents actually present in the section (auto-filled to defaults). */
  sections: Record<string, { auto?: boolean; slots?: string[]; prompt?: string; malformed?: boolean }>;
  /** Human-readable diagnostics (truncation, unknown names). */
  diagnostics: string[];
}

/** Parse one `agents` section from a raw config file value. */
export function parseAgentsSection(
  raw: unknown,
  validNames: readonly string[] = KNOWN_AGENTS,
): ParseAgentsResult {
  const result: ParseAgentsResult = { sections: {}, diagnostics: [] };
  if (raw === undefined || raw === null) return result;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    result.diagnostics.push("the agents section is not an object; ignored");
    return result;
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // Workers are named by CONVENTION (`worker`, `worker-*`), judges by the
    // package's own list — an unknown name is still reported, so a typo in a
    // judge role does not become an unreachable worker (2026-09-21).
    if (!validNames.includes(name) && !isWorkerRoleName(name)) {
      result.diagnostics.push(`agents.${name} is not a known agent name; ignored`);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      // A KNOWN agent whose entry is not an object (string/null/array) still
      // names the agent explicitly — dropping it would let the cleanup sweep
      // delete a previously valid render (round-11 P1: `{reviewer:"typo"}`
      // wiped the last good chain). Mark malformed → keep last render.
      result.diagnostics.push(`agents.${name} is not an object; ignored`);
      result.sections[name] = { malformed: true };
      continue;
    }
    const entry = value as Record<string, unknown>;
    const out: { auto?: boolean; slots?: string[]; prompt?: string } = {};
    let autoInvalid = false;
    let slotsInvalid = false;
    if (entry.auto !== undefined && typeof entry.auto === "boolean") {
      out.auto = entry.auto;
    } else if (entry.auto !== undefined) {
      // A non-boolean auto (e.g. "false") would silently drop the whole
      // entry's meaning — say so instead of discarding it quietly. An
      // invalid `auto` also poisons otherwise-valid slots: defaulting to
      // auto:true would silently IGNORE the user's slot chain (round-11 P1).
      result.diagnostics.push(`agents.${name}.auto is not a boolean; ignored`);
      autoInvalid = true;
    }
    if (entry.slots !== undefined) {
      // A slot spec must never carry CR/LF: it would inject extra frontmatter
      // lines into the rendered agent file (round-11 P1: `p/m\ntools: bash`
      // passed validation and deployed a second `tools:` key).
      const clean = (s: unknown): s is string =>
        typeof s === "string" && s.trim().length > 0 && !/[\r\n]/.test(s);
      if (Array.isArray(entry.slots) && entry.slots.every(clean)) {
        const trimmed = entry.slots.map((s) => (s as string).trim()).filter(Boolean);
        if (trimmed.length > MAX_SLOTS) {
          result.diagnostics.push(`agents.${name}.slots has more than ${MAX_SLOTS} entries; truncated to the first ${MAX_SLOTS}`);
        }
        out.slots = trimmed.slice(0, MAX_SLOTS);
      } else {
        result.diagnostics.push(`agents.${name}.slots is not a non-empty array of strings; ignored`);
        // An INVALID slots key is not "no slots": rendering auto:false with
        // an empty slot list would silently replace the last good chain with
        // the built-in default (round-11 P1). Fail-safe: mark malformed.
        slotsInvalid = true;
      }
    }
    // A WORKER PRESET'S PROMPT (2026-09-21). Free text the user writes, and it
    // reaches the pane as its `--system-prompt` FILE — never as an argv value,
    // for the same reason a task file is used instead of a message: a
    // multi-line string on a command line is one quoting bug away from a
    // different program.
    if (entry.prompt !== undefined) {
      if (typeof entry.prompt === "string" && entry.prompt.trim().length > 0) {
        out.prompt = entry.prompt;
      } else {
        result.diagnostics.push(`agents.${name}.prompt is not a non-empty string; ignored`);
      }
    }
    if (slotsInvalid || autoInvalid) {
      result.sections[name] = { malformed: true };
    } else if (out.auto !== undefined || out.slots !== undefined || out.prompt !== undefined) {
      result.sections[name] = out;
    } else if (Object.keys(entry).length > 0) {
      // An entry with fields but NO valid one (e.g. `{slots:[1]}` or
      // `{auto:"false"}`) still names the agent EXPLICITLY — treating it
      // as absent would let the cleanup sweep delete a previously valid
      // render (round-11 P1: malformed entry wiped the last good chain).
      // Mark it malformed so the renderer keeps the last render. An EMPTY
      // object stays "absent": it is not a config and must not suppress
      // the reviewer-readonly follow (round-8 P2).
      result.sections[name] = { malformed: true };
    }
  }
  return result;
}

/**
 * Every `worker*` key either layer declares, in a stable order and without
 * duplicates.
 *
 * The names are DISCOVERED rather than listed (2026-09-21): the whole point of
 * a preset is that the user invents it (`worker-recon`, `worker-strong`), so a
 * fixed registry would only be a second place to forget to add one.
 */
export function collectWorkerRoleNames(...raws: readonly unknown[]): string[] {
  const found: string[] = [];
  for (const raw of raws) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    for (const name of Object.keys(raw as Record<string, unknown>)) {
      if (isWorkerRoleName(name) && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

/**
 * Effective per-agent settings: project wins per agent, then global, then the
 * default (`auto: true`, empty slots). `source` records which layer decided,
 * so the UI can label it.
 */
export function effectiveAgentsConfig(
  globalRaw: unknown,
  projectRaw: unknown,
  validNames: readonly string[] = KNOWN_AGENTS,
): { map: AgentsConfigMap; diagnostics: string[] } {
  const names = [...validNames, ...collectWorkerRoleNames(globalRaw, projectRaw)];
  const map: AgentsConfigMap = {};
  const diagnostics: string[] = [];
  for (const name of names) map[name] = { auto: true, slots: [], source: "default" };

  const apply = (raw: unknown, source: "global" | "project") => {
    const parsed = parseAgentsSection(raw, names);
    diagnostics.push(...parsed.diagnostics);
    for (const [name, entry] of Object.entries(parsed.sections)) {
      if (!names.includes(name)) continue; // unknown agent names ignored
      if (entry.malformed) {
        // Explicitly present but field-invalid: keep whatever this layer
        // previously rendered — never treat it as "unconfigured" (the
        // cleanup would sweep a valid older render) nor render a default
        // chain over it (round-11 P1).
        map[name] = { auto: true, slots: [], source, malformed: true };
        continue;
      }
      map[name] = {
        auto: entry.auto ?? true,
        slots: entry.slots ?? [],
        ...(entry.prompt === undefined ? {} : { prompt: entry.prompt }),
        source,
      };
    }
  };
  apply(globalRaw, "global");
  apply(projectRaw, "project");

  // auto:false with an EMPTY slot list still renders the default chain —
  // an empty slot list is never a silent no-review state, and the renderer writes
  // the default-chain overlay so this layer shadows any lower slot render.
  // Surface it so the deployed default is never a surprise.
  for (const name of names) {
    const e = map[name]!;
    if (e.source !== "default" && e.auto === false && e.slots.length === 0) {
      diagnostics.push(`${name}: auto:false with an empty slot list — rendering the built-in default chain (an empty slot list is never a silent no-review state)`);
    }
  }

  // (The reviewer-readonly follow rule retired 2026-08-27 with the snapshot
  // guard: judge roles run only as tmux children, and the readonly dispatch
  // path no longer exists.)
  return { map, diagnostics };
}
