import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  registerUserInteractionTools,
  type UserInteractionToolDeps,
} from "../lib/user-interaction-tools.ts";
import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import type { ChoiceSpec } from "../lib/choice-dialog.ts";
import { BACK_ROW, DECLINE_ROW } from "../lib/choice-dialog.ts";
import { emptyState, type GateState } from "../lib/gate-state.ts";
import { SENSITIVE_GRANT_TTL_MS, type SensitiveGrant } from "../lib/sensitive-grant.ts";
import { git, neutraliseHostGitConfig } from "./helpers/git.ts";

/**
 * The three user-facing tools used to live inside the extension, where
 * exercising "the dialog could not be shown" or "the user declined" meant a
 * terminal, a session and a human. They are now a lib/ module whose dialogs,
 * gate state and loop arming all arrive as `deps` — so every branch below runs
 * against fakes, and a behavior change during the move has to survive an
 * assertion instead of a reviewer's eyes.
 *
 * WHAT IS DELIBERATELY REAL: the git status behind `request_scope_limit`. The
 * pre-existing/session split is the whole point of that tool, and a faked
 * change set would assert nothing about it.
 */

neutraliseHostGitConfig();

interface Fake {
  deps: UserInteractionToolDeps;
  tools: Map<string, (params: Record<string, unknown>) => Promise<ToolReply>>;
  order: string[];
  st: GateState;
  persists: number;
  armed: boolean[];
  notices: Array<{ lead: string; body: string }>;
  confirms: string[];
  logs: string[];
  grants: SensitiveGrant[];
  declined: Set<string>;
  scopeDeclined: boolean;
  /**
   * THE TIMEOUT PATH (review round 3 P1): nobody answered the dialog AND the
   * proxy could not either. It reaches the caller as `onUndecided` plus an
   * `undefined` answer — the same `undefined` a dismissed box gives — which is
   * exactly why the caller has to be told separately.
   */
  proxyFailed: boolean;
  tmuxDeclined: boolean;
  /** What the confirm dialog answers, or "throw" to simulate an unshowable one. */
  confirmAnswer: boolean | "throw";
  /** What each ask_user dialog answers (one per question, in order). */
  answers: Array<string | undefined>;
  /**
   * Scripted rows for the PANE dialogs, one per `askChoice` call, in order
   * (the walk-back tests need the same question asked twice).
   */
  dialogRows: Array<string | undefined>;
  /** Every `askChoice` call's spec and options, in order. */
  dialogCalls: Array<{ spec: ChoiceSpec; back?: boolean; body?: string }>;
  asked: string[];
  /** The last ChoiceSpec rendered — the ORDER and the recommendation live there. */
  lastSpec?: ChoiceSpec;
  /** This fake session can route dialogs through an orchestration channel. */
  canChannelDialogs: boolean;
  /** Grants minted via grantProxyScope, in order. */
  grantsMinted: Array<{ scope: string; via: string }>;
  /** Scopes taken back via revokeProxyScope, in order. */
  grantsRevoked: string[];
  cwd: string;
  sessionEdited: string[];
  ahead: number;
}

/** A tool context with a UI (the normal, interactive case). */
const UI_CTX = { hasUI: true, ui: { notify: () => {}, select: undefined, editor: undefined } };

