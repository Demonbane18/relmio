import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { connectVerified, formatSha256Fingerprint, getSshCapabilities } from "../src/infrastructure/ssh.js";
import { ADMIN_PROBE, LOGIN_PROBE, administrativeCommand } from "../src/infrastructure/ssh-administration.js";
import { startWizardServer } from "../src/web/server.js";
import { verifiedSshFixture } from "./helpers/ssh-session.js";

const token = "c".repeat(43);
const digest = "ab".repeat(32);
const fingerprint = formatSha256Fingerprint(digest);
const rootRequest = { host: "fixture.example", port: 22, username: "root", expectedFingerprint: fingerprint, useAgent: false, privilege: "root", password: "fixture-only-password" };
const sudoRequest = { host: "fixture.example", port: 22, username: "ubuntu", expectedFingerprint: fingerprint, useAgent: true, privilege: "sudo-n" };

// A fake SSH wire only. Administrative identity, exact authentication validation,
// command wrapping and scope are supplied by the actual infrastructure export.
class WireClient extends EventEmitter {
  constructor(uid) { super(); this.uid = uid; this.commands = []; this.inputs = []; this.uploads = 0; }
  connect(config) {
    this.config = config;
    queueMicrotask(() => config.hostVerifier(digest) ? this.emit("ready") : this.emit("error", new Error("host mismatch")));
  }
  exec(command, callback) {
    this.commands.push(command);
    let stdout;
    if (command === LOGIN_PROBE) stdout = `${this.uid}\n`;
    else if (["root", "sudo-n"].some(mode => command === administrativeCommand(ADMIN_PROBE, mode))) {
      stdout = `0\nunix:///var/run/docker.sock\n/usr/bin/docker\ndefault\n${JSON.stringify({ OSType: "linux", ServerVersion: "28.0.1", SecurityOptions: ["name=seccomp,profile=builtin"] })}\n2.39.2\ndefault\n`;
    } else throw new Error("Unexpected remote execution in credential-denial fixture");
    const channel = new EventEmitter();
    channel.stderr = new EventEmitter();
    channel.write = value => { this.inputs.push(value); return true; };
    channel.destroy = () => {};
    channel.end = () => queueMicrotask(() => { channel.emit("data", Buffer.from(stdout)); channel.emit("close", 0); });
    callback(null, channel);
  }
  sftp() { this.uploads++; throw new Error("No credential upload allowed"); }
  end() { this.closed = true; }
}

async function fixture(t, overrides = {}) {
  const clients = [];
  let credentialCalls = 0;
  const forbidden = async () => { credentialCalls++; throw new Error("Credential service must not execute"); };
  const server = await startWizardServer({ sessionToken: token, uiFiles: { "/": "fixture" }, services: {
    scanHostFingerprint: async () => fingerprint,
    getSshCapabilities: () => getSshCapabilities({ env: {}, platform: "linux" }),
    connectVerified: async request => {
      const client = new WireClient(request.privilege === "root" ? 0 : 1000);
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
  for (const path of ["/api/plan", "/api/install", "/api/assistant/plan", "/api/assistant/install", "/api/vps/supergrok/status", "/api/vps/supergrok/plan", "/api/vps/supergrok/apply", "/api/vps/supergrok/login-status", "/api/vps/supergrok/models"]) {
    const response = await fetch(f.server.origin + path, { method: "POST", headers: { Origin: f.server.origin, "X-Setup-Token": token, "Content-Type": "application/json" }, body: "not-json:must-not-be-parsed" });
    assert.equal(response.status, 403, path);
    assert.match((await response.json()).error, /local-model-only/u);
  }
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
