/**
 * THE GATE'S DIALOGS AND STATUS STRIP ON THE DESKTOP HOST, against a FAKE
 * desktop client (a unix socket server in a child process: `dialog.close` is a
 * blocking request, so the server cannot live on this thread).
 *
 * The fake answers through lib/desktop-host-protocol.ts's own encoder, scripts
 * its `dialog.open` answer per title, and logs every request it decoded.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createDesktopClient, helloFor } from "../lib/desktop-host-client.ts";
import { createDesktopDialogs, type DesktopDialogRender } from "../lib/gate-host-desktop-dialogs.ts";
import { BACK_ROW, DECLINE_ROW, parseChoice, type ChoiceSpec } from "../lib/choice-dialog.ts";
import { MULTI_UNAVAILABLE } from "../lib/multi-choice-dialog.ts";
import { createGateDialogs } from "../lib/gate-dialogs.ts";
import { createStatusStrip } from "../lib/status-strip.ts";
import { emptyState } from "../lib/gate-state.ts";
import type { SessionHost } from "../lib/session-host.ts";

const SELF = "root-1";
const dirs: string[] = [];
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * `config.answers[title]`: a `dialog.open` result, or `"hold"` (answer
 * `aborted` only when `dialog.close` names it), or `"drop"` (lose the
 * connection).
 */
const FAKE_CLIENT = `
const [socketPath, logPath, configJson, protocolUrl] = process.argv.slice(1);
const config = JSON.parse(configJson);
const { createServer } = await import("node:net");
const { appendFileSync } = await import("node:fs");
const { decodeRequest, encodeResponse } = await import(protocolUrl);
const held = new Map();
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const decoded = decodeRequest(line);
      if (!decoded.ok) { appendFileSync(logPath, JSON.stringify({ bad: decoded.error }) + "\\n"); continue; }
      const { id, method, params } = decoded.request;
      appendFileSync(logPath, JSON.stringify({ method, params }) + "\\n");
      const reply = (reqId, m, result) => socket.write(encodeResponse(reqId, m, { ok: true, result }).frame);
      if (method === "hello") reply(id, method, { protocol: 1, client: { name: "fake", version: "0" } });
      else if (method === "dialog.open") {
        const answer = config.answers[params.title];
        if (answer === "hold") held.set(params.dialogId, id);
        else if (answer === "drop") socket.destroy();
        else reply(id, method, answer);
      } else if (method === "dialog.close") {
        const openId = held.get(params.dialogId);
        held.delete(params.dialogId);
        if (openId) reply(openId, "dialog.open", { kind: "aborted" });
        reply(id, method, {});
      } else reply(id, method, {});
    }
  });
});
server.listen(socketPath, () => process.stdout.write("listening\\n"));
`;

interface Fake {
  render: DesktopDialogRender;
  requests(): Array<{ method: string; params: Record<string, unknown> }>;
}

