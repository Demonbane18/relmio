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
