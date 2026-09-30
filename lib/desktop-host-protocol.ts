/**
 * THE DESKTOP HOST PROTOCOL — what prg (this gate) says to the desktop client
 * over a unix socket, instead of running tmux (2026-09-30, t2-host-protocol).
 *
 * The prose contract — transport, lifecycle, fail-closed table, the tmux ↔
 * message appendix — is `docs/desktop/host-protocol.md`. This module is its
 * machine half, and the ONE source of truth for the wire shapes:
 *
 *  - {@link METHODS} declares every method's params and result as a field
 *    table. The runtime validator, the TS types ({@link Params} /
 *    {@link Result}) and the JSON Schema the Rust side reads
 *    ({@link buildJsonSchema}, committed as
 *    `desktop/protocol/host-protocol.schema.json`) are all DERIVED from it, so
 *    the three cannot drift apart — a test compares the committed schema with
 *    the derivation.
 *  - Objects are CLOSED (no unknown keys). A field added on either side is a
 *    protocol version bump, never a silent extra: fail-closed beats lenient
 *    when the far side is a different build in a different language.
 *
 * Pure: builds, parses and validates strings and values. No socket, no IO.
 */

import { CHILD_STATES } from "./orchestrator-child-state.ts";
import { MAX_CHOICE_OPTIONS, MIN_CHOICE_OPTIONS } from "./choice-dialog.ts";
import { NOTIFY_BODY_MAX, NOTIFY_TITLE_MAX, type UserNotifyKind } from "./user-notify.ts";

export const PROTOCOL_VERSION = 1;
/** One frame = one JSON object + `\n`, at most this many UTF-8 bytes (newline excluded). */
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Every request but `dialog.open` (which waits for a human) times out after this. */
export const REQUEST_TIMEOUT_MS = 5_000;

/** Which host this process runs under. Unset / `tmux` ⇒ tmux; `desktop` ⇒ this protocol. */
export const HOST_ENV = "RG_HOST";
/** Absolute path of the client's listening unix socket. */
export const HOST_SOCKET_ENV = "RG_HOST_SOCKET";
/** The client-minted id of the session THIS process is (the client's handle for it). */
export const HOST_SESSION_ENV = "RG_HOST_SESSION";

/** Error codes the CLIENT may put on the wire. */
export const WIRE_ERROR_CODES = [
  "bad-request",
  "unknown-method",
  "version-mismatch",
  "not-found",
  "forbidden",
  "unavailable",
  "internal",
] as const;
/** Error codes only prg's own side produces (never valid on the wire). */
export const LOCAL_ERROR_CODES = ["disconnected", "timeout", "bad-frame", "bad-response"] as const;
export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];
export type ErrorCode = WireErrorCode | (typeof LOCAL_ERROR_CODES)[number];
export interface ProtocolError { code: ErrorCode; message: string }

// ---------------------------------------------------------------------------
// The field language — just enough to describe the wire, validate it and emit JSON Schema
// ---------------------------------------------------------------------------

interface Mods { optional?: true; nullable?: true }
export type Field = Mods & (
  | { type: "string"; minLength?: number; maxLength?: number; pattern?: string }
  | { type: "integer"; minimum?: number }
  | { type: "boolean" }
  | { type: "enum"; values: readonly string[] }
  | { type: "array"; items: Field; minItems?: number; maxItems?: number }
  | { type: "map"; keyPattern: string; values: Field; maxEntries?: number }
  | { type: "object"; fields: Fields }
  | { type: "union"; tag: string; variants: Readonly<Record<string, Fields>> }
);
export type Fields = Readonly<Record<string, Field>>;

const str = <const O extends { minLength?: number; maxLength?: number; pattern?: string }>(o: O) =>
  ({ type: "string" as const, ...o });
const int = <const O extends { minimum?: number }>(o: O) => ({ type: "integer" as const, ...o });
const bool = { type: "boolean" as const };
const enm = <const V extends readonly string[]>(values: V) => ({ type: "enum" as const, values });
const arr = <const I extends Field, const O extends { minItems?: number; maxItems?: number }>(items: I, o: O) =>
  ({ type: "array" as const, items, ...o });
