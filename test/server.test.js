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
        return { exists: true, path: "/private/path/auth.json" };
      },
      async runOAuthLogin() {
        return { success: true };
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
        return { networks: ["proxy"], recommended: "proxy" };
      },
      async installSidecar() {
        return {
          baseUrl: "http://openai-oauth:10531/v1",
          apiKeyPlaceholder: "local-only",
          useResponsesApi: true,
          models: ["gpt-5.6-sol"],
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
  assert.deepEqual(await status.json(), { authExists: true });
  assert.match(
    status.headers.get("content-security-policy"),
    /default-src 'self'/,
  );
  assert.equal(status.headers.get("x-content-type-options"), "nosniff");
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
  assert.equal((await install.json()).baseUrl, "http://openai-oauth:10531/v1");
  assert.equal(remote.closed, true);
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
