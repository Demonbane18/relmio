import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { request, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { test as nodeTest } from "node:test";

import { startClaudeChatGateway } from "../src/gateway/claude-chat.js";
import {
  answer, canary, chatRequest, completionRequest, createFixtureRuntime, credential, model, parseEvents,
  syntheticSpawner, verifier,
} from "./fixtures/claude-child.mjs";

const test = (name, run) => nodeTest(name, {
  timeout: 15000,
  skip: process.platform === "win32" ? "Claude gateway requires Unix process groups" : false,
}, run);
const failed = (code) => ({ status: "failed", resolvedModel: null, error: { code } });

async function setup(t, scenario = "success", overrides = {}) {
  const fixture = await createFixtureRuntime();
  const synthetic = syntheticSpawner(fixture.runtime, scenario);
  let gateway;
  t.after(async () => {
    try { if (gateway) await gateway.close(); }
    finally {
      for (const child of synthetic.children) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
          await closed;
        }
      }
      await fixture.dispose();
    }
  });
  gateway = await startClaudeChatGateway({
    runtime: fixture.runtime, tokenVerifier: verifier, port: 0,
    turnTimeoutMs: 5000, terminationGraceMs: 30,
    spawnProcess: synthetic.spawnProcess,
    ...overrides,
  });
  return { ...fixture, ...synthetic, gateway };
}

function assertFailure(response, code, status) {
  if (status !== undefined) assert.equal(response.status, status);
  assert.deepEqual(JSON.parse(response.text), failed(code));
  assert.equal(response.text.includes(canary), false);
}

function assertCompletionFailure(response, code, status, param = null) {
  assert.equal(response.status, status);
  const body = JSON.parse(response.text);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "param", "type"]);
  assert.equal(body.error.code, code);
  assert.equal(body.error.param, param);
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.error.message.length > 0);
  assert.equal(typeof body.error.type, "string");
  assert.equal(response.text.includes(canary), false);
  return body.error;
}

function assertGone(child) {
  assert.notEqual(child.exitCode ?? child.signalCode, null);
  assert.throws(() => process.kill(-child.pid, 0), { code: "ESRCH" });
}

test("JSON completion decodes byte-split UTF-8 and distinct blocks without repeating snapshots or result", async (t) => {
  const { gateway, children } = await setup(t, "utf8");
  const response = await chatRequest(gateway.origin);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(body.status, "completed");
  assert.equal(body.text, answer);
  assert.equal(body.resolvedModel, model);
  assert.equal(body.quota, null);
  assert.equal(body.usage.input_tokens, 7);
  assert.equal(body.usage.output_tokens, 4);
  assertGone(children[0]);
});

test("SSE has ordered text deltas and one terminal without final-text duplication", async (t) => {
  const { gateway } = await setup(t, "utf8");
  const response = await chatRequest(gateway.origin, { headers: { Accept: "text/event-stream" } });
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/u);
  const events = parseEvents(response.text);
  assert.deepEqual(events.map((event) => event.event), ["delta", "delta", "completed"]);
  assert.equal(events.slice(0, -1).map((event) => event.data.text).join(""), answer);
  assert.equal(events.at(-1).data.status, "completed");
  assert.equal(events.at(-1).data.resolvedModel, model);
  assert.equal(events.at(-1).data.quota, null);
  assert.equal(Object.hasOwn(events.at(-1).data, "text"), false);
  assert.equal(response.text.includes("[DONE]"), false);
});

for (const scenario of ["thinking", "redacted-thinking", "quota-warning", "snapshot-only", "agent-metadata", "ui-render",
  "ui-render-unknown", "command-lifecycle", "builtin-plugins"]) {
  test(`${scenario} preserves completed text without duplicate or private content`, async (t) => {
    const { gateway } = await setup(t, scenario);
    const response = await chatRequest(gateway.origin);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).text, answer);
    assert.equal(response.text.includes(canary), false);
  });
}

for (const scenario of ["invalid-thinking-progress", "wrong-thinking-session"]) {
  test(`${scenario} cannot bypass native progress validation`, async (t) => {
    const { gateway } = await setup(t, scenario);
    assertFailure(await chatRequest(gateway.origin), "invalid_upstream", 502);
  });
}

for (const reason of ["org_config_refused", "org_pin_mismatch", "gateway_signin_required", "gateway_access_denied", "org_verify_failed", "config_error"]) {
  test(`pre-init startup refusal ${reason} has safe authentication-specific classification`, async (t) => {
    const { gateway, launches } = await setup(t, `startup:${reason}`);
    const login = !["org_verify_failed", "config_error"].includes(reason);
    assertFailure(await chatRequest(gateway.origin), login ? "login_required" : "upstream_failed", login ? 401 : 502);
    assert.equal(launches.length, 1);
  });
}

const rejectedResults = [
  "missing-terminal", "is-error", "max-turns", "zero-turns", "aborted", "deferred", "local-command",
  "permission-denied", "eof", "nonzero", "text-mismatch", "missing-block-stop", "trailing-record", "snapshot-mismatch", "missing-snapshot",
  ...["max_turns", "tool_deferred", "aborted_streaming", "aborted_tools", "hook_stopped", "stop_hook_prevented", "background_requested", "blocking_limit", "budget_exhausted", "api_error"].map((reason) => `terminal:${reason}`),
  ...["max_tokens", "model_context_window_exceeded", "tool_use", "pause_turn", "refusal", "stop_sequence", "unknown"].map((reason) => `stop:${reason}`),
];
for (const scenario of rejectedResults) {
  test(`${scenario} cannot produce completed JSON after provisional output`, async (t) => {
    const { gateway, children, launches } = await setup(t, scenario);
    const response = await chatRequest(gateway.origin);
    assert.notEqual(response.status, 200);
    const body = JSON.parse(response.text);
    assert.equal(body.status, "failed");
    assert.equal(body.resolvedModel, null);
    assert.equal(Object.hasOwn(body, "text"), false);
    assert.equal(typeof body.error.code, "string");
    assert.equal(launches.length, 1, "native failure must not cause adapter retry");
    assertGone(children[0]);
  });
}

for (const [scenario, code, status] of [
  ["api:401", "login_required", 401], ["api:403", "login_required", 401], ["api:429", "provider_quota", 429],
  ["assistant-error:authentication_failed", "login_required", 401],
  ["assistant-error:oauth_org_not_allowed", "login_required", 401],
  ["assistant-error:account_on_hold", "login_required", 401],
  ["assistant-error:cloud_credential_error", "login_required", 401],
  ["assistant-error:rate_limit", "provider_quota", 429],
  ["assistant-error:billing_error", "billing_required", 502],
  ["assistant-error:model_not_found", "model_unavailable", 502],
  ["assistant-error:server_error", "upstream_failed", 502],
  ["quota-rejected", "provider_quota", 429], ["credits-required", "provider_quota", 429],
]) {
  test(`${scenario} returns safe ${code} without output, retry or fallback`, async (t) => {
    const { gateway, launches } = await setup(t, scenario);
    assertFailure(await chatRequest(gateway.origin), code, status);
    assert.equal(launches.length, 1);
  });
}

for (const scenario of ["tool_use", "server_tool_use", "tool_result", "input_json_delta", "snapshot", "control_request"]) {
  test(`${scenario} is rejected before tool content reaches caller`, async (t) => {
    const { gateway, children } = await setup(t, `tool:${scenario}`);
    assertFailure(await chatRequest(gateway.origin), "unexpected_tools", 502);
    assertGone(children[0]);
  });
}

