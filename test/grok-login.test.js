import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runGrokBuildLogin } from "../src/services/grok-login.js";
import { acquireLocalEndpointChangeLock } from "../src/services/local-installer.js";

const request = {
  action: "device-auth", installDirectory: "/private/relmio/local/xai-grok-build",
  dockerHost: "unix:///var/run/docker.sock",
  projectName: "relmio-xai-grok-build-0123456789abcdef0123456789abcdef",
  isTTY: true, environment: { PATH: "/usr/bin", LANG: "C", DOCKER_HOST: "tcp://attacker.example" },
};

const attestation = {
  installDirectory: request.installDirectory,
  dockerHost: request.dockerHost,
  projectName: request.projectName,
};

test("Grok Build device login runs the exact managed Compose service with a private bounded static command", async () => {
  const calls = []; let released = false;
  const result = await runGrokBuildLogin({ ...request, resolveInstallRoot: async () => request.installDirectory, attestInstallation: async () => attestation, acquireLock: async () => async () => { released = true; }, spawnProcess(command, args, options) {
    calls.push({ command, args, options }); const child = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit("close", 1)); return true; }; queueMicrotask(() => child.emit("close", 0)); return child;
  } });
  assert.deepEqual(result, { action: "device-auth", success: true }); assert.equal(released, true);
  assert.deepEqual(calls, [{ command: "docker", args: ["--host", request.dockerHost, "compose", "--project-name", request.projectName, "--file", "docker-compose.yml", "run", "--name", `${request.projectName}-credential-action`, "--rm", "--no-deps", "--pull", "never", "--entrypoint", "/bin/sh", "grok-build", "-c", "umask 077; exec /usr/bin/timeout --signal=TERM --kill-after=2s 900s grok --no-auto-update login --device-auth"], options: { cwd: request.installDirectory, env: { PATH: "/usr/bin", LANG: "C" }, shell: false, stdio: "inherit", windowsHide: true } }]);
});

test("Grok Build login rejects non-TTY access, foreign targets, and undeclared commands", async () => {
  const dependencies = { resolveInstallRoot: async () => request.installDirectory, acquireLock: async () => async () => {}, attestInstallation: async () => attestation };
  await assert.rejects(() => runGrokBuildLogin({ ...request, ...dependencies, isTTY: false }), /interactive terminal/u);
  await assert.rejects(() => runGrokBuildLogin({ ...request, ...dependencies, action: "exec" }), /action/u);
  await assert.rejects(() => runGrokBuildLogin({ ...request, ...dependencies, attestInstallation: async () => ({ ...attestation, projectName: "relmio-codex-chat-0123456789abcdef0123456789abcdef" }) }), /attested/u);
});

test("Grok Build login cannot spawn before managed installation attestation", async () => {
  let spawned = false;
  await assert.rejects(() => runGrokBuildLogin({ ...request, resolveInstallRoot: async () => request.installDirectory, acquireLock: async () => async () => {}, attestInstallation: async () => { throw new Error("missing"); }, spawnProcess() { spawned = true; } }), /attested/u);
  assert.equal(spawned, false);
});

test("Grok Build login locks only the canonical environment-managed install root", async () => {
  let locked = false; let attested = false;
  await assert.rejects(() => runGrokBuildLogin({ ...request, resolveInstallRoot: async () => "/private/other/.relmio/local/xai-grok-build", acquireLock: async () => { locked = true; return async () => {}; }, attestInstallation: async () => { attested = true; return attestation; } }), /attested/u);
  assert.equal(locked, false); assert.equal(attested, false);
});

test("Grok Build login validates lifecycle controls before lock or spawn", async () => {
  const controller = new AbortController(); controller.abort(); let locked = false; let spawned = false;
  await assert.rejects(() => runGrokBuildLogin({ ...request, signal: controller.signal, acquireLock: async () => { locked = true; return async () => {}; }, spawnProcess: () => { spawned = true; } }), /not completed/u);
  await assert.rejects(() => runGrokBuildLogin({ ...request, loginTimeoutMs: 0, acquireLock: async () => { locked = true; return async () => {}; }, spawnProcess: () => { spawned = true; } }), /invalid/u);
  await assert.rejects(() => runGrokBuildLogin({ ...request, logoutTimeoutMs: 0, acquireLock: async () => { locked = true; return async () => {}; }, spawnProcess: () => { spawned = true; } }), /invalid/u);
  assert.equal(locked, false); assert.equal(spawned, false);
});

