import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, lstatSync } from "node:fs";
import { mkdtemp, mkdir, lstat, link, open, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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
// Remote VPS commands are Linux /bin/sh scripts (exit 78, $(( )), printf/wc).
// Native Windows has no /bin/sh. RELMIO_TEST_POSIX_SHELL is the installer opt-in.
// Node stdin/output-cap fixtures stay enabled; those shell scripts cannot.
const posixShell = process.platform === "win32"
  ? (process.env.RELMIO_TEST_POSIX_SHELL || null)
  : "/bin/sh";
const posixExecutionSkip = posixShell
  ? false
  : "Remote VPS command is a POSIX /bin/sh script; native Windows has no /bin/sh unless RELMIO_TEST_POSIX_SHELL is set.";
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
function pipeChannel(child) {
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
function processChannel(command) {
  // Remote Linux ownership/context attestation is injected, like UID probes;
  // stdin, shell quoting, process output and backpressure remain real.
  command = command.replaceAll(quoteShell(BUILDER_STATE_PROBE).slice(1, -1), ":");
  return pipeChannel(spawn(posixShell ?? "/bin/sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] }));
}
function nodeEvalChannel(code) {
  return pipeChannel(spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "pipe"] }));
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

async function managedFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "relmio-sftp-"));
  const handles = new Map();
  t.after(async () => {
    for (const file of handles.values()) await file.close();
    const { rm } = await import("node:fs/promises");
    await rm(root, { recursive: true, force: true });
  });
  const local = remotePath => join(root, remotePath.slice(1));
  await mkdir(local("/docker/n8n-openai-oauth/services"), { recursive: true });
  // The remote is attested Linux root storage. Model its permission bits from
  // SFTP OPEN/FCHMOD/RENAME so the fake behaves the same on hosts without POSIX
  // modes; file type, inode, link count and size stay real local metadata.
  const modes = new Map();
  const remoteMode = (remotePath, stat) =>
    (stat.mode & constants.S_IFMT) | (modes.get(remotePath) ?? (stat.mode & 0o755));
  // Model GNU stat in-process instead of through a host shell. SFTP v3 attrs omit
  // link count; UID 0 represents the attested remote root, not this test user.
  const client = new BoundaryClient({ execute: command => {
    const name = /^\/usr\/bin\/stat -c '%u:%f:%h:%s' -- '([^']+)'$/u.exec(command)?.[1];
    if (!name) return processChannel(command);
    let stat;
    try { stat = lstatSync(local(name)); } catch { return resultChannel({ code: 1, stdout: "" }); }
    return resultChannel({ code: 0, stdout: `0:${remoteMode(name, stat).toString(16)}:${stat.nlink}:${stat.size}\n` });
  } });
  const calls = [];
  const channel = {
    end() { calls.push(["end"]); },
    lstat(remotePath, done) {
      lstat(local(remotePath)).then(stat => done(null, { mode: remoteMode(remotePath, stat), uid: 0, size: stat.size }), done);
    },
    open(remotePath, flags, attrs, done) {
      calls.push(["open", remotePath, flags, attrs.mode]);
      assert.equal(flags & 0x20, 0x20);
      assert.equal(flags & 0x10, 0);
      const handle = Buffer.from(remotePath);
      open(local(remotePath), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, attrs.mode)
        .then(file => { handles.set(handle, file); modes.set(remotePath, attrs.mode & 0o7777); done(null, handle); }, done);
    },
    fchmod(handle, mode, done) {
      handles.get(handle).chmod(mode).then(() => { modes.set(handle.toString(), mode & 0o7777); done(); }, done);
    },
    write(handle, bytes, offset, length, position, done) {
      calls.push(["write", length, position]);
      handles.get(handle).write(bytes, offset, length, position).then(() => done(), done);
    },
    ext_openssh_fsync(handle, done) {
      calls.push(["fsync"]);
      handles.get(handle).sync().then(() => done(), done);
    },
    close(handle, done) {
      calls.push(["close"]);
      handles.get(handle).close().then(() => { handles.delete(handle); done(); }, done);
    },
    ext_openssh_rename(from, to, done) {
      calls.push(["rename", from, to]);
      rename(local(from), local(to)).then(() => {
        modes.set(to, modes.get(from));
        modes.delete(from);
        done();
      }, done);
    },
    writeFile() { assert.fail("Managed publication must never use truncating writeFile."); },
    rename() { assert.fail("Managed publication requires the OpenSSH atomic rename extension."); },
  };
  client.sftp = callback => callback(null, Object.assign(new EventEmitter(), channel));
  return { client, channel, calls, root, local, modeOf: remotePath => modes.get(remotePath) };
}

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
  const input = "é".repeat(32768);
  const code = "const c=require('node:crypto').createHash('sha256');process.stdin.on('data',b=>c.update(b));process.stdin.on('end',()=>process.stdout.write(c.digest('hex')))";
  // The administrative wrapper is a Linux /bin/sh script. Without that shell,
  // still deliver stdin to the same node hash program rather than a mock echo.
  const client = new BoundaryClient(posixShell ? {} : {
    execute: command => {
      assert.equal(command.includes(input), false);
      return nodeEvalChannel(code);
    },
  });
  const remote = await connect(client);
  const result = await remote.exec(`${quoteShell(process.execPath)} -e ${quoteShell(code)}`, { input });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, createHash("sha256").update(input).digest("hex"));
  assert.equal(client.calls.some(command => command.includes(input)), false);
  await assert.rejects(() => remote.exec("cat", { input: `${input}x` }), /input is invalid/u);
  remote.close();
});

