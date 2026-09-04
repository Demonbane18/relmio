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
import { startWizardServer } from "../src/web/server.js";

const sessionToken = "local-server-test-session-token-1234567890";
const platformApiKey = `sk-${"a".repeat(48)}`;
const clientCredential = "local-client-credential-shown-once";
const codexProjectName = `relmio-codex-chatgpt-${"01".repeat(16)}`;

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
    target: "openai-api",
    port: 12435,
    allowedOrigins: [],
  });
  const installing = postJson(wizard, "/api/local/install", {
    planId: plan.planId,
    confirmed: true,
    apiKey: platformApiKey,
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
      return "SHA256:verified-test-fingerprint";
    },
    async connectVerified() {
      return remote;
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

  const login = await postJson(wizard, "/api/oauth/login", {});
  assert.equal(login.status, 400);
  assert.deepEqual(await login.json(), {
    error: "The ChatGPT sign-in result could not be confirmed.",
    retryBlocked: true,
  });

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
        authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
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

  const login = await postJson(wizard, "/api/oauth/login", {});
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
          authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
          completion: Promise.resolve({ success: true }),
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

    const login = postJson(wizard, "/api/oauth/login", {});
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
          authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
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

    const login = await postJson(wizard, "/api/oauth/login", {});
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

  const styles = await fetch(`${wizard.origin}/local.css`);
  assert.equal(styles.status, 200);
  assert.match(styles.headers.get("content-type") ?? "", /^text\/css/u);
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
    async installLocalEndpoint() {
      return {
        target: "codex-chat",
        endpoint: "http://127.0.0.1:14501",
        protocol: "relmio-codex-chat",
        clientCredential,
        credentialShownOnce: true,
        models: [],
        deploymentMode: "installed",
        experimental: true,
        browserClients: false,
      };
    },
  });

  const notReady = await postJson(wizard, "/api/local/chat-test/key", {});
  assert.equal(notReady.status, 409);
  assert.match((await notReady.json()).error, /Install the Codex Chat Adapter/iu);

  const planned = await createPlan(wizard, {
    target: "codex-chat",
    port: "14501",
    allowedOrigins: [],
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
      return {
        managed: true,
        state: "healthy",
        snapshot: {
          target: "codex-chat",
          endpoint: "http://127.0.0.1:14501",
          auth: { configured: true, disclosure: "rotate-only" },
          canRotateCredential: true,
        },
      };
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
      return {
        managed: true,
        state: "healthy",
        snapshot: { target: "codex-chat" },
      };
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
  assert.deepEqual(JSON.parse(firstText), {
    error: ngrokSetupErrorMessage,
    retryablePlan: true,
    retryableNgrokSetup: true,
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
  assert.deepEqual(JSON.parse(text), {
    error:
      "The selected SearXNG service did not return a valid JSON search result. Relmio removed the failed owned resources.",
    retryablePlan: true,
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
          {
            target: "openai-api",
            label: "OpenAI API",
            kind: "endpoint",
            managed: true,
            state: "healthy",
            snapshot: {
              target: "openai-api",
              endpoint: "http://127.0.0.1:12435/v1",
              auth: { configured: true, disclosure: "rotate-only", token: canary },
              canRotateCredential: true,
              installRoot: canary,
            },
            actions: ["rotate-credential"],
            marker: canary,
          },
          absent("codex-chatgpt", "Codex (ChatGPT login)", "endpoint"),
          absent("codex-chat", "Codex Chat adapter", "endpoint"),
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
        ],
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
      {
        target: "openai-api",
        label: "OpenAI API",
        kind: "endpoint",
        managed: true,
        state: "healthy",
        snapshot: {
          target: "openai-api",
          endpoint: "http://127.0.0.1:12435/v1",
          auth: { configured: true, disclosure: "rotate-only" },
          canRotateCredential: true,
        },
        actions: ["rotate-credential"],
      },
      absent("codex-chatgpt", "Codex (ChatGPT login)", "endpoint"),
      absent("codex-chat", "Codex Chat adapter", "endpoint"),
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
      absent("n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"),
      absent("local-n8n-assistant", "AI Assistant tools", "n8n-assistant"),
    ],
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
    label: target === "openai-api"
      ? "OpenAI API"
      : target === "codex-chatgpt"
        ? "Codex (ChatGPT login)"
        : "Codex Chat adapter",
    kind: "endpoint",
    managed: true,
    state: "healthy",
    snapshot: {
      target,
      endpoint: endpointUrl,
      auth: { configured: true, disclosure: "rotate-only" },
      canRotateCredential: true,
      canSignIn: true,
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
      endpoint("openai-api", "http://127.0.0.1:12435/v1", ["rotate-credential"]),
      endpoint(
        "codex-chatgpt",
        "ws://127.0.0.1:14500",
        ["sign-in", "rotate-credential"],
      ),
      endpoint(
        "codex-chat",
        "http://127.0.0.1:14501",
        ["sign-in", "rotate-credential"],
      ),
      absent("local-n8n-stack", "n8n + ngrok", "n8n-stack"),
      absent("n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"),
      absent("local-n8n-assistant", "AI Assistant tools", "n8n-assistant"),
    ],
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
    valid.services.slice(0, 3).map(({ actions }) => actions),
    [
      ["rotate-credential"],
      ["sign-in", "rotate-credential"],
      ["sign-in", "rotate-credential"],
    ],
  );
  assert.equal(validText.includes("canSignIn"), false);
  assert.equal(validText.includes(canary), false);

  const scenarios = [
    {
      name: "openai-sign-in",
      mutate(status) {
        status.services[0].actions = ["sign-in", "rotate-credential"];
      },
    },
    {
      name: "stopped-codex",
      mutate(status) {
        status.services[1].state = "stopped";
        status.services[1].actions = ["sign-in"];
      },
    },
    {
      name: "partial-codex",
      mutate(status) {
        status.services[1].state = "partial";
        status.services[1].snapshot = null;
        status.services[1].actions = ["sign-in"];
      },
    },
    {
      name: "unavailable-codex",
      mutate(status) {
        status.services[2].managed = false;
        status.services[2].state = "unavailable";
        status.services[2].snapshot = null;
        status.services[2].actions = ["sign-in"];
      },
    },
    {
      name: "absent-codex",
      mutate(status) {
        status.services[2].managed = false;
        status.services[2].state = "absent";
        status.services[2].snapshot = null;
        status.services[2].actions = ["sign-in"];
      },
    },
    {
      name: "extra-action",
      mutate(status) {
        status.services[1].actions.push("remove");
      },
    },
    {
      name: "reordered-actions",
      mutate(status) {
        status.services[2].actions = ["rotate-credential", "sign-in"];
      },
    },
    {
      name: "unsafe-snapshot",
      mutate(status) {
        status.services[1].snapshot.endpoint = `https://attacker.example/${canary}`;
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
  assert.equal(body.services.length, 6);
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
          absent("openai-api", "OpenAI API", "endpoint"),
          absent("codex-chatgpt", "Codex (ChatGPT login)", "endpoint"),
          absent("codex-chat", "Codex Chat adapter", "endpoint"),
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
        ],
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
    ["openai-api", "OpenAI API", "endpoint"],
    ["codex-chatgpt", "Codex (ChatGPT login)", "endpoint"],
    ["codex-chat", "Codex Chat adapter", "endpoint"],
    ["local-n8n-stack", "n8n + ngrok", "n8n-stack"],
    ["n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"],
    ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"],
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
    ["openai-api", "OpenAI API", "endpoint"],
    ["codex-chatgpt", "Codex (ChatGPT login)", "endpoint"],
    ["codex-chat", "Codex Chat adapter", "endpoint"],
    ["local-n8n-stack", "n8n + ngrok", "n8n-stack"],
    ["n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"],
    ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"],
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
      assert.equal("code" in result, false);
      assert.equal(responseText.includes(installBody.ngrokAuthtoken), false);
      assert.equal(responseText.includes(installBody.basicAuthPassword), false);
      assert.equal(responseText.includes(dockerHost), false);
      assert.equal(responseText.includes("docker stderr"), false);
      assert.equal(responseText.includes("https://unexpected.invalid"), false);
      assert.equal(responseText.includes("plain-private-value"), false);
    });
  }
});

