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
      },
    );
  } catch (error) {
    return fail(`review-gate: 答案写不进通道 —— ${(error as Error).message}。什么都没答。`);
  }

  return reply(
    `review-gate: 已回答子会话 ${childId} 的「${request.title}」—— 选了：${resolved.answer}\n` +
    "答案已写进通道；它那边的框会自己撤下来（人这时如果正盯着那个框，会看到它消失）。\n" +
    "下一次 `orchestrator_wait` 的回执会确认这个请求已销账。",
    { childId, requestId: request.requestId, answered: true, answer: resolved.answer },
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
  if (/拒绝|不批准|取消|no|reject/i.test(answer)) return undefined;
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
      "settled instead of answering a second time. Approving a child's loop goal is allowed here " +
      "and is bounded by constraint 8: the draft checked is the one the CHILD wrote into the " +
      "channel, so no text you could pass can widen the task's file boundary.",
    parameters: Type.Object({
      childId: Type.String(),
      answer: Type.String({
        description: "选项原文、1 起的序号，或一个能唯一命中的子串；自由文本框则是答案本身",
      }),
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
