import assert from "node:assert/strict";
import test from "node:test";

import { createHostingDeploymentPlan } from "../src/domain/hosting-deployment.js";

const deploymentId = "abcdef012345";
const upstreamOrigin = "https://models.example.org";
const body = JSON.stringify({ model: "approved-model", messages: [{ role: "user", content: "hello" }] });
const incoming = "caller-private-value-not-for-output";
const upstream = "provider-private-value-not-for-output";

function plan(providerId, component, inputs = {}) {
  return createHostingDeploymentPlan({ providerId, component, deploymentId, inputs });
}

function generatedModule(artifact, name) {
  const source = artifact.files.find((entry) => entry.name === name)?.content;
  assert.ok(source, `Missing generated ${name}`);
  return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

function chatRequest(path = "/api/chat", { headers = {}, body: requestBody = body } = {}) {
  return new Request(`https://edge.example.org${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${incoming}`, "Content-Type": "application/json", ...headers },
    body: requestBody,
  });
}

for (const providerId of ["vercel", "netlify", "cloudflare-workers"]) {
  test(`${providerId} gateway authenticates separately and calls only the fixed HTTPS Chat Completions path`, async () => {
    const artifact = plan(providerId, "endpoint", { upstreamOrigin });
    const { handleChatRequest } = await generatedModule(artifact, "proxy.mjs");
    const destinations = [];
    const fakeFetch = async (url, options) => {
      destinations.push({ url, options });
      return new Response(JSON.stringify({ choices: [{ message: { content: "worked" } }] }), {
        headers: { "Content-Type": "application/json", "Set-Cookie": "not-forwarded" },
      });
    };
    const secrets = { incoming, upstream };
    const response = await handleChatRequest(chatRequest(), secrets, fakeFetch);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "worked");
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(destinations.length, 1);
    assert.equal(destinations[0].url, `${upstreamOrigin}/v1/chat/completions`);
    assert.equal(destinations[0].options.redirect, "manual");
    assert.equal(destinations[0].options.headers.authorization, `Bearer ${upstream}`);
    assert.notEqual(destinations[0].options.headers.authorization, `Bearer ${incoming}`);

    for (const [request, supplied] of [
      [chatRequest("/api/chat", { headers: { Authorization: "Bearer wrong" } }), secrets],
      [chatRequest("/api/chat?url=https://elsewhere.invalid"), secrets],
      [chatRequest("/v1/chat/completions"), secrets],
      [new Request("https://edge.example.org/api/chat", { method: "GET", headers: { Authorization: `Bearer ${incoming}` } }), secrets],
      [chatRequest(), { incoming, upstream: "" }],
      [chatRequest(), { incoming: "", upstream }],
    ]) {
      const denied = await handleChatRequest(request, supplied, fakeFetch);
      assert.notEqual(denied.status, 200);
      assert.equal((await denied.text()).includes(upstream), false);
    }
    assert.equal(destinations.length, 1);
  });
}

test("gateway rejects oversized or malformed requests before contacting model and hides upstream errors or redirects", async () => {
  const { handleChatRequest } = await generatedModule(plan("vercel", "endpoint", { upstreamOrigin }), "proxy.mjs");
  let called = 0;
  const fakeFetch = async () => { called++; return new Response("sensitive upstream detail", { status: 307, headers: { Location: "https://elsewhere.invalid" } }); };
  const secrets = { incoming, upstream };
  for (const request of [
    chatRequest("/api/chat", { body: "x".repeat(262145) }),
    chatRequest("/api/chat", { body: "{invalid" }),
    chatRequest("/api/chat", { body: JSON.stringify({ url: "https://elsewhere.invalid" }) }),
    chatRequest("/api/chat", { headers: { "Content-Type": "text/plain" } }),
    chatRequest("/api/chat", { headers: { "Content-Encoding": "gzip" } }),
  ]) assert.notEqual((await handleChatRequest(request, secrets, fakeFetch)).status, 200);
  assert.equal(called, 0);
  const redirected = await handleChatRequest(chatRequest(), secrets, fakeFetch);
  assert.equal(redirected.status, 502);
  assert.equal(await redirected.text(), "");
  assert.equal(redirected.headers.get("Location"), null);
  assert.equal(called, 1);
});

