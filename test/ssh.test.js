import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildVerifiedConnectionConfig, connectVerified, formatSha256Fingerprint,
  getSshCapabilities, resolveSshAgent, scanHostFingerprint,
} from "../src/infrastructure/ssh.js";
import {
  ADMIN_PROBE, BUILDER_STATE_PROBE, LOGIN_PROBE, administrativeCommand, parseAdministrativeProbe,
  parseLoginUid, quoteShell, validateModelUpload,
} from "../src/infrastructure/ssh-administration.js";
import { withVpsOperationLock } from "../src/services/vps-operation-lock.js";
import { VPS_OPERATION_LOCKS } from "../src/domain/vps-build-state.js";

const digest = "ab".repeat(32);
const fingerprint = formatSha256Fingerprint(digest);
const options = { host: "vps.example.test", port: 22, username: "root", password: "fixture-password", useAgent: false, privilege: "root", expectedFingerprint: fingerprint };
const modelPath = "/docker/n8n-openai-oauth/local-model/catalog.mjs";
const adminResult = (info = {}) => ({ code: 0, stdout: `0\nunix:///var/run/docker.sock\n/usr/bin/docker\ndefault\n${JSON.stringify({ OSType: "linux", ServerVersion: "28.0.1", SecurityOptions: ["name=seccomp,profile=builtin"], ...info })}\n2.39.2\ndefault\n`, stderr: "" });

function resultChannel(result) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.write = () => true;
  stream.destroy = () => {};
  stream.end = () => queueMicrotask(() => {
    stream.emit("data", Buffer.from(result.stdout));
    stream.stderr.emit("data", Buffer.from(result.stderr ?? ""));
    stream.emit("close", result.code);
  });
  return stream;
}