function fake(over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    deps: undefined as unknown as UserInteractionToolDeps,
    tools: new Map(),
    order: [],
    st: emptyState("sess-1", 10),
    persists: 0,
    armed: [],
    notices: [],
    confirms: [],
    logs: [],
    grants: [],
    declined: new Set<string>(),
    scopeDeclined: false,
    proxyFailed: false,
    tmuxDeclined: false,
    confirmAnswer: true,
    answers: [],
    dialogRows: [],
    dialogCalls: [],
    asked: [],
    canChannelDialogs: false,
    grantsMinted: [],
    grantsRevoked: [],
    cwd: "/nonexistent-repo",
    sessionEdited: [],
    ahead: 0,
    ...over,
  };
  f.deps = {
    state: () => f.st,
    persist: () => { f.persists += 1; },
    setLoopArmed: (armed) => { f.armed.push(armed); },
    showToUser: (_uiCtx, lead, body) => { f.notices.push({ lead, body }); return true; },
    askChoice: async (_uiCtx, spec, opts) => {
      f.lastSpec = spec;
      f.dialogCalls.push({ spec, back: opts?.back, body: opts?.body });
      f.confirms.push(`${spec.title}\n${opts?.body ?? ""}`);
      if (f.proxyFailed) { opts?.onUndecided?.(); return undefined; }
      if (f.dialogRows.length > 0) return f.dialogRows.shift()!;
      if (f.confirmAnswer === "throw") throw new Error("no dialog here");
      return f.confirmAnswer ? spec.options[0] : undefined;
    },
    canChannelDialogs: () => f.canChannelDialogs ?? false,
    askEitherSide: async (request, _hasUI, thunk) => {
      f.asked.push(request.title);
      // THE TIMEOUT PATH (review round 3 P1) runs the HUMAN side with nobody
      // there: `askChoice` calls `onUndecided` and answers `undefined`, which is
      // what a dismissed box looks like too — and telling them apart is the
      // whole point of that flag.
      if (f.proxyFailed) return { answer: await thunk(new AbortController().signal), by: "dismissed", requestId: "r1" };
      const answer = f.answers.length > 0
        ? f.answers.shift()!
        : request.topic === "scope-limit" || request.topic === "sensitive-edit" || request.topic === "tmux-access"
          ? (f.confirmAnswer === "throw" ? (() => { throw new Error("no dialog here"); })() : (f.confirmAnswer === true ? request.options[0] : undefined))
          : undefined;
      return { answer, by: answer === undefined ? "dismissed" : "human", requestId: "r1" };
    },
    cwd: f.cwd,
    sessionEditedPaths: () => f.sessionEdited,
    commitsAheadOfBase: async () => f.ahead,
    scopeLimitDeclined: () => f.scopeDeclined,
    declineScopeLimit: () => { f.scopeDeclined = true; },
    tmuxAccessDeclined: () => f.tmuxDeclined,
    declineTmuxAccess: () => { f.tmuxDeclined = true; },
    sensitiveGrants: () => f.grants,
    storeSensitiveGrants: (next) => { f.grants = next; },
    sensitiveDeclinedPaths: f.declined,
    log: (message) => { f.logs.push(message); },
    grantProxyScope: (scope, via) => { f.grantsMinted.push({ scope, via }); },
    revokeProxyScope: (scope) => { f.grantsRevoked.push(scope); },
  };
  const host: ToolHost = {
    registerTool: (definition) => {
      f.order.push(definition.name);
      f.tools.set(definition.name, (params) => definition.execute("id", params, undefined, undefined, UI_CTX));
    },
  };
  registerUserInteractionTools(host, f.deps);
  return f;
}

function textOf(reply: ToolReply): string {
  return reply.content.map((c) => c.text).join("\n");
}

/**
 * Run one tool with an explicit context.
 *
 * The context reaches a tool through `execute`, so a per-call context needs
 * its own registration — the real host does exactly this once, and a
 * throwaway host lets each test say what kind of session it is (interactive
 * or headless) without weakening anything the module does.
 */
function runWithCtx(f: Fake, tool: string, params: Record<string, unknown>, ctx: unknown): Promise<ToolReply> {
  let run: ((params: Record<string, unknown>) => Promise<ToolReply>) | undefined;
  const host: ToolHost = {
    registerTool: (definition) => {
      if (definition.name === tool) {
        run = (p) => definition.execute("id", p, undefined, undefined, ctx);
      }
    },
  };
  registerUserInteractionTools(host, f.deps);
  assert.ok(run, `${tool} must be registered`);
  return run(params);
}

/** The common case: an interactive session. */
function call(f: Fake, tool: string, params: Record<string, unknown> = {}): Promise<ToolReply> {
  return runWithCtx(f, tool, params, UI_CTX);
}

// ---------- registration ----------

test("ONE registration call wires all four user-facing tools", () => {
  const f = fake();
  assert.deepEqual(f.order, ["ask_user", "request_scope_limit", "request_tmux_access", "request_sensitive_edit"]);
});

// ---------- request_tmux_access ----------

/** The two labels the dialog offers, spelled as the tool spells them. */
const TMUX_SESSION = "允许：本会话和接力继任者都能用 tmux";
const TMUX_ONCE = "只允许这一次";

test("request_tmux_access: the user grants the SESSION scope, and it is persisted", async () => {
  const f = fake({ answers: [TMUX_SESSION] });
  const reply = await call(f, "request_tmux_access", { reason: "要把错位的 pane 调回去" });
  assert.equal(reply.details?.granted, true);
  assert.equal(reply.details?.scope, "session");
  assert.equal(f.st.tmuxAccess?.scope, "session", "the grant lives in the sidecar, not in memory");
  assert.ok(f.persists > 0, "a grant that is not written dies with the next reload");
  assert.equal(f.asked.length, 1, "exactly one dialog, through the channel-aware seam");
  assert.match(f.asked[0]!, /kill-server/, "the user is told WHICH commands were refused");
  assert.match(f.asked[0]!, /只读命令/, "and which ones never were");
});

