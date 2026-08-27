/**
 * Pure planning logic for the precommit runner — no filesystem writes, no
 * process spawning, so every rule here is exhaustively unit-testable.
 *
 * Two questions are answered:
 *
 *  1. WHICH TESTS does a `fast` run have to execute?  (`testScope`)
 *     `fast` is the gate a `git commit` needs; `full` is the gate a
 *     `git push` / `gh pr create` needs. Running the whole suite on every
 *     commit is what made the loop unusable on large repos (a 672-file
 *     serial jest suite = 4-5 min per round), so `fast` narrows the suite to
 *     the tests RELATED to the changed files and leaves the complete run to
 *     `full`. Nothing is weakened: a fast PASS can never authorize a push.
 *
 *  2. WHICH INPUTS does a step depend on?  (`stepInputScope`)
 *     Used by the per-step result cache. A step whose inputs are unchanged
 *     may reuse its previous PASS instead of re-running. The scope is
 *     deliberately conservative: only steps that provably do not consume
 *     documentation files get `"code-only"`, everything else gets `"all"`
 *     (= any worktree change busts the cache).
 *
 * FAIL-SAFE DIRECTION. Every uncertainty here resolves toward MORE work, not
 * less: an unrecognized test runner yields `testScope: "skipped"` for the fast
 * lane (so `full` remains the only thing that can ship), and an unrecognized
 * step yields cache scope `"all"` (so its cache busts on any change).
 */

/** Test scopes a run can report. `full` is the only one a push/PR accepts. */
export const TEST_SCOPES = Object.freeze(["related", "full", "skipped"]);

/**
 * Documentation-ish paths that provably cannot change the result of a
 * typecheck / build / test step.
 *
 * Deliberately NARROW. `.mdx` is absent because bundlers compile it; `docs/`
 * is not excluded wholesale because a `docs/` tree routinely holds real code
 * (examples, scripts, type definitions) — only the file EXTENSION decides.
 */
const DOC_FILE_RE = /\.(?:md|markdown|txt|png|jpe?g|gif|svg|webp|ico|pdf)$/i;
const DOC_BASENAME_RE = /^(?:LICENSE|LICENCE|COPYING|CHANGELOG|NOTICE|AUTHORS)(?:\.[A-Za-z]+)?$/;

/**
 * Frameworks that compile Markdown into the shipped artifact. When one of
 * these is present, `.md` is a BUILD INPUT and the doc exclusion above would
 * be wrong, so every step falls back to `"all"`.
 */
const MD_CONSUMING_CONFIG_RE =
  /^(?:next\.config\.[cm]?[jt]s|astro\.config\.[cm]?[jt]s|docusaurus\.config\.[cm]?[jt]s|gatsby-config\.[cm]?[jt]s|nuxt\.config\.[cm]?[jt]s|mkdocs\.ya?ml|\.vitepress|vuepress\.config\.[cm]?[jt]s)$/;

/**
 * Linters/formatters that routinely process Markdown. A `lint` step running
 * one of these DOES consume docs, so its cache must bust on a `.md` change.
 * (`mwts`/`gts` are included even though they wrap eslint on TS only: their
 * bundled prettier config has historically covered Markdown, and guessing
 * wrong here means a silently reused PASS.)
 */
const DOC_TOUCHING_TOOL_RE =
  /\b(?:prettier|biome|markdownlint|remark|dprint|mwts|gts|textlint|cspell|eslint)\b|\.md\b/i;

/** Steps whose inputs are code only — provided no Markdown-consuming framework. */
const CODE_ONLY_STEPS = new Set(["typecheck", "build", "test"]);

/** True when `file` (repo-root-relative) is documentation, not build input. */
export function isDocFile(file) {
  if (typeof file !== "string" || file === "") return false;
  const base = file.split("/").pop() ?? file;
  return DOC_FILE_RE.test(base) || DOC_BASENAME_RE.test(base);
}