// Authentication/attestation fixtures are injected; actual consumer commands
// execute in a real local shell. This is not a claim of live SSH/sudo success.
function processChannel(command) {
  // Remote Linux ownership/context attestation is injected, like UID probes;
  // stdin, shell quoting, process output and backpressure remain real.
  command = command.replaceAll(quoteShell(BUILDER_STATE_PROBE).slice(1, -1), ":");
  const child = spawn("/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
  const stream = new EventEmitter();
  stream.stderr = child.stderr;
  stream.write = chunk => child.stdin.write(chunk);
  stream.end = () => child.stdin.end();
  stream.destroy = () => child.kill();
  child.stdin.on("drain", () => stream.emit("drain"));
  child.stdin.on("error", error => stream.emit("error", error));
  child.stdout.on("data", data => stream.emit("data", data));
  child.on("error", error => stream.emit("error", error));
  child.on("close", code => stream.emit("close", code));
  return stream;
}

class BoundaryClient extends EventEmitter {
  constructor({ uid = 0, admin = adminResult(), execute = processChannel, hostDigest = digest } = {}) {
    super();
    Object.assign(this, { uid, admin, execute, hostDigest, calls: [] });
  }
  connect(config) {
    this.config = config;
    queueMicrotask(() => config.hostVerifier(this.hostDigest)
      ? this.emit("ready") : this.emit("error", new Error("untrusted host")));
  }
  exec(command, callback) {
    this.calls.push(command);
    if (command === LOGIN_PROBE) callback(null, resultChannel({ code: 0, stdout: `${this.uid}\n` }));
    else if (["root", "sudo-n"].some(mode => command === administrativeCommand(ADMIN_PROBE, mode))) callback(null, resultChannel(this.admin));
    else callback(null, this.execute(command));
  }
  sftp(callback) {
    callback(null, Object.assign(new EventEmitter(), {
      writeFile: (path, bytes, opts, done) => { this.uploaded = { path, bytes, opts }; done(); },
      end() {},
    }));
  }
  end() { this.ended = true; }
}
const connect = (client, changes = {}) => connectVerified({ ...options, ...changes }, { createClient: () => client });

test("fingerprint comparison pins the SSH host before commands", async () => {
  const config = buildVerifiedConnectionConfig(options);
  assert.equal(config.hostVerifier(digest), true);
  assert.equal(config.hostVerifier("cd".repeat(32)), false);
  assert.equal(config.hostVerifier("not-a-digest"), false);
  const client = new BoundaryClient({ hostDigest: "cd".repeat(32) });
  await assert.rejects(() => connect(client), /confirmed fingerprint/u);
  assert.deepEqual(client.calls, []);
  assert.equal(client.ended, true);
});

test("authentication is explicit and exclusive with no forwarding or fallback", () => {
  const { password: _password, ...base } = options;
  assert.throws(() => buildVerifiedConnectionConfig({ ...base, useAgent: false }), /password/u);
  assert.throws(() => buildVerifiedConnectionConfig({ ...options, useAgent: true }, { agent: "/fixture/agent" }), /exclusive/u);
  assert.throws(() => buildVerifiedConnectionConfig({ ...base, useAgent: true, password: undefined }, { agent: "/fixture/agent" }), /exclusive/u);
  assert.throws(() => buildVerifiedConnectionConfig({ ...options, agent: "/browser/path" }), /explicit/u);
  assert.throws(() => buildVerifiedConnectionConfig({ ...options, useAgent: undefined }), /explicit/u);
  assert.throws(() => buildVerifiedConnectionConfig(options, { agent: "/fixture/agent" }), /exclusive/u);
  const agent = buildVerifiedConnectionConfig({ ...base, useAgent: true }, { agent: "/fixture/agent" });
  assert.deepEqual(agent.authHandler, ["agent"]);
  assert.equal(Object.hasOwn(agent, "password"), false);
  assert.equal(agent.agentForward, false);
  assert.equal(agent.tryKeyboard, false);
  assert.deepEqual(buildVerifiedConnectionConfig(options).authHandler, ["password"]);
});

test("mixed authentication is rejected before agent resolution", async () => {
  let resolved = false;
  await assert.rejects(() => connectVerified({ ...options, useAgent: true }, { resolveAgent: async () => { resolved = true; } }), /exclusive/u);
  assert.equal(resolved, false);
});

test("agent resolver exposes no address or keys and requires a real socket kind", async () => {
  const configured = await resolveSshAgent({ platform: "linux", env: { SSH_AUTH_SOCK: "/private/agent" }, stat: async () => ({ isSocket: () => true }) });
  assert.equal(configured.agent, "/private/agent");
  assert.deepEqual(configured.capability, { agent: { status: "configured", transport: "unix-socket", verification: "untested" } });
  const absent = await getSshCapabilities({ platform: "linux", env: { SSH_AUTH_SOCK: "/regular/file" }, stat: async () => ({ isSocket: () => false }) });
  assert.deepEqual(absent, { agent: { status: "unavailable", transport: null, verification: "untested" } });
});

test("native Windows agent selection probes only the standard OpenSSH pipe", async () => {
  const addresses = [];
  const available = await resolveSshAgent({ platform: "win32", env: { SSH_AUTH_SOCK: "pageant" }, probePipe: async address => { addresses.push(address); return true; } });
  assert.deepEqual(addresses, ["\\\\.\\pipe\\openssh-ssh-agent"]);
  assert.equal(available.agent, addresses[0]);
  assert.equal(available.capability.agent.transport, "windows-openssh-pipe");
  const absent = await resolveSshAgent({ platform: "win32", probePipe: async () => false });
  assert.equal(absent.agent, null);
  assert.equal(absent.capability.agent.status, "unavailable");
});

test("administrative attestation rejects forged UIDs, remote and rootless engines", () => {
  assert.equal(parseLoginUid({ code: 0, stdout: "1000\n" }), 1000);
  for (const stdout of ["-1", "01", "0\n0", "4294967295", "root", " 0"]) {
    assert.throws(() => parseLoginUid({ code: 0, stdout }), /verified Linux root/u);
  }
  assert.throws(() => parseLoginUid({ code: 1, stdout: "0\n" }), /verified Linux root/u);
  assert.deepEqual(parseAdministrativeProbe(adminResult()), { endpoint: "unix:///var/run/docker.sock", binary: "/usr/bin/docker", builder: "default" });
  for (const result of [
    adminResult({ SecurityOptions: ["name=rootless"] }),
    adminResult({ ServerVersion: "5.0.0", OperatingSystem: "Podman Engine" }),
    adminResult({ OSType: "windows" }),
    { ...adminResult(), stdout: adminResult().stdout.replace("unix:///var/run/docker.sock", "ssh://other") },
    { ...adminResult(), stdout: adminResult().stdout.replace("/usr/bin/docker", "/home/user/docker;evil") },
  ]) assert.throws(() => parseAdministrativeProbe(result), /local rootful Docker/u);
});

test("administrative prerequisite failures identify the missing capability without remote diagnostics", () => {
  for (const [code, category] of [[70, /Linux/u], [71, /UID 0/u], [72, /GNU/u],
    [73, /existing.*\/docker/u], [74, /Docker CLI/u], [75, /context/u],
    [76, /Engine/u], [77, /Compose/u], [78, /selectors/u], [79, /builder/u], [1, /passwordless/u]]) {
    assert.throws(() => parseAdministrativeProbe({ code, stdout: "private-output", stderr: "private-policy" }),
      error => category.test(error.message) && !/private-output|private-policy/u.test(error.message));
  }
});

test("prepared identity records attested UID instead of trusting the username", async () => {
  const client = new BoundaryClient({ uid: 1000 });
  const remote = await connect(client, { username: "ubuntu", privilege: "sudo-n" });
  assert.deepEqual(remote.identity, { host: options.host, port: 22, fingerprint, username: "ubuntu", authentication: "password", privilege: "sudo-n", loginUid: 1000, effectiveUid: 0 });
  assert.equal(remote.scope, "local-model-only");
  assert.throws(() => { remote.identity.effectiveUid = 1000; }, TypeError);
  assert.throws(() => { remote.identity = {}; }, TypeError);
  assert.throws(() => { remote.scope = "vps"; }, TypeError);
  remote.close();
  assert.equal(client.ended, true);
  const nonroot = new BoundaryClient({ uid: 1000 });
  await assert.rejects(() => connect(nonroot), /actual UID 0/u);
  assert.equal(nonroot.calls.length, 1);
  assert.equal(nonroot.ended, true);
  const denied = new BoundaryClient({ uid: 1000, admin: { code: 1, stdout: "", stderr: "fixture-sensitive-sudo-policy" } });
  await assert.rejects(() => connect(denied, { privilege: "sudo-n" }), error => /passwordless/u.test(error.message) && !error.message.includes("fixture-sensitive"));
  assert.equal(denied.ended, true);
});

test("root command stdin is byte bounded and consumed by a real hash process", async () => {
  const client = new BoundaryClient();
  const remote = await connect(client);
  const input = "é".repeat(32768);
  const code = "const c=require('node:crypto').createHash('sha256');process.stdin.on('data',b=>c.update(b));process.stdin.on('end',()=>process.stdout.write(c.digest('hex')))";
  const result = await remote.exec(`${quoteShell(process.execPath)} -e ${quoteShell(code)}`, { input });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, createHash("sha256").update(input).digest("hex"));
  assert.equal(client.calls.some(command => command.includes(input)), false);
  await assert.rejects(() => remote.exec("cat", { input: `${input}x` }), /input is invalid/u);
  remote.close();
});

