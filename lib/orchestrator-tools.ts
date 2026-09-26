/**
 * The PLAN tool's REGISTRATION — the orchestration's own bookkeeping surface.
 *
 * The session tools (spawn / send / wait / close / relay) live in
 * lib/orchestrator-session-tools.ts; this one does not touch tmux at all.
 * Split that way because they have genuinely different failure modes:
 * everything here is a decision about STATE, everything there is a decision
 * about somebody else's PROCESS. What each action DOES is
 * lib/orchestrator-plan-action.ts; what the user reads when approving is
 * lib/orchestrator-plan-messages.ts.
 *
 * `orchestrator_plan` carries an `action` rather than being five tools,
 * because the plan is one object with one approval binding: splitting it
 * would invite an agent to mutate a task's status through one tool while the
 * approval hash was computed by another.
 */

import { Type } from "typebox";
import type { OrchestratorDeps, ToolHost } from "./orchestrator-deps.ts";
import { PLAN_FINISH_TASK_BRIEF, PLAN_TASK_SKELETON } from "./orchestrator-directives.ts";
import { DELIVERY_STATION_CHOICES } from "./delivery-station.ts";
import { requireOrchestratorMode } from "./orchestrator-tool-kit.ts";
import { PLAN_ACTIONS, handlePlanAction } from "./orchestrator-plan-action.ts";

