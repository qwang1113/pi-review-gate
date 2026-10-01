import { SearchIcon, XIcon } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import { Input } from "@/components/ui/input";
import { useDaemon } from "@/lib/daemon-context";
import { shortPath } from "@/lib/format";

/**
 * Global search + repo filter. Both live in the URL query, so the session list
 * can be filtered without a shared store and a reload keeps the view.
 */
export function TopBar() {
  const { sessions, connected } = useDaemon();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const repo = params.get("repo") ?? "";

  const repos = useMemo(() => {
    const seen = new Map<string, string>();
    for (const session of sessions) seen.set(session.repo, shortPath(session.repo));
    return [...seen.entries()].sort((left, right) => left[1].localeCompare(right[1]));
  }, [sessions]);

  const update = (key: "q" | "repo", value: string) => {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-6">
      <div className="relative w-72">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => update("q", event.target.value)}
          placeholder="搜索会话名、repo、分支…"
          className="h-8 pl-8 text-[13px]"
        />
        {query !== "" && (
          <button
            type="button"
            onClick={() => update("q", "")}
            className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      <select
        value={repo}
        onChange={(event) => update("repo", event.target.value)}
        className="h-8 rounded-md border bg-card px-2 text-[13px] text-foreground outline-none focus-visible:border-ring"
      >
        <option value="">全部 repo</option>
        {repos.map(([path, label]) => (
          <option key={path} value={path}>
            {label}
          </option>
        ))}
      </select>
      {!connected && (
        <span className="ml-auto rounded-md border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
          SSE 已断开 —— 正在自动重连
        </span>
      )}
    </header>
  );
}
