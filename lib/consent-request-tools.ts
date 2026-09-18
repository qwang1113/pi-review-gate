/**
 * The two tools that ask the USER to RELAX the gate — `request_scope_limit`
 * (narrow the review fence to this session's own edits) and
 * `request_sensitive_edit` (one-shot authorization to write one blocked file).
 *
 * They live here rather than in `extensions/review-gate.ts` for the reason
 * this repository has a rule about (AGENTS.md §"架构规范"): that file is
 * ~8500 lines, and it got there one "just add the tool body here" at a time.
 * The orchestration tools moved out first (lib/orchestrator-*-tools.ts), then
 * the judge tools (lib/judge-session-tools.ts), the prepare family
 * (lib/review-prepare-tools.ts, lib/advisory-prepare-tools.ts) and the L7
 * Copilot pair (lib/copilot-review-tools.ts). Same shape here, with every
 * effect arriving through an injected `deps` object.
 *
 * THE BOUNDARY: this module owns the two CONSENT tools. Its sibling
 * lib/user-interaction-tools.ts owns `ask_user` and is the family's single
 * registration entry point — it calls the function below, so the extension
 * still wires the whole family exactly once (philosophy two: one thing, one
 * entry). The rules these tools apply are not theirs either: the grant
 * bookkeeping is lib/sensitive-grant.ts, the change set comes from
 * lib/fingerprint.ts, and the dialogs stay behind the injected seam — which
 * is what lets a test drive every branch (headless, unshowable, declined,
 * granted) without a terminal.
 *
 * TRUST: the agent can never approve any of this. Neither tool takes a
 * `confirmed` parameter; consent arrives from the extension-rendered dialog,
 * and a dialog that could not be SHOWN is fail-closed — never a decline, so
 * it does not burn the session's anti-grinding lock.
 *
 * BEHAVIOR IS FROZEN: this module was moved verbatim out of the extension.
 * Tool names, schemas, reply texts, `details` fields, log lines and error
 * branches are the ones the agent-facing contract already documents; changing
 * any of them is a separate, deliberate change.
 */

import { Type } from "typebox";

