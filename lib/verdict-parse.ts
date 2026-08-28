/**
 * Review verdict parsing — separate review and precommit parsers.
 *
 * Review (record_review): JSON fence verdicts only.
 *   BLOCKED > NEEDS_HUMAN > READY. READY with unresolved P0/P1 findings → BLOCKED.
 * Precommit (bash output): `## Overall:` sentinels only.
 *   FAIL > NO_CHECKS_RUN > PASS. FAIL is terminal.
 */

import type { DocSyncAttestation, GateVerdict } from "./gate-state.ts";
import { DOC_SYNC_ATTESTATIONS } from "./gate-state.ts";

export interface ParsedVerdict {
  verdict: Exclude<GateVerdict, "PENDING">;
  findingsTotal: number | null;
  findingFingerprints: string[];
  /**
   * Reviewer's code↔doc attestation (docSync knob). Only the enum whitelist
   * is accepted; any unknown value is treated as absent (fail-closed — absent
   * blocks when enforcement is on, it never passes).
   */
  docSync?: DocSyncAttestation;
  /**
   * The directory the reviewer says it ran in (its own `pwd`), verbatim.
   *
   * Carried through so the GATE can check it against the repo the round was
   * prepared for. The schema and the task text both state that check, and
   * until round-9 nothing performed it: a fence claiming any cwd at all parsed
   * to the same READY (reviewer-reproduced with `/evil/elsewhere`). A stated
   * check that does not run is worse than none, because it is believed.
   *
   * This parser does not judge the value — it is self-reported, and weighing
   * it is the gate's job.
   */
  cwd?: string;
}

interface FenceVerdict {
  verdict: Exclude<GateVerdict, "PENDING">;
  findingsTotal: number | null;
  findingFingerprints: string[];
  hasP0P1: boolean;
  docSync?: DocSyncAttestation;
  cwd: string | undefined;
  /**
   * Sticky: two fences reported DIFFERENT directories somewhere in this fold.
   *
   * Needed because `undefined` alone is ambiguous — it means both "nobody
   * reported one" and "the reports contradicted". `worse()` folds pairwise, so
   * without this flag a later agreeing fence resurrects a cwd that an earlier
   * contradiction had already destroyed (measured: /evil, /repo, /repo folded
   * back to /repo). A contradiction never un-happens.
   */
  cwdConflict: boolean;
}

const SEVERITY: Record<string, number> = { BLOCKED: 3, NEEDS_HUMAN: 2, READY: 1 };

/** P0-4: fold one fence into the running worst verdict. A STRICTLY worse fence
    replaces the fold; every NON-WORSE one (equal severity OR lighter) is merged
    into it, keeping the worse verdict and accumulating the evidence — so
    READY+READY with a P1 in either becomes BLOCKED, and a NEEDS_HUMAN followed
    by a READY stays NEEDS_HUMAN with both fences' findings.
    The lighter branch is not a curiosity: the sticky cwd conflict has to
    survive it (round-13 P1 — the doc said "equal-severity" and hid it). */
function worse(a: FenceVerdict | undefined, b: FenceVerdict): FenceVerdict {
  if (!a) return b;
  const bWorse = SEVERITY[b.verdict] > SEVERITY[a.verdict];
  // Taking b wholesale drops a's cwdConflict — deliberately safe: the fold is
  // MONOTONIC (a verdict only ever gets worse), so once this branch is taken
  // the result can never return to READY, and the cwd check runs on READY
  // only. A forgotten conflict therefore cannot influence any decision.
  if (bWorse) return b;
  const cwdConflict = a.cwdConflict || b.cwdConflict ||
    (a.cwd !== undefined && b.cwd !== undefined && a.cwd !== b.cwd);
  // b is NOT worse (equal, or lighter — this branch covers both, despite what
  // the historical "equal severity" wording suggested): keep a's verdict and
  // fold b's evidence in. docSync and cwd
  // merge conservatively: agreeing fences keep the value, disagreeing fences
  // drop it (absent blocks under enforcement — fail-closed on contradiction).
  //
  // cwd MUST be merged, not dropped: the reviewer protocol explicitly allows
  // repeating the identical verdict first and last (agents/reviewer.md), and
  // rebuilding without the field turned that honest habit into a CWD CHECK
  // FAILED — a gate that punishes the format it recommends.
  return {
    verdict: a.verdict,
    findingsTotal: (a.findingsTotal ?? 0) + (b.findingsTotal ?? 0),
    findingFingerprints: [...a.findingFingerprints, ...b.findingFingerprints],
    hasP0P1: a.hasP0P1 || b.hasP0P1,
    docSync: a.docSync === b.docSync ? a.docSync : undefined,
    // Only a CONTRADICTION destroys the report. A fence that simply omits cwd
    // (a terse opening fence before the full one, say) contradicts nothing, so
    // it must not erase the value the other fence did report — that would be
    // the same false rejection this merge exists to prevent.
    //
    // The conflict is STICKY (see cwdConflict): folding is pairwise, so a
    // contradiction that is only remembered as `undefined` gets overwritten by
    // the next agreeing fence.
    cwd: cwdConflict ? undefined : a.cwd ?? b.cwd,
    cwdConflict,
  };
}

