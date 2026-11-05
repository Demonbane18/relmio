import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runClaudeCompanionLogin } from "../src/services/claude-login.js";
import { parseClaudeArguments, runClaudeCommand } from "../src/claude/command.js";

function fixture(overrides = {}) {
  const calls = []; const root = "/tmp/owner/.relmio/local/n8n-claude-oauth";
  const args = { isTTY: true, environment: { TERM: "xterm-256color" },
    resolveInstallRoot: async () => root,
    acquireLock: async () => { calls.push("lock"); return async () => calls.push("release"); },
    attestInstallation: async () => ({ installDirectory: root, projectName: "relmio-claude", serviceName: "relmio-claude", containerId: "a".repeat(64), dockerHost: "unix:///var/run/docker.sock" }),
    spawnProcess: (file, argv, options) => {
      calls.push({ file, argv, options }); const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0)); return child;
    },
    readAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "private@example.test", token: "provider-secret" }),
    ...overrides };
  return { args, calls };
}

test("Claude terminal login requires TTY before filesystem, Docker or credential work", async () => {
  const f = fixture({ isTTY: false, resolveInstallRoot: () => assert.fail("must not inspect without TTY") });
  await assert.rejects(() => runClaudeCompanionLogin(f.args), /interactive terminal/u);
  assert.deepEqual(f.calls, []);
  await assert.rejects(() => runClaudeCommand({ argumentsList: ["companion", "login"], platform: "linux", isInteractive: () => false,
    companionLogin: () => assert.fail("must not launch without TTY") }), /interactive terminal/u);
  assert.equal(parseClaudeArguments(["companion", "login"]).command, "companion login");
  assert.throws(() => parseClaudeArguments(["companion", "login", "--host", "example.test"]));
});

test("Claude login inherits terminal only for attested local daemon and returns filtered status", async () => {
  const f = fixture();
  assert.deepEqual(await runClaudeCompanionLogin(f.args), { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });
  const spawn = f.calls.find(value => typeof value === "object");
  assert.deepEqual(spawn.argv.slice(0, 7), ["--host", "unix:///var/run/docker.sock", "exec", "-it", "-w", "/data/account/empty", "relmio-claude"]);
  assert.deepEqual(spawn.argv.slice(-2), ["auth", "login"]);
  assert.equal(spawn.options.stdio, "inherit");
  assert.equal(spawn.options.shell, false);
  assert.equal(f.calls.at(-1), "release");
  const lines = [];
  assert.equal(await runClaudeCommand({ argumentsList: ["companion", "login"], platform: "linux", isInteractive: () => true,
    companionLogin: f.args.readAuthStatus, log: line => lines.push(line) }), 0);
  assert.deepEqual(lines, [JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" })]);
});

test("Claude terminal login rejects remote Docker, non-wizard identity, changed root and failed login", async () => {
  for (const change of [{ dockerHost: "tcp://example.test:2375" }, { projectName: "manual-claude" },
    { containerId: "relmio-claude" }, { installDirectory: "/tmp/other" }]) {
    const f = fixture(); const attest = f.args.attestInstallation;
    f.args.attestInstallation = async () => ({ ...await attest(), ...change });
    await assert.rejects(() => runClaudeCompanionLogin(f.args));
    assert.equal(f.calls.some(value => typeof value === "object"), false);
    assert.equal(f.calls.at(-1), "release");
  }
  const failed = fixture({ spawnProcess: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 1)); return child; },
    readAuthStatus: () => assert.fail("status must not follow failed login") });
  await assert.rejects(() => runClaudeCompanionLogin(failed.args), /not completed/u);
  assert.equal(failed.calls.at(-1), "release");
});
