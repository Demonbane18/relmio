import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { startWizardServer } from "../src/web/server.js";

const sessionToken = `w${"s".repeat(42)}`;
const controlToken = `A${"c".repeat(42)}`;
const launchUrl = pathToFileURL(join(
  tmpdir(),
  "relmio-browser-Ab3dE9",
  "launch-0123456789abcdef01234567.html",
)).href;

function formBody({ ticketId, secret, route }) {
  return new URLSearchParams({ ticketId, secret, route }).toString();
}

async function startFixture(t, overrides = {}) {
  const handoffs = [];
  const disposed = [];
  let byte = 1;
  let nowMs = 1_780_000_000_000;
  const wizard = await startWizardServer({
    sessionToken,
    controlToken,
    controlInstanceId: "12345678-1234-4123-8123-123456789abc",
    onControlStop() {},
    uiFiles: {
      "/": '<!doctype html><html><head><script src="/app.js" type="module"></script></head><body>vps</body></html>',
      "/local": '<!doctype html><html><head><script src="/local.js" type="module"></script></head><body>local</body></html>',
      "/assistant": '<!doctype html><html><head><script src="/assistant.js" type="module"></script></head><body>assistant</body></html>',
    },
    randomBytes(size) {
      const result = Buffer.alloc(size, byte);
      byte += 1;
      return result;
    },
    now: () => nowMs,
    createBrowserHandoff: async (input) => {
      handoffs.push(input);
      return {
        launchUrl,
        async dispose() { disposed.push(input.ticketId); return true; },
      };
    },
    ...overrides,
  });
  t.after(() => wizard.close());
  return {
    wizard,
    handoffs,
    disposed,
    advance(milliseconds) { nowMs += milliseconds; },
  };
}

async function prepare(fixture, route = "/local", token = sessionToken, origin = fixture.wizard.origin) {
  return await fetch(`${fixture.wizard.origin}/__relmio/browser/prepare`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": origin,
      "X-Setup-Token": token,
    },
    body: JSON.stringify({ route }),
    redirect: "error",
  });
}

async function exchange(fixture, input, headers = {}) {
  return await fetch(`${fixture.wizard.origin}/__relmio/browser/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "null",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      ...headers,
    },
    body: formBody(input),
    redirect: "manual",
  });
}

function readTransferEnvelope(html) {
  const match = /window\.name\s*=\s*"relmio-v1\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})"/u.exec(html);
  assert.ok(match, "bootstrap response must publish one strict window.name transfer envelope");
  return { transferId: match[1], secret: match[2] };
}

async function transfer(fixture, input, origin = fixture.wizard.origin) {
  return await fetch(`${fixture.wizard.origin}/__relmio/browser/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": origin,
    },
    body: JSON.stringify(input),
    redirect: "error",
  });
}

test("browser-role prepare returns only a non-authorizing private file URL", async (t) => {
  const fixture = await startFixture(t);
  const response = await prepare(fixture, "/assistant");
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  const body = await response.json();
  assert.deepEqual(body, { launchUrl });
  assert.equal(fixture.handoffs.length, 1);
  assert.equal(fixture.handoffs[0].origin, fixture.wizard.origin);
  assert.equal(fixture.handoffs[0].route, "/assistant");
  assert.match(fixture.handoffs[0].ticketId, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(fixture.handoffs[0].secret, /^[A-Za-z0-9_-]{43}$/u);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(sessionToken), false);
  assert.equal(serialized.includes(fixture.handoffs[0].ticketId), false);
  assert.equal(serialized.includes(fixture.handoffs[0].secret), false);

  assert.equal((await prepare(fixture, "/local", controlToken)).status, 401);
  assert.equal((await prepare(fixture, "/other")).status, 400);
  assert.equal((await prepare(fixture, "/local", sessionToken, "http://127.0.0.1:9")).status, 403);
});

test("one-time file POST yields only a short-lived transfer and replaces itself with a clean GET", async (t) => {
  const fixture = await startFixture(t);
  assert.equal((await prepare(fixture)).status, 201);
  const handoff = fixture.handoffs[0];
  const response = await exchange(fixture, handoff);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/u);
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]{43}'/u);
  const html = await response.text();
  assert.doesNotMatch(html, new RegExp(sessionToken, "u"));
  assert.match(html, /window\.location\.replace\("\/local"\)/u);
  assert.doesNotMatch(html, /src="\/local\.js"|<body>local<\/body>|history\.replaceState|session=/u);
  assert.equal(html.includes(handoff.ticketId), false);
  assert.equal(html.includes(handoff.secret), false);
  assert.equal(fixture.disposed.includes(handoff.ticketId), true);

  const envelope = readTransferEnvelope(html);
  const transferResponse = await transfer(fixture, { ...envelope, route: "/local" });
  assert.equal(transferResponse.status, 200);
  assert.equal(transferResponse.headers.get("cache-control"), "no-store");
  assert.equal(transferResponse.headers.get("location"), null);
  assert.equal(transferResponse.headers.get("set-cookie"), null);
  assert.equal(transferResponse.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await transferResponse.json(), { sessionToken });

  const replay = await exchange(fixture, handoff);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, "Browser launch could not be verified.");
  assert.equal((await transfer(fixture, { ...envelope, route: "/local" })).status, 401);
});

