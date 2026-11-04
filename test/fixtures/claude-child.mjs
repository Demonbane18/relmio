import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const credential = "synthetic_claude_local_capability_0123456789abcdef";
export const verifier = createHash("sha256").update(credential).digest();
export const model = "claude-sonnet-5-5";
export const answer = "Hello π 🌍!";
export const canary = "SYNTHETIC_SECRET_DO_NOT_DISCLOSE_739b91";
const fixturePath = fileURLToPath(import.meta.url);

export async function createFixtureRuntime() {
  const root = await mkdtemp(join(tmpdir(), "relmio-claude-test-"));
  const runtime = {
    executable: process.execPath,
    cwd: join(root, "empty"),
    home: join(root, "home"),
    configDir: join(root, "home", "native"),
    version: "2.1.317",
    models: [model, "claude-opus-5-5"],
  };
  await Promise.all([mkdir(runtime.cwd), mkdir(runtime.configDir, { recursive: true })]);
  return { runtime, dispose: () => rm(root, { recursive: true, force: true }) };
}

export function syntheticSpawner(runtime, scenario = "success") {
  const children = [];
  const launches = [];
  let ready;
  const firstReady = new Promise((resolve) => { ready = resolve; });
  function spawnProcess(executable, args, options) {
    const launch = { executable, args, options, input: "" };
    launches.push(launch);
    const child = spawn(process.execPath, [fixturePath, "--child"], {
      ...options,
      env: {
        ...options.env,
        FIXTURE_SCENARIO: scenario,
        FIXTURE_CWD: runtime.cwd,
        FIXTURE_MODEL: args[args.indexOf("--model") + 1],
        FIXTURE_VERSION: runtime.version,
      },
    });
    children.push(child);
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...rest) => {
      launch.input += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      return write(chunk, ...rest);
    };
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (chunk, ...rest) => {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        launch.input += chunk.toString();
      }
      return end(chunk, ...rest);
    };
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const descendant = /FIXTURE_DESCENDANT:(\d+)/u.exec(stderr);
      if (descendant) child.descendantPid = Number(descendant[1]);
      if (stderr.includes("FIXTURE_READY\n")) ready(child);
    });
    return child;
  }
  return { spawnProcess, children, launches, firstReady };
}

export function chatRequest(origin, {
  method = "POST",
  body = method === "POST" ? JSON.stringify({ input: "Synthetic prompt" }) : undefined,
  path = "/chat",
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const pending = request(new URL(path, origin), {
      method,
      agent: false,
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/json",
        ...(body === undefined ? {} : { "Content-Length": Buffer.byteLength(body) }),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode, headers: response.headers, text });
      });
    });
    pending.once("error", reject);
    pending.end(body);
  });
}

export function completionRequest(origin, body = { model, messages: [{ role: "user", content: "Synthetic prompt" }] }, options = {}) {
  return chatRequest(origin, { path: "/v1/chat/completions", body: JSON.stringify(body), ...options });
}

export function parseEvents(text) {
  return text.split(/\r?\n\r?\n/u)
    .filter((block) => block.trim() && !block.trimStart().startsWith(":"))
    .map((block) => {
      const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      return {
        event: block.split(/\r?\n/u).find((line) => line.startsWith("event:"))?.slice(6).trim(),
        data: data === "[DONE]" ? data : JSON.parse(data),
      };
    });
}

