import { verifiedSshFixture } from "./helpers/ssh-session.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createLocalN8nModelPlan, LOCAL_N8N_MODEL_ENDPOINT } from "../src/domain/local-n8n-model.js";
import { installVpsLocalModel } from "../src/services/vps-local-model.js";
import { startWizardServer } from "../src/web/server.js";

const token = "m".repeat(43);
const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const selection = {
  dockerHost: "unix:///var/run/docker.sock", n8nContainerId: containerId,
  n8nContainerName: "owned-n8n", dockerNetworkId: networkId, networkName: "owned-private",
};
const resources = { memoryBytes: 16 * 1024 ** 3, cpus: 8, diskAvailableBytes: 80 * 1024 ** 3 };
const modelId = "qwen3:0.6b";
const digest = "a".repeat(64);

async function fixture(t, overrides = {}) {
  const observed = { discovery: 0, oauth: 0, localWrites: 0, remoteWrites: 0, reviewed: 0, n8nRunning: true };
  const local = { status: "absent", installId: randomUUID(), modelId, modelDigest: null, operationId: null };
  const vps = { state: "absent", installId: randomUUID(), modelId, operation: null };
  const localStatus = () => local.status === "absent"
    ? { target: "n8n-local-model", managed: false, status: "absent" }
    : { target: "n8n-local-model", managed: true, ...local, endpoint: LOCAL_N8N_MODEL_ENDPOINT,
      networkName: selection.networkName, containerName: selection.n8nContainerName,
      resourceBudget: { memoryBytes: 2 * 1024 ** 3, cpus: 4, contextTokens: 2048 },
      progress: null, reason: null, untrustedSecret: "must-not-escape" };
  const vpsStatus = () => vps.state === "absent"
    ? { state: "absent", installId: null, endpoint: null, modelId: null, operation: null }
    : { ...vps, endpoint: LOCAL_N8N_MODEL_ENDPOINT, untrustedSecret: "must-not-escape" };
  const remotePlan = ({ action, modelId: requestedModel }) => {
    const domain = createLocalN8nModelPlan({ ...selection, modelId: action === "install" ? requestedModel : vps.modelId, hostResources: resources });
    return { action, containerName: selection.n8nContainerName, networkName: selection.networkName,
      containerId, networkId, installId: action === "install" ? null : vps.installId,
      installDirectory: "/docker/n8n-openai-oauth/local-model", endpoint: LOCAL_N8N_MODEL_ENDPOINT,
      operationLockPath: "/docker/n8n-openai-oauth/.local-model-operation.lock",
      temporaryBuildStatePath: action === "remove" ? null : "/docker/n8n-openai-oauth/.local-model-operation.lock/buildx",
      sharedRootBootstrap: action === "install" ? {
        directory: "/docker/n8n-openai-oauth", markerPath: "/docker/n8n-openai-oauth/.managed-by-relmio-root",
        mayCreateDirectory: true, mayCreateMarker: true, preservesExistingMode: true,
      } : null,
      modelId: domain.modelId, approvedModelDigest: domain.approvedModelDigest,
      catalogRevision: domain.catalogRevision, runtimeImage: domain.runtimeImage,
      contextTokens: domain.contextTokens, memoryBytes: domain.memoryBytes, cpus: domain.cpus,
      expectedDownloadBytes: domain.expectedDownloadBytes, requiredDiskBytes: domain.requiredDiskBytes,
      reservedMemoryBytes: domain.reservedMemoryBytes, hostResources: resources,
      clearModelCache: action === "remove", publishedPorts: [], existingN8nChanges: [], existingN8nRestarts: 0 };
  };
  const services = {
    async getAuthStatus() { observed.oauth++; throw new Error("OAuth must never run for models"); },
    async getLocalDockerStatus() { return { dockerAvailable: true, dockerHost: selection.dockerHost, dockerVersion: "29.7.2", composeVersion: "2.39.1" }; },
    async getLocalN8nStackStatus() { return { managed: false, state: "absent" }; },
    async discoverLocalN8nSidecarTargets() {
      observed.discovery++;
      return { dockerAvailable: true, dockerHost: selection.dockerHost,
        containers: [{ containerId, containerName: selection.n8nContainerName, image: "n8nio/n8n:fixture",
          networks: [{ dockerNetworkId: networkId, networkName: selection.networkName, disposable: true }] }] };
    },
    async inspectLocalN8nModelResources() { return resources; },
    async getLocalN8nModelStatus() { return localStatus(); },
    async installLocalN8nModel({ plan, confirmed }) {
      assert.equal(confirmed, true);
      assert.equal(plan.modelId, modelId);
      observed.localWrites++;
      local.status = "runtime-ready";
      return localStatus();
    },
    async reviewLocalN8nModelAction({ action, removeModelData }) {
      if (local.status === "absent") throw new Error("No attested owned model");
      return { action, installId: local.installId, modelId, modelDigest: local.modelDigest,
        endpoint: LOCAL_N8N_MODEL_ENDPOINT, removeModelData: action === "remove",
        networkName: selection.networkName, containerName: selection.n8nContainerName,
        operationId: local.operationId, resourceBudget: localStatus().resourceBudget };
    },
    async applyLocalN8nModelAction({ review, confirmed }) {
      assert.equal(confirmed, true);
      observed.localWrites++;
      if (review.action === "remove") {
        local.status = "absent";
        return { target: "n8n-local-model", removed: true, cacheRetained: false };
      }
      local.status = "model-ready";
      local.modelDigest = digest;
      return localStatus();
    },
    async scanHostFingerprint() { return `SHA256:${"a".repeat(43)}`; },
    async connectVerified(request) { return verifiedSshFixture(request); },
    async discoverN8n() { return { containers: observed.n8nRunning ? [{ id: containerId, name: selection.n8nContainerName, image: "n8nio/n8n", state: "running" }] : [] }; },
    async discoverNetworks() { return { networks: [selection.networkName], instanceAi: { status: "missing" } }; },
    async inspectVpsLocalModel() { return vpsStatus(); },
    async reviewVpsLocalModel(options) { observed.reviewed++; return remotePlan(options); },
    async installVpsLocalModel({ plan, confirmed }) {
      assert.equal(confirmed, true);
      observed.remoteWrites++;
      vps.state = "downloading";
      vps.modelId = plan.modelId;
      vps.operation = { state: "downloading", phase: "download", completedBytes: 0, totalBytes: 522653277,
        modelDigest: null, errorCode: null, writerMayBeActive: true };
      return vpsStatus();
    },
    async changeVpsLocalModel({ plan, confirmed }) {
      assert.equal(confirmed, true);
      observed.remoteWrites++;
      if (plan.action === "remove") {
        vps.state = "absent";
        return { ...vpsStatus(), removed: true, modelCacheDeleted: true };
      }
      vps.state = "model-ready";
      vps.operation = { state: "model-ready", phase: "complete", completedBytes: 522653277, totalBytes: 522653277,
        modelDigest: `sha256:${digest}`, errorCode: null, writerMayBeActive: false };
      return vpsStatus();
    },
    async getVpsLocalModelOperationStatus() { return vpsStatus(); },
    ...overrides,
  };
  const server = await startWizardServer({ sessionToken: token, services, uiFiles: { "/": "fixture" } });
  t.after(() => server.close());
  const post = (path, body, authenticated = true) => fetch(`${server.origin}${path}`, {
    method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json", ...(authenticated ? { "X-Setup-Token": token } : {}) },
    body: JSON.stringify(body),
  });
  const get = (path) => fetch(`${server.origin}${path}`, { headers: { "X-Setup-Token": token } });
  return { post, get, observed, local, vps, services };
}

