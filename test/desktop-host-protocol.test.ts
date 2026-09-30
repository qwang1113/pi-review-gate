import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildJsonSchema,
  checkDialogOutcome,
  decodeRequest,
  decodeResponse,
  encodeRequest,
  encodeResponse,
  livenessOf,
  MAX_FRAME_BYTES,
  METHOD_NAMES,
  METHODS,
  requestTimeoutMs,
  resolveHostEnv,
  type Method,
  type Params,
  type Result,
} from "../lib/desktop-host-protocol.ts";

const SCHEMA_PATH = new URL("../desktop/protocol/host-protocol.schema.json", import.meta.url);

/** One valid params/result pair per method — the round-trip fixtures. */
const SAMPLES: { [M in Method]: { params: Params<M>; result: Result<M> } } = {
  hello: {
    params: { protocol: 1, pid: 4242, hostSessionId: "hs-1", piSessionId: "0199-abc", cwd: "/repo" },
    result: { protocol: 1, client: { name: "pi-desktop", version: "0.1.0" } },
  },
  "session.open": {
    params: {
      argv: ["pi", "--mode", "rpc", "--session-id", "x"],
      cwd: "/repo",
      env: { RG_JUDGE_ROLE: "reviewer" },
      title: "reviewer@self",
      role: "judge",
      placement: "own-group",
    },
    result: { hostSessionId: "hs-2", pid: 99 },
  },
  "session.list": {
    params: {},
    result: {
      sessions: [
        { hostSessionId: "hs-1", parent: null, role: "root", title: "pi", groupPin: null },
        { hostSessionId: "hs-2", parent: "hs-1", role: "judge", title: "reviewer", pid: 99, groupPin: "handed-off" },
      ],
    },
  },
  "session.pin": { params: { reason: "handed-off" }, result: {} },
  "session.close": { params: { target: "session", hostSessionId: "hs-2" }, result: { closed: ["hs-2"] } },
  "session.decorate": {
    params: { hostSessionId: "hs-2", label: "reviewer@self", colorSeed: "judge-1", state: "waiting-input", stateAt: 1700000000, kind: "judge", repo: "/repo", sessionName: null },
    result: {},
  },
  focus: { params: { hostSessionId: "hs-2" }, result: {} },
  "focus.state": { params: {}, result: { focusedHostSessionId: null, appFrontmost: false } },
  notify: {
    params: { kind: "needs-user", title: "等你回答 · repo", body: "要不要继续？", group: "sid", focusHostSessionId: "hs-1" },
    result: { shown: true },
  },
  "dialog.open": {
    params: { shape: "choice", dialogId: "d1", title: "问题 1 / 2", body: "长正文".repeat(100), options: ["甲", "乙"], recommended: "甲", declineRow: "✎ 不选，我说明原因", back: true },
    result: { kind: "picked", option: "甲" },
  },
  "dialog.close": { params: { dialogId: "d1" }, result: {} },
};

test("every method round-trips request and response through encode/decode", () => {
  for (const method of METHOD_NAMES) {
    const sample = SAMPLES[method] as { params: never; result: never };
    const req = encodeRequest(`r-${method}`, method, sample.params);
    assert.ok(req.ok, `${method}: ${JSON.stringify(req)}`);
    assert.ok(req.frame.endsWith("\n") && !req.frame.slice(0, -1).includes("\n"));
    const decodedReq = decodeRequest(req.frame);
    assert.ok(decodedReq.ok, `${method}: ${JSON.stringify(decodedReq)}`);
    assert.deepEqual(decodedReq.request, { id: `r-${method}`, method, params: sample.params });

    const res = encodeResponse(`r-${method}`, method, { ok: true, result: sample.result });
    assert.ok(res.ok, `${method}: ${JSON.stringify(res)}`);
    const decodedRes = decodeResponse(res.frame, (id) => (id === `r-${method}` ? method : undefined));
    assert.ok(decodedRes.ok, `${method}: ${JSON.stringify(decodedRes)}`);
    assert.deepEqual(decodedRes.result, sample.result);
  }
});

