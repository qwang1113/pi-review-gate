/**
 * `request_arbitration` — the narrow, fail-closed gate exception — and the
 * APPEAL LEDGER every A-class refusal goes through. Moved out of
 * `extensions/review-gate.ts` (t8, 2026-09-26, wave 4). The arbitration I/O (evidence
 * gathering, the arbiter spawn for text / inspection appeals, the lessons log)
 * is lib/arbitration-host.ts; the rules are lib/arbitration.ts and
 * lib/text-appeal.ts.
 */

import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildArbiterPrompt, BYPASS_TOKEN_TTL_MS, parseArbitrableAction, runArbiter } from "./arbitration.ts";
import type { createArbitrationHost } from "./arbitration-host.ts";
import { parseChoice, type ChoiceSpec, type ChoiceUi } from "./choice-dialog.ts";
import { STATION_SHIP_NEXT_STEPS } from "./delivery-station.ts";
import { computeFingerprint } from "./fingerprint.ts";
import type { createGateDialogs } from "./gate-dialogs.ts";
import type { SessionCells } from "./session-cells.ts";
import {
  APPEAL_HINT,
  appealDigest,
  appealPassAuthorizes,
  consumeAppealPass,
  emptyAppealRecord,
  type AppealKind,
} from "./text-appeal.ts";
import type { ToolHost } from "./tool-host.ts";

/**
 * THE SHARED QUOTA and the one refusal funnel for A-class texts: every text
 * refusal goes through `refuseText`, so the appeal hint, the record of what
 * was blocked (an appeal may only contest a real block) and the pass lookup
 * cannot drift apart.
 */
export function createAppealLedger(
  cells: SessionCells,
  deps: { persist(ctx?: ExtensionContext): void; appendLesson(text: string): void },
) {
  /** Appeals + arbitrations spent this session (persisted, so a restart does
   *  not hand the agent a fresh quota). */
  function appealsUsed(): number {
    return cells.state.appeals?.used ?? 0;
  }
  /** Spend one slot of the SHARED quota (the `gh pr edit` arbitration path;
   *  a text appeal spends its slot through recordAppealDecision). */
  function spendArbitration(ctx: unknown): void {
    cells.state.appeals = { ...(cells.state.appeals ?? emptyAppealRecord()), used: appealsUsed() + 1 };
    deps.persist(ctx as unknown as ExtensionContext);
  }
  /**
   * Refuse one A-class text — unless an appeal already passed this EXACT
   * content, in which case the pass is consumed and the text goes through.
   */
  function refuseText(kind: AppealKind, text: string, reason: string, ctx: unknown): string | undefined {
    const digest = appealDigest(kind, text);
    if (appealPassAuthorizes(cells.state.appeals, digest)) {
      // Single-use: spend it here, at the one place that can prove the
      // content is the content the arbiter judged.
      cells.state.appeals = consumeAppealPass(cells.state.appeals);
      deps.persist(ctx as unknown as ExtensionContext);
      deps.appendLesson(`appeal pass consumed (${kind})`);
      return undefined;
    }
    const full = `review-gate: ${reason} ${APPEAL_HINT}`;
    cells.lastBlockedText = { kind, text, reason: full, at: Date.now() };
    return full;
  }
  return { appealsUsed, spendArbitration, refuseText };
}

export interface ArbitrationToolDeps {
  arbitration: ReturnType<typeof createArbitrationHost>;
  appealsUsed(): number;
  spendArbitration(ctx: unknown): void;
  askChoice: ReturnType<typeof createGateDialogs>["askChoice"];
}