test("sudo scopes the whole compound command, preserves quoting, and denies stdin", async (t) => {
  const command = "value='a b'; printf '%s' \"$value\" | wc -c; printf 'quoted' >&2; exit 7";
  await t.test("denies stdin before opening a channel", async () => {
    const client = new BoundaryClient({ uid: 1000, execute: () => {
      throw new Error("must-not-spawn");
    } });
    const remote = await connect(client, { privilege: "sudo-n", username: "ubuntu" });
    const before = client.calls.length;
    await assert.rejects(() => remote.exec("cat", { input: "secret" }), /do not accept stdin/u);
    assert.equal(client.calls.length, before);
    remote.close();
  });
  // printf, wc, and exit 7 are the Linux remote command. A Windows shell cannot
  // execute that script without faking the result or changing production quoting.
  await t.test("preserves quoting through a real POSIX shell", { skip: posixExecutionSkip }, async () => {
    const client = new BoundaryClient({ uid: 1000, execute: received => {
      assert.ok(received.startsWith("/usr/bin/sudo -n -- /bin/sh -c "));
      return processChannel(received.slice("/usr/bin/sudo -n -- ".length));
    } });
    const remote = await connect(client, { privilege: "sudo-n", username: "ubuntu" });
    const result = await remote.exec(command);
    assert.equal(result.code, 7);
    assert.equal(result.stdout.trim(), "3");
    assert.equal(result.stderr, "quoted");
    const before = client.calls.length;
    await assert.rejects(() => remote.exec("cat", { input: "secret" }), /do not accept stdin/u);
    assert.equal(client.calls.length, before);
    remote.close();
  });
});

