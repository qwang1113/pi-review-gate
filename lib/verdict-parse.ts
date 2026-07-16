/**
 * Review verdict parsing — separate review and precommit parsers.
 *
 * Review (record_review): JSON fence verdicts only.
 *   BLOCKED > NEEDS_HUMAN > READY. READY with unresolved P0/P1 findings → BLOCKED.
 * Precommit (bash output): `## Overall:` sentinels only.
 *   FAIL > NO_CHECKS_RUN > PASS. FAIL is terminal.
 */

import type { GateVerdict } from "./gate-state.ts";

export interface ParsedVerdict {
  verdict: Exclude<GateVerdict, "PENDING">;
  findingsTotal: number | null;
  findingFingerprints: string[];
}

interface FenceVerdict {
  verdict: Exclude<GateVerdict, "PENDING">;
  findingsTotal: number | null;
  findingFingerprints: string[];
  hasP0P1: boolean;
}

const SEVERITY: Record<string, number> = { BLOCKED: 3, NEEDS_HUMAN: 2, READY: 1 };

/** P0-4: aggregate findings across equal-severity fences. The first verdict
    is kept but hasP0P1 accumulates, so READY+READY with P1 in either → BLOCKED. */
function worse(a: FenceVerdict | undefined, b: FenceVerdict): FenceVerdict {
  if (!a) return b;
  const bWorse = SEVERITY[b.verdict] > SEVERITY[a.verdict];
  if (bWorse) return b;
  // Equal severity: merge — accumulate findings and hasP0P1.
  return {
    verdict: a.verdict,
    findingsTotal: (a.findingsTotal ?? 0) + (b.findingsTotal ?? 0),
    findingFingerprints: [...a.findingFingerprints, ...b.findingFingerprints],
    hasP0P1: a.hasP0P1 || b.hasP0P1,
  };
}

function normalizeGateWord(raw: string): Exclude<GateVerdict, "PENDING"> | undefined {
  const up = raw.trim().toUpperCase();
  if (up === "BLOCKED" || up === "BLOCK" || up === "FAIL") return "BLOCKED";
  if (up === "READY" || up === "PASS" || up === "MERGEABLE") return "READY";
  if (up === "NEEDS_HUMAN" || up === "NEED_HUMAN" || up === "NEEDS-HUMAN") return "NEEDS_HUMAN";
  return undefined;
}

function parseJsonFence(body: string): FenceVerdict | undefined {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return undefined; }
  if (typeof data !== "object" || data === null) return undefined;
  const obj = data as Record<string, unknown>;
  const gateRaw = obj.gate ?? obj.verdict ?? obj.status;
  if (typeof gateRaw !== "string") return undefined;
  const verdict = normalizeGateWord(gateRaw);
  if (!verdict) return undefined;

  let findingsTotal: number | null = null;
  let hasP0P1 = false;
  const findings = obj.findings;
  if (Array.isArray(findings)) {
    findingsTotal = findings.length;
    hasP0P1 = findings.some((f: unknown) => {
      if (typeof f !== "object" || f === null) return false;
      const s = ((f as Record<string, unknown>).severity as string ?? "").toUpperCase();
      return s === "P0" || s === "P1";
    });
  } else if (typeof obj.findings_total === "number") {
    findingsTotal = obj.findings_total;
  }

  const fingerprints: string[] = [];
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (typeof f === "object" && f !== null) {
        const ff = f as Record<string, unknown>;
        const file = typeof ff.file === "string" ? ff.file : "";
        const issue = typeof ff.issue === "string" ? ff.issue : typeof ff.title === "string" ? ff.title : "";
        const line = typeof ff.line === "number" ? Math.floor(ff.line / 10) : "";
        if (file || issue) fingerprints.push(`${file}#${line}#${issue.slice(0, 80)}`);
      }
    }
  }

  return { verdict, findingsTotal, findingFingerprints: fingerprints, hasP0P1 };
}

/**
 * Parse reviewer output. Only JSON fence verdicts are accepted (not `## Overall:` sentinels).
 * P1 fix: READY with unresolved P0/P1 findings → downgraded to BLOCKED.
 */
export function parseReviewOutput(text: string): ParsedVerdict | undefined {
  let result: FenceVerdict | undefined;

  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const fence = parseJsonFence(m[1]);
    if (fence) result = worse(result, fence);
  }

  if (!result) return undefined;

  // P1 fix: READY with unresolved P0/P1 → BLOCKED. Review claiming READY
  // while open P0/P1 findings exist is a contradictory verdict.
  if (result.verdict === "READY" && result.hasP0P1) {
    result = { ...result, verdict: "BLOCKED" };
  }

  return {
    verdict: result.verdict,
    findingsTotal: result.findingsTotal,
    findingFingerprints: result.findingFingerprints,
  };
}

/**
 * Parse precommit runner output. Only `## Overall:` sentinels.
 * FAIL > NO_CHECKS_RUN > PASS. FAIL is terminal.
 */
export function parsePrecommitOutput(text: string): "PASS" | "FAIL" | "NO_CHECKS_RUN" | null {
  const sentinelRe = /## Overall:\s*(✅\s*PASS|(?:❌|⛔)\s*FAIL|⚠️\s*NO CHECKS RUN)/g;
  let result: "PASS" | "FAIL" | "NO_CHECKS_RUN" | null = null;
  let match: RegExpExecArray | null;
  while ((match = sentinelRe.exec(text)) !== null) {
    const s = match[1];
    if (s.includes("FAIL")) return "FAIL";
    if (s.includes("NO CHECKS") && result !== "FAIL") result = "NO_CHECKS_RUN";
    if (s.includes("PASS") && result === null) result = "PASS";
  }
  return result;
}
