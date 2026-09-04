import assert from "node:assert/strict";
import test from "node:test";

import { ASSISTANT_COMPANION_IMAGES } from "../src/domain/assistant-templates.js";
import { startWizardServer } from "../src/web/server.js";

const sessionToken = "test-session-token-that-is-long-enough-123456";
const exampleHost = "vps.example.test";
const fixturePassword = "x".repeat(32);

function createAssistantInstallResult({
  includeSearxng = true,
  sandboxApiKey = "s".repeat(43),
  deploymentMode = "installed",
} = {}) {
  const sandboxUrl = `http://relmio-ai-sandbox-${"c".repeat(32)}:8080`;
  const searxngUrl = `http://relmio-ai-searxng-${"d".repeat(32)}:8080`;
  return {
    sandboxUrl,
    sandboxApiKey,
    includeSearxng,
    ...(includeSearxng ? { searxngUrl } : {}),
    n8nSettings: {
      N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
      N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
      N8N_INSTANCE_AI_SANDBOX_IMAGE: ASSISTANT_COMPANION_IMAGES.sandbox,
      N8N_SANDBOX_SERVICE_URL: sandboxUrl,
      ...(sandboxApiKey === null
        ? {}
        : { N8N_SANDBOX_SERVICE_API_KEY: sandboxApiKey }),
      ...(includeSearxng
        ? { N8N_INSTANCE_AI_SEARXNG_URL: searxngUrl }
        : {}),
    },
    webSearch: includeSearxng ? "enabled" : "disabled",
    modelProvider: "OpenAI",
    modelRecommendation: "preserve-current-supported-selection",
    deploymentMode,
    privateRunnerToken: "must-not-leak",
  };
}

function createServices() {
  const remote = {
    closed: false,
    close() {
      this.closed = true;
    },
  };

  return {
    remote,
    services: {
      async getAuthStatus() {
        return {
          exists: true,
          path: "/private/path/auth.json",
          updatedAt: "2026-07-28T01:11:01.000Z",
        };
      },
      async startOAuthLogin() {
        return {
          authorizationUrl:
            "https://auth.openai.com/oauth/authorize?fixture=true",
          completion: Promise.resolve({ success: true }),
          cancel() {},
        };
      },
      async readAuthContents() {
        return Buffer.from('{"fixture":true}');
      },
      async scanHostFingerprint() {
        return "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      async connectVerified() {
        return remote;
      },
      async discoverN8n() {
        return {
          dockerVersion: "28.3.2",
          composeVersion: "2.38.2",
          containers: [
            {
              id: "abc",
              image: "docker.n8n.io/n8nio/n8n",
              name: "n8n-n8n-1",
              state: "running",
            },
          ],
        };
      },
      async discoverNetworks() {
        return {
          networks: ["proxy"],
          recommended: "proxy",
          instanceAi: { status: "enabled" },
        };
      },
      async installSidecar() {
        return {
          baseUrl: "http://n8n-openai-oauth:10531/v1",
          apiKeyPlaceholder: "local-only",
          useResponsesApi: true,
          models: ["gpt-5.6-sol"],
          deploymentMode: "installed",
        };
      },
    },
  };
}

async function api(origin, path, options = {}) {
  return await fetch(`${origin}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Setup-Token": sessionToken,
      ...(options.headers ?? {}),
    },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function prepareVpsNetwork(
  origin,
  { assistantPlan = false, assistantIncludeSearxng = true, sidecarPlan = false } = {},
) {
  const originHeader = { Origin: origin };
  const fingerprintResponse = await api(origin, "/api/ssh/fingerprint", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ host: exampleHost, port: 22 }),
  });
  const { fingerprint } = await fingerprintResponse.json();
  await api(origin, "/api/ssh/connect", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      host: exampleHost,
      port: 22,
      username: "root",
      password: fixturePassword,
      expectedFingerprint: fingerprint,
    }),
  });
  await api(origin, "/api/discover", {
    method: "POST",
    headers: originHeader,
    body: "{}",
  });
  await api(origin, "/api/networks", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ containerName: "n8n-n8n-1" }),
  });
  const planBody = JSON.stringify({
    containerName: "n8n-n8n-1",
    networkName: "proxy",
    includeSearxng: assistantIncludeSearxng,
  });
  let sidecarPlanId;
  let assistantPlanId;
  if (sidecarPlan) {
    const response = await api(origin, "/api/plan", {
      method: "POST",
      headers: originHeader,
      body: planBody,
    });
    sidecarPlanId = (await response.json()).planId;
  }
  if (assistantPlan) {
    const response = await api(origin, "/api/assistant/plan", {
      method: "POST",
      headers: originHeader,
      body: planBody,
    });
    assistantPlanId = (await response.json()).planId;
  }
  return { originHeader, planBody, sidecarPlanId, assistantPlanId };
}

function createVpsInstallBody(
  setup,
  { assistant = false, includeSearxng = true, ...overrides } = {},
) {
  return JSON.stringify({
    containerName: "n8n-n8n-1",
    networkName: "proxy",
    ...(assistant ? { includeSearxng } : {}),
    confirmed: true,
    planId: assistant ? setup.assistantPlanId : setup.sidecarPlanId,
    ...overrides,
  });
}

test("wizard server binds to loopback and protects API responses", async (t) => {
  const { services } = createServices();
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: {
      "/": "<!doctype html><title>Setup</title>",
      "/app.js": "",
      "/styles.css": "",
    },
  });
  t.after(() => wizard.close());

  assert.match(wizard.origin, /^http:\/\/127\.0\.0\.1:\d+$/);

  const unauthorized = await fetch(`${wizard.origin}/api/status`);
  assert.equal(unauthorized.status, 401);

  const status = await api(wizard.origin, "/api/status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    authExists: true,
    authUpdatedAt: "2026-07-28T01:11:01.000Z",
  });
  assert.match(
    status.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  assert.equal(status.headers.get("x-content-type-options"), "nosniff");
});

test("default wizard assets include the color theme controller", async (t) => {
  const { services } = createServices();
  const wizard = await startWizardServer({
    sessionToken,
    services,
  });
  t.after(() => wizard.close());

  const response = await fetch(`${wizard.origin}/theme.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/u);
  assert.match(await response.text(), /relmio-color-mode/u);

  const oauthPopup = await fetch(`${wizard.origin}/oauth-popup.js`);
  assert.equal(oauthPopup.status, 200);
  assert.match(
    oauthPopup.headers.get("content-type") ?? "",
    /^text\/javascript/u,
  );
  assert.match(await oauthPopup.text(), /Preparing ChatGPT sign-in/u);

  const icon = await fetch(`${wizard.origin}/icons/monitor.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type") ?? "", /^image\/svg\+xml/u);
  assert.match(await icon.text(), /Lucide monitor icon/u);

  const relmioIcon = await fetch(`${wizard.origin}/relmio-icon.png`);
  assert.equal(relmioIcon.status, 200);
  assert.equal(relmioIcon.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Buffer.from(await relmioIcon.arrayBuffer()).subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );

  const roundedRelmioIcon = await fetch(`${wizard.origin}/relmio-icon-rounded.svg`);
  assert.equal(roundedRelmioIcon.status, 200);
  assert.match(
    roundedRelmioIcon.headers.get("content-type") ?? "",
    /^image\/svg\+xml/u,
  );
  assert.match(await roundedRelmioIcon.text(), /<clipPath id="rounded-square">/u);
});

test("wizard server rejects cross-origin writes", async (t) => {
  const { services } = createServices();
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const response = await api(wizard.origin, "/api/ssh/fingerprint", {
    method: "POST",
    headers: { Origin: "https://evil.example" },
    body: JSON.stringify({ host: exampleHost, port: 22 }),
  });

  assert.equal(response.status, 403);
});

test("wizard returns the exact fresh OAuth link and reports completion", async (t) => {
  const { services } = createServices();
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const loginResponse = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  assert.equal(
    login.authorizationUrl,
    "https://auth.openai.com/oauth/authorize?fixture=true",
  );
  assert.match(login.attemptId, /^[0-9a-f-]+$/u);

  await new Promise((resolve) => setImmediate(resolve));
  const statusResponse = await api(wizard.origin, "/api/oauth/status");
  const status = await statusResponse.json();
  assert.equal(status.status, "success");
  assert.match(status.attemptId, /^[0-9a-f-]+$/u);
});

test("wizard replaces OAuth attempts without waiting forever for superseded completion", async (t) => {
  const { services } = createServices();
  let starts = 0;
  let cancelled = 0;
  services.startOAuthLogin = async () => {
    starts += 1;
    return {
      authorizationUrl: `https://auth.openai.com/oauth/authorize?attempt=${starts}`,
      completion:
        starts === 1 ? new Promise(() => {}) : Promise.resolve({ success: true }),
      async cancel() {
        cancelled += 1;
      },
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const first = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  const firstBody = await first.json();
  const second = await Promise.race([
    api(wizard.origin, "/api/oauth/login", {
      method: "POST",
      headers: { Origin: wizard.origin },
      body: "{}",
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("replacement waited for old completion")), 50);
    }),
  ]);
  const secondBody = await second.json();

  assert.equal(starts, 2);
  assert.equal(cancelled, 1);
  assert.equal(typeof firstBody.attemptId, "string");
  assert.equal(typeof secondBody.attemptId, "string");
  assert.notEqual(firstBody.attemptId, secondBody.attemptId);
});

