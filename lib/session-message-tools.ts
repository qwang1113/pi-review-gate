/**
 * `send_message` — one session reaching ANOTHER BY NAME (t3, 2026-09-25).
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ──
 *
 * A name (`@t2-registry`) is a session's address (lib/session-registry.ts owns
 * who holds one and whether the holder is still alive). This module is the
 * traffic that address carries: one free-form message from one session to
 * another, delivered by the SENDER writing into the recipient's inbox and the
 * RECIPIENT's own gate injecting it as a user message.
 *
 * It deliberately does NOT touch the structured channel
 * (lib/orchestrator-channel.ts): a project manager's instruction, a child's
 * state report, a judge's verdict and an ask_user proxy answer each have a
 * schema, a lifecycle and an answer path of their own, and handing them a
 * second transport would be exactly the redundancy this project deletes. What
 * the two DO share is the transport PRIMITIVES, and they are shared on purpose
 * rather than re-invented:
 *
 *   - one JSON line per record, appended with a single `O_APPEND` write (the
 *     only kind POSIX guarantees is atomic, and only under `PIPE_BUF`);
 *   - anything bulky SPILLED to a side file first
 *     ({@link ChannelPayloadRef} + `MAX_INLINE_RECORD_BYTES`), so the line that
 *     is actually appended can never be torn by a concurrent append.
 *
 * ── WHY THE RECIPIENT POLLS, AND WHY IT DOES NOT INTERRUPT ──
 *
 * The injection is `pi.sendUserMessage(text, { deliverAs: "steer" })`, and its
 * contract is the whole product decision (user, 2026-09-25): a message does not
 * abort whatever the recipient is doing — it lands when the tool call it is in
 * the middle of finishes. pi's own reading of `steer` gives exactly that: while
 * the agent is streaming it is queued as steering (injected after the current
 * assistant turn's tool calls), and while the agent is idle it opens a new turn.
 * There is no `followUp` here on purpose — that queue is drained only when the
 * session STOPS, and a loop session is forbidden to stop before its contract is
 * met, so a follow-up would arrive hours late and read as a verdict on a round
 * that is long over (AGENTS.md says the same about the async precommit report).
 *
 * ── ONE RECIPIENT, ONE NAME, AND NO SECOND LIVENESS ANSWER ──
 *
 * The sender picks a NAME; `liveSessionNames()` (lib/session-name-tools.ts) is
 * what turns the registry into “which of these are still sessions”, and this
 * module never writes a second answer to that question. A name that is not live
 * fails with the list of names that ARE — a sender that guessed wrong should
 * have the actual addresses in the receipt, not just a refusal.
 *
 * A MESSAGE IS ADDRESSED TO A NAME *AND* TO THE SESSION THAT HELD IT THEN
 * ({@link SessionInboxRecord.toSessionId}). A name is an address and addresses
 * get reused; without that field a session that took a name over would read
 * mail meant for its predecessor. The consumer skips what was not addressed to
 * it, which is also why NOTHING EVER DELETES MAIL ON SOMEBODY ELSE'S BEHALF:
 *
 *   - a released name keeps whatever is in it (lib/session-registry.ts
 *     `releaseName`), and the orphan sweep does not collect a dead holder's
 *     inbox either;
 *   - whoever takes the name over reads it (skipping what was not theirs), so
 *     the leftovers are reclaimed the next time the name is used — and if it is
 *     never used again they simply stay, which is a bounded amount of dead file
 *     nobody can be hurt by;
 *   - the consumer deletes what IT has read, which is the only deletion in this
 *     module and races with nobody.
 *
 * THAT IS A DELIBERATE REVERSAL (reviewer P1 twice, 2026-09-25). The tempting
 * cleanup — “the holder is gone, delete its inbox” — cannot be made safe at this
 * layering: freeing a name and deleting its mail are two operations, and a fresh
 * session can claim the name and be sent a message in between. Trying to close
 * that with a re-read (a CAS) only narrows the window; the only remaining
 * alternative would be to make the name and its mail ONE atomic unit (a
 * directory per name, moved aside in a single `rename`), which would rewrite
 * t2's path contract for a race whose loser is somebody's message. Leaving the
 * file is the cheap failure; a message deleted after its sender was told it was
 * delivered is not.
 *
 * ── TAKING THE INBOX IS A RENAME, NOT A READ-AND-CLEAR ──
 *
 * Consuming is where a naive implementation loses messages, so it is worth
 * being precise. Reading the file and then emptying it leaves a window in which
 * another sender's append lands in a file that is about to be cleared — the
 * message is destroyed while both sides believe they succeeded. So the pending
 * inbox is MOVED ASIDE first (`<inbox>.taken`, one `rename(2)`, atomic), and
 * read from there: a concurrent append either lands in the file before the
 * rename (so it is in the taken copy) or creates a fresh inbox afterwards (so
 * it is read next tick). A message is never both read and deleted.
 *
 * ONE WINDOW, RECORDED RATHER THAN HIDDEN (quality round P2, 2026-09-25).
 * `appendFileSync` is open→write→close: three system calls, not one atomic one.
 * A sender that opens the OLD inode before the rename and is preempted until
 * after the parked copy has been read writes into the parked file, and the
 * removal that follows takes that line with it. Closing the window would mean
 * re-checking the inode after every append (`fstat` against `stat`, retry on
 * mismatch) — a real cost on the one path that is supposed to be a single
 * write, for a race that needs a microsecond-scale preemption to happen at all.
 * The trade is taken deliberately: the window is this narrow, and this is where
 * it is written down.
 *
 * WHAT A FAILED INJECTION DOES. A round stops at the first message that could
 * not be injected, and the messages it had not reached yet — that one included
 * — are written back into the taken file, which the next tick picks up. The
 * ones already injected are NOT replayed. A malformed line is skipped and
 * reported, never allowed to block the messages behind it.
 *
 * Pure-ish: the file system arrives through {@link InboxIO}, the injection and
 * the list of live sessions arrive as callbacks, and the clock is injected — so
 * every branch above runs in a test with no pi, no tmux and no real disk.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { Type } from "typebox";

import { writeFileAtomic } from "./atomic-write.ts";
import {
  MAX_INLINE_RECORD_BYTES,
  newChannelId,
  resolvePayload,
  type ChannelPayloadRef,
} from "./orchestrator-channel.ts";
import {
  heartbeatAgeMs,
  sessionInboxPath,
  sessionInboxTakenPath,
  sessionNameProblem,
  sessionRegistryRoot,
  type SessionRegistryEntry,
} from "./session-registry.ts";
import type { ToolHost, ToolReply } from "./tool-host.ts";

/** The one record kind an inbox carries. Its own, deliberately not a channel record. */
export const SESSION_MESSAGE_KIND = "session-message";

