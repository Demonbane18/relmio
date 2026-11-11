import { verifiedSshFixture } from "./helpers/ssh-session.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { LOCAL_N8N_SUPERGROK_ENDPOINT } from "../src/domain/local-n8n-supergrok.js";
import { PRECHECK_COMMAND, SHARED_ROOT_COMMAND, SHARED_ROOT_TIGHTEN_COMMAND } from "../src/domain/safety.js";
import {
  VPS_OPERATION_LOCKS, cleanupVpsBuildStateCommand, createVpsBuildStateCommand, createVpsLockCommand, releaseVpsLockCommand,
} from "../src/domain/vps-build-state.js";
import { inspectVpsSuperGrok, reviewVpsSuperGrok, installVpsSuperGrok, changeVpsSuperGrok, parseGrokDevicePrompt, discoverVpsGrokModels } from "../src/services/vps-supergrok.js";
import { startIsolatedWizard as startWizardServer, siwcAccount } from "./helpers/siwc-wizard.js";

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
    // The foreign container has its own ID; the selected n8n container's networks come from the first read.
    if (command.startsWith("docker network inspect")) return { code: 0, stdout: JSON.stringify({ Id: networkId, Containers: collision ? { ["f".repeat(64)]: { Name: "foreign" } } : {} }) };
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
    connectVerified: async (request) => verifiedSshFixture(request),
    discoverN8n: async () => ({ containers: [{ id: containerId, name: selected.containerName, image: "n8nio/n8n", state: "running" }] }),
    discoverNetworks: async () => ({ networks: [selected.networkName], instanceAi: { status: "missing" } }),
    reviewVpsSuperGrok: async args => ({ ...selected, action: args.action, containerId: freshId, networkId, installId: null, publishedPorts: [],
      operationLockPath: "/docker/n8n-openai-oauth/.supergrok-operation.lock",
      temporaryBuildStatePath: ["install", "sign-in", "sign-out"].includes(args.action) ? "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx" : null }),
    installVpsSuperGrok: async () => { installed++; return { state: "healthy", clientKey: "c".repeat(64) }; },
  };
  configureServices(services);
  const server = await startWizardServer({ sessionToken: token, services, uiFiles: { "/": "test" } });
  t.after(() => server.close());
  const post = async (path, body = {}, authenticated = true) => fetch(server.origin + path, { method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", ...(authenticated ? { "X-Setup-Token": token } : {}) }, body: JSON.stringify(body) });
  const scan = await (await post("/api/ssh/fingerprint", { host: "fixture.example", port: 22 })).json();
  assert.equal((await post("/api/ssh/connect", { host: "fixture.example", port: 22, username: "root", useAgent: false, privilege: "root", password: "fixture-only", expectedFingerprint: scan.fingerprint })).status, 200);
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
      return { ...selected, action: args.action, containerId, networkId, installId: null, publishedPorts: [],
        operationLockPath: "/docker/n8n-openai-oauth/.supergrok-operation.lock",
        temporaryBuildStatePath: ["install", "sign-in", "sign-out"].includes(args.action) ? "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx" : null };
    };
  });

  const staleReview = f.post("/api/vps/supergrok/plan", { ...selected, action: "install" });
  await firstStarted.promise;
  const currentReview = await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" });
  assert.equal(currentReview.status, 200);
  const currentPlan = await currentReview.json();

  firstReview.resolve({ ...selected, action: "install", containerId, networkId, installId: null, publishedPorts: [],
    operationLockPath: "/docker/n8n-openai-oauth/.supergrok-operation.lock",
    temporaryBuildStatePath: "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx" });
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
      return { ...selected, action: args.action, containerId, networkId, installId: null, publishedPorts: [],
        operationLockPath: "/docker/n8n-openai-oauth/.supergrok-operation.lock",
        temporaryBuildStatePath: ["install", "sign-in", "sign-out"].includes(args.action) ? "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx" : null };
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
    services.getAuthStatus = async () => ({ ...siwcAccount, exists: true });
    services.discoverNetworks = async () => ({
      networks: [selected.networkName],
      instanceAi: { status: "enabled" },
    });
  });
  const sidecarPlan = await (await f.post("/api/plan", selected)).json();
  assert.equal((await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).status, 200);
  assert.notEqual((await f.post("/api/install", { ...selected, planId: sidecarPlan.planId,
    confirmed: true, backgroundConsent: true })).status, 200);

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

