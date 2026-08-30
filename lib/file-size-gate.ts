/**
 * FILE SIZE — the one mechanical half of the architecture standard (task book
 * §9), and deliberately the only hard rule in it.
 *
 * THE ASYMMETRY IS THE DESIGN. A file that is being CREATED oversized is one
 * decision by one author, made right now, and refusing it costs a split that
 * was going to be necessary anyway. A file that has GROWN oversized is
 * fifty decisions by ten authors, none of which was individually
 * unreasonable — this repository's own `extensions/review-gate.ts` reached
 * 8659 lines in exactly that way, one honest "+100 lines" at a time. Blocking
 * a change because a pre-existing file is too long punishes the wrong commit
 * and, worse, forces a rushed split at the end of a task, which produces
 * worse modules than the sprawl it replaced. So:
 *
 *   - NEW file over the limit .......... HARD BLOCK (at checkpoint time)
 *   - EXISTING file over the limit ..... ADVISORY line, never a block
 *
 * WHERE IT RUNS. At `review_checkpoint` / precommit, not at edit time (user
 * decision 3). Blocking mid-write would fire while the file is half-written
 * and force the author to restructure blind; at checkpoint the whole shape
 * exists and splitting it is a mechanical move.
 *
 * WHAT COUNTS. Source files only. Markdown, JSON, lockfiles and fixtures are
 * excluded: their length says nothing about module design, and a task book or
 * a data fixture has every right to be long.
 *
 * Pure module: facts in, decisions out. The caller collects the facts from git.
 */

/** A new source file LONGER than this is refused. */
export const NEW_FILE_HARD_LIMIT = 600;
/** An existing source file LONGER than this earns a reminder. */
export const EXISTING_FILE_SOFT_LIMIT = 600;

/** Extensions whose length reflects module design. */
const SOURCE_EXTENSIONS: readonly string[] = Object.freeze([
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".rb", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
]);

/** Paths that are never judged, whatever their extension. */
const EXEMPT_SEGMENTS: readonly string[] = Object.freeze([
  "node_modules/", "dist/", "build/", "vendor/", "__generated__/", ".pi/",
]);

export function isSizeJudgedFile(path: string): boolean {
  const rel = path.replace(/^\.\//, "");
  if (EXEMPT_SEGMENTS.some((seg) => rel.startsWith(seg) || rel.includes("/" + seg))) return false;
  if (/\.(min|bundle)\./.test(rel)) return false;
  if (/\.d\.ts$/.test(rel)) return false;
  const dot = rel.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.includes(rel.slice(dot));
}

/** What the caller measured for one changed file. */
export interface FileSizeFact {
  /** Repo-relative path. */
  path: string;
  /** Total line count AFTER the change. */
  lines: number;
  /** True when this file does not exist in the baseline commit. */
  isNew: boolean;
  /** Lines this change added, when known (used in the advisory text). */
  addedLines?: number;
}

export interface FileSizeVerdict {
  /** Reasons the checkpoint must be refused (new files only). */
  blocking: string[];
  /** Reminders — printed, never enforced. */
  advisory: string[];
}

/**
 * Judge a batch of changed files.
 *
 * The blocking message names the limit AND the way out, because the useful
 * response to it is a split, not a smaller function: a 900-line new module is
 * usually two or three modules that have not been named yet.
 */
export function fileSizeVerdict(facts: readonly FileSizeFact[]): FileSizeVerdict {
  const blocking: string[] = [];
  const advisory: string[] = [];
  for (const fact of facts) {
    if (!isSizeJudgedFile(fact.path)) continue;
    if (fact.isNew) {
      if (fact.lines > NEW_FILE_HARD_LIMIT) {
        blocking.push(
          `新建文件 ${fact.path} 有 ${fact.lines} 行，超过 ${NEW_FILE_HARD_LIMIT} 行上限 —— ` +
          "新文件的规模是此刻的一个决定，现在拆最便宜。按职责拆成几个模块（每个都能用一句话说清它负责什么），" +
          "而不是把函数改小。",
        );
      }
      continue;
    }
    if (fact.lines > EXISTING_FILE_SOFT_LIMIT) {
      advisory.push(
        `提醒（不拦）：${fact.path} 已有 ${fact.lines} 行` +
        (fact.addedLines !== undefined ? `，本次 +${fact.addedLines}` : "") +
        " —— 存量大文件不硬拦（它是几十次小改累积的，收尾时硬拆只会拆得更烂），" +
        "但如果这次是在给它加新职责，考虑把新职责放进新模块。",
      );
    }
  }
  return { blocking, advisory };
}

/** Render the verdict for a tool result; empty string when there is nothing to say. */
export function formatFileSizeVerdict(verdict: FileSizeVerdict): string {
  const parts: string[] = [];
  if (verdict.blocking.length) {
    parts.push("文件规模硬拦（新建文件超阈值）：\n" + verdict.blocking.map((b) => `  - ${b}`).join("\n"));
  }
  if (verdict.advisory.length) {
    parts.push("文件规模提醒：\n" + verdict.advisory.map((a) => `  - ${a}`).join("\n"));
  }
  return parts.join("\n");
}
