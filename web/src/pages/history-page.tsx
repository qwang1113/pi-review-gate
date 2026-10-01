import { RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { api, describeError } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { type NotificationsResponse, type NotificationEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

const KIND_LABELS: Record<string, string> = {
  "waiting-input": "等你回答",
  done: "完成",
  exited: "异常结束",
};

/** The notification ledger the daemon keeps (`docs/daemon/api.md` §8) — what happened while you were away. */
export default function HistoryPage() {
  const [entries, setEntries] = useState<NotificationEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api<NotificationsResponse>("/api/notifications?limit=200");
      setEntries(payload.entries ?? []);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-tight">历史</h1>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          刷新
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        daemon 保留最近 24 小时的通知台账（同一个事实在 10 分钟内只出现一次）。会话自己的完整历史在它的转写文件里。
      </p>

      {error !== null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {!loading && entries.length === 0 && error === null && (
        <Card>
          <CardHeader className="flex-col">
            <CardTitle>最近 24 小时没有通知</CardTitle>
            <p className="text-xs text-muted-foreground">等你回答、完成、异常结束这三类事件会记在这里。</p>
          </CardHeader>
        </Card>
      )}

      {entries.length > 0 && (
        <Card className="py-2">
          <div className="flex flex-col divide-y">
            {[...entries].reverse().map((entry) => (
              <Link
                key={`${entry.key}-${entry.at}`}
                to={`/sessions/${entry.sessionId}`}
                className="flex items-start gap-3 px-4 py-2 transition-colors hover:bg-accent"
              >
                <span
                  className={cn(
                    "mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px]",
                    entry.kind === "waiting-input"
                      ? "bg-destructive/10 text-destructive"
                      : entry.kind === "done"
                        ? "bg-success/10 text-success"
                        : "bg-warning/10 text-warning",
                  )}
                >
                  {KIND_LABELS[entry.kind] ?? entry.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{entry.title}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{entry.body}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {entry.name ?? entry.sessionId.slice(0, 8)} · {relativeTime(entry.at)}
                    {entry.count > 1 ? ` · 重复 ${entry.count} 次` : ""}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
