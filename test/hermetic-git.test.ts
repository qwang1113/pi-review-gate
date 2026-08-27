/**
 * Regression guard for the hermetic-git contract (test/helpers/git.ts).
 *
 * Why this file exists: the neutralisation it guards is INVISIBLE on a machine
 * whose global git config is already harmless. Drop `env: hermeticGitEnv()`
 * from a fixture wrapper and every test still passes — the commits simply
 * start signing again, silently costing ~0.17s each and heating gpg-agent.
 * A reviewer proved exactly that by mutation, so the contract needs a test
 * that fails on the mutation instead of a comment asking people to remember.
 *
 * Two guards, deliberately different in kind:
 *  1. STATIC — every git-spawning test file must carry a neutralisation, so a
 *     removal (or a NEW file that forgets one) fails here. Its reach is its
 *     detector: `SPAWNS_GIT` matches the child_process spawn forms with a
 *     literal `git` argument. A spawn built from a variable (`execFileSync(bin,
 *     …)`) is invisible to it — the behavioural half below is what keeps such a
 *     gap from being silent forever.
 *  2. BEHAVIOURAL — under a deliberately hostile global config the helper must
 *     still commit, and the same commit without the helper must fail. That is
 *     what proves the static marker is not merely cosmetic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { git, hermeticGitEnv, HERMETIC_GIT_CONFIG_ENV } from "./helpers/git.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIR, "..");

/**
 * Spawns git directly (as opposed to merely mentioning it in a string).
 *
 * Deliberately broad: the quote style, the child_process function and the
 * whitespace between them are all free choices a future edit may make, and a
 * detector that only knows today's shape would wave the next one through.
 * `execSync`/`exec` take a command STRING with the binary inside it, while the
 * File-variants pass the binary as their own first argument — both shapes are
 * matched here.
 */
const SPAWNS_GIT = /(?:execFileSync|execFile|spawnSync|execSync|exec|spawn)\s*\(\s*(?:"git["\s,)]|'git['\s,)]|`git[`\s])/;

/**
 * Accepted neutralisations, in the two shapes the suite actually uses:
 * the shared helper (any of its exports) or a file-local hermetic env /
 * explicit `-c commit.gpgsign=false`, which predate it.
 */
