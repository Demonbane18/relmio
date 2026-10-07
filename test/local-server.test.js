import { verifiedSshFixture } from "./helpers/ssh-session.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import packageManifest from "../package.json" with { type: "json" };

import { ASSISTANT_COMPANION_IMAGES } from "../src/domain/assistant-templates.js";
import {
  LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE,
  LOCAL_N8N_STACK_NGROK_SETUP_REJECTED_FAILURE_KIND,
  LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE,
} from "../src/services/local-n8n-stack-installer.js";
import { startIsolatedWizard as startWizardServer, siwcAccount, siwcInstallResult, installedChatStatus } from "./helpers/siwc-wizard.js";
import { createLocalN8nSidecarPlan } from "../src/domain/local-n8n-sidecar.js";

const sessionToken = "local-server-test-session-token-1234567890";
const clientCredential = "local-client-credential-shown-once";

function dashboardProviders() {
  return [
    { target: "codex-chatgpt", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
    { target: "codex-chat", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
    { target: "xai-grok-build", label: "SuperGrok", authentication: "provider-oauth", readiness: "runtime-owned" },
    { target: "n8n-supergrok-oauth", label: "SuperGrok (n8n)", authentication: "provider-oauth", readiness: "runtime-owned" },
  ];
}

async function startLocalWizard(
  t,
  services,
  {
    previewMode = false,
    controlToken,
    controlInstanceId,
    onControlStop,
  } = {},
) {
  const wizard = await startWizardServer({
    sessionToken,
    services: {
      async acquireLocalEndpointChangeLock() {
        return async () => {};
      },
      async getLocalN8nStackStatus() {
        return { managed: false, state: "absent" };
      },
      async getManagedLocalEndpointStatus() {
        return { managed: false, state: "absent", snapshot: null };
      },
      ...services,
    },
    controlToken,
    controlInstanceId,
    onControlStop,
    previewMode,
    uiFiles: {
      "/": "",
      "/local": "",
      "/app.js": "",
      "/local.js": "",
      "/styles.css": "",
      "/local.css": "",
    },
  });
  t.after(() => wizard.close());
  return wizard;
}

test("persistent control endpoints report identity and request a separately authenticated shutdown", async (t) => {
  const controlToken = "d".repeat(43);
  const controlInstanceId = "11111111-1111-4111-8111-111111111111";
  let shutdownRequests = 0;
  let resolveShutdownRequest;
  const shutdownRequested = new Promise((resolve) => {
    resolveShutdownRequest = resolve;
  });
  const wizard = await startLocalWizard(t, {}, {
    controlToken,
    controlInstanceId,
    onControlStop() {
      shutdownRequests += 1;
      resolveShutdownRequest();
    },
  });
  const statusResponse = await fetch(`${wizard.origin}/__relmio/control/status`, {
    headers: { "X-Relmio-Control": controlToken },
  });
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(await statusResponse.json(), {
    kind: "relmio-dashboard-control",
    protocolVersion: 1,
    packageVersion: packageManifest.version,
    instanceId: controlInstanceId,
    pid: process.pid,
    origin: wizard.origin,
  });

  const unauthorized = await fetch(`${wizard.origin}/__relmio/control/status`, {
    headers: { "X-Setup-Token": sessionToken },
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(shutdownRequests, 0);

  const wrongToken = await fetch(`${wizard.origin}/__relmio/control/stop`, {
    method: "POST",
    headers: { "X-Relmio-Control": "e".repeat(43) },
  });
  assert.equal(wrongToken.status, 401);
  assert.equal(shutdownRequests, 0);

  const stopResponse = await fetch(`${wizard.origin}/__relmio/control/stop`, {
    method: "POST",
    headers: { "X-Relmio-Control": controlToken },
  });
  assert.equal(stopResponse.status, 202);
  assert.deepEqual(await stopResponse.json(), {
    stopping: true,
    instanceId: controlInstanceId,
  });

  await shutdownRequested;
  assert.equal(shutdownRequests, 1);
});

test("foreground wizard refuses the persistent shutdown endpoint", async (t) => {
  const wizard = await startLocalWizard(t, {});
  const response = await fetch(`${wizard.origin}/__relmio/control/stop`, {
    method: "POST",
    headers: { "X-Relmio-Control": "d".repeat(43) },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found." });
});

test("persistent shutdown refuses to interrupt an in-flight local mutation", async (t) => {
  const controlToken = "f".repeat(43);
  let releaseInstall;
  let notifyInstallStarted;
  let shutdownRequests = 0;
  const installStarted = new Promise((resolve) => {
    notifyInstallStarted = resolve;
  });
  const installGate = new Promise((resolve) => {
    releaseInstall = resolve;
  });
  t.after(() => releaseInstall());
  const wizard = await startLocalWizard(t, {
    async installLocalEndpoint({ plan }) {
      notifyInstallStarted();
      await installGate;
      return {
        target: plan.target,
        endpoint: plan.endpoint,
        protocol: plan.protocol,
        clientCredential,
        credentialShownOnce: true,
        models: ["gpt-5.6-sol"],
        deploymentMode: "installed",
        experimental: plan.experimental,
        browserClients: plan.browserClients,
      };
    },
  }, {
    controlToken,
    controlInstanceId: "22222222-2222-4222-8222-222222222222",
    onControlStop() {
      shutdownRequests += 1;
    },
  });

  const plan = await createPlan(wizard, {
    target: "xai-grok-build",
    port: 14502,
  });
  const installing = postJson(wizard, "/api/local/install", {
    planId: plan.planId,
    confirmed: true,
  });
  await installStarted;

  const stopResponse = await fetch(`${wizard.origin}/__relmio/control/stop`, {
    method: "POST",
    headers: { "X-Relmio-Control": controlToken },
  });
  assert.equal(stopResponse.status, 409);
  assert.match((await stopResponse.json()).error, /another operation/iu);
  assert.equal(shutdownRequests, 0);

  releaseInstall();
  assert.equal((await installing).status, 200);
});

test("persistent shutdown refuses to interrupt an in-flight VPS identity scan", async (t) => {
  const controlToken = "g".repeat(43);
  let releaseScan;
  let notifyScanStarted;
  let shutdownRequests = 0;
  const scanStarted = new Promise((resolve) => {
    notifyScanStarted = resolve;
  });
  const scanGate = new Promise((resolve) => {
    releaseScan = resolve;
  });
  t.after(() => releaseScan());
  const wizard = await startLocalWizard(t, {
    async scanHostFingerprint() {
      notifyScanStarted();
      await scanGate;
      return "SHA256:verified-test-fingerprint";
    },
  }, {
    controlToken,
    controlInstanceId: "33333333-3333-4333-8333-333333333333",
    onControlStop() {
      shutdownRequests += 1;
    },
  });

  const scanning = postJson(wizard, "/api/ssh/fingerprint", {
    host: "192.0.2.10",
    port: 22,
  });
  await scanStarted;

  const stopResponse = await fetch(`${wizard.origin}/__relmio/control/stop`, {
    method: "POST",
    headers: { "X-Relmio-Control": controlToken },
  });
  assert.equal(stopResponse.status, 409);
  assert.match((await stopResponse.json()).error, /another operation/iu);
  assert.equal(shutdownRequests, 0);

  releaseScan();
  assert.equal((await scanning).status, 200);
});

test("persistent shutdown refuses to interrupt an active authenticated VPS request", async (t) => {
  const controlToken = "j".repeat(43);
  let releaseDiscovery;
  let notifyDiscoveryStarted;
  let shutdownRequests = 0;
  const discoveryStarted = new Promise((resolve) => {
    notifyDiscoveryStarted = resolve;
  });
  const discoveryGate = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  t.after(() => releaseDiscovery());
  const remote = { close() {} };
  const wizard = await startLocalWizard(t, {
    async scanHostFingerprint() {
      return `SHA256:${"a".repeat(43)}`;
    },
    async connectVerified(request) {
      return verifiedSshFixture(request, remote);
    },
    async discoverN8n() {
      notifyDiscoveryStarted();
      await discoveryGate;
      return { containers: [] };
    },
  }, {
    controlToken,
    controlInstanceId: "66666666-6666-4666-8666-666666666666",
    onControlStop() {
      shutdownRequests += 1;
    },
  });

  const fingerprint = await postJson(wizard, "/api/ssh/fingerprint", {
    host: "192.0.2.10",
    port: 22,
  });
  const { fingerprint: expectedFingerprint } = await fingerprint.json();
  const connected = await postJson(wizard, "/api/ssh/connect", {
    host: "192.0.2.10",
    port: 22,
    username: "root",
    useAgent: false, privilege: "root",
    password: "x".repeat(32),
    expectedFingerprint,
  });
  assert.equal(connected.status, 200);

  const discovery = postJson(wizard, "/api/discover", {});
  await discoveryStarted;
  const stopResponse = await fetch(`${wizard.origin}/__relmio/control/stop`, {
    method: "POST",
    headers: { "X-Relmio-Control": controlToken },
  });
  assert.equal(stopResponse.status, 409);
  assert.match((await stopResponse.json()).error, /another operation/iu);
  assert.equal(shutdownRequests, 0);

  releaseDiscovery();
  assert.equal((await discovery).status, 200);
});

test("persistent shutdown accepts terminal OAuth retry-blocked state", async (t) => {
  const controlToken = "h".repeat(43);
  const controlInstanceId = "44444444-4444-4444-8444-444444444444";
  let shutdownRequests = 0;
  let resolveShutdownRequest;
  const shutdownRequested = new Promise((resolve) => {
    resolveShutdownRequest = resolve;
  });
  const wizard = await startLocalWizard(t, {
    async startOAuthLogin() {
      throw Object.assign(
        new Error("The ChatGPT sign-in result could not be confirmed."),
        { retryBlocked: true },
      );
    },
  }, {
    controlToken,
    controlInstanceId,
    onControlStop() {
      shutdownRequests += 1;
      resolveShutdownRequest();
    },
  });

  const login = await postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
  assert.equal(login.status, 400);
  assert.equal((await login.json()).retryBlocked, true);

  const stopResponse = await fetch(`${wizard.origin}/__relmio/control/stop`, {
    method: "POST",
    headers: { "X-Relmio-Control": controlToken },
  });
  assert.equal(stopResponse.status, 202);
  assert.deepEqual(await stopResponse.json(), {
    stopping: true,
    instanceId: controlInstanceId,
  });
  await shutdownRequested;
  assert.equal(shutdownRequests, 1);
});

test("persistent shutdown still refuses an active OAuth attempt", async (t) => {
  const controlToken = "i".repeat(43);
  let shutdownRequests = 0;
  const wizard = await startLocalWizard(t, {
    async startOAuthLogin() {
      return {
        launchMode: "system-browser",
        completion: new Promise(() => {}),
        cancel() {},
      };
    },
  }, {
    controlToken,
    controlInstanceId: "55555555-5555-4555-8555-555555555555",
    onControlStop() {
      shutdownRequests += 1;
    },
  });

  const login = await postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
  assert.equal(login.status, 200);

  const stopResponse = await fetch(`${wizard.origin}/__relmio/control/stop`, {
    method: "POST",
    headers: { "X-Relmio-Control": controlToken },
  });
  assert.equal(stopResponse.status, 409);
  assert.match((await stopResponse.json()).error, /another operation/iu);
  assert.equal(shutdownRequests, 0);
});

test("persistent shutdown refuses OAuth startup and cancellation work", async (t) => {
  await t.test("startup", async (subtest) => {
    const controlToken = "k".repeat(43);
    let releaseStart;
    let notifyStart;
    let shutdownRequests = 0;
    const startEntered = new Promise((resolve) => {
      notifyStart = resolve;
    });
    const startGate = new Promise((resolve) => {
      releaseStart = resolve;
    });
    subtest.after(() => releaseStart());
    const wizard = await startLocalWizard(subtest, {
      async startOAuthLogin() {
        notifyStart();
        await startGate;
        return {
          launchMode: "system-browser",
          completion: Promise.resolve(siwcAccount),
          cancel() {},
        };
      },
    }, {
      controlToken,
      controlInstanceId: "77777777-7777-4777-8777-777777777777",
      onControlStop() {
        shutdownRequests += 1;
      },
    });

    const login = postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
    await startEntered;
    const stopResponse = await fetch(`${wizard.origin}/__relmio/control/stop`, {
      method: "POST",
      headers: { "X-Relmio-Control": controlToken },
    });
    assert.equal(stopResponse.status, 409);
    assert.equal(shutdownRequests, 0);

    releaseStart();
    assert.equal((await login).status, 200);
  });

  await t.test("cancellation", async (subtest) => {
    const controlToken = "l".repeat(43);
    let releaseCancel;
    let notifyCancel;
    let shutdownRequests = 0;
    const cancelEntered = new Promise((resolve) => {
      notifyCancel = resolve;
    });
    const cancelGate = new Promise((resolve) => {
      releaseCancel = resolve;
    });
    subtest.after(() => releaseCancel());
    const wizard = await startLocalWizard(subtest, {
      async startOAuthLogin() {
        return {
          launchMode: "system-browser",
          completion: new Promise(() => {}),
          async cancel() {
            notifyCancel();
            await cancelGate;
          },
        };
      },
    }, {
      controlToken,
      controlInstanceId: "88888888-8888-4888-8888-888888888888",
      onControlStop() {
        shutdownRequests += 1;
      },
    });

    const login = await postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
    const { attemptId } = await login.json();
    const cancelling = postJson(wizard, "/api/oauth/cancel", { attemptId });
    await cancelEntered;
    const stopResponse = await fetch(`${wizard.origin}/__relmio/control/stop`, {
      method: "POST",
      headers: { "X-Relmio-Control": controlToken },
    });
    assert.equal(stopResponse.status, 409);
    assert.equal(shutdownRequests, 0);

    releaseCancel();
    assert.equal((await cancelling).status, 200);
  });
});

async function api(wizard, path, options = {}) {
  return await fetch(`${wizard.origin}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Setup-Token": sessionToken,
      ...(options.method === "POST" ? { Origin: wizard.origin } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function postJson(wizard, path, body) {
  return await api(wizard, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function createPlan(wizard, body) {
  const response = await postJson(wizard, "/api/local/plan", body);
  assert.equal(response.status, 200);
  return await response.json();
}

test("default wizard assets include the local endpoint flow", async (t) => {
  const wizard = await startWizardServer({ sessionToken });
  t.after(() => wizard.close());

  const page = await fetch(`${wizard.origin}/local`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/u);
  const packageManifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.ok((await page.text()).includes(`v${packageManifest.version}`));

  const script = await fetch(`${wizard.origin}/local.js`);
  assert.equal(script.status, 200);
  assert.match(
    script.headers.get("content-type") ?? "",
    /^text\/javascript/u,
  );

  const feedbackScript = await fetch(`${wizard.origin}/chat-tester-feedback.js`);
  assert.equal(feedbackScript.status, 200);
  assert.match(
    feedbackScript.headers.get("content-type") ?? "",
    /^text\/javascript/u,
  );
  assert.match(await feedbackScript.text(), /nextChatTesterFeedback/u);

  const styles = await fetch(`${wizard.origin}/local.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get("content-type") ?? "", /^text\/css/u);
});

test("hosting catalog and static review assets are available without provider or host reads", async (t) => {
  let hostReads = 0;
  const wizard = await startWizardServer({
    sessionToken,
    services: {
      async getLocalDockerStatus() { hostReads++; throw new Error("must not inspect Docker"); },
      async discoverN8n() { hostReads++; throw new Error("must not inspect n8n"); },
      async getSshCapabilities() { hostReads++; throw new Error("must not inspect SSH"); },
    },
  });
  t.after(() => wizard.close());
  for (const [path, type] of [
    ["/hosting", "text/html"],
    ["/hosting.js", "text/javascript"],
    ["/hosting-archive.js", "text/javascript"],
    ["/hosting.css", "text/css"],
    ["/domain/hosting-providers.js", "text/javascript"],
  ]) {
    const response = await fetch(`${wizard.origin}${path}`);
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("content-type")?.startsWith(type));
  }
  const denied = await fetch(`${wizard.origin}/api/hosting/providers`);
  assert.equal(denied.status, 401);
  const response = await fetch(`${wizard.origin}/api/hosting/providers`, {
    headers: { "X-Setup-Token": sessionToken },
  });
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.ok(catalog.providers.some((provider) => provider.id === "render" && provider.components.model.mode === "manual"));
  assert.ok(catalog.profiles.some((profile) => profile.providerId === "render" && profile.component === "model"));
  assert.ok(catalog.models.some((model) => model.id === "qwen3:0.6b"));
  assert.equal(hostReads, 0);
});

test("hosting plan API rejects unauthenticated, cross-origin, unsafe and unknown requests without provider reads or input echo", async (t) => {
  let hostReads = 0;
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() { hostReads++; throw new Error("must not inspect Docker"); },
    async discoverN8n() { hostReads++; throw new Error("must not inspect n8n"); },
    async getSshCapabilities() { hostReads++; throw new Error("must not inspect SSH"); },
  });
  const base = {
    providerId: "render", component: "model", deploymentId: "a1b2c3d4e5f6",
    modelId: "qwen3:0.6b", inputs: { region: "frankfurt", plan: "2c-4g", diskGB: 20 },
  };
  const unauthenticated = await fetch(`${wizard.origin}/api/hosting/plan`, {
    method: "POST",
    headers: { Origin: wizard.origin, "Content-Type": "application/json" },
    body: JSON.stringify(base),
  });
  assert.equal(unauthenticated.status, 401);
  const crossOrigin = await api(wizard, "/api/hosting/plan", {
    method: "POST",
    headers: { Origin: "http://localhost:3000" },
    body: JSON.stringify(base),
  });
  assert.equal(crossOrigin.status, 403);
  for (const invalid of [
    { ...base, deploymentId: "A1B2C3D4E5F6" },
    { ...base, providerId: "not-a-provider" },
    { ...base, modelId: "unapproved:latest" },
    { ...base, apiKey: "sk-should-not-appear-in-response" },
    { ...base, inputs: { ...base.inputs, apiKey: "sk-should-not-appear-in-response" } },
  ]) {
    const response = await postJson(wizard, "/api/hosting/plan", invalid);
    assert.equal(response.status, 400);
    assert.doesNotMatch(JSON.stringify(await response.json()), /sk-should-not-appear-in-response/u);
  }
  const oversized = await api(wizard, "/api/hosting/plan", {
    method: "POST",
    body: JSON.stringify({ ...base, inputs: { region: "x".repeat(33_000) } }),
  });
  assert.equal(oversized.status, 413);
  const accepted = await postJson(wizard, "/api/hosting/plan", base);
  assert.equal(accepted.status, 200);
  const plan = await accepted.json();
  assert.equal(plan.resourceName, "relmio-model-a1b2c3d4e5f6");
  assert.ok(plan.files.some((file) => file.name === "INSTRUCTIONS.md"));
  assert.equal(hostReads, 0);
});

test("hosting plans remain pure and downloadable in preview mode without SSH or Docker", async (t) => {
  let hostReads = 0;
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() { hostReads++; throw new Error("must not inspect Docker"); },
    async discoverN8n() { hostReads++; throw new Error("must not inspect n8n"); },
    async getSshCapabilities() { hostReads++; throw new Error("must not inspect SSH"); },
  }, { previewMode: true });
  const response = await postJson(wizard, "/api/hosting/plan", {
    providerId: "render",
    component: "searxng",
    deploymentId: "a1b2c3d4e5f6",
    inputs: { region: "frankfurt", plan: "1c-2g" },
  });
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.equal(plan.kind, "manual");
  assert.equal(plan.verification, "not-live-tested");
  assert.equal(plan.resourceName, "relmio-searxng-a1b2c3d4e5f6");
  assert.ok(plan.files.some((file) => file.name === "INSTRUCTIONS.md" && file.content.includes("NOT-RUN")));
  assert.ok(plan.files.some((file) => file.name === "render.yaml" && file.content.includes("type: pserv")));
  assert.equal(hostReads, 0);
});