test("gateway rejects unsafe upstream origins before any artifact can be downloaded", () => {
  for (const providerId of ["vercel", "netlify", "cloudflare-workers"]) {
    for (const invalid of [
      "http://models.example.org", "https://127.0.0.1", "https://10.0.0.1",
      "https://169.254.10.20", "https://8.8.8.8", "https://[::1]",
      "https://localhost", "https://service.internal", "https://models.example.org:8443",
      "https://models.example.org/v1", "https://models.example.org?q=1", "https://user:pass@models.example.org",
      "https://models.example.org@127.0.0.1", "https://models.example.org/../secret",
      "https://model.example.org\nHeader: injected", "https://-bad.example.org",
    ]) {
      assert.throws(() => plan(providerId, "endpoint", { upstreamOrigin: invalid }));
    }
  }
});

test("Cloudflare search route requires both secrets, constrains query and never forwards arbitrary paths or headers", async () => {
  const artifact = plan("cloudflare-containers", "searxng");
  const { handleSearchRequest } = await generatedModule(artifact, "search-handler.mjs");
  const env = { RELMIO_SEARCH_TOKEN: incoming, SEARXNG_SECRET: "a".repeat(48) };
  const seen = [];
  const container = () => ({ fetch: async (request) => {
    seen.push(request);
    return Response.json({ results: [{ title: "example" }] });
  } });
  const request = (path, token = incoming) => new Request(`https://search.example.org${path}`, {
    headers: { Authorization: `Bearer ${token}`, Cookie: "must-not-pass" },
  });
  for (const [path, token, bindings] of [
    ["/search?q=ok&format=json", "wrong", env],
    ["/search?q=ok&format=json", incoming, {}],
    ["/search?q=ok&format=json", incoming, { RELMIO_SEARCH_TOKEN: incoming }],
    ["/", incoming, env], ["/admin", incoming, env],
    ["/search?q=ok&format=html", incoming, env],
    ["/search?q=ok&format=json&url=https%3A%2F%2Felsewhere.invalid", incoming, env],
    ["/search?q=ok&q=again&format=json", incoming, env],
    [`/search?q=${"z".repeat(513)}&format=json`, incoming, env],
  ]) assert.notEqual((await handleSearchRequest(request(path, token), bindings, container)).status, 200);
  assert.notEqual((await handleSearchRequest(new Request("https://search.example.org/search?q=ok&format=json", {
    method: "POST",
    headers: { Authorization: `Bearer ${incoming}` },
    body: "q=ok",
  }), env, container)).status, 200);
  assert.equal(seen.length, 0);
  const response = await handleSearchRequest(request("/search?q=hello%20world&format=json"), env, container);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).results[0].title, "example");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.get("authorization"), null);
  assert.equal(seen[0].headers.get("cookie"), null);
  assert.equal(new URL(seen[0].url).pathname, "/search");
  assert.equal(new URL(seen[0].url).searchParams.get("q"), "hello world");
});

test("Cloudflare search route bounds untrusted container responses and fails closed on errors", async () => {
  const { handleSearchRequest } = await generatedModule(plan("cloudflare-containers", "searxng"), "search-handler.mjs");
  const env = { RELMIO_SEARCH_TOKEN: incoming, SEARXNG_SECRET: "a".repeat(48) };
  const request = new Request("https://search.example.org/search?q=abc&format=json", { headers: { Authorization: `Bearer ${incoming}` } });
  for (const response of [
    new Response("private", { status: 302, headers: { Location: "https://elsewhere.invalid" } }),
    new Response("private", { status: 500 }),
    new Response("{}", { headers: { "Content-Type": "text/html" } }),
    new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "1048577" } }),
  ]) {
    const actual = await handleSearchRequest(request, env, () => ({ fetch: async () => response }));
    assert.equal(actual.status, 502);
    assert.equal(await actual.text(), "");
  }
});