test("SuperGrok review rejects a missing or escaped build-state disclosure before installation", async t => {
  let temporaryBuildStatePath;
  const f = await serverFixture(t, services => {
    const review = services.reviewVpsSuperGrok;
    services.reviewVpsSuperGrok = async args => ({ ...await review(args), temporaryBuildStatePath });
  });
  for (const invalid of [undefined, "/root/.docker/buildx", "/docker/n8n-openai-oauth/.local-model-operation.lock/buildx"]) {
    temporaryBuildStatePath = invalid;
    assert.equal((await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).status, 502);
    assert.equal(f.count(), 0);
  }
  temporaryBuildStatePath = "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx";
  const reviewed = await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" });
  assert.equal(reviewed.status, 200);
  const plan = await reviewed.json();
  assert.equal((await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: false })).status, 400);
  assert.equal(f.count(), 0);
});

const ROOT = "/docker/n8n-openai-oauth/supergrok";
const LOCK = VPS_OPERATION_LOCKS.supergrok;
const COMPOSE = "docker compose --project-name relmio-n8n-supergrok-oauth-";
const FILE_NAMES = ["Dockerfile", ".dockerignore", "gateway.js", "chat.js", "session.js", "docker-compose.yml"];
const MARKER_NAME = ".managed-by-relmio.json";
const installId = "c".repeat(32);
const project = `relmio-n8n-supergrok-oauth-${installId}`;
const names = { container: `${project}-supergrok-oauth-1`, credential: `${project}-credential-action`, volume: `${project}_grok-home`, image: `${project}:local` };
const companionId = "1".repeat(64);
const credentialId = "2".repeat(64);
const imageId = `sha256:${"e".repeat(64)}`;
const recreatedN8nId = "d".repeat(64);
const OWNERSHIP = /ownership or safety check failed/u;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const ownedLabels = () => ({ "io.relmio.managed": "true", "io.relmio.target": "n8n-supergrok-oauth", "io.relmio.install": installId, "com.docker.compose.project": project });
const entropy = size => Buffer.alloc(size, 0xcc);
const readAssets = async () => ({ "gateway.js": "gateway", "chat.js": "chat", "session.js": "session" });

function ownedContainer(id, name, state) {
  return { Id: id, Name: `/${name}`, Image: imageId, Config: { Labels: ownedLabels(), Image: names.image }, State: state,
    HostConfig: { PortBindings: {}, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] },
    NetworkSettings: { Networks: { [selected.networkName]: { NetworkID: networkId, Aliases: ["n8n-supergrok", "supergrok-oauth"] } }, Ports: {} },
    Mounts: [{ Name: names.volume, Destination: "/home/node/.grok", RW: true }] };
}

