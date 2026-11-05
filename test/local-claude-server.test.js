import assert from "node:assert/strict";
import test from "node:test";
import { startIsolatedWizard } from "./helpers/siwc-wizard.js";
import { CLAUDE_REVIEW_FIELDS } from "../src/domain/local-n8n-claude.js";

const token = "local-claude-server-session-token-1234567890";
const review = Object.fromEntries(CLAUDE_REVIEW_FIELDS.map(key => [key, true]));
const HOST = "unix:///var/run/docker.sock"; const N8N = "a".repeat(64); const NET = "b".repeat(64);
const target = "n8n-claude-oauth"; const endpoint = "http://relmio-claude:14502/v1";
const expiresAt = "2026-11-10T00:00:00.000Z";
async function fixture(t) {
  const calls = [];
  const wizard = await startIsolatedWizard({ sessionToken: token, uiFiles: { "/": "", "/local": "" }, services: {
    discoverLocalN8nSidecarTargets: async () => ({ dockerAvailable: true, dockerHost: HOST, containers: [{
      containerId: N8N, containerName: "fixture-n8n", image: "n8nio/n8n:fixture", networks: [{ dockerNetworkId: NET, networkName: "fixture-shared" }],
    }] }),
    inspectLocalN8nClaudeHost: async input => { calls.push(["inspect", input]); return { arch: "arm64" }; },
    getManagedLocalN8nStackTarget: async () => ({ containerId: N8N, marker: { dockerHost: HOST } }),
    installLocalN8nClaude: async input => { calls.push(["install", input]); return { target, endpoint, baseUrl: endpoint,
      protocol: "openai-chat-completions", networkName: "fixture-shared", n8nContainerName: "fixture-n8n",
      hostPublication: "none", clientKey: "k".repeat(43), credentialShownOnce: true, deploymentMode: "installed",
      models: input.plan.models, expiresAt, providerToken: "must-not-leak" }; },
    importLocalStackN8nCredential: async input => { calls.push(["credential", input]); return { state: "created", name: "Relmio Claude" }; },
    getLocalN8nClaudeStatus: async () => ({ target, managed: true, state: "healthy", providerToken: "must-not-leak",
      snapshot: { target, endpoint, auth: { configured: true, disclosure: "one-time", token: "must-not-leak" },
        models: ["claude-sonnet-5-5"], expiresAt, approvalExpired: false, canRemove: true, key: "must-not-leak" } }),
    getLocalN8nClaudeAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "must-not-leak" }),
    discoverLocalN8nClaudeModels: async () => ({ models: ["claude-sonnet-5-5"], token: "must-not-leak" }),
    changeLocalN8nClaude: async input => { calls.push(["change", input]); return { target, ...(input.action === "remove" ? { removed: true } : { changed: true }),
      ...(input.action === "renew" ? { expiresAt } : {}), providerToken: "must-not-leak" }; },
  } });
  t.after(() => wizard.close());
  const post = (path, body) => fetch(`${wizard.origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Setup-Token": token, Origin: wizard.origin }, body: JSON.stringify(body) });
  return { wizard, calls, post };
}

test("Claude local API reviews models, demands four answers, imports only its local key and strips internals", async t => {
  const f = await fixture(t);
  const planResponse = await f.post("/api/local/plan", { target, n8nContainerId: N8N, dockerNetworkId: NET, models: ["claude-sonnet-5-5"] });
  assert.equal(planResponse.status, 200);
  const planned = await planResponse.json();
  assert.equal(planned.plan.arch, "arm64");
  assert.match(planned.plan.executableSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(planned.plan, "dockerHost"), false);
  for (const body of [{ planId: planned.planId, confirmed: true }, { planId: planned.planId, confirmed: true, review: {} },
    { planId: planned.planId, confirmed: false, review }, { planId: planned.planId, confirmed: true, review, oauthToken: "secret" }]) {
    assert.equal((await f.post("/api/local/install", body)).status, 400);
  }
  assert.equal(f.calls.some(([kind]) => kind === "install"), false);
  const response = await f.post("/api/local/install", { planId: planned.planId, confirmed: true, review });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.clientCredential, "k".repeat(43));
  assert.deepEqual(result.n8nCredential, { state: "created", name: "Relmio Claude" });
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.deepEqual(f.calls.find(([kind]) => kind === "credential")[1].credential, { feature: "claude", apiKey: "k".repeat(43) });
});

test("Claude status, filtered sign-in and separately confirmed lifecycle routes are closed-key views", async t => {
  const f = await fixture(t);
  const statusResponse = await fetch(`${f.wizard.origin}/api/local/claude/status`, { headers: { "X-Setup-Token": token } });
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.text()).includes("must-not-leak"), false);
  const auth = await f.post("/api/local/claude/auth-status", {});
  assert.deepEqual(await auth.json(), { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });
  assert.equal((await f.post("/api/local/claude/auth-status", { token: "not-allowed" })).status, 400);
  const models = await f.post("/api/local/claude/models", { clientKey: "k".repeat(43) });
  assert.deepEqual(await models.json(), { models: ["claude-sonnet-5-5"] });
  for (const action of ["renew", "sign-out", "remove"]) {
    assert.equal((await f.post(`/api/local/claude/${action}`, { confirmed: false, ...(action === "renew" ? { review } : {}) })).status, 400);
    if (action === "renew") assert.equal((await f.post(`/api/local/claude/${action}`, { confirmed: true, review: {} })).status, 400);
    const response = await f.post(`/api/local/claude/${action}`, { confirmed: true, ...(action === "renew" ? { review } : {}) });
    assert.equal(response.status, 200);
    assert.equal((await response.text()).includes("must-not-leak"), false);
  }
});
