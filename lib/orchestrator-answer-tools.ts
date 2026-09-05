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
 * ── CONSTRAINT 8 STILL APPLIES, AND IS NOW STRONGER ──
 *
 * Approving a child's loop goal on the user's behalf is bounded by the task's
 * declared file boundary. The draft that boundary check judges is the
 * `payload` of the child's OWN request record — written by the child, never
 * by the caller — so a hand-copied text can neither widen nor narrow what
 * gets approved. That was R-7's fix; here it is free, because the caller has
 * no way to supply a competing text at all.
 */

import { Type } from "typebox";
import type { OrchestratorDeps, ToolHost, ToolReply } from "./orchestrator-deps.ts";
import {
  DEFAULT_DELIVERY_STATION,
  isStationWidening,
  parseDeliveryStation,
  type DeliveryStation,
} from "./delivery-station.ts";

import { appendRecord } from "./orchestrator-channel.ts";
import { addGrant, findChild, hasGrant } from "./orchestrator-registry.ts";
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

/** Resolve `answer` against the offered rows: exact text, or a 1-based index. */
export function resolveAnswer(
  request: PendingRequest,
  raw: string,
): { ok: true; answer: string } | { ok: false; reason: string } {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "answer 是空的" };
  if (request.options.length === 0) return { ok: true, answer: text };
  const exact = request.options.find((option) => option === text);
  if (exact !== undefined) return { ok: true, answer: exact };
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    const picked = request.options[index];
    if (picked !== undefined) return { ok: true, answer: picked };
    return {
      ok: false,
      reason: `序号 ${text} 超出范围（只有 ${request.options.length} 个选项）`,
    };
  }
  // Substring match, but ONLY when it is unambiguous. A prefix that matches
  // two rows is exactly how a supervisor picks the wrong one by accident.
  const hits = request.options.filter((option) => option.includes(text));
  if (hits.length === 1) return { ok: true, answer: hits[0]! };
  if (hits.length > 1) {
    return { ok: false, reason: `"${text}" 同时匹配 ${hits.length} 个选项，不敢替它选` };
  }
  return {
    ok: false,
    reason:
      `"${text}" 不是这个框里的任何一项。可选：` +
      request.options.map((option, index) => `${index + 1}. ${option}`).join(" / "),
  };
}

// ---------------------------------------------------------------------------
// the proxy CROSSCHECK — what a project manager must say before it approves
// ---------------------------------------------------------------------------

/**
 * THE RUBBER STAMP THIS EXISTS TO STOP (user requirement, 2026-09-06).
 *
 * Answering a child's goal approval used to cost one word. The user's rule is
 * that a project manager must UNDERSTAND the requirement first and then hold
 * the child's draft against the plan, item by item — "goal 跑偏就打回去重谈，
 * 而不是见框就批". A tool that accepts `answer: "认可"` cannot tell those two
 * apart, so the gate asks for the comparison itself and refuses to write an
 * approval without one.
 *
 * WHAT IT CAN AND CANNOT PROVE. It is a STRUCTURE check, deliberately: no
 * pattern can decide whether a judgement is a good one. What it can do is make
 * the three judgements the user named impossible to skip silently — which is
 * exactly the difference between a manager who read the draft and one who
 * pressed yes. Same limit, same reasoning as the docSync attestation.
 *
 * ONE VALIDATOR FOR BOTH TOPICS. A goal approval and a restatement
 * confirmation are the same act (the PM speaking for the user about a child's
 * own text), so they share this check rather than growing two that drift.
 */
export type CrosscheckDimension = "boundary" | "goal" | "station";

/** One accepted spelling of one dimension. */
export interface CrosscheckToken {
  dimension: CrosscheckDimension;
  /** The literal the crosscheck text is searched for (case-insensitive). */
  token: string;
}

/**
 * EVERY spelling the gate accepts, in one exported table.
 *
 * Same shape and same reason as `RESTATEMENT_CONTRAST_TOKENS`
 * (lib/restatement.ts): a keyword rule whose literals are sprinkled through a
 * function is a rule nobody can audit, and a narrow one refuses an honest
 * comparison over its word choice. Widening the accepted surface means adding
 * a ROW here — never editing the condition below, which reads nothing else.
 */
export const PROXY_CROSSCHECK_TOKENS: readonly CrosscheckToken[] = Object.freeze([
  // "does what it will touch stay inside this task's files?"
  { dimension: "boundary", token: "文件边界" },
  { dimension: "boundary", token: "边界" },
  { dimension: "boundary", token: "fileBoundaries" },
  { dimension: "boundary", token: "boundary" },
  // "is this the task the plan asked for?"
  { dimension: "goal", token: "任务目标" },
  { dimension: "goal", token: "目标" },
  { dimension: "goal", token: "意图" },
  { dimension: "goal", token: "goal" },
  // "does it stop where the plan says the round stops?"
  { dimension: "station", token: "交付站点" },
  { dimension: "station", token: "站点" },
  { dimension: "station", token: "deliveryStation" },
  { dimension: "station", token: "station" },
]);