test("local Docker status exposes the native Windows support boundary", async (t) => {
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() {
      return {
        dockerAvailable: false,
        unsupportedPlatform: true,
        internalPlatform: "win32",
      };
    },
  });

  const response = await api(wizard, "/api/local/docker/status");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    dockerAvailable: false,
    unsupportedPlatform: true,
  });
});

test("local chat tester APIs keep the setup-token boundary and return no credentials", async (t) => {
  const received = [];
  let adapterInstalled = false;
  const tester = {
    async issueKey() {
      return {
        keyId: "tester-key-123",
        publicKeyJwk: { kty: "RSA", n: "public-modulus", e: "AQAB" },
        algorithm: "RSA-OAEP-256",
        expiresAt: "2030-01-01T00:00:00.000Z",
        privateKey: "must-not-leak",
      };
    },
    async message(body, options = {}) {
      received.push(body);
      options.onEvent?.("progress", { phase: "working" });
      options.onEvent?.("delta", { text: "adapter " });
      options.onEvent?.("delta", { text: "response" });
      return {
        conversationId: "conversation-123",
        output: "adapter response",
        credential: "must-not-leak",
      };
    },
    async reset(body) {
      received.push(body);
      return { forgotten: true, privateKey: "must-not-leak" };
    },
  };
  const wizard = await startLocalWizard(t, {
    localChatTest: tester,
    async getManagedLocalEndpointStatus() {
      return adapterInstalled ? installedChatStatus() : { managed: false, state: "absent" };
    },
    async installLocalEndpoint() {
      adapterInstalled = true;
      return {
        target: "codex-chat",
        endpoint: "http://127.0.0.1:14501",
        protocol: "relmio-codex-chat",
        clientCredential,
        credentialShownOnce: true,
        account: siwcAccount, readiness: "verified", runtimeState: "running",
        models: [],
        deploymentMode: "installed",
        experimental: true,
        browserClients: false,
      };
    },
  });

  const notReady = await postJson(wizard, "/api/local/chat-test/key", {});
  assert.equal(notReady.status, 409);
  assert.equal((await notReady.json()).recovery, "review-again");

  const planned = await createPlan(wizard, {
    target: "codex-chat",
    port: "14501",
  });
  const installed = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(installed.status, 200);

  for (const path of [
    "/api/local/chat-test/key",
    "/api/local/chat-test/message",
    "/api/local/chat-test/reset",
  ]) {
    const wrongMethod = await api(wizard, path, {
      method: "PUT",
      body: "{}",
    });
    assert.equal(wrongMethod.status, 405);
    assert.match((await wrongMethod.json()).error, /Method not allowed/iu);
  }

  const key = await postJson(wizard, "/api/local/chat-test/key", {});
  assert.equal(key.status, 200);
  const keyText = await key.text();
  assert.equal(keyText.includes("must-not-leak"), false);
  assert.deepEqual(JSON.parse(keyText), {
    keyId: "tester-key-123",
    publicKeyJwk: { kty: "RSA", n: "public-modulus", e: "AQAB" },
    algorithm: "RSA-OAEP-256",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });

  const message = await postJson(wizard, "/api/local/chat-test/message", {
    endpointBaseUrl: "http://127.0.0.1:14501",
    keyId: "tester-key-123",
    encryptedCredential: "ciphertext-only",
    input: "hello",
  });
  assert.equal(message.status, 200);
  const messageText = await message.text();
  assert.equal(messageText.includes("must-not-leak"), false);
  assert.deepEqual(JSON.parse(messageText), {
    conversationId: "conversation-123",
    output: "adapter response",
  });

  const streamed = await api(wizard, "/api/local/chat-test/message", {
    method: "POST",
    headers: { Accept: "text/event-stream" },
    body: JSON.stringify({
      endpointBaseUrl: "http://127.0.0.1:14501",
      keyId: "tester-key-123",
      encryptedCredential: "ciphertext-only",
      input: "What is a robot?",
    }),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get("content-type") ?? "", /^text\/event-stream\b/u);
  assert.equal(streamed.headers.get("x-relmio-stream"), "v1");
  const streamedText = await streamed.text();
  assert.match(streamedText, /event: progress\ndata: \{"phase":"working"\}/u);
  assert.match(streamedText, /event: delta\ndata: \{"text":"adapter "\}/u);
  assert.match(streamedText, /event: delta\ndata: \{"text":"response"\}/u);
  assert.match(
    streamedText,
    /event: terminal\ndata: \{"outcome":"completed","conversationId":"conversation-123"\}/u,
  );
  assert.equal((streamedText.match(/event: terminal/gu) ?? []).length, 1);
  assert.doesNotMatch(streamedText, /must-not-leak|ciphertext-only/u);

  const reset = await postJson(wizard, "/api/local/chat-test/reset", {
    keyId: "tester-key-123",
  });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { forgotten: true });
  assert.equal(received.length, 3);

  const noToken = await fetch(`${wizard.origin}/api/local/chat-test/key`, {
    method: "POST",
    headers: { Origin: wizard.origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(noToken.status, 401);

  const crossOrigin = await fetch(`${wizard.origin}/api/local/chat-test/key`, {
    method: "POST",
    headers: {
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
      "X-Setup-Token": sessionToken,
    },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);

  const preview = await startLocalWizard(
    t,
    { localChatTest: tester },
    { previewMode: true },
  );
  const disabled = await postJson(preview, "/api/local/chat-test/key", {});
  assert.equal(disabled.status, 403);
  assert.match((await disabled.json()).error, /disabled in sanitized preview mode/iu);
});

test("local chat tester re-attests an installed adapter after the wizard restarts", async (t) => {
  let statusCalls = 0;
  const wizard = await startLocalWizard(t, {
    async getManagedLocalEndpointStatus({ target }) {
      statusCalls += 1;
      assert.equal(target, "codex-chat");
      return installedChatStatus();
    },
    localChatTest: {
      async issueKey() {
        return {
          keyId: "restart-safe-tester-key",
          publicKeyJwk: { kty: "RSA", n: "public-modulus", e: "AQAB" },
          algorithm: "RSA-OAEP-256",
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
      },
    },
  });

  const response = await postJson(wizard, "/api/local/chat-test/key", {});
  assert.equal(response.status, 200);
  assert.equal(statusCalls, 1);
  assert.equal((await response.json()).keyId, "restart-safe-tester-key");
});

test("dashboard discard revokes a tester key that finishes issuing after the discard", async (t) => {
  let releaseFirstKey;
  let notifyFirstKeyStarted;
  let issueCalls = 0;
  let resetAllCalls = 0;
  const liveKeys = new Set();
  const targetedResets = [];
  const firstKeyStarted = new Promise((resolve) => {
    notifyFirstKeyStarted = resolve;
  });
  const firstKeyGate = new Promise((resolve) => {
    releaseFirstKey = resolve;
  });
  t.after(() => releaseFirstKey());

  const wizard = await startLocalWizard(t, {
    async getManagedLocalEndpointStatus() {
      return installedChatStatus();
    },
    localChatTest: {
      async issueKey() {
        issueCalls += 1;
        const keyId = `tester-key-${issueCalls}`;
        if (issueCalls === 1) {
          notifyFirstKeyStarted();
          await firstKeyGate;
        }
        liveKeys.add(keyId);
        return {
          keyId,
          publicKeyJwk: { kty: "RSA", n: "public-modulus", e: "AQAB" },
          algorithm: "RSA-OAEP-256",
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
      },
      async reset({ keyId }) {
        targetedResets.push(keyId);
        liveKeys.delete(keyId);
        return { forgotten: true };
      },
      resetAll() {
        resetAllCalls += 1;
        liveKeys.clear();
      },
    },
  });

  const issuing = postJson(wizard, "/api/local/chat-test/key", {});
  await firstKeyStarted;
  assert.equal((await postJson(wizard, "/api/local/discard", {})).status, 200);
  assert.equal(resetAllCalls, 1);
  releaseFirstKey();

  const staleKey = await issuing;
  assert.equal(staleKey.status, 409);
  assert.match((await staleKey.json()).error, /dashboard|discard|changed/iu);
  assert.deepEqual(targetedResets, ["tester-key-1"]);
  assert.deepEqual([...liveKeys], []);

  const freshKey = await postJson(wizard, "/api/local/chat-test/key", {});
  assert.equal(freshKey.status, 200);
  assert.equal((await freshKey.json()).keyId, "tester-key-2");
  assert.deepEqual([...liveKeys], ["tester-key-2"]);
  assert.equal(resetAllCalls, 1);
});

test("local project metadata exposes only the public GitHub star count and package version", async (t) => {
  const wizard = await startLocalWizard(t, {
    async getProjectMeta() {
      return { stars: 28, version: "untrusted", credential: "must-not-leak" };
    },
  });
  const response = await api(wizard, "/api/local/project-meta");
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes("must-not-leak"), false);
  assert.deepEqual(JSON.parse(text), {
    stars: 28,
    version: JSON.parse(await readFile("package.json", "utf8")).version,
  });
});

test("new local n8n + ngrok plans stay non-mutating and never expose Docker context or secrets", async (t) => {
  const dockerHost = "unix:///var/run/docker.sock";
  const ngrokAuthtoken = "ngrok-secret-token";
  const basicAuthPassword = "basic-auth-secret";
  let plans = 0;
  let installInput;
  let removeInput;
  const stackPlan = {
    kind: "local-n8n-stack",
    target: "local-n8n-stack",
    label: "Disposable self-hosted n8n + ngrok",
    dockerHost,
    ngrokHostname: "workflow.example.ngrok.app",
    n8nPort: 5679,
    ngrokInspectorPort: 4041,
    timezone: "Asia/Manila",
    assistantMode: "sandbox-with-searxng",
    localUrl: "http://127.0.0.1:5679",
    ngrokPublicUrl: "https://workflow.example.ngrok.app",
    hostPublication: "loopback-only",
    deploymentMode: "new-disposable-stack",
    managedPath: "~/.relmio/local/n8n-stack",
  };
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() {
      return { dockerAvailable: true, dockerHost };
    },
    prepareLocalN8nStackPlan(input) {
      plans += 1;
      assert.equal(input.dockerHost, dockerHost);
      return stackPlan;
    },
    async installLocalN8nStack(input) {
      installInput = input;
      return {
        target: "local-n8n-stack",
        localUrl: stackPlan.localUrl,
        ngrokPublicUrl: stackPlan.ngrokPublicUrl,
        projectName: `relmio-local-n8n-${"a".repeat(32)}`,
        containerServices: ["n8n", "ngrok", "sandbox-api", "searxng"],
        networks: ["edge", "assistant-shared", "assistant-internal"],
        assistantSettings: {
          sandboxUrl: "http://relmio-sandbox-api:8080",
          searxngUrl: "http://relmio-searxng:8080",
        },
        assistantMode: stackPlan.assistantMode,
        hostPublication: "n8n http://127.0.0.1:5679; ngrok inspector http://127.0.0.1:4041",
        deploymentMode: "new-disposable-stack",
        dockerHost,
        basicAuthPassword,
      };
    },
    async removeLocalN8nStack(input) {
      removeInput = input;
      return {
        target: "local-n8n-stack",
        removed: true,
        deploymentMode: "removed-owned-disposable-stack",
      };
    },
  });

  const planned = await createPlan(wizard, {
    target: "local-n8n-stack",
    ngrokHostname: stackPlan.ngrokHostname,
    n8nPort: "5679",
    ngrokInspectorPort: "4041",
    timezone: stackPlan.timezone,
    assistantMode: stackPlan.assistantMode,
  });
  assert.equal(plans, 1);
  assert.equal(JSON.stringify(planned).includes(dockerHost), false);
  assert.equal(planned.plan.localUrl, stackPlan.localUrl);
  assert.equal(planned.plan.ngrokPublicUrl, stackPlan.ngrokPublicUrl);

  const retiredKey = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    ngrokAuthtoken,
    basicAuthUsername: "relmio",
    basicAuthPassword,
    apiKey: "retired-api-key-field",
  });
  assert.equal(retiredKey.status, 400);
  assert.match((await retiredKey.json()).error, /n8n \+ ngrok install request/iu);
  assert.equal(installInput, undefined);

  const invalidPassword = "too-short";
  const invalid = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    ngrokAuthtoken,
    basicAuthUsername: "relmio user",
    basicAuthPassword: invalidPassword,
  });
  assert.equal(invalid.status, 400);
  const invalidText = await invalid.text();
  assert.match(invalidText, /Basic Auth username must use 1–64 letters, numbers, hyphens, or underscores\./u);
  assert.equal(invalidText.includes(invalidPassword), false);
  const invalidResult = JSON.parse(invalidText);
  assert.equal(invalidResult.retryablePlan, true);
  assert.equal("managedPartialStack" in invalidResult, false);
  assert.equal(installInput, undefined);

  const installed = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    ngrokAuthtoken,
    basicAuthUsername: "relmio",
    basicAuthPassword,
  });
  assert.equal(installed.status, 200);
  const installedText = await installed.text();
  assert.equal(installedText.includes(ngrokAuthtoken), false);
  assert.equal(installedText.includes(basicAuthPassword), false);
  assert.equal(installedText.includes(dockerHost), false);
  assert.equal(installInput.publicExposureConfirmation, "EXPOSE_LOCAL_N8N_VIA_NGROK");
  assert.deepEqual(installInput.secrets, {
    ngrokAuthtoken,
    basicAuthUsername: "relmio",
    basicAuthPassword,
  });

  const unconfirmed = await postJson(wizard, "/api/local/n8n/stack/remove", {});
  assert.equal(unconfirmed.status, 400);
  const removed = await postJson(wizard, "/api/local/n8n/stack/remove", { confirmed: true });
  assert.equal(removed.status, 200);
  assert.deepEqual(removeInput, { confirmation: "REMOVE_LOCAL_N8N_STACK" });
  assert.deepEqual(await removed.json(), {
    target: "local-n8n-stack",
    removed: true,
    deploymentMode: "removed-owned-disposable-stack",
  });
});

test("rejected ngrok startup restores only the reviewed non-secret plan for one safe retry", async (t) => {
  const dockerHost = "unix:///var/run/docker.sock";
  const stackPlan = {
    kind: "local-n8n-stack",
    target: "local-n8n-stack",
    label: "Disposable self-hosted n8n + ngrok",
    dockerHost,
    ngrokHostname: "workflow.example.ngrok.app",
    n8nPort: 5679,
    ngrokInspectorPort: 4041,
    timezone: "Asia/Manila",
    assistantMode: "disabled",
    localUrl: "http://127.0.0.1:5679",
    ngrokPublicUrl: "https://workflow.example.ngrok.app",
    hostPublication: "loopback-only",
    deploymentMode: "new-disposable-stack",
    managedPath: "~/.relmio/local/n8n-stack",
  };
  const authtoken = "ngrok-never-return-this";
  const password = "never-return-this-password";
  const ngrokSetupErrorMessage =
    "The n8n + ngrok stack did not start because ngrok rejected its account, endpoint, or credential setup. Check the reserved hostname, active agent authtoken, and Basic Auth. Relmio removed the failed owned resources; retry is safe.";
  assert.equal(ngrokSetupErrorMessage.length <= 240, true);
  let releaseFirstInstall;
  let notifyFirstInstallStarted;
  const firstInstallStarted = new Promise((resolve) => {
    notifyFirstInstallStarted = resolve;
  });
  const firstInstallGate = new Promise((resolve) => {
    releaseFirstInstall = resolve;
  });
  t.after(() => releaseFirstInstall());
  const calls = [];
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() {
      return { dockerAvailable: true, dockerHost };
    },
    prepareLocalN8nStackPlan() {
      return stackPlan;
    },
    async installLocalN8nStack(input) {
      calls.push(input);
      if (calls.length === 1) {
        notifyFirstInstallStarted();
        await firstInstallGate;
      }
      throw Object.assign(new Error(ngrokSetupErrorMessage), {
        code: LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE,
        failureKind: LOCAL_N8N_STACK_NGROK_SETUP_REJECTED_FAILURE_KIND,
      });
    },
  });
  const planned = await createPlan(wizard, {
    target: "local-n8n-stack",
    ngrokHostname: stackPlan.ngrokHostname,
    n8nPort: String(stackPlan.n8nPort),
    ngrokInspectorPort: String(stackPlan.ngrokInspectorPort),
    timezone: stackPlan.timezone,
    assistantMode: stackPlan.assistantMode,
  });
  const attempt = () => postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    ngrokAuthtoken: authtoken,
    basicAuthUsername: "relmio",
    basicAuthPassword: password,
  });
  const firstAttempt = attempt();
  await firstInstallStarted;
  const discarded = await postJson(wizard, "/api/local/discard", {});
  assert.equal(discarded.status, 409);
  assert.match((await discarded.json()).error, /already in progress/iu);
  releaseFirstInstall();

  const first = await firstAttempt;
  assert.equal(first.status, 400);
  const firstText = await first.text();
  assert.equal(firstText.includes(authtoken), false);
  assert.equal(firstText.includes(password), false);
  assert.equal(firstText.includes(dockerHost), false);
  assert.partialDeepStrictEqual(JSON.parse(firstText), {
    code: LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE, retryablePlan: true, retryableNgrokSetup: true,
  });
  const second = await attempt();
  assert.equal(second.status, 400);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((input) => input.plan === stackPlan), true);
});