for (const field of ["model", "cwd", "claude_code_version", "apiKeySource", "fast_mode_state", "tools", "mcp_servers", "plugins", "skills"]) {
  test(`native init ${field} cannot override qualified runtime`, async (t) => {
    const { gateway } = await setup(t, `init:${field}`);
    const response = await chatRequest(gateway.origin);
    assert.equal(response.status, 502);
    const body = JSON.parse(response.text);
    assert.equal(body.status, "failed");
    assert.equal(body.resolvedModel, null);
    assert.ok(["runtime_mismatch", "unexpected_tools"].includes(body.error.code));
    assert.equal(Object.hasOwn(body, "text"), false);
  });
}

for (const scenario of ["invalid-json", "truncated-json", "invalid-utf8", "truncated-utf8", "oversized-line", "wrong-session", "wrong-request", "model-substitution"]) {
  test(`${scenario} fails closed at native protocol boundary`, async (t) => {
    const { gateway } = await setup(t, scenario);
    const response = await chatRequest(gateway.origin);
    assert.equal(response.status, 502);
    const body = JSON.parse(response.text);
    assert.equal(body.status, "failed");
    assert.equal(body.resolvedModel, null);
    assert.ok(["invalid_upstream", "runtime_mismatch"].includes(body.error.code));
  });
}

test("SSE late nonzero exit emits one safe error after provisional deltas", async (t) => {
  const { gateway } = await setup(t, "nonzero");
  const response = await chatRequest(gateway.origin, { headers: { Accept: "text/event-stream" } });
  const events = parseEvents(response.text);
  assert.equal(events.filter((event) => event.event === "delta").map((event) => event.data.text).join(""), answer);
  assert.equal(events.filter((event) => ["completed", "error"].includes(event.event)).length, 1);
  assert.equal(events.at(-1).event, "error");
  assert.equal(events.at(-1).data.status, "failed");
  assert.equal(events.at(-1).data.resolvedModel, null);
});

test("non-token, negative and fractional usage is unavailable rather than invented quota", async (t) => {
  const { gateway } = await setup(t, "invalid-usage");
  const response = await chatRequest(gateway.origin);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).usage, null);
  assert.equal(JSON.parse(response.text).quota, null);
});

for (const scenario of ["output-flood", "stdout-flood", "stderr-flood"]) {
  test(`${scenario} is bounded and cannot report completion`, async (t) => {
    const { gateway } = await setup(t, scenario);
    assertFailure(await chatRequest(gateway.origin), "invalid_upstream", 502);
  });
}

const SIGNALS = ["user", "tool_progress", "tool_use_summary", "permission_denied", "hook", "task", "background", "plugin",
  "local_command_subtype", "files_persisted", "memory_recall", "agent_id", "tool_use_result", "deferred_tool_use",
  "local_command", "auth_status_output", "second_command"];
for (const scenario of ["agent-execution", "parent-tool", "unknown-tool-signal", "builtin-plus-installed", "builtin-duplicate",
  ...SIGNALS.map((name) => `signal:${name}`), "late-signal:hook", "late-signal:second_command"]) {
  test(`${scenario} is rejected as unexpected native tool activity`, async (t) => {
    const { gateway } = await setup(t, scenario);
    assertFailure(await chatRequest(gateway.origin), "unexpected_tools", 502);
  });
}

test("stderr and native metadata never enter JSON, SSE, diagnostic logs or argv", async (t) => {
  const logs = [];
  for (const name of ["log", "warn", "error"]) t.mock.method(console, name, (...args) => logs.push(args.join(" ")));
  const { gateway, launches } = await setup(t, "canary");
  for (const headers of [{}, { Accept: "text/event-stream" }]) {
    const response = await chatRequest(gateway.origin, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.text.includes(canary), false);
    assert.equal(response.text.includes("123.45"), false, "cost estimates must not become quota");
    assert.equal(response.text.includes("metadata"), false);
  }
  const errorFixture = await setup(t, "assistant-error:authentication_failed");
  const errorStream = await chatRequest(errorFixture.gateway.origin, { headers: { Accept: "text/event-stream" } });
  assert.equal(errorStream.text.includes(canary), false);
  assert.deepEqual(parseEvents(errorStream.text), [{ event: "error", data: failed("login_required") }]);
  assert.equal(logs.join("\n").includes(canary), false);
  assert.equal(JSON.stringify(launches.map((launch) => launch.args)).includes(canary), false);
});

test("launch prevents command expansion, inherited credentials and caller-controlled runtime", async (t) => {
  const { gateway, runtime, launches } = await setup(t);
  const input = "/usage @/private/file $(touch /not-real); `whoami`\nsecond line";
  const first = await chatRequest(gateway.origin, { body: JSON.stringify({ input, model }) });
  assert.equal(first.status, 200);
  assert.equal((await chatRequest(gateway.origin)).status, 200);
  const uuids = [];
  for (const launch of launches) {
    assert.equal(launch.executable, runtime.executable);
    assert.equal(launch.options.shell, false);
    assert.equal(launch.options.detached, true);
    assert.equal(launch.options.cwd, runtime.cwd);
    assert.deepEqual(launch.options.stdio, ["pipe", "pipe", "pipe"]);
    assert.equal(launch.options.env.HOME, runtime.home);
    assert.equal(launch.options.env.CLAUDE_CONFIG_DIR, runtime.configDir);
    for (const key of Object.keys(launch.options.env)) {
      assert.ok(["HOME", "USER", "LOGNAME", "CLAUDE_CONFIG_DIR", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "CLAUDE_CODE_DISABLE_FAST_MODE", "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL", "CLAUDE_CODE_AUTO_CONNECT_IDE", "CLAUDE_CODE_STARTUP_FAILURE_RESULTS", "DISABLE_AUTOUPDATER"].includes(key), `unexpected inherited environment ${key}`);
    }
    for (const flag of ["--safe-mode", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(launch.args.includes(flag));
    for (const [flag, expected] of [["--tools", ""], ["--disallowedTools", "*"], ["--mcp-config", '{"mcpServers":{}}'], ["--max-turns", "1"], ["--model", model]]) {
      assert.equal(launch.args[launch.args.indexOf(flag) + 1], expected);
    }
    for (const forbidden of ["--bare", "--fallback-model", "--resume", "--continue"]) assert.equal(launch.args.includes(forbidden), false);
    assert.equal(launch.args.includes(input), false);
    const frames = launch.input.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].client_composed, true);
    assert.equal(frames[0].parent_tool_use_id, null);
    assert.equal(frames[0].message.role, "user");
    uuids.push(frames[0].uuid);
  }
  assert.equal(JSON.parse(launches[0].input).message.content, input);
  assert.notEqual(uuids[0], uuids[1]);
});

