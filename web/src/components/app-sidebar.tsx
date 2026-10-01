import { HistoryIcon, InboxIcon, LayoutGridIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { NavLink, useSearchParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDaemon } from "@/lib/daemon-context";
import { cn } from "@/lib/utils";

/** The five destinations, in the order the work happens. */
const NAV = [
  { key: "sessions", to: "/", label: "会话", icon: LayoutGridIcon },
  { key: "questions", to: "/questions", label: "待处理", icon: InboxIcon },
  { key: "new", to: "/new", label: "发起任务", icon: PlusIcon },
  { key: "history", to: "/history", label: "历史", icon: HistoryIcon },
  { key: "settings", to: "/settings", label: "设置", icon: SettingsIcon },
] as const;

export function AppSidebar() {
  const { sessions, questions, connected } = useDaemon();
  const [params, setParams] = useSearchParams();
  const waiting = sessions.filter((session) => session.state === "waiting-input").length;

  const openSheet = () => {
    const next = new URLSearchParams(params);
    next.set("new", "1");
    setParams(next);
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 py-4">
        <span className="text-sm font-semibold tracking-tight">pi-gate</span>
        <span className="text-[11px] text-muted-foreground">面板</span>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2">
        {NAV.map((item) => {
          const badgeCount = item.key === "sessions" ? waiting : item.key === "questions" ? questions.length : 0;
          const shared = cn(
            "flex h-9 items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground transition-colors",
            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          );
          if (item.key === "new") {
            return (
              <Button key={item.key} variant="ghost" className={cn(shared, "justify-start font-normal")} onClick={openSheet}>
                <item.icon className="size-4" />
                发起任务
              </Button>
            );
          }
          return (
            <NavLink
              key={item.key}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(shared, isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground")
              }
            >
              <item.icon className="size-4" />
              {item.label}
              {badgeCount > 0 && (
                <Badge variant="destructive" className="ml-auto">
                  {badgeCount}
                </Badge>
              )}
            </NavLink>
          );
        })}
      </nav>
      <div className="flex items-center gap-2 px-4 py-3 text-[11px] text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-destructive")} />
        {connected ? "daemon 已连接" : "daemon 未连接"}
      </div>
    </aside>
  );
}
