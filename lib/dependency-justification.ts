/**
 * DEPENDENCY JUSTIFICATION — the mechanical half of the minimalism doctrine
 * (2026-09-08, user decision), next to the other mechanical rule
 * (`lib/file-size-gate.ts`). The doctrine's substantive text lives ONLY in
 * `docs/coding-standards.md` §5 — this module implements its
 * "新依赖须论证" half mechanically, never restating the other three checks.
 *
 * THE ASYMMETRY IS THE DESIGN (same shape as the file-size gate). Whether a
 * new dependency is WORTH it needs judgement — that stays with the judges
 * (reviewer P1, goal/plan audit P0/P1). Whether a justification was WRITTEN
 * needs no judgement at all: the gate can check it mechanically, at the
 * checkpoint, where the whole shape of the round exists. So:
 *
 *   - NEW dependency with NO written justification .. HARD BLOCK (at checkpoint)
 *   - NEW dependency WITH a justification ........... passes (worth is judged)
 *
 * WHAT COUNTS AS NEW. A key in `dependencies` of the worktree's package.json
 * that is absent from the same file at the checkpoint BASE (HEAD — the same
 * base the file-size gate reads with `git cat-file -e HEAD:<path>`).
 * `devDependencies` do not count: a test/build-only addition is not shipped
 * code, and the reviewer judges its necessity. Removed entries do not count.
 * Version bumps of an existing key do not count. A repo with no package.json
 * change at all passes trivially. A base manifest that cannot be PARSED
 * yields no facts (never "everything is new"); only an ABSENT base (no
 * manifest at HEAD) treats every worktree key as new.
 *
 * WHAT COUNTS AS A JUSTIFICATION. The agent's round note (`note`, the same
 * text the checkpoint message is built from) OR the checkpoint message itself
 * names the dependency AND says why the existing code / installed deps cannot
 * cover it. Mechanically: the note-or-message text contains the dependency's
 * name (or a distinctive substring of it) together with at least one
 * justification marker — a WHY-word, not a bare mention. A bare mention
 * ("added lodash") is not a justification; "added lodash because …" is, and
 * whether the because convinces is the reviewer's job, not this module's.
 *
 * WHERE IT RUNS. At `review_checkpoint`, next to the file-size gate — not at
 * edit time (same reason: blocking mid-write fires on a half-written round).
 * The checkpoint already has both inputs: the worktree paths (for the
 * package.json diff) and the round note (for the justification text).
 *
 * Pure module: facts in, decisions out. The caller collects the facts from
 * git and from the round note.
 */

/** Words that mark a mention as a justification, not a bare name-drop. */
const JUSTIFICATION_MARKERS: readonly string[] = Object.freeze([
  // English why-words — each names a reason or a rejected alternative, never
  // a bare topic word ("why"/"missing" alone match changelogs, not reasons).
  "because",
  "instead of",
  "rather than",
  "cannot",
  "can't",
  "no existing",
  "nothing existing",
  "no built-in",
  // Chinese why-words — each is a causal or contrastive PHRASE. Bare topic
  // words （现有/已有/没有/缺少/不能/原因/由于/论证） match almost any Chinese
  // round note that names a dep, which made the "refuse" path dead in
  // practice (reviewer P2, 2026-09-08): a bare mention plus background prose
  // is not a justification.
  "因为",
  "无法做到",
  "无法覆盖",
  "做不到",
  "覆盖不了",
  "没有现成的",
  "现有.*做不到",
  "现有.*无法",
  "已有.*做不到",
  "不能覆盖",
  "代替不了",
  "取代不了",
  "不得不引入",
  "只能引入",
]);

/** What the caller measured: one dependency key added by this round. */
export interface NewDependencyFact {
  /** The dependency key, exactly as it appears in package.json. */
  name: string;
}

