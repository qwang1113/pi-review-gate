import { CheckIcon, ChevronsUpDownIcon, GitBranchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, describeError } from "@/lib/api";
import { useDaemon } from "@/lib/daemon-context";
import { tildePath } from "@/lib/format";
import type { RepoCandidate, ReposResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

const GROUP_LABELS: Record<RepoCandidate["source"], string> = {
  session: "正在运行",
  history: "最近使用",
  root: "其他项目",
};

const GROUP_ORDER: RepoCandidate["source"][] = ["session", "history", "root"];

/**
 * The repo field: a command palette over `GET /api/repos`, never a typed path.
 *
 * The branch shown beside a repo comes from the sessions the daemon already
 * reports for it (`DaemonSession.branch`). `GET /api/repos` itself carries only
 * path/name/source — a working tree's dirty flag is not in the contract, so the
 * panel does not invent one.
 */
export function RepoPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const { sessions } = useDaemon();
  const [repos, setRepos] = useState<RepoCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let disposed = false;
    api<ReposResponse>("/api/repos")
      .then((payload) => {
        if (!disposed) setRepos(payload.repos);
      })
      .catch((failure: unknown) => {
        if (!disposed) setError(describeError(failure));
      });
    return () => {
      disposed = true;
    };
  }, []);

  const branches = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      if (session.branch !== null && !map.has(session.repo)) map.set(session.repo, session.branch);
    }
    return map;
  }, [sessions]);

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((source) => ({
        source,
        items: repos.filter((repo) => repo.source === source),
      })).filter((group) => group.items.length > 0),
    [repos],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("h-9 w-full justify-between font-normal", value === "" && "text-muted-foreground")}
        >
          {value === "" ? "选择仓库…" : `${value.split("/").pop()}  ${tildePath(value)}`}
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[520px] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索仓库名或路径…" />
          <CommandList>
            <CommandEmpty>没有匹配的仓库 —— daemon 的候选列表里没有它。</CommandEmpty>
            {error !== null && <div className="px-3 py-2 text-[11px] text-destructive">{error}</div>}
            {groups.map((group) => (
              <CommandGroup key={group.source} heading={GROUP_LABELS[group.source]}>
                {group.items.map((repo) => (
                  <CommandItem
                    key={repo.path}
                    value={`${repo.name} ${repo.path}`}
                    onSelect={() => {
                      onChange(repo.path);
                      setOpen(false);
                    }}
                  >
                    <CheckIcon className={cn("size-3.5", value === repo.path ? "opacity-100" : "opacity-0")} />
                    <span className="font-medium">{repo.name}</span>
                    <span className="text-[11px] text-muted-foreground">{tildePath(repo.path)}</span>
                    {branches.has(repo.path) && (
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <GitBranchIcon className="size-3" />
                        {branches.get(repo.path)}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