test("safely cleaned non-ngrok startup failures preserve the reviewed plan without ngrok guidance", async (t) => {
  const dockerHost = "unix:///var/run/docker.sock";
  const stackPlan = {
    kind: "local-n8n-stack",
    target: "local-n8n-stack",
    label: "Disposable self-hosted n8n + ngrok",
    dockerHost,
    ngrokHostname: "workflow.example.ngrok.app",
    n8nPort: 5679,
    ngrokInspectorPort: 4041,
    timezone: "Asia/Manila",
    assistantMode: "sandbox-with-searxng",
    localUrl: "http://127.0.0.1:5679",
    ngrokPublicUrl: "https://workflow.example.ngrok.app",
    hostPublication: "loopback-only",
    deploymentMode: "new-disposable-stack",
    managedPath: "~/.relmio/local/n8n-stack",
  };
  const authtoken = "ngrok-never-return-this";
  const password = "never-return-this-password";
  let installCalls = 0;
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() {
      return { dockerAvailable: true, dockerHost };
    },
    prepareLocalN8nStackPlan() {
      return stackPlan;
    },
    async installLocalN8nStack() {
      installCalls += 1;
      throw Object.assign(
        new Error(
          `docker stderr in C:\\private\\stack with ${authtoken} and ${password}`,
        ),
        {
          code: LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE,
          failureKind: "searxng-search-verification",
          safeMessage:
            "The selected SearXNG service did not return a valid JSON search result. Relmio removed the failed owned resources.",
        },
      );
    },
  });
  const planned = await createPlan(wizard, {
    target: "local-n8n-stack",
    ngrokHostname: stackPlan.ngrokHostname,
    n8nPort: String(stackPlan.n8nPort),
    ngrokInspectorPort: String(stackPlan.ngrokInspectorPort),
    timezone: stackPlan.timezone,
    assistantMode: stackPlan.assistantMode,
  });
  const body = {
    planId: planned.planId,
    confirmed: true,
    ngrokAuthtoken: authtoken,
    basicAuthUsername: "relmio",
    basicAuthPassword: password,
  };
  const first = await postJson(wizard, "/api/local/install", body);
  assert.equal(first.status, 400);
  const text = await first.text();
  assert.partialDeepStrictEqual(JSON.parse(text), {
    code: LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE, retryablePlan: true,
  });
  assert.equal(text.includes(authtoken), false);
  assert.equal(text.includes(password), false);
  assert.equal(text.includes("C:\\private\\stack"), false);
  assert.equal(text.includes(dockerHost), false);

  const retry = await postJson(wizard, "/api/local/install", body);
  assert.equal(retry.status, 400);
  assert.equal(installCalls, 2);
});

test("stopped stack resume requires an explicit user action and returns no Docker details", async (t) => {
  let resumeInput;
  const wizard = await startLocalWizard(t, {
    async resumeLocalN8nStack(input) {
      resumeInput = input;
      return {
        target: "local-n8n-stack",
        resumed: true,
        deploymentMode: "resumed-owned-disposable-stack",
        projectName: `relmio-local-n8n-${"f".repeat(32)}`,
      };
    },
  });
  const unconfirmed = await postJson(wizard, "/api/local/n8n/stack/resume", {});
  assert.equal(unconfirmed.status, 400);
  assert.equal(resumeInput, undefined);
  const resumed = await postJson(wizard, "/api/local/n8n/stack/resume", { confirmed: true });
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumeInput, { confirmed: true });
  assert.deepEqual(await resumed.json(), {
    target: "local-n8n-stack",
    resumed: true,
    deploymentMode: "resumed-owned-disposable-stack",
  });
});

test("local Docker status exposes only an exact safe managed-stack state", async (t) => {
  const leakedPath = "C:\\Users\\fixture\\.relmio\\local\\n8n-stack";
  const leakedProject = `relmio-local-n8n-${"a".repeat(32)}`;
  const leakedUrl = "https://private-fixture.ngrok.app";
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() {
      return {
        dockerAvailable: true,
        dockerVersion: "28.3.2",
        composeVersion: "2.38.2",
        dockerOutput: "must-not-leak",
      };
    },
    async getLocalN8nStackStatus() {
      return {
        managed: true,
        state: "stopped",
        installRoot: leakedPath,
        projectName: leakedProject,
        ngrokPublicUrl: leakedUrl,
        ownedResourceCount: 3,
        marker: { secret: "must-not-leak" },
        rawError: "must-not-leak",
      };
    },
  });

  const response = await api(wizard, "/api/local/docker/status");
  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert.deepEqual(JSON.parse(responseText), {
    dockerAvailable: true,
    dockerVersion: "28.3.2",
    composeVersion: "2.38.2",
    localN8nStackState: "stopped",
  });
  for (const privateValue of [
    leakedPath,
    leakedProject,
    leakedUrl,
    "must-not-leak",
  ]) {
    assert.equal(responseText.includes(privateValue), false);
  }
});

test("local Docker status omits unrecognized managed-stack state and keeps unavailable explicit", async (t) => {
  for (const scenario of [
    {
      name: "safe negative",
      getLocalN8nStackStatus: async () => ({ managed: false, state: "absent", path: "must-not-leak" }),
    },
    {
      name: "truthy non-boolean",
      getLocalN8nStackStatus: async () => ({ managed: "true", state: "partial", path: "must-not-leak" }),
    },
    {
      name: "unconfirmed error",
      getLocalN8nStackStatus: async () => {
        throw new Error("raw Docker output and marker details must-not-leak");
      },
    },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const wizard = await startLocalWizard(subtest, {
        async getLocalDockerStatus() {
          return {
            dockerAvailable: true,
            dockerVersion: "28.3.2",
            composeVersion: "2.38.2",
          };
        },
        getLocalN8nStackStatus: scenario.getLocalN8nStackStatus,
      });

      const response = await api(wizard, "/api/local/docker/status");
      assert.equal(response.status, 200);
      const responseText = await response.text();
      assert.deepEqual(JSON.parse(responseText), {
        dockerAvailable: true,
        dockerVersion: "28.3.2",
        composeVersion: "2.38.2",
      });
      assert.equal(responseText.includes("localN8nStackState"), false);
      assert.equal(responseText.includes("must-not-leak"), false);
    });
  }
});

test("local Docker status exposes only the literal unavailable state when stack attestation fails", async (t) => {
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() {
      return { dockerAvailable: true, dockerVersion: "28.3.2", composeVersion: "2.38.2" };
    },
    async getLocalN8nStackStatus() {
      return {
        managed: false,
        state: "unavailable",
        rawDockerMetadata: "must-not-leak",
      };
    },
  });
  const response = await api(wizard, "/api/local/docker/status");
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), {
    dockerAvailable: true,
    dockerVersion: "28.3.2",
    composeVersion: "2.38.2",
    localN8nStackState: "unavailable",
  });
  assert.equal(text.includes("must-not-leak"), false);
});

test("local dashboard returns only the fixed sanitized inventory contract", async (t) => {
  const canary = "must-not-leak-dashboard-secret";
  const generatedAt = "2026-09-04T02:00:00.000Z";
  const absent = (target, label, kind) => ({
    target,
    label,
    kind,
    managed: false,
    state: "absent",
    snapshot: null,
    actions: ["setup"],
  });
  const wizard = await startLocalWizard(t, {
    async getLocalDashboardStatus() {
      return {
        schemaVersion: 1,
        generatedAt,
        docker: {
          available: true,
          version: "29.7.2",
          composeVersion: "5.3.1",
          dockerHost: canary,
        },
        auth: {
          secretsRevealable: false,
          token: canary,
        },
        services: [
          absent("codex-chatgpt", "Codex (ChatGPT login)", "endpoint"),
          absent("codex-chat", "Codex Chat adapter", "endpoint"),
          {
            target: "xai-grok-build",
            label: "SuperGrok",
            kind: "endpoint",
            managed: true,
            state: "healthy",
            snapshot: {
              target: "xai-grok-build",
              endpoint: "http://127.0.0.1:14502",
              auth: { configured: true, disclosure: "rotate-only", token: canary },
              canRotateCredential: true,
              installRoot: canary,
            },
            actions: ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"],
            marker: canary,
          },
          {
            target: "local-n8n-stack",
            label: "n8n + ngrok",
            kind: "n8n-stack",
            managed: true,
            state: "stopped",
            snapshot: {
              target: "local-n8n-stack",
              assistantMode: "sandbox-with-searxng",
              endpoints: {
                n8nLocal: "http://127.0.0.1:80",
                ngrokPublic: "https://example.ngrok.app",
                ngrokInspector: "http://127.0.0.1:81",
                secret: canary,
              },
              components: {
                n8n: true,
                ngrok: true,
                codeSandbox: true,
                searxng: true,
                credential: canary,
              },
              canResume: true,
              canRemove: true,
              env: canary,
            },
            actions: ["resume", "remove"],
          },
          absent("n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"),
          absent("local-n8n-assistant", "AI Assistant tools", "n8n-assistant"),
          {
            target: "n8n-supergrok-oauth",
            label: "SuperGrok for n8n",
            kind: "n8n-supergrok",
            managed: true,
            state: "healthy",
            snapshot: {
              target: "n8n-supergrok-oauth",
              endpoint: "http://n8n-supergrok:14502/v1",
              auth: { configured: true, disclosure: "one-time", secret: canary },
              canRemove: true,
              installRoot: canary,
            },
            actions: [
              "sign-in-grok-build",
              "sign-out-grok-build",
              "remove-owned-supergrok",
            ],
          },
          absent("n8n-local-model", "Local model for n8n", "n8n-local-model"),
        ],
        providers: dashboardProviders(),
        rawError: canary,
      };
    },
  });

  const response = await api(wizard, "/api/local/dashboard");
  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert.equal(responseText.includes(canary), false);
  assert.equal(responseText.includes("reveal-secret"), false);
  assert.deepEqual(JSON.parse(responseText), {
    schemaVersion: 1,
    generatedAt,
    docker: {
      available: true,
      version: "29.7.2",
      composeVersion: "5.3.1",
    },
    auth: { secretsRevealable: false },
    services: [
      absent("codex-chatgpt", "Codex (ChatGPT plan)", "endpoint"),
      absent("codex-chat", "Codex Chat adapter", "endpoint"),
      {
        target: "xai-grok-build",
        label: "SuperGrok",
        kind: "endpoint",
        managed: true,
        state: "healthy",
        snapshot: {
          target: "xai-grok-build",
          endpoint: "http://127.0.0.1:14502",
          auth: { configured: true, disclosure: "rotate-only" },
          canRotateCredential: true,
        },
        actions: ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"],
      },
      {
        target: "local-n8n-stack",
        label: "n8n + ngrok",
        kind: "n8n-stack",
        managed: true,
        state: "stopped",
        snapshot: {
          target: "local-n8n-stack",
          assistantMode: "sandbox-with-searxng",
          endpoints: {
            n8nLocal: "http://127.0.0.1:80",
            ngrokPublic: "https://example.ngrok.app",
            ngrokInspector: "http://127.0.0.1:81",
          },
          components: {
            n8n: true,
            ngrok: true,
            codeSandbox: true,
            searxng: true,
          },
          canResume: true,
          canRemove: true,
        },
        actions: ["resume", "remove"],
      },
      absent("n8n-openai-oauth", "ChatGPT plan sidecar", "n8n-oauth-bridge"),
      absent("local-n8n-assistant", "AI Assistant tools", "n8n-assistant"),
      {
        target: "n8n-supergrok-oauth",
        label: "SuperGrok for n8n",
        kind: "n8n-supergrok",
        managed: true,
        state: "healthy",
        snapshot: {
          target: "n8n-supergrok-oauth",
          endpoint: "http://n8n-supergrok:14502/v1",
          auth: { configured: true, disclosure: "one-time" },
          canRemove: true,
        },
        actions: [
          "sign-in-grok-build",
          "sign-out-grok-build",
          "remove-owned-supergrok",
        ],
      },
      absent("n8n-local-model", "Local model for n8n", "n8n-local-model"),
    ],
    providers: dashboardProviders(),
  });
});

