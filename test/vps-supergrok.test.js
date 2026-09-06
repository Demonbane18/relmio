import assert from "node:assert/strict";
import test from "node:test";
import { inspectVpsSuperGrok, reviewVpsSuperGrok, installVpsSuperGrok, changeVpsSuperGrok, parseGrokDevicePrompt, discoverVpsGrokModels } from "../src/services/vps-supergrok.js";
import { startWizardServer } from "../src/web/server.js";

const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const selected = { containerName: "n8n-fixture", networkName: "fixture-net" };
function emptyRemote({ collision = false, running = true } = {}) {
  const calls = [];
  return { calls, async exec(command) {
    calls.push(command);
    if (command.includes("printf absent")) return { code: 0, stdout: "absent" };
    if (command.includes("json .Id")) return { code: 0, stdout: `${JSON.stringify(containerId)}|${running}|${JSON.stringify({ [selected.networkName]: { NetworkID: networkId } })}` };
    if (command.startsWith("docker network inspect")) return { code: 0, stdout: JSON.stringify({ Id: networkId, Containers: collision ? { [containerId]: { Name: "foreign" } } : {} }) };
    if (command.includes("json .NetworkSettings.Networks")) return { code: 0, stdout: JSON.stringify({ [selected.networkName]: { Aliases: ["n8n-supergrok"] } }) };
    throw new Error("Unexpected operation in read-only fixture");
  } };
}
test("VPS SuperGrok review requires a live selected boundary and makes no writes", async () => {
  const remote = emptyRemote();
  const plan = await reviewVpsSuperGrok({ remote, ...selected, action: "install" });
  assert.equal(plan.containerId, containerId);
  assert.equal(plan.networkId, networkId);
  assert.deepEqual(plan.publishedPorts, []);
  assert.deepEqual(plan.existingN8nChanges, []);
  assert.ok(remote.calls.every(command => !/\b(?:mkdir|install|upload|rm|stop|restart|build)\b/u.test(command)));
  await assert.rejects(() => reviewVpsSuperGrok({ remote: emptyRemote({ running: false }), ...selected, action: "install" }), /changed/u);
  await assert.rejects(() => reviewVpsSuperGrok({ remote: emptyRemote({ collision: true }), ...selected, action: "install" }), /already in use/u);
});
test("VPS SuperGrok rejects missing confirmation, invalid actions and command injection", async () => {
  const remote = emptyRemote();
  await assert.rejects(() => installVpsSuperGrok({ remote, plan: { action: "install" }, confirmed: false }), /Confirm/u);
  await assert.rejects(() => changeVpsSuperGrok({ remote, plan: { action: "remove" }, confirmed: false }), /Confirm/u);
  assert.equal(remote.calls.length, 0);
  await assert.rejects(() => reviewVpsSuperGrok({ remote, ...selected, action: "restart-n8n" }), /supported/u);
  await assert.rejects(() => inspectVpsSuperGrok({ remote, ...selected, containerName: "n8n; touch /tmp/owned" }), /invalid/u);
  await assert.rejects(() => discoverVpsGrokModels({ remote, clientKey: "provider-secret" }), /local bridge bearer/u);
  assert.ok(remote.calls.every(command => !command.includes("touch")));
});
test("device prompt exposes only an official URL and device code, never raw diagnostics", () => {
  assert.deepEqual(parseGrokDevicePrompt("https://evil.test/steal\nToken: do-not-forward\nhttps://accounts.x.ai/device?token=do-not-forward\nCode: ABCD-1234"), { verificationUrl: "https://accounts.x.ai/device", userCode: "ABCD-1234" });
  assert.deepEqual(parseGrokDevicePrompt("https://accounts.x.ai.evil.test/device https://user:secret@accounts.x.ai/device https://accounts.x.ai:444/device"), { verificationUrl: null, userCode: null });
});

async function serverFixture(t) {
  const token = "t".repeat(43);
  let installed = 0;
  let freshId = containerId;
  const services = {
    getAuthStatus: async () => { throw new Error("SuperGrok must not request local ChatGPT credentials"); },
    scanHostFingerprint: async () => "SHA256:" + "a".repeat(43),
    connectVerified: async () => ({ close() {} }),
    discoverN8n: async () => ({ containers: [{ id: containerId, name: selected.containerName, image: "n8nio/n8n", state: "running" }] }),
    discoverNetworks: async () => ({ networks: [selected.networkName], instanceAi: { status: "missing" } }),
    reviewVpsSuperGrok: async args => ({ ...selected, action: args.action, containerId: freshId, networkId, installId: null, publishedPorts: [] }),
    installVpsSuperGrok: async () => { installed++; return { state: "healthy", clientKey: "c".repeat(64) }; },
  };
  const server = await startWizardServer({ sessionToken: token, services, uiFiles: { "/": "test" } });
  t.after(() => server.close());
  const post = async (path, body = {}, authenticated = true) => fetch(server.origin + path, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", ...(authenticated ? { "X-Setup-Token": token } : {}) }, body: JSON.stringify(body) });
  const scan = await (await post("/api/ssh/fingerprint", { host: "fixture.example", port: 22 })).json();
  assert.equal((await post("/api/ssh/connect", { host: "fixture.example", port: 22, username: "root", password: "fixture-only", expectedFingerprint: scan.fingerprint })).status, 200);
  assert.equal((await post("/api/discover")).status, 200);
  assert.equal((await post("/api/networks", { containerName: selected.containerName })).status, 200);
  return { post, count: () => installed, changeContainer: () => { freshId = "d".repeat(64); } };
}
test("SuperGrok API installs without ChatGPT credentials, after authenticated one-time review", async t => {
  const f = await serverFixture(t);
  assert.equal((await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" }, false)).status, 401);
  const planResponse = await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" });
  assert.equal(planResponse.status, 200);
  const plan = await planResponse.json();
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: false })).status, 200);
  assert.equal(f.count(), 0);
  assert.equal((await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: true })).status, 200);
  assert.equal(f.count(), 1);
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: true })).status, 200);
  assert.equal(f.count(), 1);
});
test("SuperGrok API rejects a replaced container after review and a forged selection", async t => {
  const f = await serverFixture(t);
  assert.notEqual((await f.post("/api/vps/supergrok/plan", { ...selected, networkName: "foreign", action: "install" })).status, 200);
  const plan = await (await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).json();
  f.changeContainer();
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: true })).status, 200);
  assert.equal(f.count(), 0);
});

test("discovery and disconnection invalidate a reviewed SuperGrok action", async t => {
  const f = await serverFixture(t);
  let plan = await (await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).json();
  await f.post("/api/discover");
  await f.post("/api/networks", { containerName: selected.containerName });
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: true })).status, 200);
  plan = await (await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).json();
  await f.post("/api/disconnect");
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: true })).status, 200);
  assert.equal(f.count(), 0);
});
