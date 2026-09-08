/**
 * TEST-RUN DISCIPLINE — the nudge half of the "never manually re-run the full
 * suite" rule (2026-09-08, user decision).
 *
 * WHY THIS EXISTS. The gate's own submission chain (`judge_submit`) runs the
 * FULL precommit (typecheck + build + the complete suite) on the exact content
 * being reviewed, and the runner caches by input: unchanged content reuses the
 * recorded PASS in seconds. A manual `npm test` / `tsc` in the main session is
 * therefore pure waste — minutes of tokens and wall-clock to re-establish what
 * the gate already knows or will establish at submit time. Agents still do it
 * ("求稳"), so this nudges them back to the cheap path: run only the targeted
 * test file for what is being edited, and let the round's own full lane be the
 * single gate.
 *
 * DESIGN CONSTRAINT (mirrors lib/edit-discipline.ts): a NUDGE ONLY — appended
 * text on the bash result, never a block. A full-suite run is legitimate from
 * the JUDGE side (a reviewer verifying the reviewed commit in its throwaway
 * worktree), from the user's own hands, and as a deliberate diagnostic — so
 * the call sites decide who hears it, and this module only recognises the
 * command shapes.
 *
 * Pure module: facts in, judgement-free recognition out.
 */

/** Shell-command segments: split on separators, not on whitespace. */
function segments(command: string): string[] {
  return command.split(/[;&|\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A segment that references a concrete source/test file (path or glob with an extension). */
const FILE_TOKEN = /(?:^|\s)[^\s]*\.(?:ts|tsx|js|jsx|mjs|cjs|json)(?:\s|$)/;

function hasFileToken(segment: string): boolean {
  return FILE_TOKEN.test(segment);
}

/** A bare `npm|yarn|pnpm (run) test` with nothing file-like after it. */
const PM_TEST = /(?:^|\s)(npm|yarn|pnpm)(?:\s+run)?\s+test(?:\s|$)/;

/** `tsc --noEmit` (optionally via npx), or `npm run typecheck`. */
const TSC_NOEMIT = /(?:^|\s)(?:npx\s+)?tsc\s+--noEmit(?:\s|$)/;
const PM_TYPECHECK = /(?:^|\s)(npm|yarn|pnpm)(?:\s+run)?\s+typecheck(?:\s|$)/;

/** `node --test` alone or with flags — but not when a file follows. */
const NODE_TEST = /(?:^|\s)node\s+--test(?:\s|$)/;

/** A find-expanded whole tree (`node --test $(find test …)`) — this repo's
 * own full run. Requires BOTH halves in the same segment: `$(find …)` alone
 * is a read-only command substitution and must never be flagged (reviewer P2,
 * 2026-09-08). */
const FIND_EXPANDED = /node\s+--test[^;&|\n]*\$\(find\b/;

/** True when the command runs the FULL test suite (no target file). */
export function looksLikeFullSuiteRun(command: string): boolean {
  if (!command) return false;
  for (const seg of segments(command)) {
    if (FIND_EXPANDED.test(seg)) return true;
    if (NODE_TEST.test(seg) && !hasFileToken(seg)) return true;
    if (PM_TEST.test(seg) && !hasFileToken(seg)) return true;
  }
  return false;
}

/** True when the command runs a whole-project typecheck. */
export function looksLikeTypecheck(command: string): boolean {
  if (!command) return false;
  for (const seg of segments(command)) {
    if (TSC_NOEMIT.test(seg) && !hasFileToken(seg)) return true;
    if (PM_TYPECHECK.test(seg) && !hasFileToken(seg)) return true;
  }
  return false;
}

/** True when the command is one of the two whole-lane checks. */
export function looksLikeFullLaneRun(command: string): boolean {
  return looksLikeFullSuiteRun(command) || looksLikeTypecheck(command);
}

/**
 * The nudge, appended to the bash result. Names the cheaper path AND why the
 * full lane is not the agent's job to run by hand.
 */
export const FULL_LANE_NUDGE =
  "\n\n[review-gate] 你在手动跑全量测试/typecheck。送审（judge_submit）时门禁会自己跑 full precommit——" +
  "typecheck + build + 完整测试套件都在那份内容上跑，且按输入缓存（未变内容秒过）。" +
  "开发期只跑相关单测即可：`node --test test/<对应文件>.test.ts`（改哪个文件跑哪个）。" +
  "不要在送审前手动重跑全量或 tsc——那是门禁链路的活，重复跑只烧时间。";