test("wizard retires a cancelled OAuth attempt when replacement startup is retry-blocked", async (t) => {
  const { services } = createServices();
  let starts = 0;
  services.startOAuthLogin = async () => {
    starts += 1;
    if (starts === 2) {
      throw Object.assign(
        new Error("The ChatGPT sign-in result could not be confirmed."),
        { retryBlocked: true },
      );
    }
    return {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
      completion: new Promise(() => {}),
      cancel() {},
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const first = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  await first.json();
  const replacement = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });

  assert.equal(replacement.status, 400);
  assert.deepEqual(await replacement.json(), {
    error: "The ChatGPT sign-in result could not be confirmed.",
    retryBlocked: true,
  });

  const status = await api(wizard.origin, "/api/oauth/status");
  assert.deepEqual(await status.json(), {
    status: "error",
    error: "The ChatGPT sign-in result could not be confirmed.",
    retryBlocked: true,
  });

  const retry = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(retry.status, 409);
  assert.equal(starts, 2);
});

test("wizard retires a cancelled OAuth attempt when replacement startup fails normally", async (t) => {
  const { services } = createServices();
  let starts = 0;
  services.startOAuthLogin = () => {
    starts += 1;
    if (starts === 2) {
      throw new Error("The ChatGPT sign-in could not be started.");
    }
    return {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
      completion: new Promise(() => {}),
      cancel() {},
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const first = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  await first.json();
  const replacement = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(replacement.status, 400);

  const status = await api(wizard.origin, "/api/oauth/status");
  assert.deepEqual(await status.json(), {
    status: "error",
    error: "The ChatGPT sign-in could not be started.",
  });
  assert.equal(starts, 2);
});

test("wizard retires a manually cancelled OAuth attempt before a failed replacement starts", async (t) => {
  const { services } = createServices();
  let starts = 0;
  services.startOAuthLogin = () => {
    starts += 1;
    if (starts === 2) {
      throw new Error("The ChatGPT sign-in could not be started.");
    }
    return {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
      completion: new Promise(() => {}),
      cancel() {},
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const first = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  const { attemptId } = await first.json();
  const cancelled = await api(wizard.origin, "/api/oauth/cancel", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: JSON.stringify({ attemptId }),
  });
  assert.equal(cancelled.status, 200);

  const replacement = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(replacement.status, 400);

  const status = await api(wizard.origin, "/api/oauth/status");
  assert.deepEqual(await status.json(), {
    status: "error",
    error: "The ChatGPT sign-in could not be started.",
  });
  assert.equal(starts, 2);
});

test("wizard blocks retry after a manually cancelled OAuth attempt's replacement fails safely", async (t) => {
  const { services } = createServices();
  let starts = 0;
  services.startOAuthLogin = () => {
    starts += 1;
    if (starts === 2) {
      throw Object.assign(
        new Error("The ChatGPT sign-in result could not be confirmed."),
        { retryBlocked: true },
      );
    }
    return {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
      completion: new Promise(() => {}),
      cancel() {},
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const first = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  const { attemptId } = await first.json();
  const cancelled = await api(wizard.origin, "/api/oauth/cancel", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: JSON.stringify({ attemptId }),
  });
  assert.equal(cancelled.status, 200);

  const replacement = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(replacement.status, 400);
  assert.deepEqual(await replacement.json(), {
    error: "The ChatGPT sign-in result could not be confirmed.",
    retryBlocked: true,
  });

  const status = await api(wizard.origin, "/api/oauth/status");
  assert.deepEqual(await status.json(), {
    status: "error",
    error: "The ChatGPT sign-in result could not be confirmed.",
    retryBlocked: true,
  });

  const retry = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(retry.status, 409);
  assert.equal(starts, 2);
});

test("wizard rejects a concurrent OAuth login while the first helper is starting", async (t) => {
  const { services } = createServices();
  let starts = 0;
  let releaseStart;
  const started = new Promise((resolvePromise) => {
    releaseStart = resolvePromise;
  });
  let markStartEntered;
  const startEntered = new Promise((resolvePromise) => {
    markStartEntered = resolvePromise;
  });
  const attempt = {
    authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
    completion: new Promise(() => {}),
    cancel() {},
  };
  services.startOAuthLogin = async () => {
    starts += 1;
    markStartEntered();
    await started;
    return attempt;
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const first = api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  await startEntered;
  try {
    const second = await Promise.race([
      api(wizard.origin, "/api/oauth/login", {
        method: "POST",
        headers: { Origin: wizard.origin },
        body: "{}",
      }),
      new Promise((resolvePromise) => {
        setTimeout(() => resolvePromise(null), 25);
      }),
    ]);

    assert.equal(second?.status, 409);
    assert.equal(starts, 1);
  } finally {
    releaseStart();
  }
  assert.equal((await first).status, 200);
});

test("wizard close waits for an OAuth helper that is still starting and cancels it", async () => {
  const { services } = createServices();
  let releaseStart;
  const started = new Promise((resolvePromise) => {
    releaseStart = resolvePromise;
  });
  let markStartEntered;
  const startEntered = new Promise((resolvePromise) => {
    markStartEntered = resolvePromise;
  });
  let cancelled = 0;
  services.startOAuthLogin = async () => {
    markStartEntered();
    await started;
    return {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
      completion: new Promise(() => {}),
      cancel() {
        cancelled += 1;
      },
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });

  const loginRequest = api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  await startEntered;

  let closed = false;
  const close = wizard.close().then(() => {
    closed = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(closed, false);

  releaseStart();
  assert.equal((await loginRequest).status, 409);
  await close;
  assert.equal(cancelled, 1);
});

test("wizard cancels only the current OAuth attempt through its protected same-origin action", async (t) => {
  const { services } = createServices();
  let cancelled = 0;
  services.startOAuthLogin = async () => ({
    authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
    completion: new Promise(() => {}),
    async cancel() {
      cancelled += 1;
    },
  });
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const login = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  const { attemptId } = await login.json();
  const cancelledResponse = await api(wizard.origin, "/api/oauth/cancel", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: JSON.stringify({ attemptId }),
  });

  assert.equal(cancelledResponse.status, 200);
  assert.deepEqual(await cancelledResponse.json(), {
    status: "cancelled",
    attemptId,
  });
  assert.equal(cancelled, 1);

  const staleResponse = await api(wizard.origin, "/api/oauth/cancel", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: JSON.stringify({ attemptId: "not-the-current-attempt" }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal(cancelled, 1);
});

test("wizard blocks another OAuth start when cancellation cannot confirm termination", async (t) => {
  const { services } = createServices();
  let starts = 0;
  services.startOAuthLogin = async () => {
    starts += 1;
    return {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
      completion: new Promise(() => {}),
      async cancel() {
        throw new Error("unconfirmed helper termination");
      },
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const login = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  const { attemptId } = await login.json();
  const cancelled = await api(wizard.origin, "/api/oauth/cancel", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: JSON.stringify({ attemptId }),
  });

  assert.equal(cancelled.status, 409);
  assert.deepEqual(await cancelled.json(), {
    error:
      "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
    retryBlocked: true,
  });

  const status = await api(wizard.origin, "/api/oauth/status");
  assert.deepEqual(await status.json(), {
    status: "error",
    attemptId,
    error:
      "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
    retryBlocked: true,
  });

  const retry = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(retry.status, 409);
  assert.deepEqual(await retry.json(), {
    error:
      "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
    retryBlocked: true,
  });
  assert.equal(starts, 1);
});

test("wizard blocks another OAuth start after an unconfirmed startup cleanup", async (t) => {
  const { services } = createServices();
  let starts = 0;
  services.startOAuthLogin = async () => {
    starts += 1;
    throw Object.assign(
      new Error(
        "OpenAI OAuth login needs http://localhost:1455/auth/callback, but port 1455 is already in use. Stop the process using that port and try again.",
      ),
      { retryBlocked: true },
    );
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const first = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(first.status, 400);
  assert.deepEqual(await first.json(), {
    error:
      "OpenAI OAuth login needs http://localhost:1455/auth/callback, but port 1455 is already in use. Stop the process using that port and try again.",
    retryBlocked: true,
  });

  const status = await api(wizard.origin, "/api/oauth/status");
  assert.deepEqual(await status.json(), {
    status: "error",
    error:
      "OpenAI OAuth login needs http://localhost:1455/auth/callback, but port 1455 is already in use. Stop the process using that port and try again.",
    retryBlocked: true,
  });

  const retry = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(retry.status, 409);
  assert.deepEqual(await retry.json(), {
    error:
      "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
    retryBlocked: true,
  });
  assert.equal(starts, 1);
});

test("wizard close is bounded when OAuth startup never settles and cancels a late helper", async () => {
  const { services } = createServices();
  let releaseStart;
  const startup = new Promise((resolvePromise) => {
    releaseStart = resolvePromise;
  });
  let markStartEntered;
  const startEntered = new Promise((resolvePromise) => {
    markStartEntered = resolvePromise;
  });
  let cancelled = 0;
  services.startOAuthLogin = async () => {
    markStartEntered();
    return await startup;
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    oauthShutdownWaitMs: 0,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });

  const loginRequest = api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  await startEntered;

  const lateAttempt = {
    authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
    completion: new Promise(() => {}),
    cancel() {
      cancelled += 1;
    },
  };
  const close = wizard.close();
  try {
    await Promise.race([
      close,
      new Promise((_, rejectPromise) => {
        setTimeout(
          () => rejectPromise(new Error("wizard close waited for OAuth startup")),
          50,
        );
      }),
    ]);
  } finally {
    releaseStart(lateAttempt);
    await close;
  }
  const loginResponse = await loginRequest;
  assert.equal(loginResponse.status, 409);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(cancelled, 1);
});

test("wizard persists a retry-blocked completion failure and refuses another helper", async (t) => {
  const { services } = createServices();
  let starts = 0;
  let rejectCompletion;
  const completion = new Promise((_, rejectPromise) => {
    rejectCompletion = rejectPromise;
  });
  services.startOAuthLogin = async () => {
    starts += 1;
    return {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
      completion,
      cancel() {},
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const setup = await prepareVpsNetwork(wizard.origin);

  const loginResponse = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  const { attemptId } = await loginResponse.json();
  rejectCompletion(
    Object.assign(
      new Error("The ChatGPT sign-in result could not be confirmed."),
      { retryBlocked: true },
    ),
  );
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const status = await api(wizard.origin, "/api/oauth/status");
  assert.deepEqual(await status.json(), {
    status: "error",
    attemptId,
    error: "The ChatGPT sign-in result could not be confirmed.",
    retryBlocked: true,
  });

  const retry = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(retry.status, 409);
  assert.deepEqual(await retry.json(), {
    error:
      "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
    retryBlocked: true,
  });
  assert.equal(starts, 1);

  const blockedPlan = await api(wizard.origin, "/api/plan", {
    method: "POST",
    headers: setup.originHeader,
    body: setup.planBody,
  });
  assert.equal(blockedPlan.status, 409);
  assert.deepEqual(await blockedPlan.json(), {
    error:
      "ChatGPT sign-in could not be confirmed safely. Restart Relmio before changing the VPS.",
    retryBlocked: true,
  });
});

test("wizard close waits for cancellation of a pending OAuth attempt", async () => {
  const { services } = createServices();
  let releaseCancel;
  const cancellation = new Promise((resolve) => {
    releaseCancel = resolve;
  });
  services.startOAuthLogin = async () => ({
    authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
    completion: new Promise(() => {}),
    cancel() {
      return cancellation;
    },
  });
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });

  let closed = false;
  const close = wizard.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  releaseCancel();
  await close;
  assert.equal(closed, true);
});

test("OAuth completion queued before shutdown cannot commit server state after closing starts", async () => {
  const { services } = createServices();
  const completion = deferred();
  let cancelCalls = 0;
  services.startOAuthLogin = async () => ({
    authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
    completion: completion.promise,
    async cancel() {
      cancelCalls += 1;
    },
  });
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });

  completion.resolve({ success: true });
  await wizard.close();
  assert.equal(cancelCalls, 1);
});

test("preview mode identifies itself and refuses to start live OAuth", async (t) => {
  const { services } = createServices();
  let loginStarted = false;
  services.startOAuthLogin = async () => {
    loginStarted = true;
    throw new Error("The live OAuth service must not run in preview mode.");
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    previewMode: true,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const statusResponse = await api(wizard.origin, "/api/status");
  assert.deepEqual(await statusResponse.json(), {
    authExists: true,
    authUpdatedAt: "2026-07-28T01:11:01.000Z",
    previewMode: true,
  });

  const loginResponse = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(loginResponse.status, 403);
  assert.deepEqual(await loginResponse.json(), {
    error: "Live ChatGPT sign-in is disabled in sanitized preview mode.",
  });
  assert.equal(loginStarted, false);

  const cancelResponse = await api(wizard.origin, "/api/oauth/cancel", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: JSON.stringify({ attemptId: "preview-attempt" }),
  });
  assert.equal(cancelResponse.status, 403);
  assert.equal(loginStarted, false);
});

test("wizard flow validates discovered selections and never echoes a password", async (t) => {
  const { services, remote } = createServices();
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const originHeader = { Origin: wizard.origin };
  const fingerprintResponse = await api(
    wizard.origin,
    "/api/ssh/fingerprint",
    {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({ host: exampleHost, port: 22 }),
    },
  );
  const { fingerprint } = await fingerprintResponse.json();

  const connectResponse = await api(wizard.origin, "/api/ssh/connect", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      host: exampleHost,
      port: 22,
      username: "root",
      password: fixturePassword,
      expectedFingerprint: fingerprint,
    }),
  });
  assert.equal(connectResponse.status, 200);
  assert.equal((await connectResponse.text()).includes(fixturePassword), false);

  const discovered = await api(wizard.origin, "/api/discover", {
    method: "POST",
    headers: originHeader,
    body: "{}",
  });
  assert.equal(discovered.status, 200);

  const networks = await api(wizard.origin, "/api/networks", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ containerName: "n8n-n8n-1" }),
  });
  assert.deepEqual((await networks.json()).networks, ["proxy"]);

  const plan = await api(wizard.origin, "/api/plan", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      containerName: "n8n-n8n-1",
      networkName: "proxy",
    }),
  });
  const reviewedPlan = await plan.json();
  assert.equal(reviewedPlan.endpointHostname, "n8n-openai-oauth");

  const install = await api(wizard.origin, "/api/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      containerName: "n8n-n8n-1",
      networkName: "proxy",
      confirmed: true,
      planId: reviewedPlan.planId,
    }),
  });
  assert.equal(install.status, 200);
  assert.equal(
    (await install.json()).baseUrl,
    "http://n8n-openai-oauth:10531/v1",
  );
  assert.equal(remote.closed, true);
});

