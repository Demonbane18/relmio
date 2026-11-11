import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { connectVerified, formatSha256Fingerprint, getSshCapabilities } from "../src/infrastructure/ssh.js";
import { ADMIN_PROBE, LOGIN_PROBE, administrativeCommand, parseAdministrativeProbe } from "../src/infrastructure/ssh-administration.js";
import { VPS_OPERATION_LOCKS } from "../src/domain/vps-build-state.js";
import { describeVpsNetworkSupport } from "../src/domain/vps-network.js";
import { withVpsOperationLock } from "../src/services/vps-operation-lock.js";
import { startWizardServer } from "../src/web/server.js";
import { verifiedSshFixture } from "./helpers/ssh-session.js";

const token = "c".repeat(43);
const digest = "ab".repeat(32);
const fingerprint = formatSha256Fingerprint(digest);
const rootRequest = { host: "fixture.example", port: 22, username: "root", expectedFingerprint: fingerprint, useAgent: false, privilege: "root", password: "fixture-only-password" };
const sudoRequest = { host: "fixture.example", port: 22, username: "ubuntu", expectedFingerprint: fingerprint, useAgent: true, privilege: "sudo-n" };

const probeOutput = (info = {}, compose = "2.39.2") => `0\nunix:///var/run/docker.sock\n/usr/bin/docker\ndefault\n${JSON.stringify({ OSType: "linux", ServerVersion: "28.0.1", SecurityOptions: ["name=seccomp,profile=builtin"], ...info })}\n${compose}\ndefault\n`;

// A fake SSH wire only. Administrative identity, exact authentication validation,
// command wrapping and scope are supplied by the actual infrastructure export.
// `login` and `admin` replace what the two read-only probes answer.
class WireClient extends EventEmitter {
  constructor(uid, { login, admin } = {}) {
    super();
    Object.assign(this, { uid, login, admin, commands: [], inputs: [], uploads: 0 });
  }
  connect(config) {
    this.config = config;
    queueMicrotask(() => config.hostVerifier(digest) ? this.emit("ready") : this.emit("error", new Error("host mismatch")));
  }
  exec(command, callback) {
    this.commands.push(command);
    let stdout;
    let code = 0;
    if (command === LOGIN_PROBE) ({ stdout, code } = this.login ?? { stdout: `${this.uid}\n`, code: 0 });
    else if (["root", "sudo-n"].some(mode => command === administrativeCommand(ADMIN_PROBE, mode))) {
      ({ stdout, code } = this.admin ?? { stdout: probeOutput(), code: 0 });
    } else throw new Error("Unexpected remote execution in credential-denial fixture");
    const channel = new EventEmitter();
    channel.stderr = new EventEmitter();
    channel.write = value => { this.inputs.push(value); return true; };
    channel.destroy = () => {};
    channel.end = () => queueMicrotask(() => { channel.emit("data", Buffer.from(stdout)); channel.emit("close", code); });
    callback(null, channel);
  }
  sftp() { this.uploads++; throw new Error("No credential upload allowed"); }
  end() { this.closed = true; }
}

