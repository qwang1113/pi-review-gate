import { CheckCircle2Icon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { DaemonQuestion } from "@/lib/types";

/** The letter the gate would print in front of option `index`. */
const optionLetter = (index: number): string => String.fromCharCode(65 + index);

/**
 * The gate's own escape hatch, part of its dialog template.
 *
 * When a producer also passes it as a regular option — the answer channel’s
 * files carry the gate’s whole option list, hatch included — rendering it twice
 * gives the user two rows that mean the same thing. The hatch is recognised by
 * its own marker and rendered once, as the reason box. The label falls back to
 * the template’s wording when the producer did not send it at all.
 */
const ESCAPE_HATCH_LABEL = "✎ 不选，我说明原因";
const ESCAPE_HATCH_MARK = "✎";

/**
 * One question, rendered exactly as the gate's own dialog is: option rows (with
 * the letter prefix the gate adds), an optional checklist, and the 「✎ 不选，我
 * 说明原因」 escape hatch — a multi-line reason box.
 *
 * Controlled on purpose: a batch of questions is submitted in ONE call, so the
 * card must not answer on its own.
 */
export interface QuestionDraft {
  /** Selected option texts (one for a radio question). */
  chosen: string[];
  reason: string;
}

export function QuestionCard({
  question,
  draft,
  onChange,
  disabled,
}: {
  question: DaemonQuestion;
  draft: QuestionDraft;
  onChange: (next: QuestionDraft) => void;
  disabled?: boolean;
}) {
  const [reasonOpen, setReasonOpen] = useState(draft.reason !== "");
  const cardRef = useRef<HTMLDivElement>(null);
  const free = question.options.length === 0;
  const hatch = question.options.find((option) => option.trim().startsWith(ESCAPE_HATCH_MARK));
  const choices = useMemo(
    () => (hatch === undefined ? question.options : question.options.filter((option) => option !== hatch)),
    [question.options, hatch],
  );

  // Number/letter shortcuts, as the terminal dialog has them. Ignored while the
  // user is typing, so the reason box stays a plain text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (disabled === true || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const index = /^[a-dA-D]$/.test(event.key)
        ? event.key.toUpperCase().charCodeAt(0) - 65
        : /^[1-4]$/.test(event.key)
          ? Number(event.key) - 1
          : -1;
      if (index < 0 || index >= choices.length) return;
      event.preventDefault();
      const option = choices[index]!;
      if (question.multiple) {
        const next = draft.chosen.includes(option)
          ? draft.chosen.filter((item) => item !== option)
          : [...draft.chosen, option];
        onChange({ ...draft, chosen: next });
      } else {
        onChange({ ...draft, chosen: [option] });
      }
    };
    const node = cardRef.current;
    node?.addEventListener("keydown", onKey);
    return () => node?.removeEventListener("keydown", onKey);
  }, [draft, onChange, question, disabled, choices]);

  const toggle = (option: string) => {
    if (disabled === true) return;
    if (question.multiple) {
      onChange({
        ...draft,
        chosen: draft.chosen.includes(option)
          ? draft.chosen.filter((item) => item !== option)
          : [...draft.chosen, option],
      });
    } else {
      onChange({ ...draft, chosen: [option] });
    }
  };

  return (
    <div ref={cardRef} tabIndex={-1} className="rounded-md border bg-card p-3 outline-none">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[13px] font-medium">{question.title}</div>
        {question.multiple && <span className="shrink-0 text-[11px] text-muted-foreground">可多选</span>}
      </div>
      {question.topic !== "" && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {question.topic}
          {question.batchTotal !== null && question.batchTotal > 1
            ? ` · 第 ${(question.batchIndex ?? 0) + 1}/${question.batchTotal} 题`
            : ""}
        </div>
      )}

      {free ? (
        <Textarea
          className="mt-2 min-h-20"
          value={draft.chosen[0] ?? ""}
          disabled={disabled === true}
          onChange={(event) => onChange({ ...draft, chosen: [event.target.value] })}
          placeholder="写下你的回答"
        />
      ) : (
        <div className="mt-2 flex flex-col gap-1">
          {choices.map((option, index) => {
            const active = draft.chosen.includes(option);
            return (
              <button
                key={option}
                type="button"
                disabled={disabled === true}
                onClick={() => toggle(option)}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors",
                  active ? "border-primary bg-primary/5" : "hover:bg-accent",
                  disabled === true && "opacity-60",
                )}
              >
                <span className="mt-px shrink-0 font-mono text-[11px] text-muted-foreground">
                  {optionLetter(index)}.
                </span>
                <span className="flex-1">{option}</span>
                {question.recommended === option && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">（推荐）</span>
                )}
                {active && <CheckCircle2Icon className="mt-px size-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
      )}

      {reasonOpen ? (
        <Textarea
          className="mt-2 min-h-16 text-[12px]"
          value={draft.reason}
          disabled={disabled === true}
          onChange={(event) => onChange({ ...draft, reason: event.target.value })}
          placeholder="写明原因（随答案一起回传）"
        />
      ) : (
        <button
          type="button"
          className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => setReasonOpen(true)}
        >
          {hatch ?? ESCAPE_HATCH_LABEL}
        </button>
      )}

      {question.payload !== null && question.payload !== "" && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 text-[11px] whitespace-pre-wrap">
          {question.payload}
        </pre>
      )}
      {question.payloadRef !== null && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          长正文在 {question.payloadRef.path}（{question.payloadRef.chars} 字符）—— daemon 未内联，面板不读本机文件。
        </div>
      )}
    </div>
  );
}

/** Turn a draft into the request the answer endpoint takes (see `docs/daemon/api.md` §7.5). */
export function draftToAnswer(question: DaemonQuestion, draft: QuestionDraft): { value: string | string[]; reason?: string } {
  const value = question.multiple ? draft.chosen : (draft.chosen[0] ?? "");
  const reason = draft.reason.trim() === "" ? undefined : draft.reason.trim();
  return { value, reason };
}
