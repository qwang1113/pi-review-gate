import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { QuestionCard, acceptsDecline, draftToAnswer, type QuestionDraft } from "@/components/question-card";
import { describeError } from "@/lib/api";
import { useDaemon } from "@/lib/daemon-context";
import type { DaemonQuestion } from "@/lib/types";

/** The draft a question starts with: a checklist opens with `defaultChecked` ticked, nothing else. */
function initialDraft(question: DaemonQuestion): QuestionDraft {
  return { chosen: question.multiple ? [...question.defaultChecked] : [], reason: "" };
}

/**
 * A batch of questions asked by ONE `ask_user` interview — rendered together and
 * submitted with one click.
 *
 * `ask_user`'s own protocol submits the whole interview as a batch and the
 * answers must arrive as a set; answering one at a time from a panel is how a
 * half-finished interview happens. The requests are still answered one by one
 * underneath (that is the endpoint's shape), but the user presses one button.
 */
export function QuestionBatch({
  questions,
  sessionId,
  sessionName,
}: {
  questions: DaemonQuestion[];
  sessionId: string;
  sessionName: string;
}) {
  const { answer } = useDaemon();
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>(() =>
    Object.fromEntries(questions.map((question) => [question.requestId, initialDraft(question)])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // A new question can land in the same batch slot after a poll; keep the draft
  // map in step with what is actually on screen. Keyed by the id set rather than
  // the array so a re-render for any other reason does not reset a draft.
  const requestIds = questions.map((question) => question.requestId).join(",");
  useEffect(() => {
    setDrafts((current) => {
      const next: Record<string, QuestionDraft> = {};
      for (const question of questions) next[question.requestId] = current[question.requestId] ?? initialDraft(question);
      return next;
    });
  }, [requestIds]);

  const incomplete = useMemo(
    () =>
      questions.filter((question) => {
        const draft = drafts[question.requestId];
        if (draft === undefined) return true;
        if (draft.chosen.length > 0) return false;
        // Nothing picked is only an answer when the question carries the gate's
        // decline row — without it, free text is refused by the daemon and the
        // user would get a rejection instead of a submitted answer.
        return !acceptsDecline(question) || draft.reason.trim() === "";
      }),
    [questions, drafts],
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const question of questions) {
        const draft = drafts[question.requestId] ?? initialDraft(question);
        const { value, reason } = draftToAnswer(question, draft);
        await answer(question, value, reason);
      }
      setSent(true);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <Card className="border-success/40 bg-success/5">
        <CardHeader className="flex-col">
          <CardTitle className="text-[13px]">答案已提交</CardTitle>
          <p className="text-xs text-muted-foreground">
            门禁消费后这两个文件会被删掉，这一批就会从待处理里消失。
          </p>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {questions.map((question) => (
        <QuestionCard
          key={question.requestId}
          question={question}
          draft={drafts[question.requestId] ?? initialDraft(question)}
          onChange={(next) => setDrafts((current) => ({ ...current, [question.requestId]: next }))}
          disabled={busy}
        />
      ))}
      {error !== null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button disabled={busy || incomplete.length > 0} onClick={() => void submit()}>
          {questions.length > 1 ? `提交全部 ${questions.length} 题` : "提交答案"}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          {incomplete.length > 0
            ? `还有 ${incomplete.length} 题没作答（没选选项的题需要在理由里写清）`
            : `提交给 ${sessionName}（${sessionId.slice(0, 8)}）`}
        </span>
        <Link to={`/sessions/${sessionId}`} className="ml-auto text-[11px] text-muted-foreground hover:underline">
          打开会话 →
        </Link>
      </div>
    </div>
  );
}