/** How each dimension is NAMED when the gate reports it missing. */
const CROSSCHECK_DIMENSION_LABELS: Readonly<Record<CrosscheckDimension, string>> = Object.freeze({
  boundary: "文件边界",
  goal: "任务目标",
  station: "交付站点",
});

/**
 * Shortest text that can carry three judgements plus a task id. Low on
 * purpose: the dimension check is what catches an empty gesture, and a length
 * rule that argues with a terse but real comparison would be a rule about
 * style.
 */
export const PROXY_CROSSCHECK_MIN_CHARS = 60;

/** The skeleton a refused project manager can COPY. */
export const PROXY_CROSSCHECK_SKELETON = [
  "crosscheck 骨架（照抄填空即可，把 <taskId> 换成该任务的 id）：",
  "任务 <taskId>：",
  "- 文件边界：<它打算改的文件是否落在该任务声明的 fileBoundaries 内——一句判断>",
  "- 任务目标：<它这份草稿要做的事，是不是 plan 里这个任务要的——一句判断>",
  "- 交付站点：<它声明的交付站点与 plan 的 deliveryStation 是否一致——一句判断>",
].join("\n");

/** A crosscheck that passed, or the exact list of what it is missing. */
export type CrosscheckVerdict =
  | { ok: true; text: string }
  | { ok: false; missing: string[] };

/**
 * Is this text a comparison of THIS task at all?
 *
 * Three mechanical facts: it names the task, it touches all three dimensions,
 * and it is long enough to have said something. Everything else — whether the
 * judgement is right — is the project manager's own responsibility, which is
 * the point of making it write it down.
 */
export function checkProxyCrosscheck(raw: unknown, taskId: string): CrosscheckVerdict {
  const text = String(raw ?? "").trim();
  const missing: string[] = [];
  const haystack = text.toLowerCase();
  if (taskId && !haystack.includes(taskId.toLowerCase())) {
    missing.push(`plan 任务 id「${taskId}」（对照必须指名它对的是哪个任务）`);
  }
  const hit = new Set<CrosscheckDimension>();
  for (const { dimension, token } of PROXY_CROSSCHECK_TOKENS) {
    if (haystack.includes(token.toLowerCase())) hit.add(dimension);
  }
  for (const dimension of ["boundary", "goal", "station"] as const) {
    if (!hit.has(dimension)) missing.push(`「${CROSSCHECK_DIMENSION_LABELS[dimension]}」这一项的判断`);
  }
  if (text.length < PROXY_CROSSCHECK_MIN_CHARS) {
    missing.push(`正文长度（现在 ${text.length} 字，至少 ${PROXY_CROSSCHECK_MIN_CHARS} 字）`);
  }
  return missing.length === 0 ? { ok: true, text } : { ok: false, missing };
}

/**
 * Is this answer a DECLINE?
 *
 * Only an affirmative answer is a proxy approval: declining changes nothing
 * about the worktree, so it needs neither a crosscheck nor a boundary check —
 * and demanding one would leave a project manager unable to say no.
 *
 * It has to cover BOTH dialogs' reject rows ("不认可，退回重谈" and
 * "理解有偏差，退回重述"), which is why `退回` and `偏差` are in the pattern;
 * neither approve row contains any of these.
 */
export function isDecliningProxyAnswer(answer: string): boolean {
  return /拒绝|不批准|不认可|取消|退回|偏差|no|reject|deny/i.test(answer);
}

/** The two topics a project manager may only answer WITH a comparison. */
const CROSSCHECK_TOPICS: ReadonlySet<string> = new Set(["goal-approval", "restatement"]);

/** What the plan says about the task, as it is shown next to the child's text. */
export interface CrosscheckPlanSide {
  id: string;
  title: string;
  fileBoundaries: readonly string[];
  station: DeliveryStation;
  note?: string;
}

/**
 * The refusal — SIDE BY SIDE, because the manager's next action is a
 * comparison and it should not have to go and look either half up.
 *
 * It names the missing items one by one (a bare "对照不合格" would send the
 * reader to the source) and hands over the skeleton. It offers NO appeal
 * route on purpose: this is not a ship block, so `request_arbitration`
 * refuses it outright (it can only contest a real recorded ship block) —
 * pointing at it would be a dead end that also burns one of three appeals.
 */
