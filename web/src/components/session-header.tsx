import { CopyIcon, GitBranchIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { relativeTime, shortPath } from "@/lib/format";
import { MODE_LABELS } from "@/lib/types";
import type { DaemonSession } from "@/lib/types";

/** `tmux select-window -t <session>:<window>` — the panel cannot switch the user's terminal, so it hands over the command. */
export function tmuxCommand(session: DaemonSession): string | null {
  if (session.tmux === null) return null;
  return `tmux select-window -t ${session.tmux.session}:${session.tmux.window}`;
}

/** The strip that stays on screen: where this session lives and what it is. */
export function SessionHeader({ session }: { session: DaemonSession }) {
  const [copied, setCopied] = useState(false);
  const command = tmuxCommand(session);

  const copy = async () => {
    if (command === null) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="sticky top-0 z-10 -mx-6 mb-4 border-b bg-background/95 px-6 pt-3 pb-2 backdrop-blur">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold tracking-tight">{session.name ?? session.sessionId.slice(0, 8)}</h1>
        <StatusBadge state={session.state} />
        <span className="rounded bg-muted px-1 text-[11px]">{MODE_LABELS[session.mode] ?? session.mode}</span>
        {session.kind !== null && session.kind !== session.mode && (
          <span className="text-[11px] text-muted-foreground">{session.kind}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {command !== null && (
            <Button size="sm" variant="outline" onClick={() => void copy()}>
              {copied ? <TerminalIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              {copied ? "已复制" : "复制 tmux 跳转命令"}
            </Button>
          )}
          <Button size="sm" variant="outline" asChild>
            <a href="#composer" onClick={() => document.getElementById("composer-input")?.focus()}>
              发消息
            </a>
          </Button>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        <span className="truncate" title={session.repo}>
          {shortPath(session.repo)}
        </span>
        <span className="inline-flex items-center gap-1">
          <GitBranchIcon className="size-3" />
          {session.branch ?? "—"}
        </span>
        {session.gateStateFound ? (
          <span>
            轮次 {session.rounds.sent}（已记录 {session.rounds.recorded}）· 未满足 {session.unmet.length} 项
          </span>
        ) : (
          <span className="text-warning" title="转写尾部 256 KiB 里没有门禁 state 记录：轮次与未满足项都是未知，不是 0">
            门禁状态未知
          </span>
        )}
        <span>最后活动 {relativeTime(session.lastActivityAt)}</span>
      </div>
    </div>
  );
}
