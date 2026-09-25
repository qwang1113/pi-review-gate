/**
 * `send_message` — ONE SESSION ADDRESSING ANOTHER BY NAME.
 *
 * Two halves, one file, because they are one contract: the SENDER's judgement
 * (is this a live name, is the body legal, am I allowed to speak) and the
 * RECIPIENT's consumption (take the inbox, inject, never lose a message). The
 * registry's own liveness rules are pinned in test/session-registry.test.ts and
 * test/session-name-tools.test.ts; here the live list is handed in, so what is
 * under test is the messaging layer's use of it.
 *
 * Everything runs against fakes: the file system is a Map, the injection is a
 * list, the clock is fixed. No pi, no tmux, no disk.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ToolHost, ToolReply } from "../lib/tool-host.ts";
import {
  createSessionMessaging,
  inboxTakenPath,
  normalizeRecipient,
  parseInboxRecord,
  type InboxIO,
  type SessionInboxRecord,
} from "../lib/session-message-tools.ts";
import { sessionInboxPath, type SessionRegistryEntry } from "../lib/session-registry.ts";
import { MAX_INLINE_RECORD_BYTES } from "../lib/orchestrator-channel.ts";

const ROOT = "/home/agent/.pi/agent/rg-sessions";
const NOW = Date.parse("2026-09-25T10:00:00.000Z");
const ME = "t3-lane";
const THEIRS = "t9-pm";
const MY_SESSION = "019fbb1d-9e78-7ebf-88bf-d104b8a270ed";
const THEIR_SESSION = "019fbb1d-9e78-7ebf-88bf-ffee00000011";

function fakeIO(files: Map<string, string> = new Map()): InboxIO {
  return {
    ensureDir: () => { /* the Map has no directories */ },
    appendLine: (path, line) => { files.set(path, (files.get(path) ?? "") + line); },
    readText: (path) => files.get(path),
    writeText: (path, text) => { files.set(path, text); },
    rename: (from, to) => {
      const value = files.get(from);
      if (value === undefined) return false;
      files.delete(from);
      files.set(to, value);
      return true;
    },
    remove: (path) => (files.delete(path), true),
    now: () => NOW,
  };
}

function entry(name: string, overrides: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    schema: 1,
    name,
    sessionId: name === THEIRS ? THEIR_SESSION : MY_SESSION,
    pid: 4711,
    repo: "/repo/pi-review-gate",
    cwd: "/repo/pi-review-gate",
    mode: "loop",
    state: "working",
    registeredAt: new Date(NOW - 600_000).toISOString(),
    heartbeatAt: new Date(NOW - 5_000).toISOString(),
    ...overrides,
  };
}

interface Lab {
  messaging: ReturnType<typeof createSessionMessaging>;
  tool: { execute: (id: string, params: Record<string, unknown>) => Promise<ToolReply> };
  files: Map<string, string>;
  injected: string[];
  owner: { name?: string };
}

function makeLab(opts: {
  files?: Map<string, string>;
  live?: SessionRegistryEntry[];
  unknown?: SessionRegistryEntry[];
  ownName?: string | undefined;
  inject?: (text: string) => void;
  appendFails?: boolean;
} = {}): Lab {
  const files = opts.files ?? new Map<string, string>();
  const io = fakeIO(files);
  if (opts.appendFails) {
    io.appendLine = () => { throw new Error("disk full"); };
  }
  const owner: { name?: string } = { name: "ownName" in opts ? opts.ownName : ME };
  const injected: string[] = [];
  const messaging = createSessionMessaging({
    root: ROOT,
    io,
    liveSessions: () => ({ live: opts.live ?? [entry(THEIRS)], unknown: opts.unknown ?? [] }),
    self: () => ({
      ...(owner.name === undefined ? {} : { name: owner.name }),
      sessionId: MY_SESSION,
      repo: "/repo/pi-review-gate",
      mode: "loop",
    }),
    inject: opts.inject ?? ((text) => { injected.push(text); }),
    now: () => NOW,
  });
  let tool: Lab["tool"] | undefined;
  messaging.register({
    registerTool: (spec: unknown) => { tool = spec as Lab["tool"]; },
  } as ToolHost);
  if (!tool) throw new Error("send_message was not registered");
  return { messaging, tool, files, injected, owner };
}

function textOf(reply: ToolReply): string {
  return reply.content.map((part) => part.text).join("\n");
}

const inbox = (name: string) => sessionInboxPath(ROOT, name);