/**
 * What the caller passes: the texts that may carry the justification.
 *
 * The NOTE (the agent's own words, verbatim) is authoritative — L5 drops
 * non-Latin letters from the message, so a Chinese justification survives
 * only in the note (`submitForReview` plumbs it as `note: input.note`). The
 * message rides second (a direct checkpoint call with no note justifies in
 * English there). Both are searched together.
 */
export interface JustificationText {
  note: string;
  message: string;
}

export interface DependencyJustificationVerdict {
  /** Names the new dependency AND the way out — the checkpoint refuses these. */
  blocking: string[];
}

/**
 * Judge a batch of newly added dependencies against the justification texts.
 *
 * The blocking message names the missing justification AND where to put it,
 * because the useful response is one sentence in the round note, not a
 * smaller diff: write WHY the existing code / installed deps cannot cover it.
 */
export function dependencyJustificationVerdict(
  added: readonly NewDependencyFact[],
  text: JustificationText,
): DependencyJustificationVerdict {
  const haystack = `${text.note}\n${text.message}`.toLowerCase();
  const blocking: string[] = [];
  for (const dep of added) {
    const name = dep.name.toLowerCase().trim();
    if (!name) continue;
    // A scoped name (@scope/pkg) is justified by naming either half — the
    // agent writes "uuid" more often than "@uuid/v7", and demanding the exact
    // key would block justifications a human reviewer would accept.
    const fragments = name.split("/").map((f) => f.replace(/^@/, "")).filter((f) => f.length > 0);
    const named = fragments.some((f) => f.length >= 2 && haystack.includes(f));
    if (!named) {
      blocking.push(
        `新增依赖 ${dep.name} 无论证：在送审说明或提交说明里点名它，并写一句为什么现有代码/已装依赖做不到`,
      );
      continue;
    }
    const justified = JUSTIFICATION_MARKERS.some((m) =>
      m.includes(".*") ? new RegExp(m).test(haystack) : haystack.includes(m.toLowerCase()),
    );
    if (!justified) {
      blocking.push(
        `新增依赖 ${dep.name} 只有点名、无线索说明原因：在送审说明或提交说明里加一句为什么（because/因为/现有…无法…等）`,
      );
    }
  }
  return { blocking };
}

/**
 * Format the verdict for the checkpoint refusal line. Empty verdict ⇒ "".
 */
export function formatDependencyJustificationVerdict(v: DependencyJustificationVerdict): string {
  if (v.blocking.length === 0) return "";
  return `新增依赖缺论证（${v.blocking.length} 个）：` + v.blocking.join("；");
}

/**
 * The `dependencies` keys of a package.json text. Returns undefined when the
 * text is not a parseable package.json (the caller treats that as "no facts",
 * never as a block — an unreadable manifest is not evidence of a new dep).
 */
export function dependencyKeysOf(packageJsonText: string): string[] | undefined {
  try {
    const parsed = JSON.parse(packageJsonText) as { dependencies?: unknown };
    const deps = parsed.dependencies;
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) return [];
    return Object.keys(deps as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/**
 * Which keys are new: present in the worktree manifest, absent at the base.
 * Either side unreadable ⇒ no facts (fail-open on the FACTS, fail-closed
 * nowhere — this module never blocks on what it could not read).
 */
export function newDependencyNames(worktreeText: string | undefined, baseText: string | undefined): string[] {
  if (worktreeText === undefined) return [];
  const worktree = dependencyKeysOf(worktreeText);
  if (worktree === undefined) return [];
  // A base that cannot be READ is not an empty base: treating it as one
  // would judge every worktree key as new (reviewer P2, 2026-09-08) — the
  // opposite of this module's "no facts ⇒ never a block" contract. Only an
  // ABSENT base (no manifest at HEAD: a new repo / new manifest) means
  // "everything is new".
  if (baseText === undefined) return [...worktree];
  const base = dependencyKeysOf(baseText);
  if (base === undefined) return [];
  const baseSet = new Set(base);
  return worktree.filter((k) => !baseSet.has(k));
}