const obj = <const F extends Fields>(fields: F) => ({ type: "object" as const, fields });
const union = <const T extends string, const V extends Readonly<Record<string, Fields>>>(tag: T, variants: V) =>
  ({ type: "union" as const, tag, variants });
const opt = <const F extends Field>(f: F) => ({ ...f, optional: true as const });
const nul = <const F extends Field>(f: F) => ({ ...f, nullable: true as const });

type Infer<F> =
  F extends { type: "string" } ? string :
  F extends { type: "integer" } ? number :
  F extends { type: "boolean" } ? boolean :
  F extends { type: "enum"; values: readonly (infer V)[] } ? V :
  F extends { type: "array"; items: infer I } ? InferField<I>[] :
  F extends { type: "map"; values: infer I } ? Record<string, InferField<I>> :
  F extends { type: "object"; fields: infer Fs } ? InferFields<Fs> :
  F extends { type: "union"; tag: infer T extends string; variants: infer Vs } ?
    { [K in keyof Vs]: { [P in T]: K } & InferFields<Vs[K]> }[keyof Vs] :
  never;
type InferField<F> = F extends { nullable: true } ? Infer<F> | null : Infer<F>;
type OptKeys<Fs> = { [K in keyof Fs]: Fs[K] extends { optional: true } ? K : never }[keyof Fs];
type InferFields<Fs> =
  { -readonly [K in Exclude<keyof Fs, OptKeys<Fs>>]: InferField<Fs[K]> } &
  { -readonly [K in OptKeys<Fs>]?: InferField<Fs[K]> };

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

const ID_PATTERN = "^[A-Za-z0-9._-]{1,64}$";
const id = str({ pattern: ID_PATTERN });
const absPath = str({ minLength: 1, maxLength: 4096, pattern: "^/" });
const EMPTY = obj({});

/** What kind of process a session is — the client groups and labels by it. */
export const SESSION_ROLES = ["root", "judge", "worker", "orchestration-child", "successor"] as const;
/** The session kinds prg itself may OPEN (`root` is the one the user opened). */
const OPENABLE_ROLES = ["judge", "worker", "orchestration-child", "successor"] as const;
export const NOTIFY_KINDS = ["finished", "failed", "needs-user"] as const satisfies readonly UserNotifyKind[];

const dialogCommon = {
  dialogId: id,
  /** The question. Long text is carried whole — the client scrolls, never truncates. */
  title: str({ minLength: 1, maxLength: 65536 }),
  body: opt(str({ maxLength: 262144 })),
  options: arr(str({ minLength: 1, maxLength: 4096 }), { minItems: MIN_CHOICE_OPTIONS, maxItems: MAX_CHOICE_OPTIONS }),
  /** The ✎ row's text; picking it opens the client's multi-line reason editor. */
  declineRow: str({ minLength: 1, maxLength: 200 }),
  /** Draw `← 返回上一题` (multi-question interviews only). */
  back: bool,
} as const;

