/**
 * Loop goal — the EXIT CONTRACT of a loop-mode session.
 *
 * A loop-mode session is billed per round and ends when the gates pass, but
 * "the gates pass" says nothing about whether the user's actual goal was met.
 * The loop goal closes that hole: a short, human-written file listing the
 * CHECKABLE facts that mean "done", so the same target drives all three roles —
 * the main agent slices work against it, `adviser` advises against it, and
 * `reviewer` accepts against it (an unmet criterion is a P1 finding, which the
 * verdict logic turns into BLOCKED).
 *
 * DESIGN CONSTRAINTS:
 *  - L8 HARD GATE, but bounded: an unconfirmed goal BLOCKS edit/write tool
 *    calls in loop mode (tool_call layer) and ships at L1. The confirmation
 *    itself is a dialog fact (the sidecar hash), never something the agent can
 *    write into the file; the file stays an ordinary repo file, so this is
 *    ceremony with a real anchor — the USER'S approval — not a self-written
 *    precondition.
 *  - The file lives at `.pi/loop-goal.md`, INSIDE the gate-owned `.pi/` scope
 *    (see GATE_EXCLUDE_PATHSPECS / isGateOwnedPath in lib/fingerprint.ts).
 *    Both halves of the gate honour that scope: it is excluded from the
 *    fingerprint AND skipped by the extension's edit tracking, so writing or
 *    rewriting the goal neither changes the digest nor arms the doc gate, and
 *    can never invalidate a READY review — the same self-deadlock the
 *    exclusion was introduced to fix.
 *  - Reading is best-effort: any IO error degrades to "no goal", never throws
 *    into before_agent_start.
 *  - The injected text is length-capped so a large goal file cannot eat the
 *    prompt budget.
 */

import { sha256 } from "./hash.ts";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TaskMode } from "./task-mode.ts";
import type { DeliveryStation } from "./delivery-station.ts";
import { buildRejection } from "./rejection-copy.ts";

/** Repo-root-relative location of the goal file (gate-excluded via `.pi/`). */
export const LOOP_GOAL_RELPATH = ".pi/loop-goal.md";

/**
 * The goal file for ONE session — per sidecar variant (R-10).
 *
 * The measured problem: an orchestration child shares the supervisor's
 * worktree, so it wrote its approved goal into the SUPERVISOR's
 * `.pi/loop-goal.md`. With one child that is merely surprising; with two
 * serial children it is data loss, because the second child's approval
 * overwrites the first one's — and the reviewer verifies against that very
 * file. The sidecar solved the same problem for gate state (F4) by moving the
 * CHILD, and the goal file now follows it: same variable
 * (`RG_STATE_VARIANT`), same shape, same reason.
 *
 * A session with no variant (the ordinary case) keeps the plain path, so
 * nothing about a normal loop session changes.
 */
export function loopGoalRelPath(variant?: string): string {
  const safe = variant
    ? variant.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 64)
    : "";
  return safe.length > 0 ? `.pi/loop-goal.${safe}.md` : LOOP_GOAL_RELPATH;
}


/** Max characters of goal text injected into the system prompt. */
export const LOOP_GOAL_MAX_CHARS = 1500;

/** Older than this ⇒ warn that the goal may be left over from another session. */
export const LOOP_GOAL_STALE_MS = 24 * 60 * 60 * 1000;

/** Upper bound on a goal the extension will write on the user's behalf. */
export const LOOP_GOAL_MAX_WRITE_CHARS = 20000;

export interface LoopGoal {
  /** A non-empty goal file was read. */
  present: boolean;
  /** Goal text, trimmed and capped at LOOP_GOAL_MAX_CHARS (empty when absent). */
  text: string;
  /** The text was cut at the cap. */
  truncated: boolean;
  /** Age of the file's mtime in ms (undefined when unknown). */
  ageMs?: number;
  /** Age exceeds LOOP_GOAL_STALE_MS — likely a leftover from a past session. */
  stale: boolean;
}

const ABSENT: LoopGoal = Object.freeze({ present: false, text: "", truncated: false, stale: false });

// ---------------------------------------------------------------------------
// L8 — the goal has to be NEGOTIATED, and the confirmation is a fact
// ---------------------------------------------------------------------------
//
// The goal file used to be written by the agent alone, which made it a
// self-issued exit contract: the agent guessed what "done" meant, wrote it
// down, and then graded itself against its own guess. Worse, a goal left over
// from the PREVIOUS task kept being injected verbatim for 24h, so a new
// session could inherit — and work to — someone else's contract.
//
// Both holes close with one fact: a goal counts only while the sidecar holds
// the hash of exactly this text, recorded when the USER approved it in a
// dialog the extension rendered. The agent can still write the file (it is an
// ordinary repo file), but writing it grants nothing: an unconfirmed goal has
// its body withheld from the prompt, blocks shipping in loop mode, and blocks
// edit/write tool calls in loop and undecided mode (L8, tool_call layer).