async function fixture(t, overrides = {}, wire = {}) {
  const clients = [];
  let credentialCalls = 0;
  const forbidden = async () => { credentialCalls++; throw new Error("Credential service must not execute"); };
  const server = await startWizardServer({ sessionToken: token, uiFiles: { "/": "fixture" }, services: {
    scanHostFingerprint: async () => fingerprint,
    getSshCapabilities: () => getSshCapabilities({ env: {}, platform: "linux" }),
    connectVerified: async request => {
      const client = new WireClient(wire.uid ?? (request.privilege === "root" ? 0 : 1000), wire);
      clients.push(client);
      return connectVerified(request, { createClient: () => client, resolveAgent: async () => ({ agent: "/fixture/local-agent.sock" }) });
    },
    getAuthStatus: forbidden, readAuthContents: forbidden, installSidecar: forbidden,
    installAssistant: forbidden, inspectVpsSuperGrok: forbidden, reviewVpsSuperGrok: forbidden,
    installVpsSuperGrok: forbidden, changeVpsSuperGrok: forbidden,
    getVpsGrokLoginStatus: forbidden, discoverVpsGrokModels: forbidden,
    discoverN8n: async () => ({ containers: [] }),
    inspectVpsLocalModel: async () => ({ state: "absent", installId: null, modelId: null, endpoint: null, operation: null }),
    ...overrides,
  } });
  t.after(() => server.close());
  const call = (path, body, headers = {}) => fetch(server.origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: server.origin, "X-Setup-Token": token, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const connect = async (request = rootRequest) => {
    assert.equal((await call("/api/ssh/fingerprint", { host: request.host, port: request.port })).status, 200);
    const result = await call("/api/ssh/connect", request);
    assert.equal(result.status, 200, await result.clone().text());
    return (await result.json()).identity;
  };
  return { server, call, connect, clients, credentialCalls: () => credentialCalls };
}

test("protected capabilities expose no agent socket or key inventory", async t => {
  const f = await fixture(t, { getSshCapabilities: async () => ({ agent: { status: "configured", transport: "unix-socket", verification: "untested", socket: "/private/agent.sock", keys: ["secret-key"] }, privateKey: "private" }) });
  assert.equal((await f.call("/api/ssh/capabilities", undefined, { "X-Setup-Token": "wrong" })).status, 401);
  const response = await f.call("/api/ssh/capabilities");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { agent: { status: "configured", transport: "unix-socket", verification: "untested" } });
  assert.equal(f.clients.length, 0);
});

test("real transport identity survives HTTP projection without authentication material", async t => {
  const f = await fixture(t);
  const identity = await f.connect(sudoRequest);
  assert.deepEqual(identity, { host: "fixture.example", port: 22, fingerprint, username: "ubuntu", authentication: "agent", privilege: "sudo-n", loginUid: 1000, effectiveUid: 0, scope: "local-model-only", generation: 1 });
  assert.equal(f.clients[0].config.agent, "/fixture/local-agent.sock");
  assert.equal(Object.hasOwn(f.clients[0].config, "password"), false);
  assert.deepEqual(await (await f.call("/api/ssh/connection")).json(), identity);
  assert.equal((await f.call("/api/discover", {})).status, 200);
  assert.equal((await f.call("/api/vps/local-model/status", { containerName: "n8n", networkName: "private" })).status, 200);
  const next = await f.connect({ ...rootRequest, useAgent: true, password: undefined });
  assert.equal(next.authentication, "agent");
  assert.equal(next.scope, "vps");
  assert.ok(next.generation > identity.generation);
  assert.equal(f.clients[0].closed, true);
});

test("mixed authentication and unknown fields cannot replace a verified session", async t => {
  const f = await fixture(t);
  const identity = await f.connect();
  const invalid = [
    { ...rootRequest, useAgent: true }, { ...rootRequest, agent: "/caller/socket" },
    { ...rootRequest, privateKey: "private" }, { ...rootRequest, passphrase: "secret" },
    { ...rootRequest, useAgent: "false" }, { ...rootRequest, privilege: "sudo" },
    { ...rootRequest, useAgent: undefined }, { ...rootRequest, privilege: undefined },
    { ...sudoRequest, password: "" },
  ];
  for (const body of invalid) {
    assert.equal((await f.call("/api/ssh/connect", body)).status, 400);
    assert.deepEqual(await (await f.call("/api/ssh/connection")).json(), identity);
  }
  assert.equal(f.clients.length, 1);
  assert.notEqual(f.clients[0].closed, true);
});

