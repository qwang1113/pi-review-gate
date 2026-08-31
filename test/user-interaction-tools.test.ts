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
  /** What the confirm dialog answers, or "throw" to simulate an unshowable one. */
  confirmAnswer: boolean | "throw";
  /** What each ask_user dialog answers (one per question, in order). */
  answers: Array<string | undefined>;
  asked: string[];
  /** This fake session can route dialogs through an orchestration channel. */
  canChannelDialogs: boolean;
  /** Grants minted via grantProxyScope, in order. */
  grantsMinted: Array<{ scope: string; via: string }>;
  cwd: string;
  sessionEdited: string[];
  ahead: number;
}

/** A tool context with a UI (the normal, interactive case). */
const UI_CTX = { hasUI: true, ui: { notify: () => {}, select: undefined, input: undefined } };

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
    confirmAnswer: true,
    answers: [],
    asked: [],
    canChannelDialogs: false,
    grantsMinted: [],
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
    confirmBounded: async (_uiCtx, title, message) => {
      f.confirms.push(`${title}\n${message}`);
      if (f.confirmAnswer === "throw") throw new Error("no dialog here");
      return f.confirmAnswer;
    },
    canChannelDialogs: () => f.canChannelDialogs ?? false,
    askEitherSide: async (request) => {
      f.asked.push(request.title);
      if (f.answers.length > 0) return f.answers.shift()!;
      if (request.topic === "scope-limit" || request.topic === "sensitive-edit") {
        // Consent dialogs are SELECTs: agreed = first option.
        if (f.confirmAnswer === "throw") throw new Error("no dialog here");
        return f.confirmAnswer === true ? request.options[0] : undefined;
      }
      return undefined; // ask_user without an explicit answer is unanswered
    },
    cwd: f.cwd,
    sessionEditedPaths: () => f.sessionEdited,
    commitsAheadOfBase: async () => f.ahead,
    scopeLimitDeclined: () => f.scopeDeclined,
    declineScopeLimit: () => { f.scopeDeclined = true; },
    sensitiveGrants: () => f.grants,
    storeSensitiveGrants: (next) => { f.grants = next; },
    sensitiveDeclinedPaths: f.declined,
    log: (message) => { f.logs.push(message); },
    grantProxyScope: (scope, via) => { f.grantsMinted.push({ scope, via }); },
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

test("ONE registration call wires all three user-facing tools", () => {
  const f = fake();
  assert.deepEqual(f.order, ["ask_user", "request_scope_limit", "request_sensitive_edit"]);
});

// ---------- ask_user ----------

test("ask_user: an empty question list is refused without touching the loop", async () => {
  const f = fake();
  const reply = await call(f, "ask_user", { questions: [] });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /no question in the list/);
  assert.deepEqual(f.armed, [], "a rejected call must not arm or disarm anything");
  assert.equal(f.persists, 0);
});

test("ask_user: headless PAUSES the loop and hands the questions back", async () => {
  const f = fake();
  const reply = await runWithCtx(f, "ask_user", { questions: [{ text: "选 A 还是 B？" }] }, { hasUI: false });
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
    questions: [{ text: "问题一", options: ["A", "B"] }, { text: "问题二", options: ["A", "B"] }],
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
  const reply = await call(f, "ask_user", { questions: [{ text: "要合并吗？", options: ["是", "否"] }] });
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
    questions: [{ text: "问题一", options: ["A", "B"] }, { text: "问题二", options: ["A", "B"] }],
  });
  assert.equal(f.asked.length, 1, "the settled question is not asked again");
  assert.match(f.asked[0], /问题二/);
  assert.match(textOf(reply), /前 1 题沿用了上次中断前的回答/);
});

test("ask_user: a grantScope question mints the proxy grant when the user affirms", async () => {
  const f = fake({ answers: ["授予"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "是否授予我敏感编辑代答权？", options: ["授予", "不授予"], grantScope: "sensitive-edit" }],
  });
  assert.equal(reply.isError, undefined);
  assert.deepEqual(f.grantsMinted, [{ scope: "sensitive-edit", via: "ask-user" }]);
});

test("ask_user: a NON-affirming answer mints nothing", async () => {
  const f = fake({ answers: ["不授予"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "是否授予我敏感编辑代答权？", options: ["授予", "不授予"], grantScope: "sensitive-edit" }],
  });
  assert.equal(reply.isError, undefined);
  assert.deepEqual(f.grantsMinted, [], "a decline is not a grant");
});

test("ask_user: an invented grantScope is ignored (no mint, no error)", async () => {
  const f = fake({ answers: ["是"] });
  const reply = await call(f, "ask_user", {
    questions: [{ text: "授予运维权？", options: ["是", "否"], grantScope: "ops" }],
  });
  assert.equal(reply.isError, undefined);
  assert.deepEqual(f.grantsMinted, [], "ops is not a grantable scope");
});

// ---------- request_scope_limit ----------

test("request_scope_limit: a previous decline locks the session, before any dialog", async () => {
  const f = fake({ scopeDeclined: true });
  const reply = await call(f, "request_scope_limit", { reason: "都是既有改动" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /already DECLINED/);
  assert.deepEqual(f.asked, [], "a locked session must not raise the dialog again");
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

  const second = await call(f, "request_sensitive_edit", { path: ".env", reason: "再试一次" });
  assert.equal(second.isError, true);
  assert.match(textOf(second), /already DECLINED/);
  assert.equal(f.asked.length, 1, "a locked path must never raise a second dialog");
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
