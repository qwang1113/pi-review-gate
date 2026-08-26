/**
 * Live tail of the precommit runner's log file.
 *
 * WHY A TAIL AND NOT A PIPE. The runner is spawned DETACHED with its stdout
 * and stderr pointed at a file descriptor, deliberately: a pipe has a ~64KB
 * kernel buffer, and anything that stops draining it (a busy host, an aborted
 * tool call) blocks the runner's next write forever — the run hangs with no
 * verdict. That property must not be traded away for live output, so the file
 * stays the ONLY write channel and liveness is obtained by READING it:
 * polling has no backpressure by construction, and a reader that falls behind
 * (or dies) cannot stall the writer.
 *
 * The unit is deliberately free of process/extension plumbing so the
 * abort/timeout behaviour is testable on its own: inject `readSlice`/`sizeOf`
 * and drive `stop()` directly.
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Injectable IO so tests can drive the tail without a real runner. */
export interface TailIo {
  /** Byte size of the log right now, or null when it does not exist yet. */
  sizeOf(path: string): number | null;
  /**
   * Read `[from, to)` as RAW BYTES.
   *
   * Bytes, not a string: a poll boundary lands wherever the writer happens to
   * be, and decoding each slice on its own turns a multibyte character split
   * across two polls into replacement characters — permanently, because the
   * cursor has already moved past them. The tail decodes instead, through a
   * `StringDecoder` that holds an incomplete trailing sequence until the rest
   * of it arrives.
   */
  readSlice(path: string, from: number, to: number): Buffer;
}

export const NODE_TAIL_IO: TailIo = {
  sizeOf(path) {
    try { return statSync(path).size; } catch { return null; }
  },
  readSlice(path, from, to) {
    const length = Math.max(0, to - from);
    if (length === 0) return Buffer.alloc(0);
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.allocUnsafe(length);
      const read = readSync(fd, buf, 0, length, from);
      return buf.subarray(0, read);
    } catch {
      return Buffer.alloc(0);
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    }
  },
};

export interface TailHandle {
  /**
   * Stop polling and flush whatever the writer appended since the last tick.
   *
   * Called on EVERY exit path (clean finish, abort, timeout) — the final read
   * is what makes "the log is complete" true for an aborted run, where the
   * killed runner's last writes land between two ticks.
   */
  stop(): void;
  /** Bytes forwarded so far (diagnostics/tests). */
  forwarded(): number;
}

/**
 * Poll `path` and forward every newly appended chunk to `onChunk`.
 *
 * Multibyte-safe: slices are read as bytes and decoded through a
 * `StringDecoder`, so a character split across two polls is completed on the
 * next one instead of being emitted as replacement characters.
 *
 * Shrink handling is BEST EFFORT, and that is enough here: a file that gets
 * shorter resets the cursor and the decoder. It cannot detect a replacement
 * file that is already LONGER than the old cursor (no identity tracking), so
 * the production invariant is what keeps this honest — every run tails a
 * freshly created temp path of its own and never reuses one.
 */
export function tailLogFile(
  path: string,
  onChunk: (text: string) => void,
  opts: { intervalMs?: number; io?: TailIo } = {},
): TailHandle {
  const io = opts.io ?? NODE_TAIL_IO;
  const intervalMs = opts.intervalMs ?? 400;
  let cursor = 0;
  let stopped = false;
  let decoder = new StringDecoder("utf8");

  const emit = (text: string): void => {
    if (text === "") return;
    try { onChunk(text); } catch { /* a failing consumer must never stall the run */ }
  };

  const pump = (): void => {
    const size = io.sizeOf(path);
    if (size === null) return;
    if (size < cursor) { // truncated/rotated: restart, dropping any partial char
      cursor = 0;
      decoder = new StringDecoder("utf8");
    }
    if (size === cursor) return;
    const bytes = io.readSlice(path, cursor, size);
    if (bytes.length === 0) return;
    // Advance by BYTES actually read — never by the decoded length, which
    // differs whenever a multibyte sequence is still buffered.
    cursor += bytes.length;
    emit(decoder.write(bytes));
  };

  const timer = setInterval(pump, intervalMs);
  // Never keep the host process alive for a tail.
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      pump(); // final flush — the abort/timeout path depends on this
      // A runner killed mid-character leaves an incomplete sequence; end()
      // surfaces it rather than silently swallowing the last bytes.
      emit(decoder.end());
    },
    forwarded() { return cursor; },
  };
}
