/**
 * L6 (extension side): the test-label language check, run at EDIT time —
 * moved out of `extensions/review-gate.ts` (t5, wave 1).
 *
 * The git-hook scanner (scripts/scan-test-labels.cjs) stays the deterministic,
 * zero-dependency backstop at commit time; here the SAME lexer runs at edit
 * time for immediate feedback, judging only the labels this edit adds or
 * changes. No model call (2026-09-29, user decision: an arbiter window per
 * test edit blocked the editor for minutes); a misjudgement is appealed with
 * `request_arbitration`. Scanner load/parse failure → pass (hook still enforces).
 */

import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

import { projectEditedContent } from "./edit-projection.ts";
import { statusNotice, type SlowNoticeSink } from "./progress-stream.ts";
import { l5BlockReason } from "./lang-detect.ts";
import { normalizeSensitivePath } from "./sensitive-grant.ts";
import type { AppealKind } from "./text-appeal.ts";
import type { SessionHost } from "./session-host.ts";

/** Status-bar line the gate owns for its LLM-guard notices. */
const LLM_STATUS_KEY = "review-gate-llm";

/** What the edit-time checks need from the session beyond the shared host. */
export interface EditTimeCheckDeps {
  /** The A-class refusal (appealable; a granted pass for this exact text lets it through). */
  refuseText(kind: AppealKind, text: string, reason: string, ctx: unknown): string | undefined;
}

export function createEditTimeChecks(host: SessionHost, deps: EditTimeCheckDeps) {
  /**
   * Full post-edit file projection (lib/edit-projection.ts). Scanning the
   * complete projected file — not newText fragments — closes the reviewer's
   * P1 bypass: an edit replacing just a label STRING (`'old label'` →
   * `'ceshi denglu'`) still yields a file where the lexer sees the
   * surrounding `it(...)` call.
   */
  /** The file as it is on disk BEFORE this edit (a tool_call hook runs first). */
  function currentContent(path: string): string | undefined {
    // P2 fix: resolve relative tool paths against the SESSION cwd, not the
    // extension host's process.cwd() (they can differ under pi --cwd).
    const abs = path.startsWith("/") ? path : pathJoin(host.repos().cwd, path);
    try { return readFileSync(abs, "utf8"); } catch { return undefined; }
  }

  function editedTestContent(input: Record<string, unknown>, path: string): string {
    return projectEditedContent(input, () => currentContent(path));
  }

  /**
   * The status bar of a HOOK's context, as a slow-notice sink.
   *
   * A `tool_call` handler has no `onUpdate` (that is a tool's channel), so a
   * multi-second classification would look like a frozen editor. The status
   * line is the one surface a hook has, and `withSlowNotice` only ever uses
   * it when the call is actually slow.
   */
  function llmNotice(ctx: unknown): SlowNoticeSink | undefined {
    const ui = (ctx as { ui?: { setStatus?: (key: string, text: string | undefined) => void } } | undefined)?.ui;
    return statusNotice(ui, LLM_STATUS_KEY);
  }

  async function checkTestLabels(
    path: string,
    content: string,
    /** The hook's context: persisting a spent appeal pass. */
    ctx: unknown,
  ): Promise<string | undefined> {
    if (!content) return undefined;
    let analyze: ((p: string, src: string, baseSrc?: string) => { violations: Array<{ line: number; label: string }> }) | undefined;
    let isTest: ((p: string) => boolean) | undefined;
    try {
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      // P1 fix: probe every install layout, mirroring resolveTrustedRunner().
      // The old single "../scripts/…" path only resolved in the dev repo
      // (lib/ sibling); global installs put the package in
      // extensions/pi-review-gate/ with scripts/ TWO levels up, so the
      // edit-time L6 check silently never ran in any installed layout.
      let mod: { analyzeFile?: typeof analyze; isTestFile?: typeof isTest } | undefined;
      for (const rel of [
        "../scripts/scan-test-labels.cjs",       // dev repo: lib/ sibling
        "../../scripts/scan-test-labels.cjs",    // global/project: extensions/pi-review-gate/
        "./scripts/scan-test-labels.cjs",        // flat layout
      ]) {
        try { mod = req(rel); break; } catch { /* keep probing */ }
      }
      if (!mod) return undefined; /* scanner unavailable — hook backstop remains */
      analyze = mod.analyzeFile; isTest = mod.isTestFile;
    } catch { return undefined; /* scanner unavailable — hook backstop remains */ }
    // Classify on the RESOLVED path, for the same reason the sensitive-file
    // guard does: `foo.test.ts/x/..` names a test file that a segment-based
    // matcher would miss. (Such a spelling also fails at the fs layer and the
    // L3 hook scans the real committed paths, so this is consistency rather
    // than a hole being closed.) Messages keep the caller's spelling — that is
    // what the agent typed and can act on.
    if (!analyze || !isTest || !isTest(normalizeSensitivePath(path, host.repos().cwd))) return undefined;
    let res: ReturnType<typeof analyze>;
    try { res = analyze(path, content, currentContent(path)); } catch { return undefined; }
    const v = res.violations[0];
    if (v === undefined) return undefined;
    return deps.refuseText("test-label", v.label,
      `${l5BlockReason({ kind: "test-label", text: v.label })} 位置 ${path}:${v.line}。` +
      "测试描述必须是英文；确属特例时在上一行加 `// review-gate: allow-non-english`，" +
      "误判就用 `request_arbitration` 申诉。", ctx);
  }

  return { editedTestContent, checkTestLabels, llmNotice };
}