test("invalid local requests are rejected before any native process starts", async (t) => {
  const { gateway, launches } = await setup(t);
  const invalidBodies = [
    {}, { input: "" }, { input: "   " }, { input: 4 }, { input: "x\u0000y" }, { input: "\ud800" },
    { input: "\udc00" }, { input: "x", model: "sonnet" }, { input: "x", model: "claude-other-5" },
    { input: "x", tools: [] }, { input: "x", history: [] }, { input: "x", stream: true },
    { input: "x", cwd: "/tmp" }, { input: "x", env: {} }, { input: "x", upstream: "https://invalid.test" },
    null, [], "prompt", { input: "π".repeat(7000) },
  ];
  for (const body of invalidBodies) {
    const response = await chatRequest(gateway.origin, { body: JSON.stringify(body) });
    assert.ok([400, 413].includes(response.status), JSON.stringify(body)?.slice(0, 80));
    assertFailure(response, "invalid_request");
  }
  for (const body of ["{bad}", "{", "x".repeat(20 * 1024)]) {
    const response = await chatRequest(gateway.origin, { body });
    assert.ok([400, 413].includes(response.status));
  }
  const invalidUtf8 = await chatRequest(gateway.origin, { body: Buffer.from([0x7b, 0xc3, 0x28, 0x7d]) });
  assertFailure(invalidUtf8, "invalid_request", 400);
  assert.equal((await chatRequest(gateway.origin, { headers: { "X-Synthetic-Large": "x".repeat(20 * 1024) } })).status, 431);
  const excessHeaders = Object.fromEntries(Array.from({ length: 35 }, (_, index) => [`X-Synthetic-${index}`, "x"]));
  assertFailure(await chatRequest(gateway.origin, { headers: excessHeaders }), "invalid_request", 400);
  for (const headers of [
    { Authorization: "" }, { Authorization: "Bearer short" }, { Authorization: `Bearer ${"z".repeat(257)}` },
    { Authorization: `Bearer ${"z".repeat(40)}` }, { Authorization: `Basic ${credential}` },
    { Host: "localhost:14502" }, { Host: "evil.test" }, { Origin: "http://127.0.0.1" },
    { "Content-Type": "text/plain" },
  ]) {
    const response = await chatRequest(gateway.origin, { headers });
    assert.ok([400, 401, 403, 415].includes(response.status));
  }
  for (const options of [{ method: "GET" }, { method: "PUT" }, { path: "/chat?x=1" }, { path: "/v1/chat/completions" }, { path: "/v1/models" }]) {
    assert.notEqual((await chatRequest(gateway.origin, options)).status, 200);
  }
  assert.equal(launches.length, 0);
});

