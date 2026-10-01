import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { storeToken } from "@/lib/token";

/**
 * Shown when the panel has no token at all. The daemon authenticates every
 * `/api/*` call and there is no "log in" endpoint, so the only thing the panel
 * can do is tell the user exactly which file holds it.
 */
export default function TokenGatePage() {
  const [draft, setDraft] = useState("");

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader className="flex-col">
          <CardTitle className="text-base">需要 daemon token</CardTitle>
          <CardDescription>
            面板与 daemon 同源，但每一个 API 调用都要带 token。把它粘进来即可（只存在这台机器的
            localStorage 里）。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <pre className="rounded-md bg-muted px-3 py-2 text-xs">cat ~/.pi/agent/rg-daemon.token</pre>
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draft.trim() !== "") storeToken(draft.trim());
              }}
              placeholder="粘贴 token"
              autoFocus
            />
            <Button disabled={draft.trim() === ""} onClick={() => storeToken(draft.trim())}>
              保存
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            也可以用 <code className="rounded bg-muted px-1">http://127.0.0.1:4597/#token=&lt;token&gt;</code> 打开一次 ——
            读取后面板会把片段从地址栏去掉。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