// Runnable independently of node:test; never starts a native Claude executable.
export async function runClaudeChatSmoke() {
  const { startClaudeChatGateway } = await import("../../src/gateway/claude-chat.js");
  const fixture = await createFixtureRuntime();
  let gateway;
  try {
    const synthetic = syntheticSpawner(fixture.runtime, "utf8");
    gateway = await startClaudeChatGateway({
      runtime: fixture.runtime, tokenVerifier: verifier, port: 0,
      turnTimeoutMs: 5000, terminationGraceMs: 100,
      bodyTimeoutMs: 2000, backpressureTimeoutMs: 2000,
      spawnProcess: synthetic.spawnProcess,
    });
    const json = await chatRequest(gateway.origin);
    assert.equal(json.status, 200);
    assert.equal(JSON.parse(json.text).text, answer);
    const stream = await chatRequest(gateway.origin, { headers: { Accept: "text/event-stream" } });
    assert.equal(stream.status, 200);
    const events = parseEvents(stream.text);
    assert.equal(events.filter((event) => event.event === "delta").map((event) => event.data.text).join(""), answer);
    assert.equal(events.filter((event) => event.event === "completed").length, 1);
    assert.equal(events.some((event) => event.event === "error"), false);
    assert.equal(Object.hasOwn(events.at(-1).data, "text"), false);
    assert.equal(synthetic.launches.length, 2);
    return { json: "completed", sse: "completed", nativeStartup: false };
  } finally {
    try { if (gateway) await gateway.close(); }
    finally { await fixture.dispose(); }
  }
}