/** The sidecar record of "the user approved this exact goal text". */
export interface LoopGoalConfirmation {
  /** sha256 of the NORMALIZED goal text (see normalizeGoalText). */
  hash: string;
  /** ISO time of the user's approval. */
  at: string;
  /**
   * User-supplied reason carried with the decision: recorded only when the
   * user REJECTS with the objection (so the agent renegotiates against the
   * real problem instead of re-asking). The confirm path no longer asks
   * for a reason, so an approval never carries one; this stays optional
   * for backward compatibility with older sidecars that recorded one.
   * Never part of the hash — a reason is metadata, not goal text.
   */
  reason?: string;
  /**
   * WHERE THIS ROUND STOPS (2026-09-06) — precommit / commit / pr, shown to
   * the user in the same dialog that approved the goal.
   *
   * Optional for one reason only: sidecars written before this field existed
   * must keep their approval. A missing value is READ as `precommit`
   * (lib/delivery-station.ts) — the strictest station, which allows no ship
   * command at all — so an old record can only ever be under-privileged,
   * never over-privileged. Like `reason` it is NOT part of the hash: the
   * approval binds to the goal TEXT, and the station travels beside it.
   */
  station?: DeliveryStation;
}

/**
 * The sidecar record of "the dedicated `goal-auditor` role pre-reviewed THIS
 * exact draft" (L8b — written only by the gate's own `recordGoalPrereview`).
 *
 * The verdict is the EXTENSION's own reading of the auditor's structured
 * conclusion, never a boolean the agent attested: an agent-supplied
 * `passed` flag would make the pre-review a self-certification, which is the
 * hole this record exists to close. Like {@link LoopGoalConfirmation} it binds
 * to CONTENT — the hash of the text that was judged — so revising the draft
 * after a PASS drops the pass, which is exactly the "fix it and re-review"
 * loop the protocol asks for.
 *
 * Only the LATEST audit is kept (latest-only by design): recording a FAIL for
 * draft B after a PASS for draft A means draft A needs a fresh audit.
 */
export interface GoalPrereviewRecord {
  /** sha256 of the NORMALIZED draft text the auditor judged (goalTextHash). */
  hash: string;
  /** PASS ⇔ the extension read a READY verdict off the auditor's own conclusion. */
  verdict: "PASS" | "FAIL";
  /** ISO time the extension recorded this audit. */
  at: string;
  /** How many findings the auditor concluded with (an older record may carry null). */
  findingsTotal?: number | null;
  /**
   * The findings VERBATIM (severity + issue), as the auditor concluded them. Persisted
   * so a RE-audit of a revised draft can be handed the previous audit's
   * objections (goal criterion 2: incremental re-audit) — fingerprints alone
   * can look a finding up, they cannot carry it into the next task text.
   */
  findings?: Array<{ severity: string; issue: string }>;
  /**
   * The NORMALIZED draft text that was judged, when known. A re-audit of a
   * revised draft must be able to diff against the old draft, not just its
   * hash — the hash proves the texts differ, the text says how.
   */
  draft?: string;
  /**
   * Wall-clock milliseconds this audit took, when the agent reported when it
   * dispatched the auditor (goal criterion 6: first-vs-re-audit timing).
   * Absent on older records — diagnostic only, never a ship input.
   */
  durationMs?: number;
}

/**
 * Canonical form the hash is taken over: line endings unified and outer
 * whitespace trimmed, so a trailing newline or a CRLF checkout does not
 * invalidate a goal the user really did approve. Anything else — a reworded
 * criterion, an added line — changes the hash and needs a fresh approval,
 * which is the point.
 */
export function normalizeGoalText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

export function goalTextHash(raw: string): string {
  return sha256(normalizeGoalText(raw));
}

/**
 * Is the goal file's CURRENT content the text the user approved?
 *
 * Deliberately compares content, not timestamps: an agent edit after the
 * dialog silently changes the contract, and that must invalidate it.
 */
export function isLoopGoalConfirmed(
  goal: LoopGoal,
  confirmation: LoopGoalConfirmation | undefined,
  fileText?: string,
): boolean {
  if (!goal.present || !confirmation) return false;
  // `goal.text` may be truncated for the prompt, so the caller passes the raw
  // file text when it has it; without it, a truncated goal cannot be verified
  // and fails closed.
  const text = fileText ?? (goal.truncated ? undefined : goal.text);
  if (text === undefined) return false;
  return goalTextHash(text) === confirmation.hash;
}