test("local dashboard accepts only the exact healthy Codex sign-in action matrix", async (t) => {
  const generatedAt = "2026-09-04T02:00:00.000Z";
  const canary = "must-not-leak-codex-dashboard-action";
  const absent = (target, label, kind) => ({
    target,
    label,
    kind,
    managed: false,
    state: "absent",
    snapshot: null,
    actions: ["setup"],
  });
  const endpoint = (target, endpointUrl, actions) => ({
    target,
    label: target === "codex-chatgpt"
        ? "Codex (ChatGPT login)"
        : target === "xai-grok-build"
          ? "SuperGrok"
        : "Codex Chat adapter",
    kind: "endpoint",
    managed: true,
    state: "healthy",
    snapshot: {
      target,
      endpoint: endpointUrl,
      auth: { configured: true, disclosure: "rotate-only",
        ...(target !== "xai-grok-build" ? { account: siwcAccount } : {}) },
      ...(target !== "xai-grok-build" ? { registrationId: siwcAccount.registrationId, migrationRequired: false } : {}),
      canRotateCredential: true,
      secret: canary,
    },
    actions,
  });
  const validStatus = {
    schemaVersion: 1,
    generatedAt,
    docker: { available: true, version: "29.7.2", composeVersion: "5.3.1" },
    auth: { secretsRevealable: false },
    services: [
      endpoint(
        "codex-chatgpt",
        "ws://127.0.0.1:14500",
        ["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "rotate-local-capability"],
      ),
      endpoint(
        "codex-chat",
        "http://127.0.0.1:14501",
        ["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "rotate-local-capability"],
      ),
      endpoint(
        "xai-grok-build",
        "http://127.0.0.1:14502",
        ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"],
      ),
      absent("local-n8n-stack", "n8n + ngrok", "n8n-stack"),
      absent("n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"),
      absent("local-n8n-assistant", "AI Assistant tools", "n8n-assistant"),
      absent("n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"),
      absent("n8n-local-model", "Local model for n8n", "n8n-local-model"),
    ],
    providers: dashboardProviders(),
  };
  const validWizard = await startLocalWizard(t, {
    async getLocalDashboardStatus() {
      return validStatus;
    },
  });
  const validResponse = await api(validWizard, "/api/local/dashboard");
  assert.equal(validResponse.status, 200);
  const validText = await validResponse.text();
  const valid = JSON.parse(validText);
  assert.deepEqual(
    [valid.services[0], valid.services[1], valid.services[2]].map(({ actions }) => actions),
    [
      ["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "rotate-local-capability"],
      ["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "rotate-local-capability"],
      ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"],
    ],
  );
  assert.equal(validText.includes("canSignIn"), false);
  assert.equal(validText.includes(canary), false);

  const scenarios = [
    {
      name: "grok-wrong-sign-in",
      mutate(status) {
        status.services[2].actions = ["sign-in-chatgpt", "rotate-local-capability"];
      },
    },
    {
      name: "stopped-codex",
      mutate(status) {
        status.services[0].state = "stopped";
        status.services[0].actions = ["sign-in-chatgpt"];
      },
    },
    {
      name: "partial-codex",
      mutate(status) {
        status.services[0].state = "partial";
        status.services[0].snapshot = null;
        status.services[0].actions = ["sign-in-chatgpt"];
      },
    },
    {
      name: "unavailable-codex",
      mutate(status) {
        status.services[1].managed = false;
        status.services[1].state = "unavailable";
        status.services[1].snapshot = null;
        status.services[1].actions = ["sign-in-chatgpt"];
      },
    },
    {
      name: "absent-codex",
      mutate(status) {
        status.services[1].managed = false;
        status.services[1].state = "absent";
        status.services[1].snapshot = null;
        status.services[1].actions = ["sign-in-chatgpt"];
      },
    },
    {
      name: "extra-action",
      mutate(status) {
        status.services[0].actions.push("remove");
      },
    },
    {
      name: "reordered-actions",
      mutate(status) {
        status.services[1].actions = ["rotate-local-capability", "sign-in-chatgpt", "sign-out-chatgpt"];
      },
    },
    {
      name: "unsafe-snapshot",
      mutate(status) {
        status.services[0].snapshot.endpoint = `https://attacker.example/${canary}`;
      },
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (subtest) => {
      const status = structuredClone(validStatus);
      scenario.mutate(status);
      const wizard = await startLocalWizard(subtest, {
        async getLocalDashboardStatus() {
          return status;
        },
      });
      const response = await api(wizard, "/api/local/dashboard");
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.equal(text.includes(canary), false);
    });
  }
});

test("local dashboard preview never runs live discovery", async (t) => {
  let calls = 0;
  const wizard = await startLocalWizard(t, {
    async getLocalDashboardStatus() {
      calls += 1;
      throw new Error("must-not-run");
    },
  }, { previewMode: true });

  const response = await api(wizard, "/api/local/dashboard");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(calls, 0);
  assert.equal(body.previewMode, true);
  assert.equal(body.auth.secretsRevealable, false);
  assert.equal(body.providers.length, 4);
  assert.deepEqual(
    body.providers,
    [
      { target: "codex-chatgpt", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
      { target: "codex-chat", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
      { target: "xai-grok-build", label: "SuperGrok", authentication: "provider-oauth", readiness: "runtime-owned" },
      { target: "n8n-supergrok-oauth", label: "SuperGrok (n8n)", authentication: "provider-oauth", readiness: "runtime-owned" },
    ],
  );
  assert.ok(body.services.every((service) =>
    service.managed === false &&
    service.state === "absent" &&
    service.snapshot === null &&
    service.actions.length === 1 &&
    service.actions[0] === "setup"));
});

test("local dashboard keeps unattested partial services review-only", async (t) => {
  const absent = (target, label, kind) => ({
    target,
    label,
    kind,
    managed: false,
    state: "absent",
    snapshot: null,
    actions: ["setup"],
  });
  const wizard = await startLocalWizard(t, {
    async getLocalDashboardStatus() {
      return {
        schemaVersion: 1,
        generatedAt: "2026-09-04T02:00:00.000Z",
        docker: { available: true, version: "29.7.2", composeVersion: "5.3.1" },
        auth: { secretsRevealable: false },
        services: [
          absent("codex-chatgpt", "Codex (ChatGPT login)", "endpoint"),
          absent("codex-chat", "Codex Chat adapter", "endpoint"),
          absent("xai-grok-build", "SuperGrok", "endpoint"),
          {
            target: "local-n8n-stack",
            label: "n8n + ngrok",
            kind: "n8n-stack",
            managed: true,
            state: "partial",
            snapshot: null,
            actions: [],
          },
          absent("n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"),
          absent("local-n8n-assistant", "AI Assistant tools", "n8n-assistant"),
          absent("n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"),
          absent("n8n-local-model", "Local model for n8n", "n8n-local-model"),
        ],
        providers: dashboardProviders(),
      };
    },
  });

  const response = await api(wizard, "/api/local/dashboard");
  assert.equal(response.status, 200);
  const service = (await response.json()).services.find(
    ({ target }) => target === "local-n8n-stack",
  );
  assert.equal(service.state, "partial");
  assert.equal(service.snapshot, null);
  assert.deepEqual(service.actions, []);
});

test("local dashboard rejects an incomplete or reordered fixed service set", async (t) => {
  const definitions = [
    ["codex-chatgpt", "Codex (ChatGPT login)", "endpoint"],
    ["codex-chat", "Codex Chat adapter", "endpoint"],
    ["xai-grok-build", "SuperGrok", "endpoint"],
    ["local-n8n-stack", "n8n + ngrok", "n8n-stack"],
    ["n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"],
    ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"],
    ["n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"],
    ["n8n-local-model", "Local model for n8n", "n8n-local-model"],
  ];
  const serviceSet = definitions.map(([target, label, kind]) => ({
    target,
    label,
    kind,
    managed: false,
    state: "absent",
    snapshot: null,
    actions: ["setup"],
  }));
  for (const scenario of [serviceSet.slice(0, -1), [...serviceSet].reverse()]) {
    await t.test(String(scenario.length), async (subtest) => {
      const wizard = await startLocalWizard(subtest, {
        async getLocalDashboardStatus() {
          return {
            schemaVersion: 1,
            generatedAt: "2026-09-04T02:00:00.000Z",
            docker: { available: true, version: "29.7.2", composeVersion: "5.3.1" },
            auth: { secretsRevealable: false },
            services: scenario,
            providers: dashboardProviders(),
          };
        },
      });
      const response = await api(wizard, "/api/local/dashboard");
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /dashboard service/u);
    });
  }
});

test("local dashboard derives actions and rejects unsafe Docker versions", async (t) => {
  const definitions = [
    ["codex-chatgpt", "Codex (ChatGPT login)", "endpoint"],
    ["codex-chat", "Codex Chat adapter", "endpoint"],
    ["xai-grok-build", "SuperGrok", "endpoint"],
    ["local-n8n-stack", "n8n + ngrok", "n8n-stack"],
    ["n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"],
    ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"],
    ["n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"],
    ["n8n-local-model", "Local model for n8n", "n8n-local-model"],
  ];
  const baseStatus = {
    schemaVersion: 1,
    generatedAt: "2026-09-04T02:00:00.000Z",
    docker: { available: true, version: "29.7.2", composeVersion: "5.3.1" },
    auth: { secretsRevealable: false },
    services: definitions.map(([target, label, kind]) => ({
      target,
      label,
      kind,
      managed: false,
      state: "absent",
      snapshot: null,
      actions: ["setup"],
    })),
    providers: dashboardProviders(),
  };
  const scenarios = [
    (() => {
      const status = structuredClone(baseStatus);
      status.services[0].actions.push("remove");
      return status;
    })(),
    (() => {
      const status = structuredClone(baseStatus);
      status.docker.version = "/private/tmp/docker-secret";
      return status;
    })(),
  ];
  for (const [index, status] of scenarios.entries()) {
    await t.test(String(index), async (subtest) => {
      const wizard = await startLocalWizard(subtest, {
        async getLocalDashboardStatus() {
          return status;
        },
      });
      const response = await api(wizard, "/api/local/dashboard");
      assert.equal(response.status, 400);
      const text = await response.text();
      assert.equal(text.includes("/private/tmp/docker-secret"), false);
    });
  }
});

test("local n8n startup errors expose recovery only for the exact attested partial-stack code", async (t) => {
  const dockerHost = "unix:///var/run/docker.sock";
  const stackPlan = {
    kind: "local-n8n-stack",
    target: "local-n8n-stack",
    label: "Disposable self-hosted n8n + ngrok",
    dockerHost,
    ngrokHostname: "workflow.example.ngrok.app",
    n8nPort: 5679,
    ngrokInspectorPort: 4041,
    timezone: "Asia/Manila",
    assistantMode: "disabled",
    localUrl: "http://127.0.0.1:5679",
    ngrokPublicUrl: "https://workflow.example.ngrok.app",
    hostPublication: "loopback-only",
    deploymentMode: "new-disposable-stack",
    managedPath: "~/.relmio/local/n8n-stack",
  };
  const installBody = {
    confirmed: true,
    ngrokAuthtoken: "ngrok-secret-token",
    basicAuthUsername: "relmio",
    basicAuthPassword: "basic-auth-secret",
  };
  const cases = [
    {
      name: "confirmed Relmio-owned resources remain",
      error: Object.assign(
        new Error(
          "docker stderr: https://unexpected.invalid/?token=plain-private-value",
        ),
        { code: LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE },
      ),
      expectedManagedPartialStack: true,
    },
    {
      name: "matching human guidance without attestation code",
      error: new Error(
        "Local n8n stack startup failed and a Relmio-managed partial stack remains.",
      ),
      expectedManagedPartialStack: false,
    },
    {
      name: "confirmed cleanup leaves no resources",
      error: new Error(
        "Local n8n stack startup failed, but its owned partial resources were removed.",
      ),
      expectedManagedPartialStack: false,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const wizard = await startLocalWizard(subtest, {
        async getLocalDockerStatus() {
          return { dockerAvailable: true, dockerHost };
        },
        prepareLocalN8nStackPlan() {
          return stackPlan;
        },
        async installLocalN8nStack() {
          throw scenario.error;
        },
      });
      const planned = await createPlan(wizard, {
        target: "local-n8n-stack",
        ngrokHostname: stackPlan.ngrokHostname,
        n8nPort: String(stackPlan.n8nPort),
        ngrokInspectorPort: String(stackPlan.ngrokInspectorPort),
        timezone: stackPlan.timezone,
        assistantMode: stackPlan.assistantMode,
      });
      const response = await postJson(wizard, "/api/local/install", {
        ...installBody,
        planId: planned.planId,
      });
      assert.equal(response.status, 400);
      const responseText = await response.text();
      const result = JSON.parse(responseText);
      assert.equal(
        result.managedPartialStack === true,
        scenario.expectedManagedPartialStack,
      );
      if (!scenario.expectedManagedPartialStack) {
        assert.equal("managedPartialStack" in result, false);
      }
      assert.equal(result.code, scenario.expectedManagedPartialStack
        ? LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE : undefined);
      assert.equal(responseText.includes(installBody.ngrokAuthtoken), false);
      assert.equal(responseText.includes(installBody.basicAuthPassword), false);
      assert.equal(responseText.includes(dockerHost), false);
      assert.equal(responseText.includes("docker stderr"), false);
      assert.equal(responseText.includes("https://unexpected.invalid"), false);
      assert.equal(responseText.includes("plain-private-value"), false);
    });
  }
});

test("local Docker status, OAuth planning, and installation expose only safe fields", async (t) => {
  let installerInput;
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() {
      return {
        dockerAvailable: true,
        dockerVersion: "28.3.2",
        composeVersion: "2.38.2",
        internalPath: "/Users/fixture/.docker",
      };
    },
    async installLocalEndpoint(input) {
      installerInput = input;
      return {
        target: "xai-grok-build",
        endpoint: "http://127.0.0.1:14502",
        protocol: "relmio-grok-build-chat-http",
        clientCredential,
        credentialShownOnce: true,
        models: [],
        deploymentMode: "installed",
        experimental: true,
        browserClients: false,
        internalPath: "/Users/fixture/.relmio/local/xai-grok-build",
      };
    },
  });

  const dockerResponse = await api(wizard, "/api/local/docker/status");
  assert.deepEqual(await dockerResponse.json(), {
    dockerAvailable: true,
    dockerVersion: "28.3.2",
    composeVersion: "2.38.2",
  });

  const planned = await createPlan(wizard, {
    target: "xai-grok-build",
    port: "14502",
  });
  assert.equal(typeof planned.planId, "string");
  assert.ok(planned.planId.length >= 32);
  assert.equal(planned.planId.includes("xai-grok-build"), false);
  assert.deepEqual(planned.plan, {
    target: "xai-grok-build",
    label: "SuperGrok",
    bindHost: "127.0.0.1",
    port: 14502,
    endpoint: "http://127.0.0.1:14502",
    protocol: "relmio-grok-build-chat-http",
    upstreamAuth: "provider-owned-oauth",
    browserClients: false,
    experimental: true,
    managedPath: "~/.relmio/local/xai-grok-build",
  });

  const installResponse = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(installResponse.status, 200);
  const installedText = await installResponse.text();
  assert.equal(installedText.includes("/Users/"), false);
  assert.deepEqual(JSON.parse(installedText), {
    target: "xai-grok-build",
    endpoint: "http://127.0.0.1:14502",
    protocol: "relmio-grok-build-chat-http",
    clientCredential,
    credentialShownOnce: true,
    models: [],
    deploymentMode: "installed",
    experimental: true,
    browserClients: false,
  });
  assert.deepEqual(installerInput, {
    plan: planned.plan,
    confirmed: true,
  });

  const replay = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /fresh local endpoint plan/iu);
});

test("OAuth endpoint plans reject retired API fields before any service work", async (t) => {
  let serviceCalls = 0;
  const wizard = await startLocalWizard(t, {
    async getLocalDockerStatus() {
      serviceCalls += 1;
      throw new Error("must not run");
    },
  });
  const oauthTargets = [
    ["codex-chatgpt", 14500],
    ["codex-chat", 14501],
    ["xai-grok-build", 14502],
  ];
  for (const [target, port] of oauthTargets) {
    const accepted = await postJson(wizard, "/api/local/plan", { target, port });
    assert.equal(accepted.status, 200);
    for (const retiredField of ["apiKey", "allowedOrigins"]) {
      const rejected = await postJson(wizard, "/api/local/plan", {
        target,
        port,
        [retiredField]: retiredField === "apiKey" ? "retired-api-key-field" : [],
      });
      assert.equal(rejected.status, 400);
      assert.match((await rejected.json()).error, /OAuth local endpoint plan request/iu);
    }
  }
  assert.equal(serviceCalls, 0);
});

test("n8n OAuth, SuperGrok, and Assistant plans reject extra fields before discovery or auth checks", async (t) => {
  let discoveryCalls = 0;
  let authCalls = 0;
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      discoveryCalls += 1;
      throw new Error("must not run");
    },
    async getAuthStatus() {
      authCalls += 1;
      throw new Error("must not run");
    },
  });
  const base = {
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  };
  const cases = [
    ["n8n-openai-oauth", {}],
    ["n8n-supergrok-oauth", {}],
    ["n8n-ai-assistant", { includeSearxng: true }],
  ];
  const extras = [
    { apiKey: "synthetic" },
    { unknownField: true },
    { allowedOrigins: [] },
  ];
  for (const [target, fields] of cases) {
    for (const extra of extras) {
      const response = await postJson(wizard, "/api/local/plan", {
        target,
        ...base,
        ...fields,
        ...extra,
      });
      assert.equal(response.status, 400);
    }
  }
  assert.equal(discoveryCalls, 0);
  assert.equal(authCalls, 0);
});

test("local n8n sidecar discovery and planning bind exact private Docker resources without leaking local auth paths", async (t) => {
  const prepared = [];
  let discoveryCalls = 0;
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      discoveryCalls += 1;
      return {
        dockerAvailable: true,
        dockerVersion: "28.3.2",
        composeVersion: "2.38.2",
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        containers: [
          {
            containerId: "a".repeat(64),
            containerName: "relmio-test-n8n",
            image: "docker.n8n.io/n8nio/n8n:2.36.8",
            internalSecret: "must-not-leak",
            networks: [
              {
                dockerNetworkId: "b".repeat(64),
                networkName: "relmio-test_default",
                disposable: true,
                internalLabel: "must-not-leak",
              },
            ],
          },
        ],
      };
    },
    async getAuthStatus() { return { ...siwcAccount, exists: true }; },
    prepareLocalN8nSidecarPlan(input) {
      prepared.push(input);
      return {
        kind: "n8n-sidecar",
        target: "n8n-openai-oauth",
        label: "Self-hosted n8n bridge",
        dockerHost: input.dockerHost,
        n8nContainerId: input.n8nContainerId,
        n8nContainerName: input.n8nContainerName,
        dockerNetworkId: input.dockerNetworkId,
        networkName: input.networkName,
        authBinding: input.authBinding,
        endpoint: "http://n8n-openai-oauth:10531/v1",
        protocol: "openai-v1",
        upstreamAuth: "chatgpt-oauth",
        hostPublication: "none",
        managedPath: "~/.relmio/local/n8n-openai-oauth",
        disposableHarnessWarning: true,
      };
    },
  });

  const discovered = await api(wizard, "/api/local/n8n/discover");
  assert.equal(discovered.status, 200);
  const discoveredText = await discovered.text();
  assert.doesNotMatch(discoveredText, /\/Users\/|must-not-leak|dockerHost/iu);
  assert.deepEqual(JSON.parse(discoveredText), {
    dockerAvailable: true,
    dockerVersion: "28.3.2",
    composeVersion: "2.38.2",
    containers: [
      {
        containerId: "a".repeat(64),
        containerName: "relmio-test-n8n",
        image: "docker.n8n.io/n8nio/n8n:2.36.8",
        networks: [
          {
            dockerNetworkId: "b".repeat(64),
            networkName: "relmio-test_default",
            disposable: true,
          },
        ],
      },
    ],
  });

  const planned = await createPlan(wizard, {
    target: "n8n-openai-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  assert.equal(discoveryCalls, 2);
  assert.deepEqual(prepared, [
    {
      dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
      n8nContainerId: "a".repeat(64),
      n8nContainerName: "relmio-test-n8n",
      dockerNetworkId: "b".repeat(64),
      networkName: "relmio-test_default",
      authBinding: { registrationId: siwcAccount.registrationId, clientId: "fixture-client",
        generation: siwcAccount.generation, ownerHostId: siwcAccount.ownerHostId, ownerRuntimeId: "local" },
    },
  ]);
  const plannedText = JSON.stringify(planned);
  assert.doesNotMatch(
    plannedText,
    /\/Users\/|must-not-leak|dockerHost|authGeneration/iu,
  );
  assert.deepEqual(planned.plan, {
    kind: "n8n-sidecar",
    target: "n8n-openai-oauth",
    label: "Self-hosted n8n bridge",
    n8nContainerId: "a".repeat(64),
    n8nContainerName: "relmio-test-n8n",
    dockerNetworkId: "b".repeat(64),
    networkName: "relmio-test_default",
    endpoint: "http://n8n-openai-oauth:10531/v1",
    upstreamAuth: "chatgpt-oauth",
    hostPublication: "none",
    managedPath: "~/.relmio/local/n8n-openai-oauth",
    disposableHarnessWarning: true,
    account: siwcAccount,
  });
});

test("local n8n sidecar install is single-use, uses the server-side OAuth path, and returns only safe fields", async (t) => {
  const installCalls = [];
  const authStatus = { ...siwcAccount, exists: true };
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      return {
        dockerAvailable: true,
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        containers: [
          {
            containerId: "a".repeat(64),
            containerName: "relmio-test-n8n",
            image: "docker.n8n.io/n8nio/n8n:2.36.8",
            networks: [
              {
                dockerNetworkId: "b".repeat(64),
                networkName: "relmio-test_default",
                disposable: false,
              },
            ],
          },
        ],
      };
    },
    async getAuthStatus() {
      return authStatus;
    },
    prepareLocalN8nSidecarPlan(input) {
      return {
        kind: "n8n-sidecar",
        target: "n8n-openai-oauth",
        label: "Self-hosted n8n bridge",
        ...input,
        endpoint: "http://n8n-openai-oauth:10531/v1",
        protocol: "openai-v1",
        upstreamAuth: "chatgpt-oauth",
        hostPublication: "none",
        managedPath: "~/.relmio/local/n8n-openai-oauth",
        disposableHarnessWarning: false,
      };
    },
    async installLocalN8nSidecar(input) {
      installCalls.push(input);
      return {
        target: "n8n-openai-oauth",
        endpoint: "http://n8n-openai-oauth:10531/v1",
        baseUrl: "http://n8n-openai-oauth:10531/v1",
        protocol: "openai-v1",
        clientCredential: "k".repeat(43), credentialShownOnce: true,
        account: siwcAccount, readiness: "verified", runtimeState: "running",
        models: ["gpt-5.6-sol"],
        networkName: "relmio-test_default",
        n8nContainerName: "relmio-test-n8n",
        hostPublication: "none",
        deploymentMode: "installed",
        unofficial: true,
        authContents: "must-not-leak",
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
      };
    },
  });

  const planned = await createPlan(wizard, {
    target: "n8n-openai-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  const malformedInstall = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    backgroundConsent: true,
    apiKey: "retired-api-key-field",
  });
  assert.equal(malformedInstall.status, 400);
  assert.equal((await malformedInstall.json()).recovery, "fix-request");
  assert.equal(installCalls.length, 0);
  const response = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    backgroundConsent: true,
  });
  assert.equal(response.status, 200);
  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].registration.registrationId, siwcAccount.registrationId);
  assert.equal("authPath" in installCalls[0], false);
  assert.equal("apiKey" in installCalls[0], false);
  assert.equal("authContents" in installCalls[0], false);
  assert.equal(installCalls[0].confirmed, true);
  const responseText = await response.text();
  assert.doesNotMatch(
    responseText,
    /\/Users\/|must-not-leak|dockerHost|authContents/iu,
  );
  assert.deepEqual(JSON.parse(responseText), {
    target: "n8n-openai-oauth",
    endpoint: "http://n8n-openai-oauth:10531/v1",
    clientCredential: "k".repeat(43), credentialShownOnce: true,
    account: siwcAccount, readiness: "verified", runtimeState: "running",
    protocol: "openai-v1",
    models: ["gpt-5.6-sol"],
    deploymentMode: "installed",
    networkName: "relmio-test_default",
    hostPublication: "none",
  });

  const replay = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /fresh local endpoint plan/iu);
  assert.equal(installCalls.length, 1);
});

test("local n8n SuperGrok planning and install bind reviewed Docker resources without reading ChatGPT auth", async (t) => {
  const prepared = [];
  const installed = [];
  let authCalls = 0;
  const dockerHost = "unix:///Users/fixture/.docker/run/docker.sock";
  const clientKey = "S".repeat(43);
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      return {
        dockerAvailable: true,
        dockerHost,
        containers: [{
          containerId: "a".repeat(64),
          containerName: "relmio-test-n8n",
          image: "docker.n8n.io/n8nio/n8n:2.36.8",
          networks: [{
            dockerNetworkId: "b".repeat(64),
            networkName: "relmio-test_default",
            disposable: true,
          }],
        }],
      };
    },
    async getAuthStatus() {
      authCalls += 1;
      throw new Error("ChatGPT auth must not be read for SuperGrok");
    },
    prepareLocalN8nSuperGrokPlan(input) {
      prepared.push(input);
      return {
        kind: "n8n-supergrok",
        target: "n8n-supergrok-oauth",
        label: "SuperGrok for n8n",
        endpoint: "http://n8n-supergrok:14502/v1",
        baseUrl: "http://n8n-supergrok:14502/v1",
        protocol: "openai-chat-completions",
        upstreamAuth: "provider-owned-oauth",
        ...input,
        managedPath: "~/.relmio/local/n8n-supergrok-oauth",
        hostPublication: "none",
        experimental: true,
      };
    },
    async installLocalN8nSuperGrok(input) {
      installed.push(input);
      return {
        target: "n8n-supergrok-oauth",
        endpoint: "http://n8n-supergrok:14502/v1",
        baseUrl: "http://n8n-supergrok:14502/v1",
        protocol: "openai-chat-completions",
        networkName: input.plan.networkName,
        n8nContainerName: input.plan.n8nContainerName,
        hostPublication: "none",
        clientKey,
        credentialShownOnce: true,
        deploymentMode: "installed",
        privateMarker: "must-not-leak",
      };
    },
  });

  const planned = await createPlan(wizard, {
    target: "n8n-supergrok-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  assert.equal(authCalls, 0);
  assert.deepEqual(prepared, [{
    dockerHost,
    n8nContainerId: "a".repeat(64),
    n8nContainerName: "relmio-test-n8n",
    dockerNetworkId: "b".repeat(64),
    networkName: "relmio-test_default",
  }]);
  assert.deepEqual(planned.plan, {
    kind: "n8n-supergrok",
    target: "n8n-supergrok-oauth",
    label: "SuperGrok for n8n",
    endpoint: "http://n8n-supergrok:14502/v1",
    baseUrl: "http://n8n-supergrok:14502/v1",
    protocol: "openai-chat-completions",
    upstreamAuth: "provider-owned-oauth",
    n8nContainerId: "a".repeat(64),
    n8nContainerName: "relmio-test-n8n",
    dockerNetworkId: "b".repeat(64),
    networkName: "relmio-test_default",
    managedPath: "~/.relmio/local/n8n-supergrok-oauth",
    hostPublication: "none",
    experimental: true,
    disposableHarnessWarning: true,
  });
  assert.doesNotMatch(JSON.stringify(planned), /dockerHost|must-not-leak/iu);

  const unconfirmed = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: false,
  });
  assert.equal(unconfirmed.status, 400);
  assert.match((await unconfirmed.json()).error, /Confirm the reviewed/iu);
  assert.equal(installed.length, 0);

  const extraField = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    apiKey: "must-not-be-accepted",
  });
  assert.equal(extraField.status, 400);
  assert.match((await extraField.json()).error, /SuperGrok install request/iu);
  assert.equal(installed.length, 0);

  const response = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(response.status, 200);
  assert.equal(authCalls, 0);
  assert.equal(installed.length, 1);
  assert.deepEqual(installed[0], {
    plan: {
      kind: "n8n-supergrok",
      target: "n8n-supergrok-oauth",
      label: "SuperGrok for n8n",
      endpoint: "http://n8n-supergrok:14502/v1",
      baseUrl: "http://n8n-supergrok:14502/v1",
      protocol: "openai-chat-completions",
      upstreamAuth: "provider-owned-oauth",
      dockerHost,
      n8nContainerId: "a".repeat(64),
      n8nContainerName: "relmio-test-n8n",
      dockerNetworkId: "b".repeat(64),
      networkName: "relmio-test_default",
      managedPath: "~/.relmio/local/n8n-supergrok-oauth",
      hostPublication: "none",
      experimental: true,
      disposableHarnessWarning: true,
    },
    confirmed: true,
  });
  const responseText = await response.text();
  assert.doesNotMatch(responseText, /must-not-leak|clientKey|dockerHost/iu);
  assert.deepEqual(JSON.parse(responseText), {
    target: "n8n-supergrok-oauth",
    endpoint: "http://n8n-supergrok:14502/v1",
    baseUrl: "http://n8n-supergrok:14502/v1",
    protocol: "openai-chat-completions",
    networkName: "relmio-test_default",
    n8nContainerName: "relmio-test-n8n",
    hostPublication: "none",
    clientCredential: clientKey,
    credentialShownOnce: true,
    deploymentMode: "installed",
    models: ["grok-build"],
  });
});

