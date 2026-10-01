import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { eventsUrl } from "@/lib/api";
import { clockTime } from "@/lib/format";
import { readToken } from "@/lib/token";
import type { OutputEntry, OutputEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

/** How much of the transcript is kept on screen. Older entries are dropped, not hidden. */
const MAX_ENTRIES = 300;

/** A frame with no entries array is dropped — one bad line must not unmount the stream. */
function parseOutputFrame(data: string): OutputEvent | null {
  try {
    const payload = JSON.parse(data) as OutputEvent;
    return Array.isArray(payload.entries) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * The live stream, straight from the session's own transcript over SSE.
 *
 * The subscription is per session (`?sessionId=`) so the panel never has to
 * filter a firehose of every session's tokens, and the first frame is the
 * daemon's replay — no separate history request, no gap between the two.
 */
export function OutputStream({ sessionId }: { sessionId: string }) {
  const [entries, setEntries] = useState<OutputEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [failed, setFailed] = useState(false);
  const [follow, setFollow] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (readToken() === null) return;
    setEntries([]);
    let disposed = false;
    let retry: number | undefined;
    let failures = 0;
    let source: EventSource | null = null;

    const open = () => {
      if (disposed) return;
      source?.close();
      const next = new EventSource(eventsUrl({ sessionId, replay: 200 }));
      source = next;
      next.onopen = () => {
        if (disposed) return;
        failures = 0;
        setConnected(true);
        setFailed(false);
      };
      next.addEventListener("output", (event) => {
        if (disposed) return;
        const payload = parseOutputFrame((event as MessageEvent<string>).data);
        if (payload === null || payload.entries.length === 0) return;
        setEntries((current) =>
          // A reconnect REPLAYS the tail, so appending it would leave the same
          // entries in the stream twice (reviewer P2, 2026-10-01). A replay is
          // a re-sync: it replaces what is on screen.
          payload.replay === true
            ? payload.entries.slice(-MAX_ENTRIES)
            : [...current, ...payload.entries].slice(-MAX_ENTRIES),
        );
      });
      next.onerror = () => {
        if (disposed) return;
        failures += 1;
        setConnected(false);
        // A stream that cannot reconnect must not look like “nothing has
        // happened yet”: after a few tries the panel says it cannot read this
        // session (reviewer P2, 2026-10-01 — `failed` was never set before).
        if (failures >= 3) setFailed(true);
        next.close();
        retry = window.setTimeout(open, 2000);
      };
    };

    open();
    return () => {
      disposed = true;
      source?.close();
      if (retry !== undefined) window.clearTimeout(retry);
      setConnected(false);
    };
  }, [sessionId]);

  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, follow]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (node === null) return;
    setFollow(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
  };

  return (
    <div className="flex h-[calc(100vh-24rem)] min-h-72 flex-col rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">
          实时输出 {connected ? "· 已连接" : "· 重连中"} · 最近 {entries.length} 条
        </span>
        {!follow && (
          <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setFollow(true)}>
            回到最新
          </Button>
        )}
      </div>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {entries.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {failed ? "读不到这个会话的输出。" : "还没有新输出 —— 会话一动，这里就会出现。"}
          </p>
        )}
        {entries.map((entry, index) => (
          <EntryView key={`${entry.at}-${index}`} entry={entry} />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

const MARKDOWN: Components = {
  p: ({ node: _node, ...props }) => <p className="my-1.5 leading-relaxed" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-1.5 list-disc pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-1.5 list-decimal pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="my-0.5" {...props} />,
  h1: ({ node: _node, ...props }) => <h3 className="mt-3 mb-1 text-sm font-semibold" {...props} />,
  h2: ({ node: _node, ...props }) => <h3 className="mt-3 mb-1 text-sm font-semibold" {...props} />,
  h3: ({ node: _node, ...props }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />
  ),
  code: ({ node: _node, ...props }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]" {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[12px] whitespace-pre-wrap" {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground" {...props} />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => <th className="border px-1.5 py-1 text-left font-medium" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border px-1.5 py-1" {...props} />,
};

function EntryView({ entry }: { entry: OutputEntry }) {
  if (entry.kind === "thinking") {
    return (
      <details className="group my-1.5 rounded-md border border-dashed bg-muted/40">
        <summary className="cursor-pointer px-2 py-1 text-[11px] text-muted-foreground select-none">
          thinking · {clockTime(entry.at)}
        </summary>
        <div className="px-2 pb-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {entry.text}
        </div>
      </details>
    );
  }

  if (entry.kind === "tool" || entry.kind === "result" || entry.role === "tool") {
    return (
      <div className="my-1.5 rounded-md border bg-muted/30 px-2 py-1.5">
        <div className="text-[11px] text-muted-foreground">
          {entry.role === "tool" ? "工具" : "结果"} · {clockTime(entry.at)}
        </div>
        <pre className="mt-0.5 max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{entry.text}</pre>
      </div>
    );
  }

  const isUser = entry.role === "user";
  return (
    <div className={cn("my-2", isUser && "rounded-md border-l-2 border-primary bg-primary/5 px-2 py-1.5")}>
      <div className="text-[11px] text-muted-foreground">
        {isUser ? "用户" : entry.role === "system" ? "系统" : "agent"} · {clockTime(entry.at)}
      </div>
      <div className="text-[13px]">
        <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>
          {entry.text}
        </Markdown>
      </div>
    </div>
  );
}