// A small model of the VPS for SuperGrok: the marker and its files, the companion's Docker
// resources, and the selected n8n container with its networks. `otherN8n` maps the names of
// further n8n containers on the same networks to their IDs. Unknown commands throw.
function createVps({ installed = true } = {}) {
  const vps = {
    calls: [], writes: [], uploads: [], fail: new Set(), host: undefined, imageLabels: ownedLabels(),
    n8nId: containerId, n8nAliases: [], otherN8n: {},
    networks: { [selected.networkName]: { Id: networkId, Driver: "bridge", Internal: false } },
    marker: null, files: new Set(), companion: null, credential: null, volume: null, image: null,
  };
  if (installed) {
    vps.marker = { schemaVersion: 1, kind: "relmio-vps-supergrok", installId, projectName: project, ...selected,
      containerId, networkId, tokenSha256: sha256("fixture key"), imageId,
      files: Object.fromEntries(FILE_NAMES.map(name => [name, sha256(name)])) };
    vps.files = new Set([...FILE_NAMES, MARKER_NAME]);
    vps.companion = ownedContainer(companionId, names.container, { Running: true, Restarting: false, Health: { Status: "healthy" } });
    vps.volume = { Name: names.volume, Labels: ownedLabels() };
    vps.image = { Id: imageId, Config: { Labels: ownedLabels() } };
  }
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const failed = { code: 1, stdout: "", stderr: "" };
  const n8nNetworks = () => Object.fromEntries(Object.entries(vps.networks)
    .map(([name, network]) => [name, { NetworkID: network.Id, Aliases: vps.n8nAliases }]));
  vps.remote = {
    get host() { return vps.host; },
    async exec(command) {
      vps.calls.push(command);
      if (command === PRECHECK_COMMAND) return ok("managed\n");
      if (command.includes("printf absent")) return ok(vps.marker ? JSON.stringify(vps.marker) : "absent");
      const n8n = /^docker inspect (\S+) --format '\{\{json \.Id\}\}\|/u.exec(command);
      if (n8n) {
        const id = n8n[1] === selected.containerName ? vps.n8nId : vps.otherN8n[n8n[1]];
        return id ? ok(`${JSON.stringify(id)}|true|${JSON.stringify(n8nNetworks())}`) : failed;
      }
      const network = /^docker network inspect (\S+) --format '\{\{json \.\}\}'$/u.exec(command);
      if (network) {
        if (!vps.networks[network[1]]) return failed;
        return ok(JSON.stringify({ Name: network[1], ...vps.networks[network[1]], Containers: {
          [vps.n8nId]: { Name: selected.containerName },
          ...Object.fromEntries(Object.entries(vps.otherN8n).map(([name, id]) => [id, { Name: name }])),
          ...(vps.companion?.NetworkSettings.Networks[network[1]] ? { [vps.companion.Id]: { Name: names.container } } : {}),
        } }));
      }
      const member = /^docker inspect ([a-f0-9]{64}) --format '\{\{json \.NetworkSettings\.Networks\}\}'$/u.exec(command);
      if (member) return ok(JSON.stringify(member[1] === vps.companion?.Id ? vps.companion.NetworkSettings.Networks : n8nNetworks()));
      if (command.includes(`find ${ROOT} -mindepth 1`)) return ok([...vps.files].join("\n"));
      if (command.startsWith(`[ ! -L ${ROOT}/`)) {
        // A strict attestation needs every file; a partial one accepts the files that exist.
        const strict = !command.includes("if [ -e ");
        return vps.fail.has("files") || (strict && FILE_NAMES.some(name => !vps.files.has(name))) ? failed : ok();
      }
      if (command === `docker container inspect ${names.container}`) return vps.companion ? ok(JSON.stringify([vps.companion])) : failed;
      if (command === `docker container inspect ${names.credential}`) return vps.credential ? ok(JSON.stringify([vps.credential])) : failed;
      if (command === `docker volume inspect ${names.volume}`) return vps.volume ? ok(JSON.stringify([vps.volume])) : failed;
      if (command === "docker ps -a --format '{{.Names}}'") return ok(selected.containerName);
      if (command === "docker volume ls --format '{{.Name}}'") return ok("");
      if (command.startsWith("docker ps -a --filter label=com.docker.compose.project=")) {
        return ok([vps.companion && names.container, vps.credential && names.credential].filter(Boolean).join("\n"));
      }
      if (command.startsWith("docker volume ls --filter label=com.docker.compose.project=")) return ok(vps.volume ? names.volume : "");
      if (command === `docker image inspect ${names.image} --format '{{json .}}'`) {
        return vps.fail.has("image-check") || !vps.image ? failed : ok(JSON.stringify(vps.image));
      }
      if (command.startsWith(COMPOSE) && command.endsWith(" config --quiet")) return vps.fail.has("config") ? failed : ok();
      // Everything below changes the VPS.
      vps.writes.push(command);
      if (command.startsWith(SHARED_ROOT_COMMAND) || command === SHARED_ROOT_TIGHTEN_COMMAND) return ok();
      if (command === createVpsLockCommand(LOCK)) return ok("11:22\n");
      if (command === createVpsBuildStateCommand(LOCK, "11:22")) return ok("11:33\n");
      if (command === cleanupVpsBuildStateCommand(LOCK, "11:22", "11:33") || command === releaseVpsLockCommand(LOCK, "11:22")) return ok();
      if (command === `umask 077 && mkdir ${ROOT}`) return ok();
      if (command.includes(" BUILDX_CONFIG=") && command.endsWith(" build supergrok-oauth")) {
        if (vps.fail.has("build")) return failed;
        vps.image = { Id: imageId, Config: { Labels: vps.imageLabels } };
        return ok();
      }
      if (command.includes(" BUILDX_CONFIG=") && command.includes(` run -d --name ${names.credential} `)) {
        vps.credential = ownedContainer(credentialId, names.credential, { Running: true });
        return ok(credentialId);
      }
      if (command.startsWith(COMPOSE) && command.endsWith(" up -d --wait --wait-timeout 90 --no-build --no-deps supergrok-oauth")) {
        const started = !vps.fail.has("start");
        // A start that misses its health wait still leaves the created container and volume behind.
        vps.companion = ownedContainer(companionId, names.container,
          { Running: true, Restarting: false, Health: { Status: started ? "healthy" : "unhealthy" } });
        vps.volume = { Name: names.volume, Labels: ownedLabels() };
        return started ? ok() : failed;
      }
      const removed = /^docker rm (?:-f )?([a-f0-9]{64})$/u.exec(command);
      if (removed) {
        for (const key of ["companion", "credential"]) if (vps[key]?.Id === removed[1]) vps[key] = null;
        return ok();
      }
      if (command === `docker volume rm ${names.volume}`) {
        vps.volume = null;
        return ok();
      }
      if (command.startsWith("rm -f -- ") && command.endsWith(` && rmdir ${ROOT}`)) {
        vps.marker = null;
        vps.files.clear();
        return ok();
      }
      throw new Error(`Unexpected VPS command: ${command}`);
    },
    async upload(path, contents, mode) {
      assert.equal(mode, 0o600);
      assert.ok(path.startsWith(`${ROOT}/`));
      vps.uploads.push(path);
      const name = path.slice(ROOT.length + 1);
      vps.files.add(name);
      if (name === MARKER_NAME) vps.marker = JSON.parse(contents);
    },
  };
  return vps;
}