import type { ToolHost, ToolReply } from "./tool-host.ts";
import { isCodeFile, isDocFile, isSensitiveFile } from "./constants.ts";
import { choiceRows, parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
import { changedFiles } from "./fingerprint.ts";
import {
  SENSITIVE_GRANT_TTL_MS,
  addGrant,
  findGrant,
  isGateIntegrityPath,
  normalizeSensitivePath,
} from "./sensitive-grant.ts";
// TYPE-ONLY, so the runtime dependency stays one-way (that module imports
// this one to register the family; a type import is erased at compile time).
import type { ConsentToolDeps, UiContext } from "./user-interaction-tools.ts";

/**
 * Max characters of a sensitive path echoed INSIDE the dialog. The path is
 * agent-chosen and unbounded, so echoing all of it would bury the
 * authorization copy under one line; the full path is shown in the transcript
 * instead. (An INPUT-side cap on an untrusted value — it survived the
 * 2026-09-16 deletion of the dialog row budget, which was a different thing.)
 */
export const SENSITIVE_PATH_DIALOG_MAX_CHARS = 60;

/** The error shape both tools deny with. */
function deny(text: string): ToolReply {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}

/**
 * THE TOPICS THIS MODULE'S TOOLS ASK UNDER — deliberately NOT `string`.
 *
 * The channel's own topic union is the authority on which topics exist
 * (`lib/orchestrator-channel.ts`), and `askEitherSide` accepts only those; a
 * bare `string` here silently dropped that check (caught by the precommit
 * typecheck, not by the tests — node strips types without checking them).
 * This module asks under exactly these three, so it names exactly these.
 */
type ConsentTopic = "scope-limit" | "sensitive-edit" | "tmux-access";

/**
 * THE ONE CONSENT DIALOG (2026-09-17, user decision — quality round P1: the
 * third consent tool had just copied the same ~30 lines again, and the file
 * went 459 → 606).
 *
 * What the three tools ACTUALLY share is not their copy — each still writes
 * its own `spec`, `consentBody` and consequences — but this mechanism: ask
 * BOTH sides (the pane's human, and for an orchestration child its project
 * manager through the channel), parse the answer against the spec, and turn
 * it into one of three outcomes. A dialog that could not be SHOWN is never a
 * decline, so it does not burn the session's anti-grinding lock.
 *
 * AUTHORIZATION IS A WHITELIST, NEVER A ROW POSITION (functional reviewer P2
 * + quality round P1, 2026-09-17 — both judges caught the same first draft).
 * It read `option !== refuseLabel`, i.e. granted by elimination, and that
 * flips the failure direction on a consent path: `parseChoice` returns an
 * UNRECOGNIZED line as `{kind:"chose", option:<verbatim>}` (lib/choice-dialog.ts),
 * so any text that was not the refusal row became a GRANT — and a future spec
 * whose non-last row is not an authorization would have read as consent too.
 * Each caller therefore names its own grant labels, exactly as the three
 * copies did, and everything else is a refusal.
 */
async function askConsent(
  deps: ConsentToolDeps,
  uiCtx: UiContext,
  opts: {
    topic: ConsentTopic;
    spec: ChoiceSpec;
    consentBody: string;
    reason: string;
    /** The rows that mean YES for this tool — the caller's own labels. */
    grants: readonly string[];
  },
): Promise<
  | { outcome: "granted"; option: string }
  | { outcome: "declined"; declineReason?: string }
  | { outcome: "unshowable" }
> {
  const spec = opts.spec;
  // NO GRANT NAMED ⇒ there is nothing this tool may read as consent: fail
  // closed without rendering a box whose every answer would be a refusal.
  if (opts.grants.length === 0) return { outcome: "unshowable" };
  // …and a spec whose EVERY row is a grant is a box the user cannot say no
  // in — refuse to show it rather than make "yes" the only reachable answer.
  if (spec.options.every((o) => opts.grants.includes(o))) return { outcome: "unshowable" };
  try {
    const outcome = await deps.askEitherSide(
      {
        dialogKind: "select",
        topic: opts.topic,
        // The channel record carries the SAME text the human sees: a project
        // manager answering on the user's behalf has to read the consequences
        // (what granting covers, what refusing locks) before it can answer.
        title: `${spec.title}\n${opts.consentBody}`,
        options: choiceRows(spec),
        ...(opts.reason ? { payload: `AI 给出的理由（未经核实）: ${opts.reason.slice(0, 300)}` } : {}),
      },
      uiCtx.hasUI === true,
      (signal) => deps.askChoice(uiCtx, spec, { body: opts.consentBody, signal }),
    );
    const pick = parseChoice(outcome.answer, spec);
    // WHITELIST: only a row THIS tool called a grant authorizes anything — an
    // unrecognized answer is a refusal, not a consent.
    if (pick.kind === "chose" && opts.grants.includes(pick.option)) {
      return { outcome: "granted", option: pick.option };
    }
    // A refusal typed into the template's reason box is an objection the agent
    // can act on — dropping it would make the user repeat themselves.
    return {
      outcome: "declined",
      ...(pick.kind === "declined" && pick.reason ? { declineReason: pick.reason } : {}),
    };
  } catch {
    return { outcome: "unshowable" };
  }
}

// ---------- request_scope_limit ----------

export async function doRequestScopeLimit(
  deps: ConsentToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const state = deps.state();
  const uiCtx = ctx as UiContext;
  const reason = String(params.reason ?? "");

  if (state.taskMode === "normal") {
    return { content: [{ type: "text", text: "review-gate: normal mode — the gate is already off; no scope limit needed." }], details: {} };
  }
  // Same orchestrator self-block as request_sensitive_edit: the PM's own
  // session has no channel side to answer a consent dialog, so asking here
  // would freeze it on a human-only box. A child's scope-limit request is
  // answered with orchestrator_answer instead.
  if (state.taskMode === "orchestrator" && !deps.canChannelDialogs()) {
    return deny(
      "review-gate: 你是项目经理（orchestrator 会话）—— 不要自己调 request_scope_limit。" +
      "子会话的范围请求会出现在 orchestrator_wait 回执里，用 orchestrator_answer 代答。",
    );
  }
  if (state.scopeLimit) {
    return {
      content: [{ type: "text", text: "review-gate: a user-granted scope limit is already active — the gate covers only this session's edits." }],
      details: { alreadyLimited: true },
    };
  }
  if (deps.scopeLimitDeclined()) {
    return deny("review-gate: a scope-limit request was already DECLINED this session (by the user or the project manager) — do not ask again; satisfy the full gate or let the USER run /gate-bypass.");
  }
  if (!uiCtx.hasUI) {
    return deny("review-gate: no interactive UI — narrowing the gate fence requires the user's explicit dialog approval (fail-closed). Ask the user out-of-band.");
  }
  const all = changedFiles(deps.cwd);
  if (all === undefined) {
    return deny("review-gate: git status unavailable — cannot determine the pre-existing change set (fail-closed).");
  }
  const sessionRel = [...deps.sessionEditedPaths()];
  const sessionSet = new Set(sessionRel);
  // Only code/doc files arm the gate, so only they justify a dialog — but
  // the exemption snapshot below covers EVERY non-session changed file.
  const preexisting = all.filter((f) => (isCodeFile(f) || isDocFile(f)) && !sessionSet.has(f));
  const ahead = await deps.commitsAheadOfBase();
  if (preexisting.length === 0 && ahead === 0) {
    return deny("review-gate: every current change was made in THIS session — there is nothing pre-existing to exempt; the full gate applies.");
  }

  // USER CONSENT — extension-rendered dialog with fixed consequence copy;
  // the agent's reason is displayed as clearly-labeled untrusted data.
  //
  // The file LISTS go to the transcript, not the dialog: twenty paths would
  // bury the counts and the consequences the user is deciding on. (This was
  // also a geometry rule until 2026-09-16 — the row budget is gone, the
  // content rule is not.)
  const preexistingList = preexisting.slice(0, 20).join(", ") || "（仅分支上已有的提交）";
  const sessionList = sessionRel.length > 0 ? sessionRel.slice(0, 20).join(", ") : "（无）";
  const moreP = preexisting.length > 20 ? `（另有 ${preexisting.length - 20} 个未列出）` : "";
  const moreS = sessionRel.length > 20 ? `（另有 ${sessionRel.length - 20} 个未列出）` : "";
  deps.showToUser(
    uiCtx,
    "review-gate: AI 请求缩小审查范围——涉及的文件如下。",
    `既有变更 ${preexisting.length} 个（同意后不再触发门禁）: ${preexistingList}${moreP}` +
    (ahead > 0 ? `\n分支领先基线 ${ahead} 个提交` : "") + "\n" +
    `本会话修改 ${sessionRel.length} 个（仍需完整审查）: ${sessionList}${moreS}\n` +
    `AI 给出的理由（未经核实）: ${reason.slice(0, 300)}`,
  );
  // The consent dialog goes through the CHANNEL when this session is an
  // orchestration child: the project manager may answer it exactly like the
  // human, so a consent request can never deadlock the child on a dialog its
  // supervisor cannot even see (measured deadlock, 2026-08-31). A standalone
  // session renders the plain confirm as before.
  const GRANT_LABEL = "同意缩小审查范围";
  const spec: ChoiceSpec = {
    title: "review-gate: AI 请求把审查范围缩小到本会话的修改——是否同意？",
    options: [GRANT_LABEL, "拒绝（保持完整门禁）"],
    // The SAFE option is the recommendation: granting narrows the gate, and
    // the gate never nudges the user into weakening it.
    recommended: "拒绝（保持完整门禁）",
  };
  const consentBody =
    "门禁当前要求覆盖【本会话之前就存在】的修改。\n" +
    `既有变更 ${preexisting.length} 个` +
    (ahead > 0 ? `，分支领先基线 ${ahead} 个提交` : "") +
    `；本会话修改 ${sessionRel.length} 个（清单见上方消息）。\n` +
    "同意后：审查只需覆盖本会话自己的修改；若本会话没有任何修改，ship 拦截将解除。\n" +
    "拒绝后：AI 本会话内不能再次请求缩小范围。";
  const consent = await askConsent(deps, uiCtx, { topic: "scope-limit", spec, consentBody, reason, grants: [GRANT_LABEL] });

  // A dialog that could not be shown is NOT a decline: fail closed for
  // THIS request without burning the session's anti-grinding lock.
  if (consent.outcome === "unshowable") {
    return deny(
      "review-gate: the confirmation dialog could not be shown — no scope limit granted (fail-closed), " +
      "and this does NOT count as a user decline; retry when an interactive dialog is possible.",
    );
  }

  if (consent.outcome === "declined") {
    deps.declineScopeLimit();
    return deny(
      "review-gate: DECLINED the scope limit (by the user or the project manager) — the FULL gate applies (pre-existing " +
      "changes included). Scope requests are now locked for this session; continue the loop and cover everything." +
      (consent.declineReason ? `\n\n用户的意见：${consent.declineReason}` : ""),
    );
  }

  // GRANTED: snapshot EVERY non-session changed file as exempt (non-code
  // files never arm the gate, but freezing the full set keeps later
  // re-arm filtering unambiguous), then re-derive arming from THIS
  // session's own edits only. Verdicts/bindings are untouched — narrowing
  // the fence never fabricates a READY or a PASS.
  state.scopeLimit = {
    preexistingFiles: all.filter((f) => !sessionSet.has(f)),
    sessionFiles: sessionRel,
    at: new Date().toISOString(),
  };
  state.hasCodeChange = sessionRel.some(isCodeFile);
  state.hasDocChange = sessionRel.some(isDocFile);
  deps.persist(ctx);
  const stillArmed = state.hasCodeChange || state.hasDocChange;
  try {
    uiCtx.ui!.notify!(
      stillArmed
        ? "review-gate: 用户已同意缩小审查范围——门禁只覆盖本会话的修改（既有变更已豁免）。"
        : "review-gate: 用户已同意缩小审查范围——本会话没有自身修改，ship 拦截已解除（既有变更已豁免）。",
      "warning",
    );
  } catch { /* headless */ }
  return {
    content: [{
      type: "text",
      text: stillArmed
        ? "review-gate: the user GRANTED the scope limit. The gate now covers ONLY this session's edits: " +
          `${sessionRel.join(", ")}. When you run the review, instruct the reviewer to verdict only on ` +
          "findings in these files — pre-existing issues elsewhere are advisory, not blocking. Precommit " +
          "still runs project-wide; if it fails on pre-existing problems, report that to the user (only " +
          "the USER can /gate-bypass)."
        : "review-gate: the user GRANTED the scope limit and this session has no edits of its own — the " +
          "ship gate is disarmed for the pre-existing changes; you may proceed.",
    }],
    details: { granted: true, stillArmed, sessionFiles: sessionRel },
  };
}

// ---------- request_tmux_access ----------

/**
 * The user's permission to type tmux from bash (user decision, 2026-09-17).
 *
 * THE ONE RULE THAT MAKES THIS SAFE: the agent asks, the USER decides. There is
 * no `confirmed` parameter, the dialog is in the way, and a dialog that cannot
 * be shown is fail-closed — never a grant, and never a decline either (a
 * decline locks the session's requests, so a broken dialog must not burn it).
 *
 * TWO SCOPES, and the safest one is the recommendation: `once` spends itself on
 * the next tmux command, `session` rides the handoff to the successor as well.
 * The gate never nudges the user toward handing out the wider one — same rule
 * as the scope-limit dialog next door.
 */
export async function doRequestTmuxAccess(
  deps: ConsentToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const state = deps.state();
  const uiCtx = ctx as UiContext;
  const reason = String(params.reason ?? "");

  if (state.taskMode === "normal") {
    return { content: [{ type: "text", text: "review-gate: normal mode — the gate is off, nothing refuses tmux here; no authorization needed." }], details: {} };
  }
  // NO orchestrator self-block here (changed 2026-09-18). The other two consent
  // tools keep theirs — the manager writes no code, so it has nothing of its
  // own to ask for — but tmux is the one thing the gate refuses the MANAGER
  // ITSELF (`split-window` / `send-keys` / `kill-pane` are the tool-replaced
  // tier). Refusing the request on top of that left the one role whose tmux is
  // blocked with no way out at all, so it now asks exactly like a standalone
  // session: with no channel side to ask, `askEitherSide` renders the user's
  // own dialog.
  if (state.tmuxAccess) {
    return {
      content: [{ type: "text", text: `review-gate: 已经有 tmux 授权了（scope=${state.tmuxAccess.scope}）—— 直接用，不用再问。` }],
      details: { granted: true, alreadyGranted: true, scope: state.tmuxAccess.scope },
    };
  }
  if (deps.tmuxAccessDeclined()) {
    return deny("review-gate: a tmux-access request was already DECLINED this session (by the user or the project manager) — do not ask again; use the orchestration tools, or let the USER run the command by hand.");
  }
  if (!uiCtx.hasUI) {
    return deny("review-gate: no interactive UI — tmux access requires the user's explicit dialog approval (fail-closed). Ask the user out-of-band.");
  }

  const SESSION_LABEL = "允许：本会话和接力继任者都能用 tmux";
  const ONCE_LABEL = "只允许这一次";
  const spec: ChoiceSpec = {
    title: "review-gate: AI 请求在 bash 里使用 tmux 命令——是否授权？",
    options: [SESSION_LABEL, ONCE_LABEL, "拒绝"],
    // THE NARROW ONE IS RECOMMENDED. Granting tmux is handing the agent part of
    // the user's own working environment (panes, windows, the server itself),
    // and this gate never nudges toward the wider permission.
    recommended: ONCE_LABEL,
  };
  const consentBody =
    "被拦下的 tmux 操作是两类：会破坏或越出你 tmux 环境的（kill-server / kill-session / " +
    "kill-window / new-session / new-window / `set -g` / kill-pane -a），以及项目经理模式下" +
    "「已有编排工具替它做」的那三个（split-window / send-keys / kill-pane）。\n" +
    `「${SESSION_LABEL}」：本会话有效，且接力（session_handoff）的继任者继承——一块工作换人不用重问。\n` +
    `「${ONCE_LABEL}」：下一条 tmux 命令用掉就没。\n` +
    "「拒绝」：本会话不再允许申请，agent 只能用编排工具或请你手跑。\n" +
    "只读命令（tmux ls、display-message 等）从来不在拦截范围。";
  // WHICH grant this was is the caller's to read: this spec offers two, and
  // `askConsent` only promises that the answer was one of the two it named.
  const consent = await askConsent(deps, uiCtx, {
    topic: "tmux-access", spec, consentBody, reason,
    grants: [SESSION_LABEL, ONCE_LABEL],
  });

  if (consent.outcome === "unshowable") {
    return deny(
      "review-gate: the authorization dialog could not be shown — no tmux access granted (fail-closed), " +
      "and this does NOT count as a user decline; retry when an interactive dialog is possible.",
    );
  }
  if (consent.outcome === "declined") {
    deps.declineTmuxAccess();
    return deny(
      "review-gate: DECLINED tmux access (by the user or the project manager) — tmux commands stay blocked " +
      "in this session and the request is locked: do not ask again. Use the orchestration tools " +
      "(orchestrator_spawn / orchestrator_close / session_handoff), or ask the USER to run the command. " +
      (consent.declineReason ? `\n\n用户的意见：${consent.declineReason}` : ""),
    );
  }
  // WHICH grant this was is the caller's to read: this spec offers two, and
  // `askConsent` only promises that the answer was one of the two it named.
  const once = consent.option === ONCE_LABEL;

  state.tmuxAccess = { at: new Date().toISOString(), scope: once ? "once" : "session" };
  deps.persist(ctx);
  deps.log(`tmux access granted (scope=${state.tmuxAccess.scope})`);
  return {
    content: [{
      type: "text",
      text: once
        ? "review-gate: the user GRANTED tmux access for ONE command. Run exactly what you described, now — " +
          "the grant is spent by the next tmux operation that passes the gate."
        : "review-gate: the user GRANTED tmux access to this session and its handoff successor. tmux " +
          "commands now run; the orchestration tools remain the correct way to open and close child " +
          "sessions, and the grant dies with the work (an `orchestrator_attach` takeover inherits none of it).",
    }],
    details: { granted: true, scope: state.tmuxAccess.scope },
  };
}

// ---------- request_sensitive_edit ----------

export async function doRequestSensitiveEdit(
  deps: ConsentToolDeps,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolReply> {
  const state = deps.state();
  const uiCtx = ctx as UiContext;
  const reason = String(params.reason ?? "");

  const raw = String(params.path ?? "").trim();
  if (raw.length === 0) return deny("review-gate: path is required — name the exact file you need to edit.");
  const absPath = normalizeSensitivePath(raw, deps.cwd);

  if (!isSensitiveFile(absPath)) {
    return deny(
      `review-gate: "${raw}" is not a sensitive file — the gate does not block it. Edit it directly; ` +
      "no authorization is needed.",
    );
  }
  // ORCHESTRATOR SELF-BLOCK (measured deadlock, 2026-08-31 onchain run):
  // the project manager once called THIS tool to "authorize" a child's .env
  // edit. In the orchestrator's OWN session there is no channel side to
  // answer the consent dialog (it is not an orchestration child), so the
  // box rendered in its pane and only the human could close it — the PM
  // froze for 2h18m on a dialog it was supposed to answer, not to ask.
  // An orchestrator never edits sensitive files itself (it writes no code);
  // a child's sensitive request must be answered with `orchestrator_answer`.
  if (state.taskMode === "orchestrator" && !deps.canChannelDialogs()) {
    return deny(
      "review-gate: 你是项目经理（orchestrator 会话）—— 不要自己调 request_sensitive_edit。" +
      "子会话的敏感文件请求会出现在 orchestrator_wait 回执的『待答请求』里，" +
      "用 orchestrator_answer({childId, requestId, answer}) 代答（选『同意一次性修改』即授权）。" +
      "这个工具在项目经理会话里会弹一个只有用户能关的确认框，把你自己卡住。",
    );
  }
  // Gate-integrity paths are refused BEFORE any dialog: a "yes" here would
  // let the agent talk the user into disarming the L3 hook that checks it.
  if (isGateIntegrityPath(absPath)) {
    return deny(
      `review-gate: "${raw}" is part of the gate's own enforcement — never authorizable from ` +
      "here. `.git/hooks/*` IS the L3 layer, and `.pi/review-gate-state.json` / " +
      "`.pi/precommit-cache.json` are the verdicts and the already-passed record a commit is " +
      "checked against. A dialog here would be the agent asking permission to disarm its own " +
      "gate. If this change is really needed, the USER must make it by hand.",
    );
  }
  if (deps.sensitiveDeclinedPaths.has(absPath)) {
    return deny(
      `review-gate: editing "${raw}" was already DECLINED (by the user or the project manager) this session — do not ask again. ` +
      "Tell the user what the file needs and let them edit it themselves.",
    );
  }
  const existing = findGrant(deps.sensitiveGrants(), absPath, Date.now());
  if (existing) {
    return {
      content: [{
        type: "text",
        text:
          `review-gate: "${raw}" is already authorized (until ` +
          `${new Date(existing.expiresAt).toISOString()}). Make the edit now — the authorization ` +
          "is consumed once it succeeds.",
      }],
      details: { alreadyGranted: true, path: absPath },
    };
  }
  if (!uiCtx.hasUI) {
    return deny(
      "review-gate: no interactive UI — writing a sensitive file requires the user's explicit dialog " +
      "approval (fail-closed). Ask the user out-of-band to make the edit.",
    );
  }

  // USER CONSENT — extension-rendered dialog with fixed consequence copy;
  // the agent's reason is displayed as clearly-labeled untrusted data.
  //
  // The full path and reason go to the transcript first; the dialog gets a
  // TAIL-truncated path and the reason last, so a pathological path (the
  // agent picks it) can never bury the authorization copy.
  const shownPath = absPath.length > SENSITIVE_PATH_DIALOG_MAX_CHARS
    ? "…" + absPath.slice(-SENSITIVE_PATH_DIALOG_MAX_CHARS)
    : absPath;
  deps.showToUser(
    uiCtx,
    "review-gate: AI 请求一次性修改敏感文件——完整信息如下。",
    `文件（完整路径）: ${absPath}\n` +
    `AI 给出的理由（未经核实）: ${reason.slice(0, 300)}`,
  );
  // Same channel treatment as request_scope_limit (2026-08-31): an
  // orchestration child's consent dialog must be answerable by its project
  // manager, or it deadlocks the child on a dialog the supervisor cannot see.
  const GRANT_LABEL = "同意一次性修改";
  const spec: ChoiceSpec = {
    title: "review-gate: AI 请求一次性修改敏感文件——完整信息如下。",
    options: [GRANT_LABEL, "拒绝（保持拦截）"],
    // Refusing is the recommendation: the file holds secrets, and the gate
    // does not recommend handing them to a model.
    recommended: "拒绝（保持拦截）",
  };
  const consentBody =
    `文件（完整路径）: ${absPath}\n` +
    `AI 给出的理由（未经核实）: ${reason.slice(0, 300)}\n` +
    "同意后：只授权这一个路径，写入成功一次即失效；10 分钟内未使用也会过期，且不跨会话保留。\n" +
    "拒绝后：AI 本会话内不能再为该路径弹窗。\n" +
    "请确认这确实是你本次要求的一部分；文件里的密钥/凭据会暴露给模型。\n" +
    `文件（默认禁止 AI 写入）: ${shownPath}\n` +
    `AI 给出的理由（未经核实）: ${reason.slice(0, 300)}`;
  const consent = await askConsent(deps, uiCtx, { topic: "sensitive-edit", spec, consentBody, reason, grants: [GRANT_LABEL] });

  // A dialog that could not be shown is NOT a decline: fail closed for THIS
  // request without burning the path's anti-grinding lock.
  if (consent.outcome === "unshowable") {
    return deny(
      "review-gate: the confirmation dialog could not be shown — no authorization granted " +
      "(fail-closed), and this does NOT count as a user decline; retry when a dialog is possible.",
    );
  }

  if (consent.outcome === "declined") {
    deps.sensitiveDeclinedPaths.add(absPath);
    return deny(
      `review-gate: DECLINED editing "${raw}" (by the user or the project manager). This path is now locked for the session — ` +
      "do not ask again. Describe the change you wanted and let the user apply it." +
      (consent.declineReason ? `\n\n用户的意见：${consent.declineReason}` : ""),
    );
  }

  const now = Date.now();
  const expiresAt = now + SENSITIVE_GRANT_TTL_MS;
  deps.storeSensitiveGrants(addGrant(
    deps.sensitiveGrants(),
    { path: absPath, at: new Date(now).toISOString(), expiresAt, reason: reason.slice(0, 300) },
    now,
  ));
  deps.log(`sensitive-grant issued for ${absPath}`);
  try {
    uiCtx.ui!.notify!(`review-gate: 用户已授权 AI 修改 ${absPath}（一次性，10 分钟内有效）。`, "warning");
  } catch { /* headless */ }
  return {
    content: [{
      type: "text",
      text:
        `review-gate: the user GRANTED a one-shot edit of ${absPath}. Make ONLY the change you ` +
        "described, on this exact path, now — the authorization is consumed by the first successful " +
        "edit and expires in 10 minutes. Do not echo the file's secrets back to the user.",
    }],
    details: { granted: true, path: absPath, expiresAt },
  };
}

/**
 * Register the two consent tools.
 *
 * NOT called from the extension: lib/user-interaction-tools.ts is the
 * family's one registration entry point and calls this itself.
 */
export function registerConsentRequestTools(host: ToolHost, deps: ConsentToolDeps): void {
  host.registerTool({
    name: "request_scope_limit",
    label: "Request Scope Limit",
    description:
      "Ask the USER whether the review gate may be limited to THIS session's own edits when it " +
      "is demanding coverage of PRE-EXISTING changes (dirty files or branch commits that pre-date " +
      "this session). The extension shows the user a confirmation dialog (in an orchestration, " +
      "the project manager may answer it on the user's behalf through the channel — whoever " +
      "answers first wins). If the user agrees, the pre-existing changes recorded at grant time stop arming " +
      "the gate: with no session edits the ship gate disarms entirely; with session edits the " +
      "review scope narrows to the files this session touched (instruct the reviewer accordingly; " +
      "out-of-scope findings become advisory). If the user declines, scope requests lock for the " +
      "session — do not ask again. This never weakens the gate for the session's OWN edits.",
    parameters: Type.Object({
      reason: Type.String({ description: "One-line justification: which unmet requirements target pre-existing changes (shown to the user as untrusted data)" }),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doRequestScopeLimit(deps, params, ctx),
  });

  host.registerTool({
    name: "request_tmux_access",
    label: "Request Tmux Access",
    description:
      "Ask the USER for authorization to run tmux commands from bash. The gate REFUSES an " +
      "unauthorized tmux operation (a destructive one like `kill-server` / `kill-session` / " +
      "`new-session` / `set -g`, or, in project-manager mode, one an orchestration tool already " +
      "does properly: `split-window` / `send-keys` / `kill-pane`), and this is the ONLY way to " +
      "lift that. The extension shows the user the gate's dialog; in an orchestration the child " +
      "asks its project manager through the channel, but the manager may only answer after the " +
      "USER granted it the `tmux-access` scope (same rule as a sensitive file — `kill-server` " +
      "would take the user's whole session with it). A project manager asks for its OWN session " +
      "the way a standalone session does — there is no channel side to ask, so the dialog goes " +
      "straight to the user. A grant covers THIS session and the " +
      "`session_handoff` successor it names, so " +
      "a long piece of work does not re-ask after a handover; 'once' is consumed by the next tmux " +
      "command. An `orchestrator_attach` takeover inherits nothing. Read-only tmux commands " +
      "(`tmux ls`, `display-message`) were never gated. Ask only when the work genuinely needs " +
      "tmux, and say what you will run.",
    parameters: Type.Object({
      reason: Type.String({ description: "One line: which tmux command(s) and why (shown to the user as untrusted data)" }),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doRequestTmuxAccess(deps, params, ctx),
  });

  host.registerTool({
    name: "request_sensitive_edit",
    label: "Request Sensitive File Edit",
    description:
      "Ask the USER for one-time authorization to edit ONE sensitive file (.env, private key, " +
      "credentials…) that the gate blocks by default. The extension shows a confirmation dialog " +
      "(in an orchestration, the project manager may answer it on the user's behalf through the " +
      "channel — whoever answers first wins; the user's own dialog stays open either way). " +
      "A granted authorization covers that EXACT path only, is " +
      "consumed by the first edit that SUCCEEDS, and expires after 10 minutes; it is never " +
      "persisted, so it dies with the session. The gate's OWN enforcement is NEVER grantable: " +
      "`.git/` internals (the L3 hooks) and `.pi/review-gate-state.json` / " +
      "`.pi/precommit-cache.json` (the verdicts and the already-passed record a commit is checked " +
      "against). If the user declines, that path is locked for the session — " +
      "do not ask again, ask the user to edit it by hand. Call this only when the edit is genuinely " +
      "required by the user's request, and state exactly what you will change.",
    parameters: Type.Object({
      path: Type.String({ description: "The sensitive file to edit — absolute, or relative to the session cwd" }),
      reason: Type.String({ description: "One line: what you will change in this file and why (shown to the user as untrusted data)" }),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => doRequestSensitiveEdit(deps, params, ctx),
  });
}
