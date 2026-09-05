/**
 * THE REQUIREMENT RESTATEMENT — the step before a contract is negotiated.
 *
 * ── WHAT IT IS FOR (user ask, 2026-09-06) ──
 *
 * The expensive failure in this repo is not a wrong implementation, it is a
 * CORRECT implementation of a requirement nobody agreed to. The user's rule:
 * an interview is optional (no doubts ⇒ no questions), but restating the
 * requirement is MANDATORY — the session must say back, before it writes any
 * contract, what the thing is, an example of it, what it looks like BEFORE the
 * change and AFTER it, and which steps become different. That is where a
 * misreading surfaces while it is still cheap.
 *
 * Until this module, "restate first" existed only as three paragraphs of
 * ADVICE (lib/agent-directives.ts, lib/orchestrator-plan-audit.ts,
 * docs/orchestrator-supervision.md). Advice is what the gate exists to stop
 * relying on: `propose_loop_goal` and `orchestrator_plan({action:"submit"})`
 * now REFUSE without a user-confirmed restatement on record — refuse the way
 * a failed goal audit refuses, with no dialog rendered at all, so a session
 * that skipped the step costs the user nothing but a refusal text.
 *
 * ── WHY THIS IS NOT MERGED INTO THE GOAL / PLAN PRE-AUDIT BINDING ──
 *
 * Both of those bind a hash too, so "just record it next to `goalPrereview`"
 * is a tempting simplification. It is the wrong one, and the difference is the
 * READER of each artifact:
 *
 *   - `goalPrereview` / `planAudit` bind a draft that a JUDGE read. They
 *     answer "did an independent auditor object to this text?" and their
 *     lifetime is one draft — any edit invalidates them, because the auditor
 *     judged those exact words.
 *   - a restatement binds what the USER confirmed about their own intent. It
 *     answers "do we agree on what is being asked?", it is written BEFORE any
 *     draft exists, and it deliberately SURVIVES the drafts that follow — a
 *     goal rejected over its wording does not mean the requirement changed
 *     (user decision, 2026-09-06: confirmed once, valid until restated; the
 *     newest confirmation wins).
 *
 * Merging them would force one lifetime onto two different facts: either a
 * reworded goal silently re-uses a stale understanding, or every wording fix
 * re-interrogates the user. So they stay separate records, and this comment
 * exists so the next round does not "simplify" them back together.
 *
 * ── WHAT THIS MODULE OWNS ──
 *
 * The record and its hash, the CONTENT check (a restatement that skips the
 * before/after contrast is the failure mode the whole step exists to prevent),
 * the two refusal texts, the consent surfaces, and `propose_restatement`
 * itself. Everything with a side effect arrives through `deps`, so every
 * branch is testable without a terminal.
 */

import { createHash } from "node:crypto";
import { resolve as pathResolve } from "node:path";

import { Type } from "typebox";

import {
  DELIVERY_STATION_CHOICES,
  deliveryStationLine,
  parseDeliveryStation,
  type DeliveryStation,
} from "./delivery-station.ts";
import type { ChannelDialogOutcome, ChannelDialogRequest } from "./orchestrator-child-channel.ts";
import { gitRootOfDir } from "./repo-resolve.ts";
import type { TaskMode } from "./task-mode.ts";
import type { ToolHost, ToolReply } from "./tool-host.ts";

// ---------------------------------------------------------------------------
// the record
// ---------------------------------------------------------------------------

/**
 * "The user confirmed THIS understanding of the requirement, and agreed the
 * round stops HERE."
 *
 * The text lives in the record rather than in a repo file on purpose. The
 * sidecar (`.pi/review-gate-state.json`) is gate-owned and un-editable by the
 * agent — the one storage in this system where a confirmed text cannot be
 * rewritten after the fact — and writing it into the worktree instead would
 * move the fingerprint, invalidating a READY review for a document that is
 * not part of the change.
 */