test("VPS install plans are single-use and one shared lock excludes assistant and sidecar mutations", async (t) => {
  const cases = [
    { first: "assistant", second: "assistant" },
    { first: "assistant", second: "sidecar" },
    { first: "sidecar", second: "assistant" },
  ];
  for (const scenario of cases) {
    await t.test(`${scenario.first} excludes concurrent ${scenario.second}`, async (subtest) => {
      const { services, remote } = createServices();
      const firstInstall = deferred();
      const firstStarted = deferred();
      let assistantCalls = 0;
      let sidecarCalls = 0;
      const sidecarResult = {
        baseUrl: "http://n8n-openai-oauth:10531/v1",
        apiKeyPlaceholder: "local-only",
        useResponsesApi: true,
        models: ["gpt-5.6-sol"],
        deploymentMode: "installed",
      };
      const assistantResult = createAssistantInstallResult();
      services.installAssistant = async () => {
        assistantCalls += 1;
        if (scenario.first === "assistant" && assistantCalls === 1) {
          firstStarted.resolve();
          return await firstInstall.promise;
        }
        return assistantResult;
      };
      services.installSidecar = async () => {
        sidecarCalls += 1;
        if (scenario.first === "sidecar" && sidecarCalls === 1) {
          firstStarted.resolve();
          return await firstInstall.promise;
        }
        return sidecarResult;
      };
      const wizard = await startWizardServer({
        sessionToken,
        services,
        uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
      });
      subtest.after(() => wizard.close());
      const setup = await prepareVpsNetwork(wizard.origin, {
        assistantPlan: true,
        sidecarPlan: true,
      });
      const firstPath = scenario.first === "assistant" ? "/api/assistant/install" : "/api/install";
      const secondPath = scenario.second === "assistant" ? "/api/assistant/install" : "/api/install";
      const firstRequest = api(wizard.origin, firstPath, {
        method: "POST",
        headers: setup.originHeader,
        body: createVpsInstallBody(setup, {
          assistant: scenario.first === "assistant",
        }),
      });
      try {
        await firstStarted.promise;
        const concurrent = await api(wizard.origin, secondPath, {
          method: "POST",
          headers: setup.originHeader,
          body: createVpsInstallBody(setup, {
            assistant: scenario.second === "assistant",
          }),
        });
        assert.equal(concurrent.status, 409);
        assert.equal(remote.closed, false);
        firstInstall.resolve(scenario.first === "assistant" ? assistantResult : sidecarResult);
        assert.equal((await firstRequest).status, 200);
        assert.equal(remote.closed, true);
        assert.equal(
          scenario.second === "assistant" ? assistantCalls : sidecarCalls,
          scenario.first === scenario.second ? 1 : 0,
        );
        assert.ok(setup.planBody.length > 0);
      } finally {
        firstInstall.resolve(scenario.first === "assistant" ? assistantResult : sidecarResult);
        await firstRequest;
      }
    });
  }
});