test("duplicate Authorization, Host, Content-Type and Accept headers cannot bypass admission", async (t) => {
  const { gateway, launches } = await setup(t);
  const url = new URL(gateway.origin);
  for (const name of ["Authorization", "Host", "Content-Type", "Accept"]) {
    const values = { Authorization: `Bearer ${credential}`, Host: url.host, "Content-Type": "application/json", Accept: "text/event-stream" };
    const headers = Object.entries(values).flat();
    headers.push(name, values[name]);
    const status = await new Promise((resolve, reject) => {
      const pending = request(new URL("/chat", url), { method: "POST", headers, agent: false }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      pending.once("error", reject);
      pending.end(JSON.stringify({ input: "Synthetic" }));
    });
    assert.ok([400, 401, 403].includes(status), name);
  }
  assert.equal(launches.length, 0);
});

test("default mode accepts only the exact loopback Host", async (t) => {
  const { gateway } = await setup(t);
  const { port } = new URL(gateway.origin);
  assert.equal(gateway.origin, `http://127.0.0.1:${port}`);
  assert.equal((await chatRequest(gateway.origin, { method: "GET", path: "/health" })).status, 200);
  for (const host of [`relmio-claude:${port}`, `localhost:${port}`, "127.0.0.1"]) {
    assert.equal((await chatRequest(gateway.origin, { method: "GET", path: "/health", headers: { Host: host } })).status, 403, host);
  }
});

test("companion mode accepts only its own hostname and keeps bearer and no-Origin on every route", async (t) => {
  const { gateway, launches } = await setup(t, "success", { companionHost: "relmio-claude" });
  const { port } = new URL(gateway.origin);
  assert.equal(gateway.origin, `http://relmio-claude:${port}`);
  const local = `http://127.0.0.1:${port}`;
  const companion = { Host: `relmio-claude:${port}` };
  for (const path of ["/health", "/v1/models"]) {
    assert.equal((await chatRequest(local, { method: "GET", path, headers: companion })).status, 200, path);
    for (const host of [
      `127.0.0.1:${port}`, `localhost:${port}`, `relmio-claude:${port + 1}`, "relmio-claude",
      `relmio-claude.internal:${port}`, `n8n-claude:${port}`,
    ]) {
      assert.equal((await chatRequest(local, { method: "GET", path, headers: { Host: host } })).status, 403, `${path} ${host}`);
    }
    assert.equal((await chatRequest(local, { method: "GET", path, headers: { ...companion, Authorization: "" } })).status, 401, path);
    assert.equal((await chatRequest(local, { method: "GET", path, headers: { ...companion, Authorization: `Bearer ${"z".repeat(40)}` } })).status, 401, path);
    assert.equal((await chatRequest(local, { method: "GET", path, headers: { ...companion, Origin: "http://relmio-claude" } })).status, 403, path);
  }
  assert.equal((await chatRequest(local, { headers: { Host: `127.0.0.1:${port}` } })).status, 403);
  assert.equal(launches.length, 0);
  assert.equal((await chatRequest(local, { headers: companion })).status, 200);
  assert.equal(launches.length, 1);
});

test("companion mode listens on all interfaces while default mode stays loopback-only", async (t) => {
  const external = Object.values(networkInterfaces()).flat()
    .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
  if (external === undefined) { t.skip("no non-loopback IPv4 address"); return; }
  const companion = await setup(t, "success", { companionHost: "relmio-claude" });
  const companionPort = new URL(companion.gateway.origin).port;
  const reached = await chatRequest(`http://${external}:${companionPort}`, {
    method: "GET", path: "/health", headers: { Host: `relmio-claude:${companionPort}` },
  });
  assert.equal(reached.status, 200);
  const local = await setup(t);
  const localPort = new URL(local.gateway.origin).port;
  await assert.rejects(chatRequest(`http://${external}:${localPort}`, {
    method: "GET", path: "/health", headers: { Host: `127.0.0.1:${localPort}` },
  }), { code: "ECONNREFUSED" });
});

test("gateway rejects an invalid companion host instead of binding or accepting it", async () => {
  const fixture = await createFixtureRuntime();
  try {
    for (const companionHost of [
      "", "0.0.0.0", "127.0.0.1", "::", "Relmio", "1relmio", "relmio_claude", "relmio.claude", "relmio claude",
      "relmio-claude:14502", "relmio-claude\n", "a".repeat(64), null, 0, true, ["relmio-claude"], {},
    ]) {
      await assert.rejects(startClaudeChatGateway({
        runtime: fixture.runtime, tokenVerifier: verifier, port: 0, companionHost,
      }), TypeError, JSON.stringify(companionHost));
    }
  } finally {
    await fixture.dispose();
  }
});

test("early authentication rejection delivers complete JSON while request body remains unfinished", async (t) => {
  const { gateway, launches } = await setup(t);
  let pending;
  t.after(() => pending?.destroy());
  const response = await new Promise((resolve, reject) => {
    pending = request(new URL("/chat", gateway.origin), {
      method: "POST", agent: false,
      headers: { "Content-Type": "application/json", "Content-Length": "100" },
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.once("error", reject);
      incoming.once("end", () => resolve({
        status: incoming.statusCode,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    pending.once("error", reject);
    pending.write('{"input":"');
    // Withhold remaining entity until authentication response arrives.
  });
  assertFailure(response, "unauthorized", 401);
  assert.equal(launches.length, 0);
});

test("health never probes native readiness and requires local authentication", async (t) => {
  const { gateway, launches } = await setup(t);
  for (const body of [undefined, "Synthetic framed GET entity"]) {
    const response = await chatRequest(gateway.origin, { method: "GET", path: "/health", body });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).providerReadiness, "not-probed");
  }
  assert.equal((await chatRequest(gateway.origin, { method: "GET", path: "/health", headers: { Authorization: "" } })).status, 401);
  assert.equal(launches.length, 0);
});

test("slow admitted request body times out before spawn and releases single-flight slot", async (t) => {
  const { gateway, launches } = await setup(t, "success", { bodyTimeoutMs: 30 });
  const status = await new Promise((resolve, reject) => {
    const pending = request(new URL("/chat", gateway.origin), {
      method: "POST", agent: false,
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", "Content-Length": "100" },
    }, (response) => {
      response.resume();
      response.once("end", () => { pending.destroy(); resolve(response.statusCode); });
    });
    pending.once("error", (error) => { if (error.code !== "ECONNRESET") reject(error); });
    pending.write('{"input":"');
  });
  assert.equal(status, 408);
  assert.equal(launches.length, 0);
  assert.equal((await chatRequest(gateway.origin)).status, 200);
});

function fakeChild({ closeOnKill = true, groupGoneOnKill = true } = {}) {
  const child = new EventEmitter();
  child.pid = 987654321;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const signals = [];
  let groupExists = true;
  let closed = false;
  let interrupted;
  const firstInterrupt = new Promise((resolve) => { interrupted = resolve; });
  function release() {
    groupExists = false;
    if (!closed) {
      closed = true;
      child.signalCode = "SIGKILL";
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, "SIGKILL");
    }
  }
  function killProcess(pid, signal) {
    assert.equal(pid, -child.pid, "signal only owned detached process group");
    if (signal === 0) {
      if (!groupExists) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    }
    signals.push(signal);
    if (signal === "SIGINT") interrupted();
    if (signal === "SIGKILL") {
      if (groupGoneOnKill) groupExists = false;
      if (closeOnKill && !closed) {
        closed = true;
        child.signalCode = signal;
        queueMicrotask(() => child.emit("close", null, signal));
      }
    }
    return true;
  }
  return { child, signals, killProcess, firstInterrupt, release };
}

test("busy remains held during actual process-group reap, then permits next job", async (t) => {
  const fake = fakeChild();
  fake.child.stdin.once("finish", () => fake.child.emit("error", new Error(canary)));
  let calls = 0;
  const fixture = await createFixtureRuntime();
  const synthetic = syntheticSpawner(fixture.runtime);
  const gateway = await startClaudeChatGateway({
    runtime: fixture.runtime, tokenVerifier: verifier, port: 0, turnTimeoutMs: 5000, terminationGraceMs: 500,
    spawnProcess(...args) { calls += 1; return calls === 1 ? fake.child : synthetic.spawnProcess(...args); },
    killProcess(pid, signal) { return pid === -fake.child.pid ? fake.killProcess(pid, signal) : process.kill(pid, signal); },
  });
  t.after(async () => { fake.release(); try { await gateway.close(); } finally { await fixture.dispose(); } });
  const first = chatRequest(gateway.origin);
  await fake.firstInterrupt;
  assertFailure(await chatRequest(gateway.origin), "busy", 409);
  assert.equal(calls, 1);
  fake.release();
  assertFailure(await first, "upstream_failed", 502);
  assert.equal((await chatRequest(gateway.origin)).status, 200);
  assert.equal(calls, 2);
});

for (const options of [{ closeOnKill: true, groupGoneOnKill: false }, { closeOnKill: false, groupGoneOnKill: true }]) {
  test(`unconfirmed cleanup (${JSON.stringify(options)}) poisons admission and rejects shutdown`, async (t) => {
    const fake = fakeChild(options);
    let calls = 0;
    const fixture = await createFixtureRuntime();
    const gateway = await startClaudeChatGateway({
      runtime: fixture.runtime, tokenVerifier: verifier, port: 0, turnTimeoutMs: 10, terminationGraceMs: 10,
      spawnProcess() { calls += 1; return fake.child; }, killProcess: fake.killProcess,
    });
    t.after(async () => { fake.release(); await gateway.close().catch(() => {}); await fixture.dispose(); });
    assertFailure(await chatRequest(gateway.origin), "cleanup_failed", 503);
    assertFailure(await chatRequest(gateway.origin), "busy", 409);
    assert.equal(calls, 1);
    assert.deepEqual(fake.signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
    await assert.rejects(gateway.close(), /cleanup/i);
  });
}

for (const scenario of ["stall", "midstream", "descendant"]) {
  test(`client disconnect ${scenario} cancels and reaps owned process tree`, async (t) => {
    const signals = [];
    const { gateway, firstReady, children } = await setup(t, scenario, {
      terminationGraceMs: 300,
      killProcess(pid, signal) { if (signal !== 0) signals.push([pid, signal]); return process.kill(pid, signal); },
    });
    const pending = request(new URL("/chat", gateway.origin), {
      method: "POST", agent: false,
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", Accept: "text/event-stream" },
    });
    pending.on("error", () => {});
    let delta;
    const firstDelta = new Promise((resolve) => { delta = resolve; });
    pending.on("response", (response) => {
      response.on("error", () => {});
      response.on("data", () => delta());
    });
    pending.end(JSON.stringify({ input: "Synthetic cancellation" }));
    const child = await firstReady;
    const closed = once(child, "close");
    if (scenario === "midstream") await firstDelta;
    pending.destroy();
    await closed;
    assertGone(children[0]);
    if (scenario === "descendant") {
      assert.ok(Number.isSafeInteger(child.descendantPid));
      assert.throws(() => process.kill(child.descendantPid, 0), { code: "ESRCH" });
    }
    assert.equal(signals[0][1], "SIGINT");
    assert.ok(signals.every(([pid]) => pid === -child.pid));
  });
}

test("deadline escalates SIGINT-ignoring and SIGTERM-ignoring real Node child to SIGKILL", async (t) => {
  const signals = [];
  const { gateway, children } = await setup(t, "ignore-signals", {
    turnTimeoutMs: 2000, terminationGraceMs: 30,
    killProcess(pid, signal) { if (signal !== 0) signals.push([pid, signal]); return process.kill(pid, signal); },
  });
  assertFailure(await chatRequest(gateway.origin), "timeout", 504);
  assert.deepEqual(signals.map(([, signal]) => signal), ["SIGINT", "SIGTERM", "SIGKILL"]);
  assert.ok(signals.every(([pid]) => pid === -children[0].pid));
  assertGone(children[0]);
});

test("shutdown aborts active turn and waits for real child process-group disappearance", async (t) => {
  const { gateway, firstReady, children } = await setup(t, "ignore-signals");
  const pending = chatRequest(gateway.origin).catch(() => null);
  await firstReady;
  await gateway.close();
  await pending;
  assertGone(children[0]);
});

for (const mode of ["drain", "stalled", "disconnect"]) {
  test(`SSE ${mode} backpressure pauses parser and bounds cancellation`, async (t) => {
    const original = ServerResponse.prototype.write;
    let blocked;
    let release;
    let blockCount = 0;
    const firstBlocked = new Promise((resolve) => { blocked = resolve; });
    // node:test isolates this file; tests here are serial. Restore even on failure.
    t.mock.method(ServerResponse.prototype, "write", function (chunk, ...rest) {
      const result = original.call(this, chunk, ...rest);
      if (String(chunk).startsWith("event: delta") && blockCount++ === 0) {
        release = () => this.emit("drain");
        blocked();
        return false;
      }
      return result;
    });
    const { gateway, children } = await setup(t, "success", { backpressureTimeoutMs: 50 });
    const controller = new AbortController();
    const response = fetch(`${gateway.origin}/chat`, {
      method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ input: "Synthetic backpressure" }), signal: controller.signal,
    });
    await firstBlocked;
    assert.equal(blockCount, 1, "parser must not write another delta before drain");
    if (mode === "drain") release();
    if (mode === "disconnect") controller.abort();
    let text = "";
    try { text = await (await response).text(); }
    catch (error) { assert.ok(mode !== "drain", error.message); }
    if (mode === "drain") {
      const events = parseEvents(text);
      assert.equal(events.at(-1).event, "completed");
      assert.equal(events.filter((event) => event.event === "delta").map((event) => event.data.text).join(""), answer);
    } else {
      assert.equal(text.includes("event: completed"), false);
    }
    await gateway.close();
    assertGone(children[0]);
  });
}

test("input limit counts UTF-8 bytes, including exact boundary", async (t) => {
  const { gateway, launches } = await setup(t);
  const exact = "π".repeat(6 * 1024);
  assert.equal((await chatRequest(gateway.origin, { body: JSON.stringify({ input: exact }) })).status, 200);
  assertFailure(await chatRequest(gateway.origin, { body: JSON.stringify({ input: `${exact}x` }) }), "invalid_request", 413);
  assert.equal(launches.length, 1);
});

test("operator configuration rejects unsafe paths, unqualified pins and invalid bounds before spawn", async (t) => {
  const fixture = await createFixtureRuntime();
  t.after(fixture.dispose);
  let spawns = 0;
  const base = { runtime: fixture.runtime, tokenVerifier: verifier, port: 0, spawnProcess() { spawns += 1; throw new Error("must not spawn"); } };
  for (const patch of [
    { runtime: { ...fixture.runtime, executable: "claude" } },
    { runtime: { ...fixture.runtime, cwd: "/" } },
    { runtime: { ...fixture.runtime, home: "/tmp/../private" } },
    { runtime: { ...fixture.runtime, configDir: "/tmp/\u0000bad" } },
    { runtime: { ...fixture.runtime, version: "2.1.316" } },
    ...[
      [], Array.from({ length: 9 }, (_, index) => `claude-model-${index}`), [model, model],
      [model, "claude-fable-5-5"], ["claude-sonnet-fable-5"], ["claude-unfabled-5"],
      "claude-sonnet-5-5", null, [null], [4], ["sonnet"], ["claude-sonnet-5-5;id"],
      [`claude-${"a".repeat(122)}`], Array(1),
    ].map((models) => ({ runtime: { ...fixture.runtime, models } })),
    { runtime: { ...fixture.runtime, model } },
    { runtime: { ...fixture.runtime, extra: true } },
    { tokenVerifier: Buffer.alloc(31) }, { tokenVerifier: "a".repeat(64) },
    { port: -1 }, { port: 65536 }, { turnTimeoutMs: 0 }, { turnTimeoutMs: Infinity },
    { terminationGraceMs: -1 }, { bodyTimeoutMs: 0 }, { backpressureTimeoutMs: NaN },
  ]) {
    await assert.rejects(startClaudeChatGateway({ ...base, ...patch }), TypeError);
  }
  assert.equal(spawns, 0);
});

test("runtime accepts one through eight approved models and ids at the length limit", async (t) => {
  const fixture = await createFixtureRuntime();
  t.after(fixture.dispose);
  for (const models of [
    [model],
    [`claude-${"a".repeat(121)}`, ...Array.from({ length: 7 }, (_, index) => `claude-model-${index}`)],
  ]) {
    const synthetic = syntheticSpawner(fixture.runtime);
    const gateway = await startClaudeChatGateway({
      runtime: { ...fixture.runtime, models }, tokenVerifier: verifier, port: 0,
      turnTimeoutMs: 5000, terminationGraceMs: 30, spawnProcess: synthetic.spawnProcess,
    });
    t.after(gateway.close);
    const listed = await chatRequest(gateway.origin, { method: "GET", path: "/v1/models" });
    assert.equal(listed.status, 200);
    assert.deepEqual(JSON.parse(listed.text).data.map((entry) => entry.id), models);
    const first = await chatRequest(gateway.origin);
    assert.equal(first.status, 200);
    assert.equal(JSON.parse(first.text).resolvedModel, models[0]);
    const last = await completionRequest(gateway.origin, {
      model: models.at(-1), messages: [{ role: "user", content: "Synthetic model boundary" }],
    });
    assert.equal(last.status, 200);
    assert.equal(JSON.parse(last.text).model, models.at(-1));
    await gateway.close();
  }
});

for (const mode of ["json-success", "json-error", "sse-completed", "sse-error", "admission"]) {
  test(`${mode} final small write cannot hold socket or admission forever when finish stalls`, async (t) => {
    const originalEnd = ServerResponse.prototype.end;
    const originalWrite = ServerResponse.prototype.write;
    const writes = new Map();
    let bufferedResponse;
    let held;
    let markHeld;
    let closed;
    const endHeld = new Promise((resolve) => { markHeld = resolve; });
    t.mock.method(ServerResponse.prototype, "write", function (chunk, ...rest) {
      if (!bufferedResponse) bufferedResponse = this;
      const final = !String(chunk).startsWith("event: delta");
      // Model a small final frame accepted into a stalled buffer: no drain or finish.
      const writable = this === bufferedResponse && final ? true : originalWrite.call(this, chunk, ...rest);
      if (!writes.has(this)) writes.set(this, []);
      writes.get(this).push(writable);
      return writable;
    });
    t.mock.method(ServerResponse.prototype, "end", function (...args) {
      if (!held) {
        held = this;
        closed = once(this, "close");
        markHeld();
        return this;
      }
      return originalEnd.apply(this, args);
    });
    const scenario = mode.endsWith("error") ? "assistant-error:authentication_failed" : "success";
    const { gateway, launches, children } = await setup(t, scenario, { backpressureTimeoutMs: 500 });
    let pending;
    t.after(() => pending?.destroy());
    const clientDone = new Promise((resolve) => {
      pending = request(new URL("/chat", gateway.origin), {
        method: "POST", agent: false,
        headers: {
          Authorization: mode === "admission" ? "Bearer invalid" : `Bearer ${credential}`,
          "Content-Type": "application/json",
          ...(mode.startsWith("sse-") ? { Accept: "text/event-stream" } : {}),
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve("end"));
        response.once("aborted", () => resolve("aborted"));
        response.once("error", () => resolve("error"));
      });
      pending.once("error", () => resolve("error"));
      pending.end(JSON.stringify({ input: "Synthetic final flush" }));
    });
    await endHeld;
    assert.ok(writes.get(held)?.length > 0);
    assert.ok(writes.get(held).every((writable) => writable === true), "small writes stay below high-water mark");
    assert.equal(held.destroyed, false);
    assert.equal(held.writableFinished, false);
    if (mode !== "admission") assertFailure(await chatRequest(gateway.origin), "busy", 409);
    await closed;
    assert.equal(held.destroyed, true);
    assert.equal(held.writableFinished, false);
    assert.notEqual(await clientDone, "end", "unfinished response must be bounded by socket destruction");
    if (mode === "admission") {
      assert.equal(launches.length, 0);
      assert.equal((await chatRequest(gateway.origin)).status, 200);
    } else {
      assert.equal(launches.length, 1);
      assertGone(children[0]);
      const next = await chatRequest(gateway.origin);
      assert.equal(next.status, mode.endsWith("error") ? 401 : 200);
      assert.equal(launches.length, 2, "final-flush timeout must release admission after confirmed reap");
      for (const child of children) assertGone(child);
    }
  });
}

test("OpenAI models lists all approved models in order without probing native Claude", async (t) => {
  const { gateway, runtime, launches } = await setup(t);
  const response = await chatRequest(gateway.origin, { method: "GET", path: "/v1/models" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    object: "list", data: runtime.models.map((id) => ({ id, object: "model", created: 0, owned_by: "anthropic" })),
  });
  assert.equal(launches.length, 0);
});

test("prompt requests select approved models and default to the first after a different selection", async (t) => {
  const { gateway, runtime, launches } = await setup(t);
  for (const selected of [runtime.models[1], undefined, runtime.models[0]]) {
    const response = await chatRequest(gateway.origin, {
      body: JSON.stringify({ input: "Synthetic model selection", ...(selected === undefined ? {} : { model: selected }) }),
    });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).resolvedModel, selected ?? runtime.models[0]);
    const args = launches.at(-1).args;
    assert.equal(args[args.indexOf("--model") + 1], selected ?? runtime.models[0]);
  }
  const response = await chatRequest(gateway.origin, {
    body: JSON.stringify({ input: "Synthetic streamed model selection", model: runtime.models[1] }),
    headers: { Accept: "text/event-stream" },
  });
  const terminal = parseEvents(response.text).at(-1);
  assert.equal(terminal.event, "completed");
  assert.equal(terminal.data.resolvedModel, runtime.models[1]);
  const args = launches.at(-1).args;
  assert.equal(args[args.indexOf("--model") + 1], runtime.models[1]);
});