test("sudo scopes the whole compound command, preserves quoting, and denies stdin", async () => {
  const client = new BoundaryClient({ uid: 1000, execute: command => {
    assert.ok(command.startsWith("/usr/bin/sudo -n -- /bin/sh -c "));
    // Simulate only elevation; the quoted shell/compound command executes.
    return processChannel(command.slice("/usr/bin/sudo -n -- ".length));
  } });
  const remote = await connect(client, { privilege: "sudo-n", username: "ubuntu" });
  const result = await remote.exec("value='a b'; printf '%s' \"$value\" | wc -c; printf 'quoted' >&2; exit 7");
  assert.equal(result.code, 7);
  assert.equal(result.stdout.trim(), "3");
  assert.equal(result.stderr, "quoted");
  const before = client.calls.length;
  await assert.rejects(() => remote.exec("cat", { input: "secret" }), /do not accept stdin/u);
  assert.equal(client.calls.length, before);
  remote.close();
});

test("combined output cap terminates a real producer and hides channel errors", async () => {
  const remote = await connect(new BoundaryClient());
  await assert.rejects(() => remote.exec(`${quoteShell(process.execPath)} -e 'process.stderr.write("x".repeat(1000001))'`), /output exceeded/u);
  remote.close();
  const client = new BoundaryClient({ execute: () => { throw new Error("sensitive-agent-path"); } });
  const failed = await connect(client);
  await assert.rejects(() => failed.exec("anything"), error => error.message === "The VPS refused to start a remote command.");
  failed.close();
});