test("request_tmux_access: the recommendation is the NARROW grant", async () => {
  const f = fake();
  // Go all the way through the renderer: the ORDER and the recommendation are
  // decided by the spec, and the fake's channel path would answer before ever
  // looking at it.
  f.deps.askEitherSide = async (_request, _hasUI, render) => {
    const answer = await render(new AbortController().signal);
    return { answer, by: "human", requestId: "r1" };
  };
  await call(f, "request_tmux_access", { reason: "x" });
  // Same rule as the scope-limit dialog next door: the gate never nudges the
  // user toward the wider permission, so the narrow grant is the recommended
  // one and the standing grant is offered, not pushed.
  const spec = f.lastSpec!;
  assert.equal(spec.recommended, TMUX_ONCE);
  assert.deepEqual(spec.options, [TMUX_SESSION, TMUX_ONCE, "拒绝"]);
  assert.ok(spec.options.includes(spec.recommended), "the recommendation must be one of the options");
});

test("request_tmux_access: 'once' is a different scope, and a refusal locks the session", async () => {
  const once = fake({ answers: [TMUX_ONCE] });
  const granted = await call(once, "request_tmux_access", { reason: "一条命令" });
  assert.equal(granted.details?.scope, "once");
  assert.equal(once.st.tmuxAccess?.scope, "once");

  const no = fake({ confirmAnswer: false });
  const declined = await call(no, "request_tmux_access", { reason: "x" });
  assert.equal(declined.isError, true);
  assert.equal(no.tmuxDeclined, true, "one 'no' is the answer for the session");
  assert.equal(no.st.tmuxAccess, undefined, "a decline grants nothing");
});

test("request_tmux_access: an already-granted session is told, not asked again", async () => {
  const f = fake();
  f.st.tmuxAccess = { at: "2026-09-17T00:00:00.000Z", scope: "session" };
  const reply = await call(f, "request_tmux_access", { reason: "再来一次" });
  assert.equal(reply.details?.alreadyGranted, true);
  assert.deepEqual(f.asked, [], "no second dialog for a grant that is already standing");
});

test("request_tmux_access: a declined session, no UI, and an unshowable dialog all fail closed", async () => {
  const locked = fake({ tmuxDeclined: true });
  const lockedReply = await call(locked, "request_tmux_access", { reason: "x" });
  assert.equal(lockedReply.isError, true);
  assert.match(textOf(lockedReply), /already DECLINED/);
  assert.deepEqual(locked.asked, [], "a locked session must not raise the dialog again");

  const headless = fake();
  const noUi = await runWithCtx(headless, "request_tmux_access", { reason: "x" }, { hasUI: false });
  assert.equal(noUi.isError, true);
  assert.match(textOf(noUi), /no interactive UI/);
  assert.equal(headless.tmuxDeclined, false, "fail-closed is not a decline");

  const broken = fake({ confirmAnswer: "throw" });
  const failed = await call(broken, "request_tmux_access", { reason: "x" });
  assert.equal(failed.isError, true);
  assert.match(textOf(failed), /could not be shown/);
  assert.equal(broken.tmuxDeclined, false, "a dialog that never appeared must not burn the lock");
});

test("request_tmux_access: a project manager with no channel side is no longer refused", async () => {
  // The ONE role whose own tmux operations the gate refuses (`split-window` /
  // `send-keys` / `kill-pane` are the tool-replaced tier) used to be refused
  // the REQUEST as well, so its refusal had no way out at all (2026-09-18).
  //
  // WHAT THIS COVERS, and what it deliberately does not: the request reaches
  // the dialog seam and the grant it returns is the one any session gets.
  // WHICH dialog that seam raises is not this module's contract —
  // `deps.askEitherSide` decides, and the real one renders the user's own box
  // when the session has no channel binding (the `!binding` branch in
  // extensions/review-gate.ts). Asserting the routing HERE would only assert
  // what the fake was told to do.
  const f = fake({ answers: [TMUX_SESSION], canChannelDialogs: false });
  f.st.taskMode = "orchestrator";
  const reply = await call(f, "request_tmux_access", { reason: "要开一个裸 pane 看日志" });
  assert.equal(reply.isError, undefined, "the manager is no longer refused outright");
  assert.equal(reply.details?.granted, true);
  assert.equal(f.st.tmuxAccess?.scope, "session");
  assert.equal(f.asked.length, 1, "the request reaches the dialog seam");

  // Removing the self-block must not have removed the fail-closed check it
  // used to sit in front of: a manager with no UI is still granted nothing.
  const headless = fake();
  headless.st.taskMode = "orchestrator";
  const noUi = await runWithCtx(headless, "request_tmux_access", { reason: "x" }, { hasUI: false });
  assert.equal(noUi.isError, true);
  assert.match(textOf(noUi), /no interactive UI/);
});

// ---------- ask_user ----------

