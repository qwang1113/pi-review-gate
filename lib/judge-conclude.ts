/**
 * Judge-side self-conclusion — the ONLY way a round ends.
 *
 * A judge pane used to publish its verdict as a fenced JSON block in its
 * prose, and the gate scraped every transcript tail for it on every settle
 * (the window-truncation P0: a fence split across the tail window never
 * matched, so the channel report never landed and the opener waited
 * forever). Then the judge called ONE tool with structured fields — and the
 * gate SYNTHESISED the canonical fence from them anyway, so the opener could
 * parse it back out. The scraper was dead; its format lived on as the only
 * consumer of itself.
 *
 * Since 2026-09-04 the structured fields travel structured: `judge_conclude`
 * writes `verdict` / `findings` / `cwd` / `docSync` straight into the channel
 * `report` record and the opener reads them as data. No fence is built, none
 * is parsed, and philosophy three keeps exactly one implementation.
 *
 * THE SIGNATURE IS ROLE-SHAPED. A `reviewer` and a `goal-auditor` conclude
 * with verdict + findings + cwd and NOTHING ELSE — there is no `notes`
 * parameter to write prose into, which constrains output more reliably than
 * any instruction could, and their prose was never read by anything. An
 * `adviser` is the opposite case: its product IS the text, it never reaches
 * the recorder, and the opener quotes it — so it keeps `notes`.
 *
 * Anti-forgery is the REGISTRATION surface, not a secret: the extension
 * registers this tool only inside a judge session (see readJudgeSideEnv) and
 * never on the main side, so a main session cannot self-certify a verdict.
 * The handler re-checks the env first thing (defence in depth).
 *
 * One round, one conclusion: the opener numbers rounds on the persisted
 * hierarchy entry (`roundSeq`, bumped at every dispatch) and stamps it on
 * the report (`round`, a field the channel schema already carried). A second
 * call for the same round is refused explicitly.
 *
 * Shape: pure core below, `registerJudgeConcludeTool(host, deps)` at the
 * bottom; effects through `deps` only, like every other tool family.
 */
import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import {
  appendRecord,
  channelPathFor,
  judgeChannelTarget,
  newChannelId,
  readChannel,
  type ChannelIO,
  type ChannelRecord,
} from "./orchestrator-channel.ts";
import { DOC_SYNC_ATTESTATIONS } from "./gate-state.ts";
import { JUDGE_STREAM_ENV, readJudgeSideEnv } from "./judge-side.ts";
import type { ReviewFinding } from "./review-adjudicate.ts";

/** Tool name — pinned by structural tests on both sides of the registration. */
export const JUDGE_CONCLUDE_TOOL = "judge_conclude";

/** Verdicts a judge may conclude with (stored verbatim on the report). */
export const CONCLUDE_VERDICTS = ["READY", "BLOCKED", "NEEDS_HUMAN"] as const;
export type ConcludeVerdict = (typeof CONCLUDE_VERDICTS)[number];

/** One finding as the judge reports it — the shape the record carries. */
export type ConcludeFinding = ReviewFinding;

/**
 * The ONE role whose conclusion is prose.
 *
 * An adviser is consulted for a judgement in words: the opener quotes it
 * (`conclusionExcerpt`) and no recorder ever sees it. Every other role
 * concludes in `findings`, so giving it a prose field would only invite text
 * that nothing reads. Kept as a predicate rather than a role list because the
 * rule is about what the output IS, not about who happens to exist today.
 */
export function roleAcceptsNotes(role: string): boolean {
  return role.trim().toLowerCase() === "adviser";
}

/** The refusal a reviewer / goal-auditor gets when it still passes `notes`. */
export const NOTES_REFUSED_REASON =
  "本角色不接受 notes，请把结论放进 findings（每条 severity + issue，能给证据就填 evidence）";

/** Validated conclude input: exactly what the channel report will carry. */
export interface ConcludedInput {
  verdict: ConcludeVerdict;
  findings: ConcludeFinding[];
  cwd: string;
  docSync?: string | undefined;
  /** Prose — ADVISER ONLY; absent for every other role. */
  notes?: string | undefined;
}

function fail(text: string): ToolReply {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}

function reply(text: string, details: Record<string, unknown>): ToolReply {
  return { content: [{ type: "text", text }], details };
}

