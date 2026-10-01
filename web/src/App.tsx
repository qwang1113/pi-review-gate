import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";

import { AppSidebar } from "@/components/app-sidebar";
import { ErrorBoundary } from "@/components/error-boundary";
import { NewTaskSheet } from "@/components/new-task-sheet";
import { TopBar } from "@/components/top-bar";
import { useHasToken } from "@/lib/daemon-context";
import HistoryPage from "@/pages/history-page";
import NewTaskPage from "@/pages/new-task-page";
import QuestionsPage from "@/pages/questions-page";
import SessionDetailPage from "@/pages/session-detail-page";
import SchedulesPage from "@/pages/schedules-page";
import SessionsPage from "@/pages/sessions-page";
import SettingsPage from "@/pages/settings-page";
import TokenGatePage from "@/pages/token-gate-page";

/**
 * The shell: sidebar, top bar, routed content — and the new-task sheet, which
 * lives here rather than in a page because it can be opened from anywhere and
 * must survive a route change underneath it.
 *
 * The sheet's open state is `?new=1` in the URL: one source of truth, a working
 * back button, and no context just to pass a boolean down.
 */
export default function App() {
  const hasToken = useHasToken();
  const [params, setParams] = useSearchParams();
  const location = useLocation();

  if (!hasToken) return <TokenGatePage />;

  const closeSheet = () => {
    const next = new URLSearchParams(params);
    next.delete("new");
    setParams(next, { replace: true });
  };

  return (
    <div className="flex h-full">
      <AppSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl p-6">
            {/* Keyed by route: a crash on one page does not follow the user to the next. */}
            <ErrorBoundary key={location.pathname}>
              <Routes>
                <Route path="/" element={<SessionsPage />} />
                <Route path="/sessions/:id" element={<SessionDetailPage />} />
                <Route path="/questions" element={<QuestionsPage />} />
                <Route path="/new" element={<NewTaskPage />} />
                <Route path="/schedules" element={<SchedulesPage />} />
                <Route path="/history" element={<HistoryPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <NewTaskSheet open={params.get("new") === "1"} onClose={closeSheet} />
    </div>
  );
}