const n8nUntouched = vps => vps.calls.filter(command => command.includes(selected.containerName) || command.includes(vps.n8nId))
  .every(command => command.startsWith("docker inspect ") || command === "docker ps -a --format '{{.Names}}'");

async function apply(vps, action) {
  const plan = await reviewVpsSuperGrok({ remote: vps.remote, ...selected, action });
  return changeVpsSuperGrok({ remote: vps.remote, plan, confirmed: true });
}

test("an installed SuperGrok companion is healthy and each fact is read once per status check", async () => {
  const vps = createVps();
  assert.deepEqual(await inspectVpsSuperGrok({ remote: vps.remote, ...selected }), {
    state: "healthy", containerId, networkId, installId, endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT, credentialActionRunning: false,
  });
  // Was 15: the n8n container's networks were read twice and the files were attested twice.
  assert.equal(vps.calls.length, 12);
  assert.equal(new Set(vps.calls).size, vps.calls.length);
  assert.deepEqual(vps.writes, []);
});

test("the single file attestation and the single n8n read still refuse what the repeated ones refused", async () => {
  const tampered = createVps();
  tampered.fail.add("files");
  await assert.rejects(inspectVpsSuperGrok({ remote: tampered.remote, ...selected }), OWNERSHIP);

  const missing = createVps();
  missing.files.delete("gateway.js");
  await assert.rejects(inspectVpsSuperGrok({ remote: missing.remote, ...selected }), OWNERSHIP);
  // Without a running companion the same folder is an incomplete install, as before.
  missing.companion = null;
  assert.equal((await inspectVpsSuperGrok({ remote: missing.remote, ...selected })).state, "partial");

  const foreignFile = createVps();
  foreignFile.files.add("notes.txt");
  await assert.rejects(inspectVpsSuperGrok({ remote: foreignFile.remote, ...selected }), OWNERSHIP);

  // The alias check for the selected n8n container now uses the first read of its networks.
  const aliased = createVps({ installed: false });
  aliased.n8nAliases = ["n8n-supergrok"];
  await assert.rejects(inspectVpsSuperGrok({ remote: aliased.remote, ...selected }), /already in use/u);
  for (const vps of [tampered, missing, foreignFile, aliased]) assert.deepEqual(vps.writes, []);
});

