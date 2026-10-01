/**
 * THE PANEL'S LIVE STATE — sessions, questions and the connection itself.
 *
 * One provider owns the single `/api/events` subscription; every page reads the
 * same maps, so "which session is waiting on me" cannot disagree between the
 * sidebar badge and the session list.
 *
 * Two rules from the contract shape this file:
 *   - the SSE stream is an EVENT stream, not a snapshot (`docs/daemon/api.md` §9),
 *     so a reconnect re-reads `GET /api/sessions` — losing the events that
 *     happened while the socket was down would leave a stale row forever;
 *   - questions have no SSE frame of their own, so they are polled — and the
 *     poll is the only thing the panel does on a timer.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { api, describeError, eventsUrl } from "@/lib/api";
import { onTokenChange, readToken } from "@/lib/token";
import type { DaemonQuestion, DaemonSession, QuestionsResponse, SessionEvent, SessionsResponse } from "@/lib/types";

/** How often the pending-question list is re-read. It has no SSE frame (§7). */
const QUESTION_POLL_MS = 5000;
/** How long to wait before rebuilding a stream the browser gave up on. */
const RECONNECT_MS = 2000;

interface DaemonValue {
  sessions: DaemonSession[];
  byId: Map<string, DaemonSession>;
  questions: DaemonQuestion[];
  /** SSE is open right now. false ⇒ the banner says so and a retry is already scheduled. */
  connected: boolean;
  snapshotLoaded: boolean;
  tmuxReadable: boolean;
  problems: string[];
  errors: string[];
  refresh: () => void;
  answer: (question: DaemonQuestion, answer: string | string[], reason?: string) => Promise<void>;
}

const DaemonContext = createContext<DaemonValue | null>(null);

/**
 * An SSE frame, parsed defensively.
 *
 * A malformed frame is dropped, never thrown: a stream is long-lived and the
 * panel must survive one bad line rather than unmount the whole app (which is
 * exactly what an exception inside an event listener used to be — a blank page
 * with no clue on it).
 */
function parseFrame<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function DaemonProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => readToken());
  const [byId, setById] = useState<Map<string, DaemonSession>>(() => new Map());
  const [questions, setQuestions] = useState<DaemonQuestion[]>([]);
  const [connected, setConnected] = useState(false);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [tmuxReadable, setTmuxReadable] = useState(true);
  const [problems, setProblems] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [generation, setGeneration] = useState(0);

  useEffect(() => onTokenChange(() => setToken(readToken())), []);
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  const noteErrors = useCallback((next: string[]) => {
    setErrors((current) => (next.length === 0 ? current : [...new Set([...current, ...next])].slice(-5)));
  }, []);

  // ── the snapshot + the session stream ──────────────────────────────────────
  useEffect(() => {
    if (token === null) {
      setConnected(false);
      setSnapshotLoaded(true);
      return;
    }
    let disposed = false;
    let stream: EventSource | null = null;
    let retry: number | undefined;

    const loadSnapshot = async () => {
      try {
        const snapshot = await api<SessionsResponse>("/api/sessions");
        if (disposed) return;
        setById(new Map(snapshot.sessions.map((session) => [session.sessionId, session])));
        setTmuxReadable(snapshot.tmuxReadable);
        setProblems(snapshot.problems ?? []);
        setSnapshotLoaded(true);
      } catch (error) {
        if (disposed) return;
        setSnapshotLoaded(true);
        noteErrors([`读取会话列表失败：${describeError(error)}`]);
      }
    };

    const open = () => {
      if (disposed) return;
      stream?.close();
      const source = new EventSource(eventsUrl());
      stream = source;
      source.onopen = () => {
        if (disposed) return;
        setConnected(true);
        // Events that fired while the socket was down are gone: re-read the
        // snapshot instead of trusting a map that missed them.
        void loadSnapshot();
        void loadQuestions();
      };
      source.addEventListener("session", (event) => {
        const payload = parseFrame<SessionEvent>((event as MessageEvent<string>).data);
        if (payload === null) return;
        setById((current) => {
          const next = new Map(current);
          if (payload.kind === "removed") next.delete(payload.sessionId);
          else next.set(payload.session.sessionId, payload.session);
          return next;
        });
      });
      source.onerror = () => {
        if (disposed) return;
        setConnected(false);
        // EventSource retries by itself only for transient failures. Rebuilding
        // it unconditionally also covers the closed cases, and the health probe
        // turns an invalid token back into the gate page.
        source.close();
        retry = window.setTimeout(() => {
          void api("/api/health")
            .catch((error: unknown) => noteErrors([`daemon 连接失败：${describeError(error)}`]))
            .finally(() => open());
        }, RECONNECT_MS);
      };
    };

    const loadQuestions = async () => {
      try {
        const payload = await api<QuestionsResponse>("/api/questions");
        if (disposed) return;
        setQuestions(payload.questions);
        if ((payload.problems ?? []).length > 0) noteErrors(payload.problems.map((item) => `待答问题：${item}`));
      } catch (error) {
        if (disposed) return;
        noteErrors([`读取待答问题失败：${describeError(error)}`]);
      }
    };

    void loadSnapshot();
    void loadQuestions();
    open();
    const poll = window.setInterval(() => void loadQuestions(), QUESTION_POLL_MS);

    return () => {
      disposed = true;
      stream?.close();
      if (retry !== undefined) window.clearTimeout(retry);
      window.clearInterval(poll);
      setConnected(false);
    };
  }, [token, generation, noteErrors]);

  const answer = useCallback(
    async (question: DaemonQuestion, value: string | string[], reason?: string) => {
      const body: Record<string, unknown> = { sessionId: question.sessionId };
      if (Array.isArray(value)) body.answers = value;
      else body.answer = value;
      if (reason !== undefined && reason.trim() !== "") body.reason = reason.trim();
      await api(`/api/questions/${encodeURIComponent(question.requestId)}/answer`, { method: "POST", body });
      // The question disappears the moment the gate consumes the answer; drop it
      // from the list right away so the next poll does not render it as pending.
      setQuestions((current) => current.filter((item) => item.requestId !== question.requestId));
    },
    [],
  );

  const value = useMemo<DaemonValue>(() => {
    const sessions = [...byId.values()].sort((left, right) => {
      const leftWaiting = left.state === "waiting-input" ? 0 : 1;
      const rightWaiting = right.state === "waiting-input" ? 0 : 1;
      if (leftWaiting !== rightWaiting) return leftWaiting - rightWaiting;
      return (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "");
    });
    return {
      sessions,
      byId,
      questions,
      connected,
      snapshotLoaded,
      tmuxReadable,
      problems,
      errors,
      refresh,
      answer,
    };
  }, [byId, questions, connected, snapshotLoaded, tmuxReadable, problems, errors, refresh, answer]);

  return <DaemonContext.Provider value={value}>{children}</DaemonContext.Provider>;
}

export function useDaemon(): DaemonValue {
  const value = useContext(DaemonContext);
  if (value === null) throw new Error("useDaemon 必须在 DaemonProvider 内使用");
  return value;
}

/** The pending questions of one session. The daemon already sorts newest first. */
export function useHasToken(): boolean {
  const [token, setToken] = useState(() => readToken());
  useEffect(() => onTokenChange(() => setToken(readToken())), []);
  return token !== null;
}