const NEUTRALISED = [
  /neutraliseHostGitConfig\(\)/,
  /hermeticGitEnv\(/,
  /\bhermeticGit\(/,
  /HERMETIC_ENV/,
  /commit\.gpgsign=false/,
];

/**
 * A raw spawn may opt out ON ITS OWN LINE with this marker. It exists for the
 * counterfactuals in THIS file: a proof that an un-neutralised commit fails
 * has to spawn git un-neutralised, so it must be exempt — but visibly, one
 * line at a time, never by excusing a whole file.
 */
const INTENTIONAL_RAW = "hermetic-guard: intentional-raw";

/**
 * How far after a spawn the call's own options may reasonably live.
 *
 * Kept DELIBERATELY TIGHT, and the reasoning matters because a wider window
 * once looked free: the window also stops at the next spawn, which was read as
 * a second safety bound. It is not. That bound only stops a LATER SPAWN's
 * options from vouching for this one; a `hermeticGitEnv()` sitting in ordinary
 * non-spawn code between them has no such bound, and a 1200-char window let
 * exactly that happen — an intentionally raw spawn in this very file was
 * "cleared" by an unrelated call 18 lines below, turning its opt-out marker
 * into dead code and making the guard believe a raw spawn was neutralised.
 *
 * So the only real bound is this number, and it must err small: every
 * legitimately neutralised call in the suite carries its token within ~300
 * characters of the spawn, while too small merely produces a LOUD false
 * violation that a marker or a reordered option clears. Too large produces a
 * SILENT false acceptance — the failure this file exists to prevent.
 */
const CALL_WINDOW_CHARS = 400;

/**
 * The guard asks two questions of a file, and they have OPPOSITE safe answers.
 * Keeping them apart is what makes it trustworthy:
 *
 *  1. "Is there a git spawn here?" — asked of the RAW source, never of a
 *     filtered copy. Anything that hides text from this question can hide a
 *     real call, so nothing is allowed to. Four filtering schemes were tried
 *     and every one eventually blinded the guard on real code:
 *      - a block-comment regex took `/*` inside the string "copies
 *        agents/*.md …" as an opener and blanked ~500 lines, hiding 11 spawns;
 *      - a character scanner tracking string state was derailed by the regex
 *        literal `dep.replace(/^@.*?\//, "")`;
 *      - a line version with an `inBlock` flag was pinned on by a `/*` line
 *        inside a template literal, blanking everything after it;
 *      - a stateless line version still blanked comment-looking lines, so a
 *        call split across them stayed invisible.
 *     Reading the raw text ends the whole category. The cost is a false
 *     POSITIVE when a comment quotes a complete spawn — loud, and cleared by
 *     one `intentional-raw` marker.
 *
 *  2. "Is this spawn neutralised?" — asked of `codeOnly()`, which blanks a line
 *     from its first `//` or `/*` onwards. That is deliberately MORE than a
 *     parser would blank: a `//` inside a string, or code written after a
 *     block-comment closer, is blanked too.
 *
 *     The over-blanking is the point, because it makes the safety property
 *     structural instead of a claim about parsing. Blanking more can only
 *     WITHHOLD a neutralisation token, and a withheld token is a loud false
 *     violation that a marker or a line-break clears. It can never INVENT one,
 *     which is the failure that would matter: prose vouching for code, so that
 *     `// TODO: pass hermeticGitEnv() here` next to a raw spawn satisfies the
 *     file-level check and lands inside that spawn's window, silently clearing
 *     the very call it complains about.
 *
 * So neither answer depends on lexing JavaScript correctly, and neither depends
 * on cross-line state. Detection hides nothing; acceptance withholds freely.
 */

/**
 * `src` with commentary blanked from the first `//` or `/*` on each line, plus
 * whole lines that open or continue a comment. Length is preserved so the raw
 * text and this view share offsets.
 */
function codeOnly(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
        return " ".repeat(line.length);
      }
      // First comment opener of either kind wins; no exception for `://`,
      // because a truncated URL only costs a loud false violation while an
      // exception would let `env://hermeticGitEnv()` vouch for a raw spawn.
      const candidates = [line.indexOf("//"), line.indexOf("/*")].filter((i) => i !== -1);
      if (candidates.length === 0) return line;
      const cut = Math.min(...candidates);
      return line.slice(0, cut) + " ".repeat(line.length - cut);
    })
    .join("\n");
}


/** Character offsets of every git spawn in `src`, in source order. */
function spawnOffsets(src: string): number[] {
  const all = new RegExp(SPAWNS_GIT.source, "g");
  const offsets: number[] = [];
  for (let m = all.exec(src); m !== null; m = all.exec(src)) offsets.push(m.index);
  return offsets;
}

function testFiles(): string[] {
  return readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.mjs"))
    .sort();
}

test("every test file that spawns git neutralises the host git config", () => {
  const offenders: string[] = [];
  for (const file of testFiles()) {
    const raw = readFileSync(join(TEST_DIR, file), "utf8");
    // Detect on RAW text (nothing may hide a call); accept only on code.
    if (!SPAWNS_GIT.test(raw)) continue;
    if (!NEUTRALISED.some((re) => re.test(codeOnly(raw)))) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    "these files run real git with the developer's global config — a host "
      + "`commit.gpgsign=true` makes every fixture commit sign (slow tests, hot "
      + "gpg-agent), and `core.hooksPath`/`init.templateDir` can change what they "
      + "assert. Use test/helpers/git.ts (hermeticGitEnv / neutraliseHostGitConfig).",
  );
});

