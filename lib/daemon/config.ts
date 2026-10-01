/**
 * READING AND WRITING THE USER'S CONFIGURATION — the panel's only backend for it.
 *
 * ── THE FOUR FILES ──
 *
 *   settings      ~/.pi/agent/settings.json          pi's own settings
 *   models        ~/.pi/agent/models.json            the model providers
 *   gate (global) ~/.pi/review-gate.json             the gate's user-wide config
 *   gate (repo)   <repo>/.pi/review-gate.json        one project's override
 *
 * ── READ: MASKED, AND WITH EACH FIELD'S EDITABILITY ──
 *
 * The whole tree comes back so a panel can render it, with two rules applied:
 *
 *   1. A SECRET IS NEVER ECHOED. Any value whose key looks like a credential
 *      (`apiKey`, `token`, `secret`, `password`, …) is replaced by a fixed
 *      mask. The mask is a constant, not a partial value: showing the last
 *      four characters of an API key is still handing a secret to anything
 *      that can read an HTTP response or a screenshot.
 *   2. ONLY A LISTED FIELD IS EDITABLE. Every entry of `fields` names a dotted
 *      path, its JSON kind and whether it is sensitive; a write to anything
 *      else is refused. That list is a WHITELIST, and it is short on purpose:
 *      an arbitrary-path writer would let one bad request reshape a file the
 *      whole toolchain reads.
 *
 * ── WRITE: VALIDATE, BACK UP, THEN REPLACE ──
 *
 * Validation REUSES the gate's own implementations instead of inventing a
 * second opinion: `parseAgentsSection` + `validateSlots` (lib/agents-config.ts,
 * lib/model-spec.ts) judge a model chain exactly as the session-start check
 * does. A refused value leaves the file byte-for-byte untouched. An accepted
 * one is written atomically (lib/atomic-write.ts) after a timestamped backup
 * lands next to it.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { writeFileAtomic } from "../atomic-write.ts";
import { MAX_SLOTS, parseAgentsSection } from "../agents-config.ts";
import { KNOWN_AGENTS, isWorkerRoleName } from "../model-config.ts";
import { loadRegistry, validateSlots, KNOWN_THINKING_LEVELS } from "../model-spec.ts";
import { daemonAgentHome } from "./paths.ts";

/** Where a write may land. `gate` + `repo` means that project's config. */
export type ConfigTarget = "settings" | "models" | "gate";
/** What the HTTP layer accepts (kept apart from {@link ConfigTarget} so `repo`'s meaning stays one thing). */
export type ConfigTargetName = "settings" | "models" | "gate-global" | "gate-project";

export const CONFIG_MASK = "••••••••";

/** Most recent backups kept per file. Older ones are removed after a successful write. */
export const CONFIG_BACKUP_KEEP = 10;

/** A key is a secret when its NAME says so — values are never inspected to decide. */
const SENSITIVE_KEY = /(api[-_]?key|token|secret|password|passwd|credential|authorization|cookie|private[-_]?key)/i;

export const isSensitiveKey = (key: string): boolean => SENSITIVE_KEY.test(key);

export interface ConfigView {
  target: ConfigTargetName;
  path: string;
  exists: boolean;
  /** The parsed file with every secret masked. `null` when the file is missing. */
  value: unknown;
  /** Every dotted path a write may name, with its kind and sensitivity. */
  fields: ConfigField[];
  /** Existing backups, newest first (absolute paths). */
  backups: string[];
  /** Diagnostics from parsing what is already there (never a refusal). */
  problems: string[];
}

export interface ConfigField {
  path: string;
  kind: "string" | "boolean" | "number" | "string[]" | "json";
  sensitive: boolean;
  /** Always true in this list — the list IS the editable surface. */
  editable: boolean;
  /** The current value, masked when sensitive; absent when the key is not set. */
  current?: unknown;
  note?: string;
}

export interface ConfigWrite {
  ok: boolean;
  /** Set when the write landed. */
  path?: string;
  backup?: string;
  /** Set when the write did not land: what was wrong, in one line. */
  problem?: string;
  /** The file after the write (masked), for the panel to re-render without a second call. */
  value?: unknown;
}