test("sudo upload allowlist excludes credentials, traversal, extra files and unsafe modes", () => {
  const bytes = Buffer.alloc(1_000_000);
  assert.equal(validateModelUpload(modelPath, bytes, 0o600), bytes);
  for (const path of ["/docker/n8n-openai-oauth/auth/auth.json", `${modelPath}/extra`, modelPath.replace("catalog.mjs", "../catalog.mjs"), modelPath.replace("catalog.mjs", "secret.json")]) {
    assert.throws(() => validateModelUpload(path, "data", 0o600), /public local-model/u);
  }
  assert.throws(() => validateModelUpload(modelPath, "data", 0o644), /0600/u);
  assert.throws(() => validateModelUpload(modelPath, "é".repeat(500001), 0o600), /safety limit/u);
  assert.throws(() => validateModelUpload(modelPath.replace("catalog.mjs", ".managed-by-relmio.json.next"), "x".repeat(16385), 0o600), /safety limit/u);
});

test("sudo upload streams a bounded binary payload under backpressure and reports failure honestly", async () => {
  const payload = Buffer.alloc(1_000_000, 0xab);
  const expected = createHash("sha256").update(payload).digest("hex");
  let stalls = 0;
  const code = `const h=require("node:crypto").createHash("sha256");let n=0;process.stdin.on("data",b=>{n+=b.length;h.update(b)});process.stdin.on("end",()=>process.exit(n===1000000&&h.digest("hex")==="${expected}"?0:9))`;
  const client = new BoundaryClient({ uid: 1000, execute: () => {
    const stream = processChannel(`${quoteShell(process.execPath)} -e ${quoteShell(code)}`);
    const write = stream.write;
    stream.write = chunk => {
      assert.ok(chunk.length <= 16384);
      // Force deterministic asynchronous drain while keeping a real hash sink.
      const writable = write(chunk);
      stalls += 1;
      if (writable) setImmediate(() => stream.emit("drain"));
      return false;
    };
    return stream;
  } });
  const remote = await connect(client, { privilege: "sudo-n" });
  await remote.upload(modelPath, payload);
  assert.ok(stalls > 1);
  assert.equal(client.uploaded, undefined);
  remote.close();
  const failed = await connect(new BoundaryClient({ uid: 1000, execute: () => resultChannel({ code: 1, stdout: "", stderr: "private-policy-details" }) }), { privilege: "sudo-n" });
  await assert.rejects(() => failed.upload(modelPath, "public"), error =>
    /partial managed file/u.test(error.message) && !error.message.includes("private-policy"));
  failed.close();
});

