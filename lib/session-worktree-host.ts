/**
 * A SECOND SESSION IN A HELD REPO GETS ITS OWN CHECKOUT — the IO half
 * (2026-09-28). Every name, argv and decision is lib/session-worktree.ts's;
 * this module asks, creates, switches, records the finished branch in the main
 * repo and removes the checkout. It never commits on the session's behalf.
 *
 * THE SWITCH. pi fixes a session's cwd when the runtime is built, and the only
 * way to rebuild it on another cwd is `switchSession(<file>)` — a COMMAND ctx
 * method. So the gate writes a fresh session file whose header `cwd` is the
 * worktree and dispatches its own internal command to itself
 * (`sendUserMessage("/gate-relocate …", {expandPromptTemplates:true})` is how
 * pi runs an extension command with a command ctx). pi then shuts the old
 * session down (`session_shutdown`: timers stop, the refused claim is let go)
 * and starts the new one IN the worktree (`session_start`: a fresh extension
 * instance, state read from the new cwd). Nothing captured before the switch is
 * used after it — reclamation is keyed on the NEW session's own id and cwd.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionDirForCwd } from "./session-dir.ts";

import { parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
import { gitFailureText, gitText } from "./git-exec.ts";
import { listedWorktreeBranch } from "./repo-facts.ts";
import {
  RELOCATE_COMMAND,
  RELOCATE_YES,
  createSessionWorktreeArgv,
  isSessionWorktreePath,
  VERIFIED_BRANCHES_RELPATH,
  finishRefusal,
  ownerRecordPath,
  ownsSessionWorktree,
  parseOwner,
  parseVerifiedBranches,
  relocateChoice,
  removeSessionWorktreeArgv,
  sessionWorktreeBranch,
  sessionWorktreePath,
  shouldAdopt,
  shouldOfferRelocation,
  type SessionWorktreeOwner,
  type VerifiedBranchRecord,
} from "./session-worktree.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import { pendingCheckpoint } from "./checkpoint-sweep.ts";
import { ensureGateWorktreeRoot } from "./worktree-root.ts";
import { seedWorktree } from "./worktree-seed.ts";

interface CommandCtx {
  ui: { notify(text: string, level?: "info" | "warning" | "error"): void };
  switchSession(path: string, options?: { withSession?: (ctx: { ui: { notify(text: string, level?: "info" | "warning" | "error"): void } }) => Promise<void> }): Promise<{ cancelled: boolean }>;
}

export interface SessionWorktreeHostDeps {
  pi: {
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: CommandCtx) => Promise<void> }): void;
    sendUserMessage(text: string, options?: { expandPromptTemplates?: boolean }): void | Promise<void>;
  };
  /** This session's cwd and id, read at call time. */
  cwd(): string;
  sessionId(): string | undefined;
  /** Is this session currently refused by the exclusivity guard? */
  refused(): boolean;
  askChoice(ctx: unknown, spec: ChoiceSpec, opts?: { proxy?: boolean }): Promise<string | undefined>;
  log(text: string): void;
  /** The git runner (tests inject one); defaults to the real git. */
  git?(cwd: string, argv: readonly string[]): { ok: boolean; output: string };
}

function readOwner(worktreePath: string): SessionWorktreeOwner | undefined {
  try { return parseOwner(readFileSync(ownerRecordPath(worktreePath), "utf8")); } catch { return undefined; }
}

function writeOwner(owner: SessionWorktreeOwner): void {
  writeFileSync(ownerRecordPath(owner.path), JSON.stringify(owner, null, 2) + "\n");
}

/** `gitFailureText` keeps STDOUT, where git says "nothing to commit". */
function runGit(cwd: string, argv: readonly string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: gitText(cwd, argv, { timeout: 0 }) };
  } catch (error) {
    return { ok: false, output: gitFailureText(error).trim() };
  }
}