test("local n8n SuperGrok install rejects result drift without exposing returned fields", async (t) => {
  const canary = "must-not-leak-supergrok-installer-result";
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      return {
        dockerAvailable: true,
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        containers: [{
          containerId: "a".repeat(64),
          containerName: "relmio-test-n8n",
          networks: [{
            dockerNetworkId: "b".repeat(64),
            networkName: "relmio-test_default",
            disposable: false,
          }],
        }],
      };
    },
    prepareLocalN8nSuperGrokPlan(input) {
      return {
        kind: "n8n-supergrok",
        target: "n8n-supergrok-oauth",
        label: "SuperGrok for n8n",
        endpoint: "http://n8n-supergrok:14502/v1",
        baseUrl: "http://n8n-supergrok:14502/v1",
        protocol: "openai-chat-completions",
        upstreamAuth: "provider-owned-oauth",
        ...input,
        managedPath: "~/.relmio/local/n8n-supergrok-oauth",
        hostPublication: "none",
        experimental: true,
      };
    },
    async installLocalN8nSuperGrok() {
      return {
        target: "n8n-supergrok-oauth",
        endpoint: "http://n8n-supergrok:14502/v1",
        baseUrl: "http://n8n-supergrok:14502/v1",
        protocol: "openai-chat-completions",
        networkName: "different_network",
        n8nContainerName: "relmio-test-n8n",
        hostPublication: "none",
        clientKey: "K".repeat(43),
        credentialShownOnce: true,
        deploymentMode: "installed",
        secret: canary,
      };
    },
  });
  const planned = await createPlan(wizard, {
    target: "n8n-supergrok-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  const response = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /invalid result/iu);
  assert.equal(text.includes(canary), false);
  assert.equal(text.includes("different_network"), false);
});

test("local n8n Assistant planning, install, and removal expose only the reviewed companion contract", async (t) => {
  const prepared = [];
  const installed = [];
  let removed = 0;
  let transformAssistantResult = (result) => result;
  const sandboxApiKey = "s".repeat(43);
  const sandboxImage = ASSISTANT_COMPANION_IMAGES.sandbox;
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      return {
        dockerAvailable: true,
        dockerVersion: "28.3.2",
        composeVersion: "2.38.2",
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        containers: [
          {
            containerId: "a".repeat(64),
            containerName: "relmio-test-n8n",
            image: "docker.n8n.io/n8nio/n8n:2.36.8",
            networks: [
              {
                dockerNetworkId: "b".repeat(64),
                networkName: "relmio-test_assistant-shared",
                disposable: true,
              },
            ],
          },
        ],
      };
    },
    prepareLocalN8nAssistantPlan(input) {
      prepared.push(input);
      return {
        kind: "n8n-assistant",
        target: "n8n-ai-assistant",
        label: "n8n AI Assistant tools",
        protocol: "n8n-instance-ai-companion",
        ...input,
        codeSandbox: true,
        privilegedRunner: true,
        hostPublication: "none",
        managedPath: "~/.relmio/local/n8n-ai-assistant",
        n8nConfigurationRequired: true,
      };
    },
    async installLocalN8nAssistant(input) {
      installed.push(input);
      const sandboxUrl = "http://relmio-ai-sandbox-" + "c".repeat(32) + ":8080";
      const searxngUrl = "http://relmio-ai-searxng-" + "d".repeat(32) + ":8080";
      return transformAssistantResult({
        target: "n8n-ai-assistant",
        endpoint: sandboxUrl,
        sandboxUrl,
        sandboxApiKey,
        searxngUrl,
        protocol: "n8n-instance-ai-companion",
        includeSearxng: true,
        networkName: "relmio-test_assistant-shared",
        n8nContainerName: "relmio-test-n8n",
        hostPublication: "none",
        privilegedRunner: true,
        n8nConfigurationRequired: true,
        n8nSettings: {
          N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
          N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
          N8N_INSTANCE_AI_SANDBOX_IMAGE: sandboxImage,
          N8N_SANDBOX_SERVICE_URL: sandboxUrl,
          N8N_SANDBOX_SERVICE_API_KEY: sandboxApiKey,
          N8N_INSTANCE_AI_SEARXNG_URL: searxngUrl,
        },
        deploymentMode: "installed",
        credentialShownOnce: true,
        privateRunnerToken: "must-not-leak",
      });
    },
    async removeLocalN8nAssistant({ confirmed }) {
      assert.equal(confirmed, true);
      removed += 1;
      return { target: "n8n-ai-assistant", removed: true };
    },
    async getAuthStatus() {
      throw new Error("Assistant companion planning must not read ChatGPT OAuth");
    },
  });

  const missingChoice = await postJson(wizard, "/api/local/plan", {
    target: "n8n-ai-assistant",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  assert.equal(missingChoice.status, 400);
  assert.match((await missingChoice.json()).error, /Assistant plan request/iu);

  const planned = await createPlan(wizard, {
    target: "n8n-ai-assistant",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
    includeSearxng: true,
  });
  const malformedInstall = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    apiKey: "retired-api-key-field",
  });
  assert.equal(malformedInstall.status, 400);
  assert.match((await malformedInstall.json()).error, /Assistant install request/iu);
  assert.equal(installed.length, 0);
  assert.deepEqual(prepared, [{
    dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
    n8nContainerId: "a".repeat(64),
    n8nContainerName: "relmio-test-n8n",
    dockerNetworkId: "b".repeat(64),
    networkName: "relmio-test_assistant-shared",
    includeSearxng: true,
  }]);
  assert.deepEqual(planned.plan, {
    kind: "n8n-assistant",
    target: "n8n-ai-assistant",
    label: "n8n AI Assistant tools",
    protocol: "n8n-instance-ai-companion",
    n8nContainerId: "a".repeat(64),
    n8nContainerName: "relmio-test-n8n",
    dockerNetworkId: "b".repeat(64),
    networkName: "relmio-test_assistant-shared",
    codeSandbox: true,
    includeSearxng: true,
    privilegedRunner: true,
    hostPublication: "none",
    managedPath: "~/.relmio/local/n8n-ai-assistant",
    n8nConfigurationRequired: true,
    disposableHarnessWarning: true,
  });
  assert.doesNotMatch(JSON.stringify(planned), /dockerHost|\/Users\//iu);

  const response = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(response.status, 200);
  assert.equal(installed.length, 1);
  assert.deepEqual(installed[0], {
    plan: {
      kind: "n8n-assistant",
      target: "n8n-ai-assistant",
      label: "n8n AI Assistant tools",
      protocol: "n8n-instance-ai-companion",
      dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
      n8nContainerId: "a".repeat(64),
      n8nContainerName: "relmio-test-n8n",
      dockerNetworkId: "b".repeat(64),
      networkName: "relmio-test_assistant-shared",
      includeSearxng: true,
      codeSandbox: true,
      privilegedRunner: true,
      hostPublication: "none",
      managedPath: "~/.relmio/local/n8n-ai-assistant",
      n8nConfigurationRequired: true,
      disposableHarnessWarning: true,
    },
    confirmed: true,
  });
  const responseText = await response.text();
  assert.doesNotMatch(responseText, /must-not-leak|privateRunnerToken|dockerHost/iu);
  const result = JSON.parse(responseText);
  assert.equal(result.sandboxApiKey, sandboxApiKey);
  assert.equal(result.searxngUrl.endsWith(":8080"), true);
  assert.deepEqual(result.n8nSettings, {
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: sandboxImage,
    N8N_SANDBOX_SERVICE_URL: result.sandboxUrl,
    N8N_SANDBOX_SERVICE_API_KEY: sandboxApiKey,
    N8N_INSTANCE_AI_SEARXNG_URL: result.searxngUrl,
  });
  assert.equal("N8N_ENABLED_MODULES" in result.n8nSettings, false);

  transformAssistantResult = (installResult) => {
    installResult.n8nSettings.N8N_ENABLED_MODULES = "instance-ai";
    return installResult;
  };
  const rejectedPlan = await createPlan(wizard, {
    target: "n8n-ai-assistant",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
    includeSearxng: true,
  });
  const rejectedResponse = await postJson(wizard, "/api/local/install", {
    planId: rejectedPlan.planId,
    confirmed: true,
  });
  assert.equal(rejectedResponse.status, 502);
  assert.doesNotMatch(await rejectedResponse.text(), /N8N_ENABLED_MODULES|instance-ai/u);

  const removal = await postJson(
    wizard,
    "/api/local/n8n/assistant/remove",
    { confirmed: true },
  );
  assert.equal(removal.status, 200);
  assert.deepEqual(await removal.json(), {
    target: "n8n-ai-assistant",
    removed: true,
  });
  assert.equal(removed, 1);
});

test("local n8n sidecar planning fails closed before storing a plan when ChatGPT OAuth is absent", async (t) => {
  let prepareCalls = 0;
  let installCalls = 0;
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      return {
        dockerAvailable: true,
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        containers: [
          {
            containerId: "a".repeat(64),
            containerName: "relmio-test-n8n",
            image: "docker.n8n.io/n8nio/n8n:2.36.8",
            networks: [
              {
                dockerNetworkId: "b".repeat(64),
                networkName: "relmio-test_default",
                disposable: false,
              },
            ],
          },
        ],
      };
    },
    async getAuthStatus() { return { ...siwcAccount, exists: false }; },
    prepareLocalN8nSidecarPlan() {
      prepareCalls += 1;
      throw new Error("must not prepare without OAuth");
    },
    async installLocalN8nSidecar() {
      installCalls += 1;
      throw new Error("must not install without a reviewed plan");
    },
  });

  const planned = await postJson(wizard, "/api/local/plan", {
    target: "n8n-openai-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  assert.equal(planned.status, 409);
  assert.equal((await planned.json()).recovery, "review-again");
  assert.equal(prepareCalls, 0);

  const install = await postJson(wizard, "/api/local/install", {
    planId: "not-a-real-plan-id",
    confirmed: true,
  });
  assert.equal(install.status, 400);
  assert.match((await install.json()).error, /fresh local endpoint plan/iu);
  assert.equal(installCalls, 0);
});

test("local n8n sidecar removal requires explicit confirmation and shares the local mutation guard", async (t) => {
  let releaseInstall;
  let notifyInstallStarted;
  let removeCalls = 0;
  let oauthLoginCalls = 0;
  const installStarted = new Promise((resolve) => {
    notifyInstallStarted = resolve;
  });
  const installGate = new Promise((resolve) => {
    releaseInstall = resolve;
  });
  t.after(() => releaseInstall());
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      return {
        dockerAvailable: true,
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        containers: [
          {
            containerId: "a".repeat(64),
            containerName: "relmio-test-n8n",
            image: "docker.n8n.io/n8nio/n8n:2.36.8",
            networks: [
              {
                dockerNetworkId: "b".repeat(64),
                networkName: "relmio-test_default",
                disposable: false,
              },
            ],
          },
        ],
      };
    },
    async getAuthStatus() { return { ...siwcAccount, exists: true }; },
    prepareLocalN8nSidecarPlan(input) {
      return {
        kind: "n8n-sidecar",
        target: "n8n-openai-oauth",
        label: "Self-hosted n8n bridge",
        ...input,
        endpoint: "http://n8n-openai-oauth:10531/v1",
        protocol: "openai-v1",
        upstreamAuth: "chatgpt-oauth",
        hostPublication: "none",
        managedPath: "~/.relmio/local/n8n-openai-oauth",
        disposableHarnessWarning: false,
      };
    },
    async installLocalN8nSidecar() {
      notifyInstallStarted();
      await installGate;
      return {
        target: "n8n-openai-oauth",
        endpoint: "http://n8n-openai-oauth:10531/v1",
        protocol: "openai-v1",
        clientCredential: "k".repeat(43), credentialShownOnce: true,
        account: siwcAccount, readiness: "verified", runtimeState: "running",
        models: ["listed-model"],
        networkName: "relmio-test_default",
        hostPublication: "none",
        deploymentMode: "installed",
        unofficial: true,
      };
    },
    async removeLocalN8nSidecar({ confirmed }) {
      removeCalls += 1;
      assert.equal(confirmed, true);
      return { target: "n8n-openai-oauth", removed: true };
    },
    async startOAuthLogin() {
      oauthLoginCalls += 1;
      throw new Error("OAuth must remain locked during installation");
    },
  });

  const unconfirmed = await postJson(wizard, "/api/local/n8n/remove", {
    confirmed: false,
  });
  assert.equal(unconfirmed.status, 400);
  assert.match((await unconfirmed.json()).error, /confirm/iu);
  assert.equal(removeCalls, 0);

  const planned = await createPlan(wizard, {
    target: "n8n-openai-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  const installing = postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    backgroundConsent: true,
  });
  await installStarted;

  const concurrent = await postJson(wizard, "/api/local/n8n/remove", {
    confirmed: true,
  });
  assert.equal(concurrent.status, 409);
  assert.match((await concurrent.json()).error, /already in progress/iu);
  assert.equal(removeCalls, 0);

  const concurrentOAuth = await postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
  assert.equal(concurrentOAuth.status, 409);
  assert.match((await concurrentOAuth.json()).error, /already in progress/iu);
  assert.equal(oauthLoginCalls, 0);

  releaseInstall();
  assert.equal((await installing).status, 200);

  const removed = await postJson(wizard, "/api/local/n8n/remove", {
    confirmed: true,
  });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), {
    target: "n8n-openai-oauth",
    removed: true,
  });
  assert.equal(removeCalls, 1);
});