export const METHODS = {
  hello: {
    params: obj({ protocol: int({ minimum: 1 }), pid: int({ minimum: 1 }), hostSessionId: id, piSessionId: opt(str({ minLength: 1, maxLength: 128 })), cwd: absPath }),
    result: obj({ protocol: int({ minimum: 1 }), client: obj({ name: str({ minLength: 1, maxLength: 64 }), version: str({ minLength: 1, maxLength: 64 }) }) }),
  },
  "session.open": {
    params: obj({
      argv: arr(str({ minLength: 1, maxLength: 65536 }), { minItems: 1, maxItems: 512 }),
      cwd: absPath,
      env: { type: "map" as const, keyPattern: "^[A-Za-z_][A-Za-z0-9_]*$", values: str({ maxLength: 65536 }), maxEntries: 256 },
      title: str({ minLength: 1, maxLength: 200 }),
      role: enm(OPENABLE_ROLES),
      placement: enm(["own-group", "beside-opener"] as const),
    }),
    result: obj({ hostSessionId: id, pid: opt(int({ minimum: 1 })) }),
  },
  "session.list": {
    params: EMPTY,
    result: obj({
      sessions: arr(obj({
        hostSessionId: id,
        parent: nul(id),
        role: enm(SESSION_ROLES),
        title: str({ maxLength: 200 }),
        pid: opt(int({ minimum: 1 })),
        /** The pin its PARENT put on its children (`session.pin`); kept after the parent exits. */
        groupPin: nul(str({ minLength: 1, maxLength: 200 })),
      }), { maxItems: 4096 }),
    }),
  },
  /** Pin the requester's children group: an orphan sweep must leave them to whoever inherits them. */
  "session.pin": { params: obj({ reason: str({ minLength: 1, maxLength: 200 }) }), result: EMPTY },
  "session.close": {
    params: union("target", { session: { hostSessionId: id }, children: {} }),
    result: obj({ closed: arr(id, { maxItems: 4096 }) }),
  },
  "session.decorate": {
    params: obj({
      hostSessionId: id,
      label: opt(str({ maxLength: 200 })),
      colorSeed: opt(str({ minLength: 1, maxLength: 128 })),
      state: opt(enm(CHILD_STATES)),
      stateAt: opt(int({ minimum: 0 })),
      kind: opt(str({ minLength: 1, maxLength: 32 })),
      repo: opt(absPath),
      piSessionId: opt(str({ minLength: 1, maxLength: 128 })),
      sessionName: opt(nul(str({ minLength: 2, maxLength: 32 }))),
    }),
    result: EMPTY,
  },
  focus: { params: obj({ hostSessionId: id }), result: EMPTY },
  "focus.state": {
    params: EMPTY,
    result: obj({ focusedHostSessionId: nul(id), appFrontmost: bool }),
  },
  notify: {
    params: obj({
      kind: enm(NOTIFY_KINDS),
      title: str({ minLength: 1, maxLength: NOTIFY_TITLE_MAX }),
      body: str({ maxLength: NOTIFY_BODY_MAX }),
      group: opt(str({ minLength: 1, maxLength: 128 })),
      focusHostSessionId: opt(id),
    }),
    result: obj({ shown: bool }),
  },
  "dialog.open": {
    params: union("shape", {
      choice: { ...dialogCommon, recommended: opt(str({ minLength: 1, maxLength: 4096 })) },
      multi: { ...dialogCommon, defaultChecked: arr(str({ minLength: 1, maxLength: 4096 }), { maxItems: MAX_CHOICE_OPTIONS }) },
    }),
    result: union("kind", {
      picked: { option: str({ minLength: 1, maxLength: 4096 }) },
      checked: { options: arr(str({ minLength: 1, maxLength: 4096 }), { maxItems: MAX_CHOICE_OPTIONS }) },
      decline: { reason: str({ maxLength: 262144 }) },
      back: {},
      dismissed: {},
      aborted: {},
      unavailable: {},
    }),
  },
  "dialog.close": { params: obj({ dialogId: id }), result: EMPTY },
} as const satisfies Readonly<Record<string, { params: Field; result: Field }>>;

export type Method = keyof typeof METHODS;
export type Params<M extends Method> = InferField<(typeof METHODS)[M]["params"]>;
export type Result<M extends Method> = InferField<(typeof METHODS)[M]["result"]>;
export const METHOD_NAMES = Object.keys(METHODS) as Method[];

export function isMethod(value: unknown): value is Method {
  return typeof value === "string" && Object.hasOwn(METHODS, value);
}

/** `dialog.open` waits for a human, so it has no timeout; everything else has one. */
export function requestTimeoutMs(method: Method): number | undefined {
  return method === "dialog.open" ? undefined : REQUEST_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// Validation (runtime, from the same table)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkFields(value: unknown, fields: Fields, path: string, skip?: string): string | undefined {
  if (!isRecord(value)) return `${path}: 应为 object`;
  for (const key of Object.keys(value)) {
    if (key !== skip && !Object.hasOwn(fields, key)) return `${path}.${key}: 未知字段`;
  }
  for (const [key, field] of Object.entries(fields)) {
    if (value[key] === undefined) {
      if (field.optional) continue;
      return `${path}.${key}: 缺少必填字段`;
    }
    const problem = validateField(value[key], field, `${path}.${key}`);
    if (problem) return problem;
  }
  return undefined;
}