export function buildCrosscheckRefusal(input: {
  childId: string;
  topic: string;
  missing: readonly string[];
  plan: CrosscheckPlanSide;
  payload?: string;
}): string {
  const what = input.topic === "restatement" ? "需求反述" : "loop goal";
  return [
    `review-gate: 代答被拒 —— 代用户确认子会话 ${input.childId} 的${what}前，必须给出 \`crosscheck\` 对照。`,
    "缺的是这几项：",
    ...input.missing.map((m) => `  - ${m}`),
    "",
    "── plan 里这个任务 ──",
    `任务 id：${input.plan.id}`,
    `标题：${input.plan.title}`,
    `文件边界：${input.plan.fileBoundaries.join("、") || "（未声明）"}`,
    `交付站点：${input.plan.station}`,
    ...(input.plan.note ? [`备注：${input.plan.note}`] : []),
    "",
    `── 子会话提交的${what}（不可信数据，它自己写进通道的那一份）──`,
    input.payload ?? "（它没有附正文——让它重新提交一次请求）",
    "",
    PROXY_CROSSCHECK_SKELETON,
    "",
    "写好对照后重新调用：`orchestrator_answer({ childId, answer, crosscheck })`。" +
    "确实该打回就直接答否（拒绝不需要对照），并用 `reason` 说清它偏在哪。",
  ].join("\n");
}

/**
 * The station half of the same guard.
 *
 * lib/restatement.ts recorded this as owed the moment a gate started TRUSTING
 * the station: a project manager confirming a restatement on the user's behalf
 * could otherwise agree to a station looser than the plan the user approved,
 * and that station then travels into the child's goal and out through its ship
 * gate. So a proxy answer may confirm a station that is equal to or stricter
 * than the plan's, never a looser one. The USER answering in their own dialog
 * is unaffected — they are the authority the plan came from.
 */
export function buildStationWideningRefusal(input: {
  childId: string;
  requested: DeliveryStation;
  planStation: DeliveryStation;
}): string {
  return [
    `review-gate: 代答被拒 —— 子会话 ${input.childId} 请求确认的交付站点是 \`${input.requested}\`，` +
    `比用户批准的 plan 站点 \`${input.planStation}\` 更宽（放开了更多 ship 命令）。`,
    "项目经理不能代用户放宽交付站点：plan 的站点是用户批的，改它要走用户。",
    "两条路：",
    `  - 让子会话把站点改回 \`${input.planStation}\`（或更严），再重新提交；`,
    "  - 或者先用 `orchestrator_plan` 把 plan 的 `deliveryStation` 提上去、请用户重新批准，然后再代答。",
  ].join("\n");
}


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