test("combined output cap terminates a real producer and hides channel errors", async () => {
  const code = 'process.stderr.write("x".repeat(1000001))';
  const remote = await connect(new BoundaryClient(posixShell ? {} : {
    execute: command => {
      assert.match(command, /process\.stderr\.write\("x"\.repeat\(1000001\)\)/u);
      return nodeEvalChannel(code);
    },
  }));
  await assert.rejects(() => remote.exec(`${quoteShell(process.execPath)} -e '${code}'`), /output exceeded/u);
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
    const stream = nodeEvalChannel(code);
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

test("reviewed publication rejects hardlinked targets, child symlinks and linked ancestors without writes", async t => {
  const { client, calls, root, local } = await managedFixture(t);
  const sentinel = join(root, "outside");
  await writeFile(sentinel, "unchanged");
  const compose = "/docker/n8n-openai-oauth/docker-compose.yml";
  await link(sentinel, local(compose));
  const remote = await connect(client);
  t.after(() => remote.close());
  const rejectsWithoutWrite = async target => {
    await assert.rejects(() => remote.publishManagedFile(target, "replacement", 0o644), error =>
      /unsafe/u.test(error.message) && error.remoteOutcomeUnknown !== true);
    assert.equal(calls.some(([call]) => call === "open" || call === "write"), false);
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  };
  await rejectsWithoutWrite(compose);
  const child = "/docker/n8n-openai-oauth/services/linked.mjs";
  await symlink(sentinel, local(child));
  await rejectsWithoutWrite(child);
  await symlink(dirname(sentinel), local("/docker/n8n-openai-oauth/services/linked"));
  await rejectsWithoutWrite("/docker/n8n-openai-oauth/services/linked/child.mjs");
});

test("reviewed publication rejects unsafe ownership, permissions and nonregular targets before staging", async t => {
  const { client, channel, calls, local } = await managedFixture(t);
  const target = "/docker/n8n-openai-oauth/services/child.mjs";
  const original = channel.lstat;
  const remote = await connect(client);
  t.after(() => remote.close());
  for (const parent of ["/", "/docker", "/docker/n8n-openai-oauth", "/docker/n8n-openai-oauth/services"]) {
    for (const change of [{ uid: 1000 }, { mode: constants.S_IFDIR | 0o775 }, { mode: constants.S_IFDIR | 0o757 }]) {
      channel.lstat = (name, done) => original(name, (error, attrs) =>
        done(error, name === parent ? { ...attrs, ...change } : attrs));
      await assert.rejects(() => remote.publishManagedFile(target, "new"), error => error.remoteOutcomeUnknown !== true);
    }
  }
  channel.lstat = original;
  await mkdir(local(target));
  await assert.rejects(() => remote.publishManagedFile(target, "new"), error => error.remoteOutcomeUnknown !== true);
  assert.equal(calls.some(([call]) => call === "open"), false);
});

test("reviewed publication validates root privilege, paths, payloads and deadlines before SFTP setup", async () => {
  const client = new BoundaryClient();
  let setups = 0;
  client.sftp = () => { setups++; };
  const remote = await connect(client);
  try {
    for (const target of ["/docker/n8n/docker-compose.yml", "/docker/n8n-openai-oauth/../outside", "/docker/n8n-openai-oauth/file;touch", "/docker/n8n-openai-oauth/file\nx", "/docker/n8n-openai-oauth"]) {
      await assert.rejects(async () => remote.publishManagedFile(target, "new"), TypeError);
    }
    for (const mode of [0o666, 0o755]) await assert.rejects(async () =>
      remote.publishManagedFile("/docker/n8n-openai-oauth/file", "new", mode), TypeError);
    await assert.rejects(async () => remote.publishManagedFile("/docker/n8n-openai-oauth/file", Buffer.alloc(1_000_001)), TypeError);
    for (const timeoutMs of [0, -1, Infinity, 7_200_001, "100"]) {
      await assert.rejects(async () => remote.publishManagedFile("/docker/n8n-openai-oauth/file", "new", 0o600, { timeoutMs }), TypeError);
    }
    assert.equal(setups, 0);
  } finally { remote.close(); }
  const sudo = new BoundaryClient({ uid: 1000 });
  sudo.sftp = () => assert.fail("Sudo must not open a managed SFTP publication.");
  const scoped = await connect(sudo, { privilege: "sudo-n" });
  try { await assert.rejects(async () => scoped.publishManagedFile("/docker/n8n-openai-oauth/file", "new"), /root/u); }
  finally { scoped.close(); }
});

test("reviewed publication stages exclusively, fsyncs and atomically replaces only the destination inode", async t => {
  const { client, calls, local, modeOf } = await managedFixture(t);
  const target = "/docker/n8n-openai-oauth/docker-compose.yml";
  await writeFile(local(target), "old");
  const before = await lstat(local(target));
  const remote = await connect(client);
  t.after(() => remote.close());
  const payload = Buffer.alloc(40_000, 0xab);
  await remote.publishManagedFile(target, payload, 0o644);
  const staged = calls.find(([call]) => call === "open")[1];
  assert.equal(dirname(staged), dirname(target));
  assert.notEqual(staged, target);
  assert.notEqual((await lstat(local(target))).ino, before.ino);
  assert.equal(modeOf(target), 0o644);
  assert.deepEqual(await readFile(local(target)), payload);
  assert.equal(calls.filter(([call]) => call === "open").length, 1);
  assert.equal(calls.filter(([call]) => call === "rename").length, 1);
  assert.deepEqual(calls.filter(([call]) => ["fsync", "close", "rename"].includes(call)).map(([call]) => call), ["fsync", "close", "rename"]);
  assert.ok(calls.filter(([call]) => call === "write").every(([, length]) => length <= 16_384));
  await assert.rejects(() => lstat(local(staged)), { code: "ENOENT" });
});

test("publication rechecks target links and retains staged bytes after a late safety failure", async t => {
  const { client, channel, calls, root, local } = await managedFixture(t);
  const sentinel = join(root, "outside");
  const target = "/docker/n8n-openai-oauth/Dockerfile";
  await writeFile(sentinel, "unchanged");
  const close = channel.close;
  channel.close = (handle, done) => close(handle, error => {
    if (error) return done(error);
    link(sentinel, local(target)).then(() => done(), done);
  });
  const remote = await connect(client);
  t.after(() => remote.close());
  let failure;
  await assert.rejects(() => remote.publishManagedFile(target, "staged", 0o644), error => {
    failure = error;
    return error.remoteOutcomeUnknown === true;
  });
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  assert.equal(await readFile(local(failure.tempPath), "utf8"), "staged");
  assert.equal(calls.some(([call]) => call === "rename"), false);
});

test("publication rechecks staged link count before atomic rename", async t => {
  const { client, channel, calls, root, local } = await managedFixture(t);
  const target = "/docker/n8n-openai-oauth/Dockerfile";
  const close = channel.close;
  channel.close = (handle, done) => close(handle, error => {
    if (error) return done(error);
    const staged = calls.find(([call]) => call === "open")[1];
    link(local(staged), join(root, "outside-link")).then(() => done(), done);
  });
  const remote = await connect(client);
  t.after(() => remote.close());
  let failure;
  await assert.rejects(() => remote.publishManagedFile(target, "staged"), error => {
    failure = error;
    return error.remoteOutcomeUnknown === true;
  });
  assert.equal(await readFile(local(failure.tempPath), "utf8"), "staged");
  assert.equal(calls.some(([call]) => call === "rename"), false);
  await assert.rejects(() => lstat(local(target)), { code: "ENOENT" });
});

test("refused exclusive OPEN reports no remote effect, but lost OPEN acknowledgment remains uncertain", { timeout: 5000 }, async t => {
  const { client, channel, calls, local } = await managedFixture(t);
  const target = "/docker/n8n-openai-oauth/Dockerfile";
  const exclusiveOpen = channel.open;
  channel.open = (_name, _flags, _attrs, done) => done(Object.assign(new Error("private-policy"), { code: 3 }));
  const remote = await connect(client);
  t.after(() => remote.close());
  await assert.rejects(() => remote.publishManagedFile(target, "staged"), error =>
    error.remoteOutcomeUnknown !== true && error.tempPath === undefined && !error.message.includes("private-policy"));
  assert.equal(calls.some(([call]) => call === "write"), false);
  channel.open = (name, flags, attrs, done) => exclusiveOpen(name, flags, attrs, error => {
    if (error) done(error);
  });
  let failure;
  await assert.rejects(() => remote.publishManagedFile(target, "staged", 0o600, { timeoutMs: 100 }), error => {
    failure = error;
    return error.remoteOutcomeUnknown === true && error.timedOut === true;
  });
  assert.equal((await lstat(local(failure.tempPath))).isFile(), true);
  assert.equal(calls.filter(([call]) => call === "open").length, 1);
});

test("unavailable OpenSSH atomic rename fails closed and leaves its staged file", async t => {
  const { client, channel, local } = await managedFixture(t);
  const target = "/docker/n8n-openai-oauth/Dockerfile";
  channel.ext_openssh_rename = () => { throw new Error("Server does not support this extended request"); };
  const remote = await connect(client);
  t.after(() => remote.close());
  let failure;
  await assert.rejects(() => remote.publishManagedFile(target, "staged"), error => {
    failure = error;
    return error.remoteOutcomeUnknown === true && !error.message.includes("Server does not support");
  });
  assert.equal(await readFile(local(failure.tempPath), "utf8"), "staged");
  await assert.rejects(() => lstat(local(target)), { code: "ENOENT" });
});

test("lost rename acknowledgment is uncertain and never repeats publication", { timeout: 5000 }, async t => {
  const { client, channel, calls, local } = await managedFixture(t);
  const target = "/docker/n8n-openai-oauth/Dockerfile";
  const publish = channel.ext_openssh_rename;
  let renames = 0;
  channel.ext_openssh_rename = (from, to) => { renames++; publish(from, to, () => {}); };
  const remote = await connect(client);
  t.after(() => remote.close());
  await assert.rejects(() => remote.publishManagedFile(target, "new", 0o644, { timeoutMs: 500 }),
    error => error.remoteOutcomeUnknown === true && error.timedOut === true && /unknown/u.test(error.message) &&
      dirname(error.tempPath) === dirname(target) && !error.message.includes("new"));
  assert.equal(await readFile(local(target), "utf8"), "new");
  assert.equal(renames, 1);
  assert.equal(calls.filter(([call]) => call === "end").length, 1);
  assert.notEqual(client.ended, true);
});

test("stalled SFTP transfer expires, retains its exclusive temp and closes only its own channel", { timeout: 5000 }, async t => {
  const { client, channel, calls, local } = await managedFixture(t);
  const target = "/docker/n8n-openai-oauth/Dockerfile";
  channel.write = () => {};
  const remote = await connect(client);
  t.after(() => remote.close());
  let failure;
  await assert.rejects(() => remote.publishManagedFile(target, "private-fixture", 0o600, { timeoutMs: 100 }), error => {
    failure = error;
    return error.remoteOutcomeUnknown === true && error.timedOut === true && !error.message.includes("private-fixture");
  });
  assert.equal((await lstat(local(failure.tempPath))).isFile(), true);
  assert.equal(calls.filter(([call]) => call === "open").length, 1);
  assert.equal(calls.some(([call]) => call === "rename"), false);
  assert.equal(calls.filter(([call]) => call === "end").length, 1);
  assert.notEqual(client.ended, true);
});

test("read-only publication preflight deadline reports no remote change", { timeout: 2000 }, async t => {
  const { client, calls, local } = await managedFixture(t);
  const target = "/docker/n8n-openai-oauth/Dockerfile";
  await writeFile(local(target), "old");
  let destroyed = 0;
  client.execute = () => {
    const stream = resultChannel({ code: 0, stdout: "" });
    stream.end = () => {};
    stream.destroy = () => { destroyed++; };
    return stream;
  };
  const remote = await connect(client);
  t.after(() => remote.close());
  await assert.rejects(() => remote.publishManagedFile(target, "new", 0o600, { timeoutMs: 20 }),
    error => error.remoteOutcomeUnknown !== true && error.timedOut === true && error.tempPath === undefined);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(destroyed, 1);
  assert.equal(calls.some(([call]) => call === "open"), false);
  assert.equal(await readFile(local(target), "utf8"), "old");
});

test("live silent command expires without retrying or closing the transport", { timeout: 2000 }, async () => {
  let destroyed = 0;
  let commands = 0;
  const client = new BoundaryClient({ execute: () => {
    commands++;
    const stream = resultChannel({ code: 0, stdout: "" });
    stream.end = () => {};
    stream.destroy = () => { destroyed++; };
    return stream;
  } });
  const remote = await connect(client);
  try {
    await assert.rejects(() => remote.exec("fixture-command", { timeoutMs: 20 }),
      error => error.remoteOutcomeUnknown === true && error.timedOut === true);
    assert.equal(commands, 1);
    assert.equal(destroyed, 1);
    assert.notEqual(client.ended, true);
  } finally { remote.close(); }
});

test("exec bounds default deadlines and validates explicit build deadlines before dispatch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let commands = 0;
  let destroyed = 0;
  const client = new BoundaryClient({ execute: () => {
    commands++;
    const stream = resultChannel({ code: 0, stdout: "" });
    stream.end = () => {};
    stream.destroy = () => { destroyed++; };
    return stream;
  } });
  const remote = await connect(client);
  try {
    for (const timeoutMs of [0, -1, NaN, Infinity, 7_200_001, "100"]) {
      await assert.rejects(() => remote.exec("fixture-command", { timeoutMs }), TypeError);
    }
    assert.equal(commands, 0);
    const defaultFailure = assert.rejects(() => remote.exec("fixture-command"),
      error => error.timedOut === true && error.remoteOutcomeUnknown === true);
    t.mock.timers.tick(45 * 60_000);
    await defaultFailure;
    const buildFailure = assert.rejects(() => remote.exec("fixture-build", { timeoutMs: 600_000 }),
      error => error.timedOut === true && error.remoteOutcomeUnknown === true);
    t.mock.timers.tick(600_000);
    await buildFailure;
    assert.equal(commands, 2);
    assert.equal(destroyed, 2);
  } finally { remote.close(); }
});

test("command deadline also bounds a missing exec acknowledgment and disposes a late owned channel", { timeout: 2000 }, async () => {
  const client = new BoundaryClient();
  const exec = client.exec.bind(client);
  let pending;
  client.exec = (command, callback) => {
    if (command === LOGIN_PROBE || command === administrativeCommand(ADMIN_PROBE, "root")) exec(command, callback);
    else pending = callback;
  };
  const remote = await connect(client);
  try {
    await assert.rejects(() => remote.exec("fixture-command", { timeoutMs: 20 }),
      error => error.timedOut === true && error.remoteOutcomeUnknown === true);
    let destroyed = 0;
    const late = resultChannel({ code: 0, stdout: "" });
    late.destroy = () => { destroyed++; };
    pending(null, late);
    late.emit("error", new Error("private-late-error"));
    assert.equal(destroyed, 1);
    assert.notEqual(client.ended, true);
  } finally { remote.close(); }
});

test("publication setup has a finite default deadline without claiming an unwritten temp", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new BoundaryClient();
  client.sftp = () => {};
  const remote = await connect(client);
  try {
    const failure = assert.rejects(() => remote.publishManagedFile("/docker/n8n-openai-oauth/file", "new"),
      error => error.timedOut === true && error.remoteOutcomeUnknown !== true && error.tempPath === undefined);
    t.mock.timers.tick(5 * 60_000);
    await failure;
    assert.notEqual(client.ended, true);
  } finally { remote.close(); }
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

test("unattested builder selection is rejected and inherited builder overrides cannot run a command", async (t) => {
  const original = adminResult();
  const prefix = original.stdout.split("\n").slice(0, 6).join("\n");
  assert.throws(() => parseAdministrativeProbe({ ...original, stdout: `${prefix}\nremote-ci\n` }), /builder/u);
  await t.test("inherited builder overrides exit 78 before the command", { skip: posixExecutionSkip }, () => {
    const engine = parseAdministrativeProbe(adminResult());
    const selectors = ["BUILDX_BUILDER", "BUILDX_CONFIG", "BUILDKIT_HOST", "DOCKER_CONFIG", "COMPOSE_BAKE"];
    const base = { ...process.env };
    for (const name of selectors) delete base[name];
    for (const name of selectors) {
      const result = spawnSync(posixShell, ["-c", administrativeCommand("printf must-not-run", "root", engine)],
        { env: { ...base, [name]: "remote-ci" }, encoding: "utf8" });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 78);
      assert.equal(result.stdout, "");
    }
  });
});

test("disabled or invalid BuildKit selection cannot reach the command", { skip: posixExecutionSkip }, () => {
  const env = { ...process.env };
  for (const name of ["BUILDX_BUILDER", "BUILDX_CONFIG", "BUILDKIT_HOST", "DOCKER_CONFIG", "COMPOSE_BAKE"]) delete env[name];
  for (const value of ["0", "false", "unexpected", "1"]) {
    const result = spawnSync(posixShell, ["-c", administrativeCommand('printf "%s" "$((6 * 7))"', "root")],
      { env: { ...env, DOCKER_BUILDKIT: value }, encoding: "utf8" });
    assert.equal(result.error, undefined);
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