/** Register the `orchestrator_plan` state machine. */
export function registerOrchestratorStateTools(host: ToolHost, deps: OrchestratorDeps): void {
  host.registerTool({
    name: "orchestrator_plan",
    label: "Orchestrator Plan",
    description:
      "Read or change the orchestration PLAN — the task list that is this orchestration's exit " +
      "contract, and the only thing that authorizes spawning a child session. Actions: " +
      "\"read\" (default), \"write\" (replace the plan; every task MUST declare repo), " +
      "\"submit\" (the gate AUDITS the plan with a judge process first — minutes-long — and only " +
      "asks the USER to approve it if the audit passes; a failed audit comes back as findings " +
      "with no dialog shown, so fix them and submit again), \"set-status\" (move one task through " +
      "the state machine — `write` never changes a status), \"add-decision\" / \"resolve-decision\" " +
      "(questions only the human can settle), \"archive\" (a PREVIOUS orchestration's plan is in " +
      "this repo and you are starting a new round: the gate moves it aside — plan AND child " +
      "registry — into a timestamped file in `.pi/`, asks the user first WHEN THE PLAN STILL " +
      "HAS UNFINISHED TASKS (every task done ⇒ it just archives), and NEVER deletes " +
      "anything; it refuses while a registered child pane is still alive and points you at " +
      "`orchestrator_attach` instead). WHAT `write` DOES TO THE APPROVAL: it keeps it for " +
      "edits that grant nothing new — a dropped task, an added dependency, " +
      "parallel→serial, a lower maxParallel, a lowered deliveryStation — and records why. " +
      "It REVOKES it for a new task, a change of a task's repo, a removed dependency, " +
      "serial→parallel, a higher maxParallel, a raised deliveryStation, a repo ADDED to " +
      "`allowMultiplePrs`, or a task whose OWN station got wider — the plan's LAST task is " +
      "exempt from the same-repo narrowing (it is the one that delivers), so reordering the " +
      "list or dropping a sibling can hand another task the right to push and open the PR. " +
      "So refine the task list freely as you learn where the work lands; only real widening costs " +
      "the user a dialog. " +
      "REQUIRED BEFORE `submit`: a restatement the USER confirmed (`propose_restatement`) — " +
      "without one submit refuses outright and shows no dialog. `deliveryStation` says where the " +
      "whole orchestration stops (" + DELIVERY_STATION_CHOICES + ", default precommit); raising " +
      "it is a widening like any other. " +
      "ONE REQUIREMENT, ONE PR PER REPO: when one repo holds more than one task, that repo's " +
      "children stop at `commit` — the manager merges them locally and ONE PR comes out of the " +
      "combined result. The plan's TAIL is TWO tasks: the second-to-last (the wrap-up) merges the " +
      "siblings' branches, takes the whole through one review and commits — it is capped like any " +
      "other task — and the LAST one (the independent acceptance task) runs the real acceptance, " +
      "pushes and opens that PR; only that task is never capped. " +
      "`allowMultiplePrs` names the repos the USER allowed to split; it is the " +
      "ONLY way out of that rule, so never fill it in on your own initiative. " +
      // The manager reads THIS description while writing tasks, so the task
      // book's shape belongs here too — from the same constant the `note`
      // field describes itself with and the standing block renders.
      "每个任务的说明书写在 `plan.tasks[].note`（它不参与批准：改 note 不重审、也不重批）：\n" +
      PLAN_TASK_SKELETON +
      "\n\n" +
      PLAN_FINISH_TASK_BRIEF,

    parameters: Type.Object({
      action: Type.Optional(Type.Enum(PLAN_ACTIONS)),
      plan: Type.Optional(Type.Object({
        title: Type.String({ description: "Plan title (required for write)" }),
        intent: Type.String({ description: "One-line intent (required for write)" }),
        maxParallel: Type.Optional(Type.Number({ description: "Parallelism cap (default 2)" })),
        deliveryStation: Type.Optional(Type.String({
          description:
            "Where this orchestration stops: " + DELIVERY_STATION_CHOICES +
            " (default precommit — the user commits). Ask the user; do not pick for them.",
        })),
        tasks: Type.Array(Type.Object({
          id: Type.String({ description: "Task id, [A-Za-z0-9._-] 1-64 chars" }),
          title: Type.String({ description: "Task title" }),
          repo: Type.String({ description: "ABSOLUTE path of the repo this task works in (the child's cwd) — REQUIRED since 2026-09-02; a missing repo silently lands the child in the orchestrator's own repo" }),
          dependsOn: Type.Optional(Type.Array(Type.String())),
          execution: Type.Optional(Type.Union([Type.Literal("serial"), Type.Literal("parallel")])),
          status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("blocked")])),
          // THE TASK BOOK (user ask, 2026-09-17): this is the field the plan
          // audit reads (「任务书完整度」) and the only place a task's
          // instructions live. `note` is excluded from `canonicalPlanText`, so
          // writing it here grants nothing and revokes nothing — it is
          // instructions, not a contract boundary.
          note: Type.Optional(Type.String({
            description:
              "任务书写在这里（把 `<…>` 换成你的事实；note 是给子会话的说明书，不参与 plan 批准）：\n" +
              PLAN_TASK_SKELETON +
              "\n\n" +
              PLAN_FINISH_TASK_BRIEF,
          })),
        })),
        decisions: Type.Optional(Type.Array(Type.Object({
          id: Type.String(),
          question: Type.String(),
          planEffect: Type.Optional(Type.String()),
        }))),
        allowMultiplePrs: Type.Optional(Type.Array(Type.String({
          description:
            "ABSOLUTE repo paths the USER allowed to open more than one PR. Absent (the default) " +
            "IS the rule: a repo holding two or more tasks stops at `commit`, so ONE PR comes out " +
            "of the local merge. Adding a repo here is a widening — the approval is revoked and " +
            "the user is asked again; removing one only narrows. Never add one on your own.",
        }))),
      }, {
        description:
          "For action=\"write\": { title, intent, maxParallel?, tasks: [{ id, title, " +
          "repo: \"/abs/path/to/repo\", dependsOn?: [], execution?: \"serial\"|\"parallel\" }], " +
          "allowMultiplePrs?: [\"/abs/repo\"] (only repos the USER agreed may split into " +
          "several PRs) }. " +
          "Do NOT send `status`: existing tasks keep the status execution gave them (use " +
          "\"set-status\"), and only a genuinely new task starts at `pending`. " +
          "Pass the plan as a plain OBJECT — never a JSON string or a nested wrapper.",
      })),
      taskId: Type.Optional(Type.String({ description: "For action=\"set-status\"" })),
      status: Type.Optional(Type.Enum({ pending: "pending", running: "running", done: "done", blocked: "blocked" })),
      note: Type.Optional(Type.String({
        description:
          "For action=\"set-status\": WHY. Recorded in the gate log only — it never touches the task " +
          "book (`plan.tasks[].note`), which is the assignment a child session is handed.",
      })),
      decisionId: Type.Optional(Type.String({
        description: "For action=\"resolve-decision\" (add-decision mints its own id)",
      })),

      question: Type.Optional(Type.String({ description: "For action=\"add-decision\"" })),
      planEffect: Type.Optional(Type.String({
        description:
          "For action=\"add-decision\": what the PLAN must become once this is answered " +
          "(e.g. \"若用户选 B，任务 t3 的边界要加 scripts/\"). Shown until the decision is resolved.",
      })),
      answer: Type.Optional(Type.String({ description: "For action=\"resolve-decision\"" })),

    }),
    async execute(_id, params, signal, onUpdate) {
      const refusal = requireOrchestratorMode(deps);
      if (refusal) return refusal;
      return handlePlanAction(deps, params, onUpdate as { step?: (t: string) => void; done?: (t: string) => void } | undefined, signal as AbortSignal | undefined);
    },
  });

  // THERE IS NO `orchestrator_status` (2026-08-30). Everything it printed —
  // the plan, the children, what a handoff left behind, and what still blocks
  // `declare_done` — is now blocks 1–5 of the `orchestrator_wait` receipt,
  // reachable with `timeoutMs: 0` when an instant snapshot is what is wanted.
  // Two tools answering "how are things" is philosophy two's exact failure
  // mode: the agent has to pick, and the one it picks is the one that happens
  // to be shorter to type.

  // THERE IS NO `orchestrator_notify` EITHER (user decision, 2026-09-17).
  // Letting the manager choose when to interrupt the human is exactly what the
  // notification rule exists to prevent; the gate now raises the banner itself
  // for three kinds of event and for nothing else (lib/user-notify.ts owns the
  // policy; the extension wires the four call sites — completion, abnormal
  // exit, a dialog that is waiting, and a plan decision being registered,
  // which is the second entry point of the third kind). A manager that needs a
  // person calls `ask_user`, which IS one of them.
}
