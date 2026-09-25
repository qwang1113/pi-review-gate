/**
 * `orchestrator_answer` — the ONE way to answer a child's question.
 *
 * ── WHAT IT REPLACES, AND WHY BOTH HALVES HAD TO GO ──
 *
 * There used to be two tools. `orchestrator_read` captured the child's pane
 * and parsed a dialog out of the rendered text; `orchestrator_key` computed
 * arrow presses from that parse, sent them, re-read the screen and checked
 * the highlight had landed. Between them they produced R-1 (a status bar read
 * as a menu row), R-12 (a wrapped option silently lost), R3-4 (the title
 * taken from the wrong line) and R-8 (`Enter` and `C-m` both ignored by the
 * confirm dialog — only `KPEnter` worked, discovered by experiment).
 *
 * Every one of those is a symptom of the same thing: the question was
 * already a structured object inside the child's own gate, and the
 * orchestrator was reconstructing it from a picture of it.
 *
 * Now the child WRITES the question — title, every option in order, and the
 * full payload behind it — into its channel, and this tool writes the answer
 * back. The child's gate is sitting on a `Promise.race` around that channel
 * and its own `ui.select`, so the answer resolves the dialog directly and the
 * box disappears from the user's screen. There is no keystroke, no highlight
 * to verify, and nothing to parse — which is why reading and answering
 * collapse into ONE tool (philosophy two): the reading already happened, in
 * the `orchestrator_wait` receipt.
 *
 * ── CONSTRAINT 8 STILL APPLIES ──
 *
 * Approving a child's loop goal on the user's behalf is bounded by the
 * child's ACTUAL LANDINGS: it may not have written into a sensitive path
 * outside its repo. The draft the crosscheck judges is the `payload` of the
 * child's OWN request record — written by the child, never by the caller —
 * so a hand-copied text can neither widen nor narrow what gets approved.
 * That was R-7's fix; here it is free, because the caller has no way to
 * supply a competing text at all.
 */

import { Type } from "typebox";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";
import {
  DEFAULT_DELIVERY_STATION,
  isStationWidening,
  type DeliveryStation,
} from "./delivery-station.ts";
import { effectiveTaskStation } from "./repo-pr-policy.ts";

import { appendRecord } from "./channel-io.ts";
import { looksLikeDeclineRow, parseChoice, type ChoiceSpec } from "./choice-dialog.ts";
import {
  CROSSCHECK_TOPICS,
  buildCrosscheckRefusal,
  buildStationWideningRefusal,
  checkProxyCrosscheck,
  isDecliningProxyAnswer,
  normalizeAnswerItems,
  resolveAnswer,
  type AnswerItem,
} from "./orchestrator-answer-rules.ts";
import { isGrantableScope } from "./ask-user.ts";
import { addGrant, findChild, hasGrant, type ChildSession } from "./orchestrator-registry.ts";
import { proxyApprovalProblems } from "./orchestrator-gate.ts";
import { superviseChildren, type PendingRequest } from "./orchestrator-supervisor.ts";
import {
  alivePanes,
  childGateFacts,
  currentPlan,
  requireOrchestratorMode,
  toolFail as fail,
  toolReply as reply,
} from "./orchestrator-tool-kit.ts";

/**
 * What one proxy scope is called when the USER is asked about it.
 *
 * A LABEL TABLE, not a second list of scopes: WHICH topics are proxy-answerable
 * comes from `isGrantableScope` (lib/ask-user.ts owns the one list). The
 * identity chain this replaced had to be edited in two places, and the failure
 * mode of forgetting here was FAIL-OPEN — the project manager would silently
 * go back to approving that topic unconditionally.
 */
const PROXY_SCOPE_LABEL: Record<string, string> = {
  "sensitive-edit": "敏感编辑",
  "tmux-access": "tmux 授权",
};

/** The current unanswered questions of one child, straight from its channel. */
function pendingFor(deps: OrchestratorDeps, childId: string): PendingRequest[] {
  const runtime = deps.runtime();
  const child = findChild(runtime, childId);
  if (!child) return [];
  const panes = alivePanes(deps);
  const snapshot = superviseChildren({
    orchestrationId: runtime.orchestrationId,
    children: [child],
    livePanes: panes.ok ? new Set(panes.panes) : undefined,
    io: deps.channelIO(),
    ...(deps.channelHome() === undefined ? {} : { home: deps.channelHome()! }),
    at: deps.now(),
  });
  return snapshot.requests;
}

