import assert from "node:assert/strict";
import test from "node:test";
import { runCodexSiwcCommand } from "../src/services/codex-login.js";

const options = {
  target: "codex-chatgpt",
  installRoot: "/private/relmio/local/codex-chatgpt",
  dockerHost: "unix:///var/run/docker.sock",
  projectName: "relmio-codex-chatgpt-0123456789abcdef0123456789abcdef",
  registrationId: "registration_codex_test",
};

test("only a selected local Codex installation may run protected SIWC operations", async () => {
  let calls = 0;
  const runProcess = async () => { calls++; return { code: 0, stdout: "{}" }; };
  for (const invalid of [
    { target: "xai-grok-build" },
    { installRoot: "../codex-chatgpt" },
    { installRoot: "/private/relmio/local/codex-chatgpt/../other" },
    { dockerHost: "tcp://attacker.example:2375" },
    { projectName: "relmio-codex-chat-0123456789abcdef0123456789abcdef" },
    { projectName: "relmio-codex-chatgpt-0123456789abcdef0123456789abcdef; docker stop n8n" },
    { command: "account/login/start" },
    { command: "../../../bin/sh" },
  ]) await assert.rejects(() => runCodexSiwcCommand({ ...options, command: "host", ...invalid, runProcess }));
  assert.equal(calls, 0);
});

test("protected transfer travels via stdin, not the Docker command line or output", async () => {
  const contents = Buffer.from(JSON.stringify({ handoffId: "test-only", secret: "do-not-print" }));
  let captured;
  const result = await runCodexSiwcCommand({
    ...options, command: "accept", input: contents,
    runProcess: async spec => {
      captured = spec;
      return { code: 0, stdout: '{"handoffId":"test-only"}' };
    },
  });
  assert.equal(result.handoffId, "test-only");
  assert.strictEqual(captured.input, contents);
  assert.equal(captured.file, "docker");
  assert.equal(captured.args.some(arg => arg.includes("do-not-print")), false);
  assert.equal(captured.args.includes("account/login/start"), false);
  assert.equal(captured.args.includes("codex-home"), false);
  assert.equal(captured.args.includes("accept"), true);
});

test("read-only account inspection never creates a one-off Docker container", async () => {
  let args;
  await runCodexSiwcCommand({
    ...options, command: "account-live",
    runProcess: async spec => { args = spec.args; return { code: 0, stdout: '{"account":null}' }; },
  });
  assert.ok(args.includes("exec"));
  assert.equal(args.includes("run"), false);
});

test("failed installed-owner operations do not expose raw diagnostics", async () => {
  await assert.rejects(
    () => runCodexSiwcCommand({ ...options, command: "sign-out", input: Buffer.from("{}"),
      runProcess: async () => ({ code: 1, stdout: "access_token=secret", stderr: "refresh_token=secret" }) }),
    error => !/access_token|refresh_token|secret/u.test(error.message),
  );
  await assert.rejects(() => runCodexSiwcCommand({
    ...options, command: "accept", input: Buffer.alloc(128 * 1024 + 1),
    runProcess() { throw new Error("should not run"); },
  }));
});

test("accept validates selected registration before spawning and sends explicit CLI environment", async () => {
  let captured;
  const runProcess = async spec => { captured = spec; return { code: 0, stdout: "{}" }; };
  for (const registrationId of [undefined, "../other", "a;docker stop n8n", ""]) {
    await assert.rejects(() => runCodexSiwcCommand({
      ...options, registrationId, command: "accept", input: Buffer.from("{}"), runProcess,
    }));
  }
  assert.equal(captured, undefined);
  await runCodexSiwcCommand({ ...options, command: "accept", input: Buffer.from("{}"), runProcess });
  assert.ok(captured.args.includes(`RELMIO_REGISTRATION_ID=${options.registrationId}`));
  assert.equal(captured.args.at(-1), "accept");
});

test("receipt CLI bounds identity request and reports lost attestation as unknown", async () => {
  let calls = 0;
  const runProcess = async () => { calls++; return { code: 0, stdout: '{"receipt":null}' }; };
  await assert.rejects(() => runCodexSiwcCommand({ ...options, command: "receipt", input: Buffer.alloc(8193), runProcess }));
  assert.equal(calls, 0);
  assert.deepEqual(await runCodexSiwcCommand({ ...options, command: "receipt", input: Buffer.from("{}"), runProcess }), { receipt: null });
  await assert.rejects(() => runCodexSiwcCommand({ ...options, command: "receipt", input: Buffer.from("{}"),
    runProcess: async () => ({ code: 0, stdout: "malformed", stderr: "secret" }) }),
    error => error.remoteOutcomeUnknown === true && !error.message.includes("secret"));
});

test("installed model catalog uses the active owner's PID namespace and never creates a helper", async () => {
  let captured;
  const result = await runCodexSiwcCommand({ ...options, command: "models",
    runProcess: async spec => {
      captured = spec;
      assert.equal(spec.args.includes("exec"), true);
      assert.equal(spec.args.includes("run"), false);
      return { code: 0, stdout: '{"models":[{"slug":"selected-model"}]}' };
    },
  });
  assert.equal(captured.args.at(-1), "models");
  assert.deepEqual(result.models, [{ slug: "selected-model" }]);
});