test("ask_user: the dialog title is a bare progress label, the question rides in the body", async () => {
  const f = fake();
  // The default fake answers without raising a box; this one goes all the way
  // through the renderer, which is where the title and the body are decided.
  f.deps.askEitherSide = async (_request, _hasUI, render) => {
    const answer = await render(new AbortController().signal);
    return { answer, by: "human", requestId: "r1" };
  };
  await call(f, "ask_user", {
    questions: [{ text: "要改的范围是哪些？\n（第二行是补充）", options: ["A", "B"], recommended: "A" }],
  });
  const seen = f.confirms[0]!.split("\n");
  assert.equal(seen[0], "问题 1 / 1", "no truncated copy of the question in the title");
  assert.equal(seen.slice(1).join("\n"), "要改的范围是哪些？\n（第二行是补充）",
    "the WHOLE question is in the body");
});

test("ask_user: a box the user CLOSED is not 'this environment has no dialogs'", async () => {
  // Closing the box is THE way out of an interview (2026-09-17), so this is a
  // NORMAL path. Reporting it as "no dialogs here — paste every question into
  // your reply" is false (the box was right in front of them) and costs the
  // agent a whole iteration. What makes a session headless is that no box ever
  // reached the screen — not that nobody answered.
  const f = fake({ confirmAnswer: false });
  f.deps.askEitherSide = async (_request, _hasUI, render) => {
    const answer = await render(new AbortController().signal);
    return { answer, by: "human", requestId: "r1" };
  };
  const reply = await call(f, "ask_user", {
    questions: [
      { text: "第一题", options: ["A", "B"], recommended: "A" },
      { text: "第二题", options: ["A", "B"], recommended: "A" },
    ],
  });
  assert.doesNotMatch(textOf(reply), /没有可用的对话框/, "the box WAS shown — do not claim otherwise");
  assert.doesNotMatch(textOf(reply), /写进你的回复/);
  assert.match(textOf(reply), /循环已暂停/, "an unanswered interview still pauses the loop");
  assert.deepEqual(f.armed, [false]);
});

test("ask_user: an empty question list is refused without touching the loop", async () => {
  const f = fake();
  const reply = await call(f, "ask_user", { questions: [] });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /没有提交任何问题/);
  assert.deepEqual(f.armed, [], "a rejected call must not arm or disarm anything");
  assert.equal(f.persists, 0);
});

test("ask_user: headless PAUSES the loop and hands the questions back", async () => {
  const f = fake();
  const reply = await runWithCtx(
    f,
    "ask_user",
    { questions: [{ text: "选 A 还是 B？", options: ["A", "B"], recommended: "A" }] },
    { hasUI: false },
  );
  assert.equal(reply.isError, true);
  assert.equal(reply.details?.pending, true);
  assert.deepEqual(f.armed, [false], "no UI ⇒ the loop stops until the user answers");
  assert.ok(f.st.pausedQuestion, "the pause is recorded in the gate state");
  assert.match(f.st.pausedQuestion!.question, /选 A 还是 B？/);
  assert.equal(f.persists, 1, "and it is persisted, so it survives a restart");
  assert.deepEqual(f.asked, [], "no dialog may be raised where none can render");
});

test("ask_user: every answer re-arms the loop and clears the pause", async () => {
  const f = fake({ answers: ["A", "B"] });
  f.st.pausedQuestion = { question: "旧问题", at: "2026-08-30T00:00:00.000Z" };
  const reply = await call(f, "ask_user", {
    questions: [
      { text: "问题一", options: ["A", "B"], recommended: "A" },
      { text: "问题二", options: ["A", "B"], recommended: "A" },
    ],
  });
  assert.equal(reply.isError, undefined);
  assert.equal(reply.details?.answered, 2);
  assert.equal(reply.details?.pending, false);
  assert.equal(f.armed.at(-1), true, "nothing is waiting on the user ⇒ the loop runs again");
  assert.equal(f.st.pausedQuestion, undefined);
  assert.equal(f.st.askUser?.answers.length, 2, "the interview transcript is kept");
});

test("ask_user: a dismissed dialog is silence, not consent — the loop pauses", async () => {
  const f = fake({ answers: [undefined] });
  const reply = await call(f, "ask_user", { questions: [{ text: "要合并吗？", options: ["是", "否"], recommended: "否" }] });
  assert.equal(reply.isError, true, "an interview nobody answered is reported as such");
  assert.equal(reply.details?.pending, true);
  assert.equal(f.armed.at(-1), false);
  assert.ok(f.st.pausedQuestion, "and the unanswered question is what the session waits on");
});

test("ask_user: an interrupted interview resumes instead of re-asking", async () => {
  const f = fake({ answers: ["B"] });
  f.st.askUser = {
    at: "2026-08-30T00:00:00.000Z",
    answers: [{ question: "问题一", kind: "answered", answer: "A" }],
  };
  const reply = await call(f, "ask_user", {
    questions: [
      { text: "问题一", options: ["A", "B"], recommended: "A" },
      { text: "问题二", options: ["A", "B"], recommended: "A" },
    ],
  });
  assert.equal(f.asked.length, 1, "the settled question is not asked again");
  assert.match(f.asked[0], /问题二/);
  assert.match(textOf(reply), /前 1 题沿用了上次中断前的回答/);
});