function normalizeGateWord(raw: string): Exclude<GateVerdict, "PENDING"> | undefined {
  const up = raw.trim().toUpperCase();
  if (up === "BLOCKED" || up === "BLOCK" || up === "FAIL") return "BLOCKED";
  if (up === "READY" || up === "PASS" || up === "MERGEABLE") return "READY";
  if (up === "NEEDS_HUMAN" || up === "NEED_HUMAN" || up === "NEEDS-HUMAN") return "NEEDS_HUMAN";
  return undefined;
}

/**
 * Fail-closed recovery for a fence whose JSON did not parse. Real reviewer
 * outputs frequently embed unescaped full-width quotes inside the `issue`
 * string (e.g. `"issue":"验证“无 X”…"`), which breaks `JSON.parse` and
 * previously discarded the whole verdict (no verdict ⇒ PENDING, stalling the
 * gate). We salvage ONLY the machine-critical gate word via a tight regex.
 *
 * Safety (never fail-open): a salvaged verdict can NEVER be READY. READY is
 * the one verdict that unlocks the ship gate, and a fence we could not fully
 * parse might carry open P0/P1 findings we cannot see; downgrading any
 * salvaged READY to BLOCKED keeps recovery strictly tightening. BLOCKED and
 * NEEDS_HUMAN are already the blocking verdicts, so recovering them changes
 * nothing about safety — it only avoids a spurious PENDING stall. Findings are
 * reported as unparseable (null total, no fingerprints) so plateau detection
 * relies on the hard cap rather than trusting salvaged counts.
 */
