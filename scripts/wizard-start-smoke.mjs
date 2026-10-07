#!/usr/bin/env node
// CI smoke test for macOS and Linux. Starts the real wizard with `relmio start`
// (the existing no-browser launch), completes the private browser handoff over
// loopback the way a browser does, fetches `/` with the resulting session, then
// stops it. Uses a throwaway RELMIO_HOME and never prints a secret.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readLocalDashboardBrowserUrl } from "../src/services/local-dashboard-control.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));
// The parent must be private and free of symbolic links (macOS tmpdir is one).
const parent = await mkdtemp(join(realpathSync(tmpdir()), "relmio-smoke-"));
const env = { ...process.env, RELMIO_HOME: join(parent, ".relmio") };

function relmio(command) {
  return execFileAsync(process.execPath, [cliPath, command], { env, timeout: 60_000 });
}

function capture(text, pattern) {
  const match = pattern.exec(text);
  assert.ok(match, `Expected ${pattern} in the browser handoff.`);
  return match[1];
}

async function openWizardWithSession() {
  const launchUrl = await readLocalDashboardBrowserUrl({ env, route: "/" });
  const handoff = await readFile(fileURLToPath(launchUrl), "utf8");
  const action = new URL(capture(handoff, /action="([^"]+)"/u));
  assert.equal(action.hostname, "127.0.0.1");
  const { origin } = action;

  const bootstrap = await fetch(action, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null" },
    body: new URLSearchParams({
      ticketId: capture(handoff, /name="ticketId" value="([^"]+)"/u),
      secret: capture(handoff, /name="secret" value="([^"]+)"/u),
      route: "/",
    }),
    redirect: "manual",
  });
  assert.equal(bootstrap.status, 200);
  const envelope = /"relmio-v1\.([\w-]{43})\.([\w-]{43})"/u.exec(await bootstrap.text());
  assert.ok(envelope, "Expected a browser transfer envelope.");

  const transfer = await fetch(`${origin}/__relmio/browser/transfer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ transferId: envelope[1], secret: envelope[2], route: "/" }),
  });
  assert.equal(transfer.status, 200);
  const { sessionToken } = await transfer.json();
  assert.equal(typeof sessionToken, "string");

  const page = await fetch(`${origin}/`, {
    headers: { Accept: "text/html", "X-Setup-Token": sessionToken },
  });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  assert.match(await page.text(), /^<!doctype html>/iu);

  const api = await fetch(`${origin}/api/oauth/status`, {
    headers: { "X-Setup-Token": sessionToken },
  });
  assert.equal(api.status, 200);
  return origin;
}

try {
  let origin;
  try {
    await relmio("start");
    origin = await openWizardWithSession();
  } finally {
    // `stop` is a no-op when nothing started, so it is always safe here.
    await relmio("stop");
  }
  await assert.rejects(relmio("status"), { code: 1 });
  console.log(`Wizard served / with its CSP on ${origin}, accepted its browser session, and stopped.`);
} finally {
  await rm(parent, { recursive: true, force: true });
}