test("local n8n SuperGrok status and removal are sanitized, current, and mutation-guarded", async (t) => {
  const canary = "must-not-leak-supergrok-status-or-removal";
  let statusCalls = 0;
  let releaseStatus;
  let notifyStatusStarted;
  const statusStarted = new Promise((resolve) => {
    notifyStatusStarted = resolve;
  });
  const statusGate = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  let removeCalls = 0;
  let releaseRemoval;
  let notifyRemovalStarted;
  const removalStarted = new Promise((resolve) => {
    notifyRemovalStarted = resolve;
  });
  const removalGate = new Promise((resolve) => {
    releaseRemoval = resolve;
  });
  t.after(() => {
    releaseStatus();
    releaseRemoval();
  });
  const wizard = await startLocalWizard(t, {
    async getLocalN8nSuperGrokStatus() {
      statusCalls += 1;
      if (statusCalls === 1) {
        return {
          target: "n8n-supergrok-oauth",
          managed: true,
          state: "healthy",
          snapshot: {
            target: "n8n-supergrok-oauth",
            endpoint: "http://n8n-supergrok:14502/v1",
            auth: {
              configured: true,
              disclosure: "one-time",
              secret: canary,
            },
            canRemove: true,
            installRoot: canary,
          },
        };
      }
      if (statusCalls === 2) {
        notifyStatusStarted();
        await statusGate;
        return {
          target: "n8n-supergrok-oauth",
          managed: false,
          state: "absent",
        };
      }
      return {
        target: "n8n-supergrok-oauth",
        managed: true,
        state: "healthy",
        snapshot: {
          target: "n8n-supergrok-oauth",
          endpoint: "http://unreviewed-sidecar:14502/v1",
          auth: { configured: true, disclosure: "one-time" },
          canRemove: true,
          secret: canary,
        },
      };
    },
    async removeLocalN8nSuperGrok({ confirmed }) {
      removeCalls += 1;
      assert.equal(confirmed, true);
      if (removeCalls === 1) {
        return {
          target: "n8n-supergrok-oauth",
          removed: false,
          secret: canary,
        };
      }
      notifyRemovalStarted();
      await removalGate;
      return { target: "n8n-supergrok-oauth", removed: true };
    },
  });

  const healthy = await api(wizard, "/api/local/supergrok/status");
  assert.equal(healthy.status, 200);
  const healthyText = await healthy.text();
  assert.equal(healthyText.includes(canary), false);
  assert.deepEqual(JSON.parse(healthyText), {
    target: "n8n-supergrok-oauth",
    managed: true,
    state: "healthy",
    snapshot: {
      target: "n8n-supergrok-oauth",
      endpoint: "http://n8n-supergrok:14502/v1",
      auth: { configured: true, disclosure: "one-time" },
      canRemove: true,
    },
  });

  const staleStatus = api(wizard, "/api/local/supergrok/status");
  await statusStarted;
  const discard = await postJson(wizard, "/api/local/discard", {});
  assert.equal(discard.status, 200);
  releaseStatus();
  assert.equal((await staleStatus).status, 409);

  const unsafeStatus = await api(wizard, "/api/local/supergrok/status");
  assert.equal(unsafeStatus.status, 502);
  const unsafeStatusText = await unsafeStatus.text();
  assert.match(unsafeStatusText, /status is invalid|snapshot is invalid/iu);
  assert.equal(unsafeStatusText.includes(canary), false);

  const extra = await postJson(wizard, "/api/local/supergrok/remove", {
    confirmed: true,
    apiKey: "must-not-be-accepted",
  });
  assert.equal(extra.status, 400);
  assert.equal(removeCalls, 0);
  const unconfirmed = await postJson(wizard, "/api/local/supergrok/remove", {
    confirmed: false,
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(removeCalls, 0);

  const unsafe = await postJson(wizard, "/api/local/supergrok/remove", {
    confirmed: true,
  });
  assert.equal(unsafe.status, 502);
  const unsafeText = await unsafe.text();
  assert.match(unsafeText, /invalid/iu);
  assert.equal(unsafeText.includes(canary), false);

  const removing = postJson(wizard, "/api/local/supergrok/remove", {
    confirmed: true,
  });
  await removalStarted;
  const concurrent = await postJson(wizard, "/api/local/supergrok/remove", {
    confirmed: true,
  });
  assert.equal(concurrent.status, 409);
  assert.equal(removeCalls, 2);
  const discardDuringRemoval = await postJson(wizard, "/api/local/discard", {});
  assert.equal(discardDuringRemoval.status, 409);
  releaseRemoval();
  assert.equal((await removing).status, 200);
});

test("pending ChatGPT OAuth blocks sidecar planning, installation, and removal without consuming the reviewed plan", async (t) => {
  let finishOAuth;
  let discoveryCalls = 0;
  let installCalls = 0;
  let removeCalls = 0;
  const oauthCompletion = new Promise((resolve) => {
    finishOAuth = resolve;
  });
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      discoveryCalls += 1;
      return {
        dockerAvailable: true,
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        containers: [
          {
            containerId: "a".repeat(64),
            containerName: "relmio-test-n8n",
            image: "docker.n8n.io/n8nio/n8n:2.36.8",
            networks: [
              {
                dockerNetworkId: "b".repeat(64),
                networkName: "relmio-test_default",
                disposable: false,
              },
            ],
          },
        ],
      };
    },
    async getAuthStatus() { return { ...siwcAccount, exists: true }; },
    prepareLocalN8nSidecarPlan(input) {
      return {
        kind: "n8n-sidecar",
        target: "n8n-openai-oauth",
        label: "Self-hosted n8n bridge",
        ...input,
        endpoint: "http://n8n-openai-oauth:10531/v1",
        protocol: "openai-v1",
        upstreamAuth: "chatgpt-oauth",
        hostPublication: "none",
        managedPath: "~/.relmio/local/n8n-openai-oauth",
      };
    },
    async startOAuthLogin() {
      return {
        launchMode: "system-browser",
        completion: oauthCompletion,
        async cancel() {
          finishOAuth();
        },
      };
    },
    async installLocalN8nSidecar() {
      installCalls += 1;
      throw new Error("install must stay locked while OAuth is pending");
    },
    async removeLocalN8nSidecar() {
      removeCalls += 1;
      throw new Error("remove must stay locked while OAuth is pending");
    },
  });

  const reviewed = await createPlan(wizard, {
    target: "n8n-openai-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  assert.equal(discoveryCalls, 1);
  const oauth = await postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
  assert.equal(oauth.status, 200);

  const install = await postJson(wizard, "/api/local/install", {
    planId: reviewed.planId,
    confirmed: true,
  });
  assert.equal(install.status, 409);
  assert.equal(installCalls, 0);

  const removal = await postJson(wizard, "/api/local/n8n/remove", {
    confirmed: true,
  });
  assert.equal(removal.status, 409);
  assert.equal(removeCalls, 0);

  const replanning = await postJson(wizard, "/api/local/plan", {
    target: "n8n-openai-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  assert.equal(replanning.status, 409);
  assert.equal(discoveryCalls, 1);

  finishOAuth(siwcAccount);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = await api(wizard, "/api/oauth/status");
    if ((await status.json()).status === "success") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const retried = await postJson(wizard, "/api/local/install", {
    planId: reviewed.planId,
    confirmed: true,
  });
  assert.equal(retried.status, 400);
  assert.equal(installCalls, 0);
});

test("local credential rotation is setup-token protected, live-only, rate-limited, and redacts upstream credentials", async (t) => {
  const prepareCalls = [];
  const activationCalls = [];
  let testerResetCalls = 0;
  const wizard = await startLocalWizard(t, {
    localChatTest: {
      resetAll() {
        testerResetCalls += 1;
      },
    },
    async prepareLocalClientCredentialRotation(input) {
      prepareCalls.push(input);
      return {
        target: "codex-chatgpt",
        endpoint: "ws://127.0.0.1:14500",
        protocol: "codex-app-server-json-rpc",
        clientCredential: "fresh-local-capability-shown-once",
        credentialShownOnce: true,
        models: [],
        tokenSha256: "a".repeat(64),
        deploymentMode: "staged",
        registrationId: siwcAccount.registrationId, expectedGeneration: siwcAccount.generation,
        experimental: true,
        browserClients: false,
        upstreamChatGptCredential: "must-not-be-returned",
      };
    },
    async activateLocalClientCredentialRotation(input) {
      activationCalls.push(input);
      return {
        target: input.target,
        endpoint: "ws://127.0.0.1:14500",
        protocol: "codex-app-server-json-rpc",
        models: [],
        deploymentMode: "updated",
        experimental: true,
        browserClients: false,
        upstreamChatGptCredential: "must-not-be-returned",
      };
    },
  });

  const first = await postJson(wizard, "/api/local/client-credential/rotate", {
    target: "codex-chatgpt",
  });
  assert.equal(first.status, 200);
  const firstText = await first.text();
  assert.equal(firstText.includes("must-not-be-returned"), false);
  const firstBody = JSON.parse(firstText);
  assert.deepEqual(firstBody, {
    target: "codex-chatgpt",
    endpoint: "ws://127.0.0.1:14500",
    protocol: "codex-app-server-json-rpc",
    clientCredential: "fresh-local-capability-shown-once",
    credentialShownOnce: true,
    models: [],
    deploymentMode: "staged",
    experimental: true,
    browserClients: false,
    rotationId: firstBody.rotationId,
  });
  assert.equal(typeof firstBody.rotationId, "string");
  assert.equal(firstText.includes("tokenSha256"), false);
  assert.deepEqual(prepareCalls, [{ target: "codex-chatgpt" }]);

  const firstActivation = await postJson(
    wizard,
    "/api/local/client-credential/activate",
    {
      rotationId: firstBody.rotationId,
      clientCredential: firstBody.clientCredential,
    },
  );
  assert.equal(firstActivation.status, 200);
  const activationText = await firstActivation.text();
  assert.equal(activationText.includes("must-not-be-returned"), false);
  assert.equal(activationText.includes("fresh-local-capability"), false);

  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await postJson(
      wizard,
      "/api/local/client-credential/rotate",
      { target: "codex-chatgpt" },
    );
    assert.equal(response.status, 200);
    const staged = await response.json();
    const activated = await postJson(
      wizard,
      "/api/local/client-credential/activate",
      {
        rotationId: staged.rotationId,
        clientCredential: staged.clientCredential,
      },
    );
    assert.equal(activated.status, 200);
  }
  const limited = await postJson(wizard, "/api/local/client-credential/rotate", {
    target: "codex-chatgpt",
  });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /too many attempts/iu);
  assert.equal(prepareCalls.length, 10);
  assert.equal(activationCalls.length, 10);
  assert.equal(testerResetCalls, 20);

  const preview = await startLocalWizard(
    t,
    {
      async prepareLocalClientCredentialRotation() {
        throw new Error("should not run");
      },
    },
    { previewMode: true },
  );
  const disabled = await postJson(preview, "/api/local/client-credential/rotate", {
    target: "codex-chatgpt",
  });
  assert.equal(disabled.status, 403);
  assert.match((await disabled.json()).error, /disabled in sanitized preview mode/iu);
});

test("dashboard discard invalidates plans and keys without treating the installed owner as signed out", async (t) => {
  const assistantReview = createAssistantSearxngEditReview();
  let installCalls = 0;
  let assistantEditCalls = 0;
  let rotationPrepareCalls = 0;
  let rotationActivateCalls = 0;
  let chatKeyCalls = 0;
  let chatResetCalls = 0;
  const wizard = await startLocalWizard(t, {
    localChatTest: {
      async issueKey() {
        chatKeyCalls += 1;
        return {
          keyId: `discard-key-${chatKeyCalls}`,
          publicKeyJwk: { kty: "RSA", n: "public-modulus", e: "AQAB" },
          algorithm: "RSA-OAEP-256",
          expiresAt: "2030-01-01T00:00:00.000Z",
        };
      },
      resetAll() {
        chatResetCalls += 1;
      },
    },
    async getManagedLocalEndpointStatus() {
      return installCalls ? installedChatStatus() : { managed: false, state: "absent", snapshot: null };
    },
    async installLocalEndpoint({ plan }) {
      installCalls += 1;
      return {
        target: plan.target,
        endpoint: plan.endpoint,
        protocol: plan.protocol,
        clientCredential,
        credentialShownOnce: true,
        account: siwcAccount, readiness: "verified", runtimeState: "running",
        models: [],
        deploymentMode: "installed",
        experimental: plan.experimental,
        browserClients: plan.browserClients,
      };
    },
    async prepareLocalN8nAssistantSearxngUpdate() {
      return assistantReview;
    },
    async editLocalN8nAssistantSearxng() {
      assistantEditCalls += 1;
      throw new Error("a discarded review must not reach the edit service");
    },
    async prepareLocalClientCredentialRotation({ target }) {
      rotationPrepareCalls += 1;
      return {
        target,
        endpoint: target === "codex-chatgpt"
          ? "ws://127.0.0.1:14500"
          : "http://127.0.0.1:14501",
        protocol: target === "codex-chatgpt"
          ? "codex-app-server-json-rpc"
          : "relmio-codex-chat",
        clientCredential,
        tokenSha256: "a".repeat(64),
        credentialShownOnce: true,
        models: [],
        deploymentMode: "staged",
        registrationId: siwcAccount.registrationId, expectedGeneration: siwcAccount.generation,
        experimental: true,
        browserClients: false,
      };
    },
    async activateLocalClientCredentialRotation() {
      rotationActivateCalls += 1;
      throw new Error("a discarded rotation must not reach the activation service");
    },
  });

  const installedPlan = await createPlan(wizard, {
    target: "codex-chat",
    port: 14501,
  });
  assert.equal(
    (await postJson(wizard, "/api/local/install", {
      planId: installedPlan.planId,
      confirmed: true,
    })).status,
    200,
  );
  assert.equal(
    (await postJson(wizard, "/api/local/chat-test/key", {})).status,
    200,
  );

  const oldPlan = await createPlan(wizard, {
    target: "xai-grok-build",
    port: 14502,
  });
  const reviewed = await postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/review",
    { includeSearxng: true },
  );
  assert.equal(reviewed.status, 200);
  const oldReview = await reviewed.json();
  const rotated = await postJson(
    wizard,
    "/api/local/client-credential/rotate",
    { target: "codex-chatgpt" },
  );
  assert.equal(rotated.status, 200);
  const oldRotation = await rotated.json();

  const unauthorized = await fetch(`${wizard.origin}/api/local/discard`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);
  const crossOrigin = await api(wizard, "/api/local/discard", {
    method: "POST",
    headers: { Origin: "http://malicious.example" },
    body: "{}",
  });
  assert.equal(crossOrigin.status, 403);
  const stillBlocked = await postJson(
    wizard,
    "/api/local/client-credential/rotate",
    { target: "codex-chatgpt" },
  );
  assert.equal(stillBlocked.status, 409);
  assert.equal(rotationPrepareCalls, 1);

  const resetsBeforeDiscard = chatResetCalls;
  const discarded = await postJson(wizard, "/api/local/discard", {});
  assert.equal(discarded.status, 200);
  assert.deepEqual(await discarded.json(), { discarded: true });
  assert.equal(chatResetCalls, resetsBeforeDiscard + 1);

  const oldInstall = await postJson(wizard, "/api/local/install", {
    planId: oldPlan.planId,
    confirmed: true,
  });
  assert.equal(oldInstall.status, 400);
  assert.match((await oldInstall.json()).error, /fresh local endpoint plan/iu);
  assert.equal(installCalls, 1);

  const oldEnable = await postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/enable",
    { reviewId: oldReview.reviewId, confirmed: true },
  );
  assert.equal(oldEnable.status, 400);
  assert.match((await oldEnable.json()).error, /review/iu);
  assert.equal(assistantEditCalls, 0);

  const oldActivation = await postJson(
    wizard,
    "/api/local/client-credential/activate",
    {
      rotationId: oldRotation.rotationId,
      clientCredential: oldRotation.clientCredential,
    },
  );
  assert.equal(oldActivation.status, 400);
  assert.match((await oldActivation.json()).error, /fresh local client credential/iu);
  assert.equal(rotationActivateCalls, 0);

  const freshRotation = await postJson(
    wizard,
    "/api/local/client-credential/rotate",
    { target: "codex-chatgpt" },
  );
  assert.equal(freshRotation.status, 200);
  assert.equal(rotationPrepareCalls, 2);

  const discardedInstalledTarget = await postJson(
    wizard,
    "/api/local/chat-test/key",
    {},
  );
  assert.equal(discardedInstalledTarget.status, 200);
  assert.equal(chatKeyCalls, 2);
});

test("dashboard discard rejects an inventory read that finishes after the discard", async (t) => {
  const started = Promise.withResolvers();
  const inspection = Promise.withResolvers();
  t.after(() => inspection.resolve());
  let calls = 0;
  const snapshot = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    docker: { available: true, version: "29.7.2", composeVersion: "5.3.1" },
    auth: { secretsRevealable: false },
    services: [
      ["codex-chatgpt", "Codex (ChatGPT login)", "endpoint"],
      ["codex-chat", "Codex Chat adapter", "endpoint"],
      ["xai-grok-build", "SuperGrok", "endpoint"],
      ["local-n8n-stack", "n8n + ngrok", "n8n-stack"],
      ["n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"],
      ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"],
      ["n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"],
      ["n8n-local-model", "Local model for n8n", "n8n-local-model"],
    ].map(([target, label, kind]) => ({
      target, label, kind, managed: false, state: "absent", snapshot: null,
      actions: ["setup"],
    })),
    providers: dashboardProviders(),
  };
  const wizard = await startLocalWizard(t, {
    async getLocalDashboardStatus() {
      calls += 1;
      if (calls === 1) {
        started.resolve();
        await inspection.promise;
      }
      return snapshot;
    },
  });
  const reading = api(wizard, "/api/local/dashboard");
  await started.promise;
  assert.equal((await postJson(wizard, "/api/local/discard", {})).status, 200);
  inspection.resolve();
  const stale = await reading;
  assert.equal(stale.status, 409);
  const rejected = await stale.json();
  assert.match(rejected.error, /dashboard.*changed/iu);
  assert.equal(Object.hasOwn(rejected, "services"), false);
  const refreshed = await api(wizard, "/api/local/dashboard");
  assert.equal(refreshed.status, 200);
});

test("dashboard discard rejects a local plan that finishes discovery after the discard", async (t) => {
  let releaseDiscovery;
  let notifyDiscoveryStarted;
  let installCalls = 0;
  const discoveryStarted = new Promise((resolve) => {
    notifyDiscoveryStarted = resolve;
  });
  const discoveryGate = new Promise((resolve) => {
    releaseDiscovery = resolve;
  });
  t.after(() => releaseDiscovery());

  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      notifyDiscoveryStarted();
      await discoveryGate;
      return {
        dockerAvailable: true,
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        containers: [
          {
            containerId: "a".repeat(64),
            containerName: "relmio-test-n8n",
            image: "docker.n8n.io/n8nio/n8n:2.36.8",
            networks: [
              {
                dockerNetworkId: "b".repeat(64),
                networkName: "relmio-test_default",
                disposable: false,
              },
            ],
          },
        ],
      };
    },
    async getAuthStatus() { return { ...siwcAccount, exists: true }; },
    async installLocalN8nSidecar() {
      installCalls += 1;
      throw new Error("a discarded in-flight plan must not install");
    },
  });

  const planning = postJson(wizard, "/api/local/plan", {
    target: "n8n-openai-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  await discoveryStarted;

  assert.equal((await postJson(wizard, "/api/local/discard", {})).status, 200);
  releaseDiscovery();

  const stalePlan = await planning;
  assert.equal(stalePlan.status, 409);
  assert.match((await stalePlan.json()).error, /dashboard|discard|changed/iu);

  const install = await postJson(wizard, "/api/local/install", {
    planId: "discarded-in-flight-plan",
    confirmed: true,
  });
  assert.equal(install.status, 400);
  assert.match((await install.json()).error, /fresh local endpoint plan/iu);
  assert.equal(installCalls, 0);
});

test("dashboard discard leaves a running ChatGPT login helper attached", async (t) => {
  let finishLogin;
  let cancelCalls = 0;
  const completion = new Promise((resolve) => {
    finishLogin = resolve;
  });
  const wizard = await startLocalWizard(t, {
    async startOAuthLogin() {
      return {
        launchMode: "system-browser",
        completion,
        async cancel() {
          cancelCalls += 1;
          finishLogin();
        },
      };
    },
  });

  const started = await postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
  assert.equal(started.status, 200);
  const { attemptId } = await started.json();
  assert.equal((await postJson(wizard, "/api/local/discard", {})).status, 200);
  const status = await api(wizard, "/api/oauth/status");
  assert.deepEqual(await status.json(), {
    status: "pending",
    attemptId,
  });
  assert.equal(cancelCalls, 0);
});

test("retired native Codex device login routes cannot create a second refresh owner", async (t) => {
  const wizard = await startLocalWizard(t, {});
  assert.equal((await postJson(wizard, "/api/local/codex/login", {})).status, 404);
  assert.equal((await api(wizard, "/api/local/codex/login/status")).status, 405);
});

test("local installation rejects concurrent attempts and releases its lock after failure", async (t) => {
  let releaseFirstInstall;
  let notifyFirstInstallStarted;
  let installCalls = 0;
  let rotationCalls = 0;
  const firstInstallStarted = new Promise((resolve) => {
    notifyFirstInstallStarted = resolve;
  });
  const firstInstallGate = new Promise((resolve) => {
    releaseFirstInstall = resolve;
  });
  t.after(() => releaseFirstInstall());

  const wizard = await startLocalWizard(t, {
    async installLocalEndpoint({ plan }) {
      installCalls += 1;
      if (installCalls === 1) {
        notifyFirstInstallStarted();
        await firstInstallGate;
        throw new Error("Deferred installation failed.");
      }
      return {
        target: plan.target,
        endpoint: plan.endpoint,
        protocol: plan.protocol,
        clientCredential,
        credentialShownOnce: true,
        models: ["gpt-5.6-sol"],
        deploymentMode: "installed",
        experimental: plan.experimental,
        browserClients: plan.browserClients,
      };
    },
    async prepareLocalClientCredentialRotation() {
      rotationCalls += 1;
      throw new Error("rotation should remain locked");
    },
  });

  const firstPlan = await createPlan(wizard, {
    target: "xai-grok-build",
    port: 14502,
  });
  const firstInstall = postJson(wizard, "/api/local/install", {
    planId: firstPlan.planId,
    confirmed: true,
  });
  await firstInstallStarted;

  const secondPlan = await createPlan(wizard, {
    target: "xai-grok-build",
    port: 14503,
  });
  const concurrent = await postJson(wizard, "/api/local/install", {
    planId: secondPlan.planId,
    confirmed: true,
  });
  assert.equal(concurrent.status, 409);
  assert.match((await concurrent.json()).error, /already in progress/iu);
  assert.equal(installCalls, 1);

  const concurrentRotation = await postJson(
    wizard,
    "/api/local/client-credential/rotate",
    { target: "xai-grok-build" },
  );
  assert.equal(concurrentRotation.status, 409);
  assert.match(
    (await concurrentRotation.json()).error,
    /already in progress/iu,
  );
  assert.equal(rotationCalls, 0);

  releaseFirstInstall();
  assert.equal((await firstInstall).status, 400);

  const retried = await postJson(wizard, "/api/local/install", {
    planId: secondPlan.planId,
    confirmed: true,
  });
  assert.equal(retried.status, 200);
  assert.equal(installCalls, 2);
});