test("OpenAI requests launch the second approved model and return it in JSON and every SSE chunk", async (t) => {
  const { gateway, runtime, launches } = await setup(t);
  const selected = runtime.models[1];
  for (const stream of [false, true]) {
    const response = await completionRequest(gateway.origin, {
      model: selected, messages: [{ role: "user", content: "Synthetic second model" }], stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    });
    assert.equal(response.status, 200);
    if (stream) {
      const frames = parseEvents(response.text).map((event) => event.data);
      assert.equal(frames.at(-1), "[DONE]");
      assert.ok(frames.slice(0, -1).every((frame) => frame.model === selected));
      assert.equal(frames.slice(0, -1).flatMap((frame) => frame.choices)
        .map((choice) => choice.delta.content ?? "").join(""), answer);
    } else {
      const body = JSON.parse(response.text);
      assert.equal(body.model, selected);
      assert.equal(body.choices[0].message.content, answer);
    }
    const args = launches.at(-1).args;
    assert.equal(args[args.indexOf("--model") + 1], selected);
  }
});

test("unlisted models fail before spawn with route-specific errors", async (t) => {
  const { gateway, launches } = await setup(t);
  for (const model of ["claude-haiku-5-5", "claude-fable-5-5", "claude-opus-5-5 --unsafe"]) {
    assertFailure(await chatRequest(gateway.origin, {
      body: JSON.stringify({ input: "Synthetic unlisted model", model }),
    }), "invalid_request", 400);
    assertCompletionFailure(await completionRequest(gateway.origin, {
      model, messages: [{ role: "user", content: "Synthetic unlisted model" }],
    }), "model_not_found", 404, "model");
  }
  assert.equal(launches.length, 0);
});

