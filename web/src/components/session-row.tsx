import { GitBranchIcon } from "lucide-react";
import { Link } from "react-router-dom";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { relativeTime, shortPath } from "@/lib/format";
import { MODE_LABELS } from "@/lib/types";
import type { DaemonSession } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One session, written to be read at a glance: who, where, what state, how long ago. */
export function SessionRow({ session }: { session: DaemonSession }) {
  const waiting = session.state === "waiting-input";
  const title = session.name ?? session.sessionId.slice(0, 8);
  return (
    <Link
      to={`/sessions/${session.sessionId}`}
      className={cn(
        "flex items-center gap-3 rounded-md border border-transparent px-3 py-2 transition-colors hover:bg-accent",
        waiting && "border-destructive/30 bg-destructive/5",
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", session.alive ? "bg-success" : "bg-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium">{title}</span>
          {session.kind !== null && <Badge variant="outline">{session.kind}</Badge>}
          <StatusBadge state={session.state} />
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="truncate">{shortPath(session.repo)}</span>
          <span className="inline-flex items-center gap-1">
            <GitBranchIcon className="size-3" />
            {session.branch ?? "—"}
          </span>
          <span className="rounded bg-muted px-1">{MODE_LABELS[session.mode] ?? session.mode}</span>
          {session.gateStateFound ? (
            <span>
              轮次 {session.rounds.sent}
              {session.unmet.length > 0 ? ` · 未满足 ${session.unmet.length}` : " · 无未满足项"}
            </span>
          ) : (
            <span title="转写尾部没有读到门禁 state 记录，轮次与未满足项都不是结论">门禁状态未知</span>
          )}
        </div>
      </div>
      <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(session.lastActivityAt)}</span>
    </Link>
  );
}
