/**
 * READING A PI SESSION'S TRANSCRIPT — the daemon's output source.
 *
 * A session writes one JSON line per event into
 * `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`. The file
 * is append-only, which is what makes it usable from outside: the daemon reads
 * the bytes it has not seen, parses the lines, and pushes what a human would
 * call "output" over SSE (lib/daemon/events.ts).
 *
 * ── WHAT COUNTS AS OUTPUT ──
 *
 * Only the `message` records, and only the parts a reader wants to SEE: the
 * assistant's text and thinking, the tool calls it made, the tool results that
 * came back, and the user's own messages. `system`, `model_change`,
 * `thinking_level_change` and the gate's own `custom` records are not output —
 * the first is the whole prompt (tens of kilobytes per session), and the rest
 * are state, which the session summary reads separately
 * ({@link extractGateState}).
 *
 * ── WHY THE TAILER, AND NOT A WATCHER ──
 *
 * A file watcher would fire on every append and give no ordering guarantee
 * across the two readers here; an offset is simpler and cannot lose a line by
 * missing an event. Truncation (a rotated or rewritten file) is detected by
 * size going backwards, and the offset restarts at zero — the file is the
 * truth, the offset is only a bookmark.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

/** One line of a session's transcript, as the daemon reports it. */
export interface OutputEntry {
  /** ISO, from the record's own timestamp. */
  at: string;
  role: "user" | "assistant" | "system" | "tool";
  kind: "text" | "thinking" | "tool" | "result";
  text: string;
}

/** How much of one entry the daemon will carry. Longer text is truncated, never dropped. */
export const OUTPUT_TEXT_MAX = 4_000;

/** How far back a "recent output" read goes. Bounded so one request cannot read a whole session. */
const TAIL_BYTES = 512 * 1024;

const TRUNCATION = "\n…（截断）";