/**
 * L8b decision: may `propose_loop_goal` show the approval dialog for this text?
 *
 * Fail-closed on every uncertainty — no record, a FAIL record, or a record
 * bound to DIFFERENT text all mean "not pre-reviewed". There is deliberately
 * no TTL: the binding is to content, so an old PASS for the identical text is
 * still a PASS for that text, and any edit invalidates it by hash.
 */
export function goalPrereviewPassed(
  record: GoalPrereviewRecord | undefined,
  goalText: string,
): boolean {
  if (!record || record.verdict !== "PASS") return false;
  return goalTextHash(goalText) === record.hash;
}

/**
 * THE GOAL SKELETON — the shape the agent COPIES instead of inventing one
 * (user ask, 2026-09-17: 「让 agent 在协商 goal 这些地方直接给模板，照着模板改」).
 *
 * WHY A TEMPLATE RATHER THAN A DESCRIPTION. The tool description used to
 * summarise the shape in one English line (task title, one-line intent, 3–7
 * checkable exit criteria, non-goals, ISO date) and every agent had to
 * translate that sentence into a document before it could negotiate anything.
 * The translation is where the checkable parts get lost — a criterion nobody
 * can falsify, a non-goal that was never decided — and each loss comes back as
 * a goal-audit round. Handing over the document itself removes the step.
 *
 * ONE OF THREE, AND THEY ARE ONE FAMILY: `RESTATEMENT_SKELETON`
 * (lib/restatement.ts) and `PLAN_TASK_SKELETON` (lib/orchestrator-directives.ts)
 * open the same way — `## <名字>（照抄这个骨架填即可）` — and blank the same
 * `<…>` way. `test/templates.test.ts` pins the three together.
 *
 * RENDERED, NEVER RESTATED: the surfaces that show it (this module's refusal
 * and `propose_loop_goal`'s description, lib/goal-tools.ts) interpolate this
 * constant; the standing block carries a POINTER only. That is what keeps one
 * copy from drifting into two.
 *
 * 「关键测试场景与边界情况」 IS A FIRST-CLASS COLUMN on purpose (user ask):
 * the criteria say what "done" means, this one says what will actually be
 * exercised — and naming what is deliberately NOT tested is how a reviewer
 * learns the boundary was CHOSEN rather than forgotten.
 */
export const LOOP_GOAL_SKELETON = [
  "## loop goal 骨架（照抄这个骨架填即可）",
  "# <任务标题>",
  "意图：<一句话>",
  "退出标准（每条必须能用一个命令或一次具体观察判定）：",
  "  1. <…>",
  "关键测试场景与边界情况：",
  "  - 正常路径：<…>",
  "  - 边界 / 错误路径：<…>",
  "  - 明确不测的：<…>（说明为什么）",
  "真实验收方案（acceptance judge 在真实环境里按它验收；确实没有可真实验收的东西，就写「本轮无真实验收（理由）」—— 那是要用户在批准框里拍板的豁免）：",
  "  - 正向真实调用：<起什么、调什么、期望返回什么>",
  "  - 反向验证：<改完后要再确认哪些原本正确的行为没被破坏>",
  "  - 环境前提：<要真实跑起来需要什么>",
  "非目标：",
  "  - <…>",
  "日期：<ISO>",
].join("\n");

/** Inputs for {@link buildGoalPrereviewRefusal} — all facts the EXTENSION derived. */
export interface GoalPrereviewRefusalContext {
  /** The pre-review record for the target repo (absent ⇒ never audited). */
  record?: GoalPrereviewRecord;
  /** The goal text that was just submitted. */
  goalText: string;
  /** Is `goal-auditor.md` dispatchable (present in a global/project agents dir)? */
  auditorInstalled: boolean;
  /** Package agents dir, or null when the layout probe could not locate it. */
  packageAgentsDir: string | null;
  /**
   * Repo the record was looked up in. A multi-repo session records the audit
   * per repo, so an anonymous "for this repo" leaves the agent guessing WHICH
   * one is missing it — the same trap the edit gate's repo hint exists for.
   */
  repoRoot?: string;
}

