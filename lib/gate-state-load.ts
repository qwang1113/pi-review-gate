/**
 * Reading the sidecar back: `loadSidecar` validates every field (fail-closed on
 * anything forged or malformed) and applies the fingerprint-algorithm migration.
 *
 * Split out of lib/gate-state.ts.
 */

import { readFileSync } from "node:fs";

import { normalizeTaskMode } from "./task-mode.ts";
import { normalizeRuntime } from "./orchestrator-registry.ts";
import { normalizeNotifyHistory } from "./user-notify.ts";
import { normalizeOrchestrationId } from "./orchestration-id.ts";
import { FINGERPRINT_VERSION } from "./fingerprint.ts";
import { sanitizeCopilotState } from "./copilot-review.ts";
import { sanitizeAcceptanceRecord } from "./acceptance-round.ts";
import { sanitizeLoopStages } from "./loop-stages.ts";
import { restatementHash, type RestatementRecord } from "./restatement.ts";
import { isDeliveryStation } from "./delivery-station.ts";
import { SHIP_COMMAND_KINDS, type ShipCommandKind } from "./constants.ts";
import type { GoalPrereviewRecord } from "./loop-goal.ts";
import { TEST_SCOPES } from "./precommit-receipt.ts";
import type { GateState } from "./gate-state.ts";
import {
  DOC_SYNC_ATTESTATIONS,
  GATE_VERDICTS,
  isPendingReadyReview,
  PRECOMMIT_MODES,
  PRECOMMIT_VERDICTS,
  sanitizeRoundScope,
} from "./gate-state-records.ts";

/**
 * Load and validate the sidecar.
 *
 * The fingerprint migration is applied HERE, not left to callers: forgetting
 * it would mean trusting a binding produced by another algorithm, which is the
 * one outcome this must never allow. Because the migration is consumed here,
 * callers that need to TELL the user why their READY disappeared must pass
 * `out` — reading `state.fingerprintVersion` afterwards is useless, it has
 * already been updated (that exact mistake silenced the notice on the
 * sidecar-restore path).
 */