async function connectVps(fixture) {
  const scanned = await fixture.post("/api/ssh/fingerprint", { host: "fixture.example", port: 22 });
  assert.equal(scanned.status, 200);
  const { fingerprint } = await scanned.json();
  assert.equal((await fixture.post("/api/ssh/connect", { host: "fixture.example", port: 22, username: "root", useAgent: false, privilege: "root", password: "fixture-only", expectedFingerprint: fingerprint })).status, 200);
  assert.equal((await fixture.post("/api/discover", {})).status, 200);
  assert.equal((await fixture.post("/api/networks", { containerName: selection.n8nContainerName })).status, 200);
}

test("local model requires exact allowlisted selection and fresh human confirmation without OAuth", async t => {
  const f = await fixture(t);
  for (const body of [
    { target: "n8n-local-model", n8nContainerId: containerId, dockerNetworkId: networkId, modelId: "unauthorized:latest" },
    { target: "n8n-local-model", n8nContainerId: containerId, dockerNetworkId: networkId, modelId, authPath: "/secret" },
    { target: "n8n-local-model", n8nContainerId: `${containerId};echo bad`, dockerNetworkId: networkId, modelId },
  ]) assert.notEqual((await f.post("/api/local/plan", body)).status, 200);
  assert.equal(f.observed.oauth, 0);
  assert.equal(f.observed.localWrites, 0);
  const reviewed = await f.post("/api/local/plan", { target: "n8n-local-model", n8nContainerId: containerId, dockerNetworkId: networkId, modelId });
  assert.equal(reviewed.status, 200);
  const { planId, plan } = await reviewed.json();
  assert.match(plan.approvedModelDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(plan.hostPublication, "none");
  assert.equal(plan.authentication, "none");
  assert.equal(plan.hostResources.diskAvailableBytes, resources.diskAvailableBytes);
  assert.equal((await f.post("/api/local/install", { planId, confirmed: false })).status, 400);
  assert.equal((await f.post("/api/local/install", { planId, confirmed: true, oauthToken: "forbidden" })).status, 400);
  assert.equal(f.observed.localWrites, 0);
  const installed = await f.post("/api/local/install", { planId, confirmed: true });
  assert.equal(installed.status, 200);
  assert.equal((await installed.json()).status, "runtime-ready");
  assert.equal((await f.post("/api/local/install", { planId, confirmed: true })).status, 400);
  assert.equal(f.observed.localWrites, 1);
  assert.equal(f.observed.oauth, 0);
});

test("local model retry and destructive removal are separately reviewed and reattested", async t => {
  const f = await fixture(t);
  f.local.status = "model-error";
  const review = await f.post("/api/local/model/plan", { action: "retry" });
  assert.equal(review.status, 200);
  const { reviewId } = await review.json();
  assert.equal((await f.post("/api/local/model/apply", { reviewId, confirmed: false })).status, 400);
  f.local.installId = randomUUID();
  assert.equal((await f.post("/api/local/model/apply", { reviewId, confirmed: true })).status, 400);
  assert.equal(f.observed.localWrites, 0);
  const fresh = await f.post("/api/local/model/plan", { action: "retry" });
  const applied = await f.post("/api/local/model/apply", { reviewId: (await fresh.json()).reviewId, confirmed: true });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).status, "model-ready");
  const removedReview = await f.post("/api/local/model/plan", { action: "remove", removeModelData: true });
  assert.equal(removedReview.status, 200);
  const removeId = (await removedReview.json()).reviewId;
  assert.equal((await f.post("/api/local/model/apply", { reviewId: removeId, confirmed: true })).status, 400);
  assert.equal((await f.post("/api/local/model/apply", { reviewId: removeId, confirmed: true, removeModelData: true })).status, 200);
  assert.equal((await (await f.get("/api/local/model/status")).json()).status, "absent");
  assert.equal(f.observed.localWrites, 2);
});

