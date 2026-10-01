/**
 * 定时任务页 —— 面板上的调度表（`docs/daemon/api.md` §13）。
 *
 * 能做的事只有三类，且都由 daemon 的端点决定：看（`GET /api/schedules`）、
 * 改周期/启停（`PUT`，不重新协商）、删（`DELETE`）。**新增与改需求不在这里写表**：
 * 它们走 `POST /api/schedules/author` 起一个 authoring 会话，契约要等用户在
 * 「待处理」里批准 —— 列表里出现一条任务的唯一原因，是用户批准过这份契约。
 *
 * 数据没有 SSE 帧（§13 只给了 REST），所以这一页不开第二套订阅：它依赖
 * `daemon-context` 既有的 `generation`（`refresh()` 的信号）重读。
 */

import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { ScheduleForm, type ScheduleFormMode, type ScheduleFormResult } from "@/components/schedule-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, describeError } from "@/lib/api";
import { useDaemon } from "@/lib/daemon-context";
import { dateTime, relativeTime, tildePath } from "@/lib/format";
import type {
  ScheduleAuthorResponse,
  ScheduledTask,
  ScheduledTaskRun,
  SchedulesResponse,
  ScheduleTaskWriteResponse,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The last result of one task, with its reviewer verdict where there is one.
 *
 * The four outcomes the daemon records are NOT four names for the same thing
 * (`docs/daemon/api.md` §13.6): `passed` means a READY was recorded, `blocked`
 * a BLOCKED, `failed` a session that ended without either, and `gone` a run
 * whose gate state could not be read at all. Rendering them identically would
 * hide exactly the distinction the ledger exists for.
 */
function RunSummary({ run }: { run: ScheduledTaskRun | undefined }) {
  if (run === undefined) return <span className="text-[11px] text-muted-foreground">还没有跑过</span>;
  if (run.kind === "run-skipped") {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Badge variant="outline">已跳过</Badge>
        <span className="truncate text-muted-foreground" title={run.reason}>
          {relativeTime(run.at)} · {run.reason}
        </span>
      </span>
    );
  }
  if (run.kind === "run-started") {
    // `lastRuns` filters these out (§13.1) — the type still allows one, and a
    // record the daemon might send is not a reason to render nothing.
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge variant="info">已开始</Badge>
        <span className="text-muted-foreground">{relativeTime(run.at)}</span>
      </span>
    );
  }
  const variant =
    run.outcome === "passed"
      ? "success"
      : run.outcome === "blocked"
        ? "destructive"
        : run.outcome === "gone"
          ? "warning"
          : "secondary";
  const label =
    run.outcome === "passed"
      ? run.verdict ?? "READY"
      : run.outcome === "blocked"
        ? run.verdict ?? "BLOCKED"
        : run.outcome === "gone"
          ? "会话消失"
          : "未结论结束";
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Badge variant={variant}>{label}</Badge>
      <span className="truncate text-muted-foreground">
        {relativeTime(run.at)}
        {run.unmet.length > 0 ? ` · 未满足 ${run.unmet.length}` : ""}
      </span>
    </span>
  );
}

