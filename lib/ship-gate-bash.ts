/**
 * The SHIP GATE itself (L1): everything the gate decides about a `bash`
 * command before it runs — the tmux backstop, `/gate-bypass`, ship-command
 * detection, the A-class text checks (AI attribution + L5 English), the
 * message-only-rewrite exemption, the per-repo requirement check and the
 * single-use arbiter bypass.
 *
 * It lives here rather than in `extensions/review-gate.ts` for the reason this
 * repository has a rule about (AGENTS.md §"架构规范"): that file is ~7600
 * lines, and it got there one "just add it to the handler" at a time. See the
 * docblock of lib/ship-gate-edit-guard.ts for the boundary between the three
 * modules the L1 hook was split into; lib/ship-gate-hook.ts is the entry point
 * that dispatches to this one.
 *
 * WHAT IS AND IS NOT INJECTED. The pure decisions are imported directly
 * (lib/ship-detect.ts, lib/lang-detect.ts, lib/git-rewrite.ts,
 * lib/gate-state.ts's `unmetRequirements`, lib/arbitration.ts,
 * lib/orchestrator-guard.ts): they are already testable on their own. What IS
 * injected is everything this module cannot own — the gate state per repo, the
 * git measurements, the LLM classifier, the appeal recorder and the arbiter
 * token — so every branch here can be exercised with fakes and no subprocess.
 *
 * BEHAVIOR IS FROZEN: this was moved verbatim out of the extension. The ORDER
 * is the contract, not an implementation detail — the tmux backstop sits ABOVE
 * `/gate-bypass` (a bypass is an escape from the SHIP gate, never a licence to
 * destroy the user's environment) and `/gate-bypass` sits above ship detection.
 * Both orderings are pinned mechanically in test/extension-structure.test.ts.
 */

import { COMMIT_MSG_FORBIDDEN, requiresFullPrecommit, type ShipCommandKind } from "./constants.ts";
import {
  detectShipCommands,
  extractCommitMessages,
  extractPrTextFields,
  type ShipDetection,
} from "./ship-detect.ts";
import { resolveShipRepos } from "./repo-resolve.ts";
import {
  containsNonLatinLetter,
  firstNonEnglishText,
  l5BlockReason,
  nonEnglishCommitMessage,
} from "./lang-detect.ts";
import { detectForbiddenTmux } from "./orchestrator-guard.ts";
import { hasAmendFlag, isMessageOnlyRewrite } from "./git-rewrite.ts";
import { changedFiles, computeFingerprint, type Fingerprint } from "./fingerprint.ts";
import { isProtectedBranch } from "./workspace-branch.ts";
import { unmetRequirements, type GateState } from "./gate-state.ts";
import { LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK } from "./loop-goal.ts";
import {
  parseArbitrableAction,
  tokenAuthorizes,
  type ArbitrableAction,
  type BypassToken,
  type TokenBindings,
} from "./arbitration.ts";
import {
  classifyAiAttribution,
  classifyNonEnglish,
  classifyShipCommand,
  isSuspiciousShipCandidate,
  type LlmClassifier,
} from "./llm-classify.ts";
import { withSlowNotice, type SlowNoticeSink } from "./progress-stream.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { TaskMode } from "./task-mode.ts";
import type { AppealKind } from "./text-appeal.ts";
import type { ToolCallBlock } from "./ship-gate-edit-guard.ts";

// (The ship-operation shape is lib/ship-detect.ts's own `ShipDetection` — the
// LLM guard below pushes into the SAME array the static parser filled, so a
// locally widened copy would quietly stop type-checking what goes in.)

/** The record `request_arbitration` contests — a REAL block, never a guess. */
export interface BlockedShipRecord {
  command: string;
  problems: string[];
  blockReason: string;
  at: number;
}

/**
 * Everything the bash arm needs from the outside world.
 *
 * Deliberately narrow and side-effect-explicit: every member is a thing a
 * test replaces with three lines.
 */
