/**
 * THE ARBITRATION HOST — the I/O around the gate's appeals, moved out of
 * `extensions/review-gate.ts` (t5, wave 1): the token bindings, the arbiter
 * model lookup, the two appeal hearings, the evidence gatherers and the two
 * gate-owned audit logs.
 *
 * The RULES (admission, quotas, prompts, what may be granted) stay in the pure
 * modules — lib/arbitration.ts, lib/text-appeal.ts, lib/inspection-appeal.ts.
 * What is here is only the I/O those rules cannot own.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname as pathDirname, join as pathJoin } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { runArbiter, type ArbitrableAction, type TokenBindings } from "./arbitration.ts";
import { effectiveAgentsConfig } from "./agents-config.ts";
import {
  admitAppeal,
  appealDigest,
  buildTextAppealPrompt,
  recordAppealDecision,
  TEXT_APPEAL_SYSTEM_PROMPT,
  type AppealableBlock,
} from "./text-appeal.ts";
import {
  admitInspectionAppeal,
  buildInspectionAppealPrompt,
  inspectionDecisionKey,
  inspectionDeniedText,
  inspectionGrantedText,
  INSPECTION_APPEAL_SYSTEM_PROMPT,
  issueInspectionPass,
  type InspectionBlock,
  type InspectionPass,
} from "./inspection-appeal.ts";
import { sha256 } from "./hash.ts";
import { gitOrNull } from "./git-exec.ts";
import type { ProjectConfig } from "./project-config.ts";
import type { SessionHost } from "./session-host.ts";

type AppealReply = { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };

/**
 * Best-effort audit line for gate decisions the transcript alone cannot be
 * trusted to preserve: sensitive-file grants (issued/consumed) and loop-goal
 * approvals. All three are USER consent events — the one class of fact that
 * must stay checkable after a compaction, a crash, or a session the agent
 * later summarizes in its own words.
 *
 * This function was CALLED from three places before it existed: ESM only
 * throws `log is not defined` when the line finally runs, so every
 * propose_loop_goal / request_sensitive_edit approval crashed in front of the
 * user. `npm run typecheck` (TS2304) now catches that class before shipping.
 *
 * Writes under the REPO ROOT's `.pi/` — gate-owned, so it is excluded from
 * the fingerprint and from edit tracking: auditing a decision must never
 * invalidate the review binding the decision belongs to. Anchoring on the
 * session `cwd` instead would break exactly that when Pi runs in a
 * subdirectory of the repo, because `:/.pi` only excludes the ROOT one —
 * `<root>/sub/.pi/audit.log` is an ordinary worktree file, and appending to
 * it would move the digest under a recorded READY.
 */