/**
 * Agent-facing refusal copy for a goal submitted without a matching PASS.
 *
 * It has to answer three questions at once, or the agent burns a round
 * guessing: WHY this was refused (missing vs. hash-mismatched), HOW to fix it
 * (the full recovery path), and — when the mismatch is invisible — WHAT text
 * the recorded hash belongs to. Trailing whitespace inside a line survives
 * normalizeGoalText, so "the same text" can hash differently with nothing to
 * see; echoing both hash prefixes plus the submitted first line makes that
 * diagnosable instead of maddening.
 */
export function buildGoalPrereviewRefusal(ctx: GoalPrereviewRefusalContext): string {
  const submittedHash = goalTextHash(ctx.goalText);
  const firstLine = normalizeGoalText(ctx.goalText).split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const why = !ctx.record
    ? `no goal-auditor pre-review has been recorded for ${ctx.repoRoot ?? "this repo"}`
    : ctx.record.verdict !== "PASS"
      // Echo BOTH hashes here too: a FAIL recorded for a DIFFERENT draft would
      // otherwise read as "your draft failed" and send the agent off fixing
      // objections that were never raised against this text.
      ? `the last recorded pre-review for ${ctx.repoRoot ?? "this repo"} is FAIL (recorded ${ctx.record.hash.slice(0, 12)}… at ${ctx.record.at}, submitted ${submittedHash.slice(0, 12)}…)` +
        (ctx.record.hash === submittedHash
          ? " — the auditor's objections against THIS text are not resolved yet"
          : " — note the hashes differ: that FAIL was recorded for ANOTHER draft, so this text has never been audited")
      : `the recorded PASS belongs to DIFFERENT text (recorded ${ctx.record.hash.slice(0, 12)}… at ${ctx.record.at}, submitted ${submittedHash.slice(0, 12)}…) — even an invisible trailing space changes the hash`;
  const bootstrap = !ctx.auditorInstalled
    ? "\nBOOTSTRAP: `goal-auditor` is not dispatchable yet (no goal-auditor.md in the global or project agents dir). " +
      (ctx.packageAgentsDir
        ? `Start a new session (the extension self-heals missing agent files from ${ctx.packageAgentsDir} at session start) or copy it from there now.`
        : "The extension could NOT locate the package agents directory (包内 agents 目录无法定位) — run `/gate-doctor` to see the probe result and reinstall the package.")
    : "";
  return buildRejection({
    what: `propose_loop_goal 被拒 —— ${why}`,
    why: "用户的批准框只在这一版文本通过 goal-auditor 审计之后才会弹出；" +
      "审计只看 P0/P1 反对意见（P2/Nit 不阻塞）。",
    by: "agent",
    next: [
      "1. 按反对意见改草稿；",
      "2. 再调一次 `propose_loop_goal` —— 审计是它自己跑的（组装任务、派 judge、裁决、记录 PASS），" +
      "没有单独的审计调用可以打。",
      // The recovery path a refused draft actually needs: a FORMAT to fill, not
      // another sentence about the format. Same skeleton the tool description
      // hands out before the first submit, from the same constant.
      "3. 照抄下面这个骨架改草稿（`<…>` 换成你的事实）：",
      "",
      LOOP_GOAL_SKELETON,
      "",
      "关于文本本身：提交给用户的 goal 正文必须用简体中文（标识符、路径、代码 token 保持英文），" +
      "否则审计直接拦下（“Simplified Chinese”）。",
      `本次提交的首行：${firstLine.slice(0, 120) || "(空)"}`,
    ].join("\n") + bootstrap,
  });
}


/** Ship-block copy for loop mode without a confirmed goal (L1 only). */
export const LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK =
  "loop goal not confirmed by the user — interview them with `ask_user` when anything is unclear " +
  "(it asks and pauses the loop until they answer), get your understanding confirmed with " +
  "`propose_restatement({restatement, station})` (REQUIRED first: without it the call below " +
  "refuses and shows no dialog), draft the goal in Simplified Chinese (identifiers, paths and code " +
  "tokens stay English), then call `propose_loop_goal` — it runs the `goal-auditor` audit itself " +
  "(dispatch, adjudicate, record) and only then asks the USER to approve it " +

  "in a dialog. Writing " + LOOP_GOAL_RELPATH + " yourself does not count.";

/**
 * Edit-block copy for loop mode without a confirmed goal (L8 tool_call gate).
 *
 * Unlike the ship block, this runs BEFORE the work starts — the whole point
 * of the edit gate is that the negotiation happens before the agent can
 * change a file. It also carries the goal pre-review step, which is MECHANICAL
 * since 2026-08-25 (it superseded the 2026-08-18 `adviser` merged rule): the
 * draft must pass a `goal-auditor` audit, and since 2026-08-29 the gate runs
 * that audit itself — since 2026-08-30 it runs INSIDE `propose_loop_goal`,
 * which dispatches the judge, adjudicates the verdict (only P0/P1 block) and
 * records it before the user is ever asked. The agent submits a draft, not a
 * sequence.
 *
 * A FUNCTION, not a constant, since the three-part rewrite: `repoRoot`
 * belongs in the 现象 line (a multi-repo session that lacks THIS repo's goal
 * would otherwise re-approve the primary one and stay stuck), and appending
 * it to a multi-line message would strand it on the last line.
 */