export interface ShipGateBashDeps {
  /** The session cwd — a getter (pi hands the real one only at session_start). */
  cwd(): string;
  /** The session's own repo root — a getter, same reason. */
  primaryRepoRoot(): string;
  /**
   * This session's gate mode, read fresh on every command.
   *
   * `undefined` is the UNDECIDED state and is deliberately part of the type:
   * every branch below is an equality test against a named mode, so undecided
   * never takes the `normal` early return.
   */
  taskMode(): TaskMode | undefined;
  /** Is `/gate-bypass` active for the rest of the session? */
  bypassActive(): boolean;
  /** The effective project config (LLM guard switches, doc sync, arbiter). */
  projectConfig(): ProjectConfig;
  /** Every repo this session has touched (the ambiguous-resolution fallback). */
  sessionRepos(): Iterable<string>;
  /** Every repo the session knows about — decides whether to label problems. */
  knownRepoRoots(): string[];
  /** One repo's gate state, or undefined when it has no sidecar. */
  enforcementStateFor(root: string): GateState | undefined;
  /** One repo's state, materializing it (the primary repo's IS the session's). */
  stateForRepo(root: string): GateState;
  /** How a repo is named in a multi-repo problem line. */
  repoLabel(root: string): string;
  /** The branch a repo currently has checked out (rebase-aware). */
  currentBranch(root: string): string | undefined;
  /** The repo's worktree tree oid — half of the message-only-rewrite proof. */
  worktreeTree(root: string): string | undefined;
  /** HEAD's tree oid. */
  headCommitTree(root: string): string;
  /** Whether the index holds a staged change (the other half). */
  hasStagedChanges(root: string): boolean | undefined;
  /** Trees of commits made since the last REVIEWED one. */
  unreviewedTreesSince(root: string, review: GateState["review"]): string[] | undefined;
  /** Has the USER approved this session's loop goal (primary repo)? */
  loopGoalConfirmed(): boolean;
  /** "your READY is on another repo" — the cross-repo hint for a block. */
  crossRepoVerdictHint(blockedRoots: string[]): string;
  /** The flash classifier the three LLM guards run on. */
  classifier(): LlmClassifier;
  /** The status-bar sink the slow LLM guards report through. */
  notice(ctx: unknown): SlowNoticeSink | undefined;
  /**
   * Record an A-class TEXT block and return its refusal, or `undefined` when a
   * granted appeal pass authorizes this exact content once.
   */
  refuseText(kind: AppealKind, text: string, message: string, ctx: unknown): string | undefined;
  /** Append one line to the gate's lesson log. */
  appendLesson(text: string): void;
  /** The standing single-use arbiter bypass token, if one was issued. */
  bypassToken(): BypassToken | null;
  /** Replace it (used to mark it consumed on attempt). */
  setBypassToken(token: BypassToken | null): void;
  /** Drop it entirely. */
  clearBypassToken(): void;
  /** The current binding material a token is checked against. */
  computeTokenBindings(action: ArbitrableAction, fingerprint: string): Promise<TokenBindings>;
  /** Remember THIS block so `request_arbitration` can only contest a real one. */
  setLastBlockedShip(record: BlockedShipRecord): void;
}

/**
 * P0-5: describe compound vs single ship for block/lesson messages.
 *
 * Pure, and the reason a compound command reads as one thing in every message
 * that names it (the block reason and the arbiter lesson alike).
 */
export function describeShips(_command: string, ships: Array<{ kind: string }>): string {
  return ships.length > 1
    ? `compound command with ${ships.map((s) => s.kind).join(" + ")}`
    : ships[0].kind;
}

/**
 * The refusal text a blocked ship carries, as a pure decision.
 *
 * O13: ONE next-step line. The problems already say what is unmet; the
 * arbitration sentence is added only where it can apply at all (a lone
 * `gh pr edit`), because a ship gate is a FACT — satisfy it, do not argue
 * with it.
 */
export function buildShipBlockReason(input: {
  command: string;
  ships: Array<{ kind: string }>;
  problems: string[];
  crossRepoHint: string;
}): { recorded: string; shown: string } {
  const recorded =
    `review-gate: ${describeShips(input.command, input.ships)} blocked — quality gates unmet:\n` +
    input.problems.map((p) => `  - ${p}`).join("\n") +
    (input.ships.length > 1 ? "\nCompound ship commands are unsafe: later operations run after HEAD changes. Split them." : "") +
    input.crossRepoHint;
  const shown = recorded + "\n" + (input.ships.length === 1 && input.ships[0].kind === "pr-edit"
    ? "跑完审查循环清掉门禁；若这条拦截确实是循环死结（唯一的修法就是这条 gh pr edit），可 request_arbitration。"
    : "跑完审查循环清掉门禁（judge_submit → declare_done）。");
  return { recorded, shown };
}

/**
 * The bash arm of the L1 `tool_call` hook — the ship gate.
 *
 * Returns a refusal, or `undefined` to let the command run.
 */