test("Grok Build login aborts or times out once, waits for reap, and retains its lock", async (t) => {
  for (const mode of ["abort", "timeout", "abort-zero-exit"]) await t.test(mode, async () => {
    const controller = new AbortController(); const signals = []; let released = false;
    let spawned;
    const childSpawned = new Promise((resolve) => { spawned = resolve; });
    const pending = runGrokBuildLogin({ ...request, signal: controller.signal, loginTimeoutMs: mode === "timeout" ? 1 : 1000, terminationGraceMs: 10, resolveInstallRoot: async () => request.installDirectory, attestInstallation: async () => attestation, acquireLock: async () => async () => { released = true; }, spawnProcess() {
      const child = new EventEmitter(); child.kill = (name) => { signals.push(name); queueMicrotask(() => child.emit("close", mode === "abort-zero-exit" ? 0 : 1)); return true; }; spawned(); return child;
    } });
    if (mode.startsWith("abort")) { await childSpawned; controller.abort(); }
    await assert.rejects(() => pending, /not completed/u);
    assert.deepEqual(signals, ["SIGTERM"]); assert.equal(released, false);
  });
});

test("Grok Build login retains its lock when an ignored termination cannot be reaped", async () => {
  const signals = []; let released = false;
  await assert.rejects(() => runGrokBuildLogin({ ...request, loginTimeoutMs: 1, terminationGraceMs: 1, resolveInstallRoot: async () => request.installDirectory, attestInstallation: async () => attestation, acquireLock: async () => async () => { released = true; }, spawnProcess() {
    const child = new EventEmitter(); child.kill = (name) => { signals.push(name); return true; }; return child;
  } }), /not completed/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]); assert.equal(released, false);
});

test("Grok Build login retains its lock after SIGKILL and a late Compose CLI close", async () => {
  const signals = []; let released = false;
  await assert.rejects(() => runGrokBuildLogin({ ...request, loginTimeoutMs: 1, terminationGraceMs: 1, resolveInstallRoot: async () => request.installDirectory, attestInstallation: async () => attestation, acquireLock: async () => async () => { released = true; }, spawnProcess() {
    const child = new EventEmitter(); child.kill = (name) => { signals.push(name); if (name === "SIGKILL") queueMicrotask(() => child.emit("close", 1)); return true; }; return child;
  } }), /not completed/u);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(released, false);
});

test("Grok Build login retains its lock when a live child emits an error without close", async () => {
  let released = false;
  await assert.rejects(() => runGrokBuildLogin({ ...request, resolveInstallRoot: async () => request.installDirectory, attestInstallation: async () => attestation, acquireLock: async () => async () => { released = true; }, spawnProcess() {
    const child = new EventEmitter(); child.kill = () => true; queueMicrotask(() => child.emit("error", new Error("fixture"))); return child;
  } }), /not completed/u);
  assert.equal(released, false);
});