/** First problem found in `value` against `field`, or `undefined` when it conforms. */
export function validateField(value: unknown, field: Field, path = "$"): string | undefined {
  if (value === null) return field.nullable ? undefined : `${path}: 不允许 null`;
  switch (field.type) {
    case "string":
      if (typeof value !== "string") return `${path}: 应为 string`;
      if (field.minLength !== undefined && value.length < field.minLength) return `${path}: 过短`;
      if (field.maxLength !== undefined && value.length > field.maxLength) return `${path}: 过长`;
      if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) return `${path}: 不符合 ${field.pattern}`;
      return undefined;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return `${path}: 应为整数`;
      return field.minimum !== undefined && value < field.minimum ? `${path}: 小于 ${field.minimum}` : undefined;
    case "boolean":
      return typeof value === "boolean" ? undefined : `${path}: 应为 boolean`;
    case "enum":
      return typeof value === "string" && field.values.includes(value) ? undefined : `${path}: 不在 ${field.values.join("|")} 之内`;
    case "array": {
      if (!Array.isArray(value)) return `${path}: 应为 array`;
      if (field.minItems !== undefined && value.length < field.minItems) return `${path}: 至少 ${field.minItems} 项`;
      if (field.maxItems !== undefined && value.length > field.maxItems) return `${path}: 至多 ${field.maxItems} 项`;
      for (let i = 0; i < value.length; i++) {
        const problem = validateField(value[i], field.items, `${path}[${i}]`);
        if (problem) return problem;
      }
      return undefined;
    }
    case "map": {
      if (!isRecord(value)) return `${path}: 应为 object`;
      const entries = Object.entries(value);
      if (field.maxEntries !== undefined && entries.length > field.maxEntries) return `${path}: 至多 ${field.maxEntries} 项`;
      const keyRule = new RegExp(field.keyPattern);
      for (const [key, entry] of entries) {
        if (!keyRule.test(key)) return `${path}: 键 ${JSON.stringify(key)} 不符合 ${field.keyPattern}`;
        const problem = validateField(entry, field.values, `${path}.${key}`);
        if (problem) return problem;
      }
      return undefined;
    }
    case "object":
      return checkFields(value, field.fields, path);
    case "union": {
      if (!isRecord(value)) return `${path}: 应为 object`;
      const tag = value[field.tag];
      if (typeof tag !== "string" || !Object.hasOwn(field.variants, tag)) {
        return `${path}.${field.tag}: 应为 ${Object.keys(field.variants).join("|")} 之一`;
      }
      return checkFields(value, field.variants[tag]!, path, field.tag);
    }
  }
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

export type EncodeResult = { ok: true; frame: string } | { ok: false; error: ProtocolError };
export type RequestFrame = { [M in Method]: { id: string; method: M; params: Params<M> } }[Method];
export type ResponseOutcome<M extends Method> =
  | { ok: true; result: Result<M> }
  | { ok: false; error: { code: WireErrorCode; message: string } };

const ERROR_FIELD = obj({ code: enm(WIRE_ERROR_CODES), message: str({ maxLength: 2000 }) });
const idRule = new RegExp(ID_PATTERN);

function fail(code: ErrorCode, message: string): { ok: false; error: ProtocolError } {
  return { ok: false, error: { code, message } };
}

function frameOf(message: object): EncodeResult {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return fail("bad-frame", `帧超过 ${MAX_FRAME_BYTES} 字节`);
  return { ok: true, frame: `${line}\n` };
}

function parseFrame(line: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: ProtocolError } {
  const text = line.replace(/\r?\n$/, "");
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) return fail("bad-frame", `帧超过 ${MAX_FRAME_BYTES} 字节`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("bad-frame", "不是合法 JSON");
  }
  if (!isRecord(value)) return fail("bad-frame", "帧应为 JSON object");
  if (value.v !== PROTOCOL_VERSION) return fail("bad-frame", `v 应为 ${PROTOCOL_VERSION}`);
  return { ok: true, value };
}