test("ask_user: a grantScope question mints the proxy grant when the user picks the RECOMMENDED option", async () => {
  const f = fake({ answers: ["授予"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "是否授予我敏感编辑代答权？", options: ["授予", "不授予"], recommended: "授予", grantScope: "sensitive-edit" }],
  });
  assert.equal(reply.isError, undefined);
  assert.deepEqual(f.grantsMinted, [{ scope: "sensitive-edit", via: "ask-user" }]);
});

test("ask_user: a grantScope question without a recommendation is REFUSED outright", async () => {
  const f = fake({ answers: ["授予"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "是否授予我敏感编辑代答权？", options: ["授予", "不授予"], grantScope: "sensitive-edit" }],
  });
  // The template is a hard requirement: no recommendation ⇒ the batch never
  // reaches a dialog, so there is nothing to mint a grant from.
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /recommended/);
  assert.deepEqual(f.grantsMinted, [], "a refused batch mints nothing");
  assert.deepEqual(f.asked, [], "and it raises no dialog");
});

test("ask_user: a NON-affirming answer mints nothing", async () => {
  const f = fake({ answers: ["不授予"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "是否授予我敏感编辑代答权？", options: ["授予", "不授予"], recommended: "授予", grantScope: "sensitive-edit" }],
  });
  assert.equal(reply.isError, undefined);
  assert.deepEqual(f.grantsMinted, [], "a decline is not a grant");
});

test("ask_user: an invented grantScope is ignored (no mint, no error)", async () => {
  const f = fake({ answers: ["是"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "授予运维权？", options: ["是", "否"], recommended: "否", grantScope: "ops" }],
  });
  assert.equal(reply.isError, undefined);
  assert.deepEqual(f.grantsMinted, [], "ops is not a grantable scope");
});

test("ask_user: a grantScope is VISIBLE in the dialog title and the transcript (reviewer P2 fix)", async () => {
  const f = fake({ answers: ["授予"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "是否授予我敏感编辑代答权？", options: ["授予", "不授予"], recommended: "授予", grantScope: "sensitive-edit" }],
  });
  assert.equal(reply.isError, undefined);
  // The channel title (what the dialog AND the orchestrator receipt show)
  // must carry the authorization notice — the user reads THIS, not the
  // grantScope field.
  assert.equal(f.asked.length, 1);
  assert.match(f.asked[0], /明确授予项目经理/, "the dialog title states the grant");
  assert.match(f.asked[0], /sensitive-edit/, "…and names the scope");
  // The transcript notice must carry it too.
  const body = f.notices.map((n) => `${n.lead}\n${n.body}`).join("\n");
  assert.match(body, /明确授予项目经理/, "the transcript states the grant");
  assert.deepEqual(f.grantsMinted, [{ scope: "sensitive-edit", via: "ask-user" }], "and the grant was minted");
});

test("ask_user: a grantScope question with no options is refused — free text cannot even be asked", async () => {
  const f = fake({ answers: ["grant me a few minutes"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "能给我一点时间吗？", grantScope: "sensitive-edit" }],
  });
  assert.equal(reply.isError, true);
  assert.deepEqual(f.grantsMinted, [], "a refused batch mints nothing");
  assert.deepEqual(f.asked, [], "and nothing was asked");
});

// ---------- the way back through an interview (user decision, 2026-09-19) ----------

/** The pane is where walking back happens: drive the dialogs from `dialogRows`. */
function inPane(f: Fake): void {
  f.deps.askEitherSide = async (_request, _hasUI, render) => {
    const answer = await render(new AbortController().signal);
    return { answer, by: "human", requestId: "r1" };
  };
}

/** Three ordinary questions — the interview the walk-back tests walk through. */
const WALK = [
  { text: "第一题", options: ["甲", "乙"], recommended: "甲" },
  { text: "第二题", options: ["丙", "丁"], recommended: "丙" },
  { text: "第三题", options: ["戊", "己"], recommended: "戊" },
];

/** The question number each `askChoice` call was for, in order. */
function askedOrder(f: Fake): Array<string | undefined> {
  return f.dialogCalls.map((c) => c.spec.title.match(/问题 (\d)/)?.[1]);
}

test("ask_user: only a question that HAS an earlier one offers the way back", async () => {
  const f = fake({ dialogRows: ["A. 甲（推荐）", "A. 丙（推荐）", "A. 戊（推荐）"] });
  inPane(f);
  await call(f, "ask_user", { questions: WALK });
  assert.deepEqual(f.dialogCalls.map((c) => c.back), [false, true, true],
    "question 1 has nowhere to go back to; the rest do");
});