export function loopGoalUnconfirmedEditBlock(repoRoot?: string): string {
  return buildRejection({
    what: "edit/write 被拦 —— loop 模式下这个仓库还没有用户批准过的 loop goal" +
      (repoRoot ? ` (repo: ${repoRoot})` : ""),
    why: "L8 在编辑发生之前就拦：批准只有在动手之前才有意义 —— 到 ship 才拦是摆设，" +
      "那时 agent 已经把自己的退出条约写完了。",
    by: "agent",
    next: "按这个顺序谈出 goal：① 有不清楚的先 `ask_user` 问用户（它会问并暂停循环）；" +
      "② `propose_restatement({restatement, station})` 把需求反述给用户确认 —— 是什么、一个例子、" +
      "改之前 → 改之后、哪几步会变，外加本轮交付到哪一站（precommit | commit | pr）；这一步是硬前置，" +
      "没有它下一步不弹框；③ 用简体中文写 goal（标识符、路径、代码 token 保持英文 —— Simplified Chinese），" +
      "调 `propose_loop_goal`。这**一个**调用里就跑完 `goal-auditor` 的审计（门禁自己派 judge、" +
      "裁决 —— 只有 P0/P1 算阻塞 —— 记录 PASS），过了才弹用户批准框；审计被打回就按反对意见改完再提交一次。" +
      `自己写 ${LOOP_GOAL_RELPATH} 不算数。` +
      "（如果这个会话本来就不该跑完整循环，先用 set_gate_mode 分类：explore / normal 不要求 goal。）",
  });
}

/**
 * Pure decision behind the L8 edit gate: may an edit/write call pass in the
 * current mode?
 *
 * `taskMode` undefined (undecided) behaves as loop — fail-closed, exactly
 * like every other layer of the gate. explore/normal never require the goal:
 * explore deliberately allows small edits during an investigation, and normal
 * steps aside entirely. `orchestrator` is exempt for a different reason: its
 * exit contract is the PLAN (lib/orchestrator-plan.ts), approved in its own
 * dialog, and its write surface is closed far tighter than L8 could — an
 * orchestrator may only touch its plan and handoff docs, never code. Making
 * it also demand a loop goal would ask the user to approve two contracts for
 * one session. The caller supplies `goalConfirmed` for the TARGET repo (see
 * isLoopGoalConfirmed), so a multi-repo session checks each repo's own goal
 * before writing into it.
 */
export function loopGoalEditGate(opts: {
  taskMode: TaskMode | undefined;
  goalConfirmed: boolean;
}): boolean {
  if (opts.taskMode === "normal" || opts.taskMode === "explore") return true;
  if (opts.taskMode === "orchestrator") return true;
  return opts.goalConfirmed;
}

/**
 * Read this session's goal file. Never throws: any failure ⇒ absent.
 *
 * `variant` selects the per-session file (R-10); omitted ⇒ the plain
 * `.pi/loop-goal.md`, which is what an ordinary loop session uses.
 */
export function readLoopGoal(repoRoot: string, now: number = Date.now(), variant?: string): LoopGoal {
  const path = join(repoRoot, loopGoalRelPath(variant));

  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    return ABSENT;
  }
  if (raw === "") return ABSENT;

  let ageMs: number | undefined;
  try {
    ageMs = Math.max(0, now - statSync(path).mtimeMs);
  } catch {
    ageMs = undefined;
  }
  const truncated = raw.length > LOOP_GOAL_MAX_CHARS;
  return {
    present: true,
    text: truncated ? capText(raw) + "\n…[truncated — read the file for the rest]" : raw,
    truncated,
    ageMs,
    stale: ageMs !== undefined && ageMs > LOOP_GOAL_STALE_MS,
  };
}

/**
 * Cut to LOOP_GOAL_MAX_CHARS without splitting a surrogate pair — slicing
 * mid-pair would inject a lone half-character (mojibake) into the prompt.
 */
function capText(raw: string): string {
  const cut = raw.slice(0, LOOP_GOAL_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  const danglingHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return danglingHighSurrogate ? cut.slice(0, -1) : cut;
}