test("status, sign-in, sign-out and removal keep working after n8n is recreated on the same network", async () => {
  const vps = createVps();
  vps.n8nId = recreatedN8nId;
  const status = await inspectVpsSuperGrok({ remote: vps.remote, ...selected });
  assert.deepEqual([status.state, status.containerId, status.networkId, status.installId], ["healthy", recreatedN8nId, networkId, installId]);

  assert.deepEqual(await apply(vps, "sign-in"), { state: "pending", installId });
  assert.equal(vps.credential.Id, credentialId);
  assert.deepEqual(await apply(vps, "cancel-sign-in"), { state: "cancelled", installId });
  assert.deepEqual(await apply(vps, "sign-out"), { state: "pending", installId });
  vps.credential.State = { Running: false, ExitCode: 0 };

  assert.deepEqual(await apply(vps, "remove"), { state: "absent", removed: true });
  assert.deepEqual([vps.marker, vps.companion, vps.credential, vps.volume], [null, null, null, null]);
  assert.ok(n8nUntouched(vps));
  assert.equal((await inspectVpsSuperGrok({ remote: vps.remote, ...selected })).state, "absent");
});

test("a plan reviewed against one n8n container is refused once that container is replaced", async () => {
  const vps = createVps();
  const plan = await reviewVpsSuperGrok({ remote: vps.remote, ...selected, action: "remove" });
  vps.n8nId = recreatedN8nId;
  await assert.rejects(changeVpsSuperGrok({ remote: vps.remote, plan, confirmed: true }), OWNERSHIP);
  assert.ok(vps.companion);
  assert.ok(vps.marker);
});

test("another network is refused by name, and a replaced network is refused, before any write", async () => {
  const vps = createVps();
  vps.networks["other-net"] = { Id: "9".repeat(64), Driver: "bridge", Internal: false };
  const other = { containerName: selected.containerName, networkName: "other-net" };
  const named = /installed on the Docker network "fixture-net"/u;
  await assert.rejects(inspectVpsSuperGrok({ remote: vps.remote, ...other }), named);
  for (const action of ["remove", "sign-in", "sign-out"]) {
    await assert.rejects(reviewVpsSuperGrok({ remote: vps.remote, ...other, action }), named, action);
  }

  // The same name with another network ID is a different network.
  const replaced = createVps();
  const plan = await reviewVpsSuperGrok({ remote: replaced.remote, ...selected, action: "remove" });
  replaced.networks[selected.networkName].Id = "9".repeat(64);
  const renamed = /Docker network "fixture-net" was replaced/u;
  await assert.rejects(inspectVpsSuperGrok({ remote: replaced.remote, ...selected }), renamed);
  await assert.rejects(reviewVpsSuperGrok({ remote: replaced.remote, ...selected, action: "remove" }), renamed);
  await assert.rejects(changeVpsSuperGrok({ remote: replaced.remote, plan, confirmed: true }), renamed);
  for (const each of [vps, replaced]) {
    assert.ok(each.companion);
    assert.ok(each.writes.every(command => !command.startsWith("docker ") && !command.startsWith("rm ")));
  }
});

test("a companion that is restarting, unhealthy or still starting is incomplete and removable, never healthy", async () => {
  for (const state of [
    { Running: true, Restarting: true, Health: { Status: "unhealthy" } },
    { Status: "restarting", Running: true, Health: { Status: "healthy" } },
    { Running: true, Restarting: false, Health: { Status: "unhealthy" } },
    { Running: true, Restarting: false, Health: { Status: "starting" } },
    { Running: false, Restarting: false, Health: { Status: "unhealthy" } },
  ]) {
    const vps = createVps();
    vps.companion.State = state;
    assert.equal((await inspectVpsSuperGrok({ remote: vps.remote, ...selected })).state, "partial", JSON.stringify(state));
    await assert.rejects(reviewVpsSuperGrok({ remote: vps.remote, ...selected, action: "sign-in" }), /not ready for that action/u);
    assert.deepEqual(await apply(vps, "remove"), { state: "absent", removed: true });
  }
});