function recoverFenceVerdict(body: string): FenceVerdict | undefined {
  const m = /["']?(?:gate|verdict|status)["']?\s*:\s*["']([A-Za-z_-]+)["']/.exec(body);
  if (!m) return undefined;
  const verdict = normalizeGateWord(m[1]);
  if (!verdict) return undefined;
  // Salvaged READY is untrustworthy (possible hidden P0/P1) → downgrade.
  const safeVerdict = verdict === "READY" ? "BLOCKED" : verdict;
  // No cwd is recovered ON PURPOSE: this body is malformed, untrusted text.
  // A loose regex "recovering" a directory from it would manufacture the very
  // evidence the check is meant to weigh, out of the input we trust least. It
  // costs an honest reviewer nothing — a salvaged READY is already downgraded
  // above, and the cwd check only runs on READY.
  return {
    verdict: safeVerdict, findingsTotal: null, findingFingerprints: [],
    hasP0P1: false, cwd: undefined, cwdConflict: false,
  };
}

/**
 * Escape ONLY the raw control characters (< 0x20) that sit INSIDE a JSON
 * string value, so a fence whose strings contain unescaped newlines/tabs
 * (a common LLM output defect — e.g. a multi-line `notes` field) can be
 * re-parsed as valid JSON. Everything else is left byte-for-byte alone:
 * structure tokens, whitespace between tokens, and already-escaped
 * sequences (`\"`, `\\`, `\n`, …) are copied verbatim.
 *
 * Safety: this never invents structure. If the body is damaged beyond raw
 * control characters inside strings, the re-parse fails and the caller
 * falls through to recoverFenceVerdict (fail-closed).
 */
function escapeControlCharsInStrings(body: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") {
        // Escape prefix: copy it and the escaped char verbatim.
        out += ch;
        if (i + 1 < body.length) { out += body[i + 1]; i++; }
        continue;
      }
      if (ch === '"') { inString = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" :
          `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    out += ch;
  }
  return out;
}


function parseJsonFence(body: string): FenceVerdict | undefined {
  let data: unknown;
  try { data = JSON.parse(body); }
  catch {
    // LLM fences routinely embed raw newlines inside string values (a
    // multi-line `notes`/`text` field). JSON forbids them, which used to
    // drop the whole verdict into recoverFenceVerdict — losing every finding
    // and downgrading a legitimate READY to BLOCKED. Escape only the
    // string-internal control characters and re-parse; a body damaged
    // beyond that still falls through to recovery (fail-closed).
    try { data = JSON.parse(escapeControlCharsInStrings(body)); }
    catch { return recoverFenceVerdict(body); }
  }
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

  // docSync attestation — enum whitelist only, unknown values → absent.
  let docSync: DocSyncAttestation | undefined;
  const docSyncRaw = obj.docSync ?? obj.doc_sync;
  if (typeof docSyncRaw === "string" && DOC_SYNC_ATTESTATIONS.has(docSyncRaw.trim().toUpperCase())) {
    docSync = docSyncRaw.trim().toUpperCase() as DocSyncAttestation;
  }

  // `cwd` travels verbatim — the gate compares it, this parser does not judge it.
  const cwdRaw = obj.cwd;
  const cwd = typeof cwdRaw === "string" && cwdRaw.trim() !== "" ? cwdRaw.trim() : undefined;

  // cwdConflict starts false: a single fence cannot contradict itself.
  return {
    verdict, findingsTotal, findingFingerprints: fingerprints, hasP0P1, docSync,
    cwd, cwdConflict: false,
  };
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
    docSync: result.docSync,
    cwd: result.cwd,
  };
}

/**
 * One finding as the auditor/reviewer wrote it (severity + issue prose).
 */
export interface FenceFinding {
  severity: string;
  issue: string;
}

/**
 * Extract the raw findings from every parseable JSON fence in the text.
 *
 * `parseReviewOutput` deliberately keeps only fingerprints — enough to look a
 * finding up, not to carry it anywhere. A RE-audit (goal criterion 2) needs the
 * previous round's objections verbatim so the auditor can judge whether each
 * was actually addressed; the gate persists these alongside the verdict.
 * Unparseable fences are skipped (their verdict already failed closed).
 */
export function parseFenceFindings(text: string): FenceFinding[] {
  const out: FenceFinding[] = [];
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    let obj: unknown;
    try { obj = JSON.parse(m[1]!); }
    catch {
      // Same salvage as parseJsonFence: raw control chars inside string
      // values (a routine LLM defect) must not lose the findings the verdict
      // parser itself keeps.
      try { obj = JSON.parse(escapeControlCharsInStrings(m[1]!)); }
      catch { continue; /* unparseable fence: skip */ }
    }
    if (obj && Array.isArray((obj as Record<string, unknown>).findings)) {
      for (const f of (obj as Record<string, unknown>).findings as unknown[]) {
        if (f && typeof f === "object" && typeof (f as Record<string, unknown>).issue === "string") {
          out.push({
            severity: typeof (f as Record<string, unknown>).severity === "string"
              ? (f as Record<string, unknown>).severity as string
              : "P2",
            issue: (f as Record<string, unknown>).issue as string,
          });
        }
      }
    }
  }
  return out;
}

/**
 * One finding with its FILE, for the polish-gate file-level counting.
 *
 * `parseFenceFindings` deliberately carries only severity + issue (the
 * re-audit carryover needs objections verbatim, not locations). The polish
 * gate (round-18) counts how many consecutive rounds a FILE keeps showing up
 * in P2/Nit findings, which needs severity AND file per finding; unparseable
 * fences are skipped exactly like the verdict parser.
 */
export interface FenceFileFinding {
  severity: string;
  file: string;
}

export function parseFenceFileFindings(text: string): FenceFileFinding[] {
  const out: FenceFileFinding[] = [];
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    let obj: unknown;
    try { obj = JSON.parse(m[1]!); }
    catch {
      try { obj = JSON.parse(escapeControlCharsInStrings(m[1]!)); }
      catch { continue; }
    }
    if (obj && Array.isArray((obj as Record<string, unknown>).findings)) {
      for (const f of (obj as Record<string, unknown>).findings as unknown[]) {
        if (f && typeof f === "object" && typeof (f as Record<string, unknown>).severity === "string") {
          const file = (f as Record<string, unknown>).file;
          // A finding with no file cannot feed the file-level streak — skip
          // it like the verdict parser skips unparseable entries.
          if (typeof file !== "string" || file.trim() === "") continue;
          out.push({
            severity: (f as Record<string, unknown>).severity as string,
            file,
          });
        }
      }
    }
  }
  return out;
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
    if (s.includes("NO CHECKS")) result = "NO_CHECKS_RUN";
    if (s.includes("PASS") && result === null) result = "PASS";
  }
  return result;
}