test("a durable one-off container identity blocks a replacement after stale parent-lock recovery", async (t) => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "relmio-grok-lock-"));
  t.after(() => rm(temporaryHome, { recursive: true, force: true }));
  const home = await realpath(temporaryHome);
  const installDirectory = join(home, ".relmio", "local", "xai-grok-build");
  const environment = { RELMIO_HOME: join(home, ".relmio") };
  let processId = 41_001;
  let lockAcquisitions = 0;
  let liveContainerName;
  let credentialActions = 0;
  const containerNames = [];
  const acquireLock = async (lockRequest, options) => {
    lockAcquisitions += 1;
    const ownerProcessId = processId;
    processId += 1;
    return acquireLocalEndpointChangeLock(lockRequest, {
      ...options,
      processId: ownerProcessId,
      isProcessAlive: (candidate) => candidate === ownerProcessId,
    });
  };
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.kill = () => true;
    const containerName = args[args.indexOf("--name") + 1];
    containerNames.push(containerName);
    if (liveContainerName === containerName) {
      queueMicrotask(() => child.emit("close", 125));
      return child;
    }
    liveContainerName = containerName;
    credentialActions += 1;
    return child;
  };
  const dependencies = {
    ...request,
    installDirectory,
    environment,
    acquireLock,
    attestInstallation: async () => ({ ...attestation, installDirectory }),
    loginTimeoutMs: 1,
    resolveInstallRoot: async () => installDirectory,
    spawnProcess,
    terminationGraceMs: 1,
  };

  await assert.rejects(runGrokBuildLogin(dependencies), /not completed/u);
  await assert.rejects(runGrokBuildLogin(dependencies), /not completed/u);

  assert.equal(lockAcquisitions, 2);
  assert.equal(credentialActions, 1);
  assert.deepEqual(containerNames, [
    `${request.projectName}-credential-action`,
    `${request.projectName}-credential-action`,
  ]);
});

test("Grok Build exposes only its bounded official CLI actions", async () => {
  const expected = {
    "device-auth": "umask 077; exec /usr/bin/timeout --signal=TERM --kill-after=2s 900s grok --no-auto-update login --device-auth",
    logout: "umask 077; exec /usr/bin/timeout --signal=TERM --kill-after=2s 60s grok --no-auto-update logout",
  };
  for (const [action, command] of Object.entries(expected)) {
    const calls = [];
    await runGrokBuildLogin({ ...request, action, isTTY: action === "logout" ? false : true, resolveInstallRoot: async () => request.installDirectory, attestInstallation: async () => attestation, acquireLock: async () => async () => {}, spawnProcess(_command, args) {
      calls.push(args); const child = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit("close", 1)); return true; }; queueMicrotask(() => child.emit("close", 0)); return child;
    } });
    assert.deepEqual(calls[0].slice(-2), ["-c", command]);
    assert.deepEqual(calls[0].slice(calls[0].indexOf("run"), calls[0].indexOf("grok-build") + 1), ["run", "--name", `${request.projectName}-credential-action`, "--rm", "--no-deps", "--pull", "never", "--entrypoint", "/bin/sh", "grok-build"]);
  }
});

test("private n8n sign-in is restricted to its own canonical project and service", async () => {
  const target = "n8n-supergrok-oauth";
  const installDirectory = "/private/relmio/local/n8n-supergrok-oauth";
  const projectName = "relmio-n8n-supergrok-oauth-0123456789abcdef0123456789abcdef";
  const calls = [];
  const dependencies = {
    ...request, target, installDirectory,
    resolveInstallRoot: async (options) => { assert.equal(options.target, target); return installDirectory; },
    acquireLock: async (options) => { assert.deepEqual(options, { target }); return async () => {}; },
    attestInstallation: async () => ({ installDirectory, projectName, dockerHost: request.dockerHost, serviceName: "supergrok-oauth" }),
    spawnProcess(command, args) {
      calls.push(args);
      const child = new EventEmitter(); child.kill = () => true;
      queueMicrotask(() => child.emit("close", 0)); return child;
    },
  };
  await runGrokBuildLogin(dependencies);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes(projectName), true);
  assert.equal(calls[0][calls[0].indexOf("--name") + 1], `${projectName}-credential-action`);
  assert.equal(calls[0].at(-3), "supergrok-oauth");
  for (const badAttestation of [
    { ...attestation, installDirectory },
    { installDirectory, projectName, dockerHost: request.dockerHost, serviceName: "grok-build" },
  ]) {
    await assert.rejects(runGrokBuildLogin({ ...dependencies, attestInstallation: async () => badAttestation }), /attested/u);
  }
  await assert.rejects(runGrokBuildLogin({ ...dependencies, target: "n8n-openai-oauth" }), /target/u);
  assert.equal(calls.length, 1);
});