test("ask_user: walking back re-asks the earlier question, then returns to the interview", async () => {
  const f = fake({
    dialogRows: [
      "A. 甲（推荐）", // 第一题 answered
      BACK_ROW,          // 第二题: go back
      "B. 乙",           // 第一题 re-answered — the ONLY answer that changes
      "A. 丙（推荐）", // 第二题 answered, and the interview carries on
      "A. 戊（推荐）", // 第三题
    ],
  });
  inPane(f);
  const reply = await call(f, "ask_user", { questions: WALK });

  assert.equal(f.dialogCalls.length, 5, "the earlier question is asked again");
  assert.deepEqual(askedOrder(f), ["1", "2", "1", "2", "3"], "…and the box comes back to where it was");
  assert.equal(f.dialogCalls[3]!.back, true, "the way back is still offered after the walk");
  assert.deepEqual(f.st.askUser?.answers.map((a) => a.answer), ["B. 乙", "A. 丙", "A. 戊"],
    "the re-answer overwrote question 1; the later answers are untouched");
  assert.equal(reply.details?.pending, false, "the interview finished normally");
});

test("ask_user: the way back reaches question 1 from anywhere, skipping nothing", async () => {
  const f = fake({
    dialogRows: [
      "A. 甲（推荐）",
      "A. 丙（推荐）",
      BACK_ROW,        // 第三题 → 第二题
      BACK_ROW,        // 第二题 → 第一题
      "B. 乙",         // 第一题 re-answered
      "A. 戊（推荐）", // back on 第三题
    ],
  });
  inPane(f);
  await call(f, "ask_user", { questions: WALK });

  assert.deepEqual(askedOrder(f), ["1", "2", "3", "2", "1", "3"],
    "the cursor walks back one question at a time — the middle one is shown again, not skipped");
  assert.deepEqual(f.st.askUser?.answers.map((a) => a.answer), ["B. 乙", "A. 丙", "A. 戊"],
    "only the question actually re-answered is overwritten");
});

test("ask_user: a scope granted by a question the user walks BACK to is taken back with it", async () => {
  const f = fake({
    dialogRows: [
      "A. 授予（推荐）", // the authorization question: yes
      BACK_ROW,          // the next question: go back
      "B. 不授予",       // …and answer it no instead
    ],
  });
  inPane(f);
  await call(f, "ask_user", {
    questions: [
      { text: "是否授予我敏感编辑代答权？", options: ["授予", "不授予"], recommended: "授予", grantScope: "sensitive-edit" },
      { text: "还有别的吗？", options: ["没有了", "有"], recommended: "没有了" },
    ],
  });

  assert.deepEqual(f.grantsMinted, [{ scope: "sensitive-edit", via: "ask-user" }], "the first answer granted it");
  assert.deepEqual(f.grantsRevoked, ["sensitive-edit"], "and the re-answer took it back");
});

test("ask_user: the way back is NOT offered over the channel — it is a human row", async () => {
  const seen: string[][] = [];
  const f = fake({ dialogRows: ["A. 甲（推荐）", "A. 丙（推荐）"] });
  f.deps.askEitherSide = async (request, _hasUI, render) => {
    seen.push(request.options);
    const answer = await render(new AbortController().signal);
    return { answer, by: "human", requestId: "r1" };
  };
  await call(f, "ask_user", { questions: WALK.slice(0, 2) });

  assert.ok(seen.every((rows) => !rows.includes(BACK_ROW)),
    "a project manager must never be handed a row that means 'ask the human again'");
  assert.deepEqual(seen[1], ["A. 丙（推荐）", "B. 丁", DECLINE_ROW], "…the answerable rows, lettered");
});

// ---------- request_scope_limit ----------