test("VPS model confirms SSH identity then rejects unreviewed, stale and boundary-changing actions", async t => {
  const f = await fixture(t);
  const boundary = { containerName: selection.n8nContainerName, networkName: selection.networkName };
  assert.equal((await f.post("/api/ssh/connect", { host: "fixture.example", port: 22, username: "root", useAgent: false, privilege: "root", password: "fixture-only", expectedFingerprint: "SHA256:unverified" })).status, 400);
  assert.equal((await f.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId })).status, 400);
  const notConnected = await f.get("/api/ssh/connection");
  assert.equal(notConnected.status, 200);
  assert.deepEqual(await notConnected.json(), { connected: false });
  await connectVps(f);
  const identity = await (await f.get("/api/ssh/connection")).json();
  assert.deepEqual(identity, { host: "fixture.example", port: 22, fingerprint: `SHA256:${"a".repeat(43)}`,
    username: "root", authentication: "password", privilege: "root", loginUid: 0, effectiveUid: 0, scope: "vps", generation: 1 });
  assert.equal((await f.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId, extra: true })).status, 400);
  assert.equal((await f.post("/api/vps/local-model/plan", { containerName: "n8n;echo bad", networkName: boundary.networkName, action: "install", modelId })).status, 400);
  assert.equal(f.observed.reviewed, 0);
  const response = await f.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId });
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.match(plan.approvedModelDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(plan.publishedPorts, []);
  assert.deepEqual(plan.sharedRootBootstrap, {
    directory: "/docker/n8n-openai-oauth", markerPath: "/docker/n8n-openai-oauth/.managed-by-relmio-root",
    mayCreateDirectory: true, mayCreateMarker: true, preservesExistingMode: true,
  });
  assert.equal(plan.operationLockPath, "/docker/n8n-openai-oauth/.local-model-operation.lock");
  assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "install", planId: plan.planId, confirmed: false })).status, 400);
  assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "install", planId: plan.planId, confirmed: true })).status, 200);
  assert.equal(f.observed.remoteWrites, 1);
  assert.deepEqual(await (await f.get("/api/ssh/connection")).json(), identity);
  const removalReview = await f.post("/api/vps/local-model/plan", { ...boundary, action: "remove", clearModelCache: true });
  assert.equal(removalReview.status, 200);
  const status = await (await f.post("/api/vps/local-model/status", boundary)).json();
  assert.equal(status.state, "downloading");
  assert.equal(status.operation.writerMayBeActive, true);
  assert.equal(JSON.stringify(status).includes("must-not-escape"), false);
  assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "install", planId: plan.planId, confirmed: true })).status, 400);
  assert.equal((await f.post("/api/disconnect", {})).status, 200);
  const disconnected = await f.get("/api/ssh/connection");
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), { connected: false });
  assert.equal((await f.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId })).status, 400);
});

