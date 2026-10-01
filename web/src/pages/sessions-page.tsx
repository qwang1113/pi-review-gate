import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { SessionRow } from "@/components/session-row";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDaemon } from "@/lib/daemon-context";
import { shortPath } from "@/lib/format";

/**
 * Every session the daemon can see, grouped by repo, `waiting-input` first
 * (the provider already sorts that way). The search box and the repo filter in
 * the top bar drive this list through the URL.
 */
export default function SessionsPage() {
  const { sessions, snapshotLoaded, tmuxReadable, problems, errors } = useDaemon();
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").trim().toLowerCase();
  const repoFilter = params.get("repo") ?? "";
  // The daemon reports everything that moved in the last 24 h by default, which
  // on a working machine is mostly sessions that have already exited. The list
  // opens on the live ones; the switch shows the rest.
  const showAll = params.get("all") === "1";
  const aliveCount = useMemo(() => sessions.filter((session) => session.alive).length, [sessions]);

  const toggleAll = () => {
    const next = new URLSearchParams(params);
    if (showAll) next.delete("all");
    else next.set("all", "1");
    setParams(next, { replace: true });
  };

  const filtered = useMemo(() => {
    return sessions.filter((session) => {
      if (!showAll && !session.alive) return false;
      if (repoFilter !== "" && session.repo !== repoFilter) return false;
      if (query === "") return true;
      const haystack = [session.name ?? "", session.repo, session.branch ?? "", session.sessionId, session.kind ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [sessions, query, repoFilter, showAll]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const session of filtered) {
      const bucket = map.get(session.repo);
      if (bucket === undefined) map.set(session.repo, [session]);
      else bucket.push(session);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">会话</h1>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            共 {filtered.length} 个
            {query !== "" || repoFilter !== "" ? "（已过滤）" : ""}
          </span>
          <button type="button" onClick={toggleAll} className="rounded-md border px-2 py-0.5 hover:bg-accent">
            {showAll ? `只看活跃（${aliveCount}）` : `显示 24h 内全部（${sessions.length}）`}
          </button>
        </div>
      </div>

      {!tmuxReadable && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          tmux 读不到 —— pane 状态这一层整体跳过，下面的状态来自注册表与转写。
        </div>
      )}
      {problems.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          {problems.map((problem) => (
            <div key={problem}>{problem}</div>
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {errors.map((error) => (
            <div key={error}>{error}</div>
          ))}
        </div>
      )}

      {!snapshotLoaded && (
        <Card>
          <CardHeader>
            <CardTitle>正在读取会话…</CardTitle>
          </CardHeader>
          <div className="flex flex-col gap-2 px-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        </Card>
      )}

      {snapshotLoaded && groups.length === 0 && (
        <Card>
          <CardHeader className="flex-col">
            <CardTitle>没有会话</CardTitle>
            <p className="text-xs text-muted-foreground">
              {query !== "" || repoFilter !== ""
                ? "当前过滤条件下没有匹配的会话。"
                : "daemon 现在看不到任何会话 —— 起一个 pi 会话，或用「发起任务」。"}
            </p>
          </CardHeader>
        </Card>
      )}

      {groups.map(([repo, list]) => (
        <Card key={repo} className="gap-1 py-3">
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">{shortPath(repo)}</CardTitle>
            <span className="truncate text-[11px] text-muted-foreground">{repo}</span>
          </CardHeader>
          <div className="flex flex-col px-1">
            {list.map((session) => (
              <SessionRow key={session.sessionId} session={session} />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