export function createSessionWorktree(deps: SessionWorktreeHostDeps) {
  let offered = false;
  const git = deps.git ?? runGit;

  /** Cut + seed the checkout and write the session file that starts in it. */
  function prepare(repoRoot: string, previousSessionId: string): { ok: true; file: string; path: string; branch: string } | { ok: false; reason: string } {
    const token = randomBytes(4).toString("hex");
    const path = sessionWorktreePath(repoRoot, token);
    const branch = sessionWorktreeBranch(token);
    ensureGateWorktreeRoot();
    const made = git(repoRoot, createSessionWorktreeArgv(repoRoot, path, branch));
    if (!made.ok) return { ok: false, reason: made.output.split("\n").slice(-3).join(" ") };
    const seeded = seedWorktree(repoRoot, path);
    if (seeded.length > 0) deps.log(`review-gate[session-worktree] 播种：\n${seeded.join("\n")}`);
    // A session file whose HEADER names the worktree as cwd: that header is
    // what `switchSession` builds the new runtime's cwd from. Written by hand,
    // not through pi's SessionManager: the gate imports only TYPES from pi
    // (installed copies run without pi's node_modules beside them).
    // ponytail: header version pinned at 3 (pi's CURRENT_SESSION_VERSION today);
    // pi migrates older headers, so this only needs bumping if pi drops that.
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const dir = sessionDirForCwd(path);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: path }) + "\n");
    writeOwner({ sessionId: id, pid: process.pid, repo: repoRoot, branch, path });
    deps.log(`review-gate[session-worktree] 为 ${previousSessionId} 开出 ${path}（${branch}）`);
    return { ok: true, file, path, branch };
  }

  /** Called right after the exclusivity decision at session start. */
  function offerAfterRefusal(ctx: ExtensionContext): void {
    if (!shouldOfferRelocation({ refused: deps.refused(), hasUI: ctx.hasUI, alreadyOffered: offered })) return;
    offered = true;
    const repoRoot = deps.cwd();
    // Not awaited: session_start must not hang on a dialog.
    void (async () => {
      const spec = relocateChoice(repoRoot);
      // The dialog returns the ROW it showed (`A. …（推荐）`); the template's own
      // parser maps it back to the option text.
      const pick = parseChoice(await deps.askChoice(ctx, spec, { proxy: false }), spec);
      if (pick.kind !== "chose" || pick.option !== RELOCATE_YES) return;
      const prepared = prepare(repoRoot, deps.sessionId() ?? "?");
      if (!prepared.ok) {
        try { ctx.ui.notify(`review-gate: 开不出独立 worktree —— ${prepared.reason}。本会话保持原状。`, "error"); } catch { /* headless */ }
        return;
      }
      await deps.pi.sendUserMessage(`/${RELOCATE_COMMAND} ${prepared.file}`, { expandPromptTemplates: true });
    })().catch((error) => deps.log(`review-gate[session-worktree] 切换失败：${(error as Error).message}`));
  }

  function register(): void {
    deps.pi.registerCommand(RELOCATE_COMMAND, {
      description: "（门禁内部）把本会话切进门禁为它开的独立 worktree",
      handler: async (args, ctx) => {
        const file = args.trim();
        // Only a file the gate itself prepared: its header cwd is a session
        // worktree under the root, and that worktree's owner record names
        // the session this file starts.
        let header: { id?: unknown; cwd?: unknown } | undefined;
        try { header = JSON.parse(readFileSync(file, "utf8").split("\n")[0] ?? ""); } catch { header = undefined; }
        const cwd = typeof header?.cwd === "string" ? header.cwd : "";
        const owner = cwd && isSessionWorktreePath(cwd) ? readOwner(cwd) : undefined;
        if (!owner || owner.sessionId !== header?.id || !existsSync(cwd)) {
          ctx.ui.notify(`review-gate: /${RELOCATE_COMMAND} 只接受门禁自己准备的会话文件。`, "error");
          return;
        }
        // Anything that still reads process.cwd() follows the session too.
        try { process.chdir(cwd); } catch { /* the runtime cwd is what the tools use */ }
        const branch = owner.branch;
        await ctx.switchSession(file, {
          withSession: async (next) => {
            next.ui.notify(
              `review-gate: 本会话已切到独立 worktree ${cwd}（分支 ${branch}），与另一个会话互不打扰。` +
                "改动过门禁 commit 到这条分支、验收通过后 declare_done，门禁把「已验」写回主仓库并回收目录；" +
                "没做完就退出，未提交的改动会被丢弃。",
              "info",
            );
          },
        });
      },
    });
  }

  /** A `/new` in the same process takes the record over (see `shouldAdopt`). */
  function adoptOnStart(): void {
    const cwd = deps.cwd();
    if (!isSessionWorktreePath(cwd)) return;
    const owner = readOwner(cwd);
    const self = deps.sessionId();
    if (shouldAdopt(owner, self, process.pid)) {
      try { writeOwner({ ...owner!, sessionId: self! }); } catch { /* reclaim just will not match */ }
    }
  }

  /** The owner record of the worktree THIS session runs in, if it owns one. */
  function ownWorktree(): SessionWorktreeOwner | undefined {
    const cwd = deps.cwd();
    if (!isSessionWorktreePath(cwd)) return undefined;
    const owner = readOwner(cwd);
    return ownsSessionWorktree(owner, deps.sessionId()) ? owner : undefined;
  }

  /**
   * The LAST gate of `declare_done` in a relocated session — called only after
   * every other gate, acceptance included, has passed. Refuses a dirty or
   * unreviewed checkout; otherwise writes the verified-branch record into the
   * MAIN repo. Returns a refusal, or undefined (not relocated, or recorded).
   */
  function finishOwn(facts: {
    reviewVerdict?: string;
    reviewTree?: string | null;
    acceptanceStatus?: string;
    /** Untracked paths this session wrote (`GateState.sessionEditedFiles`). */
    sessionEditedFiles?: readonly string[];
  }): { refusal: string } | undefined {
    const owner = ownWorktree();
    if (!owner || !existsSync(owner.path)) return undefined;
    // "Clean" means what the CHECKPOINT means (lib/checkpoint-sweep.ts): a
    // foreign untracked file is never committed, so it must not block here —
    // the refusal's advice (commit it through the review loop) could never
    // clear it.
    let clean = false;
    try { clean = pendingCheckpoint(owner.path, facts.sessionEditedFiles ?? []).paths.length === 0; } catch { clean = false; }
    const head = git(owner.path, ["-C", owner.path, "rev-parse", "HEAD", "HEAD^{tree}"]);
    const [commit, headTree] = head.ok ? head.output.split("\n").map((s) => s.trim()) : [];
    const refusal = finishRefusal({
      clean,
      headTree,
      reviewVerdict: facts.reviewVerdict,
      reviewTree: facts.reviewTree,
      acceptanceStatus: facts.acceptanceStatus,
    });
    if (refusal) return { refusal };
    const branch = listedWorktreeBranch(owner.repo, owner.path) ?? owner.branch;
    const file = join(owner.repo, VERIFIED_BRANCHES_RELPATH);
    let existing: string | undefined;
    try { existing = readFileSync(file, "utf8"); } catch { existing = undefined; }
    const records = parseVerifiedBranches(existing).filter((r) => r.branch !== branch);
    const record: VerifiedBranchRecord = {
      branch, commit: commit!, tree: headTree!, review: "READY", acceptance: facts.acceptanceStatus!,
      sessionId: owner.sessionId, at: new Date().toISOString(),
    };
    try {
      writeFileAtomic(file, JSON.stringify([...records, record], null, 2) + "\n");
    } catch (error) {
      return { refusal: `没能把验证记录写回主仓库（${file}）：${(error as Error).message}` };
    }
    return undefined;
  }

  /**
   * Remove THIS session's worktree directory as it stands — never a commit.
   * The branch stays. Returns a line for the receipt, or undefined when this
   * session is not in a worktree it owns.
   */
  function removeOwn(): string | undefined {
    const owner = ownWorktree();
    if (!owner) return undefined;
    const branch = listedWorktreeBranch(owner.repo, owner.path) ?? owner.branch;
    if (existsSync(owner.path)) {
      const removed = git(owner.repo, removeSessionWorktreeArgv(owner));
      if (!removed.ok) return `⚠️ 独立 worktree ${owner.path} 没能删掉：${removed.output.slice(0, 300)}`;
    }
    try { rmSync(ownerRecordPath(owner.path), { force: true }); } catch { /* harmless without its checkout */ }
    return `独立 worktree ${owner.path} 已回收；分支 \`${branch}\` 留在主仓库 ${owner.repo}。`;
  }

  /** Is this session working in its own relocated worktree? */
  function inOwnWorktree(): boolean {
    return ownWorktree() !== undefined;
  }

  return { register, offerAfterRefusal, adoptOnStart, finishOwn, removeOwn, inOwnWorktree };
}