/**
 * Validate raw tool params into conclude input, for THIS role. Returns the
 * reason when the params are unusable — a validation refusal NEVER consumes
 * the round's single conclusion (only a written report does), so a role that
 * passed `notes` by habit simply calls again without it.
 */
export function validateConcludeParams(params: Record<string, unknown>, role: string):
  | { ok: true; input: ConcludedInput }
  | { ok: false; reason: string } {
  const verdictRaw = typeof params.verdict === "string" ? params.verdict.trim().toUpperCase() : "";
  if (!(CONCLUDE_VERDICTS as readonly string[]).includes(verdictRaw)) {
    return {
      ok: false,
      reason: `verdict 必须是 ${CONCLUDE_VERDICTS.join(" / ")} 之一（收到 ${JSON.stringify(params.verdict) ?? "空"}）`,
    };
  }
  const cwd = typeof params.cwd === "string" ? params.cwd.trim() : "";
  if (!cwd) {
    return { ok: false, reason: "cwd 缺失——先跑 `pwd`，把它的原样输出填进 cwd 再调一次" };
  }
  const rawFindings = params.findings === undefined ? [] : params.findings;
  if (!Array.isArray(rawFindings)) {
    return { ok: false, reason: "findings 必须是数组（可为空数组）" };
  }
  const findings: ConcludeFinding[] = [];
  for (let i = 0; i < rawFindings.length; i++) {
    const f = rawFindings[i] as Record<string, unknown>;
    if (typeof f !== "object" || f === null) {
      return { ok: false, reason: `findings[${i}] 不是对象` };
    }
    const severity = typeof f.severity === "string" ? f.severity.trim() : "";
    const issue = typeof f.issue === "string" ? f.issue.trim() : "";
    if (!severity || !issue) {
      return { ok: false, reason: `findings[${i}] 缺 severity 或 issue（两项都必填）` };
    }
    const file = typeof f.file === "string" && f.file.trim() !== "" ? f.file.trim() : undefined;
    const line = typeof f.line === "number" && Number.isFinite(f.line) ? Math.floor(f.line) : undefined;
    // `evidence` is OPTIONAL and unvalidated (D6): for most findings the
    // evidence IS file:line, and demanding it only manufactures filler.
    const evidence = typeof f.evidence === "string" && f.evidence.trim() !== "" ? f.evidence.trim() : undefined;
    findings.push({
      severity,
      ...(file === undefined ? {} : { file }),
      ...(line === undefined ? {} : { line }),
      issue,
      ...(evidence === undefined ? {} : { evidence }),
    });
  }
  let docSync: string | undefined;
  if (params.docSync !== undefined) {
    const normalized = typeof params.docSync === "string" ? params.docSync.trim().toUpperCase() : "";
    if (!DOC_SYNC_ATTESTATIONS.has(normalized)) {
      return {
        ok: false,
        reason: `docSync 只能是 ${[...DOC_SYNC_ATTESTATIONS].join(" / ")}（收到 ${JSON.stringify(params.docSync) ?? "空"}），不覆盖代码改动时直接省略该字段`,
      };
    }
    docSync = normalized;
  }
  // The role-shaped half of the signature. A reviewer / goal-auditor has no
  // `notes` parameter at all, so passing one is refused outright rather than
  // silently dropped — a silently ignored field teaches the caller nothing.
  if (!roleAcceptsNotes(role)) {
    if (params.notes !== undefined) {
      return { ok: false, reason: NOTES_REFUSED_REASON };
    }
    return { ok: true, input: { verdict: verdictRaw as ConcludeVerdict, findings, cwd, docSync } };
  }
  if (params.notes !== undefined && typeof params.notes !== "string") {
    return { ok: false, reason: "notes 必须是纯文本" };
  }
  const notes = typeof params.notes === "string" ? params.notes : "";
  return { ok: true, input: { verdict: verdictRaw as ConcludeVerdict, findings, cwd, docSync, notes } };
}

/**
 * Highest `round` among this judge's own reports in the channel (pre-tool
 * reports carry none and count as 0). The opener uses it to number a fresh
 * dispatch above every previous round; the judge uses it to recognise its
 * own concluded round. Pure over the read records.
 */
