import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { createPreviewServices, PREVIEW_FIXTURES, runPreview } from "../scripts/preview.js";
import { createPrivateBrowserHandoff } from "../src/services/browser-handoff.js";
import { startWizardServer } from "../src/web/server.js";
import { CLAUDE_REVIEW_FIELDS } from "../src/domain/local-n8n-claude.js";

function hiddenInput(contents, name) {
  const match = new RegExp(`name="${name}" value="([^"]+)"`, "u").exec(contents);
  assert.ok(match, `private handoff must contain ${name}`);
  return match[1];
}

test("preview opens through a private handoff and authenticates from a clean page", async (t) => {
  const privateRoot = await realpath(
    await mkdtemp(join(tmpdir(), "relmio-preview-test-")),
  );
  t.after(() => rm(privateRoot, { recursive: true, force: true }));

  const sessionToken = Buffer.alloc(32, 23).toString("base64url");
  const environment = { RELMIO_HOME: join(privateRoot, ".relmio") };
  const argumentsBefore = [...process.argv];
  const logs = [];
  const opened = [];
  const signalTarget = new EventEmitter();
  const log = (line) => logs.push(line);
  let detached = 0;
  let launchRootOptions;

  const preview = await runPreview({
    createSessionToken: () => sessionToken,
    env: environment,
    ensureBrowserLaunchRoot: async (options) => {
      launchRootOptions = options;
      return privateRoot;
    },
    startServer: async (options) => await startWizardServer({
      ...options,
      createBrowserHandoff: async (input) => await createPrivateBrowserHandoff({
        ...input,
        lockDownPath: async () => {},
      }),
    }),
    log,
    open: async (launchUrl) => {
      opened.push(launchUrl);
      return true;
    },
    attachReopen({ prepareLaunch, open, write }) {
      assert.equal(typeof prepareLaunch, "function");
      assert.equal(typeof open, "function");
      assert.equal(write, log);
      return () => { detached += 1; };
    },
    signalTarget,
  });
  t.after(() => preview.close());

  assert.deepEqual(launchRootOptions, { env: environment });
  assert.equal(opened.length, 1);
  const launchUrl = opened[0];
  const parsedLaunchUrl = new URL(launchUrl);
  assert.equal(parsedLaunchUrl.protocol, "file:");
  assert.equal(parsedLaunchUrl.search, "");
  assert.equal(parsedLaunchUrl.hash, "");
  assert.equal(launchUrl.includes(sessionToken), false);
  assert.doesNotMatch(launchUrl, /session=/iu);

  const terminalOutput = logs.join("\n");
  assert.equal(terminalOutput.includes(sessionToken), false);
  assert.doesNotMatch(terminalOutput, /[?&]session=/iu);
  assert.deepEqual(process.argv, argumentsBefore);
  assert.equal(JSON.stringify(environment).includes(sessionToken), false);

  const handoffContents = await readFile(fileURLToPath(launchUrl), "utf8");
  const action = /action="([^"]+)"/u.exec(handoffContents)?.[1];
  assert.ok(action);
  assert.equal(handoffContents.includes(sessionToken), false);
  assert.doesNotMatch(
    handoffContents,
    /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie|session=/u,
  );

  const bootstrapResponse = await fetch(action, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "null",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
    },
    body: new URLSearchParams({
      route: hiddenInput(handoffContents, "route"),
      secret: hiddenInput(handoffContents, "secret"),
      ticketId: hiddenInput(handoffContents, "ticketId"),
    }),
    redirect: "manual",
  });
  assert.equal(bootstrapResponse.status, 200);
  assert.equal(bootstrapResponse.headers.get("set-cookie"), null);
  const bootstrapHtml = await bootstrapResponse.text();
  assert.equal(bootstrapHtml.includes(sessionToken), false);
  assert.match(bootstrapHtml, /window\.location\.replace\("\/"\)/u);
  assert.doesNotMatch(bootstrapHtml, /[?&]session=|\blocalStorage\b|\bsessionStorage\b/u);

  const envelope =
    /window\.name = "relmio-v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})"/u.exec(
      bootstrapHtml,
    );
  assert.ok(envelope);
  const origin = new URL(action).origin;
  const transferResponse = await fetch(`${origin}/__relmio/browser/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": origin,
    },
    body: JSON.stringify({
      route: "/",
      transferId: envelope[1],
      secret: envelope[2],
    }),
    redirect: "error",
  });
  assert.equal(transferResponse.status, 200);
  assert.equal(transferResponse.headers.get("set-cookie"), null);
  assert.deepEqual(await transferResponse.json(), { sessionToken });

  const pageResponse = await fetch(`${origin}/`, { redirect: "error" });
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.url, `${origin}/`);
  assert.equal(pageResponse.headers.get("set-cookie"), null);
  assert.equal((await pageResponse.text()).includes(sessionToken), false);

  const statusResponse = await fetch(`${origin}/api/siwc/accounts`, {
    headers: { "X-Setup-Token": sessionToken },
  });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).previewMode, true);

  await preview.close();
  assert.equal(detached, 1);
  assert.equal(signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(signalTarget.listenerCount("SIGTERM"), 0);
});

test("preview keeps the terminal reopen fallback when automatic opening fails", async () => {
  const sessionToken = Buffer.alloc(32, 31).toString("base64url");
  const browserLaunchRoot = join(tmpdir(), "relmio-preview-browser-launches");
  const signalTarget = new EventEmitter();
  const logs = [];
  let attached;
  let closed = 0;
  let prepared = 0;

  const preview = await runPreview({
    attachReopen(options) {
      attached = options;
      options.write(
        "If the wizard did not open automatically, press Enter to open it again.",
      );
      return () => {};
    },
    createSessionToken: () => sessionToken,
    ensureBrowserLaunchRoot: async () => browserLaunchRoot,
    log: (line) => logs.push(line),
    open: async () => false,
    signalTarget,
    startServer: async () => ({
      async close() { closed += 1; },
      async prepareBrowserLaunch(route) {
        assert.equal(route, "/");
        prepared += 1;
        return pathToFileURL(join(
          browserLaunchRoot,
          "relmio-browser-Ab3dE9",
          `launch-${String(prepared).padStart(24, "0")}.html`,
        )).href;
      },
    }),
  });

  assert.equal(prepared, 1);
  assert.equal(typeof attached?.prepareLaunch, "function");
  assert.equal(typeof attached?.open, "function");
  assert.match(logs.join("\n"), /press Enter/iu);
  assert.equal(closed, 0);

  await preview.close();
  assert.equal(closed, 1);
});

test("every sanitized SIWC fixture starts and serves wizard pages without credentials or live actions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relmio-preview-fixtures-"));
  const sessionToken = Buffer.alloc(32, 17).toString("base64url");
  for (const fixture of PREVIEW_FIXTURES) {
    await t.test(fixture, async () => {
      const wizard = await startWizardServer({ sessionToken, storageRoot: join(root, fixture),
        services: createPreviewServices(fixture), previewMode: true, previewFixture: fixture });
      try {
        for (const path of ["/", "/local", "/app.js", "/local.js", "/siwc-controls.js", "/siwc.css"]) {
          const response = await fetch(`${wizard.origin}${path}`);
          assert.equal(response.status, 200);
          assert.ok((await response.text()).length > 0);
        }
        const response = await fetch(`${wizard.origin}/api/siwc/accounts`, {
          headers: { "X-Setup-Token": sessionToken },
        });
        assert.equal(response.status, 200);
        const text = await response.text();
        const result = JSON.parse(text);
        assert.equal(result.previewFixture, fixture);
        assert.equal(result.accounts.length, 1);
        assert.doesNotMatch(text, /accessToken|refreshToken|idToken|clientCredential|privateKey/u);
        if (["signed-out", "reauthorize"].includes(fixture)) assert.equal(result.accounts[0].session, fixture);
        if (fixture === "plan-not-granted") assert.equal(result.accounts[0].planPermission, "not-granted");
        if (fixture === "handoff-pending") assert.equal(result.accounts[0].ownership, fixture);
        const dashboard = await fetch(`${wizard.origin}/api/local/dashboard`, {
          headers: { "X-Setup-Token": sessionToken },
        });
        assert.equal(dashboard.status, 200);
        if (fixture === "staged") {
          const service = (await dashboard.json()).services.find(({ target }) => target === "codex-chat");
          assert.equal(service.state, "staged");
          assert.equal(service.staging.registrationId, result.accounts[0].registrationId);
        }
        const disabled = await fetch(`${wizard.origin}/api/local/siwc/recovery/review`, {
          method: "POST", headers: { "Content-Type": "application/json", Origin: wizard.origin,
            "X-Setup-Token": sessionToken }, body: JSON.stringify({
              target: "codex-chat", registrationId: result.accounts[0].registrationId, action: "resume",
            }),
        });
        assert.equal(disabled.status, 403);
      } finally {
        await wizard.close();
      }
    });
  }
});

test("sanitized preview keeps the guide choice in memory and writes no preference file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relmio-preview-preferences-"));
  const sessionToken = Buffer.alloc(32, 23).toString("base64url");
  const wizard = await startWizardServer({ sessionToken, storageRoot: root, uiFiles: {},
    services: createPreviewServices(), previewMode: true, previewFixture: "connected" });
  t.after(async () => {
    await wizard.close();
    await rm(root, { recursive: true, force: true });
  });
  const preferences = (body) => fetch(`${wizard.origin}/api/ui/preferences`, { method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Origin: wizard.origin, "X-Setup-Token": sessionToken },
    body: body && JSON.stringify(body) });
  assert.deepEqual(await (await preferences()).json(), {});
  assert.deepEqual(await (await preferences({ guide: "off" })).json(), { guide: "off" });
  assert.deepEqual(await (await preferences()).json(), { guide: "off" });
  await assert.rejects(stat(join(root, "ui-preferences.json")), { code: "ENOENT" });
});

test("preview provider routes reach status and review without SSH, and confirmed applies stay refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relmio-preview-providers-"));
  const sessionToken = Buffer.alloc(32, 42).toString("base64url");
  const services = createPreviewServices();
  const wizard = await startWizardServer({ sessionToken, storageRoot: root, uiFiles: {},
    services, previewMode: true, previewFixture: "connected" });
  t.after(async () => {
    await wizard.close();
    await rm(root, { recursive: true, force: true });
  });
  const request = async (path, body) => {
    const response = await fetch(`${wizard.origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: wizard.origin, "X-Setup-Token": sessionToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (path, body) => {
    const result = await request(path, body);
    assert.equal(result.status, 200, `${path}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  // The ordinary host-key review still applies, even though both scan and connect are fakes.
  const destination = { host: "preview.example.test", port: 22 };
  const login = { ...destination, username: "root", useAgent: false, privilege: "root", password: "preview-only" };
  assert.equal((await request("/api/ssh/connect", login)).status, 400);
  const { fingerprint } = await ok("/api/ssh/fingerprint", destination);
  await ok("/api/ssh/connect", { ...login, expectedFingerprint: fingerprint });
  const { containers } = await ok("/api/discover", {});
  const containerName = containers[0].name;
  const { networks } = await ok("/api/networks", { containerName });
  const boundary = { containerName, networkName: networks[0] };
  const host = await ok("/api/ssh/host-report");
  assert.equal(host.host.arch, "x86_64");
  assert.ok(host.rows.length > 1);

  assert.equal((await ok("/api/vps/supergrok/status", boundary)).state, "absent");
  assert.equal((await ok("/api/vps/claude/status")).state, "absent");
  assert.equal((await ok("/api/vps/local-model/status", boundary)).state, "absent");
  assert.deepEqual(await ok("/api/vps/supergrok/login-status", {}), { state: "idle" });
  assert.equal((await ok("/api/vps/supergrok/models", { clientKey: "a".repeat(64) })).status, 200);
  assert.deepEqual(await ok("/api/vps/claude/auth-status", {}), {
    loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro",
  });
  assert.ok((await ok("/api/vps/claude/models", { clientKey: "p".repeat(43) })).models.length);

  const grok = await ok("/api/vps/supergrok/plan", { ...boundary, action: "install" });
  assert.deepEqual(grok.publishedPorts, []);
  assert.equal((await request("/api/vps/supergrok/apply", { ...grok, confirmed: true })).status, 403);
  const review = Object.fromEntries(CLAUDE_REVIEW_FIELDS.map(field => [field, true]));
  assert.equal((await request("/api/vps/claude/plan", {
    ...boundary, action: "install", models: ["claude-sonnet-5-5"], review: {},
  })).status, 400);
  const claude = await ok("/api/vps/claude/plan", {
    ...boundary, action: "install", models: ["claude-sonnet-5-5"], review,
  });
  assert.equal(claude.plan.keepsClaudeLogin, false);
  assert.equal((await request("/api/vps/claude/apply", { planId: claude.planId, confirmed: true })).status, 403);
  const model = await ok("/api/vps/local-model/plan", { ...boundary, action: "install", modelId: "qwen3:0.6b" });
  assert.equal(model.sharedRootBootstrap.directoryMode, "0700");
  assert.equal((await request("/api/vps/local-model/apply", {
    ...boundary, action: "install", planId: model.planId, confirmed: true,
  })).status, 403);
  for (const name of ["installVpsSuperGrok", "changeVpsSuperGrok", "applyVpsClaude",
    "installVpsLocalModel", "changeVpsLocalModel", "installSidecar", "installAssistant"]) {
    assert.throws(() => services[name]({ confirmed: true }), { statusCode: 403 }, name);
  }
});
