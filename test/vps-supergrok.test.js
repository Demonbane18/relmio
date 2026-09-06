import assert from "node:assert/strict";
import test from "node:test";
import { inspectVpsSuperGrok, reviewVpsSuperGrok, installVpsSuperGrok, changeVpsSuperGrok, parseGrokDevicePrompt, discoverVpsGrokModels } from "../src/services/vps-supergrok.js";
import { startWizardServer } from "../src/web/server.js";

const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const selected = { containerName: "n8n-fixture", networkName: "fixture-net" };
function deferred() {
  let resolve;
  return {
    promise: new Promise((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}
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

async function serverFixture(t, configureServices = () => {}) {
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
  configureServices(services);
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

test("a newer SuperGrok review rejects a late prior review instead of replacing its confirmed plan", async (t) => {
  const firstReview = deferred();
  const firstStarted = deferred();
  let reviews = 0;
  const f = await serverFixture(t, (services) => {
    services.reviewVpsSuperGrok = async (args) => {
      reviews += 1;
      if (reviews === 1) {
        firstStarted.resolve();
        return await firstReview.promise;
      }
      return { ...selected, action: args.action, containerId, networkId, installId: null, publishedPorts: [] };
    };
  });

  const staleReview = f.post("/api/vps/supergrok/plan", { ...selected, action: "install" });
  await firstStarted.promise;
  const currentReview = await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" });
  assert.equal(currentReview.status, 200);
  const currentPlan = await currentReview.json();

  firstReview.resolve({ ...selected, action: "install", containerId, networkId, installId: null, publishedPorts: [] });
  const stale = await staleReview;
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /newer SuperGrok review/u);

  assert.equal((await f.post("/api/vps/supergrok/apply", { ...currentPlan, confirmed: true })).status, 200);
  assert.equal(f.count(), 1);
});

test("a completed discovery cannot let an earlier SuperGrok review repopulate a stale plan", async (t) => {
  const review = deferred();
  const reviewStarted = deferred();
  const f = await serverFixture(t, (services) => {
    services.reviewVpsSuperGrok = async (args) => {
      reviewStarted.resolve();
      await review.promise;
      return { ...selected, action: args.action, containerId, networkId, installId: null, publishedPorts: [] };
    };
  });

  const pendingReview = f.post("/api/vps/supergrok/plan", { ...selected, action: "install" });
  await reviewStarted.promise;
  assert.equal((await f.post("/api/discover")).status, 200);
  review.resolve();

  const stale = await pendingReview;
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /VPS session changed|newer SuperGrok review/u);
  assert.notEqual((await f.post("/api/vps/supergrok/apply", {
    ...selected,
    action: "install",
    planId: "not-a-current-plan",
    confirmed: true,
  })).status, 200);
  assert.equal(f.count(), 0);
});

test("a pending discovery immediately invalidates a reviewed SuperGrok action", async (t) => {
  const discovery = deferred();
  const discoveryStarted = deferred();
  let discoveries = 0;
  const f = await serverFixture(t, (services) => {
    services.discoverN8n = async () => {
      discoveries += 1;
      if (discoveries === 1) {
        return { containers: [{ id: containerId, name: selected.containerName, image: "n8nio/n8n", state: "running" }] };
      }
      discoveryStarted.resolve();
      return await discovery.promise;
    };
  });
  const plan = await (await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).json();

  const refreshing = f.post("/api/discover");
  await discoveryStarted.promise;
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: true })).status, 200);
  assert.equal(f.count(), 0);

  discovery.resolve({ containers: [{ id: containerId, name: selected.containerName, image: "n8nio/n8n", state: "running" }] });
  assert.equal((await refreshing).status, 200);
});

test("each provider review invalidates plans from the other VPS providers", async (t) => {
  const f = await serverFixture(t, (services) => {
    services.getAuthStatus = async () => ({
      exists: true,
      path: "/fixture/auth.json",
      updatedAt: "2026-09-06T00:00:00.000Z",
    });
    services.discoverNetworks = async () => ({
      networks: [selected.networkName],
      instanceAi: { status: "enabled" },
    });
  });
  const sidecarPlan = await (await f.post("/api/plan", selected)).json();
  assert.equal((await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).status, 200);
  assert.notEqual((await f.post("/api/install", { ...selected, planId: sidecarPlan.planId, confirmed: true })).status, 200);

  const grokBeforeSidecar = await (await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).json();
  assert.equal((await f.post("/api/plan", selected)).status, 200);
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...grokBeforeSidecar, confirmed: true })).status, 200);

  const assistantPlan = await (await f.post("/api/assistant/plan", { ...selected, includeSearxng: false })).json();
  assert.equal((await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).status, 200);
  assert.notEqual((await f.post("/api/assistant/install", { ...selected, includeSearxng: false, planId: assistantPlan.planId, confirmed: true })).status, 200);

  const grokBeforeAssistant = await (await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).json();
  assert.equal((await f.post("/api/assistant/plan", { ...selected, includeSearxng: false })).status, 200);
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...grokBeforeAssistant, confirmed: true })).status, 200);
  assert.equal(f.count(), 0);
});

test("only the latest started discovery can replace the current VPS context", async (t) => {
  const firstDiscovery = deferred();
  const secondDiscovery = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  let discoveries = 0;
  const f = await serverFixture(t, (services) => {
    services.discoverN8n = async () => {
      discoveries += 1;
      if (discoveries === 1) {
        return { containers: [{ id: containerId, name: selected.containerName, image: "n8nio/n8n", state: "running" }] };
      }
      if (discoveries === 2) {
        firstStarted.resolve();
        return await firstDiscovery.promise;
      }
      secondStarted.resolve();
      return await secondDiscovery.promise;
    };
  });

  const older = f.post("/api/discover");
  await firstStarted.promise;
  const newer = f.post("/api/discover");
  await secondStarted.promise;
  firstDiscovery.resolve({ containers: [] });
  assert.equal((await older).status, 409);
  secondDiscovery.resolve({ containers: [{ id: containerId, name: selected.containerName, image: "n8nio/n8n", state: "running" }] });
  assert.equal((await newer).status, 200);
});
