/**
 * pi-review-gate — shared constants.
 *
 * PR #7 lesson 5 (code-extension drift): multiple gate sites in -dev-flow
 * had INCONSISTENT file-extension lists, so some file types were gated by some
 * hooks and silently ignored by others. Here there is exactly ONE list, and a
 * structural test (test/constants.test.ts) asserts every consumer imports it
 * rather than declaring its own.
 */

/**
 * The single source of truth for "is this a code file?".
 * PR #7 lesson 4 (NotebookEdit bypass): `.ipynb` is a first-class member —
 * notebook edits engage the gate exactly like any other code edit.
 */
export const CODE_EXTENSIONS: readonly string[] = Object.freeze([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "pyw", "ipynb",
  "go", "rs",
  "java", "kt", "kts", "scala",
  "rb", "php", "swift",
  "c", "cpp", "cc", "h", "hpp", "cs",
  "ex", "exs",
  "sh", "bash", "zsh",
]);

export const DOC_EXTENSIONS: readonly string[] = Object.freeze(["md", "mdx"]);

const codeExtSet = new Set(CODE_EXTENSIONS);
const docExtSet = new Set(DOC_EXTENSIONS);

export function extOf(filePath: string): string {
  const base = filePath.split("/").pop() ?? "";
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : "";
}

export function isCodeFile(filePath: string): boolean {
  return codeExtSet.has(extOf(filePath));
}

export function isDocFile(filePath: string): boolean {
  return docExtSet.has(extOf(filePath));
}

/**
 * Coalesce the file path out of a tool input regardless of which parameter
 * name the tool uses. PR #7 lesson 4: the NotebookEdit bypass happened
 * because hooks only read `file_path` while the notebook tool sent
 * `notebook_path`. We accept every known spelling so a new tool with a
 * path-like parameter still engages the gate.
 */
export function coalesceToolPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "file_path", "filePath", "notebook_path", "notebookPath"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Sensitive files the model must never edit or write.
 * Matched against the basename and the full path.
 */
export const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|\/)\.env$/i,                    // .env only — templates (.env.template) hold no secrets
  /(^|\/)[^/]*\.(pem|key|p12|pfx)$/i, // private keys / certs
  /(^|\/)id_(rsa|ed25519|ecdsa)[^/]*$/i,
  /(^|\/)(credentials|secrets?)(\.[a-z0-9]+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)serviceaccount.*\.json$/i,
  // sd0x-dev-flow pre-edit-guard port: .git internals are never editable by the
  // model — otherwise it could rewrite .git/hooks/pre-commit and disarm the L3
  // defense-in-depth layer. Matches `.git/…` and a bare `.git` path segment,
  // but NOT .gitignore / .github (the dot must be followed by exactly "git").
  /(^|\/)\.git(\/|$)/i,
]);

export function isSensitiveFile(filePath: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(filePath));
}

/**
 * AI-attribution patterns for commit messages.
 *
 * PR #7 lesson 8 (word-boundary false positives): bare `AI` under
 * case-insensitive matching hits "maintainer" and "domain". Only `AI` is
 * \b-bounded. `GPT` and `OpenAI` stay UNBOUNDED on purpose so they still
 * match inside "ChatGPT" / "GPT-4" (no English word contains "gpt").
 */
export const COMMIT_MSG_FORBIDDEN: readonly RegExp[] = Object.freeze([
  /Co-Authored-By:.*(Claude|Anthropic|GPT|OpenAI|Copilot|noreply@anthropic)/i,
  /Generated (by|with).*(Claude|\bAI\b|GPT|OpenAI|Copilot)/i,
  /🤖.*(Claude|\bAI\b|GPT|OpenAI)/i,
]);

/** Ship commands that the hard gate intercepts. */
export const SHIP_COMMAND_KINDS = Object.freeze(["commit", "push", "pr-create", "pr-edit"] as const);
export type ShipCommandKind = (typeof SHIP_COMMAND_KINDS)[number];

/**
 * Output-language gate — the single source of truth for the language directive.
 *
 * This gate cannot be enforced at the ship/tool_call layer (a `git commit` says
 * nothing about output language, and heuristically scoring the model's prose as
 * "Chinese enough" would false-positive on code, paths, and shell commands —
 * exactly the fail-open trap this project avoids). So it is enforced the only
 * reliable way: an UNCONDITIONAL system-prompt directive injected every turn.
 *
 * Requirement: strict Simplified Chinese for user-facing output; thinking in
 * Chinese where practical. Protocol-fixed English tokens are explicitly exempt
 * so the directive can't corrupt the review gate itself (verdict enum values
 * READY/BLOCKED/NEEDS_HUMAN, commit messages, code, identifiers, paths, commands).
 */
export const LANGUAGE_DIRECTIVE =
  "## 输出语言（强制 / enforced）\n" +
  "你必须严格使用**简体中文**输出所有面向用户的文字（解释、总结、提问、findings 描述等）。\n" +
  "thinking（思考过程）也请尽量使用简体中文。\n" +
  "例外（保持英文原样，不要翻译）：代码、标识符、文件路径、shell 命令，以及协议要求的固定英文标记" +
  "——尤其是门禁裁决 JSON 里的 \"READY\" / \"BLOCKED\" / \"NEEDS_HUMAN\" 字段值、precommit 的 " +
  "`## Overall:` sentinel、以及 commit message。这些若被翻译会破坏门禁解析。\n" +
  "反向要求（L5，advisory）：commit message 与 PR 的 title/description 必须用英文撰写，" +
  "不要出现中文或其他非英文文案；reviewer 审核时也会检查这一点。";

/** Gate loop hard cap — mirrors auto-loop max_rounds. Overridable per project
 * via .pi/review-gate.json (see lib/project-config.ts, sd0x-dev-flow R6). */
export const DEFAULT_MAX_ROUNDS = 10;

/** Consecutive identical-fingerprint rounds before we call it a plateau. */
export const PLATEAU_ROUNDS = 3;

/**
 * Oscillation cap. Session-log analysis of real projects showed ~50% of gated
 * sessions where the reviewer returned READY and then, a round or two later,
 * BLOCKED again with an entirely NEW set of findings (finding fingerprints
 * never repeated across rounds). `isPlateaued` cannot catch this — it requires
 * a non-decreasing, overlapping finding set, whereas oscillation is 0→N→0→M.
 * When the READY→BLOCKED transition recurs this many times the loop is not
 * converging; we disarm the auto-loop and escalate to the user (same treatment
 * as plateau / max-rounds). This ONLY disarms auto-continuation and never
 * loosens the ship gate — it is a tighten-only stop condition.
 */
export const OSCILLATION_LIMIT = 3;

/**
 * Strategic reset (sd0x-dev-flow R10 "Think Harder"): when the review loop is
 * still BLOCKED within this many rounds of the cap, inject a one-shot rethink
 * checklist instead of letting the model burn the remaining rounds on
 * incremental fixes. Fires ONCE per gate-state lifetime (reset by /gate-reset
 * or a new session state).
 */
export const STRATEGIC_RESET_OFFSET = 3;

export const STRATEGIC_RESET_CHECKLIST =
  "[STRATEGIC_RESET] Approaching the round cap. Before burning the remaining rounds:\n" +
  "1) Re-read the ORIGINAL requirement/error from the start of the task.\n" +
  "2) Challenge the current assumption — what if the opposite is true?\n" +
  "3) Search the codebase for similar patterns that are already solved.\n" +
  "4) Consider a fundamentally different approach, not an incremental fix.\n" +
  "5) Consult the adviser subagent with the full problem statement.\n" +
  "If still blocked at the cap, escalate to the user.";