/** Put a message into @t3-lane's inbox the way a real sender would — through the tool. */
async function seedMessage(files: Map<string, string>, text: string, from = "seeder"): Promise<void> {
  const seeder = makeLab({ files, ownName: from, live: [entry(ME)] });
  const reply = await seeder.tool.execute("s", { to: ME, text });
  assert.equal(reply.isError, undefined, textOf(reply));
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test("send_message delivers to a live name, with or without the @ prefix", async () => {
  const at = makeLab();
  const first = await at.tool.execute("1", { to: `@${THEIRS}`, text: "把 lib/foo.ts 的导出改名" });
  assert.equal(first.isError, undefined);
  assert.match(textOf(first), /已投递给 @t9-pm/);
  assert.match(textOf(first), /不会打断它当前正在跑的那一步/);

  const stored = parseInboxRecord((at.files.get(inbox(THEIRS)) ?? "").trim());
  assert.equal(stored?.from, ME);
  assert.equal(stored?.text, "把 lib/foo.ts 的导出改名");
  assert.equal(stored?.fromSessionId, MY_SESSION);

  // The prefix is courtesy, not syntax: the bare name is the same address.
  const second = await at.tool.execute("2", { to: THEIRS, text: "第二条" });
  assert.equal(second.isError, undefined);
  const lines = (at.files.get(inbox(THEIRS)) ?? "").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(parseInboxRecord(lines[1])?.text, "第二条");
});

test("an unknown name fails and the receipt carries the addresses that do exist", async () => {
  const at = makeLab({ live: [entry(THEIRS), entry("t2-registry", { repo: "/repo/other", state: "idle" })] });
  const reply = await at.tool.execute("1", { to: "@nobody-home", text: "喂" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /@nobody-home 不在活会话里/);
  assert.match(textOf(reply), /当前活着的会话/);
  assert.match(textOf(reply), /@t9-pm（repo=\/repo\/pi-review-gate、状态=working/);
  assert.match(textOf(reply), /@t2-registry（repo=\/repo\/other、状态=idle/);
  assert.equal(at.files.get(inbox("nobody-home")), undefined);
});

test("with no named session at all the receipt says so instead of printing an empty list", async () => {
  const at = makeLab({ live: [] });
  const reply = await at.tool.execute("1", { to: "@nobody-home", text: "喂" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /当前没有任何命名过的活会话/);
});

test("a name whose holder cannot be classified is refused, and reported separately", async () => {
  const at = makeLab({ live: [], unknown: [entry("half-dead", { state: "unknown" })] });
  const reply = await at.tool.execute("1", { to: "half-dead", text: "喂" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /生死判不出来/);
  assert.match(textOf(reply), /fail-closed 处理：不投递/);
  assert.match(textOf(reply), /生死判不出来的/);
  assert.equal(at.files.get(inbox("half-dead")), undefined);
});

test("a malformed name, an empty body, and writing to yourself are all refused", async () => {
  const at = makeLab();
  const malformed = await at.tool.execute("1", { to: "Not A Name", text: "喂" });
  assert.equal(malformed.isError, true);
  assert.match(textOf(malformed), /收件人名字不合法/);

  const empty = await at.tool.execute("2", { to: `@${THEIRS}`, text: "   " });
  assert.equal(empty.isError, true);
  assert.match(textOf(empty), /正文是空的/);

  const self = await at.tool.execute("3", { to: `@${ME}`, text: "提醒我自己" });
  assert.equal(self.isError, true);
  assert.match(textOf(self), /就是你自己/);
  assert.equal(at.files.get(inbox(THEIRS)), undefined);
});

test("an unnamed session is told to name itself first — it may not send", async () => {
  const at = makeLab({ ownName: undefined });
  const reply = await at.tool.execute("1", { to: `@${THEIRS}`, text: "喂" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /你还没有名字/);
  assert.match(textOf(reply), /name_session\(\{name:/);
  assert.equal(at.files.get(inbox(THEIRS)), undefined);
});

test("a failed write is reported, never claimed as delivered", async () => {
  const at = makeLab({ appendFails: true });
  const reply = await at.tool.execute("1", { to: `@${THEIRS}`, text: "喂" });
  assert.equal(reply.isError, true);
  assert.match(textOf(reply), /消息没写进 @t9-pm 的 inbox/);
  assert.match(textOf(reply), /disk full/);
});

test("a long body spills to a side file and the appended line stays under the byte budget", async () => {
  const at = makeLab();
  const body = "改".repeat(2000); // 3 bytes each in UTF-8: well past the inline budget
  const reply = await at.tool.execute("1", { to: THEIRS, text: body });
  assert.equal(reply.isError, undefined);

  const line = (at.files.get(inbox(THEIRS)) ?? "").trim();
  assert.ok(Buffer.byteLength(line, "utf8") <= MAX_INLINE_RECORD_BYTES, `line was ${Buffer.byteLength(line, "utf8")} bytes`);
  const stored = parseInboxRecord(line) as SessionInboxRecord;
  assert.equal(stored.text, undefined);
  assert.equal(stored.textRef?.chars, body.length);
  assert.equal(at.files.get(stored.textRef?.path ?? ""), body);
});

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

test("drain injects what is waiting, then takes it away — and never replays it", async () => {
  const files = new Map<string, string>();
  await seedMessage(files, "第一条");
  await seedMessage(files, "第二条");

  const at = makeLab({ files });
  at.messaging.drain();
  assert.equal(at.injected.length, 2);
  assert.match(at.injected[0], /^\[来自 @seeder 的会话消息 · 2026-09-25T10:00:00.000Z\]\n第一条\n/);
  assert.match(at.injected[0], /send_message\(\{to:"@seeder"/);
  assert.equal(files.get(inbox(ME)), undefined);
  assert.equal(files.get(inboxTakenPath(inbox(ME))), undefined);

  at.messaging.drain();
  assert.equal(at.injected.length, 2, "a second drain must not re-inject");
});

test("an injection that fails keeps the message for the next tick, without replaying the ones already injected", async () => {
  const files = new Map<string, string>();
  await seedMessage(files, "第一条");
  await seedMessage(files, "第二条");
  await seedMessage(files, "第三条");

  let calls = 0;
  const at = makeLab({
    files,
    inject: () => {
      calls += 1;
      if (calls === 2) throw new Error("pi 不在");
    },
  });
  at.messaging.drain();
  assert.equal(calls, 2, "the round stops at the message that could not be injected");
  const parked = files.get(inboxTakenPath(inbox(ME))) ?? "";
  assert.equal((parked.trim().split("\n").length), 2, "the failed message and the one behind it stay parked");
  assert.match(parked, /第二条/);
  assert.match(parked, /第三条/);

  at.messaging.drain();
  assert.equal(calls, 4, "the retry injects exactly the two that were left");
  assert.equal(files.get(inboxTakenPath(inbox(ME))), undefined);
});

test("a malformed line is skipped and never blocks the messages behind it", async () => {
  const files = new Map<string, string>();
  await seedMessage(files, "好的那条");
  files.set(inbox(ME), `{ this is not json\n${files.get(inbox(ME)) ?? ""}`);

  const at = makeLab({ files });
  at.messaging.drain();
  assert.equal(at.injected.length, 1);
  assert.match(at.injected[0], /好的那条/);
  assert.equal(files.get(inbox(ME)), undefined);
  assert.equal(files.get(inboxTakenPath(inbox(ME))), undefined);
});

test("drain does nothing without a name, or with an empty inbox", async () => {
  const unnamed = makeLab({ ownName: undefined });
  unnamed.messaging.drain();
  assert.equal(unnamed.injected.length, 0);

  const empty = makeLab();
  empty.messaging.drain();
  assert.equal(empty.injected.length, 0);
});

test("a parked inbox left by a previous tick is finished before a fresh one is taken", async () => {
  // Simulates the crash-between-ticks case: the tail of an earlier take is still
  // parked, and new traffic has arrived in the meantime. The parked tail must be
  // injected FIRST — parking the live inbox over it would destroy those messages.
  const files = new Map<string, string>();
  await seedMessage(files, "新到的");

  const record = {
    kind: "session-message",
    messageId: "msg-old",
    from: "seeder",
    fromSessionId: THEIR_SESSION,
    fromRepo: "/repo/pi-review-gate",
    fromMode: "loop",
    at: new Date(NOW).toISOString(),
    text: "上次没投出去的",
  };
  files.set(inboxTakenPath(inbox(ME)), `${JSON.stringify(record)}\n`);

  const at = makeLab({ files });
  at.messaging.drain();
  assert.equal(at.injected.length, 1);
  assert.match(at.injected[0], /上次没投出去的/);
  assert.equal(files.get(inboxTakenPath(inbox(ME))), undefined, "the parked copy is gone");
  assert.ok((files.get(inbox(ME)) ?? "").includes("新到的"), "the fresh inbox is untouched");

  at.messaging.drain();
  assert.equal(at.injected.length, 2);
  assert.match(at.injected[1], /新到的/);
});

test("normalizeRecipient and parseInboxRecord keep the shapes they promise", () => {
  assert.equal(normalizeRecipient("@t2-registry"), "t2-registry");
  assert.equal(normalizeRecipient("  t2-registry "), "t2-registry");
  assert.equal(normalizeRecipient(42), "");
  assert.equal(parseInboxRecord("not json"), undefined);
  assert.equal(parseInboxRecord('{"kind":"session-message","messageId":"m","from":"a","at":"t"}'), undefined, "no body at all");
  assert.equal(
    parseInboxRecord('{"kind":"session-message","messageId":"m","from":"a","at":"t","text":""}')?.text,
    "",
  );
});
