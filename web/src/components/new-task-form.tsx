import { ChevronDownIcon, ChevronRightIcon, FileTextIcon, RocketIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { RepoPicker } from "@/components/repo-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { api, describeError } from "@/lib/api";
import { useDaemon } from "@/lib/daemon-context";
import { tildePath } from "@/lib/format";
import type { TaskResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

const DRAFT_KEY = "rg-new-task-draft";
const LAST_KEY = "rg-new-task-last";

/** The task-book skeleton the gate's own plan tasks are written with. */
const SKELETON = `目标：
交付：
代码落点：
验收：
边界：`;

export type Station = "precommit" | "commit" | "pr";export type GateMode = "loop" | "explore" | "normal" | "orchestrator";

interface Draft {
  repo: string;
  task: string;
  station: Station;
  mode: GateMode;
  name: string;
}

const EMPTY: Draft = { repo: "", task: "", station: "precommit", mode: "loop", name: "" };

const STATIONS: { value: Station; who: string }[] = [
  { value: "precommit", who: "门禁跑通就行，commit 由你自己来（最严格）" },
  { value: "commit", who: "会话把改动提交好，push 由你自己来" },
  { value: "pr", who: "会话做到 PR 开出来" },
];

function readStored(key: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    return { ...EMPTY, ...parsed };
  } catch {
    return null;
  }
}

/**
 * The one-screen new-task form: repo, description, delivery station, advanced.
 *
 * No wizard, no steps — every field is on this form, in the order the decision
 * is actually made, and the draft is in localStorage from the first keystroke
 * (a half-typed task description is the one thing a reload must not eat).
 */
export function NewTaskForm({ onLaunched }: { onLaunched: (sessionId: string, windowName: string) => void }) {
  const { sessions, refresh } = useDaemon();
  const [draft, setDraft] = useState<Draft>(() => readStored(DRAFT_KEY) ?? EMPTY);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const last = useMemo(() => readStored(LAST_KEY), []);

  useEffect(() => {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [draft]);

  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  const repoBranch = useMemo(() => {
    const hit = sessions.find((session) => session.repo === draft.repo && session.branch !== null);
    return hit?.branch ?? null;
  }, [sessions, draft.repo]);

  const liveHere = useMemo(
    () => sessions.filter((session) => session.repo === draft.repo && session.alive),
    [sessions, draft.repo],
  );

  const canLaunch = draft.repo !== "" && draft.task.trim() !== "" && !busy;

  const launch = async () => {
    if (!canLaunch) return;
    setBusy(true);
    setError(null);
    try {
      const receipt = await api<TaskResponse>("/api/tasks", {
        method: "POST",
        body: {
          repo: draft.repo,
          task: draft.task,
          mode: draft.mode,
          station: draft.station,
          ...(draft.name.trim() === "" ? {} : { name: draft.name.trim() }),
        },
      });
      // Keep the draft as "last" so 「载入上次」 can bring it back, then clear the
      // live draft: the sheet closes and the user lands on the new session.
      window.localStorage.setItem(LAST_KEY, JSON.stringify(draft));
      window.localStorage.removeItem(DRAFT_KEY);
      refresh();
      onLaunched(receipt.sessionId, receipt.windowName ?? "");
    } catch (failure) {
      // The daemon refused (bad repo, taken name, no tmux…): the reason is shown
      // and every field stays exactly as typed.
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
          void launch();
        }
      }}
    >
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label>仓库</Label>
            <RepoPicker value={draft.repo} onChange={(repo) => patch({ repo })} disabled={busy} />
            {draft.repo !== "" && (
              <div className="mt-1 flex flex-col gap-2 rounded-md border bg-muted/30 px-3 py-2">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span>当前分支</span>
                  <span className="font-mono text-foreground">{repoBranch ?? "未知"}</span>
                  {repoBranch !== null && <span>（来自这个 repo 上活跃会话的报告）</span>}
                </div>
                {liveHere.length > 0 && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
                    这个 repo 已经有 {liveHere.length} 个活会话（{liveHere
                      .map((session) => session.name ?? session.sessionId.slice(0, 8))
                      .join("、")}
                    ）。daemon 起的会话与它们 <span className="font-medium">共用同一个 checkout</span> —— 面板不能替它开隔离 worktree，改动会互相看见。
                  </div>
                )}
                <div className="text-[11px] text-muted-foreground">
                  {tildePath(draft.repo)} —— 会话就在这个工作区里开始，分支由会话自己（和门禁的提交规则）决定。
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <Label>任务描述</Label>
              <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px]">
                    <FileTextIcon className="size-3.5" />
                    骨架模板
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 p-1">
                  <button
                    type="button"
                    className="w-full rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                    onClick={() => {
                      patch({ task: draft.task.trim() === "" ? SKELETON : `${draft.task}\n\n${SKELETON}` });
                      setTemplateOpen(false);
                    }}
                  >
                    插入任务书骨架（目标/交付/代码落点/验收/边界）
                  </button>
                  <button
                    type="button"
                    disabled={last === null}
                    className="w-full rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent disabled:opacity-50"
                    onClick={() => {
                      if (last !== null) patch({ task: last.task, repo: last.repo });
                      setTemplateOpen(false);
                    }}
                  >
                    载入上次的任务描述
                  </button>
                </PopoverContent>
              </Popover>
            </div>
            <Textarea
              className="min-h-40 resize-y"
              value={draft.task}
              disabled={busy}
              onChange={(event) => patch({ task: event.target.value })}
              placeholder="这次要让会话做什么？可以直接粘贴 issue / PR 链接或一大段需求。"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>交付站点</Label>
            <div className="flex rounded-md border p-0.5">
              {STATIONS.map((station) => (
                <button
                  key={station.value}
                  type="button"
                  disabled={busy}
                  onClick={() => patch({ station: station.value })}
                  className={cn(
                    "flex-1 rounded-[5px] px-2 py-1 text-[12px] transition-colors",
                    draft.station === station.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent",
                  )}
                >
                  {station.value}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {STATIONS.find((station) => station.value === draft.station)?.who}
            </p>
            <p className="text-[11px] text-muted-foreground">
              loop 模式下会话启动后会先协商 loop goal 并弹审批框 —— 那些框在「待处理」里答，不用切回终端。
            </p>
          </div>

          <div className="flex flex-col">
            <button
              type="button"
              className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground"
              onClick={() => setAdvanced((value) => !value)}
            >
              {advanced ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
              高级
              <span className="ml-2 font-normal text-muted-foreground">
                {draft.mode} · 模型与 thinking 由会话自己的 review-gate.json 决定
              </span>
            </button>
            {advanced && (
              <div className="mt-3 flex flex-col gap-3 rounded-md border bg-muted/20 px-3 py-3">
                <div className="flex flex-col gap-1.5">
                  <Label>门禁模式</Label>
                  <div className="flex gap-1">
                    {(["loop", "explore", "normal", "orchestrator"] as GateMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        disabled={busy}
                        onClick={() => patch({ mode })}
                        className={cn(
                          "rounded-md border px-2 py-0.5 text-[12px]",
                          draft.mode === mode ? "border-primary bg-primary/5 text-primary" : "text-muted-foreground",
                        )}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>会话名（kebab-case，可留空）</Label>
                  <Input
                    value={draft.name}
                    disabled={busy}
                    onChange={(event) => patch({ name: event.target.value })}
                    placeholder="例如 t2-registry"
                    className="h-8"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  模型槽位与 thinking 级别目前不在 <code className="rounded bg-muted px-0.5">POST /api/tasks</code> 的契约里；
                  会话启动后按 <code className="rounded bg-muted px-0.5">review-gate.json</code> 的 agents 配置选模型。
                </p>
              </div>
            )}
          </div>

          {error !== null && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t px-5 py-3">
        <Button disabled={!canLaunch} onClick={() => void launch()}>
          <RocketIcon className="size-4" />
          启动任务
        </Button>
        <span className="text-[11px] text-muted-foreground">Cmd/Ctrl + Enter</span>
      </div>
    </div>
  );
}
