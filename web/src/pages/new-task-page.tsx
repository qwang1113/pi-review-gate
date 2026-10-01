import { useNavigate } from "react-router-dom";

import { NewTaskForm } from "@/components/new-task-form";
import { Card } from "@/components/ui/card";

/** The same form, at full width — reached from the sheet's 「放大」 button. */
export default function NewTaskPage() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-4">
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="text-lg font-semibold tracking-tight">发起任务</h1>
        <p className="mb-3 text-xs text-muted-foreground">在新的 tmux 窗口里启动一个 pi 会话，工作目录就是你选的仓库。</p>
        <Card className="p-0">
          <NewTaskForm onLaunched={(sessionId) => navigate(`/sessions/${sessionId}?launched=1`)} />
        </Card>
      </div>
    </div>
  );
}