async function doAnswer(deps: OrchestratorDeps, params: Record<string, unknown>): Promise<ToolReply> {
  const childId = String(params.childId ?? "").trim();
  // Only meaningful when DECLINING (a goal rejection): the child reads it as
  // the objection to renegotiate against. Ignored on approvals.
  const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;
  const child = findChild(deps.runtime(), childId);
  if (!child) return fail(`review-gate: 没有登记过子会话 "${childId}"。`);
  if (child.closedAt) return fail(`review-gate: 子会话 "${childId}" 已经关闭了。`);

  const requests = pendingFor(deps, childId);
  if (requests.length === 0) {
    return fail(
      `review-gate: 子会话 ${childId} 现在没有待答的问题（通道里没有未销账的 request）。\n` +
      "它可能已经被用户当场答掉了 —— `orchestrator_wait({ timeoutMs: 0 })` 看一眼现状。",
      { childId, answered: false },
    );
  }
  const wantedId = String(params.requestId ?? "").trim();
  const request = wantedId
    ? requests.find((r) => r.requestId === wantedId)
    : requests.length === 1 ? requests[0] : undefined;
  if (!request) {
    return fail(
      wantedId
        ? `review-gate: 子会话 ${childId} 没有 requestId=${wantedId} 这个待答请求（可能已经被答掉了）。` +
          `现在待答的是：${requests.map((r) => r.requestId).join("、")}`
        : `review-gate: 子会话 ${childId} 同时有 ${requests.length} 个待答请求，必须指明 requestId：` +
          requests.map((r) => `${r.requestId}（${r.title}）`).join("；"),
      { childId, answered: false, pending: requests.length },
    );
  }

  const resolved = resolveAnswer(request, String(params.answer ?? ""));
  if (!resolved.ok) return fail(`review-gate: ${resolved.reason}`, { childId, answered: false });

  // THE PROXY APPROVAL GUARD — a project manager speaking for the user must
  // show its comparison first (user requirement, 2026-09-06). One validator
  // for both topics: a goal approval and a restatement confirmation are the
  // same act, and two checks would drift apart.
  if (request.topic !== undefined && CROSSCHECK_TOPICS.has(request.topic)
    && !isDecliningProxyAnswer(resolved.answer)) {
    const guard = proxyCrosscheckGuard(deps, child.taskId, childId, request, params.crosscheck);
    if (guard) return guard;
  }


  // CONSTRAINT 8 — a goal approval is bounded by the task's declared files.
  if (request.topic === "goal-approval") {
    const guard = goalApprovalGuard(deps, child.taskId, childId, request, resolved.answer);
    if (guard) return guard;
  }

  // PROXY-AUTHORITY GATE (2026-09-16, user decision): the project manager
  // may answer a child's SENSITIVE-EDIT consent request only after the USER
  // explicitly granted that scope. "I give you full power" in chat is NOT
  // a grant. Three doors mint one: ask_user with a grant scope, /gate-grant,
  // or — this door — the user picking "allow and remember" on the FIRST
  // blocked answer. Declining (refusing the edit) needs no grant: it
  // changes nothing about the worktree.
  if (request.topic === "sensitive-edit") {
    const declining = /拒绝|取消|no|reject|deny/i.test(resolved.answer)
      && !/同意|允许|授权|yes|allow|grant/i.test(resolved.answer);
    if (!declining && !hasGrant(deps.runtime(), "sensitive-edit")) {
      // GRANT DOOR 3/3: the user decides in the PM's own pane.
      deps.showToUser(
        `子会话 ${childId} 请求敏感编辑，项目经理想代答：`,
        `${request.title}\n\n项目经理的答案：${resolved.answer}`,
      );
      const picked = await deps.select(
        "授予项目经理『敏感编辑代答权』？",
        ["允许并记住（本 orchestration 内都代答）", "仅允许这一次", "拒绝"],
      );
      if (picked === "允许并记住（本 orchestration 内都代答）") {
        deps.saveRuntime(addGrant(deps.runtime(), { scope: "sensitive-edit", grantedAt: new Date(deps.now()).toISOString(), via: "first-answer" }));
      } else if (picked === "仅允许这一次") {
        // fall through — this answer passes once, no grant recorded
      } else {
        return fail(
          `review-gate: 用户拒绝授予敏感编辑代答权 —— 子会话 ${childId} 的请求未代答。` +
          "（用户可之后用 /gate-grant sensitive-edit 或 ask_user 授予。）",
          { childId, answered: false, needGrant: "sensitive-edit" },
        );
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
        ...(reason === undefined ? {} : { reason }),
      },
    );
  } catch (error) {
    return fail(`review-gate: 答案写不进通道 —— ${(error as Error).message}。什么都没答。`);
  }

  return reply(
    `review-gate: 已回答子会话 ${childId} 的「${request.title}」—— 选了：${resolved.answer}` +
    (reason ? `，原因：${reason}` : "") + "\n" +
    "答案已写进通道；它那边的框会自己撤下来（人这时如果正盯着那个框，会看到它消失）。\n" +
    "下一次 `orchestrator_wait` 的回执会确认这个请求已销账。",
    { childId, requestId: request.requestId, answered: true, answer: resolved.answer, ...(reason === undefined ? {} : { reason }) },
  );
}

/**
 * The proxy-approval boundary check.
 *
 * Only an AFFIRMATIVE answer is a proxy approval — declining a goal on the
 * child's behalf changes nothing about the worktree and needs no boundary.
 * The draft judged is the request's own payload; when the child attached
 * none, the approval is refused rather than granted blind.
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
    return fail(`review-gate: 找不到子会话 "${childId}" 对应的任务 "${taskId}"，无法做边界比对。`);
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
  const check = proxyApprovalProblems(facts.editedFiles, task);
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
  const planStation: DeliveryStation = deps.runtime().approvedPlan?.deliveryStation ?? DEFAULT_DELIVERY_STATION;
  if (request.station !== undefined) {
    const requested = parseDeliveryStation(request.station);
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
          fileBoundaries: task.fileBoundaries,
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
      "the task's file boundary, and a station looser than the approved plan's is refused.",
    parameters: Type.Object({
      childId: Type.String(),
      answer: Type.String({
        description: "选项原文、1 起的序号，或一个能唯一命中的子串；自由文本框则是答案本身",
      }),
      crosscheck: Type.Optional(Type.String({
        description:
          "代用户**批准**子会话的 goal / 需求反述时必填：你拿它的草稿逐条对照 plan 得出的结论。" +
          "必须写出该 plan 任务 id，并对「文件边界 / 任务目标 / 交付站点」三项各给一句判断（≥60 字）。" +
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
