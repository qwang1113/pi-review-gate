/**
 * Precommit output parsing — the `## Overall:` sentinel, and nothing else.
 *
 * This file used to be `lib/verdict-parse.ts` and held two parsers: this one,
 * and an all-fence worst-wins parser for REVIEW verdicts. The review half is
 * gone (2026-09-04): a judge concludes through `judge_conclude` with
 * structured fields that now travel structured all the way to the opener, so
 * there is no text to scan for a verdict and no fence to synthesise for the
 * scanner (`lib/review-adjudicate.ts` owns what the review parser also
 * decided — the READY-with-open-P0/P1 downgrade, the finding count and the
 * cross-round fingerprints). The file is named after what is left.
 *
 * Precommit is the OTHER gate and it is deliberately separate: it reads a
 * trusted runner's stdout, never a judge's, and `FAIL > NO_CHECKS_RUN > PASS`
 * with FAIL terminal.
 */

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