test("one intentional-raw marker excuses exactly one spawn", () => {
  // Round-3 Nit: the opt-out used to accept a marker on the line above
  // unconditionally, so a trailing marker on a spawn line vouched for BOTH
  // its own spawn and the next line's — one comment, two blind spots.
  const markerLine = `execFileSync("git", ["a"], { cwd: d }); // ${INTENTIONAL_RAW}`; // hermetic-guard: intentional-raw (fixture text)
  const nextLine = `execFileSync("git", ["b"], { cwd: d });`; // hermetic-guard: intentional-raw (fixture text)

  // The marker line carries a spawn itself, so it is spent there.
  assert.equal(SPAWNS_GIT.test(markerLine), true, "marker line spawns");
  assert.equal(SPAWNS_GIT.test(nextLine), true, "following line spawns");

  // A marker on a comment-only line above is NOT spent, so it may carry down.
  const commentOnlyMarker = `// ${INTENTIONAL_RAW}`;
  assert.equal(
    SPAWNS_GIT.test(commentOnlyMarker),
    false,
    "a comment-only marker line has no spawn of its own to be spent on",
  );
});


test("detection reads raw source, so nothing can hide a call", () => {
  // Four generations of this guard blinded themselves by filtering the text
  // before looking for spawns; each shape below is one of those incidents.
  //
  // What this pins, exactly: that `SPAWNS_GIT` still matches each historical
  // shape in unfiltered text. It does NOT pin the scans' input path — a future
  // edit that re-routes them through a filter would have to be caught by
  // review, not by this test. The scans read `raw` one line above their loops,
  // which is as close as a unit test can sit to that decision.
  const detect = (src: string) => SPAWNS_GIT.test(src);

  // Round 3: `/*` inside an ordinary string. The trailing comment supplies the
  // closer that made the historical regex swallow everything between them.
  const trapString = [
    `test("postinstall copies agents/*.md into ~/.pi/agent/agents/", () => {`,
    `  execFileSync("git", ["init"], { cwd: dir });`, // hermetic-guard: intentional-raw (fixture text)
    `});`,
    `/* a genuine comment further down, whose closer completes the bogus span */`,
  ].join("\n");
  assert.equal(detect(trapString), true, "a `/*` inside a string must not hide the code after it");

  // Round 3: a regex literal read as a string/comment delimiter.
  const trapRegex = [
    `const bare = dep.replace(/^@.*?\\//, "");`,
    `execFileSync("git", ["commit"], { cwd: dir });`, // hermetic-guard: intentional-raw (fixture text)
  ].join("\n");
  assert.equal(detect(trapRegex), true, "a regex literal must not hide the code after it");

  // Round 4: a comment-looking line INSIDE a template literal, which latched a
  // stateful stripper on and blanked the rest of the file.
  const trapTemplateBlock = [
    "const tpl = `",
    "/* this line is string content, not a comment opener",
    "`;",
    `execFileSync("git", ["commit"], { cwd: d });`, // hermetic-guard: intentional-raw (fixture text)
  ].join("\n");
  assert.equal(detect(trapTemplateBlock), true, "a `/*` line in a template literal must not hide later code");

  // Round 6/7: a call whose head line reads as commentary. A line-based filter
  // blanked the head and lost the whole call; raw detection sees it.
  const trapDisguisedSplit = [
    "const n = a",
    `  * execFileSync(`, // hermetic-guard: intentional-raw (fixture text)
    `      "git", ["commit"], { cwd: d });`,
  ].join("\n");
  assert.equal(detect(trapDisguisedSplit), true, "a split call with a commentary-looking head must not hide");
});

