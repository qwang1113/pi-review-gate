import { AlertTriangleIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { relativeTime } from "@/lib/format";
import type { DaemonSession } from "@/lib/types";

/**
 * Anything the daemon sent is rendered as text.
 *
 * `rounds.lastVerdict` is typed `string | null` in the contract, but a verdict
 * that later grows into a record would otherwise crash the page (React refuses
 * an object as a child) — and a blank page is the worst possible way to learn
 * that the contract moved.
 */
function text(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * The gate column: what the daemon could read about this session's gate, and
 * the facts behind the row in the list.
 *
 * The contract exposes the gate through `rounds` / `unmet` / `gateStateFound`
 * and nothing finer (`docs/daemon/api.md` §5.2), so that is exactly what is
 * rendered — no invented "goal" or "model health" card from data the daemon
 * does not send.
 */
export function GateCards({ session }: { session: DaemonSession }) {
  return (
    <div className="flex flex-col gap-3">
      <Card className="py-3">
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">门禁</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-[11px]">
          {!session.gateStateFound ? (
            <div className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-warning">
              <AlertTriangleIcon className="mt-px size-3.5 shrink-0" />
              <span>
                转写尾部没有读到门禁 state 记录 —— 轮次与未满足项都按「未知」处理，不能读成「没有未满足项」。
              </span>
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between">
                <span className="text-muted-foreground">本轮发出的审查轮次</span>
                <span className="font-medium">{session.rounds.sent}</span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="text-muted-foreground">已记录裁决</span>
                <span className="font-medium">{session.rounds.recorded}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">上次裁决</span>
                <span className="font-medium break-words">{text(session.rounds.lastVerdict)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-muted-foreground">未满足项（{session.unmet.length}）</span>
                {session.unmet.length === 0 ? (
                  <span className="font-medium">无</span>
                ) : (
                  <ul className="flex list-disc flex-col gap-0.5 pl-4 break-words">
                    {session.unmet.map((item) => (
                      <li key={text(item)}>{text(item)}</li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="py-3">
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">会话事实</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-[11px]">
          <Fact label="sessionId" value={session.sessionId} mono />
          <Fact label="kind" value={text(session.kind)} />
          <Fact label="pid" value={session.pid === null ? "—" : String(session.pid)} />
          <Fact label="状态来源" value={session.stateSource} />
          <Fact label="注册 / 心跳" value={`${relativeTime(session.registeredAt)} / ${relativeTime(session.heartbeatAt)}`} />
          {session.tmux !== null && (
            <Fact label="tmux" value={`${session.tmux.session}:${session.tmux.window}.${session.tmux.pane}`} mono />
          )}
          <Fact label="cwd" value={session.cwd} mono />
          <Fact label="转写" value={session.transcript ?? "—"} mono />
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={mono === true ? "min-w-0 flex-1 font-mono break-all" : "min-w-0 flex-1 break-words"}>{value}</span>
    </div>
  );
}
