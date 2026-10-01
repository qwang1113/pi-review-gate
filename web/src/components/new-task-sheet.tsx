import { MaximizeIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { NewTaskForm } from "@/components/new-task-form";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * The new-task sheet — the normal way to start a session. Submitting it closes
 * the sheet and jumps to the new session's page (with the launch tracker on
 * top); it never leaves the user staring at the form with a toast.
 */
export function NewTaskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent className="gap-0 p-0">
        <SheetHeader>
          <SheetTitle className="text-base">发起任务</SheetTitle>
          <SheetDescription>在新的 tmux 窗口里启动一个 pi 会话，工作目录就是你选的仓库。</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1">
          <NewTaskForm
            onLaunched={(sessionId) => {
              onClose();
              navigate(`/sessions/${sessionId}?launched=1`);
            }}
          />
        </div>
        <SheetFooter>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onClose();
              navigate("/new");
            }}
          >
            <MaximizeIcon className="size-3.5" />
            放大成独立页面
          </Button>
          <span className="text-[11px] text-muted-foreground">提交后直接进入会话详情页</span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
