import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { Composer } from "@/components/composer";
import { GateCards } from "@/components/gate-cards";
import { LaunchTracker } from "@/components/launch-tracker";
import { OutputStream } from "@/components/output-stream";
import { QuestionBatch } from "@/components/question-batch";
import { SessionHeader } from "@/components/session-header";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDaemon } from "@/lib/daemon-context";

/**
 * One session in full: the fixed strip on top, the pending-question banner, the
 * live stream on the left and the gate column on the right, and the composer at
 * the bottom. Answering a gate question from here is the point — no terminal.
 */
export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const { byId, questions, snapshotLoaded } = useDaemon();
  // The launch moment is fixed when the page opens: the tracker counts from it.
  const [openedAt] = useState(() => Date.now());

  const session = id === undefined ? undefined : byId.get(id);
  const pending = questions.filter((question) => question.sessionId === id);
  const launched = params.get("launched") === "1" && id !== undefined;

  if (session === undefined) {
    return (
      <Card>
        <CardHeader className="flex-col">
          <CardTitle>{snapshotLoaded ? "找不到这个会话" : "正在读取会话…"}</CardTitle>
          <p className="text-xs text-muted-foreground">
            {snapshotLoaded
              ? `daemon 现在观测不到 ${id ?? "这个 id"} —— 它可能已经结束，或者从未在 daemon 能看到的范围里。`
              : "正在等 daemon 的会话列表。"}
          </p>
          {!snapshotLoaded && <Skeleton className="mt-2 h-8" />}
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col">
      <SessionHeader session={session} />
      <div className="pt-4">
        {launched && <LaunchTracker sessionId={session.sessionId} launchedAt={openedAt} />}

        {pending.length > 0 && (
          <div className="mb-4 rounded-lg border-2 border-destructive/40 bg-destructive/5 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[13px] font-semibold text-destructive">有 {pending.length} 个问题在等你回答</span>
              <span className="text-[11px] text-muted-foreground">答完即闭环，不用切回终端</span>
            </div>
            <QuestionBatch
              questions={pending}
              sessionId={session.sessionId}
              sessionName={session.name ?? session.sessionId.slice(0, 8)}
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
          <OutputStream sessionId={session.sessionId} />
          <GateCards session={session} />
        </div>

        <Composer session={session} />
      </div>
    </div>
  );
}