test("sudo model sessions reject every credential-bearing route before body and service work", async t => {
  const f = await fixture(t);
  await f.connect(sudoRequest);
  const client = f.clients[0];
  const commandCount = client.commands.length;
  for (const path of ["/api/plan", "/api/install", "/api/assistant/plan", "/api/assistant/install", "/api/vps/supergrok/status", "/api/vps/supergrok/plan", "/api/vps/supergrok/apply", "/api/vps/supergrok/login-status", "/api/vps/supergrok/models",
    "/api/vps/claude/status", "/api/vps/claude/plan", "/api/vps/claude/apply", "/api/vps/claude/auth-status", "/api/vps/claude/models"]) {
    const response = await fetch(f.server.origin + path, { method: "POST", headers: { Origin: f.server.origin, "X-Setup-Token": token, "Content-Type": "application/json" }, body: "not-json:must-not-be-parsed" });
    assert.equal(response.status, 403, path);
    assert.match((await response.json()).error, /local-model-only/u);
  }
  const claudeStatus = await fetch(`${f.server.origin}/api/vps/claude/status`, { headers: { Origin: f.server.origin, "X-Setup-Token": token } });
  assert.equal(claudeStatus.status, 403);
  assert.match((await claudeStatus.json()).error, /local-model-only/u);
  assert.equal(f.credentialCalls(), 0);
  assert.equal(client.commands.length, commandCount);
  assert.deepEqual(client.inputs, []);
  assert.equal(client.uploads, 0);
  assert.equal((await f.call("/api/disconnect", {})).status, 200);
});

test("missing or mismatched transport metadata never becomes a root session", async t => {
  for (const mismatch of ["missing", "username", "authentication", "privilege", "scope", "host", "fingerprint", "loginUid", "effectiveUid"]) {
    await t.test(mismatch, async subtest => {
      let closed = false;
      const f = await fixture(subtest, { connectVerified: async request => {
        const remote = verifiedSshFixture(request, { close() { closed = true; } });
        if (mismatch === "missing") delete remote.identity;
        else if (mismatch === "scope") remote.scope = "local-model-only";
        else remote.identity = { ...remote.identity, [mismatch]: mismatch.endsWith("Uid") ? 1000 : "mismatch" };
        return remote;
      } });
      await f.call("/api/ssh/fingerprint", { host: rootRequest.host, port: 22 });
      assert.equal((await f.call("/api/ssh/connect", rootRequest)).status, 400);
      assert.deepEqual(await (await f.call("/api/ssh/connection")).json(), { connected: false });
      assert.equal(closed, true);
      assert.equal(f.credentialCalls(), 0);
    });
  }
});

const GENERIC_FAILURE = "The request could not be completed safely.";
const PROBE_REFUSALS = {
  70: "vps_prereq_linux", 71: "vps_prereq_uid", 72: "vps_prereq_tools", 73: "vps_prereq_docker_dir",
  74: "vps_prereq_docker_cli", 75: "vps_prereq_docker_context", 76: "vps_prereq_docker_engine",
  77: "vps_prereq_compose", 78: "vps_prereq_builder_config", 79: "vps_prereq_default_builder",
};

async function refusedConnect(t, wire, request = rootRequest) {
  const f = await fixture(t, {}, wire);
  assert.equal((await f.call("/api/ssh/fingerprint", { host: request.host, port: request.port })).status, 200);
  const response = await f.call("/api/ssh/connect", request);
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.notEqual(body.error, GENERIC_FAILURE);
  assert.ok(body.error.length <= 240);
  assert.deepEqual(await (await f.call("/api/ssh/connection")).json(), { connected: false });
  assert.equal(f.clients[0].closed, true);
  assert.equal(f.credentialCalls(), 0);
  return body;
}

test("each probe refusal reaches the browser as its own sentence with its code", async t => {
  for (const [exit, code] of Object.entries(PROBE_REFUSALS)) {
    await t.test(`probe exit ${exit}`, async subtest => {
      let expected;
      try { parseAdministrativeProbe({ code: Number(exit), stdout: "" }); } catch (error) { expected = error.message; }
      const body = await refusedConnect(subtest, { admin: { code: Number(exit), stdout: "private-remote-output" } });
      assert.equal(body.error, expected);
      assert.equal(body.code, code);
      assert.equal(JSON.stringify(body).includes("private-remote-output"), false);
    });
  }
});