test("dialog shapes and outcomes round-trip: multi, decline with reason, back, dismissed", () => {
  const multi: Params<"dialog.open"> = { shape: "multi", dialogId: "d2", title: "选几个", options: ["甲", "乙", "丙"], defaultChecked: ["甲"], declineRow: "✎", back: false };
  assert.ok(encodeRequest("r1", "dialog.open", multi).ok);
  for (const outcome of [
    { kind: "checked", options: ["甲", "丙"] },
    { kind: "checked", options: [] },
    { kind: "decline", reason: "都不对" },
    { kind: "dismissed" },
    { kind: "aborted" },
    { kind: "unavailable" },
  ] as Result<"dialog.open">[]) {
    const frame = encodeResponse("r1", "dialog.open", { ok: true, result: outcome });
    assert.ok(frame.ok);
    const decoded = decodeResponse(frame.frame, () => "dialog.open");
    assert.ok(decoded.ok);
    assert.deepEqual(decoded.result, outcome);
    assert.equal(checkDialogOutcome(multi, outcome), undefined);
  }
});

test("an answer the box did not offer is refused by checkDialogOutcome", () => {
  const choice = SAMPLES["dialog.open"].params;
  assert.match(checkDialogOutcome(choice, { kind: "picked", option: "丙" }) ?? "", /不在 options/);
  assert.match(checkDialogOutcome(choice, { kind: "checked", options: ["甲"] }) ?? "", /多选框/);
  const noBack = { ...choice, back: false };
  assert.match(checkDialogOutcome(noBack, { kind: "back" }) ?? "", /返回上一题/);
  const multi: Params<"dialog.open"> = { shape: "multi", dialogId: "d", title: "t", options: ["甲", "乙"], defaultChecked: [], declineRow: "✎", back: false };
  assert.match(checkDialogOutcome(multi, { kind: "checked", options: ["甲", "甲"] }) ?? "", /重复/);
  assert.match(checkDialogOutcome(multi, { kind: "picked", option: "甲" }) ?? "", /单选框/);
});

test("requests that break the table are refused before they reach the wire", () => {
  const bad = (method: Method, params: unknown) => {
    const out = encodeRequest("r", method, params as never);
    assert.equal(out.ok, false, `${method} ${JSON.stringify(params)}`);
    if (!out.ok) assert.equal(out.error.code, "bad-request");
  };
  bad("session.open", { ...SAMPLES["session.open"].params, cwd: "relative" });
  bad("session.open", { ...SAMPLES["session.open"].params, argv: [] });
  bad("session.open", { ...SAMPLES["session.open"].params, env: { "BAD KEY": "x" } });
  bad("session.open", { ...SAMPLES["session.open"].params, role: "root" });
  bad("session.open", { ...SAMPLES["session.open"].params, extra: 1 });
  bad("session.open", { ...SAMPLES["session.open"].params, env: { RG_HOST_SESSION: "hs-1" } });
  bad("session.pin", { reason: "" });
  bad("session.close", { target: "everything" });
  bad("session.decorate", { hostSessionId: "hs", state: "sleeping" });
  bad("notify", { ...SAMPLES.notify.params, title: "x".repeat(81) });
  bad("dialog.open", { ...SAMPLES["dialog.open"].params, options: ["only-one"] });
  bad("dialog.open", { ...SAMPLES["dialog.open"].params, options: ["a", "b", "c", "d", "e"] });
  bad("hello", { ...SAMPLES.hello.params, pid: 1.5 });
  bad("focus", { hostSessionId: "has space" });
  assert.equal(encodeRequest("bad id!", "focus", { hostSessionId: "hs" }).ok, false);
});

test("decodeRequest names the failure: bad frame, unknown method, bad params", () => {
  const codeOf = (line: string) => {
    const out = decodeRequest(line);
    return out.ok ? "ok" : out.error.code;
  };
  assert.equal(codeOf("not json"), "bad-frame");
  assert.equal(codeOf("[1]"), "bad-frame");
  assert.equal(codeOf(JSON.stringify({ v: 2, type: "request", id: "r", method: "focus", params: {} })), "bad-frame");
  assert.equal(codeOf(JSON.stringify({ v: 1, type: "request", id: "r", method: "kill-server", params: {} })), "unknown-method");
  assert.equal(codeOf(JSON.stringify({ v: 1, type: "request", id: "r", method: "focus", params: {} })), "bad-request");
  assert.equal(codeOf(JSON.stringify({ v: 1, type: "request", method: "focus", params: {} })), "bad-request");
  const leak = { ...SAMPLES["session.open"].params, env: { RG_HOST: "desktop" } };
  assert.equal(codeOf(JSON.stringify({ v: 1, type: "request", id: "r", method: "session.open", params: leak })), "bad-request");
  assert.equal(codeOf(`{"v":1,"pad":"${"x".repeat(MAX_FRAME_BYTES)}"}`), "bad-frame");
});