/**
 * The three host variables are the CLIENT's to set on every process it starts
 * (the child's own session id is minted there); prg passing them would hand a
 * child somebody else's identity.
 */
function hostEnvLeak(method: Method, params: unknown): string | undefined {
  if (method !== "session.open") return undefined;
  const env = (params as { env: Record<string, string> }).env;
  const leaked = [HOST_ENV, HOST_SOCKET_ENV, HOST_SESSION_ENV].find((key) => Object.hasOwn(env, key));
  return leaked === undefined ? undefined : `params.env.${leaked}: 宿主变量由客户端注入，prg 不得传`;
}

/** prg → client. Refuses (never sends) anything the table does not allow. */
export function encodeRequest<M extends Method>(requestId: string, method: M, params: Params<M>): EncodeResult {
  if (!idRule.test(requestId)) return fail("bad-request", `请求 id 不符合 ${ID_PATTERN}`);
  const problem = validateField(params, METHODS[method].params, "params") ?? hostEnvLeak(method, params);
  if (problem) return fail("bad-request", problem);
  return frameOf({ v: PROTOCOL_VERSION, type: "request", id: requestId, method, params });
}

/** The client side's reading of a request — for mock clients and cross-checks; Rust mirrors it. */
export function decodeRequest(line: string): { ok: true; request: RequestFrame } | { ok: false; id?: string; error: ProtocolError } {
  const parsed = parseFrame(line);
  if (!parsed.ok) return parsed;
  const { value } = parsed;
  const requestId = typeof value.id === "string" && idRule.test(value.id) ? value.id : undefined;
  const withId = requestId === undefined ? {} : { id: requestId };
  if (value.type !== "request" || requestId === undefined) return { ...withId, ...fail("bad-request", "缺 type=request 或合法 id") };
  if (!isMethod(value.method)) return { ...withId, ...fail("unknown-method", `未知方法 ${String(value.method)}`) };
  const extra = Object.keys(value).find((key) => !["v", "type", "id", "method", "params"].includes(key));
  if (extra) return { ...withId, ...fail("bad-request", `未知字段 ${extra}`) };
  const problem = validateField(value.params, METHODS[value.method].params, "params") ?? hostEnvLeak(value.method, value.params);
  if (problem) return { ...withId, ...fail("bad-request", problem) };
  return { ok: true, request: { id: requestId, method: value.method, params: value.params } as RequestFrame };
}

/** client → prg. Exists so mock clients and tests produce exactly what Rust must. */
export function encodeResponse<M extends Method>(requestId: string, method: M, outcome: ResponseOutcome<M>): EncodeResult {
  if (!idRule.test(requestId)) return fail("bad-request", `响应 id 不符合 ${ID_PATTERN}`);
  const problem = outcome.ok
    ? validateField(outcome.result, METHODS[method].result, "result")
    : validateField(outcome.error, ERROR_FIELD, "error");
  if (problem) return fail("bad-request", problem);
  return frameOf({ v: PROTOCOL_VERSION, type: "response", id: requestId, ...outcome });
}

export type DecodedResponse =
  | { ok: true; id: string; method: Method; result: unknown }
  | { ok: false; id?: string; error: ProtocolError };

/**
 * prg's reading of one line from the client. `methodOf` maps a pending
 * request id to its method; an id nobody is waiting on is `bad-response`.
 * A malformed result is `bad-response` too — never passed on as a success.
 */