test("credential rotation blocks installation until the managed service change completes", async (t) => {
  let releaseRotation;
  let notifyRotationStarted;
  let installCalls = 0;
  const rotationStarted = new Promise((resolve) => {
    notifyRotationStarted = resolve;
  });
  const rotationGate = new Promise((resolve) => {
    releaseRotation = resolve;
  });
  t.after(() => releaseRotation());

  const wizard = await startLocalWizard(t, {
    async prepareLocalClientCredentialRotation() {
      notifyRotationStarted();
      await rotationGate;
      return {
        target: "codex-chatgpt",
        endpoint: "ws://127.0.0.1:14500",
        protocol: "codex-app-server-json-rpc",
        clientCredential,
        tokenSha256: "b".repeat(64),
        credentialShownOnce: true,
        models: [],
        deploymentMode: "staged",
        registrationId: siwcAccount.registrationId, expectedGeneration: siwcAccount.generation,
        experimental: true,
        browserClients: false,
      };
    },
    async activateLocalClientCredentialRotation({ target }) {
      return {
        target,
        endpoint: "ws://127.0.0.1:14500",
        protocol: "codex-app-server-json-rpc",
        models: [],
        deploymentMode: "updated",
        experimental: true,
        browserClients: false,
      };
    },
    async installLocalEndpoint({ plan }) {
      installCalls += 1;
      return {
        target: plan.target,
        endpoint: plan.endpoint,
        protocol: plan.protocol,
        clientCredential,
        credentialShownOnce: true,
        models: [],
        deploymentMode: "installed",
        account: siwcAccount, readiness: "verified", runtimeState: "running",
        experimental: plan.experimental,
        browserClients: plan.browserClients,
      };
    },
  });

  const rotation = postJson(
    wizard,
    "/api/local/client-credential/rotate",
    { target: "codex-chatgpt" },
  );
  await rotationStarted;

  const plan = await createPlan(wizard, {
    target: "codex-chatgpt",
    port: 14500,
  });
  const concurrentInstall = await postJson(wizard, "/api/local/install", {
    planId: plan.planId,
    confirmed: true,
  });
  assert.equal(concurrentInstall.status, 409);
  assert.match(
    (await concurrentInstall.json()).error,
    /already in progress/iu,
  );
  assert.equal(installCalls, 0);

  releaseRotation();
  const stagedResponse = await rotation;
  assert.equal(stagedResponse.status, 200);
  const staged = await stagedResponse.json();
  const activation = await postJson(
    wizard,
    "/api/local/client-credential/activate",
    {
      rotationId: staged.rotationId,
      clientCredential: staged.clientCredential,
    },
  );
  assert.equal(activation.status, 200);

  const retriedInstall = await postJson(wizard, "/api/local/install", {
    planId: plan.planId,
    confirmed: true,
  });
  assert.equal(retriedInstall.status, 200);
  assert.equal(installCalls, 1);
});

test("a local plan is consumed before a failed install and errors redact secrets and paths", async (t) => {
  let installCalls = 0;
  const wizard = await startLocalWizard(t, {
    async installLocalEndpoint({ plan }) {
      installCalls += 1;
      throw new Error(`Docker failed in /Users/fixture using ${plan.target}`);
    },
  });
  const planned = await createPlan(wizard, {
    target: "xai-grok-build",
    port: 14502,
  });

  const failed = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(failed.status, 400);
  const failure = await failed.json();
  assert.equal(failure.status, 400);
  assert.equal(JSON.stringify(failure).includes("must-not-leak"), false);

  const replay = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(replay.status, 400);
  assert.equal(installCalls, 1);
});

test("SIWC first-use acknowledgment gates installation and account switching invalidates review", async (t) => {
  let selected = siwcAccount.registrationId;
  let account = { ...siwcAccount, needsPlanWelcome: true };
  const other = { ...siwcAccount, registrationId: "fixture_registration_2" };
  let installs = 0;
  const wizard = await startLocalWizard(t, {
    async listAuthRegistrations() { return [account, other]; },
    async getSelectedRegistration() { return selected; },
    async selectRegistration({ registrationId }) { selected = registrationId; },
    async getAuthStatus({ registrationId }) { return { ...(registrationId === account.registrationId ? account : other), exists: true }; },
    async readRegistration({ registrationId }) { return { clientId: "fixture-client",
      generation: registrationId === account.registrationId ? account.generation : other.generation }; },
    async acknowledgePlanUse() { account = { ...account, needsPlanWelcome: false }; return account; },
    async installLocalEndpoint() { installs++; throw new Error("must not install stale plan"); },
  });
  assert.equal((await postJson(wizard, "/api/local/plan", { target: "codex-chat", port: 14501 })).status, 409);
  assert.equal((await postJson(wizard, "/api/siwc/ack", { registrationId: account.registrationId,
    expectedGeneration: account.generation })).status, 200);
  const plan = await createPlan(wizard, { target: "codex-chat", port: 14501 });
  assert.equal((await postJson(wizard, "/api/siwc/select", { registrationId: other.registrationId })).status, 200);
  assert.equal((await postJson(wizard, "/api/local/install", { planId: plan.planId, confirmed: true })).status, 400);
  assert.equal(installs, 0);
});

test("verified identity without plan grant remains visible but cannot review installation", async (t) => {
  const account = { ...siwcAccount, planPermission: "not-granted", planEnabled: false };
  const wizard = await startLocalWizard(t, {
    async listAuthRegistrations() { return [account]; },
  });
  const accounts = await (await api(wizard, "/api/siwc/accounts")).json();
  assert.equal(accounts.accounts[0].session, "connected");
  assert.equal(accounts.accounts[0].planPermission, "not-granted");
  assert.equal((await postJson(wizard, "/api/local/plan", { target: "codex-chat", port: 14501 })).status, 409);
});

test("local sign-out projects unconfirmed revocation and never exposes protected credentials", async (t) => {
  const wizard = await startLocalWizard(t, {
    async listAuthRegistrations() { return [{ ...siwcAccount, accessToken: "must-not-leak" }]; },
    async signOut() { return { account: { ...siwcAccount, session: "signed-out", planEnabled: false },
      revocation: "unconfirmed", refreshToken: "must-not-leak" }; },
  });
  const response = await postJson(wizard, "/api/siwc/logout", { registrationId: siwcAccount.registrationId,
    expectedGeneration: siwcAccount.generation });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(JSON.parse(text).revocation, "unconfirmed");
  assert.equal(JSON.parse(text).account.session, "signed-out");
  assert.equal(text.includes("must-not-leak"), false);
});

test("local pending handoffs require read-only review and final confirmation, consume review once", async (t) => {
  for (const target of ["codex-chat", "codex-chatgpt", "n8n-openai-oauth"]) {
    await t.test(target, async (subtest) => {
      let calls = 0;
      let account = { ...siwcAccount, ownership: "handoff-pending" };
      const reconcile = async ({ registration, confirmed }) => {
        assert.equal(confirmed, true);
        assert.equal(registration.registrationId, account.registrationId);
        calls++;
        account = { ...account, ownership: "transferred", session: "signed-out", planEnabled: false };
        return { outcome: "finished", account, receipt: "must-not-leak" };
      };
      const wizard = await startLocalWizard(subtest, {
        async listAuthRegistrations() { return [account]; },
        reconcileLocalSiwcHandoff: reconcile, reconcileLocalN8nSiwcHandoff: reconcile,
      });
      const review = await postJson(wizard, "/api/local/siwc/recovery/review", {
        target, registrationId: account.registrationId, action: "reconcile" });
      assert.equal(review.status, 200);
      const body = await review.json();
      assert.equal(calls, 0);
      assert.equal((await postJson(wizard, "/api/local/siwc/recovery/reconcile", {
        reviewId: body.reviewId, confirmed: false })).status, 409);
      const response = await postJson(wizard, "/api/local/siwc/recovery/reconcile", {
        reviewId: body.reviewId, confirmed: true });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(JSON.parse(text).outcome, "finished");
      assert.equal(text.includes("must-not-leak"), false);
      assert.equal(calls, 1);
      assert.equal((await postJson(wizard, "/api/local/siwc/recovery/reconcile", {
        reviewId: body.reviewId, confirmed: true })).status, 409);
    });
  }
});

test("local reconciliation preserves not-accepted and unknown outcomes without reporting success", async (t) => {
  for (const unknown of [false, true]) {
    await t.test(String(unknown), async (subtest) => {
      const account = { ...siwcAccount, ownership: "handoff-pending" };
      const wizard = await startLocalWizard(subtest, {
        async listAuthRegistrations() { return [account]; },
        async reconcileLocalSiwcHandoff() {
          if (unknown) throw Object.assign(new Error("Destination outcome is unknown."), { remoteOutcomeUnknown: true });
          return { outcome: "not-accepted", account };
        },
      });
      const body = await (await postJson(wizard, "/api/local/siwc/recovery/review", {
        target: "codex-chat", registrationId: account.registrationId, action: "reconcile" })).json();
      const response = await postJson(wizard, "/api/local/siwc/recovery/reconcile", {
        reviewId: body.reviewId, confirmed: true });
      assert.equal(response.status, unknown ? 400 : 200);
      const result = await response.json();
      if (unknown) assert.equal(result.remoteOutcomeUnknown, true);
      else assert.equal(result.outcome, "not-accepted");
    });
  }
});

test("reviewed local staged resume preserves exact checkpoint, plan and one-time key on finalization failure", async (t) => {
  let account = { ...siwcAccount, ownership: "transferred", session: "signed-out", planEnabled: false };
  const binding = { registrationId: account.registrationId, clientId: "fixture-client",
    generation: "original_generation", ownerHostId: account.ownerHostId, ownerRuntimeId: "local" };
  const plan = { target: "codex-chat", label: "Codex Chat Adapter", bindHost: "127.0.0.1",
    port: 14501, endpoint: "http://127.0.0.1:14501", protocol: "relmio-codex-chat",
    upstreamAuth: "relmio-siwc", browserClients: false, experimental: true,
    managedPath: "~/.relmio/local/codex-chat", authBinding: binding };
  const resume = { target: plan.target, installId: "fixture_install_1", registrationId: account.registrationId,
    stage: "transferred", plan, checkpointSha256: "a".repeat(64), filesSha256: "b".repeat(64), resourcesSha256: "c".repeat(64) };
  let calls = 0;
  const wizard = await startLocalWizard(t, {
    async listAuthRegistrations() { return [account]; },
    async reviewLocalSiwcResume() { return resume; },
    async installLocalEndpoint(input) {
      assert.equal(input.resume, resume);
      assert.equal(input.plan, plan);
      calls++;
      return siwcInstallResult({ target: plan.target, endpoint: plan.endpoint, protocol: plan.protocol,
        deploymentMode: "partial", readiness: "unverified", experimental: true,
        finalizationFailure: { error: "Journal finalization failed.", recovery: "review-again" } });
    },
  });
  const review = await postJson(wizard, "/api/local/siwc/recovery/review", {
    target: plan.target, registrationId: account.registrationId, action: "resume" });
  assert.equal(review.status, 200);
  const body = await review.json();
  assert.equal(body.plan.resumeRequired, true);
  assert.equal(calls, 0);
  const response = await postJson(wizard, "/api/local/install", { planId: body.planId, confirmed: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.clientCredential, "k".repeat(43));
  assert.equal(result.finalizationFailure.recovery, "review-again");
  assert.equal((await postJson(wizard, "/api/local/install", { planId: body.planId, confirmed: true })).status, 400);
  assert.equal(calls, 1);
});

test("recovery validates paths, setup-token, same origin and account generation before installer effects", async (t) => {
  let account = { ...siwcAccount, ownership: "handoff-pending" };
  let calls = 0;
  const wizard = await startLocalWizard(t, {
    async listAuthRegistrations() { return [account]; },
    async readRegistration() { return { clientId: "fixture-client", generation: account.generation }; },
    async reconcileLocalSiwcHandoff() { calls++; throw new Error("must not reconcile"); },
  });
  const route = "/api/local/siwc/recovery/review";
  assert.equal((await postJson(wizard, route, { target: "../../outside",
    registrationId: account.registrationId, action: "reconcile" })).status, 400);
  const request = { target: "codex-chat", registrationId: account.registrationId, action: "reconcile" };
  assert.equal((await fetch(`${wizard.origin}${route}`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: wizard.origin }, body: JSON.stringify(request) })).status, 401);
  assert.equal((await api(wizard, route, { method: "POST", headers: { Origin: "https://other.example" },
    body: JSON.stringify(request) })).status, 403);
  const body = await (await postJson(wizard, route, request)).json();
  account = { ...account, generation: "changed_generation" };
  assert.equal((await postJson(wizard, "/api/local/siwc/recovery/reconcile", {
    reviewId: body.reviewId, confirmed: true })).status, 409);
  assert.equal(calls, 0);
});

test("sanitized preview mode never invokes Docker, installation, or sign-in", async (t) => {
  const calls = [];
  const wizard = await startLocalWizard(
    t,
    {
      async getLocalDockerStatus() {
        calls.push("docker");
      },
      async discoverLocalN8nSidecarTargets() {
        calls.push("n8n-discover");
      },
      async installLocalEndpoint() {
        calls.push("install");
      },
      async installLocalN8nSidecar() {
        calls.push("n8n-install");
      },
      async removeLocalN8nSidecar() {
        calls.push("n8n-remove");
      },
      async getLocalN8nSuperGrokStatus() {
        calls.push("supergrok-status");
      },
      async removeLocalN8nSuperGrok() {
        calls.push("supergrok-remove");
      },
      async startOAuthLogin() { calls.push("login"); },
    },
    { previewMode: true },
  );

  const docker = await api(wizard, "/api/local/docker/status");
  assert.deepEqual(await docker.json(), {
    dockerAvailable: false,
    previewMode: true,
  });
  const n8nDiscovery = await api(wizard, "/api/local/n8n/discover");
  assert.deepEqual(await n8nDiscovery.json(), {
    dockerAvailable: false,
    previewMode: true,
    containers: [],
  });

  const n8nPlan = await postJson(wizard, "/api/local/plan", {
    target: "n8n-openai-oauth",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
  });
  assert.equal(n8nPlan.status, 403);

  const planned = await createPlan(wizard, {
    target: "xai-grok-build",
    port: 14502,
  });
  const install = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(install.status, 403);

  const removal = await postJson(wizard, "/api/local/n8n/remove", {
    confirmed: true,
  });
  assert.equal(removal.status, 403);
  const superGrokStatus = await api(wizard, "/api/local/supergrok/status");
  assert.deepEqual(await superGrokStatus.json(), {
    target: "n8n-supergrok-oauth",
    managed: false,
    state: "absent",
    snapshot: null,
  });
  const superGrokRemoval = await postJson(
    wizard,
    "/api/local/supergrok/remove",
    { confirmed: true },
  );
  assert.equal(superGrokRemoval.status, 403);

  const login = await postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
  assert.equal(login.status, 403);
  const status = await api(wizard, "/api/siwc/accounts");
  assert.equal((await status.json()).previewMode, true);
  assert.deepEqual(calls, []);
});

function createAssistantSearxngEditReview() {
  return {
    schemaVersion: 1,
    kind: "relmio-local-n8n-assistant-searxng-update",
    target: "n8n-ai-assistant",
    includeSearxng: true,
    sandboxApiKeyRotated: false,
    plan: {
      kind: "n8n-assistant",
      target: "n8n-ai-assistant",
      label: "n8n AI Assistant tools",
      protocol: "n8n-instance-ai-companion",
      dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
      n8nContainerId: "a".repeat(64),
      n8nContainerName: "relmio-test-n8n",
      dockerNetworkId: "b".repeat(64),
      networkName: "relmio-test_assistant-shared",
      includeSearxng: false,
      codeSandbox: true,
      privilegedRunner: true,
      hostPublication: "none",
      managedPath: "~/.relmio/local/n8n-ai-assistant",
      n8nConfigurationRequired: true,
    },
    installation: {
      version: 2,
      installId: "c".repeat(32),
      projectName: `relmio-ai-${"d".repeat(32)}`,
      sandboxAlias: `relmio-ai-sandbox-${"e".repeat(32)}`,
      searxngAlias: `relmio-ai-searxng-${"f".repeat(32)}`,
      includeSearxng: false,
    },
  };
}

test("managed local companion edits require review and confirmations, use the shared mutation guard, and sanitize every result", async (t) => {
  const review = createAssistantSearxngEditReview();
  const editInputs = [];
  let editReturnsUnexpectedSecret = true;
  const wizard = await startLocalWizard(t, {
    async prepareLocalN8nAssistantSearxngUpdate({ includeSearxng }) {
      assert.equal(includeSearxng, true);
      return review;
    },
    async editLocalN8nAssistantSearxng(input) {
      editInputs.push(input);
      return {
        target: "n8n-ai-assistant",
        endpoint: `http://${review.installation.sandboxAlias}:8080`,
        sandboxUrl: `http://${review.installation.sandboxAlias}:8080`,
        searxngUrl: `http://${review.installation.searxngAlias}:8080`,
        protocol: "n8n-instance-ai-companion",
        includeSearxng: true,
        networkName: review.plan.networkName,
        n8nContainerName: review.plan.n8nContainerName,
        hostPublication: "none",
        privilegedRunner: true,
        n8nConfigurationRequired: true,
        n8nSettings: {
          N8N_INSTANCE_AI_SEARXNG_URL: `http://${review.installation.searxngAlias}:8080`,
        },
        deploymentMode: "searxng-enabled",
        sandboxApiKeyRotated: false,
        ...(editReturnsUnexpectedSecret ? { sandboxApiKey: "must-not-leak" } : {}),
      };
    },
    async startOAuthLogin() {
      throw new Error("must not start while a local edit is in flight");
    },
  });


  const reviewed = await postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/review",
    { includeSearxng: true },
  );
  assert.equal(reviewed.status, 200);
  const reviewedText = await reviewed.text();
  assert.doesNotMatch(
    reviewedText,
    /dockerHost|dockerNetworkId|containerId|installId|projectName|Users/iu,
  );
  const safeReview = JSON.parse(reviewedText);
  assert.deepEqual(Object.keys(safeReview).sort(), [
    "hostPublication",
    "includeSearxng",
    "n8nConfigurationRequired",
    "n8nContainerName",
    "networkName",
    "reviewId",
    "sandboxApiKeyRotated",
    "sandboxUrl",
    "searxngUrl",
    "target",
  ]);

  const unconfirmedEnable = await postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/enable",
    { reviewId: safeReview.reviewId },
  );
  assert.equal(unconfirmedEnable.status, 400);
  assert.equal(editInputs.length, 0);
  const enabled = await postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/enable",
    { reviewId: safeReview.reviewId, confirmed: true },
  );
  assert.equal(enabled.status, 502, "unexpected secret-bearing result must fail closed");
  assert.equal(editInputs.length, 1);
  assert.deepEqual(editInputs[0], { review, confirmed: true });
  assert.doesNotMatch(await enabled.text(), /sandboxApiKey|must-not-leak/iu);

  editReturnsUnexpectedSecret = false;
  const reviewedAgain = await postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/review",
    { includeSearxng: true },
  );
  assert.equal(reviewedAgain.status, 200);
  const safeReviewAgain = await reviewedAgain.json();
  const enabledSafely = await postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/enable",
    { reviewId: safeReviewAgain.reviewId, confirmed: true },
  );
  assert.equal(enabledSafely.status, 200);
  const safeEnabledText = await enabledSafely.text();
  assert.doesNotMatch(safeEnabledText, /must-not-leak|dockerHost/iu);
  assert.deepEqual(JSON.parse(safeEnabledText), {
    target: "n8n-ai-assistant",
    endpoint: `http://${review.installation.sandboxAlias}:8080`,
    sandboxUrl: `http://${review.installation.sandboxAlias}:8080`,
    searxngUrl: `http://${review.installation.searxngAlias}:8080`,
    protocol: "n8n-instance-ai-companion",
    includeSearxng: true,
    networkName: review.plan.networkName,
    n8nContainerName: review.plan.n8nContainerName,
    hostPublication: "none",
    privilegedRunner: true,
    n8nConfigurationRequired: true,
    n8nSettings: {
      N8N_INSTANCE_AI_SEARXNG_URL: `http://${review.installation.searxngAlias}:8080`,
    },
    deploymentMode: "searxng-enabled",
    sandboxApiKeyRotated: false,
  });
});