test("wrong secret, route, and origin do not consume the valid ticket", async (t) => {
  const fixture = await startFixture(t);
  await prepare(fixture, "/");
  const handoff = fixture.handoffs[0];
  assert.equal((await exchange(fixture, { ...handoff, secret: `x${handoff.secret.slice(1)}` })).status, 401);
  assert.equal((await exchange(fixture, { ...handoff, route: "/assistant" })).status, 401);
  assert.equal((await exchange(fixture, handoff, { Origin: fixture.wizard.origin })).status, 403);
  assert.equal(fixture.disposed.length, 0);
  assert.equal((await exchange(fixture, handoff)).status, 200);
});

test("concurrent correct exchanges allow exactly one success", async (t) => {
  const fixture = await startFixture(t);
  await prepare(fixture);
  const handoff = fixture.handoffs[0];
  const responses = await Promise.all([
    exchange(fixture, handoff),
    exchange(fixture, handoff),
  ]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 401]);
  assert.equal(fixture.disposed.filter((id) => id === handoff.ticketId).length, 1);
});

test("browser transfer is exact-origin, route-bound, one-use, and non-consuming on bad proof", async (t) => {
  const fixture = await startFixture(t);
  await prepare(fixture, "/assistant");
  const html = await (await exchange(fixture, fixture.handoffs[0])).text();
  const envelope = readTransferEnvelope(html);

  assert.equal((await transfer(fixture, { ...envelope, route: "/local" })).status, 401);
  assert.equal((await transfer(fixture, {
    ...envelope,
    secret: `x${envelope.secret.slice(1)}`,
    route: "/assistant",
  })).status, 401);
  assert.equal((await transfer(
    fixture,
    { ...envelope, route: "/assistant" },
    "http://127.0.0.1:9",
  )).status, 403);

  const responses = await Promise.all([
    transfer(fixture, { ...envelope, route: "/assistant" }),
    transfer(fixture, { ...envelope, route: "/assistant" }),
  ]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 401]);
});

test("browser transfers expire, are capacity-bounded, and are purged on close", async (t) => {
  const timers = [];
  const fixture = await startFixture(t, {
    browserTransferTtlMs: 25,
    maxPendingBrowserTransfers: 2,
    setTimer(callback, milliseconds) {
      const timer = {
        callback,
        milliseconds,
        cleared: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true;
    },
  });

  await prepare(fixture, "/local");
  const first = readTransferEnvelope(await (await exchange(fixture, fixture.handoffs[0])).text());
  fixture.advance(26);
  assert.equal((await transfer(fixture, { ...first, route: "/local" })).status, 401);

  await prepare(fixture, "/local");
  const second = readTransferEnvelope(await (await exchange(fixture, fixture.handoffs[1])).text());
  await prepare(fixture, "/assistant");
  const third = readTransferEnvelope(await (await exchange(fixture, fixture.handoffs[2])).text());
  await prepare(fixture, "/");
  const full = await exchange(fixture, fixture.handoffs[3]);
  assert.equal(full.status, 429);

  await fixture.wizard.close();
  assert.ok(second.transferId);
  assert.ok(third.transferId);
  assert.ok(timers.length >= 7);
  assert.equal(timers.every(({ cleared }) => cleared), true);
});

test("expired handoffs fail generically and pending handoffs are disposed on close", async (t) => {
  const fixture = await startFixture(t, { browserBootstrapTtlMs: 25 });
  await prepare(fixture, "/local");
  const expired = fixture.handoffs[0];
  fixture.advance(26);
  assert.equal((await exchange(fixture, expired)).status, 401);
  assert.equal(fixture.disposed.includes(expired.ticketId), true);

  await prepare(fixture, "/assistant");
  const pending = fixture.handoffs.at(-1);
  await fixture.wizard.close();
  assert.equal(fixture.disposed.includes(pending.ticketId), true);
});

test("pending browser bootstrap capacity is bounded", async (t) => {
  const fixture = await startFixture(t, { maxPendingBrowserBootstraps: 2 });
  assert.equal((await prepare(fixture, "/local")).status, 201);
  assert.equal((await prepare(fixture, "/assistant")).status, 201);
  const response = await prepare(fixture, "/");
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "Too many pending browser launches." });
});