export function loadSidecar(path: string, out?: { migrated: boolean }): GateState | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as GateState;
    if (parsed?.schema !== 1) return undefined;
    // P0: reject malformed schema-1 payloads (e.g. {"schema":1}).
    if (typeof parsed.hasCodeChange !== "boolean" || typeof parsed.hasDocChange !== "boolean") return undefined;
    // P1 fail-closed: reject unknown/forged verdicts, not merely non-strings.
    // A schema-1 payload carrying precommit.verdict:"READY" (not a real
    // precommit verdict) must be rejected so it can't slip past the if-else
    // chain in unmetRequirements and fail-open.
    if (!parsed.review || !GATE_VERDICTS.has(parsed.review.verdict as string)) return undefined;
    // THE PARKED READY (2026-09-15). Optional, and a malformed one is DROPPED
    // rather than rejecting the sidecar: dropping is the fail-closed direction
    // here (a parked conclusion that cannot be replayed is one the gate must
    // not replay), and `review` stays PENDING either way — so the worst case
    // is a round that has to be re-submitted, never a replayed forgery.
    if (parsed.pendingReady !== undefined && !isPendingReadyReview(parsed.pendingReady)) {
      delete parsed.pendingReady;
    }
    if (!parsed.precommit || !PRECOMMIT_VERDICTS.has(parsed.precommit.verdict as string)) return undefined;
    // Lane metadata. A forged/unknown value is DROPPED rather than rejecting
    // the sidecar, and dropping is the fail-closed direction: an absent
    // testScope is treated as "not full", which blocks a push/PR.
    if (parsed.precommit.mode !== undefined && !PRECOMMIT_MODES.has(parsed.precommit.mode as string)) {
      delete parsed.precommit.mode;
    }
    if (parsed.precommit.testScope !== undefined &&
        !(TEST_SCOPES as readonly string[]).includes(parsed.precommit.testScope as string)) {
      delete parsed.precommit.testScope;
    }
    // The recorded pass-coverage tree: a CONTENT IDENTITY, and the only thing
    // that lets a READY be recorded after the live binding was invalidated by
    // the next round's own edits. Anything that is not a real object id is
    // dropped — dropping means the check falls back to the live verdict, which
    // is the direction that cannot wave an unverified round through.
    if (parsed.precommit.lastFullPassTree !== undefined &&
        !(typeof parsed.precommit.lastFullPassTree === "string" &&
          /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(parsed.precommit.lastFullPassTree))) {
      delete parsed.precommit.lastFullPassTree;
    }
    // Incremental-review baseline. `treeOid` is handed to `git diff` as an
    // ARGUMENT, so an unvalidated string from a tampered (or simply
    // repo-committed) sidecar would be git option injection — `--output=…`
    // and friends. Accept only a real object id; drop the whole field
    // otherwise, which just means the next round is a full review.
    //
    // `verdict` is validated the same way: it is what stops a BLOCKED tree
    // from being read as a settled conclusion (`settledConclusion`), so an
    // unknown word drops the field rather than guessing which side it is on.
    if (parsed.lastReviewedTree !== undefined) {
      const b = parsed.lastReviewedTree as Record<string, unknown> | null;
      const validOid = typeof b?.treeOid === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(b.treeOid);
      const validFiles = b?.files === undefined ||
        (Array.isArray(b.files) && b.files.every((f: unknown) => typeof f === "string"));
      const validVerdict = b?.verdict === "READY" || b?.verdict === "BLOCKED" || b?.verdict === "NEEDS_HUMAN";
      if (!b || typeof b !== "object" || Array.isArray(b) || !validOid || !validFiles || !validVerdict || typeof b.at !== "string") {
        delete parsed.lastReviewedTree;
      }
    }
    // The proxy's record. Shape-validated for one reason: `declare_done` prints
    // it back to the user, so a garbled entry would either crash the completion
    // report or quietly drop a decision nobody else witnessed. A bad shape drops
    // the WHOLE list rather than printing half of it — an incomplete list reads
    // as "that was all of them", which is the one thing this record cannot lie
    // about.
    if (parsed.proxyDecisions !== undefined) {
      const rows = parsed.proxyDecisions;
      const entryOk = (value: unknown): boolean => {
        const e = value as Record<string, unknown> | null;
        return !!e && typeof e === "object" && !Array.isArray(e) &&
          typeof e.at === "string" && typeof e.question === "string" &&
          typeof e.choice === "string" && typeof e.rationale === "string" &&
          (e.sessionId === undefined || typeof e.sessionId === "string") &&
          Array.isArray(e.options) && e.options.every((o: unknown) => typeof o === "string");
      };
      if (!Array.isArray(rows) || !rows.every(entryOk)) delete parsed.proxyDecisions;
    }
    // Orchestration runtime. Same threat model as `lastReviewedTree` above:
    // this blob carries the USER'S plan approval (which authorizes spawning
    // child sessions) and tmux pane ids (which become command targets), and
    // it lives in an ordinary repo-local file. `normalizeRuntime` validates
    // it and drops the approval on any doubt — the session then simply has to
    // ask the user again.
    //
    // THE ID IS READ BACK, AND THAT IS A CHANGE (2026-09-06, B1). It used to
    // be blanked here, with the reasoning that "a forged id must never become
    // an attention channel key". The blanking did not achieve that and cost
    // something real:
    //
    //  - it did not achieve it, because the very next thing that happened was
    //    lib/orchestrator-wiring.ts STAMPING the session's own id onto the
    //    stored runtime — so a foreign registry was adopted under our address
    //    anyway, and `runtimeConflict` (whose whole job is to refuse exactly
    //    that) compared against `""` and returned a falsy "conflict" that
    //    `dispatchSpawn` skipped;
    //  - it cost the takeover path: with no id on the record, nothing on disk
    //    could say WHICH orchestration this repo's plan belongs to, and a new
    //    project manager had no way to adopt it (it had to `rm` the plan).
    //
    // What actually keeps a forged id from becoming an address is elsewhere
    // and is unchanged: an id is only ADOPTED when a caller names it
    // explicitly in `orchestrator_attach` and it survives that tool's checks.
    // Read back here, the id is a FACT ABOUT THE RECORD ("this registry
    // belongs to that orchestration"), which is what makes refusing it
    // possible. A malformed one is not repaired: the whole blob goes, because
    // a registry whose owner cannot be named is one nothing may act on.
    if (parsed.orchestrator !== undefined) {
      // OPTIONAL CHAINING IS LOAD-BEARING HERE. `parsed.orchestrator` is
      // whatever the file said: `null` passes the `!== undefined` test above
      // and a plain property read on it THROWS — inside the try/catch that
      // wraps this whole function, which returns "unreadable sidecar". The
      // blast radius would have been every mode, not this one: a loop session
      // whose sidecar carried `"orchestrator": null` would silently lose its
      // READY and its precommit because of a field it never reads. The old
      // code was safe by accident (it handed the value to `normalizeRuntime`,
      // which type-checks first); this one has to be safe on purpose.
      const storedId = normalizeOrchestrationId(
        (parsed.orchestrator as { orchestrationId?: unknown } | null)?.orchestrationId,
      );
      const cleaned = storedId ? normalizeRuntime(parsed.orchestrator, storedId) : undefined;
      if (cleaned) parsed.orchestrator = cleaned;
      else delete parsed.orchestrator;
    }
    // Round-18 polish gate: malformed per-round file lists and the last
    // reason are DROPPED (absent means 'no trigger / nothing to carry',
    // which is the safe direction for both).
    if (Array.isArray(parsed.rounds)) {
      for (const r of parsed.rounds as unknown as Array<Record<string, unknown>>) {
        if (r.polishFiles !== undefined &&
            (!Array.isArray(r.polishFiles) || !r.polishFiles.every((v) => typeof v === "string"))) {
          delete r.polishFiles;
        }
        if (r.blockingFiles !== undefined &&
            (!Array.isArray(r.blockingFiles) || !r.blockingFiles.every((v) => typeof v === "string"))) {
          delete r.blockingFiles;
        }
        // A persisted total must be a real count. `isPlateaued` only guards
        // against `null` and then compares numerically, and EVERY comparison
        // with NaN is false — so a NaN slipping in here would sail past the
        // unparseable-total guard and let overlap alone declare a plateau.
        // Anything that is not a finite non-negative number becomes `null`,
        // which is the guard's own fail-closed value (round-15 P1). The
        // sidecar is a file: a stale writer or a hand edit can put anything
        // in it, so the parser's sanitizing is not enough on its own.
        if (r.findingsTotal !== undefined && r.findingsTotal !== null &&
            (typeof r.findingsTotal !== "number" ||
              !Number.isFinite(r.findingsTotal) || r.findingsTotal < 0)) {
          r.findingsTotal = null;
        }
        if (r.fingerprints !== undefined &&
            (!Array.isArray(r.fingerprints) || !r.fingerprints.every((v) => typeof v === "string"))) {
          r.fingerprints = [];
        }
        // The audit stamp is a RECORD, and a record nobody can trust is worse
        // than none: anything that is not a recognisable stamp is dropped
        // rather than kept as a half-value a reader would still print.
        const scope = sanitizeRoundScope(r.scope);
        if (scope === undefined) delete r.scope;
        else r.scope = scope;

      }
    }
    if (parsed.lastPolishReason !== undefined) {
      const p = parsed.lastPolishReason as Record<string, unknown> | null;
      if (!p || typeof p !== "object" || typeof p.reason !== "string" ||
          typeof p.at !== "string" || typeof p.round !== "number") {
        delete parsed.lastPolishReason;
      }
    }
    if (!Array.isArray(parsed.rounds)) return undefined;
    if (!parsed.bypass || typeof parsed.bypass.active !== "boolean") return undefined;
    // Optional field. Unknown values are removed so consumers fall back to
    // the safer loop behavior.
    if (parsed.taskMode !== undefined && normalizeTaskMode(parsed.taskMode) === undefined) {
      delete parsed.taskMode;
    }
    // Unknown source values fail closed to "auto" (never hook-advisory).
    if (parsed.taskModeSource !== undefined && parsed.taskModeSource !== "auto" && parsed.taskModeSource !== "user") {
      delete parsed.taskModeSource;
    }
    // Unknown/forged docSync attestation → treated as absent (fail-closed:
    // absent blocks when the project enforces docSync, never passes).
    if (parsed.review.docSync !== undefined && !DOC_SYNC_ATTESTATIONS.has(parsed.review.docSync as string)) {
      delete parsed.review.docSync;
    }
    // Malformed pause → treated as NOT paused (tighten-only: the pause only
    // relaxes auto-continuation, so dropping a forged one re-arms the loop;
    // the ship gate never reads this field either way).
    if (parsed.pausedQuestion !== undefined &&
        (typeof parsed.pausedQuestion !== "object" || parsed.pausedQuestion === null ||
         typeof parsed.pausedQuestion.question !== "string" ||
         typeof parsed.pausedQuestion.at !== "string")) {
      delete parsed.pausedQuestion;
    }
    // Malformed completion record → treated as ABSENT, which is the
    // fail-closed direction here: a supervisor then keeps watching a child it
    // cannot prove is finished, rather than writing it off (and marking its
    // plan task done) on a field anything could have written. `merge` is
    // constrained to the three landings the gate itself records.
    if (parsed.completion !== undefined) {
      const c = parsed.completion as Record<string, unknown> | null;
      const validMerge = c?.merge === "merged" || c?.merge === "waived" || c?.merge === "none";
      if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.at !== "string" || !c.at ||
          !validMerge || (c.summary !== undefined && typeof c.summary !== "string")) {
        delete parsed.completion;
      }
    }
    // Malformed scope limit → treated as ABSENT (fail-closed: absent means
    // the FULL-scope gate; dropping a forged one can only widen coverage,
    // never narrow it).
    if (parsed.scopeLimit !== undefined &&
        (typeof parsed.scopeLimit !== "object" || parsed.scopeLimit === null ||
         !Array.isArray(parsed.scopeLimit.preexistingFiles) ||
         !parsed.scopeLimit.preexistingFiles.every((v) => typeof v === "string") ||
         !Array.isArray(parsed.scopeLimit.sessionFiles) ||
         !parsed.scopeLimit.sessionFiles.every((v) => typeof v === "string") ||
         typeof parsed.scopeLimit.at !== "string")) {
      delete parsed.scopeLimit;
    }
    // Malformed session-edit attribution → treated as ABSENT (hints and the
    // scope tool then behave conservatively; the ship authority never reads
    // this field either way).
    if (parsed.sessionEditedFiles !== undefined &&
        (!Array.isArray(parsed.sessionEditedFiles) ||
         !parsed.sessionEditedFiles.every((v) => typeof v === "string"))) {
      delete parsed.sessionEditedFiles;
    }
    // Malformed repo set → treated as ABSENT (declare_done then only covers
    // the session repo; fail-closed for anything it does cover).
    if (parsed.sessionReposPaths !== undefined &&
        (!Array.isArray(parsed.sessionReposPaths) ||
         !parsed.sessionReposPaths.every((v) => typeof v === "string"))) {
      delete parsed.sessionReposPaths;
    }
    // Observed ship kinds: keep only the known vocabulary, deduped. A record
    // that is not an array at all is dropped entirely. Evidence that cannot be
    // read is not evidence — and losing it only makes an ARRIVAL check block,
    // which is the safe direction.
    if (parsed.shippedKinds !== undefined) {
      if (!Array.isArray(parsed.shippedKinds)) {
        delete parsed.shippedKinds;
      } else {
        const known = parsed.shippedKinds.filter(
          (v): v is ShipCommandKind => typeof v === "string" && (SHIP_COMMAND_KINDS as readonly string[]).includes(v),
        );
        parsed.shippedKinds = [...new Set(known)];
      }
    }

    // L7: a malformed Copilot cycle is repaired, never trusted verbatim and
    // never fatal — sanitizeCopilotState downgrades an unrecognized status to
    // ARMED (still to be proven) and drops a non-object entirely. Rejecting
    // the whole sidecar here would brick the ship gate over a field the ship
    // gate does not even read.
    if (parsed.copilot !== undefined) {
      const copilot = sanitizeCopilotState(parsed.copilot);
      if (copilot) parsed.copilot = copilot;
      else delete parsed.copilot;
    }
    // L9: a malformed acceptance record is treated as ABSENT — and absence is
    // exactly the fail-closed direction here, because "no record" means the
    // round is OWED. A record that could only ever release completion is the
    // one shape this must never guess at.
    if (parsed.acceptance !== undefined) {
      const acceptance = sanitizeAcceptanceRecord(parsed.acceptance);
      if (acceptance) parsed.acceptance = acceptance;
      else delete parsed.acceptance;
    }
    // A malformed stage record is treated as ABSENT, which is the defaults:
    // every stage ON. A record can only ever RELEASE a gate, so a partial or
    // forged one must never be read as a switch-off (lib/loop-stages.ts's
    // sanitizer is all-or-nothing for the same reason).
    if (parsed.stages !== undefined) {
      const stages = sanitizeLoopStages(parsed.stages);
      if (stages) parsed.stages = stages;
      else delete parsed.stages;
    }
    // L8: a malformed goal approval is treated as ABSENT — the fail-closed
    // direction here is "not approved" (goal body withheld, loop ships
    // blocked), so a forged or truncated record can only cost a fresh dialog.
    if (parsed.loopGoal !== undefined &&
        (typeof parsed.loopGoal !== "object" || parsed.loopGoal === null ||
         typeof parsed.loopGoal.hash !== "string" ||
         !/^[0-9a-f]{64}$/.test(parsed.loopGoal.hash) ||
         typeof parsed.loopGoal.at !== "string" ||
         (parsed.loopGoal.reason !== undefined && typeof parsed.loopGoal.reason !== "string"))) {
      delete parsed.loopGoal;
    }
    // The goal's delivery station (2026-09-06) is metadata BESIDE the
    // approval, so a broken one drops the FIELD and never the approval: the
    // reader degrades a missing station to `precommit`, the strictest value,
    // which is exactly what an unreadable one should mean. Dropping the whole
    // record instead would revoke an approval the user really gave over a
    // field that grants nothing.
    if (parsed.loopGoal?.station !== undefined && !isDeliveryStation(parsed.loopGoal.station)) {
      delete parsed.loopGoal.station;
    }
    // L8b: a MALFORMED pre-review record is treated as ABSENT — fail-closed
    // here means "never audited", so a truncated or shape-broken record costs
    // one fresh goal-auditor round instead of opening a dialog. This is a
    // SHAPE check, not an anti-forgery one: a well-formed record whose hash
    // matches the submitted text is honoured, exactly like `loopGoal`
    // (fabricating one is the same excluded class as writing the sidecar
    // directly — see the threat model in the README).
    function isGoalPrereviewRecord(x: unknown): boolean {
      const r = x as GoalPrereviewRecord | null | undefined;
      return !!r && typeof r === "object" &&
        typeof r.hash === "string" &&
        /^[0-9a-f]{64}$/.test(r.hash) &&
        (r.verdict === "PASS" || r.verdict === "FAIL") &&
        typeof r.at === "string" &&
        (r.findingsTotal === undefined || r.findingsTotal === null || typeof r.findingsTotal === "number") &&
        (r.findings === undefined ||
          (Array.isArray(r.findings) &&
            r.findings.every((f) =>
              typeof f === "object" && f !== null &&
              typeof (f as { issue?: unknown }).issue === "string" &&
              typeof (f as { severity?: unknown }).severity === "string"))) &&
        (r.draft === undefined || typeof r.draft === "string") &&
        (r.durationMs === undefined || typeof r.durationMs === "number");
    }
    if (parsed.goalPrereview !== undefined && !isGoalPrereviewRecord(parsed.goalPrereview)) {
      delete parsed.goalPrereview;
    }
    // L8b history (goal criterion 2: EVERY audit is persisted, PASS or FAIL,
    // not just the latest). Malformed entries are dropped per-entry, keeping
    // the rest of the history intact.
    if (parsed.goalPrereviewHistory !== undefined) {
      if (!Array.isArray(parsed.goalPrereviewHistory)) {
        delete parsed.goalPrereviewHistory;
      } else {
        parsed.goalPrereviewHistory = parsed.goalPrereviewHistory.filter(isGoalPrereviewRecord);
      }
    }
    // The goal's audit round is a plain counter; anything else on disk is
    // corruption, and dropping it restarts the count rather than printing
    // "第 NaN 轮审计".
    if (parsed.goalAuditRound !== undefined &&
      (typeof parsed.goalAuditRound !== "number" || !Number.isFinite(parsed.goalAuditRound) || parsed.goalAuditRound < 0)) {
      delete parsed.goalAuditRound;
    }
    // The un-goaled turn counter is a plain counter too; anything else on disk
    // is corruption, and dropping it restarts the count. A forged LARGE value
    // would only trigger the force-negotiate directive early (a prompt, not a
    // block — fail-open by design), so no extra bound is needed beyond sanity.
    if (parsed.turnsWithoutGoal !== undefined &&
      (typeof parsed.turnsWithoutGoal !== "number" || !Number.isFinite(parsed.turnsWithoutGoal) || parsed.turnsWithoutGoal < 0)) {
      delete parsed.turnsWithoutGoal;
    }
    // The REQUIREMENT RESTATEMENT (2026-09-06). Dropped WHOLE on any doubt,
    // and unlike every neighbour above this one re-computes the hash: the
    // record carries the confirmed TEXT, so `text` and `hash` disagreeing
    // means the pair was not written by `propose_restatement` — corruption or
    // an assembled record — and both readings are "nobody confirmed this".
    // Fail-closed here costs one fresh confirmation dialog; fail-open would
    // let a contract be negotiated against an understanding the user never
    // saw. The station is validated against the three known values, and a
    // record whose station alone is broken is dropped with it rather than
    // silently downgraded: a confirmation the user gave for `pr` must not
    // survive as something else.
    if (parsed.restatement !== undefined) {
      const rec = parsed.restatement as Partial<RestatementRecord> | null;
      const ok = !!rec && typeof rec === "object" &&
        typeof rec.text === "string" && rec.text.trim().length > 0 &&
        typeof rec.hash === "string" && /^[0-9a-f]{64}$/.test(rec.hash) &&
        typeof rec.at === "string" &&
        isDeliveryStation(rec.station) &&
        restatementHash(rec.text) === rec.hash;
      if (!ok) delete parsed.restatement;
    }
    // The ask_user record is diagnostic, so a malformed one is dropped whole:
    // no enforcement path reads it, and half a record answers nothing.
    if (parsed.askUser !== undefined) {
      const rec = parsed.askUser as { at?: unknown; answers?: unknown };
      const ok = !!rec && typeof rec === "object" && typeof rec.at === "string" &&
        Array.isArray(rec.answers) &&
        rec.answers.every((a) =>
          typeof a === "object" && a !== null &&
          typeof (a as { question?: unknown }).question === "string" &&
          ["answered", "skipped", "deferred-to-chat", "unanswered"].includes(String((a as { kind?: unknown }).kind)) &&
          // An `answer` that is not text would be replayed into the agent's
          // prompt as the user's words — it must be a string or absent. Same
          // for the option the answer was picked from (`option`, the letterless
          // text the proxy-grant rule compares) — 2026-09-19.
          ((a as { answer?: unknown }).answer === undefined || typeof (a as { answer?: unknown }).answer === "string") &&
          ((a as { option?: unknown }).option === undefined || typeof (a as { option?: unknown }).option === "string"));
      if (!ok) delete parsed.askUser;
    }
    // The banner throttle is bookkeeping whose worst failure is one extra
    // notification, so it is read fail-soft: unreadable entries contribute
    // nothing, and a malformed record can never be rounded into silence.
    if (parsed.notify !== undefined) {
      parsed.notify = normalizeNotifyHistory(parsed.notify);
    }
    // TMUX ACCESS is AUTHORITY, so it is read the other way round: a record
    // that does not parse is DROPPED (fail-closed — the agent asks again),
    // and the scope must be one of the two the tool can mint. A forged or
    // corrupted value must never read as a standing permission.
    if (parsed.tmuxAccess !== undefined) {
      const rec = parsed.tmuxAccess as { at?: unknown; scope?: unknown } | null;
      const ok = !!rec && typeof rec === "object" && typeof rec.at === "string" &&
        (rec.scope === "session" || rec.scope === "once");
      if (ok) parsed.tmuxAccess = { at: rec.at as string, scope: rec.scope as "session" | "once" };
      else delete parsed.tmuxAccess;
    }
    // APPEALS are anti-abuse bookkeeping, so a malformed record is dropped
    // WHOLE and the session starts from zero spent appeals. That is the safe
    // direction for the pass (a forged one would authorize content no arbiter
    // ever saw) and the honest one for the quota: a record the gate cannot
    // read is not evidence that anything was spent.
    if (parsed.appeals !== undefined) {
      const a = parsed.appeals as { used?: unknown; decided?: unknown; pass?: unknown };
      const decisionsOk = !!a && typeof a === "object" &&
        typeof a.used === "number" && Number.isFinite(a.used) && a.used >= 0 &&
        !!a.decided && typeof a.decided === "object" && !Array.isArray(a.decided) &&
        Object.entries(a.decided as Record<string, unknown>).every(([digest, decision]) =>
          /^[0-9a-f]{64}$/.test(digest) &&
          ["GATE_WINS", "AGENT_WINS", "HUMAN"].includes(String(decision)));
      const p = a?.pass as { digest?: unknown; kind?: unknown; issuedAt?: unknown } | undefined;
      const passOk = p === undefined ||
        (!!p && typeof p === "object" && typeof p.digest === "string" && /^[0-9a-f]{64}$/.test(p.digest) &&
          typeof p.kind === "string" && typeof p.issuedAt === "string");
      if (!decisionsOk || !passOk) delete parsed.appeals;
    }
    const migrated = migrateFingerprintVersion(parsed);
    if (out) out.migrated = migrated;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Invalidate bindings that were produced by a DIFFERENT fingerprint algorithm.
 *
 * A digest only means something under the algorithm that produced it, so an
 * older (or newer, or corrupt) version number cannot be trusted, reinterpreted
 * or converted — it is dropped back to "needs a fresh round". The change flags
 * are deliberately preserved: the worktree really does hold uncommitted work,
 * and forgetting that would DISARM the gate instead of re-arming it.
 *
 * Returns true when a migration actually happened, so callers can tell the
 * user why their READY disappeared.
 */
export function migrateFingerprintVersion(state: GateState): boolean {
  if (state.fingerprintVersion === FINGERPRINT_VERSION) return false;
  state.fingerprintVersion = FINGERPRINT_VERSION;
  const hadBinding =
    state.review.verdict !== "PENDING" || state.review.fingerprint !== null ||
    state.precommit.verdict !== "NOT_RUN" || state.precommit.fingerprint !== null;
  state.review = { verdict: "PENDING", fingerprint: null, at: state.review.at };
  state.precommit = { verdict: "NOT_RUN", fingerprint: null, at: state.precommit.at };
  return hadBinding;
}

/** Operator-facing explanation for a fingerprint-algorithm migration. */
export const FINGERPRINT_MIGRATION_NOTICE =
  "review-gate: the worktree fingerprint algorithm changed in this version, so the previous " +
  "READY review and precommit PASS no longer describe this worktree and were invalidated " +
  "(the code itself was NOT modified). Run the precommit runner and an independent review again. " +
  "If the git hook keeps rejecting a commit the gate just approved, the resident extension is " +
  "still running the old algorithm — restart Pi (or /reload) first.";