test("local Docker status, planning, and installation expose only safe fields", async (t) => {
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
        target: "openai-api",
        endpoint: "http://127.0.0.1:12435/v1",
        protocol: "openai-v1",
        clientCredential,
        credentialShownOnce: true,
        models: ["gpt-5.6-sol"],
        deploymentMode: "installed",
        experimental: false,
        browserClients: true,
        internalPath: "/Users/fixture/.relmio/local/openai-api",
        upstreamApiKey: platformApiKey,
      };
    },
  });

  const dockerResponse = await api(
    wizard,
    "/api/local/docker/status",
  );
  assert.deepEqual(await dockerResponse.json(), {
    dockerAvailable: true,
    dockerVersion: "28.3.2",
    composeVersion: "2.38.2",
  });

  const planned = await createPlan(wizard, {
    target: "openai-api",
    port: "12435",
    allowedOrigins: ["http://localhost:3000", "http://localhost:3000"],
  });
  assert.equal(typeof planned.planId, "string");
  assert.ok(planned.planId.length >= 32);
  assert.equal(planned.planId.includes("openai-api"), false);
  assert.deepEqual(planned.plan, {
    target: "openai-api",
    label: "OpenAI API",
    bindHost: "127.0.0.1",
    port: 12435,
    endpoint: "http://127.0.0.1:12435/v1",
    protocol: "openai-v1",
    upstreamAuth: "platform-api-key",
    allowedOrigins: ["http://localhost:3000"],
    browserClients: true,
    experimental: false,
    managedPath: "~/.relmio/local/openai-api",
  });

  const installResponse = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    apiKey: platformApiKey,
  });
  assert.equal(installResponse.status, 200);
  const installedText = await installResponse.text();
  assert.equal(installedText.includes(platformApiKey), false);
  assert.equal(installedText.includes("/Users/"), false);
  assert.deepEqual(JSON.parse(installedText), {
    target: "openai-api",
    endpoint: "http://127.0.0.1:12435/v1",
    protocol: "openai-v1",
    clientCredential,
    credentialShownOnce: true,
    models: ["gpt-5.6-sol"],
    deploymentMode: "installed",
    experimental: false,
    browserClients: true,
  });
  assert.deepEqual(installerInput, {
    plan: {
      target: "openai-api",
      label: "OpenAI API",
      bindHost: "127.0.0.1",
      port: 12435,
      endpoint: "http://127.0.0.1:12435/v1",
      protocol: "openai-v1",
      upstreamAuth: "platform-api-key",
      allowedOrigins: ["http://localhost:3000"],
      browserClients: true,
      experimental: false,
      managedPath: "~/.relmio/local/openai-api",
    },
    apiKey: platformApiKey,
    confirmed: true,
  });

  const replay = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    apiKey: platformApiKey,
  });
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /fresh local endpoint plan/iu);
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
    async getAuthStatus() {
      return {
        exists: true,
        path: "/Users/fixture/.n8n-openai-oauth/auth.json",
        updatedAt: "2026-08-31T01:02:03.000Z",
      };
    },
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
        authGeneration: input.authGeneration,
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
      authGeneration: "2026-08-31T01:02:03.000Z",
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
  });
});