test("opaque VPS plan ids isolate identical tabs and preserve only the current reviewed plan", async (t) => {
  for (const assistant of [false, true]) {
    await t.test(assistant ? "assistant" : "sidecar", async (subtest) => {
      const { services } = createServices();
      let installs = 0;
      services.installAssistant = async () => {
        installs += 1;
        return createAssistantInstallResult();
      };
      services.installSidecar = async () => {
        installs += 1;
        return {
          baseUrl: "http://n8n-openai-oauth:10531/v1",
          apiKeyPlaceholder: "local-only",
          useResponsesApi: true,
          models: ["gpt-5.6-sol"],
          deploymentMode: "installed",
        };
      };
      const wizard = await startWizardServer({
        sessionToken,
        services,
        uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
      });
      subtest.after(() => wizard.close());
      const setup = await prepareVpsNetwork(wizard.origin);
      const planPath = assistant ? "/api/assistant/plan" : "/api/plan";
      const firstPlanResponse = await api(wizard.origin, planPath, {
        method: "POST",
        headers: setup.originHeader,
        body: setup.planBody,
      });
      const firstPlan = await firstPlanResponse.json();
      const currentPlanResponse = await api(wizard.origin, planPath, {
        method: "POST",
        headers: setup.originHeader,
        body: setup.planBody,
      });
      const currentPlan = await currentPlanResponse.json();
      assert.match(firstPlan.planId, /^[0-9a-f-]+$/u);
      assert.match(currentPlan.planId, /^[0-9a-f-]+$/u);
      assert.notEqual(firstPlan.planId, currentPlan.planId);
      assert.doesNotMatch(
        JSON.stringify(currentPlan),
        /private|auth\.json|2026-07-28T01:11/iu,
      );

      const staleSetup = {
        ...setup,
        ...(assistant
          ? { assistantPlanId: firstPlan.planId }
          : { sidecarPlanId: firstPlan.planId }),
      };
      const stale = await api(
        wizard.origin,
        assistant ? "/api/assistant/install" : "/api/install",
        {
          method: "POST",
          headers: setup.originHeader,
          body: createVpsInstallBody(staleSetup, { assistant }),
        },
      );
      assert.equal(stale.status, 400);
      assert.match((await stale.json()).error, /fresh.*plan/i);
      assert.equal(installs, 0);

      const currentSetup = {
        ...setup,
        ...(assistant
          ? { assistantPlanId: currentPlan.planId }
          : { sidecarPlanId: currentPlan.planId }),
      };
      const installed = await api(
        wizard.origin,
        assistant ? "/api/assistant/install" : "/api/install",
        {
          method: "POST",
          headers: setup.originHeader,
          body: createVpsInstallBody(currentSetup, { assistant }),
        },
      );
      assert.equal(installed.status, 200);
      assert.equal(installs, 1);

      const consumed = await api(
        wizard.origin,
        assistant ? "/api/assistant/install" : "/api/install",
        {
          method: "POST",
          headers: setup.originHeader,
          body: createVpsInstallBody(currentSetup, { assistant }),
        },
      );
      assert.equal(consumed.status, 400);
      assert.match((await consumed.json()).error, /fresh.*plan/i);
      assert.equal(installs, 1);
    });
  }
});

