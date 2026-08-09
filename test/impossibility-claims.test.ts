import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
// Prose re-wraps whenever a line is edited, so assertions run against a
// whitespace-flattened copy: they pin the WORDING, never the column width.
const flat = (s: string) => s.replace(/\s+/g, " ");

// --------------------------------------------------------------------------
// "That is impossible" is the cheapest way to smuggle a degraded implementation
// past a review: no layer in lib/ can tell whether an author's excuse was true,
// so the defense is prompt-level and lives in the judge/skill documents. These
// structural assertions pin the instruction so a later prompt edit cannot drop
// it silently.

test("reviewer treats an impossibility claim as a hypothesis to verify, not a fact", () => {
  const reviewer = read("agents", "reviewer.md");
  assert.match(reviewer, /^## "It can't be done" — verify the claim, never take it on trust$/m);
  assert.match(reviewer, /impossibility claim is a hypothesis, not a fact/);
  // The weak-model / small-thinking-budget failure mode is the stated reason.
  assert.match(reviewer, /weaker model|thinking budget/);
  assert.match(reviewer, /local optimum/);
});

test("reviewer is told where unlabeled impossibility claims hide", () => {
  const reviewer = flat(read("agents", "reviewer.md"));
  for (const clue of [
    /`TODO`, `FIXME`/, // code comments and ship prose
    /\.skip`\/`\.todo`\/`xfail`/, // suppressed tests
    /\[NIT_DEFERRED\]/, // deferral log
    /`\.pi\/loop-goal\.md` non-goals/, // non-goals born from "can't be done"
    /Handoff text, task descriptions/, // the author's own summary
    /"would require a rewrite"/, // the phrasing that usually carries the excuse
  ]) {
    assert.match(reviewer, clue, `reviewer must name this hunting ground: ${clue}`);
  }
});

test("reviewer must settle an impossibility claim with hard evidence, or say it did not", () => {
  const reviewer = flat(read("agents", "reviewer.md"));
  assert.match(reviewer, /Verify with hard evidence/);
  assert.match(reviewer, /node_modules/, "must prefer installed source over recalled API knowledge");
  assert.match(reviewer, /minimal counter-example/);
  assert.match(reviewer, /reproducible read-only command/);
  // Unverifiable is allowed, silence is not.
  assert.match(reviewer, /Never convert "I did not verify" into silent acceptance\./);
});

test("reviewer grades a refuted claim P1 when it degraded the change, P2 otherwise", () => {
  const reviewer = flat(read("agents", "reviewer.md"));
  const gradingAt = reviewer.indexOf("**Grading:**");
  assert.notEqual(gradingAt, -1, "reviewer must carry a grading block for impossibility claims");
  const grading = reviewer.slice(gradingAt);
  assert.match(grading, /degraded implementation, a skipped\/removed test, or a bypassed requirement ⇒ \*\*P1\*\*/);
  assert.match(grading, /stale comment[\s\S]{0,80}⇒ \*\*P2\*\*/);
  assert.match(grading, /Evidence insufficient in either direction ⇒ \*\*Note\*\*/);
  // Symmetry: the author's word never accepts, and the reviewer's hunch never blocks.
  assert.match(grading, /is \*\*never\*\*, on its own, sufficient/);
  assert.match(grading, /unverified hunch that "it should be possible" is a Note, not a P1/);
});

test("review-loop skill makes the main agent hand its impossible list to the reviewer", () => {
  const skill = read("skills", "review-loop", "SKILL.md");
  assert.match(skill, /Hand over your "impossible" list\./);
  assert.match(skill, /Do NOT hand over your justification as a conclusion/);
  // It belongs to the review step, ahead of the record step.
  const handover = skill.indexOf('Hand over your "impossible" list');
  const record = skill.indexOf("4. **Record**");
  const review = skill.indexOf("3. **Review**");
  assert.ok(review !== -1 && record !== -1, "skill protocol must keep its Review and Record steps");
  assert.ok(handover > review && handover < record, "handover instruction must sit inside the Review step");
});

test("README documents the impossibility-claim rule for users of the gate", () => {
  const readme = read("README.md");
  const heading = `### "It can't be done" is a hypothesis, not a finding-free pass`;
  const start = readme.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, "README must document the rule under its own heading");
  // Assert against THAT section only: a match elsewhere in a 1200-line README
  // would guard nothing.
  const rest = readme.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  const section = flat(end === -1 ? rest : rest.slice(0, end));
  assert.match(section, /agents\/reviewer\.md/, "section must point at the reviewer definition");
  assert.match(section, /skills\/review-loop/, "section must point at the main agent's handover duty");
  assert.match(section, /⇒ \*\*P1\*\* \(⇒ `BLOCKED`\)/, "section must state the P1 consequence");
});

test("the impossibility rule stays prompt-level: no new verdict JSON field", () => {
  const reviewer = read("agents", "reviewer.md");
  const verdictLine = reviewer
    .split("\n")
    .find((l) => l.includes('{"gate":') && l.includes("findings"));
  assert.ok(verdictLine, "reviewer must still document the verdict JSON shape");
  const cut = verdictLine!.indexOf('"findings"');
  const keysIn = (s: string) => [...s.matchAll(/"([A-Za-z_]+)":/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    keysIn(verdictLine!.slice(0, cut)),
    ["docSync", "gate"],
    "verdict schema must gain no extra top-level key beyond gate/docSync/findings",
  );
  assert.deepEqual(
    keysIn(verdictLine!.slice(cut)),
    ["file", "findings", "issue", "line", "severity"],
    "finding entries must keep their existing shape",
  );
});