async function fakeClient(answers: Record<string, unknown>): Promise<Fake> {
  // Short enough for `sun_path` (103 bytes) whatever TMPDIR is.
  const dir = mkdtempSync("/tmp/rg-dd-");
  dirs.push(dir);
  const socketPath = join(dir, "s.sock");
  const logPath = join(dir, "log.jsonl");
  const protocolUrl = new URL("../lib/desktop-host-protocol.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", FAKE_CLIENT, socketPath, logPath, JSON.stringify({ answers }), protocolUrl], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on("data", (data: Buffer) => { if (String(data).includes("listening")) resolve(); });
    child.on("exit", (code) => reject(new Error(`fake client exited early (${code})`)));
  });
  const client = createDesktopClient({ socketPath, timeoutMs: 2_000, hello: () => helloFor({ hostSessionId: SELF, cwd: "/repo" }) });
  return {
    render: createDesktopDialogs({ client }),
    requests: () => (existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

const radio = (title: string): ChoiceSpec => ({ title, options: ["甲", "乙", "丙"], recommended: "乙" });
const checklist = (title: string): ChoiceSpec => ({ title, options: ["甲", "乙", "丙"], defaultChecked: ["甲"] });
const opens = (fake: Fake) => fake.requests().filter((r) => r.method === "dialog.open");

test("a radio question goes out structured and comes back as the TUI's own row", async () => {
  const body = "长正文".repeat(20_000);
  const fake = await fakeClient({ pick: { kind: "picked", option: "乙" } });
  const line = await fake.render(radio("pick"), { body });
  assert.equal(line, "B. 乙（推荐）", "exactly what pi's select returns for that row");
  assert.deepEqual(parseChoice(line, radio("pick")), { kind: "chose", option: "乙" });
  const sent = opens(fake)[0]!.params;
  assert.equal(sent.shape, "choice");
  assert.deepEqual(sent.options, ["甲", "乙", "丙"], "option text, no letters — the client draws them");
  assert.equal(sent.recommended, "乙");
  assert.equal(sent.declineRow, DECLINE_ROW);
  assert.equal(sent.back, false);
  assert.equal(sent.body, body, "the long text travels whole, never cut");
});

test("the decline row's reason, an empty reason, and the way back", async () => {
  const fake = await fakeClient({
    why: { kind: "decline", reason: "  都不对\n第二行 " },
    bare: { kind: "decline", reason: "  " },
    back: { kind: "back" },
  });
  assert.equal(await fake.render(radio("why")), `${DECLINE_ROW}：都不对\n第二行`);
  assert.equal(await fake.render(radio("bare")), DECLINE_ROW);
  assert.equal(await fake.render(radio("back"), { back: true }), BACK_ROW);
  assert.equal(opens(fake)[2]!.params.back, true);
});

test("a checklist carries defaultChecked and returns the multi label", async () => {
  const fake = await fakeClient({ multi: { kind: "checked", options: ["丙", "甲"] }, none: { kind: "checked", options: [] } });
  assert.equal(await fake.render(checklist("multi"), { checkbox: true }), "A. 甲 / C. 丙", "in list order, never tick order");
  assert.equal(await fake.render(checklist("none"), { checkbox: true }), "", "nothing ticked is an answer");
  const sent = opens(fake)[0]!.params;
  assert.equal(sent.shape, "multi");
  assert.deepEqual(sent.defaultChecked, ["甲"]);
  assert.equal("recommended" in sent, false);
});

test("a dismissed card is a closed box", async () => {
  const fake = await fakeClient({ gone: { kind: "dismissed" } });
  assert.equal(await fake.render(radio("gone")), undefined);
});

test("the other side answered first: the card is taken down with dialog.close", async () => {
  const fake = await fakeClient({ held: "hold" });
  const settled = new AbortController();
  const asking = fake.render(radio("held"), { signal: settled.signal });
  // Let the open reach the fake before the project manager "answers".
  for (let i = 0; i < 50 && opens(fake).length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
  settled.abort();
  assert.equal(await asking, undefined, "the same thing an aborted TUI box returns");
  const close = fake.requests().find((r) => r.method === "dialog.close")!;
  assert.equal(close.params.dialogId, opens(fake)[0]!.params.dialogId);
});

test("an already-settled question is never sent", async () => {
  const fake = await fakeClient({});
  const settled = new AbortController();
  settled.abort();
  assert.equal(await fake.render(radio("x"), { signal: settled.signal }), undefined);
  assert.equal(opens(fake).length, 0);
});

test("fail-closed: a lost connection or an invented answer is never the user's answer", async () => {
  const fake = await fakeClient({
    drop: "drop",
    lie: { kind: "picked", option: "丁" },
    cannot: { kind: "unavailable" },
  });
  assert.equal(await fake.render(checklist("drop"), { checkbox: true }), MULTI_UNAVAILABLE, "a checklist goes back to the agent");
  const race = new AbortController();
  let done = false;
  const radioAsk = fake.render(radio("lie"), { signal: race.signal }).then((v) => { done = true; return v; });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(done, false, "a radio question stays unanswered on the human side — the race decides");
  race.abort();
  assert.equal(await radioAsk, undefined);
  assert.equal(await fake.render(radio("cannot")), undefined, "no race to wait for ⇒ nothing decided");
});

test("askChoice routes through the desktop presentation; the TUI ui is never touched", async () => {
  const fake = await fakeClient({ wired: { kind: "picked", option: "甲" } });
  const host = { repos: () => ({ active: "/repo", primary: "/repo" }), ctx: () => undefined } as unknown as SessionHost;
  const interactions = { current: undefined as string | undefined };
  const { askChoice } = createGateDialogs(host, {
    proxy: { answerFor: async () => ({ failure: "n/a" }), record: () => {}, all: () => [] },
    raiseBanner: () => undefined,
    lastUserInteractionAt: interactions,
    proxyWaitMs: () => 600_000,
    desktopDialogs: fake.render,
  });
  const ui = { select: async () => { throw new Error("the TUI must not draw on the desktop host"); } };
  assert.equal(await askChoice({ ui } as never, radio("wired")), "A. 甲");
  assert.ok(interactions.current, "a real answer is recorded as the user's");
});

test("status strip on the desktop host: string[] only, no renderer probe", () => {
  const calls: Array<{ key: string; content: unknown }> = [];
  const state = emptyState("sess-1", 10);
  const host = {
    state: () => state,
    repos: () => ({ primary: "/repo", active: "/repo", all: new Set(["/repo"]), cwd: "/repo", inGit: false }),
  } as unknown as SessionHost;
  const strip = (desktop: boolean) => createStatusStrip(host, {
    goalStageSatisfied: () => true,
    goalStageOn: () => true,
    isJudgePane: () => false,
    judgeTaskRound: () => undefined,
    sessionEdited: () => false,
    loopGoalPresent: () => false,
    loopGoalPath: () => "/repo/.pi/loop-goal.md",
    lastUiCtx: { current: undefined },
    desktopHost: () => desktop,
  });
  const ctx = { hasUI: true, ui: { setWidget: (key: string, content: unknown) => calls.push({ key, content }), notify: () => {} } } as never;
  const desktop = strip(true);
  desktop.updateWidget(ctx);
  desktop.disarmUiRefreshTimer();
  assert.deepEqual(calls.map((c) => c.key), ["review-gate-agents"]);
  assert.ok(Array.isArray(calls[0]!.content), "the form RPC forwards to the client");
  calls.length = 0;
  const terminal = strip(false);
  terminal.updateWidget(ctx);
  terminal.disarmUiRefreshTimer();
  assert.deepEqual(calls.map((c) => c.key), ["review-gate-renderer-probe", "review-gate-renderer-probe", "review-gate-agents"],
    "the terminal host is unchanged");
});
