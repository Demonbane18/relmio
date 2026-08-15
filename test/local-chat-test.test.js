import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { createLocalChatTestService } from "../src/services/local-chat-test.js";

const credential = "TEST_SECRET_SENTINEL_DO_NOT_LOG";

async function encrypt(publicKeyJwk) {
  const key = await webcrypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const encrypted = await webcrypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    key,
    new TextEncoder().encode(credential),
  );
  return Buffer.from(encrypted).toString("base64");
}

async function createRequest(service) {
  const issued = await service.issueKey();
  return {
    endpointBaseUrl: "http://127.0.0.1:14501/",
    keyId: issued.keyId,
    encryptedCredential: await encrypt(issued.publicKeyJwk),
    input: "Reply with exactly: adapter works",
  };
}

test("issues expiring RSA-OAEP keys and forwards only a bounded /chat contract", async () => {
  const calls = [];
  const service = createLocalChatTestService({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        conversationId: "conversation-123",
        output: "adapter works",
        ignored: credential,
      });
    },
  });
  const request = await createRequest(service);

  const first = await service.message(request);
  const second = await service.message({
    ...request,
    input: "Continue the conversation",
    conversationId: first.conversationId,
  });

  assert.deepEqual(first, {
    conversationId: "conversation-123",
    output: "adapter works",
  });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:14501/chat");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.Origin, undefined);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${credential}`);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    input: "Continue the conversation",
    conversationId: "conversation-123",
  });
});

test("rejects every non-literal-loopback adapter URL before decrypting", async () => {
  const service = createLocalChatTestService({
    fetchImpl: async () => {
      throw new Error("fetch must not run");
    },
  });
  const request = await createRequest(service);

  for (const endpointBaseUrl of [
    "http://localhost:14501",
    "http://[::1]:14501",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://user:pass@127.0.0.1:14501",
    "http://127.0.0.1:14501/other",
    "http://127.0.0.1:14501?next=https://example.test",
    "https://127.0.0.1:14501",
    "http://192.168.1.1:14501",
  ]) {
    await assert.rejects(
      service.message({ ...request, endpointBaseUrl }),
      (error) => error?.statusCode === 400 && !String(error.message).includes(credential),
      endpointBaseUrl,
    );
  }
});

test("expires, resets, and bounds outstanding ephemeral tester sessions", async () => {
  let now = 100;
  const service = createLocalChatTestService({
    now: () => now,
    keyTtlMs: 60_000,
    maxSessions: 2,
    fetchImpl: async () => Response.json({ conversationId: "one", output: "ok" }),
  });
  const first = await createRequest(service);
  await service.issueKey();
  await assert.rejects(service.issueKey(), (error) => error?.statusCode === 429);

  now += 60_001;
  await assert.rejects(
    service.message(first),
    (error) => error?.statusCode === 409 && /expired/u.test(error.message),
  );
  const fresh = await createRequest(service);
  await service.reset({ keyId: fresh.keyId });
  await assert.rejects(
    service.message(fresh),
    (error) => error?.statusCode === 409 && !String(error.message).includes(credential),
  );
});

test("does not exceed the session bound when keys are issued concurrently", async () => {
  const service = createLocalChatTestService({
    maxSessions: 1,
    fetchImpl: async () => Response.json({ conversationId: "one", output: "ok" }),
  });

  const results = await Promise.allSettled([service.issueKey(), service.issueKey()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    results.find((result) => result.status === "rejected")?.reason?.statusCode,
    429,
  );
});

test("redacts malformed, redirected, timed-out, and oversized adapter responses", async () => {
  const cases = [
    {
      response: new Response("private redirect detail", { status: 302 }),
      statusCode: 502,
    },
    {
      response: new Response("{", { status: 200 }),
      statusCode: 502,
    },
    {
      response: new Response(JSON.stringify({ conversationId: "x", output: "x" }), {
        headers: { "content-length": "999999" },
      }),
      statusCode: 502,
    },
    {
      response: Response.json({ conversationId: "x", output: "x".repeat(16_385) }),
      statusCode: 502,
    },
    {
      error: new DOMException("private network detail", "TimeoutError"),
      statusCode: 504,
    },
  ];

  for (const fixture of cases) {
    const service = createLocalChatTestService({
      fetchImpl: async () => {
        if (fixture.error) {
          throw fixture.error;
        }
        return fixture.response;
      },
    });
    const request = await createRequest(service);
    await assert.rejects(
      service.message(request),
      (error) =>
        error?.statusCode === fixture.statusCode &&
        !String(error.message).includes("private") &&
        !String(error.message).includes(credential),
    );
  }
});

test("rejects a second use of the same tester key while a turn is in flight", async () => {
  let finish;
  const service = createLocalChatTestService({
    fetchImpl: async () =>
      await new Promise((resolve) => {
        finish = () => resolve(Response.json({ conversationId: "one", output: "ok" }));
      }),
  });
  const request = await createRequest(service);
  const inFlight = service.message(request);

  await assert.rejects(
    service.message(request),
    (error) => error?.statusCode === 409,
  );
  finish();
  assert.deepEqual(await inFlight, { conversationId: "one", output: "ok" });
});

test("dispose invalidates keys and aborts an in-flight adapter request", async () => {
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const service = createLocalChatTestService({
    fetchImpl: async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        requestStarted();
      }),
  });
  const request = await createRequest(service);
  const inFlight = service.message(request);
  await started;

  service.dispose();

  await assert.rejects(inFlight, (error) => error?.statusCode === 504);
  await assert.rejects(
    service.message(request),
    (error) => error?.statusCode === 409 && /expired/u.test(error.message),
  );
});

test("expiry actively erases a key and aborts an in-flight adapter request", async () => {
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const service = createLocalChatTestService({
    keyTtlMs: 20,
    fetchImpl: async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        requestStarted();
      }),
  });
  const request = await createRequest(service);
  const inFlight = service.message(request);
  await started;

  await assert.rejects(inFlight, (error) => error?.statusCode === 504);
  await assert.rejects(
    service.message(request),
    (error) => error?.statusCode === 409 && /expired/u.test(error.message),
  );
});