test("pending and committing OAuth work excludes multi-tab VPS plans and mutations", async (t) => {
  const { services } = createServices();
  const oauthCompletion = deferred();
  let authUpdatedAt = "2026-07-28T01:11:01.000Z";
  let assistantCalls = 0;
  let sidecarCalls = 0;
  services.getAuthStatus = async () => ({
    exists: true,
    path: "/private/path/auth.json",
    updatedAt: authUpdatedAt,
  });
  services.startOAuthLogin = async () => ({
    authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
    completion: oauthCompletion.promise,
    async cancel() {},
  });
  services.installAssistant = async () => {
    assistantCalls += 1;
    return createAssistantInstallResult();
  };
  services.installSidecar = async () => {
    sidecarCalls += 1;
    return {
      baseUrl: "http://n8n-openai-oauth:10531/v1",
      apiKeyPlaceholder: "local-only",
      useResponsesApi: true,
      models: ["gpt-5.6-sol"],
      deploymentMode: "installed",
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const setup = await prepareVpsNetwork(wizard.origin, {
    assistantPlan: true,
    sidecarPlan: true,
  });

  const login = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  assert.equal(login.status, 200);

  // Model the credential as already promoted while the OAuth completion still
  // owns its commit-settlement window.
  authUpdatedAt = "2026-07-28T01:11:02.000Z";
  const conflicts = await Promise.all([
    api(wizard.origin, "/api/plan", {
      method: "POST",
      headers: setup.originHeader,
      body: setup.planBody,
    }),
    api(wizard.origin, "/api/assistant/plan", {
      method: "POST",
      headers: setup.originHeader,
      body: setup.planBody,
    }),
    api(wizard.origin, "/api/install", {
      method: "POST",
      headers: setup.originHeader,
      body: createVpsInstallBody(setup),
    }),
    api(wizard.origin, "/api/assistant/install", {
      method: "POST",
      headers: setup.originHeader,
      body: createVpsInstallBody(setup, { assistant: true }),
    }),
  ]);

  for (const conflict of conflicts) {
    assert.equal(conflict.status, 409);
    const payload = await conflict.json();
    assert.match(payload.error, /ChatGPT sign-in.*progress/i);
    assert.doesNotMatch(
      JSON.stringify(payload),
      /private|auth\.json|refresh[_-]?token|2026-07-28T01:11/iu,
    );
  }
  assert.equal(assistantCalls, 0);
  assert.equal(sidecarCalls, 0);

  oauthCompletion.resolve({ success: true });
  await new Promise((resolve) => setImmediate(resolve));
});

test("an active VPS mutation excludes OAuth start and releases ownership after failure", async (t) => {
  const { services } = createServices();
  const installStarted = deferred();
  let rejectInstall;
  const installCompletion = new Promise((_, reject) => {
    rejectInstall = reject;
  });
  let oauthStarts = 0;
  services.installSidecar = async () => {
    installStarted.resolve();
    return await installCompletion;
  };
  services.startOAuthLogin = async () => {
    oauthStarts += 1;
    return {
      authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
      completion: Promise.resolve({ success: true }),
      async cancel() {},
    };
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const setup = await prepareVpsNetwork(wizard.origin, { sidecarPlan: true });
  const installRequest = api(wizard.origin, "/api/install", {
    method: "POST",
    headers: setup.originHeader,
    body: JSON.stringify({
      containerName: "n8n-n8n-1",
      networkName: "proxy",
      confirmed: true,
      planId: setup.sidecarPlanId,
    }),
  });

  await installStarted.promise;
  const conflict = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  assert.equal(conflict.status, 409);
  const conflictPayload = await conflict.json();
  assert.match(conflictPayload.error, /VPS.*progress/i);
  assert.doesNotMatch(JSON.stringify(conflictPayload), /private|auth\.json|token/iu);
  assert.equal(oauthStarts, 0);

  rejectInstall(
    new Error(
      "fixture install failed with refresh_token=must-not-leak at /private/path/auth.json",
    ),
  );
  const failedInstall = await installRequest;
  assert.equal(failedInstall.status, 400);
  assert.doesNotMatch(
    JSON.stringify(await failedInstall.json()),
    /must-not-leak|private|auth\.json/iu,
  );

  const login = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  assert.equal(login.status, 200);
  assert.equal(oauthStarts, 1);
});

test("wizard shutdown waits for an active VPS mutation and its HTTP request to settle", async () => {
  const { services } = createServices();
  const installStarted = deferred();
  const installReady = deferred();
  const statusStarted = deferred();
  const statusReady = deferred();
  services.installSidecar = async () => {
    installStarted.resolve();
    return await installReady.promise;
  };
  services.getLocalDockerStatus = async () => {
    statusStarted.resolve();
    return await statusReady.promise;
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    oauthShutdownWaitMs: 1,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  let installRequest;
  let statusRequest;
  let closing;
  try {
    const setup = await prepareVpsNetwork(wizard.origin, { sidecarPlan: true });
    installRequest = api(wizard.origin, "/api/install", {
      method: "POST",
      headers: setup.originHeader,
      body: createVpsInstallBody(setup),
    });
    await installStarted.promise;

    statusRequest = api(wizard.origin, "/api/local/docker/status");
    await statusStarted.promise;

    let closeSettled = false;
    closing = wizard.close().then(() => {
      closeSettled = true;
    });
    // Let the mutation finish during close's first await. A late snapshot
    // would now miss it and take the unsafe bounded HTTP-close branch.
    installReady.resolve({
      baseUrl: "http://n8n-openai-oauth:10531/v1",
      apiKeyPlaceholder: "local-only",
      useResponsesApi: true,
      models: ["gpt-5.6-sol"],
      deploymentMode: "installed",
    });
    assert.equal((await installRequest).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(closeSettled, false);

    statusReady.resolve({ dockerAvailable: false });
    assert.equal((await statusRequest).status, 200);
    await closing;
    assert.equal(closeSettled, true);
  } finally {
    installReady.resolve({
      baseUrl: "http://n8n-openai-oauth:10531/v1",
      apiKeyPlaceholder: "local-only",
      useResponsesApi: true,
      models: ["gpt-5.6-sol"],
      deploymentMode: "installed",
    });
    statusReady.resolve({ dockerAvailable: false });
    await installRequest?.catch(() => {});
    await statusRequest?.catch(() => {});
    if (closing) await closing;
    else await wizard.close();
  }
});

test("OAuth refresh invalidates a previously reviewed VPS credential plan", async (t) => {
  const { services } = createServices();
  const oauthCompletion = deferred();
  let authUpdatedAt = "2026-07-28T01:11:01.000Z";
  let credentialReads = 0;
  let installs = 0;
  services.getAuthStatus = async () => ({
    exists: true,
    path: "/private/path/auth.json",
    updatedAt: authUpdatedAt,
  });
  services.startOAuthLogin = async () => ({
    authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
    completion: oauthCompletion.promise,
    async cancel() {},
  });
  services.readAuthContents = async () => {
    credentialReads += 1;
    return Buffer.from('{"fixture":true}');
  };
  services.installSidecar = async () => {
    installs += 1;
    throw new Error("A stale credential plan must not reach installation.");
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const setup = await prepareVpsNetwork(wizard.origin, { sidecarPlan: true });

  await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  authUpdatedAt = "2026-07-28T01:11:02.000Z";
  oauthCompletion.resolve({ success: true });
  await new Promise((resolve) => setImmediate(resolve));

  const stale = await api(wizard.origin, "/api/install", {
    method: "POST",
    headers: setup.originHeader,
    body: JSON.stringify({
      containerName: "n8n-n8n-1",
      networkName: "proxy",
      confirmed: true,
      planId: setup.sidecarPlanId,
    }),
  });
  assert.equal(stale.status, 400);
  const payload = await stale.json();
  assert.match(payload.error, /fresh.*sidecar plan/i);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|auth\.json|2026-07-28T01:11/iu,
  );
  assert.equal(credentialReads, 0);
  assert.equal(installs, 0);
});

test("VPS install consumes its plan when the credential generation changes during the final read", async (t) => {
  const { services } = createServices();
  const readStarted = deferred();
  const finishRead = deferred();
  let authUpdatedAt = "2026-07-28T01:11:01.000Z";
  let credentialReads = 0;
  let installs = 0;
  services.getAuthStatus = async () => ({
    exists: true,
    path: "/private/path/auth.json",
    updatedAt: authUpdatedAt,
  });
  services.readAuthContents = async () => {
    credentialReads += 1;
    readStarted.resolve();
    await finishRead.promise;
    return Buffer.from('{"fixture":true}');
  };
  services.installSidecar = async () => {
    installs += 1;
    throw new Error("A changed credential must not reach remote mutation.");
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const setup = await prepareVpsNetwork(wizard.origin, { sidecarPlan: true });
  const installRequest = api(wizard.origin, "/api/install", {
    method: "POST",
    headers: setup.originHeader,
    body: JSON.stringify({
      containerName: "n8n-n8n-1",
      networkName: "proxy",
      confirmed: true,
      planId: setup.sidecarPlanId,
    }),
  });

  await readStarted.promise;
  authUpdatedAt = "2026-07-28T01:11:02.000Z";
  finishRead.resolve();
  const changed = await installRequest;
  assert.equal(changed.status, 400);
  const payload = await changed.json();
  assert.match(payload.error, /sign-in changed.*fresh.*plan/i);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /private|auth\.json|2026-07-28T01:11/iu,
  );
  assert.equal(credentialReads, 1);
  assert.equal(installs, 0);

  const consumed = await api(wizard.origin, "/api/install", {
    method: "POST",
    headers: setup.originHeader,
    body: JSON.stringify({
      containerName: "n8n-n8n-1",
      networkName: "proxy",
      confirmed: true,
      planId: setup.sidecarPlanId,
    }),
  });
  assert.equal(consumed.status, 400);
  assert.match((await consumed.json()).error, /fresh.*sidecar plan/i);
});

test("safe OAuth cancellation releases the VPS credential gate", async (t) => {
  const { services } = createServices();
  let cancellations = 0;
  services.startOAuthLogin = async () => ({
    authorizationUrl: "https://auth.openai.com/oauth/authorize?fixture=true",
    completion: new Promise(() => {}),
    async cancel() {
      cancellations += 1;
    },
  });
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const setup = await prepareVpsNetwork(wizard.origin);
  const login = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  const { attemptId } = await login.json();

  const blockedPlan = await api(wizard.origin, "/api/plan", {
    method: "POST",
    headers: setup.originHeader,
    body: setup.planBody,
  });
  assert.equal(blockedPlan.status, 409);

  const cancelled = await api(wizard.origin, "/api/oauth/cancel", {
    method: "POST",
    headers: setup.originHeader,
    body: JSON.stringify({ attemptId }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancellations, 1);

  const plan = await api(wizard.origin, "/api/plan", {
    method: "POST",
    headers: setup.originHeader,
    body: setup.planBody,
  });
  assert.equal(plan.status, 200);
});

test("VPS install failures consume the plan, release the shared lock, and preserve cleanup uncertainty safely", async (t) => {
  const { services } = createServices();
  let installAttempts = 0;
  services.installAssistant = async () => {
    installAttempts += 1;
    if (installAttempts === 1) {
      throw Object.assign(
        new Error("Automatic cleanup could not be confirmed at /docker/n8n-openai-oauth/assistant-sandbox with secret token"),
        {
          safeMessage: "Automatic cleanup could not be confirmed. Do not use the AI Assistant companion until an administrator confirms its removal.",
        },
      );
    }
    return createAssistantInstallResult();
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  let setup = await prepareVpsNetwork(wizard.origin, { assistantPlan: true });
  const failed = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: setup.originHeader,
    body: createVpsInstallBody(setup, { assistant: true }),
  });
  assert.equal(failed.status, 400);
  const failure = await failed.json();
  assert.match(failure.error, /cleanup.*not.*confirmed.*do not use/i);
  assert.doesNotMatch(JSON.stringify(failure), /\/docker|secret|credential|token/i);

  setup = await prepareVpsNetwork(wizard.origin);
  const stalePlan = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: setup.originHeader,
    body: createVpsInstallBody(setup, { assistant: true }),
  });
  assert.equal(stalePlan.status, 400);
  assert.match((await stalePlan.json()).error, /fresh.*plan/i);

  const retriedPlan = await api(wizard.origin, "/api/assistant/plan", {
    method: "POST",
    headers: setup.originHeader,
    body: setup.planBody,
  });
  setup.assistantPlanId = (await retriedPlan.json()).planId;
  const retried = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: setup.originHeader,
    body: createVpsInstallBody(setup, { assistant: true }),
  });
  assert.equal(retried.status, 200);
  assert.equal(installAttempts, 2);
});

test("a throwing SSH close cannot mask an install failure or preserve either reviewed plan", async (t) => {
  const { remote, services } = createServices();
  let closeCalls = 0;
  let installCalls = 0;
  remote.close = () => {
    closeCalls += 1;
    throw new Error("close failed with refresh_token=must-not-leak");
  };
  services.installSidecar = async () => {
    installCalls += 1;
    throw Object.assign(
      new Error("remote install failed at /private/path with token"),
      { safeMessage: "The sidecar installation could not be completed safely." },
    );
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const reviewed = await prepareVpsNetwork(wizard.origin, {
    assistantPlan: true,
    sidecarPlan: true,
  });

  const failed = await api(wizard.origin, "/api/install", {
    method: "POST",
    headers: reviewed.originHeader,
    body: createVpsInstallBody(reviewed),
  });
  assert.equal(failed.status, 400);
  const failure = await failed.json();
  assert.equal(
    failure.error,
    "The sidecar installation could not be completed safely.",
  );
  assert.doesNotMatch(
    JSON.stringify(failure),
    /must-not-leak|refresh_token|private|token/iu,
  );
  assert.equal(installCalls, 1);
  assert.equal(closeCalls, 1);

  const reconnected = await prepareVpsNetwork(wizard.origin);
  for (const assistant of [false, true]) {
    const staleSetup = {
      ...reconnected,
      assistantPlanId: reviewed.assistantPlanId,
      sidecarPlanId: reviewed.sidecarPlanId,
    };
    const stale = await api(
      wizard.origin,
      assistant ? "/api/assistant/install" : "/api/install",
      {
        method: "POST",
        headers: reconnected.originHeader,
        body: createVpsInstallBody(staleSetup, { assistant }),
      },
    );
    assert.equal(stale.status, 400);
    assert.match((await stale.json()).error, /fresh.*plan/i);
  }
});

test("assistant web-search selection is an explicit boolean bound to its reviewed plan", async (t) => {
  const { services } = createServices();
  const installs = [];
  services.installAssistant = async (input) => {
    installs.push(input);
    return createAssistantInstallResult({ includeSearxng: false });
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const { originHeader } = await prepareVpsNetwork(wizard.origin);
  const base = { containerName: "n8n-n8n-1", networkName: "proxy" };
  for (const includeSearxng of [undefined, "false", 0, null]) {
    const response = await api(wizard.origin, "/api/assistant/plan", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({ ...base, ...(includeSearxng === undefined ? {} : { includeSearxng }) }),
    });
    assert.equal(response.status, 400);
  }
  const reviewed = await api(wizard.origin, "/api/assistant/plan", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ ...base, includeSearxng: false }),
  });
  assert.equal(reviewed.status, 200);
  const reviewedPayload = await reviewed.json();
  assert.equal(reviewedPayload.includeSearxng, false);
  for (const includeSearxng of [undefined, "false", 0, null]) {
    const response = await api(wizard.origin, "/api/assistant/install", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({
        ...base,
        ...(includeSearxng === undefined ? {} : { includeSearxng }),
        confirmed: true,
        planId: reviewedPayload.planId,
      }),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(installs.length, 0);
  const mismatched = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      ...base,
      includeSearxng: true,
      confirmed: true,
      planId: reviewedPayload.planId,
    }),
  });
  assert.equal(mismatched.status, 400);
  assert.equal(installs.length, 0);

  const refreshed = await api(wizard.origin, "/api/assistant/plan", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ ...base, includeSearxng: false }),
  });
  assert.equal(refreshed.status, 200);
  const refreshedPayload = await refreshed.json();
  const installed = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      ...base,
      includeSearxng: false,
      confirmed: true,
      planId: refreshedPayload.planId,
    }),
  });
  assert.equal(installed.status, 200);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].includeSearxng, false);
});