test("a neutralisation token in prose never vouches for code", () => {
  // The other direction: `codeOnly` must withhold tokens that appear only in
  // commentary, so a comment cannot clear a raw spawn. Over-blanking here is
  // safe — it can only produce a loud false violation, never a silent pass.
  const leading = [
    `// TODO: pass hermeticGitEnv() to the call below`,
    `execFileSync("git", ["commit"], { cwd: d });`, // hermetic-guard: intentional-raw (fixture text)
  ].join("\n");
  assert.equal(
    NEUTRALISED.some((re) => re.test(codeOnly(leading))),
    false,
    "a token in a whole-line comment must not count as neutralisation",
  );

  const trailing = `execFileSync("git", ["c"], { cwd: d }); // switch to hermeticGitEnv() someday`; // hermetic-guard: intentional-raw (fixture text)
  assert.equal(
    NEUTRALISED.some((re) => re.test(codeOnly(trailing))),
    false,
    "a token in a TRAILING comment must not count either",
  );

  // Round 8: the same trick with a block comment, and with a `://` in front of
  // it — both used to survive and vouch for the spawn on their own line.
  const inlineBlock = `execFileSync("git", ["c"], { cwd: d, env: process.env /* not hermeticGitEnv() */ });`; // hermetic-guard: intentional-raw (fixture text)
  assert.equal(
    NEUTRALISED.some((re) => re.test(codeOnly(inlineBlock))),
    false,
    "a token inside an inline /* */ comment must not count",
  );

  const afterColon = `execFileSync("git", ["c"], { cwd: d }); // env://hermeticGitEnv()`; // hermetic-guard: intentional-raw (fixture text)
  assert.equal(
    NEUTRALISED.some((re) => re.test(codeOnly(afterColon))),
    false,
    "a token after `://` must not count — no URL exception, on purpose",
  );

  // ...while a token that really is in code still counts. The trailing URL is
  // blanked along with the comment it sits in — over-blanking to the right of
  // the token is exactly the harmless direction.
  const real = `execFileSync("git", ["c"], { cwd: d, env: hermeticGitEnv() }); // see https://example.com/x`;
  assert.equal(
    NEUTRALISED.some((re) => re.test(codeOnly(real))),
    true,
    "a token in real code still counts even when a comment follows it",
  );

  // The cost of having no URL exception, stated as a test rather than hidden:
  // a token written to the RIGHT of a `//` inside a string is withheld. That is
  // a loud false violation, clearable by a marker or by moving the token.
  const tokenAfterSlashesInString = `const s = "a//b"; const e = hermeticGitEnv();`;
  assert.equal(
    NEUTRALISED.some((re) => re.test(codeOnly(tokenAfterSlashesInString))),
    false,
    "known cost: `//` inside a string withholds a later token — loud, never silent",
  );

  // Offsets must survive, or reported line numbers and windows drift.
  assert.equal(codeOnly(leading).length, leading.length);
  assert.equal(codeOnly(trailing).length, trailing.length);
  assert.equal(codeOnly(real).split("\n").length, real.split("\n").length);
});


test("the guard actually sees a file that spawns git without neutralisation", () => {
  // Guards that cannot fail are decoration: prove the detector fires on the
  // exact shape the previous test forbids, and stays quiet once fixed.
  const bare = `execFileSync("git", ["init"], { cwd: dir });`; // hermetic-guard: intentional-raw
  assert.equal(SPAWNS_GIT.test(bare), true, "detector must recognise a raw git spawn");
  assert.equal(NEUTRALISED.some((re) => re.test(bare)), false, "raw spawn must count as un-neutralised");

  const fixed = `execFileSync("git", ["init"], { cwd: dir, env: hermeticGitEnv() });`;
  assert.equal(NEUTRALISED.some((re) => re.test(fixed)), true, "helper use must count as neutralised");
});