for (const source of ["init", "message-start", "assistant", "model-usage"]) {
  test(`a different approved model in native ${source} still fails the selected-model check`, async (t) => {
    const { gateway, runtime, launches } = await setup(t, `approved-substitution:${source}`);
    for (const selected of runtime.models) {
      assertFailure(await chatRequest(gateway.origin, {
        body: JSON.stringify({ input: "Synthetic model mismatch", model: selected }),
      }), "runtime_mismatch", 502);
      assertCompletionFailure(await completionRequest(gateway.origin, {
        model: selected, messages: [{ role: "user", content: "Synthetic model mismatch" }],
      }), "runtime_mismatch", 502);
    }
    assert.equal(launches.length, 4, "model mismatch must never retry or fall back");
  });
}

test("runtime snapshots the approved list so caller mutation cannot change allowed models", async (t) => {
  const { gateway, runtime, launches } = await setup(t);
  const approved = [...runtime.models];
  runtime.models.splice(0, runtime.models.length, "claude-unapproved-5");
  assertFailure(await chatRequest(gateway.origin, {
    body: JSON.stringify({ input: "Synthetic mutated list", model: runtime.models[0] }),
  }), "invalid_request", 400);
  assert.equal(launches.length, 0);
  const response = await chatRequest(gateway.origin);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).resolvedModel, approved[0]);
  assert.equal(launches[0].args[launches[0].args.indexOf("--model") + 1], approved[0]);
});

test("OpenAI completion preserves single-user input and maps sanitized native text and usage", async (t) => {
  const { gateway, launches, children } = await setup(t, "utf8");
  const content = "  /usage $(touch /not-real)\nSynthetic π 🌍 prompt  ";
  for (const stream of [undefined, false]) {
    const response = await completionRequest(gateway.origin, { model, messages: [{ role: "user", content }], stream },
      { headers: { Accept: "text/event-stream" } });
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /application\/json/u);
    const body = JSON.parse(response.text);
    assert.equal(body.object, "chat.completion");
    assert.match(body.id, /^chatcmpl-[0-9a-f-]{36}$/u);
    assert.ok(Number.isSafeInteger(body.created) && body.created > 0);
    assert.equal(body.model, model);
    assert.deepEqual(body.choices, [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }]);
    assert.deepEqual(body.usage, { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
    const launch = launches.at(-1);
    const frames = launch.input.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].client_composed, true);
    assert.equal(frames[0].message.content, content);
    assert.equal(launch.args.includes(content), false);
    assertGone(children.at(-1));
  }
});

test("OpenAI history flattens to one labelled prompt and compatibility options never reach native arguments", async (t) => {
  const { gateway, launches } = await setup(t);
  const messages = [
    { role: "system", content: "Answer briefly." },
    { role: "developer", content: [{ type: "text", text: "Stay on topic." }] },
    { role: "user", content: "First question", name: "caller" },
    { role: "assistant", content: [{ type: "text", text: "Prior " }, { type: "text", text: "answer" }] },
    { role: "user", content: [{ type: "text", text: "Next " }, { type: "text", text: "question" }] },
  ];
  const options = {
    temperature: 0.3, top_p: 0.8, frequency_penalty: -2, presence_penalty: 2, max_tokens: 1,
    stop: ["Hello", "π"], seed: 19, user: canary, metadata: { synthetic: canary }, store: false,
    service_tier: "default", reasoning_effort: "low", n: 1, tools: [], tool_choice: "none",
    parallel_tool_calls: false, logprobs: false, response_format: { type: "text" }, modalities: ["text"],
  };
  for (const patch of [{}, options, { max_completion_tokens: 1, stop: "Hello" }]) {
    const response = await completionRequest(gateway.origin, { model, messages, ...patch });
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).choices[0].message.content, answer, "ignored stop and token caps must not truncate text");
    assert.equal(response.text.includes(canary), false);
    const launch = launches.at(-1);
    const frames = launch.input.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].client_composed, true);
    assert.deepEqual(frames[0].message, {
      role: "user",
      content: "Instructions:\nAnswer briefly.\n\nStay on topic.\n\nUser: First question\n\nAssistant: Prior answer\n\nUser: Next question",
    });
    assert.deepEqual(launch.args, launches[0].args);
    assert.equal(JSON.stringify(launch).includes(canary), false);
  }
});