function ScheduleRow({
  task,
  busy,
  confirming,
  onToggle,
  onEditCron,
  onEditRequirement,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  task: ScheduledTask;
  busy: boolean;
  confirming: boolean;
  onToggle: (enabled: boolean) => void;
  onEditCron: () => void;
  onEditRequirement: () => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const last = task.lastRuns[task.lastRuns.length - 1];
  return (
    <Card className="gap-2 py-3">
      <CardHeader>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("truncate text-[13px] font-medium", !task.enabled && "text-muted-foreground")}>
              {task.name}
            </span>
            <Badge variant="outline">{task.id}</Badge>
            {!task.enabled && <Badge variant="secondary">已停用</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span title={task.repo}>{tildePath(task.repo)}</span>
            <span className="inline-flex items-baseline gap-1">
              {task.describe}
              <span className="font-mono text-[10px] opacity-80">{task.cron}</span>
            </span>
          </div>
          <p className="mt-1 truncate text-[11px] text-muted-foreground" title={task.requirement}>
            {task.requirement}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <div className="text-right text-[11px] leading-tight">
            <div className="text-muted-foreground">下一次运行</div>
            <div>{task.nextRunAt === null ? "—" : dateTime(task.nextRunAt)}</div>
          </div>
          <Switch checked={task.enabled} disabled={busy} onCheckedChange={onToggle} />
        </div>
      </CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4">
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">最近一次</span>
          <RunSummary run={last} />
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEditCron}>
            <PencilIcon className="size-3.5" />
            编辑周期
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onEditRequirement}>
            <PencilIcon className="size-3.5" />
            编辑需求
          </Button>
          {confirming ? (
            <>
              <Button size="sm" variant="destructive" disabled={busy} onClick={onConfirmDelete}>
                确认删除
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={onCancelDelete}>
                取消
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRequestDelete}>
              <Trash2Icon className="size-3.5" />
              删除
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

type FormState = { mode: ScheduleFormMode; task?: ScheduledTask };

export default function SchedulesPage() {
  const { refresh, generation, connected } = useDaemon();
  const [data, setData] = useState<SchedulesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [launched, setLaunched] = useState<ScheduleAuthorResponse | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await api<SchedulesResponse>("/api/schedules");
      setData(payload);
      setError(null);
    } catch (failure) {
      // A failed read is NEVER rendered as an empty table: the daemon answers
      // 500 for an unreadable table on purpose (§13.2), and "no tasks" is a
      // different sentence from "could not read".
      setError(describeError(failure));
    }
  }, []);

  // Two existing moments re-read this page, and both are needed: a `refresh()`
  // (`generation`), and the stream coming back (`connected`) — the events that
  // fired while it was down are gone, which is also why the provider re-reads
  // its session snapshot on reopen. Schedules have no SSE frame of their own
  // (§13), and this page does not open one.
  useEffect(() => {
    void load();
  }, [load, generation, connected]);

  const toggle = async (task: ScheduledTask, enabled: boolean) => {
    setBusyId(task.id);
    setActionError(null);
    try {
      await api<ScheduleTaskWriteResponse>(`/api/schedules/${encodeURIComponent(task.id)}`, {
        method: "PUT",
        body: { enabled },
      });
      await load();
    } catch (failure) {
      setActionError(`${task.name}：${describeError(failure)}`);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (task: ScheduledTask) => {
    setBusyId(task.id);
    setActionError(null);
    try {
      await api<ScheduleTaskWriteResponse>(`/api/schedules/${encodeURIComponent(task.id)}`, {
        method: "DELETE",
      });
      setConfirmingId(null);
      await load();
    } catch (failure) {
      setActionError(`${task.name}：${describeError(failure)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onFormDone = (result: ScheduleFormResult) => {
    if (result.kind === "author") {
      // The endpoint writes no table (§13.3): the session has to be approved
      // before anything shows up here. `refresh()` tells the rest of the panel
      // a session just appeared, and re-reads this page through `generation`.
      setForm(null);
      setLaunched(result.receipt);
      refresh();
    } else {
      setForm(null);
      void load();
    }
  };

  const tasks = data?.tasks ?? [];

  function sheetCopy(): { title: string; description: string } {
    if (launched !== null) return { title: "authoring 会话已起", description: "契约谈定之前，调度表里不会有这个任务。" };
    if (form === null) return { title: "", description: "" };
    if (form.mode === "create") {
      return {
        title: "新建定时任务",
        description: "填一句需求与周期；提交后门禁起一个 authoring 会话，你在「待处理」里批准契约，任务才会出现。",
      };
    }
    if (form.mode === "requirement") {
      return {
        title: `编辑需求 · ${form.task?.name ?? ""}`,
        description: "需求、repo 与契约的修改都要重新协商：会话会先弹需求反述，再请你批准 goal。",
      };
    }
    return { title: `改周期 · ${form.task?.name ?? ""}`, description: "只改周期不重新协商，保存后立即生效。" };
  }

  const copy = sheetCopy();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">定时任务</h1>
        <div className="flex items-center gap-2">
          {tasks.length > 0 && <span className="text-xs text-muted-foreground">共 {tasks.length} 个</span>}
          <Button size="sm" onClick={() => setForm({ mode: "create" })}>
            <PlusIcon className="size-3.5" />
            新建定时任务
          </Button>
        </div>
      </div>

      {actionError !== null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {actionError}
        </div>
      )}

      {error !== null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          <div className="font-medium">读不到定时任务表</div>
          <div>{error}</div>
          <div className="mt-1 text-[11px]">
            daemon 读不了调度表时给的是 500 而不是空表 —— 这不是「没有定时任务」，先修好文件再看。
          </div>
        </div>
      )}

      {data === null && error === null && (
        <Card>
          <CardHeader>
            <CardTitle>正在读取定时任务…</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-2 px-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </Card>
      )}

      {data !== null && tasks.length === 0 && (
        <Card>
          <CardHeader className="flex-col">
            <CardTitle>还没有定时任务</CardTitle>
            <p className="text-xs text-muted-foreground">
              点右上角「新建定时任务」填一句需求与周期 —— 门禁会起一个 authoring 会话，
              需求反述与 goal 批准框出现在「待处理」里，批准之后任务才会出现在这里。
              也可以直接在任意 pi 会话里用 schedule_task 工具建。
            </p>
          </CardHeader>
        </Card>
      )}

      {tasks.map((task) => (
        <ScheduleRow
          key={task.id}
          task={task}
          busy={busyId === task.id}
          confirming={confirmingId === task.id}
          onToggle={(enabled) => void toggle(task, enabled)}
          onEditCron={() => {
            setConfirmingId(null);
            setForm({ mode: "cycle", task });
          }}
          onEditRequirement={() => {
            setConfirmingId(null);
            setForm({ mode: "requirement", task });
          }}
          onRequestDelete={() => {
            setConfirmingId(task.id);
            setActionError(null);
          }}
          onConfirmDelete={() => void remove(task)}
          onCancelDelete={() => setConfirmingId(null)}
        />
      ))}

      <Sheet
        open={form !== null || launched !== null}
        onOpenChange={(open) => {
          if (!open) {
            setForm(null);
            setLaunched(null);
          }
        }}
      >
        <SheetContent className="gap-0 p-0">
          <SheetHeader>
            <SheetTitle className="text-base">{copy.title}</SheetTitle>
            <SheetDescription>{copy.description}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">
            {launched !== null ? (
              <div className="flex flex-col gap-4 px-5 py-4">
                <div className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-[12px] text-success">
                  authoring 会话已起：确认框在「待处理」里，批准后任务才会出现。
                </div>
                <p className="text-[12px] text-muted-foreground">
                  会话 <span className="font-mono">{launched.sessionId}</span> 正在和你谈这份任务的契约
                  （需求反述 → goal 批准）。面板不写调度表，所以在那之前列表里看不到它。
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" asChild>
                    <Link to={`/sessions/${launched.sessionId}`}>打开会话详情</Link>
                  </Button>
                  <Button size="sm" variant="ghost" asChild>
                    <Link to="/questions">去「待处理」回答</Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLaunched(null);
                      setForm(null);
                    }}
                  >
                    回到列表
                  </Button>
                </div>
              </div>
            ) : form !== null ? (
              <ScheduleForm
                key={`${form.mode}-${form.task?.id ?? "new"}`}
                mode={form.mode}
                task={form.task}
                onCancel={() => setForm(null)}
                onDone={onFormDone}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