/** How much of the message a receipt echoes back. Enough to recognise, not a transcript. */
export const SESSION_MESSAGE_PREVIEW = 160;

/**
 * One message in a name's inbox.
 *
 * `from` is a NAME, never a bare session id: the user decision (2026-09-25) is
 * that only a named session may send — the recipient has to know who wrote, and
 * it has to be able to answer, which are the same requirement.
 */
export interface SessionInboxRecord {
  kind: typeof SESSION_MESSAGE_KIND;
  /** Collision-resistant id; also names the side file when the text spills. */
  messageId: string;
  /** The sender's name, without the `@`. */
  from: string;
  /**
   * WHO the message was addressed to: the pi session id of the session that
   * held `name` at the moment it was sent.
   *
   * Optional, and absent on records written before this field existed — those
   * are delivered to whoever holds the name (the only reading available).
   */
  toSessionId?: string;
  fromSessionId: string;
  fromRepo: string;
  fromMode: string;
  /** ISO timestamp. */
  at: string;
  /** The body, when it fitted inline. */
  text?: string;
  /** The body's side file, when it did not. */
  textRef?: ChannelPayloadRef;
}

/**
 * Every filesystem touch the inbox makes — the same five primitives the channel
 * needs plus the two the take-aside consumption needs (`rename`, `remove`).
 *
 * It is its own seam rather than a widened `ChannelIO` because the extra two
 * exist for a reason the channel does not have: a channel is only ever appended
 * to, while an inbox is CONSUMED, and consuming is the one operation that has to
 * be decided here.
 */