test("VPS cache removal can be reviewed after n8n discovery disappears but still needs both confirmations", async t => {
  const f = await fixture(t);
  await connectVps(f);
  f.vps.state = "model-ready";
  f.vps.operation = { state: "model-ready", phase: "complete", completedBytes: 522653277, totalBytes: 522653277,
    modelDigest: `sha256:${digest}`, errorCode: null, writerMayBeActive: false };
  f.observed.n8nRunning = false;
  assert.equal((await f.post("/api/discover", {})).status, 200);
  const boundary = { containerName: selection.n8nContainerName, networkName: selection.networkName };
  assert.equal((await f.post("/api/vps/local-model/plan", { ...boundary, action: "remove" })).status, 400);
  const reviewed = await f.post("/api/vps/local-model/plan", { ...boundary, action: "remove", clearModelCache: true });
  assert.equal(reviewed.status, 200);
  const planId = (await reviewed.json()).planId;
  assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "remove", planId, confirmed: false })).status, 400);
  assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "remove", planId, confirmed: true })).status, 400);
  assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "remove", planId, confirmed: true, clearModelCache: false })).status, 400);
  assert.equal(f.observed.remoteWrites, 0);
  const removed = await f.post("/api/vps/local-model/apply", { ...boundary, action: "remove", planId, confirmed: true, clearModelCache: true });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { state: "absent", installId: null, modelId: null, endpoint: null, operation: null, removed: true, modelCacheDeleted: true });
  assert.equal(f.observed.remoteWrites, 1);
});