test("a healthy companion with changed hardening still fails the ownership check", async () => {
  const vps = createVps();
  vps.companion.HostConfig.ReadonlyRootfs = false;
  await assert.rejects(inspectVpsSuperGrok({ remote: vps.remote, ...selected }), OWNERSHIP);
});

async function install(vps) {
  const plan = await reviewVpsSuperGrok({ remote: vps.remote, ...selected, action: "install" });
  return installVpsSuperGrok({ remote: vps.remote, plan, confirmed: true }, { entropy, readAssets });
}

test("a confirmed install creates the private companion and reports healthy", async () => {
  const vps = createVps({ installed: false });
  const result = await install(vps);
  assert.deepEqual([result.state, result.installId, result.credentialShownOnce], ["healthy", installId, true]);
  assert.equal(vps.marker.tokenSha256, sha256(result.clientKey));
  assert.equal(vps.marker.imageId, imageId);
  assert.ok(vps.calls.every(command => !command.includes(result.clientKey)));
  assert.ok(n8nUntouched(vps));
  assert.equal((await inspectVpsSuperGrok({ remote: vps.remote, ...selected })).state, "healthy");
});

test("each failed setup step names itself with its code, and the incomplete companion stays removable", async () => {
  for (const [failure, code, sentence] of [
    ["config", "vps_step_compose_config", /Docker Compose did not accept the SuperGrok files/u],
    ["build", "vps_step_build", /SuperGrok image did not build/u],
    ["image-check", "vps_step_image_check", /could not show the SuperGrok image/u],
    ["start", "vps_step_start", /did not become healthy/u],
  ]) {
    const vps = createVps({ installed: false });
    vps.fail.add(failure);
    await assert.rejects(install(vps), error => {
      assert.match(error.message, sentence, failure);
      assert.doesNotMatch(error.message, OWNERSHIP, failure);
      assert.equal(error.code, code, failure);
      // The server shows at most 240 characters and no absolute path.
      assert.ok(error.message.length <= 240, failure);
      assert.doesNotMatch(error.message, /\/[a-z]+\//u, failure);
      return true;
    });
    vps.fail.clear();
    assert.equal((await inspectVpsSuperGrok({ remote: vps.remote, ...selected })).state, "partial", failure);
    assert.deepEqual(await apply(vps, "remove"), { state: "absent", removed: true }, failure);
  }
});

test("an image that is not this install's keeps the ownership sentence without a step code", async () => {
  const vps = createVps({ installed: false });
  vps.imageLabels = { ...ownedLabels(), "io.relmio.install": "f".repeat(32) };
  await assert.rejects(install(vps), error => {
    assert.match(error.message, OWNERSHIP);
    assert.equal(error.code, undefined);
    return true;
  });
  const edited = createVps({ installed: false });
  edited.fail.add("files");
  await assert.rejects(install(edited), error => OWNERSHIP.test(error.message) && error.code === undefined);
});

test("an unsupported CPU refuses the install review without a remote call; an unknown CPU proceeds", async () => {
  for (const arch of ["riscv64", "armv7l", "s390x", "i686"]) {
    const vps = createVps({ installed: false });
    vps.host = { arch };
    await assert.rejects(reviewVpsSuperGrok({ remote: vps.remote, ...selected, action: "install" }), error => {
      assert.equal(error.code, "vps_host_unsupported_cpu", arch);
      assert.ok(error.message.length <= 240);
      return true;
    });
    assert.deepEqual(vps.calls, [], arch);
  }
  for (const host of [undefined, null, {}, { arch: null }, { arch: "x86_64" }, { arch: "aarch64" }]) {
    const vps = createVps({ installed: false });
    vps.host = host;
    assert.equal((await reviewVpsSuperGrok({ remote: vps.remote, ...selected, action: "install" })).action, "install", JSON.stringify(host));
  }
  // An installed companion can always be inspected and removed.
  const installed = createVps();
  installed.host = { arch: "riscv64" };
  assert.equal((await inspectVpsSuperGrok({ remote: installed.remote, ...selected })).state, "healthy");
  assert.deepEqual(await apply(installed, "remove"), { state: "absent", removed: true });
});

test("an install review refuses Docker's default bridge and an internal network; status and removal do not", async () => {
  const internal = createVps({ installed: false });
  internal.networks[selected.networkName].Internal = true;
  assert.equal((await inspectVpsSuperGrok({ remote: internal.remote, ...selected })).state, "absent");
  await assert.rejects(reviewVpsSuperGrok({ remote: internal.remote, ...selected, action: "install" }),
    error => error.code === "vps_network_unsupported" && /internal/u.test(error.message));

  const bridge = createVps({ installed: false });
  bridge.networks = { bridge: { Id: networkId, Driver: "bridge", Internal: false } };
  await assert.rejects(reviewVpsSuperGrok({ remote: bridge.remote, containerName: selected.containerName, networkName: "bridge", action: "install" }),
    error => error.code === "vps_network_unsupported" && /default bridge/u.test(error.message));

  // A network that turned internal after review is refused again inside the confirmed install.
  const late = createVps({ installed: false });
  const plan = await reviewVpsSuperGrok({ remote: late.remote, ...selected, action: "install" });
  late.networks[selected.networkName].Internal = true;
  await assert.rejects(installVpsSuperGrok({ remote: late.remote, plan, confirmed: true }, { entropy, readAssets }),
    error => error.code === "vps_network_unsupported");
  assert.deepEqual(late.uploads, []);

  const installed = createVps();
  installed.networks[selected.networkName].Internal = true;
  assert.equal((await inspectVpsSuperGrok({ remote: installed.remote, ...selected })).state, "healthy");
  assert.deepEqual(await apply(installed, "remove"), { state: "absent", removed: true });
});

test("SuperGrok step errors survive the HTTP safety filter and retain lock uncertainty", async t => {
  for (const [failure, code] of [
    ["config", "vps_step_compose_config"], ["build", "vps_step_build"],
    ["image-check", "vps_step_image_check"], ["start", "vps_step_start"],
  ]) {
    const vps = createVps({ installed: false });
    vps.fail.add(failure);
    const f = await serverFixture(t, services => {
      services.connectVerified = async request => verifiedSshFixture(request, { ...vps.remote, close() {} });
      services.reviewVpsSuperGrok = reviewVpsSuperGrok;
      services.installVpsSuperGrok = args => installVpsSuperGrok(args, { entropy, readAssets });
    });
    const response = await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" });
    assert.equal(response.status, 200);
    const plan = await response.json();
    const failed = await f.post("/api/vps/supergrok/apply", { ...plan, confirmed: true });
    assert.equal(failed.status, 400);
    const result = await failed.json();
    assert.equal(result.code, code);
    assert.notEqual(result.error, "The request could not be completed safely.");
    assert.doesNotMatch(result.error, /ownership|\/docker\//u);
  }
  const locked = createVps({ installed: false });
  locked.fail.add("build");
  const exec = locked.remote.exec;
  locked.remote.exec = async command => command === releaseVpsLockCommand(LOCK, "11:22")
    ? { code: 1, stdout: "" } : exec(command);
  await assert.rejects(install(locked), error => {
    assert.equal(error.code, "vps_step_build");
    assert.equal(error.operationLockRetained, true);
    assert.match(error.safeMessage, /SuperGrok image did not build.*administrator must inspect/u);
    assert.ok(error.safeMessage.length <= 240);
    return true;
  });
});

test("a companion installed for one n8n is not managed through another n8n on the same network", async () => {
  const vps = createVps();
  const secondId = "7".repeat(64);
  vps.otherN8n["n8n-second"] = secondId;
  const second = { containerName: "n8n-second", networkName: selected.networkName };
  const named = /installed for the n8n container "n8n-fixture"/u;
  await assert.rejects(inspectVpsSuperGrok({ remote: vps.remote, ...second }), named);
  for (const action of ["sign-in", "sign-out", "remove", "cancel-sign-in"]) {
    await assert.rejects(reviewVpsSuperGrok({ remote: vps.remote, ...second, action }), error => {
      assert.match(error.message, named, action);
      // The server shows at most 240 characters and no absolute path.
      assert.ok(error.message.length <= 240);
      assert.doesNotMatch(error.message, /\/[a-z]+\//u);
      return true;
    });
  }
  assert.deepEqual(vps.writes, []);

  // A reviewed plan pointed at the second n8n afterwards is refused under the lock, before any change.
  for (const action of ["sign-in", "sign-out", "remove"]) {
    const plan = await reviewVpsSuperGrok({ remote: vps.remote, ...selected, action });
    await assert.rejects(changeVpsSuperGrok({ remote: vps.remote, plan: { ...plan, ...second, containerId: secondId }, confirmed: true }), OWNERSHIP, action);
  }
  assert.ok(vps.writes.every(command => [createVpsLockCommand(LOCK), releaseVpsLockCommand(LOCK, "11:22")].includes(command)));
  assert.ok(vps.companion && vps.marker && vps.volume);
  assert.equal(vps.credential, null);

  // The stored name is only shown after it passed validation.
  const forged = createVps();
  forged.otherN8n["n8n-second"] = secondId;
  forged.marker.containerName = "n8n\"; touch /tmp/owned; \"";
  await assert.rejects(inspectVpsSuperGrok({ remote: forged.remote, ...second }), error => !/touch|owned/u.test(error.message));

  // The n8n it was installed for still manages it, also after that n8n was recreated.
  vps.n8nId = recreatedN8nId;
  assert.equal((await inspectVpsSuperGrok({ remote: vps.remote, ...selected })).state, "healthy");
  assert.deepEqual(await apply(vps, "remove"), { state: "absent", removed: true });
});

test("only a confirmed SuperGrok change that passed its checks sets the shared folder mode, once, before its first write", async () => {
  const tightened = vps => vps.writes.filter(command => command === SHARED_ROOT_TIGHTEN_COMMAND).length;
  const firstChange = vps => vps.writes.find(command => /^docker (?:rm|volume rm)|^rm -f -- | BUILDX_CONFIG=/u.test(command));
  for (const action of ["sign-in", "sign-out", "remove"]) {
    const vps = createVps();
    const plan = await reviewVpsSuperGrok({ remote: vps.remote, ...selected, action });
    assert.equal((await inspectVpsSuperGrok({ remote: vps.remote, ...selected })).state, "healthy");
    assert.equal(tightened(vps), 0, `${action}: status and review`);
    await changeVpsSuperGrok({ remote: vps.remote, plan, confirmed: true });
    assert.equal(tightened(vps), 1, action);
    assert.ok(vps.writes.indexOf(createVpsLockCommand(LOCK)) < vps.writes.indexOf(SHARED_ROOT_TIGHTEN_COMMAND), action);
    assert.ok(vps.writes.indexOf(SHARED_ROOT_TIGHTEN_COMMAND) < vps.writes.indexOf(firstChange(vps)), action);
  }
  const cancelling = createVps();
  await apply(cancelling, "sign-in");
  assert.deepEqual(await apply(cancelling, "cancel-sign-in"), { state: "cancelled", installId });
  assert.equal(tightened(cancelling), 2);

  // Unconfirmed, stale and refused requests change nothing.
  const refused = createVps();
  const plan = await reviewVpsSuperGrok({ remote: refused.remote, ...selected, action: "remove" });
  await assert.rejects(changeVpsSuperGrok({ remote: refused.remote, plan, confirmed: false }), /Confirm/u);
  assert.deepEqual(refused.writes, []);
  await assert.rejects(changeVpsSuperGrok({ remote: refused.remote, plan: { ...plan, installId: "f".repeat(32) }, confirmed: true }), OWNERSHIP);
  refused.n8nId = recreatedN8nId;
  await assert.rejects(changeVpsSuperGrok({ remote: refused.remote, plan, confirmed: true }), OWNERSHIP);
  refused.n8nId = containerId;
  refused.companion.HostConfig.ReadonlyRootfs = false;
  const signIn = { ...plan, action: "sign-in" };
  await assert.rejects(changeVpsSuperGrok({ remote: refused.remote, plan: signIn, confirmed: true }), OWNERSHIP);
  assert.equal(tightened(refused), 0);
  assert.ok(refused.companion);
});