test("assistant install responses expose only exact companion settings", async (t) => {
  const cases = [
    {
      name: "valid install strips internal fields",
      build() {
        return createAssistantInstallResult();
      },
      expectedStatus: 200,
    },
    {
      name: "managed update omits an intentionally unavailable key",
      build() {
        return createAssistantInstallResult({
          sandboxApiKey: null,
          deploymentMode: "updated",
        });
      },
      expectedStatus: 200,
    },
    {
      name: "missing settings object",
      build() {
        const result = createAssistantInstallResult();
        delete result.n8nSettings;
        return result;
      },
      expectedStatus: 502,
    },
    {
      name: "malicious extra prerequisite setting",
      build() {
        const result = createAssistantInstallResult();
        result.n8nSettings.N8N_ENABLED_MODULES = "instance-ai";
        return result;
      },
      expectedStatus: 502,
    },
    {
      name: "mismatched sandbox URL",
      build() {
        const result = createAssistantInstallResult();
        result.n8nSettings.N8N_SANDBOX_SERVICE_URL =
          `http://relmio-ai-sandbox-${"e".repeat(32)}:8080`;
        return result;
      },
      expectedStatus: 502,
    },
    {
      name: "mismatched sandbox API key",
      build() {
        const result = createAssistantInstallResult();
        result.n8nSettings.N8N_SANDBOX_SERVICE_API_KEY = "x".repeat(43);
        return result;
      },
      expectedStatus: 502,
    },
    {
      name: "mismatched sandbox image",
      build() {
        const result = createAssistantInstallResult();
        result.n8nSettings.N8N_INSTANCE_AI_SANDBOX_IMAGE = "malicious:latest";
        return result;
      },
      expectedStatus: 502,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const { services } = createServices();
      services.installAssistant = async () => scenario.build();
      const wizard = await startWizardServer({
        sessionToken,
        services,
        uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
      });
      subtest.after(() => wizard.close());
      const setup = await prepareVpsNetwork(wizard.origin, {
        assistantPlan: true,
      });
      const response = await api(wizard.origin, "/api/assistant/install", {
        method: "POST",
        headers: setup.originHeader,
        body: createVpsInstallBody(setup, { assistant: true }),
      });
      assert.equal(response.status, scenario.expectedStatus);
      const responseText = await response.text();
      assert.doesNotMatch(responseText, /must-not-leak|privateRunnerToken/u);
      if (scenario.expectedStatus !== 200) return;

      const result = JSON.parse(responseText);
      assert.deepEqual(Object.keys(result).sort(), [
        "deploymentMode",
        "includeSearxng",
        "n8nSettings",
        "sandboxApiKey",
        "sandboxUrl",
        "searxngUrl",
      ]);
      assert.equal("N8N_ENABLED_MODULES" in result.n8nSettings, false);
      assert.equal(
        "N8N_SANDBOX_SERVICE_API_KEY" in result.n8nSettings,
        result.sandboxApiKey !== null,
      );
      assert.equal(
        result.n8nSettings.N8N_SANDBOX_SERVICE_URL,
        result.sandboxUrl,
      );
      assert.equal(
        result.n8nSettings.N8N_INSTANCE_AI_SEARXNG_URL,
        result.searxngUrl,
      );
      assert.equal(
        result.n8nSettings.N8N_INSTANCE_AI_SANDBOX_IMAGE,
        ASSISTANT_COMPANION_IMAGES.sandbox,
      );
    });
  }
});

test("assistant plan requires a fresh enabled instance-ai prerequisite", async (t) => {
  const { services } = createServices();
  let prerequisiteStatus = "enabled";
  services.discoverNetworks = async () => ({
    networks: ["proxy"],
    recommended: "proxy",
    instanceAi: { status: prerequisiteStatus },
  });
  const installs = [];
  services.installAssistant = async (input) => {
    installs.push(input);
    return createAssistantInstallResult({ includeSearxng: false });
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const { originHeader } = await prepareVpsNetwork(wizard.origin);
  const body = {
    containerName: "n8n-n8n-1",
    networkName: "proxy",
    includeSearxng: false,
  };

  const enabledPlan = await api(wizard.origin, "/api/assistant/plan", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify(body),
  });
  assert.equal(enabledPlan.status, 200);
  const enabledPlanId = (await enabledPlan.json()).planId;
  prerequisiteStatus = "configured";
  await api(wizard.origin, "/api/networks", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ containerName: body.containerName }),
  });
  const staleInstall = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ ...body, confirmed: true, planId: enabledPlanId }),
  });
  assert.equal(staleInstall.status, 400);
  assert.equal(installs.length, 0);

  for (const status of ["missing", "configured"]) {
    prerequisiteStatus = status;
    await api(wizard.origin, "/api/networks", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({ containerName: body.containerName }),
    });
    const response = await api(wizard.origin, "/api/assistant/plan", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.match(result.error, /N8N_ENABLED_MODULES.*instance-ai/i);
    assert.doesNotMatch(JSON.stringify(result), /secret|configured\|/i);
  }

  prerequisiteStatus = "enabled";
  await api(wizard.origin, "/api/networks", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ containerName: body.containerName }),
  });
  const plan = await api(wizard.origin, "/api/assistant/plan", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify(body),
  });
  assert.equal(plan.status, 200);
  const planPayload = await plan.json();
  assert.deepEqual(planPayload.instanceAi, { status: "enabled" });
  const install = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      ...body,
      confirmed: true,
      planId: planPayload.planId,
    }),
  });
  assert.equal(install.status, 200);
  assert.equal(installs.length, 1);
});

test("assistant installation rechecks live network and prerequisite state after plan review", async (t) => {
  const cases = [
    {
      label: "selected network disappears",
      live: { networks: ["other-network"], recommended: "other-network", instanceAi: { status: "enabled" } },
      expected: /Docker network.*found|network.*changed/i,
    },
    {
      label: "instance-ai is no longer enabled",
      live: { networks: ["proxy"], recommended: "proxy", instanceAi: { status: "configured" } },
      expected: /N8N_ENABLED_MODULES.*instance-ai|prerequisite/i,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.label, async (subtest) => {
      const { services } = createServices();
      let discoveryCalls = 0;
      let installCalls = 0;
      services.discoverNetworks = async () => {
        discoveryCalls += 1;
        return discoveryCalls === 1
          ? { networks: ["proxy"], recommended: "proxy", instanceAi: { status: "enabled" } }
          : scenario.live;
      };
      services.installAssistant = async () => {
        installCalls += 1;
        return { sandboxUrl: "http://sandbox:8080", includeSearxng: true };
      };
      const wizard = await startWizardServer({
        sessionToken,
        services,
        uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
      });
      subtest.after(() => wizard.close());

      const setup = await prepareVpsNetwork(wizard.origin, {
        assistantPlan: true,
      });
      const response = await api(wizard.origin, "/api/assistant/install", {
        method: "POST",
        headers: setup.originHeader,
        body: createVpsInstallBody(setup, { assistant: true }),
      });

      assert.equal(response.status, 400);
      assert.match((await response.json()).error, scenario.expected);
      assert.equal(discoveryCalls, 2);
      assert.equal(installCalls, 0);
    });
  }
});