export function decodeResponse(line: string, methodOf: (requestId: string) => Method | undefined): DecodedResponse {
  const parsed = parseFrame(line);
  if (!parsed.ok) return parsed;
  const { value } = parsed;
  const requestId = typeof value.id === "string" && idRule.test(value.id) ? value.id : undefined;
  if (value.type !== "response" || requestId === undefined) return fail("bad-response", "缺 type=response 或合法 id");
  const method = methodOf(requestId);
  if (method === undefined) return { id: requestId, ...fail("bad-response", `没有在等 id=${requestId} 的请求`) };
  const bad = (message: string): DecodedResponse => ({ id: requestId, ...fail("bad-response", message) });
  const allowed = value.ok === true ? ["v", "type", "id", "ok", "result"] : ["v", "type", "id", "ok", "error"];
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) return bad(`未知字段 ${extra}`);
  if (value.ok === false) {
    const problem = validateField(value.error, ERROR_FIELD, "error");
    if (problem) return bad(problem);
    const error = value.error as { code: WireErrorCode; message: string };
    return { ok: false, id: requestId, error: { code: error.code, message: error.message } };
  }
  if (value.ok !== true) return bad("ok 应为 boolean");
  const problem = validateField(value.result, METHODS[method].result, "result");
  if (problem) return bad(problem);
  return { ok: true, id: requestId, method, result: value.result };
}

// ---------------------------------------------------------------------------
// Semantics prg applies on top of the shapes (fail-closed readings)
// ---------------------------------------------------------------------------

/**
 * A dialog answer is only an answer if it is one the box OFFERED: an option
 * the client invented, a `checked` for a radio box, or a `back` on a box that
 * drew no back row is refused — prg then treats the dialog as unanswered.
 */
export function checkDialogOutcome(params: Params<"dialog.open">, outcome: Result<"dialog.open">): string | undefined {
  if (outcome.kind === "picked") {
    if (params.shape !== "choice") return "picked 只属于单选框";
    return params.options.includes(outcome.option) ? undefined : `picked 的选项不在 options 里：${outcome.option}`;
  }
  if (outcome.kind === "checked") {
    if (params.shape !== "multi") return "checked 只属于多选框";
    if (new Set(outcome.options).size !== outcome.options.length) return "checked 有重复项";
    const stray = outcome.options.find((option) => !params.options.includes(option));
    return stray === undefined ? undefined : `checked 的选项不在 options 里：${stray}`;
  }
  if (outcome.kind === "back" && !params.back) return "这个框没有画「返回上一题」";
  return undefined;
}

/**
 * Is a session alive, from one `session.list` reading? A FAILED reading is
 * `unknown`, never `dead`: missing information is not evidence of death (the
 * same rule `paneRecoverability`'s `unknown-liveness` enforces for tmux).
 */
export function livenessOf(
  listing: { ok: true; result: Result<"session.list"> } | { ok: false },
  hostSessionId: string,
): "alive" | "dead" | "unknown" {
  if (!listing.ok) return "unknown";
  return listing.result.sessions.some((s) => s.hostSessionId === hostSessionId) ? "alive" : "dead";
}

export type HostEnv =
  | { kind: "tmux" }
  | { kind: "desktop"; socketPath: string; hostSessionId: string }
  | { kind: "invalid"; error: string };

/** macOS `sun_path` is 104 bytes including the NUL. */
const SOCKET_PATH_MAX_BYTES = 103;

/**
 * Which host this process runs under. `invalid` is FAIL-CLOSED: the caller
 * refuses host operations with the reason — it never falls back to tmux, which
 * would open windows the desktop user cannot see.
 */
export function resolveHostEnv(env: Readonly<Record<string, string | undefined>>): HostEnv {
  const host = (env[HOST_ENV] ?? "").trim();
  if (host === "" || host === "tmux") return { kind: "tmux" };
  if (host !== "desktop") return { kind: "invalid", error: `${HOST_ENV}=${host} 不认识（只认 tmux / desktop）` };
  const socketPath = env[HOST_SOCKET_ENV] ?? "";
  if (!socketPath.startsWith("/")) return { kind: "invalid", error: `${HOST_SOCKET_ENV} 必须是绝对路径` };
  if (Buffer.byteLength(socketPath, "utf8") > SOCKET_PATH_MAX_BYTES) {
    return { kind: "invalid", error: `${HOST_SOCKET_ENV} 超过 ${SOCKET_PATH_MAX_BYTES} 字节（unix socket 路径上限）` };
  }
  const hostSessionId = env[HOST_SESSION_ENV] ?? "";
  if (!idRule.test(hostSessionId)) return { kind: "invalid", error: `${HOST_SESSION_ENV} 缺失或不符合 ${ID_PATTERN}` };
  return { kind: "desktop", socketPath, hostSessionId };
}