test("local n8n sidecar install is single-use, uses the server-side OAuth path, and returns only safe fields", async (t) => {
  const installCalls = [];
  const authStatus = {
    exists: true,
    path: "/Users/fixture/.n8n-openai-oauth/auth.json",
    updatedAt: "2026-08-31T01:02:03.000Z",
  };
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
        apiKeyPlaceholder: "local-only",
        useResponsesApi: true,
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
  const response = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(response.status, 200);
  assert.equal(installCalls.length, 1);
  assert.equal(installCalls[0].authPath, authStatus.path);
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
    apiKeyPlaceholder: "local-only",
    protocol: "openai-v1",
    models: ["gpt-5.6-sol"],
    deploymentMode: "installed",
    networkName: "relmio-test_default",
    hostPublication: "none",
    responsesApi: true,
    unofficial: true,
  });

  const replay = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /fresh local endpoint plan/iu);
  assert.equal(installCalls.length, 1);
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
  assert.match((await missingChoice.json()).error, /SearXNG|choose/iu);

  const planned = await createPlan(wizard, {
    target: "n8n-ai-assistant",
    n8nContainerId: "a".repeat(64),
    dockerNetworkId: "b".repeat(64),
    includeSearxng: true,
  });
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
    async getAuthStatus() {
      return {
        exists: false,
        path: "/Users/fixture/.n8n-openai-oauth/auth.json",
      };
    },
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
  assert.equal(planned.status, 400);
  assert.match((await planned.json()).error, /sign in with ChatGPT/iu);
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
    async getAuthStatus() {
      return {
        exists: true,
        path: "/Users/fixture/.n8n-openai-oauth/auth.json",
        updatedAt: "2026-08-31T01:02:03.000Z",
      };
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
    async installLocalN8nSidecar() {
      notifyInstallStarted();
      await installGate;
      return {
        target: "n8n-openai-oauth",
        endpoint: "http://n8n-openai-oauth:10531/v1",
        protocol: "openai-v1",
        apiKeyPlaceholder: "local-only",
        useResponsesApi: true,
        models: [],
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
  });
  await installStarted;

  const concurrent = await postJson(wizard, "/api/local/n8n/remove", {
    confirmed: true,
  });
  assert.equal(concurrent.status, 409);
  assert.match((await concurrent.json()).error, /already in progress/iu);
  assert.equal(removeCalls, 0);

  const concurrentOAuth = await postJson(wizard, "/api/oauth/login", {});
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

test("pending ChatGPT OAuth blocks sidecar planning, installation, and removal without consuming the reviewed plan", async (t) => {
  let finishOAuth;
  let authUpdatedAt = "2026-08-31T01:02:03.000Z";
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
    async getAuthStatus() {
      return {
        exists: true,
        path: "/Users/fixture/.n8n-openai-oauth/auth.json",
        updatedAt: authUpdatedAt,
      };
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
      };
    },
    async startOAuthLogin() {
      return {
        authorizationUrl: "https://auth.openai.com/oauth/authorize",
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
  const oauth = await postJson(wizard, "/api/oauth/login", {});
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

  authUpdatedAt = "2026-08-31T01:02:04.000Z";
  finishOAuth();
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
  assert.match((await retried.json()).error, /changed after plan review/iu);
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

test("dashboard discard invalidates reviewed local state and clears safe installed-target state", async (t) => {
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
      return { managed: false, state: "absent", snapshot: null };
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
    allowedOrigins: [],
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
    target: "openai-api",
    port: 12435,
    allowedOrigins: [],
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
    apiKey: platformApiKey,
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
  assert.equal(discardedInstalledTarget.status, 409);
  assert.equal(chatKeyCalls, 1);
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
    async getAuthStatus() {
      return {
        exists: true,
        path: "/Users/fixture/.n8n-openai-oauth/auth.json",
        updatedAt: "2026-09-04T01:02:03.000Z",
      };
    },
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
        authorizationUrl: "https://auth.openai.com/oauth/authorize",
        completion,
        async cancel() {
          cancelCalls += 1;
          finishLogin();
        },
      };
    },
  });

  const started = await postJson(wizard, "/api/oauth/login", {});
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

test("dashboard discard leaves a running Codex login helper attached", async (t) => {
  let finishLogin;
  let cancelCalls = 0;
  const completion = new Promise((resolve) => {
    finishLogin = resolve;
  });
  const wizard = await startLocalWizard(t, {
    async acquireLocalEndpointChangeLock() {
      return async () => {};
    },
    resolveLocalInstallRoot() {
      return "/Users/fixture/.relmio/local/codex-chatgpt";
    },
    async attestLocalCodexInstallation() {
      return {
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName: codexProjectName,
      };
    },
    async startCodexDeviceLogin() {
      return {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        completion,
        cancel() {
          cancelCalls += 1;
        },
      };
    },
    async restartLocalCodex() {},
  });

  assert.equal(
    (await postJson(wizard, "/api/local/codex/login", {
      target: "codex-chatgpt",
    })).status,
    200,
  );
  assert.equal((await postJson(wizard, "/api/local/discard", {})).status, 200);
  assert.deepEqual(
    await (await api(wizard, "/api/local/codex/login/status")).json(),
    { status: "pending" },
  );
  assert.equal(cancelCalls, 0);

  finishLogin();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = await api(wizard, "/api/local/codex/login/status");
    if ((await status.json()).status === "success") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(
    await (await api(wizard, "/api/local/codex/login/status")).json(),
    { status: "success" },
  );
  assert.equal(cancelCalls, 0);
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
    target: "openai-api",
    port: 12435,
    allowedOrigins: [],
  });
  const firstInstall = postJson(wizard, "/api/local/install", {
    planId: firstPlan.planId,
    confirmed: true,
    apiKey: platformApiKey,
  });
  await firstInstallStarted;

  const secondPlan = await createPlan(wizard, {
    target: "openai-api",
    port: 12436,
    allowedOrigins: [],
  });
  const concurrent = await postJson(wizard, "/api/local/install", {
    planId: secondPlan.planId,
    confirmed: true,
    apiKey: platformApiKey,
  });
  assert.equal(concurrent.status, 409);
  assert.match((await concurrent.json()).error, /already in progress/iu);
  assert.equal(installCalls, 1);

  const concurrentRotation = await postJson(
    wizard,
    "/api/local/client-credential/rotate",
    { target: "openai-api" },
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
    apiKey: platformApiKey,
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
        deploymentMode: "updated",
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
    allowedOrigins: [],
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
    async installLocalEndpoint({ apiKey }) {
      installCalls += 1;
      throw new Error(`Docker failed in /Users/fixture using ${apiKey}`);
    },
  });
  const planned = await createPlan(wizard, {
    target: "openai-api",
    port: 12435,
    allowedOrigins: [],
  });

  const failed = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    apiKey: platformApiKey,
  });
  assert.equal(failed.status, 400);
  assert.deepEqual(await failed.json(), {
    error: "The request could not be completed safely.",
  });

  const replay = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    apiKey: platformApiKey,
  });
  assert.equal(replay.status, 400);
  assert.equal(installCalls, 1);
});