test("shutdown rejects pending VPS lifecycle work and closes a stale SSH connection before it can commit", async () => {
  const { services } = createServices();
  const connectStarted = deferred();
  const candidateReady = deferred();
  const staleConnection = {
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    },
  };
  services.connectVerified = async () => {
    connectStarted.resolve();
    return await candidateReady.promise;
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  let closePromise;
  try {
    const originHeader = { Origin: wizard.origin };
    const fingerprint = await api(wizard.origin, "/api/ssh/fingerprint", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({ host: exampleHost, port: 22 }),
    });
    const { fingerprint: expectedFingerprint } = await fingerprint.json();
    const pendingConnect = api(wizard.origin, "/api/ssh/connect", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({
        host: exampleHost,
        port: 22,
        username: "root",
        password: fixturePassword,
        expectedFingerprint,
      }),
    });
    await connectStarted.promise;
    closePromise = wizard.close();
    candidateReady.resolve(staleConnection);
    const response = await pendingConnect;
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /closing/i);
    await closePromise;
    assert.equal(staleConnection.closeCalls, 1);
  } finally {
    candidateReady.resolve(staleConnection);
    if (closePromise) await closePromise;
    else await wizard.close();
  }
});

test("pending VPS discovery cannot overwrite state while an assistant mutation owns the connection", async () => {
  const { services, remote } = createServices();
  const originalDiscover = services.discoverN8n;
  const discoveryStarted = deferred();
  const discoveryReady = deferred();
  const installStarted = deferred();
  const installReady = deferred();
  let discoverCalls = 0;
  const assistantResult = createAssistantInstallResult();
  services.discoverN8n = async (connection) => {
    discoverCalls += 1;
    if (discoverCalls === 1) return await originalDiscover(connection);
    discoveryStarted.resolve();
    return await discoveryReady.promise;
  };
  services.installAssistant = async () => {
    installStarted.resolve();
    return await installReady.promise;
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  let pendingInstall;
  try {
    const setup = await prepareVpsNetwork(wizard.origin, {
      assistantPlan: true,
    });
    const pendingDiscovery = api(wizard.origin, "/api/discover", {
      method: "POST",
      headers: setup.originHeader,
      body: "{}",
    });
    await discoveryStarted.promise;
    pendingInstall = api(wizard.origin, "/api/assistant/install", {
      method: "POST",
      headers: setup.originHeader,
      body: createVpsInstallBody(setup, { assistant: true }),
    });
    await installStarted.promise;
    discoveryReady.resolve({ containers: [] });
    const discovery = await pendingDiscovery;
    assert.equal(discovery.status, 409);
    assert.match((await discovery.json()).error, /installation.*progress/i);
    assert.equal(remote.closed, false);
    installReady.resolve(assistantResult);
    assert.equal((await pendingInstall).status, 200);
    assert.equal(remote.closed, true);
  } finally {
    discoveryReady.resolve({ containers: [] });
    installReady.resolve(assistantResult);
    await pendingInstall?.catch(() => {});
    await wizard.close();
  }
});

test("a completed intervening VPS mutation invalidates pending discovery state", async (t) => {
  for (const kind of ["containers", "networks"]) {
    await t.test(kind, async (subtest) => {
      const { services } = createServices();
      const requestStarted = deferred();
      const staleResultReady = deferred();
      const originalDiscoverN8n = services.discoverN8n;
      const originalDiscoverNetworks = services.discoverNetworks;
      let discoverN8nCalls = 0;
      let discoverNetworkCalls = 0;
      services.discoverN8n = async (connection) => {
        discoverN8nCalls += 1;
        if (kind === "containers" && discoverN8nCalls === 2) {
          requestStarted.resolve();
          return await staleResultReady.promise;
        }
        return await originalDiscoverN8n(connection);
      };
      services.discoverNetworks = async (connection, containerName) => {
        discoverNetworkCalls += 1;
        if (kind === "networks" && discoverNetworkCalls === 2) {
          requestStarted.resolve();
          return await staleResultReady.promise;
        }
        return await originalDiscoverNetworks(connection, containerName);
      };
      services.installAssistant = async () => createAssistantInstallResult();
      const wizard = await startWizardServer({
        sessionToken,
        services,
        uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
      });
      subtest.after(() => wizard.close());
      const setup = await prepareVpsNetwork(wizard.origin, {
        assistantPlan: true,
      });
      const pendingDiscovery = api(
        wizard.origin,
        kind === "containers" ? "/api/discover" : "/api/networks",
        {
          method: "POST",
          headers: setup.originHeader,
          body:
            kind === "containers"
              ? "{}"
              : JSON.stringify({ containerName: "n8n-n8n-1" }),
        },
      );
      await requestStarted.promise;

      const install = await api(wizard.origin, "/api/assistant/install", {
        method: "POST",
        headers: setup.originHeader,
        body: createVpsInstallBody(setup, { assistant: true }),
      });
      assert.equal(install.status, 200);

      staleResultReady.resolve(
        kind === "containers"
          ? { containers: [] }
          : {
              networks: ["stale-network"],
              recommended: "stale-network",
              instanceAi: { status: "missing" },
            },
      );
      const staleDiscovery = await pendingDiscovery;
      assert.equal(staleDiscovery.status, 409);
      const payload = await staleDiscovery.json();
      assert.match(payload.error, /VPS session changed/i);
      assert.doesNotMatch(JSON.stringify(payload), /password|private|token/iu);
    });
  }
});

test("disconnect and reconnect invalidate discovery work from the previous VPS session", async (t) => {
  for (const action of ["disconnect", "reconnect"]) {
    await t.test(action, async (subtest) => {
      const { services } = createServices();
      const originalDiscover = services.discoverN8n;
      const staleDiscoveryStarted = deferred();
      const staleDiscoveryReady = deferred();
      let discoverCalls = 0;
      let connectionCalls = 0;
      const connections = [
        { close() {} },
        { close() {} },
      ];
      services.connectVerified = async () => {
        const connection = connections[connectionCalls];
        connectionCalls += 1;
        return connection;
      };
      services.discoverN8n = async (connection) => {
        discoverCalls += 1;
        if (discoverCalls === 2) {
          staleDiscoveryStarted.resolve();
          return await staleDiscoveryReady.promise;
        }
        return await originalDiscover(connection);
      };
      const wizard = await startWizardServer({
        sessionToken,
        services,
        uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
      });
      subtest.after(() => wizard.close());
      const setup = await prepareVpsNetwork(wizard.origin);
      const pendingDiscovery = api(wizard.origin, "/api/discover", {
        method: "POST",
        headers: setup.originHeader,
        body: "{}",
      });
      await staleDiscoveryStarted.promise;

      if (action === "disconnect") {
        const disconnected = await api(wizard.origin, "/api/disconnect", {
          method: "POST",
          headers: setup.originHeader,
          body: "{}",
        });
        assert.equal(disconnected.status, 200);
      } else {
        const fingerprintResponse = await api(
          wizard.origin,
          "/api/ssh/fingerprint",
          {
            method: "POST",
            headers: setup.originHeader,
            body: JSON.stringify({ host: exampleHost, port: 22 }),
          },
        );
        const { fingerprint } = await fingerprintResponse.json();
        const reconnected = await api(wizard.origin, "/api/ssh/connect", {
          method: "POST",
          headers: setup.originHeader,
          body: JSON.stringify({
            host: exampleHost,
            port: 22,
            username: "root",
            password: fixturePassword,
            expectedFingerprint: fingerprint,
          }),
        });
        assert.equal(reconnected.status, 200);
      }

      staleDiscoveryReady.resolve({ containers: [] });
      const stale = await pendingDiscovery;
      assert.equal(stale.status, 409);
      assert.match((await stale.json()).error, /VPS session changed/i);
    });
  }
});

test("disconnect detaches state before a throwing SSH close and rejects late discovery", async (t) => {
  const { remote, services } = createServices();
  const originalDiscover = services.discoverN8n;
  const staleDiscoveryStarted = deferred();
  const staleDiscoveryReady = deferred();
  let closeCalls = 0;
  let discoverCalls = 0;
  remote.close = () => {
    closeCalls += 1;
    throw new Error("close failed at /private/path with token");
  };
  services.discoverN8n = async (connection) => {
    discoverCalls += 1;
    if (discoverCalls === 2) {
      staleDiscoveryStarted.resolve();
      return await staleDiscoveryReady.promise;
    }
    return await originalDiscover(connection);
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const reviewed = await prepareVpsNetwork(wizard.origin, {
    assistantPlan: true,
    sidecarPlan: true,
  });
  const pendingDiscovery = api(wizard.origin, "/api/discover", {
    method: "POST",
    headers: reviewed.originHeader,
    body: "{}",
  });
  await staleDiscoveryStarted.promise;

  const disconnected = await api(wizard.origin, "/api/disconnect", {
    method: "POST",
    headers: reviewed.originHeader,
    body: "{}",
  });
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), { disconnected: true });
  assert.equal(closeCalls, 1);

  staleDiscoveryReady.resolve({ containers: [] });
  const staleDiscovery = await pendingDiscovery;
  assert.equal(staleDiscovery.status, 409);
  const stalePayload = await staleDiscovery.json();
  assert.match(stalePayload.error, /VPS session changed/i);
  assert.doesNotMatch(
    JSON.stringify(stalePayload),
    /private|token|close failed/iu,
  );

  const reconnected = await prepareVpsNetwork(wizard.origin);
  for (const assistant of [false, true]) {
    const staleSetup = {
      ...reconnected,
      assistantPlanId: reviewed.assistantPlanId,
      sidecarPlanId: reviewed.sidecarPlanId,
    };
    const stale = await api(
      wizard.origin,
      assistant ? "/api/assistant/install" : "/api/install",
      {
        method: "POST",
        headers: reconnected.originHeader,
        body: createVpsInstallBody(staleSetup, { assistant }),
      },
    );
    assert.equal(stale.status, 400);
    assert.match((await stale.json()).error, /fresh.*plan/i);
  }
});