export interface InboxIO {
  ensureDir(dir: string): void;
  /** One append write. Atomicity is the contract — never split the line. */
  appendLine(path: string, line: string): void;
  readText(path: string): string | undefined;
  /** Atomic replace. */
  writeText(path: string, text: string): void;
  /** `rename(2)`: false when the source is gone. */
  rename(from: string, to: string): boolean;
  remove(path: string): boolean;
}

/** The real file system. */
export function nodeInboxIO(): InboxIO {
  return {
    ensureDir(dir) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* the append reports it */ }
    },
    appendLine(path, line) {
      appendFileSync(path, line, "utf8");
    },
    readText(path) {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
    writeText(path, text) {
      writeFileAtomic(path, text);
    },
    rename(from, to) {
      try { renameSync(from, to); return true; } catch { return false; }
    },
    remove(path) {
      try { rmSync(path, { force: true }); return true; } catch { return false; }
    },
  };
}

/**
 * The shape a message id must have: ONE safe path segment.
 *
 * WHY IT IS ENFORCED AT PARSE TIME (quality round P1, 2026-09-25): the id is
 * what {@link inboxPayloadPath} builds a path from, and the record it travels in
 * comes off a file that anything on the machine may append to. Without this, a
 * crafted `messageId` of `../../src/important` would build a path OUTSIDE the
 * inbox, and the equality check that guards the side file would be checking the
 * attacker's own arithmetic.
 */
export const MESSAGE_ID_PATTERN = /^(?!.*\.\.)[A-Za-z0-9._-]{1,64}$/;

/**
 * Where a message's spilled body lives: `<inbox>.<messageId>.payload`.
 *
 * Derived from the inbox path, so the rule stays in one place — the sender
 * writes here, the consumer removes what it has read, and the send path can
 * clean up after itself when the append that would have pointed at this file
 * never happened.
 */
export function inboxPayloadPath(inboxPath: string, messageId: string): string {
  return `${inboxPath}.${messageId}.payload`;
}

/** `@名字` and `名字` are the same address — the prefix is courtesy, not syntax. */
export function normalizeRecipient(to: unknown): string {
  const raw = typeof to === "string" ? to.trim() : "";
  return raw.startsWith("@") ? raw.slice(1).trim() : raw;
}

/** Parse one stored line. Undefined on any doubt — the caller reports and skips it. */
export function parseInboxRecord(line: string): SessionInboxRecord | undefined {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return undefined; }
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.kind !== SESSION_MESSAGE_KIND) return undefined;
  const messageId = typeof value.messageId === "string" ? value.messageId.trim() : "";
  const from = typeof value.from === "string" ? value.from.trim() : "";
  const at = typeof value.at === "string" ? value.at.trim() : "";
  // AN ID THAT COULD BE A PATH IS NOT AN ID (see {@link MESSAGE_ID_PATTERN}).
  // Rejected here, where the file is read, so no consumer has to remember.
  if (!messageId || !MESSAGE_ID_PATTERN.test(messageId) || !from || !at) return undefined;
  const textRef = value.textRef as ChannelPayloadRef | undefined;
  const hasRef = !!textRef && typeof textRef.path === "string" && textRef.path.trim() !== "";
  const text = typeof value.text === "string" ? value.text : undefined;
  if (text === undefined && !hasRef) return undefined;
  const toSessionId = typeof value.toSessionId === "string" && value.toSessionId.trim() !== ""
    ? value.toSessionId.trim()
    : undefined;
  return {
    kind: SESSION_MESSAGE_KIND,
    messageId,
    from,
    fromSessionId: typeof value.fromSessionId === "string" ? value.fromSessionId : "",
    fromRepo: typeof value.fromRepo === "string" ? value.fromRepo : "",
    fromMode: typeof value.fromMode === "string" ? value.fromMode : "",
    at,
    ...(text === undefined ? {} : { text }),
    ...(hasRef ? { textRef } : {}),
    ...(toSessionId === undefined ? {} : { toSessionId }),
  };
}