test("Assistant SearXNG review holds the shared local-change guard while attesting Docker state", async (t) => {
  const review = createAssistantSearxngEditReview();
  let releaseReview;
  let signalReviewStarted;
  let refreshCalls = 0;
  let oauthCalls = 0;
  const reviewGate = new Promise((resolve) => {
    releaseReview = resolve;
  });
  const reviewStarted = new Promise((resolve) => {
    signalReviewStarted = resolve;
  });
  t.after(() => releaseReview());

  const wizard = await startLocalWizard(t, {
    async prepareLocalN8nAssistantSearxngUpdate() {
      signalReviewStarted();
      await reviewGate;
      return review;
    },
    async reviewLocalSiwcResume() {
      refreshCalls += 1;
      throw new Error("must not recover while a review snapshot is in flight");
    },
    async startOAuthLogin() {
      oauthCalls += 1;
      throw new Error("must not sign in while a review snapshot is in flight");
    },
  });

  const reviewing = postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/review",
    { includeSearxng: true },
  );
  await reviewStarted;

  const concurrentRefresh = await postJson(
    wizard,
    "/api/local/siwc/recovery/review",
    { target: "codex-chat", registrationId: siwcAccount.registrationId, action: "resume" },
  );
  const concurrentSignIn = await postJson(wizard, "/api/oauth/login", { purpose: "sign-in" });
  assert.equal(concurrentRefresh.status, 409);
  assert.equal(concurrentSignIn.status, 409);
  assert.equal(refreshCalls, 0);
  assert.equal(oauthCalls, 0);

  releaseReview();
  assert.equal((await reviewing).status, 200);
});

test("local companion edit routes reject preview mode without calling services", async (t) => {
  const calls = [];
  const wizard = await startLocalWizard(
    t,
    {
      async getAuthStatus() {
        calls.push("auth");
      },
      async reviewLocalSiwcResume() { calls.push("resume"); },
      async prepareLocalN8nAssistantSearxngUpdate() {
        calls.push("review");
      },
      async editLocalN8nAssistantSearxng() {
        calls.push("enable");
      },
    },
    { previewMode: true },
  );
  for (const [path, body] of [
    ["/api/local/siwc/recovery/review", { target: "codex-chat", registrationId: siwcAccount.registrationId, action: "resume" }],
    ["/api/local/n8n/assistant/searxng/review", { includeSearxng: true }],
    ["/api/local/n8n/assistant/searxng/enable", { reviewId: "x", confirmed: true }],
  ]) {
    const response = await postJson(wizard, path, body);
    assert.equal(response.status, 403);
  }
  assert.deepEqual(calls, []);
});

test("retired credential-copy and native-runtime update routes reject without installer effects", async (t) => {
  const wizard = await startLocalWizard(t, {});
  for (const path of ["/api/local/n8n/sidecar/refresh", "/api/local/n8n/sidecar/update"]) {
    assert.equal((await postJson(wizard, path, { confirmed: true })).status, 404);
  }
});

test("local n8n staged resume preserves exact review and one-time key through unknown finalization", async (t) => {
  const authBinding = { registrationId: siwcAccount.registrationId, clientId: "fixture-client",
    generation: siwcAccount.generation, ownerHostId: siwcAccount.ownerHostId, ownerRuntimeId: "local" };
  const plan = createLocalN8nSidecarPlan({ dockerHost: "unix:///var/run/docker.sock",
    n8nContainerId: "a".repeat(64), n8nContainerName: "fixture-n8n",
    dockerNetworkId: "b".repeat(64), networkName: "fixture-network", authBinding });
  const resume = { target: plan.target, installId: "fixture_install_1",
    registrationId: siwcAccount.registrationId, stage: "built", plan,
    checkpointSha256: "a".repeat(64), filesSha256: "b".repeat(64), resourcesSha256: "c".repeat(64) };
  let calls = 0;
  const wizard = await startLocalWizard(t, {
    async reviewLocalN8nSiwcResume({ registration }) {
      assert.equal(registration.registrationId, siwcAccount.registrationId);
      return resume;
    },
    async installLocalN8nSidecar(input) {
      assert.equal(input.resume, resume);
      assert.equal(input.plan, plan);
      assert.equal(input.backgroundConsent.noticeVersion, "siwc-local-2026-10-04");
      calls++;
      return siwcInstallResult({ target: plan.target, endpoint: plan.endpoint, protocol: "openai-v1",
        networkName: plan.networkName, hostPublication: "unknown", runtimeState: "unknown",
        readiness: "unverified", deploymentMode: "partial", models: [],
        finalizationFailure: { error: "Stopping the owned runtime was not confirmed.", recovery: "review-again" } });
    },
  });
  const review = await postJson(wizard, "/api/local/siwc/recovery/review", {
    target: plan.target, registrationId: siwcAccount.registrationId, action: "resume" });
  assert.equal(review.status, 200);
  const body = await review.json();
  assert.equal(body.plan.staging.installId, resume.installId);
  assert.equal(calls, 0);
  assert.equal((await postJson(wizard, "/api/local/install", {
    planId: body.planId, confirmed: false, backgroundConsent: true })).status, 400);
  const response = await postJson(wizard, "/api/local/install", {
    planId: body.planId, confirmed: true, backgroundConsent: true });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.clientCredential, "k".repeat(43));
  assert.equal(result.hostPublication, "unknown");
  assert.equal(result.finalizationFailure.recovery, "review-again");
  assert.equal(calls, 1);
});

test("n8n resume reviews the selected recreated container and preserves the installer's exact returned plan", async (t) => {
  const dockerHost = "unix:///var/run/docker.sock";
  const target = "n8n-openai-oauth";
  const n8nContainerId = "c".repeat(64);
  const dockerNetworkId = "b".repeat(64);
  const account = { ...siwcAccount, ownership: "transferred", session: "signed-out", planEnabled: false };
  let resume;
  let reviewedPlan;
  let installs = 0;
  const wizard = await startLocalWizard(t, {
    async listAuthRegistrations() { return [account]; },
    async discoverLocalN8nSidecarTargets() {
      return { dockerAvailable: true, dockerHost, containers: [{
        containerId: n8nContainerId, containerName: "recreated-n8n",
        networks: [{ dockerNetworkId, networkName: "same-reviewed-network" }],
      }] };
    },
    async reviewLocalN8nSiwcResume({ registration, plan }) {
      assert.equal(registration.registrationId, account.registrationId);
      assert.equal(plan.n8nContainerId, n8nContainerId);
      assert.equal(plan.dockerNetworkId, dockerNetworkId);
      assert.equal(plan.dockerHost, dockerHost);
      assert.equal(plan.authBinding.generation, account.generation);
      reviewedPlan = createLocalN8nSidecarPlan({ ...plan, authBinding: {
        ...plan.authBinding, generation: "b6b68314-3d22-4b0b-bb05-1849d817ee99",
      } });
      resume = { target, installId: "fixture_install_1", registrationId: account.registrationId,
        stage: "transferred", plan: reviewedPlan, checkpointSha256: "a".repeat(64),
        filesSha256: "b".repeat(64), resourcesSha256: "c".repeat(64) };
      return resume;
    },
    async installLocalN8nSidecar(input) {
      installs++;
      assert.equal(input.resume, resume);
      assert.equal(input.plan, reviewedPlan);
      return siwcInstallResult({ target, endpoint: reviewedPlan.endpoint, protocol: "openai-v1",
        networkName: reviewedPlan.networkName });
    },
  });
  const response = await postJson(wizard, "/api/local/siwc/recovery/review", {
    target, registrationId: account.registrationId, action: "resume", n8nContainerId, dockerNetworkId });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan.n8nContainerId, n8nContainerId);
  assert.equal(body.plan.dockerNetworkId, dockerNetworkId);
  assert.equal(body.plan.n8nContainerName, "recreated-n8n");
  assert.equal(body.plan.dockerHost, undefined);
  assert.equal(body.plan.authBinding, undefined);
  assert.equal(installs, 0);
  const installed = await postJson(wizard, "/api/local/install", {
    planId: body.planId, confirmed: true, backgroundConsent: true });
  assert.equal(installed.status, 200);
  assert.equal((await installed.json()).clientCredential, "k".repeat(43));
  assert.equal(installs, 1);
});

test("n8n resume rejects malformed paired IDs and non-attached networks before installer review", async (t) => {
  let discoveryCalls = 0;
  let reviews = 0;
  const wizard = await startLocalWizard(t, {
    async discoverLocalN8nSidecarTargets() {
      discoveryCalls++;
      return { dockerAvailable: true, dockerHost: "unix:///var/run/docker.sock", containers: [{
        containerId: "c".repeat(64), containerName: "recreated-n8n",
        networks: [{ dockerNetworkId: "b".repeat(64), networkName: "same-reviewed-network" }],
      }] };
    },
    async reviewLocalN8nSiwcResume() { reviews++; throw new Error("must not review an unverified target"); },
  });
  const body = { target: "n8n-openai-oauth", registrationId: siwcAccount.registrationId, action: "resume" };
  for (const fields of [
    { n8nContainerId: "c".repeat(64) },
    { dockerNetworkId: "b".repeat(64) },
    { n8nContainerId: "../../outside", dockerNetworkId: "b".repeat(64) },
    { n8nContainerId: "c".repeat(64), dockerNetworkId: "b".repeat(64), dockerHost: "/untrusted" },
  ]) {
    assert.equal((await postJson(wizard, "/api/local/siwc/recovery/review", { ...body, ...fields })).status, 400);
  }
  assert.equal(discoveryCalls, 0);
  assert.equal((await postJson(wizard, "/api/local/siwc/recovery/review", {
    ...body, n8nContainerId: "c".repeat(64), dockerNetworkId: "d".repeat(64),
  })).status, 409);
  assert.equal(discoveryCalls, 1);
  assert.equal(reviews, 0);
});

const localImagesContainerId = "c".repeat(64);
const localImagesPending = Object.freeze({ userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device",
  expiresAt: "2026-10-07T12:15:00.000Z", deviceAuthId: "must-not-leak-device" });
const localImagesAccount = Object.freeze({ email: "images@example.test", planType: "plus", accountIdSuffix: "abc123",
  accountId: "must-not-leak-account", accessToken: "must-not-leak-access" });
const localImagesSecrets = Object.freeze({ accessToken: "must-not-leak-access", refreshToken: "must-not-leak-refresh",
  deviceAuthId: "must-not-leak-device", containerId: localImagesContainerId });

test("local image status returns only validated add-on fields and pins the verification URL", async (t) => {
  const calls = [];
  let next;
  const wizard = await startLocalWizard(t, {
    async getLocalN8nCodexImagesStatus(input) { calls.push(input); return next; },
    async changeLocalN8nCodexImages() { throw new Error("must not change"); },
  });
  const check = (body = { registrationId: siwcAccount.registrationId }) =>
    postJson(wizard, "/api/local/n8n/siwc/images/status", body);
  assert.equal((await postJson(wizard, "/api/local/n8n/siwc/images/action",
    { action: "login-cancel", confirmed: false })).status, 409, "an action needs a status check first");
  // The status check shares the 10-in-15-minutes limit, so each case below is one of those ten.
  assert.equal((await check({ registrationId: siwcAccount.registrationId, containerId: "c".repeat(64) })).status, 400);
  assert.equal(calls.length, 0);

  next = { ...localImagesSecrets, state: "signed-in", account: localImagesAccount, pending: localImagesPending };
  const signedIn = await check();
  assert.equal(signedIn.status, 200);
  const signedInText = await signedIn.text();
  assert.equal(signedInText.includes("must-not-leak"), false);
  assert.deepEqual(JSON.parse(signedInText), { state: "signed-in",
    account: { email: "images@example.test", planType: "plus", accountIdSuffix: "abc123" } });
  assert.deepEqual(calls, [{ registrationId: siwcAccount.registrationId }]);

  next = { ...localImagesSecrets, state: "pending", pending: localImagesPending };
  const pending = await check();
  const pendingText = await pending.text();
  assert.equal(pendingText.includes("must-not-leak"), false);
  assert.deepEqual(JSON.parse(pendingText), { state: "pending", pending: { userCode: "ABCD-1234",
    verificationUrl: "https://auth.openai.com/codex/device", expiresAt: "2026-10-07T12:15:00.000Z" } });

  for (const invalid of [
    { state: "pending", pending: { ...localImagesPending, userCode: "abcd-1234" } },
    { state: "pending", pending: { ...localImagesPending, verificationUrl: "https://auth.openai.com/codex/device?next=https://example.test" } },
    { state: "pending", pending: { ...localImagesPending, verificationUrl: "http://auth.openai.com/codex/device" } },
    { state: "pending", pending: { ...localImagesPending, verificationUrl: "https://example.test/codex/device" } },
    { state: "signed-in", account: { ...localImagesAccount, accountIdSuffix: "must-not-leak-account" } },
    { state: "on" },
  ]) {
    next = { ...localImagesSecrets, ...invalid };
    const response = await check();
    assert.equal(response.status, 502, JSON.stringify(invalid));
    assert.equal((await response.text()).includes("must-not-leak"), false);
  }
  assert.equal((await postJson(wizard, "/api/local/n8n/siwc/images/action",
    { action: "login-cancel", confirmed: false })).status, 409, "a rejected status leaves no target");
});

test("local image actions need confirmation and the checked container; polls need a pending sign-in", async (t) => {
  const changes = [];
  const polls = [{ state: "pending", pending: localImagesPending }, { state: "signed-in", account: localImagesAccount }];
  const wizard = await startLocalWizard(t, {
    async getLocalN8nCodexImagesStatus() { return { ...localImagesSecrets, state: "off" }; },
    async changeLocalN8nCodexImages(input) {
      changes.push(input);
      const result = input.action === "login-start" ? { state: "pending", pending: localImagesPending }
        : input.action === "login-poll" ? polls.shift()
          : input.action === "sign-out" ? { state: "off", revocation: "unconfirmed" } : { state: "off" };
      return { ...localImagesSecrets, ...result };
    },
  });
  const act = (body) => postJson(wizard, "/api/local/n8n/siwc/images/action", body);
  const poll = () => postJson(wizard, "/api/local/n8n/siwc/images/login-status", {});
  const check = () => postJson(wizard, "/api/local/n8n/siwc/images/status", { registrationId: siwcAccount.registrationId });

  assert.equal((await act({ action: "login-start", confirmed: true })).status, 409);
  assert.equal((await check()).status, 200);
  for (const body of [{ action: "login-start", confirmed: false }, { action: "login-start" },
    { action: "login-poll", confirmed: true }, { action: "status", confirmed: true },
    { action: "sign-out", confirmed: "true" }, { action: "sign-out", confirmed: true, registrationId: "other_registration" }]) {
    assert.equal((await act(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await poll()).status, 409, "polling needs a pending sign-in");
  assert.equal(changes.length, 0);

  const started = await act({ action: "login-start", confirmed: true });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).pending.userCode, "ABCD-1234");
  assert.deepEqual(changes[0], { registrationId: siwcAccount.registrationId, action: "login-start",
    expectedContainerId: localImagesContainerId, confirmed: true });

  assert.equal((await (await poll()).json()).state, "pending");
  assert.deepEqual(changes[1], { registrationId: siwcAccount.registrationId, action: "login-poll",
    expectedContainerId: localImagesContainerId, confirmed: false });
  const finished = await poll();
  const finishedText = await finished.text();
  assert.equal(finishedText.includes("must-not-leak"), false);
  assert.equal(JSON.parse(finishedText).state, "signed-in");
  assert.equal((await poll()).status, 409, "a finished sign-in is no longer polled");

  const cancelled = await act({ action: "login-cancel", confirmed: false });
  assert.deepEqual(await cancelled.json(), { state: "off" });
  const signedOut = await act({ action: "sign-out", confirmed: true });
  assert.deepEqual(await signedOut.json(), { state: "off", revocation: "unconfirmed" });
  assert.equal(changes.at(-1).confirmed, true);

  const later = Date.now() + 21 * 60_000;
  t.mock.method(Date, "now", () => later);
  assert.equal((await act({ action: "login-cancel", confirmed: false })).status, 409, "the checked target expires");
  assert.equal(changes.length, 5);
});

test("local sidecar sign-out and removal report only a known image revocation result", async (t) => {
  let imagesRevocation = "confirmed";
  const healthy = { managed: true, state: "healthy", snapshot: {
    target: "n8n-openai-oauth", registrationId: siwcAccount.registrationId, migrationRequired: false,
    auth: { configured: true, disclosure: "server-managed", account: siwcAccount } } };
  const wizard = await startLocalWizard(t, {
    async getLocalN8nSidecarStatus() { return healthy; },
    async manageLocalN8nSiwcInstallation() {
      return { account: { ...siwcAccount, session: "signed-out", planEnabled: false }, revocation: "confirmed",
        runtimeStopped: true, imagesRevocation };
    },
    async removeLocalN8nSidecar() {
      return { target: "n8n-openai-oauth", removed: true, imagesRevocation, accessToken: "must-not-leak" };
    },
  });
  const signOut = () => postJson(wizard, "/api/local/n8n/siwc/manage", { registrationId: siwcAccount.registrationId,
    expectedGeneration: siwcAccount.generation, action: "sign-out", confirmed: true });
  const remove = () => postJson(wizard, "/api/local/n8n/remove", { confirmed: true });
  assert.equal((await (await signOut()).json()).imagesRevocation, "confirmed");
  imagesRevocation = "unknown";
  assert.deepEqual(await (await remove()).json(), { target: "n8n-openai-oauth", removed: true, imagesRevocation: "unknown" });
  imagesRevocation = "must-not-leak";
  const signedOut = await (await signOut()).text();
  const removed = await (await remove()).text();
  assert.equal(signedOut.includes("must-not-leak") || removed.includes("must-not-leak"), false);
  assert.equal(JSON.parse(removed).imagesRevocation, undefined);
});