test("terminal OAuth retry-blocked state still permits an explicit authenticated VPS disconnect", async (t) => {
  const { remote, services } = createServices();
  let closeCalls = 0;
  remote.close = () => {
    closeCalls += 1;
  };
  services.startOAuthLogin = async () => {
    throw Object.assign(
      new Error("The ChatGPT sign-in result could not be confirmed."),
      { retryBlocked: true },
    );
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const setup = await prepareVpsNetwork(wizard.origin);

  const login = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  assert.equal(login.status, 400);
  assert.equal((await login.json()).retryBlocked, true);

  const disconnected = await api(wizard.origin, "/api/disconnect", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), { disconnected: true });
  assert.equal(closeCalls, 1);
});

test("an idle VPS SSH connection expires and cannot be reused", async (t) => {
  const { remote, services } = createServices();
  let closeCalls = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  remote.close = () => {
    closeCalls += 1;
    resolveClosed();
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    vpsConnectionIdleMs: 20,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  await prepareVpsNetwork(wizard.origin);

  await Promise.race([
    closed,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("idle VPS connection did not expire")), 500);
    }),
  ]);
  assert.equal(closeCalls, 1);

  const discovery = await api(wizard.origin, "/api/discover", {
    method: "POST",
    headers: { Origin: wizard.origin },
    body: "{}",
  });
  assert.equal(discovery.status, 400);
  assert.deepEqual(await discovery.json(), { error: "Connect to the VPS first." });
});

test("VPS SSH idle expiry waits for an active remote operation", async (t) => {
  const { remote, services } = createServices();
  const originalDiscover = services.discoverN8n;
  const discoveryStarted = deferred();
  const discoveryReady = deferred();
  let discoveryCalls = 0;
  let closeCalls = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  remote.close = () => {
    closeCalls += 1;
    resolveClosed();
  };
  services.discoverN8n = async (connection) => {
    discoveryCalls += 1;
    if (discoveryCalls === 2) {
      discoveryStarted.resolve();
      await discoveryReady.promise;
    }
    return await originalDiscover(connection);
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    vpsConnectionIdleMs: 20,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());
  const setup = await prepareVpsNetwork(wizard.origin);

  const discovery = api(wizard.origin, "/api/discover", {
    method: "POST",
    headers: setup.originHeader,
    body: "{}",
  });
  await discoveryStarted.promise;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(closeCalls, 0);

  discoveryReady.resolve();
  assert.equal((await discovery).status, 200);
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("released VPS connection did not expire")), 500);
    }),
  ]);
  assert.equal(closeCalls, 1);
});

test("concurrent SSH connects fail fast without replacing or leaking the winning connection", async () => {
  const { services } = createServices();
  const firstConnectStarted = deferred();
  const firstCandidateReady = deferred();
  let connectCalls = 0;
  const firstCandidate = {
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    },
  };
  const losingCandidate = {
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    },
  };
  services.connectVerified = async () => {
    connectCalls += 1;
    if (connectCalls === 1) {
      firstConnectStarted.resolve();
      await firstCandidateReady.promise;
      return firstCandidate;
    }
    return losingCandidate;
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  let firstConnect;
  try {
    const originHeader = { Origin: wizard.origin };
    const fingerprintResponse = await api(
      wizard.origin,
      "/api/ssh/fingerprint",
      {
        method: "POST",
        headers: originHeader,
        body: JSON.stringify({ host: exampleHost, port: 22 }),
      },
    );
    const { fingerprint } = await fingerprintResponse.json();
    const connectBody = JSON.stringify({
      host: exampleHost,
      port: 22,
      username: "root",
      password: fixturePassword,
      expectedFingerprint: fingerprint,
    });
    firstConnect = api(wizard.origin, "/api/ssh/connect", {
      method: "POST",
      headers: originHeader,
      body: connectBody,
    });
    await firstConnectStarted.promise;

    const concurrent = await api(wizard.origin, "/api/ssh/connect", {
      method: "POST",
      headers: originHeader,
      body: connectBody,
    });
    assert.equal(concurrent.status, 409);
    const conflict = await concurrent.json();
    assert.match(conflict.error, /VPS connection.*progress/i);
    assert.doesNotMatch(JSON.stringify(conflict), /password|private|token/iu);
    assert.equal(connectCalls, 1);
    assert.equal(losingCandidate.closeCalls, 0);

    firstCandidateReady.resolve();
    assert.equal((await firstConnect).status, 200);
  } finally {
    firstCandidateReady.resolve();
    await firstConnect?.catch(() => {});
    await wizard.close();
  }
  assert.equal(firstCandidate.closeCalls, 1);
  assert.equal(losingCandidate.closeCalls, 0);
});

test("the last-started fingerprint scan deterministically owns host identity state", async () => {
  const { services } = createServices();
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstReady = deferred();
  const secondReady = deferred();
  let scanCalls = 0;
  const firstFingerprint = `SHA256:${"a".repeat(43)}`;
  const secondFingerprint = `SHA256:${"b".repeat(43)}`;
  services.scanHostFingerprint = async () => {
    scanCalls += 1;
    if (scanCalls === 1) {
      firstStarted.resolve();
      await firstReady.promise;
      return firstFingerprint;
    }
    secondStarted.resolve();
    await secondReady.promise;
    return secondFingerprint;
  };
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  try {
    const originHeader = { Origin: wizard.origin };
    const firstScan = api(wizard.origin, "/api/ssh/fingerprint", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({ host: exampleHost, port: 22 }),
    });
    await firstStarted.promise;
    const secondScan = api(wizard.origin, "/api/ssh/fingerprint", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({ host: exampleHost, port: 22 }),
    });
    await secondStarted.promise;

    secondReady.resolve();
    const secondResponse = await secondScan;
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(await secondResponse.json(), {
      fingerprint: secondFingerprint,
    });

    firstReady.resolve();
    const staleFirstResponse = await firstScan;
    assert.equal(staleFirstResponse.status, 409);
    assert.match((await staleFirstResponse.json()).error, /identity scan changed/i);

    const connected = await api(wizard.origin, "/api/ssh/connect", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({
        host: exampleHost,
        port: 22,
        username: "root",
        password: fixturePassword,
        expectedFingerprint: secondFingerprint,
      }),
    });
    assert.equal(connected.status, 200);
  } finally {
    firstReady.resolve();
    secondReady.resolve();
    await wizard.close();
  }
});

test("wizard binds SSH authentication to the server fingerprint it scanned", async (t) => {
  const { services } = createServices();
  const wizard = await startWizardServer({
    sessionToken,
    services,
    uiFiles: { "/": "", "/app.js": "", "/styles.css": "" },
  });
  t.after(() => wizard.close());

  const originHeader = { Origin: wizard.origin };
  await api(wizard.origin, "/api/ssh/fingerprint", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ host: exampleHost, port: 22 }),
  });

  const response = await api(wizard.origin, "/api/ssh/connect", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      host: "changed-vps.example.test",
      port: 22,
      username: "root",
      password: fixturePassword,
      expectedFingerprint:
        "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /identity|fingerprint/i);
});
