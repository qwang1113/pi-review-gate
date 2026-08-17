/**
 * Requirement-orchestration plan state — the on-disk contract of the
 * `/decompose` loop (design doc: this repo's `docs/requirement-orchestration.md`;
 * the runtime contract is self-contained in this module and the command prompts).
 *
 * WHY THIS FILE EXISTS: a large requirement is executed one module at a time by
 * short-lived subagents. Nothing may live only in an agent's context, because
 * every agent in the loop is expected to die and be replaced by a cold-started
 * successor. The plan state IS the handoff: whatever is not written here does
 * not survive the next step.
 *
 * DESIGN CONSTRAINTS:
 *  - AUTHORITATIVE STATE IS JSON (`.pi/plan/state.json`), not the YAML
 *    frontmatter the design first sketched. The gate takes no npm
 *    dependencies, so a YAML source of truth would mean hand-rolling a YAML
 *    subset parser and then trusting it with the run's only durable record.
 *    `JSON.parse` is in the platform and cannot silently misread a document.
 *    `PLAN.md` is RENDERED from this state for humans and never parsed back.
 *  - FAIL CLOSED. A state file that is missing, malformed, or internally
 *    inconsistent (unknown enum, dangling or cyclic `depends_on`, overlapping
 *    ownership between plan-time modules) is REFUSED with the exact defect.
 *    A partially written plan is never silently "repaired" by guessing.
 *  - ATOMIC WRITES. Write to a temp file in the same directory, then rename,
 *    so a crash mid-write leaves the previous valid state intact.
 *  - PURE CORE. Validation, charging and dispatch selection are pure functions
 *    over the state object: they are the parts a test can pin, and the parts a
 *    misbehaving agent must not be able to reinterpret.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Schema version of `state.json`. Bumping it invalidates older runs loudly. */
export const PLAN_SCHEMA = 1;

/** Directory (repo-root-relative) holding all run state. Gate-owned, git-ignored. */
export const PLAN_DIR = ".pi/plan";
export const PLAN_STATE_FILE = "state.json";
export const PLAN_VIEW_FILE = "PLAN.md";
export const PLAN_BRIEF_FILE = "brief.md";
export const PLAN_WORKLOG_DIR = "worklog";

/** Seam modules are created mid-verify and are the only ones allowed to overlap. */
export const SEAM_ID_PREFIX = "M-INT-";

/** `blocked_rounds` at which the module's tier is escalated (design §7). */
export const ESCALATE_AT = 3;
/** Above this many charged rounds the run stops and asks the human (design D7). */
export const HUMAN_AT = 8;

export const MODULE_STATUSES = Object.freeze([
  "pending", "running", "implemented", "reviewing", "blocked", "accepted",
] as const);
export const PLAN_STATUSES = Object.freeze([
  "drafting", "approved", "executing", "verifying", "done", "blocked",
] as const);
export const MUST_HAVE_KINDS = Object.freeze(["artifact", "behavior", "test", "doc"] as const);
export const RISKS = Object.freeze(["low", "normal", "high"] as const);
/** Ordered weakest → strongest; escalation walks this ladder. */
export const THINKING_LADDER = Object.freeze(["low", "medium", "high", "max"] as const);