/** What one item did. */
type AnswerOutcome =
  | { ok: true; requestId: string; title: string; answer: string; reason?: string }
  | { ok: false; requestId?: string; refusal: ToolReply };

/**
 * WHICH open question this item is for.
 *
 * `answered` holds the ids this same call has already written an answer for,
 * and it is what keeps a batch honest: the pending list is read ONCE (the
 * child settles asynchronously, so re-reading it mid-batch would race with
 * its own settle records), so without this a repeated id — or a second item
 * with no id at all — would write a second answer to a question that is
 * already decided.
 */
function pickRequest(
  childId: string,
  requests: PendingRequest[],
  wantedId: string,
  answered: ReadonlySet<string>,
): { ok: true; request: PendingRequest } | { ok: false; refusal: ToolReply } {
  if (wantedId && answered.has(wantedId)) {
    return {
      ok: false,
      refusal: fail(
        `review-gate: requestId=${wantedId} 在这一次调用里已经回答过了，第二条被丢弃（不重复写）。`,
        { childId, answered: false },
      ),
    };
  }
  const open = requests.filter((r) => !answered.has(r.requestId));
  const request = wantedId
    ? open.find((r) => r.requestId === wantedId)
    : open.length === 1 ? open[0] : undefined;
  if (!request) {
    return {
      ok: false,
      refusal: fail(
        wantedId
          ? `review-gate: 子会话 ${childId} 没有 requestId=${wantedId} 这个待答请求（可能已经被答掉了）。` +
            `现在待答的是：${open.map((r) => r.requestId).join("、")}`
          : `review-gate: 子会话 ${childId} 同时有 ${open.length} 个待答请求，必须指明 requestId：` +
            open.map((r) => `${r.requestId}（${r.title}）`).join("；"),
        { childId, answered: false, pending: open.length },
      ),
    };
  }
  return { ok: true, request };
}

/**
 * Adjudicate ONE answer and write it — every rule, in the one place that has
 * them. Called once by the single form and once per item by the batch form.
 */