export async function evaluateShipCommand(
  deps: ShipGateBashDeps,
  input: Record<string, unknown>,
  ctx: unknown,
): Promise<ToolCallBlock | undefined> {
  const cwd = deps.cwd();
  const primaryRepoRoot = deps.primaryRepoRoot();
  const projectConfig = deps.projectConfig();
  // L1 (the ship gate). What actually gates it is right below: `normal` mode
  // and an active `/gate-bypass` both return BEFORE any ship detection, so
  // "this session loads the extension" is not by itself enough — do not
  // claim otherwise here (round-12 P1: the previous rewrite did, and /tmp
  // sessions are clamped to normal, making the claim plainly false).
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return undefined;
  // The ship path runs up to three LLM guards before it can answer; each is
  // a few seconds, and a blocked bash call with no explanation reads as a
  // hang. Same status-bar sink as the L6 label check.
  const shipNotice = deps.notice(ctx);

  // Normal mode (user-confirmed, or the consent-free /tmp scratchFirstMode
  // first classification which maps loop / missing picks to normal):
  // the ship gate,
  // commit-message checks, and LLM ship classification are all off. This is
  // the mode's defining behavior; explore below never gets this branch.
  if (deps.taskMode() === "normal") return undefined;

  // tmux BACKSTOP (task book §4.3). Placed ABOVE /gate-bypass on purpose:
  // a bypass is the user's escape from the SHIP gate, and it was never a
  // licence to destroy their working environment. The destructive
  // subcommands are refused in every gated mode; the three the
  // orchestration tools replace are redirected only in orchestrator mode,
  // where a tool exists to do the same thing correctly. The gate's own tmux
  // calls never pass through here — they are argv, not bash.
  const tmuxHit = detectForbiddenTmux(command, {
    orchestratorMode: deps.taskMode() === "orchestrator",
  });
  if (tmuxHit) return { block: true, reason: tmuxHit.reason };

  // /gate-bypass (user-authorized, reason logged in state): the L1 ship gate
  // steps aside for the rest of the session. The git hooks mirror it via
  // REVIEW_GATE_BYPASS=1 for commits made OUTSIDE Pi; inside the session
  // this is the only in-session escape. (Missing before 2026-08-16: the
  // command set state.bypass but L1 never consulted it, so a bypassed
  // session still blocked every ship — only the hooks honored it.)
  if (deps.bypassActive()) return undefined;

  // Explore mode does NOT block bash — investigations need diagnostic
  // commands. Ship commands below stay FULLY gated in every mode except the
  // normal mode: explore only relaxes auto-continuation and
  // declare_done, never the ship gate.

  // P0-5: detect ALL ship commands, not just the first. Block if ANY operation
  // would ship ungated and warn about compound commands.
  const ships: ShipDetection[] = detectShipCommands(command);

  // P-multi: resolve the repos this command operates on — but ONLY once
  // there is something to check. A plain command (no ship op, not even a
  // suspicious git/gh mention) must not pay for the per-segment git
  // subprocesses in resolveShipRepos.
  if (ships.length === 0
    && !(projectConfig.llmGuards.shipDetect && isSuspiciousShipCandidate(command))) {
    return undefined;
  }
  const resolution = resolveShipRepos(command, cwd);
  const checkRoots = new Set(resolution.repos);
  if (resolution.ambiguous) {
    for (const r of deps.sessionRepos()) checkRoots.add(r);
  }
  let anyChange = false;
  for (const root of checkRoots) {
    const st = deps.enforcementStateFor(root);
    if (st) {
      if (st.hasCodeChange || st.hasDocChange) { anyChange = true; break; }
    } else {
      // Sidecar-less repo: uncommitted work still counts as a change so the
      // fail-closed "state missing" check below actually runs (an agent that
      // edited files via bash, not the edit tool, must not short-circuit).
      // changedFiles() returning UNDEFINED (dir missing / bare repo / .git
      // internals) is itself unverifiable — count it as a change so the
      // block loop fails closed instead of silently passing.
      const files = changedFiles(root);
      if ((files && files.length > 0) || files === undefined) { anyChange = true; break; }
    }
  }

  if (ships.length === 0) {
    // Guard #4 additional layer (tighten-only): the static parser saw no ship
    // op, but the command mentions git/gh with dynamic shell constructs the
    // parser cannot resolve (encodings, aliases, substitutions). Ask flash
    // whether it would ship; only a positive answer ADDS a detection — "none"
    // or a failed call changes nothing (the command was passing anyway).
    if (
      projectConfig.llmGuards.shipDetect &&
      anyChange &&
      isSuspiciousShipCandidate(command)
    ) {
      const kind = await withSlowNotice(
        shipNotice,
        "review-gate: 正在做 ship 命令语义判定…",
        () => classifyShipCommand(deps.classifier(), command),
      );
      if (kind !== undefined && kind !== "none") {
        ships.push({ kind, segment: command });
      }
    }
    if (ships.length === 0) return undefined;
  }

  // Short-circuit: if no changes tracked in any touched repo, no gate to
  // enforce. (A sidecar-less repo with uncommitted work still fails closed
  // in the per-repo check below — it has no state here, so it never
  // short-circuits; the block loop treats it as "state missing".)
  if (!anyChange) return undefined;

  // AI attribution (HARD) + English-language (L5, HARD) checks on commit
  // messages and PR title/description. Both are A-CLASS: heuristics the gate
  // can get wrong, so every refusal here carries the appeal route
  // (lib/text-appeal.ts) and is recorded as an appealable block.
  for (const s of ships) {
    if (s.kind === "commit") {
      // (WHERE a commit lands is checked per REPO, in the checkRoots loop
      // below: each repo has its own work branch, and a commit in repo B
      // must not be judged against repo A's branch.)
      const msgs = extractCommitMessages(s.segment);
      for (const msg of msgs) {
        if (COMMIT_MSG_FORBIDDEN.some((re) => re.test(msg))) {
          const reason = deps.refuseText("ai-attribution", msg,
            "commit message contains AI attribution. Rewrite without it.", ctx);
          if (reason) return { block: true, reason };
        }
      }
      // Guard #2 (tighten-only): regexes missed — ask flash about paraphrased
      // AI attribution ("pair-programmed with an assistant"). Failure → pass
      // (exact pre-LLM behavior).
      if (msgs.length > 0 && projectConfig.llmGuards.aiAttribution) {
        const attributed = await withSlowNotice(
          shipNotice,
          "review-gate: 正在做 AI 署名语义判定…",
          () => classifyAiAttribution(deps.classifier(), msgs),
        );
        if (attributed === true) {
          const reason = deps.refuseText("ai-attribution", msgs.join("\n\n"),
            "commit message contains AI attribution (semantic check). Rewrite without it.", ctx);
          if (reason) return { block: true, reason };
        }
      }
      // L5 (HARD): a commit message must be English — no non-Latin letter,
      // subject or body. The two parts share one rule and differ only in
      // what the reason points at.
      //
      // The paragraphs are JOINED first, exactly as git builds the message
      // from repeated -m: only the FIRST paragraph's first line is a subject.
      const whole = msgs.join("\n\n");
      const nonEn = nonEnglishCommitMessage(whole);
      if (nonEn) {
        const reason = deps.refuseText(
          nonEn.part === "subject" ? "commit-subject" : "commit-body",
          nonEn.text,
          l5BlockReason({
            kind: nonEn.part === "subject" ? "commit-subject" : "commit-body",
            text: nonEn.text,
          }) + " 用英文重写（git commit --amend）。",
          ctx,
        );
        if (reason) return { block: true, reason };
      } else if (msgs.length > 0 && projectConfig.llmGuards.englishCheck
        && !msgs.some(containsNonLatinLetter)
        && await withSlowNotice(
          shipNotice,
          "review-gate: 正在做 L5 语义判定（罗马化非英文）…",
          () => classifyNonEnglish(deps.classifier(), msgs),
        ) === true) {
        // L5 blind spot: the letters are all Latin, but the text may still
        // be romanized non-English (pinyin/romaji). Only worth asking when
        // there is no non-Latin letter at all — otherwise the hard rule
        // above already answered.
        const reason = deps.refuseText("romanized", whole,
          "commit message reads as romanized non-English (semantic check). Rewrite it in English.", ctx);
        if (reason) return { block: true, reason };
      }
    } else if (s.kind === "pr-create" || s.kind === "pr-edit") {
      const prTexts = extractPrTextFields(s.segment);
      const nonEn = firstNonEnglishText("pr-text", prTexts);
      if (nonEn) {
        const reason = deps.refuseText("pr-text", nonEn.text,
          l5BlockReason(nonEn) + " 用英文重写（gh pr edit --title/--body）。", ctx);
        if (reason) return { block: true, reason };
      } else if (prTexts.length > 0 && projectConfig.llmGuards.englishCheck
        && !prTexts.some(containsNonLatinLetter)
        && await withSlowNotice(
          shipNotice,
          "review-gate: 正在做 L5 语义判定（罗马化非英文）…",
          () => classifyNonEnglish(deps.classifier(), prTexts),
        ) === true) {
        const reason = deps.refuseText("romanized", prTexts.join("\n\n"),
          "PR title/description reads as romanized non-English (semantic check). Rewrite it in English.", ctx);
        if (reason) return { block: true, reason };
      }
    }
  }

  // MESSAGE-ONLY REWRITE (lib/git-rewrite.ts). A `git commit --amend` that
  // publishes the tree it replaces adds no content, so the CONTENT gates
  // have nothing to judge — and refusing it is what left a non-English
  // commit message unfixable (the only exit was a human running
  // /gate-bypass).
  //
  // IT EXEMPTS THE CONTENT GATES AND NOTHING ELSE (round-3 P1). The branch
  // rule, the fail-closed sidecar checks and the loop-goal gate below still
  // run: WHERE a commit lands is not a content question, and this round's
  // own rebase-aware `currentBranch` is exactly what lets that rule keep
  // applying during a reword instead of deadlocking on a detached HEAD.
  //
  // The message was already judged: L5 and the AI-attribution guard run
  // ABOVE this, so a rewrite cannot smuggle in a bad message.
  //
  // Two measurements, because `--amend` publishes the INDEX while the
  // fingerprint is a worktree tree: the worktree must equal HEAD's tree AND
  // the index must hold no staged change. Either alone is bypassable (stage
  // a change, then restore the worktree).
  const messageOnlyRewrite =
    !resolution.ambiguous &&
    ships.every((s) => s.kind === "commit" && hasAmendFlag(s.segment)) &&
    // EVERY repo this command touches must qualify: a compound
    // `git -C A commit --amend && git -C B commit --amend` must not be
    // exempted by repo A alone.
    [...checkRoots].every((root) => isMessageOnlyRewrite({
      amend: true,
      newTree: deps.worktreeTree(root),
      replacedTree: deps.headCommitTree(root) || undefined,
      stagedChanges: deps.hasStagedChanges(root),
    }));
  if (messageOnlyRewrite) {
    deps.appendLesson(`message-only rewrite: content gates skipped (tree unchanged): ${command.slice(0, 160)}`);
  }


  // P-multi: check every repo this command ships FROM (checkRoots was
  // already resolved above, before the short-circuits). Each ship segment's
  // repo is checked with ITS OWN sidecar + fingerprint.
  const problems: string[] = [];
  // Label EVERY problem line once more than one repo is in play. An
  // unlabelled "code review gate is PENDING" from the primary repo is what
  // a real multi-repo session read as being about the repo it had just
  // reviewed; single-repo wording is left untouched.
  const multiRepo = checkRoots.size > 1 || deps.knownRepoRoots().length > 1;
  const blockedUnreviewed: string[] = [];
  // Primary-repo fingerprint for the arbiter token path below (kept from the
  // loop so we do not re-hash the primary repo).
  let primaryFp: Fingerprint = { digest: "", head: "", unavailable: true };
  // Lane requirement for THIS command. A commit is local and reversible, so
  // the fast lane satisfies it; anything that publishes (push, gh pr) needs a
  // run whose tests were not narrowed. A compound command is judged by its
  // strictest segment — `git commit && git push` must satisfy the push rule.
  const requireFullTests = ships.some((s) => requiresFullPrecommit(s.kind as ShipCommandKind));
  for (const root of checkRoots) {
    const st = deps.enforcementStateFor(root);
    const fp = computeFingerprint(root);
    if (root === primaryRepoRoot) primaryFp = fp;
    // A commit on a PROTECTED branch (main/master/dev/develop) is refused
    // outright by the ship gate: the checkpoint tool can ask the user to
    // confirm, but a raw `git commit` in a shell has no dialog, so it
    // fails closed with a pointer to the branch rule instead.
    if (ships.some((s) => s.kind === "commit")) {
      const here = deps.currentBranch(root);
      if (here && isProtectedBranch(here)) {
        problems.push(multiRepo
          ? `[${deps.repoLabel(root)}] 当前在受保护分支 ${here} 上，直接提交被门禁拒绝 — 切到开发分支再提交（或确认这是有意为之）。`
          : `当前在受保护分支 ${here} 上，直接提交被门禁拒绝 — 切到开发分支再提交（或确认这是有意为之）。`);
      }
    }
    if (st) {
      // The CONTENT gates — and the only thing a message-only rewrite is
      // exempt from, because it publishes no content for them to judge.
      const unmet = messageOnlyRewrite ? [] : unmetRequirements(st, deps.headCommitTree(root), false, {
        requireDocSync: projectConfig.docSync,
        unreviewedCommits: deps.unreviewedTreesSince(root, st.review),
        requireFullTests,
      });
      for (const p of unmet) {
        problems.push(multiRepo ? `[${deps.repoLabel(root)}] ${p}` : p);
      }
      // Only a repo that is actually holding this ship up is worth pointing
      // the cross-repo hint at; a clean repo that simply never needed a
      // review would make the hint name an innocent bystander.
      if (unmet.length > 0 && st.review.verdict !== "READY") blockedUnreviewed.push(root);
    } else {
      // No sidecar for a non-primary repo: fail-closed when it holds
      // uncommitted work (an unreviewed diff must not ship through a repo
      // that never initialized its gate), but allow ships from a clean repo
      // this session has not touched. changedFiles() returning UNDEFINED
      // (dir missing / bare repo / .git internals) is UNVERIFIABLE — that
      // fails closed too (P0: a mis-parsed fake dir must never sail through
      // on "zero information").
      const files = changedFiles(root);
      if (files && files.length > 0) {
        problems.push(
          `[${deps.repoLabel(root)}] gate state missing (fail-closed) — ${files.length} uncommitted change(s) but no review-gate sidecar; initialize the gate for that repo (edit a file via the edit tool, then review + precommit there) before shipping`,
        );
      } else if (files === undefined) {
        problems.push(
          `[${deps.repoLabel(root)}] worktree unverifiable (fail-closed) — not inside a readable git repository and no review-gate sidecar; refusing to ship there`,
        );
      }
    }
  }
  // L8 — loop mode ships only against a goal the USER approved. The
  // negotiation is the point: without it the agent writes its own exit
  // contract, works to it, and grades itself against it, and a leftover file
  // from a previous task passes for a contract too. Blocking at ship time
  // (rather than at declare_done) is what makes the negotiation happen
  // BEFORE the work lands — by the time `declare_done` runs, the code is
  // already pushed and agreeing on the goal is theatre.
  //
  // L1 only, deliberately: the git hooks judge code facts from the sidecar
  // and cannot see a dialog, so this requirement never enters
  // unmetRequirements() (the ship authority they share).
  if (deps.taskMode() === "loop" && !deps.loopGoalConfirmed()) {
    problems.push(multiRepo ? `[${deps.repoLabel(primaryRepoRoot)}] ${LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK}` : LOOP_GOAL_UNCONFIRMED_SHIP_BLOCK);
  }

  if (problems.length === 0) return undefined;

  // Single-use arbiter bypass token (lib/arbitration.ts). Only a lone,
  // in-scope `gh pr edit` (title/body) can EVER match — the token is bound to
  // the exact command + worktree fingerprint + review round + body-file
  // content, and is consumed on the first authorized run. It never bypasses
  // commit/push/pr-create (those are not arbitrable, so no token is ever
  // issued for them) and never touches the code review loop.
  const token = deps.bypassToken();
  if (ships.length === 1 && ships[0].kind === "pr-edit" && token && !primaryFp.unavailable) {
    const parsed = parseArbitrableAction(command);
    if (parsed.ok) {
      const bindings = await deps.computeTokenBindings(parsed.action, primaryFp.digest);
      if (tokenAuthorizes(token, bindings, Date.now())) {
        deps.setBypassToken({ ...token, consumed: true }); // consume on attempt
        deps.clearBypassToken();
        try {
          (ctx as { ui: { notify: (t: string, l: string) => void } }).ui.notify("review-gate: single-use arbiter bypass consumed for this `gh pr edit`. Re-review after PR text is fixed.", "warning");
        } catch { /* headless */ }
        deps.appendLesson(`arbiter AGENT_WINS bypass consumed: ${describeShips(command, ships)}`);
        return undefined;
      }
    }
  }

  // Record this block so request_arbitration can only contest a REAL block.
  // The cross-repo hint is part of the recorded text: the arbiter should read
  // exactly what the agent read, and "your READY is on another repo" is the
  // single most relevant fact when a multi-repo block is being contested.
  const { recorded, shown } = buildShipBlockReason({
    command,
    ships,
    problems,
    crossRepoHint: deps.crossRepoVerdictHint(blockedUnreviewed),
  });
  deps.setLastBlockedShip({ command, problems, blockReason: recorded, at: Date.now() });

  return { block: true, reason: shown };
}