/** The file a target names. `repo` is REQUIRED for a project gate config. */
export function configPath(target: ConfigTargetName, home: string, repo?: string): string {
  if (target === "settings") return join(daemonAgentHome(home), "settings.json");
  if (target === "models") return join(daemonAgentHome(home), "models.json");
  if (target === "gate-global") return join(home, ".pi", "review-gate.json");
  const root = (repo ?? "").trim();
  if (root === "") throw new Error("gate-project 目标必须带 repo 参数");
  // ANY ABSOLUTE DIRECTORY IS ACCEPTED, and that is the contract rather than an
  // oversight — `docs/daemon/api.md` §5.7 「repo 的边界（明写）」: the caller holds
  // the token, is the same user on this machine, and could start pi in that
  // directory anyway; restricting this to `GET /api/repos` would be a boundary
  // in name only. The panel still offers candidates only.
  return join(root, ".pi", "review-gate.json");
}

function readJsonIfExists(path: string): { value: unknown; exists: boolean } {
  if (!existsSync(path)) return { value: undefined, exists: false };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), exists: true };
  } catch {
    return { value: undefined, exists: true };
  }
}

/**
 * Replace every string under a secret-named key with the mask. The tree is copied, never mutated.
 *
 * `sensitive` ACCUMULATES down the tree: a secret is often one level below its
 * name (`apiTokens: { acme: "sk-…" }`, `headers: { authorization: … }`), and
 * checking only the leaf key would walk straight past both. Once a level is
 * sensitive everything under it is masked — a wrong mask costs one read of a
 * value the user already knows, a missed one leaks it into a screenshot.
 */
export function maskSecrets(value: unknown, key = "", sensitive = false): unknown {
  const touchesSecret = sensitive || isSensitiveKey(key);
  if (Array.isArray(value)) return value.map((item) => maskSecrets(item, key, touchesSecret));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [child, item] of Object.entries(value as Record<string, unknown>)) {
      out[child] = maskSecrets(item, child, touchesSecret);
    }
    return out;
  }
  // A SECRET'S TYPE IS NOT A LOOPHOLE (reviewer P1, 2026-10-01): masking only
  // strings left a numeric or boolean value under `apiTokens` in the clear.
  // Everything a sensitive-named key can hold is masked — including a number,
  // because the panel has no use for it and the name says it is a credential.
  if (touchesSecret && value !== null && value !== undefined) return CONFIG_MASK;
  return value;
}

/** One segment of a dotted path — never a prototype hop. */
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);

export function parseFieldPath(path: string): string[] | undefined {
  const segments = path.split(".");
  if (segments.length === 0 || segments.length > 8) return undefined;
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || FORBIDDEN.has(segment)) return undefined;
  }
  return segments;
}