test("root retains SFTP secret uploads without granting sudo the same capability", async () => {
  const root = new BoundaryClient();
  const remote = await connect(root);
  const path = "/docker/n8n-openai-oauth/auth/auth.json";
  await remote.upload(path, "fixture-secret");
  assert.equal(root.uploaded.path, path);
  assert.equal(root.uploaded.bytes.toString(), "fixture-secret");
  assert.equal(root.uploaded.opts.mode, 0o600);
  assert.throws(() => remote.upload("/docker/n8n/docker-compose.yml", "bad"), /sidecar directory/u);
  assert.throws(() => remote.upload(path, Buffer.alloc(1_000_001)), /safety limit/u);
  remote.close();
  const sudo = new BoundaryClient({ uid: 1000 });
  const scoped = await connect(sudo, { privilege: "sudo-n" });
  assert.throws(() => scoped.upload(path, "fixture-secret"), /public local-model/u);
  assert.equal(sudo.uploaded, undefined);
  scoped.close();
});

test("fingerprint scanning never configures an authentication method", async () => {
  const client = new BoundaryClient();
  const found = await scanHostFingerprint(options, { createClient: () => client });
  assert.equal(found, fingerprint);
  assert.equal(Object.hasOwn(client.config, "password"), false);
  assert.equal(Object.hasOwn(client.config, "agent"), false);
  assert.deepEqual(client.calls, []);
});

test("Podman migration host metadata does not impersonate the engine implementation", () => {
  const engine = parseAdministrativeProbe(adminResult({ Name: "podman-migration", Labels: ["migrated-from=podman"] }));
  assert.equal(engine.endpoint, "unix:///var/run/docker.sock");
  assert.throws(() => parseAdministrativeProbe(adminResult({ OperatingSystem: "Podman Engine" })), /Podman/u);
});

test("unattested builder selection is rejected and inherited builder overrides cannot run a command", () => {
  const original = adminResult();
  const prefix = original.stdout.split("\n").slice(0, 6).join("\n");
  assert.throws(() => parseAdministrativeProbe({ ...original, stdout: `${prefix}\nremote-ci\n` }), /builder/u);
  const engine = parseAdministrativeProbe(adminResult());
  const selectors = ["BUILDX_BUILDER", "BUILDX_CONFIG", "BUILDKIT_HOST", "DOCKER_CONFIG", "COMPOSE_BAKE"];
  const base = { ...process.env };
  for (const name of selectors) delete base[name];
  for (const name of selectors) {
    const result = spawnSync("/bin/sh", ["-c", administrativeCommand("printf must-not-run", "root", engine)],
      { env: { ...base, [name]: "remote-ci" }, encoding: "utf8" });
    assert.equal(result.status, 78);
    assert.equal(result.stdout, "");
  }
});

test("disabled or invalid BuildKit selection cannot reach the command", () => {
  const env = { ...process.env };
  for (const name of ["BUILDX_BUILDER", "BUILDX_CONFIG", "BUILDKIT_HOST", "DOCKER_CONFIG", "COMPOSE_BAKE"]) delete env[name];
  for (const value of ["0", "false", "unexpected", "1"]) {
    const result = spawnSync("/bin/sh", ["-c", administrativeCommand('printf "%s" "$((6 * 7))"', "root")],
      { env: { ...env, DOCKER_BUILDKIT: value }, encoding: "utf8" });
    assert.equal(result.status, value === "1" ? 0 : 78);
    assert.equal(result.stdout, value === "1" ? "42" : "");
  }
});

test("root SFTP rejects interrupted WRITE without waiting for an impossible CLOSE reply", { timeout: 2000 }, async () => {
  for (const [source, event] of [["channel", "end"], ["channel", "close"], ["channel", "error"], ["client", "close"], ["client", "error"]]) {
    const client = new BoundaryClient();
    let channel;
    client.sftp = callback => {
      channel = Object.assign(new EventEmitter(), {
        end() {},
        writeFile() { queueMicrotask(() => (source === "client" ? client : channel).emit(event, new Error("private-diagnostic"))); },
      });
      callback(null, channel);
    };
    const remote = await connect(client);
    await assert.rejects(() => remote.upload("/docker/n8n-openai-oauth/auth/auth.json", "secret"),
      error => /interrupted/u.test(error.message) && !error.message.includes("private-diagnostic"));
    channel.emit("error", new Error("late-error"));
    remote.close();
  }
});

