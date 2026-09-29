/**
 * THE GATE LIVES AND DIES WITH A PI PROCESS (2026-09-29, user decision).
 *
 * A judge / worker / orchestration-child pane is a pi process of its own that
 * used to know its opener only by SESSION id — never by process — and asked
 * nothing but the gate's own heartbeats and tables whether it was still
 * wanted. Measured: three sandbox openers were `kill -9`-ed, and the judges
 * they had opened went on writing an `idle` heartbeat every minute, forever,
 * because nothing they read could tell them their opener was gone. A gate that
 * infers its own liveness from records it writes itself can always keep
 * itself alive.
 *
 * So liveness is read off the OS process table, never off a file's age: the
 * opener's identity (pid + the start time `ps` reports, so a recycled pid is
 * not mistaken for it) rides in the pane's environment, and the child's own
 * 10s heartbeat asks `ps` about it. Gone ⇒ the child shuts itself down.
 *
 * A HANDOVER is the one legitimate way an opener process ends while its
 * children are still wanted: the successor adopts them. It writes its own
 * identity under the keys the children were opened with (the predecessor's
 * session id; the orchestration id for a project manager), and a child whose
 * opener vanished re-binds to that identity ONLY IF the process it names is
 * alive in the process table right now. The file names a candidate; the
 * process table decides.
 *
 * ponytail: pid + start time via `ps`, polled every 10s — an OS-held lock
 * (flock, an inherited pipe fd) would notice instantly and needs no poll, add
 * one if a 10s window ever matters.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

export const OPENER_PID_ENV = "RG_OPENER_PID";
export const OPENER_STARTED_ENV = "RG_OPENER_STARTED";
/** The key a successor re-binds under: the opener's session id, or the orchestration id. */
export const OPENER_KEY_ENV = "RG_OPENER_KEY";

export interface ProcessIdentity {
  pid: number;
  /** `ps -o lstart=` for that pid — what makes a recycled pid a different process. */
  started: string;
}

/**
 * The start time of `pid` as the process table reports it: a string when the
 * process exists, `null` when the table says it does not, `undefined` when the
 * table could not be read at all (a failed LOOK never kills anything).
 */
export type ProcessProbe = (pid: number) => string | null | undefined;

export const probeProcessStart: ProcessProbe = (pid) => {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000,
    }).trim();
    return out.length > 0 ? out : null;
  } catch (err) {
    // `ps -p <missing pid>` exits 1 with nothing on stdout: a positive "gone".
    return (err as { status?: number }).status === 1 ? null : undefined;
  }
};

let ownIdentity: ProcessIdentity | null | undefined;
/** This process's identity, measured once; `undefined` when `ps` cannot say. */
export function ownProcessIdentity(probe: ProcessProbe = probeProcessStart): ProcessIdentity | undefined {
  if (ownIdentity === undefined) {
    const started = probe(process.pid);
    ownIdentity = started ? { pid: process.pid, started } : null;
  }
  return ownIdentity ?? undefined;
}

/** The env a pane is opened with so it can watch THIS process. Empty when the identity is unknown. */
export function openerEnv(key: string, identity: ProcessIdentity | undefined = ownProcessIdentity()): Record<string, string> {
  if (!identity) return {};
  return {
    [OPENER_PID_ENV]: String(identity.pid),
    [OPENER_STARTED_ENV]: identity.started,
    [OPENER_KEY_ENV]: key,
  };
}

/** The opener binding a pane was opened with, when it has one. */
export function readOpenerEnv(env: NodeJS.ProcessEnv): { identity: ProcessIdentity; key: string } | undefined {
  const pid = Number(env[OPENER_PID_ENV]);
  const started = env[OPENER_STARTED_ENV]?.trim();
  const key = env[OPENER_KEY_ENV]?.trim();
  if (!Number.isInteger(pid) || pid <= 0 || !started || !key) return undefined;
  return { identity: { pid, started }, key };
}

/** Carry this process's own opener binding into a pane that replaces it (a relay keeps the same opener). */
export function forwardOpenerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const bound = readOpenerEnv(env);
  return bound ? openerEnv(bound.key, bound.identity) : {};
}