test("every file the guard clears really does spawn git through a neutralised path", () => {
  // The file-level guard would accept a file that carries ONE helper call and
  // a dozen raw ones. Assert per call site instead: either the file neutralises
  // the whole process, or every raw `git` spawn opts in on its own.
  //
  // Scanning is offset-based, not line-based: `execFileSync(\n  "git", …` is
  // the same call spread over lines, and a line-based scan would either miss
  // the spawn or miss the `env:` that neutralises it.
  const violations: string[] = [];
  for (const file of testFiles()) {
    const raw = readFileSync(join(TEST_DIR, file), "utf8");
    // Two views, per the doctrine above: spawns are DETECTED in `raw` (nothing
    // may hide a call), the neutralisation token is only ACCEPTED from
    // `codeOnly` (prose may not vouch for code). `codeOnly` preserves length,
    // so both are indexed by the same offsets. The opt-out marker is read from
    // `raw` lines, since the marker itself lives in a comment.
    const code = codeOnly(raw);
    const rawLines = raw.split("\n");
    if (!SPAWNS_GIT.test(raw)) continue;
    if (/neutraliseHostGitConfig\(\)/.test(code)) continue; // process-wide: covers every site
    const offsets = spawnOffsets(raw);
    for (const [n, at] of offsets.entries()) {
      // The call's options object follows the spawn; take a generous window so
      // a multi-line call still shows its `env:`, and require neutralisation
      // inside it. The window stops at the next spawn so one neutralised call
      // cannot vouch for the raw call behind it.
      const end = Math.min(offsets[n + 1] ?? raw.length, at + CALL_WINDOW_CHARS);
      const line = raw.slice(0, at).split("\n").length;
      // The marker opts out ONE spawn: the one on its own line, or — for a
      // multi-line call that has no room for a trailing comment — the one on
      // the line below. A marker on a line that ALREADY carries a spawn is
      // spent on that spawn, so it cannot also vouch for the next line's.
      const own = rawLines[line - 1] ?? "";
      const above = rawLines[line - 2] ?? "";
      const aboveIsSpentOnItsOwnSpawn = SPAWNS_GIT.test(above);
      const exempt = own.includes(INTENTIONAL_RAW)
        || (above.includes(INTENTIONAL_RAW) && !aboveIsSpentOnItsOwnSpawn);
      if (exempt) continue;
      // Both strips preserve length, so the same offsets index `code`.
      const codeWindow = code.slice(at, end);
      if (!NEUTRALISED.some((re) => re.test(codeWindow))) violations.push(`${file}:${line}`);
    }
  }
  assert.deepEqual(violations, [], "raw git spawn sites without a hermetic env or explicit -c neutralisation");
});

// ---------------------------------------------------------------------------
// Behavioural: the marker must correspond to real protection.

/** A global git config as hostile as a real developer machine can be. */
function hostileGlobalConfig(dir: string): string {
  const path = join(dir, "hostile.gitconfig");
  writeFileSync(
    path,
    [
      "[commit]",
      "\tgpgsign = true",
      "[user]",
      // A key that cannot exist: signing MUST fail if it is ever consulted.
      "\tsigningkey = 0000000000000000000000000000000000000000",
      "[gpg]",
      "\tprogram = /nonexistent/gpg-that-cannot-run",
      "",
    ].join("\n"),
  );
  return path;
}