test("request_scope_limit: nobody answering is NOT a decline — the request stays open", async (t) => {
  // REVIEW ROUND 3 P1. The dialog waited out its window and the proxy could not
  // decide either; the conservative landing is the FULL gate (nothing granted),
  // and the consent path used to reach that landing through the DECLINE branch —
  // which also locked the request for the session and wrote a refusal the user
  // never gave. They come back to a door closed in their absence, and the goal
  // says they must be able to walk the step again.
  const dir = mkdtempSync(join(tmpdir(), "rg-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "old.ts"), "export const a = 1;\n");
  const f = fake({ cwd: dir, proxyFailed: true });

  const reply = await call(f, "request_scope_limit", { reason: "既有改动" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /NOBODY ANSWERED/);
  assert.match(textOf(reply), /NOT locked/, "…and the reply says so — the next call depends on that fact");
  assert.equal(f.scopeDeclined, false, "a timeout must NEVER lock the request");
  assert.equal(f.st.scopeLimit, undefined, "…and nothing was granted either");
});

test("request_scope_limit: a previous decline locks the session, before any dialog", async () => {
  const f = fake({ scopeDeclined: true });
  const reply = await call(f, "request_scope_limit", { reason: "都是既有改动" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /already DECLINED/);
  assert.deepEqual(f.asked, [], "a locked session must not raise the dialog again");
});

test("request_scope_limit: an answer that is NOT one of the rows is a refusal, never a consent", async (t) => {
  // THE WHITELIST GUARD (functional reviewer P2 + quality round P1, both on
  // 2026-09-17): `parseChoice` returns an unrecognized line VERBATIM as
  // `{kind:"chose", option:<text>}` (lib/choice-dialog.ts), so a consent
  // decided by ELIMINATION ("anything that is not the refusal row") turns any
  // other text into a GRANT on a path whose whole job is to be conservative.
  // The three copies the shared helper replaced each matched their own grant
  // label; this keeps it that way.
  const dir = mkdtempSync(join(tmpdir(), "rg-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "old.ts"), "export const a = 1;\n");
  const f = fake({ cwd: dir, answers: ["随便写的一句话，不是任何一个选项"] });

  const reply = await call(f, "request_scope_limit", { reason: "既有改动" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /DECLINED the scope limit/);
  assert.equal(f.scopeDeclined, true, "an unreadable answer is treated as a refusal");
  assert.equal(f.st.scopeLimit, undefined, "nothing was granted");
});

test("request_scope_limit: no UI fails closed", async () => {
  const f = fake();
  const reply = await runWithCtx(f, "request_scope_limit", { reason: "既有改动" }, { hasUI: false });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /no interactive UI/);
  assert.equal(f.scopeDeclined, false, "fail-closed is not a decline");
});

test("request_scope_limit: an unreadable git status fails closed", async () => {
  const f = fake();
  const reply = await call(f, "request_scope_limit", { reason: "既有改动" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /git status unavailable/);
});

test("request_scope_limit: granted narrows arming to the session's own edits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rg-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "old.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "mine.ts"), "export const b = 2;\n");
  const f = fake({ cwd: dir, sessionEdited: ["mine.ts"] });

  const reply = await call(f, "request_scope_limit", { reason: "既有改动来自上一个会话" });
  assert.equal(reply.details?.granted, true);
  assert.deepEqual(reply.details?.sessionFiles, ["mine.ts"]);
  assert.deepEqual(f.st.scopeLimit?.preexistingFiles, ["old.ts"],
    "every non-session change is frozen as exempt");
  assert.equal(f.st.hasCodeChange, true, "arming is re-derived from the session's own edits");
  assert.equal(f.persists, 1);
  assert.match(textOf(reply), /GRANTED the scope limit/);
});

test("request_scope_limit: the consent dialog goes through the channel with a scope-limit topic (orchestrator-answerable)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rg-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "old.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "mine.ts"), "export const b = 2;\n");
  const f = fake({ cwd: dir, sessionEdited: ["mine.ts"] });
  // The project manager answers through the channel (option 1 = agree).
  f.answers.push("同意缩小审查范围");
  const reply = await call(f, "request_scope_limit", { reason: "既有改动来自上一个会话" });
  assert.equal(reply.details?.granted, true);
  assert.equal(f.asked.length, 1, "the consent dialog is raised exactly once, through askEitherSide");
  assert.match(f.asked[0], /审查范围缩小/);
  assert.match(f.asked[0], /拒绝后：AI 本会话内不能再次请求缩小范围/,
    "the channel record carries the CONSEQUENCES too — a PM answering for the user must read them");
});

test("request_scope_limit: a refusal typed into the template's reason box reaches the agent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rg-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "old.ts"), "export const a = 1;\n");
  const f = fake({ cwd: dir, answers: ["✎ 不选，我说明原因：这些也是本次会话的活"] });

  const reply = await call(f, "request_scope_limit", { reason: "既有改动" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /这些也是本次会话的活/,
    "the user's objection must reach the agent — dropping it makes them repeat themselves");
  assert.equal(f.scopeDeclined, true, "a typed refusal is still a decline");
});

test("request_scope_limit: a dialog that could not be SHOWN is not a decline", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rg-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "old.ts"), "export const a = 1;\n");
  const f = fake({ cwd: dir, confirmAnswer: "throw" });

  const reply = await call(f, "request_scope_limit", { reason: "既有改动" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /could not be shown/);
  assert.equal(f.scopeDeclined, false, "the anti-grinding lock must not burn on an unshowable dialog");
  assert.equal(f.st.scopeLimit, undefined);
});

test("request_scope_limit: a real decline locks the session and grants nothing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rg-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "old.ts"), "export const a = 1;\n");
  const f = fake({ cwd: dir, confirmAnswer: false });

  const reply = await call(f, "request_scope_limit", { reason: "既有改动" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /DECLINED the scope limit/);
  assert.equal(f.scopeDeclined, true);
  assert.equal(f.st.scopeLimit, undefined, "a decline never narrows the fence");
});

// ---------- request_sensitive_edit ----------