/**
 * Cache-input scope for one step.
 *
 * `"code-only"` — documentation changes do not bust this step's cache.
 * `"all"`       — any worktree change busts it (the conservative default).
 *
 * @param {string} stepName          declared step name (lint/typecheck/build/test/…)
 * @param {string} command           the command line that will run
 * @param {boolean} mdConsumingBuild repo builds Markdown into its artifact
 */
export function stepInputScope(stepName, command, mdConsumingBuild) {
  if (mdConsumingBuild) return "all";
  if (!CODE_ONLY_STEPS.has(stepName)) return "all";
  // A "test"/"build" script that itself runs a Markdown-aware tool (a repo
  // whose `test` script chains lint, say) must not get the narrow scope.
  if (typeof command === "string" && DOC_TOUCHING_TOOL_RE.test(command)) return "all";
  return "code-only";
}

/** True when any root-level entry marks a Markdown-consuming framework. */
export function detectsMdConsumingBuild(rootEntries) {
  if (!Array.isArray(rootEntries)) return false;
  return rootEntries.some((e) => typeof e === "string" && MD_CONSUMING_CONFIG_RE.test(e));
}

/**
 * Minimal POSIX-ish tokenizer: splits on unquoted whitespace and strips one
 * level of quoting. Enough for reading a package.json script body, which is
 * authored by the project and not adversarial input.
 */
export function splitTokens(input) {
  if (typeof input !== "string") return [];
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || cur !== "") { out.push(cur); cur = ""; has = false; }
      continue;
    }
    if (c === "\\" && i + 1 < input.length) { cur += input[++i]; continue; }
    cur += c;
  }
  if (has || cur !== "") out.push(cur);
  return out;
}

/**
 * Shell metacharacters that make a script body more than one simple command.
 *
 * A NEWLINE counts: npm script bodies may contain them, and `/bin/sh` runs each
 * line as its own command. Without it a body like `jest` followed by a second
 * line was treated as ONE jest invocation — so flags belonging to a different
 * command could be read as jest's own (and, for the `.pi` injection, could send
 * `--showConfig` after the wrong config).
 */