test("Codex device-code sign-in requires installation and restarts only its local service", async (t) => {
  let finishLogin;
  let cancelCalls = 0;
  let restartInput;
  const attestationCalls = [];
  const completion = new Promise((resolve) => {
    finishLogin = resolve;
  });
  const wizard = await startLocalWizard(t, {
    async installLocalEndpoint() {
      return {
        target: "codex-chatgpt",
        endpoint: "ws://127.0.0.1:14500",
        protocol: "codex-app-server-json-rpc",
        clientCredential,
        credentialShownOnce: true,
        models: [],
        deploymentMode: "installed",
        experimental: true,
        browserClients: false,
      };
    },
    resolveLocalInstallRoot({ target }) {
      assert.equal(target, "codex-chatgpt");
      return "/Users/fixture/.relmio/local/codex-chatgpt";
    },
    async attestLocalCodexInstallation(input) {
      attestationCalls.push(input);
      if (attestationCalls.length === 1) {
        throw new Error("Install the local Codex endpoint before signing in.");
      }
      return {
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName: codexProjectName,
      };
    },
    async startCodexDeviceLogin(input) {
      assert.deepEqual(input, {
        installDirectory: "/Users/fixture/.relmio/local/codex-chatgpt",
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName: codexProjectName,
      });
      return {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        completion,
        cancel() {
          cancelCalls += 1;
        },
      };
    },
    async restartLocalCodex(input, dependencies) {
      restartInput = { input, dependencies };
    },
  });

  const beforeInstall = await postJson(
    wizard,
    "/api/local/codex/login",
    {},
  );
  assert.equal(beforeInstall.status, 400);
  assert.match((await beforeInstall.json()).error, /install/iu);
  assert.deepEqual(attestationCalls, [
    { installDirectory: "/Users/fixture/.relmio/local/codex-chatgpt" },
  ]);

  const planned = await createPlan(wizard, {
    target: "codex-chatgpt",
    port: 14500,
    allowedOrigins: ["https://ignored.example"],
  });
  assert.deepEqual(planned.plan.allowedOrigins, []);
  const install = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
  });
  assert.equal(install.status, 200);

  const started = await postJson(
    wizard,
    "/api/local/codex/login",
    {},
  );
  assert.equal(started.status, 200);
  assert.deepEqual(attestationCalls, [
    { installDirectory: "/Users/fixture/.relmio/local/codex-chatgpt" },
    { installDirectory: "/Users/fixture/.relmio/local/codex-chatgpt" },
  ]);
  assert.deepEqual(await started.json(), {
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
  });

  const pending = await api(
    wizard,
    "/api/local/codex/login/status",
  );
  const pendingText = await pending.text();
  assert.deepEqual(JSON.parse(pendingText), { status: "pending" });
  assert.equal(pendingText.includes("ABCD-EFGH"), false);
  assert.equal(pendingText.includes("/Users/"), false);

  finishLogin({ success: true });
  for (let attempt = 0; attempt < 10 && !restartInput; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(restartInput, {
    input: {
      installDirectory: "/Users/fixture/.relmio/local/codex-chatgpt",
    },
    dependencies: { changeLockHeld: true },
  });
  const completed = await api(
    wizard,
    "/api/local/codex/login/status",
  );
  assert.deepEqual(await completed.json(), { status: "success" });
  assert.equal(cancelCalls, 0);
});