test("sign-in refusals reach the browser with their codes and only the validated account name", async t => {
  const redirected = await refusedConnect(t, {
    login: { code: 142, stdout: 'Please login as the user "ubuntu" rather than the user "root".\n\n' },
  });
  assert.equal(redirected.code, "ssh_root_login_disabled");
  assert.match(redirected.error, /"ubuntu"/u);
  const garbled = await refusedConnect(t, {
    login: { code: 142, stdout: 'Please login as the user "ubuntu" rather than the user "root".\nprivate-motd-line\n' },
  });
  assert.equal(garbled.code, "vps_prereq_probe");
  assert.doesNotMatch(JSON.stringify(garbled), /private-motd-line|ubuntu/u);
  assert.equal((await refusedConnect(t, { uid: 1000 })).code, "ssh_not_root");
  assert.equal((await refusedConnect(t, { admin: { code: 0, stdout: probeOutput({ SecurityOptions: ["name=rootless"] }) } })).code, "vps_prereq_rootless");
  assert.equal((await refusedConnect(t, { admin: { code: 1, stdout: "" } }, sudoRequest)).code, "vps_prereq_probe");
});

test("a retained operation lock reaches the browser by name, without its path", async t => {
  const lock = VPS_OPERATION_LOCKS.model;
  const lockFailure = async (remote, operation = () => "done") => {
    try { await withVpsOperationLock(remote, lock, operation); } catch (error) { return error; }
    return assert.fail("Expected the lock to fail.");
  };
  const releaseFails = () => {
    let calls = 0;
    return { exec: async () => (++calls === 1 ? { code: 0, stdout: "7:11\n" } : { code: 1, stdout: "private-lock-diagnostic" }) };
  };
  const failures = [
    [await lockFailure({ exec: async () => ({ code: 1, stdout: "private-lock-diagnostic" }) }), "vps_operation_lock"],
    [await lockFailure(releaseFails()), "vps_operation_lock"],
    [await lockFailure(releaseFails(), () => {
      throw Object.assign(new Error("private /docker/n8n-openai-oauth diagnostic"), { safeMessage: "The model runtime did not start in time.", code: "vps_step_start" });
    }), "vps_step_start"],
  ];
  for (const [failure, code] of failures) {
    const f = await fixture(t, { inspectVpsLocalModel: async () => { throw failure; } });
    await f.connect();
    const response = await f.call("/api/vps/local-model/status", { containerName: "n8n", networkName: "private" });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error, failure.safeMessage);
    assert.notEqual(body.error, GENERIC_FAILURE);
    assert.equal(body.code, code);
    assert.match(body.error, /\.local-model-operation\.lock/u);
    assert.doesNotMatch(JSON.stringify(body), /\/docker\/|private-/u);
  }
});

