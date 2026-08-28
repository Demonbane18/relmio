import assert from "node:assert/strict";
import test from "node:test";

import { startWizardServer } from "../src/web/server.js";

const sessionToken = "test-session-token-that-is-long-enough-123456";
const exampleHost = "vps.example.test";
const fixturePassword = "x".repeat(32);

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
  if (sidecarPlan) {
    await api(origin, "/api/plan", { method: "POST", headers: originHeader, body: planBody });
  }
  if (assistantPlan) {
    await api(origin, "/api/assistant/plan", { method: "POST", headers: originHeader, body: planBody });
  }
  return { originHeader, planBody };
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

  const loginResponse = await api(wizard.origin, "/api/oauth/login", {
    method: "POST",
    headers: { Origin: wizard.origin },
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
  assert.equal(
    (await plan.json()).endpointHostname,
    "n8n-openai-oauth",
  );

  const install = await api(wizard.origin, "/api/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({
      containerName: "n8n-n8n-1",
      networkName: "proxy",
      confirmed: true,
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
      const assistantResult = {
        sandboxUrl: "http://sandbox:8080",
        sandboxApiKey: "shown-once",
        searxngUrl: "http://search:8080",
        modelProvider: "OpenAI",
        modelRecommendation: "preserve-current-supported-selection",
        deploymentMode: "installed",
      };
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
      const { originHeader, planBody } = await prepareVpsNetwork(wizard.origin, {
        assistantPlan: true,
        sidecarPlan: true,
      });
      const firstPath = scenario.first === "assistant" ? "/api/assistant/install" : "/api/install";
      const secondPath = scenario.second === "assistant" ? "/api/assistant/install" : "/api/install";
      const firstRequest = api(wizard.origin, firstPath, {
        method: "POST",
        headers: originHeader,
        body: JSON.stringify({ containerName: "n8n-n8n-1", networkName: "proxy", includeSearxng: true, confirmed: true }),
      });
      try {
        await firstStarted.promise;
        const concurrent = await api(wizard.origin, secondPath, {
          method: "POST",
          headers: originHeader,
          body: JSON.stringify({ containerName: "n8n-n8n-1", networkName: "proxy", includeSearxng: true, confirmed: true }),
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
        assert.ok(planBody.length > 0);
      } finally {
        firstInstall.resolve(scenario.first === "assistant" ? assistantResult : sidecarResult);
        await firstRequest;
      }
    });
  }
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
    return {
      sandboxUrl: "http://sandbox:8080",
      sandboxApiKey: "shown-once",
      searxngUrl: "http://search:8080",
      modelProvider: "OpenAI",
      modelRecommendation: "preserve-current-supported-selection",
      deploymentMode: "installed",
    };
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
    body: JSON.stringify({ containerName: "n8n-n8n-1", networkName: "proxy", includeSearxng: true, confirmed: true }),
  });
  assert.equal(failed.status, 400);
  const failure = await failed.json();
  assert.match(failure.error, /cleanup.*not.*confirmed.*do not use/i);
  assert.doesNotMatch(JSON.stringify(failure), /\/docker|secret|credential|token/i);

  setup = await prepareVpsNetwork(wizard.origin);
  const stalePlan = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: setup.originHeader,
    body: JSON.stringify({ containerName: "n8n-n8n-1", networkName: "proxy", includeSearxng: true, confirmed: true }),
  });
  assert.equal(stalePlan.status, 400);
  assert.match((await stalePlan.json()).error, /fresh.*plan/i);

  await api(wizard.origin, "/api/assistant/plan", {
    method: "POST",
    headers: setup.originHeader,
    body: setup.planBody,
  });
  const retried = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: setup.originHeader,
    body: JSON.stringify({ containerName: "n8n-n8n-1", networkName: "proxy", includeSearxng: true, confirmed: true }),
  });
  assert.equal(retried.status, 200);
  assert.equal(installAttempts, 2);
});

test("assistant web-search selection is an explicit boolean bound to its reviewed plan", async (t) => {
  const { services } = createServices();
  const installs = [];
  services.installAssistant = async (input) => {
    installs.push(input);
    return {
      sandboxUrl: "http://sandbox:8080",
      sandboxApiKey: "shown-once",
      includeSearxng: false,
      webSearch: "disabled",
      modelProvider: "OpenAI",
      modelRecommendation: "preserve-current-supported-selection",
      deploymentMode: "installed",
    };
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
  assert.equal((await reviewed.json()).includeSearxng, false);
  for (const includeSearxng of [undefined, "false", 0, null]) {
    const response = await api(wizard.origin, "/api/assistant/install", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({
        ...base,
        ...(includeSearxng === undefined ? {} : { includeSearxng }),
        confirmed: true,
      }),
    });
    assert.equal(response.status, 400);
  }
  assert.equal(installs.length, 0);
  const mismatched = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ ...base, includeSearxng: true, confirmed: true }),
  });
  assert.equal(mismatched.status, 400);
  assert.equal(installs.length, 0);

  const refreshed = await api(wizard.origin, "/api/assistant/plan", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ ...base, includeSearxng: false }),
  });
  assert.equal(refreshed.status, 200);
  const installed = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ ...base, includeSearxng: false, confirmed: true }),
  });
  assert.equal(installed.status, 200);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].includeSearxng, false);
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
    return { sandboxUrl: "http://sandbox:8080", includeSearxng: false };
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
  prerequisiteStatus = "configured";
  await api(wizard.origin, "/api/networks", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ containerName: body.containerName }),
  });
  const staleInstall = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ ...body, confirmed: true }),
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
  assert.deepEqual((await plan.json()).instanceAi, { status: "enabled" });
  const install = await api(wizard.origin, "/api/assistant/install", {
    method: "POST",
    headers: originHeader,
    body: JSON.stringify({ ...body, confirmed: true }),
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

      const { originHeader, planBody } = await prepareVpsNetwork(wizard.origin, {
        assistantPlan: true,
      });
      const response = await api(wizard.origin, "/api/assistant/install", {
        method: "POST",
        headers: originHeader,
        body: JSON.stringify({ ...JSON.parse(planBody), confirmed: true }),
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
  const assistantResult = {
    sandboxUrl: "http://sandbox:8080",
    sandboxApiKey: "shown-once",
    searxngUrl: "http://search:8080",
    modelProvider: "OpenAI",
    modelRecommendation: "preserve-current-supported-selection",
    deploymentMode: "installed",
  };
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
    const { originHeader } = await prepareVpsNetwork(wizard.origin, { assistantPlan: true });
    const pendingDiscovery = api(wizard.origin, "/api/discover", {
      method: "POST",
      headers: originHeader,
      body: "{}",
    });
    await discoveryStarted.promise;
    pendingInstall = api(wizard.origin, "/api/assistant/install", {
      method: "POST",
      headers: originHeader,
      body: JSON.stringify({ containerName: "n8n-n8n-1", networkName: "proxy", includeSearxng: true, confirmed: true }),
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