async function answerOneRequest(
  deps: OrchestratorDeps,
  child: ChildSession,
  request: PendingRequest,
  item: AnswerItem,
): Promise<AnswerOutcome> {
  const childId = child.id;
  const resolved = resolveAnswer(request, item.answer);
  if (!resolved.ok) {
    return {
      ok: false,
      requestId: request.requestId,
      refusal: fail(`review-gate: ${resolved.reason}`, { childId, answered: false }),
    };
  }

  // THE PROXY APPROVAL GUARD — a project manager speaking for the user must
  // show its comparison first (user requirement, 2026-09-06). One validator
  // for both topics: a goal approval and a restatement confirmation are the
  // same act, and two checks would drift apart.
  if (request.topic !== undefined && CROSSCHECK_TOPICS.has(request.topic)
    && !isDecliningProxyAnswer(resolved.answer)) {
    const guard = proxyCrosscheckGuard(deps, child.taskId, childId, request, item.crosscheck);
    if (guard) return { ok: false, requestId: request.requestId, refusal: guard };
  }


  // CONSTRAINT 8 — a goal approval is refused if the child has written to a
  // sensitive path outside its repo.
  if (request.topic === "goal-approval") {
    const guard = goalApprovalGuard(deps, child.taskId, childId, request, resolved.answer);
    if (guard) return { ok: false, requestId: request.requestId, refusal: guard };
  }

  // PROXY-AUTHORITY GATE (2026-09-16 user decision; tmux added 2026-09-17): the
  // project manager may answer a child's SENSITIVE-EDIT or TMUX-ACCESS consent
  // request only after the USER explicitly granted that scope. "I give you full
  // power" in chat is NOT a grant. Three doors mint one: ask_user with a grant
  // scope, /gate-grant, or — this door — the user picking "allow and remember"
  // on the FIRST blocked answer. Declining needs no grant: it changes nothing.
  //
  // WHY TMUX IS IN THE SAME CLASS as a sensitive file: `kill-server` ends the
  // user's whole tmux session and `new-session` puts surface outside the window
  // the work was agreed in — a child that could talk its manager into that
  // would have bypassed the permission the USER was just handed.
  const proxyScope = isGrantableScope(request.topic) ? request.topic : undefined;
  if (proxyScope) {
    const what = PROXY_SCOPE_LABEL[proxyScope] ?? proxyScope;
    // A `✎ …` row is a refusal REGARDLESS of its reason text (which may well
    // contain 授权/允许): the row itself is the answer, and reading it as a
    // request to grant would be the worst possible misread (reviewer P1).
    const declining = looksLikeDeclineRow(resolved.answer)
      || (/拒绝|取消|不选|no|reject|deny/i.test(resolved.answer)
        && !/同意|允许|授权|yes|allow|grant/i.test(resolved.answer));
    if (!declining && !hasGrant(deps.runtime(), proxyScope)) {
      // GRANT DOOR 3/3: the user decides in the PM's own pane.
      deps.showToUser(
        `子会话 ${childId} 请求${what}，项目经理想代答：`,
        `${request.title}\n\n项目经理的答案：${resolved.answer}`,
      );
      const grantSpec: ChoiceSpec = {
        title: `授予项目经理『${what}代答权』？`,
        options: ["允许并记住（本 orchestration 内都代答）", "仅允许这一次", "拒绝"],
        recommended: "拒绝",
      };
      const picked = parseChoice(await deps.askChoice(grantSpec), grantSpec);
      if (picked.kind === "chose" && picked.option === grantSpec.options[0]) {
        deps.saveRuntime(addGrant(deps.runtime(), { scope: proxyScope, grantedAt: new Date(deps.now()).toISOString(), via: "first-answer" }));
      } else if (picked.kind === "chose" && picked.option === "仅允许这一次") {
        // fall through — this answer passes once, no grant recorded
      } else {
        return {
          ok: false,
          requestId: request.requestId,
          refusal: fail(
            `review-gate: 用户拒绝授予${what}代答权` +
            (picked.kind === "declined" && picked.reason ? `（原因：${picked.reason}）` : "") +
            ` —— 子会话 ${childId} 的请求未代答。` +
            `（用户可之后用 /gate-grant ${proxyScope} 或 ask_user 授予。）`,
            { childId, answered: false, needGrant: proxyScope },
          ),
        };
      }
    }
  }

  try {
    appendRecord(
      deps.channelIO(),
      {
        orchestrationId: deps.runtime().orchestrationId,
        childId,
        ...(deps.channelHome() === undefined ? {} : { home: deps.channelHome()! }),
      },
      {
        kind: "answer",
        from: "orchestrator",
        at: new Date(deps.now()).toISOString(),
        requestId: request.requestId,
        answer: resolved.answer,
        ...(item.reason === undefined ? {} : { reason: item.reason }),
      },
    );
  } catch (error) {
    return {
      ok: false,
      requestId: request.requestId,
      refusal: fail(`review-gate: 答案写不进通道 —— ${(error as Error).message}。什么都没答。`),
    };
  }

  return {
    ok: true,
    requestId: request.requestId,
    title: request.title,
    answer: resolved.answer,
    ...(item.reason === undefined ? {} : { reason: item.reason }),
  };
}

