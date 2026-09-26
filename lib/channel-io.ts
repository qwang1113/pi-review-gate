/**
 * THE CHANNEL ON DISK — the filesystem seam, the paths, and the spill rule.
 *
 * The record schema is lib/channel-records.ts; reading a channel back is
 * lib/channel-projection.ts. This module is every WRITE the channel makes and
 * the one IO interface both halves share.
 *
 * WHY EVERY LINE IS SMALL (the spill rule). Two processes append to one
 * channel file concurrently. A POSIX `O_APPEND` write is atomic only below
 * `PIPE_BUF` (4 KiB), and the payloads that matter here — a loop-goal draft, a
 * task document — are exactly the ones that blow past it. So anything bulky is
 * SPILLED to a sibling file and the record carries a reference
 * ({@link ChannelPayloadRef}); the JSONL line itself stays far under the
 * limit and can never be torn. Readers resolve refs through the same IO seam,
 * so a test never touches a real disk.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import type {
  ChannelInstructRecord,
  ChannelPayloadRef,
  ChannelRecord,
  ChannelReportRecord,
  ChannelRequestRecord,
} from "./channel-records.ts";


/** Directory (under the pi agent home) that holds every orchestration's channels. */
export const CHANNEL_ROOT_DIRNAME = "rg-channels";

/**
 * A serialized record whose UTF-8 length exceeds this spills its bulky field
 * to a side file.
 *
 * Deliberately well under `PIPE_BUF` (4096): the budget has to cover the
 * record's own envelope plus JSON escaping, and being wrong here means a torn
 * line, which is the one failure this whole scheme exists to prevent.
 *
 * MEASURED IN BYTES, and that is not a detail: `PIPE_BUF` is a byte limit,
 * while `String.length` counts UTF-16 units. Everything a judge writes here is
 * Simplified Chinese by directive (L4), and a CJK code point is 3 bytes — so a
 * 1500-CHARACTER record can be 4400 bytes and tear, which is exactly the case
 * this constant exists to prevent. (Found while adding the structured findings
 * array, 2026-09-04; the prose `summary` path had the same latent hole.)
 */
export const MAX_INLINE_RECORD_BYTES = 1500;

/**
 * Every filesystem touch the channel makes, as one injectable seam.
 *
 * A handful of methods, all trivially fakeable — which is what lets the
 * protocol tests drive the REAL implementation with an in-memory map instead
 * of asserting against a mock of it.
 */
export interface ChannelIO {
  ensureDir(dir: string): void;
  /** Append one line. MUST be a single append write (atomicity is the contract). */
  appendLine(path: string, line: string): void;
  /** Whole file, or `undefined` when it does not exist. */
  readText(path: string): string | undefined;
  /**
   * The bytes from `offset` to the end, decoded as UTF-8, plus the file's
   * current size in bytes — `undefined` when the file does not exist.
   *
   * OPTIONAL: it is the cheap path for a cursor read (a poller re-reading a
   * growing file must not pay for its whole history every tick). An IO that
   * leaves it out is read through {@link readText} instead, with the same
   * result.
   */
  readFrom?(path: string, offset: number): { text: string; size: number } | undefined;
  /** Replace a file's contents (spilled payloads only, never the JSONL). */
  writeText(path: string, text: string): void;
  now(): number;
}

/** The real filesystem. */
export function nodeChannelIO(): ChannelIO {
  return {
    ensureDir(dir) {
      mkdirSync(dir, { recursive: true });
    },
    appendLine(path, line) {
      appendFileSync(path, line, "utf8");
    },
    readText(path) {
      return existsSync(path) ? readFileSync(path, "utf8") : undefined;
    },
    readFrom(path, offset) {
      if (!existsSync(path)) return undefined;
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        if (size <= offset) return { text: "", size };
        const buf = Buffer.alloc(size - offset);
        const read = readSync(fd, buf, 0, buf.length, offset);
        return { text: buf.subarray(0, read).toString("utf8"), size };
      } finally {
        closeSync(fd);
      }
    },
    writeText(path, text) {
      writeFileAtomic(path, text);
    },
    now: () => Date.now(),
  };
}

/**
 * Root of every channel. Global (pi's agent home) rather than repo-local
 * because a child may run in a worktree, or in another repository entirely,
 * and the orchestrator still has to reach it.
 */
export function channelRoot(home: string = homedir()): string {
  return join(home, ".pi", "agent", CHANNEL_ROOT_DIRNAME);
}

/**
 * Only the characters that are safe in a path segment survive.
 *
 * A DOT is excluded along with everything else non-alphanumeric, and that is
 * the whole security property: with dots allowed, `..` survives sanitizing
 * and a crafted id stops being a NAME and becomes a PATH. Both real inputs
 * (an orchestration id, a registry child id) are alphanumeric-with-dashes
 * already, so nothing legitimate is lost.
 */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "unnamed";
}


/** Directory holding one orchestration's channels. */
export function channelDir(orchestrationId: string, home?: string): string {
  return join(channelRoot(home), safeSegment(orchestrationId));
}

/** The one file this child and this orchestration talk through. */
export function channelPathFor(orchestrationId: string, childId: string, home?: string): string {
  return join(channelDir(orchestrationId, home), `${safeSegment(childId)}.jsonl`);
}

/** Side file for a spilled payload; named after the record it belongs to. */
export function payloadPathFor(
  orchestrationId: string,
  childId: string,
  recordId: string,
  home?: string,
): string {
  return join(channelDir(orchestrationId, home), `${safeSegment(childId)}.${safeSegment(recordId)}.payload`);
}

