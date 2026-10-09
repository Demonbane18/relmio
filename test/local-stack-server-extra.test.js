import assert from "node:assert/strict";
import test from "node:test";
import { startIsolatedWizard } from "./helpers/siwc-wizard.js";

const dockerHost = "unix:///var/run/docker.sock";
const projectName = `relmio-local-n8n-${"a".repeat(32)}`;
const containerName = `${projectName}-n8n-1`;
const networkName = `${projectName}_edge`;
const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const sessionToken = "local-stack-server-regression-session-token";

async function startWizard(t, services) {
  const wizard = await startIsolatedWizard({ sessionToken, services: {
    async acquireLocalEndpointChangeLock() { return async () => {}; },
    async getLocalN8nStackStatus() { return { managed: false, state: "absent" }; },
    ...services,
  } });
  t.after(() => wizard.close());
  return wizard;
}

async function request(wizard, url, body) {
  const response = await fetch(`${wizard.origin}${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Setup-Token": sessionToken,
      ...(body === undefined ? {} : { Origin: wizard.origin }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("private stack plan rejects ngrok fields and installs without public confirmation", async t => {
  let installed;
  const wizard = await startWizard(t, {
    async getLocalDockerStatus() { return { dockerAvailable: true, dockerHost }; },
    async installLocalN8nStack(input) {
      installed = input;
      return { target: "local-n8n-stack", publicAccess: "none", localUrl: "http://localhost:5679",
        ngrokPublicUrl: null, n8nContainerName: containerName, networkName, projectName,
        containerServices: ["n8n"], networks: ["edge"], assistantSettings: null,
        assistantMode: "disabled", hostPublication: "n8n http://127.0.0.1:5679",
        deploymentMode: "new-disposable-stack" };
    },
  });
  const body = { target: "local-n8n-stack", publicAccess: "none", n8nPort: 5679,
    timezone: "Asia/Manila", assistantMode: "disabled" };
  const rejected = await request(wizard, "/api/local/plan", { ...body, ngrokHostname: "example.ngrok.app" });
  assert.equal(rejected.status, 400);
  const plan = await request(wizard, "/api/local/plan", body);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.plan.publicAccess, "none");
  assert.equal(plan.body.plan.ngrokPublicUrl, null);
  const bad = await request(wizard, "/api/local/install", { planId: plan.body.planId, confirmed: true,
    basicAuthPassword: "secret-value" });
  assert.equal(bad.status, 400);
  const result = await request(wizard, "/api/local/install", { planId: plan.body.planId, confirmed: true });
  assert.equal(result.status, 200);
  assert.equal(result.body.publicAccess, "none");
  assert.equal(result.body.networkName, networkName);
  assert.equal(Object.hasOwn(installed, "publicExposureConfirmation"), false);
  assert.deepEqual(installed.secrets, {});
});

test("discovery matches managed container ID and network; import failures leave SuperGrok key available", async t => {
  let input;
  const marker = { projectName, dockerHost, assistantMode: "disabled" };
  const wizard = await startWizard(t, {
    async discoverLocalN8nSidecarTargets() { return { dockerAvailable: true, dockerHost, containers: [
      { containerId, containerName, image: "docker.io/n8nio/n8n:2.42.5",
        networks: [{ dockerNetworkId: networkId, networkName, disposable: false }] },
      { containerId: "c".repeat(64), containerName, image: "docker.io/n8nio/n8n:2.42.5",
        networks: [{ dockerNetworkId: networkId, networkName, disposable: false }] },
    ] }; },
    async getManagedLocalN8nStackTarget() { return { marker, containerId }; },
    async importLocalStackN8nCredential(value) { input = value; return { state: "failed", name: "Relmio SuperGrok" }; },
    async installLocalN8nSuperGrok({ plan }) { return { target: "n8n-supergrok-oauth",
      endpoint: "http://n8n-supergrok:14502/v1", baseUrl: "http://n8n-supergrok:14502/v1",
      protocol: "openai-chat-completions", networkName: plan.networkName,
      n8nContainerName: plan.n8nContainerName, hostPublication: "none",
      clientKey: "S".repeat(43), credentialShownOnce: true, deploymentMode: "installed" }; },
  });
  const discovery = await request(wizard, "/api/local/n8n/discover");
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.containers[0].managedStack, true);
  assert.equal(discovery.body.containers[0].recommendedNetwork, networkName);
  assert.equal(discovery.body.containers[1].managedStack, false);
  const plan = await request(wizard, "/api/local/plan", {
    target: "n8n-supergrok-oauth", n8nContainerId: containerId, dockerNetworkId: networkId,
  });
  assert.equal(plan.status, 200);
  const installed = await request(wizard, "/api/local/install", { planId: plan.body.planId, confirmed: true });
  assert.equal(installed.status, 200);
  assert.deepEqual(installed.body.n8nCredential, { state: "failed", name: "Relmio SuperGrok" });
  assert.equal(installed.body.clientCredential, "S".repeat(43));
  assert.equal(input.credential.apiKey, "S".repeat(43));
  assert.equal(JSON.stringify(installed.body.n8nCredential).includes(input.credential.apiKey), false);
});

test("Assistant plan refuses managed n8n already configured at stack setup", async t => {
  const wizard = await startWizard(t, {
    async discoverLocalN8nSidecarTargets() { return { dockerAvailable: true, dockerHost, containers: [
      { containerId, containerName, image: "docker.io/n8nio/n8n:2.42.5",
        networks: [{ dockerNetworkId: networkId, networkName, disposable: false }] },
    ] }; },
    async getManagedLocalN8nStackTarget() { return { marker: { projectName, dockerHost, assistantMode: "sandbox" }, containerId }; },
  });
  const response = await request(wizard, "/api/local/plan", {
    target: "n8n-ai-assistant", n8nContainerId: containerId,
    dockerNetworkId: networkId, includeSearxng: false,
  });
  assert.equal(response.body.error, "This n8n already has Assistant tools from its setup.");
  assert.equal(response.status, 409);
});
