/**
 * The desktop host's SOCKET THREAD (lib/desktop-host-client.ts is its only user).
 *
 * The gate asks its host synchronously — every tmux call it replaces was a
 * blocking `execFileSync` — while a unix socket is asynchronous. This worker
 * owns the ONE connection the protocol allows per process
 * (docs/desktop/host-protocol.md §4.3) and answers the main thread through a
 * SharedArrayBuffer the main thread blocks on with `Atomics.wait`.
 *
 * It knows nothing about the protocol beyond "a frame is one line": encoding,
 * validation and the handshake stay on the main thread. Plain JS on purpose:
 * a worker is started from a file path, and node refuses to strip types from
 * a `.ts` file that lives under node_modules (the installed package).
 *
 * Shared layout: Int32 [seq, length, kind] then the payload bytes.
 * kind 0 = a response line, 1 = ok (connected), 2 = disconnected (payload = why),
 * 3 = not connected, so the frame was NEVER written (safe to resend after a reconnect).
 *
 * THE ASYNC LANE (`op: "send-async"`, t3b): `dialog.open` waits for a human,
 * so its answer comes back as a `postMessage` instead of through the shared
 * buffer — the main thread keeps running while it waits. Same connection, any
 * number in flight; a lost connection ends every one of them.
 */

import { createConnection } from "node:net";
import { parentPort, workerData } from "node:worker_threads";

const { socketPath, shared } = workerData;
const header = new Int32Array(shared, 0, 3);
const payload = new Uint8Array(shared, 12);
/** A line longer than this is not a frame (the protocol caps one at 1 MiB). */
const MAX_BUFFERED = payload.length;

let socket;
/** A connection still being set up — replaced (and destroyed) by a later connect. */
let pending;
let connected = false;
let buffer = "";
/** The one request the main thread is blocked on: `{ seq, id }`. */
let waiting;
/** Request ids on the async lane, answered through `postMessage`. */
const asyncIds = new Set();

function asyncReply(id, ok, text) {
  asyncIds.delete(id);
  parentPort.postMessage({ op: "async-reply", id, ok, text });
}

function reply(seq, kind, text) {
  const bytes = Buffer.from(text, "utf8");
  payload.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 2, kind);
  Atomics.store(header, 0, seq);
  Atomics.notify(header, 0);
}

function lost(why) {
  connected = false;
  buffer = "";
  if (socket) socket.destroy();
  socket = undefined;
  for (const id of [...asyncIds]) asyncReply(id, false, why);
  if (waiting) {
    const { seq } = waiting;
    waiting = undefined;
    reply(seq, 2, why);
  }
}

function onData(chunk) {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    let id;
    try { id = JSON.parse(line).id; } catch { /* the main thread reports the bad frame */ }
    if (typeof id === "string" && asyncIds.has(id)) {
      if (Buffer.byteLength(line, "utf8") > payload.length) return lost("收到超长的帧");
      asyncReply(id, true, line);
      continue;
    }
    // A response nobody is waiting on any more (its request timed out) is dropped.
    if (waiting && (id === waiting.id || typeof id !== "string")) {
      // A line too big to hand over breaks the framing contract: the whole
      // connection goes, so the next request starts over with a fresh `hello`.
      if (Buffer.byteLength(line, "utf8") > payload.length) return lost("收到超长的帧");
      const { seq } = waiting;
      waiting = undefined;
      reply(seq, 0, line);
    }
  }
  if (Buffer.byteLength(buffer, "utf8") > MAX_BUFFERED) lost("收到超长的帧");
}

function connect(seq) {
  if (connected) return reply(seq, 1, "");
  // ONE connection per process (§4.3): an attempt that timed out is abandoned here.
  if (pending) pending.destroy();
  const conn = createConnection(socketPath);
  pending = conn;
  conn.setEncoding("utf8");
  let settled = false;
  conn.once("connect", () => {
    settled = true;
    pending = undefined;
    socket = conn;
    connected = true;
    reply(seq, 1, "");
  });
  conn.on("data", onData);
  conn.on("error", (error) => {
    if (!settled) {
      settled = true;
      if (pending === conn) pending = undefined;
      conn.destroy();
      reply(seq, 2, `连不上 ${socketPath}：${error.message}`);
    } else if (socket === conn) {
      lost(`连接出错：${error.message}`);
    }
  });
  conn.on("close", () => { if (socket === conn) lost("客户端关闭了连接"); });
}

parentPort.on("message", (message) => {
  if (message.op === "connect") return connect(message.seq);
  if (message.op === "send") {
    if (!connected || !socket) return reply(message.seq, 3, "未连接");
    waiting = { seq: message.seq, id: message.id };
    socket.write(message.frame);
    return undefined;
  }
  if (message.op === "send-async") {
    if (!connected || !socket) return parentPort.postMessage({ op: "async-reply", id: message.id, ok: false, notSent: true, text: "未连接" });
    asyncIds.add(message.id);
    socket.write(message.frame);
    return undefined;
  }
  if (message.op === "close") lost("本进程关闭了连接");
  return undefined;
});