export function maxSelfReportRound(records: ReadonlyArray<ChannelRecord>): number {
  let max = 0;
  for (const r of records) {
    if (r.kind !== "report" || r.from !== "child") continue;
    const round = (r as { round?: unknown }).round;
    if (typeof round === "number" && Number.isFinite(round)) max = Math.max(max, Math.floor(round));
  }
  return max;
}

/**
 * The next round number: above both the persisted entry and every report
 * already in the channel (a close→spawn keeps the old reports, so the entry
 * alone would restart at 1 and collide with them).
 */
export function nextRoundSeq(entrySeq: number | undefined, records: ReadonlyArray<ChannelRecord>): number {
  const base = typeof entrySeq === "number" && Number.isFinite(entrySeq) ? Math.floor(entrySeq) : 0;
  return Math.max(base, maxSelfReportRound(records)) + 1;
}

/**
 * May this round conclude? Refuse only when one of OUR reports already
 * closes THIS round — older rounds' reports (a previous review under the
 * same id) never block. Returns the existing report id for the message.
 */
export function decideConclude(
  records: ReadonlyArray<ChannelRecord>,
  currentRound: number,
): { ok: true } | { ok: false; reportId: string } {
  for (const r of records) {
    if (r.kind !== "report" || r.from !== "child") continue;
    const rec = r as { round?: unknown; reportId?: unknown };
    if (typeof rec.round === "number" && rec.round === currentRound) {
      return { ok: false, reportId: typeof rec.reportId === "string" ? rec.reportId : "?" };
    }
  }
  return { ok: true };
}

/**
 * Stream line count for the report (gate-counted from RG_JUDGE_STREAM, never
 * judge-reported). Falls back to the findings length when there is no stream.
 */
export function countStreamFindings(readText: (path: string) => string | undefined, streamPath: string | undefined, fallback: number): number {
  if (!streamPath) return fallback;
  try {
    const raw = readText(streamPath);
    if (raw === undefined) return fallback;
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return fallback;
  }
}

/** Everything the tool needs from the outside world. */
export interface JudgeConcludeToolDeps {
  /** This judge pane's environment (identity comes from RG_JUDGE_*). */
  env(): NodeJS.ProcessEnv;
  /** Repo root (the pane's cwd) — locates the persisted hierarchy slice. */
  repoRoot(): string;
  /** Absolute path of one repo's hierarchy file. */
  hierarchyPath(root: string): string;
  /** Whole file, or undefined when absent/unreadable. */
  readText(path: string): string | undefined;
  /** Channel filesystem seam and its home override. */
  channelIO(): ChannelIO;
  channelHome(): string | undefined;
  /** Injectable clock. */
  now(): number;
}

/** Read our persisted round number, or refuse when the gate state is unreadable. */
function readOwnRoundSeq(deps: JudgeConcludeToolDeps, judgeId: string): { ok: true; round: number } | { ok: false; reason: string } {
  let raw: string | undefined;
  try {
    raw = deps.readText(deps.hierarchyPath(deps.repoRoot()));
  } catch {
    raw = undefined;
  }
  if (raw === undefined) {
    return { ok: false, reason: "门禁登记表不可读（文件缺失或读失败）——稍后重试，不要重复交卷" };
  }
  try {
    const snap = JSON.parse(raw) as { judges?: Record<string, { roundSeq?: unknown }> };
    const entry = snap?.judges?.[judgeId];
    if (!entry) {
      return { ok: false, reason: `登记表里没有本 review（${judgeId}）——它可能已被关闭；不要交卷，去问 opener` };
    }
    const seq = entry.roundSeq;
    return { ok: true, round: typeof seq === "number" && Number.isFinite(seq) ? Math.floor(seq) : 0 };
  } catch {
    return { ok: false, reason: "门禁登记表已损坏无法解析——稍后重试，不要重复交卷" };
  }
}

