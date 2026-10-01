/**
 * THE ONLY WAY THE PANEL TALKS TO THE DAEMON.
 *
 * Paths are relative: the panel is served by the daemon itself, so same-origin
 * is the contract — there is no configurable base URL to get wrong, and a
 * deep-linked page reload still hits the right host.
 */

import { clearToken, readToken } from "@/lib/token";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface ApiInit {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
}

/** One API call. Throws {@link ApiError} carrying the daemon's own error text. */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const token = readToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch (error) {
    throw new ApiError(0, `连不上 daemon：${error instanceof Error ? error.message : String(error)}`);
  }

  if (response.status === 401) {
    // The token is gone or wrong: back to the gate page rather than a screen
    // where every panel shows the same 401 forever. The line is for the browser
    // console — "why did the panel ask for a token again" is a question worth
    // being able to answer without a debugger.
    console.warn(`[pi-gate 面板] ${path} 被拒：token 缺失或错误，已清空本地 token —— 面板回到 token 门页。`);
    clearToken();
  }

  const text = await response.text();
  let payload: unknown = undefined;
  if (text !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (!response.ok) {
    const message =
      payload !== null && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

/** The SSE URL for `EventSource`, which cannot send an Authorization header. */
export function eventsUrl(params: { sessionId?: string; replay?: number } = {}): string {
  const query = new URLSearchParams();
  const token = readToken();
  if (token !== null) query.set("token", token);
  if (params.sessionId !== undefined) query.set("sessionId", params.sessionId);
  if (params.replay !== undefined) query.set("replay", String(params.replay));
  return `/api/events?${query.toString()}`;
}

/** A human sentence for any thrown thing. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