function clip(text: string, max = OUTPUT_TEXT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max)}${TRUNCATION}`;
}

/** Flatten one content block list into plain text (the only thing SSE can carry). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (typeof value.text === "string") parts.push(value.text);
    else if (typeof value.thinking === "string") parts.push(value.thinking);
  }
  return parts.join("\n");
}

/** `bash({"command":"ls"})` — enough to recognize the call, not a full argument dump. */
function describeToolCall(name: string, args: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(args ?? {});
  } catch {
    rendered = "{}";
  }
  return clip(`${name}(${rendered})`, 600);
}

/** One record's entries, or none when it is not a message / carries nothing. */
function entriesFromMessage(record: Record<string, unknown>, at: string): OutputEntry[] {
  const message = record.message;
  if (!message || typeof message !== "object") return [];
  const value = message as Record<string, unknown>;
  const role = typeof value.role === "string" ? value.role : "";
  const content = value.content;
  if (role === "user") {
    const text = contentText(content);
    return text.trim() === "" ? [] : [{ at, role: "user", kind: "text", text: clip(text) }];
  }
  if (role === "toolResult") {
    const text = contentText(content);
    return text.trim() === "" ? [] : [{ at, role: "tool", kind: "result", text: clip(text) }];
  }
  if (role !== "assistant") return [];
  if (!Array.isArray(content)) {
    const text = contentText(content);
    return text.trim() === "" ? [] : [{ at, role: "assistant", kind: "text", text: clip(text) }];
  }
  const entries: OutputEntry[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const part = block as Record<string, unknown>;
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim() !== "") {
      entries.push({ at, role: "assistant", kind: "thinking", text: clip(part.thinking, 1_500) });
    } else if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
      entries.push({ at, role: "assistant", kind: "text", text: clip(part.text) });
    } else if (part.type === "toolCall") {
      const name = typeof part.name === "string" ? part.name : "tool";
      entries.push({ at, role: "assistant", kind: "tool", text: describeToolCall(name, part.arguments) });
    }
  }
  return entries;
}

/** Parse one JSONL line; an unparsable or non-message line yields nothing. */
export function parseOutputLine(line: string): OutputEntry[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  let record: unknown;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!record || typeof record !== "object") return [];
  const value = record as Record<string, unknown>;
  if (value.type !== "message") return [];
  const at = typeof value.timestamp === "string" ? value.timestamp : "";
  return entriesFromMessage(value, at);
}

/** What a session's own gate last recorded about itself, read from its transcript. */
export function extractGateState(text: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.includes("review-gate-state")) continue;
    try {
      const record = JSON.parse(trimmed) as { type?: unknown; customType?: unknown; data?: { state?: unknown } };
      if (record.type !== "custom" || record.customType !== "review-gate-state") continue;
      const state = record.data?.state;
      if (state && typeof state === "object") found = state as Record<string, unknown>;
    } catch { /* one bad line never hides the ones after it */ }
  }
  return found;
}

/**
 * Read `[from, size)` of an open file as text.
 *
 * Only the requested window is read into memory: a long session's transcript
 * is tens of megabytes, and every reader here wants the end of it.
 */
function readRange(path: string, from: number, size: number): string | undefined {
  if (size <= from) return "";
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(size - from);
    const read = readSync(fd, buffer, 0, buffer.length, from);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The file's size, or undefined when it is not there. */
export function transcriptSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

/** The first `maxBytes` of a file as text: a session's `cwd` lives on line one. */
export function readFileHead(path: string, maxBytes: number): string | undefined {
  const size = transcriptSize(path);
  if (size === undefined) return undefined;
  const raw = readRange(path, 0, Math.min(maxBytes, size));
  if (raw === undefined) return undefined;
  const newline = raw.indexOf("\n");
  return newline < 0 ? raw : raw.slice(0, newline);
}

/** The last `maxBytes` of a file, plus whether anything before it was cut off. */
export function readFileTail(path: string, maxBytes: number = TAIL_BYTES): { text: string; truncated: boolean } | undefined {
  const size = transcriptSize(path);
  if (size === undefined) return undefined;
  const from = Math.max(0, size - maxBytes);
  const raw = readRange(path, from, size);
  if (raw === undefined) return undefined;
  if (from === 0) return { text: raw, truncated: false };
  // Cutting at a byte boundary can split a UTF-8 sequence; the first partial
  // line is dropped rather than repaired, since a JSON line cannot be
  // completed from its tail anyway (the bytes before it were never read).
  const firstNewline = raw.indexOf("\n");
  return { text: firstNewline < 0 ? "" : raw.slice(firstNewline + 1), truncated: true };
}

/** The last `count` output entries, oldest first. */
export function readRecentEntries(path: string, count: number): OutputEntry[] {
  const tail = readFileTail(path);
  if (tail === undefined) return [];
  const entries: OutputEntry[] = [];
  for (const line of tail.text.split("\n")) entries.push(...parseOutputLine(line));
  return count > 0 ? entries.slice(-count) : entries;
}

/**
 * ONE transcript, read from a moving offset.
 *
 * The offset is a bookmark, never the truth: the file passing the bookmark
 * through {@link markSize} is what authorizes a read, so a truncation or a
 * replacement restarts the read instead of silently skipping the new bytes.
 */
export class TranscriptTailer {
  private readonly offsets = new Map<string, number>();

  /** New entries since the previous call for this path (all of them on the first). */
  read(path: string, maxBytes: number = TAIL_BYTES): OutputEntry[] {
    const size = transcriptSize(path);
    if (size === undefined) {
      this.offsets.delete(path);
      return [];
    }
    const known = this.offsets.get(path);
    const from = known ?? size;
    // The FIRST sight of a file sets the bookmark at its end; without storing
    // it, every later poll would re-resolve "end of file" and never read the
    // bytes appended in between (the bug this line exists for).
    if (known === undefined) this.offsets.set(path, size);
    if (size < from || size - from > maxBytes) {
      // Truncated (a rewritten file) or so far behind that catching up would
      // read a whole session: resume from the newest bytes only.
      const entries = readRecentEntries(path, 0);
      this.offsets.set(path, size);
      return entries;
    }
    if (size === from) return [];
    const chunk = readRange(path, from, size);
    if (chunk === undefined) return [];
    this.offsets.set(path, size);
    const entries: OutputEntry[] = [];
    for (const line of chunk.split("\n")) entries.push(...parseOutputLine(line));
    return entries;
  }

  forget(path: string): void {
    this.offsets.delete(path);
  }

  /**
   * Put the bookmark at the file's CURRENT end.
   *
   * A watcher that starts following a file it has never seen has no honest
   * "since" to read from, and starting at the beginning would replay a whole
   * session. Priming is called by whoever is ABOUT to subscribe — before it
   * reads its own replay — so the tail covers exactly what the replay does not:
   * everything appended from that moment on.
   */
  prime(path: string): void {
    const size = transcriptSize(path);
    if (size !== undefined) this.offsets.set(path, size);
  }
}