export function appendAuditLog(repoRoot: string, sessionId: string | null | undefined, text: string): void {
  try {
    const logPath = pathJoin(repoRoot, ".pi", "review-gate-audit.log");
    mkdirSync(pathDirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} [${sessionId ?? "no-session"}] ${text}\n`);
  } catch { /* best effort audit log */ }
}

/** What the arbitration I/O needs from the session beyond the shared host. */
export interface ArbitrationHostDeps {
  projectConfig(): ProjectConfig;
  /** Appeals spent this session, across all three classes. */
  appealsUsed(): number;
  /** Spend one appeal from the shared quota (persisted). */
  spendArbitration(ctx: unknown): void;
  /** The inspection class's decisions, keyed per judge round (in memory). */
  arbitrationDecisions: Map<string, "GATE_WINS" | "AGENT_WINS" | "HUMAN">;
  /** Park the single-use pass an AGENT_WINS inspection appeal issues. */
  grantInspectionPass(pass: InspectionPass): void;
}

export function createArbitrationHost(host: SessionHost, deps: ArbitrationHostDeps) {
  // Compute the current binding material for a parsed arbitrable action: hash
  // each --body-file's (path + content) so replacing the file after issue
  // invalidates the token.
  async function computeTokenBindings(action: ArbitrableAction, fingerprint: string): Promise<TokenBindings> {
    const state = host.state();
    return {
      sessionId: state.sessionId,
      kind: action.kind,
      fingerprint,
      round: state.rounds.length,
      commandDigest: action.commandDigest,
      bodyFileDigest: bodyFileDigest(action.bodyFilePaths),
    };
  }


  /**
   * The arbiter model, resolved from the agents config layer (arbiter role).
   *
   * The arbiter USED to be a hard-coded constant (project-config's
   * DEFAULT_ARBITER_MODEL). Per the all-roles-through-config requirement it
   * now comes from agents.arbiter.slots[0]. Absent/unconfigured → undefined,
   * which callers treat as fail-closed (no arbiter, GATE_WINS).
   */
  function resolveArbiterModel(): string | undefined {
    try {
      const projectConfig = deps.projectConfig();
      const { map } = effectiveAgentsConfig(projectConfig.agentsGlobal, projectConfig.agentsProject);
      const arbiter = map.arbiter;
      if (arbiter && arbiter.auto === false && arbiter.slots.length > 0) return arbiter.slots[0]!;
      // NO BUILT-IN DEFAULT (criterion 1): an unconfigured arbiter returns
      // undefined and the caller fails closed (GATE_WINS). The legacy
      // projectConfig.arbiter.model field is NOT a fallback — its default
      // value is the hard-coded DEFAULT_ARBITER_MODEL, which this
      // requirement removes.
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Hear an appeal against an A-class TEXT block (lib/text-appeal.ts).
   *
   * Same shape as the `gh pr edit` arbitration below it — an independent
   * arbiter process, fail-closed on any failure — but what it may grant is a
   * CONTENT-bound single-use pass, never a command. The four brakes live in
   * the pure module; this function only does the I/O around them.
   */
  async function arbitrateText(
    block: AppealableBlock,
    argument: string,
    ctx: unknown,
  ): Promise<AppealReply> {
    const state = host.state();
    const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
    const digest = appealDigest(block.kind, block.text);
    const admission = admitAppeal(state.appeals, digest, deps.projectConfig().arbiter.maxPerSession);
    if (!admission.ok) return deny(`review-gate: ${admission.reason}`);

    const verdict = await runArbiter(
      resolveArbiterModel() ?? "",
      buildTextAppealPrompt(block, argument),
      undefined,
      undefined,
      TEXT_APPEAL_SYSTEM_PROMPT,
    );
    // Fail-closed: a spawn failure, a timeout or an unparseable answer is a
    // GATE_WINS — and it still SPENDS the quota, so a broken arbiter cannot be
    // retried into a grant.
    const decision = verdict?.decision ?? "GATE_WINS";
    state.appeals = recordAppealDecision(state.appeals, digest, block.kind, decision, new Date().toISOString());
    host.persist(ctx as unknown as ExtensionContext);
    appendLesson(`text appeal (${block.kind}) decision=${decision} reason=${JSON.stringify(verdict?.reason ?? "(no verdict → GATE_WINS)")} text=${block.text.slice(0, 120)}`);
    if (decision === "AGENT_WINS") {
      return {
        content: [{
          type: "text",
          text: `review-gate: 仲裁者判定 AGENT_WINS — ${verdict?.reason ?? ""}\n` +
            "已对这段内容发放一次性通行证：把**完全相同**的文本再提交一次即可通过（改一个字就失效）。" +
            "它只放行这段文本，不影响代码审查与 precommit 门禁。",
        }],
        details: { decision, kind: block.kind, used: deps.appealsUsed() },
      };
    }
    if (decision === "HUMAN") {
      return deny(
        `review-gate: 仲裁者把判断交给人 — ${verdict?.reason ?? ""}\n` +
        "本次不放行。要么改文案，要么请用户直接定夺（这条已计入配额）。",
      );
    }
    return deny(
      `review-gate: 仲裁者判定 GATE_WINS — ${verdict?.reason ?? "无有效裁决（fail-closed）"}。` +
      "按门禁要求改文案；同一段内容不能再申诉。",
    );
  }

  /**
   * Hear an appeal against a ZERO-INSPECTION READY refusal (the judge-side
   * class, lib/inspection-appeal.ts).
   *
   * Same three-part shape as the two appeals above — admission in the pure
   * module, an independent arbiter process, fail-closed on every failure —
   * and what it may grant is the narrowest thing in the gate: this judge's
   * THIS round may conclude READY once despite having inspected nothing. It
   * issues no bypass token, touches no verdict, and cannot reach a ship
   * command. The pass lives in memory because the round does.
   */
  async function arbitrateInspection(
    block: InspectionBlock,
    argument: string,
    ctx: unknown,
  ): Promise<AppealReply> {
    const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
    const key = inspectionDecisionKey(block.judgeId, block.round);
    const admission = admitInspectionAppeal({
      decided: deps.arbitrationDecisions.get(key),
      used: deps.appealsUsed(),
      maxPerSession: deps.projectConfig().arbiter.maxPerSession,
    });
    if (!admission.ok) return deny(`review-gate: ${admission.reason}`);

    // The quota is SHARED with the two other classes, and it is spent BEFORE
    // the arbiter runs: a spawn that dies must not be retried into a grant.
    deps.spendArbitration(ctx);
    const verdict = await runArbiter(
      resolveArbiterModel() ?? "",
      buildInspectionAppealPrompt(block, argument),
      undefined,
      undefined,
      INSPECTION_APPEAL_SYSTEM_PROMPT,
    );
    // Fail-closed, and the quota is spent either way: a broken arbiter cannot
    // be retried into a grant.
    const decision = verdict?.decision ?? "GATE_WINS";
    deps.arbitrationDecisions.set(key, decision);
    appendLesson(
      `inspection appeal (${block.role} round ${block.round}) decision=${decision} ` +
      `reason=${JSON.stringify(verdict?.reason ?? "(no verdict → GATE_WINS)")} arg=${argument.slice(0, 200)}`,
    );
    if (decision === "AGENT_WINS") {
      deps.grantInspectionPass(issueInspectionPass(block, Date.now()));
      return {
        content: [{ type: "text", text: inspectionGrantedText(verdict?.reason ?? "") }],
        details: { decision, round: block.round, used: deps.appealsUsed() },
      };
    }
    return deny(inspectionDeniedText(decision, verdict?.reason ?? ""));
  }


  function bodyFileDigest(paths: readonly string[]): string {
    if (paths.length === 0) return "";
    const { cwd } = host.repos();
    const parts: string[] = [];
    for (const p of paths) {
      let content = "";
      try { content = readFileSync(p.startsWith("/") ? p : pathJoin(cwd, p), "utf8"); } catch { content = "\0MISSING"; }
      parts.push(sha256(p + "\0" + content));
    }
    return sha256(parts.join("\0"));
  }

  function appendLesson(text: string) {
    try {
      const logPath = pathJoin(host.repos().cwd, ".pi", "review-gate-arbitration.log");
      mkdirSync(pathDirname(logPath), { recursive: true });
      appendFileSync(logPath, `${new Date().toISOString()} ${text}\n`);
    } catch { /* best effort audit log */ }
  }

  // Evidence gatherers for the arbiter (the arbiter is tool-less; the extension
  // fetches trusted ground truth). All are best-effort read-only and degrade to
  // an explicit "unavailable" note rather than throwing.
  function runReadOnly(argv: string[], extraEnv?: Record<string, string>): string | undefined {
    try {
      return execFileSync(argv[0], argv.slice(1), {
        cwd: host.repos().cwd, encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024,
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      }).trim();
    } catch { return undefined; }
  }

  function gatherPrText(action: ArbitrableAction): string {
    // Query the SAME PR the blocked command targets: mirror its selector, repo,
    // and hostname so the arbiter's ground truth matches the action under
    // review (not the current branch's default PR). All values come from the
    // parsed, validated action (argv, never a shell).
    const argv = ["gh", "pr", "view"];
    if (action.selector) argv.push(action.selector);
    if (action.repo) argv.push("--repo", action.repo);
    argv.push("--json", "number,title,body,url");
    // P1 fix: `gh pr view` has NO --hostname flag (that spelling would make gh
    // exit with a usage error and the evidence degrade to "unavailable").
    // gh selects the host via the GH_HOST environment variable instead.
    const out = runReadOnly(argv, action.hostname ? { GH_HOST: action.hostname } : undefined);
    return out ?? "(current PR text unavailable — `gh pr view` failed; arbiter should weigh this as missing evidence)";
  }

  function gatherProposedText(action: ArbitrableAction): string {
    if (action.bodyFilePaths.length === 0) return "(no --body-file; inline --title/--body is inside the blocked command shown above)";
    const { cwd } = host.repos();
    const parts: string[] = [];
    for (const p of action.bodyFilePaths) {
      try {
        const abs = p.startsWith("/") ? p : pathJoin(cwd, p);
        parts.push(`--- ${p} ---\n${readFileSync(abs, "utf8")}`);
      } catch { parts.push(`--- ${p} ---\n(unreadable)`); }
    }
    return parts.join("\n\n");
  }

  function gatherGitLog(dir: string): string {
    return gitOrNull(dir, ["log", "--oneline", "-15"], { timeout: 15000 }) ?? "(git log unavailable)";
  }

  return {
    computeTokenBindings,
    resolveArbiterModel,
    arbitrateText,
    arbitrateInspection,
    bodyFileDigest,
    appendLesson,
    gatherPrText,
    gatherProposedText,
    gatherGitLog,
  };
}