/** Read a dotted path out of a parsed JSON tree. */
export function readPath(root: unknown, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Immutably set (or, with `undefined`, delete) a dotted path. */
export function withPath(root: unknown, segments: string[], value: unknown): Record<string, unknown> {
  const base = root !== null && typeof root === "object" && !Array.isArray(root)
    ? { ...(root as Record<string, unknown>) }
    : {};
  if (segments.length === 1) {
    if (value === undefined) delete base[segments[0]!];
    else base[segments[0]!] = value;
    return base;
  }
  base[segments[0]!] = withPath(base[segments[0]!], segments.slice(1), value);
  return base;
}

// ---------------------------------------------------------------------------
// The editable surface (the whitelist)
// ---------------------------------------------------------------------------

interface FieldSpec {
  path: string;
  kind: ConfigField["kind"];
  note?: string;
}

/** pi's own settings the panel may change. A short list is the safe list. */
const SETTINGS_FIELDS: readonly FieldSpec[] = [
  { path: "defaultProvider", kind: "string", note: "默认 provider" },
  { path: "defaultModel", kind: "string", note: "默认模型（provider/id[:thinking]）" },
  { path: "defaultThinkingLevel", kind: "string", note: `可选值：${[...KNOWN_THINKING_LEVELS].join("/")}` },
  { path: "theme", kind: "string" },
  { path: "tuiMode", kind: "string", note: "regular 或 fullscreen" },
  { path: "quietStartup", kind: "boolean" },
];

/** The per-provider keys the panel may change in models.json. */
const MODEL_PROVIDER_FIELDS: readonly FieldSpec[] = [
  { path: "apiKey", kind: "string" },
  { path: "baseUrl", kind: "string" },
  { path: "api", kind: "string" },
];

function gateFields(root: unknown): ConfigField[] {
  const fields: ConfigField[] = [];
  const agents = readPath(root, ["agents"]);
  const names = new Set<string>([...KNOWN_AGENTS]);
  if (agents !== null && typeof agents === "object") {
    for (const name of Object.keys(agents as Record<string, unknown>)) {
      if (KNOWN_AGENTS.includes(name) || isWorkerRoleName(name)) names.add(name);
    }
  }
  for (const name of names) {
    fields.push({ path: `agents.${name}.slots`, kind: "string[]", editable: true, sensitive: false, note: `最多 ${MAX_SLOTS} 个槽位，逐个经 validateSlots 校验` });
    fields.push({ path: `agents.${name}.auto`, kind: "boolean", editable: true, sensitive: false, note: "true = 使用上游默认链" });
    if (isWorkerRoleName(name)) {
      fields.push({ path: `agents.${name}.prompt`, kind: "string", editable: true, sensitive: false, note: "read-only worker 的系统提示词" });
    }
  }
  return fields;
}

function withCurrent(fields: readonly FieldSpec[], root: unknown): ConfigField[] {
  return fields.map((field) => {
    const segments = parseFieldPath(field.path)!;
    const current = readPath(root, segments);
    const fieldValue = isSensitiveKey(segments[segments.length - 1]!) ? maskSecrets(current, segments[segments.length - 1]!) : current;
    return {
      path: field.path,
      kind: field.kind,
      sensitive: isSensitiveKey(segments[segments.length - 1]!),
      editable: true,
      ...(field.note === undefined ? {} : { note: field.note }),
      ...(current === undefined ? {} : { current: fieldValue }),
    };
  });
}

export function listFields(target: ConfigTargetName, root: unknown): ConfigField[] {
  if (target === "settings") return withCurrent(SETTINGS_FIELDS, root);
  if (target === "gate-global" || target === "gate-project") return gateFields(root);
  const fields: ConfigField[] = [];
  const providers = readPath(root, ["providers"]);
  if (providers !== null && typeof providers === "object") {
    for (const provider of Object.keys(providers as Record<string, unknown>)) {
      for (const spec of MODEL_PROVIDER_FIELDS) {
        const path = `providers.${provider}.${spec.path}`;
        fields.push(...withCurrent([{ path, kind: spec.kind }], root));
      }
    }
  }
  return fields;
}

function backupsOf(path: string): string[] {
  const dir = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  try {
    return readdirSync(dir)
      .filter((file) => file.startsWith(prefix))
      .map((file) => join(dir, file))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function readConfig(target: ConfigTargetName, opts: { home: string; repo?: string }): ConfigView {
  const path = configPath(target, opts.home, opts.repo);
  const { value, exists } = readJsonIfExists(path);
  const problems: string[] = [];
  if (exists && value === undefined) problems.push("文件存在但不是合法 JSON —— 面板只读展示，写入会被拒绝");
  return {
    target,
    path,
    exists,
    value: maskSecrets(value ?? null),
    fields: listFields(target, value),
    backups: backupsOf(path),
    problems,
  };
}

// ---------------------------------------------------------------------------
// Validation and write
// ---------------------------------------------------------------------------

const THINKING_LEVELS = new Set<string>(KNOWN_THINKING_LEVELS);

/** Is this value legal for this field? Returns the problem, or undefined. */
export function validateConfigValue(
  target: ConfigTargetName,
  path: string,
  value: unknown,
  opts: { home: string },
): string | undefined {
  const segments = parseFieldPath(path);
  if (segments === undefined) return `路径不合法：${JSON.stringify(path)}`;
  const leaf = segments[segments.length - 1]!;

  // THE WHITELIST COMES FIRST — A DELETE IS A WRITE TOO (reviewer P1,
  // 2026-10-01). Accepting `null` before the check let any caller remove any
  // path in settings.json (`packages`, `extensions`, …): the list bounds what
  // this endpoint may change, and removing a key changes the file as much as
  // setting it.
  const refusal = fieldRefusal(target, path, segments);
  if (refusal !== undefined) return refusal;

  if (value === null) return undefined; // delete of a LISTED field

  if (isSensitiveKey(leaf) && typeof value === "string" && value === CONFIG_MASK) {
    return "掩码不能写回 —— 要保留原值就不要提交这个字段";
  }

  if (target === "settings") {
    const spec = SETTINGS_FIELDS.find((candidate) => candidate.path === path)!;
    if (spec.kind === "boolean") return typeof value === "boolean" ? undefined : `${path} 需要布尔值`;
    if (typeof value !== "string") return `${path} 需要字符串`;
    if (path === "defaultThinkingLevel" && !THINKING_LEVELS.has(value)) {
      return `defaultThinkingLevel 不支持 ${JSON.stringify(value)}（可选：${[...THINKING_LEVELS].join("/")}）`;
    }
    if (path === "tuiMode" && value !== "regular" && value !== "fullscreen") {
      return 'tuiMode 只能是 "regular" 或 "fullscreen"';
    }
    return undefined;
  }

  if (target === "models") {
    return typeof value === "string" && value.trim() !== "" ? undefined : `${path} 需要非空字符串`;
  }

  const role = segments[1]!;
  if (leaf === "auto") return typeof value === "boolean" ? undefined : `${path} 需要布尔值`;
  if (leaf === "prompt") {
    if (!isWorkerRoleName(role)) return `${path}：只有 worker 预设有自己的 prompt`;
    return typeof value === "string" && value.trim() !== "" ? undefined : `${path} 需要非空字符串`;
  }
  return Array.isArray(value) ? undefined : `${path} 需要字符串数组`;
}

/** Is this path one of the fields this target allows at all? */
function fieldRefusal(target: ConfigTargetName, path: string, segments: string[]): string | undefined {
  if (target === "settings") {
    return SETTINGS_FIELDS.some((candidate) => candidate.path === path) ? undefined : `${path} 不在可编辑清单里`;
  }
  if (target === "models") {
    const leaf = segments[segments.length - 1]!;
    return segments.length === 3 && segments[0] === "providers" && MODEL_PROVIDER_FIELDS.some((f) => f.path === leaf)
      ? undefined
      : `${path} 不在可编辑清单里（可改的是 providers.<provider>.apiKey|baseUrl|api）`;
  }
  if (segments.length !== 3 || segments[0] !== "agents") {
    return `${path} 不在可编辑清单里（可改的是 agents.<role>.slots|auto|prompt）`;
  }
  const role = segments[1]!;
  if (!KNOWN_AGENTS.includes(role) && !isWorkerRoleName(role)) return `${path}：${role} 不是门禁认识的角色名`;
  const leaf = segments[segments.length - 1]!;
  return leaf === "auto" || leaf === "prompt" || leaf === "slots" ? undefined : `${path} 不在可编辑清单里`;
}

/** Validate a SLOT LIST with the gate's own validator (registry included). */
export function validateSlotList(home: string, slots: unknown): string | undefined {
  if (!Array.isArray(slots) || slots.length === 0) return "slots 必须是非空数组";
  if (slots.length > MAX_SLOTS) return `slots 最多 ${MAX_SLOTS} 项（当前 ${slots.length}）`;
  for (const slot of slots) {
    if (typeof slot !== "string" || slot.trim() === "" || /[\r\n]/.test(slot)) {
      return `slots 里有一项不是合法字符串：${JSON.stringify(slot)}`;
    }
  }
  const verdict = validateSlots(loadRegistry(home), (slots as string[]).map((slot) => slot.trim()));
  if (!verdict.ok) return verdict.reason ?? "slots 校验没通过";
  return undefined;
}

/**
 * Apply one write: validate → back up → replace atomically.
 *
 * `value === null` deletes the key. Everything the caller is told (path,
 * backup, the masked result) is real: nothing here reports a write it did not
 * make.
 */
export function writeConfig(
  target: ConfigTargetName,
  path: string,
  rawValue: unknown,
  opts: { home: string; repo?: string; now?: () => number },
): ConfigWrite {
  const segments = parseFieldPath(path);
  if (segments === undefined) return { ok: false, problem: `路径不合法：${JSON.stringify(path)}` };
  let file: string;
  try {
    file = configPath(target, opts.home, opts.repo);
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  const existing = readJsonIfExists(file);
  const existed = existing.exists;
  if (existing.exists && existing.value === undefined) {
    return { ok: false, problem: `${file} 不是合法 JSON —— 先手工修好，daemon 不会覆盖一个读不出来的文件` };
  }
  // SLOTS is the one field whose value is a LIST: the shape check above
  // guarantees an array, and the gate's own validator then judges its contents.
  let value = rawValue;
  const leaf = segments[segments.length - 1]!;
  const isSlots = leaf === "slots" && segments[0] === "agents";
  const problem = validateConfigValue(target, path, value, opts);
  if (problem !== undefined) return { ok: false, problem };
  if (isSlots && value !== null) {
    const slotsProblem = validateSlotList(opts.home, value);
    if (slotsProblem !== undefined) return { ok: false, problem: slotsProblem };
    value = (value as string[]).map((slot) => slot.trim());
  }
  const next = withPath(existing.value, segments, value === null ? undefined : value);

  // MODELS: ONLY THE PROVIDERS THAT ALREADY EXIST (reviewer P1, 2026-10-01).
  // `fields` lists `providers.<p>.…` for the providers the file HAS, and a
  // write that could invent a provider would make that list a lie — the panel
  // may edit a credential, not mint a provider entry.
  if (target === "models") {
    const provider = segments[1]!;
    const providers = readPath(existing.value, ["providers"]);
    const known = providers !== null && typeof providers === "object" ? Object.keys(providers as Record<string, unknown>) : [];
    if (!known.includes(provider)) {
      return { ok: false, problem: `providers.${provider} 不在现有配置里（已知：${known.join("、") || "无"}）—— 本接口只能改已存在的 provider` };
    }
  }

  let backup: string | undefined;
  if (existing.exists) {
    // `20260102T030405Z` — sortable, filesystem-safe, and readable as a time.
    const at = new Date(opts.now?.() ?? Date.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    backup = `${file}.bak-${at}`;
    try {
      copyFileSync(file, backup);
    } catch (error) {
      return { ok: false, problem: `备份失败，未写入：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    return { ok: false, problem: `写入失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (!existed) {
    // A FILE WE CREATE IS PRIVATE (reviewer P1, 2026-10-01): `writeFileAtomic`
    // preserves an existing mode, but a brand-new config file got the process
    // umask — usually 0644 — and this surface can hold an API key (`models.json`
    // exists for exactly that). 0600 costs nothing: pi reads these files as the
    // same user. The chmod gets its OWN try (quality round P2): a failed chmod
    // must not report a write that DID land as a failure — the panel would
    // retry it and produce another backup.
    try {
      chmodSync(file, 0o600);
    } catch { /* the write already landed; a stricter mode is best effort */ }
  }
  if (backup !== undefined) {
    for (const stale of backupsOf(file).slice(CONFIG_BACKUP_KEEP)) {
      try {
        rmSync(stale, { force: true });
      } catch { /* an unremovable old backup is not a write failure */ }
    }
  }
  return {
    ok: true,
    path: file,
    ...(backup === undefined ? {} : { backup }),
    value: maskSecrets(next),
  };
}