/**
 * The text the recipient's agent actually reads — sender first, because "who is
 * this from" is what decides whether the message is even for it.
 *
 * The closing line is not decoration: the receiving agent has no other way to
 * learn that a message came from a PEER rather than from its user, and a peer is
 * answerable with the same tool that delivered it.
 */
export function formatInboxMessage(record: SessionInboxRecord, text: string): string {
  return (
    `[来自 @${record.from} 的会话消息 · ${record.at}]\n` +
    `${text}\n\n` +
    `（这不是用户的输入，是另一个 pi 会话发来的消息。要回它一句：` +
    `send_message({to:"@${record.from}", text:"…"})）`
  );
}

/** What the sender needs to know about itself. */
export interface SessionMessageSelf {
  /** The name this session holds — sending requires one (user decision). */
  name?: string;
  sessionId: string;
  /** Primary repo root, for the receipt's "who are you" line. */
  repo: string;
  mode: string;
}

/** Everything the messaging runtime needs from the session it runs in. */
export interface SessionMessagingDeps {
  /** Registry root; defaults to `~/.pi/agent/rg-sessions`. */
  root?: string;
  /** Inbox IO; defaults to the real file system. */
  io?: InboxIO;
  /**
   * The names that are still sessions, from the registry's own answer
   * (lib/session-name-tools.ts `liveSessionNames`). The sender PICK a name; it
   * never re-decides liveness here.
   */
  liveSessions(): { live: SessionRegistryEntry[]; unknown: SessionRegistryEntry[] };
  /** THIS session's identity, read live (the name can be taken away mid-session). */
  self(): SessionMessageSelf;
  /**
   * Hand one formatted message to pi — `pi.sendUserMessage(text, {deliverAs:
   * "steer"})` in the extension. Throws when pi refused it; the message then
   * stays in the inbox and the next drain retries.
   */
  inject(text: string): void;
  now?: () => number;
  log?(message: string): void;
}

/** What the extension wires: one tool, and one poll on the heartbeat it already has. */
export interface SessionMessaging {
  register(host: ToolHost): void;
  /** Consume this session's inbox, if it has a name and something is waiting. */
  drain(): void;
}

