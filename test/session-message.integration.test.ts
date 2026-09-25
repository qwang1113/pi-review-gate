/**
 * THE MESSAGE PATH ON A REAL DISK.
 *
 * The unit tests pin what the module DECIDES (a Map for a file system, a list
 * for the injection, so every failure branch is reachable). What they cannot
 * pin is that the real primitives behave the way the design assumes: that one
 * `appendFileSync` really appends one line, that `rename(2)` really moves the
 * inbox out from under a later append, and that the parked copy a failed
 * injection leaves behind is really there on the next tick's disk read.
 *
 * That is all this file does. No pi and no tmux are involved: who is alive is
 * the registry's answer and is handed in here, exactly as the extension hands
 * it in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSessionMessaging,
  inboxTakenPath,
  nodeInboxIO,
  parseInboxRecord,
} from "../lib/session-message-tools.ts";
import { sessionInboxPath, type SessionRegistryEntry } from "../lib/session-registry.ts";
import { MAX_INLINE_RECORD_BYTES } from "../lib/orchestrator-channel.ts";

const ME = "t3-lane";
const THEIRS = "t9-pm";

function entry(name: string): SessionRegistryEntry {
  return {
    schema: 1,
    name,
    sessionId: `sess-${name}`,
    pid: process.pid,
    repo: "/repo/pi-review-gate",
    cwd: "/repo/pi-review-gate",
    mode: "loop",
    state: "working",
    registeredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
}

/** A runtime over one temp root; `inject` is whatever the test wants to observe. */
function runtime(root: string, opts: { name?: string; inject?: (text: string) => void } = {}) {
  const injected: string[] = [];
  const messaging = createSessionMessaging({
    root,
    io: nodeInboxIO(),
    liveSessions: () => ({ live: [entry(ME)], unknown: [] }),
    self: () => ({
      ...(opts.name === undefined ? {} : { name: opts.name }),
      sessionId: "sess-sender",
      repo: "/repo/pi-review-gate",
      mode: "loop",
    }),
    inject: opts.inject ?? ((text) => { injected.push(text); }),
  });
  let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }> } | undefined;
  messaging.register({ registerTool: (spec: unknown) => { tool = spec as typeof tool; } } as never);
  if (!tool) throw new Error("send_message was not registered");
  return { messaging, tool, injected };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "rg-message-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a message written by one session is injected by the other, and the inbox is gone afterwards", async () => {
  await withRoot(async (root) => {
    const sender = runtime(root, { name: THEIRS });
    const receiver = runtime(root, { name: ME });
    const inbox = sessionInboxPath(root, ME);

    const reply = await sender.tool.execute("1", { to: `@${ME}`, text: "把 lib/foo.ts 的导出改名" });
    assert.equal(reply.isError, undefined, reply.content[0].text);
    // ONE line, written with one append: what the concurrency argument rests on.
    const raw = readFileSync(inbox, "utf8");
    assert.equal(raw.trimEnd().split("\n").length, 1);
    assert.equal(parseInboxRecord(raw.trimEnd())?.from, THEIRS);

    receiver.messaging.drain();
    assert.equal(receiver.injected.length, 1);
    assert.match(receiver.injected[0], /来自 @t9-pm 的会话消息/);
    assert.ok(receiver.injected[0].includes("把 lib/foo.ts 的导出改名"));
    assert.equal(existsSync(inbox), false, "consumed: the inbox is taken away");
    assert.equal(existsSync(inboxTakenPath(inbox)), false, "and so is the parked copy");

    // A second drain has nothing left to replay.
    receiver.messaging.drain();
    assert.equal(receiver.injected.length, 1);
  });
});

test("two senders appending concurrently keep their messages readable", async () => {
  await withRoot(async (root) => {
    const first = runtime(root, { name: THEIRS });
    const second = runtime(root, { name: "t2-registry" });
    const inbox = sessionInboxPath(root, ME);

    const replies = await Promise.all([
      first.tool.execute("1", { to: ME, text: "来自第一个发送方" }),
      second.tool.execute("2", { to: ME, text: "来自第二个发送方" }),
    ]);
    for (const reply of replies) assert.equal(reply.isError, undefined, reply.content[0].text);
    const lines = readFileSync(inbox, "utf8").split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 2);
    const texts = lines.map((line) => parseInboxRecord(line)?.text).sort();
    assert.deepEqual(texts, ["来自第二个发送方", "来自第一个发送方"].sort());

    const receiver = runtime(root, { name: ME });
    receiver.messaging.drain();
    assert.equal(receiver.injected.length, 2);
  });
});

test("a body too long for one line spills to a real side file and still arrives", async () => {
  await withRoot(async (root) => {
    const sender = runtime(root, { name: THEIRS });
    const body = "中".repeat(4000); // 12000 bytes — far past the inline budget
    await sender.tool.execute("1", { to: ME, text: body });
    const inbox = sessionInboxPath(root, ME);
    const line = readFileSync(inbox, "utf8").trim();
    assert.ok(Buffer.byteLength(line, "utf8") <= MAX_INLINE_RECORD_BYTES);
    const record = parseInboxRecord(line);
    assert.equal(record?.text, undefined);
    assert.equal(readFileSync(record?.textRef?.path ?? "", "utf8"), body, "the whole body is on disk");

    const receiver = runtime(root, { name: ME });
    receiver.messaging.drain();
    assert.equal(receiver.injected.length, 1);
    assert.ok(receiver.injected[0].includes(body), "the injected text carries the whole body");
  });
});

test("an injection that fails leaves the message on disk for the next tick", async () => {
  await withRoot(async (root) => {
    const sender = runtime(root, { name: THEIRS });
    const inbox = sessionInboxPath(root, ME);
    await sender.tool.execute("1", { to: ME, text: "第一条" });
    await sender.tool.execute("2", { to: ME, text: "第二条" });

    let calls = 0;
    const failing = runtime(root, {
        name: ME,
      inject: () => { calls += 1; throw new Error("pi 不在"); },
    });
    failing.messaging.drain();
    assert.equal(calls, 1);
    const parked = inboxTakenPath(inbox);
    assert.ok(existsSync(parked), "the failed message is parked, not lost");
    const lines = readFileSync(parked, "utf8").split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 2, "it and the one behind it stay");

    const recovered = runtime(root, { name: ME });
    recovered.messaging.drain();
    assert.equal(recovered.injected.length, 2);
    assert.equal(existsSync(parked), false);
    assert.equal(existsSync(inbox), false);
  });
});

test("a corrupt line does not stop the good message behind it", async () => {
  await withRoot(async (root) => {
    const sender = runtime(root, { name: THEIRS });
    const inbox = sessionInboxPath(root, ME);
    await sender.tool.execute("1", { to: ME, text: "好的" });
    writeFileSync(inbox, `{ not json at all\n${readFileSync(inbox, "utf8")}`, "utf8");
    const receiver = runtime(root, { name: ME });
    receiver.messaging.drain();
    assert.equal(receiver.injected.length, 1);
    assert.ok(receiver.injected[0].includes("好的"));
    assert.equal(existsSync(inbox), false);
  });
});