const COMPOUND_RE = /(?:&&|\|\||[|;<>\n\r]|\$\(|`)/;

/**
 * Parse a package.json test script into the pieces the fast lane needs.
 *
 * Returns `null` when the body is a COMPOUND command (`a && b`, pipes,
 * substitutions): rewriting such a script cannot be done safely, so the caller
 * falls back to `skipped`.
 *
 * @returns {null | {env: string[], bin: string, runner: string, flags: string[], positionals: string[]}}
 */
export function parseTestScript(body) {
  if (typeof body !== "string" || body.trim() === "") return null;
  if (COMPOUND_RE.test(body)) return null;

  const tokens = splitTokens(body);
  if (tokens.length === 0) return null;

  // Leading `KEY=value` assignments belong to the command's environment and
  // must be preserved verbatim — a suite keyed on TEST_ENV breaks without them.
  const env = [];
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) env.push(tokens[i++]);

  // `cross-env FOO=bar jest …` — same meaning, different spelling.
  if (i < tokens.length && /(?:^|\/)cross-env$/.test(tokens[i])) {
    i++;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) env.push(tokens[i++]);
  }

  if (i >= tokens.length) return null;
  const bin = tokens[i++];
  const base = bin.split("/").pop() ?? bin;

  let runner = "unknown";
  if (/^jest$/.test(base)) runner = "jest";
  else if (/^vitest$/.test(base)) runner = "vitest";
  else if (/^node$/.test(base) && tokens.slice(i).some((t) => t === "--test")) runner = "node-test";

  const flags = [];
  const positionals = [];
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      flags.push(t);
      // `--flag value` (as opposed to `--flag=value`): keep the value with it.
      if (!t.includes("=") && i + 1 < tokens.length && !tokens[i + 1].startsWith("-") &&
          FLAGS_TAKING_VALUE.has(t)) {
        flags.push(tokens[++i]);
      }
      continue;
    }
    positionals.push(t);
  }
  return { env, bin, runner, flags, positionals };
}

/**
 * Flags whose value is a SEPARATE argument. Anything not listed is assumed to
 * be a boolean flag, so a stray value would be read as a positional — which
 * only ever widens the recorded path filter, never narrows it.
 */
const FLAGS_TAKING_VALUE = new Set([
  "--config", "-c", "--maxWorkers", "-w", "--testTimeout", "--reporters",
  "--testPathPattern", "--testPathPatterns", "--testNamePattern", "-t",
  "--roots", "--rootDir", "--shard", "--selectProjects", "--project",
]);

/**
 * Flags that decide WHICH jest configuration is in effect.
 *
 * `jest --showConfig` run bare answers for the DEFAULT config. If the test
 * script selects another one (`--config custom.json`, `--selectProjects api`,
 * `--rootDir src`), the patterns we read come from a config the real run never
 * uses — and injecting them back as CLI `--testPathIgnorePatterns` would
 * OVERRIDE the config that is actually in effect. Rather than reproduce the
 * selection (see `hasJestConfigSelection`), a command carrying any of these is
 * left alone.
 */
const CONFIG_SELECTING_FLAGS = new Set([
  // Verified against jest-cli's own `build/args.js`: these are the options that
  // decide WHICH config/projects a run uses. `--ignoreProjects` belongs here for
  // the same reason as `--selectProjects` — it changes the effective project set.
  "--config", "-c", "--rootDir", "--roots",
  "--selectProjects", "--ignoreProjects", "--project", "--projects",
]);

/**
 * Does this jest command select a configuration explicitly?
 *
 * DELIBERATELY A BOOLEAN, not an argv fragment to replay. Forwarding the
 * selection to `--showConfig` means reimplementing jest's own CLI parsing
 * (single vs variadic values, `--flag=value`, `--` end-of-options, values that
 * look like paths), and every divergence sends the query at a DIFFERENT config
 * than the run uses — which is exactly the failure the merge exists to avoid.
 * Four consecutive review rounds each found another such divergence.
 *
 * So the contract is narrowed instead: the merge is attempted ONLY when the
 * command uses default config discovery, where a bare `jest --showConfig`
 * provably describes the same configuration. Anything explicit is skipped with
 * a recorded reason — no guess, no override of the repo's own patterns.
 *
 * @param {string[]} tokens `splitTokens(scriptBody)`
 */
export function hasJestConfigSelection(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  for (const token of list) {
    if (typeof token !== "string") continue;
    // `--` ends jest's own options: what follows are path filters for the
    // tests, so a `--config` there is not jest's configuration.
    if (token === "--") return false;
    const eq = token.indexOf("=");
    const base = eq === -1 ? token : token.slice(0, eq);
    if (CONFIG_SELECTING_FLAGS.has(base)) return true;
  }
  return false;
}

/** Flags that must NOT be carried into a narrowed run. */
const DROPPED_FLAGS = new Set([
  // Coverage thresholds are computed over the WHOLE suite; a narrowed run
  // would fail them for a reason that has nothing to do with the change.
  "--coverage", "--collectCoverage",
  // Path filters are replaced by the explicit file list we compute ourselves.
  "--testPathPattern", "--testPathPatterns", "--onlyChanged", "--changedSince",
  "--listTests", "--passWithNoTests", "--findRelatedTests", "--runTestsByPath",
]);

/** Strip flags that conflict with an explicit, narrowed file list. */
export function narrowableFlags(flags) {
  const out = [];
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const name = f.split("=")[0];
    if (DROPPED_FLAGS.has(name) || /^--collectCoverageFrom/.test(name)) {
      // Skip its separate value too, when it has one.
      if (!f.includes("=") && FLAGS_TAKING_VALUE.has(name) && i + 1 < flags.length &&
          !flags[i + 1].startsWith("-")) i++;
      continue;
    }
    out.push(f);
  }
  return out;
}

/**
 * Keep only the related tests that also live under the ORIGINAL script's path
 * filter.
 *
 * This intersection is done HERE, not by the test runner: jest's
 * `--testPathPattern` is ignored when `--findRelatedTests` is present
 * (verified against jest 29 — the listed set was identical with and without
 * it), so a repo whose script is `jest test/unit` would otherwise have its
 * fast lane silently widened to suites the project never runs there
 * (integration/e2e), which need services a commit-time check must not require.
 *
 * @param {string[]} related      absolute or repo-relative test paths
 * @param {string[]} positionals  the original script's path filters (may be [])
 * @param {string}   cwd          run directory, to relativize absolute paths
 */
export function intersectWithScriptPaths(related, positionals, cwd) {
  if (!Array.isArray(related)) return [];
  const cleaned = related.filter((p) => typeof p === "string" && p.trim() !== "");
  if (!Array.isArray(positionals) || positionals.length === 0) return cleaned;
  const prefix = typeof cwd === "string" && cwd !== "" ? (cwd.endsWith("/") ? cwd : `${cwd}/`) : "";
  return cleaned.filter((p) => {
    const rel = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
    // The originals are jest path PATTERNS (regexes matched against the full
    // path). Matching them as regexes keeps `test/(unit|service)` working;
    // an invalid regex degrades to a literal substring test.
    return positionals.some((pat) => {
      try {
        return new RegExp(pat).test(rel) || new RegExp(pat).test(p);
      } catch {
        return rel.includes(pat) || p.includes(pat);
      }
    });
  });
}

/** Source extensions a JS/TS test runner can map to tests. */
const SOURCE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/;

/** True when the changed-file list contains something a JS runner can relate. */
export function hasRelatableSources(files) {
  return Array.isArray(files) && files.some((f) => typeof f === "string" && SOURCE_EXT_RE.test(f));
}

/**
 * Build the fast-lane test plan.
 *
 * @param {object}   o
 * @param {object|null} o.parsed        parseTestScript() result for the chosen script
 * @param {string[]} o.changedFiles     repo-root-relative changed paths
 * @param {string}   o.fullCommand      the unnarrowed command (`npm run test`)
 * @param {(bin: string) => string|null} o.resolveBin  locate a runner binary
 * @param {string[]} [o.tokens]          raw `splitTokens(body)`, so an explicit
 *                                      jest config selection can be detected
 * @returns {{testScope: string, command: string|null, listCommand: string|null,
 *            positionals: string[], reason: string}}
 *   `listCommand` non-null ⇒ the caller must run it to enumerate related tests
 *   and then build the final command with {@link runTestsByPathCommand}.
 */
export function planFastTests({ parsed, changedFiles, fullCommand, resolveBin, tokens }) {
  const skip = (reason) => ({ testScope: "skipped", command: null, listCommand: null, positionals: [], reason });

  if (!parsed) return skip("test script is not a single simple command");
  // A script that selects its own jest config cannot be narrowed: the
  // enumeration (`--listTests --findRelatedTests`) would run under the DEFAULT
  // config, and the related set it produces would then be executed as if it
  // came from the real one. Skipping costs a full run — the module's documented
  // fail-safe direction — whereas guessing runs the wrong set of tests.
  if (parsed.runner === "jest" && hasJestConfigSelection(tokens)) {
    return skip("jest command selects its own config; narrowing would enumerate under a different one");
  }
  if (!Array.isArray(changedFiles)) return skip("changed files unavailable");
  if (changedFiles.length === 0) return skip("no changed files to relate tests to");

  const sources = changedFiles.filter((f) => SOURCE_EXT_RE.test(f));
  if (sources.length === 0) return skip("no JS/TS sources among the changed files");

  const bin = typeof resolveBin === "function" ? resolveBin(parsed.runner) : null;
  if (!bin) return skip(`test runner "${parsed.runner}" not resolvable`);

  const flags = narrowableFlags(parsed.flags);
  const env = parsed.env.join(" ");
  const pre = env ? `${env} ` : "";

  if (parsed.runner === "jest") {
    // Two-step: enumerate first (cheap — measured ~0.5s on a 989-test repo),
    // intersect with the script's own path filter, then run by exact path.
    const listCommand =
      `${pre}${bin} --listTests --findRelatedTests ${sources.map(shellQuote).join(" ")} --passWithNoTests`;
    return {
      testScope: "related",
      command: null,
      listCommand,
      positionals: parsed.positionals,
      reason: `jest --findRelatedTests over ${sources.length} changed source file(s)`,
      env: pre,
      bin,
      flags,
    };
  }

  if (parsed.runner === "vitest") {
    // vitest's own `related` subcommand already restricts to the project's
    // configured include patterns, so no intersection step is needed.
    const command =
      `${pre}${bin} related --run ${flags.join(" ")} ${sources.map(shellQuote).join(" ")}`.replace(/\s+/g, " ").trim();
    return {
      testScope: "related",
      command,
      listCommand: null,
      positionals: parsed.positionals,
      reason: `vitest related over ${sources.length} changed source file(s)`,
    };
  }

  // `node --test` has no dependency graph. Anything else is unknown.
  void fullCommand;
  return skip(`no related-test strategy for runner "${parsed.runner}"`);
}

/** Final jest command once the related set has been enumerated and filtered. */
export function runTestsByPathCommand({ env, bin, flags, files, ignore = "" }) {
  const parts = [env ?? "", bin, ...(flags ?? []), "--runTestsByPath", ...files.map(shellQuote)];
  if (ignore) parts.push(ignore);
  return parts.filter((p) => p !== "" && p !== undefined).join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Build the jest CLI `--testPathIgnorePatterns` argument list: the repo's
 * OWN existing patterns (from `jest --showConfig`) plus the gate's `.pi`
 * exclusion, so a full/fast jest run never scans `.pi/review-snapshots/`
 * (repo-local fallback layout; the default `~/.pi/review-snapshots/` is
 * outside the repo, so whole-tree discovery cannot reach it at all —
 * disposable review copies whose test files would otherwise be executed).
 *
 * Pure: the caller is responsible for obtaining `existingPatterns` (via
 * `jest --showConfig`) and for deciding whether injection may happen at all
 * (see `maybeInjectJestIgnore`).
 */

/**
 * Trim captured output to a receipt-safe tail: the last `maxLines` lines AND
 * at most `maxBytes` bytes.
 *
 * The line bound alone is not a bound. One un-newlined 64 MiB line is still
 * one line, so a receipt built from it is ~64 MiB — and the extension refuses
 * any receipt over 1 MiB, which turns a genuinely PASSING run into ERROR. The
 * byte bound is what makes the receipt a BOUNDED summary in all cases.
 *
 * Cutting by bytes can land mid-character, so leading UTF-8 continuation bytes
 * are dropped rather than decoded into U+FFFD.
 *
 * @param {string} text
 * @param {{maxLines?: number, maxBytes?: number}} [limits]
 */
export function boundedTail(text, limits = {}) {
  const maxLines = limits.maxLines ?? 40;
  const maxBytes = limits.maxBytes ?? 16 * 1024;
  if (typeof text !== "string" || text === "") return "";
  const byLines = text.split("\n").slice(-maxLines).join("\n");
  const buf = Buffer.from(byLines, "utf8");
  if (buf.length <= maxBytes) return byLines;
  const tail = buf.subarray(buf.length - maxBytes);
  let start = 0;
  while (start < tail.length && (tail[start] & 0xc0) === 0x80) start++;
  return tail.subarray(start).toString("utf8");
}

/**
 * Bounded capture of a step's output.
 *
 * Extracted as a pure unit because its rules are easy to get subtly wrong and
 * expensive to test through a real 64 MiB run:
 *
 *  1. the cap counts RAW BYTES, taken from the chunk, not the decoded string.
 *     A decoded JS string is UTF-16 code units, so CJK output (3 bytes per
 *     unit) would let ~3x the cap through.
 *  2. the decoder REMAINDER is appended even after truncation. It is at most a
 *     few bytes of a character the child was killed inside, and dropping it
 *     silently is how the last line of an aborted run goes missing.
 *  3. the cap is a CHUNK-BOUNDARY bound, not a hard ceiling: the chunk that
 *     crosses it is kept whole (it is already in memory, and cutting it would
 *     split a line, or a surrogate pair, for no benefit), so the captured text
 *     may exceed `maxBytes` by at most one chunk plus the marker. What must be
 *     strictly bounded is what LEAVES here — see `boundedTail`, which caps the
 *     receipt and cache copies in bytes.
 *
 * `onText` receives every accepted fragment so the caller can stream it.
 *
 * @param {number} maxBytes
 * @param {(fragment: string) => void} [onText]
 */
export function createCaptureAccumulator(maxBytes, onText = () => {}) {
  let text = "";
  let bytes = 0;
  let truncated = false;
  const accept = (fragment) => {
    if (fragment === "") return;
    text += fragment;
    onText(fragment);
  };
  return {
    /** Feed one decoded chunk together with the BYTE length it came from. */
    push(byteLength, decoded) {
      if (truncated) return;
      bytes += byteLength;
      accept(decoded);
      if (bytes > maxBytes) {
        truncated = true;
        accept(`\n…[output truncated at ${Math.round(maxBytes / (1024 * 1024))}MB]…\n`);
      }
    },
    /** Append a decoder remainder — deliberately allowed after truncation. */
    flush(remainder) { accept(remainder); },
    get text() { return text; },
    get bytes() { return bytes; },
    get truncated() { return truncated; },
  };
}

export function jestIgnoreArgs(existingPatterns, extra = "<rootDir>/.pi/") {
  const all = Array.isArray(existingPatterns) ? [...existingPatterns] : [];
  // EXACT match, never a substring: a repo pattern that merely CONTAINS `.pi`
  // (`<rootDir>/.pipeline/`, `.pixi/`, `spec/.pixel/`) is not our exclusion, and
  // treating it as one would silently leave `.pi/review-snapshots/` in the test
  // scan — the exact failure this injection exists to prevent. The reverse
  // mistake is harmless: a redundant-but-equivalent pattern only costs a
  // duplicate CLI arg, so the tie is broken toward always excluding.
  if (!all.includes(extra)) all.push(extra);
  return all.map((p) => `--testPathIgnorePatterns ${shellQuote(p)}`).join(" ");
}

/**
 * Inject the jest ignore args into a step command, subject to the safety
 * boundary: ONLY a single simple jest command (per `parseTestScript`) is ever
 * rewritten — compound scripts, non-jest runners and missing ignore args are
 * left untouched with a recorded reason. The npm package manager passes
 * arguments to a script through ` -- `; bun/yarn/pnpm forward them directly.
 *
 * @returns {{command: string, injected: boolean, reason?: string}}
 */
export function maybeInjectJestIgnore({ command, body, pm, ignoreArgs }) {
  const parsed = parseTestScript(body);
  if (parsed?.runner !== "jest") {
    return { command, injected: false, reason: "test script is not a single jest command" };
  }
  if (!ignoreArgs) {
    return { command, injected: false, reason: "jest ignore injection unavailable (see showConfig note)" };
  }
  const sep = pm === "npm" ? " -- " : " ";
  return { command: `${command}${sep}${ignoreArgs}`, injected: true };
}


/** Single-quote a path for `bash -c`. */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