export function createSessionMessaging(deps: SessionMessagingDeps): SessionMessaging {
  const root = deps.root ?? sessionRegistryRoot();
  const io = deps.io ?? nodeInboxIO();
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => { /* silent unless the caller wants a log */ });

  function ok(text: string, details: Record<string, unknown> = {}): ToolReply {
    return { content: [{ type: "text", text }], details };
  }

  function fail(text: string): ToolReply {
    return { content: [{ type: "text", text }], details: { ok: false }, isError: true };
  }

  /** `5 秒前` / `3 分钟前` — a receipt reads better than an ISO stamp. */
  function age(entry: SessionRegistryEntry): string {
    const ms = heartbeatAgeMs(entry, now());
    if (ms === undefined) return "未知";
    return ms < 60_000 ? `${Math.round(ms / 1000)} 秒前` : `${Math.round(ms / 60_000)} 分钟前`;
  }

  function describe(entry: SessionRegistryEntry): string {
    const repo = entry.repo || "(repo 未知)";
    return `@${entry.name}（repo=${repo}、状态=${entry.state}、模式=${entry.mode}、心跳=${age(entry)}）`;
  }

  /** The addresses a failed send hands back, so the next try can just copy one. */
  function addressBook(): string {
    let live: SessionRegistryEntry[] = [];
    let unknown: SessionRegistryEntry[] = [];
    try {
      const listed = deps.liveSessions();
      live = listed.live;
      unknown = listed.unknown;
    } catch (error) {
      return `\n（活会话清单也读不出来：${(error as Error).message}）`;
    }
    const lines: string[] = [];
    if (live.length === 0) {
      lines.push("当前没有任何命名过的活会话 —— 注册表只登记显式调用过 name_session 的会话。");
    } else {
      lines.push("当前活着的会话（可直接 send_message({to:\"@名字\", text:\"…\"})）：");
      for (const entry of live) lines.push(`  - ${describe(entry)}`);
    }
    if (unknown.length > 0) {
      lines.push("生死判不出来的（tmux 或进程读不到，fail-closed 不投递）：");
      for (const entry of unknown) lines.push(`  - ${describe(entry)}`);
    }
    return `\n${lines.join("\n")}`;
  }

  /** The body as it goes on the wire, spilling it when the line would be too long. */
  function withSpill(record: SessionInboxRecord, inboxPath: string): SessionInboxRecord {
    if (record.text === undefined) return record;
    if (Buffer.byteLength(JSON.stringify(record), "utf8") <= MAX_INLINE_RECORD_BYTES) return record;
    const path = inboxPayloadPath(inboxPath, record.messageId);
    io.writeText(path, record.text);
    const { text, ...rest } = record;
    return { ...rest, textRef: { path, chars: text.length } };
  }

  /** Write one message into `@name`'s inbox. Returns a receipt, never throws. */
  function deliver(target: SessionRegistryEntry, sender: SessionMessageSelf, text: string): ToolReply {
    const inbox = sessionInboxPath(root, target.name);
    const at = new Date(now()).toISOString();
    const messageId = newChannelId("msg", now());
    let record: SessionInboxRecord;
    try {
      io.ensureDir(dirname(inbox));
      // SPILLING IS INSIDE THE GUARD TOO (quality round P2): writing the side
      // file can fail for the same reasons the append can (a full or read-only
      // disk), and this function promises a receipt rather than a throw.
      record = withSpill(
        {
          kind: SESSION_MESSAGE_KIND,
          messageId,
          from: sender.name ?? "",
          fromSessionId: sender.sessionId,
          fromRepo: sender.repo,
          fromMode: sender.mode,
          // WHO IS BEING ADDRESSED: the name plus the session holding it right
          // now. A name can change hands before the message is read, and the
          // next holder must not be handed this one's mail.
          ...(target.sessionId === undefined || target.sessionId === ""
            ? {}
            : { toSessionId: target.sessionId }),
          at,
          text,
        },
        inbox,
      );
      io.appendLine(inbox, `${JSON.stringify(record)}\n`);
    } catch (error) {
      // A HALF-WRITTEN MESSAGE LEAVES NOTHING BEHIND: the body may already be
      // in its side file while the line that points at it never landed. The
      // removal is by THIS message's own id, so it can only ever hit the file
      // this call just wrote (and removing a file that was never written is a
      // no-op).
      io.remove(inboxPayloadPath(inbox, messageId));
      return fail(
        `review-gate: 消息没写进 @${target.name} 的 inbox —— ${(error as Error).message}\n` +
        `inbox：${inbox}`,
      );
    }
    const preview = text.length > SESSION_MESSAGE_PREVIEW ? `${text.slice(0, SESSION_MESSAGE_PREVIEW)}…` : text;
    return ok(
      `review-gate: 已投递给 ${describe(target)}。\n` +
      `消息：${preview}\n` +
      `投递：${inbox}\n` +
      `它下一次轮询（≤30 秒）就会读到，作为一条 user 消息注入 —— ` +
      `不会打断它当前正在跑的那一步，它做完手上这步就看到。`,
      { ok: true, to: target.name, messageId: record.messageId, at },
    );
  }

  /** `send_message` — validate, find the recipient, deliver, or say why not. */
  function sendMessage(to: unknown, text: unknown): ToolReply {
    const sender = deps.self();
    if (sender.name === undefined || sender.name.trim() === "") {
      return fail(
        "review-gate: 你还没有名字，发不了消息 —— 对方得知道是谁发的、也才知道怎么回你。\n" +
        "先给自己起一个：name_session({name:\"t3-lane\"})（kebab-case、2–32 字符、全局唯一），然后再发。",
      );
    }
    const me: SessionMessageSelf = { ...sender, name: sender.name.trim() };
    const body = typeof text === "string" ? text : "";
    if (body.trim() === "") {
      return fail("review-gate: 消息正文是空的 —— text 得写点什么。");
    }
    const name = normalizeRecipient(to);
    if (name === "") {
      return fail(
        "review-gate: 没写收件人 —— to 要填对方的名字（如 \"@t2-registry\"）。" + addressBook(),
      );
    }
    const problem = sessionNameProblem(name);
    if (problem !== undefined) {
      return fail(
        `review-gate: 收件人名字不合法 —— ${problem}\n（to=${JSON.stringify(typeof to === "string" ? to : "")}）` +
        addressBook(),
      );
    }
    if (name === me.name) {
      return fail(
        `review-gate: ${name} 就是你自己 —— 会话消息是发给别人的，自己给自己发绕了一圈什么也没发生。` +
        addressBook(),
      );
    }
    let live: SessionRegistryEntry[] = [];
    let unknown: SessionRegistryEntry[] = [];
    try {
      const listed = deps.liveSessions();
      live = listed.live;
      unknown = listed.unknown;
    } catch (error) {
      return fail(
        `review-gate: 读不到会话注册表，无法确认 @${name} 还活着（fail-closed 不发）：` +
        `${(error as Error).message}\n注册表：${sessionInboxPath(root, name)}`,
      );
    }
    const target = live.find((entry) => entry.name === name);
    if (target !== undefined) return deliver(target, me, body);
    const stalled = unknown.find((entry) => entry.name === name);
    if (stalled !== undefined) {
      return fail(
        `review-gate: 没送出去 —— @${name} 的生死判不出来（心跳过期，但 tmux 或进程读不到）：${describe(stalled)}。\n` +
        "按 fail-closed 处理：不投递到一个可能已经死掉的 inbox。稍后重试，或换一个活会话。" + addressBook(),
      );
    }
    return fail(
      `review-gate: 没送出去 —— @${name} 不在活会话里（它可能从没登记过这个名字，也可能已经死了）。` +
      addressBook(),
    );
  }

  /**
   * Consume whatever is in THIS session's inbox.
   *
   * The order is the whole point: park the inbox (rename) → inject line by line
   * → drop the parked copy only when every line has been handed to pi. A failure
   * leaves the untouched tail exactly where the next tick will find it.
   */
  function drain(): void {
    const self = deps.self();
    const name = self.name?.trim();
    if (name === undefined || name === "") return;
    const mySessionId = self.sessionId.trim();
    const inbox = sessionInboxPath(root, name);
    const taken = sessionInboxTakenPath(root, name);
    // A parked copy from a previous tick is finished FIRST, and the live inbox
    // is not touched until it is gone: parking over it would overwrite the very
    // messages the last tick failed to inject.
    if (io.readText(taken) === undefined) {
      if (!io.rename(inbox, taken)) return; // nothing waiting (or unreadable) — nothing to do
    }
    const raw = io.readText(taken);
    if (raw === undefined) return;
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      io.remove(taken);
      return;
    }
    let index = 0;
    for (; index < lines.length; index += 1) {
      const record = parseInboxRecord(lines[index]);
      if (record === undefined) {
        // A MALFORMED LINE TAKES NO SIDE FILE WITH IT, and cannot: the id that
        // names that file is exactly what failed to parse. The line is reported
        // and skipped, and a body it may have had stays as a dead file — a torn
        // line is the only way to produce one, and nothing can locate it later.
        log(`inbox 有一行读不出来，已跳过：${lines[index].slice(0, 120)}`);
        continue;
      }
      // A SIDE FILE MAY ONLY BE THE ONE THIS INBOX OWNS (quality round P1,
      // 2026-09-25). The record comes off a file anything on this machine can
      // append to, and its `textRef.path` is used to READ (into the recipient's
      // transcript) and to DELETE. Following it blindly is a crafted record
      // that reads `~/.ssh/id_rsa` into a session or deletes a source file. So
      // the path is never trusted — it is re-derived from THIS inbox and THIS
      // message id (itself shape-checked at parse time) and must match exactly.
      // Anything else is “no body”: reported, never followed.
      const own = record.textRef !== undefined && record.textRef.path === inboxPayloadPath(inbox, record.messageId)
        ? record.textRef
        : undefined;
      if (record.textRef !== undefined && own === undefined) {
        log(`来自 @${record.from} 的消息带了一个不属于它的 side file（${record.textRef.path}），已忽略`);
      }
      // NOT ADDRESSED TO ME (reviewer P1, 2026-09-25): the message names the
      // session that held this name when it was sent, and this session took the
      // name over afterwards. Reading it would hand a new holder somebody
      // else's mail; it is dropped here, with the parked file, which is the only
      // place these leftovers are ever reclaimed.
      if (record.toSessionId !== undefined && mySessionId !== "" && record.toSessionId !== mySessionId) {
        log(`来自 @${record.from} 的消息是发给上一个持有这个名字的会话的（${record.toSessionId}），已丢弃`);
        // ITS SPILLED BODY GOES WITH IT (reviewer P2, 2026-09-25): the message is
        // dropped, and the side file held only a body nobody is going to read.
        if (own !== undefined) io.remove(own.path);
        continue;
      }
      const text = record.text ?? (own === undefined ? undefined : resolvePayload(io, own));
      if (text === undefined) {
        log(`来自 @${record.from} 的消息（${record.messageId}）正文读不出来（溢出文件丢失），已跳过`);
        continue;
      }
      try {
        deps.inject(formatInboxMessage(record, text));
      } catch (error) {
        log(
          `注入 @${record.from} 的消息失败（${(error as Error).message}）—— ` +
          "未注入的留在 inbox 里，下次心跳重试",
        );
        break;
      }
      // THE SPILLED BODY GOES WITH THE MESSAGE (quality round P2): a side file
      // exists only to keep the JSONL line short, and once the text is in the
      // recipient's hands it is dead weight in the registry directory.
      if (own !== undefined) io.remove(own.path);
    }
    if (index >= lines.length) {
      io.remove(taken);
      return;
    }
    // Put the tail back, the failed message included. The parked file is ours
    // alone, so this rewrite races with nobody.
    io.writeText(taken, `${lines.slice(index).join("\n")}\n`);
  }

  return {
    register(host: ToolHost): void {
      host.registerTool({
        name: "send_message",
        label: "Message Another Session",
        description:
          "Send a message to ANOTHER pi session by its name (`@名字`) — the name another session took " +
          "with `name_session`, registered machine-wide in ~/.pi/agent/rg-sessions/. The message is written " +
          "into that session's inbox and its own gate injects it as a user message. It does NOT interrupt " +
          "whatever the recipient is doing: the message lands when the tool call it is in the middle of " +
          "finishes. The `@` prefix is optional. YOU must be a named session too (call `name_session` " +
          "first) — the recipient has to know who wrote and how to answer. A name that is not a live " +
          "session fails, and the failure lists the sessions that are alive right now.",
        parameters: Type.Object({
          to: Type.String({ description: "收件人的名字，`@` 前缀可写可不写（如 `@t2-registry` 或 `t2-registry`）。" }),
          text: Type.String({ description: "要发的正文（纯文本）。" }),
        }),
        execute: (_id, params) => Promise.resolve(sendMessage(params.to, params.text)),
      });
    },

    drain,
  };
}