for (const includeUsage of [false, true]) {
  test(`OpenAI UTF-8 SSE emits role, deltas, stop, optional usage (${includeUsage}) and DONE once`, async (t) => {
    const { gateway } = await setup(t, "utf8");
    const response = await completionRequest(gateway.origin, {
      model, messages: [{ role: "user", content: "Synthetic prompt" }], stream: true,
      ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /text\/event-stream/u);
    const events = parseEvents(response.text);
    assert.ok(events.every((event) => event.event === undefined));
    const frames = events.map((event) => event.data);
    assert.equal(frames.at(-1), "[DONE]");
    assert.equal(frames.filter((frame) => frame === "[DONE]").length, 1);
    const chunks = frames.slice(0, -1);
    for (const chunk of chunks) {
      assert.equal(chunk.object, "chat.completion.chunk");
      assert.equal(chunk.id, chunks[0].id);
      assert.equal(chunk.created, chunks[0].created);
      assert.equal(chunk.model, model);
    }
    const choices = chunks.filter((chunk) => chunk.choices.length).map((chunk) => chunk.choices[0]);
    assert.deepEqual(choices[0].delta, { role: "assistant", content: "" });
    assert.equal(choices.map((choice) => choice.delta.content ?? "").join(""), answer);
    assert.deepEqual(choices.map((choice) => choice.finish_reason), [null, null, null, "stop"]);
    assert.deepEqual(choices.at(-1).delta, {});
    assert.ok(choices.every((choice) => choice.index === 0));
    if (includeUsage) {
      assert.deepEqual(chunks.at(-1).choices, []);
      assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
      assert.ok(chunks.slice(0, -1).every((chunk) => chunk.usage === null));
    } else assert.ok(chunks.every((chunk) => !Object.hasOwn(chunk, "usage")));
  });
}

test("OpenAI rejects unsupported capabilities, malformed history and invalid option ranges before spawn", async (t) => {
  const { gateway, launches } = await setup(t);
  const base = { model, messages: [{ role: "user", content: "Synthetic" }] };
  const unsupported = [
    ["tools", [{ type: "function", function: { name: "Read" } }]], ["tools", null], ["tool_choice", "auto"],
    ["functions", []], ["function_call", "none"], ["parallel_tool_calls", true], ["n", 2],
    ["response_format", { type: "json_object" }], ["response_format", { type: "text", schema: {} }],
    ["logprobs", true], ["top_logprobs", 0], ["audio", {}], ["modalities", ["text", "audio"]],
    ["prediction", {}], ["web_search_options", {}],
  ];
  for (const [key, value] of unsupported) {
    assertCompletionFailure(await completionRequest(gateway.origin, { ...base, [key]: value }), "unsupported_parameter", 400, key);
  }
  const invalid = [
    ["stream", "true"], ["stream", null], ["stream_options", { include_usage: true }],
    ["temperature", -0.1], ["temperature", 2.1], ["temperature", null], ["top_p", 1.1],
    ["frequency_penalty", -2.1], ["presence_penalty", 2.1], ["max_tokens", 0],
    ["max_completion_tokens", 1.5], ["seed", 1.5], ["stop", []], ["stop", ["a", "b", "c", "d", "e"]],
    ["stop", [7]], ["user", 1], ["store", "false"], ["metadata", []], ["metadata", { test: 1 }],
    ["metadata", { test: "x".repeat(513) }], ["service_tier", "unlimited"], ["reasoning_effort", "all"],
  ];
  for (const [key, value] of invalid) {
    assertCompletionFailure(await completionRequest(gateway.origin, { ...base, [key]: value }), "invalid_request", 400, key);
  }
  assertCompletionFailure(await completionRequest(gateway.origin, { ...base, max_tokens: 1, max_completion_tokens: 2 }),
    "invalid_request", 400, "max_completion_tokens");
  assertCompletionFailure(await completionRequest(gateway.origin, { ...base, stream: true, stream_options: { include_usage: true, other: true } }),
    "invalid_request", 400, "stream_options");
  for (const [messages, code, param] of [
    [[], "invalid_request", "messages"],
    [[{ role: "tool", content: canary }], "unsupported_parameter", "messages[0].role"],
    [[{ role: "assistant", content: "Text", tool_calls: [] }, ...base.messages], "unsupported_parameter", "messages[0].tool_calls"],
    [[{ role: "assistant", content: "Text", function_call: {} }, ...base.messages], "unsupported_parameter", "messages[0].function_call"],
    [[{ role: "user", content: [{ type: "image_url", image_url: { url: canary } }] }], "unsupported_parameter", "messages[0].content"],
    [[{ role: "user", content: [{ type: "text", text: "x", extra: true }] }], "unsupported_parameter", "messages[0].content"],
    [[{ role: "assistant", content: "Last answer" }], "invalid_request", "messages"],
    [[{ role: "system", content: "Instructions only" }], "invalid_request", "messages"],
    [[{ role: "assistant", content: null }, ...base.messages], "invalid_request", "messages[0].content"],
    [[{ role: "user", content: "\ud800" }], "invalid_request", "messages[0].content"],
    [[{ role: "user", content: "a\0b" }], "invalid_request", "messages[0].content"],
    [[{ role: "user", content: "   " }], "invalid_request", "messages[0].content"],
    [[{ role: "user", content: [] }], "invalid_request", "messages[0].content"],
    [[{ role: "user", content: "x", name: 2 }], "invalid_request", "messages[0].name"],
  ]) {
    assertCompletionFailure(await completionRequest(gateway.origin, { ...base, messages }), code, 400, param);
  }
  assertCompletionFailure(await completionRequest(gateway.origin, { messages: base.messages }), "invalid_request", 400, "model");
  assertCompletionFailure(await completionRequest(gateway.origin, { ...base, model: canary }), "model_not_found", 404, "model");
  assertCompletionFailure(await completionRequest(gateway.origin, { ...base, [canary]: true }), "unsupported_parameter", 400);
  for (const body of ["{", "null", "[]", Buffer.from([0x7b, 0xc3, 0x28, 0x7d])]) {
    assertCompletionFailure(await completionRequest(gateway.origin, base, { body }), "invalid_request", 400);
  }
  assert.equal(launches.length, 0);
});

test("OpenAI request and flattened UTF-8 bounds are separate from legacy prompt limits", async (t) => {
  const { gateway, launches } = await setup(t);
  const exact = "π".repeat(96 * 1024);
  const body = { model, messages: [{ role: "user", content: exact }] };
  assert.equal((await completionRequest(gateway.origin, body)).status, 200);
  assert.equal(JSON.parse(launches[0].input).message.content, exact);
  assertCompletionFailure(await completionRequest(gateway.origin, {
    ...body, messages: [{ role: "user", content: `${exact}x` }],
  }), "invalid_request", 413, "messages");
  assertCompletionFailure(await completionRequest(gateway.origin, {
    ...body, messages: [{ role: "system", content: "x" }, ...body.messages],
  }), "invalid_request", 413, "messages");
  const small = JSON.stringify({ model, messages: [{ role: "user", content: "x" }] });
  const fullBody = `${small}${" ".repeat(256 * 1024 - Buffer.byteLength(small))}`;
  assert.equal((await completionRequest(gateway.origin, undefined, { body: fullBody })).status, 200);
  assertCompletionFailure(await completionRequest(gateway.origin, undefined, { body: `${fullBody} ` }), "invalid_request", 413);
  assertFailure(await chatRequest(gateway.origin, { body: JSON.stringify({ input: exact }) }), "invalid_request", 413);
  assert.equal(launches.length, 2);
});

test("OpenAI routes enforce authentication, exact Host and no Origin before body validation", async (t) => {
  const { gateway, launches } = await setup(t);
  for (const route of [{ method: "GET", path: "/v1/models" }, { method: "POST", path: "/v1/chat/completions" }]) {
    for (const [headers, status, code, type] of [
      [{ Authorization: "" }, 401, "unauthorized", "authentication_error"],
      [{ Authorization: `Bearer ${"z".repeat(40)}` }, 401, "unauthorized", "authentication_error"],
      [{ Host: "localhost:14502" }, 403, "forbidden", "permission_error"],
      [{ Origin: "null" }, 403, "forbidden", "permission_error"],
    ]) {
      const error = assertCompletionFailure(await chatRequest(gateway.origin, { ...route, headers, body: "{" }), code, status);
      assert.equal(error.type, type);
    }
  }
  for (const headers of [{ "Content-Type": "text/plain" }, { "Content-Encoding": "gzip" }, { Expect: "100-continue" }]) {
    assertCompletionFailure(await completionRequest(gateway.origin, undefined, { headers }), "invalid_request", 415);
  }
  for (const options of [
    { path: "/v1/chat/completions?x=1" }, { method: "GET" }, { path: "/v1/models", method: "POST" },
  ]) assertCompletionFailure(await completionRequest(gateway.origin, undefined, options), "invalid_request", 404);
  assert.equal(launches.length, 0);
});

for (const scenario of ["stall", "midstream"]) {
  test(`OpenAI ${scenario} holds shared single-flight slot and cancels owned child on disconnect`, async (t) => {
    const { gateway, firstReady, launches, children } = await setup(t, scenario);
    let pending;
    t.after(() => pending?.destroy());
    let contentSeen;
    const firstContent = new Promise((resolve) => { contentSeen = resolve; });
    pending = request(new URL("/v1/chat/completions", gateway.origin), {
      method: "POST", agent: false,
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
    }, (response) => {
      response.on("error", () => {});
      response.on("data", (chunk) => { if (chunk.toString().includes('"content":"Hello')) contentSeen(); });
    });
    pending.on("error", () => {});
    pending.end(JSON.stringify({ model, messages: [{ role: "user", content: "Synthetic cancellation" }], stream: scenario === "midstream" }));
    const child = await firstReady;
    if (scenario === "midstream") await firstContent;
    const busy = assertCompletionFailure(await completionRequest(gateway.origin, { tools: ["invalid"] }), "busy", 409);
    assert.equal(busy.type, "invalid_request_error");
    assertFailure(await chatRequest(gateway.origin), "busy", 409);
    assert.equal((await chatRequest(gateway.origin, { method: "GET", path: "/v1/models" })).status, 200);
    assert.equal(launches.length, 1);
    const closed = once(child, "close");
    pending.destroy();
    await closed;
    await gateway.close();
    assertGone(children[0]);
  });
}

for (const [scenario, code, status, type] of [
  ["api:401", "login_required", 401, "authentication_error"],
  ["api:429", "rate_limit_exceeded", 429, "rate_limit_error"],
  ["assistant-error:billing_error", "billing_required", 502, "server_error"],
  ["assistant-error:model_not_found", "model_unavailable", 502, "server_error"],
  ["missing-terminal", "upstream_failed", 502, "server_error"],
  ["invalid-json", "invalid_upstream", 502, "server_error"],
  ["init:model", "runtime_mismatch", 502, "server_error"],
]) {
  test(`OpenAI ${scenario} exposes fixed error fields without provider details or a completion`, async (t) => {
    const { gateway, launches } = await setup(t, scenario);
    const error = assertCompletionFailure(await completionRequest(gateway.origin), code, status);
    assert.equal(error.type, type);
    assert.equal(launches.length, 1);
  });
}

for (const [scenario, code, status] of [["api:401", "login_required", 401], ["api:429", "rate_limit_exceeded", 429]]) {
  test(`OpenAI requested SSE preserves ${scenario} HTTP failure before any text`, async (t) => {
    const { gateway, launches } = await setup(t, scenario);
    const response = await completionRequest(gateway.origin, {
      model, messages: [{ role: "user", content: "Synthetic" }], stream: true,
    });
    assertCompletionFailure(response, code, status);
    assert.match(response.headers["content-type"], /application\/json/u);
    assert.equal(launches.length, 1);
  });
}

test("OpenAI SSE late failure ends with error instead of stop or DONE", async (t) => {
  const { gateway } = await setup(t, "nonzero");
  const response = await completionRequest(gateway.origin, {
    model, messages: [{ role: "user", content: "Synthetic" }], stream: true, stream_options: { include_usage: true },
  });
  const frames = parseEvents(response.text).map((event) => event.data);
  assert.equal(response.status, 200);
  assert.equal(frames.slice(0, -1).map((chunk) => chunk.choices[0].delta.content ?? "").join(""), answer);
  assert.equal(frames.at(-1).error.code, "upstream_failed");
  assert.equal(frames.at(-1).error.type, "server_error");
  assert.equal(frames.filter((frame) => frame.error).length, 1);
  assert.equal(frames.some((frame) => frame.choices?.some((choice) => choice.finish_reason !== null)), false);
  assert.equal(response.text.includes("[DONE]"), false);
  assert.equal(response.text.includes(canary), false);
});

for (const scenario of ["invalid-usage", "partial-usage", "missing-input-usage"]) {
  test(`OpenAI ${scenario} stays null instead of inventing absent token counts`, async (t) => {
    const { gateway } = await setup(t, scenario);
    const response = await completionRequest(gateway.origin);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.text).usage, null);
  });
}

