/**
 * WHAT AN ISOLATED CHECKOUT IS SEEDED WITH — the local facts `git worktree`
 * cannot carry.
 *
 * ── THE MEASURED FAILURE (2026-09-15, onchain) ──
 *
 * A same-repo second child gets its own `git worktree` (lib/orchestrator-worktree.ts),
 * and a worktree starts from a COMMIT — so everything the repository does not
 * track is simply absent: the project's gate config, its `.env`, its
 * `node_modules`. The child then reads a repository that is not the one its
 * parent planned against. Onchain's `.pi/review-gate.json` configures the
 * precommit `test` step as a scoped jest run; without the file the gate fell
 * back to the package's own `yarn test` (midway, whole suite), 143 files
 * failed for reasons that had nothing to do with the change, and the project
 * manager spent a round instructing the child to hand-copy a config file the
 * gate itself could see perfectly well. That is a gate gap, not a child's
 * mistake (AGENTS.md philosophy one): the child never asked for a checkout
 * with half its environment missing.
 *
 * ── THE TWO RULES THAT DECIDE WHAT GOES ──
 *
 * 1. NOTHING THAT GIT WOULD SEE. A seeded path is only ever a path git
 *    IGNORES (`git check-ignore`). A tracked path already exists in the
 *    worktree because the commit carries it; a path that is neither tracked
 *    nor ignored would show up as untracked content in the isolated checkout,
 *    which is exactly what the isolation exists to prevent — the fingerprint,
 *    the precommit cache and the review scope all read that tree and would see
 *    a change nobody made.
 *
 * 2. COPY WHAT IS SMALL, LINK WHAT IS BIG. The gate's own config is copied:
 *    a copy cannot be edited back into the main checkout by a child that
 *    misbehaves. `node_modules` and `.env` are LINKED: they are large or must
 *    stay a single source of truth, and copying a node_modules tree per child
 *    would cost gigabytes.
 *
 * WHAT IS DELIBERATELY ABSENT: everything else under `.pi/`. The plan, the
 * gate state, the precommit cache, the task files, the judge sessions and the
 * review streams are a SESSION's own runtime, and seeding them would make two
 * writers share one piece of state — the one kind of damage this whole
 * mechanism exists to avoid.
 *
 * WHO CLEARS IT: whoever creates it. The seed lives INSIDE the child's
 * checkout, so reclaiming the worktree removes it with everything else
 * (lib/orchestrator-worktree.ts).
 *
 * Pure half + one small IO half, split for the usual reason: the list is
 * testable without a repository, and the io half is a loop over `fs`.
 */

import { gitText } from "./git-exec.ts";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/** How one seeded path is brought over. */
export type SeedKind = "copy" | "link";

export interface SeedEntry {
  kind: SeedKind;
  /** Path relative to the repository root (both sides). */
  path: string;
  /** One line for the receipt: why this one is here. */
  why: string;
}

/**
 * THE LIST. Every entry must be a path git ignores — {@link planWorktreeSeed}
 * checks that mechanically, so this list says WHAT is wanted and git decides
 * whether it is safe to take.
 */
export const SEED_ENTRIES: readonly SeedEntry[] = Object.freeze([
  {
    kind: "copy",
    path: ".pi/review-gate.json",
    why: "本仓的门禁配置（precommit 步骤、agents、标量）—— 少了它 precommit 会退回包默认命令",
  },
  {
    kind: "copy",
    path: ".pi/settings.json",
    why: "pi 的项目级设置",
  },
  {
    kind: "copy",
    path: ".pi/agents",
    why: "项目层的 agent 渲染（/gate-config 写的模型链）",
  },
  {
    kind: "link",
    path: ".env",
    why: "本地连接串与密钥 —— 隔离 checkout 要连同一个本地库",
  },
  {
    kind: "link",
    path: ".env.local",
    why: ".env 的本地覆盖变体（存在才处理）",
  },
  {
    kind: "link",
    path: "node_modules",
    why: "依赖目录：复制一份要几个 GB，链接保持单一来源",
  },
]);

/**
 * The facts the decision needs, injected so the rule can be tested without a
 * repository — and so the ONE caller that owns git is the one that answers.
 */
export interface SeedFacts {
  /** Does this path exist in the MAIN checkout? */
  exists(path: string): boolean;
  /** Does git ignore this path? (`git check-ignore`) */
  ignored(path: string): boolean;
}

/** One thing to do in the new checkout. */
export interface SeedAction {
  kind: SeedKind;
  path: string;
  why: string;
}

/** One path that was NOT brought over, and the fact that decided it. */
export interface SeedSkip {
  path: string;
  reason: string;
}

export interface SeedPlan {
  actions: SeedAction[];
  skipped: SeedSkip[];
}

/**
 * Decide what the new checkout gets.
 *
 * A missing path and an unignored path are both REFUSALS, not errors: a
 * project without `.env` is ordinary, and a project that TRACKS its
 * `node_modules` gets it from the commit itself. Neither is worth failing a
 * spawn over, so both come back as skips the receipt can print.
 */
