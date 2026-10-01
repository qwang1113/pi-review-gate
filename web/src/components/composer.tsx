import { SendIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, describeError } from "@/lib/api";
import type { DaemonSession } from "@/lib/types";

/**
 * The bottom composer — how the user says something to a running session
 * without going back to the terminal.
 *
 * DELIVERY MODE, HONESTLY: `POST /api/sessions/:id/messages` writes into the
 * session's inbox, and the recipient's gate injects inbox records with
 * `deliverAs: "steer"` — it does not interrupt the turn in flight. There is no
 * `mode` field in the contract (`docs/daemon/api.md` §5.5 deliberately says the
 * body is `{text}`), so the panel offers the one delivery that actually
 * happens instead of a switch that would silently do nothing. `interrupt`
 * would have to be added on the daemon side.
 */
export function Composer({ session }: { session: DaemonSession }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const named = session.name !== null;

  const send = async () => {
    if (text.trim() === "" || !named) return;
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      // The address is the session's NAME — the daemon refuses an unnamed one.
      const receipt = await api<{ messageId: string; at: string }>(
        `/api/sessions/${encodeURIComponent(session.name!)}/messages`,
        { method: "POST", body: { text } },
      );
      setSent(`已写进 inbox（${receipt.messageId}）—— 会话读到后继续。`);
      setText("");
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border bg-card p-3">
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span>投递方式：</span>
        <span className="rounded bg-muted px-1">steer —— 写 inbox，会话读完继续</span>
        <span className="truncate" title="契约里 POST /api/sessions/:id/messages 只接受 {text}，没有 mode 字段">
          （interrupt 需要 daemon 支持 <code className="rounded bg-muted px-0.5">mode</code>，当前契约没有）
        </span>
      </div>
      <Textarea
        id="composer-input"
        className="min-h-20 resize-y"
        value={text}
        disabled={!named || busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={named ? "给这个会话写一条消息…（Cmd+Enter 发送）" : "这个会话还没有名字 —— 门禁只投递给登记过名字的会话"}
      />
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={!named || busy || text.trim() === ""} onClick={() => void send()}>
          <SendIcon className="size-3.5" />
          发送
        </Button>
        {sent !== null && <span className="text-[11px] text-success">{sent}</span>}
        {error !== null && <span className="text-[11px] text-destructive">{error}</span>}
      </div>
    </div>
  );
}