test("request_sensitive_edit: a non-sensitive path needs no authorization", async () => {
  const f = fake({ cwd: "/repo" });
  const reply = await call(f, "request_sensitive_edit", { path: "lib/thing.ts", reason: "改逻辑" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /is not a sensitive file/);
  assert.deepEqual(f.asked, []);
});

test("SECURITY: request_sensitive_edit refuses gate-integrity paths before any dialog", async () => {
  const f = fake({ cwd: "/repo" });
  for (const path of [".git/hooks/pre-commit", ".pi/review-gate-state.json", ".pi/precommit-cache.json"]) {
    const reply = await call(f, "request_sensitive_edit", { path, reason: "调整门禁" });
    assert.equal(reply.isError, true, `${path} must be refused`);
    assert.match(textOf(reply), /never authorizable from here|part of the gate's own enforcement/);
  }
  assert.deepEqual(f.asked, [], "the user is never asked to disarm the gate");
  assert.deepEqual(f.grants, []);
});

test("request_sensitive_edit: a declined path is locked for the session", async () => {
  const f = fake({ cwd: "/repo", confirmAnswer: false });
  const first = await call(f, "request_sensitive_edit", { path: ".env", reason: "加一个变量" });
  assert.equal(first.isError, true);
  assert.match(textOf(first), /DECLINED editing/);
  assert.equal(f.asked.length, 1);
  assert.match(f.asked[0], /同意后：只授权这一个路径/,
    "the channel record carries the consequences — and the path it authorizes");

  const second = await call(f, "request_sensitive_edit", { path: ".env", reason: "再试一次" });
  assert.equal(second.isError, true);
  assert.match(textOf(second), /already DECLINED/);
  assert.equal(f.asked.length, 1, "a locked path must never raise a second dialog");
});

test("request_sensitive_edit: the refusal reason reaches the agent", async () => {
  const f = fake({ cwd: "/repo", answers: ["✎ 不选，我说明原因：这个文件我自己改"] });
  const reply = await call(f, "request_sensitive_edit", { path: ".env", reason: "加一个变量" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /这个文件我自己改/,
    "the user's own reason is the actionable half of a refusal");
  assert.ok(f.declined.has("/repo/.env"), "…and the path is still locked");
});

test("request_sensitive_edit: an unshowable dialog fails closed WITHOUT locking the path", async () => {
  const f = fake({ cwd: "/repo", confirmAnswer: "throw" });
  const reply = await call(f, "request_sensitive_edit", { path: ".env", reason: "加一个变量" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /could not be shown/);
  assert.equal(f.declined.size, 0);
  assert.deepEqual(f.grants, []);
});

test("request_sensitive_edit: granted issues ONE bounded, unpersisted grant", async () => {
  const before = Date.now();
  const f = fake({ cwd: "/repo" });
  const reply = await call(f, "request_sensitive_edit", { path: ".env", reason: "加一个变量" });
  assert.equal(reply.details?.granted, true);
  assert.equal(f.grants.length, 1);
  assert.equal(f.grants[0].path, "/repo/.env", "the grant covers that EXACT path");
  assert.ok(f.grants[0].expiresAt >= before + SENSITIVE_GRANT_TTL_MS,
    "and it expires on the module's own TTL");
  assert.equal(f.persists, 0, "a write authorization must never reach the sidecar");
  assert.match(f.logs.join("\n"), /sensitive-grant issued for \/repo\/\.env/);

  // A live grant is reported, not re-asked.
  const again = await call(f, "request_sensitive_edit", { path: ".env", reason: "同一处改动" });
  assert.equal(again.details?.alreadyGranted, true);
  assert.equal(f.asked.length, 1);
});

test("request_sensitive_edit: no UI fails closed", async () => {
  const f = fake({ cwd: "/repo" });
  const reply = await runWithCtx(f, "request_sensitive_edit", { path: ".env", reason: "加一个变量" }, { hasUI: false });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /no interactive UI/);
  assert.deepEqual(f.grants, []);
});

test("ask_user's own description says the interview is optional but UNCAPPED", () => {
  // USER REQUIREMENT (2026-09-06): "有疑问就问，不设数量上限；没疑问就只做反述确认".
  // The tool description is what the model actually reads before deciding
  // whether to ask, so the rule has to be IN it — not only in the loop-goal
  // directive next door.
  let description = "";
  const host: ToolHost = {
    registerTool: (definition) => {
      if (definition.name === "ask_user") description = definition.description;
    },
  };
  registerUserInteractionTools(host, fake().deps);
  assert.match(description, /no cap/i, "the count is not the thing to economize on");
  assert.match(description, /optional/i, "…and asking nothing when nothing is unclear is fine too");
  assert.doesNotMatch(description, /questionnaire|one question, not/i,
    "no wording that reads as 'ask fewer questions'");
});

