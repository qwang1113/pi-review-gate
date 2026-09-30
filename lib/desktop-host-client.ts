/**
 * THE DESKTOP HOST CONNECTION — one per process, asked synchronously.
 *
 * Every call the gate makes to its host is synchronous (the tmux host is a
 * blocking `execFileSync` per act, and the whole call graph above it was built
 * that way). The socket lives on a worker thread (lib/desktop-host-worker.mjs)
 * and this side blocks on a SharedArrayBuffer with `Atomics.wait`, bounded by
 * the protocol's own timeout — the same shape as a blocking tmux call.
 *
 * Lifecycle (docs/desktop/host-protocol.md §4): connect + `hello` on first use
 * (or at session start through `connect()`), one connection for the life of the
 * process, and after a disconnect the NEXT request tries once more — no timer,
 * no queue, no retry loop. Everything that goes wrong comes back as a
 * {@link ProtocolError}; nothing here throws and nothing falls back.
 *
 * `dialog.open` is refused by `request`: it waits for a human, and a blocked
 * main thread would freeze the session for as long as the human takes. It has
 * its own ASYNC lane on the same connection instead: `dialog` (t3b).
 */

import { Worker } from "node:worker_threads";

import {
  decodeResponse,
  encodeRequest,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
  requestTimeoutMs,
  type Method,
  type Params,
  type ProtocolError,
  type Result,
} from "./desktop-host-protocol.ts";

export type DesktopReply<M extends Method> = { ok: true; result: Result<M> } | { ok: false; error: ProtocolError };

export interface DesktopClient {
  /** Connect and shake hands now, if not already connected. */
  connect(): { ok: true } | { ok: false; error: ProtocolError };
  request<M extends Method>(method: M, params: Params<M>): DesktopReply<M>;
  /**
   * `dialog.open`, without blocking: resolves when the client answers or the
   * connection is lost (`disconnected`). No timeout — it waits for a human;
   * taking the box down is the caller's `dialog.close`.
   */
  dialog(params: Params<"dialog.open">): Promise<DesktopReply<"dialog.open">>;
  close(): void;
}

export interface DesktopClientOptions {
  socketPath: string;
  /** What `hello` says about this process. */
  hello(): Params<"hello">;
  /** Test seam: a shorter bound than the protocol's 5s. */
  timeoutMs?: number;
}

/** Kinds the worker writes into the shared header. */
const KIND_LINE = 0;
const KIND_OK = 1;
/** The worker had no connection, so the frame never left this process. */
const KIND_NOT_SENT = 3;

/** What the worker posts back for an async-lane request. */
interface AsyncReply {
  ok: boolean;
  text: string;
  /** The frame never left this process (no connection). */
  notSent?: boolean;
}

export function helloFor(opts: { hostSessionId: string; cwd: string; piSessionId?: string | undefined }): Params<"hello"> {
  return {
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    hostSessionId: opts.hostSessionId,
    cwd: opts.cwd,
    ...(opts.piSessionId ? { piSessionId: opts.piSessionId.slice(0, 128) } : {}),
  };
}