// ---------------------------------------------------------------------------
// JSON Schema (what the Rust side reads) — derived, never hand-kept
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function fieldsSchema(fields: Fields, tag?: { name: string; value: string }): Json {
  const properties: Json = tag ? { [tag.name]: { const: tag.value } } : {};
  const required = tag ? [tag.name] : [];
  for (const [key, field] of Object.entries(fields)) {
    properties[key] = fieldSchema(field);
    if (!field.optional) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

function fieldSchema(field: Field): Json {
  const base = ((): Json => {
    switch (field.type) {
      case "string": {
        const { minLength, maxLength, pattern } = field;
        return { type: "string", ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }), ...(pattern === undefined ? {} : { pattern }) };
      }
      case "integer":
        return { type: "integer", ...(field.minimum === undefined ? {} : { minimum: field.minimum }) };
      case "boolean":
        return { type: "boolean" };
      case "enum":
        return { enum: [...field.values] };
      case "array": {
        const { minItems, maxItems } = field;
        return { type: "array", items: fieldSchema(field.items), ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }) };
      }
      case "map":
        return {
          type: "object",
          propertyNames: { pattern: field.keyPattern },
          additionalProperties: fieldSchema(field.values),
          ...(field.maxEntries === undefined ? {} : { maxProperties: field.maxEntries }),
        };
      case "object":
        return fieldsSchema(field.fields);
      case "union":
        return { oneOf: Object.entries(field.variants).map(([value, fields]) => fieldsSchema(fields, { name: field.tag, value })) };
    }
  })();
  return field.nullable ? { anyOf: [base, { type: "null" }] } : base;
}

/**
 * The whole protocol as one JSON Schema document (draft 2020-12, plus `x-`
 * facts a schema cannot express). `desktop/protocol/host-protocol.schema.json`
 * is exactly this, pretty-printed; the test fails when they differ.
 */
export function buildJsonSchema(): Json {
  const defs: Json = {
    error: fieldSchema(ERROR_FIELD),
  };
  for (const method of METHOD_NAMES) {
    defs[`${method}.params`] = fieldSchema(METHODS[method].params);
    defs[`${method}.result`] = fieldSchema(METHODS[method].result);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "pi-review-gate/desktop-host-protocol",
    title: "pi-review-gate desktop host protocol (generated from lib/desktop-host-protocol.ts)",
    "x-protocolVersion": PROTOCOL_VERSION,
    "x-maxFrameBytes": MAX_FRAME_BYTES,
    "x-requestTimeoutMs": REQUEST_TIMEOUT_MS,
    "x-env": { host: HOST_ENV, socket: HOST_SOCKET_ENV, hostSession: HOST_SESSION_ENV },
    "x-wireErrorCodes": [...WIRE_ERROR_CODES],
    "x-methods": [...METHOD_NAMES],
    "x-request": {
      type: "object",
      properties: { v: { const: PROTOCOL_VERSION }, type: { const: "request" }, id: { type: "string", pattern: ID_PATTERN }, method: { enum: [...METHOD_NAMES] }, params: { description: "$defs[<method>.params]" } },
      required: ["v", "type", "id", "method", "params"],
      additionalProperties: false,
    },
    "x-response": {
      oneOf: [
        { type: "object", properties: { v: { const: PROTOCOL_VERSION }, type: { const: "response" }, id: { type: "string", pattern: ID_PATTERN }, ok: { const: true }, result: { description: "$defs[<method>.result]" } }, required: ["v", "type", "id", "ok", "result"], additionalProperties: false },
        { type: "object", properties: { v: { const: PROTOCOL_VERSION }, type: { const: "response" }, id: { type: "string", pattern: ID_PATTERN }, ok: { const: false }, error: { $ref: "#/$defs/error" } }, required: ["v", "type", "id", "ok", "error"], additionalProperties: false },
      ],
    },
    $defs: defs,
  };
}
