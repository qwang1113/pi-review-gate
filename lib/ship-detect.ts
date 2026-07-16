/**
 * Ship-command detection: decide whether a bash command line contains a
 * "ship" operation (git commit / git push / gh pr create).
 *
 * Design notes:
 * - We tokenize per shell segment (split on ;, &&, ||, |, newline) so
 *   `cd foo && git commit` is caught.
 * - We deliberately do NOT try to be a full shell parser. Fail-closed
 *   philosophy from : obvious evasions (bash -c "...", eval, xargs git,
 *   command substitution with git inside) are ALSO flagged — a false
 *   positive costs one confirmation, a false negative ships ungated code.
 * - `git commit --amend --no-edit` and message-only edits are still commits.
 */

import type { ShipCommandKind } from "./constants.ts";

export interface ShipDetection {
  kind: ShipCommandKind;
  segment: string;
}

/** Split a command line into logical shell segments. Also unwraps
 * command substitution $() and backtick `` — fail-closed. */
function segments(command: string): string[] {
  // Remove backslash-newline line continuations FIRST: the shell deletes them
  // before word splitting, so `git \<newline>commit` executes as `git commit`.
  // Doing this before splitting on newlines is what closes that ship bypass.
  command = command.replace(/\\\r?\n/g, "");
  // First extract command substitutions and process them as segments too.
  const subs: string[] = [];
  let expanded = command;
  // $() form
  expanded = expanded.replace(/\$\(([^)]+)\)/g, (_m, inner) => { subs.push(inner); return ""; });
  // backtick form
  expanded = expanded.replace(/`([^`]+)`/g, (_m, inner) => { subs.push(inner); return ""; });
  const main = expanded
    .split(/(?:\|\||&&|;|\||\n)/g)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...main, ...subs];
}

/**
 * Model the shell's own quote/escape removal on a SINGLE word: quote characters
 * are delimiters, not content — removing them concatenates the adjacent runs
 * (so `"g"it`, `gi"t"`, `g""i""t`, `'g'it` all become `git`), and a backslash
 * escapes the next char (so `\g\i\t` becomes `git`). This is applied per token
 * AFTER whitespace splitting, so real argument separation is preserved while
 * intra-word obfuscation is normalized away. Fail-closed: we only strip; we
 * never introduce new separators.
 */
function dequoteWord(word: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      // Inside double quotes a backslash escapes the next char; inside single
      // quotes it is literal. Keep it simple and fail-closed: copy the char.
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "\\" && i + 1 < word.length) { out += word[i + 1]; i++; continue; }
    out += ch;
  }
  return out;
}

/** Strip leading env assignments (FOO=bar git commit) and wrappers.
 * P0-5: handle env with args, /usr/bin/env, sudo -u, git -c key=val.
 * Each token is shell-dequoted first so quote/escape obfuscation of the command
 * name ("g"it, gi"t", \g\i\t) is normalized before matching. */
/** Exec wrappers that run ANOTHER command (matched by basename, so absolute
 * paths like /usr/bin/sudo work too). Their option grammars differ wildly, so
 * once one prefixes the line we scan forward to the git/gh command head rather
 * than parsing each wrapper's flags. */
const WRAPPER_NAMES = new Set([
  "command", "exec", "nohup", "time", "sudo", "doas", "env",
  "nice", "timeout", "setsid", "stdbuf", "ionice", "chrt",
]);
function basename(tok: string): string {
  const slash = tok.lastIndexOf("/");
  return slash >= 0 ? tok.slice(slash + 1) : tok;
}
function isWrapper(tok: string): boolean {
  return WRAPPER_NAMES.has(basename(tok));
}
function isCommandHead(tok: string): boolean {
  return tok === "git" || tok === "gh" || tok.endsWith("/git") || tok.endsWith("/gh");
}
/** Leading shell syntax that precedes a command position: `!`, grouping
 * `(`/`{`, and redirections (`>out`, `2>err`, `>>a`, `<in`, `2>&1`). */
function isShellPrefix(tok: string): boolean {
  return tok === "!" || tok === "(" || tok === ")" || tok === "{" || tok === "}"
    || /^\d*[<>]/.test(tok)   // redirection possibly with leading fd: >x 2>y >>z <i
    || /^&\d*$/.test(tok);    // &1 style leftovers
}

function normalizedTokens(segment: string): string[] {
  // Split off leading grouping punctuation glued to tokens: `(git`, `{git`.
  const tokens = segment
    .split(/\s+/)
    // Peel grouping/negation punctuation glued to a token so `(git`, `{git`,
    // `push)`, `};` become separate tokens the scanner can skip.
    .flatMap((t) => t.replace(/^[!(){}]+|[(){};]+$/g, (m) => " " + m.split("").join(" ") + " ").split(/\s+/))
    .map(dequoteWord)
    .filter((t) => t.length > 0);
  let i = 0;
  // Skip leading shell-syntax prefixes and env assignments, in any order, until
  // we reach a command position. Bounded to the segment HEAD (adviser's
  // "bounded command-position scan").
  while (i < tokens.length) {
    const t = tokens[i];
    // A bare redirection OPERATOR (`>`, `2>`, `>>`, `<`) consumes its target in
    // the next token: `> out git commit` → skip `>` and `out`.
    if (/^\d*(>>?|<)$/.test(t)) { i += 2; continue; }
    if (isShellPrefix(t)) { i++; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // FOO=bar
    break;
  }

  // If the command position is an exec wrapper, scan forward to the real git/gh
  // command head. This transparently handles any wrapper option grammar and
  // nested wrappers (sudo env git commit). Because a wrapper's flag VALUES are
  // indistinguishable from an executable statically (env -u HOME git …), we
  // scan the whole segment for a git/gh head — accepting the documented
  // wrapper-ambiguity false positive (`sudo echo git push`) as fail-closed.
  if (i < tokens.length && isWrapper(tokens[i])) {
    for (let j = i + 1; j < tokens.length; j++) {
      if (isCommandHead(tokens[j])) return tokens.slice(j);
    }
  }
  return tokens.slice(i);
}

function matchGit(tokens: string[]): ShipCommandKind | undefined {
  if (tokens.length === 0) return undefined;
  const head = tokens[0];
  if (head !== "git" && !head.endsWith("/git")) return undefined;

  // Skip git global options before the subcommand. No-value flags are skipped
  // generically (skip 1); the options that take a SEPARATE value consume two
  // tokens. VALUE_OPTS lists git's separate-value global options (from
  // `git --help`, plus lesser-known --attr-source/--exec-path/--super-prefix).
  const VALUE_OPTS = new Set([
    "-C", "-c", "--git-dir", "--work-tree", "--namespace",
    "--exec-path", "--super-prefix", "--attr-source", "--config-env",
  ]);
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (VALUE_OPTS.has(t)) { i += 2; continue; }        // option + separate value
    if (t.startsWith("-")) { i += 1; continue; }         // any attached-value or no-value flag
    break;                                               // first non-option = subcommand
  }
  const sub = tokens[i];
  if (sub === "commit") return "commit";
  if (sub === "push") return "push";
  // Fail-closed guard for an UNKNOWN separate-value global option not in
  // VALUE_OPTS: such an option would leave us pointing at its VALUE (treated as
  // `sub`), with the real subcommand one token later. Precisely: if `sub` was
  // immediately preceded by a `-`-flag (so it may be that flag's value) AND the
  // NEXT token is a ship verb, flag it. This is bounded (no scanning into commit
  // messages) yet over-detects the unknown-option case rather than missing it.
  if (i > 1 && tokens[i - 1].startsWith("-") && !VALUE_OPTS.has(tokens[i - 1])) {
    if (tokens[i + 1] === "commit") return "commit";
    if (tokens[i + 1] === "push") return "push";
  }
  return undefined;
}

/**
 * Native `git -c alias.<name>=<def> <name>` bypass (fail-closed). Git lets you
 * DEFINE an alias inline on the command line and invoke it in the same call, so
 * the resolved subcommand token is the alias name (`ship`), not the ship verb
 * it expands to. matchGit skips `-c <value>` as an opaque global option and
 * therefore never sees the `commit`/`push` hidden inside the alias definition.
 *
 * This is a fully STATIC, single-line, recognizable text form (same equivalence
 * class as the g""it / git${IFS}commit obfuscations we already catch), so it is
 * in-scope. We do NOT try to confirm the alias name is actually invoked later —
 * fail-closed: an inline alias DEFINING a ship verb is treated as that ship.
 *
 * A pre-existing alias living in the user's git config (`git ship`, definition
 * NOT on the command line) is statically invisible and stays out of scope.
 */
function matchGitConfigAlias(headTokens: string[], rawSegment: string): ShipCommandKind | undefined {
  const head = headTokens[0];
  if (head === undefined || (head !== "git" && !head.endsWith("/git"))) return undefined;

  // `--config-env[=| ]alias.x=ENVVAR` pulls the alias body from an environment
  // variable — statically opaque. Fail-closed: treat any inline alias defined
  // via config-env as a commit (one confirmation beats an ungated ship).
  // Git config section/key names are case-INSENSITIVE (ALIAS.ship === alias.ship),
  // so every alias regex here uses the `i` flag to close the case-shift bypass.
  if (/(?:^|\s)--config-env(?:=|\s+)["']?alias\.[^=\s]+=/i.test(rawSegment)) return "commit";

  // Scan every inline `-c alias.<name>=<body>` definition. The body must be read
  // from the RAW segment (not the whitespace-split tokens): a quoted body like
  // "alias.x=commit --no-verify" or the shell form "alias.x=!git commit" would
  // otherwise be truncated at the first space, hiding the verb.
  //   quoted:   -c "alias.x=commit --no-verify"   (body = between the quotes)
  //   unquoted: -c alias.x=commit s               (body = up to next space)
  //   attached: -calias.x=push --force
  const patterns = [
    /(?:^|\s)-c(?:=|\s+)?(["'])alias\.[^=]+=([^"']*)\1/gi,       // quoted body
    /(?:^|\s)-c(?:=|\s+)?alias\.[^=\s]+=(\S*)/gi,                  // unquoted body
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawSegment)) !== null) {
      const body = m[2] ?? m[1] ?? "";
      // Body may be a git subcommand (`commit --no-verify`) or a shell alias
      // (`!git commit ...`). A ship verb anywhere in it flags the corresponding
      // gate; push is checked first so `!git push && commit-lint` reads as push.
      if (/\bpush\b/.test(body)) return "push";
      if (/\bcommit\b/.test(body)) return "commit";
    }
  }
  return undefined;
}

function matchGh(tokens: string[]): ShipCommandKind | undefined {
  if (tokens.length < 2) return undefined;
  const head = tokens[0];
  if (head !== "gh" && !head.endsWith("/gh")) return undefined;
  // Skip gh global flags before `pr create`. Handle both the space form
  // (`-R repo` / `--repo repo`) and the attached form (`--repo=repo` / `-R=repo`),
  // mirroring matchGit's --git-dir handling so `gh --repo=o/r pr create` is caught.
  // gh global options that take a SEPARATE value (space form).
  const GH_VALUE_OPTS = new Set(["-R", "--repo", "--hostname"]);
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (GH_VALUE_OPTS.has(t)) { i += 2; continue; }                 // option + separate value
    if (t.startsWith("--repo=") || t.startsWith("-R=") || t.startsWith("--hostname=")) { i += 1; continue; }
    if (t.startsWith("-R") && t.length > 2) { i += 1; continue; }   // compact -Rowner/repo
    if (t.startsWith("-")) { i += 1; continue; }                    // any other no-value gh global flag
    break;
  }
  if (tokens[i] === "pr" && tokens[i + 1] === "create") return "pr-create";
  // Fail-closed for an UNKNOWN separate-value gh global option (not in
  // GH_VALUE_OPTS): it would leave us pointing at its VALUE, with `pr create`
  // one token later. If the preceding token was a `-`flag, check that.
  if (i > 1 && tokens[i - 1].startsWith("-") && tokens[i + 1] === "pr" && tokens[i + 2] === "create") {
    return "pr-create";
  }
  return undefined;
}

/**
 * Evasion heuristics — commands that hide a ship op inside a nested shell.
 * Fail-closed: flagged as the contained kind when we can tell, else "commit"
 * as the most conservative gate (commit gate ⊆ push gate requirements).
 */
function matchEvasion(segment: string, fullCommand: string): ShipCommandKind | undefined {
  // bash -c / sh -c / zsh -c with git commit/push or gh pr create inside
  // Also catch: herestrings (bash <<<), piped-to-shell, process substitution.
  // Fail-closed: flag all.
  if (/\b(ba|z|da)?sh\s+(-[a-z]*\s+)*-c\b/.test(segment) ||
      /\b(ba|z|da)?sh\s+<<</.test(segment) ||
      /\beval\b/.test(segment) ||
      /\bxargs\b/.test(segment)) {
    if (/\bgit\b[^|;&]*\bcommit\b/.test(fullCommand)) return "commit";
    if (/\bgit\b[^|;&]*\bpush\b/.test(fullCommand)) return "push";
    if (/\bgh\b[^|;&]*\bpr\b[^|;&]*\bcreate\b/.test(fullCommand)) return "pr-create";
  }
  // Bare sh/bash token: likely piped-to-shell (echo ... | sh). Check full command.
  if (/^(ba|z|da)?sh$/.test(segment) || /^\S*\/(ba|z|da)?sh$/.test(segment)) {
    if (/\bgit\b/.test(fullCommand) || /\bgh\b/.test(fullCommand)) return "commit";
  }
  return undefined;
}

/**
 * Obfuscation heuristic (fail-closed) for expansions that our token matcher
 * can't see literally. Quote/escape splicing (g"i"t, \g\i\t) is already handled
 * upstream by per-token dequoting in normalizedTokens; here we handle SHELL
 * PARAMETER EXPANSION inside a word:
 *   git${IFS}commit  (IFS splices two words)     → shell runs `git commit`
 *   $GIT commit / ${GIT} commit (var indirection) → shell may run `git commit`
 * A false positive costs one confirmation; a false negative ships ungated.
 */
function matchObfuscated(segment: string): ShipCommandKind | undefined {
  // First resolve `${x:=word}` / `${x:-word}` / `${x=word}` default-value
  // expansions to their WORD, PRESERVING adjacency exactly as the shell does:
  // `${x:-g}${y:-it}` concatenates to `git`, not `g it`. So we substitute the
  // word with NO surrounding spaces. Then remove quotes (git$IFS"commit" →
  // git$IFScommit) and turn remaining parameter refs ($IFS, ${IFS}, $GIT) into a
  // separator so git${IFS}commit and git$IFScommit both split into git commit.
  const withDefaults = segment.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]([^}]*)\}/g, (_m, word) => word);
  const deQuoted = withDefaults.replace(/["']/g, "");
  // $IFS is the canonical word-splitting trick; replace it specifically first so
  // `git$IFScommit` → `git commit` (the generic $VAR rule below would greedily
  // eat the trailing `commit` as part of the variable name).
  const deIfs = deQuoted.replace(/\$\{IFS\}/g, " ").replace(/\$IFS/g, " ");
  const deExpanded = deIfs.replace(/\$\{[^}]*\}/g, " ").replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, " ");
  const collapsed = deExpanded.replace(/\s+/g, " ").trim();

  // Case A: after de-obfuscation a real git/gh ship command is visible.
  const toks = collapsed.split(" ");
  const g = matchGit(toks) ?? matchGh(toks);
  if (g) return g;

  // Case B: a variable-indirected command HEAD followed immediately by a ship
  // verb ($GIT commit, ${GH} pr create). Constrain strictly to the segment
  // HEAD: the segment must START with a $-expansion, and the ship verb must be
  // the very next token. This avoids false positives like `echo $HOME commit`
  // where the verb is an argument, not the command.
  const headExpansion = /^\s*\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s+(\S+)(\s+(\S+))?/.exec(segment);
  if (headExpansion) {
    const verb1 = headExpansion[1];
    const verb2 = headExpansion[3];
    if (verb1 === "commit") return "commit";
    if (verb1 === "push") return "push";
    if (verb1 === "pr" && verb2 === "create") return "pr-create";
  }
  return undefined;
}

/**
 * Dynamic command-head bypass (fail-closed). The shell can build the command
 * NAME from a substitution or variable, then run a ship verb:
 *   $(printf git) commit   `printf git` push   ${GIT_CMD} commit   $(printf gh) pr create
 * `segments()` strips substitutions, losing that the head was dynamic, so we
 * scan the RAW segments separately: a dynamic expression at the executable
 * (head) position immediately followed by a static ship verb is a ship attempt.
 * We do NOT flag substitutions in ARGUMENT position (echo "$(date)") — only when
 * the dynamic expression IS the command head.
 */
function matchDynamicHead(rawSegment: string): ShipCommandKind | undefined {
  // Head is a $(...) / `...` / ${VAR} / $VAR expression, then the next word(s).
  const m = /^\s*(?:\$\([^)]*\)|`[^`]*`|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*)\s+(\S+)(?:\s+(\S+))?/.exec(rawSegment);
  if (!m) return undefined;
  const verb1 = m[1];
  const verb2 = m[2];
  if (verb1 === "commit") return "commit";
  if (verb1 === "push") return "push";
  if (verb1 === "pr" && verb2 === "create") return "pr-create";
  return undefined;
}

/** Split on operators WITHOUT stripping substitutions — for raw-head scanning. */
function rawSegments(command: string): string[] {
  return command
    .replace(/\\\r?\n/g, "")
    .split(/(?:\|\||&&|;|\||\n)/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function detectShipCommands(command: string): ShipDetection[] {
  const results: ShipDetection[] = [];
  for (const seg of segments(command)) {
    const tokens = normalizedTokens(seg);
    const git = matchGit(tokens);
    if (git) { results.push({ kind: git, segment: seg }); continue; }
    const alias = matchGitConfigAlias(tokens, seg);
    if (alias) { results.push({ kind: alias, segment: seg }); continue; }
    const gh = matchGh(tokens);
    if (gh) { results.push({ kind: gh, segment: seg }); continue; }
    const evasion = matchEvasion(seg, command);
    if (evasion) { results.push({ kind: evasion, segment: seg }); continue; }
    const obfuscated = matchObfuscated(seg);
    if (obfuscated) { results.push({ kind: obfuscated, segment: seg }); }
  }
  // Separate pass over RAW segments for dynamic-command-head ship attempts,
  // which segments() would have hidden by stripping the substitution.
  for (const seg of rawSegments(command)) {
    const dyn = matchDynamicHead(seg);
    if (dyn && !results.some((r) => r.segment === seg)) {
      results.push({ kind: dyn, segment: seg });
    }
  }
  return results;
}

/**
 * Extract -m/--message payloads from a git commit segment for AI-attribution
 * scanning. Handles -m "msg", -m'msg', --message=msg. Returns raw strings.
 */
export function extractCommitMessages(segment: string): string[] {
  const out: string[] = [];
  // Handles: -m "msg", -m'msg', --message=msg, -m"msg", -mmsg (git accepts all)
  const re = /(?:-m|--message)\s*(=?\s*)("([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    out.push(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return out;
}

/**
 * Extract `gh pr create` title/body payloads for language checking.
 * Handles -t/--title and -b/--body in space, =, and quoted forms.
 * Returns the raw strings (title and body together; both must be English).
 */
export function extractPrTextFields(segment: string): string[] {
  const out: string[] = [];
  // Long options must be WHOLE flags followed by `=`/space (so `--template` /
  // `--body-file` do NOT match `--title`/`--body`). Short options accept space,
  // `=`, and the compact `-tVALUE` form (mirrors git's `-mmsg`). gh/pflag also
  // allow CLUSTERING the value-taking short flag after BOOLEAN shorthands. For
  // `gh pr create` those booleans are only -d(raft) -e(ditor) -f(ill) -w(eb),
  // so `-t`/`-b` may be preceded by `[defw]*` — constrained to the boolean set so
  // we don't misread a value-shorthand's argument (e.g. `-l t中文` = label "t中文").
  const long = /(?:^|\s)(?:--title|--body)(?:=|\s+)("([^"]*)"|'([^']*)'|(\S+))/g;
  const short = /(?:^|\s)-[defw]*[tb](?:=?\s*|)("([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = long.exec(segment)) !== null) out.push(m[2] ?? m[3] ?? m[4] ?? "");
  while ((m = short.exec(segment)) !== null) out.push(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}