async function doAnswer(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  const child = findChild(deps.runtime(), childId);
  if (!child) return fail(`review-gate: 没有登记过子会话 "${childId}"。`);
  if (child.closedAt) return fail(`review-gate: 子会话 "${childId}" 已经关闭了。`);

  // ONE ROUND, ONE OR MANY QUESTIONS (2026-09-06). A child's `ask_user`
  // interview now reaches the receipt whole (its questions carry a batch
  // stamp), so answering it one tool call at a time was the only round trip
  // left. `answers` closes it; `answer` is unchanged for the single case,
  // and both walk the same adjudication.
  const batch = normalizeAnswerItems(params.answers);
  if (batch !== undefined && batch.length === 0) {
    return fail("review-gate: answers 是空数组 —— 什么都没答。要么给它元素，要么用单问形式的 answer。", { childId, answered: false });
  }
  const items: AnswerItem[] = batch ?? [{
    answer: String(params.answer ?? ""),
    ...(String(params.requestId ?? "").trim() ? { requestId: String(params.requestId).trim() } : {}),
    // Only meaningful when DECLINING (a goal rejection): the child reads it as
    // the objection to renegotiate against. Ignored on approvals.
    ...(typeof params.reason === "string" && params.reason.trim() ? { reason: params.reason.trim() } : {}),
    ...(params.crosscheck === undefined ? {} : { crosscheck: params.crosscheck }),
  }];

  const requests = pendingFor(deps, childId);
  if (requests.length === 0) {
    return fail(
      `review-gate: 子会话 ${childId} 现在没有待答的问题（通道里没有未销账的 request）。\n` +
      "它可能已经被用户当场答掉了 —— `orchestrator_wait({ timeoutMs: 0 })` 看一眼现状。",
      { childId, answered: false },
    );
  }

  const answeredIds = new Set<string>();
  const outcomes: AnswerOutcome[] = [];
  for (const item of items) {
    const picked = pickRequest(childId, requests, item.requestId ?? "", answeredIds);
    if (!picked.ok) {
      outcomes.push({ ok: false, refusal: picked.refusal });
      continue;
    }
    const outcome = await answerOneRequest(deps, child, picked.request, item);
    outcomes.push(outcome);
    // Answered or refused, this question is spoken for in this round: a
    // refusal must not make the NEXT item silently target the same box.
    answeredIds.add(picked.request.requestId);
  }

  // The single form keeps its exact reply — it is what every existing caller
  // (including a project manager running an older build) reads back.
  if (outcomes.length === 1) {
    const only = outcomes[0]!;
    if (!only.ok) return only.refusal;
    return reply(
      `review-gate: 已回答子会话 ${childId} 的「${only.title}」—— 选了：${only.answer}` +
      (only.reason ? `，原因：${only.reason}` : "") + "\n" +
      "答案已写进通道；它那边的框会自己撤下来（人这时如果正盯着那个框，会看到它消失）。\n" +
      "下一次 `orchestrator_wait` 的回执会确认这个请求已销账。",
      { childId, requestId: only.requestId, answered: true, answer: only.answer, ...(only.reason === undefined ? {} : { reason: only.reason }) },
    );
  }

  const done = outcomes.filter((o): o is Extract<AnswerOutcome, { ok: true }> => o.ok);
  const lines = outcomes.map((o, index) => (o.ok
    ? `${index + 1}. ✅ ${o.requestId}「${o.title}」→ 选了：${o.answer}${o.reason ? `（原因：${o.reason}）` : ""}`
    : `${index + 1}. ❌ ${o.requestId ?? "（没定位到请求）"} —— ${o.refusal.content.map((c) => c.text).join(" ")}`));
  const text =
    `review-gate: 一次性回答子会话 ${childId} 的 ${outcomes.length} 个问题 —— 成功 ${done.length}，被拒 ${outcomes.length - done.length}。\n` +
    lines.join("\n") + "\n" +
    // EVERY ITEM IS ITS OWN DECISION, and nothing rolls back: an answer that
    // reached the channel cannot be unwritten, so a batch never pretends to
    // be a transaction. Fix a refused item and answer that one again.
    "每条独立裁决：被拒的那条没有写进通道，改好后再单独回答它即可；已写进去的不会回滚。\n" +
    "子会话那边的框会按题序自己撤下来。";
  const details = {
    childId,
    answered: done.length,
    refused: outcomes.length - done.length,
    results: outcomes.map((o) => (o.ok
      ? { requestId: o.requestId, ok: true, answer: o.answer }
      : { ...(o.requestId === undefined ? {} : { requestId: o.requestId }), ok: false })),
  };
  return done.length === 0 ? fail(text, details) : reply(text, details);
}


/**
 * The proxy-approval out-of-repo check.
 *
 * Only an AFFIRMATIVE answer is a proxy approval — declining a goal on the
 * child's behalf changes nothing about the worktree. The draft judged is the
 * request's own payload; when the child attached none, the approval is
 * refused rather than granted blind.
 */