/** A collision-resistant id for a request or an instruction. */
export function newChannelId(prefix: string, now: number, entropy = Math.random()): string {
  return `${prefix}-${Math.floor(now).toString(36)}-${entropy.toString(36).slice(2, 8)}`;
}

/** Where a record is written, and which id names its spill file. */
export interface ChannelTarget {
  orchestrationId: string;
  childId: string;
  home?: string;
}

/**
 * A judge channel target: `<opener-id>/<judge-id>.jsonl` under the same root.
 *
 * Deliberately the SAME file shape as an orchestration channel (not a
 * second channel module): the opener may be a session id rather than an
 * orchestration id, but the record/spill/cursor primitives do not care —
 * planes differ by key naming only.
 */
export function judgeChannelTarget(openerId: string, judgeId: string, home?: string): ChannelTarget {
  return { orchestrationId: openerId, childId: judgeId, ...(home === undefined ? {} : { home }) };
}

/**
 * Append one record, spilling an oversized payload first.
 *
 * Returns the record as it was actually written (with `payloadRef` in place
 * of `payload` when it spilled) so a caller can report the truth rather than
 * what it intended.
 */
export function appendRecord(io: ChannelIO, target: ChannelTarget, record: ChannelRecord): ChannelRecord {
  const dir = channelDir(target.orchestrationId, target.home);
  io.ensureDir(dir);
  const stored = spillIfLarge(io, target, record);
  io.appendLine(channelPathFor(target.orchestrationId, target.childId, target.home), `${JSON.stringify(stored)}\n`);
  return stored;
}

/** The UTF-8 size of a record once serialized — what `PIPE_BUF` actually bounds. */
function recordBytes(record: ChannelRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

/** Move `payload` / `text` / `findings` into a side file when the line would be too long. */
function spillIfLarge(io: ChannelIO, target: ChannelTarget, record: ChannelRecord): ChannelRecord {
  if (recordBytes(record) <= MAX_INLINE_RECORD_BYTES) return record;
  if (record.kind === "request" && record.payload !== undefined) {
    const path = payloadPathFor(target.orchestrationId, target.childId, record.requestId, target.home);
    io.writeText(path, record.payload);
    const { payload, ...rest } = record;
    return { ...rest, payloadRef: { path, chars: payload.length } };
  }
  if (record.kind === "instruct" && record.text !== undefined) {
    const path = payloadPathFor(target.orchestrationId, target.childId, record.instructId, target.home);
    io.writeText(path, record.text);
    const { text, ...rest } = record;
    return { ...rest, textRef: { path, chars: text.length } };
  }
  if (record.kind === "report") {
    // A report carries TWO bulky things and either alone can blow the budget:
    // an adviser's prose (`summary`) and — since the conclusion travels
    // structured — the `findings` array. Spill both, biggest first, and stop
    // as soon as the line fits: a round with one huge finding must not also
    // lose its prose to a side file, and a round with twenty ordinary
    // findings must not stay inline just because it has no prose.
    let out: ChannelRecord = record;
    const path = payloadPathFor(target.orchestrationId, target.childId, record.reportId, target.home);
    const findingsSize = record.findings === undefined ? 0 : Buffer.byteLength(JSON.stringify(record.findings), "utf8");
    const summarySize = record.summary === undefined ? 0 : Buffer.byteLength(record.summary, "utf8");
    const spillFindings = () => {
      const r = out as ChannelReportRecord;
      // An empty array is not what blew the budget — moving it out would cost
      // a side file and save two characters.
      if (r.findings === undefined || r.findings.length === 0) return;
      const text = JSON.stringify(r.findings);
      io.writeText(`${path}.findings`, text);
      const { findings, ...rest } = r;
      out = { ...rest, findingsRef: { path: `${path}.findings`, chars: text.length } };
    };
    const spillSummary = () => {
      const r = out as ChannelReportRecord;
      if (r.summary === undefined) return;
      io.writeText(path, r.summary);
      const { summary, ...rest } = r;
      out = { ...rest, summaryRef: { path, chars: summary.length } };
    };
    const [first, second] = findingsSize >= summarySize
      ? [spillFindings, spillSummary]
      : [spillSummary, spillFindings];
    first();
    if (recordBytes(out) > MAX_INLINE_RECORD_BYTES) second();
    return out;
  }
  // Nothing bulky to move (a huge dialog title, say). Truncation would lose
  // the very content the orchestrator needs, and an over-long line only risks
  // interleaving — never silent data loss — so it is written as it is.
  return record;
}


/**
 * Resolve a spilled payload back into text. `undefined` when unreadable.
 *
 * Takes the READ half of the IO seam rather than all of it: resolving a spill
 * is a read, and the inbox (lib/session-message-tools.ts) shares this helper
 * without being a {@link ChannelIO} — it has no reason to grow a `now` it never
 * calls just to be allowed to read a file.
 */
export function resolvePayload(
  io: Pick<ChannelIO, "readText">,
  ref: ChannelPayloadRef | undefined,
): string | undefined {
  if (!ref) return undefined;
  return io.readText(ref.path);
}

/** The full request text, whether it was inlined or spilled. */
export function requestPayload(io: ChannelIO, record: ChannelRequestRecord): string | undefined {
  return record.payload ?? resolvePayload(io, record.payloadRef);
}

/** The full instruction text, whether it was inlined or spilled. */
export function instructText(io: ChannelIO, record: ChannelInstructRecord): string | undefined {
  return record.text ?? resolvePayload(io, record.textRef);
}

/** The full report summary, whether it was inlined or spilled. */
export function reportText(io: ChannelIO, record: ChannelReportRecord): string | undefined {
  return record.summary ?? resolvePayload(io, record.summaryRef);
}