export function openerRebindPath(key: string, home: string = homedir()): string {
  return join(home, ".pi", "agent", "rg-openers", `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** Read the candidate a successor left under `key`; anything unreadable is no candidate. */
export function readOpenerRebind(key: string, home?: string): ProcessIdentity | undefined {
  try {
    const raw = JSON.parse(readFileSync(openerRebindPath(key, home), "utf8")) as Partial<ProcessIdentity>;
    return Number.isInteger(raw.pid) && typeof raw.started === "string" && raw.started
      ? { pid: raw.pid!, started: raw.started }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A handover successor adopts its predecessor's children: write this
 * process's identity under the keys they were opened with. Only a project
 * manager's successor claims the orchestration id — a CHILD's successor
 * carries the same orchestration id and must never become its siblings' opener.
 *
 * One hop by design: a successor adopts its PREDECESSOR's panes, exactly the
 * set the judge registry lets it own (`callerIdentities` = own id +
 * predecessor). A pane opened two handovers ago is nobody's any more, so it
 * dies with the process that last adopted it.
 */
export function recordSuccessorOpener(
  inheritance: { kind?: string; predecessorSession?: string },
  orchestrationId: string | undefined,
  opts: { identity?: ProcessIdentity; home?: string } = {},
): string[] {
  const identity = opts.identity ?? ownProcessIdentity();
  if (!identity || !inheritance.predecessorSession) return [];
  const keys = [inheritance.predecessorSession];
  if (inheritance.kind === "orchestrator" && orchestrationId) keys.push(orchestrationId);
  for (const key of keys) {
    try { writeFileAtomic(openerRebindPath(key, opts.home), JSON.stringify(identity)); } catch { /* best effort */ }
  }
  return keys;
}

export type OpenerStatus = "alive" | "gone" | "unknown";

/**
 * Is the opener still there — and if the original is gone, has a live
 * successor taken it over? Liveness comes from `probe` alone; the rebind
 * candidate is read only after the original is positively gone.
 */
export function resolveOpener(
  current: ProcessIdentity,
  readRebind: () => ProcessIdentity | undefined,
  probe: ProcessProbe,
): { status: OpenerStatus; identity?: ProcessIdentity } {
  const started = probe(current.pid);
  if (started === undefined) return { status: "unknown", identity: current };
  if (started === current.started) return { status: "alive", identity: current };
  const candidate = readRebind();
  if (!candidate || (candidate.pid === current.pid && candidate.started === current.started)) {
    return { status: "gone" };
  }
  const candidateStarted = probe(candidate.pid);
  if (candidateStarted === undefined) return { status: "unknown", identity: current };
  return candidateStarted === candidate.started ? { status: "alive", identity: candidate } : { status: "gone" };
}

/**
 * The child-side watch, one per process: `check()` on every heartbeat tick.
 * `unbound` when the pane was not opened with an opener identity — nothing to
 * watch, so nothing is ever decided.
 */
export function createOpenerWatch(
  env: NodeJS.ProcessEnv = process.env,
  deps: { probe?: ProcessProbe; readRebind?: (key: string) => ProcessIdentity | undefined } = {},
): { check(): OpenerStatus | "unbound" } {
  const bound = readOpenerEnv(env);
  let current = bound?.identity;
  const probe = deps.probe ?? probeProcessStart;
  const readRebind = deps.readRebind ?? ((key: string) => readOpenerRebind(key));
  return {
    check() {
      if (!bound || !current) return "unbound";
      const verdict = resolveOpener(current, () => readRebind(bound.key), probe);
      if (verdict.identity) current = verdict.identity;
      return verdict.status;
    },
  };
}

/**
 * One heartbeat's enforcement: opener gone ⇒ stop every clock this side owns
 * and shut pi down. True when it did.
 */
export function enforceOpenerBinding(
  watch: { check(): OpenerStatus | "unbound" },
  act: { stop(): void; shutdown(): void },
): boolean {
  if (watch.check() !== "gone") return false;
  act.stop();
  try { act.shutdown(); } catch { /* the session is already going */ }
  return true;
}
