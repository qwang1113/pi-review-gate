/**
 * The HTTP surface (lib/daemon/server.ts) — over a REAL socket, because the
 * contract the panel and the menu-bar app build against is the wire, not the
 * handler function: status codes, JSON field names, the SSE frame format and
 * the static fallback are all pinned here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createRuntime, type Runtime } from "../lib/daemon/server.ts";
import { DEFAULT_WEB_DIR, missingBuildPage, safeJoin } from "../lib/daemon/static.ts";
import { ensureDaemonToken } from "../lib/daemon/state.ts";
import { questionPath, sessionQuestionsDir } from "../lib/daemon/paths.ts";
import { sessionInboxPath, sessionRegistryRoot } from "../lib/session-registry.ts";
import {
  assistantRecord,
  paneLine,
  paneRunner,
  registryEntry,
  scratchHome,
  writeRegistry,
  writeTranscript,
} from "./daemon-helpers.ts";

interface Harness {
  home: string;
  webDir: string;
  runtime: Runtime;
  port: number;
  token: string;
  call: (path: string, init?: RequestInit) => Promise<Response>;
  json: <T = Record<string, unknown>>(path: string, init?: RequestInit) => Promise<T>;
}

async function harness(options: { withPanel?: boolean; webDir?: string } = {}): Promise<Harness> {
  const home = scratchHome();
  const webDir = options.webDir ?? join(home, "web");
  if (options.withPanel !== false) {
    mkdirSync(webDir, { recursive: true });
    writeFileSync(join(webDir, "index.html"), "<!doctype html><title>panel</title><div id=app></div>");
    writeFileSync(join(webDir, "app.js"), "console.log('panel')");
  }
  const token = ensureDaemonToken(home).token;
  // THE FIXTURE EXISTS BEFORE THE DAEMON STARTS, on purpose: the observer caches
  // one collection per second and the transcript index for five, so a fixture
  // written after a poll would be invisible to the next assertion — which is
  // correct behaviour (the daemon is not a test fixture), and the reason the
  // order here is what it is.
  writeRegistry(home, registryEntry({
    name: "t1-work",
    sessionId: "abc123",
    repo: "/Users/me/project",
    cwd: "/Users/me/project",
  }));
  writeTranscript(home, { sessionId: "abc123", cwd: "/Users/me/project", records: [assistantRecord("hello from the transcript")] });
  const runtime = createRuntime({
    home,
    port: 0,
    token,
    webDir,
    runTmux: paneRunner([
      paneLine({
        session: "rg-repo-abc123",
        windowId: "@1",
        paneId: "%7",
        sid: "abc123",
        repo: "/Users/me/project",
        kind: "loop",
        state: "working",
        stateAt: String(Math.floor(Date.now() / 1000)),
      }),
      // A pane with no registration at all — a judge or a worker. It has an id
      // and a state but no name, which is what the message endpoint refuses.
      paneLine({
        session: "rg-repo-abc123",
        windowId: "@2",
        paneId: "%8",
        sid: "judge-1",
        repo: "/Users/me/project",
        kind: "judge",
        state: "working",
        stateAt: String(Math.floor(Date.now() / 1000)),
      }),
    ]),
  });
  const port = await runtime.start();
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
    });
  async function json<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
    return (await (await call(path, init)).json()) as T;
  }
  return { home, webDir, runtime, port, token, call, json };
}

test("every /api call needs the token, and the token is never echoed", async () => {
  const h = await harness();
  try {
    const anonymous = await fetch(`http://127.0.0.1:${h.port}/api/sessions`);
    assert.equal(anonymous.status, 401);
    const wrong = await fetch(`http://127.0.0.1:${h.port}/api/sessions`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    const body = await wrong.text();
    assert.ok(!body.includes(h.token), "the refusal must not leak the expected token");
    // The `?token=` exception is SSE-only and is pinned by its own test below
    // (“the query token is an SSE-only exception”); this test is about the
    // header path.
  } finally {
    await h.runtime.stop();
  }
});

test("the query token is an SSE-only exception: every other endpoint wants a header", async () => {
  const h = await harness();
  try {
    const viaQuery = await fetch(`http://127.0.0.1:${h.port}/api/sessions?token=${h.token}`);
    assert.equal(viaQuery.status, 401, "a token in a URL ends up in logs and history — headers everywhere else");
    const viaHeader = await h.call("/api/sessions?limit=1");
    assert.equal(viaHeader.status, 200);
    // SSE still takes it in the URL: EventSource cannot set a header.
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${h.port}/api/events?replay=0&token=${h.token}`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    controller.abort();
  } finally {
    await h.runtime.stop();
  }
});

test("GET /api/health reports the daemon's own facts", async () => {
  const h = await harness();
  try {
    const health = await h.json<Record<string, unknown>>("/api/health");
    assert.equal(health.ok, true);
    assert.equal(health.schema, 1);
    assert.equal(health.pid, process.pid);
    assert.equal(health.port, h.port);
    assert.equal(typeof health.uptimeMs, "number");
    assert.equal(health.token, undefined);
  } finally {
    await h.runtime.stop();
  }
});

test("GET /api/sessions returns the observed session, by id and by name", async () => {
  const h = await harness();
  try {
    const listed = await h.json<{ tmuxReadable: boolean; sessions: Record<string, unknown>[] }>("/api/sessions");
    assert.equal(listed.tmuxReadable, true);
    const session = listed.sessions.find((candidate) => candidate.sessionId === "abc123");
    assert.ok(session);
    assert.equal(session.name, "t1-work");
    assert.equal(session.state, "working");
    assert.equal(session.stateSource, "pane");
    assert.equal((session.tmux as Record<string, unknown>).pane, "%7");
    assert.equal(typeof session.unmet, "object");

    const byId = await h.json<{ session: Record<string, unknown> }>("/api/sessions/abc123");
    assert.equal(byId.session.name, "t1-work");
    const byName = await h.json<{ session: Record<string, unknown> }>("/api/sessions/t1-work");
    assert.equal(byName.session.sessionId, "abc123");
    const missing = await h.call("/api/sessions/ghost");
    assert.equal(missing.status, 404);

    const output = await h.json<{ entries: { text: string }[] }>("/api/sessions/abc123/output?tail=5");
    assert.ok(output.entries.some((entry) => entry.text === "hello from the transcript"));
  } finally {
    await h.runtime.stop();
  }
});

test("POST a message: named sessions get an inbox line, unnamed ones are refused", async () => {
  const h = await harness();
  try {
    const sent = await h.json<{ ok: boolean; messageId: string; inbox: string }>("/api/sessions/t1-work/messages", {
      method: "POST",
      body: JSON.stringify({ text: "从面板发来的消息" }),
    });
    assert.equal(sent.ok, true);
    const inbox = sessionInboxPath(sessionRegistryRoot(h.home), "t1-work");
    assert.equal(sent.inbox, inbox);
    assert.equal(readFileSync(inbox, "utf8").includes("从面板发来的消息"), true);

    const unnamed = await h.call("/api/sessions/judge-1/messages", { method: "POST", body: JSON.stringify({ text: "x" }) });
    assert.equal(unnamed.status, 400, "a session with no name has no address to write to");
    assert.match(((await unnamed.json()) as { error: string }).error, /还没有名字/);
  } finally {
    await h.runtime.stop();
  }
});

test("a bad JSON body is a 400, not a 500", async () => {
  const h = await harness();
  try {
    const bad = await h.call("/api/tasks", { method: "POST", body: "{ not json" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /合法 JSON/);
  } finally {
    await h.runtime.stop();
  }
});

test("GET /api/repos and POST /api/tasks answer their documented shapes", async () => {
  const h = await harness();
  try {
    const repos = await h.json<{ repos: unknown[] }>("/api/repos");
    assert.equal(Array.isArray(repos.repos), true);

    const refused = await h.call("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ repo: "/no/such/place", task: "x" }),
    });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /不是存在的目录/);
  } finally {
    await h.runtime.stop();
  }
});

test("the inbox sender is the daemon, never a name the request supplied", async () => {
  const h = await harness();
  try {
    const sent = await h.json<{ ok: boolean; inbox: string }>("/api/sessions/t1-work/messages", {
      method: "POST",
      body: JSON.stringify({ text: "伪装测试", from: "t1-work" }),
    });
    assert.equal(sent.ok, true);
    const line = readFileSync(sent.inbox, "utf8").trim().split("\n").pop()!;
    const record = JSON.parse(line) as { from: string; fromSessionId: string; fromMode: string };
    assert.equal(record.from, "daemon", "a token holder must not be able to sign as another session");
    assert.equal(record.fromSessionId, "daemon");
    assert.equal(record.fromMode, "daemon");
  } finally {
    await h.runtime.stop();
  }
});

test("config: read masks, write refuses without touching the file, and backs up on success", async () => {
  const h = await harness();
  try {
    const settings = join(h.home, ".pi", "agent", "settings.json");
    mkdirSync(join(h.home, ".pi", "agent"), { recursive: true });
    writeFileSync(settings, `${JSON.stringify({ theme: "dark", apiTokens: { acme: "sk-hidden" } }, null, 2)}\n`);

    const view = await h.json<{ value: Record<string, unknown>; fields: { path: string }[] }>("/api/config?target=settings");
    assert.equal((view.value.apiTokens as Record<string, string>).acme, "••••••••");
    assert.equal(view.value.theme, "dark");
    assert.ok(view.fields.some((field) => field.path === "theme"));

    const refused = await h.call("/api/config", {
      method: "PUT",
      body: JSON.stringify({ target: "settings", path: "theme", value: 42 }),
    });
    assert.equal(refused.status, 400);
    assert.equal(readFileSync(settings, "utf8").includes('"dark"'), true);

    const written = await h.json<{ ok: boolean; backup: string }>("/api/config", {
      method: "PUT",
      body: JSON.stringify({ target: "settings", path: "theme", value: "light" }),
    });
    assert.equal(written.ok, true);
    assert.ok(readFileSync(written.backup, "utf8").includes('"dark"'));
    assert.ok(readFileSync(settings, "utf8").includes('"light"'));

    const unknownTarget = await h.call("/api/config?target=nope");
    assert.equal(unknownTarget.status, 400);
    const noRepo = await h.call("/api/config?target=gate-project");
    assert.equal(noRepo.status, 400);
  } finally {
    await h.runtime.stop();
  }
});

test("questions: an empty data source still answers, and the answer path works end to end", async () => {
  const h = await harness();
  try {
    const empty = await h.json<{ questions: unknown[] }>("/api/questions");
    assert.deepEqual(empty.questions, []);

    mkdirSync(sessionQuestionsDir(h.home, "abc123"), { recursive: true });
    writeFileSync(questionPath(h.home, "abc123", "q-7"), JSON.stringify({
      schema: 1,
      requestId: "q-7",
      sessionId: "abc123",
      sessionName: "t1-work",
      topic: "ask-user",
      title: "继续吗？",
      options: ["继续", "停"],
      multiple: false,
      recommended: "继续",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));

    const listed = await h.json<{ questions: { requestId: string }[] }>("/api/questions?sessionId=abc123");
    assert.equal(listed.questions.length, 1);
    assert.equal(listed.questions[0]?.requestId, "q-7");

    const answered = await h.json<{ ok: boolean; answer: string }>("/api/questions/q-7/answer", {
      method: "POST",
      body: JSON.stringify({ sessionId: "abc123", answer: "A" }),
    });
    assert.equal(answered.ok, true);
    assert.equal(answered.answer, "继续");

    const again = await h.call("/api/questions/q-7/answer", {
      method: "POST",
      body: JSON.stringify({ sessionId: "abc123", answer: "停" }),
    });
    assert.equal(again.status, 400);

    const missingSession = await h.call("/api/questions/q-7/answer", { method: "POST", body: JSON.stringify({ answer: "继续" }) });
    assert.equal(missingSession.status, 400);
    assert.deepEqual((await h.json<{ questions: unknown[] }>("/api/questions")).questions, []);
  } finally {
    await h.runtime.stop();
  }
});

test("notifications: the first claim wins, the second is a duplicate, and history reads back", async () => {
  const h = await harness();
  try {
    const first = await h.json<{ claimed: boolean; firstSeenAt: string; count: number }>("/api/notifications/claim", {
      method: "POST",
      body: JSON.stringify({ key: "等你回答 · project\u0000@t1-work 正在等你回答。", kind: "waiting-input", sessionId: "abc123", title: "等你回答 · project", body: "@t1-work 正在等你回答。" }),
    });
    assert.equal(first.claimed, true);
    assert.equal(first.count, 1);

    const second = await h.json<{ claimed: boolean; count: number; reason: string }>("/api/notifications/claim", {
      method: "POST",
      body: JSON.stringify({ key: "等你回答 · project\u0000@t1-work 正在等你回答。", kind: "waiting-input", sessionId: "abc123" }),
    });
    assert.equal(second.claimed, false);
    assert.match(second.reason, /已发过/);

    const history = await h.json<{ entries: { key: string; count: number }[] }>("/api/notifications?limit=10");
    assert.equal(history.entries.length, 1);
    assert.equal(history.entries[0]?.key.startsWith("等你回答"), true);

    const noKey = await h.call("/api/notifications/claim", { method: "POST", body: JSON.stringify({}) });
    assert.equal(noKey.status, 400);
  } finally {
    await h.runtime.stop();
  }
});

test("SSE: a subscription replays recent output and then pushes new entries", async () => {
  const h = await harness();
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${h.port}/api/events?sessionId=abc123&replay=5&token=${h.token}`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: { event: string; data: unknown }[] = [];
    const readUntil = async (predicate: () => boolean, budgetMs: number): Promise<void> => {
      const deadline = Date.now() + budgetMs;
      while (!predicate() && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1] ?? "";
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          frames.push({ event, data: data === undefined ? undefined : JSON.parse(data) });
        }
      }
    };

    await readUntil(() => frames.some((frame) => frame.event === "hello"), 2_000);
    assert.ok(frames.some((frame) => frame.event === "hello"), "the subscription opens with a hello frame");
    await readUntil(() => frames.some((frame) => frame.event === "output" && (frame.data as { replay?: boolean }).replay === true), 2_000);
    const replay = frames.find((frame) => frame.event === "output")!;
    assert.ok((replay.data as { entries: { text: string }[] }).entries.some((entry) => entry.text === "hello from the transcript"));

    // Now make the session produce something NEW.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(h.home, ".pi", "agent", "sessions", "--repo--", "2026-01-01T00-00-00-000Z_abc123.jsonl"),
      `${JSON.stringify(assistantRecord("a brand new line"))}\n`);
    await readUntil(() => frames.some((frame) => frame.event === "output" && (frame.data as { replay?: boolean }).replay !== true), 4_000);
    const live = frames.filter((frame) => frame.event === "output").pop()!;
    assert.ok((live.data as { entries: { text: string }[] }).entries.some((entry) => entry.text === "a brand new line"));
  } finally {
    controller.abort();
    await h.runtime.stop();
  }
});

test("a session is addressable as `名字` and as `@名字` (one address, two spellings)", async () => {
  const h = await harness();
  try {
    for (const key of ["t1-work", "@t1-work"]) {
      const found = await h.json<{ session: { sessionId: string } }>(`/api/sessions/${key}`);
      assert.equal(found.session.sessionId, "abc123", `${key} must resolve to the same session`);
    }
    const sent = await h.json<{ ok: boolean }>("/api/sessions/@t1-work/messages", {
      method: "POST",
      body: JSON.stringify({ text: "从 @ 形式发来的" }),
    });
    assert.equal(sent.ok, true);
  } finally {
    await h.runtime.stop();
  }
});

test("a path segment that is not valid percent-encoding is a 404, never a 500", async () => {
  const h = await harness();
  try {
    const raw = await h.call("/api/sessions/%");
    assert.equal(raw.status, 404, `expected 404, got ${raw.status}`);
    const malformed = await h.call("/api/sessions/%zz");
    assert.equal(malformed.status, 404);
  } finally {
    await h.runtime.stop();
  }
});

test("SSE: a subscription with replay=0 still tails from the moment it subscribes", async () => {
  const h = await harness();
  const controller = new AbortController();
  try {
    const response = await fetch(`http://127.0.0.1:${h.port}/api/events?sessionId=abc123&replay=0&token=${h.token}`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: { event: string; data: Record<string, unknown> }[] = [];
    const pump = async (budgetMs: number, predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + budgetMs;
      while (!predicate() && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = /^event: (.+)$/m.exec(raw)?.[1] ?? "";
          const data = /^data: (.+)$/m.exec(raw)?.[1];
          frames.push({ event, data: data === undefined ? {} : JSON.parse(data) });
        }
      }
    };
    await pump(2_000, () => frames.some((frame) => frame.event === "hello"));
    assert.equal(frames.some((frame) => frame.data.replay === true), false, "replay=0 sent no history");

    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(h.home, ".pi", "agent", "sessions", "--repo--", "2026-01-01T00-00-00-000Z_abc123.jsonl"),
      `${JSON.stringify(assistantRecord("written after subscribing"))}\n`);
    await pump(4_000, () => frames.some((frame) => frame.event === "output"));
    const output = frames.filter((frame) => frame.event === "output").pop();
    assert.ok(output, "an appended line reaches a replay=0 subscriber");
    assert.ok((output.data.entries as { text: string }[]).some((entry) => entry.text === "written after subscribing"));
  } finally {
    controller.abort();
    await h.runtime.stop();
  }
});

test("static: the panel is served, an unknown route falls back to index.html", async () => {
  const h = await harness();
  try {
    const root = await h.call("/");
    assert.equal(root.status, 200);
    assert.match(await root.text(), /id=app/);
    const asset = await h.call("/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);
    const deepRoute = await h.call("/sessions/abc123");
    assert.equal(deepRoute.status, 200);
    assert.match(await deepRoute.text(), /id=app/, "a single-page app's own route must survive a reload");
    // A path that tries to climb out of the static root never leaves it.
    assert.equal(safeJoin("/srv/web", "/../../etc/passwd"), undefined);
    assert.equal(safeJoin("/srv/web", "/ok/../secret"), "/srv/web/secret", "a path that resolves inside the root is served from inside it");
    const notThere = await h.call("/%2e%2e/%2e%2e/etc/passwd");
    assert.match(await notThere.text(), /id=app/, "a traversal attempt is just an unknown route");
  } finally {
    await h.runtime.stop();
  }
});

test("static: a symlink out of the build directory is not served", async () => {
  const home = scratchHome();
  const webDir = join(home, "web");
  const outside = join(home, "secret.txt");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(outside, "TOP SECRET", "utf8");
  writeFileSync(join(webDir, "index.html"), "<!doctype html><div id=app></div>", "utf8");
  symlinkSync(outside, join(webDir, "leak.txt"));
  const h = await harness({ webDir, withPanel: false });
  try {
    const leaked = await h.call("/leak.txt");
    const body = await leaked.text();
    assert.ok(!body.includes("TOP SECRET"), "a symlink must not widen the static root");
    assert.match(body, /id=app/, "it falls back to the panel like any other unknown path");
  } finally {
    await h.runtime.stop();
  }
});

test("static: a missing build is an explanation page, never a 500", async () => {
  const home = scratchHome();
  const h = await harness({ webDir: join(home, "not-built"), withPanel: false });
  try {
    const response = await h.call("/");
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /面板还没构建/);
    assert.match(body, /build:web/);
    assert.match(missingBuildPage(join(home, "not-built")), /not-built/);
    assert.equal(DEFAULT_WEB_DIR.endsWith("/web/dist"), true);
  } finally {
    await h.runtime.stop();
  }
});

test("an unknown /api path is a 404 and a wrong method on a known one is a 405", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("/api/nope")).status, 404);
    assert.equal((await h.call("/api/health", { method: "POST" })).status, 405);
  } finally {
    await h.runtime.stop();
  }
});