export function registerArbitrationTool(host: ToolHost, cells: SessionCells, deps: ArbitrationToolDeps): void {
  const arb = deps.arbitration;
  host.registerTool({
    name: "request_arbitration",
    label: "Request Arbitration",
    description:
      "Contest a review-gate block you believe is a MISJUDGEMENT. Three things are contestable, " +
      "each only AFTER the gate actually blocked: (a) a TEXT the language/attribution heuristics " +
      "refused (commit subject/body, PR title/body, romanized non-English, AI attribution, test " +
      "label) — a granted appeal passes THAT EXACT CONTENT once; (b) a ship block on a lone " +
      "`gh pr edit` limited to --title/--body/--body-file that is genuinely CIRCULAR; (c) IN A " +
      "REVIEW SESSION, a refusal to conclude READY because the gate observed no inspection this " +
      "round — a granted appeal lets THIS round conclude once. Never " +
      "git commit/push or gh pr create, and never a FACT the gate observed (no workspace, no " +
      "approved goal, unmet review gate, sensitive file) — those have a correct next step. " +
      "An INDEPENDENT arbiter (you cannot write its verdict) rules GATE_WINS / AGENT_WINS / " +
      "HUMAN. Quota: 3 per session, shared; a refused content cannot be appealed twice.",
    parameters: Type.Object({
      argument: Type.String({ description: "Your case for why this specific block is a misjudgement / circular — cite evidence (e.g. the non-Latin text is a quoted filename)." }),
    }),
    async execute(_id, rawParams, _signal, _onUpdate, rawCtx) {
      const params = rawParams as { argument: string };
      const ctx = rawCtx as ExtensionContext;
      const deny = (text: string) => ({ content: [{ type: "text" as const, text }], details: {}, isError: true });
      const projectConfig = cells.projectConfig;

      if (!projectConfig.arbiter.enabled) {
        return deny("review-gate: arbitration is disabled for this project (arbiter.enabled=false). GATE_WINS — comply with the gate.");
      }
      // Criterion 1: no built-in arbiter default — an unconfigured arbiter
      // (no agents.arbiter.slots[0]) fails closed here, before any spawn.
      if (!arb.resolveArbiterModel()) {
        return deny("review-gate: 仲裁者未配置模型链（agents.arbiter.slots 缺失或为空）——按 fail-closed 处理，GATE_WINS。请修复 ~/.pi/review-gate.json 后重试。");
      }
      // Must contest a REAL, recent block — and the MOST RECENT one, when
      // several kinds happened: that is the block the caller is actually stuck
      // on. Three kinds exist: an A-class TEXT refusal, a ship block on a lone
      // `gh pr edit`, and (judge side only) a zero-inspection READY refusal.
      const blockedAt = (at: number | undefined) => at ?? -1;
      const newest = Math.max(
        blockedAt(cells.lastBlockedInspection?.at),
        blockedAt(cells.lastBlockedText?.at),
        blockedAt(cells.lastBlockedShip?.at),
      );
      if (newest < 0) {
        return deny("review-gate: 没有可申诉的拦截。先把命令/编辑真跑一次——申诉只受理已经发生的拦截。");
      }
      if (cells.lastBlockedInspection && cells.lastBlockedInspection.at === newest) {
        return arb.arbitrateInspection(cells.lastBlockedInspection, String(params.argument ?? ""), ctx);
      }
      if (cells.lastBlockedText && cells.lastBlockedText.at === newest) {
        return arb.arbitrateText(cells.lastBlockedText, String(params.argument ?? ""), ctx);
      }
      const lastBlockedShip = cells.lastBlockedShip;
      if (!lastBlockedShip) {
        return deny("review-gate: no ship block to arbitrate. Run the command first; arbitration only contests an actual block.");
      }
      // A DELIVERY-STATION block is not arbitrable, and saying so BEFORE the
      // quota check is the point: the ship gate does not consult a token while
      // a station refusal stands, so accepting this appeal would spend one of
      // three and leave the command blocked (round-1 reviewer P2, 2026-09-06).
      if (lastBlockedShip.stationBlocked) {
        return deny(
          "review-gate: 这条拦截里有**交付站点**的成分，仲裁受理不了 —— 仲裁判的是「质量拦截是不是死结」，" +
          "它从来没被问过「这一轮该走多远」，而且站点还立着的时候门禁根本不会去看仲裁令牌。\n" +
          STATION_SHIP_NEXT_STEPS,
        );
      }

      const parsed = parseArbitrableAction(lastBlockedShip.command);
      if (!parsed.ok) {
        return deny(`review-gate: this block is NOT arbitrable — ${parsed.reason}. Only a lone \`gh pr edit\` (title/body) qualifies; git commit/push and gh pr create must go through the full gate.`);
      }
      // Per-session cap (SHARED with text appeals, and persisted) and re-roll
      // prevention.
      if (deps.appealsUsed() >= projectConfig.arbiter.maxPerSession) {
        return deny(`review-gate: arbitration limit reached (${projectConfig.arbiter.maxPerSession}/session). Escalate to the user or /gate-bypass.`);
      }
      const fp = computeFingerprint(cells.cwd);
      if (fp.unavailable) return deny("review-gate: worktree fingerprint unavailable — cannot bind an arbitration token. GATE_WINS (fail-closed).");
      // Re-roll prevention: an action identity (exact command + review round +
      // body-file content) may be arbitrated AT MOST ONCE — AGENT_WINS too. To
      // legitimately try again the agent must change the command or fix the
      // code (new round / fingerprint), which yields a different identity.
      const bodyDigest = arb.bodyFileDigest(parsed.action.bodyFilePaths);
      const decisionKey = `${parsed.action.commandDigest}#${cells.state.rounds.length}#${bodyDigest}`;
      const cached = cells.arbitrationDecisions.get(decisionKey);
      if (cached) {
        return deny(`review-gate: this exact action was already arbitrated this round → ${cached}. Re-rolling is not allowed; change the action or comply with the gate.`);
      }

      deps.spendArbitration(ctx);

      // Gather TRUSTED ground-truth evidence ourselves (the arbiter is tool-less).
      const prompt = buildArbiterPrompt({
        blockReason: lastBlockedShip.blockReason,
        gateProblems: lastBlockedShip.problems,
        command: lastBlockedShip.command,
        currentPr: arb.gatherPrText(parsed.action),
        proposedText: arb.gatherProposedText(parsed.action),
        gitContext: arb.gatherGitLog(cells.cwd),
        agentArgument: params.argument,
      });

      const verdict = await runArbiter(arb.resolveArbiterModel() ?? "", prompt);
      // Fail-closed: any spawn/parse failure → GATE_WINS.
      const decision = verdict?.decision ?? "GATE_WINS";
      cells.arbitrationDecisions.set(decisionKey, decision);
      arb.appendLesson(`arbitration #${deps.appealsUsed()} decision=${decision} reason=${JSON.stringify(verdict?.reason ?? "(no verdict → GATE_WINS)")} cmd=${lastBlockedShip.command.slice(0, 200)} arg=${params.argument.slice(0, 200)}`);

      /** The single-use bypass for this exact `gh pr edit`. */
      const issueToken = async () => {
        const bindings = await arb.computeTokenBindings(parsed.action, fp.digest);
        cells.bypassToken = {
          blockId: randomBytes(8).toString("hex"),
          sessionId: bindings.sessionId,
          kind: bindings.kind,
          fingerprint: bindings.fingerprint,
          round: bindings.round,
          commandDigest: bindings.commandDigest,
          bodyFileDigest: bindings.bodyFileDigest,
          issuedAt: Date.now(),
          ttlMs: BYPASS_TOKEN_TTL_MS,
          consumed: false,
        };
      };

      if (decision === "AGENT_WINS") {
        await issueToken();
        return {
          content: [{ type: "text", text: `review-gate: arbiter ruled AGENT_WINS — ${verdict?.reason ?? ""}\nA SINGLE-USE bypass is issued for this exact \`gh pr edit\` (valid ${Math.round(BYPASS_TOKEN_TTL_MS / 60000)} min, this worktree/round only). Run the SAME command now; it will be allowed ONCE, then you must re-review.` }],
          details: { decision },
        };
      }

      if (decision === "HUMAN") {
        // Pause the gate: hand the choice to the human via a 3-way dialog. No
        // UI → fail-closed to GATE_WINS.
        if (!ctx.hasUI) {
          return deny("review-gate: arbiter deferred to a HUMAN but no interactive UI is available → GATE_WINS (fail-closed). Escalate to the user out-of-band.");
        }
        let choice: string | undefined;
        /** The human's own words when they picked the template's decline row. */
        let humanNote: string | undefined;
        try {
          // The arbiter's question goes through the SAME template as every
          // other dialog (2026-09-08): the recommended row is the gate's own
          // answer, and the decline row lets the human explain why neither
          // extreme fits.
          const spec: ChoiceSpec = {
            title: `review-gate: arbiter is unsure — you decide.\nBlock: ${lastBlockedShip.blockReason.split("\n")[0]}\nArbiter: ${verdict?.reason ?? ""}`,
            options: [
              "Gate wins — require correction",
              "Allow this exact `gh pr edit` once",
              "Pause gate and wait",
            ],
            recommended: "Gate wins — require correction",
          };
          const pick = parseChoice(
            await deps.askChoice(ctx as unknown as { ui?: ChoiceUi }, spec),
            spec,
          );
          choice = pick.kind === "chose" ? pick.option : undefined;
          // The decline row is "none of these, and here is why": the gate keeps
          // its fail-closed default, and the objection is carried back.
          humanNote = pick.kind === "declined" ? pick.reason : undefined;
        } catch { choice = undefined; }
        if (choice === "Allow this exact `gh pr edit` once") {
          await issueToken();
          arb.appendLesson(`arbitration #${deps.appealsUsed()} HUMAN→allow-once`);
          return { content: [{ type: "text", text: "review-gate: human allowed this exact `gh pr edit` ONCE. Run the same command now." }], details: { decision: "HUMAN", human: "allow-once" } };
        }
        if (choice === "Pause gate and wait") {
          cells.loopArmed = false;
          cells.arbitrationPaused = true; // P1: the revival timer must respect this
          arb.appendLesson(`arbitration #${deps.appealsUsed()} HUMAN→pause`);
          return { content: [{ type: "text", text: "review-gate: gate PAUSED by the human — auto-continuation disarmed. No bypass issued. Wait for further instructions." }], details: { decision: "HUMAN", human: "pause" } };
        }
        // The decline row is not one of the three rulings, and saying "the
        // human ruled GATE_WINS" would put words in their mouth (reviewer P1).
        if (humanNote !== undefined) {
          arb.appendLesson(`arbitration #${deps.appealsUsed()} human note: ${humanNote}`);
          return deny(
            "review-gate: the human did not pick an arbitration option — they picked 「✎ 不选，我说明原因」." +
            (humanNote ? ` 用户的意见：${humanNote}` : "") +
            " The gate's default therefore stands (no bypass issued): comply with the gate, or bring this objection into a new appeal.",
          );
        }
        arb.appendLesson(`arbitration #${deps.appealsUsed()} HUMAN→gate-wins`);
        return deny("review-gate: human ruled GATE_WINS — comply with the gate.");
      }

      // GATE_WINS
      return deny(`review-gate: arbiter ruled GATE_WINS — ${verdict?.reason ?? "the block stands (no valid verdict → fail-closed)"}. Comply: fix the underlying problem, then re-review.`);
    },
  });
}