test("helper commits succeed under a hostile global config", () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-hermetic-ok-"));
  try {
    const hostile = hostileGlobalConfig(dir);
    const repo = join(dir, "repo");
    // The hostile config is what the host would inject; the helper must win.
    const withHostileHost = { GIT_CONFIG_GLOBAL: hostile, GIT_CONFIG_SYSTEM: hostile };
    const saved = { ...process.env };
    Object.assign(process.env, withHostileHost);
    try {
      execFileSync("git", ["init", "-q", repo], { cwd: dir, env: hermeticGitEnv(), stdio: "ignore" });
      git(repo, ["config", "user.email", "t@t"], { quiet: true });
      git(repo, ["config", "user.name", "t"], { quiet: true });
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
      git(repo, ["add", "-A"], { quiet: true });
      git(repo, ["commit", "-qm", "init"], { quiet: true });
      assert.match(git(repo, ["log", "-1", "--pretty=%s"]), /init/);
    } finally {
      for (const key of Object.keys(withHostileHost)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same commit WITHOUT the helper fails under that hostile config", () => {
  // The counterfactual: without this proof the test above could pass simply
  // because the hostile config never mattered.
  const dir = mkdtempSync(join(tmpdir(), "rg-hermetic-bad-"));
  try {
    const hostile = hostileGlobalConfig(dir);
    const repo = join(dir, "repo");
    const hostileEnv = { ...process.env, GIT_CONFIG_GLOBAL: hostile, GIT_CONFIG_SYSTEM: hostile };
    // hermetic-guard: intentional-raw — the hostile env IS the experiment here
    const run = (args: string[]) => execFileSync("git", args, { cwd: dir, env: hostileEnv, stdio: ["ignore", "ignore", "pipe"] }); // hermetic-guard: intentional-raw
    run(["init", "-q", repo]);
    const inRepo = (args: string[]) => execFileSync("git", args, { cwd: repo, env: hostileEnv, stdio: ["ignore", "ignore", "pipe"] }); // hermetic-guard: intentional-raw
    inRepo(["config", "user.email", "t@t"]);
    inRepo(["config", "user.name", "t"]);
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    inRepo(["add", "-A"]);
    assert.throws(
      () => inRepo(["commit", "-qm", "init"]),
      /gpg|sign/i,
      "a commit that inherits the hostile config must fail to sign — otherwise this file guards nothing",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the neutralising variables are the ones git actually honours", () => {
  // Guard the constant itself: a rename (or a typo) would silently disable
  // every call site while keeping all the markers the static guard looks for.
  assert.deepEqual({ ...HERMETIC_GIT_CONFIG_ENV }, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });

  const dir = mkdtempSync(join(tmpdir(), "rg-hermetic-vars-"));
  try {
    const hostile = hostileGlobalConfig(dir);
    const hostileEnv = { ...process.env, GIT_CONFIG_GLOBAL: hostile, GIT_CONFIG_SYSTEM: hostile };

    // Each lookup is judged on its OWN outcome. Sharing one try/catch let an
    // exit-1 from the FIRST lookup satisfy the "key is unset" branch meant for
    // the second, so the fixture-sanity assertion could be skipped entirely
    // and the test still passed while proving nothing.
    const lookup = (env: NodeJS.ProcessEnv): { status: number; value: string } => {
      try { // hermetic-guard: intentional-raw — env is the variable under test
        const out = execFileSync("git", ["config", "--get", "commit.gpgsign"], {
          cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        return { status: 0, value: String(out).trim() };
      } catch (err) {
        const e = err as { status?: number; stdout?: string };
        // `git config --get` exits 1 when the key is simply unset; anything
        // else (127, a crash) is a broken fixture, not an answer.
        assert.equal(e.status, 1, `git config failed unexpectedly: ${String(err)}`);
        return { status: 1, value: String(e.stdout ?? "").trim() };
      }
    };

    const hostileLookup = lookup(hostileEnv);
    assert.equal(hostileLookup.status, 0, "fixture sanity: the hostile config must be readable");
    assert.equal(hostileLookup.value, "true", "fixture sanity: the hostile config must be in effect");

    // The hermetic env must hide it: either an empty value or the unset exit.
    const hermeticLookup = lookup(hermeticGitEnv());
    assert.equal(hermeticLookup.value, "", "hermetic env must hide the host's commit.gpgsign");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ROOT and the helper live where this guard expects them", () => {
  // Cheap staleness check: if the layout moves, the scans above would quietly
  // stop covering anything.
  assert.equal(readFileSync(join(ROOT, "test", "helpers", "git.ts"), "utf8").includes("neutraliseHostGitConfig"), true);
  assert.ok(testFiles().length > 20, "test file discovery must not come back near-empty");
});
