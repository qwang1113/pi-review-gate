/**
 * THE THIRTY-MINUTE STAND-IN'S I/O (2026-09-19) — asking the arbiter to answer
 * a dialog nobody is at the terminal for, and making what it answered VISIBLE.
 * Moved out of `extensions/review-gate.ts` with the dialog renderer (t5,
 * wave 1); the race itself — timing, the row check, human-always-wins — lives
 * in lib/user-proxy.ts.
 */

import type { ChoiceSpec } from "./choice-dialog.ts";
import {
  buildProxyPrompt,
  parseProxyDecision,
  PROXY_ARBITER_TIMEOUT_MS,
  PROXY_SYSTEM_PROMPT,
  type ProxyChoice,
} from "./user-proxy.ts";
import { PROXY_ISOLATION_FLAGS, runArbiterProcess } from "./arbitration.ts";
import { mergeProxyDecisions } from "./gate-state-io.ts";
import type { GateState } from "./gate-state.ts";
import type { SessionHost } from "./session-host.ts";

export interface DialogProxyDeps {
  /** The arbiter model, or undefined when none is configured (fail-closed). */
  resolveArbiterModel(): string | undefined;
  /** Where this session's own transcript lives, when it can be found. */
  ownTranscriptPath(): string | undefined;
}

export interface DialogProxy {
  answerFor(spec: ChoiceSpec, body: string | undefined, root: string): Promise<ProxyChoice | undefined>;
  record(spec: ChoiceSpec, choice: string, byProxy: { rationale: string; at: string }, root: string): void;
  /** Every proxy decision of this session, across every repo it touched. */
  all(): NonNullable<GateState["proxyDecisions"]>;
}

export function createDialogProxy(host: SessionHost, deps: DialogProxyDeps): DialogProxy {
  /**
   * ASK THE PROXY (2026-09-19) — what happens when a dialog waits thirty
   * minutes with nobody at the terminal.
   *
   * NO ARBITER, NO PROXY: an unconfigured arbiter resolves to no model, and
   * this returns `undefined` — which the dialog reads exactly as it reads a
   * closed box, so a gate with no arbiter still cannot grant anything by
   * omission. Same fail-closed shape the arbitration paths use.
   *
   * The prompt carries a TRANSCRIPT POINTER, not the transcript: the proxy is a
   * one-shot process (lib/arbitration.ts) and is told where to read the
   * conversation rather than handed it — the choice `lib/adviser-brief.ts` makes
   * too, for the same reason (a session log dwarfs the question).
   */
  async function proxyAnswerFor(spec: ChoiceSpec, body: string | undefined, root: string): Promise<ProxyChoice | undefined> {
    const model = deps.resolveArbiterModel();
    if (!model) return undefined;
    const transcript = deps.ownTranscriptPath();
    const prompt = buildProxyPrompt({
      title: spec.title,
      // THE ROWS THE USER WOULD HAVE SEEN, verbatim, and the ONLY values the
      // answer may take: `raceWithUserProxy` refuses anything else, which is what
      // makes a proxied answer indistinguishable downstream.
      options: spec.options,
      // A CHECKBOX QUESTION TAKES SEVERAL (2026-09-22): the proxy may name
      // several rows, and the check that accepts them widens by SHAPE only.
      ...(spec.defaultChecked === undefined ? {} : { multiple: true }),
      ...(body === undefined ? {} : { body }),
      ...(transcript === undefined ? {} : { transcript }),
      // WHICH REPO THE PROXY IS ASKED ABOUT (review round 3 P1): the same one
      // its decision will be filed under. Reading it twice would let the prompt
      // and the sidecar disagree.
      repoRoot: root,
    });
    const raw = await runArbiterProcess(
      model, prompt, undefined, PROXY_ARBITER_TIMEOUT_MS, PROXY_SYSTEM_PROMPT,
      // THE READ-ONLY SET, NOT `--no-tools` (review round 2 P1). The appeal
      // arbiter's isolation is text-in/JSON-out; this one is asked to READ the
      // session, and a prompt carrying a transcript pointer is worthless to a
      // process that cannot open a file.
      PROXY_ISOLATION_FLAGS,
    );
    return parseProxyDecision(raw);
  }

  /**
   * WRITE THE DECISION WHERE THE USER WILL SEE IT (2026-09-19).
   *
   * This is the whole safety story of the proxy: downstream its answer is
   * indistinguishable from the user's own — it opens the same doors. The only
   * thing that keeps that honest is that it is VISIBLE, in three places: this
   * state record, a notice in the session, and the completion report
   * `declare_done` prints. A proxy decision that left no trace would be an
   * authorization the user never gave and cannot discover.
   */
  function recordProxyDecision(
    spec: ChoiceSpec,
    choice: string,
    byProxy: { rationale: string; at: string },
    /**
     * WHICH REPO'S SIDE CAR (review round 2 P1). The dialog does not know, and
     * `askChoice` is ONE function for all twelve sites — so the caller resolves
     * it. A decision recorded under the primary repo while its question belonged
     * to a secondary one lands in the wrong sidecar AND is missing from that
     * repo's completion report.
     */
    root: string,
  ): void {
    const st = host.stateFor(root);
    const sessionId = host.state().sessionId;
    st.proxyDecisions = [
      ...(st.proxyDecisions ?? []),
      {
        at: byProxy.at,
        question: spec.title,
        options: [...spec.options],
        choice,
        rationale: byProxy.rationale,
        ...(sessionId ? { sessionId } : {}),
      },
    ];
    // `persistRepo`, not `persist`: the latter writes the CURRENT repo's
    // sidecar, and the decision belongs to `root` (review round 2 P1).
    const latestCtx = host.ctx();
    if (latestCtx) host.persistRepo(latestCtx, root);
    try {
      latestCtx?.ui.notify(
        `review-gate: 对话框等了 30 分钟无人作答，已由 arbiter 代为决定 —— 「${spec.title}」→ ${choice}` +
          (byProxy.rationale ? `\n依据：${byProxy.rationale}` : "") +
          "\n这条会记入 declare_done 的完成报告；你回来可以推翻它（重新走一遍对应的步骤即可）。",
        "warning",
      );
    } catch { /* headless */ }
  }

  /**
   * EVERY PROXY DECISION OF THIS SESSION, ACROSS EVERY REPO IT TOUCHED
   * (review round 2 P1). `declare_done` runs ONCE for the session, while each
   * decision belongs to whichever repo its dialog was about — reading only the
   * primary repo's sidecar would silently omit the rest, and an incomplete list
   * reads as "that was all of them", which is the one thing this record cannot
   * get wrong.
   *
   * Deduped by (time, question, choice): a session that touched the same repo
   * twice must not print the same decision twice either.
   */
  function allProxyDecisions(): NonNullable<GateState["proxyDecisions"]> {
    // The dedupe lives in `mergeProxyDecisions` (哲学三: one implementation) —
    // this is the same union, folded over more than two sessions.
    let out: NonNullable<GateState["proxyDecisions"]> = [];
    for (const root of host.repos().all) {
      out = mergeProxyDecisions(out, host.stateFor(root).proxyDecisions);
    }
    return out;
  }

  return { answerFor: proxyAnswerFor, record: recordProxyDecision, all: allProxyDecisions };
}