test("pending Codex sign-in blocks installation and credential rotation in the same wizard", async (t) => {
  let finishLogin;
  let releases = 0;
  let installCalls = 0;
  let rotationCalls = 0;
  const completion = new Promise((resolvePromise) => {
    finishLogin = resolvePromise;
  });
  const wizard = await startLocalWizard(t, {
    async acquireLocalEndpointChangeLock() {
      return async () => {
        releases += 1;
      };
    },
    resolveLocalInstallRoot() {
      return "/Users/fixture/.relmio/local/codex-chatgpt";
    },
    async attestLocalCodexInstallation() {
      return {
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName: codexProjectName,
      };
    },
    async startCodexDeviceLogin() {
      return {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "LOCK-CODE",
        completion,
        cancel() {},
      };
    },
    async restartLocalCodex() {},
    async installLocalEndpoint() {
      installCalls += 1;
    },
    async prepareLocalClientCredentialRotation() {
      rotationCalls += 1;
    },
  });
  assert.equal(
    (await postJson(wizard, "/api/local/codex/login", {})).status,
    200,
  );
  const plan = await createPlan(wizard, {
    target: "codex-chatgpt",
    port: 14500,
    allowedOrigins: [],
  });
  const install = await postJson(wizard, "/api/local/install", {
    planId: plan.planId,
    confirmed: true,
  });
  assert.equal(install.status, 409);
  const rotation = await postJson(
    wizard,
    "/api/local/client-credential/rotate",
    { target: "codex-chatgpt" },
  );
  assert.equal(rotation.status, 409);
  assert.equal(installCalls, 0);
  assert.equal(rotationCalls, 0);

  finishLogin({ success: true });
  for (let attempt = 0; attempt < 10 && releases === 0; attempt += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.equal(releases, 1);
});

test("a fresh wizard server can sign in an attested existing Codex installation", async (t) => {
  const installDirectory = "/Users/fixture/.relmio/local/codex-chatgpt";
  const calls = [];
  const wizard = await startLocalWizard(t, {
    resolveLocalInstallRoot(input) {
      calls.push(["resolve", input]);
      return installDirectory;
    },
    async attestLocalCodexInstallation(input) {
      calls.push(["attest", input]);
      return {
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName: codexProjectName,
      };
    },
    async startCodexDeviceLogin(input) {
      calls.push(["login", input]);
      return {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "FRESH-CODE",
        completion: new Promise(() => {}),
        cancel() {},
      };
    },
  });

  const response = await postJson(wizard, "/api/local/codex/login", {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "FRESH-CODE",
  });
  assert.deepEqual(calls, [
    ["resolve", { target: "codex-chatgpt" }],
    ["attest", { installDirectory }],
    [
      "login",
      {
        installDirectory,
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName: codexProjectName,
      },
    ],
  ]);
});

test("Codex Chat sign-in attests and restarts only the adapter project", async (t) => {
  const installDirectory = "/Users/fixture/.relmio/local/codex-chat";
  const projectName = `relmio-codex-chat-${"02".repeat(16)}`;
  const calls = [];
  const wizard = await startLocalWizard(t, {
    async acquireLocalEndpointChangeLock(input) {
      calls.push(["lock", input]);
      return async () => calls.push(["unlock"]);
    },
    resolveLocalInstallRoot(input) {
      calls.push(["resolve", input]);
      return installDirectory;
    },
    async attestLocalCodexInstallation(input) {
      calls.push(["attest", input]);
      return {
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName,
      };
    },
    async startCodexDeviceLogin(input) {
      calls.push(["login", input]);
      return {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "CHAT-CODE",
        completion: Promise.resolve({ success: true }),
        cancel() {},
      };
    },
    async restartLocalCodex(input, dependencies) {
      calls.push(["restart", input, dependencies]);
    },
  });

  const response = await postJson(wizard, "/api/local/codex/login", {
    target: "codex-chat",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "CHAT-CODE",
  });
  for (
    let attempt = 0;
    attempt < 10 && !calls.some(([name]) => name === "unlock");
    attempt += 1
  ) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.deepEqual(calls, [
    ["lock", { target: "codex-chat" }],
    ["resolve", { target: "codex-chat" }],
    ["attest", { installDirectory, target: "codex-chat" }],
    [
      "login",
      {
        installDirectory,
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName,
      },
    ],
    [
      "restart",
      { installDirectory, target: "codex-chat" },
      { changeLockHeld: true },
    ],
    ["unlock"],
  ]);
  assert.deepEqual(
    await (await api(wizard, "/api/local/codex/login/status")).json(),
    { status: "success" },
  );
});

test("Codex sign-in rejects a concurrent start and releases its start lock", async (t) => {
  const installDirectory = "/Users/fixture/.relmio/local/codex-chatgpt";
  let releaseFirstAttestation;
  let notifyFirstAttestationStarted;
  let attestationCalls = 0;
  let loginCalls = 0;
  const firstAttestationStarted = new Promise((resolve) => {
    notifyFirstAttestationStarted = resolve;
  });
  const firstAttestationGate = new Promise((resolve) => {
    releaseFirstAttestation = resolve;
  });
  t.after(() => releaseFirstAttestation());

  const wizard = await startLocalWizard(t, {
    resolveLocalInstallRoot() {
      return installDirectory;
    },
    async attestLocalCodexInstallation() {
      attestationCalls += 1;
      if (attestationCalls === 1) {
        notifyFirstAttestationStarted();
        await firstAttestationGate;
        throw new Error("Deferred Codex attestation failed.");
      }
      return {
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName: codexProjectName,
      };
    },
    async startCodexDeviceLogin() {
      loginCalls += 1;
      return {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "RETRY-CODE",
        completion: new Promise(() => {}),
        cancel() {},
      };
    },
  });

  const first = postJson(wizard, "/api/local/codex/login", {});
  await firstAttestationStarted;

  const concurrent = await postJson(wizard, "/api/local/codex/login", {});
  assert.equal(concurrent.status, 409);
  assert.match((await concurrent.json()).error, /already in progress/iu);
  assert.equal(attestationCalls, 1);
  assert.equal(loginCalls, 0);

  releaseFirstAttestation();
  assert.equal((await first).status, 400);

  const retried = await postJson(wizard, "/api/local/codex/login", {});
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), {
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "RETRY-CODE",
  });
  assert.equal(attestationCalls, 2);
  assert.equal(loginCalls, 1);
});