export function planWorktreeSeed(facts: SeedFacts, entries: readonly SeedEntry[] = SEED_ENTRIES): SeedPlan {
  const actions: SeedAction[] = [];
  const skipped: SeedSkip[] = [];
  for (const entry of entries) {
    if (!facts.exists(entry.path)) {
      skipped.push({ path: entry.path, reason: "主 checkout 里没有这个路径" });
      continue;
    }
    if (!facts.ignored(entry.path)) {
      // Tracked content arrives with HEAD; content that is neither tracked nor
      // ignored would become untracked noise the fingerprint would read as a
      // change. Both are reasons to leave it alone.
      skipped.push({ path: entry.path, reason: "git 没有忽略它（受版本控制或未被忽略）—— 带过去会污染隔离 checkout 的 git status" });
      continue;
    }
    actions.push({ kind: entry.kind, path: entry.path, why: entry.why });
  }
  return { actions, skipped };
}

/** Is this relative path ignored by the repository at `root`? */
function isIgnored(root: string, relPath: string): boolean {
  return ignoreVerdict(root, relPath) === "ignored";
}

/**
 * The THREE-WAY answer, because "git says this is not ignored" and "git could
 * not be asked" are different facts with different consequences (drill F2,
 * 2026-09-20).
 *
 * `check-ignore` exits 1 for "not ignored" — the answer a seeded path has to be
 * removed over — while "no git", "not a repository" and a broken index are exit
 * 128 or a spawn failure. Collapsing those into `false` was harmless while only
 * the source checkout was asked (a refusal to seed is the safe reading there);
 * it is NOT harmless for the destination-side verification, where `false`
 * deletes a path the child may need because a `git` call could not be made at
 * all. Unknown ⇒ the plan-time answer stands.
 */
export function ignoreVerdict(root: string, relPath: string): "ignored" | "not-ignored" | "unknown" {
  try {
    gitText(root, ["check-ignore", "-q", "--", relPath]);
    return "ignored";
  } catch (error) {
    return (error as { status?: number }).status === 1 ? "not-ignored" : "unknown";
  }
}

/**
 * Apply the plan inside a freshly created checkout.
 *
 * Returns the receipt lines (one per path, action or skip). It NEVER throws:
 * a seed is a convenience for the child, and a spawn that already produced a
 * valid checkout must not be undone by a `.env` that could not be linked —
 * the child can still ask, and the receipt says what happened.
 */
export function seedWorktree(mainRoot: string, worktreeRoot: string): string[] {
  const lines: string[] = [];
  const plan = planWorktreeSeed({
    exists: (path) => existsSync(join(mainRoot, path)),
    ignored: (path) => isIgnored(mainRoot, path),
  });
  for (const action of plan.actions) {
    const from = join(mainRoot, action.path);
    const to = join(worktreeRoot, action.path);
    try {
      mkdirSync(dirname(to), { recursive: true });
      // A rerun (a recovered spawn, a reclaimed-and-recreated worktree) must
      // not trip over its own earlier work: anything already at `to` is
      // removed by cpSync's force or by the link call below.
      if (action.kind === "copy") {
        if (existsSync(to)) rmQuietly(to);
        try {
          cpSync(from, to, { recursive: true, force: true });
        } catch {
          // A directory copy can fail per-entry (a socket, a permission);
          // fall back to a file copy when the source is a regular file.
          copyFileSync(from, to);
        }
      } else {
        if (existsSync(to)) rmQuietly(to);
        symlinkSync(from, to);
      }
      // THE VERIFICATION HAS TO HAPPEN IN THE DESTINATION (drill F2,
      // 2026-09-19). `planWorktreeSeed` asked the MAIN checkout, and the two
      // can answer differently about the same path: `node_modules/` (trailing
      // slash) matches the DIRECTORY in the main checkout and NOT the symlink
      // this function just created in the new one, so `git check-ignore`
      // exited 1 there and the seeded path showed up as `?? node_modules` in
      // the isolated checkout's git status. That untracked entry was the fuel
      // for a fail-open of the ship gate (F1): what the seeder exists to
      // prevent must not depend on the source checkout's answer.
      //
      // A path that does not survive the check is REMOVED again — leaving it
      // would repeat exactly the pollution this refuses — and reported, unlike
      // the plan-time skips below: these two are not the same fact, and only
      // this one means "the checkout you got is missing something you may
      // have expected".
      if (ignoreVerdict(worktreeRoot, action.path) === "not-ignored") {
        rmQuietly(to);
        lines.push(
          `⚠ ${action.path} 没有带过去 —— 目标 checkout 的 git 不忽略它（源 checkout 里成立、在隔离 checkout 里不成立），` +
          "留着会污染它的 git status；子会话自己按需处理",
        );
        continue;
      }
      lines.push(`✔ ${action.kind === "copy" ? "已复制" : "已链接"} ${action.path} —— ${action.why}`);
    } catch (error) {
      lines.push(`⚠ ${action.path} 没能带过去（${(error as Error).message}）—— 子会话可以自己补或向项目经理求助`);
    }
  }
  // Skips are NOT printed here: a project without `.env` or with a committed
  // `node_modules` is ordinary, and a handful of "skipped" lines in every
  // spawn receipt would teach the reader to skip the receipt. They are still
  // RETURNED by planWorktreeSeed — the receipt can grow a section the day a
  // skip becomes surprising (and the tests assert on the reasons).
  return lines;
}

/** Best-effort removal of a path left by an earlier seed run. */
function rmQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    void path;
  }
}