test("decodeResponse fails closed: unknown id, malformed result, bad error code, oversized", () => {
  const ok = encodeResponse("r1", "session.list", { ok: true, result: SAMPLES["session.list"].result });
  assert.ok(ok.ok);
  const nobody = decodeResponse(ok.frame, () => undefined);
  assert.equal(nobody.ok, false);
  if (!nobody.ok) assert.deepEqual([nobody.error.code, nobody.id], ["bad-response", "r1"]);

  const malformed = JSON.stringify({ v: 1, type: "response", id: "r1", ok: true, result: { sessions: [{ hostSessionId: "hs" }] } });
  const m = decodeResponse(malformed, () => "session.list");
  assert.equal(m.ok, false);
  if (!m.ok) assert.equal(m.error.code, "bad-response");

  const localCode = JSON.stringify({ v: 1, type: "response", id: "r1", ok: false, error: { code: "timeout", message: "x" } });
  const l = decodeResponse(localCode, () => "focus");
  assert.equal(l.ok, false);
  if (!l.ok) assert.equal(l.error.code, "bad-response");

  const wireError = encodeResponse("r1", "session.close", { ok: false, error: { code: "forbidden", message: "not yours" } });
  assert.ok(wireError.ok);
  const w = decodeResponse(wireError.frame, () => "session.close");
  assert.equal(w.ok, false);
  if (!w.ok) assert.deepEqual([w.id, w.error], ["r1", { code: "forbidden", message: "not yours" }]);

  const stray = JSON.stringify({ v: 1, type: "response", id: "r1", ok: true, result: {}, extra: 1 });
  assert.equal(decodeResponse(stray, () => "focus").ok, false);
  assert.equal(decodeResponse(JSON.stringify({ v: 1, type: "response", id: "r1", ok: "yes" }), () => "focus").ok, false);

  const huge = encodeResponse("r1", "dialog.open", { ok: true, result: { kind: "decline", reason: "x".repeat(262144) } });
  assert.ok(huge.ok, "the largest allowed reason still fits a frame");
});

test("liveness: a failed listing is unknown, never dead", () => {
  const listing = { ok: true as const, result: SAMPLES["session.list"].result };
  assert.equal(livenessOf(listing, "hs-2"), "alive");
  assert.equal(livenessOf(listing, "hs-9"), "dead");
  assert.equal(livenessOf({ ok: false }, "hs-2"), "unknown");
});

test("host env: tmux by default, desktop only with a valid socket and session id, otherwise invalid", () => {
  assert.deepEqual(resolveHostEnv({}), { kind: "tmux" });
  assert.deepEqual(resolveHostEnv({ RG_HOST: "tmux" }), { kind: "tmux" });
  assert.deepEqual(
    resolveHostEnv({ RG_HOST: "desktop", RG_HOST_SOCKET: "/tmp/pd.sock", RG_HOST_SESSION: "hs-1" }),
    { kind: "desktop", socketPath: "/tmp/pd.sock", hostSessionId: "hs-1" },
  );
  for (const env of [
    { RG_HOST: "wayland" },
    { RG_HOST: "desktop", RG_HOST_SESSION: "hs-1" },
    { RG_HOST: "desktop", RG_HOST_SOCKET: "rel.sock", RG_HOST_SESSION: "hs-1" },
    { RG_HOST: "desktop", RG_HOST_SOCKET: `/${"x".repeat(200)}`, RG_HOST_SESSION: "hs-1" },
    { RG_HOST: "desktop", RG_HOST_SOCKET: "/tmp/pd.sock" },
  ]) {
    assert.equal(resolveHostEnv(env).kind, "invalid", JSON.stringify(env));
  }
});

test("only dialog.open waits without a timeout", () => {
  for (const method of METHOD_NAMES) {
    assert.equal(requestTimeoutMs(method) === undefined, method === "dialog.open", method);
  }
});

test("the committed JSON Schema is exactly the one derived from METHODS", () => {
  const committed = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  assert.deepEqual(
    committed,
    buildJsonSchema(),
    "desktop/protocol/host-protocol.schema.json drifted — regenerate it from buildJsonSchema() (see docs/desktop/host-protocol.md §Schema)",
  );
  const defs = committed.$defs as Record<string, unknown>;
  for (const method of Object.keys(METHODS)) {
    assert.ok(defs[`${method}.params`] && defs[`${method}.result`], method);
  }
});
