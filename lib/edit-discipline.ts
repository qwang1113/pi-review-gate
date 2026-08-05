/**
 * Edit-discipline nudges — prompt-level correction for a recurring bad habit:
 * when an edit/write tool call fails (validation error, oldText mismatch,
 * wrong tool name), some agents fall back to bash/python to modify files
 * directly (sed -i, cat >, python -c writes, …), bypassing the tools.
 *
 * DESIGN CONSTRAINT (user requirement): these are NUDGES ONLY — appended text
 * in tool results and a system-prompt paragraph. Nothing here blocks, rewrites
 * commands, or adds enforcement. A nudge can be ignored at no cost; the goal is
 * to steer the agent back to the tools, not to police it.
 *
 * Two append sites:
 *  - edit/write tool FAILURE → append EDIT_FAILURE_NUDGE to that result.
 *  - a bash command that looks like a direct file write, while an edit failure
 *    is still pending IN THE SAME TURN → append BASH_WRITE_NUDGE to that
 *    result. The pending flag is cleared at turn start (before_agent_start),
 *    on a new user input, on any successful edit, and after one nudge, so
 *    ordinary bash usage never pays for a nudge.
 */

/** bash commands that directly WRITE or MODIFY file contents (bypassing the
 *  edit/write tools). Broad on purpose: nudges are cheap and non-blocking, and
 *  the call sites gate them behind a same-turn edit-failure window, so false
 *  positives only occur right after a failed edit. */
const WRITE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b(sed|perl|ruby)\s+-i\b/,                        // in-place edits
  /\b(python3?|node|ruby)\s+-?\s*<</,               // heredoc script (conservative)
  // -c/-e scripts count only with an actual file-write primitive inside
  /\b(python3?|node|ruby)\s+(-c|-e)\b[\s\S]*?\b(open\([^)]*['"][wa]|write_text|writeText|writeFile|writeFileSync|appendFile|outputFile|createWriteStream|os\.write|\.write\(|\.writelines\()/,
  /\btee\b/,                                          // tee always writes
  /(?:cat)\s+[^|;\n]*>\s*/,                          // cat redirected to a file
  /\b(?:printf|echo)\s+[^|;\n]*>\s*[^\s|;&\n]/,      // output redirected to a file
  /\b>>?\s*[^\s|;&\n]+\s*$/,                         // bare redirect at line end
  /\bbase64\s+-d[^|;\n]*>/,                          // decoded write
  /\bapply_patch\b|\bpatch\s+-p\d+/,                 // patch application
]);

/** True when the command plausibly writes file contents from bash. */
export function looksLikeBashFileWrite(command: string): boolean {
  if (!command) return false;
  // Ignore /dev/null targets — that is output suppression, not file editing.
  for (const re of WRITE_PATTERNS) {
    if (re.test(command)) {
      const devNull = /\s>>?\s*\/dev\/null\b/.test(command);
      if (devNull && !/cat\s|tee\s|printf\s|echo\s|base64\s/.test(command)) return false;
      return true;
    }
  }
  return false;
}

/** Appended to the result of a FAILED edit/write tool call. */
export const EDIT_FAILURE_NUDGE =
  "\n\n[review-gate] This edit/write call FAILED (see error above). Fix the tool call " +
  "itself — exact oldText, valid fields, tool name \"edit\"/\"write\" — and retry; " +
  "do NOT fall back to bash/python (sed -i, cat >, python -c writes, ...) to edit " +
  "files directly. bash is for read-only diagnostics and commands.";

/** Appended to a bash result that writes files right after a failed edit. */
export const BASH_WRITE_NUDGE =
  "\n\n[review-gate] This bash command appears to write/modify a file directly. If this " +
  "is a workaround for a failed edit call, stop and retry the edit/write tool instead " +
  "(fix its arguments — exact oldText, valid fields, correct tool name). If you " +
  "genuinely need bash for a non-edit file operation (e.g. generating a fixture), say " +
  "why; otherwise prefer the edit/write tools.";

/** Per-turn system-prompt paragraph (injected in every non-normal mode). */
export const EDIT_DISCIPLINE_DIRECTIVE =
  "## File-editing discipline\n" +
  "Make ALL file changes through the edit/write tools — never fall back to " +
  "bash/python to modify files (sed -i, perl -i, cat >, python/node script writes, " +
  "etc.); bash is for read-only diagnostics and commands. If an edit/write call " +
  "fails (validation error, oldText mismatch, unknown tool name), FIX THE CALL " +
  "(exact oldText, valid fields, correct tool name) and retry — do not work around " +
  "it with bash. If you genuinely need bash for a non-edit file operation, say why.";