export function createDesktopClient(opts: DesktopClientOptions): DesktopClient {
  const shared = new SharedArrayBuffer(12 + MAX_FRAME_BYTES + 16);
  const header = new Int32Array(shared, 0, 3);
  const payload = new Uint8Array(shared, 12);
  let worker: Worker | undefined;
  let seq = 0;
  let requestId = 0;
  let connected = false;
  /** Async-lane requests waiting for their line (or for the connection to go). */
  const inflight = new Map<string, (message: AsyncReply) => void>();
  const dropInflight = (why: string): void => {
    for (const [id, settle] of [...inflight]) {
      inflight.delete(id);
      settle({ ok: false, text: why });
    }
  };

  function thread(): Worker {
    if (!worker) {
      worker = new Worker(new URL("./desktop-host-worker.mjs", import.meta.url), {
        workerData: { socketPath: opts.socketPath, shared },
      });
      // A thread that died is reported by the next request's timeout; an
      // unhandled `error` event would take the whole extension host down.
      const dead = worker;
      dead.on("error", () => {
        if (worker === dead) worker = undefined;
        connected = false;
        dropInflight("套接字线程崩了");
      });
      dead.on("message", (message: { op?: string; id?: string } & AsyncReply) => {
        if (message?.op !== "async-reply" || typeof message.id !== "string") return;
        const settle = inflight.get(message.id);
        if (!settle) return;
        inflight.delete(message.id);
        settle(message);
      });
      // The socket thread never keeps a finished session alive. AFTER the
      // listeners: a `message` listener re-refs the worker's port.
      dead.unref();
    }
    return worker;
  }

  /** Post one op and block until the worker answers it (or the bound passes). */
  function exchange(op: Record<string, unknown>, timeoutMs: number): { kind: number; text: string } | undefined {
    seq += 1;
    const mine = seq;
    thread().postMessage({ ...op, seq: mine });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const done = Atomics.load(header, 0);
      if (done === mine) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      Atomics.wait(header, 0, done, remaining);
    }
    const length = Atomics.load(header, 1);
    const text = Buffer.from(payload.subarray(0, length)).toString("utf8");
    return { kind: Atomics.load(header, 2), text };
  }

  const bound = (method: Method) => opts.timeoutMs ?? requestTimeoutMs(method) ?? REQUEST_TIMEOUT_MS;

  function send<M extends Method>(method: M, params: Params<M>): DesktopReply<M> & { notSent?: true } {
    requestId += 1;
    const id = `r-${requestId}`;
    const encoded = encodeRequest(id, method, params);
    if (!encoded.ok) return encoded;
    const answer = exchange({ op: "send", id, frame: encoded.frame }, bound(method));
    if (answer === undefined) return { ok: false, error: { code: "timeout", message: `${method} ${bound(method)}ms 内没有响应` } };
    if (answer.kind !== KIND_LINE) {
      connected = false;
      return { ok: false, error: { code: "disconnected", message: answer.text }, ...(answer.kind === KIND_NOT_SENT ? { notSent: true as const } : {}) };
    }
    const decoded = decodeResponse(answer.text, (got) => (got === id ? method : undefined));
    if (!decoded.ok) return { ok: false, error: decoded.error };
    return { ok: true, result: decoded.result as Result<M> };
  }

  function connect(): { ok: true } | { ok: false; error: ProtocolError } {
    if (connected) return { ok: true };
    const answer = exchange({ op: "connect" }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    if (answer === undefined) return { ok: false, error: { code: "timeout", message: "连接桌面客户端超时" } };
    if (answer.kind !== KIND_OK) return { ok: false, error: { code: "disconnected", message: answer.text } };
    const hello = send("hello", opts.hello());
    if (!hello.ok) {
      // A refused handshake leaves no half-open connection behind.
      thread().postMessage({ op: "close" });
      return { ok: false, error: { code: hello.error.code, message: `hello 被拒：${hello.error.message}` } };
    }
    connected = true;
    return { ok: true };
  }

  async function sendAsync(params: Params<"dialog.open">): Promise<DesktopReply<"dialog.open"> & { notSent?: true }> {
    requestId += 1;
    const id = `r-${requestId}`;
    const encoded = encodeRequest(id, "dialog.open", params);
    if (!encoded.ok) return encoded;
    const answer = await new Promise<AsyncReply>((resolve) => {
      inflight.set(id, resolve);
      thread().postMessage({ op: "send-async", id, frame: encoded.frame });
    });
    if (!answer.ok) {
      connected = false;
      return { ok: false, error: { code: "disconnected", message: answer.text }, ...(answer.notSent ? { notSent: true as const } : {}) };
    }
    const decoded = decodeResponse(answer.text, (got) => (got === id ? "dialog.open" : undefined));
    if (!decoded.ok) return { ok: false, error: decoded.error };
    return { ok: true, result: decoded.result as Result<"dialog.open"> };
  }

  return {
    connect,
    request(method, params) {
      if (method === "dialog.open") {
        return { ok: false, error: { code: "bad-request", message: "dialog.open 等人作答，不走同步通道" } };
      }
      const up = connect();
      if (!up.ok) return up;
      const first = send(method, params);
      // A connection that dropped while idle is only noticed here: this side
      // still thought it was up. The frame was never written, so this is the
      // ONE reconnect + hello the protocol allows (§4.5) — never a resend of a
      // request that may already have acted.
      if (first.ok || first.notSent !== true) return first;
      const again = connect();
      return again.ok ? send(method, params) : again;
    },
    async dialog(params) {
      const up = connect();
      if (!up.ok) return up;
      // The same one reconnect the sync lane allows, for the same reason.
      const first = await sendAsync(params);
      if (first.ok || first.notSent !== true) return first;
      const again = connect();
      return again.ok ? sendAsync(params) : again;
    },
    close() {
      connected = false;
      dropInflight("本进程关闭了连接");
      if (worker) {
        void worker.terminate();
        worker = undefined;
      }
    },
  };
}