test("the host report is built from the connection probe and cached discovery without a remote call", async t => {
  // Fields from a sanitized `docker info` capture, as an x86_64 host reports them.
  const info = {
    OperatingSystem: "Ubuntu 24.04.4 LTS", KernelVersion: "6.8.0-117-generic", Architecture: "x86_64", ServerVersion: "29.5.2",
    NCPU: 2, MemTotal: 4095635456, SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin", "name=cgroupns"],
    ClientInfo: { Plugins: [{ Name: "buildx", Version: "v0.38.1" }, { Name: "compose", Version: "5.6.1" }] },
  };
  let discoveries = 0;
  const f = await fixture(t, {
    discoverN8n: async () => {
      discoveries++;
      return { containers: [{ id: "a1b2c3d4e5f6", name: "n8n-n8n-1", image: "docker.n8n.io/n8nio/n8n", state: "running", composeProject: "n8n", n8nSandboxPresent: false }] };
    },
    discoverNetworks: async () => {
      discoveries++;
      return {
        networks: ["bridge", "n8n_default"], recommended: "n8n_default", instanceAi: { status: "missing" },
        support: { bridge: describeVpsNetworkSupport({ Name: "bridge" }), n8n_default: describeVpsNetworkSupport({ Name: "n8n_default", Driver: "bridge", Internal: false }) },
      };
    },
  }, { admin: { code: 0, stdout: probeOutput(info, "5.6.1") } });
  const report = async (query = "") => {
    const response = await f.call(`/api/ssh/host-report${query}`);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    for (const row of body.rows) {
      assert.deepEqual(Object.keys(row), ["id", "level", "text", "flows"]);
      assert.ok(["pass", "warn", "fail"].includes(row.level) && row.text.length > 0 && row.text.length <= 240);
    }
    assert.equal(new Set(body.rows.map(row => row.id)).size, body.rows.length);
    return { host: body.host, rows: Object.fromEntries(body.rows.map(row => [row.id, row])) };
  };

  assert.equal((await f.call("/api/ssh/host-report")).status, 400, "there is nothing to report before a connection");
  await f.connect();
  const client = f.clients[0];
  const commands = client.commands.length;
  assert.equal((await f.call("/api/ssh/host-report", undefined, { "X-Setup-Token": "wrong" })).status, 401);

  const first = await report();
  assert.deepEqual(first.host, {
    os: "Ubuntu 24.04.4 LTS", kernel: "6.8.0-117-generic", arch: "x86_64", dockerVersion: "29.5.2", composeVersion: "5.6.1",
    buildxVersion: "0.38.1", memoryBytes: 4095635456, cpus: 2, security: ["apparmor", "seccomp", "cgroupns"],
  });
  assert.deepEqual(Object.keys(first.rows), ["login", "os", "cpu", "docker", "compose", "buildx", "resources", "security"]);
  assert.ok(Object.values(first.rows).every(row => row.level === "pass"));

  assert.equal((await f.call("/api/discover", {})).status, 200);
  assert.equal((await f.call("/api/networks", { containerName: "n8n-n8n-1" })).status, 200);
  const calls = discoveries;
  assert.equal((await report()).rows.n8n.level, "pass");
  assert.equal((await report()).rows.network, undefined, "no network row without a selection");
  assert.equal((await report("?container=n8n-n8n-1&network=n8n_default")).rows.network.level, "pass");
  const onBridge = (await report("?container=n8n-n8n-1&network=bridge")).rows.network;
  assert.deepEqual([onBridge.level, onBridge.flows], ["fail", []]);
  // A selection the cached discovery does not hold yields no row, and odd queries are refused.
  assert.equal((await report("?container=n8n-n8n-1&network=elsewhere")).rows.network, undefined);
  assert.equal((await report("?container=other-n8n&network=bridge")).rows.network, undefined);
  for (const query of ["?container=n8n-n8n-1&extra=1", "?network=a%20b", "?container=a&container=b", "?network=--help", "?network="]) {
    assert.equal((await f.call(`/api/ssh/host-report${query}`)).status, 400, query);
  }

  assert.equal(client.commands.length, commands, "no SSH command ran for any report");
  assert.equal(discoveries, calls, "no discovery ran for any report");
  assert.equal(client.uploads, 0);

  // A sudo session may read the report; it marks the four root-only flows.
  const sudo = await fixture(t);
  await sudo.connect(sudoRequest);
  const response = await sudo.call("/api/ssh/host-report");
  assert.equal(response.status, 200);
  const login = (await response.json()).rows.find(row => row.id === "login");
  assert.deepEqual([login.level, login.flows], ["fail", ["chatgpt", "assistant", "supergrok", "claude"]]);
});

test("the SSH password is dropped from the connection config once the session is verified", async t => {
  const f = await fixture(t);
  await f.connect();
  assert.equal(Object.hasOwn(f.clients[0].config, "password"), false);
  assert.equal(JSON.stringify(f.clients[0].config).includes(rootRequest.password), false);
  assert.equal((await f.call("/api/discover", {})).status, 200);
});