test("VPS HTTP apply crosses the real installer plan validator before any remote write", async t => {
  const f = await fixture(t, {
    async installVpsLocalModel({ plan, confirmed }) {
      return installVpsLocalModel({
        plan, confirmed,
        remote: { async exec() { throw new Error("read-only boundary reached"); } },
      });
    },
  });
  await connectVps(f);
  const boundary = { containerName: selection.n8nContainerName, networkName: selection.networkName };
  const review = await f.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId });
  assert.equal(review.status, 200);
  const { planId } = await review.json();
  const applied = await f.post("/api/vps/local-model/apply", { ...boundary, action: "install", planId, confirmed: true });
  assert.equal(applied.status, 400);
  assert.match((await applied.json()).error, /read-only boundary reached/u);
  assert.equal(f.observed.remoteWrites, 0);
});

test("denied credential routes preserve a sudo model review and leave local sign-in available", async t => {
  const f = await fixture(t);
  const { fingerprint } = await (await f.post("/api/ssh/fingerprint", { host: "fixture.example", port: 22 })).json();
  assert.equal((await f.post("/api/ssh/connect", {
    host: "fixture.example", port: 22, username: "ubuntu", useAgent: true,
    privilege: "sudo-n", expectedFingerprint: fingerprint,
  })).status, 200);
  await f.post("/api/discover", {});
  const boundary = { containerName: selection.n8nContainerName, networkName: selection.networkName };
  await f.post("/api/networks", { containerName: boundary.containerName });
  const reviewed = await f.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId });
  assert.equal(reviewed.status, 200);
  const { planId } = await reviewed.json();
  for (const path of ["/api/plan", "/api/install", "/api/assistant/plan", "/api/assistant/install", "/api/vps/supergrok/plan", "/api/vps/supergrok/models"]) {
    assert.equal((await f.post(path, { clientKey: "must-not-be-read" })).status, 403);
  }
  assert.equal(f.observed.oauth, 0);
  assert.equal(f.observed.remoteWrites, 0);
  // Safe local OAuth status remains available; VPS scope is not a global login prohibition.
  assert.equal((await f.get("/api/oauth/status")).status, 200);
  assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "install", planId, confirmed: true })).status, 200);
  assert.equal(f.observed.remoteWrites, 1);
});

test("model review rejects missing or unconfined temporary build state before approval", async t => {
  const source = await fixture(t);
  await connectVps(source);
  const boundary = { containerName: selection.n8nContainerName, networkName: selection.networkName };
  const approved = await (await source.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId })).json();
  const { planId: _planId, ...validPlan } = approved;
  let temporaryBuildStatePath;
  const f = await fixture(t, {
    async reviewVpsLocalModel() { return { ...validPlan, temporaryBuildStatePath }; },
  });
  await connectVps(f);
  for (const invalid of [undefined, "/root/.docker/buildx", "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx"]) {
    temporaryBuildStatePath = invalid;
    assert.equal((await f.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId })).status, 502);
    assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "install", planId: "not-reviewed", confirmed: true })).status, 400);
    assert.equal(f.observed.remoteWrites, 0);
  }
  temporaryBuildStatePath = "/docker/n8n-openai-oauth/.local-model-operation.lock/buildx";
  const reviewed = await f.post("/api/vps/local-model/plan", { ...boundary, action: "install", modelId });
  assert.equal(reviewed.status, 200);
  const accepted = await reviewed.json();
  assert.equal(accepted.temporaryBuildStatePath, temporaryBuildStatePath);
  assert.equal((await f.post("/api/vps/local-model/apply", { ...boundary, action: "install", planId: accepted.planId, confirmed: false })).status, 400);
  assert.equal(f.observed.remoteWrites, 0);
});
