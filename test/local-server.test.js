import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { startWizardServer } from "../src/web/server.js";

const sessionToken = "local-server-test-session-token-1234567890";
const platformApiKey = `sk-${"a".repeat(48)}`;
const clientCredential = "local-client-credential-shown-once";
const codexProjectName = `relmio-codex-chatgpt-${"01".repeat(16)}`;

async function startLocalWizard(t, services, { previewMode = false } = {}) {
  const wizard = await startWizardServer({
    sessionToken,
    services: {
      async acquireLocalEndpointChangeLock() {
        return async () => {};
      },
      ...services,
    },
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