export interface RestatementRecord {
  /** The confirmed restatement, normalized (see {@link normalizeRestatement}). */
  text: string;
  /** sha256 of `text` — recomputable, so a tampered record is detectable. */
  hash: string;
  /** ISO time of the confirmation. */
  at: string;
  /** Where this round stops (the user agreed to this in the same dialog). */
  station: DeliveryStation;
}

/** Longest restatement the gate will store (a restatement is not a design doc). */
export const RESTATEMENT_MAX_CHARS = 8000;

/**
 * Shortest text that can plausibly carry context + example + before/after +
 * which steps change. Deliberately low: the marker check below is what
 * catches an empty gesture, and a length cap that argues with a concise
 * writer would be a rule about style rather than about substance.
 */
export const RESTATEMENT_MIN_CHARS = 120;

/**
 * Canonical form the hash is taken over: unified line endings, trimmed ends.
 *
 * Same rule as `normalizeGoalText`, deliberately NOT the same function: that
 * one is part of the goal contract (it is what `.pi/loop-goal.md` is compared
 * against), and sharing it would couple two contracts that are allowed to
 * evolve apart. The duplication is three tokens; the coupling would be
 * permanent.
 */
export function normalizeRestatement(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

/** sha256 over the normalized text. */
export function restatementHash(raw: string): string {
  return createHash("sha256").update(normalizeRestatement(raw), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// the content check
// ---------------------------------------------------------------------------

/** One accepted way of writing the before/after contrast. */
export interface ContrastToken {
  /**
   * `arrow` alone satisfies the check (it IS a contrast); `before` and
   * `after` must appear as a pair.
   */
  role: "arrow" | "before" | "after";
  /** The literal the text is searched for. */
  token: string;
}

/**
 * EVERY phrasing the gate accepts as "before → after", in one exported array.
 *
 * It is a named constant, and {@link hasBeforeAfterContrast} reads nothing
 * else, for a reason the user stated directly (2026-09-06): a keyword rule
 * with literals sprinkled through a function is a rule nobody can audit, and
 * a NARROW one punishes an honest restatement for its word choice. The array
 * is the contract — a test enumerates it entry by entry, and widening the
 * accepted surface means adding a row here, never editing a condition.
 */
export const RESTATEMENT_CONTRAST_TOKENS: readonly ContrastToken[] = Object.freeze([
  // An arrow is self-evidently a contrast, in any of its common spellings.
  { role: "arrow", token: "→" },
  { role: "arrow", token: "->" },
  { role: "arrow", token: "⇒" },
  { role: "arrow", token: "=>" },
  // "the way it is now"…
  { role: "before", token: "改之前" },
  { role: "before", token: "改前" },
  { role: "before", token: "之前" },
  { role: "before", token: "原来" },
  { role: "before", token: "现在是" },
  { role: "before", token: "现状" },
  { role: "before", token: "目前" },
  { role: "before", token: "before" },
  // …versus "the way it will be".
  { role: "after", token: "改之后" },
  { role: "after", token: "改后" },
  { role: "after", token: "之后" },
  { role: "after", token: "以后" },
  { role: "after", token: "改成" },
  { role: "after", token: "变成" },
  { role: "after", token: "将会" },
  { role: "after", token: "after" },
]);

/** Does the text contrast a BEFORE state with an AFTER state? */
export function hasBeforeAfterContrast(text: string): boolean {
  const haystack = text.toLowerCase();
  let before = false;
  let after = false;
  for (const { role, token } of RESTATEMENT_CONTRAST_TOKENS) {
    if (!haystack.includes(token.toLowerCase())) continue;
    if (role === "arrow") return true;
    if (role === "before") before = true;
    else after = true;
  }
  return before && after;
}

/**
 * The skeleton a refused session can COPY.
 *
 * This is the part that makes the refusal self-rescuing: the next session has
 * never seen this mechanism, and telling it "your restatement is not good
 * enough" without showing the shape would send it to read the source. Every
 * heading here contains an accepted contrast token, so filling it in passes.
 */
export const RESTATEMENT_SKELETON = [
  "## 需求反述（照抄这个骨架填即可）",
  "1. 这件事是什么：<一句话说清要解决的问题>",
  "2. 举个例子：<一个具体场景 / 一次具体调用>",
  "3. 改之前：<现在的行为、现在会发生什么>",
  "4. 改之后：<改完的行为、会发生什么>",
  "5. 哪几步会变得不同：<按步骤列出受影响的操作>",
].join("\n");

/** A submitted restatement that passed the content check, or the refusal. */
export type RestatementCheck =
  | { ok: true; text: string }
  | { ok: false; text: string };

/**
 * Is this text a restatement at all?
 *
 * Three mechanical facts only — non-empty, within the caps, and carrying a
 * before/after contrast. Whether the restatement is CORRECT is the user's
 * call in the dialog, and no amount of pattern matching could take that over.
 */
export function checkRestatementText(raw: unknown): RestatementCheck {
  const text = normalizeRestatement(String(raw ?? ""));
  if (text.length === 0) {
    return {
      ok: false,
      text: "review-gate: propose_restatement rejected —— 反述正文是空的。\n" + RESTATEMENT_SKELETON,
    };
  }
  if (text.length > RESTATEMENT_MAX_CHARS) {
    return {
      ok: false,
      text: `review-gate: propose_restatement rejected —— 反述 ${text.length} 字，超过 ` +
        `${RESTATEMENT_MAX_CHARS} 字上限。反述是让用户一眼看出理解偏差的对照，不是设计文档。`,
    };
  }
  if (text.length < RESTATEMENT_MIN_CHARS) {
    return {
      ok: false,
      text: `review-gate: propose_restatement rejected —— 反述只有 ${text.length} 字，` +
        `低于 ${RESTATEMENT_MIN_CHARS} 字下限：这么短装不下上下文、例子、改前改后与受影响的步骤。\n` +
        RESTATEMENT_SKELETON,
    };
  }
  if (!hasBeforeAfterContrast(text)) {
    return {
      ok: false,
      text: "review-gate: propose_restatement rejected —— 反述里没有「改之前 → 改之后」的对照，" +
        "而这正是反述唯一能提前暴露理解偏差的地方。\n" +
        "接受的写法很宽：只要出现箭头（→ / -> / ⇒ / =>），或者「改之前/改前/之前/原来/现在是/现状/目前」" +
        "配上「改之后/改后/之后/以后/改成/变成/将会」中的任意一对即可。\n" +
        RESTATEMENT_SKELETON,
    };
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// the gate decision the two contract tools ask
// ---------------------------------------------------------------------------

/** The slice of gate state this module reads and writes. */
export interface RestatementStateSlice {
  restatement?: RestatementRecord;
  taskMode?: TaskMode;
}

/**
 * Do the contract tools require a restatement in this mode?
 *
 * loop and orchestrator only. explore is investigation and normal is the gate
 * switched off — requiring a requirement contract there would be a rule about
 * sessions that have no contract to protect. This is SCOPE, not an escape
 * hatch: a session that becomes delivery work must upgrade to loop
 * (set_gate_mode), and the requirement arrives with the upgrade.
 */
export function restatementRequiredInMode(mode: TaskMode | undefined): boolean {
  return mode === "loop" || mode === "orchestrator";
}

/**
 * Is there a usable confirmation on record?
 *
 * Fail-closed on every uncertainty, and it RE-COMPUTES the hash rather than
 * trusting the stored one: a record whose `text` and `hash` disagree was
 * either corrupted or assembled by something other than this tool, and both
 * readings mean "nobody confirmed this".
 */
export function restatementConfirmed(record: RestatementRecord | undefined): boolean {
  if (!record || typeof record.text !== "string" || typeof record.hash !== "string") return false;
  if (normalizeRestatement(record.text).length === 0) return false;
  return restatementHash(record.text) === record.hash;
}

/** Which contract refused, so the text can say what to do next in ITS terms. */
export type RestatementGatedTool = "propose_loop_goal" | "orchestrator_plan";

/**
 * The refusal BOTH contract tools hand back — one text, so the two entry
 * points can never drift into two different stories.
 *
 * It has to be self-rescuing: the session reading it has never seen this
 * mechanism, so it carries the exact call to make (with its parameters), the
 * skeleton to copy, and the appeal route. The appeal is deliberately the
 * EXISTING `request_arbitration` — a new bypass would be a second way to skip
 * the step, which is the thing this module exists to remove.
 */
export function buildRestatementMissingRefusal(tool: RestatementGatedTool): string {
  const what = tool === "propose_loop_goal"
    ? "协商 loop goal"
    : "提交 plan 请用户批准";
  return [
    `review-gate: ${tool} 被拒 —— 还没有经用户确认的「需求反述」，因此没有弹出任何对话框。`,
    `规矩：先反述、用户确认，才能${what}。反述要在写契约之前暴露理解偏差，` +
    "所以它是独立的一步，而不是 goal / plan 里的一段话。",
    "",
    "下一步（照抄即可）：",
    "```",
    "propose_restatement({",
    '  restatement: "<你的反述全文，简体中文，见下面的骨架>",',
    `  station: "<${DELIVERY_STATION_CHOICES}>",   // 本轮交付到哪一站`,
    '  repo: "<可选：本轮绑定的仓库绝对路径，缺省为本会话仓库>"',
    "})",
    "```",
    "",
    RESTATEMENT_SKELETON,
    "",
    "交付站点三选一：precommit（门禁跑通，用户自己 commit）/ commit（提交完成，用户自己 push）/ pr（做到 PR 开出来）。",
    "拿不准就用 `ask_user` 问用户，别自己替他选。",
    "",
    "若你认为这是误判（例如本轮根本不是交付性工作），用 `request_arbitration` 申诉并说明理由；" +
    "门禁不提供任何豁免开关。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// the consent surfaces
// ---------------------------------------------------------------------------

/** The dialog the USER (or the PM on their behalf) confirms a restatement in. */
export const RESTATEMENT_CONFIRM_TITLE = "review-gate: 这是 AI 对需求的反述——理解对了吗？";

/** Approve / reject labels, exported so tests answer with the real strings. */
export const RESTATEMENT_APPROVE_LABEL = "理解正确，可以继续";
export const RESTATEMENT_REJECT_LABEL = "理解有偏差，退回重述";

/** The full restatement, printed to the transcript before the dialog opens. */
export function buildRestatementTranscriptMessage(text: string, station: DeliveryStation): string {
  return [
    "AI 对需求的反述（不可信数据）——确认前请读完：",
    "───────────────────────",
    text,
    "───────────────────────",
    deliveryStationLine(station),
    "确认的是**理解**：哪里说错了、漏了、多了，就点否并说明；确认之后它才会去谈 goal / 提交 plan。",
  ].join("\n");
}

/** Dialog body — the decision only (the text itself is already on screen). */
export function buildRestatementConfirmMessage(station: DeliveryStation): string {
  return [
    "反述全文（不可信数据）已显示在上方消息中，请先读完再决定。",
    deliveryStationLine(station),
    "确认 = 你认可它对需求的理解，并同意本轮停在这一站；不认可就点否，它会改完再来。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// propose_restatement
// ---------------------------------------------------------------------------

/** Everything the tool needs from the outside world. */
export interface RestatementToolDeps {
  /** The session's own repo — the default binding (a getter: session_start re-resolves it). */
  primaryRepoRoot(): string;
  /** What a relative `repo` parameter resolves against — a getter, same reason. */
  cwd(): string;
  /** One repo's gate state (the primary repo's state IS the extension's). */
  stateFor(root: string): RestatementStateSlice;
  /** Persist one repo's state. */
  persist(ctx: unknown, root: string): void;
  /** The gate's own log channel. */
  log(message: string): void;
  /** Put text in front of the user, in the transcript, right now. */
  showToUser(uiCtx: unknown, lead: string, body: string): boolean;
  /** `ui.confirm` with the dialog-height budget applied. */
  confirmBounded(
    uiCtx: unknown,
    title: string,
    message: string,
    pointer?: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /** Raise a dialog EITHER the human or the orchestrator may answer. */
  askEitherSide(
    request: Omit<ChannelDialogRequest, "hasUI">,
    hasUI: boolean,
    render: (signal: AbortSignal) => Promise<string | undefined>,
  ): Promise<ChannelDialogOutcome>;
  /** Injected for tests; production passes lib/repo-resolve.ts's gitRootOfDir. */
  gitRoot?(dir: string): string | null;
  /** Injectable clock, so a recorded time is assertable. */
  now?(): Date;
}

/** Just enough of pi's tool context for a dialog. */
interface RestatementUiContext {
  hasUI?: boolean;
}

/** Resolve the repo this restatement binds to — same rule as a goal's `repo`. */
function resolveRestatementRepo(
  deps: RestatementToolDeps,
  rawRepo: unknown,
): { ok: true; root: string } | { ok: false; text: string } {
  const requested = String(rawRepo ?? "").trim();
  if (!requested) return { ok: true, root: deps.primaryRepoRoot() };
  const abs = pathResolve(deps.cwd(), requested);
  const root = (deps.gitRoot ?? gitRootOfDir)(abs);
  if (!root) {
    return {
      ok: false,
      text: `review-gate: repo "${requested}"（解析为 ${abs}）不在可读的 git 仓库里 —— ` +
        "反述只能绑定到真实仓库（与 propose_loop_goal 的 repo 同语义）。",
    };
  }
  return { ok: true, root };
}

export async function doProposeRestatement(
  deps: RestatementToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const checked = checkRestatementText(params.restatement);
  if (!checked.ok) {
    return { content: [{ type: "text", text: checked.text }], details: { confirmed: false }, isError: true };
  }
  const repo = resolveRestatementRepo(deps, params.repo);
  if (!repo.ok) {
    return { content: [{ type: "text", text: repo.text }], details: { confirmed: false }, isError: true };
  }
  // A missing or misspelled station is READ as the strictest one rather than
  // refused: the reply says which station was recorded, so a typo costs one
  // corrected call instead of an interrupted negotiation.
  const station = parseDeliveryStation(params.station);
  const text = checked.text;

  const uiCtx = ctx as RestatementUiContext;
  deps.showToUser(uiCtx, RESTATEMENT_CONFIRM_TITLE, buildRestatementTranscriptMessage(text, station));

  let confirmed = false;
  let reason: string | undefined;
  let interrupted = false;
  try {
    const outcome = await deps.askEitherSide(
      {
        dialogKind: "confirm",
        topic: "restatement",
        title: RESTATEMENT_CONFIRM_TITLE,
        options: [RESTATEMENT_APPROVE_LABEL, RESTATEMENT_REJECT_LABEL],
        // The FULL text travels in the payload: an orchestrator answering on
        // the user's behalf must judge the same words the human would see,
        // never a summary the child retyped.
        //
        // NOT CHECKED HERE, ON PURPOSE (task split, 2026-09-06): a project
        // manager answering this topic could confirm a station looser than the
        // plan's own `deliveryStation`, and nothing compares the two. It grants
        // nothing today — the station is recorded, and NO gate reads it yet —
        // so the check belongs with the task that wires the station into the
        // ship gate. Whoever does that must add it there (a constraint-8-style
        // comparison against the approved plan) before the first gate starts
        // trusting this field.
        payload: text,
      },
      uiCtx.hasUI === true,
      async (renderSignal) => {
        const ok = await deps.confirmBounded(
          uiCtx,
          RESTATEMENT_CONFIRM_TITLE,
          buildRestatementConfirmMessage(station),
          "（反述全文见上方消息）",
          renderSignal,
        );
        return ok ? RESTATEMENT_APPROVE_LABEL : RESTATEMENT_REJECT_LABEL;
      },
    );
    confirmed = outcome.answer === RESTATEMENT_APPROVE_LABEL;
    reason = outcome.reason;
    interrupted = outcome.by === "interrupted";
  } catch {
    confirmed = false;
  }

  if (!confirmed) {
    if (interrupted) {
      return {
        content: [{
          type: "text",
          text: "review-gate: 反述确认被中断（项目经理发来消息，确认框已解除）。" +
            "处理完它的消息后重新调用 propose_restatement 即可 —— 这不是被否掉。",
        }],
        details: { confirmed: false, interrupted: true },
      };
    }
    return {
      content: [{
        type: "text",
        text: "review-gate: 用户不认可这份反述" +
          (reason ? `。他的意见：${reason}。请针对这一点重述` : "。先问清楚哪里理解错了（`ask_user`），再重述") +
          "，改完重新调用 propose_restatement；在此之前 propose_loop_goal / orchestrator_plan submit 仍会被拒。",
      }],
      details: { confirmed: false, reason: reason ?? null },
    };
  }

  const st = deps.stateFor(repo.root);
  st.restatement = {
    text,
    hash: restatementHash(text),
    at: (deps.now?.() ?? new Date()).toISOString(),
    station,
  };
  deps.persist(ctx, repo.root);
  deps.log(`restatement confirmed for ${repo.root} (${text.length} chars, station: ${station})`);
  return {
    content: [{
      type: "text",
      text: `review-gate: 反述已确认并记录（仓库：${repo.root}）。\n` +
        deliveryStationLine(station) + "\n" +
        "接下来：loop 会话去 `propose_loop_goal` 协商本会话的 goal；" +
        "项目经理去 `orchestrator_plan({ action: \"submit\" })` 提交 plan。\n" +
        "需求后来变了就再调一次本工具重述 —— 最新一份确认生效。",
    }],
    details: { confirmed: true, station, repo: repo.root },
  };
}

/** The family's single registration entry point. */
export function registerRestatementTools(host: ToolHost, deps: RestatementToolDeps): void {
  host.registerTool({
    name: "propose_restatement",
    label: "Propose Restatement",
    description:
      "Say the requirement BACK to the user and get it confirmed — the mandatory step before " +
      "`propose_loop_goal` (loop) or `orchestrator_plan({action:\"submit\"})` (orchestrator): both " +
      "REFUSE without a confirmed restatement on record, and show no dialog when they do. " +
      "Write `restatement` in SIMPLIFIED CHINESE (identifiers, paths and code tokens stay English) " +
      "and cover: what the thing is, a concrete example, what it looks like BEFORE the change and " +
      "AFTER it, and which steps become different — the before/after contrast is REQUIRED (arrows " +
      "→ / -> / ⇒ / => or 改之前…改之后 both count). `station` says where THIS round stops: " +
      "`precommit` (the gate's checks pass, the user commits) | `commit` (the commit is made, the " +
      "user pushes) | `pr` (the PR is open) — ask the user rather than choosing for them; an " +
      "unreadable value is recorded as the strictest, `precommit`. `repo` binds the restatement to " +
      "one repo (default: this session's), same meaning as propose_loop_goal's. The extension " +
      "shows the text to the user and records the confirmation itself; an orchestrator may answer " +
      "on the user's behalf (whoever answers first wins). Call it again whenever the requirement " +
      "changes — the newest confirmation is the one that counts.",
    parameters: Type.Object({
      restatement: Type.String({
        description:
          "The full restatement (Simplified Chinese): what it is, an example, BEFORE → AFTER, and " +
          "which steps change. Must contain a before/after contrast.",
      }),
      station: Type.String({
        description: `Where this round stops: ${DELIVERY_STATION_CHOICES} (unreadable ⇒ precommit)`,
      }),
      repo: Type.Optional(Type.String({
        description: "Absolute path of the repo this restatement binds to (default: the session repo).",
      })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doProposeRestatement(deps, params, ctx),
  });
}