test("a fingerprint scan rejects clean disconnects before a host key", { timeout: 2000 }, async () => {
  for (const event of ["end", "close"]) {
    const client = new BoundaryClient();
    client.connect = () => queueMicrotask(() => client.emit(event));
    await assert.rejects(() => scanHostFingerprint(options, { createClient: () => client }), /host key/u);
    assert.equal(client.ended, true);
  }
});

test("read-only preparation has a finite deadline even when SSH remains responsive", { timeout: 2000 }, async () => {
  const client = new BoundaryClient();
  client.exec = (_, callback) => {
    const channel = resultChannel({ code: 0, stdout: "" });
    channel.end = () => {};
    callback(null, channel);
  };
  await assert.rejects(() => connectVerified(options, { createClient: () => client, prepareTimeoutMs: 10 }), /probes timed out/u);
  assert.equal(client.ended, true);
});

test("an SSH channel without an integer exit status rejects with unknown outcome", async () => {
  for (const code of [undefined, null, "0"]) {
    const remote = await connect(new BoundaryClient({
      execute: () => resultChannel({ code, stdout: "private-remote-diagnostic" }),
    }));
    await assert.rejects(() => remote.exec("fixture-command"), error =>
      /outcome is unknown/u.test(error.message) && !error.message.includes("private-remote-diagnostic"));
    remote.close();
  }
});

test("statusless SSH build closure retains the operation lease and never starts cleanup", async () => {
  let executions = 0;
  let cleanupAttempted = false;
  const client = new BoundaryClient({ uid: 1000, execute: () => {
    executions += 1;
    if (executions === 1) return resultChannel({ code: 0, stdout: "7:11\n" });
    if (executions === 2) return resultChannel({ code: 0, stdout: "7:12\n" });
    if (executions === 3) return resultChannel({ code: undefined, stdout: "" });
    cleanupAttempted = true;
    return resultChannel({ code: 0, stdout: "" });
  } });
  const remote = await connect(client, { privilege: "sudo-n", username: "ubuntu" });
  await assert.rejects(() => withVpsOperationLock(remote, VPS_OPERATION_LOCKS.model,
    build => build("docker compose --project-name fixture --file /docker/n8n-openai-oauth/local-model/compose.yaml build acquisition")),
  error => {
    assert.equal(error.operationLockRetained, true);
    assert.match(error.message, /outcome is unknown/u);
    assert.match(error.safeMessage, /administrator must inspect/u);
    return true;
  });
  assert.equal(executions, 3);
  assert.equal(cleanupAttempted, false);
  remote.close();
});

test("statusless compose up after a successful build retains build state and lease without attempting cleanup", async () => {
  let executions = 0;
  const client = new BoundaryClient({ uid: 1000, execute: () => {
    executions += 1;
    if (executions === 1) return resultChannel({ code: 0, stdout: "7:11\n" });
    if (executions === 2) return resultChannel({ code: 0, stdout: "7:12\n" });
    if (executions === 3) return resultChannel({ code: 0, stdout: "" });
    if (executions === 4) return resultChannel({ code: undefined, stdout: "private-remote-diagnostic" });
    throw new Error("Cleanup was attempted");
  } });
  const remote = await connect(client, { privilege: "sudo-n", username: "ubuntu" });
  await assert.rejects(() => withVpsOperationLock(remote, VPS_OPERATION_LOCKS.model, async build => {
    await build("docker compose --project-name fixture --file /docker/n8n-openai-oauth/local-model/compose.yaml build acquisition");
    await remote.exec("docker compose --project-name fixture --file /docker/n8n-openai-oauth/local-model/compose.yaml up -d --no-build");
  }), error => {
    assert.equal(error.remoteOutcomeUnknown, true);
    assert.equal(error.operationLockRetained, true);
    assert.match(error.safeMessage, /administrator must inspect/u);
    assert.doesNotMatch(`${error.message} ${error.safeMessage}`, /private-remote-diagnostic/u);
    return true;
  });
  assert.equal(executions, 4);
  remote.close();
});

