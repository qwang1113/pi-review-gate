/**
 * 定时任务表单 —— 两条提交路径写在同一个文件里，因为它们是同一次决定的两种结果：
 *
 *   - 「起 authoring 会话」（新增 / 改需求）：`POST /api/schedules/author`。
 *     daemon **不写调度表**（`docs/daemon/api.md` §13.3）：它只起会话，契约要由
 *     用户在门禁的对话框里批准，写表的永远是 `schedule_task` 工具。所以提交成功
 *     只意味着「会话起了」，任务要等批准之后才出现在列表里 —— 文案必须说清这件事。
 *   - 「只改周期」：`PUT /api/schedules/:id`（§13.4），不重新协商、不弹反述。
 *
 * 面板没有「直接改需求 / repo」的路径：daemon 会 400，判定在 store 的
 * `applyScheduleEdit({from:"panel"})` 里（唯一实现）。这里做的是把它的原文显示
 * 出来，不是把那条规则再写一遍。
 */

import { useState } from "react";

import { RepoPicker } from "@/components/repo-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, describeError } from "@/lib/api";
import type { ScheduleAuthorResponse, ScheduledTask, ScheduleTaskWriteResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

export type ScheduleFormMode = "create" | "requirement" | "cycle";

export type ScheduleFormResult =
  | { kind: "author"; receipt: ScheduleAuthorResponse }
  | { kind: "cycle"; task: ScheduledTask };

/** The three shortcuts. Their labels are `describeCron`'s own wording for these expressions. */
const CRON_PRESETS = [
  { label: "每天 09:00", cron: "0 9 * * *" },
  { label: "每小时", cron: "0 * * * *" },
  { label: "每周一 08:00", cron: "0 8 * * 1" },
] as const;

export function ScheduleForm({
  mode,
  task,
  onCancel,
  onDone,
}: {
  mode: ScheduleFormMode;
  /** `requirement` / `cycle` 的目标；`create` 时没有。 */
  task?: ScheduledTask;
  onCancel: () => void;
  onDone: (result: ScheduleFormResult) => void;
}) {
  const authoring = mode !== "cycle";
  const [name, setName] = useState(() => (mode === "create" ? "" : task?.name ?? ""));
  const [repo, setRepo] = useState(() => task?.repo ?? "");
  const [cron, setCron] = useState(() => task?.cron ?? CRON_PRESETS[0].cron);
  const [requirement, setRequirement] = useState(() => task?.requirement ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // `create` needs a name; `cycle` needs the task it edits. Nothing else is a
  // rule this side owns — the daemon validates names, repos and cron itself.
  const canSubmit =
    !busy &&
    cron.trim() !== "" &&
    (authoring ? name.trim() !== "" && repo !== "" && requirement.trim() !== "" : task !== undefined);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = cron.trim();
      if (authoring) {
        const receipt = await api<ScheduleAuthorResponse>("/api/schedules/author", {
          method: "POST",
          body: {
            action: mode === "create" ? "create" : "update",
            ...(task === undefined ? {} : { id: task.id }),
            name: name.trim(),
            repo,
            cron: trimmed,
            requirement: requirement.trim(),
          },
        });
        onDone({ kind: "author", receipt });
      } else if (task !== undefined) {
        const payload = await api<ScheduleTaskWriteResponse>(`/api/schedules/${encodeURIComponent(task.id)}`, {
          method: "PUT",
          body: { cron: trimmed },
        });
        onDone({ kind: "cycle", task: payload.task });
      }
    } catch (failure) {
      // The daemon refused (bad cron, taken name, a version race…): its own
      // sentence is shown, and every field stays exactly as typed.
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-4">
          {mode === "create" && (
            <div className="flex flex-col gap-1.5">
              <Label>名字</Label>
              <Input
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 daily-audit"
                className="h-8"
              />
              <p className="text-[11px] text-muted-foreground">
                kebab-case（小写字母、数字、单连字符，2–32 位），在定时任务里全局唯一 —— 与 id 共用一个命名空间。
              </p>
            </div>
          )}

          {authoring && (
            <div className="flex flex-col gap-1.5">
              <Label>仓库</Label>
              <RepoPicker value={repo} onChange={setRepo} disabled={busy} />
              <p className="text-[11px] text-muted-foreground">
                {mode === "create"
                  ? "到点之后，会话就在这个仓库里跑。"
                  : "契约绑不住仓库：换 repo 同样是重新协商，所以它和新任务走同一条批准流程。"}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>周期</Label>
            <div className="flex flex-wrap gap-1">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  disabled={busy}
                  onClick={() => setCron(preset.cron)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-[12px] transition-colors",
                    cron.trim() === preset.cron
                      ? "border-primary bg-primary/5 text-primary"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <Input
              value={cron}
              disabled={busy}
              onChange={(event) => setCron(event.target.value)}
              placeholder="0 9 * * *"
              className="h-8 font-mono"
            />
            <p className="text-[11px] text-muted-foreground">
              5 段表达式：分 时 日 月 周（本地时间）。上面三个快捷项填的就是它们，也可以直接改。
            </p>
          </div>

          {authoring && (
            <div className="flex flex-col gap-1.5">
              <Label>需求描述</Label>
              <Textarea
                className="min-h-28 resize-y"
                value={requirement}
                disabled={busy}
                onChange={(event) => setRequirement(event.target.value)}
                placeholder="一句话说清这次定时运行要做什么 —— 它会成为契约里的需求反述。"
              />
            </div>
          )}

          {mode === "cycle" && (
            <p className="rounded-md border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
              只改周期不重新协商：需求、repo 与契约原样不动，保存后立即生效，「下一次运行」按新周期算。
              要改需求描述，用列表里的「编辑需求」—— 那条路会起一个 authoring 会话。
            </p>
          )}

          {error !== null && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t px-5 py-3">
        <Button disabled={!canSubmit} onClick={() => void submit()}>
          {mode === "create" ? "起 authoring 会话" : mode === "requirement" ? "起会话重新协商需求" : "保存周期"}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        {authoring && (
          <span className="text-[11px] text-muted-foreground">提交后契约在「待处理」里批准，任务才会出现</span>
        )}
      </div>
    </div>
  );
}
