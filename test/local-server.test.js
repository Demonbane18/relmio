import assert from "node:assert/strict";
import test from "node:test";

import { startWizardServer } from "../src/web/server.js";

const sessionToken = "local-server-test-session-token-1234567890";
const platformApiKey = `sk-${"a".repeat(48)}`;
const clientCredential = "local-client-credential-shown-once";
const codexProjectName = `relmio-codex-chatgpt-${"01".repeat(16)}`;

async function startLocalWizard(t, services, { previewMode = false } = {}) {
  const wizard = await startWizardServer({
    sessionToken,
    services,
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

test("local installation rejects concurrent attempts and releases its lock after failure", async (t) => {
  let releaseFirstInstall;
  let notifyFirstInstallStarted;
  let installCalls = 0;
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
    async restartLocalCodex(input) {
      restartInput = input;
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
    installDirectory: "/Users/fixture/.relmio/local/codex-chatgpt",
  });
  const completed = await api(
    wizard,
    "/api/local/codex/login/status",
  );
  assert.deepEqual(await completed.json(), { status: "success" });
  assert.equal(cancelCalls, 0);
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
      async installLocalEndpoint() {
        calls.push("install");
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
