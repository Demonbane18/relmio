import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runPreview } from "../scripts/preview.js";

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

  const statusResponse = await fetch(`${origin}/api/status`, {
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
    ensureBrowserLaunchRoot: async () => "/private/preview/browser-launches",
    log: (line) => logs.push(line),
    open: async () => false,
    signalTarget,
    startServer: async () => ({
      async close() { closed += 1; },
      async prepareBrowserLaunch(route) {
        assert.equal(route, "/");
        prepared += 1;
        return `file:///private/tmp/relmio-browser-Ab3dE9/launch-${String(prepared).padStart(24, "0")}.html`;
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