async function runChild() {
  const scenario = process.env.FIXTURE_SCENARIO;
  let wire = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) wire += chunk.toString("utf8");
  const frames = wire.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.equal(frame.type, "user");
  assert.equal(frame.client_composed, true);
  assert.equal(frame.parent_tool_use_id, null);
  assert.equal(frame.message.role, "user");
  assert.equal(typeof frame.message.content, "string");
  assert.match(frame.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

  const session = scenario === "escaped-answer" ? "s" : "synthetic-session";
  const envelope = (record) => ({ session_id: session, ...record });
  const stream = (event) => envelope({ type: "stream_event", parent_tool_use_id: null, event });
  const init = envelope({
    type: "system", subtype: "init", tools: [], mcp_servers: [], plugins: [], skills: [],
    cwd: process.env.FIXTURE_CWD, model: process.env.FIXTURE_MODEL,
    claude_code_version: process.env.FIXTURE_VERSION, apiKeySource: "none", fast_mode_state: "off",
  });
  const message = { id: "msg_synthetic", type: "message", role: "assistant", model: process.env.FIXTURE_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } };
  const result = envelope({
    type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
    stop_reason: "end_turn", num_turns: 1, result: answer, permission_denials: [],
    user_message_uuid: frame.uuid,
    usage: { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
    modelUsage: { [process.env.FIXTURE_MODEL]: { inputTokens: 7, outputTokens: 4 } },
  });
  let parts = ["Hello π ", "🌍!"];
  if (scenario === "escaped-answer") {
    delete result.modelUsage;
    result.usage = { input_tokens: 7, output_tokens: 4 };
    const overhead = Buffer.byteLength(JSON.stringify({ ...result, result: "" }));
    // Fit the native result line; the OpenAI envelope adds enough bytes to cross 256 KiB.
    result.result = "\\".repeat(Math.floor((256 * 1024 - overhead) / 2));
    parts = [result.result.slice(0, 64 * 1024), result.result.slice(64 * 1024)];
  }
  let records = [init, stream({ type: "message_start", message })];
  for (const [index, text] of parts.entries()) {
    records.push(stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
    records.push(stream({ type: "content_block_delta", index, delta: { type: "text_delta", text } }));
    records.push(envelope({ type: "assistant", parent_tool_use_id: null, message: { ...message, content: [{ type: "text", text }] } }));
    records.push(stream({ type: "content_block_stop", index }));
  }
  records.push(stream({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }));
  records.push(stream({ type: "message_stop" }));
  records.push(result);

  if (scenario.startsWith("init:")) {
    const field = scenario.slice(5);
    const mismatches = { model: "claude-other-5", cwd: "/synthetic/wrong", claude_code_version: "2.1.316", apiKeySource: "user", fast_mode_state: "on", tools: ["Read"], mcp_servers: [{ name: "bad" }], plugins: [{ name: "bad" }], skills: ["bad"] };
    init[field] = mismatches[field];
  } else if (scenario.startsWith("terminal:")) {
    result.terminal_reason = scenario.slice(9);
  } else if (scenario.startsWith("stop:")) {
    result.stop_reason = scenario.slice(5);
    records.at(-3).event.delta.stop_reason = result.stop_reason;
  } else if (scenario.startsWith("assistant-error:")) {
    records = [init, envelope({ type: "assistant", error: scenario.slice(16), message: { ...message, content: [{ type: "text", text: canary }] } })];
  } else if (scenario.startsWith("api:")) {
    records = [init, envelope({ type: "system", subtype: "api_retry", error_status: Number(scenario.slice(4)), attempt: 1, max_retries: 3, error: canary })];
  } else if (scenario.startsWith("tool:")) {
    const type = scenario.slice(5);
    const content = { type, id: "tool_1", name: "Read", input: { secret: canary } };
    if (type === "input_json_delta") {
      records = records.slice(0, 3);
      records.push(stream({ type: "content_block_delta", index: 0, delta: { type, partial_json: `{"secret":"${canary}` } }));
    } else if (type === "snapshot") {
      records = [init, envelope({ type: "assistant", message: { ...message, content: [{ ...content, type: "tool_use" }] } })];
    } else if (type === "control_request") {
      records = [init, { type, request_id: "synthetic-control", request: { subtype: "can_use_tool", tool_name: "Read" } }];
    } else {
      records = [init, records[1], stream({ type: "content_block_start", index: 0, content_block: content })];
    }
  } else if (scenario === "quota-rejected" || scenario === "credits-required" || scenario === "quota-warning") {
    records.splice(1, 0, envelope({ type: "rate_limit_event", rate_limit_info: { status: scenario === "quota-rejected" ? "rejected" : "allowed_warning", ...(scenario === "credits-required" ? { errorCode: "credits_required" } : {}) } }));
  } else if (scenario === "missing-terminal") {
    delete result.terminal_reason;
  } else if (scenario === "is-error") {
    result.is_error = true;
  } else if (scenario === "max-turns") {
    result.subtype = "error_max_turns";
  } else if (scenario === "zero-turns") {
    result.num_turns = 0;
  } else if (scenario === "permission-denied") {
    result.permission_denials = [{ tool_name: "Read", tool_input: canary }];
  } else if (scenario === "aborted") {
    records[4].aborted = true;
  } else if (scenario === "deferred") {
    result.deferred_tool_use = [{ id: "deferred" }];
  } else if (scenario === "local-command") {
    result.local_command = true;
  } else if (scenario === "wrong-session") {
    result.session_id = "another-session";
  } else if (scenario === "wrong-request") {
    result.user_message_uuid = "another-request";
  } else if (scenario === "model-substitution") {
    records[4].message.model = "claude-other-5";
  } else if (scenario.startsWith("approved-substitution:")) {
    const otherModel = process.env.FIXTURE_MODEL === model ? "claude-opus-5-5" : model;
    const source = scenario.slice("approved-substitution:".length);
    if (source === "init") init.model = otherModel;
    else if (source === "message-start") message.model = otherModel;
    else if (source === "assistant") records[4].message.model = otherModel;
    else if (source === "model-usage") result.modelUsage = { [otherModel]: { inputTokens: 7, outputTokens: 4 } };
  } else if (scenario === "text-mismatch") {
    result.result = "Unstreamed answer";
  } else if (scenario === "missing-block-stop") {
    records = records.filter((record) => record.event?.type !== "content_block_stop");
  } else if (scenario === "eof") {
    records.pop();
  } else if (scenario === "trailing-record") {
    records.push(envelope({ type: "assistant", message: { ...message, content: [{ type: "text", text: "late" }] } }));
  } else if (scenario === "thinking") {
    records.splice(-3, 0,
      stream({ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "" } }),
      stream({ type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: canary } }),
      stream({ type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: canary } }),
      envelope({ type: "system", subtype: "thinking_tokens", estimated_tokens: 32, estimated_tokens_delta: 8, user_message_uuid: frame.uuid }),
      envelope({ type: "assistant", parent_tool_use_id: null, message: { ...message, content: [{ type: "thinking", thinking: canary, signature: canary }] } }),
      stream({ type: "content_block_stop", index: 2 }));
  } else if (scenario === "redacted-thinking") {
    const block = { type: "redacted_thinking", data: canary };
    records.splice(-3, 0,
      stream({ type: "content_block_start", index: 2, content_block: block }),
      envelope({ type: "system", subtype: "thinking_tokens", estimated_tokens: 48.5, estimated_tokens_delta: 16.25, user_message_uuid: frame.uuid }),
      envelope({ type: "assistant", parent_tool_use_id: null, message: { ...message, content: [block] } }),
      stream({ type: "content_block_stop", index: 2 }));
  } else if (scenario.startsWith("startup:")) {
    records = [envelope({
      type: "result", subtype: "error_during_execution", is_error: true,
      startup_failure_reason: scenario.slice(8), errors: [canary], num_turns: 0,
      user_message_uuid: frame.uuid,
    })];
  } else if (scenario === "ui-render" || scenario === "ui-render-unknown") {
    // Observed Claude Code 2.1.317 shape: emitted before init, before any model request.
    records.unshift({ type: "system", subtype: "ui_invalidate",
      event: scenario === "ui-render" ? "ui.render" : "ui.other",
      uuid: "00000000-0000-4000-8000-000000000001", session_id: "ui-session" });
  } else if (scenario === "command-lifecycle") {
    // Observed Claude Code 2.1.317 record type; values are synthetic. Unknown metadata is ignored.
    const lifecycle = (state) => ({ type: "command_lifecycle", command_uuid: frame.uuid, state,
      uuid: "00000000-0000-4000-8000-000000000002", session_id: "lifecycle-session" });
    records.unshift(lifecycle("started"));
    records.splice(-1, 0, lifecycle("running"));
    records.push(lifecycle("completed"));
  } else if (scenario === "builtin-plugins" || scenario === "builtin-plus-installed") {
    // Observed Claude Code 2.1.317 built-in mods; --safe-mode does not stop built-in mods.
    init.plugins = ["cc-plugin-agents-md", "cc-plugin-privacy", "cc-plugin-plugin-authoring"]
      .map((name) => ({ name, path: "builtin" }));
    if (scenario === "builtin-plus-installed") init.plugins.push({ name: "community-mod", path: "/synthetic/plugins/community-mod" });
  } else if (scenario === "builtin-duplicate") {
    init.plugins = ["cc-plugin-agents-md", "cc-plugin-privacy", "cc-plugin-privacy"].map((name) => ({ name, path: "builtin" }));
  } else if (scenario === "unknown-tool-signal") {
    records.splice(2, 0, envelope({ type: "future_metadata", parent_tool_use_id: "toolu_synthetic" }));
  } else if (scenario.startsWith("signal:") || scenario.startsWith("late-signal:")) {
    // Each must fail closed even on a record type the adapter otherwise ignores.
    const signals = {
      user: { type: "user", message: { role: "user", content: "synthetic" } },
      tool_progress: { type: "tool_progress" },
      tool_use_summary: { type: "tool_use_summary" },
      permission_denied: { type: "permission_denied" },
      hook: { type: "system", subtype: "hook_started" },
      task: { type: "system", subtype: "task_started" },
      background: { type: "system", subtype: "background_task" },
      plugin: { type: "system", subtype: "plugin_loaded" },
      local_command_subtype: { type: "system", subtype: "local_command_output" },
      files_persisted: { type: "system", subtype: "files_persisted" },
      memory_recall: { type: "system", subtype: "memory_recall" },
      agent_id: { type: "future_metadata", agent_id: "synthetic-agent" },
      tool_use_result: { type: "future_metadata", tool_use_result: {} },
      deferred_tool_use: { type: "future_metadata", deferred_tool_use: {} },
      local_command: { type: "future_metadata", local_command: "synthetic" },
      auth_status_output: { type: "auth_status", output: ["synthetic helper output"] },
      second_command: { type: "command_lifecycle", command_uuid: "00000000-0000-4000-8000-0000000000ff", state: "running" },
    };
    const late = scenario.startsWith("late-signal:");
    const record = envelope(signals[scenario.slice(late ? 12 : 7)]);
    records.unshift({ type: "command_lifecycle", command_uuid: frame.uuid, state: "started" });
    if (late) records.push(record); else records.splice(2, 0, record);
  } else if (scenario === "invalid-thinking-progress" || scenario === "wrong-thinking-session") {
    records.splice(1, 0, envelope({
      type: "system", subtype: "thinking_tokens", estimated_tokens: scenario === "invalid-thinking-progress" ? -1 : 32,
      estimated_tokens_delta: 8,
      ...(scenario === "wrong-thinking-session" ? { session_id: "unrelated-session" } : {}),
    }));
  } else if (scenario === "canary") {
    process.stderr.write(canary);
    result.total_cost_usd = 123.45;
    result.metadata = { secret: canary };
    result.usage.secret = canary;
    result.modelUsage[process.env.FIXTURE_MODEL].costUSD = 123.45;
  } else if (scenario === "snapshot-only") {
    records = [init, ...records.filter((record) => record.type === "assistant"), result];
  } else if (scenario === "snapshot-mismatch") {
    records[4].message.content[0].text = "different snapshot";
  } else if (scenario === "missing-snapshot") {
    records = records.filter((record) => record.type !== "assistant");
  } else if (scenario === "agent-metadata") {
    init.agents = ["general-purpose", "Explore"];
  } else if (scenario === "agent-execution") {
    records[4].agent_id = "synthetic-agent";
  } else if (scenario === "parent-tool") {
    records[4].parent_tool_use_id = "synthetic-parent";
  } else if (scenario === "invalid-usage") {
    result.usage = { input_tokens: -1, output_tokens: 1.5, cache_read_input_tokens: "9", cache_creation_input_tokens: null };
  } else if (scenario === "partial-usage") {
    result.usage.output_tokens = -1;
  } else if (scenario === "missing-input-usage") {
    result.usage.input_tokens = -1;
  } else if (scenario === "output-flood") {
    const text = "x".repeat(140 * 1024);
    records = [init, records[1], records[2], stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })];
  } else if (scenario === "stdout-flood") {
    records = [init, ...Array.from({ length: 20 }, () => envelope({ type: "system", subtype: "api_retry", error_status: 529, metadata: "x".repeat(60 * 1024) }))];
  }

  if (scenario === "descendant") {
    const descendant = spawn(process.execPath, ["-e", 'process.on("SIGINT", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'], {
      stdio: ["ignore", "pipe", "ignore"], env: {},
    });
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => { descendant.once("close", () => process.exit(0)); });
    await once(descendant.stdout, "data");
    process.stderr.write(`FIXTURE_DESCENDANT:${descendant.pid}\n`);
    records = [init];
  }
  if (["stall", "ignore-signals", "midstream"].includes(scenario)) {
    process.on("SIGINT", () => {});
    if (scenario === "ignore-signals") process.on("SIGTERM", () => {});
    records = scenario === "midstream" ? records.slice(0, 4) : [init];
  }
  process.stderr.write("FIXTURE_READY\n");
  let output = records.map((record) => `${JSON.stringify(record)}\n`).join("");
  if (scenario === "invalid-json") output = `${JSON.stringify(init)}\n{bad-json}\n`;
  if (scenario === "truncated-json") output = `${JSON.stringify(init)}\n{"type":`;
  if (scenario === "oversized-line") output = `${JSON.stringify(init)}\n${"x".repeat(2 * 1024 * 1024)}\n`;
  if (scenario === "stderr-flood") process.stderr.write("x".repeat(2 * 1024 * 1024));
  const bytes = scenario === "invalid-utf8" ? Buffer.from([0xc3, 0x28, 10])
    : scenario === "truncated-utf8" ? Buffer.from([0xf0, 0x9f]) : Buffer.from(output);
  const size = scenario === "utf8" ? 1 : 16 * 1024;
  for (let offset = 0; offset < bytes.length; offset += size) {
    if (!process.stdout.write(bytes.subarray(offset, offset + size))) await once(process.stdout, "drain");
  }
  if (["stall", "ignore-signals", "midstream", "descendant"].includes(scenario)) {
    setInterval(() => {}, 1000);
  } else if (scenario === "nonzero") {
    process.exitCode = 9;
  }
}

if (process.argv[1] === fixturePath) {
  if (process.argv[2] === "--child") await runChild();
  else if (process.argv[2] === "--smoke") console.log(JSON.stringify(await runClaudeChatSmoke()));
}
