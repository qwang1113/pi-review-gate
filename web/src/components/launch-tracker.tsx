import { useEffect, useState } from "react";

import { tmuxCommand } from "@/components/session-header";
import { useDaemon } from "@/lib/daemon-context";
import { cn } from "@/lib/utils";

/** The four steps, in order. Each one is unlocked by a FACT, never by a timer. */
const STEPS = ["starting", "window-created", "booting", "working"] as const;
const STEP_LABELS: Record<(typeof STEPS)[number], string> = {
  starting: "已提交",
  "window-created": "窗口已创建",
  booting: "pi 已启动",
  working: "会话已注册",
};

/** After this long with no registry heartbeat, "starting" stops being a normal thing to watch. */
const SLOW_AFTER_MS = 8000;

/**
 * The launch tracker for a session started from the panel.
 *
 * Every stage comes from an observable fact — the pane exists in
 * `GET /api/sessions`, the session registered a name, a heartbeat landed — and
 * the only clock in here is the "this is taking a while" hint. A fixed delay
 * would have called a slow boot "done" and a fast one "still starting".
 */
export function LaunchTracker({ sessionId, launchedAt }: { sessionId: string; launchedAt: number }) {
  const { byId } = useDaemon();
  const session = byId.get(sessionId);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const hasPane = session !== undefined && session.tmux !== null;
  // Three facts, three stages: the pane exists, the transcript has moved (pi is
  // really running), the session registered (its gate is up and it can be
  // addressed). A timer is only the "this is taking a while" hint below.
  const hasTranscript = session !== undefined && session.lastActivityAt !== null;
  const hasRegistry = session !== undefined && (session.heartbeatAt !== null || session.registeredAt !== null);
  const stage = hasRegistry ? 3 : hasTranscript ? 2 : hasPane ? 1 : 0;
  const waitingMs = now - launchedAt;
  const slow = stage < 2 && waitingMs > SLOW_AFTER_MS;
  const lost = session !== undefined && !session.alive && stage < 3;
  const command = session === undefined ? null : tmuxCommand(session);

  return (
    <div className="mb-4 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        {STEPS.map((step, index) => (
          <div key={step} className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px]",
                index <= stage ? "bg-primary/10 text-primary" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  index < stage ? "bg-success" : index === stage ? "animate-pulse bg-primary" : "bg-muted-foreground/40",
                )}
              />
              {STEP_LABELS[step]}
            </span>
            {index < STEPS.length - 1 && <span className="text-muted-foreground/50">→</span>}
          </div>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">{Math.floor(waitingMs / 1000)}s</span>
      </div>

      {slow && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
          <span>启动较慢 —— 8 秒内还没有运行迹象。</span>
          {command !== null && (
            <code className="rounded bg-background/70 px-1 font-mono text-[11px]">{command}</code>
          )}
          <span className="text-muted-foreground">
            在终端里跑这条命令可以直接看到那个 pane 的 stderr；面板读不到它（daemon 没有这个接口）。
          </span>
        </div>
      )}

      {lost && (
        <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          这个会话在注册之前就没了（pane 消失了）。换一组参数重开一个 —— 新 Sheet 里的草稿还在。
        </div>
      )}
    </div>
  );
}