function goalApprovalGuard(
  deps: OrchestratorDeps,
  taskId: string,
  childId: string,
  request: PendingRequest,
  answer: string,
): ToolReply | undefined {
  // ONE reading of "this is a no", shared with the crosscheck guard: two
  // patterns would eventually disagree about the same answer, and the pair
  // that disagreed would let a decline through one check and into the other.
  if (isDecliningProxyAnswer(answer)) return undefined;

  const { plan } = currentPlan(deps);
  const task = plan?.tasks.find((t) => t.id === taskId);
  if (!task) {
    return fail(`review-gate: 找不到子会话 "${childId}" 对应的任务 "${taskId}"，无法做 plan 对照。`);
  }
  if (!request.payload) {
    return fail(
      `review-gate: 代批被拒 —— 子会话 ${childId} 的批准请求里没有带上 goal 全文，` +
      "门禁只批**它自己写进通道的那一份**（R-7）。让它重新提交一次批准。",
      { childId, approved: false },
    );
  }
  // R3-1 — CONSTRAINT 8 IS JUDGED ON FILES, NOT ON PROSE. What decides the
  // approval is where this child has actually written: a documentation goal
  // that quotes the modules it documents is not a scope change, and treating
  // it as one cost two bypasses in the third run.
  const facts = childGateFacts(deps, findChild(deps.runtime(), childId)!);
  const check = proxyApprovalProblems(facts.editedFiles);
  if (!check.ok) return fail("review-gate: " + check.reason, { outside: check.outside });
  return undefined;
}


/**
 * The proxy CROSSCHECK guard — two refusals, one entry point.
 *
 * It runs for both approvable topics and asks, in this order:
 *
 *  1. does the station the child is asking to have confirmed stay inside the
 *     plan the USER approved? (a manager may tighten, never widen)
 *  2. did the manager write the comparison, naming the task and judging all
 *     three dimensions?
 *
 * The station comes first because no amount of writing fixes it: a station
 * looser than the plan's is a decision only the user can make, so telling the
 * manager to improve its prose would be the wrong next step.
 */
function proxyCrosscheckGuard(
  deps: OrchestratorDeps,
  taskId: string,
  childId: string,
  request: PendingRequest,
  crosscheckRaw: unknown,
): ToolReply | undefined {
  const { plan, problem } = currentPlan(deps);
  if (problem) return problem;
  const task = plan?.tasks.find((t) => t.id === taskId);
  if (!task) {
    return fail(
      `review-gate: 找不到子会话 "${childId}" 对应的任务 "${taskId}"，无法做 plan 对照，因此不代答。`,
      { childId, answered: false },
    );
  }
  // The station the USER approved — the snapshot, never the plan FILE: an
  // edited-but-unapproved plan must not be able to raise its own ceiling.
  // Absent (a runtime written before the field existed) reads as the
  // strictest station, the same reading lib/orchestrator-plan-approval.ts
  // applies when it decides whether an edit widened the plan.
  //
  // AND NARROWED PER REPO (2026-09-15): when the approved plan holds more than
  // one task in this task's repo, that repo stops at `commit` unless the user
  // allowed it to split (lib/repo-pr-policy.ts). The comparison below is what
  // stops a manager from confirming on the user's behalf a station the plan
  // already ruled out — so it has to compare against the NARROWED ceiling, not
  // the plan's headline station.
  // AND THE ACCEPTANCE TASK IS EXEMPT (2026-09-18; the tail became two links
  // 2026-09-22): the plan's LAST task takes the
  // plan's own station — it is the one that delivers, and capping it would
  // leave nobody who may publish. `effectiveTaskStation` is the ONE place that
  // answers the question, so this comparison cannot disagree with the ceiling
  // the child was spawned with.
  const approved = deps.runtime().approvedPlan;
  const planStation: DeliveryStation = approved
    ? effectiveTaskStation(
      {
        deliveryStation: approved.deliveryStation ?? DEFAULT_DELIVERY_STATION,
        ...(approved.allowMultiplePrs === undefined ? {} : { allowMultiplePrs: approved.allowMultiplePrs }),
        tasks: approved.tasks,
      },
      task,
      deps.repoRoot,
    )
    : DEFAULT_DELIVERY_STATION;
  // `request.station` arrives SANITIZED from the channel boundary
  // (`sanitizeDeliveryStation`), so there is nothing to parse here and no
  // second validator to drift: it is one of the three, or it is absent
  // because the child said nothing readable — and then there is no station to
  // compare and the crosscheck below is the whole check.
  const requested = request.station;
  if (requested !== undefined) {

    if (isStationWidening(planStation, requested)) {
      return fail(
        buildStationWideningRefusal({ childId, requested, planStation }),
        { childId, answered: false, requestedStation: requested, planStation },
      );
    }
  }
  const checked = checkProxyCrosscheck(crosscheckRaw, task.id);
  if (!checked.ok) {
    return fail(
      buildCrosscheckRefusal({
        childId,
        topic: request.topic ?? "",
        missing: checked.missing,
        plan: {
          id: task.id,
          title: task.title,
          station: planStation,
          ...(task.note === undefined ? {} : { note: task.note }),
        },
        ...(request.payload === undefined ? {} : { payload: request.payload }),
      }),
      { childId, answered: false, missing: checked.missing },
    );
  }
  return undefined;
}