test("wizard shutdown waits for Codex sign-in startup and releases its project lock", async (t) => {
  let releaseAcquisition;
  let notifyAcquisitionStarted;
  let lockReleases = 0;
  let loginCalls = 0;
  const acquisitionStarted = new Promise((resolvePromise) => {
    notifyAcquisitionStarted = resolvePromise;
  });
  const acquisitionGate = new Promise((resolvePromise) => {
    releaseAcquisition = resolvePromise;
  });
  const wizard = await startLocalWizard(t, {
    async acquireLocalEndpointChangeLock() {
      notifyAcquisitionStarted();
      await acquisitionGate;
      return async () => {
        lockReleases += 1;
      };
    },
    resolveLocalInstallRoot() {
      return "/Users/fixture/.relmio/local/codex-chatgpt";
    },
    async attestLocalCodexInstallation() {
      throw new Error("attestation must not run while closing");
    },
    async startCodexDeviceLogin() {
      loginCalls += 1;
    },
  });
  const login = postJson(wizard, "/api/local/codex/login", {});
  await acquisitionStarted;
  const closing = wizard.close();
  releaseAcquisition();
  await closing;
  assert.equal((await login).status, 409);
  assert.equal(lockReleases, 1);
  assert.equal(loginCalls, 0);
});

test("Codex sign-in releases its start lock and preserves pending-login replacement", async (t) => {
  const installDirectory = "/Users/fixture/.relmio/local/codex-chatgpt";
  let rejectFirstCompletion;
  let cancelCalls = 0;
  let loginCalls = 0;
  const firstCompletion = new Promise((_, reject) => {
    rejectFirstCompletion = reject;
  });
  void firstCompletion.catch(() => {});

  const wizard = await startLocalWizard(t, {
    resolveLocalInstallRoot() {
      return installDirectory;
    },
    async attestLocalCodexInstallation() {
      return {
        dockerHost: "unix:///Users/fixture/.docker/run/docker.sock",
        projectName: codexProjectName,
      };
    },
    async startCodexDeviceLogin() {
      loginCalls += 1;
      if (loginCalls === 1) {
        return {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "FIRST-CODE",
          completion: firstCompletion,
          cancel() {
            cancelCalls += 1;
            rejectFirstCompletion(new Error("The first login was replaced."));
          },
        };
      }
      return {
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "SECOND-CODE",
        completion: new Promise(() => {}),
        cancel() {},
      };
    },
  });

  const first = await postJson(wizard, "/api/local/codex/login", {});
  assert.equal(first.status, 200);

  const replacement = await postJson(wizard, "/api/local/codex/login", {});
  assert.equal(replacement.status, 200);
  assert.deepEqual(await replacement.json(), {
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "SECOND-CODE",
  });
  assert.equal(cancelCalls, 1);
  assert.equal(loginCalls, 2);
  assert.deepEqual(
    await (await api(wizard, "/api/local/codex/login/status")).json(),
    { status: "pending" },
  );
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
      async startCodexDeviceLogin() {
        calls.push("login");
      },
      async attestLocalCodexInstallation() {
        calls.push("attest");
      },
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
    target: "openai-api",
    port: 12435,
    allowedOrigins: [],
  });
  const install = await postJson(wizard, "/api/local/install", {
    planId: planned.planId,
    confirmed: true,
    apiKey: platformApiKey,
  });
  assert.equal(install.status, 403);

  const removal = await postJson(wizard, "/api/local/n8n/remove", {
    confirmed: true,
  });
  assert.equal(removal.status, 403);

  const login = await postJson(
    wizard,
    "/api/local/codex/login",
    {},
  );
  assert.equal(login.status, 403);
  const status = await api(
    wizard,
    "/api/local/codex/login/status",
  );
  assert.deepEqual(await status.json(), {
    status: "idle",
    previewMode: true,
  });
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
  const authPath = "/Users/fixture/.n8n-openai-oauth/auth.json";
  const review = createAssistantSearxngEditReview();
  const refreshInputs = [];
  const editInputs = [];
  let editReturnsUnexpectedSecret = true;
  let resolveRefresh;
  let refreshStarted;
  const refreshGate = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  const refreshStart = new Promise((resolve) => {
    refreshStarted = resolve;
  });
  t.after(() => resolveRefresh());
  const wizard = await startLocalWizard(t, {
    async getAuthStatus() {
      return {
        exists: true,
        path: authPath,
        updatedAt: "2026-08-31T01:02:03.000Z",
      };
    },
    async refreshLocalN8nSidecarCredential(input) {
      refreshInputs.push(input);
      refreshStarted();
      await refreshGate;
      return {
        target: "n8n-openai-oauth",
        credentialRefreshed: true,
        models: ["gpt-5.6-sol"],
        hostPublication: "none",
        authPath,
        authContents: "must-not-leak",
      };
    },
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

  const unconfirmedRefresh = await postJson(
    wizard,
    "/api/local/n8n/sidecar/refresh",
    {},
  );
  assert.equal(unconfirmedRefresh.status, 400);
  assert.equal(refreshInputs.length, 0);

  const refreshing = postJson(wizard, "/api/local/n8n/sidecar/refresh", {
    confirmed: true,
  });
  await refreshStart;
  const concurrentReview = await postJson(
    wizard,
    "/api/local/n8n/assistant/searxng/review",
    { includeSearxng: true },
  );
  assert.equal(concurrentReview.status, 409);
  const concurrentSignIn = await postJson(wizard, "/api/oauth/login", {});
  assert.equal(concurrentSignIn.status, 409);
  resolveRefresh();
  const refreshed = await refreshing;
  assert.equal(refreshed.status, 200);
  assert.deepEqual(refreshInputs, [{ authPath, confirmed: true }]);
  const refreshedText = await refreshed.text();
  assert.doesNotMatch(refreshedText, /Users|authContents|must-not-leak/iu);
  assert.deepEqual(JSON.parse(refreshedText), {
    target: "n8n-openai-oauth",
    credentialRefreshed: true,
    models: ["gpt-5.6-sol"],
    hostPublication: "none",
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
    async refreshLocalN8nSidecarCredential() {
      refreshCalls += 1;
      throw new Error("must not refresh while a review snapshot is in flight");
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
    "/api/local/n8n/sidecar/refresh",
    { confirmed: true },
  );
  const concurrentSignIn = await postJson(wizard, "/api/oauth/login", {});
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
      async refreshLocalN8nSidecarCredential() {
        calls.push("refresh");
      },
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
    ["/api/local/n8n/sidecar/refresh", { confirmed: true }],
    ["/api/local/n8n/assistant/searxng/review", { includeSearxng: true }],
    ["/api/local/n8n/assistant/searxng/enable", { reviewId: "x", confirmed: true }],
  ]) {
    const response = await postJson(wizard, path, body);
    assert.equal(response.status, 403);
  }
  assert.deepEqual(calls, []);
});
