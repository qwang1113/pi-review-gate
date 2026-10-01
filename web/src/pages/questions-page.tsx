import { useMemo } from "react";

import { QuestionBatch } from "@/components/question-batch";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { useDaemon } from "@/lib/daemon-context";
import { relativeTime } from "@/lib/format";
import type { DaemonQuestion } from "@/lib/types";

interface SessionGroup {
  sessionId: string;
  sessionName: string;
  batches: DaemonQuestion[][];
}

/** Split one session's questions by the interview they came from, oldest batch first. */
function groupByBatch(questions: DaemonQuestion[]): DaemonQuestion[][] {
  const batches = new Map<string, DaemonQuestion[]>();
  for (const question of questions) {
    const key = question.batchId ?? question.requestId;
    const bucket = batches.get(key);
    if (bucket === undefined) batches.set(key, [question]);
    else bucket.push(question);
  }
  return [...batches.values()]
    .map((batch) => batch.sort((left, right) => (left.batchIndex ?? 0) - (right.batchIndex ?? 0)))
    .sort((left, right) => (left[0]?.createdAt ?? "").localeCompare(right[0]?.createdAt ?? ""));
}

/** Everything waiting on the user — the panel's reason to exist. */
export default function QuestionsPage() {
  const { questions, byId, problems } = useDaemon();

  const groups = useMemo<SessionGroup[]>(() => {
    const bySession = new Map<string, DaemonQuestion[]>();
    for (const question of questions) {
      const bucket = bySession.get(question.sessionId);
      if (bucket === undefined) bySession.set(question.sessionId, [question]);
      else bucket.push(question);
    }
    return [...bySession.entries()].map(([sessionId, list]) => ({
      sessionId,
      sessionName: list[0]?.sessionName ?? byId.get(sessionId)?.name ?? sessionId.slice(0, 8),
      batches: groupByBatch(list),
    }));
  }, [questions, byId]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold tracking-tight">待处理</h1>
        <span className="text-xs text-muted-foreground">
          {questions.length === 0 ? "没有待答问题" : `${questions.length} 个问题等着回答`}
        </span>
      </div>

      {problems.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          {problems.map((problem) => (
            <div key={problem}>{problem}</div>
          ))}
        </div>
      )}

      {groups.length === 0 && (
        <Card>
          <CardHeader className="flex-col">
            <CardTitle>现在没有等你回答的问题</CardTitle>
            <p className="text-xs text-muted-foreground">
              门禁弹出的审批框会出现在这里 —— 也可以直接在会话详情页回答，不必切回终端。
            </p>
          </CardHeader>
        </Card>
      )}

      {groups.map((group) => (
        <Card key={group.sessionId}>
          <CardHeader className="flex-col gap-0.5 pb-1">
            <CardTitle className="text-[13px]">{group.sessionName}</CardTitle>
            <span className="text-[11px] text-muted-foreground">
              {group.sessionId} · 最早 {relativeTime(group.batches[0]?.[0]?.createdAt ?? null)}
            </span>
          </CardHeader>
          <div className="flex flex-col gap-4 px-4">
            {group.batches.map((batch) => (
              <QuestionBatch
                key={batch[0]?.requestId}
                questions={batch}
                sessionId={group.sessionId}
                sessionName={group.sessionName}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