test("OpenAI escaped answer near output limit fits its bounded JSON response envelope", async (t) => {
  const { gateway, children } = await setup(t, "escaped-answer");
  const response = await completionRequest(gateway.origin);
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(response.text) > 256 * 1024);
  assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(response.text));
  const body = JSON.parse(response.text);
  const content = body.choices[0].message.content;
  assert.ok(content.length > 127 * 1024 && content.length <= 128 * 1024);
  assert.match(content, /^\\+$/u);
  assert.equal(body.choices[0].finish_reason, "stop");
  assertGone(children[0]);
});

for (const groupGoneOnKill of [true, false]) {
  test(`OpenAI deadline and cleanup failures preserve shared admission safety (${groupGoneOnKill})`, async (t) => {
    const fake = fakeChild({ groupGoneOnKill });
    const fixture = await createFixtureRuntime();
    let calls = 0;
    const gateway = await startClaudeChatGateway({
      runtime: fixture.runtime, tokenVerifier: verifier, port: 0, turnTimeoutMs: 20, terminationGraceMs: 10,
      spawnProcess() { calls += 1; return fake.child; }, killProcess: fake.killProcess,
    });
    t.after(async () => { fake.release(); await gateway.close().catch(() => {}); await fixture.dispose(); });
    assertCompletionFailure(await completionRequest(gateway.origin), groupGoneOnKill ? "timeout" : "cleanup_failed", groupGoneOnKill ? 504 : 502);
    assert.deepEqual(fake.signals, ["SIGINT", "SIGTERM", "SIGKILL"]);
    if (!groupGoneOnKill) {
      assertCompletionFailure(await completionRequest(gateway.origin), "busy", 409);
      await assert.rejects(gateway.close(), /cleanup/u);
    }
    assert.equal(calls, 1);
  });
}
