/**
 * Test fixtures for the daemon suite (not a test file itself: the runner's glob
 * is `test/**\/*.test.ts`, so a plain module here is never collected).
 *
 * Everything the daemon reads comes from the agent home, so a scratch home plus
 * a fake tmux runner is enough to run the whole thing without a terminal, a
 * provider or a real session — which is what makes the failure branches (an
 * unreadable pane list, a dead pid, a truncated transcript) testable at all.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeRegistryEntry, type SessionRegistryEntry } from "../lib/session-registry.ts";
import type { TmuxRunner, TmuxRunResult } from "../lib/orchestrator-tmux.ts";

/** A throwaway `$HOME` with the agent directory already in place. */
export function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), "rg-daemon-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  return home;
}

export const agentHome = (home: string): string => join(home, ".pi", "agent");

/** The 13 columns `buildListAllPanesArgv` asks tmux for, tab separated. */
export function paneLine(row: {
  session?: string;
  windowId?: string;
  windowIndex?: string;
  windowName?: string;
  paneId?: string;
  sid?: string;
  repo?: string;
  kind?: string;
  state?: string;
  stateAt?: string;
  scopeOwner?: string;
  sessionName?: string;
  sidebar?: boolean;
}): string {
  return [
    row.session ?? "rg-repo-abc123",
    row.windowId ?? "@1",
    row.windowIndex ?? "0",
    row.windowName ?? "pi",
    row.paneId ?? "%1",
    row.sid ?? "",
    row.repo ?? "",
    row.kind ?? "",
    row.state ?? "",
    row.stateAt ?? "",
    row.scopeOwner ?? "",
    row.sessionName ?? "",
    row.sidebar === true ? "1" : "",
  ].join("\t");
}

/** A tmux runner that answers exactly one argv shape and records what it saw. */
export function fakeRunner(handler: (argv: readonly string[]) => TmuxRunResult): TmuxRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((argv: readonly string[]) => {
    calls.push([...argv]);
    return handler(argv);
  }) as TmuxRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

/** A runner whose pane list is the rows given (and which fails everything else). */
export function paneRunner(rows: readonly string[]): TmuxRunner & { calls: string[][] } {
  return fakeRunner((argv) => {
    if (argv[0] === "list-panes") return { ok: true, stdout: `${rows.join("\n")}\n`, stderr: "" };
    return { ok: false, stdout: "", stderr: `unexpected tmux argv: ${argv.join(" ")}` };
  });
}

/** A tmux runner that cannot be read at all. */
export function brokenRunner(): TmuxRunner {
  return fakeRunner(() => ({ ok: false, stdout: "", stderr: "no server" }));
}

/** Write one named registration into a scratch home. */
export function writeRegistry(home: string, entry: SessionRegistryEntry): void {
  const dir = join(agentHome(home), "rg-sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${entry.name}.json`), serializeRegistryEntry(entry));
}

export function registryEntry(overrides: Partial<SessionRegistryEntry> & { name: string; sessionId: string }): SessionRegistryEntry {
  return {
    schema: 1,
    pid: process.pid,
    repo: "/repo",
    cwd: "/repo",
    mode: "loop",
    state: "working",
    registeredAt: new Date(Date.now() - 60_000).toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Write a session transcript under `<home>/.pi/agent/sessions/<encoded>/`. */
export function writeTranscript(
  home: string,
  options: { sessionId: string; cwd: string; dirName?: string; records: unknown[] },
): string {
  const dirName = options.dirName ?? "--repo--";
  const dir = join(agentHome(home), "sessions", dirName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-01-01T00-00-00-000Z_${options.sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", id: options.sessionId, timestamp: new Date().toISOString(), cwd: options.cwd }),
    ...options.records.map((record) => JSON.stringify(record)),
  ];
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** One assistant message record, in pi's transcript shape. */
export function assistantRecord(text: string, at: string = new Date().toISOString()): unknown {
  return { type: "message", timestamp: at, message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** One gate-state record, as a session writes about itself. */
export function gateStateRecord(state: Record<string, unknown>, at: string = new Date().toISOString()): unknown {
  return { type: "custom", customType: "review-gate-state", timestamp: at, data: { state } };
}

/** A real listening port nobody else is on: bind 0, read the port, close it. */
export async function freePort(): Promise<number> {
  const { createServer } = await import("node:http");
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.once("error", rejectPromise);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePromise(port));
    });
  });
}