export type ModuleStatus = (typeof MODULE_STATUSES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export type MustHaveKind = (typeof MUST_HAVE_KINDS)[number];
export type Risk = (typeof RISKS)[number];
export type Thinking = (typeof THINKING_LADDER)[number];

export interface MustHave {
  id: string;
  kind: MustHaveKind;
  statement: string;
  risk: Risk;
}

export interface PlanModule {
  id: string;
  title: string;
  intent: string;
  owned_paths: string[];
  depends_on: string[];
  must_haves: MustHave[];
  model: string;
  thinking: Thinking;
  risk: Risk;
  est_context_tokens: number;
  status: ModuleStatus;
  blocked_rounds: number;
  worklog: string;
  /**
   * Marks a seam module: one created DURING a verify round to own a fix that
   * crosses module ownership. Only a seam module may overlap another module's
   * `owned_paths`. This is an explicit field rather than an id convention
   * because an id prefix is a naming habit, not a guarantee — a plan-time
   * module accidentally named `M-INT-oops` would otherwise slip past the
   * disjointness rule in silence.
   */
  seam?: true;
  result: string;
}

export interface PlanState {
  schema: number;
  requirement: string;
  brief: string;
  created: string;
  status: PlanStatus;
  cursor: string | null;
  verify_round: number;
  integration_blocked_rounds: number;
  modules: PlanModule[];
  /**
   * Optional parallel-execution ledger (schema stays 1: absent on older runs,
   * so pre-parallel state files parse unchanged). Each wave records which
   * modules ran together, how they ran (subagent spawns of
   * `agents/worker-readonly.md`),
   * and
   * where their patch artifacts landed. Written by the driver (/plan-next),
   * read by /plan-status and reviewers.
   */
  parallel?: PlanParallelState;
}

/** One executed wave in the parallel ledger. */
export interface PlanWaveRecord {
  /** Module ids dispatched together in this wave (≤ maxWaveSize). */
  modules: string[];
  status: "running" | "applied" | "failed";
  /** Repo-relative or absolute path of this wave's patch artifacts. */
  patches_dir: string;
  /** One-line outcome (applied cleanly, failed patches, retried worker…). */
  note?: string;
}

export interface PlanParallelState {
  /** Execution substrate. Only "subagents" is accepted; the retired pdw value rejects. */
  engine: "subagents";
  waves: PlanWaveRecord[];
}

export type PlanResult =
  | { ok: true; state: PlanState }
  | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function fail(defect: string): PlanResult {
  return { ok: false, error: defect };
}

/** Is this a seam module (created during a verify round to own a cross-cutting fix)? */
export function isSeamModule(module: Pick<PlanModule, "id" | "seam">): boolean {
  return module.seam === true;
}

/**
 * Parse + validate raw `state.json` text. Fail-closed: any structural defect
 * returns the exact reason instead of a partially trusted plan.
 */
export function parsePlanState(raw: string): PlanResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return fail(`plan state is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(data)) return fail("plan state must be a JSON object");
  if (data.schema !== PLAN_SCHEMA) {
    return fail(`unsupported plan schema ${JSON.stringify(data.schema)} (expected ${PLAN_SCHEMA})`);
  }
  for (const key of ["requirement", "brief", "created"] as const) {
    if (typeof data[key] !== "string" || (data[key] as string).length === 0) {
      return fail(`plan field "${key}" must be a non-empty string`);
    }
  }
  if (!PLAN_STATUSES.includes(data.status as PlanStatus)) {
    return fail(`unknown plan status ${JSON.stringify(data.status)}`);
  }
  if (data.cursor !== null && typeof data.cursor !== "string") {
    return fail("plan field \"cursor\" must be a module id or null");
  }
  for (const key of ["verify_round", "integration_blocked_rounds"] as const) {
    const n = data[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
      return fail(`plan field "${key}" must be a non-negative integer`);
    }
  }
  if (!Array.isArray(data.modules)) return fail("plan field \"modules\" must be an array");

  const modules: PlanModule[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of data.modules.entries()) {
    const m = parseModule(entry, index);
    if (!m.ok) return fail(m.error);
    if (seen.has(m.module.id)) return fail(`duplicate module id "${m.module.id}"`);
    seen.add(m.module.id);
    modules.push(m.module);
  }

  const parallel = parseParallelState(data.parallel);
  if (!parallel.ok) return fail(parallel.error);

  const state: PlanState = {
    schema: PLAN_SCHEMA,
    requirement: data.requirement as string,
    brief: data.brief as string,
    created: data.created as string,
    status: data.status as PlanStatus,
    cursor: (data.cursor as string | null) ?? null,
    verify_round: data.verify_round as number,
    integration_blocked_rounds: data.integration_blocked_rounds as number,
    modules,
    parallel: parallel.value,
  };

  const structural = validateGraph(state);
  if (structural) return fail(structural);
  return { ok: true, state };
}

type ParallelParseResult = { ok: true; value: PlanParallelState | undefined } | { ok: false; error: string };

/**
 * Validate the optional parallel-execution ledger. Absent (older runs) is
 * fine; present but malformed fails closed with the exact defect.
 */
function parseParallelState(raw: unknown): ParallelParseResult {
  if (raw === undefined) return { ok: true, value: undefined };
  if (!isRecord(raw)) return { ok: false, error: "plan field \"parallel\" must be an object" };
  if (raw.engine !== "subagents") {
    return { ok: false, error: "plan field \"parallel.engine\" must be \"subagents\"" };
  }
  if (!Array.isArray(raw.waves)) return { ok: false, error: "plan field \"parallel.waves\" must be an array" };
  const waves: PlanWaveRecord[] = [];
  for (const [index, entry] of raw.waves.entries()) {
    const where = `parallel.waves[${index}]`;
    if (!isRecord(entry)) return { ok: false, error: `${where} must be an object` };
    if (!isStringArray(entry.modules) || entry.modules.length === 0) {
      return { ok: false, error: `${where}.modules must be a non-empty array of module ids` };
    }
    if (entry.status !== "running" && entry.status !== "applied" && entry.status !== "failed") {
      return { ok: false, error: `${where}.status must be running|applied|failed` };
    }
    if (typeof entry.patches_dir !== "string" || entry.patches_dir.length === 0) {
      return { ok: false, error: `${where}.patches_dir must be a non-empty string` };
    }
    if (entry.note !== undefined && typeof entry.note !== "string") {
      return { ok: false, error: `${where}.note must be a string` };
    }
    waves.push({
      modules: entry.modules as string[],
      status: entry.status as PlanWaveRecord["status"],
      patches_dir: entry.patches_dir as string,
      note: entry.note as string | undefined,
    });
  }
  return { ok: true, value: { engine: raw.engine as PlanParallelState["engine"], waves } };
}

type ModuleResult = { ok: true; module: PlanModule } | { ok: false; error: string };

function parseModule(entry: unknown, index: number): ModuleResult {
  const where = `modules[${index}]`;
  if (!isRecord(entry)) return { ok: false, error: `${where} must be an object` };
  const id = entry.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return { ok: false, error: `${where}.id must be a slug like "M-01" or "M-INT-1"` };
  }
  for (const key of ["title", "intent", "model", "worklog"] as const) {
    if (typeof entry[key] !== "string" || (entry[key] as string).length === 0) {
      return { ok: false, error: `${where}.${key} must be a non-empty string` };
    }
  }
  if (typeof entry.result !== "string") {
    return { ok: false, error: `${where}.result must be a string (empty until the module reports)` };
  }
  if (!isStringArray(entry.owned_paths) || entry.owned_paths.length === 0) {
    return { ok: false, error: `${where}.owned_paths must be a non-empty array of paths` };
  }
  if (!isStringArray(entry.depends_on)) {
    return { ok: false, error: `${where}.depends_on must be an array of module ids` };
  }
  if (!Array.isArray(entry.must_haves) || entry.must_haves.length === 0) {
    return { ok: false, error: `${where}.must_haves must list at least one acceptance criterion` };
  }
  const mustHaves: MustHave[] = [];
  for (const [j, mh] of entry.must_haves.entries()) {
    if (!isRecord(mh)) return { ok: false, error: `${where}.must_haves[${j}] must be an object` };
    if (typeof mh.id !== "string" || mh.id.length === 0) {
      return { ok: false, error: `${where}.must_haves[${j}].id must be a non-empty string` };
    }
    if (!MUST_HAVE_KINDS.includes(mh.kind as MustHaveKind)) {
      return { ok: false, error: `${where}.must_haves[${j}].kind is unknown: ${JSON.stringify(mh.kind)}` };
    }
    if (typeof mh.statement !== "string" || mh.statement.length === 0) {
      return { ok: false, error: `${where}.must_haves[${j}].statement must be a non-empty string` };
    }
    if (!RISKS.includes(mh.risk as Risk)) {
      return { ok: false, error: `${where}.must_haves[${j}].risk is unknown: ${JSON.stringify(mh.risk)}` };
    }
    mustHaves.push({ id: mh.id, kind: mh.kind as MustHaveKind, statement: mh.statement, risk: mh.risk as Risk });
  }
  if (!THINKING_LADDER.includes(entry.thinking as Thinking)) {
    return { ok: false, error: `${where}.thinking is unknown: ${JSON.stringify(entry.thinking)}` };
  }
  if (!RISKS.includes(entry.risk as Risk)) {
    return { ok: false, error: `${where}.risk is unknown: ${JSON.stringify(entry.risk)}` };
  }
  if (!MODULE_STATUSES.includes(entry.status as ModuleStatus)) {
    return { ok: false, error: `${where}.status is unknown: ${JSON.stringify(entry.status)}` };
  }
  const est = entry.est_context_tokens;
  if (typeof est !== "number" || !Number.isInteger(est) || est <= 0) {
    return { ok: false, error: `${where}.est_context_tokens must be a positive integer` };
  }
  const blocked = entry.blocked_rounds;
  if (typeof blocked !== "number" || !Number.isInteger(blocked) || blocked < 0) {
    return { ok: false, error: `${where}.blocked_rounds must be a non-negative integer` };
  }
  return {
    ok: true,
    module: {
      id,
      title: entry.title as string,
      intent: entry.intent as string,
      owned_paths: [...(entry.owned_paths as string[])],
      depends_on: [...(entry.depends_on as string[])],
      must_haves: mustHaves,
      model: entry.model as string,
      thinking: entry.thinking as Thinking,
      risk: entry.risk as Risk,
      est_context_tokens: est,
      status: entry.status as ModuleStatus,
      ...(entry.seam === true ? { seam: true as const } : {}),
      blocked_rounds: blocked,
      worklog: entry.worklog as string,
      result: entry.result as string,
    },
  };
}

/**
 * Cross-module invariants: dependency edges resolve, the graph is acyclic, the
 * cursor points at a real module, and plan-time modules own disjoint paths.
 * Seam modules are exempt from disjointness by design — they exist precisely to
 * own a fix that crosses ownership, and serial execution keeps that safe.
 * Returns the defect, or undefined when the plan is sound.
 */
export function validateGraph(state: PlanState): string | undefined {
  const byId = new Map(state.modules.map((m) => [m.id, m]));
  if (state.cursor !== null && !byId.has(state.cursor)) {
    return `cursor points at unknown module "${state.cursor}"`;
  }
  for (const m of state.modules) {
    for (const dep of m.depends_on) {
      if (!byId.has(dep)) return `module "${m.id}" depends on unknown module "${dep}"`;
      if (dep === m.id) return `module "${m.id}" depends on itself`;
    }
  }
  const cycle = findCycle(state.modules);
  if (cycle) return `dependency cycle: ${cycle.join(" -> ")}`;

  const owners = new Map<string, string>();
  for (const m of state.modules) {
    if (isSeamModule(m)) continue;
    for (const path of m.owned_paths) {
      const prev = owners.get(path);
      if (prev) return `modules "${prev}" and "${m.id}" both own "${path}"`;
      owners.set(path, m.id);
    }
  }
  return undefined;
}

function findCycle(modules: PlanModule[]): string[] | undefined {
  const byId = new Map(modules.map((m) => [m.id, m]));
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];

  const walk = (id: string): string[] | undefined => {
    const seen = state.get(id);
    if (seen === "done") return undefined;
    if (seen === "open") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "open");
    stack.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      const found = walk(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };

  for (const m of modules) {
    const found = walk(m.id);
    if (found) return found;
  }
  return undefined;
}

/** Read + validate the plan from `<repoRoot>/.pi/plan/state.json`. */
export function readPlanState(repoRoot: string): PlanResult {
  const path = join(repoRoot, PLAN_DIR, PLAN_STATE_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail(`no plan at ${PLAN_DIR}/${PLAN_STATE_FILE} — run /decompose first`);
    return fail(`cannot read ${PLAN_DIR}/${PLAN_STATE_FILE}: ${(err as Error).message}`);
  }
  return parsePlanState(raw);
}

/**
 * Persist the plan atomically, and re-render the human view beside it.
 * Validates first: this function refuses to write a plan that `readPlanState`
 * would then refuse to load, so the run can never save itself into a corner.
 */
export function writePlanState(repoRoot: string, state: PlanState): { ok: true } | { ok: false; error: string } {
  // Validate the EXACT bytes we are about to persist, through the same parser
  // that will load them. Checking the in-memory object with validateGraph alone
  // would miss every field-level defect (an empty must_haves list, a duplicate
  // id, a negative counter) and let the run save itself into a state no command
  // can subsequently read — a permanent wedge, on disk.
  const payload = `${JSON.stringify({ ...state, schema: PLAN_SCHEMA }, null, 2)}\n`;
  const parsed = parsePlanState(payload);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const defect = validateGraph(state);
  if (defect) return { ok: false, error: defect };
  const dir = join(repoRoot, PLAN_DIR);
  mkdirSync(join(dir, PLAN_WORKLOG_DIR), { recursive: true });
  atomicWrite(join(dir, PLAN_STATE_FILE), payload);
  atomicWrite(join(dir, PLAN_VIEW_FILE), renderPlan(state));
  return { ok: true };
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Render the human-readable `PLAN.md`. Never parsed back — a pure projection. */
export function renderPlan(state: PlanState): string {
  const lines: string[] = [
    `# Plan — ${state.requirement}`,
    "",
    "> Rendered from `.pi/plan/state.json`. Edit the state, not this file.",
    "",
    `- status: **${state.status}**`,
    `- verify round: ${state.verify_round}`,
    `- integration blocked rounds: ${state.integration_blocked_rounds}`,
    `- cursor: ${state.cursor ?? "—"}`,
    `- brief: \`${PLAN_DIR}/${state.brief}\``,
    "",
    "| id | status | title | model / thinking | blocked | result |",
    "|---|---|---|---|---|---|",
  ];
  for (const m of state.modules) {
    lines.push(
      `| ${m.id} | ${m.status} | ${escapeCell(m.title)} | ${escapeCell(m.model)} / ${m.thinking} | ${m.blocked_rounds} | ${escapeCell(m.result || "—")} |`,
    );
  }
  lines.push("", "## Modules", "");
  for (const m of state.modules) {
    lines.push(
      `### ${m.id} — ${m.title}`,
      "",
      m.intent,
      "",
      `- owned paths: ${m.owned_paths.map((p) => `\`${p}\``).join(", ")}`,
      `- depends on: ${m.depends_on.length ? m.depends_on.join(", ") : "—"}`,
      `- worklog: \`${PLAN_DIR}/${m.worklog}\``,
      `- must-haves:`,
      ...m.must_haves.map((mh) => `  - [${mh.kind}/${mh.risk}] ${mh.id}: ${escapeCell(mh.statement)}`),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/* ------------------------------------------------------------------ *
 * Charging — the single rule that bounds every failure path (design §5.3)
 * ------------------------------------------------------------------ */

export interface ChargeOutcome {
  state: PlanState;
  /** Modules whose blocked_rounds was charged this round. */
  chargedModules: string[];
  /** Whether the run-level counter was charged. */
  chargedIntegration: boolean;
  /** Modules that have crossed HUMAN_AT and need a human (design D7). */
  needsHuman: string[];
}

/**
 * Charge one aborted verify round and roll the plan back to `executing`.
 *
 * `blamedModules` are the existing modules that own a finding this round (each
 * charged ONCE however many findings it owns); `createdSeam` says the round had
 * at least one finding that no single module could own; `phaseB` marks an
 * integration failure, which always charges the run-level counter. Every module
 * NOT blamed rolls back `reviewing` → `implemented` so the next round can start
 * from step 0 — that rollback is what keeps the loop guard satisfiable.
 */
export function chargeAbortedRound(
  state: PlanState,
  opts: { blamedModules: string[]; createdSeam?: boolean; phaseB?: boolean },
): ChargeOutcome {
  const blamed = new Set(opts.blamedModules);
  // Fail closed on the bound: an aborted round with nothing charged to a module
  // is, by the assignment rule, a round whose findings did not land on a single
  // existing module — exactly the case the run-level counter exists for. If we
  // let a caller abort a round for free, the verify loop would be unbounded,
  // and the caller is an LLM. `blamed.size === 0` therefore charges the run.
  const chargedIntegration =
    Boolean(opts.createdSeam) || Boolean(opts.phaseB) || blamed.size === 0;
  const modules = state.modules.map((m) => {
    if (blamed.has(m.id)) {
      return { ...m, status: "blocked" as ModuleStatus, blocked_rounds: m.blocked_rounds + 1 };
    }
    if (m.status === "reviewing") return { ...m, status: "implemented" as ModuleStatus };
    return m;
  });
  const next: PlanState = {
    ...state,
    status: "executing",
    integration_blocked_rounds: state.integration_blocked_rounds + (chargedIntegration ? 1 : 0),
    modules,
  };
  const needsHuman = modules.filter((m) => m.blocked_rounds > HUMAN_AT).map((m) => m.id);
  if (next.integration_blocked_rounds > HUMAN_AT) needsHuman.push("<integration>");
  return {
    state: needsHuman.length ? { ...next, status: "blocked" } : next,
    chargedModules: [...blamed],
    chargedIntegration,
    needsHuman,
  };
}

/** Start a verify round: every implemented module enters review. */
export function beginVerifyRound(state: PlanState): PlanState {
  return {
    ...state,
    status: "verifying",
    verify_round: state.verify_round + 1,
    modules: state.modules.map((m) =>
      m.status === "implemented" ? { ...m, status: "reviewing" as ModuleStatus } : m,
    ),
  };
}

/**
 * Phase B returned READY: every module under review is accepted and its
 * escalation counter resets. This is the ONLY producer of `accepted` — a module
 * reviewer's READY alone never accepts anything, because the integration
 * reviewer can still send that module back.
 */
export function acceptRound(state: PlanState): PlanState {
  return {
    ...state,
    status: "done",
    modules: state.modules.map((m) =>
      m.status === "reviewing" ? { ...m, status: "accepted" as ModuleStatus, blocked_rounds: 0 } : m,
    ),
  };
}

/**
 * Escalation ladder: at ESCALATE_AT charged rounds raise thinking one notch;
 * once thinking is maxed, the model tier is the next lever (the caller supplies
 * the stronger model id, since model availability is a runtime concern).
 * Returns undefined when nothing should change yet.
 */
export function escalationFor(module: PlanModule): { thinking: Thinking; raiseModelTier: boolean } | undefined {
  if (module.blocked_rounds < ESCALATE_AT) return undefined;
  const index = THINKING_LADDER.indexOf(module.thinking);
  if (index < THINKING_LADDER.length - 1) {
    return { thinking: THINKING_LADDER[index + 1], raiseModelTier: false };
  }
  return { thinking: module.thinking, raiseModelTier: true };
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

export type Dispatch =
  | { kind: "run"; module: PlanModule }
  | { kind: "verify" }
  | { kind: "blocked"; reason: string }
  | { kind: "done" };

/**
 * What should happen next, decided from state alone — the same answer a
 * cold-started planner must reach, which is what makes the planner disposable.
 *
 * A module is dispatchable when it is `pending` or `blocked` and every module it
 * depends on has reached `implemented` or `accepted`. The cursor is a
 * preference, not an authority: if it points at something undispatchable, the
 * first dispatchable module in declaration order wins, so a stale cursor can
 * never wedge the run.
 */
export function nextDispatch(state: PlanState): Dispatch {
  if (state.status === "blocked") {
    return { kind: "blocked", reason: "the plan is blocked and needs a human decision" };
  }
  if (state.status === "done") return { kind: "done" };

  const byId = new Map(state.modules.map((m) => [m.id, m]));
  const ready = (m: PlanModule): boolean =>
    (m.status === "pending" || m.status === "blocked") &&
    m.depends_on.every((dep) => {
      const d = byId.get(dep);
      return d ? d.status === "implemented" || d.status === "accepted" : false;
    });

  const cursored = state.cursor ? byId.get(state.cursor) : undefined;
  if (cursored && ready(cursored)) return { kind: "run", module: cursored };

  const candidate = state.modules.find(ready);
  if (candidate) return { kind: "run", module: candidate };

  if (state.modules.every((m) => m.status === "implemented" || m.status === "accepted")) {
    return { kind: "verify" };
  }
  if (state.modules.some((m) => m.status === "running" || m.status === "reviewing")) {
    return { kind: "blocked", reason: "a module is still running or under review" };
  }
  return {
    kind: "blocked",
    reason: "no module is dispatchable — every remaining module waits on an unfinished dependency",
  };
}

/** Conventional worklog path for a module id. */
export function worklogPathFor(id: string): string {
  return `${PLAN_WORKLOG_DIR}/${id}.md`;
}