test("interrupted SFTP upload retains the lease even when cleanup commands would succeed", async () => {
  let executions = 0;
  const client = new BoundaryClient({ execute: () => {
    executions += 1;
    if (executions === 1) return resultChannel({ code: 0, stdout: "7:11\n" });
    return resultChannel({ code: 0, stdout: "" });
  } });
  client.sftp = callback => callback(null, Object.assign(new EventEmitter(), {
    end() {},
    writeFile(_path, _bytes, _options, done) { done(new Error("private-upload-diagnostic")); },
  }));
  const remote = await connect(client);
  await assert.rejects(() => withVpsOperationLock(remote, VPS_OPERATION_LOCKS.model,
    () => remote.upload("/docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next", "public")),
  error => {
    assert.equal(error.remoteOutcomeUnknown, true);
    assert.equal(error.operationLockRetained, true);
    assert.match(error.safeMessage, /administrator must inspect/u);
    assert.doesNotMatch(`${error.message} ${error.safeMessage}`, /private-upload-diagnostic/u);
    return true;
  });
  assert.equal(executions, 1);
  remote.close();
});

test("SFTP setup failure before a write can release the lease", async () => {
  let executions = 0;
  const client = new BoundaryClient({ execute: () => {
    executions += 1;
    return resultChannel({ code: 0, stdout: executions === 1 ? "7:11\n" : "" });
  } });
  client.sftp = callback => callback(new Error("private-setup-diagnostic"));
  const remote = await connect(client);
  await assert.rejects(() => withVpsOperationLock(remote, VPS_OPERATION_LOCKS.model,
    () => remote.upload("/docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next", "public")),
  error => {
    assert.notEqual(error.remoteOutcomeUnknown, true);
    assert.notEqual(error.operationLockRetained, true);
    assert.doesNotMatch(error.message, /private-setup-diagnostic/u);
    return true;
  });
  assert.equal(executions, 2);
  remote.close();
});

test("sudo model upload preserves unknown outcome across its sanitized wrapper", async () => {
  let executions = 0;
  const client = new BoundaryClient({ uid: 1000, execute: () => {
    executions += 1;
    return resultChannel(executions === 1
      ? { code: 0, stdout: "7:11\n" }
      : { code: undefined, stdout: "private-upload-output" });
  } });
  const remote = await connect(client, { privilege: "sudo-n", username: "ubuntu" });
  await assert.rejects(() => withVpsOperationLock(remote, VPS_OPERATION_LOCKS.model,
    () => remote.upload(modelPath, "public")),
  error => error.remoteOutcomeUnknown === true && error.operationLockRetained === true &&
    !`${error.message} ${error.safeMessage}`.includes("private-upload-output"));
  assert.equal(executions, 2);
  remote.close();
});

test("verified nonzero remote command and rejected upload release the lease", async () => {
  for (const upload of [false, true]) {
    let executions = 0;
    const client = new BoundaryClient({ uid: 1000, execute: () => {
      executions += 1;
      return resultChannel(executions === 1
        ? { code: 0, stdout: "7:11\n" }
        : { code: executions === 2 ? 71 : 0, stdout: "", stderr: "private-diagnostic" });
    } });
    const remote = await connect(client, { privilege: "sudo-n", username: "ubuntu" });
    await assert.rejects(() => withVpsOperationLock(remote, VPS_OPERATION_LOCKS.model, async () => {
      if (upload) await remote.upload(modelPath, "public");
      else {
        const result = await remote.exec("fixture-command");
        if (result.code !== 0) throw new Error("Confirmed operation failed.");
      }
    }), error => {
      assert.notEqual(error.remoteOutcomeUnknown, true);
      assert.notEqual(error.operationLockRetained, true);
      assert.doesNotMatch(error.message, /private-diagnostic/u);
      return true;
    });
    assert.equal(executions, 3);
    remote.close();
  }
});