/** Register the single answering tool. */
export function registerOrchestratorAnswerTool(host: ToolHost, deps: OrchestratorDeps): void {
  host.registerTool({
    name: "orchestrator_answer",
    label: "Answer A Child Session",
    description:
      "Answer a question a child session is waiting on. The question — its title, every option " +
      "in order, and the full text behind it — is already in the `orchestrator_wait` receipt, " +
      "written there by the CHILD's own gate: nothing was read off a screen, so there is nothing " +
      "to parse and no keystroke to verify. `answer` takes the option's exact text, its 1-based " +
      "number, or an unambiguous substring; an ambiguous one is REFUSED rather than guessed. " +
      "Writing the answer resolves the dialog inside the child and the box disappears from the " +
      "user's screen — and if the user got there first, this reports that the request is already " +
      "settled instead of answering a second time. APPROVING a child's loop goal or its " +
      "requirement restatement on the user's behalf additionally requires `crosscheck` — the " +
      "comparison you made against the plan task — and is bounded by constraint 8: the draft " +
      "checked is the one the CHILD wrote into the channel, so no text you could pass can widen " +
      "what was approved, and a station looser than the approved plan's is refused. " +
      "A CHECKBOX question (the receipt marks it 「多选题（可答多项）」) takes SEVERAL answers: " +
      "write them as `A, C` — commas, 、, spaces, `+` and `/` all separate them — and it accepts " +
      "a single `A` too; a row it cannot read refuses the whole answer rather than guessing. " +
      "A child's `ask_user` INTERVIEW arrives as a batch (its questions share a batch stamp and " +
      "all of them are in the receipt at once): answer the whole thing in ONE call with " +
      "`answers: [{requestId, answer}, ...]` instead of one call per question. Every item is " +
      "adjudicated on its own — a refused one does not stop the others, and nothing rolls back.",
    parameters: Type.Object({
      childId: Type.String(),
      answer: Type.Optional(Type.String({
        description: "选项原文、1 起的序号，或一个能唯一命中的子串；自由文本框则是答案本身。回一整批时改用 answers。",
      })),
      answers: Type.Optional(Type.Array(
        Type.Object({
          requestId: Type.String({ description: "要回答的那个待答请求（回执里有）" }),
          answer: Type.String({ description: "选项原文、1 起的序号，或一个能唯一命中的子串" }),
          reason: Type.Optional(Type.String({ description: "拒绝原因（仅拒绝 goal 时填）" })),
          crosscheck: Type.Optional(Type.String({ description: "代批 goal / 需求反述时必填，见 crosscheck" })),
        }),
        {
          description:
            "一次性回答同一个子会话的多个待答请求（它一次 ask_user 提交的整批问题）。" +
            "每条独立裁决：某条被拒不影响其余条，已写进通道的答案不回滚。给了它就不要再给 answer。",
        },
      )),

      crosscheck: Type.Optional(Type.String({
        description:
          "代用户**批准**子会话的 goal / 需求反述时必填：你拿它的草稿逐条对照 plan 得出的结论。" +
          "必须写出该 plan 任务 id，并对「任务目标 / 交付站点」两项各给一句判断（≥60 字）。" +
          "拒绝不需要填；缺项会被退回，并把 plan 任务与它的正文并排贴给你。",
      })),
      reason: Type.Optional(Type.String({
        description: "拒绝原因（仅拒绝 goal 时填）——会随答案写进通道，子会话拿它重新协商，不再干等原因",
      })),
      requestId: Type.Optional(Type.String({
        description: "同时有多个待答请求时必填（回执与 wait 的收据里都有它）",
      })),

    }),
    execute: async (_id, params) => {
      const refusal = requireOrchestratorMode(deps);
      if (refusal) return refusal;
      return doAnswer(deps, params);
    },
  });
}
