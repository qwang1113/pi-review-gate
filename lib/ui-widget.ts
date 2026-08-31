/**
 * pi-review-gate — TUI widget content builders (pure functions).
 *
 * The extension renders ONE widget via `ctx.ui.setWidget`: belowEditor shows
 * the gate status panel — workspace/branch facts, review & precommit
 * verdicts, unmet requirements, and the effective model configuration for
 * the judgment agents (adviser/reviewer). The sub-agent artifact scan was
 * retired 2026-09-06 with the pi-subagents companion.
 *
 * Everything here is a pure function of plain strings so it can be
 * unit-tested without a TUI. The extension owns the side effects
 * (reading goal files, calling setWidget) and the try/catch fallbacks.
 */

export interface ModelConfigWidgetEntry {
  /** Agent role name (reviewer, adviser, …). */
  name: string;
  /** Effective spec as shown, including any `:thinking` suffix. */
  spec: string;
  /** Whether the agent runs on its built-in default model chain. */
  auto: boolean;
  /** Which config layer decided this entry. */
  source: "project" | "global" | "default";
}

/**
 * Build the widget lines showing the effective model configuration for the
 * judgment agents. One line per agent: `model <name>: <spec>  [state · source]`.
 */
export function buildModelConfigWidget(entries: ModelConfigWidgetEntry[]): string[] {
  return entries.map((e) => {
    const state = e.auto === false ? "auto OFF" : "auto on";
    return `model ${e.name}: ${e.spec}  [${state} · ${e.source}]`;
  });
}

// ---- Gate status panel (2026-08-31 redesign) ----
//
// The widget used to carry ONLY the model config — gate state lived in
// injected directives nobody keeps on screen. It now renders a status
// panel: workspace/branch, verdicts, unmet requirements, model config.
// Purely display; it never feeds any enforcement path (a widget bug can
// misinform, never misauthorize).

/** Review verdicts, in display order. */
export const GATE_REVIEW_VERDICTS = ["PENDING", "READY", "BLOCKED", "NEEDS_HUMAN"] as const;
export type GateReviewVerdict = (typeof GATE_REVIEW_VERDICTS)[number];

export interface GateWidgetFacts {
  /** Current gate mode (loop / explore / normal / orchestrator). */
  mode?: string;
  /** Current branch (the session works directly on it — no work branch). */
  branch?: string;
  /** The session has edited at least one file. */
  edited: boolean;
  /** Review verdict of the current round. */
  review: GateReviewVerdict;
  /** When the review verdict was recorded (ISO) — undefined = never. */
  reviewAt?: string;
  /** Round count of the current review session. */
  rounds: number;
  /** Precommit verdict of the current round. */
  precommit: "PASS" | "FAIL" | "NO_CHECKS_RUN" | "NOT_RUN";
  /** When the precommit verdict was recorded (ISO) — undefined = never. */
  precommitAt?: string;
  /** Whether the recorded precommit is the fast lane (narrowed tests). */
  precommitFast?: boolean;
  /** Loop goal approved (L8). */
  goalApproved: boolean;
  /** Copilot review cycle is open (L7). */
  copilotOpen: boolean;
  /** Unmet requirements (ship-gate problems). */
  unmet: string[];
}

const VERDICT_LABEL: Record<string, string> = {
  PENDING: "待审核",
  READY: "通过",
  BLOCKED: "未通过",
  NEEDS_HUMAN: "需人工",
  PASS: "通过",
  FAIL: "失败",
  NO_CHECKS_RUN: "零检查",
  NOT_RUN: "未运行",
};

/** Compact relative time: "3m", "2h", "5d"; "" when unknown. */
export function relativeAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.floor(s / 60)}m`;
  if (s < 129600) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const UNMET_PREFIX: ReadonlyArray<[string, string]> = [
  ["code review gate is", "review"],
  ["precommit", "precommit"],
  ["unreviewed commits", "commits"],
  ["docSync", "docSync"],
  ["fingerprint mismatch", "指纹失配"],
  ["worktree fingerprint unavailable", "指纹不可用"],
  ["loop goal is not approved", "goal"],
  ["loop goal is unconfirmed", "goal"],
  ["Copilot", "copilot"],
  ["gate state missing", "无状态"],
];

/** The first canonical short tag for an unmet-requirement line, or "?" . */
export function unmetTag(line: string): string {
  for (const [prefix, tag] of UNMET_PREFIX) {
    if (line.includes(prefix)) return tag;
  }
  return "?";
}

/**
 * Build the gate status panel (one widget, several blocks).
 * Pure: everything comes from the facts object.
 */
export function buildGateWidget(f: GateWidgetFacts): string[] {
  const lines: string[] = [];

  // ---- block 1: branch / mode ----
  const wsBits: string[] = [`mode ${f.mode ?? "?"}`];
  if (f.branch) wsBits.push(f.branch);
  wsBits.push(f.edited ? "已编辑" : "未编辑");
  lines.push(`门禁 · ${wsBits.join(" · ")}`);

  // ---- block 2: verdicts ----
  const review = VERDICT_LABEL[f.review] ?? f.review;
  const reviewAge = relativeAge(f.reviewAt);
  const precommit = VERDICT_LABEL[f.precommit] ?? f.precommit;
  const precommitAge = relativeAge(f.precommitAt);
  lines.push(
    `审核 ${review}${f.rounds > 0 ? ` · 第 ${f.rounds} 轮` : ""}${reviewAge ? ` · ${reviewAge} 前` : ""} | ` +
      `precommit ${precommit}${f.precommitFast ? "（fast）" : ""}${precommitAge ? ` · ${precommitAge} 前` : ""} | ` +
      `goal ${f.goalApproved ? "已批准" : "未批准"} | copilot ${f.copilotOpen ? "进行中" : "关"}`,
  );

  // ---- block 3: unmet requirements (ship-gate problems), capped ----
  const show = f.unmet.slice(0, 3);
  if (show.length > 0) {
    for (const u of show) lines.push(`  ⚠ ${unmetTag(u)}: ${u.slice(0, 88)}`);
    if (f.unmet.length > show.length) lines.push(`  … 另有 ${f.unmet.length - show.length} 项未满足`);
  }

  return lines;
}
