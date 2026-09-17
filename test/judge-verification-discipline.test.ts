/**
 * THE VERIFICATION DISCIPLINE — one rule, one home, six summary surfaces.
 *
 * 2026-09-17 (user decision): a judge READS the code and the diff. It does not
 * run tests, lint or external commands by default; a concrete doubt buys the
 * MINIMAL verification, and the finding says what was run and what it showed.
 *
 * Before this round every surface pushed the OPPOSITE default — "a reviewer
 * SHOULD verify by doing — mutation analysis included", "Run ONLY targeted
 * tests … and mutation checks on the specific code" — and five of the six
 * copies had no test watching them at all, so the one that actually reaches a
 * judge could have kept the old wording forever.
 *
 * `docs/judge-protocol.md` is the one substantive home. Its embedded copy
 * (`JUDGE_COMMON_PROTOCOL`) is pinned to the document by the F5 pin in
 * test/judge-prompt.test.ts, which is why this file asserts the section is
 * THERE rather than re-comparing the two texts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JUDGE_COMMON_PROTOCOL } from "../lib/judge-prompt.ts";
import { buildReviewPrompt, formatPrecommitBaseline } from "../lib/parallel-review.ts";
import { buildQualityAuditTask } from "../lib/quality-round.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
// Prose rewraps whenever a line is edited, so assertions run against a
// whitespace-flattened copy: they pin the WORDING, never the column width.
const flat = (s: string) => s.replace(/\s+/g, " ");

/** The wording this round removed — the negative scan must reject exactly it. */
const OLD_DEFAULT =
  /SHOULD verify by doing|verify by doing|mutation analysis included|mutation checks/i;

/**
 * The surfaces allowed to SUMMARISE the rule (and required to point at it).
 * The task named six COPIES; `lib/parallel-review.ts` carries two of them (its
 * module header and its per-round task text) inside one file, and the quality
 * round's task text is the same kind of renderer — so six FILES hold them all,
 * and the count below is those files.
 */
const SURFACES: [string, string][] = [
  ["AGENTS.md", read("AGENTS.md")],
  ["agents/reviewer.md", read("agents", "reviewer.md")],
  ["lib/parallel-review.ts", read("lib", "parallel-review.ts")],
  ["lib/quality-round.ts", read("lib", "quality-round.ts")],
  ["skills/review-loop/SKILL.md", read("skills", "review-loop", "SKILL.md")],
  ["README.md", read("README.md")],
];

test("the rule has ONE substantive home, and the embedded protocol carries it", () => {
  const doc = flat(read("docs", "judge-protocol.md"));
  assert.match(doc, /## 验证纪律：默认只读代码，非必要不跑命令/, "the section exists under its own heading");
  // The four claims that make it a rule rather than a sentiment — every one of
  // them answers a different way a judge drifts back to "just run it".
  assert.match(doc, /默认动作是读/, "…defaulting to reading");
  assert.match(doc, /不跑测试、不跑 lint、不跑外部命令/, "…naming what is NOT run by default");
  assert.match(doc, /具体的怀疑/, "…and what buys a run");
  assert.match(doc, /最小的代价把它验掉|最小的验证/, "…at minimal cost");
  assert.match(doc, /跑了什么、看到什么/, "…reported in the finding");
  assert.match(doc, /\$TMPDIR/, "…in a throwaway copy when it does run");
  assert.match(doc, /不算审查动作/, "…and running is not what a READY requires");
  // The judge's own system prompt carries the section: a rule only the docs
  // mention never reaches the pane.
  assert.match(JUDGE_COMMON_PROTOCOL, /## 验证纪律/, "the embedded protocol carries the same section");
});

test("every surface points at the rule's home and names the section", () => {
  assert.equal(
    SURFACES.length,
    6,
    "all six summary surfaces are in the scan — dropping one is how it silently stops being checked",
  );
  for (const [file, src] of SURFACES) {
    const text = flat(src);
    assert.ok(text.length > 2000, `${file}: the window is the whole file, not a fragment`);
    assert.match(text, /docs\/judge-protocol\.md|judge-protocol\.md/, `${file} must point at the rule's home`);
    assert.match(text, /验证纪律/, `${file} must name the section it points at`);
  }
});

test("no surface still teaches the removed default", () => {
  // Self-proof first: a negative scan whose pattern matches nothing is a
  // green light that means nothing. This is the wording the round replaced.
  assert.match(
    "a reviewer SHOULD verify by doing — mutation analysis included",
    OLD_DEFAULT,
    "the negative scan has teeth: it matches the wording this round removed",
  );
  for (const [file, src] of SURFACES) {
    assert.doesNotMatch(src, OLD_DEFAULT, `${file} must not keep the old default (run tests / mutation checks)`);
  }
});

test("the reviewer's own task text carries the discipline, not the old default", () => {
  // Rendered output, not the source text: this is the string a judge reads.
  const prompt = buildReviewPrompt("review", ["src/a.ts"], undefined, undefined, {
    streamPath: "/repo/.pi/review-stream/r.jsonl",
    commitRange: "a..b",
  });
  assert.match(prompt, /run nothing by default/);
  assert.match(prompt, /MINIMAL verification/);
  assert.match(prompt, /docs\/judge-protocol\.md/);
  assert.doesNotMatch(prompt, /mutation/);
  // Only the DEFAULT changed: the throwaway-copy mechanics and their advisory
  // status stay, because a doubt still has to be settled somewhere.
  assert.match(prompt, /THROWAWAY worktree under \$TMPDIR/);
  assert.match(prompt, /ADVISORY/);

  const block = formatPrecommitBaseline({
    verdict: "PASS",
    mode: "full",
    testScope: "full",
    at: "2026-09-17T00:00:00.000Z",
    steps: [],
  });
  assert.match(block.replace(/\s+/g, " "), /run ONLY the targeted test that settles it/);
  assert.doesNotMatch(block, /mutation/);
});

test("the quality round's task text carries it too", () => {
  const task = buildQualityAuditTask({
    range: "a..b",
    files: ["lib/a.ts"],
    streamPath: "/tmp/s.jsonl",
    rulesPath: "docs/code-quality-rules.md",
  });
  assert.match(task, /run nothing by default|concrete doubt/);
  assert.match(task, /docs\/judge-protocol\.md/);
  assert.doesNotMatch(task, /To try something/);
  // Still the throwaway copy when it does run.
  assert.match(task, /THROWAWAY worktree under \$TMPDIR/);
});