async function doConclude(deps: JudgeConcludeToolDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const cfg = readJudgeSideEnv(deps.env());
  if (!cfg) {
    return fail("review-gate: judge_conclude 只在 review 会话里可用——主会话不能自证裁决。");
  }
  const validated = validateConcludeParams(params, cfg.role);
  if (!validated.ok) {
    return fail(`review-gate: 交卷被拒绝（参数问题，不占交卷额度）：${validated.reason}。修正后调一次。`);
  }
  const input = validated.input;
  const seq = readOwnRoundSeq(deps, cfg.judgeId);
  if (!seq.ok) {
    return fail(`review-gate: 交卷被拒绝（门禁状态问题，不占交卷额度）：${seq.reason}`);
  }
  const io = deps.channelIO();
  const home = deps.channelHome();
  const target = judgeChannelTarget(cfg.openerId, cfg.judgeId, home);
  let records: ChannelRecord[];
  try {
    records = readChannel(io, channelPathFor(target.orchestrationId, target.childId, target.home)).records;
  } catch {
    return fail("review-gate: 交卷被拒绝（通道不可读，不占交卷额度）：稍后重试，不要重复交卷。");
  }
  const decided = decideConclude(records, seq.round);
  if (!decided.ok) {
    return fail(`review-gate: 本轮已交过卷（report ${decided.reportId})——重复调用被拒绝，不计入任何轮次。停下等 opener，不要再调。`);
  }
  const streamPath = (deps.env()[JUDGE_STREAM_ENV] ?? "").trim() || undefined;
  const findingsCount = countStreamFindings((p) => deps.readText(p), streamPath, input.findings.length);
  const now = deps.now();
  const notes = (input.notes ?? "").trim();
  const report = {
    reportId: newChannelId("rep", now),
    kind: "report" as const,
    from: "child" as const,
    at: new Date(now).toISOString(),
    round: seq.round,
    verdict: input.verdict,
    findingsCount,
    // Verbatim: the opener records exactly what was concluded here.
    findings: input.findings,
    cwd: input.cwd,
    ...(input.docSync === undefined ? {} : { docSync: input.docSync }),
    // Prose only where prose is the product (adviser); a reviewer's report
    // carries none, so no judge text can reach the opener's context.
    ...(notes === "" ? {} : { summary: notes }),
  };
  try {
    appendRecord(io, target, report);
  } catch (err) {
    return fail(`review-gate: 交卷写入失败（不占交卷额度）：${(err as Error).message}。稍后重试。`);
  }
  return reply(
    `review-gate: 本轮结论已交卷（report ${report.reportId}，verdict=${input.verdict}，findings=${input.findings.length}）。停下等 opener，不要再调一次。`,
    { concluded: true, reportId: report.reportId, round: seq.round, verdict: input.verdict },
  );
}

/**
 * Register `judge_conclude` — the caller guards it to judge sessions only.
 *
 * The SCHEMA is role-shaped, not just the validation: a reviewer's tool
 * simply has no `notes` parameter to fill in.
 */
export function registerJudgeConcludeTool(host: ToolHost, deps: JudgeConcludeToolDeps): void {
  const role = readJudgeSideEnv(deps.env())?.role ?? "reviewer";
  const findingSchema = Type.Object({
    severity: Type.String(),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    issue: Type.String(),
    evidence: Type.Optional(Type.String({ description: "Where to look, when file:line is not enough (optional)" })),
  });
  const base = {
    verdict: Type.Enum({ READY: "READY", BLOCKED: "BLOCKED", NEEDS_HUMAN: "NEEDS_HUMAN" }),
    findings: Type.Optional(Type.Array(findingSchema)),
    cwd: Type.String({ description: "What `pwd` printed in the reviewed repo (never copy it from the task)" }),
    docSync: Type.Optional(Type.String({ description: "UPDATED | NOT_NEEDED, when the review covers code changes" })),
  };
  host.registerTool({
    name: JUDGE_CONCLUDE_TOOL,
    label: "Conclude Own Review Round",
    description:
      "Submit THIS review round's conclusion (one call per round; a second call is refused). " +
      (roleAcceptsNotes(role)
        ? "Your conclusion IS the prose: put it in `notes`. "
        : "The conclusion is the structured fields — there is no prose field, and prose written after this call is read by nobody. ") +
      "Only registered inside a review session — the main session never sees it.",
    parameters: Type.Object(
      roleAcceptsNotes(role)
        ? { ...base, notes: Type.String({ description: "Your conclusion and its key points, as plain prose" }) }
        : base,
    ),
    execute: (_id, params) => doConclude(deps, params),
  });
}
